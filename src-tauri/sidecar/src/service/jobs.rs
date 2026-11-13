//! In-memory recognition job store for the Ketcher compatibility protocol.
//!
//! Ketcher uploads an image, receives an opaque id and polls it until the job
//! leaves `PENDING`. The store is per-process and deliberately not persisted: a
//! sidecar restart drops every job, so a later poll is `404`. A job resolves to
//! `SUCCESS` (V2000 molfile) or `FAILURE` (actionable message) and is pruned one
//! [`TTL`] after it resolves. A job still `PENDING` at `created + TTL` is
//! reported as the timeout `FAILURE` on its next poll.
//!
//! The clock is injected as an [`Instant`] argument, so the TTL boundaries are
//! tested without sleeping. The uploaded bytes stay with the job while it is
//! pending and are dropped as soon as it resolves.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a job stays reachable: from creation while pending, from resolution
/// once resolved.
pub const TTL: Duration = Duration::from_secs(600);

/// Error reported when a `PENDING` job reaches [`TTL`].
pub const TIMEOUT_MESSAGE: &str = "Recognition timed out. Try again.";

/// State of one recognition job, as polled by Ketcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobStatus {
    /// The worker has not resolved the job yet.
    Pending,
    /// The worker recognized a structure; carries the V2000 molfile.
    Success {
        /// V2000 molfile the client adds to the canvas.
        molfile: String,
    },
    /// The worker failed; carries the actionable UI copy.
    Failure {
        /// Message the client surfaces to the user.
        error: String,
    },
}

/// One uploaded image and its resolution state.
struct Job {
    status: JobStatus,
    image: Vec<u8>,
    created_at: Instant,
    resolved_at: Option<Instant>,
}

/// In-memory store shared by the upload and polling handlers.
///
/// The lock only guards the map: inference never runs under it, so a slow job
/// cannot block polling.
#[derive(Default)]
pub struct JobStore {
    jobs: Mutex<HashMap<String, Job>>,
}

impl JobStore {
    /// Creates an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores the uploaded image as a new `PENDING` job and returns its id.
    pub fn create(&self, image: Vec<u8>, now: Instant) -> String {
        let id = next_id();
        let job = Job {
            status: JobStatus::Pending,
            image,
            created_at: now,
            resolved_at: None,
        };
        self.lock().insert(id.clone(), job);
        id
    }

    /// Returns the current status of `id`, or `None` when it is unknown or
    /// expired.
    ///
    /// A `PENDING` job at or past `created + TTL` is resolved as the timeout
    /// `FAILURE` here, so a client polling a dead worker never stays pending
    /// forever.
    pub fn get(&self, id: &str, now: Instant) -> Option<JobStatus> {
        let mut jobs = self.lock();
        let job = jobs.get_mut(id)?;
        time_out_if_due(job, now);
        if is_expired(job, now) {
            return None;
        }
        Some(job.status.clone())
    }

    /// Returns a copy of the uploaded bytes while the job is known.
    ///
    /// The worker takes this copy before processing; the original is dropped
    /// when the job resolves.
    pub fn image(&self, id: &str) -> Option<Vec<u8>> {
        self.lock().get(id).map(|job| job.image.clone())
    }

    /// Resolves a known `PENDING` job as `SUCCESS`.
    ///
    /// Returns `false` for an unknown, already resolved or timed-out job.
    pub fn succeed(&self, id: &str, molfile: String, now: Instant) -> bool {
        self.resolve(id, JobStatus::Success { molfile }, now)
    }

    /// Resolves a known `PENDING` job as `FAILURE`.
    ///
    /// Returns `false` for an unknown, already resolved or timed-out job.
    pub fn fail(&self, id: &str, error: String, now: Instant) -> bool {
        self.resolve(id, JobStatus::Failure { error }, now)
    }

    /// Drops every job resolved at or before `now - TTL`.
    ///
    /// A job still pending at `created + TTL` is resolved as the timeout
    /// `FAILURE` first, so it is pruned one TTL after that resolution.
    ///
    /// Both HTTP handlers call this before they answer, so the store cannot
    /// grow for the process lifetime. There is no background reaper on purpose:
    /// the store is only touched by upload and poll traffic.
    pub fn purge(&self, now: Instant) {
        let mut jobs = self.lock();
        for job in jobs.values_mut() {
            time_out_if_due(job, now);
        }
        jobs.retain(|_, job| !is_expired(job, now));
    }

    /// Returns how many jobs the map currently holds.
    ///
    /// Expired entries are only removed by [`JobStore::purge`], so this counts
    /// resolved-but-not-yet-pruned jobs too. It exists for tests that must
    /// prove pruning removes entries, not merely that [`JobStore::get`]
    /// answers `None`.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Reports whether the map holds no jobs at all (see [`JobStore::len`]).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn resolve(&self, id: &str, status: JobStatus, now: Instant) -> bool {
        let mut jobs = self.lock();
        let Some(job) = jobs.get_mut(id) else {
            return false;
        };
        time_out_if_due(job, now);
        if job.status != JobStatus::Pending {
            return false;
        }
        job.status = status;
        job.resolved_at = Some(now);
        job.image = Vec::new();
        true
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Job>> {
        self.jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Resolves a pending job as the timeout failure when its TTL has elapsed.
fn time_out_if_due(job: &mut Job, now: Instant) {
    if job.status != JobStatus::Pending {
        return;
    }
    let deadline = job.created_at + TTL;
    if now >= deadline {
        job.status = JobStatus::Failure {
            error: TIMEOUT_MESSAGE.to_string(),
        };
        job.resolved_at = Some(deadline);
        job.image = Vec::new();
    }
}

/// Reports whether a resolved job is past `resolved_at + TTL`.
fn is_expired(job: &Job, now: Instant) -> bool {
    job.resolved_at
        .is_some_and(|resolved_at| now >= resolved_at + TTL)
}

/// Generates a process-unique, non-empty job id.
///
/// The store lives for one sidecar process, so a nanosecond timestamp mixed
/// with a monotonic counter is unique without a UUID dependency. The result is
/// 32 hex characters, safe to interpolate into the polling URL.
fn next_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);

    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let mixed = nanos ^ (u128::from(sequence) << 64) ^ u128::from(sequence);
    format!("{mixed:032x}")
}
