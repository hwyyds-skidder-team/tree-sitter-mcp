use crate::arch;
use crate::diagnostic::{BinaryPatchError, Result};
use crate::format::{pe, read_u16_le, read_u32_le, read_u64_le, Binary, BinaryFormat, Segment};
use crate::ir::Module;
use crate::ir::{BasicBlock, Operation};
use crate::layout::{self, EncodedBlock, LayoutPlan};
use crate::rewrite::RewritePlan;

pub fn emit(binary: &Binary, plan: &RewritePlan) -> Result<Vec<u8>> {
    arch::ensure_supported(binary.object().architecture)?;
    ensure_elf_dynamic_rewrite_support(binary)?;
    let module = binary.lift()?;
    let layout_diagnostics = crate::rewrite::verify_preserve_entry_block(binary, &module, plan)?;
    if layout_diagnostics.has_errors() {
        return Err(BinaryPatchError::Emit(format!(
            "rewrite plan failed validation: {}",
            diagnostics_message(layout_diagnostics.diagnostics())
        )));
    }
    let rewritten = plan.apply(&module)?;
    ensure_unwind_entry_rewrite_is_safe(binary, module.entry_block(), plan)?;
    let entry_block = rewritten
        .entry_block()
        .ok_or_else(|| BinaryPatchError::Emit("module has no entry block".to_string()))?;
    let original_entry = module
        .entry_block()
        .ok_or_else(|| BinaryPatchError::Emit("module has no entry block".to_string()))?;

    reject_unsafe_entry_shift(entry_block)?;
    let encoded = encode_operations(
        binary,
        entry_block.address,
        &entry_block
            .instructions
            .iter()
            .map(|instruction| instruction.operation.clone())
            .collect::<Vec<_>>(),
    )?;
    let original_len = original_entry.encoded_len();
    let required_extra = encoded.len().saturating_sub(original_len);
    ensure_padding(binary, original_entry, required_extra)?;

    let mut output = binary.bytes().to_vec();
    let start = original_entry.file_offset as usize;
    let end = start + encoded.len();
    if end > output.len() {
        return Err(BinaryPatchError::Emit(
            "encoded entry block exceeds file size".to_string(),
        ));
    }
    output[start..end].copy_from_slice(&encoded);
    Ok(output)
}

pub fn emit_relocated(binary: &Binary, module: &Module, layout: &LayoutPlan) -> Result<Vec<u8>> {
    arch::ensure_supported(binary.object().architecture)?;
    ensure_elf_dynamic_rewrite_support(binary)?;
    let layout_diagnostics = layout.verify(module);
    if layout_diagnostics.has_errors() {
        return Err(BinaryPatchError::Emit(format!(
            "layout plan failed validation: {}",
            diagnostics_message(layout_diagnostics.diagnostics())
        )));
    }
    let entry_block = module
        .entry_block()
        .ok_or_else(|| BinaryPatchError::Emit("module has no entry block".to_string()))?;
    let relocated_entry = layout
        .new_address_for(module.entry)
        .ok_or_else(|| BinaryPatchError::Emit("layout has no relocated entry".to_string()))?;
    if relocated_entry == module.entry {
        return Err(BinaryPatchError::Emit(
            "relocated emission requires the entry block to move".to_string(),
        ));
    }

    let encoded_blocks = layout::encode_blocks(module, layout)?;
    ensure_unwind_relocated_blocks_are_safe(binary, module, layout, &encoded_blocks)?;
    if binary.object().format == BinaryFormat::Pe {
        pe::validate_relocated_blocks(binary, &encoded_blocks)?;
    }
    ensure_elf_relocated_blocks_are_safe(binary, &encoded_blocks)?;
    let mut output = binary.bytes().to_vec();
    write_relocated_blocks(binary, module, &encoded_blocks, &mut output)?;
    rewrite_relocated_metadata(binary, module, &encoded_blocks, &mut output)?;
    patch_entry_jump(binary, entry_block, relocated_entry, &mut output)?;
    Ok(output)
}

pub fn emit_relocated_expanding_load_segment(binary: &Binary, module: &Module) -> Result<Vec<u8>> {
    ensure_elf_dynamic_rewrite_support(binary)?;
    match binary.object().format {
        BinaryFormat::Elf => emit_relocated_expanding_elf_load_segment(binary, module),
        BinaryFormat::Pe => emit_relocated_expanding_pe_section(binary, module),
    }
}

fn emit_relocated_expanding_elf_load_segment(binary: &Binary, module: &Module) -> Result<Vec<u8>> {
    let entry_block = module
        .entry_block()
        .ok_or_else(|| BinaryPatchError::Emit("module has no entry block".to_string()))?;
    let entry_segment = binary
        .object()
        .entry_segment()
        .ok_or_else(|| BinaryPatchError::Emit("entry is not in an executable segment".to_string()))?
        .clone();
    let append_file_offset = binary.bytes().len() as u64;
    let append_address =
        entry_segment.virtual_address + (append_file_offset - entry_segment.file_offset);
    let layout = LayoutPlan::relocate_contiguous(module, append_address)?;
    let layout_diagnostics = layout.verify(module);
    if layout_diagnostics.has_errors() {
        return Err(BinaryPatchError::Emit(format!(
            "layout plan failed validation: {}",
            diagnostics_message(layout_diagnostics.diagnostics())
        )));
    }
    let encoded_blocks = layout::encode_blocks(module, &layout)?;
    let relocated_entry = layout
        .new_address_for(module.entry)
        .ok_or_else(|| BinaryPatchError::Emit("layout has no relocated entry".to_string()))?;
    ensure_unwind_relocated_blocks_are_safe(binary, module, &layout, &encoded_blocks)?;
    ensure_elf_relocated_blocks_are_safe(binary, &encoded_blocks)?;

    let mut output = binary.bytes().to_vec();
    append_relocated_blocks(
        append_file_offset,
        append_address,
        &encoded_blocks,
        &mut output,
    )?;
    rewrite_relocated_metadata(binary, module, &encoded_blocks, &mut output)?;
    ensure_elf_segment_expansion_is_safe(binary, &entry_segment, output.len() as u64)?;
    patch_elf_load_segment_size(binary, &entry_segment, output.len() as u64, &mut output)?;
    patch_entry_jump(binary, entry_block, relocated_entry, &mut output)?;
    Ok(output)
}

fn emit_relocated_expanding_pe_section(binary: &Binary, module: &Module) -> Result<Vec<u8>> {
    let entry_block = module
        .entry_block()
        .ok_or_else(|| BinaryPatchError::Emit("module has no entry block".to_string()))?;
    let entry_segment = binary
        .object()
        .entry_segment()
        .ok_or_else(|| BinaryPatchError::Emit("entry is not in an executable section".to_string()))?
        .clone();
    let section_file_end = entry_segment.file_offset + entry_segment.file_size;
    if section_file_end != binary.bytes().len() as u64 {
        return Err(BinaryPatchError::Unsupported(
            "this expansion path requires the entry PE section to end at EOF".to_string(),
        ));
    }

    let append_file_offset = binary.bytes().len() as u64;
    let append_address =
        entry_segment.virtual_address + (append_file_offset - entry_segment.file_offset);
    let layout = LayoutPlan::relocate_contiguous(module, append_address)?;
    let layout_diagnostics = layout.verify(module);
    if layout_diagnostics.has_errors() {
        return Err(BinaryPatchError::Emit(format!(
            "layout plan failed validation: {}",
            diagnostics_message(layout_diagnostics.diagnostics())
        )));
    }
    let encoded_blocks = layout::encode_blocks(module, &layout)?;
    let relocated_entry = layout
        .new_address_for(module.entry)
        .ok_or_else(|| BinaryPatchError::Emit("layout has no relocated entry".to_string()))?;
    ensure_unwind_relocated_blocks_are_safe(binary, module, &layout, &encoded_blocks)?;
    pe::validate_relocated_blocks(binary, &encoded_blocks)?;

    let mut output = binary.bytes().to_vec();
    append_relocated_blocks(
        append_file_offset,
        append_address,
        &encoded_blocks,
        &mut output,
    )?;
    rewrite_relocated_metadata(binary, module, &encoded_blocks, &mut output)?;
    patch_pe_section_size(binary, &entry_segment, output.len() as u64, &mut output)?;
    patch_entry_jump(binary, entry_block, relocated_entry, &mut output)?;
    Ok(output)
}

fn diagnostics_message(diagnostics: &[crate::diagnostic::Diagnostic]) -> String {
    diagnostics
        .iter()
        .map(|diagnostic| match diagnostic.offset {
            Some(offset) => format!(
                "{:?} at {offset:#x}: {}",
                diagnostic.severity, diagnostic.message
            ),
            None => format!("{:?}: {}", diagnostic.severity, diagnostic.message),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn reject_unsafe_entry_shift(block: &BasicBlock) -> Result<()> {
    let has_unknown = block
        .instructions
        .iter()
        .any(|instruction| matches!(instruction.operation, Operation::Unknown { .. }));
    if has_unknown {
        return Err(BinaryPatchError::Unsupported(
            "entry block contains unknown operations and cannot be safely re-emitted".to_string(),
        ));
    }
    let has_internal_control_target = block.instructions.iter().any(|instruction| {
        instruction
            .operation
            .direct_target()
            .is_some_and(|target| target > block.address && target < block.end_address())
    });
    if has_internal_control_target {
        return Err(BinaryPatchError::Unsupported(
            "entry insertion needs an intra-block target relocation map".to_string(),
        ));
    }
    Ok(())
}

fn encode_operations(
    binary: &Binary,
    start_address: u64,
    operations: &[Operation],
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut address = start_address;
    for operation in operations {
        let bytes = arch::encode_operation(binary.object().architecture, address, operation)
            .map_err(|error| {
                BinaryPatchError::Unsupported(format!(
                    "failed to encode operation at {address:#x}: {error}"
                ))
            })?;
        address += bytes.len() as u64;
        output.extend_from_slice(&bytes);
    }
    Ok(output)
}

fn write_relocated_blocks(
    binary: &Binary,
    module: &Module,
    blocks: &[EncodedBlock],
    output: &mut [u8],
) -> Result<()> {
    let mut ranges = Vec::new();
    for block in blocks {
        let file_offset = binary
            .object()
            .file_offset_for_virtual_address(block.new_address)
            .ok_or_else(|| {
                BinaryPatchError::Emit(format!(
                    "relocated block address {:#x} is not mapped in the file",
                    block.new_address
                ))
            })? as usize;
        let end = file_offset + block.bytes.len();
        if end > output.len() {
            return Err(BinaryPatchError::Emit(
                "relocated block exceeds file size".to_string(),
            ));
        }
        ranges.push((file_offset, end));
        if block.original_address != block.new_address {
            ensure_padding_range(output, file_offset, end)?;
        }
        if module.entry_block().is_some_and(|entry| {
            block.new_address >= entry.address && block.new_address < entry.end_address()
        }) {
            return Err(BinaryPatchError::Emit(
                "relocated block would overlap the original entry block".to_string(),
            ));
        }
        output[file_offset..end].copy_from_slice(&block.bytes);
    }
    ranges.sort_unstable();
    for pair in ranges.windows(2) {
        if pair[0].1 > pair[1].0 {
            return Err(BinaryPatchError::Emit(
                "relocated block ranges overlap".to_string(),
            ));
        }
    }
    Ok(())
}

fn append_relocated_blocks(
    append_file_offset: u64,
    append_address: u64,
    blocks: &[EncodedBlock],
    output: &mut Vec<u8>,
) -> Result<()> {
    for block in blocks {
        let file_offset = append_file_offset + (block.new_address - append_address);
        let start = file_offset as usize;
        let end = start + block.bytes.len();
        if output.len() < start {
            output.resize(start, 0x90);
        }
        if output.len() < end {
            output.resize(end, 0x90);
        }
        output[start..end].copy_from_slice(&block.bytes);
    }
    Ok(())
}

fn ensure_elf_dynamic_rewrite_support(binary: &Binary) -> Result<()> {
    if binary.object().format != BinaryFormat::Elf {
        return Ok(());
    }
    if let Some(metadata) = binary.elf_dynamic_metadata()? {
        metadata.validate_rewrite_support()?;
    }
    Ok(())
}

fn ensure_elf_relocated_blocks_are_safe(binary: &Binary, blocks: &[EncodedBlock]) -> Result<()> {
    if binary.object().format != BinaryFormat::Elf {
        return Ok(());
    }
    if let Some(metadata) = binary.elf_dynamic_metadata()? {
        metadata.validate_relocated_blocks(blocks)?;
    }
    Ok(())
}

fn rewrite_relocated_metadata(
    binary: &Binary,
    module: &Module,
    blocks: &[EncodedBlock],
    output: &mut [u8],
) -> Result<()> {
    match binary.object().format {
        BinaryFormat::Elf => {
            if let Some(metadata) = binary.elf_dynamic_metadata()? {
                metadata.rewrite_relocated_metadata(binary.bytes(), module, blocks, output)?;
            }
            Ok(())
        }
        BinaryFormat::Pe => pe::rewrite_relocated_metadata(binary, module, blocks, output),
    }
}

fn ensure_unwind_entry_rewrite_is_safe(
    binary: &Binary,
    original_entry: Option<&BasicBlock>,
    plan: &RewritePlan,
) -> Result<()> {
    if plan.transforms().is_empty() {
        return Ok(());
    }
    let Some(original_entry) = original_entry else {
        return Ok(());
    };
    let Some(metadata) = binary.object().unwind_metadata() else {
        return Ok(());
    };

    if let Some(conflict) = metadata.function_ranges().iter().find(|range| {
        ranges_overlap(
            original_entry.address,
            original_entry.end_address(),
            range.range.start,
            range.range.end,
        )
    }) {
        return Err(BinaryPatchError::Unsupported(format!(
            "rewrite would modify unwind-covered function {} at {:#x}..{:#x}",
            conflict.label, conflict.range.start, conflict.range.end
        )));
    }

    Ok(())
}

fn ensure_unwind_relocated_blocks_are_safe(
    binary: &Binary,
    module: &Module,
    layout: &LayoutPlan,
    blocks: &[EncodedBlock],
) -> Result<()> {
    let Some(metadata) = binary.object().unwind_metadata() else {
        return Ok(());
    };

    for block in blocks {
        let Some(placement) = layout
            .placements()
            .iter()
            .find(|placement| placement.original_address == block.original_address)
        else {
            continue;
        };
        let Some(original_block) = module
            .functions
            .iter()
            .flat_map(|function| function.blocks.iter())
            .find(|candidate| candidate.address == block.original_address)
        else {
            continue;
        };
        let original_end = original_block.end_address();
        let relocated_end = placement
            .new_address
            .checked_add(block.bytes.len() as u64)
            .ok_or_else(|| {
                BinaryPatchError::Emit(format!(
                    "relocated block at {:#x} exceeds address space",
                    placement.new_address
                ))
            })?;

        if let Some(conflict) = metadata.protected_ranges().iter().find(|range| {
            ranges_overlap(
                placement.new_address,
                relocated_end,
                range.range.start,
                range.range.end,
            )
        }) {
            return Err(BinaryPatchError::Emit(format!(
                "relocated block at {:#x}..{:#x} overlaps unwind metadata {} at {:#x}..{:#x}",
                placement.new_address,
                relocated_end,
                conflict.label,
                conflict.range.start,
                conflict.range.end
            )));
        }

        if let Some(conflict) = metadata.function_ranges().iter().find(|range| {
            ranges_overlap(
                original_block.address,
                original_end,
                range.range.start,
                range.range.end,
            )
        }) {
            return Err(BinaryPatchError::Unsupported(format!(
                "relocating unwind-covered function block {:#x} would stale {} at {:#x}..{:#x}",
                original_block.address, conflict.label, conflict.range.start, conflict.range.end
            )));
        }
    }

    Ok(())
}

fn ranges_overlap(start: u64, end: u64, other_start: u64, other_end: u64) -> bool {
    start < other_end && other_start < end
}

fn ensure_elf_segment_expansion_is_safe(
    binary: &Binary,
    segment: &Segment,
    new_file_end: u64,
) -> Result<()> {
    let new_size = new_file_end
        .checked_sub(segment.file_offset)
        .ok_or_else(|| {
            BinaryPatchError::Emit("expanded segment start exceeds file end".to_string())
        })?;
    let expanded_end = segment
        .virtual_address
        .saturating_add(new_size.max(segment.memory_size));
    for other in &binary.object().segments {
        if other == segment {
            continue;
        }
        let other_end = other
            .virtual_address
            .saturating_add(other.memory_size.max(other.file_size));
        if segment.virtual_address < other_end && other.virtual_address < expanded_end {
            return Err(BinaryPatchError::Unsupported(
                "expanding the ELF load segment would overlap another load segment".to_string(),
            ));
        }
    }
    Ok(())
}

fn patch_elf_load_segment_size(
    binary: &Binary,
    segment: &Segment,
    new_file_end: u64,
    output: &mut [u8],
) -> Result<()> {
    match output.get(4).copied() {
        Some(1) => patch_elf32_load_segment_size(binary, segment, new_file_end, output),
        Some(2) => patch_elf64_load_segment_size(binary, segment, new_file_end, output),
        _ => Err(BinaryPatchError::InvalidFormat(
            "unknown ELF class while patching segment size".to_string(),
        )),
    }
}

fn patch_pe_section_size(
    binary: &Binary,
    segment: &Segment,
    new_file_end: u64,
    output: &mut [u8],
) -> Result<()> {
    let pe_offset = read_u32_le(binary.bytes(), 0x3c)? as usize;
    let optional_size = read_u16_le(binary.bytes(), pe_offset + 20)? as usize;
    let optional_offset = pe_offset + 24;
    let section_offset = optional_offset + optional_size;
    let section_alignment = read_u32_le(binary.bytes(), optional_offset + 32)?.max(1);
    let Some(section_index) = pe::section_index_for_segment(binary.object(), segment) else {
        return Err(BinaryPatchError::Emit(
            "could not find PE section to resize".to_string(),
        ));
    };
    let offset = section_offset + section_index * 40;
    let section_rva = binary.object().sections[section_index]
        .virtual_address
        .checked_sub(binary.object().image_base)
        .ok_or_else(|| {
            BinaryPatchError::Emit("PE section virtual address precedes image base".to_string())
        })?;
    let new_size = new_file_end - segment.file_offset;
    if new_size > u32::MAX as u64 {
        return Err(BinaryPatchError::Emit(
            "expanded PE section exceeds u32 size".to_string(),
        ));
    }
    write_u32_le(output, offset + 8, new_size.max(segment.memory_size) as u32)?;
    write_u32_le(output, offset + 16, new_size as u32)?;
    let image_end_rva = section_rva + new_size.max(segment.memory_size);
    let size_of_image = align_up_u64(image_end_rva, section_alignment as u64)?;
    if size_of_image > u32::MAX as u64 {
        return Err(BinaryPatchError::Emit(
            "expanded PE image exceeds u32 SizeOfImage".to_string(),
        ));
    }
    write_u32_le(output, optional_offset + 56, size_of_image as u32)?;
    Ok(())
}

fn patch_elf64_load_segment_size(
    binary: &Binary,
    segment: &Segment,
    new_file_end: u64,
    output: &mut [u8],
) -> Result<()> {
    let phoff = read_u64_le(binary.bytes(), 32)? as usize;
    let phentsize = read_u16_le(binary.bytes(), 54)? as usize;
    let phnum = read_u16_le(binary.bytes(), 56)? as usize;
    for index in 0..phnum {
        let offset = phoff + index * phentsize;
        if read_u32_le(binary.bytes(), offset)? != 1 {
            continue;
        }
        let p_offset = read_u64_le(binary.bytes(), offset + 8)?;
        let p_vaddr = read_u64_le(binary.bytes(), offset + 16)?;
        if p_offset == segment.file_offset && p_vaddr == segment.virtual_address {
            let new_size = new_file_end - segment.file_offset;
            write_u64_le(output, offset + 32, new_size)?;
            write_u64_le(output, offset + 40, new_size.max(segment.memory_size))?;
            return Ok(());
        }
    }
    Err(BinaryPatchError::Emit(
        "could not find ELF64 load segment to resize".to_string(),
    ))
}

fn patch_elf32_load_segment_size(
    binary: &Binary,
    segment: &Segment,
    new_file_end: u64,
    output: &mut [u8],
) -> Result<()> {
    let phoff = read_u32_le(binary.bytes(), 28)? as usize;
    let phentsize = read_u16_le(binary.bytes(), 42)? as usize;
    let phnum = read_u16_le(binary.bytes(), 44)? as usize;
    for index in 0..phnum {
        let offset = phoff + index * phentsize;
        if read_u32_le(binary.bytes(), offset)? != 1 {
            continue;
        }
        let p_offset = read_u32_le(binary.bytes(), offset + 4)? as u64;
        let p_vaddr = read_u32_le(binary.bytes(), offset + 8)? as u64;
        if p_offset == segment.file_offset && p_vaddr == segment.virtual_address {
            let new_size = new_file_end - segment.file_offset;
            if new_size > u32::MAX as u64 {
                return Err(BinaryPatchError::Emit(
                    "expanded ELF32 segment exceeds u32 size".to_string(),
                ));
            }
            write_u32_le(output, offset + 16, new_size as u32)?;
            write_u32_le(
                output,
                offset + 20,
                new_size.max(segment.memory_size) as u32,
            )?;
            return Ok(());
        }
    }
    Err(BinaryPatchError::Emit(
        "could not find ELF32 load segment to resize".to_string(),
    ))
}

fn patch_entry_jump(
    binary: &Binary,
    entry_block: &BasicBlock,
    relocated_entry: u64,
    output: &mut [u8],
) -> Result<()> {
    let jump = arch::encode_operation(
        binary.object().architecture,
        entry_block.address,
        &Operation::DirectJump {
            target: relocated_entry,
        },
    )?;
    let original_len = entry_block.encoded_len();
    if original_len < jump.len() {
        return Err(BinaryPatchError::Emit(
            "entry block is too small for relocation jump".to_string(),
        ));
    }
    let start = entry_block.file_offset as usize;
    let end = start + original_len;
    if end > output.len() {
        return Err(BinaryPatchError::Emit(
            "entry patch exceeds file size".to_string(),
        ));
    }
    output[start..start + jump.len()].copy_from_slice(&jump);
    for byte in &mut output[start + jump.len()..end] {
        *byte = 0x90;
    }
    Ok(())
}

fn ensure_padding(binary: &Binary, block: &BasicBlock, required_extra: usize) -> Result<()> {
    if required_extra == 0 {
        return Ok(());
    }

    let padding_start = block.end_file_offset() as usize;
    let padding_end = padding_start + required_extra;
    let padding = binary
        .bytes()
        .get(padding_start..padding_end)
        .ok_or_else(|| {
            BinaryPatchError::Emit("not enough file space after entry block".to_string())
        })?;
    ensure_padding_bytes(padding)
}

fn ensure_padding_range(output: &[u8], start: usize, end: usize) -> Result<()> {
    let bytes = output
        .get(start..end)
        .ok_or_else(|| BinaryPatchError::Emit("padding range exceeds file size".to_string()))?;
    ensure_padding_bytes(bytes)
}

fn ensure_padding_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.iter().all(|byte| matches!(*byte, 0x00 | 0x90 | 0xcc)) {
        Ok(())
    } else {
        Err(BinaryPatchError::Emit(
            "semantic emission would overwrite non-padding bytes".to_string(),
        ))
    }
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

fn align_up_u64(value: u64, alignment: u64) -> Result<u64> {
    if alignment == 0 {
        return Ok(value);
    }
    let mask = alignment - 1;
    value
        .checked_add(mask)
        .map(|value| value & !mask)
        .ok_or_else(|| BinaryPatchError::Emit("alignment overflow".to_string()))
}
