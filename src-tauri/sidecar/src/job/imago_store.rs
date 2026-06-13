//! In-memory [`ImagoJobStore`] shared across handlers via `AppState`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Status of an Imago recognition job.
#[derive(Clone, Debug)]
pub enum JobStatus {
    /// Job created, recognition in progress.
    Processing,
    /// Recognition finished successfully.
    Success {
        /// The resulting molfile (V2000), cleaned through Indigo.
        mol_str: String,
    },
    /// Recognition failed.
    Failure {
        /// Human-readable error message.
        error: String,
    },
}

/// Thread-safe, in-memory store for Imago recognition jobs.
///
/// Jobs are identified by UUID v4. The store is backed by a
/// `HashMap<String, JobStatus>` guarded by `Arc<Mutex<…>>`.
/// There is no persistence — restarting the sidecar loses all jobs.
#[derive(Clone)]
pub struct ImagoJobStore {
    jobs: Arc<Mutex<HashMap<String, JobStatus>>>,
}

impl ImagoJobStore {
    /// Creates an empty store.
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Creates a new job in [`JobStatus::Processing`].
    ///
    /// Returns the UUID v4 that the client uses for polling.
    pub fn create(&self) -> String {
        let id = Uuid::new_v4().to_string();
        let mut jobs = self.jobs.lock().unwrap();
        jobs.insert(id.clone(), JobStatus::Processing);
        id
    }

    /// Marks a job as successful and stores the resulting molfile.
    pub fn set_success(&self, id: &str, mol_str: String) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.insert(id.to_string(), JobStatus::Success { mol_str });
    }

    /// Marks a job as failed and stores the error message.
    pub fn set_failure(&self, id: &str, error: String) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.insert(id.to_string(), JobStatus::Failure { error });
    }

    /// Returns the current status of a job, or `None` if the id is unknown.
    pub fn get(&self, id: &str) -> Option<JobStatus> {
        let jobs = self.jobs.lock().unwrap();
        jobs.get(id).cloned()
    }
}
