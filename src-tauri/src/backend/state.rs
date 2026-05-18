use std::path::PathBuf;

use serde::{Serialize, Serializer};
use thiserror::Error;

use super::config::Config;

/// In-process backend handle. Holds the resolved app-home directory
/// (`~/.agent-skill-manager` / `~/.skillworks` depending on the platform)
/// and an owned copy of the parsed config. Concrete I/O lives in the
/// submodules; `Manager` is the cross-cutting state container.
#[derive(Debug, Clone)]
pub struct Manager {
    pub config: Config,
    pub app_home: PathBuf,
}

impl Manager {
    pub fn new(app_home: PathBuf, config: Config) -> Self {
        Self { app_home, config }
    }
}

/// Errors that can flow back to the JavaScript frontend over IPC. Serialized
/// as a `{ kind, message }` object so the existing toast-on-error logic in
/// `public/app.js` can keep extracting `.error` / `.message` text.
#[derive(Debug, Error)]
pub enum BackendError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("not found: {0}")]
    NotFound(String),
}

impl Serialize for BackendError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let (kind, message) = match self {
            BackendError::Io(e) => ("io", e.to_string()),
            BackendError::Json(e) => ("json", e.to_string()),
            BackendError::Validation(msg) => ("validation", msg.clone()),
            BackendError::NotFound(msg) => ("notFound", msg.clone()),
        };
        let mut s = serializer.serialize_struct("BackendError", 3)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &message)?;
        // Mirror the existing JS-server error envelope so the frontend's
        // `payload.error` access keeps working unchanged.
        s.serialize_field("error", &message)?;
        s.end()
    }
}

pub type BackendResult<T> = Result<T, BackendError>;
