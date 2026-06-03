use super::{
    read_u16_le, read_u32_le, read_u64_le, Architecture, BaseRelocation, BaseRelocationKind,
    Binary, BinaryFormat, BinaryObject, Import, ImportEntry, ImportKind, MetadataRange,
    ParsedBinary, Permissions, Section, Segment, Symbol, SymbolBinding, SymbolKind, SymbolSource,
    UnwindMetadata,
};
use crate::diagnostic::{BinaryPatchError, Result};
use crate::ir::Module;
use crate::layout::EncodedBlock;
use std::ops::Range;

const IMAGE_FILE_MACHINE_I386: u16 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const IMAGE_NT_OPTIONAL_HDR32_MAGIC: u16 = 0x10b;
const IMAGE_NT_OPTIONAL_HDR64_MAGIC: u16 = 0x20b;
const IMAGE_SCN_MEM_EXECUTE: u32 = 0x2000_0000;
const IMAGE_SCN_MEM_READ: u32 = 0x4000_0000;
const IMAGE_SCN_MEM_WRITE: u32 = 0x8000_0000;
const IMAGE_ORDINAL_FLAG32: u64 = 0x8000_0000;
const IMAGE_ORDINAL_FLAG64: u64 = 0x8000_0000_0000_0000;
const IMAGE_DIRECTORY_ENTRY_EXPORT: usize = 0;
const IMAGE_DIRECTORY_ENTRY_IMPORT: usize = 1;
const IMAGE_DIRECTORY_ENTRY_EXCEPTION: usize = 3;
const IMAGE_DIRECTORY_ENTRY_BASERELOC: usize = 5;
const IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT: usize = 13;

pub fn looks_like(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && &bytes[..2] == b"MZ"
}

pub(crate) fn parse(bytes: &[u8]) -> Result<ParsedBinary> {
    if bytes.len() < 0x40 || !looks_like(bytes) {
        return Err(BinaryPatchError::InvalidFormat(
            "missing PE DOS header".to_string(),
        ));
    }

    let pe_offset = read_u32_le(bytes, 0x3c)? as usize;
    if pe_offset + 24 > bytes.len() || bytes.get(pe_offset..pe_offset + 4) != Some(b"PE\0\0") {
        return Err(BinaryPatchError::InvalidFormat(
            "missing PE signature".to_string(),
        ));
    }

    let machine = read_u16_le(bytes, pe_offset + 4)?;
    let architecture = pe_machine(machine)?;
    let section_count = read_u16_le(bytes, pe_offset + 6)? as usize;
    let optional_size = read_u16_le(bytes, pe_offset + 20)? as usize;
    let optional_offset = pe_offset + 24;
    if optional_offset + optional_size > bytes.len() {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated PE optional header".to_string(),
        ));
    }

    let optional_magic = read_u16_le(bytes, optional_offset)?;
    let (image_base, data_directory_offset, ordinal_flag, thunk_size) = match optional_magic {
        IMAGE_NT_OPTIONAL_HDR32_MAGIC => (
            read_u32_le(bytes, optional_offset + 28)? as u64,
            optional_offset + 96,
            IMAGE_ORDINAL_FLAG32,
            4u64,
        ),
        IMAGE_NT_OPTIONAL_HDR64_MAGIC => (
            read_u64_le(bytes, optional_offset + 24)?,
            optional_offset + 112,
            IMAGE_ORDINAL_FLAG64,
            8u64,
        ),
        other => {
            return Err(BinaryPatchError::Unsupported(format!(
                "unknown PE optional header magic {other:#x}"
            )))
        }
    };
    let entry_rva = read_u32_le(bytes, optional_offset + 16)? as u64;
    let entry = image_base + entry_rva;
    let section_offset = optional_offset + optional_size;
    let mut sections = Vec::new();
    let mut segments = Vec::new();

    for index in 0..section_count {
        let offset = section_offset + index * 40;
        if offset + 40 > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated PE section table".to_string(),
            ));
        }
        let raw_name = bytes.get(offset..offset + 8).unwrap_or_default();
        let name_end = raw_name.iter().position(|byte| *byte == 0).unwrap_or(8);
        let name = String::from_utf8_lossy(&raw_name[..name_end]).to_string();
        let virtual_size = read_u32_le(bytes, offset + 8)? as u64;
        let virtual_address = image_base + read_u32_le(bytes, offset + 12)? as u64;
        let raw_size = read_u32_le(bytes, offset + 16)? as u64;
        let raw_offset = read_u32_le(bytes, offset + 20)? as u64;
        let characteristics = read_u32_le(bytes, offset + 36)?;
        let permissions = Permissions {
            read: characteristics & IMAGE_SCN_MEM_READ != 0,
            write: characteristics & IMAGE_SCN_MEM_WRITE != 0,
            execute: characteristics & IMAGE_SCN_MEM_EXECUTE != 0,
        };
        sections.push(Section {
            name: Some(name),
            file_offset: raw_offset,
            virtual_address,
            size: raw_size,
            executable: permissions.execute,
        });
        segments.push(Segment {
            file_offset: raw_offset,
            virtual_address,
            file_size: raw_size,
            memory_size: virtual_size.max(raw_size),
            permissions,
        });
    }

    let data_directories =
        parse_data_directories(bytes, optional_offset, optional_size, data_directory_offset)?;
    let mut symbols = parse_export_symbols(
        bytes,
        image_base,
        &segments,
        data_directories.get(IMAGE_DIRECTORY_ENTRY_EXPORT).copied(),
    )?;
    let mut imports = Vec::new();

    let standard_imports = parse_import_descriptors(
        bytes,
        image_base,
        &segments,
        data_directories.get(IMAGE_DIRECTORY_ENTRY_IMPORT).copied(),
        ImportKind::Standard,
        ordinal_flag,
        thunk_size,
    )?;
    symbols.extend(standard_imports.symbols);
    imports.extend(standard_imports.descriptors);

    let delay_imports = parse_delay_import_descriptors(
        bytes,
        image_base,
        &segments,
        data_directories
            .get(IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT)
            .copied(),
        ordinal_flag,
        thunk_size,
    )?;
    symbols.extend(delay_imports.symbols);
    imports.extend(delay_imports.descriptors);

    let base_relocations = parse_base_relocations(
        bytes,
        image_base,
        &segments,
        data_directories
            .get(IMAGE_DIRECTORY_ENTRY_BASERELOC)
            .copied(),
    )?;
    let unwind_metadata = parse_unwind_metadata(
        bytes,
        image_base,
        &segments,
        &sections,
        data_directories
            .get(IMAGE_DIRECTORY_ENTRY_EXCEPTION)
            .copied(),
    )?;

    Ok(ParsedBinary {
        object: BinaryObject {
            format: BinaryFormat::Pe,
            architecture,
            entry,
            image_base,
            segments,
            sections,
            symbols,
            imports,
            base_relocations,
            unwind_metadata,
        },
        diagnostics: Vec::new(),
    })
}

#[derive(Debug, Clone, Copy)]
struct DataDirectory {
    rva: u32,
    size: u32,
}

#[derive(Debug)]
struct ParsedImports {
    descriptors: Vec<Import>,
    symbols: Vec<Symbol>,
}

#[derive(Debug, Clone, Copy)]
struct ImportParseContext<'a> {
    bytes: &'a [u8],
    image_base: u64,
    segments: &'a [Segment],
    ordinal_flag: u64,
    thunk_size: u64,
}

fn parse_data_directories(
    bytes: &[u8],
    optional_offset: usize,
    optional_size: usize,
    data_directory_offset: usize,
) -> Result<Vec<DataDirectory>> {
    let number_offset = data_directory_offset.checked_sub(4).ok_or_else(|| {
        BinaryPatchError::InvalidFormat("invalid PE data directory offset".to_string())
    })?;
    if number_offset + 4 > optional_offset + optional_size {
        return Ok(Vec::new());
    }
    let declared = read_u32_le(bytes, number_offset)? as usize;
    let optional_end = optional_offset + optional_size;
    if data_directory_offset >= optional_end {
        return Ok(Vec::new());
    }
    let available = (optional_end - data_directory_offset) / 8;
    let count = declared.min(available);
    let mut directories = Vec::with_capacity(count);
    for index in 0..count {
        let offset = data_directory_offset + index * 8;
        directories.push(DataDirectory {
            rva: read_u32_le(bytes, offset)?,
            size: read_u32_le(bytes, offset + 4)?,
        });
    }
    Ok(directories)
}

fn parse_export_symbols(
    bytes: &[u8],
    image_base: u64,
    segments: &[Segment],
    directory: Option<DataDirectory>,
) -> Result<Vec<Symbol>> {
    let Some(directory) = directory.filter(|directory| directory.rva != 0 && directory.size >= 40)
    else {
        return Ok(Vec::new());
    };
    let export_offset = match rva_to_file_offset(segments, image_base, directory.rva as u64) {
        Some(offset) => offset,
        None => return Ok(Vec::new()),
    };
    if export_offset + 40 > bytes.len() {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated PE export directory".to_string(),
        ));
    }

    let number_of_functions = read_u32_le(bytes, export_offset + 20)? as usize;
    let number_of_names = read_u32_le(bytes, export_offset + 24)? as usize;
    let functions_rva = read_u32_le(bytes, export_offset + 28)?;
    let names_rva = read_u32_le(bytes, export_offset + 32)?;
    let ordinals_rva = read_u32_le(bytes, export_offset + 36)?;
    let functions_offset = rva_to_file_offset(segments, image_base, functions_rva as u64)
        .ok_or_else(|| {
            BinaryPatchError::InvalidFormat("PE export function table is unmapped".to_string())
        })?;
    let names_offset =
        rva_to_file_offset(segments, image_base, names_rva as u64).ok_or_else(|| {
            BinaryPatchError::InvalidFormat("PE export name table is unmapped".to_string())
        })?;
    let ordinals_offset = rva_to_file_offset(segments, image_base, ordinals_rva as u64)
        .ok_or_else(|| {
            BinaryPatchError::InvalidFormat("PE export ordinal table is unmapped".to_string())
        })?;

    let mut symbols = Vec::new();
    for index in 0..number_of_names {
        let name_rva = read_u32_le(bytes, names_offset + index * 4)?;
        let name_offset =
            rva_to_file_offset(segments, image_base, name_rva as u64).ok_or_else(|| {
                BinaryPatchError::InvalidFormat("PE export name is unmapped".to_string())
            })?;
        let name = read_c_string(bytes, name_offset)?;
        let ordinal = read_u16_le(bytes, ordinals_offset + index * 2)? as usize;
        if ordinal >= number_of_functions {
            return Err(BinaryPatchError::InvalidFormat(
                "PE export ordinal is outside function table".to_string(),
            ));
        }
        let function_rva = read_u32_le(bytes, functions_offset + ordinal * 4)?;
        if function_rva == 0 || rva_in_directory(function_rva, directory) {
            continue;
        }
        let address = image_base + function_rva as u64;
        symbols.push(Symbol {
            name,
            address,
            size: 0,
            kind: SymbolKind::Function,
            binding: SymbolBinding::Global,
            source: SymbolSource::Export,
            section_index: section_index_for_address(segments, address),
        });
    }
    Ok(symbols)
}

fn parse_import_descriptors(
    bytes: &[u8],
    image_base: u64,
    segments: &[Segment],
    directory: Option<DataDirectory>,
    kind: ImportKind,
    ordinal_flag: u64,
    thunk_size: u64,
) -> Result<ParsedImports> {
    let Some(directory) = directory.filter(|directory| directory.rva != 0) else {
        return Ok(ParsedImports {
            descriptors: Vec::new(),
            symbols: Vec::new(),
        });
    };
    if directory.size < 20 {
        return Err(BinaryPatchError::InvalidFormat(
            "invalid PE import directory size".to_string(),
        ));
    }
    let start_offset = match rva_to_file_offset(segments, image_base, directory.rva as u64) {
        Some(offset) => offset,
        None => {
            return Err(BinaryPatchError::Unsupported(
                "PE import directory is not file-backed".to_string(),
            ))
        }
    };
    let context = ImportParseContext {
        bytes,
        image_base,
        segments,
        ordinal_flag,
        thunk_size,
    };

    let mut descriptors = Vec::new();
    let mut symbols = Vec::new();
    let directory_size = directory.size as usize;
    let mut relative_offset = 0usize;
    while relative_offset + 20 <= directory_size {
        let descriptor_offset = start_offset + relative_offset;
        if descriptor_offset + 20 > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated PE import descriptor".to_string(),
            ));
        }

        let original_first_thunk = read_u32_le(bytes, descriptor_offset)?;
        let timestamp = read_u32_le(bytes, descriptor_offset + 4)?;
        let name_rva = read_u32_le(bytes, descriptor_offset + 12)?;
        let first_thunk = read_u32_le(bytes, descriptor_offset + 16)?;
        if original_first_thunk == 0 && name_rva == 0 && first_thunk == 0 {
            break;
        }

        let name_offset =
            rva_to_file_offset(segments, image_base, name_rva as u64).ok_or_else(|| {
                BinaryPatchError::InvalidFormat("PE import descriptor name is unmapped".to_string())
            })?;
        let library = read_c_string(bytes, name_offset)?;
        let lookup_table_rva = if original_first_thunk != 0 {
            Some(original_first_thunk)
        } else {
            None
        };
        let table_address = image_base + first_thunk as u64;
        let entries = parse_import_entries(
            &context,
            &library,
            lookup_table_rva.map(|rva| image_base + rva as u64),
            table_address,
            &mut symbols,
        )?;
        descriptors.push(Import {
            library,
            kind,
            descriptor_address: image_base + directory.rva as u64 + relative_offset as u64,
            name_address: image_base + name_rva as u64,
            lookup_table_address: lookup_table_rva.map(|rva| image_base + rva as u64),
            address_table_address: table_address,
            module_handle_address: None,
            bound_address_table_address: None,
            unload_address_table_address: None,
            timestamp,
            attributes: 0,
            entries,
        });
        relative_offset += 20;
    }

    Ok(ParsedImports {
        descriptors,
        symbols,
    })
}

fn parse_delay_import_descriptors(
    bytes: &[u8],
    image_base: u64,
    segments: &[Segment],
    directory: Option<DataDirectory>,
    ordinal_flag: u64,
    thunk_size: u64,
) -> Result<ParsedImports> {
    let Some(directory) = directory.filter(|directory| directory.rva != 0) else {
        return Ok(ParsedImports {
            descriptors: Vec::new(),
            symbols: Vec::new(),
        });
    };
    if directory.size < 32 {
        return Err(BinaryPatchError::InvalidFormat(
            "invalid PE delay import directory size".to_string(),
        ));
    }
    let start_offset = match rva_to_file_offset(segments, image_base, directory.rva as u64) {
        Some(offset) => offset,
        None => {
            return Err(BinaryPatchError::Unsupported(
                "PE delay import directory is not file-backed".to_string(),
            ))
        }
    };
    let context = ImportParseContext {
        bytes,
        image_base,
        segments,
        ordinal_flag,
        thunk_size,
    };

    let mut descriptors = Vec::new();
    let mut symbols = Vec::new();
    let directory_size = directory.size as usize;
    let mut relative_offset = 0usize;
    while relative_offset + 32 <= directory_size {
        let descriptor_offset = start_offset + relative_offset;
        if descriptor_offset + 32 > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated PE delay import descriptor".to_string(),
            ));
        }

        let attributes = read_u32_le(bytes, descriptor_offset)?;
        let name_field = read_u32_le(bytes, descriptor_offset + 4)?;
        let module_handle_field = read_u32_le(bytes, descriptor_offset + 8)?;
        let iat_field = read_u32_le(bytes, descriptor_offset + 12)?;
        let int_field = read_u32_le(bytes, descriptor_offset + 16)?;
        let bound_iat_field = read_u32_le(bytes, descriptor_offset + 20)?;
        let unload_iat_field = read_u32_le(bytes, descriptor_offset + 24)?;
        let timestamp = read_u32_le(bytes, descriptor_offset + 28)?;
        if attributes == 0
            && name_field == 0
            && module_handle_field == 0
            && iat_field == 0
            && int_field == 0
            && bound_iat_field == 0
            && unload_iat_field == 0
            && timestamp == 0
        {
            break;
        }

        let addresses_are_rva = attributes & 1 != 0;
        let name_address =
            resolve_directory_field_address(image_base, name_field, addresses_are_rva).ok_or_else(
                || {
                    BinaryPatchError::InvalidFormat(
                        "PE delay import descriptor name address is invalid".to_string(),
                    )
                },
            )?;
        let name_offset = address_to_file_offset(segments, name_address).ok_or_else(|| {
            BinaryPatchError::InvalidFormat(
                "PE delay import descriptor name is unmapped".to_string(),
            )
        })?;
        let library = read_c_string(bytes, name_offset)?;

        let address_table_address = resolve_directory_field_address(
            image_base,
            iat_field,
            addresses_are_rva,
        )
        .ok_or_else(|| {
            BinaryPatchError::InvalidFormat("PE delay import address table is invalid".to_string())
        })?;
        let lookup_table_address = if int_field != 0 {
            Some(
                resolve_directory_field_address(image_base, int_field, addresses_are_rva)
                    .ok_or_else(|| {
                        BinaryPatchError::InvalidFormat(
                            "PE delay import lookup table is invalid".to_string(),
                        )
                    })?,
            )
        } else {
            None
        };
        let entries = parse_import_entries(
            &context,
            &library,
            lookup_table_address,
            address_table_address,
            &mut symbols,
        )?;
        descriptors.push(Import {
            library,
            kind: ImportKind::Delay,
            descriptor_address: image_base + directory.rva as u64 + relative_offset as u64,
            name_address,
            lookup_table_address,
            address_table_address,
            module_handle_address: resolve_directory_field_address(
                image_base,
                module_handle_field,
                addresses_are_rva,
            ),
            bound_address_table_address: resolve_directory_field_address(
                image_base,
                bound_iat_field,
                addresses_are_rva,
            ),
            unload_address_table_address: resolve_directory_field_address(
                image_base,
                unload_iat_field,
                addresses_are_rva,
            ),
            timestamp,
            attributes,
            entries,
        });
        relative_offset += 32;
    }

    Ok(ParsedImports {
        descriptors,
        symbols,
    })
}

fn parse_import_entries(
    context: &ImportParseContext<'_>,
    library: &str,
    lookup_table_address: Option<u64>,
    address_table_address: u64,
    symbols: &mut Vec<Symbol>,
) -> Result<Vec<ImportEntry>> {
    let table_address = lookup_table_address.unwrap_or(address_table_address);
    let mut table_offset =
        address_to_file_offset(context.segments, table_address).ok_or_else(|| {
            BinaryPatchError::InvalidFormat("PE import thunk table is unmapped".to_string())
        })?;
    let mut index = 0u64;
    let mut entries = Vec::new();

    loop {
        let thunk = if context.thunk_size == 8 {
            read_u64_le(context.bytes, table_offset)?
        } else {
            read_u32_le(context.bytes, table_offset)? as u64
        };
        if thunk == 0 {
            break;
        }

        let lookup_address = table_address + index * context.thunk_size;
        let address_table_entry = address_table_address + index * context.thunk_size;
        let (name, ordinal, hint) = if thunk & context.ordinal_flag != 0 {
            (None, Some((thunk & 0xffff) as u16), None)
        } else {
            let import_by_name_offset = import_name_pointer_to_file_offset(context, thunk)
                .ok_or_else(|| {
                    BinaryPatchError::InvalidFormat(
                        "PE import-by-name entry is unmapped".to_string(),
                    )
                })?;
            let hint = read_u16_le(context.bytes, import_by_name_offset)?;
            let name = read_c_string(context.bytes, import_by_name_offset + 2)?;
            (Some(name), None, Some(hint))
        };
        let symbol_name = name
            .clone()
            .unwrap_or_else(|| format!("{library}!#{}", ordinal.unwrap_or_default()));
        symbols.push(Symbol {
            name: symbol_name,
            address: address_table_entry,
            size: context.thunk_size,
            kind: SymbolKind::Function,
            binding: SymbolBinding::Global,
            source: SymbolSource::Import,
            section_index: None,
        });
        entries.push(ImportEntry {
            name,
            ordinal,
            hint,
            lookup_address: Some(lookup_address),
            address_table_address: address_table_entry,
        });

        table_offset += context.thunk_size as usize;
        index += 1;
    }

    Ok(entries)
}

fn parse_base_relocations(
    bytes: &[u8],
    image_base: u64,
    segments: &[Segment],
    directory: Option<DataDirectory>,
) -> Result<Vec<BaseRelocation>> {
    let blocks = parse_base_relocation_blocks(bytes, image_base, segments, directory)?;
    let mut relocations = Vec::new();
    for block in blocks {
        for entry in block.entries {
            relocations.push(BaseRelocation {
                page_address: block.page_address,
                address: entry.address,
                offset: entry.offset,
                kind: entry.kind,
            });
        }
    }
    Ok(relocations)
}

pub(crate) fn rewrite_relocated_metadata(
    binary: &Binary,
    module: &Module,
    blocks: &[EncodedBlock],
    output: &mut [u8],
) -> Result<()> {
    let directory = pe_data_directories(binary)?
        .get(IMAGE_DIRECTORY_ENTRY_BASERELOC)
        .copied();
    let Some(directory) = directory.filter(|directory| directory.rva != 0) else {
        return Ok(());
    };
    let raw_blocks = parse_base_relocation_blocks(
        binary.bytes(),
        binary.object().image_base,
        &binary.object().segments,
        Some(directory),
    )?;
    for block in raw_blocks {
        for entry in block.entries {
            let Some(new_target) = relocated_target_address(module, blocks, entry.address)? else {
                continue;
            };
            if entry.kind == BaseRelocationKind::Absolute {
                continue;
            }
            match entry.kind {
                BaseRelocationKind::Dir64 | BaseRelocationKind::HighLow => {
                    let new_page_address = new_target & !0xfff;
                    if new_page_address != block.page_address {
                        return Err(BinaryPatchError::Unsupported(format!(
                            "PE base relocation target {:#x} moved across page boundaries from {:#x} to {:#x}; block reshaping is not implemented yet",
                            entry.address,
                            block.page_address,
                            new_page_address
                        )));
                    }
                    let new_offset = (new_target - new_page_address) as u16;
                    let raw = (entry.kind_code() << 12) | new_offset;
                    write_u16_le(output, entry.file_offset, raw)?;
                }
                other => {
                    return Err(BinaryPatchError::Unsupported(format!(
                        "PE base relocation {:?} at {:#x} is not supported for relocation writeback",
                        other, entry.address
                    )));
                }
            }
        }
    }
    Ok(())
}

fn parse_base_relocation_blocks(
    bytes: &[u8],
    image_base: u64,
    segments: &[Segment],
    directory: Option<DataDirectory>,
) -> Result<Vec<BaseRelocationBlock>> {
    let Some(directory) = directory.filter(|directory| directory.rva != 0) else {
        return Ok(Vec::new());
    };
    if directory.size < 8 {
        return Err(BinaryPatchError::InvalidFormat(
            "invalid PE base relocation directory size".to_string(),
        ));
    }
    let start_offset = match rva_to_file_offset(segments, image_base, directory.rva as u64) {
        Some(offset) => offset,
        None => {
            return Err(BinaryPatchError::Unsupported(
                "PE base relocation directory is not file-backed".to_string(),
            ))
        }
    };

    let mut blocks = Vec::new();
    let mut relative_offset = 0usize;
    let directory_size = directory.size as usize;
    while relative_offset + 8 <= directory_size {
        let block_offset = start_offset + relative_offset;
        if block_offset + 8 > bytes.len() {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated PE base relocation block".to_string(),
            ));
        }

        let page_rva = read_u32_le(bytes, block_offset)?;
        let block_size = read_u32_le(bytes, block_offset + 4)? as usize;
        if page_rva == 0 && block_size == 0 {
            break;
        }
        if block_size < 8 || !block_size.is_multiple_of(2) {
            return Err(BinaryPatchError::InvalidFormat(
                "invalid PE base relocation block size".to_string(),
            ));
        }
        if relative_offset + block_size > directory_size || block_offset + block_size > bytes.len()
        {
            return Err(BinaryPatchError::InvalidFormat(
                "truncated PE base relocation entries".to_string(),
            ));
        }

        let page_address = image_base + page_rva as u64;
        let entry_count = (block_size - 8) / 2;
        let mut entries = Vec::with_capacity(entry_count);
        for index in 0..entry_count {
            let raw = read_u16_le(bytes, block_offset + 8 + index * 2)?;
            let kind = (raw >> 12) as u16;
            let offset = raw & 0x0fff;
            let address = page_address + offset as u64;
            entries.push(BaseRelocationEntry {
                file_offset: block_offset + 8 + index * 2,
                address,
                offset,
                kind: base_relocation_kind(kind),
            });
        }
        blocks.push(BaseRelocationBlock {
            page_address,
            entries,
        });
        relative_offset += block_size;
    }

    Ok(blocks)
}

fn parse_unwind_metadata(
    bytes: &[u8],
    image_base: u64,
    segments: &[Segment],
    sections: &[Section],
    directory: Option<DataDirectory>,
) -> Result<Option<UnwindMetadata>> {
    let mut metadata = UnwindMetadata::default();

    if let Some(section) = section_by_name(sections, ".pdata") {
        let end = section
            .virtual_address
            .checked_add(section.size)
            .ok_or_else(|| {
                BinaryPatchError::InvalidFormat("PE .pdata range overflows".to_string())
            })?;
        metadata.push_protected_range(section.virtual_address..end, ".pdata");
    }
    if let Some(section) = section_by_name(sections, ".xdata") {
        let end = section
            .virtual_address
            .checked_add(section.size)
            .ok_or_else(|| {
                BinaryPatchError::InvalidFormat("PE .xdata range overflows".to_string())
            })?;
        metadata.push_protected_range(section.virtual_address..end, ".xdata");
    }
    if let Some(directory) = directory.filter(|directory| directory.rva != 0 && directory.size != 0)
    {
        let start_address = image_base
            .checked_add(directory.rva as u64)
            .ok_or_else(|| {
                BinaryPatchError::Emit("PE exception directory exceeds address space".to_string())
            })?;
        let end_address = start_address
            .checked_add(directory.size as u64)
            .ok_or_else(|| {
                BinaryPatchError::Emit("PE exception directory exceeds address space".to_string())
            })?;
        let start_offset = rva_to_file_offset(segments, image_base, directory.rva as u64)
            .ok_or_else(|| {
                BinaryPatchError::Unsupported(
                    "PE exception directory is not file-backed".to_string(),
                )
            })?;
        let end_offset = rva_to_file_offset(
            segments,
            image_base,
            directory.rva as u64 + directory.size as u64 - 1,
        )
        .ok_or_else(|| {
            BinaryPatchError::Unsupported("PE exception directory is not file-backed".to_string())
        })?;
        let _ = (start_offset, end_offset);
        metadata.push_protected_range(start_address..end_address, "exception directory");
        for range in
            parse_runtime_function_ranges(bytes, image_base, start_offset, directory.size as usize)?
        {
            metadata.push_function_range(range.range, range.label);
        }
    } else if let Some(section) = section_by_name(sections, ".pdata") {
        for range in parse_runtime_function_ranges(
            bytes,
            image_base,
            section.file_offset as usize,
            section.size as usize,
        )? {
            metadata.push_function_range(range.range, range.label);
        }
    }

    if metadata.is_empty() {
        Ok(None)
    } else {
        Ok(Some(metadata))
    }
}

fn parse_runtime_function_ranges(
    bytes: &[u8],
    image_base: u64,
    start_offset: usize,
    size: usize,
) -> Result<Vec<MetadataRange>> {
    if size == 0 {
        return Ok(Vec::new());
    }
    if size < 12 || !size.is_multiple_of(12) {
        return Err(BinaryPatchError::InvalidFormat(
            "invalid PE exception directory size".to_string(),
        ));
    }
    if start_offset
        .checked_add(size)
        .is_none_or(|end| end > bytes.len())
    {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated PE exception directory".to_string(),
        ));
    }

    let mut ranges = Vec::new();
    for offset in (start_offset..start_offset + size).step_by(12) {
        let begin_rva = read_u32_le(bytes, offset)?;
        let end_rva = read_u32_le(bytes, offset + 4)?;
        let unwind_rva = read_u32_le(bytes, offset + 8)?;
        if begin_rva == 0 && end_rva == 0 && unwind_rva == 0 {
            break;
        }
        if end_rva <= begin_rva {
            return Err(BinaryPatchError::InvalidFormat(
                "PE runtime function range is empty or inverted".to_string(),
            ));
        }

        let start = image_base.checked_add(begin_rva as u64).ok_or_else(|| {
            BinaryPatchError::Emit("PE runtime function exceeds address space".to_string())
        })?;
        let end = image_base.checked_add(end_rva as u64).ok_or_else(|| {
            BinaryPatchError::Emit("PE runtime function exceeds address space".to_string())
        })?;
        ranges.push(MetadataRange {
            label: format!("PE runtime function at {start:#x}"),
            range: start..end,
        });
    }
    Ok(ranges)
}

fn resolve_directory_field_address(
    image_base: u64,
    value: u32,
    addresses_are_rva: bool,
) -> Option<u64> {
    if value == 0 {
        None
    } else if addresses_are_rva {
        image_base.checked_add(value as u64)
    } else {
        Some(value as u64)
    }
}

fn import_name_pointer_to_file_offset(
    context: &ImportParseContext<'_>,
    pointer: u64,
) -> Option<usize> {
    address_to_file_offset(context.segments, pointer)
        .or_else(|| rva_to_file_offset(context.segments, context.image_base, pointer))
}

fn rva_to_file_offset(segments: &[Segment], image_base: u64, rva: u64) -> Option<usize> {
    let address = image_base.checked_add(rva)?;
    address_to_file_offset(segments, address)
}

fn address_to_file_offset(segments: &[Segment], address: u64) -> Option<usize> {
    segments
        .iter()
        .find_map(|segment| segment.file_offset_for_virtual_address(address))
        .map(|offset| offset as usize)
}

fn section_index_for_address(segments: &[Segment], address: u64) -> Option<u16> {
    segments
        .iter()
        .position(|segment| segment.contains_virtual_address(address))
        .and_then(|index| u16::try_from(index + 1).ok())
}

fn rva_in_directory(rva: u32, directory: DataDirectory) -> bool {
    rva >= directory.rva && rva < directory.rva.saturating_add(directory.size)
}

fn read_c_string(bytes: &[u8], offset: usize) -> Result<String> {
    let tail = bytes
        .get(offset..)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("string offset exceeds file".to_string()))?;
    let end = tail
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("unterminated PE string".to_string()))?;
    Ok(String::from_utf8_lossy(&tail[..end]).to_string())
}

fn section_by_name<'a>(sections: &'a [Section], name: &str) -> Option<&'a Section> {
    sections
        .iter()
        .find(|section| section.name.as_deref() == Some(name))
}

fn pe_machine(machine: u16) -> Result<Architecture> {
    match machine {
        IMAGE_FILE_MACHINE_I386 => Ok(Architecture::X86),
        IMAGE_FILE_MACHINE_AMD64 => Ok(Architecture::X86_64),
        other => Err(BinaryPatchError::Unsupported(format!(
            "PE machine {other:#x} is not x86/x86_64"
        ))),
    }
}

fn base_relocation_kind(kind: u16) -> BaseRelocationKind {
    match kind {
        0 => BaseRelocationKind::Absolute,
        1 => BaseRelocationKind::High,
        2 => BaseRelocationKind::Low,
        3 => BaseRelocationKind::HighLow,
        4 => BaseRelocationKind::HighAdj,
        10 => BaseRelocationKind::Dir64,
        other => BaseRelocationKind::Other(other),
    }
}

pub(crate) fn section_index_for_segment(object: &BinaryObject, segment: &Segment) -> Option<usize> {
    object.sections.iter().position(|section| {
        section.file_offset == segment.file_offset
            && section.virtual_address == segment.virtual_address
    })
}

pub(crate) fn validate_relocated_blocks(binary: &Binary, blocks: &[EncodedBlock]) -> Result<()> {
    let protected_ranges = relocated_protected_ranges(binary)?;
    for block in blocks {
        let start = block.new_address;
        let end = start.checked_add(block.bytes.len() as u64).ok_or_else(|| {
            BinaryPatchError::Emit(format!(
                "relocated PE block at {start:#x} exceeds address space"
            ))
        })?;

        if let Some(conflict) = protected_ranges.iter().find(|protected| {
            ranges_overlap(start, end, protected.range.start, protected.range.end)
        }) {
            return Err(BinaryPatchError::Emit(format!(
                "relocated PE block at {start:#x}..{end:#x} overlaps {} at {:#x}..{:#x}",
                conflict.label, conflict.range.start, conflict.range.end
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct ProtectedRange {
    range: Range<u64>,
    label: &'static str,
}

fn relocated_protected_ranges(binary: &Binary) -> Result<Vec<ProtectedRange>> {
    let object = binary.object();
    let mut ranges = Vec::new();
    let pointer_size = match object.architecture {
        Architecture::X86 => 4u64,
        Architecture::X86_64 => 8u64,
    };
    let directories = pe_data_directories(binary)?;

    push_directory_range(
        binary,
        directories.get(IMAGE_DIRECTORY_ENTRY_IMPORT).copied(),
        "import directory",
        20,
        &mut ranges,
    )?;
    push_directory_range(
        binary,
        directories.get(IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT).copied(),
        "delay import directory",
        32,
        &mut ranges,
    )?;
    push_directory_range(
        binary,
        directories.get(IMAGE_DIRECTORY_ENTRY_BASERELOC).copied(),
        "base relocation directory",
        8,
        &mut ranges,
    )?;

    for import in &object.imports {
        let descriptor_size = match import.kind {
            ImportKind::Standard => 20u64,
            ImportKind::Delay => 32u64,
        };
        push_range(
            &mut ranges,
            import.descriptor_address,
            descriptor_size,
            "import descriptor",
        )?;
        push_range(
            &mut ranges,
            import.name_address,
            import.library.len() as u64 + 1,
            "import library name",
        )?;

        let table_size = (import.entries.len() as u64 + 1) * pointer_size;
        let lookup_table_address = import
            .lookup_table_address
            .unwrap_or(import.address_table_address);
        if let Some(address) = import.lookup_table_address {
            push_range(&mut ranges, address, table_size, "import lookup table")?;
        }
        push_import_name_ranges(
            binary,
            import,
            lookup_table_address,
            pointer_size,
            &mut ranges,
        )?;
        push_range(
            &mut ranges,
            import.address_table_address,
            table_size,
            "import address table",
        )?;
        if let Some(address) = import.module_handle_address {
            push_range(
                &mut ranges,
                address,
                pointer_size,
                "delay import module handle",
            )?;
        }
        if let Some(address) = import.bound_address_table_address {
            push_range(&mut ranges, address, table_size, "delay import bound table")?;
        }
        if let Some(address) = import.unload_address_table_address {
            push_range(
                &mut ranges,
                address,
                table_size,
                "delay import unload table",
            )?;
        }
    }

    for relocation in &object.base_relocations {
        let size = match relocation.kind {
            BaseRelocationKind::Absolute => continue,
            BaseRelocationKind::Other(_) => {
                return Err(BinaryPatchError::Unsupported(format!(
                    "PE base relocation {:?} is not supported for rewrite",
                    relocation.kind
                )));
            }
            kind => relocation_target_size(kind).expect("supported relocation kind must size"),
        };
        push_range(
            &mut ranges,
            relocation.address,
            size,
            "base relocation target",
        )?;
    }

    Ok(ranges)
}

fn push_import_name_ranges(
    binary: &Binary,
    import: &Import,
    table_address: u64,
    pointer_size: u64,
    ranges: &mut Vec<ProtectedRange>,
) -> Result<()> {
    let object = binary.object();
    for index in 0..import.entries.len() {
        let thunk_address = table_address + index as u64 * pointer_size;
        let Some(thunk_offset) = object.file_offset_for_virtual_address(thunk_address) else {
            continue;
        };
        let thunk = if pointer_size == 8 {
            read_u64_le(binary.bytes(), thunk_offset as usize)?
        } else {
            read_u32_le(binary.bytes(), thunk_offset as usize)? as u64
        };
        if thunk == 0 || thunk & ordinal_flag(pointer_size) != 0 {
            continue;
        }

        let Some((name_address, name_offset)) = import_name_address(object, thunk) else {
            return Err(BinaryPatchError::Unsupported(format!(
                "PE import-by-name entry at {thunk:#x} is not file-backed"
            )));
        };
        let name_length = read_c_string_length(binary.bytes(), name_offset + 2)?;
        push_range(
            ranges,
            name_address,
            2 + name_length as u64 + 1,
            "import-by-name entry",
        )?;
    }
    Ok(())
}

fn import_name_address(object: &BinaryObject, thunk: u64) -> Option<(u64, usize)> {
    if let Some(offset) = object.file_offset_for_virtual_address(thunk) {
        return Some((thunk, offset as usize));
    }
    let address = object.image_base.checked_add(thunk)?;
    let offset = object.file_offset_for_virtual_address(address)?;
    Some((address, offset as usize))
}

fn pe_data_directories(binary: &Binary) -> Result<Vec<DataDirectory>> {
    let bytes = binary.bytes();
    if bytes.len() < 0x40 || !looks_like(bytes) {
        return Err(BinaryPatchError::InvalidFormat(
            "missing PE DOS header".to_string(),
        ));
    }

    let pe_offset = read_u32_le(bytes, 0x3c)? as usize;
    if pe_offset + 24 > bytes.len() || bytes.get(pe_offset..pe_offset + 4) != Some(b"PE\0\0") {
        return Err(BinaryPatchError::InvalidFormat(
            "missing PE signature".to_string(),
        ));
    }

    let optional_size = read_u16_le(bytes, pe_offset + 20)? as usize;
    let optional_offset = pe_offset + 24;
    if optional_offset + optional_size > bytes.len() {
        return Err(BinaryPatchError::InvalidFormat(
            "truncated PE optional header".to_string(),
        ));
    }

    let optional_magic = read_u16_le(bytes, optional_offset)?;
    let data_directory_offset = match optional_magic {
        IMAGE_NT_OPTIONAL_HDR32_MAGIC => optional_offset + 96,
        IMAGE_NT_OPTIONAL_HDR64_MAGIC => optional_offset + 112,
        other => {
            return Err(BinaryPatchError::Unsupported(format!(
                "unknown PE optional header magic {other:#x}"
            )))
        }
    };

    parse_data_directories(bytes, optional_offset, optional_size, data_directory_offset)
}

fn push_directory_range(
    binary: &Binary,
    directory: Option<DataDirectory>,
    label: &'static str,
    minimum_size: u32,
    ranges: &mut Vec<ProtectedRange>,
) -> Result<()> {
    let Some(directory) = directory.filter(|directory| directory.rva != 0 && directory.size != 0)
    else {
        return Ok(());
    };
    if directory.size < minimum_size {
        return Err(BinaryPatchError::InvalidFormat(format!(
            "invalid PE {label} size"
        )));
    }

    let object = binary.object();
    let start_address = object
        .image_base
        .checked_add(directory.rva as u64)
        .ok_or_else(|| BinaryPatchError::Emit(format!("PE {label} exceeds address space")))?;
    let end_address = start_address
        .checked_add(directory.size as u64)
        .ok_or_else(|| BinaryPatchError::Emit(format!("PE {label} exceeds address space")))?;
    if object
        .file_offset_for_virtual_address(start_address)
        .is_none()
        || object
            .file_offset_for_virtual_address(end_address.saturating_sub(1))
            .is_none()
    {
        return Err(BinaryPatchError::Unsupported(format!(
            "PE {label} is not file-backed"
        )));
    }

    push_range(ranges, start_address, directory.size as u64, label)
}

fn push_range(
    ranges: &mut Vec<ProtectedRange>,
    start: u64,
    size: u64,
    label: &'static str,
) -> Result<()> {
    if size == 0 {
        return Ok(());
    }
    let end = start
        .checked_add(size)
        .ok_or_else(|| BinaryPatchError::Emit(format!("{label} range exceeds address space")))?;
    ranges.push(ProtectedRange {
        range: start..end,
        label,
    });
    Ok(())
}

fn read_c_string_length(bytes: &[u8], offset: usize) -> Result<usize> {
    let tail = bytes
        .get(offset..)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("string offset exceeds file".to_string()))?;
    tail.iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("unterminated PE string".to_string()))
}

fn ordinal_flag(pointer_size: u64) -> u64 {
    if pointer_size == 8 {
        IMAGE_ORDINAL_FLAG64
    } else {
        IMAGE_ORDINAL_FLAG32
    }
}

fn relocation_target_size(kind: BaseRelocationKind) -> Option<u64> {
    match kind {
        BaseRelocationKind::High | BaseRelocationKind::Low => Some(2),
        BaseRelocationKind::HighAdj => Some(4),
        BaseRelocationKind::HighLow => Some(4),
        BaseRelocationKind::Dir64 => Some(8),
        BaseRelocationKind::Absolute | BaseRelocationKind::Other(_) => None,
    }
}

fn ranges_overlap(a_start: u64, a_end: u64, b_start: u64, b_end: u64) -> bool {
    a_start < b_end && b_start < a_end
}

#[derive(Debug, Clone)]
struct BaseRelocationBlock {
    page_address: u64,
    entries: Vec<BaseRelocationEntry>,
}

#[derive(Debug, Clone)]
struct BaseRelocationEntry {
    file_offset: usize,
    address: u64,
    offset: u16,
    kind: BaseRelocationKind,
}

impl BaseRelocationEntry {
    fn kind_code(&self) -> u16 {
        match self.kind {
            BaseRelocationKind::Absolute => 0,
            BaseRelocationKind::High => 1,
            BaseRelocationKind::Low => 2,
            BaseRelocationKind::HighLow => 3,
            BaseRelocationKind::HighAdj => 4,
            BaseRelocationKind::Dir64 => 10,
            BaseRelocationKind::Other(value) => value,
        }
    }
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
            "PE relocation target {target:#x} lies inside relocated block {:#x}..{:#x} and interior targets are not yet rewritten",
            block.address,
            block.end_address()
        )));
    }
    Ok(Some(encoded_block.new_address))
}

fn write_u16_le(output: &mut [u8], offset: usize, value: u16) -> Result<()> {
    let bytes = output
        .get_mut(offset..offset + 2)
        .ok_or_else(|| BinaryPatchError::Emit("u16 write exceeds file size".to_string()))?;
    bytes.copy_from_slice(&value.to_le_bytes());
    Ok(())
}
