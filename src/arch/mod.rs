pub mod x86;

use crate::diagnostic::Result;
use crate::format::{Architecture, Binary};
use crate::ir::Module;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiftOptions {
    pub follow_direct_calls: bool,
}

impl LiftOptions {
    pub const FULL_CFG: Self = Self {
        follow_direct_calls: true,
    };

    pub const SINGLE_FUNCTION: Self = Self {
        follow_direct_calls: false,
    };
}

pub fn lift_binary(binary: &Binary) -> Result<Module> {
    lift_binary_at(binary, binary.object().entry)
}

pub fn lift_binary_at(binary: &Binary, address: u64) -> Result<Module> {
    lift_binary_at_with_options(binary, address, LiftOptions::FULL_CFG)
}

pub fn lift_binary_at_with_options(
    binary: &Binary,
    address: u64,
    options: LiftOptions,
) -> Result<Module> {
    match binary.object().architecture {
        Architecture::X86 | Architecture::X86_64 => x86::lift_from(binary, address, options),
    }
}

pub(crate) fn encode_operation(
    architecture: Architecture,
    address: u64,
    operation: &crate::ir::Operation,
) -> Result<Vec<u8>> {
    match architecture {
        Architecture::X86 | Architecture::X86_64 => {
            x86::encode_operation(architecture, address, operation)
        }
    }
}

pub(crate) fn ensure_supported(architecture: Architecture) -> Result<()> {
    match architecture {
        Architecture::X86 | Architecture::X86_64 => Ok(()),
    }
}
