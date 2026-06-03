use super::{
    read_u16_le, read_u32_le, read_u64_le, Architecture, BinaryFormat, BinaryObject,
    ElfDynamicEntry, ElfDynamicMetadata, ElfDynamicTable, ElfDynamicTableSource, ElfDynamicTag,
    ElfPltMetadata, MetadataRange, ParsedBinary, Permissions, RelocationTableDescriptor,
    RelocationTableFormat, RelocationTableSource, Section, Segment, Symbol, SymbolBinding,
    SymbolKind, SymbolSource, UnwindMetadata,
};
use crate::diagnostic::{BinaryPatchError, Diagnostic, Result};
use crate::ir::Module;
use crate::layout::EncodedBlock;
use std::collections::BTreeMap;
use std::ops::Range;

const EI_CLASS: usize = 4;
const EI_DATA: usize = 5;
const ELFCLASS32: u8 = 1;
const ELFCLASS64: u8 = 2;
const ELFDATA2LSB: u8 = 1;
const EM_386: u16 = 3;
const EM_X86_64: u16 = 62;
const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PF_X: u32 = 1;
const PF_W: u32 = 2;
const PF_R: u32 = 4;
const SHT_SYMTAB: u32 = 2;
const SHT_STRTAB: u32 = 3;
const SHT_RELA: u32 = 4;
const SHT_DYNAMIC: u32 = 6;
const SHT_REL: u32 = 9;
const SHT_DYNSYM: u32 = 11;
const SHF_EXECINSTR: u64 = 0x4;
const SHN_UNDEF: u16 = 0;
const STT_OBJECT: u8 = 1;
const STT_FUNC: u8 = 2;
const STT_SECTION: u8 = 3;
const STT_FILE: u8 = 4;
const STB_LOCAL: u8 = 0;
const STB_GLOBAL: u8 = 1;
const STB_WEAK: u8 = 2;
const DT_NULL: u64 = 0;
const DT_NEEDED: u64 = 1;
const DT_PLTRELSZ: u64 = 2;
const DT_PLTGOT: u64 = 3;
const DT_STRTAB: u64 = 5;
const DT_SYMTAB: u64 = 6;
const DT_RELA: u64 = 7;
const DT_RELASZ: u64 = 8;
const DT_RELAENT: u64 = 9;
const DT_STRSZ: u64 = 10;
const DT_SYMENT: u64 = 11;
const DT_REL: u64 = 17;
const DT_RELSZ: u64 = 18;
const DT_RELENT: u64 = 19;
const DT_PLTREL: u64 = 20;
const DT_JMPREL: u64 = 23;
const DT_TEXTREL: u64 = 22;
const DT_FLAGS: u64 = 30;
const DF_TEXTREL: u64 = 0x4;
const DW_EH_PE_ABSPTR: u8 = 0x00;
const DW_EH_PE_UDATA2: u8 = 0x02;
const DW_EH_PE_UDATA4: u8 = 0x03;
const DW_EH_PE_UDATA8: u8 = 0x04;
const DW_EH_PE_SIGNED: u8 = 0x08;
const DW_EH_PE_SDATA2: u8 = 0x0a;
const DW_EH_PE_SDATA4: u8 = 0x0b;
const DW_EH_PE_SDATA8: u8 = 0x0c;
const DW_EH_PE_PCREL: u8 = 0x10;
const DW_EH_PE_OMIT: u8 = 0xff;

pub fn looks_like(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == b"\x7fELF"
}

pub(crate) fn parse(bytes: &[u8]) -> Result<ParsedBinary> {
    if bytes.len() < 0x34 || !looks_like(bytes) {
        return Err(BinaryPatchError::InvalidFormat(
            "missing ELF header".to_string(),
        ));
    }
    if bytes[EI_DATA] != ELFDATA2LSB {
        return Err(BinaryPatchError::Unsupported(
            "only little-endian ELF is supported".to_string(),
        ));
    }

    match bytes[EI_CLASS] {
        ELFCLASS32 => parse_elf32(bytes),
        ELFCLASS64 => parse_elf64(bytes),
        class => Err(BinaryPatchError::Unsupported(format!(
            "unknown ELF class {class}"
        ))),
    }
}

fn parse_elf64(bytes: &[u8]) -> Result<ParsedBinary> {
    if bytes.len() < 64 {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF64 header".to_string(),
        ));
    }

    let machine = read_u16_le(bytes, 18)?;
    let architecture = elf_machine(machine)?;
    let entry = read_u64_le(bytes, 24)?;
    let phoff = read_u64_le(bytes, 32)? as usize;
    let shoff = read_u64_le(bytes, 40)? as usize;
    let phentsize = read_u16_le(bytes, 54)? as usize;
    let phnum = read_u16_le(bytes, 56)? as usize;
    let shentsize = read_u16_le(bytes, 58)? as usize;
    let shnum = read_u16_le(bytes, 60)? as usize;
    let shstrndx = read_u16_le(bytes, 62)? as usize;

    let program_headers = parse_elf64_program_headers(bytes, phoff, phentsize, phnum)?;
    let segments = public_segments(&program_headers);

    let section_headers = parse_elf64_section_headers(bytes, shoff, shentsize, shnum)?;
    let sections = public_sections(bytes, &section_headers, shstrndx)?;
    let symbols = parse_symbols(bytes, &section_headers, true)?;
    let unwind_metadata = parse_unwind_metadata(bytes, &sections, true)?;
    let image_base = segments
        .iter()
        .map(|segment| segment.virtual_address.saturating_sub(segment.file_offset))
        .min()
        .unwrap_or(0);

    Ok(ParsedBinary {
        object: BinaryObject {
            format: BinaryFormat::Elf,
            architecture,
            entry,
            image_base,
            segments,
            sections,
            symbols,
            imports: Vec::new(),
            base_relocations: Vec::new(),
            unwind_metadata,
        },
        diagnostics: Vec::new(),
    })
}

fn parse_elf32(bytes: &[u8]) -> Result<ParsedBinary> {
    if bytes.len() < 52 {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF32 header".to_string(),
        ));
    }

    let machine = read_u16_le(bytes, 18)?;
    let architecture = elf_machine(machine)?;
    let entry = read_u32_le(bytes, 24)? as u64;
    let phoff = read_u32_le(bytes, 28)? as usize;
    let shoff = read_u32_le(bytes, 32)? as usize;
    let phentsize = read_u16_le(bytes, 42)? as usize;
    let phnum = read_u16_le(bytes, 44)? as usize;
    let shentsize = read_u16_le(bytes, 46)? as usize;
    let shnum = read_u16_le(bytes, 48)? as usize;
    let shstrndx = read_u16_le(bytes, 50)? as usize;

    let program_headers = parse_elf32_program_headers(bytes, phoff, phentsize, phnum)?;
    let segments = public_segments(&program_headers);

    let section_headers = parse_elf32_section_headers(bytes, shoff, shentsize, shnum)?;
    let sections = public_sections(bytes, &section_headers, shstrndx)?;
    let symbols = parse_symbols(bytes, &section_headers, false)?;
    let unwind_metadata = parse_unwind_metadata(bytes, &sections, false)?;
    let image_base = segments
        .iter()
        .map(|segment| segment.virtual_address.saturating_sub(segment.file_offset))
        .min()
        .unwrap_or(0);

    Ok(ParsedBinary {
        object: BinaryObject {
            format: BinaryFormat::Elf,
            architecture,
            entry,
            image_base,
            segments,
            sections,
            symbols,
            imports: Vec::new(),
            base_relocations: Vec::new(),
            unwind_metadata,
        },
        diagnostics: Vec::new(),
    })
}

#[derive(Debug, Clone)]
struct ElfProgramHeader {
    segment_type: u32,
    flags: u32,
    file_offset: u64,
    virtual_address: u64,
    file_size: u64,
    memory_size: u64,
}

#[derive(Debug, Clone)]
struct ElfSectionHeader {
    name_offset: u32,
    section_type: u32,
    flags: u64,
    virtual_address: u64,
    file_offset: u64,
    size: u64,
    link: u32,
    entry_size: u64,
}

#[derive(Debug, Clone, Copy)]
struct RawDynamicEntry {
    tag: u64,
    value: u64,
}

#[derive(Debug, Clone, Copy)]
struct DynamicStringTable {
    file_offset: u64,
    size: u64,
}

fn parse_elf64_program_headers(
    bytes: &[u8],
    phoff: usize,
    phentsize: usize,
    phnum: usize,
) -> Result<Vec<ElfProgramHeader>> {
    if phoff == 0 || phnum == 0 {
        return Ok(Vec::new());
    }

    let mut program_headers = Vec::with_capacity(phnum);
    for index in 0..phnum {
        let offset = phoff + index * phentsize;
        if phentsize < 56 || offset + phentsize > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated ELF64 program header".to_string(),
            ));
        }
        program_headers.push(ElfProgramHeader {
            segment_type: read_u32_le(bytes, offset)?,
            flags: read_u32_le(bytes, offset + 4)?,
            file_offset: read_u64_le(bytes, offset + 8)?,
            virtual_address: read_u64_le(bytes, offset + 16)?,
            file_size: read_u64_le(bytes, offset + 32)?,
            memory_size: read_u64_le(bytes, offset + 40)?,
        });
    }
    Ok(program_headers)
}

fn parse_elf32_program_headers(
    bytes: &[u8],
    phoff: usize,
    phentsize: usize,
    phnum: usize,
) -> Result<Vec<ElfProgramHeader>> {
    if phoff == 0 || phnum == 0 {
        return Ok(Vec::new());
    }

    let mut program_headers = Vec::with_capacity(phnum);
    for index in 0..phnum {
        let offset = phoff + index * phentsize;
        if phentsize < 32 || offset + phentsize > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated ELF32 program header".to_string(),
            ));
        }
        program_headers.push(ElfProgramHeader {
            segment_type: read_u32_le(bytes, offset)?,
            flags: read_u32_le(bytes, offset + 24)?,
            file_offset: read_u32_le(bytes, offset + 4)? as u64,
            virtual_address: read_u32_le(bytes, offset + 8)? as u64,
            file_size: read_u32_le(bytes, offset + 16)? as u64,
            memory_size: read_u32_le(bytes, offset + 20)? as u64,
        });
    }
    Ok(program_headers)
}

fn public_segments(headers: &[ElfProgramHeader]) -> Vec<Segment> {
    headers
        .iter()
        .filter(|header| header.segment_type == PT_LOAD)
        .map(|header| Segment {
            file_offset: header.file_offset,
            virtual_address: header.virtual_address,
            file_size: header.file_size,
            memory_size: header.memory_size,
            permissions: permissions_from_elf(header.flags),
        })
        .collect()
}

fn parse_elf64_section_headers(
    bytes: &[u8],
    shoff: usize,
    shentsize: usize,
    shnum: usize,
) -> Result<Vec<ElfSectionHeader>> {
    if shoff == 0 || shnum == 0 {
        return Ok(Vec::new());
    }

    let mut sections = Vec::new();
    for index in 0..shnum {
        let offset = shoff + index * shentsize;
        if shentsize < 64 || offset + shentsize > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated ELF64 section header".to_string(),
            ));
        }
        sections.push(ElfSectionHeader {
            name_offset: read_u32_le(bytes, offset)?,
            section_type: read_u32_le(bytes, offset + 4)?,
            flags: read_u64_le(bytes, offset + 8)?,
            virtual_address: read_u64_le(bytes, offset + 16)?,
            file_offset: read_u64_le(bytes, offset + 24)?,
            size: read_u64_le(bytes, offset + 32)?,
            link: read_u32_le(bytes, offset + 40)?,
            entry_size: read_u64_le(bytes, offset + 56)?,
        });
    }
    Ok(sections)
}

fn parse_elf32_section_headers(
    bytes: &[u8],
    shoff: usize,
    shentsize: usize,
    shnum: usize,
) -> Result<Vec<ElfSectionHeader>> {
    if shoff == 0 || shnum == 0 {
        return Ok(Vec::new());
    }

    let mut sections = Vec::new();
    for index in 0..shnum {
        let offset = shoff + index * shentsize;
        if shentsize < 40 || offset + shentsize > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated ELF32 section header".to_string(),
            ));
        }
        sections.push(ElfSectionHeader {
            name_offset: read_u32_le(bytes, offset)?,
            section_type: read_u32_le(bytes, offset + 4)?,
            flags: read_u32_le(bytes, offset + 8)? as u64,
            virtual_address: read_u32_le(bytes, offset + 12)? as u64,
            file_offset: read_u32_le(bytes, offset + 16)? as u64,
            size: read_u32_le(bytes, offset + 20)? as u64,
            link: read_u32_le(bytes, offset + 24)?,
            entry_size: read_u32_le(bytes, offset + 36)? as u64,
        });
    }
    Ok(sections)
}

pub(crate) fn parse_dynamic_metadata(
    bytes: &[u8],
    object: &BinaryObject,
) -> Result<Option<ElfDynamicMetadata>> {
    if bytes.len() < 0x34 || !looks_like(bytes) {
        return Err(BinaryPatchError::InvalidFormat(
            "missing ELF header".to_string(),
        ));
    }
    if bytes[EI_DATA] != ELFDATA2LSB {
        return Err(BinaryPatchError::Unsupported(
            "only little-endian ELF is supported".to_string(),
        ));
    }

    match bytes[EI_CLASS] {
        ELFCLASS32 => parse_elf32_dynamic_metadata(bytes, object),
        ELFCLASS64 => parse_elf64_dynamic_metadata(bytes, object),
        class => Err(BinaryPatchError::Unsupported(format!(
            "unknown ELF class {class}"
        ))),
    }
}

fn parse_elf64_dynamic_metadata(
    bytes: &[u8],
    object: &BinaryObject,
) -> Result<Option<ElfDynamicMetadata>> {
    if bytes.len() < 64 {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF64 header".to_string(),
        ));
    }

    let phoff = read_u64_le(bytes, 32)? as usize;
    let shoff = read_u64_le(bytes, 40)? as usize;
    let phentsize = read_u16_le(bytes, 54)? as usize;
    let phnum = read_u16_le(bytes, 56)? as usize;
    let shentsize = read_u16_le(bytes, 58)? as usize;
    let shnum = read_u16_le(bytes, 60)? as usize;
    let shstrndx = read_u16_le(bytes, 62)? as usize;
    let program_headers = parse_elf64_program_headers(bytes, phoff, phentsize, phnum)?;
    let section_headers = parse_elf64_section_headers(bytes, shoff, shentsize, shnum)?;
    build_dynamic_metadata(
        bytes,
        object,
        true,
        &program_headers,
        &section_headers,
        shstrndx,
    )
}

fn parse_elf32_dynamic_metadata(
    bytes: &[u8],
    object: &BinaryObject,
) -> Result<Option<ElfDynamicMetadata>> {
    if bytes.len() < 52 {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF32 header".to_string(),
        ));
    }

    let phoff = read_u32_le(bytes, 28)? as usize;
    let shoff = read_u32_le(bytes, 32)? as usize;
    let phentsize = read_u16_le(bytes, 42)? as usize;
    let phnum = read_u16_le(bytes, 44)? as usize;
    let shentsize = read_u16_le(bytes, 46)? as usize;
    let shnum = read_u16_le(bytes, 48)? as usize;
    let shstrndx = read_u16_le(bytes, 50)? as usize;
    let program_headers = parse_elf32_program_headers(bytes, phoff, phentsize, phnum)?;
    let section_headers = parse_elf32_section_headers(bytes, shoff, shentsize, shnum)?;
    build_dynamic_metadata(
        bytes,
        object,
        false,
        &program_headers,
        &section_headers,
        shstrndx,
    )
}

fn build_dynamic_metadata(
    bytes: &[u8],
    object: &BinaryObject,
    is_64_bit: bool,
    program_headers: &[ElfProgramHeader],
    section_headers: &[ElfSectionHeader],
    shstrndx: usize,
) -> Result<Option<ElfDynamicMetadata>> {
    let default_dynamic_entry_size = if is_64_bit { 16 } else { 8 } as u64;
    let dynamic_section = section_headers
        .iter()
        .find(|header| header.section_type == SHT_DYNAMIC && header.size != 0);
    let table = merge_dynamic_table_sources(
        program_headers
            .iter()
            .find(|header| header.segment_type == PT_DYNAMIC && header.file_size != 0)
            .map(|header| ElfDynamicTable {
                source: ElfDynamicTableSource::ProgramHeader,
                file_offset: header.file_offset,
                virtual_address: header.virtual_address,
                size: header.file_size,
                entry_size: default_dynamic_entry_size,
            }),
        dynamic_section.map(|section| ElfDynamicTable {
            source: ElfDynamicTableSource::SectionHeader,
            file_offset: section.file_offset,
            virtual_address: section.virtual_address,
            size: section.size,
            entry_size: if section.entry_size == 0 {
                default_dynamic_entry_size
            } else {
                section.entry_size
            },
        }),
    );
    let raw_entries = match table.as_ref() {
        Some(table) => parse_dynamic_entries(bytes, table, is_64_bit)?,
        None => Vec::new(),
    };
    let dynamic_strings =
        resolve_dynamic_string_table(bytes, object, section_headers, shstrndx, &raw_entries)?;
    let entries = parse_dynamic_entry_metadata(bytes, &raw_entries, dynamic_strings)?;
    let needed_libraries: Vec<String> = entries
        .iter()
        .filter(|entry| entry.tag == ElfDynamicTag::Needed)
        .filter_map(|entry| entry.string.clone())
        .collect();
    let plt = parse_plt_metadata(&raw_entries);
    let relocation_tables = parse_relocation_tables(
        bytes,
        object,
        is_64_bit,
        section_headers,
        shstrndx,
        &raw_entries,
        &plt,
    )?;
    let plt = resolve_plt_metadata(plt, &relocation_tables)?;

    if table.is_none()
        && entries.is_empty()
        && needed_libraries.is_empty()
        && relocation_tables.is_empty()
        && plt == ElfPltMetadata::default()
    {
        return Ok(None);
    }

    Ok(Some(ElfDynamicMetadata {
        table,
        entries,
        needed_libraries,
        plt,
        relocation_tables,
    }))
}

fn merge_dynamic_table_sources(
    program_header: Option<ElfDynamicTable>,
    section_header: Option<ElfDynamicTable>,
) -> Option<ElfDynamicTable> {
    match (program_header, section_header) {
        (Some(mut program), Some(section))
            if program.file_offset == section.file_offset
                && program.virtual_address == section.virtual_address
                && program.size == section.size =>
        {
            program.source = ElfDynamicTableSource::ProgramHeaderAndSectionHeader;
            if program.entry_size == 0 {
                program.entry_size = section.entry_size;
            }
            Some(program)
        }
        (Some(program), _) => Some(program),
        (None, Some(section)) => Some(section),
        (None, None) => None,
    }
}

fn parse_dynamic_entries(
    bytes: &[u8],
    table: &ElfDynamicTable,
    is_64_bit: bool,
) -> Result<Vec<RawDynamicEntry>> {
    let entry_size = if table.entry_size == 0 {
        if is_64_bit {
            16
        } else {
            8
        }
    } else {
        table.entry_size as usize
    };
    let minimum_entry_size = if is_64_bit { 16 } else { 8 };
    if entry_size < minimum_entry_size {
        return Err(BinaryPatchError::InvalidFormat(
            "ELF dynamic entry size is too small".to_string(),
        ));
    }
    if table.size == 0 {
        return Ok(Vec::new());
    }
    if !table.size.is_multiple_of(entry_size as u64) {
        return Err(BinaryPatchError::InvalidFormat(
            "ELF dynamic table size is not entry-aligned".to_string(),
        ));
    }

    let start = table.file_offset as usize;
    let size = table.size as usize;
    if start.checked_add(size).is_none_or(|end| end > bytes.len()) {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF dynamic table".to_string(),
        ));
    }

    let mut entries = Vec::new();
    for offset in (start..start + size).step_by(entry_size) {
        let entry = if is_64_bit {
            RawDynamicEntry {
                tag: read_u64_le(bytes, offset)?,
                value: read_u64_le(bytes, offset + 8)?,
            }
        } else {
            RawDynamicEntry {
                tag: read_u32_le(bytes, offset)? as u64,
                value: read_u32_le(bytes, offset + 4)? as u64,
            }
        };
        entries.push(entry);
        if entry.tag == DT_NULL {
            break;
        }
    }
    Ok(entries)
}

fn resolve_dynamic_string_table(
    bytes: &[u8],
    object: &BinaryObject,
    headers: &[ElfSectionHeader],
    shstrndx: usize,
    entries: &[RawDynamicEntry],
) -> Result<Option<DynamicStringTable>> {
    let dynamic_strtab_address = dynamic_entry_value(entries, DT_STRTAB);
    let dynamic_strtab_size = dynamic_entry_value(entries, DT_STRSZ);
    if let (Some(address), Some(size)) = (dynamic_strtab_address, dynamic_strtab_size) {
        if let Some(file_offset) = object.file_offset_for_virtual_address(address) {
            return Ok(Some(DynamicStringTable { file_offset, size }));
        }
    }

    for (index, section) in headers.iter().enumerate() {
        if section.section_type != SHT_STRTAB {
            continue;
        }
        let Some(name) = section_name(bytes, headers, shstrndx, index)? else {
            continue;
        };
        if name == ".dynstr" {
            return Ok(Some(DynamicStringTable {
                file_offset: section.file_offset,
                size: section.size,
            }));
        }
    }
    Ok(None)
}

fn parse_dynamic_entry_metadata(
    bytes: &[u8],
    raw_entries: &[RawDynamicEntry],
    strings: Option<DynamicStringTable>,
) -> Result<Vec<ElfDynamicEntry>> {
    raw_entries
        .iter()
        .map(|entry| {
            let tag = dynamic_tag(entry.tag);
            let string = match (tag, strings) {
                (ElfDynamicTag::Needed, Some(strings)) => {
                    Some(read_string_from_table(bytes, strings, entry.value)?)
                }
                _ => None,
            };
            let relocation_format = match tag {
                ElfDynamicTag::PltRel => dynamic_relocation_format(entry.value),
                _ => None,
            };
            Ok(ElfDynamicEntry {
                tag,
                value: entry.value,
                string,
                relocation_format,
            })
        })
        .collect()
}

fn parse_plt_metadata(entries: &[RawDynamicEntry]) -> ElfPltMetadata {
    ElfPltMetadata {
        got_address: dynamic_entry_value(entries, DT_PLTGOT),
        relocations_address: dynamic_entry_value(entries, DT_JMPREL),
        relocations_size: dynamic_entry_value(entries, DT_PLTRELSZ),
        relocation_format: dynamic_entry_value(entries, DT_PLTREL)
            .and_then(dynamic_relocation_format),
    }
}

fn parse_relocation_tables(
    bytes: &[u8],
    object: &BinaryObject,
    is_64_bit: bool,
    section_headers: &[ElfSectionHeader],
    shstrndx: usize,
    raw_entries: &[RawDynamicEntry],
    plt: &ElfPltMetadata,
) -> Result<Vec<RelocationTableDescriptor>> {
    let mut relocation_tables = Vec::new();
    for (index, section) in section_headers.iter().enumerate() {
        let format = match section.section_type {
            SHT_REL => RelocationTableFormat::Rel,
            SHT_RELA => RelocationTableFormat::Rela,
            _ => continue,
        };
        if section.size == 0 {
            continue;
        }
        let entry_size = if section.entry_size == 0 {
            default_relocation_entry_size(format, is_64_bit)
        } else {
            section.entry_size
        };
        merge_relocation_table(
            &mut relocation_tables,
            RelocationTableDescriptor {
                name: section_name(bytes, section_headers, shstrndx, index)?,
                format,
                source: RelocationTableSource::SectionHeader,
                file_offset: Some(section.file_offset),
                virtual_address: section.virtual_address,
                size: section.size,
                entry_size,
            },
        )?;
    }

    if let (Some(address), Some(size)) = (
        dynamic_entry_value(raw_entries, DT_RELA),
        dynamic_entry_value(raw_entries, DT_RELASZ),
    ) {
        merge_relocation_table(
            &mut relocation_tables,
            RelocationTableDescriptor {
                name: None,
                format: RelocationTableFormat::Rela,
                source: RelocationTableSource::DynamicEntry,
                file_offset: object.file_offset_for_virtual_address(address),
                virtual_address: address,
                size,
                entry_size: dynamic_entry_value(raw_entries, DT_RELAENT).unwrap_or(
                    default_relocation_entry_size(RelocationTableFormat::Rela, is_64_bit),
                ),
            },
        )?;
    }

    if let (Some(address), Some(size)) = (
        dynamic_entry_value(raw_entries, DT_REL),
        dynamic_entry_value(raw_entries, DT_RELSZ),
    ) {
        merge_relocation_table(
            &mut relocation_tables,
            RelocationTableDescriptor {
                name: None,
                format: RelocationTableFormat::Rel,
                source: RelocationTableSource::DynamicEntry,
                file_offset: object.file_offset_for_virtual_address(address),
                virtual_address: address,
                size,
                entry_size: dynamic_entry_value(raw_entries, DT_RELENT).unwrap_or(
                    default_relocation_entry_size(RelocationTableFormat::Rel, is_64_bit),
                ),
            },
        )?;
    }

    if let (Some(address), Some(size)) = (plt.relocations_address, plt.relocations_size) {
        let format = plt
            .relocation_format
            .or_else(|| infer_relocation_format(address, section_headers));
        if let Some(format) = format {
            let entry_size = match format {
                RelocationTableFormat::Rel => dynamic_entry_value(raw_entries, DT_RELENT)
                    .unwrap_or(default_relocation_entry_size(format, is_64_bit)),
                RelocationTableFormat::Rela => dynamic_entry_value(raw_entries, DT_RELAENT)
                    .unwrap_or(default_relocation_entry_size(format, is_64_bit)),
            };
            merge_relocation_table(
                &mut relocation_tables,
                RelocationTableDescriptor {
                    name: None,
                    format,
                    source: RelocationTableSource::DynamicEntry,
                    file_offset: object.file_offset_for_virtual_address(address),
                    virtual_address: address,
                    size,
                    entry_size,
                },
            )?;
        }
    }

    Ok(relocation_tables)
}

fn merge_relocation_table(
    relocation_tables: &mut Vec<RelocationTableDescriptor>,
    descriptor: RelocationTableDescriptor,
) -> Result<()> {
    if let Some(existing) = relocation_tables.iter_mut().find(|current| {
        current.format == descriptor.format && current.virtual_address == descriptor.virtual_address
    }) {
        if existing.size != descriptor.size {
            return Err(BinaryPatchError::InvalidFormat(format!(
                "ELF {} relocation descriptors disagree on size at {:#x} ({} vs {})",
                relocation_table_kind(existing.format),
                existing.virtual_address,
                existing.size,
                descriptor.size
            )));
        }
        if existing.entry_size != descriptor.entry_size
            && existing.entry_size != 0
            && descriptor.entry_size != 0
        {
            return Err(BinaryPatchError::InvalidFormat(format!(
                "ELF {} relocation descriptors disagree on entry size at {:#x} ({} vs {})",
                relocation_table_kind(existing.format),
                existing.virtual_address,
                existing.entry_size,
                descriptor.entry_size
            )));
        }
        existing.source = match (existing.source, descriptor.source) {
            (RelocationTableSource::SectionHeader, RelocationTableSource::DynamicEntry)
            | (RelocationTableSource::DynamicEntry, RelocationTableSource::SectionHeader)
            | (RelocationTableSource::SectionHeaderAndDynamicEntry, _)
            | (_, RelocationTableSource::SectionHeaderAndDynamicEntry) => {
                RelocationTableSource::SectionHeaderAndDynamicEntry
            }
            (source, _) => source,
        };
        if existing.name.is_none() {
            existing.name = descriptor.name;
        }
        if existing.file_offset.is_none() {
            existing.file_offset = descriptor.file_offset;
        } else if let Some(file_offset) = descriptor.file_offset {
            if let Some(existing_file_offset) = existing.file_offset {
                if existing_file_offset != file_offset {
                    return Err(BinaryPatchError::InvalidFormat(format!(
                        "ELF {} relocation descriptors disagree on file offset at {:#x} ({} vs {})",
                        relocation_table_kind(existing.format),
                        existing.virtual_address,
                        existing_file_offset,
                        file_offset
                    )));
                }
            }
        }
        if existing.entry_size == 0 {
            existing.entry_size = descriptor.entry_size;
        }
        return Ok(());
    }
    relocation_tables.push(descriptor);
    Ok(())
}

fn resolve_plt_metadata(
    mut plt: ElfPltMetadata,
    relocation_tables: &[RelocationTableDescriptor],
) -> Result<ElfPltMetadata> {
    if plt.relocation_format.is_some() {
        return Ok(plt);
    }
    let Some(address) = plt.relocations_address else {
        return Ok(plt);
    };
    let Some(size) = plt.relocations_size else {
        return Ok(plt);
    };

    let mut matching_tables = relocation_tables
        .iter()
        .filter(|table| table.virtual_address == address && table.size == size);
    let Some(first) = matching_tables.next() else {
        return Ok(plt);
    };
    if matching_tables.any(|table| table.format != first.format) {
        return Err(BinaryPatchError::InvalidFormat(format!(
            "ELF PLT relocation descriptors disagree on format at {address:#x}"
        )));
    }
    plt.relocation_format = Some(first.format);
    Ok(plt)
}

fn section_name(
    bytes: &[u8],
    headers: &[ElfSectionHeader],
    shstrndx: usize,
    index: usize,
) -> Result<Option<String>> {
    let Some(table) = headers
        .get(shstrndx)
        .filter(|section| section.section_type == SHT_STRTAB)
    else {
        return Ok(None);
    };
    let Some(section) = headers.get(index) else {
        return Ok(None);
    };
    if section.name_offset == 0 {
        return Ok(None);
    }
    Ok(Some(read_string(bytes, table, section.name_offset)?))
}

fn read_string_from_table(bytes: &[u8], table: DynamicStringTable, offset: u64) -> Result<String> {
    if offset >= table.size {
        return Err(BinaryPatchError::InvalidFormat(
            "ELF dynamic string offset is outside .dynstr".to_string(),
        ));
    }
    let start = table.file_offset as usize + offset as usize;
    let end =
        table.file_offset.checked_add(table.size).ok_or_else(|| {
            BinaryPatchError::InvalidFormat("ELF string table overflows".to_string())
        })? as usize;
    if end > bytes.len() || start >= end {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF dynamic string table".to_string(),
        ));
    }
    let string_end = bytes[start..end]
        .iter()
        .position(|byte| *byte == 0)
        .map(|index| start + index)
        .ok_or_else(|| {
            BinaryPatchError::InvalidFormat("unterminated ELF dynamic string".to_string())
        })?;
    Ok(String::from_utf8_lossy(&bytes[start..string_end]).to_string())
}

fn dynamic_entry_value(entries: &[RawDynamicEntry], tag: u64) -> Option<u64> {
    entries
        .iter()
        .find(|entry| entry.tag == tag)
        .map(|entry| entry.value)
}

fn dynamic_tag(tag: u64) -> ElfDynamicTag {
    match tag {
        DT_NULL => ElfDynamicTag::Null,
        DT_NEEDED => ElfDynamicTag::Needed,
        DT_STRTAB => ElfDynamicTag::StrTab,
        DT_STRSZ => ElfDynamicTag::StrSz,
        DT_SYMTAB => ElfDynamicTag::SymTab,
        DT_SYMENT => ElfDynamicTag::SymEnt,
        DT_PLTGOT => ElfDynamicTag::PltGot,
        DT_PLTRELSZ => ElfDynamicTag::PltRelSize,
        DT_PLTREL => ElfDynamicTag::PltRel,
        DT_JMPREL => ElfDynamicTag::JumpRel,
        DT_REL => ElfDynamicTag::Rel,
        DT_RELSZ => ElfDynamicTag::RelSize,
        DT_RELENT => ElfDynamicTag::RelEnt,
        DT_RELA => ElfDynamicTag::Rela,
        DT_RELASZ => ElfDynamicTag::RelaSize,
        DT_RELAENT => ElfDynamicTag::RelaEnt,
        other => ElfDynamicTag::Other(other),
    }
}

fn dynamic_relocation_format(value: u64) -> Option<RelocationTableFormat> {
    match value {
        DT_REL => Some(RelocationTableFormat::Rel),
        DT_RELA => Some(RelocationTableFormat::Rela),
        _ => None,
    }
}

fn infer_relocation_format(
    address: u64,
    headers: &[ElfSectionHeader],
) -> Option<RelocationTableFormat> {
    headers
        .iter()
        .find(|header| header.virtual_address == address)
        .and_then(|header| match header.section_type {
            SHT_REL => Some(RelocationTableFormat::Rel),
            SHT_RELA => Some(RelocationTableFormat::Rela),
            _ => None,
        })
}

fn default_relocation_entry_size(format: RelocationTableFormat, is_64_bit: bool) -> u64 {
    match (format, is_64_bit) {
        (RelocationTableFormat::Rel, true) => 16,
        (RelocationTableFormat::Rel, false) => 8,
        (RelocationTableFormat::Rela, true) => 24,
        (RelocationTableFormat::Rela, false) => 12,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ElfDynamicRelocationTableState {
    SectionBacked,
    DynamicEntryBackedResolved,
    DynamicEntryBackedUnresolved,
}

impl RelocationTableDescriptor {
    fn relocation_state(&self) -> ElfDynamicRelocationTableState {
        match self.source {
            RelocationTableSource::SectionHeader
            | RelocationTableSource::SectionHeaderAndDynamicEntry => {
                ElfDynamicRelocationTableState::SectionBacked
            }
            RelocationTableSource::DynamicEntry if self.file_offset.is_some() => {
                ElfDynamicRelocationTableState::DynamicEntryBackedResolved
            }
            RelocationTableSource::DynamicEntry => {
                ElfDynamicRelocationTableState::DynamicEntryBackedUnresolved
            }
        }
    }
}

impl ElfDynamicMetadata {
    pub(crate) fn validate_rewrite_support(&self) -> Result<()> {
        if self.has_text_relocations() {
            return Err(BinaryPatchError::Unsupported(
                "ELF requests text relocations and requires relocation-aware rewriting".to_string(),
            ));
        }

        if self.plt.relocations_address.is_some()
            && self.plt.relocations_size.is_some()
            && self.plt.relocation_format.is_none()
        {
            return Err(BinaryPatchError::Unsupported(
                "ELF PLT relocation table does not identify a relocation format".to_string(),
            ));
        }

        if !self.needed_libraries.is_empty() && self.relocation_tables.is_empty() {
            return Err(BinaryPatchError::Unsupported(
                "dynamically linked ELF exposes no resolved relocation tables".to_string(),
            ));
        }

        if let Some(table) = self.relocation_tables.iter().find(|table| {
            matches!(
                table.relocation_state(),
                ElfDynamicRelocationTableState::DynamicEntryBackedUnresolved
            )
        }) {
            return Err(BinaryPatchError::Unsupported(format!(
                "ELF relocation table at {:#x} is not file-backed",
                table.virtual_address
            )));
        }

        Ok(())
    }

    pub(crate) fn validate_relocated_blocks(&self, blocks: &[EncodedBlock]) -> Result<()> {
        let protected_ranges = self.relocated_protected_ranges()?;
        for block in blocks {
            let start = block.new_address;
            let end = start.checked_add(block.bytes.len() as u64).ok_or_else(|| {
                BinaryPatchError::Emit(format!(
                    "relocated ELF block at {start:#x} exceeds address space"
                ))
            })?;
            if let Some(conflict) = protected_ranges.iter().find(|protected| {
                ranges_overlap(start, end, protected.range.start, protected.range.end)
            }) {
                return Err(BinaryPatchError::Emit(format!(
                    "relocated ELF block at {start:#x}..{end:#x} overlaps {} at {:#x}..{:#x}",
                    conflict.label, conflict.range.start, conflict.range.end
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn rewrite_relocated_metadata(
        &self,
        source: &[u8],
        module: &Module,
        blocks: &[EncodedBlock],
        output: &mut [u8],
    ) -> Result<()> {
        for table in &self.relocation_tables {
            let Some(file_offset) = table.file_offset else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "ELF {} relocation table at {:#x} is not file-backed",
                    relocation_table_kind(table.format),
                    table.virtual_address
                )));
            };
            if table.entry_size == 0 {
                return Err(BinaryPatchError::InvalidFormat(format!(
                    "ELF {} relocation table entry size is zero",
                    relocation_table_kind(table.format)
                )));
            }
            let entry_size = table.entry_size as usize;
            let table_start = file_offset as usize;
            let table_end = table_start
                .checked_add(table.size as usize)
                .ok_or_else(|| {
                    BinaryPatchError::Emit(format!(
                        "ELF {} relocation table at {:#x} exceeds address space",
                        relocation_table_kind(table.format),
                        table.virtual_address
                    ))
                })?;
            if table_end > source.len() || table_end > output.len() {
                return Err(BinaryPatchError::InvalidFormat(format!(
                    "truncated ELF {} relocation table",
                    relocation_table_kind(table.format)
                )));
            }
            if !table.size.is_multiple_of(entry_size as u64) {
                return Err(BinaryPatchError::InvalidFormat(format!(
                    "ELF {} relocation table size is not entry-aligned",
                    relocation_table_kind(table.format)
                )));
            }

            match table.format {
                RelocationTableFormat::Rel => rewrite_elf_rel_table(
                    source,
                    module,
                    blocks,
                    output,
                    table_start,
                    table_end,
                    entry_size,
                )?,
                RelocationTableFormat::Rela => rewrite_elf_rela_table(
                    source,
                    module,
                    blocks,
                    output,
                    table_start,
                    table_end,
                    entry_size,
                )?,
            }
        }
        Ok(())
    }

    fn has_text_relocations(&self) -> bool {
        self.entries.iter().any(|entry| match entry.tag {
            ElfDynamicTag::Other(tag) if tag == DT_TEXTREL => true,
            ElfDynamicTag::Other(tag) if tag == DT_FLAGS && entry.value & DF_TEXTREL != 0 => true,
            _ => false,
        })
    }

    fn relocated_protected_ranges(&self) -> Result<Vec<ProtectedRange>> {
        let plt_table = self
            .plt
            .relocations_address
            .zip(self.plt.relocations_size)
            .and_then(|(address, size)| {
                self.relocation_tables
                    .iter()
                    .find(|table| table.virtual_address == address && table.size == size)
            });

        let mut protected_ranges = Vec::new();
        for table in &self.relocation_tables {
            let Some(size) = table.file_offset.map(|_| table.size) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "ELF {} relocation table at {:#x} is not file-backed",
                    relocation_table_kind(table.format),
                    table.virtual_address
                )));
            };
            let end = table.virtual_address.checked_add(size).ok_or_else(|| {
                BinaryPatchError::Unsupported(format!(
                    "ELF {} relocation table at {:#x} exceeds address space",
                    relocation_table_kind(table.format),
                    table.virtual_address
                ))
            })?;
            let label = if plt_table.is_some_and(|plt| {
                plt.virtual_address == table.virtual_address && plt.size == table.size
            }) {
                "ELF PLT relocation table".to_string()
            } else {
                relocation_table_label(table)
            };
            protected_ranges.push(ProtectedRange {
                range: table.virtual_address..end,
                label,
            });
        }
        Ok(protected_ranges)
    }
}

#[derive(Debug, Clone)]
struct ProtectedRange {
    range: Range<u64>,
    label: String,
}

fn relocation_table_kind(format: RelocationTableFormat) -> &'static str {
    match format {
        RelocationTableFormat::Rel => "REL",
        RelocationTableFormat::Rela => "RELA",
    }
}

fn relocation_table_label(table: &RelocationTableDescriptor) -> String {
    match &table.name {
        Some(name) => format!("ELF {} table {}", relocation_table_kind(table.format), name),
        None => format!(
            "ELF {} table at {:#x}",
            relocation_table_kind(table.format),
            table.virtual_address
        ),
    }
}

fn ranges_overlap(start: u64, end: u64, other_start: u64, other_end: u64) -> bool {
    start < other_end && other_start < end
}

fn rewrite_elf_rel_table(
    source: &[u8],
    module: &Module,
    blocks: &[EncodedBlock],
    output: &mut [u8],
    table_start: usize,
    table_end: usize,
    entry_size: usize,
) -> Result<()> {
    let is_64_bit = entry_size >= 16;
    for offset in (table_start..table_end).step_by(entry_size) {
        let target = if is_64_bit {
            read_u64_le(source, offset)?
        } else {
            read_u32_le(source, offset)? as u64
        };
        let Some(new_target) = relocated_target_address(module, blocks, target)? else {
            continue;
        };
        if is_64_bit {
            write_u64_le(output, offset, new_target)?;
        } else {
            if new_target > u32::MAX as u64 {
                return Err(BinaryPatchError::Emit(format!(
                    "ELF REL relocation target {new_target:#x} exceeds 32-bit address space"
                )));
            }
            write_u32_le(output, offset, new_target as u32)?;
        }
    }
    Ok(())
}

fn rewrite_elf_rela_table(
    source: &[u8],
    module: &Module,
    blocks: &[EncodedBlock],
    output: &mut [u8],
    table_start: usize,
    table_end: usize,
    entry_size: usize,
) -> Result<()> {
    let is_64_bit = entry_size >= 24;
    for offset in (table_start..table_end).step_by(entry_size) {
        let target = if is_64_bit {
            read_u64_le(source, offset)?
        } else {
            read_u32_le(source, offset)? as u64
        };
        let Some(new_target) = relocated_target_address(module, blocks, target)? else {
            continue;
        };
        if is_64_bit {
            write_u64_le(output, offset, new_target)?;
        } else {
            if new_target > u32::MAX as u64 {
                return Err(BinaryPatchError::Emit(format!(
                    "ELF RELA relocation target {new_target:#x} exceeds 32-bit address space"
                )));
            }
            write_u32_le(output, offset, new_target as u32)?;
        }
    }
    Ok(())
}

fn relocated_target_address(
    module: &Module,
    blocks: &[EncodedBlock],
    target: u64,
) -> Result<Option<u64>> {
    let Some(block) = module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
        .find(|block| target >= block.address && target < block.end_address())
    else {
        return Ok(None);
    };
    let Some(encoded_block) = blocks
        .iter()
        .find(|encoded| encoded.original_address == block.address)
    else {
        return Ok(None);
    };
    if encoded_block.original_address == encoded_block.new_address {
        return Ok(None);
    }
    if target != block.address {
        return Err(BinaryPatchError::Unsupported(format!(
            "ELF relocation target {target:#x} lies inside relocated block {:#x}..{:#x} and interior targets are not yet rewritten",
            block.address,
            block.end_address()
        )));
    }
    Ok(Some(encoded_block.new_address))
}

fn write_u32_le(output: &mut [u8], offset: usize, value: u32) -> Result<()> {
    let bytes = output
        .get_mut(offset..offset + 4)
        .ok_or_else(|| BinaryPatchError::Emit("u32 write exceeds file size".to_string()))?;
    bytes.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_u64_le(output: &mut [u8], offset: usize, value: u64) -> Result<()> {
    let bytes = output
        .get_mut(offset..offset + 8)
        .ok_or_else(|| BinaryPatchError::Emit("u64 write exceeds file size".to_string()))?;
    bytes.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn public_sections(
    bytes: &[u8],
    headers: &[ElfSectionHeader],
    shstrndx: usize,
) -> Result<Vec<Section>> {
    let name_table = headers
        .get(shstrndx)
        .filter(|section| section.section_type == SHT_STRTAB);
    headers
        .iter()
        .map(|header| {
            let name = match name_table {
                Some(table) if header.name_offset != 0 => {
                    Some(read_string(bytes, table, header.name_offset)?)
                }
                _ => None,
            };
            Ok(Section {
                name,
                virtual_address: header.virtual_address,
                file_offset: header.file_offset,
                size: header.size,
                executable: header.flags & SHF_EXECINSTR != 0,
            })
        })
        .collect()
}

fn parse_unwind_metadata(
    bytes: &[u8],
    sections: &[Section],
    is_64_bit: bool,
) -> Result<Option<UnwindMetadata>> {
    let mut metadata = UnwindMetadata::default();

    if let Some(section) = section_by_name(sections, ".eh_frame_hdr") {
        let end = section
            .virtual_address
            .checked_add(section.size)
            .ok_or_else(|| {
                BinaryPatchError::InvalidFormat("ELF .eh_frame_hdr range overflows".to_string())
            })?;
        metadata.push_protected_range(section.virtual_address..end, ".eh_frame_hdr");
    }

    if let Some(section) = section_by_name(sections, ".eh_frame") {
        let end = section
            .virtual_address
            .checked_add(section.size)
            .ok_or_else(|| {
                BinaryPatchError::InvalidFormat("ELF .eh_frame range overflows".to_string())
            })?;
        metadata.push_protected_range(section.virtual_address..end, ".eh_frame");
        for range in parse_eh_frame_function_ranges(bytes, section, is_64_bit)? {
            metadata.push_function_range(range.range, range.label);
        }
    }

    if metadata.is_empty() {
        Ok(None)
    } else {
        Ok(Some(metadata))
    }
}

fn parse_eh_frame_function_ranges(
    bytes: &[u8],
    section: &Section,
    is_64_bit: bool,
) -> Result<Vec<MetadataRange>> {
    let start = section.file_offset as usize;
    let end = section
        .file_offset
        .checked_add(section.size)
        .ok_or_else(|| {
            BinaryPatchError::InvalidFormat("ELF .eh_frame section overflows".to_string())
        })? as usize;
    if end > bytes.len() {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF .eh_frame section".to_string(),
        ));
    }

    let mut cie_pointer_encodings = BTreeMap::new();
    let mut ranges = Vec::new();
    let mut offset = start;
    while offset + 4 <= end {
        let length = read_u32_le(bytes, offset)? as usize;
        if length == 0 {
            break;
        }
        let entry_end = offset.checked_add(4 + length).ok_or_else(|| {
            BinaryPatchError::InvalidFormat("ELF .eh_frame entry overflows".to_string())
        })?;
        if entry_end > end {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated ELF .eh_frame entry".to_string(),
            ));
        }

        let cie_id = read_u32_le(bytes, offset + 4)?;
        if cie_id == 0 {
            let (pointer_encoding, _) =
                parse_eh_frame_cie(bytes, section, offset, entry_end, is_64_bit)?;
            cie_pointer_encodings.insert(offset as u64, pointer_encoding);
        } else {
            let cie_offset = (offset as u64 + 4)
                .checked_sub(cie_id as u64)
                .ok_or_else(|| {
                    BinaryPatchError::InvalidFormat(
                        "ELF .eh_frame FDE CIE pointer underflows".to_string(),
                    )
                })?;
            let pointer_encoding = *cie_pointer_encodings.get(&cie_offset).ok_or_else(|| {
                BinaryPatchError::Unsupported(format!(
                    "ELF .eh_frame FDE references unknown CIE at {cie_offset:#x}"
                ))
            })?;
            let mut cursor = offset + 8;
            let (initial_location, consumed) = decode_dwarf_pointer(
                bytes,
                section,
                cursor,
                entry_end,
                pointer_encoding,
                is_64_bit,
                true,
            )?;
            cursor += consumed;
            let (address_range, _) = decode_dwarf_pointer(
                bytes,
                section,
                cursor,
                entry_end,
                pointer_encoding,
                is_64_bit,
                false,
            )?;
            if address_range == 0 {
                return Err(BinaryPatchError::InvalidFormat(
                    "ELF .eh_frame function range is empty".to_string(),
                ));
            }
            let end_address = initial_location.checked_add(address_range).ok_or_else(|| {
                BinaryPatchError::InvalidFormat(
                    "ELF .eh_frame function range overflows".to_string(),
                )
            })?;
            ranges.push(MetadataRange {
                label: format!("ELF .eh_frame FDE at {offset:#x}"),
                range: initial_location..end_address,
            });
        }

        offset = entry_end;
    }

    Ok(ranges)
}

fn parse_eh_frame_cie(
    bytes: &[u8],
    section: &Section,
    entry_start: usize,
    entry_end: usize,
    is_64_bit: bool,
) -> Result<(u8, usize)> {
    let mut cursor = entry_start + 8;
    if cursor >= entry_end {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF .eh_frame CIE".to_string(),
        ));
    }
    let _version = *bytes.get(cursor).ok_or_else(|| {
        BinaryPatchError::InvalidFormat("truncated ELF .eh_frame CIE".to_string())
    })?;
    cursor += 1;

    let augmentation_end = bytes
        .get(cursor..entry_end)
        .and_then(|tail| {
            tail.iter()
                .position(|byte| *byte == 0)
                .map(|index| cursor + index)
        })
        .ok_or_else(|| {
            BinaryPatchError::InvalidFormat("unterminated ELF .eh_frame augmentation".to_string())
        })?;
    let augmentation = String::from_utf8_lossy(&bytes[cursor..augmentation_end]).to_string();
    cursor = augmentation_end + 1;

    let (_, consumed) = read_uleb128(bytes, cursor, entry_end)?;
    cursor += consumed;
    let (_, consumed) = read_sleb128(bytes, cursor, entry_end)?;
    cursor += consumed;
    let (_, consumed) = read_uleb128(bytes, cursor, entry_end)?;
    cursor += consumed;

    let mut pointer_encoding = DW_EH_PE_ABSPTR;
    if augmentation.starts_with('z') {
        let (augmentation_size, consumed) = read_uleb128(bytes, cursor, entry_end)?;
        cursor += consumed;
        let augmentation_end = cursor + augmentation_size as usize;
        if augmentation_end > entry_end {
            return Err(BinaryPatchError::InvalidFormat(
                "ELF .eh_frame CIE augmentation overflows".to_string(),
            ));
        }
        let mut augmentation_cursor = cursor;
        for ch in augmentation.chars().skip(1) {
            if augmentation_cursor > augmentation_end {
                return Err(BinaryPatchError::InvalidFormat(
                    "ELF .eh_frame CIE augmentation overflows".to_string(),
                ));
            }
            match ch {
                'S' => {}
                'L' => {
                    augmentation_cursor = augmentation_cursor.checked_add(1).ok_or_else(|| {
                        BinaryPatchError::InvalidFormat(
                            "ELF .eh_frame CIE augmentation overflows".to_string(),
                        )
                    })?;
                    if augmentation_cursor > augmentation_end {
                        return Err(BinaryPatchError::InvalidFormat(
                            "ELF .eh_frame CIE augmentation overflows".to_string(),
                        ));
                    }
                }
                'P' => {
                    let encoding = *bytes.get(augmentation_cursor).ok_or_else(|| {
                        BinaryPatchError::InvalidFormat(
                            "truncated ELF .eh_frame personality encoding".to_string(),
                        )
                    })?;
                    augmentation_cursor += 1;
                    let (_, consumed) = decode_dwarf_pointer(
                        bytes,
                        section,
                        augmentation_cursor,
                        augmentation_end,
                        encoding,
                        is_64_bit,
                        true,
                    )?;
                    augmentation_cursor += consumed;
                }
                'R' => {
                    pointer_encoding = *bytes.get(augmentation_cursor).ok_or_else(|| {
                        BinaryPatchError::InvalidFormat(
                            "truncated ELF .eh_frame pointer encoding".to_string(),
                        )
                    })?;
                    augmentation_cursor = augmentation_cursor.checked_add(1).ok_or_else(|| {
                        BinaryPatchError::InvalidFormat(
                            "ELF .eh_frame CIE augmentation overflows".to_string(),
                        )
                    })?;
                }
                other => {
                    return Err(BinaryPatchError::Unsupported(format!(
                        "ELF .eh_frame CIE augmentation {other:?} is unsupported"
                    )));
                }
            }
        }
        cursor = augmentation_end;
    }

    if cursor > entry_end {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF .eh_frame CIE".to_string(),
        ));
    }

    Ok((pointer_encoding, cursor - entry_start))
}

fn decode_dwarf_pointer(
    bytes: &[u8],
    section: &Section,
    field_offset: usize,
    entry_end: usize,
    encoding: u8,
    is_64_bit: bool,
    allow_relative: bool,
) -> Result<(u64, usize)> {
    let format = encoding & 0x0f;
    let size = match format {
        DW_EH_PE_ABSPTR => {
            if is_64_bit {
                8
            } else {
                4
            }
        }
        DW_EH_PE_UDATA2 | DW_EH_PE_SDATA2 => 2,
        DW_EH_PE_UDATA4 | DW_EH_PE_SDATA4 => 4,
        DW_EH_PE_UDATA8 | DW_EH_PE_SDATA8 => 8,
        DW_EH_PE_SIGNED => {
            if is_64_bit {
                8
            } else {
                4
            }
        }
        DW_EH_PE_OMIT => {
            return Err(BinaryPatchError::Unsupported(
                "ELF .eh_frame pointer encoding omits the value".to_string(),
            ));
        }
        other => {
            return Err(BinaryPatchError::Unsupported(format!(
                "ELF .eh_frame pointer encoding {other:#x} is unsupported"
            )));
        }
    };

    let end = field_offset.checked_add(size).ok_or_else(|| {
        BinaryPatchError::InvalidFormat("ELF .eh_frame pointer overflows".to_string())
    })?;
    if end > entry_end {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF .eh_frame pointer".to_string(),
        ));
    }

    let signed_value = match format {
        DW_EH_PE_ABSPTR => {
            if is_64_bit {
                read_u64_le(bytes, field_offset)? as i64
            } else {
                read_u32_le(bytes, field_offset)? as i64
            }
        }
        DW_EH_PE_UDATA2 => read_u16_le(bytes, field_offset)? as i64,
        DW_EH_PE_UDATA4 => read_u32_le(bytes, field_offset)? as i64,
        DW_EH_PE_UDATA8 => read_u64_le(bytes, field_offset)? as i64,
        DW_EH_PE_SIGNED => {
            if is_64_bit {
                read_u64_le(bytes, field_offset)? as i64
            } else {
                read_u32_le(bytes, field_offset)? as i32 as i64
            }
        }
        DW_EH_PE_SDATA2 => read_u16_le(bytes, field_offset)? as i16 as i64,
        DW_EH_PE_SDATA4 => read_u32_le(bytes, field_offset)? as i32 as i64,
        DW_EH_PE_SDATA8 => read_u64_le(bytes, field_offset)? as i64,
        DW_EH_PE_OMIT => unreachable!(),
        _ => unreachable!(),
    };

    let value = if allow_relative && encoding & DW_EH_PE_PCREL != 0 {
        let field_offset_u64 = field_offset as u64;
        let section_offset = field_offset_u64
            .checked_sub(section.file_offset)
            .ok_or_else(|| {
                BinaryPatchError::InvalidFormat(
                    "ELF .eh_frame pointer precedes its section".to_string(),
                )
            })?;
        let field_address = section
            .virtual_address
            .checked_add(section_offset)
            .ok_or_else(|| {
                BinaryPatchError::InvalidFormat(
                    "ELF .eh_frame pointer address overflows".to_string(),
                )
            })?;
        field_address.wrapping_add(signed_value as u64)
    } else {
        signed_value as u64
    };

    Ok((value, size))
}

fn read_uleb128(bytes: &[u8], offset: usize, entry_end: usize) -> Result<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;
    let mut cursor = offset;
    loop {
        if cursor >= entry_end {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated ULEB128 value".to_string(),
            ));
        }
        let byte = bytes[cursor];
        cursor += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok((value, cursor - offset));
        }
        shift += 7;
        if shift >= 64 {
            return Err(BinaryPatchError::InvalidFormat(
                "ULEB128 value is too large".to_string(),
            ));
        }
    }
}

fn read_sleb128(bytes: &[u8], offset: usize, entry_end: usize) -> Result<(i64, usize)> {
    let mut value = 0i64;
    let mut shift = 0u32;
    let mut cursor = offset;
    let mut byte: u8;
    loop {
        if cursor >= entry_end {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated SLEB128 value".to_string(),
            ));
        }
        byte = bytes[cursor];
        cursor += 1;
        value |= ((byte & 0x7f) as i64) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            break;
        }
        if shift >= 64 {
            return Err(BinaryPatchError::InvalidFormat(
                "SLEB128 value is too large".to_string(),
            ));
        }
    }
    if shift < 64 && byte & 0x40 != 0 {
        value |= !0 << shift;
    }
    Ok((value, cursor - offset))
}

fn section_by_name<'a>(sections: &'a [Section], name: &str) -> Option<&'a Section> {
    sections
        .iter()
        .find(|section| section.name.as_deref() == Some(name))
}

fn parse_symbols(
    bytes: &[u8],
    headers: &[ElfSectionHeader],
    is_64_bit: bool,
) -> Result<Vec<Symbol>> {
    let mut symbols = Vec::new();
    for section in headers {
        let source = match section.section_type {
            SHT_SYMTAB => SymbolSource::Static,
            SHT_DYNSYM => SymbolSource::Dynamic,
            _ => continue,
        };
        let strings = headers.get(section.link as usize).ok_or_else(|| {
            BinaryPatchError::InvalidFormat(
                "ELF symbol string table link is out of range".to_string(),
            )
        })?;
        if strings.section_type != SHT_STRTAB {
            return Err(BinaryPatchError::InvalidFormat(
                "ELF symbol table does not link to a string table".to_string(),
            ));
        }
        parse_symbol_table(bytes, section, strings, source, is_64_bit, &mut symbols)?;
    }
    Ok(symbols)
}

fn parse_symbol_table(
    bytes: &[u8],
    symbols_section: &ElfSectionHeader,
    strings: &ElfSectionHeader,
    source: SymbolSource,
    is_64_bit: bool,
    output: &mut Vec<Symbol>,
) -> Result<()> {
    let default_entry_size = if is_64_bit { 24 } else { 16 };
    let entry_size = if symbols_section.entry_size == 0 {
        default_entry_size
    } else {
        symbols_section.entry_size as usize
    };
    if entry_size < default_entry_size {
        return Err(BinaryPatchError::InvalidFormat(
            "ELF symbol entry size is too small".to_string(),
        ));
    }
    if symbols_section.size == 0 {
        return Ok(());
    }
    if !symbols_section.size.is_multiple_of(entry_size as u64) {
        return Err(BinaryPatchError::InvalidFormat(
            "ELF symbol table size is not entry-aligned".to_string(),
        ));
    }

    let table_start = symbols_section.file_offset as usize;
    let table_size = symbols_section.size as usize;
    if table_start
        .checked_add(table_size)
        .is_none_or(|end| end > bytes.len())
    {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF symbol table".to_string(),
        ));
    }

    for offset in (table_start..table_start + table_size).step_by(entry_size) {
        let raw = if is_64_bit {
            parse_elf64_symbol(bytes, offset)?
        } else {
            parse_elf32_symbol(bytes, offset)?
        };
        if raw.name_offset == 0 {
            continue;
        }
        let name = read_string(bytes, strings, raw.name_offset)?;
        if name.is_empty() {
            continue;
        }
        output.push(Symbol {
            name,
            address: raw.value,
            size: raw.size,
            kind: symbol_kind(raw.info & 0x0f),
            binding: symbol_binding(raw.info >> 4),
            source,
            section_index: (raw.section_index != SHN_UNDEF).then_some(raw.section_index),
        });
    }
    Ok(())
}

struct RawSymbol {
    name_offset: u32,
    info: u8,
    section_index: u16,
    value: u64,
    size: u64,
}

fn parse_elf64_symbol(bytes: &[u8], offset: usize) -> Result<RawSymbol> {
    Ok(RawSymbol {
        name_offset: read_u32_le(bytes, offset)?,
        info: *bytes
            .get(offset + 4)
            .ok_or_else(|| BinaryPatchError::InvalidFormat("truncated ELF64 symbol".to_string()))?,
        section_index: read_u16_le(bytes, offset + 6)?,
        value: read_u64_le(bytes, offset + 8)?,
        size: read_u64_le(bytes, offset + 16)?,
    })
}

fn parse_elf32_symbol(bytes: &[u8], offset: usize) -> Result<RawSymbol> {
    Ok(RawSymbol {
        name_offset: read_u32_le(bytes, offset)?,
        value: read_u32_le(bytes, offset + 4)? as u64,
        size: read_u32_le(bytes, offset + 8)? as u64,
        info: *bytes
            .get(offset + 12)
            .ok_or_else(|| BinaryPatchError::InvalidFormat("truncated ELF32 symbol".to_string()))?,
        section_index: read_u16_le(bytes, offset + 14)?,
    })
}

fn read_string(bytes: &[u8], table: &ElfSectionHeader, name_offset: u32) -> Result<String> {
    if name_offset as u64 >= table.size {
        return Err(BinaryPatchError::InvalidFormat(
            "ELF string offset is outside its string table".to_string(),
        ));
    }
    let start = table.file_offset as usize + name_offset as usize;
    let table_end =
        table.file_offset.checked_add(table.size).ok_or_else(|| {
            BinaryPatchError::InvalidFormat("ELF string table overflows".to_string())
        })? as usize;
    if table_end > bytes.len() || start >= table_end {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated ELF string table".to_string(),
        ));
    }
    let end = bytes[start..table_end]
        .iter()
        .position(|byte| *byte == 0)
        .map(|position| start + position)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("unterminated ELF string".to_string()))?;
    Ok(String::from_utf8_lossy(&bytes[start..end]).to_string())
}

fn symbol_kind(value: u8) -> SymbolKind {
    match value {
        STT_OBJECT => SymbolKind::Object,
        STT_FUNC => SymbolKind::Function,
        STT_SECTION => SymbolKind::Section,
        STT_FILE => SymbolKind::File,
        other => SymbolKind::Other(other),
    }
}

fn symbol_binding(value: u8) -> SymbolBinding {
    match value {
        STB_LOCAL => SymbolBinding::Local,
        STB_GLOBAL => SymbolBinding::Global,
        STB_WEAK => SymbolBinding::Weak,
        other => SymbolBinding::Other(other),
    }
}

fn elf_machine(machine: u16) -> Result<Architecture> {
    match machine {
        EM_386 => Ok(Architecture::X86),
        EM_X86_64 => Ok(Architecture::X86_64),
        other => Err(BinaryPatchError::Unsupported(format!(
            "ELF machine {other} is not x86/x86_64"
        ))),
    }
}

fn permissions_from_elf(flags: u32) -> Permissions {
    Permissions {
        read: flags & PF_R != 0,
        write: flags & PF_W != 0,
        execute: flags & PF_X != 0,
    }
}

#[allow(dead_code)]
fn _diagnostic_for_empty_executable_segments() -> Diagnostic {
    Diagnostic::warning("ELF has no executable load segment", None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_plt_relocation_format_from_matching_relocation_table() {
        let plt = ElfPltMetadata {
            got_address: None,
            relocations_address: Some(0x401140),
            relocations_size: Some(0x18),
            relocation_format: None,
        };
        let relocation_tables = vec![RelocationTableDescriptor {
            name: Some(".rela.plt".to_string()),
            format: RelocationTableFormat::Rela,
            source: RelocationTableSource::DynamicEntry,
            file_offset: Some(0x1140),
            virtual_address: 0x401140,
            size: 0x18,
            entry_size: 0x18,
        }];

        let resolved = resolve_plt_metadata(plt, &relocation_tables).expect("plt metadata");
        assert_eq!(
            resolved.relocation_format,
            Some(RelocationTableFormat::Rela)
        );
    }
}
