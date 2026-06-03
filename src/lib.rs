//! Semantic-IR oriented binary rewriting for ELF and PE executables.
//!
//! The crate is intentionally organized around lifting and re-emission. Raw
//! bytes are still available for diagnostics and format work, but user-facing
//! rewrites are expressed as IR transformations.

pub mod analysis;
pub mod arch;
pub mod diagnostic;
pub mod emit;
pub mod format;
pub mod ir;
pub mod layout;
pub mod rewrite;

pub use analysis::{
    CfgConfidence, ConfidenceTier, ControlFlowGraph, ModuleAnalysis, UnresolvedEdge,
    UnresolvedEdgeReason,
};
pub use diagnostic::{BinaryPatchError, Diagnostic, DiagnosticSeverity, Result};
pub use format::{
    Architecture, BaseRelocation, BaseRelocationKind, Binary, BinaryFormat, BinaryObject, Import,
    ImportEntry, ImportKind, MetadataRange, Symbol, SymbolBinding, SymbolKind, SymbolSource,
    UnwindMetadata,
};
pub use layout::{BlockPlacement, EncodedBlock, LayoutAllocator, LayoutDiagnostics, LayoutPlan};
pub use rewrite::{
    CloneEntryBlockPass, InsertEntryNopPass, PlannedRewrite, RewriteLayout, RewritePass,
    RewritePassReport, RewritePlan, RewriteSession, RewriteTransform, RewriteVerification,
    RewriteWorkflow, RewriteWorkflowResult,
};
