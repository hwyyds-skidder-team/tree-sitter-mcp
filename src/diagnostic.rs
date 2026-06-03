use std::error::Error;
use std::fmt::{Display, Formatter};

pub type Result<T> = std::result::Result<T, BinaryPatchError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub offset: Option<u64>,
}

impl Diagnostic {
    pub fn info(message: impl Into<String>) -> Self {
        Self {
            severity: DiagnosticSeverity::Info,
            message: message.into(),
            offset: None,
        }
    }

    pub fn warning(message: impl Into<String>, offset: Option<u64>) -> Self {
        Self {
            severity: DiagnosticSeverity::Warning,
            message: message.into(),
            offset,
        }
    }

    pub fn error(message: impl Into<String>, offset: Option<u64>) -> Self {
        Self {
            severity: DiagnosticSeverity::Error,
            message: message.into(),
            offset,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryPatchError {
    InvalidFormat(String),
    Unsupported(String),
    Rewrite(String),
    Emit(String),
    Io(String),
}

impl Display for BinaryPatchError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFormat(message) => write!(f, "invalid binary format: {message}"),
            Self::Unsupported(message) => write!(f, "unsupported binary feature: {message}"),
            Self::Rewrite(message) => write!(f, "rewrite failed: {message}"),
            Self::Emit(message) => write!(f, "emit failed: {message}"),
            Self::Io(message) => write!(f, "io failed: {message}"),
        }
    }
}

impl Error for BinaryPatchError {}

impl From<std::io::Error> for BinaryPatchError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}
