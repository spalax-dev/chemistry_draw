use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub enum JobStatus {
    Processing,
    Success { mol_str: String },
    Failure { error: String },
}

#[derive(Clone)]
pub struct ImagoJobStore {
    jobs: Arc<Mutex<HashMap<String, JobStatus>>>,
}

impl ImagoJobStore {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(&self) -> String {
        let id = Uuid::new_v4().to_string();
        let mut jobs = self.jobs.lock().unwrap();
        jobs.insert(id.clone(), JobStatus::Processing);
        id
    }

    pub fn set_success(&self, id: &str, mol_str: String) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.insert(id.to_string(), JobStatus::Success { mol_str });
    }

    pub fn set_failure(&self, id: &str, error: String) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.insert(id.to_string(), JobStatus::Failure { error });
    }

    pub fn get(&self, id: &str) -> Option<JobStatus> {
        let jobs = self.jobs.lock().unwrap();
        jobs.get(id).cloned()
    }
}
