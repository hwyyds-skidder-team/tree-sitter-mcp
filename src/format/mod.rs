pub mod elf;
pub mod pe;

use crate::arch;
use crate::diagnostic::{BinaryPatchError, Diagnostic, Result};
use crate::emit;
use crate::ir::Module;
use crate::layout::LayoutPlan;
use crate::rewrite::{RewritePlan, RewriteSession};
use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryFormat {
    Elf,
    Pe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Architecture {
    X86,
    X86_64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Permissions {
    pub read: bool,
    pub write: bool,
    pub execute: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub file_offset: u64,
    pub virtual_address: u64,
    pub file_size: u64,
    pub memory_size: u64,
    pub permissions: Permissions,
}

impl Segment {
    pub fn contains_virtual_address(&self, address: u64) -> bool {
        address >= self.virtual_address
            && address < self.virtual_address.saturating_add(self.file_size)
    }

    pub fn file_offset_for_virtual_address(&self, address: u64) -> Option<u64> {
        if self.contains_virtual_address(address) {
            Some(self.file_offset + (address - self.virtual_address))
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub name: Option<String>,
    pub file_offset: u64,
    pub virtual_address: u64,
    pub size: u64,
    pub executable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Object,
    Section,
    File,
    Other(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolBinding {
    Local,
    Global,
    Weak,
    Other(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolSource {
    Static,
    Dynamic,
    Export,
    Import,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub address: u64,
    pub size: u64,
    pub kind: SymbolKind,
    pub binding: SymbolBinding,
    pub source: SymbolSource,
    pub section_index: Option<u16>,
}

impl Symbol {
    pub fn is_defined(&self) -> bool {
        self.section_index.is_some()
    }

    pub fn is_function(&self) -> bool {
        self.kind == SymbolKind::Function
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    Standard,
    Delay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEntry {
    pub name: Option<String>,
    pub ordinal: Option<u16>,
    pub hint: Option<u16>,
    pub lookup_address: Option<u64>,
    pub address_table_address: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Import {
    pub library: String,
    pub kind: ImportKind,
    pub descriptor_address: u64,
    pub name_address: u64,
    pub lookup_table_address: Option<u64>,
    pub address_table_address: u64,
    pub module_handle_address: Option<u64>,
    pub bound_address_table_address: Option<u64>,
    pub unload_address_table_address: Option<u64>,
    pub timestamp: u32,
    pub attributes: u32,
    pub entries: Vec<ImportEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseRelocationKind {
    Absolute,
    High,
    Low,
    HighLow,
    HighAdj,
    Dir64,
    Other(u16),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseRelocation {
    pub page_address: u64,
    pub address: u64,
    pub offset: u16,
    pub kind: BaseRelocationKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelocationTableFormat {
    Rel,
    Rela,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelocationTableSource {
    SectionHeader,
    DynamicEntry,
    SectionHeaderAndDynamicEntry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelocationTableDescriptor {
    pub name: Option<String>,
    pub format: RelocationTableFormat,
    pub source: RelocationTableSource,
    pub file_offset: Option<u64>,
    pub virtual_address: u64,
    pub size: u64,
    pub entry_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElfDynamicTableSource {
    ProgramHeader,
    SectionHeader,
    ProgramHeaderAndSectionHeader,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElfDynamicTable {
    pub source: ElfDynamicTableSource,
    pub file_offset: u64,
    pub virtual_address: u64,
    pub size: u64,
    pub entry_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElfDynamicTag {
    Null,
    Needed,
    StrTab,
    StrSz,
    SymTab,
    SymEnt,
    PltGot,
    PltRelSize,
    PltRel,
    JumpRel,
    Rel,
    RelSize,
    RelEnt,
    Rela,
    RelaSize,
    RelaEnt,
    Other(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElfDynamicEntry {
    pub tag: ElfDynamicTag,
    pub value: u64,
    pub string: Option<String>,
    pub relocation_format: Option<RelocationTableFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ElfPltMetadata {
    pub got_address: Option<u64>,
    pub relocations_address: Option<u64>,
    pub relocations_size: Option<u64>,
    pub relocation_format: Option<RelocationTableFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ElfDynamicMetadata {
    pub table: Option<ElfDynamicTable>,
    pub entries: Vec<ElfDynamicEntry>,
    pub needed_libraries: Vec<String>,
    pub plt: ElfPltMetadata,
    pub relocation_tables: Vec<RelocationTableDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataRange {
    pub label: String,
    pub range: Range<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UnwindMetadata {
    protected_ranges: Vec<MetadataRange>,
    function_ranges: Vec<MetadataRange>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryObject {
    pub format: BinaryFormat,
    pub architecture: Architecture,
    pub entry: u64,
    pub image_base: u64,
    pub segments: Vec<Segment>,
    pub sections: Vec<Section>,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub base_relocations: Vec<BaseRelocation>,
    pub unwind_metadata: Option<UnwindMetadata>,
}

impl BinaryObject {
    pub fn segment_for_virtual_address(&self, address: u64) -> Option<&Segment> {
        self.segments
            .iter()
            .find(|segment| segment.contains_virtual_address(address))
    }

    pub fn executable_segment_for_virtual_address(&self, address: u64) -> Option<&Segment> {
        self.segments.iter().find(|segment| {
            segment.permissions.execute && segment.contains_virtual_address(address)
        })
    }

    pub fn file_offset_for_virtual_address(&self, address: u64) -> Option<u64> {
        self.segment_for_virtual_address(address)
            .and_then(|segment| segment.file_offset_for_virtual_address(address))
    }

    pub fn entry_segment(&self) -> Option<&Segment> {
        self.executable_segment_for_virtual_address(self.entry)
    }

    pub fn entry_file_offset(&self) -> Option<u64> {
        self.file_offset_for_virtual_address(self.entry)
    }

    pub fn unwind_metadata(&self) -> Option<&UnwindMetadata> {
        self.unwind_metadata.as_ref()
    }

    pub fn symbol_by_name(&self, name: &str) -> Option<&Symbol> {
        self.symbols.iter().find(|symbol| symbol.name == name)
    }

    pub fn function_symbol_by_name(&self, name: &str) -> Option<&Symbol> {
        self.symbols.iter().find(|symbol| {
            symbol.name == name
                && symbol.is_function()
                && symbol.is_defined()
                && self
                    .executable_segment_for_virtual_address(symbol.address)
                    .is_some()
        })
    }

    pub fn elf_dynamic_metadata(&self, bytes: &[u8]) -> Result<Option<ElfDynamicMetadata>> {
        if self.format != BinaryFormat::Elf {
            return Ok(None);
        }
        elf::parse_dynamic_metadata(bytes, self)
    }
}

pub(crate) fn function_symbol_lookup_error(object: &BinaryObject, name: &str) -> BinaryPatchError {
    match object.symbol_by_name(name) {
        None => BinaryPatchError::Unsupported(format!("function symbol {name:?} not found")),
        Some(symbol) if !symbol.is_function() => BinaryPatchError::Unsupported(format!(
            "symbol {name:?} is not a function and cannot be lifted or rewritten"
        )),
        Some(symbol) if !symbol.is_defined() => BinaryPatchError::Unsupported(format!(
            "symbol {name:?} is imported and cannot be lifted or rewritten"
        )),
        Some(symbol)
            if object
                .executable_segment_for_virtual_address(symbol.address)
                .is_none() =>
        {
            BinaryPatchError::Unsupported(format!(
                "function symbol {name:?} is not located in an executable segment"
            ))
        }
        Some(_) => {
            BinaryPatchError::Unsupported(format!("function symbol {name:?} is not liftable"))
        }
    }
}

#[derive(Debug, Clone)]
pub struct Binary {
    bytes: Vec<u8>,
    object: BinaryObject,
    diagnostics: Vec<Diagnostic>,
}

impl Binary {
    /// Parse raw bytes into a binary representation.
    pub fn parse(bytes: impl AsRef<[u8]>) -> Result<Self> {
        let bytes = bytes.as_ref().to_vec();
        let parsed = if elf::looks_like(&bytes) {
            elf::parse(&bytes)
        } else if pe::looks_like(&bytes) {
            pe::parse(&bytes)
        } else {
            Err(BinaryPatchError::InvalidFormat(
                "input is neither ELF nor PE".to_string(),
            ))
        }?;

        Ok(Self {
            bytes,
            object: parsed.object,
            diagnostics: parsed.diagnostics,
        })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn object(&self) -> &BinaryObject {
        &self.object
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn elf_dynamic_metadata(&self) -> Result<Option<ElfDynamicMetadata>> {
        self.object.elf_dynamic_metadata(&self.bytes)
    }

    pub fn unwind_metadata(&self) -> Option<&UnwindMetadata> {
        self.object.unwind_metadata()
    }

    /// Lift the binary entry point to a `Module`.
    pub fn lift(&self) -> Result<Module> {
        arch::lift_binary(self)
    }

    /// Lift an arbitrary executable address to a `Module`.
    pub fn lift_at(&self, address: u64) -> Result<Module> {
        arch::lift_binary_at(self, address)
    }

    /// Lift only the function-local control flow rooted at an executable address.
    ///
    /// Direct call targets remain represented as call instructions, but callees are
    /// not recursively lifted into the rewrite module.
    pub fn lift_function_at(&self, address: u64) -> Result<Module> {
        arch::lift_binary_at_with_options(self, address, arch::LiftOptions::SINGLE_FUNCTION)
    }

    /// Lift a named function symbol to a `Module`.
    pub fn lift_symbol(&self, name: &str) -> Result<Module> {
        let symbol = self
            .object
            .function_symbol_by_name(name)
            .ok_or_else(|| function_symbol_lookup_error(&self.object, name))?;
        self.lift_at(symbol.address)
    }

    /// Lift only a named function symbol without recursively lifting direct callees.
    pub fn lift_function_symbol(&self, name: &str) -> Result<Module> {
        let symbol = self
            .object
            .function_symbol_by_name(name)
            .ok_or_else(|| function_symbol_lookup_error(&self.object, name))?;
        self.lift_function_at(symbol.address)
    }

    /// Apply a rewrite plan to the current binary bytes.
    pub fn emit(&self, plan: &RewritePlan) -> Result<Vec<u8>> {
        emit::emit(self, plan)
    }

    /// Start a rewrite session rooted at the entry point.
    pub fn rewrite(&self) -> Result<RewriteSession<'_>> {
        RewriteSession::new(self)
    }

    /// Start a rewrite session rooted at an arbitrary executable address.
    pub fn rewrite_at(&self, address: u64) -> Result<RewriteSession<'_>> {
        RewriteSession::new_at(self, address)
    }

    /// Start a rewrite session that is scoped to one selected function.
    pub fn rewrite_function_at(&self, address: u64) -> Result<RewriteSession<'_>> {
        RewriteSession::new_function_at(self, address)
    }

    /// Start a rewrite session rooted at a named function symbol.
    pub fn rewrite_symbol(&self, name: &str) -> Result<RewriteSession<'_>> {
        RewriteSession::new_symbol(self, name)
    }

    /// Start a rewrite session rooted at a named function without recursively lifting direct callees.
    pub fn rewrite_function_symbol(&self, name: &str) -> Result<RewriteSession<'_>> {
        RewriteSession::new_function_symbol(self, name)
    }

    /// Emit a relocated rewrite using an explicit layout plan.
    pub fn emit_relocated(&self, module: &Module, layout: &LayoutPlan) -> Result<Vec<u8>> {
        emit::emit_relocated(self, module, layout)
    }

    /// Emit a relocated rewrite by expanding the last executable segment.
    pub fn emit_relocated_expanding_load_segment(&self, module: &Module) -> Result<Vec<u8>> {
        emit::emit_relocated_expanding_load_segment(self, module)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedBinary {
    pub object: BinaryObject,
    pub diagnostics: Vec<Diagnostic>,
}

impl UnwindMetadata {
    pub fn protected_ranges(&self) -> &[MetadataRange] {
        &self.protected_ranges
    }

    pub fn function_ranges(&self) -> &[MetadataRange] {
        &self.function_ranges
    }

    pub fn is_empty(&self) -> bool {
        self.protected_ranges.is_empty() && self.function_ranges.is_empty()
    }

    pub(crate) fn push_protected_range(
        &mut self,
        range: Range<u64>,
        label: impl Into<String>,
    ) -> &mut Self {
        self.protected_ranges.push(MetadataRange {
            label: label.into(),
            range,
        });
        self
    }

    pub(crate) fn push_function_range(
        &mut self,
        range: Range<u64>,
        label: impl Into<String>,
    ) -> &mut Self {
        self.function_ranges.push(MetadataRange {
            label: label.into(),
            range,
        });
        self
    }
}

pub(crate) fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16> {
    let raw = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("truncated u16".to_string()))?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

pub(crate) fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32> {
    let raw = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("truncated u32".to_string()))?;
    Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

pub(crate) fn read_i32_le(bytes: &[u8], offset: usize) -> Result<i32> {
    Ok(read_u32_le(bytes, offset)? as i32)
}

pub(crate) fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64> {
    let raw = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("truncated u64".to_string()))?;
    Ok(u64::from_le_bytes([
        raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
    ]))
}
