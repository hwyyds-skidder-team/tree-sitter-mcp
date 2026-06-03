use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::arch::LiftOptions;
use crate::diagnostic::{BinaryPatchError, Diagnostic, Result};
use crate::format::{read_i32_le, read_u16_le, read_u32_le, read_u64_le, Architecture, Binary};
use crate::ir::{
    BasicBlock, BasicBlockId, ConditionCode, ControlFlowOperand, Edge, EdgeKind, Function,
    Instruction, JumpTableCandidate, JumpTableEntry, MemoryOperand, Module, ModuleMetadata,
    Operation, Register, SegmentRegister, SimdBinaryKind, SimdMoveDirection, SimdMoveKind,
    StringRepeatPrefix, VectorOperand, VectorRegister,
};

const MAX_BLOCK_DECODE_BYTES: usize = 4096;
const MAX_BLOCKS: usize = 4096;
const MAX_INSTRUCTIONS_PER_BLOCK: usize = 1024;
const MAX_JUMP_TABLE_ENTRIES: usize = 64;

#[derive(Debug, Clone, Copy, Default)]
struct RexPrefix {
    w: bool,
    r: bool,
    x: bool,
    b: bool,
}

impl RexPrefix {
    const NONE: Self = Self {
        w: false,
        r: false,
        x: false,
        b: false,
    };

    fn from_byte(byte: u8) -> Self {
        Self {
            w: byte & 0b1000 != 0,
            r: byte & 0b0100 != 0,
            x: byte & 0b0010 != 0,
            b: byte & 0b0001 != 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum BitwiseOp {
    And,
    Or,
    Xor,
}

#[derive(Debug, Clone, Copy)]
enum ShiftSource {
    Immediate,
    Cl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SimdPrefix {
    None,
    Prefix66,
    PrefixF2,
    PrefixF3,
}

pub fn lift_from(binary: &Binary, start_address: u64, options: LiftOptions) -> Result<Module> {
    let object = binary.object();
    let start_segment = object
        .executable_segment_for_virtual_address(start_address)
        .ok_or_else(|| {
            BinaryPatchError::Unsupported(format!("{start_address:#x} is not executable"))
        })?;
    object
        .file_offset_for_virtual_address(start_address)
        .ok_or_else(|| {
            BinaryPatchError::Unsupported(format!("cannot map {start_address:#x} to file"))
        })?;

    let mut diagnostics = Vec::new();
    let mut blocks_by_address: BTreeMap<u64, BasicBlock> = BTreeMap::new();
    let mut incoming_known_addresses: BTreeMap<u64, Option<BTreeMap<Register, u64>>> =
        BTreeMap::new();
    let mut outgoing_known_addresses: BTreeMap<u64, BTreeMap<Register, u64>> = BTreeMap::new();
    let mut block_ids: BTreeMap<u64, BasicBlockId> = BTreeMap::new();
    let mut queued = BTreeSet::new();
    let mut worklist = VecDeque::from([start_address]);
    let mut next_block_id = 0usize;
    queued.insert(start_address);
    incoming_known_addresses.insert(start_address, Some(BTreeMap::new()));

    while let Some(address) = worklist.pop_front() {
        queued.remove(&address);

        if !blocks_by_address.contains_key(&address) && blocks_by_address.len() >= MAX_BLOCKS {
            diagnostics.push(Diagnostic::warning(
                format!("stopped CFG discovery after {MAX_BLOCKS} blocks"),
                Some(start_segment.file_offset),
            ));
            break;
        }

        let entry_known_addresses = incoming_known_addresses
            .get(&address)
            .and_then(|known| known.clone())
            .unwrap_or_default();
        let id = *block_ids.entry(address).or_insert_with(|| {
            let id = BasicBlockId(next_block_id);
            next_block_id += 1;
            id
        });
        let (block, exit_known_addresses) = decode_block(
            binary,
            address,
            id,
            &mut diagnostics,
            &entry_known_addresses,
        )?;
        blocks_by_address.insert(address, block);

        if outgoing_known_addresses.get(&address) != Some(&exit_known_addresses) {
            outgoing_known_addresses.insert(address, exit_known_addresses.clone());
        }

        if let Some(block) = blocks_by_address.get(&address) {
            for edge in &block.edges {
                if edge.kind == EdgeKind::Call && !options.follow_direct_calls {
                    continue;
                }
                if let Some(target) = edge.target {
                    if object
                        .executable_segment_for_virtual_address(target)
                        .is_none()
                    {
                        continue;
                    }
                    let entry = incoming_known_addresses.entry(target).or_insert(None);
                    let merged = match entry {
                        Some(current) => meet_known_addresses(current, &exit_known_addresses),
                        None => exit_known_addresses.clone(),
                    };
                    if entry.as_ref() != Some(&merged) {
                        *entry = Some(merged);
                    }
                    if queued.insert(target) {
                        worklist.push_back(target);
                    }
                }
            }
        }
    }

    let mut blocks: Vec<BasicBlock> = blocks_by_address.into_values().collect();
    split_blocks_at_internal_targets(&mut blocks, &mut diagnostics);
    dedupe_blocks_by_address(&mut blocks, &mut diagnostics);
    blocks.sort_by_key(|block| block.address);
    for (index, block) in blocks.iter_mut().enumerate() {
        block.id = BasicBlockId(index);
    }
    rebuild_edges(&mut blocks);
    resolve_edges(&mut blocks, &mut diagnostics);

    Ok(Module {
        format: object.format,
        architecture: object.architecture,
        entry: start_address,
        metadata: module_metadata(binary),
        functions: vec![Function {
            entry: start_address,
            blocks,
        }],
        diagnostics,
    })
}

fn module_metadata(binary: &Binary) -> ModuleMetadata {
    let object = binary.object();
    let elf_plt = object
        .elf_dynamic_metadata(binary.bytes())
        .ok()
        .and_then(|metadata| metadata.map(|metadata| metadata.plt));
    ModuleMetadata {
        imports: object.imports.clone(),
        elf_plt,
    }
}

fn decode_block(
    binary: &Binary,
    address: u64,
    id: BasicBlockId,
    module_diagnostics: &mut Vec<Diagnostic>,
    entry_known_addresses: &BTreeMap<Register, u64>,
) -> Result<(BasicBlock, BTreeMap<Register, u64>)> {
    let object = binary.object();
    let segment = object
        .executable_segment_for_virtual_address(address)
        .ok_or_else(|| {
            BinaryPatchError::Unsupported(format!("address {address:#x} is not executable"))
        })?;
    let file_offset = object
        .file_offset_for_virtual_address(address)
        .ok_or_else(|| BinaryPatchError::Unsupported(format!("cannot map {address:#x} to file")))?;
    let available = segment
        .file_offset
        .saturating_add(segment.file_size)
        .saturating_sub(file_offset) as usize;
    let decode_len = available.min(MAX_BLOCK_DECODE_BYTES);
    let start = file_offset as usize;
    let end = start + decode_len;
    let code = binary
        .bytes()
        .get(start..end)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("block range exceeds file size".into()))?;

    let mut block = BasicBlock {
        id,
        address,
        file_offset,
        instructions: Vec::new(),
        edges: Vec::new(),
    };
    let mut cursor = 0usize;
    let mut instruction_count = 0usize;
    let mut known_addresses = entry_known_addresses.clone();

    while cursor < code.len() && instruction_count < MAX_INSTRUCTIONS_PER_BLOCK {
        let instruction_address = address + cursor as u64;
        let instruction_file_offset = file_offset + cursor as u64;
        let mut decoded = decode_one(
            object.architecture,
            code,
            cursor,
            instruction_address,
            instruction_file_offset,
        )?;
        decoded.jump_table =
            recover_jump_table_candidate(binary, &decoded.operation, &known_addresses);
        cursor += decoded.bytes.len();
        instruction_count += 1;
        let next_address = address + cursor as u64;
        let edges = edges_for_instruction(id, &decoded, next_address);
        module_diagnostics.extend(decoded.diagnostics.iter().cloned());
        let terminal = decoded.operation.is_terminal();
        update_known_addresses(&mut known_addresses, &decoded.operation);
        block.instructions.push(decoded);
        block.edges.extend(edges);
        if terminal {
            break;
        }
    }

    if instruction_count == MAX_INSTRUCTIONS_PER_BLOCK {
        module_diagnostics.push(Diagnostic::warning(
            "stopped block decode at instruction limit",
            Some(file_offset),
        ));
    }
    if block.instructions.is_empty() {
        module_diagnostics.push(Diagnostic::error(
            "executable block produced no liftable instructions",
            Some(file_offset),
        ));
    }
    if block.edges.is_empty() {
        add_fallthrough_edge(&mut block);
    }
    Ok((block, known_addresses))
}

fn meet_known_addresses(
    current: &BTreeMap<Register, u64>,
    incoming: &BTreeMap<Register, u64>,
) -> BTreeMap<Register, u64> {
    let mut merged = BTreeMap::new();
    for (register, value) in current {
        if incoming.get(register) == Some(value) {
            merged.insert(*register, *value);
        }
    }
    merged
}

fn decode_one(
    architecture: Architecture,
    code: &[u8],
    cursor: usize,
    address: u64,
    file_offset: u64,
) -> Result<Instruction> {
    let remaining = &code[cursor..];
    let byte = remaining[0];
    let mut diagnostics = Vec::new();

    if let Some(length) = decode_multibyte_nop_len(remaining) {
        return Ok(Instruction {
            address,
            file_offset,
            bytes: remaining[..length].to_vec(),
            operation: Operation::NopBytes {
                bytes: remaining[..length].to_vec(),
            },
            jump_table: None,
            diagnostics,
        });
    }

    if matches!(byte, 0x64 | 0x65) {
        let (length, operation) =
            decode_segment_override_memory(architecture, remaining, file_offset, &mut diagnostics)?;
        return Ok(Instruction {
            address,
            file_offset,
            bytes: remaining[..length].to_vec(),
            operation,
            jump_table: None,
            diagnostics,
        });
    }

    if let Some((length, operation)) = decode_prefixed_simd_or_x87(
        architecture,
        remaining,
        address,
        file_offset,
        &mut diagnostics,
    )? {
        return Ok(Instruction {
            address,
            file_offset,
            bytes: remaining[..length].to_vec(),
            operation,
            jump_table: None,
            diagnostics,
        });
    }

    if matches!(byte, 0xf2 | 0xf3) {
        return decode_string_instruction(
            architecture,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        );
    }

    let (length, operation) = match byte {
        0x90 => (1, Operation::Nop),
        0xf4 => (1, Operation::Halt),
        0xcc => (1, Operation::Breakpoint),
        0xcd if remaining.len() >= 2 => (
            2,
            Operation::Interrupt {
                vector: remaining[1],
            },
        ),
        0xc3 => (1, Operation::Return),
        0xc9 => (1, Operation::LeaveFrame),
        0xc2 if remaining.len() >= 3 => (
            3,
            Operation::ReturnWithStackAdjustment {
                bytes: read_u16_le(remaining, 1)?,
            },
        ),
        0xd9 if remaining.get(1) == Some(&0xd0) => (2, Operation::FpuNoop),
        0xdb if remaining.get(1) == Some(&0xe3) => (2, Operation::FpuInitialize { wait: false }),
        0xdb if remaining.get(1) == Some(&0xe2) => {
            (2, Operation::FpuClearExceptions { wait: false })
        }
        0x0f if remaining.get(1) == Some(&0x05) => (2, Operation::Syscall),
        0x0f if remaining.len() >= 2 => decode_two_byte_opcode_with_simd(
            architecture,
            SimdPrefix::None,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x09 if remaining.len() >= 2 => decode_bitwise_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            BitwiseOp::Or,
            false,
        ),
        0x0b if remaining.len() >= 2 => decode_bitwise_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            BitwiseOp::Or,
            true,
        ),
        0x21 if remaining.len() >= 2 => decode_bitwise_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            BitwiseOp::And,
            false,
        ),
        0x24 if remaining.len() >= 2 => (
            2,
            Operation::AndRegisterImmediate {
                register: Register::Al,
                value: remaining[1] as i8 as i64,
                width_bits: 8,
            },
        ),
        0x23 if remaining.len() >= 2 => decode_bitwise_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            BitwiseOp::And,
            true,
        ),
        0x31 if remaining.len() >= 2 => decode_bitwise_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            BitwiseOp::Xor,
            false,
        ),
        0x35 if remaining.len() >= 5 => (
            5,
            Operation::XorRegisterImmediate {
                register: Register::Eax,
                value: read_u32_le(remaining, 1)? as i32 as i64,
                width_bits: 32,
            },
        ),
        0x33 if remaining.len() >= 2 => decode_bitwise_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            BitwiseOp::Xor,
            true,
        ),
        0x39 if remaining.len() >= 2 => decode_cmp_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            false,
        ),
        0x3b if remaining.len() >= 2 => decode_cmp_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
            true,
        ),
        0x11 if remaining.len() >= 2 => decode_add_sub_with_carry_reg_rm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            false,
            false,
        )?,
        0x13 if remaining.len() >= 2 => decode_add_sub_with_carry_reg_rm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            true,
            false,
        )?,
        0x19 if remaining.len() >= 2 => decode_add_sub_with_carry_reg_rm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            false,
            true,
        )?,
        0x1b if remaining.len() >= 2 => decode_add_sub_with_carry_reg_rm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            true,
            true,
        )?,
        0x63 if architecture == Architecture::X86_64 && remaining.len() >= 3 => {
            decode_sign_extend_reg_rm(
                architecture,
                32,
                64,
                RexPrefix::NONE,
                remaining,
                address,
                file_offset,
                &mut diagnostics,
            )?
        }
        0x50..=0x57 => (
            1,
            Operation::PushRegister {
                register: low_register(byte - 0x50, architecture),
                width_bits: native_width(architecture),
            },
        ),
        0x58..=0x5f => (
            1,
            Operation::PopRegister {
                register: low_register(byte - 0x58, architecture),
                width_bits: native_width(architecture),
            },
        ),
        0x6a if remaining.len() >= 2 => (
            2,
            Operation::PushImmediate {
                value: remaining[1] as i8 as i64,
                width_bits: native_width(architecture),
            },
        ),
        0x68 if remaining.len() >= 5 => (
            5,
            Operation::PushImmediate {
                value: read_i32_le(remaining, 1)? as i64,
                width_bits: native_width(architecture),
            },
        ),
        0x74..=0x7f if byte != 0x82 && byte != 0x83 => {
            let condition = condition_from_short_opcode(byte).expect("range is condition");
            if remaining.len() < 2 {
                unsupported(byte, file_offset, &mut diagnostics)
            } else {
                let relative = remaining[1] as i8 as i64;
                let target = (address as i64 + 2 + relative) as u64;
                (2, Operation::ConditionalJump { condition, target })
            }
        }
        0x81 if remaining.len() >= 6 => decode_group81(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x83 if remaining.len() >= 3 => decode_group83(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x69 if remaining.len() >= 6 => decode_imul_reg_rm_imm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            false,
        )?,
        0x6b if remaining.len() >= 3 => decode_imul_reg_rm_imm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            true,
        )?,
        0x85 if remaining.len() >= 2 => decode_test_reg_reg(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
        ),
        0x84 if remaining.len() >= 2 => decode_test_reg_reg(
            architecture,
            8,
            RexPrefix::NONE,
            remaining,
            file_offset,
            &mut diagnostics,
        ),
        0xc1 if remaining.len() >= 3 => decode_shift_group(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            ShiftSource::Immediate,
        )?,
        0xc0 if remaining.len() >= 3 => decode_shift_group(
            architecture,
            8,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            ShiftSource::Immediate,
        )?,
        0xd1 if remaining.len() >= 2 => decode_shift_group(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            ShiftSource::Immediate,
        )?,
        0xd3 if remaining.len() >= 2 => decode_shift_group(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            ShiftSource::Cl,
        )?,
        0xd0 if remaining.len() >= 2 => decode_shift_group(
            architecture,
            8,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            ShiftSource::Immediate,
        )?,
        0xd2 if remaining.len() >= 2 => decode_shift_group(
            architecture,
            8,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
            ShiftSource::Cl,
        )?,
        0x89 if remaining.len() >= 2 => decode_mov_store_no_rex(
            architecture,
            32,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0xb0..=0xb7 if remaining.len() >= 2 => (
            2,
            Operation::SetRegisterImmediate {
                register: low_register_for_width(byte - 0xb0, 8, architecture),
                value: remaining[1] as u64,
                width_bits: 8,
            },
        ),
        0xc6 if remaining.len() >= 3 => decode_mov_imm_group(
            architecture,
            8,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0xc7 if remaining.len() >= 6 => decode_mov_imm_group(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x8a if remaining.len() >= 2 => decode_mov_load_no_rex(
            architecture,
            8,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x8b if remaining.len() >= 2 => decode_mov_load_no_rex(
            architecture,
            32,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0xb8..=0xbf if remaining.len() >= 5 => (
            5,
            Operation::SetRegisterImmediate {
                register: low_register(byte - 0xb8, Architecture::X86),
                value: read_u32_le(remaining, 1)? as u64,
                width_bits: 32,
            },
        ),
        0x87 if remaining.len() >= 2 => decode_xchg_reg_rm(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x8f if remaining.len() >= 2 => decode_group_8f(
            architecture,
            remaining,
            1,
            RexPrefix::NONE,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0xa4 if !remaining.is_empty() => (
            1,
            Operation::MoveString {
                prefix: None,
                width_bits: 8,
            },
        ),
        0xa5 if !remaining.is_empty() => (
            1,
            Operation::MoveString {
                prefix: None,
                width_bits: 32,
            },
        ),
        0xa6 if !remaining.is_empty() => (
            1,
            Operation::CompareString {
                prefix: None,
                width_bits: 8,
            },
        ),
        0xa7 if !remaining.is_empty() => (
            1,
            Operation::CompareString {
                prefix: None,
                width_bits: 32,
            },
        ),
        0xaa if !remaining.is_empty() => (
            1,
            Operation::StoreString {
                prefix: None,
                width_bits: 8,
            },
        ),
        0xab if !remaining.is_empty() => (
            1,
            Operation::StoreString {
                prefix: None,
                width_bits: 32,
            },
        ),
        0xf6 if remaining.len() >= 2 => decode_mul_div_group(
            architecture,
            8,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0xf7 if remaining.len() >= 2 => decode_mul_div_group(
            architecture,
            32,
            RexPrefix::NONE,
            remaining,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0xe8 if remaining.len() >= 5 => {
            let relative = read_i32_le(remaining, 1)? as i64;
            let target = (address as i64 + 5 + relative) as u64;
            (5, Operation::DirectCall { target })
        }
        0xe9 if remaining.len() >= 5 => {
            let relative = read_i32_le(remaining, 1)? as i64;
            let target = (address as i64 + 5 + relative) as u64;
            (5, Operation::DirectJump { target })
        }
        0xeb if remaining.len() >= 2 => {
            let relative = remaining[1] as i8 as i64;
            let target = (address as i64 + 2 + relative) as u64;
            (2, Operation::DirectJump { target })
        }
        0xff if remaining.len() >= 2 => decode_group_ff(
            architecture,
            remaining,
            1,
            RexPrefix::NONE,
            address,
            file_offset,
            &mut diagnostics,
        )?,
        0x40..=0x4f if architecture == Architecture::X86_64 && remaining.len() >= 2 => {
            decode_rex(remaining, address, file_offset, &mut diagnostics)?
        }
        _ => unsupported(byte, file_offset, &mut diagnostics),
    };
    annotate_partial_register_diagnostics(architecture, &operation, file_offset, &mut diagnostics);

    Ok(Instruction {
        address,
        file_offset,
        bytes: remaining[..length].to_vec(),
        operation,
        jump_table: None,
        diagnostics,
    })
}

fn unsupported(
    byte: u8,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> (usize, Operation) {
    diagnostics.push(Diagnostic::warning(
        format!("unsupported x86/x86_64 opcode {byte:#x}"),
        Some(file_offset),
    ));
    (
        1,
        Operation::Unknown {
            bytes: vec![byte],
            reason: "unsupported opcode".to_string(),
        },
    )
}

fn decode_multibyte_nop_len(remaining: &[u8]) -> Option<usize> {
    let mut cursor = 0usize;
    while matches!(
        remaining.get(cursor),
        Some(0x66 | 0x2e | 0x3e | 0x26 | 0x36 | 0x64 | 0x65)
    ) {
        cursor += 1;
    }
    if remaining.get(cursor) != Some(&0x0f) || remaining.get(cursor + 1) != Some(&0x1f) {
        return None;
    }
    let modrm_index = cursor + 2;
    let modrm = *remaining.get(modrm_index)?;
    let mode = modrm >> 6;
    let rm = modrm & 0b111;
    let mut length = modrm_index + 1;
    if mode != 0b11 && rm == 0b100 {
        let sib = *remaining.get(length)?;
        length += 1;
        if mode == 0 && (sib & 0b111) == 0b101 {
            length = length.checked_add(4)?;
        }
    } else if mode == 0 && rm == 0b101 {
        length = length.checked_add(4)?;
    }
    match mode {
        0b01 => length = length.checked_add(1)?,
        0b10 => length = length.checked_add(4)?,
        _ => {}
    }
    (length <= remaining.len()).then_some(length)
}

fn decode_segment_override_memory(
    architecture: Architecture,
    remaining: &[u8],
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    if architecture != Architecture::X86_64 {
        return Ok(unsupported(remaining[0], file_offset, diagnostics));
    }
    let segment = match remaining[0] {
        0x64 => SegmentRegister::Fs,
        0x65 => SegmentRegister::Gs,
        _ => unreachable!(),
    };
    let mut cursor = 1usize;
    let rex = if remaining
        .get(cursor)
        .is_some_and(|byte| matches!(*byte, 0x40..=0x4f))
    {
        let rex = RexPrefix::from_byte(remaining[cursor]);
        cursor += 1;
        rex
    } else {
        RexPrefix::NONE
    };
    let opcode = *remaining
        .get(cursor)
        .ok_or_else(|| BinaryPatchError::InvalidFormat("truncated segment override".to_string()))?;
    if !matches!(opcode, 0x8b | 0x89 | 0x2b) || remaining.len() < cursor + 7 {
        return Ok(unsupported(
            opcode,
            file_offset + cursor as u64,
            diagnostics,
        ));
    }
    let modrm = remaining[cursor + 1];
    let sib = remaining[cursor + 2];
    if modrm >> 6 != 0 || modrm & 0b111 != 0b100 || sib & 0b111 != 0b101 {
        return Ok(unsupported(
            modrm,
            file_offset + cursor as u64 + 1,
            diagnostics,
        ));
    }
    let register = low_register(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        Architecture::X86_64,
    );
    let address = MemoryOperand::SegmentDisplacement {
        segment,
        displacement: read_i32_le(remaining, cursor + 3)?,
        width_bits: if rex.w { 64 } else { 32 },
    };
    let width_bits = if rex.w { 64 } else { 32 };
    let operation = match opcode {
        0x8b => Operation::LoadRegisterMemory {
            dst: register,
            address,
            width_bits,
        },
        0x89 => Operation::StoreMemoryRegister {
            address,
            src: register,
            width_bits,
        },
        0x2b => Operation::SubtractOperandOperand {
            dst: ControlFlowOperand::Register(register),
            src: ControlFlowOperand::Memory(address),
            width_bits,
        },
        _ => unreachable!(),
    };
    Ok((cursor + 7, operation))
}

fn decode_string_instruction(
    architecture: Architecture,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Instruction> {
    let prefix = match remaining[0] {
        0xf3 => Some(StringRepeatPrefix::Repe),
        0xf2 => Some(StringRepeatPrefix::Repne),
        _ => None,
    };
    let mut cursor = 1usize;
    let rex = if architecture == Architecture::X86_64
        && remaining
            .get(1)
            .is_some_and(|byte| (0x40..=0x4f).contains(byte))
    {
        cursor += 1;
        RexPrefix::from_byte(remaining[1] & 0x0f)
    } else {
        RexPrefix::NONE
    };
    let Some(opcode) = remaining.get(cursor).copied() else {
        let (length, operation) = unsupported(remaining[0], file_offset, diagnostics);
        return Ok(Instruction {
            address,
            file_offset,
            bytes: remaining[..length].to_vec(),
            operation,
            jump_table: None,
            diagnostics: diagnostics.clone(),
        });
    };
    let width_bits = if opcode == 0xa4 || opcode == 0xa6 || opcode == 0xaa {
        8
    } else if architecture == Architecture::X86_64 && rex.w {
        64
    } else {
        32
    };
    let operation = match opcode {
        0xa4 => Operation::MoveString { prefix, width_bits },
        0xa5 => Operation::MoveString { prefix, width_bits },
        0xa6 => Operation::CompareString { prefix, width_bits },
        0xa7 => Operation::CompareString { prefix, width_bits },
        0xaa => Operation::StoreString { prefix, width_bits },
        0xab => Operation::StoreString { prefix, width_bits },
        _ => {
            let (length, operation) = unsupported(opcode, file_offset + cursor as u64, diagnostics);
            return Ok(Instruction {
                address,
                file_offset,
                bytes: remaining[..cursor + length].to_vec(),
                operation,
                jump_table: None,
                diagnostics: diagnostics.clone(),
            });
        }
    };
    Ok(Instruction {
        address,
        file_offset,
        bytes: remaining[..cursor + 1].to_vec(),
        operation,
        jump_table: None,
        diagnostics: diagnostics.clone(),
    })
}

fn decode_prefixed_simd_or_x87(
    architecture: Architecture,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<(usize, Operation)>> {
    match remaining[0] {
        0x9b => {
            if remaining.len() >= 3 && remaining[1] == 0xdb && remaining[2] == 0xe3 {
                return Ok(Some((3, Operation::FpuInitialize { wait: true })));
            }
            if remaining.len() >= 3 && remaining[1] == 0xdb && remaining[2] == 0xe2 {
                return Ok(Some((3, Operation::FpuClearExceptions { wait: true })));
            }
            Ok(Some((1, Operation::FpuWait)))
        }
        0x66 | 0xf2 | 0xf3 => {
            if remaining.len() >= 4 && remaining[1] == 0x0f && remaining[2] == 0x1e {
                match remaining[3] {
                    0xfa => return Ok(Some((4, Operation::EndBranch { width_bits: 64 }))),
                    0xfb => return Ok(Some((4, Operation::EndBranch { width_bits: 32 }))),
                    _ => {}
                }
            }
            let prefix = match remaining[0] {
                0x66 => SimdPrefix::Prefix66,
                0xf2 => SimdPrefix::PrefixF2,
                0xf3 => SimdPrefix::PrefixF3,
                _ => unreachable!(),
            };
            let (rex, opcode_index) = if architecture == Architecture::X86_64
                && remaining
                    .get(1)
                    .is_some_and(|byte| matches!(*byte, 0x40..=0x4f))
            {
                (RexPrefix::from_byte(remaining[1]), 2usize)
            } else {
                (RexPrefix::NONE, 1usize)
            };
            if remaining.get(opcode_index) != Some(&0x0f) {
                return Ok(None);
            }
            if remaining.len() < opcode_index + 3 {
                return Ok(None);
            }
            let (length, operation) = decode_two_byte_opcode_with_simd(
                architecture,
                prefix,
                rex,
                &remaining[opcode_index..],
                address + opcode_index as u64,
                file_offset + opcode_index as u64,
                diagnostics,
            )?;
            Ok(Some((length + opcode_index, operation)))
        }
        _ => Ok(None),
    }
}

#[allow(clippy::too_many_arguments)]
fn decode_two_byte_opcode_with_simd(
    architecture: Architecture,
    prefix: SimdPrefix,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let opcode = remaining[1];
    if remaining.len() < 3 {
        return if prefix == SimdPrefix::None {
            decode_two_byte_opcode(
                architecture,
                rex,
                remaining,
                address,
                file_offset,
                diagnostics,
            )
        } else {
            Ok(unsupported(opcode, file_offset + 1, diagnostics).with_prefix())
        };
    }
    match (prefix, opcode) {
        (SimdPrefix::None, 0x28) => decode_simd_move(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movaps,
            128,
        ),
        (SimdPrefix::None, 0x29) => decode_simd_store(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movaps,
            128,
        ),
        (SimdPrefix::None, 0x10) => decode_simd_move(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movups,
            128,
        ),
        (SimdPrefix::None, 0x11) => decode_simd_store(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movups,
            128,
        ),
        (SimdPrefix::Prefix66, 0x6f) => decode_simd_move(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movdqa,
            128,
        ),
        (SimdPrefix::Prefix66, 0x7f) => decode_simd_store(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movdqa,
            128,
        ),
        (SimdPrefix::PrefixF3, 0x6f) => decode_simd_move(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movdqu,
            128,
        ),
        (SimdPrefix::PrefixF3, 0x7f) => decode_simd_store(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movdqu,
            128,
        ),
        (SimdPrefix::Prefix66, 0xef) => decode_simd_binary(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdBinaryKind::Pxor,
            128,
        ),
        (SimdPrefix::None, 0x57) => decode_simd_binary(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdBinaryKind::Xorps,
            128,
        ),
        (SimdPrefix::PrefixF2, 0x58) => decode_simd_binary(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdBinaryKind::Addsd,
            64,
        ),
        (SimdPrefix::PrefixF2, 0x59) => decode_simd_binary(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdBinaryKind::Mulsd,
            64,
        ),
        (SimdPrefix::PrefixF2, 0x11) => decode_simd_store(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            SimdMoveKind::Movsd,
            64,
        ),
        _ if prefix == SimdPrefix::None => decode_two_byte_opcode(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
        ),
        _ => Ok(unsupported(opcode, file_offset + 1, diagnostics).with_prefix()),
    }
}

fn vector_register_for_code(code: u8, architecture: Architecture) -> Option<VectorRegister> {
    if architecture == Architecture::X86 && code >= 8 {
        return None;
    }
    Some(match code {
        0 => VectorRegister::Xmm0,
        1 => VectorRegister::Xmm1,
        2 => VectorRegister::Xmm2,
        3 => VectorRegister::Xmm3,
        4 => VectorRegister::Xmm4,
        5 => VectorRegister::Xmm5,
        6 => VectorRegister::Xmm6,
        7 => VectorRegister::Xmm7,
        8 => VectorRegister::Xmm8,
        9 => VectorRegister::Xmm9,
        10 => VectorRegister::Xmm10,
        11 => VectorRegister::Xmm11,
        12 => VectorRegister::Xmm12,
        13 => VectorRegister::Xmm13,
        14 => VectorRegister::Xmm14,
        15 => VectorRegister::Xmm15,
        _ => return None,
    })
}

#[allow(clippy::too_many_arguments)]
fn decode_vector_operand(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    modrm_index: usize,
    address: u64,
    width_bits: u8,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<(usize, VectorOperand)>> {
    let modrm = remaining[modrm_index];
    if modrm >> 6 == 0b11 {
        let code = extend_reg(modrm & 0b111, rex.b);
        let Some(register) = vector_register_for_code(code, architecture) else {
            return Ok(None);
        };
        return Ok(Some((modrm_index + 1, VectorOperand::Register(register))));
    }
    if architecture != Architecture::X86_64 {
        return Ok(None);
    }
    let Some((length, memory)) = decode_memory_operand64(
        remaining,
        modrm_index,
        rex,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(None);
    };
    Ok(Some((length, VectorOperand::Memory(memory))))
}

#[allow(clippy::too_many_arguments)]
fn decode_simd_move(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    kind: SimdMoveKind,
    width_bits: u8,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let Some(dst) = vector_register_for_code(extend_reg((modrm >> 3) & 0b111, rex.r), architecture)
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let Some((length, src)) = decode_vector_operand(
        architecture,
        rex,
        remaining,
        2,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    Ok((
        length,
        Operation::SimdMove {
            kind,
            direction: SimdMoveDirection::Load,
            dst,
            src,
            width_bits,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn decode_simd_store(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    kind: SimdMoveKind,
    width_bits: u8,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let Some(src) = vector_register_for_code(extend_reg((modrm >> 3) & 0b111, rex.r), architecture)
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    if modrm >> 6 == 0b11 {
        let Some(dst) = vector_register_for_code(extend_reg(modrm & 0b111, rex.b), architecture)
        else {
            return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
        };
        return Ok((
            3,
            Operation::SimdMove {
                kind,
                direction: SimdMoveDirection::Store,
                dst,
                src: VectorOperand::Register(src),
                width_bits,
            },
        ));
    }
    let Some((length, memory)) = decode_memory_operand64(
        remaining,
        2,
        rex,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    Ok((
        length,
        Operation::StoreSimdMemoryRegister {
            kind,
            address: memory,
            src,
            width_bits,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn decode_simd_binary(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    kind: SimdBinaryKind,
    width_bits: u8,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let Some(dst) = vector_register_for_code(extend_reg((modrm >> 3) & 0b111, rex.r), architecture)
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let Some((length, src)) = decode_vector_operand(
        architecture,
        rex,
        remaining,
        2,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    Ok((
        length,
        Operation::SimdBinary {
            kind,
            dst,
            src,
            width_bits,
        },
    ))
}

fn decode_two_byte_opcode(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let opcode = remaining[1];
    if let Some(condition) = condition_from_near_opcode(opcode) {
        if remaining.len() < 6 {
            return Ok(unsupported(opcode, file_offset + 1, diagnostics).with_prefix());
        }
        let relative = read_i32_le(remaining, 2)? as i64;
        let target = (address as i64 + 6 + relative) as u64;
        return Ok((6, Operation::ConditionalJump { condition, target }));
    }
    if let Some(condition) = condition_from_setcc_opcode(opcode) {
        return decode_setcc(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            condition,
        );
    }
    if let Some(condition) = condition_from_cmov_opcode(opcode) {
        return decode_cmov_reg_reg(
            architecture,
            if architecture == Architecture::X86_64 && rex.w {
                64
            } else {
                32
            },
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
            condition,
        );
    }
    if opcode == 0xaf && remaining.len() >= 3 {
        return decode_imul_reg_rm(
            architecture,
            if architecture == Architecture::X86_64 && rex.w {
                64
            } else {
                32
            },
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
        );
    }
    if matches!(opcode, 0xb6 | 0xb7 | 0xbe | 0xbf) && remaining.len() >= 3 {
        return decode_extend_reg_rm(
            architecture,
            rex,
            remaining,
            address,
            file_offset,
            diagnostics,
        );
    }
    Ok(unsupported(opcode, file_offset + 1, diagnostics).with_prefix())
}

#[allow(clippy::too_many_arguments)]
fn decode_bitwise_reg_reg(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    op: BitwiseOp,
    reverse: bool,
) -> (usize, Operation) {
    let modrm = remaining[1];
    if modrm >> 6 != 0b11 {
        return unsupported(modrm, file_offset + 1, diagnostics);
    }
    let reg = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let rm = low_register_for_width(extend_reg(modrm & 0b111, rex.b), width_bits, architecture);
    let (dst, src) = if reverse { (reg, rm) } else { (rm, reg) };
    if matches!(op, BitwiseOp::Xor) && src == dst {
        (
            2,
            Operation::ClearRegister {
                register: dst,
                width_bits,
            },
        )
    } else {
        (
            2,
            match op {
                BitwiseOp::And => Operation::AndRegisterRegister {
                    dst,
                    src,
                    width_bits,
                },
                BitwiseOp::Or => Operation::OrRegisterRegister {
                    dst,
                    src,
                    width_bits,
                },
                BitwiseOp::Xor => Operation::XorRegisterRegister {
                    dst,
                    src,
                    width_bits,
                },
            },
        )
    }
}

fn decode_group81(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let reg = (modrm >> 3) & 0b111;
    let Some((length, operand)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let immediate = read_u32_le(remaining, length).unwrap_or_default() as i32 as i64;
    let operation = match reg {
        1 => match operand {
            ControlFlowOperand::Register(register) => Operation::OrRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        2 => Operation::AddWithCarryOperandImmediate {
            dst: operand,
            value: immediate,
            width_bits,
        },
        3 => Operation::SubtractWithBorrowOperandImmediate {
            dst: operand,
            value: immediate,
            width_bits,
        },
        4 => match operand {
            ControlFlowOperand::Register(register) => Operation::AndRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        5 => match operand {
            ControlFlowOperand::Register(register) => Operation::SubRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        6 => match operand {
            ControlFlowOperand::Register(register) => Operation::XorRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        7 => match operand {
            ControlFlowOperand::Register(register) => Operation::CompareRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        _ => return Ok(unsupported(reg, file_offset + 1, diagnostics)),
    };
    Ok((length + 4, operation))
}

fn decode_group83(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let reg = (modrm >> 3) & 0b111;
    let Some((length, operand)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let immediate = remaining[length] as i8 as i64;
    let operation = match reg {
        0 => match operand {
            ControlFlowOperand::Register(register) => Operation::AddRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        1 => match operand {
            ControlFlowOperand::Register(register) => Operation::OrRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        2 => Operation::AddWithCarryOperandImmediate {
            dst: operand,
            value: immediate,
            width_bits,
        },
        3 => Operation::SubtractWithBorrowOperandImmediate {
            dst: operand,
            value: immediate,
            width_bits,
        },
        4 => match operand {
            ControlFlowOperand::Register(register) => Operation::AndRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        5 => match operand {
            ControlFlowOperand::Register(register) => Operation::SubRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        6 => match operand {
            ControlFlowOperand::Register(register) => Operation::XorRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        7 => match operand {
            ControlFlowOperand::Register(register) => Operation::CompareRegisterImmediate {
                register,
                value: immediate,
                width_bits,
            },
            _ => return Ok(unsupported(modrm, file_offset + 1, diagnostics)),
        },
        _ => return Ok(unsupported(reg, file_offset + 1, diagnostics)),
    };
    Ok((length + 1, operation))
}

#[allow(clippy::too_many_arguments)]
fn decode_shift_group(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    source: ShiftSource,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let Some((length, operand)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let amount = if matches!(source, ShiftSource::Immediate) && matches!(remaining[0], 0xc0 | 0xc1)
    {
        remaining.get(length).copied().unwrap_or(1)
    } else {
        1
    };
    let operation = match (modrm >> 3) & 0b111 {
        4 => match source {
            ShiftSource::Immediate => Operation::ShiftLeftRegisterImmediate {
                dst: operand,
                amount,
                width_bits,
            },
            ShiftSource::Cl => Operation::ShiftLeftRegisterCl {
                dst: operand,
                width_bits,
            },
        },
        5 => match source {
            ShiftSource::Immediate => Operation::ShiftRightLogicalRegisterImmediate {
                dst: operand,
                amount,
                width_bits,
            },
            ShiftSource::Cl => Operation::ShiftRightLogicalRegisterCl {
                dst: operand,
                width_bits,
            },
        },
        7 => match source {
            ShiftSource::Immediate => Operation::ShiftRightArithmeticRegisterImmediate {
                dst: operand,
                amount,
                width_bits,
            },
            ShiftSource::Cl => Operation::ShiftRightArithmeticRegisterCl {
                dst: operand,
                width_bits,
            },
        },
        reg => return Ok(unsupported(reg, file_offset + 1, diagnostics)),
    };
    let amount_len = match source {
        ShiftSource::Immediate if matches!(remaining[0], 0xc0 | 0xc1) => 1,
        _ => 0,
    };
    Ok((length + amount_len, operation))
}

fn decode_mov_reg_reg(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> (usize, Operation) {
    let modrm = remaining[1];
    if modrm >> 6 != 0b11 {
        return unsupported(modrm, file_offset + 1, diagnostics);
    }
    let src = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let dst = low_register_for_width(extend_reg(modrm & 0b111, rex.b), width_bits, architecture);
    (
        2,
        Operation::MoveRegister {
            dst,
            src,
            width_bits,
        },
    )
}

fn decode_mov_load_no_rex(
    architecture: Architecture,
    width_bits: u8,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    if modrm >> 6 == 0b11 {
        return Ok(decode_mov_reg_reg(
            architecture,
            width_bits,
            RexPrefix::NONE,
            remaining,
            file_offset,
            diagnostics,
        ));
    }
    if architecture != Architecture::X86_64 {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    }
    let Some((length, memory)) = decode_memory_operand64(
        remaining,
        1,
        RexPrefix::NONE,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let dst = low_register_for_width((modrm >> 3) & 0b111, width_bits, Architecture::X86_64);
    Ok((
        length,
        Operation::LoadRegisterMemory {
            dst,
            address: memory,
            width_bits,
        },
    ))
}

fn decode_mov_store_no_rex(
    architecture: Architecture,
    width_bits: u8,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    if modrm >> 6 == 0b11 {
        return Ok(decode_mov_reg_reg(
            architecture,
            width_bits,
            RexPrefix::NONE,
            remaining,
            file_offset,
            diagnostics,
        ));
    }
    if architecture != Architecture::X86_64 {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    }
    let Some((length, memory)) = decode_memory_operand64(
        remaining,
        1,
        RexPrefix::NONE,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let src = low_register_for_width((modrm >> 3) & 0b111, width_bits, Architecture::X86_64);
    Ok((
        length,
        Operation::StoreMemoryRegister {
            address: memory,
            src,
            width_bits,
        },
    ))
}

fn decode_mov_imm_group(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let reg = (modrm >> 3) & 0b111;
    if reg != 0 {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    }
    let immediate_width = if width_bits == 8 { 1 } else { 4 };
    let Some((length, operand)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    if remaining.len() < length + immediate_width {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    }
    let value = if width_bits == 8 {
        remaining[length] as i8 as i64
    } else {
        read_u32_le(remaining, length)? as i32 as i64
    };
    let operation = match operand {
        ControlFlowOperand::Register(register) => Operation::SetRegisterImmediate {
            register,
            value: value as u64,
            width_bits,
        },
        ControlFlowOperand::Memory(address) => Operation::StoreMemoryImmediate {
            address,
            value,
            width_bits,
        },
    };
    Ok((length + immediate_width, operation))
}

fn decode_cmp_reg_reg(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    reverse: bool,
) -> (usize, Operation) {
    let modrm = remaining[1];
    if modrm >> 6 != 0b11 {
        return unsupported(modrm, file_offset + 1, diagnostics);
    }
    let reg = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let rm = low_register_for_width(extend_reg(modrm & 0b111, rex.b), width_bits, architecture);
    let (left, right) = if reverse { (reg, rm) } else { (rm, reg) };
    (
        2,
        Operation::CompareRegisterRegister {
            left,
            right,
            width_bits,
        },
    )
}

fn decode_test_reg_reg(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> (usize, Operation) {
    let modrm = remaining[1];
    if modrm >> 6 != 0b11 {
        return unsupported(modrm, file_offset + 1, diagnostics);
    }
    let reg = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let rm = low_register_for_width(extend_reg(modrm & 0b111, rex.b), width_bits, architecture);
    (
        2,
        Operation::TestRegisterRegister {
            left: rm,
            right: reg,
            width_bits,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn decode_operand64(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    modrm_index: usize,
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<(usize, ControlFlowOperand)>> {
    let modrm = remaining[modrm_index];
    if modrm >> 6 == 0b11 {
        let register = if width_bits == 8 {
            low_byte_register(extend_reg(modrm & 0b111, rex.b), architecture, rex)
        } else {
            Some(low_register_for_width(
                extend_reg(modrm & 0b111, rex.b),
                width_bits,
                architecture,
            ))
        };
        let Some(register) = register else {
            return Ok(None);
        };
        return Ok(Some((
            modrm_index + 1,
            ControlFlowOperand::Register(register),
        )));
    }
    if architecture != Architecture::X86_64 {
        return Ok(None);
    }
    let Some((length, memory)) = decode_memory_operand64(
        remaining,
        modrm_index,
        rex,
        address,
        width_bits,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(None);
    };
    Ok(Some((length, ControlFlowOperand::Memory(memory))))
}

#[allow(clippy::too_many_arguments)]
fn decode_cmov_reg_reg(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    condition: ConditionCode,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let Some((length, src)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        2,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let dst = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    Ok((
        length,
        Operation::ConditionalMoveRegister {
            condition,
            dst,
            src,
            width_bits,
        },
    ))
}

fn decode_setcc(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    condition: ConditionCode,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let Some((length, dst)) = decode_operand64(
        architecture,
        8,
        rex,
        remaining,
        2,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    Ok((length, Operation::SetRegisterCondition { condition, dst }))
}

#[allow(clippy::too_many_arguments)]
fn decode_add_sub_with_carry_reg_rm(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    reverse: bool,
    borrow: bool,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let reg = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let Some((length, rm_operand)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let (dst, src) = if reverse {
        (ControlFlowOperand::Register(reg), rm_operand)
    } else {
        (rm_operand, ControlFlowOperand::Register(reg))
    };
    let operation = match borrow {
        false => Operation::AddWithCarryOperandOperand {
            dst,
            src,
            width_bits,
        },
        true => Operation::SubtractWithBorrowOperandOperand {
            dst,
            src,
            width_bits,
        },
    };
    Ok((length, operation))
}

fn decode_mul_div_group(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let reg = (modrm >> 3) & 0b111;
    let Some((length, src)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    let operation = match reg {
        2 => Operation::NotOperand {
            dst: src,
            width_bits,
        },
        3 => Operation::NegOperand {
            dst: src,
            width_bits,
        },
        4 => Operation::UnsignedMultiply { src, width_bits },
        5 => Operation::SignedMultiply { src, width_bits },
        6 => Operation::UnsignedDivide { src, width_bits },
        7 => Operation::SignedDivide { src, width_bits },
        _ => return Ok(unsupported(reg, file_offset + 1, diagnostics)),
    };
    Ok((length, operation))
}

fn decode_extend_reg_rm(
    architecture: Architecture,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let opcode = remaining[1];
    let (signed, source_width_bits) = match opcode {
        0xb6 => (false, 8),
        0xb7 => (false, 16),
        0xbe => (true, 8),
        0xbf => (true, 16),
        _ => return Ok(unsupported(opcode, file_offset + 1, diagnostics).with_prefix()),
    };
    let width_bits = if architecture == Architecture::X86_64 && rex.w {
        64
    } else {
        32
    };
    let modrm = remaining[2];
    let dst = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let Some((length, src)) = decode_operand64(
        architecture,
        source_width_bits,
        rex,
        remaining,
        2,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let operation = if signed {
        Operation::SignExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        }
    } else {
        Operation::ZeroExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        }
    };
    Ok((length, operation))
}

#[allow(clippy::too_many_arguments)]
fn decode_sign_extend_reg_rm(
    architecture: Architecture,
    source_width_bits: u8,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let dst = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let Some((length, src)) = decode_operand64(
        architecture,
        source_width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    Ok((
        length,
        Operation::SignExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        },
    ))
}

fn decode_xchg_reg_rm(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[1];
    let register = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let Some((length, operand)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        1,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 1, diagnostics));
    };
    Ok((
        length,
        Operation::ExchangeRegisterOperand {
            register,
            operand,
            width_bits,
        },
    ))
}

fn decode_imul_reg_rm(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let dst = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let Some((length, src)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        2,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics));
    };
    Ok((
        length,
        Operation::SignedMultiplyRegister {
            dst,
            src,
            width_bits,
        },
    ))
}

#[allow(clippy::too_many_arguments)]
fn decode_imul_reg_rm_imm(
    architecture: Architecture,
    width_bits: u8,
    rex: RexPrefix,
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
    short_imm: bool,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let dst = low_register_for_width(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        width_bits,
        architecture,
    );
    let Some((length, src)) = decode_operand64(
        architecture,
        width_bits,
        rex,
        remaining,
        2,
        address,
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics));
    };
    let value = if short_imm {
        remaining[length] as i8 as i64
    } else {
        read_i32_le(remaining, length)? as i64
    };
    Ok((
        length + if short_imm { 1 } else { 4 },
        Operation::SignedMultiplyRegisterImmediate {
            dst,
            src,
            value,
            width_bits,
        },
    ))
}

fn decode_group_ff(
    architecture: Architecture,
    remaining: &[u8],
    modrm_index: usize,
    rex: RexPrefix,
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[modrm_index];
    let reg = (modrm >> 3) & 0b111;
    let target = if modrm >> 6 == 0b11 {
        ControlFlowOperand::Register(low_register_for_width(
            extend_reg(modrm & 0b111, rex.b),
            native_width(architecture),
            architecture,
        ))
    } else if architecture == Architecture::X86_64 {
        let Some((length, memory)) = decode_memory_operand64(
            remaining,
            modrm_index,
            rex,
            address,
            native_width(architecture),
            file_offset,
            diagnostics,
        )?
        else {
            return Ok(unsupported(
                modrm,
                file_offset + modrm_index as u64,
                diagnostics,
            ));
        };
        return Ok((
            length,
            match reg {
                2 => Operation::IndirectCall {
                    target: ControlFlowOperand::Memory(memory),
                },
                4 => Operation::IndirectJump {
                    target: ControlFlowOperand::Memory(memory),
                },
                6 => Operation::PushMemory {
                    address: memory,
                    width_bits: native_width(architecture),
                },
                _ => unsupported(modrm, file_offset + modrm_index as u64, diagnostics).1,
            },
        ));
    } else {
        return Ok(unsupported(
            modrm,
            file_offset + modrm_index as u64,
            diagnostics,
        ));
    };
    Ok((
        modrm_index + 1,
        match reg {
            2 => Operation::IndirectCall { target },
            4 => Operation::IndirectJump { target },
            6 => match target {
                ControlFlowOperand::Register(register) => Operation::PushRegister {
                    register,
                    width_bits: native_width(architecture),
                },
                ControlFlowOperand::Memory(_) => unreachable!(),
            },
            _ => {
                return Ok(unsupported(
                    modrm,
                    file_offset + modrm_index as u64,
                    diagnostics,
                ))
            }
        },
    ))
}

fn decode_group_8f(
    architecture: Architecture,
    remaining: &[u8],
    modrm_index: usize,
    rex: RexPrefix,
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[modrm_index];
    if (modrm >> 3) & 0b111 != 0 {
        return Ok(unsupported(
            modrm,
            file_offset + modrm_index as u64,
            diagnostics,
        ));
    }
    if modrm >> 6 == 0b11 {
        return Ok((
            modrm_index + 1,
            Operation::PopRegister {
                register: low_register_for_width(
                    extend_reg(modrm & 0b111, rex.b),
                    native_width(architecture),
                    architecture,
                ),
                width_bits: native_width(architecture),
            },
        ));
    }
    if architecture != Architecture::X86_64 {
        return Ok(unsupported(
            modrm,
            file_offset + modrm_index as u64,
            diagnostics,
        ));
    }
    let Some((length, memory)) = decode_memory_operand64(
        remaining,
        modrm_index,
        rex,
        address,
        native_width(architecture),
        file_offset,
        diagnostics,
    )?
    else {
        return Ok(unsupported(
            modrm,
            file_offset + modrm_index as u64,
            diagnostics,
        ));
    };
    Ok((
        length,
        Operation::PopMemory {
            address: memory,
            width_bits: native_width(architecture),
        },
    ))
}

fn decode_rex(
    remaining: &[u8],
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let rex = RexPrefix::from_byte(remaining[0]);
    let width_bits = if rex.w { 64 } else { 32 };
    match remaining.get(1).copied() {
        Some(0x0f) if remaining.len() >= 3 => Ok(decode_two_byte_opcode_with_simd(
            Architecture::X86_64,
            SimdPrefix::None,
            rex,
            &remaining[1..],
            address + 1,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0x09) if remaining.len() >= 3 => Ok(decode_bitwise_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            BitwiseOp::Or,
            false,
        )
        .with_prefix()),
        Some(0x0b) if remaining.len() >= 3 => Ok(decode_bitwise_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            BitwiseOp::Or,
            true,
        )
        .with_prefix()),
        Some(0x21) if remaining.len() >= 3 => Ok(decode_bitwise_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            BitwiseOp::And,
            false,
        )
        .with_prefix()),
        Some(0x23) if remaining.len() >= 3 => Ok(decode_bitwise_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            BitwiseOp::And,
            true,
        )
        .with_prefix()),
        Some(0x31) if remaining.len() >= 3 => Ok(decode_bitwise_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            BitwiseOp::Xor,
            false,
        )
        .with_prefix()),
        Some(0x33) if remaining.len() >= 3 => Ok(decode_bitwise_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            BitwiseOp::Xor,
            true,
        )
        .with_prefix()),
        Some(0x63) if remaining.len() >= 3 && rex.w => Ok(decode_sign_extend_reg_rm(
            Architecture::X86_64,
            32,
            64,
            rex,
            &remaining[1..],
            address + 1,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0x81) if remaining.len() >= 7 => Ok(decode_group81(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0x83) if remaining.len() >= 4 => Ok(decode_group83(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0x69) if remaining.len() >= 7 => Ok(decode_imul_reg_rm_imm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            false,
        )?
        .with_prefix()),
        Some(0x6b) if remaining.len() >= 4 => Ok(decode_imul_reg_rm_imm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            true,
        )?
        .with_prefix()),
        Some(0x11) if remaining.len() >= 3 => Ok(decode_add_sub_with_carry_reg_rm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            false,
            false,
        )?
        .with_prefix()),
        Some(0x13) if remaining.len() >= 3 => Ok(decode_add_sub_with_carry_reg_rm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            true,
            false,
        )?
        .with_prefix()),
        Some(0x19) if remaining.len() >= 3 => Ok(decode_add_sub_with_carry_reg_rm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            false,
            true,
        )?
        .with_prefix()),
        Some(0x1b) if remaining.len() >= 3 => Ok(decode_add_sub_with_carry_reg_rm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            true,
            true,
        )?
        .with_prefix()),
        Some(0x85) if remaining.len() >= 3 => Ok(decode_test_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
        )
        .with_prefix()),
        Some(0xa9) if remaining.len() >= 6 => Ok((
            6,
            Operation::TestRegisterImmediate {
                register: if width_bits == 64 {
                    Register::Rax
                } else {
                    Register::Eax
                },
                value: read_u32_le(remaining, 2)? as i32 as i64,
                width_bits,
            },
        )),
        Some(0xc1) if remaining.len() >= 4 => Ok(decode_shift_group(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            ShiftSource::Immediate,
        )?
        .with_prefix()),
        Some(0xc0) if remaining.len() >= 4 => Ok(decode_shift_group(
            Architecture::X86_64,
            8,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            ShiftSource::Immediate,
        )?
        .with_prefix()),
        Some(0xd1) if remaining.len() >= 3 => Ok(decode_shift_group(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            ShiftSource::Immediate,
        )?
        .with_prefix()),
        Some(0xd3) if remaining.len() >= 3 => Ok(decode_shift_group(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            ShiftSource::Cl,
        )?
        .with_prefix()),
        Some(0xd0) if remaining.len() >= 3 => Ok(decode_shift_group(
            Architecture::X86_64,
            8,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            ShiftSource::Immediate,
        )?
        .with_prefix()),
        Some(0xd2) if remaining.len() >= 3 => Ok(decode_shift_group(
            Architecture::X86_64,
            8,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
            ShiftSource::Cl,
        )?
        .with_prefix()),
        Some(0x87) if remaining.len() >= 3 => Ok(decode_xchg_reg_rm(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address + 1,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0x89) if remaining.len() >= 3 => Ok(decode_mov_reg_or_store64(
            remaining,
            rex,
            width_bits,
            file_offset,
            diagnostics,
        )?),
        Some(0x8b) if remaining.len() >= 3 => Ok(decode_mov_load64(
            remaining,
            rex,
            width_bits,
            address,
            file_offset,
            diagnostics,
        )?),
        Some(0x8d) if remaining.len() >= 3 => Ok(decode_lea64(
            remaining,
            rex,
            address,
            file_offset,
            diagnostics,
        )?),
        Some(0x39) if remaining.len() >= 3 => Ok(decode_cmp_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            false,
        )
        .with_prefix()),
        Some(0x3b) if remaining.len() >= 3 => Ok(decode_cmp_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
            true,
        )
        .with_prefix()),
        Some(0x8f) if remaining.len() >= 3 => Ok(decode_group_8f(
            Architecture::X86_64,
            &remaining[1..],
            1,
            rex,
            address + 1,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0x50..=0x57) => Ok((
            2,
            Operation::PushRegister {
                register: low_register(
                    extend_reg(remaining[1] - 0x50, rex.b),
                    Architecture::X86_64,
                ),
                width_bits: 64,
            },
        )),
        Some(0x58..=0x5f) => Ok((
            2,
            Operation::PopRegister {
                register: low_register(
                    extend_reg(remaining[1] - 0x58, rex.b),
                    Architecture::X86_64,
                ),
                width_bits: 64,
            },
        )),
        Some(0xb6) | Some(0xb7) | Some(0xbe) | Some(0xbf) if remaining.len() >= 3 => {
            Ok(decode_extend_reg_rm(
                Architecture::X86_64,
                rex,
                &remaining[1..],
                address + 1,
                file_offset + 1,
                diagnostics,
            )?
            .with_prefix())
        }
        Some(0xb8..=0xbf) if !rex.w && remaining.len() >= 6 => Ok((
            6,
            Operation::SetRegisterImmediate {
                register: low_register_for_width(
                    extend_reg(remaining[1] - 0xb8, rex.b),
                    32,
                    Architecture::X86_64,
                ),
                value: read_u32_le(remaining, 2)? as u64,
                width_bits: 32,
            },
        )),
        Some(0xb8..=0xbf) if rex.w && remaining.len() >= 10 => Ok((
            10,
            Operation::SetRegisterImmediate {
                register: low_register(
                    extend_reg(remaining[1] - 0xb8, rex.b),
                    Architecture::X86_64,
                ),
                value: read_u64_le(remaining, 2)?,
                width_bits: 64,
            },
        )),
        Some(0xc7) if remaining.len() >= 7 => Ok(decode_mov_imm_group(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0xf6) if remaining.len() >= 3 => Ok(decode_mul_div_group(
            Architecture::X86_64,
            8,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0xf7) if remaining.len() >= 3 => Ok(decode_mul_div_group(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            address,
            file_offset + 1,
            diagnostics,
        )?
        .with_prefix()),
        Some(0xff) if remaining.len() >= 3 => Ok(decode_group_ff(
            Architecture::X86_64,
            remaining,
            2,
            rex,
            address,
            file_offset,
            diagnostics,
        )?),
        _ => Ok((
            1,
            Operation::Unknown {
                bytes: vec![remaining[0]],
                reason: format!("unsupported REX.W instruction at {address:#x}"),
            },
        )),
    }
}

fn decode_mov_reg_or_store64(
    remaining: &[u8],
    rex: RexPrefix,
    width_bits: u8,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    if modrm >> 6 == 0b11 {
        return Ok(decode_mov_reg_reg(
            Architecture::X86_64,
            width_bits,
            rex,
            &remaining[1..],
            file_offset + 1,
            diagnostics,
        )
        .with_prefix());
    }
    if width_bits != 64 {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    }
    let Some((length, memory)) =
        decode_memory_operand64(remaining, 2, rex, 0, 64, file_offset, diagnostics)?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let src = low_register(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        Architecture::X86_64,
    );
    Ok((
        length,
        Operation::StoreMemoryRegister {
            address: memory,
            src,
            width_bits: 64,
        },
    ))
}

fn decode_mov_load64(
    remaining: &[u8],
    rex: RexPrefix,
    width_bits: u8,
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    if modrm >> 6 == 0b11 {
        let src = low_register_for_width(
            extend_reg(modrm & 0b111, rex.b),
            width_bits,
            Architecture::X86_64,
        );
        let dst = low_register_for_width(
            extend_reg((modrm >> 3) & 0b111, rex.r),
            width_bits,
            Architecture::X86_64,
        );
        return Ok((
            3,
            Operation::MoveRegister {
                dst,
                src,
                width_bits,
            },
        ));
    }
    if width_bits != 64 {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    }
    let Some((length, memory)) =
        decode_memory_operand64(remaining, 2, rex, address, 64, file_offset, diagnostics)?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let dst = low_register(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        Architecture::X86_64,
    );
    Ok((
        length,
        Operation::LoadRegisterMemory {
            dst,
            address: memory,
            width_bits: 64,
        },
    ))
}

fn decode_lea64(
    remaining: &[u8],
    rex: RexPrefix,
    address: u64,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(usize, Operation)> {
    let modrm = remaining[2];
    let Some((length, memory)) =
        decode_memory_operand64(remaining, 2, rex, address, 64, file_offset, diagnostics)?
    else {
        return Ok(unsupported(modrm, file_offset + 2, diagnostics).with_prefix());
    };
    let dst = low_register(
        extend_reg((modrm >> 3) & 0b111, rex.r),
        Architecture::X86_64,
    );
    Ok((
        length,
        Operation::LoadEffectiveAddress {
            dst,
            address: memory,
            width_bits: 64,
        },
    ))
}

fn decode_memory_operand64(
    remaining: &[u8],
    modrm_index: usize,
    rex: RexPrefix,
    address: u64,
    width_bits: u8,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<(usize, MemoryOperand)>> {
    let modrm = remaining[modrm_index];
    let mode = modrm >> 6;
    let rm = modrm & 0b111;
    let displacement_index = modrm_index + 1;
    match (mode, rm) {
        (0b00, 0b101) if remaining.len() >= displacement_index + 4 => {
            let displacement = read_i32_le(remaining, displacement_index)? as i64;
            let target = (address as i64 + displacement_index as i64 + 4 + displacement) as u64;
            Ok(Some((
                displacement_index + 4,
                MemoryOperand::RipRelative { target, width_bits },
            )))
        }
        (0b00, 0b100) | (0b01, 0b100) | (0b10, 0b100) => decode_sib_memory_operand64(
            remaining,
            modrm_index,
            rex,
            mode,
            width_bits,
            file_offset,
            diagnostics,
        ),
        (0b00, base) => Ok(Some((
            displacement_index,
            MemoryOperand::BaseDisplacement {
                base: low_register(extend_reg(base, rex.b), Architecture::X86_64),
                displacement: 0,
                width_bits,
            },
        ))),
        (0b01, base) if remaining.len() > displacement_index => Ok(Some((
            displacement_index + 1,
            MemoryOperand::BaseDisplacement {
                base: low_register(extend_reg(base, rex.b), Architecture::X86_64),
                displacement: remaining[displacement_index] as i8 as i32,
                width_bits,
            },
        ))),
        (0b10, base) if remaining.len() >= displacement_index + 4 => Ok(Some((
            displacement_index + 4,
            MemoryOperand::BaseDisplacement {
                base: low_register(extend_reg(base, rex.b), Architecture::X86_64),
                displacement: read_i32_le(remaining, displacement_index)?,
                width_bits,
            },
        ))),
        _ => Ok(None),
    }
}

fn decode_sib_memory_operand64(
    remaining: &[u8],
    modrm_index: usize,
    rex: RexPrefix,
    mode: u8,
    width_bits: u8,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Option<(usize, MemoryOperand)>> {
    let sib_index = modrm_index + 1;
    if remaining.len() <= sib_index {
        return Ok(None);
    }
    let sib = remaining[sib_index];
    let scale_bits = sib >> 6;
    let scale = 1u8 << scale_bits;
    let raw_index_code = (sib >> 3) & 0b111;
    let raw_base_code = sib & 0b111;
    let index_code = extend_reg(raw_index_code, rex.x);
    let base_code = extend_reg(raw_base_code, rex.b);
    let index =
        (raw_index_code != 0b100 || rex.x).then(|| low_register(index_code, Architecture::X86_64));
    let Some((length, base, displacement)) = (match mode {
        0b00 if raw_base_code != 0b101 => Some((
            sib_index + 1,
            Some(low_register(base_code, Architecture::X86_64)),
            0,
        )),
        0b00 if remaining.len() >= sib_index + 5 => {
            Some((sib_index + 5, None, read_i32_le(remaining, sib_index + 1)?))
        }
        0b01 if remaining.len() >= sib_index + 2 => Some((
            sib_index + 2,
            Some(low_register(base_code, Architecture::X86_64)),
            remaining[sib_index + 1] as i8 as i32,
        )),
        0b10 if remaining.len() >= sib_index + 5 => Some((
            sib_index + 5,
            Some(low_register(base_code, Architecture::X86_64)),
            read_i32_le(remaining, sib_index + 1)?,
        )),
        _ => {
            diagnostics.push(Diagnostic::warning(
                "SIB memory operand form is not modeled yet",
                Some(file_offset + sib_index as u64),
            ));
            None
        }
    }) else {
        return Ok(None);
    };
    match index {
        Some(index) => Ok(Some((
            length,
            MemoryOperand::BaseIndexScaleDisplacement {
                base,
                index,
                scale,
                displacement,
                width_bits,
            },
        ))),
        None => match base {
            Some(base) => Ok(Some((
                length,
                MemoryOperand::BaseDisplacement {
                    base,
                    displacement,
                    width_bits,
                },
            ))),
            None => {
                diagnostics.push(Diagnostic::warning(
                    "absolute SIB memory operands are not modeled yet",
                    Some(file_offset + sib_index as u64),
                ));
                Ok(None)
            }
        },
    }
}

trait PrefixedDecode {
    fn with_prefix(self) -> Self;
}

impl PrefixedDecode for (usize, Operation) {
    fn with_prefix(self) -> Self {
        (self.0 + 1, self.1)
    }
}

fn edges_for_operation(id: BasicBlockId, operation: &Operation, next_address: u64) -> Vec<Edge> {
    match operation {
        Operation::DirectJump { target } => vec![Edge {
            from: id,
            to: None,
            target: Some(*target),
            kind: EdgeKind::Jump,
        }],
        Operation::ConditionalJump { target, .. } => vec![
            Edge {
                from: id,
                to: None,
                target: Some(*target),
                kind: EdgeKind::Jump,
            },
            Edge {
                from: id,
                to: None,
                target: Some(next_address),
                kind: EdgeKind::Fallthrough,
            },
        ],
        Operation::DirectCall { target } => vec![Edge {
            from: id,
            to: None,
            target: Some(*target),
            kind: EdgeKind::Call,
        }],
        Operation::Return | Operation::ReturnWithStackAdjustment { .. } => vec![Edge {
            from: id,
            to: None,
            target: None,
            kind: EdgeKind::Return,
        }],
        Operation::Syscall => vec![Edge {
            from: id,
            to: None,
            target: None,
            kind: EdgeKind::Syscall,
        }],
        Operation::IndirectJump { .. }
        | Operation::IndirectCall { .. }
        | Operation::Unknown { .. } => {
            vec![Edge {
                from: id,
                to: None,
                target: None,
                kind: EdgeKind::Unknown,
            }]
        }
        _ => Vec::new(),
    }
}

fn edges_for_instruction(
    id: BasicBlockId,
    instruction: &Instruction,
    next_address: u64,
) -> Vec<Edge> {
    let mut edges = match &instruction.operation {
        Operation::IndirectJump { .. } if instruction.jump_table.is_some() => Vec::new(),
        _ => edges_for_operation(id, &instruction.operation, next_address),
    };
    if let Some(jump_table) = &instruction.jump_table {
        let mut seen_targets = BTreeSet::new();
        for entry in &jump_table.entries {
            if !seen_targets.insert(entry.target) {
                continue;
            }
            edges.push(Edge {
                from: id,
                to: None,
                target: Some(entry.target),
                kind: EdgeKind::Jump,
            });
        }
    }
    edges
}

fn recover_jump_table_candidate(
    binary: &Binary,
    operation: &Operation,
    known_addresses: &BTreeMap<Register, u64>,
) -> Option<JumpTableCandidate> {
    let Operation::IndirectJump { target } = operation else {
        return None;
    };
    let ControlFlowOperand::Memory(memory) = target else {
        return None;
    };
    if !memory.looks_like_jump_table() {
        return None;
    }

    let (table_address, entry_size_bytes) = match memory {
        MemoryOperand::RipRelative { target, width_bits } => (*target, (*width_bits / 8) as usize),
        MemoryOperand::BaseIndexScaleDisplacement {
            base,
            displacement,
            width_bits,
            ..
        } => {
            let table_address = match base {
                Some(register) => {
                    known_addresses
                        .get(&register.family_root())
                        .and_then(|base_address| {
                            if *displacement >= 0 {
                                base_address.checked_add(*displacement as u64)
                            } else {
                                base_address.checked_sub(displacement.checked_abs()? as u64)
                            }
                        })?
                }
                None if *displacement >= 0 => *displacement as u64,
                None => return None,
            };
            (table_address, (*width_bits / 8) as usize)
        }
        _ => return None,
    };

    if !matches!(entry_size_bytes, 4 | 8) {
        return None;
    }
    if table_address % entry_size_bytes as u64 != 0 {
        return None;
    }

    let object = binary.object();
    let table_offset = object.file_offset_for_virtual_address(table_address)? as usize;
    let segment = object.segment_for_virtual_address(table_address)?;
    if !segment.permissions.read {
        return None;
    }

    let bytes = binary.bytes();
    let table_end = segment
        .file_offset
        .saturating_add(segment.file_size)
        .min(bytes.len() as u64) as usize;

    let absolute_entries = recover_jump_table_entries(
        object,
        bytes,
        table_offset,
        table_end,
        table_address,
        entry_size_bytes,
        JumpTableEntryEncoding::Absolute,
        RelativeEntryBase::TableBase,
    );
    let entries = absolute_entries
        .or_else(|| {
            recover_jump_table_entries(
                object,
                bytes,
                table_offset,
                table_end,
                table_address,
                entry_size_bytes,
                JumpTableEntryEncoding::Relative,
                RelativeEntryBase::TableBase,
            )
        })
        .or_else(|| {
            recover_jump_table_entries(
                object,
                bytes,
                table_offset,
                table_end,
                table_address,
                entry_size_bytes,
                JumpTableEntryEncoding::Relative,
                RelativeEntryBase::EntryAddress,
            )
        })
        .or_else(|| {
            if entry_size_bytes == 8 {
                recover_jump_table_entries(
                    object,
                    bytes,
                    table_offset,
                    table_end,
                    table_address,
                    4,
                    JumpTableEntryEncoding::Relative,
                    RelativeEntryBase::TableBase,
                )
            } else {
                None
            }
        })
        .or_else(|| {
            if entry_size_bytes == 8 {
                recover_jump_table_entries(
                    object,
                    bytes,
                    table_offset,
                    table_end,
                    table_address,
                    4,
                    JumpTableEntryEncoding::Relative,
                    RelativeEntryBase::EntryAddress,
                )
            } else {
                None
            }
        })?;

    Some(JumpTableCandidate {
        table_address,
        table_file_offset: table_offset as u64,
        entry_size_bytes: entry_size_bytes as u8,
        entries,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JumpTableEntryEncoding {
    Absolute,
    Relative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelativeEntryBase {
    TableBase,
    EntryAddress,
}

#[allow(clippy::too_many_arguments)]
fn recover_jump_table_entries(
    object: &crate::format::BinaryObject,
    bytes: &[u8],
    table_offset: usize,
    table_end: usize,
    table_address: u64,
    entry_size_bytes: usize,
    encoding: JumpTableEntryEncoding,
    relative_base: RelativeEntryBase,
) -> Option<Vec<JumpTableEntry>> {
    let mut entries = Vec::new();
    for index in 0..MAX_JUMP_TABLE_ENTRIES {
        let entry_offset = table_offset + index * entry_size_bytes;
        if entry_offset + entry_size_bytes > table_end {
            break;
        }
        let target = match (encoding, entry_size_bytes) {
            (JumpTableEntryEncoding::Absolute, 4) => {
                let Ok(value) = read_u32_le(bytes, entry_offset) else {
                    break;
                };
                value as u64
            }
            (JumpTableEntryEncoding::Absolute, 8) => {
                let Ok(value) = read_u64_le(bytes, entry_offset) else {
                    break;
                };
                value
            }
            (JumpTableEntryEncoding::Relative, 4) => {
                let Ok(value) = read_i32_le(bytes, entry_offset) else {
                    break;
                };
                let origin = relative_origin(table_address, entry_size_bytes, index, relative_base);
                let Some(target) = add_signed(origin, value as i64) else {
                    break;
                };
                target
            }
            (JumpTableEntryEncoding::Relative, 8) => {
                let Ok(value) = read_u64_le(bytes, entry_offset) else {
                    break;
                };
                let origin = relative_origin(table_address, entry_size_bytes, index, relative_base);
                let Some(target) = add_signed(origin, value as i64) else {
                    break;
                };
                target
            }
            _ => return None,
        };
        if object
            .executable_segment_for_virtual_address(target)
            .is_none()
        {
            break;
        }
        entries.push(JumpTableEntry { index, target });
    }

    if entries.len() < 2 {
        return None;
    }

    Some(entries)
}

fn add_signed(base: u64, delta: i64) -> Option<u64> {
    if delta >= 0 {
        base.checked_add(delta as u64)
    } else {
        base.checked_sub(delta.checked_abs()? as u64)
    }
}

fn relative_origin(
    table_address: u64,
    entry_size_bytes: usize,
    index: usize,
    relative_base: RelativeEntryBase,
) -> u64 {
    match relative_base {
        RelativeEntryBase::TableBase => table_address,
        RelativeEntryBase::EntryAddress => {
            table_address.saturating_add((index * entry_size_bytes) as u64)
        }
    }
}

fn update_known_addresses(known_addresses: &mut BTreeMap<Register, u64>, operation: &Operation) {
    for register in operation.registers_clobbered() {
        known_addresses.remove(&register);
    }

    match operation {
        Operation::LoadEffectiveAddress {
            dst,
            address: MemoryOperand::RipRelative { target, .. },
            ..
        } => {
            known_addresses.insert(dst.family_root(), *target);
        }
        Operation::MoveRegister { dst, src, .. } => {
            if let Some(target) = known_addresses.get(&src.family_root()).copied() {
                known_addresses.insert(dst.family_root(), target);
            }
        }
        _ => {}
    }
}

fn annotate_partial_register_diagnostics(
    architecture: Architecture,
    operation: &Operation,
    file_offset: u64,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if architecture != Architecture::X86_64 {
        return;
    }

    let mut warned = BTreeSet::new();
    for register in operation
        .registers_read()
        .into_iter()
        .chain(operation.registers_written())
    {
        if register.is_low_byte() && warned.insert(register) {
            diagnostics.push(Diagnostic::warning(
                format!(
                    "x86_64 partial register {register:?} is tracked through its family root {:?}",
                    register.family_root()
                ),
                Some(file_offset),
            ));
        }
    }
}

fn split_blocks_at_internal_targets(
    blocks: &mut Vec<BasicBlock>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let targets: BTreeSet<u64> = blocks
        .iter()
        .flat_map(|block| block.edges.iter().filter_map(|edge| edge.target))
        .collect();
    let mut split_blocks = Vec::new();

    for block in blocks.drain(..) {
        let instruction_starts: BTreeSet<u64> = block
            .instructions
            .iter()
            .map(|instruction| instruction.address)
            .collect();
        let split_points: BTreeSet<u64> = targets
            .iter()
            .copied()
            .filter(|target| *target > block.address && *target < block.end_address())
            .filter(|target| {
                if instruction_starts.contains(target) {
                    true
                } else {
                    diagnostics.push(Diagnostic::warning(
                        format!(
                            "edge targets {target:#x}, which is not an instruction boundary in block {:#x}",
                            block.address
                        ),
                        None,
                    ));
                    false
                }
            })
            .collect();

        if split_points.is_empty() {
            split_blocks.push(block);
            continue;
        }

        let mut current = Vec::new();
        for instruction in block.instructions {
            if split_points.contains(&instruction.address) && !current.is_empty() {
                split_blocks.push(block_from_instructions(BasicBlockId(0), current));
                current = Vec::new();
            }
            current.push(instruction);
        }
        if !current.is_empty() {
            split_blocks.push(block_from_instructions(BasicBlockId(0), current));
        }
    }

    *blocks = split_blocks;
}

fn block_from_instructions(id: BasicBlockId, instructions: Vec<Instruction>) -> BasicBlock {
    let address = instructions
        .first()
        .map(|instruction| instruction.address)
        .unwrap_or_default();
    let file_offset = instructions
        .first()
        .map(|instruction| instruction.file_offset)
        .unwrap_or_default();
    BasicBlock {
        id,
        address,
        file_offset,
        instructions,
        edges: Vec::new(),
    }
}

fn dedupe_blocks_by_address(blocks: &mut Vec<BasicBlock>, _diagnostics: &mut Vec<Diagnostic>) {
    let mut seen = BTreeSet::new();
    blocks.retain(|block| seen.insert(block.address));
}

fn rebuild_edges(blocks: &mut [BasicBlock]) {
    for block in blocks {
        block.edges.clear();
        for instruction in &block.instructions {
            let next_address = instruction.address + instruction.bytes.len() as u64;
            block
                .edges
                .extend(edges_for_instruction(block.id, instruction, next_address));
        }
        add_fallthrough_edge(block);
    }
}

fn add_fallthrough_edge(block: &mut BasicBlock) {
    let Some(last) = block.instructions.last() else {
        return;
    };
    if last.operation.is_terminal() {
        return;
    }
    let target = block.end_address();
    if block
        .edges
        .iter()
        .any(|edge| edge.kind == EdgeKind::Fallthrough && edge.target == Some(target))
    {
        return;
    }
    block.edges.push(Edge {
        from: block.id,
        to: None,
        target: Some(target),
        kind: EdgeKind::Fallthrough,
    });
}

fn resolve_edges(blocks: &mut [BasicBlock], diagnostics: &mut Vec<Diagnostic>) {
    let block_by_address: BTreeMap<u64, BasicBlockId> = blocks
        .iter()
        .map(|block| (block.address, block.id))
        .collect();
    let ranges: Vec<(u64, u64, BasicBlockId)> = blocks
        .iter()
        .map(|block| (block.address, block.end_address(), block.id))
        .collect();

    for block in blocks {
        let block_address = block.address;
        for edge in &mut block.edges {
            edge.from = block.id;
            let Some(target) = edge.target else {
                continue;
            };
            if let Some(id) = block_by_address.get(&target) {
                edge.to = Some(*id);
                continue;
            }
            if ranges
                .iter()
                .any(|(start, end, _)| target > *start && target < *end)
            {
                diagnostics.push(Diagnostic::warning(
                    format!(
                        "edge from {block_address:#x} targets the middle of decoded block {target:#x}; block splitting is required"
                    ),
                    None,
                ));
            }
        }
    }
}

pub fn encode_operation(
    architecture: Architecture,
    address: u64,
    operation: &Operation,
) -> Result<Vec<u8>> {
    let bytes = match operation {
        Operation::Nop => vec![0x90],
        Operation::NopBytes { bytes } => bytes.clone(),
        Operation::Halt => vec![0xf4],
        Operation::EndBranch { width_bits: 64 } => vec![0xf3, 0x0f, 0x1e, 0xfa],
        Operation::EndBranch { width_bits: 32 } => vec![0xf3, 0x0f, 0x1e, 0xfb],
        Operation::EndBranch { width_bits } => {
            return Err(BinaryPatchError::Unsupported(format!(
                "unsupported endbr width {width_bits}"
            )))
        }
        Operation::Breakpoint => vec![0xcc],
        Operation::Interrupt { vector } => vec![0xcd, *vector],
        Operation::ClearRegister {
            register,
            width_bits,
        } => encode_clear_register(*register, *width_bits)?,
        Operation::MoveRegister {
            dst,
            src,
            width_bits,
        } => encode_move_register(architecture, *dst, *src, *width_bits)?,
        Operation::LoadEffectiveAddress {
            dst,
            address: memory,
            width_bits,
        } => encode_rip_relative_memory_op(0x8d, architecture, *dst, memory, *width_bits, address)?,
        Operation::LoadRegisterMemory {
            dst,
            address: memory,
            width_bits,
        } => {
            let opcode = if *width_bits == 8 { 0x8a } else { 0x8b };
            encode_rip_relative_memory_op(opcode, architecture, *dst, memory, *width_bits, address)?
        }
        Operation::StoreMemoryRegister {
            address: memory,
            src,
            width_bits,
        } => {
            let opcode = if *width_bits == 8 { 0x88 } else { 0x89 };
            encode_memory_reg_op(opcode, architecture, *src, memory, *width_bits, address)?
        }
        Operation::StoreMemoryImmediate {
            address: memory,
            value,
            width_bits,
        } => encode_memory_imm_op(architecture, memory, *value, *width_bits, address)?,
        Operation::SimdMove {
            kind,
            direction,
            dst,
            src,
            width_bits,
        } => encode_simd_move(
            architecture,
            address,
            *kind,
            *direction,
            *dst,
            src,
            *width_bits,
        )?,
        Operation::StoreSimdMemoryRegister {
            kind,
            address: memory,
            src,
            width_bits,
        } => encode_simd_store(architecture, address, *kind, memory, *src, *width_bits)?,
        Operation::SimdBinary {
            kind,
            dst,
            src,
            width_bits,
        } => encode_simd_binary(architecture, address, *kind, *dst, src, *width_bits)?,
        Operation::FpuWait => vec![0x9b],
        Operation::FpuNoop => vec![0xd9, 0xd0],
        Operation::FpuInitialize { wait } => {
            if *wait {
                vec![0x9b, 0xdb, 0xe3]
            } else {
                vec![0xdb, 0xe3]
            }
        }
        Operation::FpuClearExceptions { wait } => {
            if *wait {
                vec![0x9b, 0xdb, 0xe2]
            } else {
                vec![0xdb, 0xe2]
            }
        }
        Operation::SetRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_set_reg_imm(architecture, *register, *value, *width_bits)?,
        Operation::AddRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_group1_imm(0, architecture, *register, *value, *width_bits)?,
        Operation::AndRegisterImmediate {
            register,
            value,
            width_bits,
        } if *width_bits == 8 && *register == Register::Al => vec![0x24, *value as i8 as u8],
        Operation::AndRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_group1_imm(4, architecture, *register, *value, *width_bits)?,
        Operation::OrRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_group1_imm(1, architecture, *register, *value, *width_bits)?,
        Operation::XorRegisterImmediate {
            register,
            value,
            width_bits,
        } if *width_bits == 32 && *register == Register::Eax => {
            let mut bytes = vec![0x35];
            bytes.extend_from_slice(&(*value as i32).to_le_bytes());
            bytes
        }
        Operation::XorRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_group1_imm(6, architecture, *register, *value, *width_bits)?,
        Operation::SubRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_group1_imm(5, architecture, *register, *value, *width_bits)?,
        Operation::CompareRegisterImmediate {
            register,
            value,
            width_bits,
        } => encode_cmp_reg_imm(architecture, *register, *value, *width_bits)?,
        Operation::CompareRegisterRegister {
            left,
            right,
            width_bits,
        } => encode_reg_reg(0x39, architecture, *left, *right, *width_bits)?,
        Operation::TestRegisterRegister {
            left,
            right,
            width_bits,
        } => {
            let opcode = if *width_bits == 8 { 0x84 } else { 0x85 };
            encode_reg_reg(opcode, architecture, *left, *right, *width_bits)?
        }
        Operation::TestRegisterImmediate {
            register,
            value,
            width_bits,
        } => {
            if !matches!(
                (*register, *width_bits),
                (Register::Rax, 64) | (Register::Eax, 32)
            ) {
                return Err(BinaryPatchError::Unsupported(
                    "test immediate accumulator encoding only supports eax/rax".to_string(),
                ));
            }
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && *width_bits == 64 {
                bytes.push(rex_byte(true, false, false, false));
            }
            bytes.push(0xa9);
            bytes.extend_from_slice(&(*value as i32).to_le_bytes());
            bytes
        }
        Operation::AndRegisterRegister {
            dst,
            src,
            width_bits,
        } => encode_reg_reg(0x21, architecture, *dst, *src, *width_bits)?,
        Operation::OrRegisterRegister {
            dst,
            src,
            width_bits,
        } => encode_reg_reg(0x09, architecture, *dst, *src, *width_bits)?,
        Operation::XorRegisterRegister {
            dst,
            src,
            width_bits,
        } => encode_reg_reg(0x31, architecture, *dst, *src, *width_bits)?,
        Operation::ShiftLeftRegisterImmediate {
            dst,
            amount,
            width_bits,
        } => encode_shift_imm(4, architecture, dst, *amount, *width_bits, address)?,
        Operation::ShiftRightLogicalRegisterImmediate {
            dst,
            amount,
            width_bits,
        } => encode_shift_imm(5, architecture, dst, *amount, *width_bits, address)?,
        Operation::ShiftRightArithmeticRegisterImmediate {
            dst,
            amount,
            width_bits,
        } => encode_shift_imm(7, architecture, dst, *amount, *width_bits, address)?,
        Operation::ShiftLeftRegisterCl { dst, width_bits } => {
            encode_shift_cl(4, architecture, dst, *width_bits, address)?
        }
        Operation::ShiftRightLogicalRegisterCl { dst, width_bits } => {
            encode_shift_cl(5, architecture, dst, *width_bits, address)?
        }
        Operation::ShiftRightArithmeticRegisterCl { dst, width_bits } => {
            encode_shift_cl(7, architecture, dst, *width_bits, address)?
        }
        Operation::AddWithCarryOperandImmediate {
            dst,
            value,
            width_bits,
        } => encode_binary_imm_op(2, architecture, dst, *value, *width_bits, address)?,
        Operation::AddWithCarryOperandOperand {
            dst,
            src,
            width_bits,
        } => encode_binary_op(0x11, 0x13, architecture, dst, src, *width_bits, address)?,
        Operation::SubtractWithBorrowOperandImmediate {
            dst,
            value,
            width_bits,
        } => encode_binary_imm_op(3, architecture, dst, *value, *width_bits, address)?,
        Operation::SubtractWithBorrowOperandOperand {
            dst,
            src,
            width_bits,
        } => encode_binary_op(0x19, 0x1b, architecture, dst, src, *width_bits, address)?,
        Operation::SubtractOperandOperand {
            dst,
            src,
            width_bits,
        } => encode_binary_op(0x29, 0x2b, architecture, dst, src, *width_bits, address)?,
        Operation::ConditionalMoveRegister {
            condition,
            dst,
            src,
            width_bits,
        } => encode_cmov(*condition, architecture, *dst, src, *width_bits, address)?,
        Operation::SetRegisterCondition { condition, dst } => {
            encode_setcc(*condition, dst, address)?
        }
        Operation::UnsignedMultiply { src, width_bits } => {
            encode_mul_div(4, architecture, src, *width_bits, address)?
        }
        Operation::SignedMultiply { src, width_bits } => {
            encode_mul_div(5, architecture, src, *width_bits, address)?
        }
        Operation::SignedMultiplyRegister {
            dst,
            src,
            width_bits,
        } => encode_imul_reg_rm(architecture, *dst, src, *width_bits, address)?,
        Operation::SignedMultiplyRegisterImmediate {
            dst,
            src,
            value,
            width_bits,
        } => encode_imul_reg_rm_imm(architecture, *dst, src, *value, *width_bits, address)?,
        Operation::UnsignedDivide { src, width_bits } => {
            encode_mul_div(6, architecture, src, *width_bits, address)?
        }
        Operation::SignedDivide { src, width_bits } => {
            encode_mul_div(7, architecture, src, *width_bits, address)?
        }
        Operation::PushRegister {
            register,
            width_bits,
        } => encode_push_pop(0x50, *register, *width_bits)?,
        Operation::PopRegister {
            register,
            width_bits,
        } => encode_push_pop(0x58, *register, *width_bits)?,
        Operation::PushImmediate { value, width_bits } => {
            encode_push_imm(architecture, *value, *width_bits)?
        }
        Operation::PushMemory {
            address: memory,
            width_bits,
        } => encode_memory_opcode(0xff, 6, memory, *width_bits == 64, address)?,
        Operation::PopMemory {
            address: memory,
            width_bits,
        } => encode_memory_opcode(0x8f, 0, memory, *width_bits == 64, address)?,
        Operation::ExchangeRegisterOperand {
            register,
            operand,
            width_bits,
        } => encode_xchg(architecture, *register, operand, *width_bits, address)?,
        Operation::SignExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        } => encode_extend(
            architecture,
            true,
            *dst,
            src,
            *source_width_bits,
            *width_bits,
            address,
        )?,
        Operation::ZeroExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        } => encode_extend(
            architecture,
            false,
            *dst,
            src,
            *source_width_bits,
            *width_bits,
            address,
        )?,
        Operation::NotOperand { dst, width_bits } => {
            encode_unary_op(2, architecture, dst, *width_bits, address)?
        }
        Operation::NegOperand { dst, width_bits } => {
            encode_unary_op(3, architecture, dst, *width_bits, address)?
        }
        Operation::MoveString { prefix, width_bits } => {
            encode_string_op(architecture, prefix, 0xa4, 0xa5, *width_bits)?
        }
        Operation::StoreString { prefix, width_bits } => {
            encode_string_op(architecture, prefix, 0xaa, 0xab, *width_bits)?
        }
        Operation::CompareString { prefix, width_bits } => {
            encode_string_op(architecture, prefix, 0xa6, 0xa7, *width_bits)?
        }
        Operation::LeaveFrame => vec![0xc9],
        Operation::Syscall => {
            if architecture != Architecture::X86_64 {
                return Err(BinaryPatchError::Unsupported(
                    "syscall encoding requires x86_64".to_string(),
                ));
            }
            vec![0x0f, 0x05]
        }
        Operation::Return => vec![0xc3],
        Operation::ReturnWithStackAdjustment { bytes } => {
            let mut encoded = vec![0xc2];
            encoded.extend_from_slice(&bytes.to_le_bytes());
            encoded
        }
        Operation::DirectJump { target } => encode_rel32(0xe9, address, *target, 5)?,
        Operation::ConditionalJump { condition, target } => {
            encode_conditional_rel32(*condition, address, *target)?
        }
        Operation::DirectCall { target } => encode_rel32(0xe8, address, *target, 5)?,
        Operation::IndirectJump { target } => {
            encode_indirect_control(4, architecture, target, address)?
        }
        Operation::IndirectCall { target } => {
            encode_indirect_control(2, architecture, target, address)?
        }
        Operation::Unknown { reason, .. } => {
            return Err(BinaryPatchError::Unsupported(format!(
                "cannot encode unknown operation at {address:#x}: {reason}"
            )))
        }
    };
    Ok(bytes)
}

fn encode_rip_relative_memory_op(
    opcode: u8,
    architecture: Architecture,
    dst: Register,
    memory: &MemoryOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    encode_memory_reg_op(opcode, architecture, dst, memory, width_bits, address)
}

fn encode_memory_reg_op(
    opcode: u8,
    architecture: Architecture,
    reg: Register,
    memory: &MemoryOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    if architecture != Architecture::X86_64 || !matches!(width_bits, 8 | 32 | 64) {
        return Err(BinaryPatchError::Unsupported(
            "memory operand encoding is currently x86_64 8/32/64-bit only".to_string(),
        ));
    }
    let Some(reg_code) = register_code(reg) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode memory operand register {reg:?}"
        )));
    };
    encode_memory_opcode(opcode, reg_code, memory, width_bits == 64, address)
}

fn encode_memory_imm_op(
    architecture: Architecture,
    memory: &MemoryOperand,
    value: i64,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    if architecture != Architecture::X86_64 || !matches!(width_bits, 8 | 32 | 64) {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode memory immediate width {width_bits}"
        )));
    }
    let mut bytes = encode_memory_opcode(0xc7, 0, memory, width_bits == 64, address)?;
    if width_bits == 8 {
        bytes = encode_memory_opcode(0xc6, 0, memory, false, address)?;
        bytes.push(value as i8 as u8);
    } else {
        bytes.extend_from_slice(&(value as i32).to_le_bytes());
    }
    Ok(bytes)
}

fn encode_simd_move(
    architecture: Architecture,
    address: u64,
    kind: SimdMoveKind,
    direction: SimdMoveDirection,
    dst: VectorRegister,
    src: &VectorOperand,
    width_bits: u8,
) -> Result<Vec<u8>> {
    let (prefix, load_opcode, store_opcode) = simd_move_encoding(kind);
    if (kind == SimdMoveKind::Movsd && width_bits != 64)
        || (kind != SimdMoveKind::Movsd && width_bits != 128)
    {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode SIMD move width {width_bits}"
        )));
    }
    match direction {
        SimdMoveDirection::Load => match src {
            VectorOperand::Register(src) => {
                encode_vector_reg_reg(prefix, load_opcode, architecture, dst, *src, false)
            }
            VectorOperand::Memory(memory) => {
                encode_vector_memory_op(prefix, load_opcode, architecture, dst, memory, address)
            }
        },
        SimdMoveDirection::Store => match src {
            VectorOperand::Register(src) => {
                encode_vector_reg_reg(prefix, store_opcode, architecture, dst, *src, true)
            }
            VectorOperand::Memory(_) => Err(BinaryPatchError::Unsupported(
                "cannot encode SIMD register store from memory source".to_string(),
            )),
        },
    }
}

fn encode_simd_store(
    architecture: Architecture,
    address: u64,
    kind: SimdMoveKind,
    memory: &MemoryOperand,
    src: VectorRegister,
    width_bits: u8,
) -> Result<Vec<u8>> {
    let (prefix, _, store_opcode) = simd_move_encoding(kind);
    if width_bits != 128 {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode SIMD move width {width_bits}"
        )));
    }
    encode_vector_memory_op(prefix, store_opcode, architecture, src, memory, address)
}

fn encode_simd_binary(
    architecture: Architecture,
    address: u64,
    kind: SimdBinaryKind,
    dst: VectorRegister,
    src: &VectorOperand,
    width_bits: u8,
) -> Result<Vec<u8>> {
    let (prefix, opcode) = simd_binary_encoding(kind);
    match kind {
        SimdBinaryKind::Xorps | SimdBinaryKind::Pxor => {
            if width_bits != 128 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode SIMD binary width {width_bits}"
                )));
            }
        }
        SimdBinaryKind::Addsd | SimdBinaryKind::Mulsd => {
            if width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode SIMD binary width {width_bits}"
                )));
            }
        }
    }
    match src {
        VectorOperand::Register(src) => {
            encode_vector_reg_reg(prefix, opcode, architecture, dst, *src, false)
        }
        VectorOperand::Memory(memory) => {
            encode_vector_memory_op(prefix, opcode, architecture, dst, memory, address)
        }
    }
}

fn simd_move_encoding(kind: SimdMoveKind) -> (Option<u8>, u8, u8) {
    match kind {
        SimdMoveKind::Movaps => (None, 0x28, 0x29),
        SimdMoveKind::Movups => (None, 0x10, 0x11),
        SimdMoveKind::Movdqa => (Some(0x66), 0x6f, 0x7f),
        SimdMoveKind::Movdqu => (Some(0xf3), 0x6f, 0x7f),
        SimdMoveKind::Movsd => (Some(0xf2), 0x10, 0x11),
    }
}

fn simd_binary_encoding(kind: SimdBinaryKind) -> (Option<u8>, u8) {
    match kind {
        SimdBinaryKind::Xorps => (None, 0x57),
        SimdBinaryKind::Pxor => (Some(0x66), 0xef),
        SimdBinaryKind::Addsd => (Some(0xf2), 0x58),
        SimdBinaryKind::Mulsd => (Some(0xf2), 0x59),
    }
}

fn encode_vector_reg_reg(
    prefix: Option<u8>,
    opcode: u8,
    architecture: Architecture,
    dst: VectorRegister,
    src: VectorRegister,
    reverse: bool,
) -> Result<Vec<u8>> {
    let dst_code = dst.code();
    let src_code = src.code();
    if architecture == Architecture::X86 && (dst_code >= 8 || src_code >= 8) {
        return Err(BinaryPatchError::Unsupported(
            "cannot encode extended XMM registers outside x86_64".to_string(),
        ));
    }
    let (reg_code, rm_code) = if reverse {
        (src_code, dst_code)
    } else {
        (dst_code, src_code)
    };
    let modrm = 0b11_000_000 | (low3(reg_code) << 3) | low3(rm_code);
    let mut bytes = Vec::new();
    if let Some(prefix) = prefix {
        bytes.push(prefix);
    }
    if architecture == Architecture::X86_64 && (high_bit(src_code) || high_bit(dst_code)) {
        bytes.push(rex_byte(
            false,
            high_bit(src_code),
            false,
            high_bit(dst_code),
        ));
    }
    bytes.extend_from_slice(&[0x0f, opcode, modrm]);
    Ok(bytes)
}

fn encode_vector_memory_op(
    prefix: Option<u8>,
    opcode: u8,
    architecture: Architecture,
    reg: VectorRegister,
    memory: &MemoryOperand,
    address: u64,
) -> Result<Vec<u8>> {
    let reg_code = reg.code();
    if architecture == Architecture::X86 && reg_code >= 8 {
        return Err(BinaryPatchError::Unsupported(
            "cannot encode extended XMM registers outside x86_64".to_string(),
        ));
    }
    let mut bytes = encode_memory_opcode(
        opcode,
        reg_code,
        memory,
        false,
        address + u64::from(prefix.is_some()),
    )?;
    if let Some(prefix) = prefix {
        bytes.insert(0, prefix);
    }
    Ok(bytes)
}

fn encode_memory_opcode(
    opcode: u8,
    reg_code: u8,
    memory: &MemoryOperand,
    rex_w: bool,
    address: u64,
) -> Result<Vec<u8>> {
    let reg_low = low3(reg_code);
    match memory {
        MemoryOperand::RipRelative { target, .. } => {
            let prefix_len = usize::from(needs_rex_prefix(rex_w, high_bit(reg_code), false, false));
            let relative = *target as i128 - (address + (prefix_len + 2 + 4) as u64) as i128;
            if relative < i32::MIN as i128 || relative > i32::MAX as i128 {
                return Err(BinaryPatchError::Unsupported(
                    "RIP-relative target is outside disp32 range".to_string(),
                ));
            }
            let modrm = (reg_low << 3) | 0b101;
            let mut bytes = Vec::new();
            push_rex_prefix(&mut bytes, rex_w, high_bit(reg_code), false, false);
            bytes.extend_from_slice(&[opcode, modrm]);
            bytes.extend_from_slice(&(relative as i32).to_le_bytes());
            Ok(bytes)
        }
        MemoryOperand::BaseDisplacement {
            base, displacement, ..
        } => {
            let Some(base_code) = register_code(*base) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode memory base {base:?}"
                )));
            };
            let base_low = low3(base_code);
            if base_low == 0b100 {
                encode_sib_base_memory_op(opcode, reg_code, base_code, rex_w, *displacement)
            } else {
                let (mode, displacement_bytes) = displacement_encoding(*displacement, base_low);
                let modrm = (mode << 6) | (reg_low << 3) | base_low;
                let mut bytes = Vec::new();
                push_rex_prefix(
                    &mut bytes,
                    rex_w,
                    high_bit(reg_code),
                    false,
                    high_bit(base_code),
                );
                bytes.extend_from_slice(&[opcode, modrm]);
                bytes.extend_from_slice(&displacement_bytes);
                Ok(bytes)
            }
        }
        MemoryOperand::BaseIndexScaleDisplacement {
            base,
            index,
            scale,
            displacement,
            ..
        } => encode_indexed_sib_memory_op(
            opcode,
            reg_code,
            *base,
            *index,
            *scale,
            rex_w,
            *displacement,
        ),
        MemoryOperand::SegmentDisplacement {
            segment,
            displacement,
            ..
        } => {
            let mut bytes = vec![segment_prefix(*segment)];
            push_rex_prefix(&mut bytes, rex_w, high_bit(reg_code), false, false);
            bytes.extend_from_slice(&[opcode, (reg_low << 3) | 0b100, 0b00_100_101]);
            bytes.extend_from_slice(&displacement.to_le_bytes());
            Ok(bytes)
        }
        MemoryOperand::Unsupported { description } => Err(BinaryPatchError::Unsupported(format!(
            "cannot encode unsupported memory operand: {description}"
        ))),
    }
}

fn segment_prefix(segment: SegmentRegister) -> u8 {
    match segment {
        SegmentRegister::Fs => 0x64,
        SegmentRegister::Gs => 0x65,
    }
}

fn encode_sib_base_memory_op(
    opcode: u8,
    reg_code: u8,
    base_code: u8,
    rex_w: bool,
    displacement: i32,
) -> Result<Vec<u8>> {
    let sib = 0b00_100_100;
    let (mode, displacement_bytes) = displacement_encoding(displacement, low3(base_code));
    let modrm = (mode << 6) | (low3(reg_code) << 3) | 0b100;
    let mut bytes = Vec::new();
    push_rex_prefix(
        &mut bytes,
        rex_w,
        high_bit(reg_code),
        false,
        high_bit(base_code),
    );
    bytes.extend_from_slice(&[opcode, modrm, sib]);
    bytes.extend_from_slice(&displacement_bytes);
    Ok(bytes)
}

fn encode_indexed_sib_memory_op(
    opcode: u8,
    reg_code: u8,
    base: Option<Register>,
    index: Register,
    scale: u8,
    rex_w: bool,
    displacement: i32,
) -> Result<Vec<u8>> {
    let scale_bits = match scale {
        1 => 0,
        2 => 1,
        4 => 2,
        8 => 3,
        _ => {
            return Err(BinaryPatchError::Unsupported(format!(
                "invalid SIB scale {scale}"
            )))
        }
    };
    let Some(index_code) = register_code(index) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode memory index {index:?}"
        )));
    };
    if index_code == 0b100 {
        return Err(BinaryPatchError::Unsupported(
            "rsp cannot be encoded as a SIB index".to_string(),
        ));
    }

    let (mode, base_code, displacement_bytes) = match base {
        Some(base) => {
            let Some(base_code) = register_code(base) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode memory base {base:?}"
                )));
            };
            let (mode, displacement_bytes) = displacement_encoding(displacement, low3(base_code));
            (mode, base_code, displacement_bytes)
        }
        None => (0b00, 0b101, displacement.to_le_bytes().to_vec()),
    };
    let modrm = (mode << 6) | (low3(reg_code) << 3) | 0b100;
    let sib = (scale_bits << 6) | (low3(index_code) << 3) | low3(base_code);
    let mut bytes = Vec::new();
    push_rex_prefix(
        &mut bytes,
        rex_w,
        high_bit(reg_code),
        high_bit(index_code),
        high_bit(base_code),
    );
    bytes.extend_from_slice(&[opcode, modrm, sib]);
    bytes.extend_from_slice(&displacement_bytes);
    Ok(bytes)
}

fn encode_indirect_control(
    reg_field: u8,
    architecture: Architecture,
    target: &ControlFlowOperand,
    address: u64,
) -> Result<Vec<u8>> {
    match target {
        ControlFlowOperand::Register(register) => {
            let Some(code) = register_code(*register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode indirect control register {register:?}"
                )));
            };
            if architecture != Architecture::X86_64 && high_bit(code) {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode extended register {register:?} outside x86_64"
                )));
            }
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 {
                push_rex_prefix(&mut bytes, false, false, false, high_bit(code));
            }
            bytes.extend_from_slice(&[0xff, 0b11_000_000 | (reg_field << 3) | low3(code)]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            if architecture != Architecture::X86_64 {
                return Err(BinaryPatchError::Unsupported(
                    "memory indirect control flow is currently x86_64 only".to_string(),
                ));
            }
            encode_memory_opcode(0xff, reg_field, memory, false, address)
        }
    }
}

fn encode_clear_register(register: Register, width_bits: u8) -> Result<Vec<u8>> {
    let Some(code) = register_code(register) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode clear {register:?}"
        )));
    };
    let architecture = if width_bits == 64 || high_bit(code) {
        Architecture::X86_64
    } else {
        Architecture::X86
    };
    encode_reg_reg(0x31, architecture, register, register, width_bits)
}

fn encode_set_reg_imm(
    architecture: Architecture,
    register: Register,
    value: u64,
    width_bits: u8,
) -> Result<Vec<u8>> {
    if width_bits == 32 && value > u32::MAX as u64 {
        return Err(BinaryPatchError::Unsupported(
            "immediate values wider than 32 bits are not encoded yet".to_string(),
        ));
    }
    let imm = (value as u32).to_le_bytes();
    match (architecture, register, width_bits) {
        (_, register, 8) => {
            let Some(code) = register_code(register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode {register:?} as byte register"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && needs_rex_for_low_byte(register) {
                bytes.push(rex_byte(false, false, false, high_bit(code)));
            }
            bytes.push(0xb0 + low3(code));
            bytes.push(value as u8);
            Ok(bytes)
        }
        (_, register, 32) => {
            let Some(code) = register_code(register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode {register:?} as general register"
                )));
            };
            if code >= 8 && architecture != Architecture::X86_64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode extended register {register:?} outside x86_64"
                )));
            }
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && high_bit(code) {
                bytes.push(rex_byte(false, false, false, true));
            }
            bytes.push(0xb8 + low3(code));
            bytes.extend_from_slice(&imm);
            Ok(bytes)
        }
        (Architecture::X86_64, register, 64) => {
            let Some(code) = register_code(register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode {register:?} as general register"
                )));
            };
            let signed = value as i64;
            if signed as u64 == value && signed >= i32::MIN as i64 && signed <= i32::MAX as i64 {
                let mut bytes = vec![
                    rex_byte(true, false, false, high_bit(code)),
                    0xc7,
                    0b11_000_000 | low3(code),
                ];
                bytes.extend_from_slice(&(signed as i32).to_le_bytes());
                Ok(bytes)
            } else {
                let mut bytes = vec![
                    rex_byte(true, false, false, high_bit(code)),
                    0xb8 + low3(code),
                ];
                bytes.extend_from_slice(&value.to_le_bytes());
                Ok(bytes)
            }
        }
        _ => Err(BinaryPatchError::Unsupported(format!(
            "cannot encode {register:?} immediate with width {width_bits}"
        ))),
    }
}

fn encode_move_register(
    architecture: Architecture,
    dst: Register,
    src: Register,
    width_bits: u8,
) -> Result<Vec<u8>> {
    encode_reg_reg(0x89, architecture, dst, src, width_bits)
}

fn encode_reg_reg(
    opcode: u8,
    architecture: Architecture,
    dst_rm: Register,
    src_reg: Register,
    width_bits: u8,
) -> Result<Vec<u8>> {
    let Some(dst_code) = register_code(dst_rm) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode destination register {dst_rm:?}"
        )));
    };
    let Some(src_code) = register_code(src_reg) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode source register {src_reg:?}"
        )));
    };
    let modrm = 0b11_000_000 | (low3(src_code) << 3) | low3(dst_code);
    if architecture == Architecture::X86_64 && width_bits == 64 {
        Ok(vec![
            rex_byte(true, high_bit(src_code), false, high_bit(dst_code)),
            opcode,
            modrm,
        ])
    } else if width_bits == 32 {
        let mut bytes = Vec::new();
        if architecture == Architecture::X86_64 && (high_bit(src_code) || high_bit(dst_code)) {
            bytes.push(rex_byte(
                false,
                high_bit(src_code),
                false,
                high_bit(dst_code),
            ));
        }
        bytes.extend_from_slice(&[opcode, modrm]);
        Ok(bytes)
    } else {
        Err(BinaryPatchError::Unsupported(format!(
            "cannot encode register/register opcode {opcode:#x} width {width_bits}"
        )))
    }
}

fn encode_cmp_reg_imm(
    architecture: Architecture,
    register: Register,
    value: i64,
    width_bits: u8,
) -> Result<Vec<u8>> {
    let Some(code) = register_code(register) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode register {register:?}"
        )));
    };
    let modrm = 0b11_000_000 | (7 << 3) | low3(code);
    if value >= i8::MIN as i64 && value <= i8::MAX as i64 {
        if architecture == Architecture::X86_64 && width_bits == 64 {
            Ok(vec![
                rex_byte(true, false, false, high_bit(code)),
                0x83,
                modrm,
                value as i8 as u8,
            ])
        } else if width_bits == 32 {
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && high_bit(code) {
                bytes.push(rex_byte(false, false, false, true));
            }
            bytes.extend_from_slice(&[0x83, modrm, value as i8 as u8]);
            Ok(bytes)
        } else {
            Err(BinaryPatchError::Unsupported(format!(
                "cannot encode cmp immediate width {width_bits}"
            )))
        }
    } else if value >= i32::MIN as i64 && value <= i32::MAX as i64 {
        let imm = (value as i32).to_le_bytes();
        if architecture == Architecture::X86_64 && width_bits == 64 {
            Ok([
                vec![rex_byte(true, false, false, high_bit(code)), 0x81, modrm],
                imm.to_vec(),
            ]
            .concat())
        } else if width_bits == 32 {
            let mut prefix = Vec::new();
            if architecture == Architecture::X86_64 && high_bit(code) {
                prefix.push(rex_byte(false, false, false, true));
            }
            Ok([prefix, vec![0x81, modrm], imm.to_vec()].concat())
        } else {
            Err(BinaryPatchError::Unsupported(format!(
                "cannot encode cmp immediate width {width_bits}"
            )))
        }
    } else {
        Err(BinaryPatchError::Unsupported(
            "cmp immediate outside i32 range".to_string(),
        ))
    }
}

fn encode_group1_imm(
    reg_field: u8,
    architecture: Architecture,
    register: Register,
    value: i64,
    width_bits: u8,
) -> Result<Vec<u8>> {
    let Some(code) = register_code(register) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode register {register:?}"
        )));
    };
    let modrm = 0b11_000_000 | (reg_field << 3) | low3(code);
    if value >= i8::MIN as i64 && value <= i8::MAX as i64 {
        if architecture == Architecture::X86_64 && width_bits == 64 {
            Ok(vec![
                rex_byte(true, false, false, high_bit(code)),
                0x83,
                modrm,
                value as i8 as u8,
            ])
        } else if width_bits == 32 {
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && high_bit(code) {
                bytes.push(rex_byte(false, false, false, true));
            }
            bytes.extend_from_slice(&[0x83, modrm, value as i8 as u8]);
            Ok(bytes)
        } else {
            Err(BinaryPatchError::Unsupported(format!(
                "cannot encode group1 immediate width {width_bits}"
            )))
        }
    } else if value >= i32::MIN as i64 && value <= i32::MAX as i64 {
        let imm = (value as i32).to_le_bytes();
        if architecture == Architecture::X86_64 && width_bits == 64 {
            Ok([
                vec![rex_byte(true, false, false, high_bit(code)), 0x81, modrm],
                imm.to_vec(),
            ]
            .concat())
        } else if width_bits == 32 {
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && high_bit(code) {
                bytes.push(rex_byte(false, false, false, true));
            }
            bytes.extend_from_slice(&[0x81, modrm]);
            bytes.extend_from_slice(&imm);
            Ok(bytes)
        } else {
            Err(BinaryPatchError::Unsupported(format!(
                "cannot encode group1 immediate width {width_bits}"
            )))
        }
    } else {
        Err(BinaryPatchError::Unsupported(
            "group1 immediate outside i32 range".to_string(),
        ))
    }
}

fn encode_group83_imm(
    reg_field: u8,
    architecture: Architecture,
    register: Register,
    value: i64,
    width_bits: u8,
) -> Result<Vec<u8>> {
    if value < i8::MIN as i64 || value > i8::MAX as i64 {
        return Err(BinaryPatchError::Unsupported(
            "group83 immediate outside i8 range".to_string(),
        ));
    }
    let Some(code) = register_code(register) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode register {register:?}"
        )));
    };
    let modrm = 0b11_000_000 | (reg_field << 3) | low3(code);
    if architecture == Architecture::X86_64 && width_bits == 64 {
        Ok(vec![
            rex_byte(true, false, false, high_bit(code)),
            0x83,
            modrm,
            value as i8 as u8,
        ])
    } else if width_bits == 32 || width_bits == native_width(architecture) {
        let mut bytes = Vec::new();
        if architecture == Architecture::X86_64 && high_bit(code) {
            bytes.push(rex_byte(false, false, false, true));
        }
        bytes.extend_from_slice(&[0x83, modrm, value as i8 as u8]);
        Ok(bytes)
    } else {
        Err(BinaryPatchError::Unsupported(format!(
            "cannot encode group83 width {width_bits}"
        )))
    }
}

fn encode_shift_imm(
    reg_field: u8,
    architecture: Architecture,
    dst: &ControlFlowOperand,
    amount: u8,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let opcode = match (width_bits, amount) {
        (8, 1) => 0xd0,
        (8, _) => 0xc0,
        (_, 1) => 0xd1,
        _ => 0xc1,
    };
    match dst {
        ControlFlowOperand::Register(register) => {
            let Some(code) = register_code(*register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode register {register:?}"
                )));
            };
            if width_bits != 8 && width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode shift width {width_bits}"
                )));
            }
            let mut bytes = Vec::new();
            let rex_b = high_bit(code);
            if architecture == Architecture::X86_64
                && (width_bits == 64
                    || rex_b
                    || (width_bits == 8 && needs_rex_for_low_byte(*register)))
            {
                bytes.push(rex_byte(width_bits == 64, false, false, rex_b));
            }
            let modrm = 0b11_000_000 | (reg_field << 3) | low3(code);
            bytes.extend_from_slice(&[opcode, modrm]);
            if !matches!(opcode, 0xd0 | 0xd1) {
                bytes.push(amount);
            }
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => encode_shift_memory_op(
            opcode,
            reg_field,
            memory,
            architecture,
            width_bits,
            address,
            amount,
        ),
    }
}

fn encode_shift_cl(
    reg_field: u8,
    architecture: Architecture,
    dst: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let opcode = if width_bits == 8 { 0xd2 } else { 0xd3 };
    match dst {
        ControlFlowOperand::Register(register) => {
            let Some(code) = register_code(*register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode register {register:?}"
                )));
            };
            if width_bits != 8 && width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode shift width {width_bits}"
                )));
            }
            let mut bytes = Vec::new();
            let rex_b = high_bit(code);
            if architecture == Architecture::X86_64
                && (width_bits == 64
                    || rex_b
                    || (width_bits == 8 && needs_rex_for_low_byte(*register)))
            {
                bytes.push(rex_byte(width_bits == 64, false, false, rex_b));
            }
            let modrm = 0b11_000_000 | (reg_field << 3) | low3(code);
            bytes.extend_from_slice(&[opcode, modrm]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => encode_shift_memory_op(
            opcode,
            reg_field,
            memory,
            architecture,
            width_bits,
            address,
            1,
        ),
    }
}

fn encode_binary_op(
    opcode_rm_reg: u8,
    opcode_reg_rm: u8,
    architecture: Architecture,
    dst: &ControlFlowOperand,
    src: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    match (dst, src) {
        (ControlFlowOperand::Register(dst), ControlFlowOperand::Register(src)) => {
            encode_reg_reg(opcode_rm_reg, architecture, *dst, *src, width_bits)
        }
        (ControlFlowOperand::Register(dst), ControlFlowOperand::Memory(memory)) => {
            let Some(dst_code) = register_code(*dst) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode destination register {dst:?}"
                )));
            };
            if width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode binary op width {width_bits}"
                )));
            }
            encode_memory_opcode(opcode_reg_rm, dst_code, memory, width_bits == 64, address)
        }
        (ControlFlowOperand::Memory(memory), ControlFlowOperand::Register(src)) => {
            let Some(src_code) = register_code(*src) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode source register {src:?}"
                )));
            };
            if width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode binary op width {width_bits}"
                )));
            }
            encode_memory_opcode(opcode_rm_reg, src_code, memory, width_bits == 64, address)
        }
        _ => Err(BinaryPatchError::Unsupported(
            "binary operation with two memory operands is not supported".to_string(),
        )),
    }
}

fn encode_binary_imm_op(
    reg_field: u8,
    architecture: Architecture,
    dst: &ControlFlowOperand,
    value: i64,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    if value >= i8::MIN as i64 && value <= i8::MAX as i64 {
        match dst {
            ControlFlowOperand::Register(register) => {
                encode_group83_imm(reg_field, architecture, *register, value, width_bits)
            }
            ControlFlowOperand::Memory(memory) => {
                let mut bytes =
                    encode_memory_opcode(0x83, reg_field, memory, width_bits == 64, address)?;
                bytes.push(value as i8 as u8);
                Ok(bytes)
            }
        }
    } else if value >= i32::MIN as i64 && value <= i32::MAX as i64 {
        match dst {
            ControlFlowOperand::Register(register) => {
                encode_group1_imm(reg_field, architecture, *register, value, width_bits)
            }
            ControlFlowOperand::Memory(memory) => {
                let mut bytes =
                    encode_memory_opcode(0x81, reg_field, memory, width_bits == 64, address)?;
                bytes.extend_from_slice(&(value as i32).to_le_bytes());
                Ok(bytes)
            }
        }
    } else {
        Err(BinaryPatchError::Unsupported(
            "binary immediate outside i32 range".to_string(),
        ))
    }
}

fn encode_mul_div(
    reg_field: u8,
    architecture: Architecture,
    src: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let opcode = if width_bits == 8 { 0xf6 } else { 0xf7 };
    match src {
        ControlFlowOperand::Register(register) => {
            let Some(code) = register_code(*register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode source register {register:?}"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64
                && (width_bits == 64
                    || high_bit(code)
                    || (width_bits == 8 && needs_rex_for_low_byte(*register)))
            {
                bytes.push(rex_byte(width_bits == 64, false, false, high_bit(code)));
            }
            let modrm = 0b11_000_000 | (reg_field << 3) | low3(code);
            bytes.extend_from_slice(&[opcode, modrm]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            if width_bits != 8 && width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode mul/div width {width_bits}"
                )));
            }
            encode_memory_opcode(opcode, reg_field, memory, width_bits == 64, address)
        }
    }
}

fn encode_imul_reg_rm(
    architecture: Architecture,
    dst: Register,
    src: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let Some(dst_code) = register_code(dst) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode destination register {dst:?}"
        )));
    };
    match src {
        ControlFlowOperand::Register(src) => {
            let Some(src_code) = register_code(*src) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode source register {src:?}"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64
                && (width_bits == 64 || high_bit(dst_code) || high_bit(src_code))
            {
                bytes.push(rex_byte(
                    width_bits == 64,
                    high_bit(dst_code),
                    false,
                    high_bit(src_code),
                ));
            }
            bytes.extend_from_slice(&[
                0x0f,
                0xaf,
                0b11_000_000 | (low3(dst_code) << 3) | low3(src_code),
            ]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            if width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode imul width {width_bits}"
                )));
            }
            encode_two_byte_memory_opcode(0x0f, 0xaf, dst_code, memory, width_bits == 64, address)
        }
    }
}

fn encode_imul_reg_rm_imm(
    architecture: Architecture,
    dst: Register,
    src: &ControlFlowOperand,
    value: i64,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let (opcode, imm_bytes) = if value >= i8::MIN as i64 && value <= i8::MAX as i64 {
        (0x6b, vec![value as i8 as u8])
    } else if value >= i32::MIN as i64 && value <= i32::MAX as i64 {
        (0x69, (value as i32).to_le_bytes().to_vec())
    } else {
        return Err(BinaryPatchError::Unsupported(
            "imul immediate outside i32 range".to_string(),
        ));
    };
    let Some(dst_code) = register_code(dst) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode destination register {dst:?}"
        )));
    };
    match src {
        ControlFlowOperand::Register(src) => {
            let Some(src_code) = register_code(*src) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode source register {src:?}"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64
                && (width_bits == 64 || high_bit(dst_code) || high_bit(src_code))
            {
                bytes.push(rex_byte(
                    width_bits == 64,
                    high_bit(dst_code),
                    false,
                    high_bit(src_code),
                ));
            }
            bytes.extend_from_slice(&[
                opcode,
                0b11_000_000 | (low3(dst_code) << 3) | low3(src_code),
            ]);
            bytes.extend_from_slice(&imm_bytes);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            if width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode imul width {width_bits}"
                )));
            }
            let mut bytes =
                encode_memory_opcode(opcode, dst_code, memory, width_bits == 64, address)?;
            bytes.extend_from_slice(&imm_bytes);
            Ok(bytes)
        }
    }
}

fn encode_two_byte_memory_opcode(
    opcode_prefix: u8,
    opcode: u8,
    reg_code: u8,
    memory: &MemoryOperand,
    rex_w: bool,
    address: u64,
) -> Result<Vec<u8>> {
    let reg_low = low3(reg_code);
    match memory {
        MemoryOperand::RipRelative { target, .. } => {
            let prefix_len = usize::from(needs_rex_prefix(rex_w, high_bit(reg_code), false, false));
            let relative = *target as i128 - (address + (prefix_len + 3 + 4) as u64) as i128;
            if relative < i32::MIN as i128 || relative > i32::MAX as i128 {
                return Err(BinaryPatchError::Unsupported(
                    "RIP-relative target is outside disp32 range".to_string(),
                ));
            }
            let modrm = (reg_low << 3) | 0b101;
            let mut bytes = Vec::new();
            push_rex_prefix(&mut bytes, rex_w, high_bit(reg_code), false, false);
            bytes.extend_from_slice(&[opcode_prefix, opcode, modrm]);
            bytes.extend_from_slice(&(relative as i32).to_le_bytes());
            Ok(bytes)
        }
        MemoryOperand::BaseDisplacement {
            base, displacement, ..
        } => {
            let Some(base_code) = register_code(*base) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode memory base {base:?}"
                )));
            };
            let base_low = low3(base_code);
            if base_low == 0b100 {
                let (mode, displacement_bytes) = displacement_encoding(*displacement, base_low);
                let modrm = (mode << 6) | (reg_low << 3) | 0b100;
                let mut bytes = Vec::new();
                push_rex_prefix(
                    &mut bytes,
                    rex_w,
                    high_bit(reg_code),
                    false,
                    high_bit(base_code),
                );
                bytes.extend_from_slice(&[opcode_prefix, opcode, modrm, 0b00_100_100]);
                bytes.extend_from_slice(&displacement_bytes);
                Ok(bytes)
            } else {
                let (mode, displacement_bytes) = displacement_encoding(*displacement, base_low);
                let modrm = (mode << 6) | (reg_low << 3) | base_low;
                let mut bytes = Vec::new();
                push_rex_prefix(
                    &mut bytes,
                    rex_w,
                    high_bit(reg_code),
                    false,
                    high_bit(base_code),
                );
                bytes.extend_from_slice(&[opcode_prefix, opcode, modrm]);
                bytes.extend_from_slice(&displacement_bytes);
                Ok(bytes)
            }
        }
        MemoryOperand::BaseIndexScaleDisplacement {
            base,
            index,
            scale,
            displacement,
            ..
        } => encode_indexed_two_byte_sib_memory_op(
            opcode_prefix,
            opcode,
            reg_code,
            *base,
            *index,
            *scale,
            rex_w,
            *displacement,
        ),
        MemoryOperand::SegmentDisplacement { .. } => Err(BinaryPatchError::Unsupported(
            "cannot encode segment memory operand for two-byte opcode".to_string(),
        )),
        MemoryOperand::Unsupported { description } => Err(BinaryPatchError::Unsupported(format!(
            "cannot encode unsupported memory operand: {description}"
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
fn encode_indexed_two_byte_sib_memory_op(
    opcode_prefix: u8,
    opcode: u8,
    reg_code: u8,
    base: Option<Register>,
    index: Register,
    scale: u8,
    rex_w: bool,
    displacement: i32,
) -> Result<Vec<u8>> {
    let scale_bits = match scale {
        1 => 0,
        2 => 1,
        4 => 2,
        8 => 3,
        _ => {
            return Err(BinaryPatchError::Unsupported(format!(
                "invalid SIB scale {scale}"
            )))
        }
    };
    let Some(index_code) = register_code(index) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode memory index {index:?}"
        )));
    };
    if index_code == 0b100 {
        return Err(BinaryPatchError::Unsupported(
            "rsp cannot be encoded as a SIB index".to_string(),
        ));
    }
    let (mode, base_code, displacement_bytes) = match base {
        Some(base) => {
            let Some(base_code) = register_code(base) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode memory base {base:?}"
                )));
            };
            let (mode, displacement_bytes) = displacement_encoding(displacement, low3(base_code));
            (mode, base_code, displacement_bytes)
        }
        None => (0b00, 0b101, displacement.to_le_bytes().to_vec()),
    };
    let modrm = (mode << 6) | (low3(reg_code) << 3) | 0b100;
    let sib = (scale_bits << 6) | (low3(index_code) << 3) | low3(base_code);
    let mut bytes = Vec::new();
    let base_high = base.and_then(register_code).is_some_and(high_bit);
    push_rex_prefix(
        &mut bytes,
        rex_w,
        high_bit(reg_code),
        high_bit(index_code),
        base_high,
    );
    bytes.extend_from_slice(&[opcode_prefix, opcode, modrm, sib]);
    bytes.extend_from_slice(&displacement_bytes);
    Ok(bytes)
}

fn encode_shift_memory_op(
    opcode: u8,
    reg_field: u8,
    memory: &MemoryOperand,
    architecture: Architecture,
    width_bits: u8,
    address: u64,
    amount: u8,
) -> Result<Vec<u8>> {
    if width_bits != 8 && width_bits != 32 && width_bits != 64 {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode shift width {width_bits}"
        )));
    }
    let mut bytes = encode_memory_opcode(opcode, reg_field, memory, width_bits == 64, address)?;
    if matches!(opcode, 0xc0 | 0xc1) {
        bytes.push(amount);
    }
    let _ = architecture;
    Ok(bytes)
}

fn encode_cmov(
    condition: ConditionCode,
    architecture: Architecture,
    dst: Register,
    src: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let Some(dst_code) = register_code(dst) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode destination register {dst:?}"
        )));
    };
    match src {
        ControlFlowOperand::Register(src) => {
            let Some(src_code) = register_code(*src) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode source register {src:?}"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && width_bits == 64 {
                bytes.push(rex_byte(
                    true,
                    high_bit(dst_code),
                    false,
                    high_bit(src_code),
                ));
            } else if width_bits == 32 {
                if architecture == Architecture::X86_64
                    && (high_bit(dst_code) || high_bit(src_code))
                {
                    bytes.push(rex_byte(
                        false,
                        high_bit(dst_code),
                        false,
                        high_bit(src_code),
                    ));
                }
            } else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode cmov width {width_bits}"
                )));
            }
            bytes.extend_from_slice(&[
                0x0f,
                0x40 + condition_code(condition),
                0b11_000_000 | (low3(dst_code) << 3) | low3(src_code),
            ]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            if width_bits != 32 && width_bits != 64 {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode cmov width {width_bits}"
                )));
            }
            encode_two_byte_memory_opcode(
                0x0f,
                0x40 + condition_code(condition),
                dst_code,
                memory,
                width_bits == 64,
                address,
            )
        }
    }
}

fn encode_setcc(
    condition: ConditionCode,
    dst: &ControlFlowOperand,
    address: u64,
) -> Result<Vec<u8>> {
    match dst {
        ControlFlowOperand::Register(register) => {
            let Some(code) = register_code(*register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode setcc destination {register:?}"
                )));
            };
            let mut bytes = Vec::new();
            if needs_rex_for_low_byte(*register) || high_bit(code) {
                bytes.push(rex_byte(false, false, false, high_bit(code)));
            }
            bytes.extend_from_slice(&[
                0x0f,
                0x90 + condition_code(condition),
                0b11_000_000 | low3(code),
            ]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => encode_two_byte_memory_opcode(
            0x0f,
            0x90 + condition_code(condition),
            0,
            memory,
            false,
            address,
        ),
    }
}

fn encode_push_pop(opcode_base: u8, register: Register, width_bits: u8) -> Result<Vec<u8>> {
    let Some(code) = register_code(register) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode stack register {register:?}"
        )));
    };
    if width_bits == 32 || width_bits == 64 {
        let mut bytes = Vec::new();
        if high_bit(code) {
            bytes.push(rex_byte(false, false, false, true));
        }
        bytes.push(opcode_base + low3(code));
        Ok(bytes)
    } else {
        Err(BinaryPatchError::Unsupported(format!(
            "cannot encode stack op width {width_bits}"
        )))
    }
}

fn encode_push_imm(architecture: Architecture, value: i64, width_bits: u8) -> Result<Vec<u8>> {
    if width_bits != 32 && width_bits != 64 {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode push immediate width {width_bits}"
        )));
    }
    let _ = architecture;
    if value >= i8::MIN as i64 && value <= i8::MAX as i64 {
        Ok(vec![0x6a, value as i8 as u8])
    } else if value >= i32::MIN as i64 && value <= i32::MAX as i64 {
        let mut bytes = vec![0x68];
        bytes.extend_from_slice(&(value as i32).to_le_bytes());
        Ok(bytes)
    } else {
        Err(BinaryPatchError::Unsupported(
            "push immediate outside i32 range".to_string(),
        ))
    }
}

fn encode_xchg(
    architecture: Architecture,
    register: Register,
    operand: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    match operand {
        ControlFlowOperand::Register(other) => {
            encode_reg_reg(0x87, architecture, *other, register, width_bits)
        }
        ControlFlowOperand::Memory(memory) => {
            let Some(code) = register_code(register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode xchg register {register:?}"
                )));
            };
            encode_memory_opcode(0x87, code, memory, width_bits == 64, address)
        }
    }
}

fn encode_extend(
    architecture: Architecture,
    signed: bool,
    dst: Register,
    src: &ControlFlowOperand,
    source_width_bits: u8,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let opcode = match (signed, source_width_bits, width_bits) {
        (true, 8, 32) | (true, 8, 64) => 0xbe,
        (true, 16, 32) | (true, 16, 64) => 0xbf,
        (false, 8, 32) | (false, 8, 64) => 0xb6,
        (false, 16, 32) | (false, 16, 64) => 0xb7,
        (true, 32, 64) if architecture == Architecture::X86_64 => 0x63,
        _ => {
            return Err(BinaryPatchError::Unsupported(format!(
                "cannot encode extend from width {source_width_bits} to {width_bits}"
            )))
        }
    };
    let Some(dst_code) = register_code(dst) else {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode destination register {dst:?}"
        )));
    };
    match src {
        ControlFlowOperand::Register(src) => {
            let Some(src_code) = register_code(*src) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode source register {src:?}"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && width_bits == 64 {
                bytes.push(rex_byte(
                    true,
                    high_bit(dst_code),
                    false,
                    high_bit(src_code),
                ));
            } else if architecture == Architecture::X86_64
                && (high_bit(dst_code) || high_bit(src_code))
            {
                bytes.push(rex_byte(
                    false,
                    high_bit(dst_code),
                    false,
                    high_bit(src_code),
                ));
            }
            if opcode == 0x63 {
                bytes.push(opcode);
            } else {
                bytes.extend_from_slice(&[0x0f, opcode]);
            }
            bytes.push(0b11_000_000 | (low3(dst_code) << 3) | low3(src_code));
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            if opcode == 0x63 {
                encode_memory_opcode(0x63, dst_code, memory, width_bits == 64, address)
            } else {
                encode_two_byte_memory_opcode(
                    0x0f,
                    opcode,
                    dst_code,
                    memory,
                    width_bits == 64,
                    address,
                )
            }
        }
    }
}

fn encode_unary_op(
    reg_field: u8,
    architecture: Architecture,
    dst: &ControlFlowOperand,
    width_bits: u8,
    address: u64,
) -> Result<Vec<u8>> {
    let opcode = if width_bits == 8 { 0xf6 } else { 0xf7 };
    match dst {
        ControlFlowOperand::Register(register) => {
            let Some(code) = register_code(*register) else {
                return Err(BinaryPatchError::Unsupported(format!(
                    "cannot encode unary register {register:?}"
                )));
            };
            let mut bytes = Vec::new();
            if architecture == Architecture::X86_64 && (width_bits == 64 || high_bit(code)) {
                bytes.push(rex_byte(width_bits == 64, false, false, high_bit(code)));
            }
            bytes.extend_from_slice(&[opcode, 0b11_000_000 | (reg_field << 3) | low3(code)]);
            Ok(bytes)
        }
        ControlFlowOperand::Memory(memory) => {
            encode_memory_opcode(opcode, reg_field, memory, width_bits == 64, address)
        }
    }
}

fn encode_string_op(
    architecture: Architecture,
    prefix: &Option<StringRepeatPrefix>,
    byte_opcode: u8,
    word_opcode: u8,
    width_bits: u8,
) -> Result<Vec<u8>> {
    if width_bits != 8 && width_bits != 32 && width_bits != 64 {
        return Err(BinaryPatchError::Unsupported(format!(
            "cannot encode string op width {width_bits}"
        )));
    }
    let mut bytes = Vec::new();
    if let Some(prefix) = prefix {
        bytes.push(match prefix {
            StringRepeatPrefix::Rep | StringRepeatPrefix::Repe => 0xf3,
            StringRepeatPrefix::Repne => 0xf2,
        });
    }
    if architecture == Architecture::X86_64 && width_bits == 64 {
        bytes.push(rex_byte(true, false, false, false));
    }
    bytes.push(if width_bits == 8 {
        byte_opcode
    } else {
        word_opcode
    });
    Ok(bytes)
}

fn encode_rel32(opcode: u8, address: u64, target: u64, length: u64) -> Result<Vec<u8>> {
    let relative = target as i128 - (address + length) as i128;
    if relative < i32::MIN as i128 || relative > i32::MAX as i128 {
        return Err(BinaryPatchError::Unsupported(
            "relative branch target is outside rel32 range".to_string(),
        ));
    }
    let mut bytes = vec![opcode];
    bytes.extend_from_slice(&(relative as i32).to_le_bytes());
    Ok(bytes)
}

fn encode_conditional_rel32(
    condition: ConditionCode,
    address: u64,
    target: u64,
) -> Result<Vec<u8>> {
    let relative = target as i128 - (address + 6) as i128;
    if relative < i32::MIN as i128 || relative > i32::MAX as i128 {
        return Err(BinaryPatchError::Unsupported(
            "conditional branch target is outside rel32 range".to_string(),
        ));
    }
    let mut bytes = vec![0x0f, 0x80 + condition_code(condition)];
    bytes.extend_from_slice(&(relative as i32).to_le_bytes());
    Ok(bytes)
}

fn condition_from_short_opcode(opcode: u8) -> Option<ConditionCode> {
    condition_from_code(opcode.checked_sub(0x70)?)
}

fn condition_from_near_opcode(opcode: u8) -> Option<ConditionCode> {
    condition_from_code(opcode.checked_sub(0x80)?)
}

fn condition_from_cmov_opcode(opcode: u8) -> Option<ConditionCode> {
    condition_from_code(opcode.checked_sub(0x40)?)
}

fn condition_from_setcc_opcode(opcode: u8) -> Option<ConditionCode> {
    condition_from_code(opcode.checked_sub(0x90)?)
}

fn condition_from_code(code: u8) -> Option<ConditionCode> {
    Some(match code {
        0x0 => ConditionCode::Overflow,
        0x1 => ConditionCode::NotOverflow,
        0x2 => ConditionCode::Below,
        0x3 => ConditionCode::AboveOrEqual,
        0x4 => ConditionCode::Equal,
        0x5 => ConditionCode::NotEqual,
        0x6 => ConditionCode::BelowOrEqual,
        0x7 => ConditionCode::Above,
        0x8 => ConditionCode::Sign,
        0x9 => ConditionCode::NotSign,
        0xa => ConditionCode::Parity,
        0xb => ConditionCode::NotParity,
        0xc => ConditionCode::Less,
        0xd => ConditionCode::GreaterOrEqual,
        0xe => ConditionCode::LessOrEqual,
        0xf => ConditionCode::Greater,
        _ => return None,
    })
}

fn condition_code(condition: ConditionCode) -> u8 {
    match condition {
        ConditionCode::Overflow => 0x0,
        ConditionCode::NotOverflow => 0x1,
        ConditionCode::Below => 0x2,
        ConditionCode::AboveOrEqual => 0x3,
        ConditionCode::Equal => 0x4,
        ConditionCode::NotEqual => 0x5,
        ConditionCode::BelowOrEqual => 0x6,
        ConditionCode::Above => 0x7,
        ConditionCode::Sign => 0x8,
        ConditionCode::NotSign => 0x9,
        ConditionCode::Parity => 0xa,
        ConditionCode::NotParity => 0xb,
        ConditionCode::Less => 0xc,
        ConditionCode::GreaterOrEqual => 0xd,
        ConditionCode::LessOrEqual => 0xe,
        ConditionCode::Greater => 0xf,
    }
}

fn native_width(architecture: Architecture) -> u8 {
    match architecture {
        Architecture::X86 => 32,
        Architecture::X86_64 => 64,
    }
}

fn extend_reg(code: u8, high_bit: bool) -> u8 {
    code | if high_bit { 0b1000 } else { 0 }
}

fn low3(code: u8) -> u8 {
    code & 0b111
}

fn high_bit(code: u8) -> bool {
    code & 0b1000 != 0
}

fn rex_byte(w: bool, r: bool, x: bool, b: bool) -> u8 {
    0x40 | ((w as u8) << 3) | ((r as u8) << 2) | ((x as u8) << 1) | b as u8
}

fn needs_rex_prefix(w: bool, r: bool, x: bool, b: bool) -> bool {
    w || r || x || b
}

fn push_rex_prefix(bytes: &mut Vec<u8>, w: bool, r: bool, x: bool, b: bool) {
    if needs_rex_prefix(w, r, x, b) {
        bytes.push(rex_byte(w, r, x, b));
    }
}

fn displacement_encoding(displacement: i32, base_low: u8) -> (u8, Vec<u8>) {
    if displacement == 0 && base_low != 0b101 {
        (0b00, Vec::new())
    } else if displacement >= i8::MIN as i32 && displacement <= i8::MAX as i32 {
        (0b01, vec![displacement as i8 as u8])
    } else {
        (0b10, displacement.to_le_bytes().to_vec())
    }
}

fn low_register_for_width(code: u8, width_bits: u8, architecture: Architecture) -> Register {
    if width_bits == 64 && architecture == Architecture::X86_64 {
        low_register(code, Architecture::X86_64)
    } else if architecture == Architecture::X86_64 {
        low_register32(code)
    } else {
        low_register(code, Architecture::X86)
    }
}

fn low_register(code: u8, architecture: Architecture) -> Register {
    match (architecture, code) {
        (Architecture::X86_64, 0) => Register::Rax,
        (Architecture::X86_64, 1) => Register::Rcx,
        (Architecture::X86_64, 2) => Register::Rdx,
        (Architecture::X86_64, 3) => Register::Rbx,
        (Architecture::X86_64, 4) => Register::Rsp,
        (Architecture::X86_64, 5) => Register::Rbp,
        (Architecture::X86_64, 6) => Register::Rsi,
        (Architecture::X86_64, 7) => Register::Rdi,
        (Architecture::X86_64, 8) => Register::R8,
        (Architecture::X86_64, 9) => Register::R9,
        (Architecture::X86_64, 10) => Register::R10,
        (Architecture::X86_64, 11) => Register::R11,
        (Architecture::X86_64, 12) => Register::R12,
        (Architecture::X86_64, 13) => Register::R13,
        (Architecture::X86_64, 14) => Register::R14,
        (Architecture::X86_64, 15) => Register::R15,
        (_, 0) => Register::Eax,
        (_, 1) => Register::Ecx,
        (_, 2) => Register::Edx,
        (_, 3) => Register::Ebx,
        (_, 4) => Register::Esp,
        (_, 5) => Register::Ebp,
        (_, 6) => Register::Esi,
        (_, 7) => Register::Edi,
        _ => Register::Eax,
    }
}

fn low_register32(code: u8) -> Register {
    match code {
        0 => Register::Eax,
        1 => Register::Ecx,
        2 => Register::Edx,
        3 => Register::Ebx,
        4 => Register::Esp,
        5 => Register::Ebp,
        6 => Register::Esi,
        7 => Register::Edi,
        8 => Register::R8d,
        9 => Register::R9d,
        10 => Register::R10d,
        11 => Register::R11d,
        12 => Register::R12d,
        13 => Register::R13d,
        14 => Register::R14d,
        15 => Register::R15d,
        _ => Register::Eax,
    }
}

fn low_byte_register(code: u8, architecture: Architecture, rex: RexPrefix) -> Option<Register> {
    match (architecture, code) {
        (_, 0) => Some(Register::Al),
        (_, 1) => Some(Register::Cl),
        (_, 2) => Some(Register::Dl),
        (_, 3) => Some(Register::Bl),
        (Architecture::X86_64, 4) if needs_rex_prefix(rex.w, rex.r, rex.x, rex.b) => {
            Some(Register::Spl)
        }
        (Architecture::X86_64, 5) if needs_rex_prefix(rex.w, rex.r, rex.x, rex.b) => {
            Some(Register::Bpl)
        }
        (Architecture::X86_64, 6) if needs_rex_prefix(rex.w, rex.r, rex.x, rex.b) => {
            Some(Register::Sil)
        }
        (Architecture::X86_64, 7) if needs_rex_prefix(rex.w, rex.r, rex.x, rex.b) => {
            Some(Register::Dil)
        }
        (Architecture::X86_64, 8) => Some(Register::R8b),
        (Architecture::X86_64, 9) => Some(Register::R9b),
        (Architecture::X86_64, 10) => Some(Register::R10b),
        (Architecture::X86_64, 11) => Some(Register::R11b),
        (Architecture::X86_64, 12) => Some(Register::R12b),
        (Architecture::X86_64, 13) => Some(Register::R13b),
        (Architecture::X86_64, 14) => Some(Register::R14b),
        (Architecture::X86_64, 15) => Some(Register::R15b),
        _ => None,
    }
}

fn needs_rex_for_low_byte(register: Register) -> bool {
    matches!(
        register,
        Register::Spl
            | Register::Bpl
            | Register::Sil
            | Register::Dil
            | Register::R8b
            | Register::R9b
            | Register::R10b
            | Register::R11b
            | Register::R12b
            | Register::R13b
            | Register::R14b
            | Register::R15b
    )
}

fn register_code(register: Register) -> Option<u8> {
    Some(match register {
        Register::Eax | Register::Rax | Register::Al => 0,
        Register::Ecx | Register::Rcx | Register::Cl => 1,
        Register::Edx | Register::Rdx | Register::Dl => 2,
        Register::Ebx | Register::Rbx | Register::Bl => 3,
        Register::Esp | Register::Rsp | Register::Spl => 4,
        Register::Ebp | Register::Rbp | Register::Bpl => 5,
        Register::Esi | Register::Rsi | Register::Sil => 6,
        Register::Edi | Register::Rdi | Register::Dil => 7,
        Register::R8d | Register::R8 | Register::R8b => 8,
        Register::R9d | Register::R9 | Register::R9b => 9,
        Register::R10d | Register::R10 | Register::R10b => 10,
        Register::R11d | Register::R11 | Register::R11b => 11,
        Register::R12d | Register::R12 | Register::R12b => 12,
        Register::R13d | Register::R13 | Register::R13b => 13,
        Register::R14d | Register::R14 | Register::R14b => 14,
        Register::R15d | Register::R15 | Register::R15b => 15,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        ControlFlowOperand, Flag, FlagEffect, MemoryOperand, ProcessorFlag, SimdBinaryKind,
        SimdMoveDirection, SimdMoveKind, StringRepeatPrefix, VectorOperand, VectorRegister,
    };
    use std::collections::BTreeMap;

    #[test]
    fn decodes_and_encodes_setcc_with_rex_low_byte_registers() {
        let instruction = decode_one(
            Architecture::X86_64,
            &[0x41, 0x0f, 0x95, 0xc0],
            0,
            0x401000,
            0x1000,
        )
        .expect("setcc should decode");

        assert_eq!(
            instruction.operation,
            Operation::SetRegisterCondition {
                condition: ConditionCode::NotEqual,
                dst: ControlFlowOperand::Register(Register::R8b),
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401000, &instruction.operation)
                .expect("setcc should encode"),
            vec![0x41, 0x0f, 0x95, 0xc0]
        );
    }

    #[test]
    fn decodes_and_encodes_cmov_shift_and_logic_ops() {
        let cmov = decode_one(
            Architecture::X86_64,
            &[0x48, 0x0f, 0x44, 0xc1],
            0,
            0x401000,
            0x1000,
        )
        .expect("cmov should decode");
        assert_eq!(
            cmov.operation,
            Operation::ConditionalMoveRegister {
                condition: ConditionCode::Equal,
                dst: Register::Rax,
                src: ControlFlowOperand::Register(Register::Rcx),
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401000, &cmov.operation)
                .expect("cmov should encode"),
            vec![0x48, 0x0f, 0x44, 0xc1]
        );

        let shift = decode_one(
            Architecture::X86_64,
            &[0x48, 0xc1, 0xe8, 0x03],
            0,
            0x401004,
            0x1004,
        )
        .expect("shift should decode");
        assert_eq!(
            shift.operation,
            Operation::ShiftRightLogicalRegisterImmediate {
                dst: ControlFlowOperand::Register(Register::Rax),
                amount: 3,
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401004, &shift.operation)
                .expect("shift should encode"),
            vec![0x48, 0xc1, 0xe8, 0x03]
        );

        let and = decode_one(
            Architecture::X86_64,
            &[0x83, 0xe0, 0xf0],
            0,
            0x401008,
            0x1008,
        )
        .expect("and should decode");
        assert_eq!(
            and.operation,
            Operation::AndRegisterImmediate {
                register: Register::Eax,
                value: -16,
                width_bits: 32,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401008, &and.operation)
                .expect("and should encode"),
            vec![0x83, 0xe0, 0xf0]
        );
    }

    #[test]
    fn models_flags_for_compare_carry_and_imul_ops() {
        let clear = Operation::ClearRegister {
            register: Register::Rax,
            width_bits: 64,
        };
        assert!(clear.flags_read().is_empty());
        assert_eq!(
            clear.flags_written(),
            vec![
                Flag::Carry,
                Flag::Parity,
                Flag::AuxiliaryCarry,
                Flag::Zero,
                Flag::Sign,
                Flag::Overflow,
            ]
        );
        let clear_effect = clear.dataflow_effect();
        assert!(clear_effect.flag_reads.is_empty());
        assert_eq!(
            clear_effect.flag_writes,
            BTreeSet::from([
                ProcessorFlag::Carry,
                ProcessorFlag::Parity,
                ProcessorFlag::AuxiliaryCarry,
                ProcessorFlag::Zero,
                ProcessorFlag::Sign,
                ProcessorFlag::Overflow,
            ])
        );

        let cmp = Operation::CompareRegisterRegister {
            left: Register::Rax,
            right: Register::Rcx,
            width_bits: 64,
        };
        assert!(cmp.flags_read().is_empty());
        assert_eq!(
            cmp.flags_written(),
            vec![
                Flag::Carry,
                Flag::Parity,
                Flag::AuxiliaryCarry,
                Flag::Zero,
                Flag::Sign,
                Flag::Overflow,
            ]
        );

        let adc = Operation::AddWithCarryOperandOperand {
            dst: ControlFlowOperand::Register(Register::Rax),
            src: ControlFlowOperand::Register(Register::Rcx),
            width_bits: 64,
        };
        assert_eq!(adc.flags_read(), vec![Flag::Carry]);
        assert_eq!(adc.flag_effects().carry, FlagEffect::ReadDefined);
        assert_eq!(adc.registers_read(), vec![Register::Rax, Register::Rcx]);
        assert_eq!(adc.registers_written(), vec![Register::Rax]);
        assert_eq!(
            adc.dataflow_effect().flag_reads,
            BTreeSet::from([ProcessorFlag::Carry])
        );

        let imul = Operation::SignedMultiplyRegisterImmediate {
            dst: Register::Rax,
            src: ControlFlowOperand::Register(Register::Rcx),
            value: 7,
            width_bits: 64,
        };
        let effects = imul.flag_effects();
        assert_eq!(effects.carry, FlagEffect::Defined);
        assert_eq!(effects.overflow, FlagEffect::Defined);
        assert_eq!(effects.auxiliary_carry, FlagEffect::Undefined);
        assert_eq!(effects.zero, FlagEffect::Undefined);
        assert!(imul.flags_read().is_empty());
    }

    #[test]
    fn models_implicit_register_reads_and_writes_for_shift_and_mul_div() {
        let shift = decode_one(
            Architecture::X86_64,
            &[0x48, 0xd3, 0xe0],
            0,
            0x401000,
            0x1000,
        )
        .expect("cl shift should decode");
        assert_eq!(
            shift.operation,
            Operation::ShiftLeftRegisterCl {
                dst: ControlFlowOperand::Register(Register::Rax),
                width_bits: 64,
            }
        );
        assert!(shift.operation.registers_read().contains(&Register::Cl));
        assert!(shift.operation.registers_written().contains(&Register::Rax));
        assert_eq!(shift.operation.flag_effects().carry, FlagEffect::Defined);
        assert!(shift
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("partial register")));

        let mul = Operation::UnsignedMultiply {
            src: ControlFlowOperand::Register(Register::Rbx),
            width_bits: 64,
        };
        assert_eq!(mul.registers_read(), vec![Register::Rax, Register::Rbx]);
        assert_eq!(mul.registers_written(), vec![Register::Rax, Register::Rdx]);

        let div = Operation::SignedDivide {
            src: ControlFlowOperand::Register(Register::Rbx),
            width_bits: 64,
        };
        assert_eq!(
            div.registers_read(),
            vec![Register::Rax, Register::Rdx, Register::Rbx]
        );
        assert_eq!(div.registers_written(), vec![Register::Rax, Register::Rdx]);
    }

    #[test]
    fn aliases_low_and_zero_extending_registers_through_family_roots() {
        assert_eq!(Register::Al.family_root(), Register::Rax);
        assert_eq!(Register::Cl.family_root(), Register::Rcx);
        assert_eq!(Register::Eax.family_root(), Register::Rax);
        assert_eq!(Register::R8d.family_root(), Register::R8);
        assert!(Register::Al.is_low_byte());
        assert!(Register::Cl.is_low_byte());
        assert!(Register::Eax.is_zero_extending_32bit());
        assert!(!Register::Rax.is_low_byte());

        let mut known_addresses = BTreeMap::from([(Register::Rax, 0x401000)]);
        update_known_addresses(
            &mut known_addresses,
            &Operation::SetRegisterImmediate {
                register: Register::Eax,
                value: 0x1234,
                width_bits: 32,
            },
        );
        assert!(known_addresses.is_empty());
    }

    #[test]
    fn decodes_and_encodes_indirect_control_and_modrm_base_memory() {
        let call = decode_one(
            Architecture::X86_64,
            &[0x41, 0xff, 0xd0],
            0,
            0x401000,
            0x1000,
        )
        .expect("indirect call should decode");
        assert_eq!(
            call.operation,
            Operation::IndirectCall {
                target: ControlFlowOperand::Register(Register::R8),
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401000, &call.operation)
                .expect("indirect call should encode"),
            vec![0x41, 0xff, 0xd0]
        );

        let jmp = decode_one(
            Architecture::X86_64,
            &[0xff, 0x25, 0x08, 0x00, 0x00, 0x00],
            0,
            0x401000,
            0x1000,
        )
        .expect("rip-relative jmp should decode");
        assert_eq!(
            jmp.operation,
            Operation::IndirectJump {
                target: ControlFlowOperand::Memory(MemoryOperand::RipRelative {
                    target: 0x40100e,
                    width_bits: 64,
                }),
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401000, &jmp.operation)
                .expect("rip-relative jmp should encode"),
            vec![0xff, 0x25, 0x08, 0x00, 0x00, 0x00]
        );

        let load = decode_one(
            Architecture::X86_64,
            &[0x48, 0x8b, 0x18],
            0,
            0x401010,
            0x1010,
        )
        .expect("base memory load should decode");
        assert_eq!(
            load.operation,
            Operation::LoadRegisterMemory {
                dst: Register::Rbx,
                address: MemoryOperand::BaseDisplacement {
                    base: Register::Rax,
                    displacement: 0,
                    width_bits: 64,
                },
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401010, &load.operation)
                .expect("base memory load should encode"),
            vec![0x48, 0x8b, 0x18]
        );
    }

    #[test]
    fn decodes_and_encodes_stack_immediates_and_memory_forms() {
        let push_imm = decode_one(Architecture::X86_64, &[0x6a, 0xfe], 0, 0x401000, 0x1000)
            .expect("push immediate should decode");
        assert_eq!(
            push_imm.operation,
            Operation::PushImmediate {
                value: -2,
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401000, &push_imm.operation)
                .expect("push immediate should encode"),
            vec![0x6a, 0xfe]
        );

        let push_mem = decode_one(
            Architecture::X86_64,
            &[0x48, 0xff, 0x30],
            0,
            0x401100,
            0x1100,
        )
        .expect("push memory should decode");
        assert_eq!(
            push_mem.operation,
            Operation::PushMemory {
                address: MemoryOperand::BaseDisplacement {
                    base: Register::Rax,
                    displacement: 0,
                    width_bits: 64,
                },
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401100, &push_mem.operation)
                .expect("push memory should encode"),
            vec![0x48, 0xff, 0x30]
        );

        let pop_mem = decode_one(
            Architecture::X86_64,
            &[0x48, 0x8f, 0x00],
            0,
            0x401200,
            0x1200,
        )
        .expect("pop memory should decode");
        assert_eq!(
            pop_mem.operation,
            Operation::PopMemory {
                address: MemoryOperand::BaseDisplacement {
                    base: Register::Rax,
                    displacement: 0,
                    width_bits: 64,
                },
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401200, &pop_mem.operation)
                .expect("pop memory should encode"),
            vec![0x48, 0x8f, 0x00]
        );
    }

    #[test]
    fn decodes_and_encodes_extend_xchg_and_unary_ops() {
        let movsx = decode_one(
            Architecture::X86_64,
            &[0x48, 0x0f, 0xbe, 0xc1],
            0,
            0x401300,
            0x1300,
        )
        .expect("movsx should decode");
        assert_eq!(
            movsx.operation,
            Operation::SignExtendRegister {
                dst: Register::Rax,
                src: ControlFlowOperand::Register(Register::Cl),
                source_width_bits: 8,
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401300, &movsx.operation)
                .expect("movsx should encode"),
            vec![0x48, 0x0f, 0xbe, 0xc1]
        );

        let movzx = decode_one(
            Architecture::X86_64,
            &[0x48, 0x0f, 0xb6, 0xc1],
            0,
            0x401304,
            0x1304,
        )
        .expect("movzx should decode");
        assert_eq!(
            movzx.operation,
            Operation::ZeroExtendRegister {
                dst: Register::Rax,
                src: ControlFlowOperand::Register(Register::Cl),
                source_width_bits: 8,
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401304, &movzx.operation)
                .expect("movzx should encode"),
            vec![0x48, 0x0f, 0xb6, 0xc1]
        );

        let xchg = decode_one(
            Architecture::X86_64,
            &[0x48, 0x87, 0xc8],
            0,
            0x401308,
            0x1308,
        )
        .expect("xchg should decode");
        assert_eq!(
            xchg.operation,
            Operation::ExchangeRegisterOperand {
                register: Register::Rcx,
                operand: ControlFlowOperand::Register(Register::Rax),
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401308, &xchg.operation)
                .expect("xchg should encode"),
            vec![0x48, 0x87, 0xc8]
        );

        let not = decode_one(
            Architecture::X86_64,
            &[0x48, 0xf7, 0xd0],
            0,
            0x40130b,
            0x130b,
        )
        .expect("not should decode");
        assert_eq!(
            not.operation,
            Operation::NotOperand {
                dst: ControlFlowOperand::Register(Register::Rax),
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x40130b, &not.operation)
                .expect("not should encode"),
            vec![0x48, 0xf7, 0xd0]
        );

        let neg = decode_one(
            Architecture::X86_64,
            &[0x48, 0xf7, 0xd8],
            0,
            0x40130e,
            0x130e,
        )
        .expect("neg should decode");
        assert_eq!(
            neg.operation,
            Operation::NegOperand {
                dst: ControlFlowOperand::Register(Register::Rax),
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x40130e, &neg.operation)
                .expect("neg should encode"),
            vec![0x48, 0xf7, 0xd8]
        );
    }

    #[test]
    fn decodes_and_encodes_rep_string_ops_with_conservative_effects() {
        let movs = decode_one(
            Architecture::X86_64,
            &[0xf3, 0x48, 0xa5],
            0,
            0x401400,
            0x1400,
        )
        .expect("rep movs should decode");
        assert_eq!(
            movs.operation,
            Operation::MoveString {
                prefix: Some(StringRepeatPrefix::Repe),
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401400, &movs.operation)
                .expect("rep movs should encode"),
            vec![0xf3, 0x48, 0xa5]
        );

        let cmps = decode_one(
            Architecture::X86_64,
            &[0xf2, 0x48, 0xa7],
            0,
            0x401403,
            0x1403,
        )
        .expect("rep cmps should decode");
        assert_eq!(
            cmps.operation,
            Operation::CompareString {
                prefix: Some(StringRepeatPrefix::Repne),
                width_bits: 64,
            }
        );
        assert!(cmps
            .operation
            .dataflow_effect()
            .flag_reads
            .contains(&ProcessorFlag::Zero));
        assert!(cmps
            .operation
            .dataflow_effect()
            .flag_reads
            .contains(&ProcessorFlag::Direction));
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401403, &cmps.operation)
                .expect("rep cmps should encode"),
            vec![0xf2, 0x48, 0xa7]
        );
    }

    #[test]
    fn decodes_and_encodes_conservative_simd_and_fpu_ops() {
        let movaps = decode_one(
            Architecture::X86_64,
            &[0x0f, 0x28, 0xc1],
            0,
            0x401000,
            0x1000,
        )
        .expect("movaps should decode");
        assert_eq!(
            movaps.operation,
            Operation::SimdMove {
                kind: SimdMoveKind::Movaps,
                direction: SimdMoveDirection::Load,
                dst: VectorRegister::Xmm0,
                src: VectorOperand::Register(VectorRegister::Xmm1),
                width_bits: 128,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401000, &movaps.operation)
                .expect("movaps should encode"),
            vec![0x0f, 0x28, 0xc1]
        );

        let movaps_store = decode_one(
            Architecture::X86_64,
            &[0x0f, 0x29, 0xc1],
            0,
            0x401002,
            0x1002,
        )
        .expect("movaps store should decode");
        assert_eq!(
            movaps_store.operation,
            Operation::SimdMove {
                kind: SimdMoveKind::Movaps,
                direction: SimdMoveDirection::Store,
                dst: VectorRegister::Xmm1,
                src: VectorOperand::Register(VectorRegister::Xmm0),
                width_bits: 128,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401002, &movaps_store.operation)
                .expect("movaps store should encode"),
            vec![0x0f, 0x29, 0xc1]
        );

        let movdqa = decode_one(
            Architecture::X86_64,
            &[0x66, 0x0f, 0x6f, 0xc1],
            0,
            0x401004,
            0x1004,
        )
        .expect("movdqa should decode");
        assert_eq!(
            movdqa.operation,
            Operation::SimdMove {
                kind: SimdMoveKind::Movdqa,
                direction: SimdMoveDirection::Load,
                dst: VectorRegister::Xmm0,
                src: VectorOperand::Register(VectorRegister::Xmm1),
                width_bits: 128,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401004, &movdqa.operation)
                .expect("movdqa should encode"),
            vec![0x66, 0x0f, 0x6f, 0xc1]
        );

        let pxor = decode_one(
            Architecture::X86_64,
            &[0x66, 0x0f, 0xef, 0xc1],
            0,
            0x401008,
            0x1008,
        )
        .expect("pxor should decode");
        assert_eq!(
            pxor.operation,
            Operation::SimdBinary {
                kind: SimdBinaryKind::Pxor,
                dst: VectorRegister::Xmm0,
                src: VectorOperand::Register(VectorRegister::Xmm1),
                width_bits: 128,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401008, &pxor.operation)
                .expect("pxor should encode"),
            vec![0x66, 0x0f, 0xef, 0xc1]
        );

        let addsd = decode_one(
            Architecture::X86_64,
            &[0xf2, 0x0f, 0x58, 0xc1],
            0,
            0x40100c,
            0x100c,
        )
        .expect("addsd should decode");
        assert_eq!(
            addsd.operation,
            Operation::SimdBinary {
                kind: SimdBinaryKind::Addsd,
                dst: VectorRegister::Xmm0,
                src: VectorOperand::Register(VectorRegister::Xmm1),
                width_bits: 64,
            }
        );
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x40100c, &addsd.operation)
                .expect("addsd should encode"),
            vec![0xf2, 0x0f, 0x58, 0xc1]
        );

        let fnop = decode_one(Architecture::X86_64, &[0xd9, 0xd0], 0, 0x401010, 0x1010)
            .expect("fnop should decode");
        assert_eq!(fnop.operation, Operation::FpuNoop);
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401010, &fnop.operation)
                .expect("fnop should encode"),
            vec![0xd9, 0xd0]
        );

        let finit = decode_one(
            Architecture::X86_64,
            &[0x9b, 0xdb, 0xe3],
            0,
            0x401012,
            0x1012,
        )
        .expect("finit should decode");
        assert_eq!(finit.operation, Operation::FpuInitialize { wait: true });
        assert_eq!(
            encode_operation(Architecture::X86_64, 0x401012, &finit.operation)
                .expect("finit should encode"),
            vec![0x9b, 0xdb, 0xe3]
        );
    }
}
