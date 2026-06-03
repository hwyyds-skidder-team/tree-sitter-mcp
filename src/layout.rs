use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::ops::Range;

use crate::arch;
use crate::diagnostic::{BinaryPatchError, Diagnostic, DiagnosticSeverity, Result};
use crate::ir::{BasicBlock, ControlFlowOperand, MemoryOperand, Module, Operation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockPlacement {
    pub original_address: u64,
    pub new_address: u64,
    pub encoded_len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedRange {
    pub range: Range<u64>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutableIsland {
    pub range: Range<u64>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlacementConstraint {
    FixedAddress {
        block_address: u64,
        address: u64,
        label: String,
    },
    AddressWindow {
        block_address: u64,
        range: Range<u64>,
        label: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LayoutMetadata {
    protected_ranges: Vec<ProtectedRange>,
    executable_islands: Vec<ExecutableIsland>,
    placement_constraints: Vec<PlacementConstraint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutPlan {
    placements: Vec<BlockPlacement>,
    metadata: LayoutMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutDiagnostics {
    diagnostics: Vec<Diagnostic>,
    block_count: usize,
    relocated_block_count: usize,
    protected_range_count: usize,
    executable_island_count: usize,
    placement_constraint_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedBlock {
    pub original_address: u64,
    pub new_address: u64,
    pub bytes: Vec<u8>,
}

impl LayoutPlan {
    pub fn preserve(module: &Module) -> Self {
        Self::preserve_with_metadata(module, LayoutMetadata::default())
    }

    pub fn preserve_with_metadata(module: &Module, metadata: LayoutMetadata) -> Self {
        let placements = module
            .functions
            .iter()
            .flat_map(|function| function.blocks.iter())
            .map(|block| BlockPlacement {
                original_address: block.address,
                new_address: block.address,
                encoded_len: block.encoded_len(),
            })
            .collect();
        Self {
            placements,
            metadata,
        }
    }

    pub fn relocate_contiguous(module: &Module, base_address: u64) -> Result<Self> {
        Self::relocate_contiguous_with_metadata(module, base_address, LayoutMetadata::default())
    }

    pub fn relocate_contiguous_with_metadata(
        module: &Module,
        base_address: u64,
        metadata: LayoutMetadata,
    ) -> Result<Self> {
        let blocks = module_blocks(module);
        let mut lengths: Vec<usize> = blocks.iter().map(|block| block.encoded_len()).collect();

        for _ in 0..8 {
            let placements =
                contiguous_placements_with_metadata(&blocks, &lengths, base_address, &metadata)?;
            let address_map = address_map(&placements);
            let mut changed = false;
            let mut next_lengths = Vec::with_capacity(blocks.len());

            for (block, placement) in blocks.iter().zip(&placements) {
                let bytes = encode_block_at(module, block, placement.new_address, &address_map)?;
                changed |= bytes.len() != placement.encoded_len;
                next_lengths.push(bytes.len());
            }

            if !changed {
                return Ok(Self {
                    placements,
                    metadata,
                });
            }
            lengths = next_lengths;
        }

        Err(BinaryPatchError::Emit(
            "relocated block layout did not converge".to_string(),
        ))
    }

    pub fn placements(&self) -> &[BlockPlacement] {
        &self.placements
    }

    pub fn metadata(&self) -> &LayoutMetadata {
        &self.metadata
    }

    pub fn new_address_for(&self, original_address: u64) -> Option<u64> {
        self.placements
            .iter()
            .find(|placement| placement.original_address == original_address)
            .map(|placement| placement.new_address)
    }

    pub fn verify(&self, module: &Module) -> LayoutDiagnostics {
        self.verify_with_metadata(module, &self.metadata)
    }

    pub fn verify_with_metadata(
        &self,
        module: &Module,
        metadata: &LayoutMetadata,
    ) -> LayoutDiagnostics {
        let blocks = module_blocks(module);
        let mut diagnostics = Vec::new();
        let mut expected_blocks = BTreeMap::new();
        let mut block_offsets = BTreeMap::new();
        let mut relocated_block_count = 0;
        let mut ranges = Vec::new();
        let mut seen_original = BTreeSet::new();

        for block in &blocks {
            expected_blocks.insert(block.address, block.file_offset);
            block_offsets.insert(block.address, block.file_offset);
        }

        validate_metadata(metadata, &mut diagnostics);

        let mut constraint_windows = BTreeMap::new();
        for constraint in &metadata.placement_constraints {
            let block_address = constraint.block_address();
            let Some(file_offset) = block_offsets.get(&block_address).copied() else {
                diagnostics.push(Diagnostic::error(
                    format!("layout constraint targets unknown block {block_address:#x}"),
                    None,
                ));
                continue;
            };

            let entry = constraint_windows
                .entry(block_address)
                .or_insert_with(BlockConstraintWindow::default);
            if let Err(message) = entry.apply(constraint) {
                diagnostics.push(Diagnostic::error(message, Some(file_offset)));
            }
        }

        for placement in &self.placements {
            if !seen_original.insert(placement.original_address) {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "layout contains duplicate placement for block {:#x}",
                        placement.original_address
                    ),
                    expected_blocks.get(&placement.original_address).copied(),
                ));
            }

            let Some(file_offset) = expected_blocks.remove(&placement.original_address) else {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "layout contains placement for unknown block {:#x}",
                        placement.original_address
                    ),
                    None,
                ));
                continue;
            };

            if placement.new_address != placement.original_address {
                relocated_block_count += 1;
            }
            if placement.encoded_len == 0 {
                diagnostics.push(Diagnostic::warning(
                    format!(
                        "layout reserves zero bytes for block {:#x}",
                        placement.original_address
                    ),
                    Some(file_offset),
                ));
            }

            if let Some(window) = constraint_windows.get(&placement.original_address) {
                let placement_end = placement
                    .new_address
                    .saturating_add(placement.encoded_len as u64);
                if let Some(expected_address) = window.fixed_address {
                    if placement.new_address != expected_address {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "layout places block {:#x} at {:#x} but the plan requires {:#x}",
                                placement.original_address, placement.new_address, expected_address
                            ),
                            Some(file_offset),
                        ));
                    }
                }
                if let Some(range) = &window.range {
                    if !range_contains_range(range, placement.new_address, placement_end) {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "layout places block {:#x} at {:#x}..{:#x} outside the required window {:#x}..{:#x}",
                                placement.original_address,
                                placement.new_address,
                                placement_end,
                                range.start,
                                range.end
                            ),
                            Some(file_offset),
                        ));
                    }
                }
            }

            ranges.push((
                placement.new_address,
                placement
                    .new_address
                    .saturating_add(placement.encoded_len as u64),
                file_offset,
            ));
        }

        for (address, file_offset) in expected_blocks {
            diagnostics.push(Diagnostic::error(
                format!("layout is missing block placement for {address:#x}"),
                Some(file_offset),
            ));
        }

        if self.new_address_for(module.entry).is_none() {
            diagnostics.push(Diagnostic::error(
                format!(
                    "layout has no placement for module entry {:#x}",
                    module.entry
                ),
                None,
            ));
        }

        let protected_ranges = normalized_protected_ranges(&metadata.protected_ranges);
        let executable_islands = normalized_executable_islands(&metadata.executable_islands);

        ranges.sort_unstable_by_key(|(start, _, _)| *start);
        for window in ranges.windows(2) {
            if window[0].1 > window[1].0 {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "layout placements overlap at {:#x}..{:#x} and {:#x}..{:#x}",
                        window[0].0, window[0].1, window[1].0, window[1].1
                    ),
                    Some(window[1].2),
                ));
            }
        }

        for placement in &self.placements {
            let end = placement
                .new_address
                .saturating_add(placement.encoded_len as u64);

            if let Some(conflict) =
                first_range_overlap(placement.new_address, end, &protected_ranges)
            {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "layout places block {:#x} at {:#x}..{:#x} over protected range {} at {:#x}..{:#x}",
                        placement.original_address,
                        placement.new_address,
                        end,
                        conflict.label,
                        conflict.range.start,
                        conflict.range.end
                    ),
                    None,
                ));
            }

            if !executable_islands.is_empty()
                && !executable_islands
                    .iter()
                    .any(|island| range_contains_range(&island.range, placement.new_address, end))
            {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "layout places block {:#x} at {:#x}..{:#x} outside executable islands",
                        placement.original_address, placement.new_address, end
                    ),
                    None,
                ));
            }
        }

        LayoutDiagnostics::new(
            diagnostics,
            blocks.len(),
            relocated_block_count,
            metadata.protected_ranges.len(),
            metadata.executable_islands.len(),
            metadata.placement_constraints.len(),
        )
    }
}

impl LayoutMetadata {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn protected_ranges(&self) -> &[ProtectedRange] {
        &self.protected_ranges
    }

    pub fn executable_islands(&self) -> &[ExecutableIsland] {
        &self.executable_islands
    }

    pub fn placement_constraints(&self) -> &[PlacementConstraint] {
        &self.placement_constraints
    }

    pub fn is_empty(&self) -> bool {
        self.protected_ranges.is_empty()
            && self.executable_islands.is_empty()
            && self.placement_constraints.is_empty()
    }

    pub fn push_protected_range(
        &mut self,
        range: Range<u64>,
        label: impl Into<String>,
    ) -> &mut Self {
        self.protected_ranges.push(ProtectedRange {
            range,
            label: label.into(),
        });
        self
    }

    pub fn with_protected_range(mut self, range: Range<u64>, label: impl Into<String>) -> Self {
        self.push_protected_range(range, label);
        self
    }

    pub fn push_executable_island(
        &mut self,
        range: Range<u64>,
        label: impl Into<String>,
    ) -> &mut Self {
        self.executable_islands.push(ExecutableIsland {
            range,
            label: label.into(),
        });
        self
    }

    pub fn with_executable_island(mut self, range: Range<u64>, label: impl Into<String>) -> Self {
        self.push_executable_island(range, label);
        self
    }

    pub fn push_placement_constraint(&mut self, constraint: PlacementConstraint) -> &mut Self {
        self.placement_constraints.push(constraint);
        self
    }

    pub fn with_placement_constraint(mut self, constraint: PlacementConstraint) -> Self {
        self.push_placement_constraint(constraint);
        self
    }
}

impl PlacementConstraint {
    pub fn fixed_address(block_address: u64, address: u64, label: impl Into<String>) -> Self {
        Self::FixedAddress {
            block_address,
            address,
            label: label.into(),
        }
    }

    pub fn address_window(block_address: u64, range: Range<u64>, label: impl Into<String>) -> Self {
        Self::AddressWindow {
            block_address,
            range,
            label: label.into(),
        }
    }

    fn block_address(&self) -> u64 {
        match self {
            Self::FixedAddress { block_address, .. }
            | Self::AddressWindow { block_address, .. } => *block_address,
        }
    }
}

impl LayoutDiagnostics {
    pub(crate) fn new(
        diagnostics: Vec<Diagnostic>,
        block_count: usize,
        relocated_block_count: usize,
        protected_range_count: usize,
        executable_island_count: usize,
        placement_constraint_count: usize,
    ) -> Self {
        Self {
            diagnostics,
            block_count,
            relocated_block_count,
            protected_range_count,
            executable_island_count,
            placement_constraint_count,
        }
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn block_count(&self) -> usize {
        self.block_count
    }

    pub fn relocated_block_count(&self) -> usize {
        self.relocated_block_count
    }

    pub fn protected_range_count(&self) -> usize {
        self.protected_range_count
    }

    pub fn executable_island_count(&self) -> usize {
        self.executable_island_count
    }

    pub fn placement_constraint_count(&self) -> usize {
        self.placement_constraint_count
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}

#[derive(Debug, Clone)]
pub struct LayoutAllocator {
    base_address: u64,
    cursor: u64,
    metadata: LayoutMetadata,
}

impl LayoutAllocator {
    pub fn new(base_address: u64) -> Self {
        Self::with_metadata(base_address, LayoutMetadata::default())
    }

    pub fn with_metadata(base_address: u64, metadata: LayoutMetadata) -> Self {
        Self {
            base_address,
            cursor: base_address,
            metadata,
        }
    }

    pub fn base_address(&self) -> u64 {
        self.base_address
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn metadata(&self) -> &LayoutMetadata {
        &self.metadata
    }

    pub fn metadata_mut(&mut self) -> &mut LayoutMetadata {
        &mut self.metadata
    }

    pub fn into_metadata(self) -> LayoutMetadata {
        self.metadata
    }

    pub fn allocate_block(
        &mut self,
        block_address: u64,
        encoded_len: usize,
    ) -> Result<BlockPlacement> {
        let metadata = self.metadata.clone();
        let protected_ranges = normalized_protected_ranges(&metadata.protected_ranges);
        let executable_islands = normalized_executable_islands(&metadata.executable_islands);
        self.allocate_block_with_constraints(
            block_address,
            encoded_len,
            &metadata,
            &protected_ranges,
            &executable_islands,
        )
    }

    pub fn allocate_blocks(
        &mut self,
        blocks: &[&BasicBlock],
        lengths: &[usize],
    ) -> Result<Vec<BlockPlacement>> {
        if blocks.len() != lengths.len() {
            return Err(BinaryPatchError::Emit(
                "block and length counts differ".to_string(),
            ));
        }

        let metadata = self.metadata.clone();
        let protected_ranges = normalized_protected_ranges(&metadata.protected_ranges);
        let executable_islands = normalized_executable_islands(&metadata.executable_islands);
        let mut placements = Vec::with_capacity(blocks.len());

        for (block, length) in blocks.iter().zip(lengths) {
            let placement = self.allocate_block_with_constraints(
                block.address,
                *length,
                &metadata,
                &protected_ranges,
                &executable_islands,
            )?;
            placements.push(placement);
        }

        Ok(placements)
    }

    fn allocate_block_with_constraints(
        &mut self,
        block_address: u64,
        encoded_len: usize,
        metadata: &LayoutMetadata,
        protected_ranges: &[&ProtectedRange],
        executable_islands: &[&ExecutableIsland],
    ) -> Result<BlockPlacement> {
        let window = placement_window_for(block_address, metadata)?;
        let placement_address = choose_block_address(
            self.cursor,
            encoded_len as u64,
            window.as_ref(),
            protected_ranges,
            executable_islands,
        )?;

        let placement = BlockPlacement {
            original_address: block_address,
            new_address: placement_address,
            encoded_len,
        };
        self.cursor = placement_address.saturating_add(encoded_len as u64);
        Ok(placement)
    }
}

pub fn encode_blocks(module: &Module, layout: &LayoutPlan) -> Result<Vec<EncodedBlock>> {
    let blocks = module_blocks(module);
    let address_map = address_map(&layout.placements);
    let mut encoded = Vec::with_capacity(blocks.len());

    for block in blocks {
        let placement = layout
            .placements
            .iter()
            .find(|placement| placement.original_address == block.address)
            .ok_or_else(|| {
                BinaryPatchError::Emit(format!("missing placement for block {:#x}", block.address))
            })?;
        encoded.push(EncodedBlock {
            original_address: block.address,
            new_address: placement.new_address,
            bytes: encode_block_at(module, block, placement.new_address, &address_map)?,
        });
    }

    Ok(encoded)
}

fn module_blocks(module: &Module) -> Vec<&BasicBlock> {
    module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
        .collect()
}

fn contiguous_placements_with_metadata(
    blocks: &[&BasicBlock],
    lengths: &[usize],
    base_address: u64,
    metadata: &LayoutMetadata,
) -> Result<Vec<BlockPlacement>> {
    let mut allocator = LayoutAllocator::with_metadata(base_address, metadata.clone());
    allocator.allocate_blocks(blocks, lengths)
}

fn address_map(placements: &[BlockPlacement]) -> BTreeMap<u64, u64> {
    placements
        .iter()
        .map(|placement| (placement.original_address, placement.new_address))
        .collect()
}

fn encode_block_at(
    module: &Module,
    block: &BasicBlock,
    new_address: u64,
    address_map: &BTreeMap<u64, u64>,
) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut cursor = new_address;
    for instruction in &block.instructions {
        let operation = translate_targets(&instruction.operation, address_map);
        let encoded = arch::encode_operation(module.architecture, cursor, &operation)?;
        cursor += encoded.len() as u64;
        bytes.extend_from_slice(&encoded);
    }
    Ok(bytes)
}

fn translate_targets(operation: &Operation, address_map: &BTreeMap<u64, u64>) -> Operation {
    match operation {
        Operation::DirectJump { target } => Operation::DirectJump {
            target: address_map.get(target).copied().unwrap_or(*target),
        },
        Operation::ConditionalJump { condition, target } => Operation::ConditionalJump {
            condition: *condition,
            target: address_map.get(target).copied().unwrap_or(*target),
        },
        Operation::DirectCall { target } => Operation::DirectCall {
            target: address_map.get(target).copied().unwrap_or(*target),
        },
        Operation::LoadEffectiveAddress {
            dst,
            address,
            width_bits,
        } => Operation::LoadEffectiveAddress {
            dst: *dst,
            address: translate_memory(address, address_map),
            width_bits: *width_bits,
        },
        Operation::LoadRegisterMemory {
            dst,
            address,
            width_bits,
        } => Operation::LoadRegisterMemory {
            dst: *dst,
            address: translate_memory(address, address_map),
            width_bits: *width_bits,
        },
        Operation::StoreMemoryRegister {
            address,
            src,
            width_bits,
        } => Operation::StoreMemoryRegister {
            address: translate_memory(address, address_map),
            src: *src,
            width_bits: *width_bits,
        },
        Operation::PushMemory {
            address,
            width_bits,
        } => Operation::PushMemory {
            address: translate_memory(address, address_map),
            width_bits: *width_bits,
        },
        Operation::PopMemory {
            address,
            width_bits,
        } => Operation::PopMemory {
            address: translate_memory(address, address_map),
            width_bits: *width_bits,
        },
        Operation::ExchangeRegisterOperand {
            register,
            operand,
            width_bits,
        } => Operation::ExchangeRegisterOperand {
            register: *register,
            operand: translate_control_flow_operand(operand, address_map),
            width_bits: *width_bits,
        },
        Operation::SignExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        } => Operation::SignExtendRegister {
            dst: *dst,
            src: translate_control_flow_operand(src, address_map),
            source_width_bits: *source_width_bits,
            width_bits: *width_bits,
        },
        Operation::ZeroExtendRegister {
            dst,
            src,
            source_width_bits,
            width_bits,
        } => Operation::ZeroExtendRegister {
            dst: *dst,
            src: translate_control_flow_operand(src, address_map),
            source_width_bits: *source_width_bits,
            width_bits: *width_bits,
        },
        Operation::NotOperand { dst, width_bits } => Operation::NotOperand {
            dst: translate_control_flow_operand(dst, address_map),
            width_bits: *width_bits,
        },
        Operation::NegOperand { dst, width_bits } => Operation::NegOperand {
            dst: translate_control_flow_operand(dst, address_map),
            width_bits: *width_bits,
        },
        other => other.clone(),
    }
}

fn translate_control_flow_operand(
    operand: &ControlFlowOperand,
    address_map: &BTreeMap<u64, u64>,
) -> ControlFlowOperand {
    match operand {
        ControlFlowOperand::Register(register) => ControlFlowOperand::Register(*register),
        ControlFlowOperand::Memory(memory) => {
            ControlFlowOperand::Memory(translate_memory(memory, address_map))
        }
    }
}

fn translate_memory(memory: &MemoryOperand, address_map: &BTreeMap<u64, u64>) -> MemoryOperand {
    match memory {
        MemoryOperand::RipRelative { target, width_bits } => MemoryOperand::RipRelative {
            target: address_map.get(target).copied().unwrap_or(*target),
            width_bits: *width_bits,
        },
        MemoryOperand::BaseDisplacement {
            base,
            displacement,
            width_bits,
        } => MemoryOperand::BaseDisplacement {
            base: *base,
            displacement: *displacement,
            width_bits: *width_bits,
        },
        MemoryOperand::BaseIndexScaleDisplacement {
            base,
            index,
            scale,
            displacement,
            width_bits,
        } => MemoryOperand::BaseIndexScaleDisplacement {
            base: *base,
            index: *index,
            scale: *scale,
            displacement: *displacement,
            width_bits: *width_bits,
        },
        MemoryOperand::SegmentDisplacement {
            segment,
            displacement,
            width_bits,
        } => MemoryOperand::SegmentDisplacement {
            segment: *segment,
            displacement: *displacement,
            width_bits: *width_bits,
        },
        MemoryOperand::Unsupported { description } => MemoryOperand::Unsupported {
            description: description.clone(),
        },
    }
}

#[derive(Debug, Clone, Default)]
struct BlockConstraintWindow {
    fixed_address: Option<u64>,
    range: Option<Range<u64>>,
}

impl BlockConstraintWindow {
    fn apply(&mut self, constraint: &PlacementConstraint) -> std::result::Result<(), String> {
        match constraint {
            PlacementConstraint::FixedAddress { address, label, .. } => {
                if let Some(existing) = self.fixed_address {
                    if existing != *address {
                        return Err(format!(
                            "conflicting fixed addresses for constraint {label}: {existing:#x} vs {address:#x}"
                        ));
                    }
                }
                self.fixed_address = Some(*address);
            }
            PlacementConstraint::AddressWindow { range, label, .. } => {
                if range.start >= range.end {
                    return Err(format!(
                        "placement constraint {label} has an empty or inverted range {:#x}..{:#x}",
                        range.start, range.end
                    ));
                }
                self.range = match self.range.take() {
                    Some(existing) => {
                        let start = existing.start.max(range.start);
                        let end = existing.end.min(range.end);
                        if start >= end {
                            return Err(format!(
                                "placement constraints do not intersect: {:#x}..{:#x} and {:#x}..{:#x}",
                                existing.start, existing.end, range.start, range.end
                            ));
                        }
                        Some(start..end)
                    }
                    None => Some(range.clone()),
                };
            }
        }
        Ok(())
    }
}

fn placement_window_for(
    block_address: u64,
    metadata: &LayoutMetadata,
) -> Result<Option<BlockConstraintWindow>> {
    let mut window = BlockConstraintWindow::default();
    let mut saw_constraint = false;

    for constraint in &metadata.placement_constraints {
        if constraint.block_address() != block_address {
            continue;
        }
        saw_constraint = true;
        window.apply(constraint).map_err(BinaryPatchError::Emit)?;
    }

    if let (Some(address), Some(range)) = (window.fixed_address, window.range.as_ref()) {
        if !range_contains_range(range, address, address.saturating_add(1)) {
            return Err(BinaryPatchError::Emit(format!(
                "fixed placement {address:#x} is outside the required window {:#x}..{:#x}",
                range.start, range.end
            )));
        }
    }

    if saw_constraint {
        Ok(Some(window))
    } else {
        Ok(None)
    }
}

fn choose_block_address(
    cursor: u64,
    len: u64,
    window: Option<&BlockConstraintWindow>,
    protected_ranges: &[&ProtectedRange],
    executable_islands: &[&ExecutableIsland],
) -> Result<u64> {
    if len == 0 {
        return Ok(cursor);
    }

    if let Some(window) = window {
        if let Some(address) = window.fixed_address {
            let end = address.checked_add(len).ok_or_else(|| {
                BinaryPatchError::Emit("placement exceeds address space".to_string())
            })?;
            if let Some(range) = &window.range {
                if !range_contains_range(range, address, end) {
                    return Err(BinaryPatchError::Emit(format!(
                        "fixed placement {address:#x}..{end:#x} falls outside the required window {:#x}..{:#x}",
                        range.start, range.end
                    )));
                }
            }
            if let Some(conflict) = first_range_overlap(address, end, protected_ranges) {
                return Err(BinaryPatchError::Emit(format!(
                    "fixed placement {address:#x}..{end:#x} overlaps protected range {} at {:#x}..{:#x}",
                    conflict.label, conflict.range.start, conflict.range.end
                )));
            }
            if !executable_islands.is_empty()
                && !executable_islands
                    .iter()
                    .any(|island| range_contains_range(&island.range, address, end))
            {
                return Err(BinaryPatchError::Emit(format!(
                    "fixed placement {address:#x}..{end:#x} does not fit in any executable island"
                )));
            }
            return Ok(address);
        }
    }

    let mut candidate = cursor;
    loop {
        if let Some(range) = window.and_then(|window| window.range.as_ref()) {
            if candidate < range.start {
                candidate = range.start;
            }
            if candidate >= range.end {
                return Err(BinaryPatchError::Emit(format!(
                    "placement cursor {candidate:#x} is outside the required window {:#x}..{:#x}",
                    range.start, range.end
                )));
            }
        }

        let Some((start, end_limit)) =
            align_cursor_to_island(candidate, len, executable_islands, window)
        else {
            return Err(BinaryPatchError::Emit(
                "no executable island can accommodate the relocated block".to_string(),
            ));
        };
        candidate = start;

        let end = candidate
            .checked_add(len)
            .ok_or_else(|| BinaryPatchError::Emit("placement exceeds address space".to_string()))?;
        if end > end_limit {
            candidate = end_limit;
            continue;
        }

        if let Some(conflict) = first_range_overlap(candidate, end, protected_ranges) {
            candidate = conflict.range.end;
            continue;
        }

        if let Some(range) = window.and_then(|window| window.range.as_ref()) {
            if !range_contains_range(range, candidate, end) {
                candidate = range.end;
                continue;
            }
        }

        return Ok(candidate);
    }
}

fn align_cursor_to_island(
    cursor: u64,
    len: u64,
    executable_islands: &[&ExecutableIsland],
    window: Option<&BlockConstraintWindow>,
) -> Option<(u64, u64)> {
    if executable_islands.is_empty() {
        let end = window
            .and_then(|window| window.range.as_ref())
            .map(|range| range.end)
            .unwrap_or(u64::MAX);
        return Some((cursor, end));
    }

    for island in executable_islands {
        let mut start = cursor.max(island.range.start);
        if let Some(range) = window.and_then(|window| window.range.as_ref()) {
            start = start.max(range.start);
        }
        let end_limit = match window.and_then(|window| window.range.as_ref()) {
            Some(range) => island.range.end.min(range.end),
            None => island.range.end,
        };
        if start > end_limit {
            continue;
        }
        if start.checked_add(len)? <= end_limit {
            return Some((start, end_limit));
        }
    }

    None
}

fn validate_metadata(metadata: &LayoutMetadata, diagnostics: &mut Vec<Diagnostic>) {
    for range in &metadata.protected_ranges {
        if range.range.start >= range.range.end {
            diagnostics.push(Diagnostic::error(
                format!(
                    "protected range {} is empty or inverted at {:#x}..{:#x}",
                    range.label, range.range.start, range.range.end
                ),
                None,
            ));
        }
    }
    for range in &metadata.executable_islands {
        if range.range.start >= range.range.end {
            diagnostics.push(Diagnostic::error(
                format!(
                    "executable island {} is empty or inverted at {:#x}..{:#x}",
                    range.label, range.range.start, range.range.end
                ),
                None,
            ));
        }
    }

    let protected_ranges = normalized_protected_ranges(&metadata.protected_ranges);
    for window in protected_ranges.windows(2) {
        if ranges_overlap(
            window[0].range.start,
            window[0].range.end,
            window[1].range.start,
            window[1].range.end,
        ) {
            diagnostics.push(Diagnostic::error(
                format!(
                    "protected ranges overlap at {:#x}..{:#x} and {:#x}..{:#x}",
                    window[0].range.start,
                    window[0].range.end,
                    window[1].range.start,
                    window[1].range.end
                ),
                None,
            ));
        }
    }

    let executable_islands = normalized_executable_islands(&metadata.executable_islands);
    for window in executable_islands.windows(2) {
        if ranges_overlap(
            window[0].range.start,
            window[0].range.end,
            window[1].range.start,
            window[1].range.end,
        ) {
            diagnostics.push(Diagnostic::error(
                format!(
                    "executable islands overlap at {:#x}..{:#x} and {:#x}..{:#x}",
                    window[0].range.start,
                    window[0].range.end,
                    window[1].range.start,
                    window[1].range.end
                ),
                None,
            ));
        }
    }
}

fn normalized_protected_ranges(ranges: &[ProtectedRange]) -> Vec<&ProtectedRange> {
    let mut ranges: Vec<&ProtectedRange> = ranges.iter().collect();
    ranges.sort_unstable_by_key(|range| (range.range.start, range.range.end));
    ranges
}

fn normalized_executable_islands(ranges: &[ExecutableIsland]) -> Vec<&ExecutableIsland> {
    let mut ranges: Vec<&ExecutableIsland> = ranges.iter().collect();
    ranges.sort_unstable_by_key(|range| (range.range.start, range.range.end));
    ranges
}

fn first_range_overlap<'a>(
    start: u64,
    end: u64,
    ranges: &'a [&ProtectedRange],
) -> Option<&'a ProtectedRange> {
    ranges
        .iter()
        .copied()
        .find(|range| ranges_overlap(start, end, range.range.start, range.range.end))
}

fn range_contains_range(outer: &Range<u64>, start: u64, end: u64) -> bool {
    outer.start <= start && end <= outer.end
}

fn ranges_overlap(a_start: u64, a_end: u64, b_start: u64, b_end: u64) -> bool {
    a_start < b_end && b_start < a_end
}
