use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crate::analysis::{
    BasicBlockDataflow, ConfidenceTier, ModuleAnalysis, ModuleDataflow, ResourceSet,
};
use crate::arch;
use crate::diagnostic::{BinaryPatchError, Diagnostic, DiagnosticSeverity, Result};
use crate::emit;
use crate::format::{function_symbol_lookup_error, Binary, BinaryFormat};
use crate::ir::{Instruction, Module, Operation};
use crate::layout::{LayoutDiagnostics, LayoutPlan};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewriteLayout {
    PreserveEntryBlock,
    RelocateContiguous { base_address: u64 },
    ExpandLastExecutableSegment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RewriteTransform {
    InsertBlockEntryOperation {
        block_address: u64,
        operation: Operation,
    },
    InsertBeforeInstructionOperation {
        block_address: u64,
        instruction_index: usize,
        operation: Operation,
    },
    ReplaceBlockEntryOperation {
        block_address: u64,
        operation: Operation,
    },
    CloneBlock {
        source_block_address: u64,
        clone_address: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewritePlan {
    transforms: Vec<RewriteTransform>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Debug)]
pub struct RewriteSession<'a> {
    binary: &'a Binary,
    module: Module,
    rewrite_plan: RewritePlan,
}

#[derive(Debug)]
pub struct PlannedRewrite<'a> {
    binary: &'a Binary,
    module: Module,
    rewrite_plan: RewritePlan,
    layout: RewriteLayout,
    layout_plan: Option<LayoutPlan>,
    verification: RewriteVerification,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewriteVerification {
    module_analysis: ModuleAnalysis,
    layout_diagnostics: Option<LayoutDiagnostics>,
    diagnostics: Vec<Diagnostic>,
}

impl RewritePlan {
    pub fn new() -> Self {
        Self {
            transforms: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn insert_entry_nop(module: &Module) -> Result<Self> {
        Self::insert_entry_operation(module, Operation::Nop)
    }

    pub fn insert_entry_operation(module: &Module, operation: Operation) -> Result<Self> {
        let block = module
            .entry_block()
            .ok_or_else(|| BinaryPatchError::Rewrite("module has no entry block".to_string()))?;

        let mut plan = Self::new();
        plan.insert_block_entry_operation(block.address, operation);
        Ok(plan)
    }

    pub fn replace_entry_operation(module: &Module, operation: Operation) -> Result<Self> {
        let block = module
            .entry_block()
            .ok_or_else(|| BinaryPatchError::Rewrite("module has no entry block".to_string()))?;
        if block.instructions.is_empty() {
            return Err(BinaryPatchError::Rewrite(
                "entry block has no instructions".to_string(),
            ));
        }

        let mut plan = Self::new();
        plan.replace_block_entry_operation(block.address, operation);
        Ok(plan)
    }

    pub fn insert_block_entry_operation(
        &mut self,
        block_address: u64,
        operation: Operation,
    ) -> &mut Self {
        self.transforms
            .push(RewriteTransform::InsertBlockEntryOperation {
                block_address,
                operation,
            });
        self
    }

    pub fn replace_block_entry_operation(
        &mut self,
        block_address: u64,
        operation: Operation,
    ) -> &mut Self {
        self.transforms
            .push(RewriteTransform::ReplaceBlockEntryOperation {
                block_address,
                operation,
            });
        self
    }

    pub fn clone_block(&mut self, source_block_address: u64, clone_address: u64) -> &mut Self {
        self.transforms.push(RewriteTransform::CloneBlock {
            source_block_address,
            clone_address,
        });
        self
    }

    pub fn insert_before_returns(module: &Module, operation: Operation) -> Result<Self> {
        Self::insert_before_instrumentation_sites(
            module,
            InstrumentationSiteKind::Return,
            None,
            operation,
        )
    }

    pub fn insert_before_return_block(
        module: &Module,
        block_address: u64,
        operation: Operation,
    ) -> Result<Self> {
        Self::insert_before_instrumentation_sites(
            module,
            InstrumentationSiteKind::Return,
            Some(InstrumentationSiteSelector::Block(block_address)),
            operation,
        )
    }

    pub fn insert_before_return_at(
        module: &Module,
        instruction_address: u64,
        operation: Operation,
    ) -> Result<Self> {
        Self::insert_before_instrumentation_sites(
            module,
            InstrumentationSiteKind::Return,
            Some(InstrumentationSiteSelector::Instruction(
                instruction_address,
            )),
            operation,
        )
    }

    pub fn insert_before_calls(module: &Module, operation: Operation) -> Result<Self> {
        Self::insert_before_instrumentation_sites(
            module,
            InstrumentationSiteKind::Call,
            None,
            operation,
        )
    }

    pub fn insert_before_call_block(
        module: &Module,
        block_address: u64,
        operation: Operation,
    ) -> Result<Self> {
        Self::insert_before_instrumentation_sites(
            module,
            InstrumentationSiteKind::Call,
            Some(InstrumentationSiteSelector::Block(block_address)),
            operation,
        )
    }

    pub fn insert_before_call_at(
        module: &Module,
        instruction_address: u64,
        operation: Operation,
    ) -> Result<Self> {
        Self::insert_before_instrumentation_sites(
            module,
            InstrumentationSiteKind::Call,
            Some(InstrumentationSiteSelector::Instruction(
                instruction_address,
            )),
            operation,
        )
    }

    fn insert_before_instrumentation_sites(
        module: &Module,
        kind: InstrumentationSiteKind,
        selector: Option<InstrumentationSiteSelector>,
        operation: Operation,
    ) -> Result<Self> {
        let analysis = ModuleAnalysis::from_module(module);
        let mut plan = Self::new();

        match selector {
            None => {
                let sites = collect_instrumentation_sites(module, kind);
                if sites.is_empty() {
                    plan.diagnostics.push(Diagnostic::error(
                        format!("module has no {} instructions to instrument", kind.label()),
                        None,
                    ));
                    return Ok(plan);
                }
                add_instrumentation_sites(&mut plan, module, &analysis, kind, sites, &operation);
            }
            Some(InstrumentationSiteSelector::Block(block_address)) => {
                let sites = collect_instrumentation_sites_in_block(module, kind, block_address);
                if sites.is_empty() {
                    let offset = find_block(module, block_address).map(|block| block.file_offset);
                    plan.diagnostics.push(Diagnostic::error(
                        format!(
                            "block {block_address:#x} has no {} instructions to instrument",
                            kind.label()
                        ),
                        offset,
                    ));
                    return Ok(plan);
                }
                add_instrumentation_sites(&mut plan, module, &analysis, kind, sites, &operation);
            }
            Some(InstrumentationSiteSelector::Instruction(instruction_address)) => {
                let Some(site) = find_instrumentation_site(module, kind, instruction_address)
                else {
                    let offset = find_instruction_block(module, instruction_address)
                        .map(|block| block.file_offset);
                    plan.diagnostics.push(Diagnostic::error(
                        format!(
                            "instruction {instruction_address:#x} is not a {} instrumentation site",
                            kind.label()
                        ),
                        offset,
                    ));
                    return Ok(plan);
                };
                add_instrumentation_sites(&mut plan, module, &analysis, kind, [site], &operation);
            }
        }

        Ok(plan)
    }

    pub fn apply(&self, module: &Module) -> Result<Module> {
        let mut rewritten = module.clone();
        let mut original_block_lengths = BTreeMap::new();
        let mut insertion_prefix_counts: BTreeMap<u64, Vec<usize>> = BTreeMap::new();
        let mut replace_cursors = BTreeMap::new();

        for block in module
            .functions
            .iter()
            .flat_map(|function| function.blocks.iter())
        {
            original_block_lengths.insert(block.address, block.instructions.len());
        }

        for transform in &self.transforms {
            match transform {
                RewriteTransform::InsertBlockEntryOperation {
                    block_address,
                    operation,
                } => {
                    let block =
                        find_block_mut(&mut rewritten, *block_address).ok_or_else(|| {
                            BinaryPatchError::Rewrite(format!(
                                "rewrite transform targets unknown block {block_address:#x}"
                            ))
                        })?;
                    let entry_cursor = insertion_prefix_counts
                        .entry(*block_address)
                        .or_insert_with(|| vec![0; block.instructions.len() + 1]);
                    insert_instruction_before(block, 0, operation.clone(), entry_cursor);
                }
                RewriteTransform::InsertBeforeInstructionOperation {
                    block_address,
                    instruction_index,
                    operation,
                } => {
                    let block =
                        find_block_mut(&mut rewritten, *block_address).ok_or_else(|| {
                            BinaryPatchError::Rewrite(format!(
                                "rewrite transform targets unknown block {block_address:#x}"
                            ))
                        })?;
                    let Some(original_length) = original_block_lengths.get(block_address) else {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform targets unknown block {block_address:#x}"
                        )));
                    };
                    if *instruction_index >= *original_length {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform targets instruction {instruction_index} beyond the end of block {block_address:#x}"
                        )));
                    }
                    let insertion_offsets = insertion_prefix_counts
                        .entry(*block_address)
                        .or_insert_with(|| vec![0; block.instructions.len() + 1]);
                    insert_instruction_before(
                        block,
                        *instruction_index,
                        operation.clone(),
                        insertion_offsets,
                    );
                }
                RewriteTransform::ReplaceBlockEntryOperation {
                    block_address,
                    operation,
                } => {
                    let block =
                        find_block_mut(&mut rewritten, *block_address).ok_or_else(|| {
                            BinaryPatchError::Rewrite(format!(
                                "rewrite transform targets unknown block {block_address:#x}"
                            ))
                        })?;
                    let replace_cursor = replace_cursors.entry(*block_address).or_insert(0);
                    let insertion_offsets = insertion_prefix_counts
                        .entry(*block_address)
                        .or_insert_with(|| vec![0; block.instructions.len() + 1]);
                    let Some(original_length) = original_block_lengths.get(block_address) else {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform targets unknown block {block_address:#x}"
                        )));
                    };
                    let current_index = *replace_cursor;
                    if current_index >= *original_length {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform replaces beyond the end of block {block_address:#x}"
                        )));
                    }
                    let insertion_count = insertion_offsets
                        .get(current_index)
                        .copied()
                        .unwrap_or_default();
                    let replacement_index = current_index + insertion_count;
                    if replacement_index >= block.instructions.len() {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform replaces beyond the end of block {block_address:#x}"
                        )));
                    }
                    let mut instruction = block.instructions[replacement_index].clone();
                    instruction.operation = operation.clone();
                    block.instructions[replacement_index] = instruction;
                    *replace_cursor += 1;
                }
                RewriteTransform::CloneBlock {
                    source_block_address,
                    clone_address,
                } => {
                    let Some((function_index, block_index, source_block)) =
                        find_block_location(&rewritten, *source_block_address)
                    else {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform targets unknown block {source_block_address:#x}"
                        )));
                    };
                    if find_block(&rewritten, *clone_address).is_some() {
                        return Err(BinaryPatchError::Rewrite(format!(
                            "rewrite transform clones to an existing block address {clone_address:#x}"
                        )));
                    }

                    let mut cloned_block = clone_basic_block(source_block, *clone_address);
                    cloned_block.id = next_block_id(&rewritten);
                    rewritten.functions[function_index]
                        .blocks
                        .insert(block_index + 1, cloned_block);
                }
            }
        }

        Ok(rewritten)
    }

    pub fn transforms(&self) -> &[RewriteTransform] {
        &self.transforms
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn verify(&self, module: &Module) -> Vec<Diagnostic> {
        let mut diagnostics = self.diagnostics.clone();
        let analysis = ModuleAnalysis::from_module(module);
        let dataflow = analysis.dataflow();
        let mut block_lengths = BTreeMap::new();
        let mut entry_cursors = BTreeMap::new();
        let mut seen_clone_addresses = BTreeSet::new();

        for block in module
            .functions
            .iter()
            .flat_map(|function| function.blocks.iter())
        {
            block_lengths.insert(block.address, block.instructions.len());
        }

        for transform in &self.transforms {
            match transform {
                RewriteTransform::InsertBlockEntryOperation {
                    block_address,
                    operation,
                } => {
                    let Some(length) = block_lengths.get_mut(block_address) else {
                        diagnostics.push(Diagnostic::error(
                            format!("rewrite transform targets unknown block {block_address:#x}"),
                            None,
                        ));
                        continue;
                    };
                    let entry_cursor = entry_cursors.entry(*block_address).or_insert(0);
                    if *entry_cursor > *length {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "rewrite transform inserts beyond the end of block {block_address:#x}"
                            ),
                            None,
                        ));
                        continue;
                    }
                    *entry_cursor += 1;
                    *length += 1;
                    if let Some(block) = dataflow.block_by_address(*block_address) {
                        diagnostics.extend(block.unsafe_insertion_diagnostics(operation));
                    }
                }
                RewriteTransform::InsertBeforeInstructionOperation {
                    block_address,
                    instruction_index,
                    operation,
                } => {
                    let Some(length) = block_lengths.get(block_address) else {
                        diagnostics.push(Diagnostic::error(
                            format!("rewrite transform targets unknown block {block_address:#x}"),
                            None,
                        ));
                        continue;
                    };
                    if *instruction_index >= *length {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "rewrite transform targets instruction {instruction_index} beyond the end of block {block_address:#x}"
                            ),
                            None,
                        ));
                        continue;
                    }
                    let Some(module_block) = find_block(module, *block_address) else {
                        diagnostics.push(Diagnostic::error(
                            format!("rewrite transform targets unknown block {block_address:#x}"),
                            None,
                        ));
                        continue;
                    };
                    let Some(_block) = dataflow.block_by_address(*block_address) else {
                        diagnostics.push(Diagnostic::error(
                            format!("rewrite transform targets unknown block {block_address:#x}"),
                            Some(module_block.file_offset),
                        ));
                        continue;
                    };
                    diagnostics.extend(insertion_site_diagnostics(
                        module,
                        dataflow,
                        "instrumented",
                        InstrumentationSite {
                            block_address: *block_address,
                            instruction_index: *instruction_index,
                            instruction_address: module_block
                                .instructions
                                .get(*instruction_index)
                                .map(|instruction| instruction.address)
                                .unwrap_or(*block_address),
                            file_offset: module_block.file_offset,
                        },
                        operation,
                    ));
                }
                RewriteTransform::ReplaceBlockEntryOperation {
                    block_address,
                    operation,
                } => {
                    let Some(length) = block_lengths.get_mut(block_address) else {
                        diagnostics.push(Diagnostic::error(
                            format!("rewrite transform targets unknown block {block_address:#x}"),
                            None,
                        ));
                        continue;
                    };
                    let entry_cursor = entry_cursors.entry(*block_address).or_insert(0);
                    if *entry_cursor >= *length {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "rewrite transform replaces beyond the end of block {block_address:#x}"
                            ),
                            None,
                        ));
                        continue;
                    }
                    *entry_cursor += 1;
                    if let Some(block) = dataflow.block_by_address(*block_address) {
                        diagnostics.extend(block.unsafe_insertion_diagnostics(operation));
                    }
                }
                RewriteTransform::CloneBlock {
                    source_block_address,
                    clone_address,
                } => {
                    if find_block(module, *source_block_address).is_none() {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "rewrite transform targets unknown block {source_block_address:#x}"
                            ),
                            None,
                        ));
                    }
                    if !seen_clone_addresses.insert(*clone_address)
                        || find_block(module, *clone_address).is_some()
                    {
                        diagnostics.push(Diagnostic::error(
                            format!(
                                "rewrite transform clones to an existing block address {clone_address:#x}"
                            ),
                            None,
                        ));
                    }
                }
            }
        }
        diagnostics.extend(rewrite_plan_cfg_confidence_diagnostics(
            analysis.control_flow_confidence_tier(),
            &self.transforms,
            module,
        ));
        diagnostics
    }
}

impl Default for RewritePlan {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> RewriteSession<'a> {
    /// Start a rewrite session rooted at the binary entry point.
    pub fn new(binary: &'a Binary) -> Result<Self> {
        Self::new_at(binary, binary.object().entry)
    }

    /// Start a rewrite session rooted at an arbitrary executable address.
    pub fn new_at(binary: &'a Binary, address: u64) -> Result<Self> {
        arch::ensure_supported(binary.object().architecture)?;
        Ok(Self {
            binary,
            module: binary.lift_at(address)?,
            rewrite_plan: RewritePlan::new(),
        })
    }

    /// Start a rewrite session scoped to one function-local CFG.
    ///
    /// Direct calls are kept as call operations but their targets are not lifted into
    /// this module. This is useful for instrumenting one selected function in large
    /// binaries without requiring every reachable callee to be re-encodable.
    pub fn new_function_at(binary: &'a Binary, address: u64) -> Result<Self> {
        arch::ensure_supported(binary.object().architecture)?;
        Ok(Self {
            binary,
            module: binary.lift_function_at(address)?,
            rewrite_plan: RewritePlan::new(),
        })
    }

    /// Start a rewrite session rooted at a named function symbol.
    pub fn new_symbol(binary: &'a Binary, name: &str) -> Result<Self> {
        let symbol = binary
            .object()
            .function_symbol_by_name(name)
            .ok_or_else(|| function_symbol_lookup_error(binary.object(), name))?;
        Self::new_at(binary, symbol.address)
    }

    /// Start a single-function rewrite session rooted at a named function symbol.
    pub fn new_function_symbol(binary: &'a Binary, name: &str) -> Result<Self> {
        let symbol = binary
            .object()
            .function_symbol_by_name(name)
            .ok_or_else(|| function_symbol_lookup_error(binary.object(), name))?;
        Self::new_function_at(binary, symbol.address)
    }

    pub fn binary(&self) -> &Binary {
        self.binary
    }

    pub fn module(&self) -> &Module {
        &self.module
    }

    pub fn rewrite_plan(&self) -> &RewritePlan {
        &self.rewrite_plan
    }

    pub fn rewrite_plan_mut(&mut self) -> &mut RewritePlan {
        &mut self.rewrite_plan
    }

    /// Apply queued transforms and return the rewritten semantic module.
    pub fn planned_module(&self) -> Result<Module> {
        self.rewrite_plan.apply(&self.module)
    }

    /// Analyze the queued rewrite as semantic IR.
    pub fn analyze(&self) -> Result<ModuleAnalysis> {
        Ok(ModuleAnalysis::from_module(&self.planned_module()?))
    }

    pub fn insert_entry_operation(&mut self, operation: Operation) -> Result<&mut Self> {
        let block = self
            .module
            .entry_block()
            .ok_or_else(|| BinaryPatchError::Rewrite("module has no entry block".to_string()))?;
        self.rewrite_plan
            .insert_block_entry_operation(block.address, operation);
        Ok(self)
    }

    pub fn replace_entry_operation(&mut self, operation: Operation) -> Result<&mut Self> {
        let block = self
            .module
            .entry_block()
            .ok_or_else(|| BinaryPatchError::Rewrite("module has no entry block".to_string()))?;
        if block.instructions.is_empty() {
            return Err(BinaryPatchError::Rewrite(
                "entry block has no instructions".to_string(),
            ));
        }
        self.rewrite_plan
            .replace_block_entry_operation(block.address, operation);
        Ok(self)
    }

    pub fn insert_entry_nop(&mut self) -> Result<&mut Self> {
        self.insert_entry_operation(Operation::Nop)
    }

    pub fn replace_entry_nop(&mut self) -> Result<&mut Self> {
        self.replace_entry_operation(Operation::Nop)
    }

    pub fn insert_block_entry_operation(
        &mut self,
        block_address: u64,
        operation: Operation,
    ) -> Result<&mut Self> {
        self.ensure_target_block_exists(block_address)?;
        self.rewrite_plan
            .insert_block_entry_operation(block_address, operation);
        Ok(self)
    }

    pub fn replace_block_entry_operation(
        &mut self,
        block_address: u64,
        operation: Operation,
    ) -> Result<&mut Self> {
        self.ensure_target_block_has_instructions(block_address)?;
        self.rewrite_plan
            .replace_block_entry_operation(block_address, operation);
        Ok(self)
    }

    pub fn insert_before_returns(&mut self, operation: Operation) -> Result<&mut Self> {
        let mut plan = RewritePlan::insert_before_returns(&self.module, operation)?;
        self.rewrite_plan.transforms.append(&mut plan.transforms);
        self.rewrite_plan.diagnostics.append(&mut plan.diagnostics);
        Ok(self)
    }

    pub fn insert_before_return_block(
        &mut self,
        block_address: u64,
        operation: Operation,
    ) -> Result<&mut Self> {
        let mut plan =
            RewritePlan::insert_before_return_block(&self.module, block_address, operation)?;
        self.rewrite_plan.transforms.append(&mut plan.transforms);
        self.rewrite_plan.diagnostics.append(&mut plan.diagnostics);
        Ok(self)
    }

    pub fn insert_before_return_at(
        &mut self,
        instruction_address: u64,
        operation: Operation,
    ) -> Result<&mut Self> {
        let mut plan =
            RewritePlan::insert_before_return_at(&self.module, instruction_address, operation)?;
        self.rewrite_plan.transforms.append(&mut plan.transforms);
        self.rewrite_plan.diagnostics.append(&mut plan.diagnostics);
        Ok(self)
    }

    pub fn insert_before_calls(&mut self, operation: Operation) -> Result<&mut Self> {
        let mut plan = RewritePlan::insert_before_calls(&self.module, operation)?;
        self.rewrite_plan.transforms.append(&mut plan.transforms);
        self.rewrite_plan.diagnostics.append(&mut plan.diagnostics);
        Ok(self)
    }

    pub fn insert_before_call_block(
        &mut self,
        block_address: u64,
        operation: Operation,
    ) -> Result<&mut Self> {
        let mut plan =
            RewritePlan::insert_before_call_block(&self.module, block_address, operation)?;
        self.rewrite_plan.transforms.append(&mut plan.transforms);
        self.rewrite_plan.diagnostics.append(&mut plan.diagnostics);
        Ok(self)
    }

    pub fn insert_before_call_at(
        &mut self,
        instruction_address: u64,
        operation: Operation,
    ) -> Result<&mut Self> {
        let mut plan =
            RewritePlan::insert_before_call_at(&self.module, instruction_address, operation)?;
        self.rewrite_plan.transforms.append(&mut plan.transforms);
        self.rewrite_plan.diagnostics.append(&mut plan.diagnostics);
        Ok(self)
    }

    /// Build the best available layout plan for the queued rewrite.
    pub fn planned_rewrite(&self) -> Result<PlannedRewrite<'a>> {
        let preserve = self.preserve_entry_block()?;
        if !preserve.verification().has_errors() {
            return Ok(preserve);
        }

        match self.expand_last_executable_segment() {
            Ok(expanded) if !expanded.verification().has_errors() => Ok(expanded),
            Ok(expanded) => Err(BinaryPatchError::Rewrite(format!(
                "rewrite plan is not valid for preserve or expansion layouts; preserve diagnostics: {}; expansion diagnostics: {}",
                diagnostics_message(preserve.verification().diagnostics()),
                diagnostics_message(expanded.verification().diagnostics()),
            ))),
            Err(error) => match error {
                BinaryPatchError::Unsupported(message) => {
                    Err(BinaryPatchError::Unsupported(format!(
                        "rewrite plan is not supported by the available layouts: preserve diagnostics: {}; expansion error: {message}",
                        diagnostics_message(preserve.verification().diagnostics()),
                    )))
                }
                other => Err(BinaryPatchError::Rewrite(format!(
                    "rewrite plan is not valid for preserve layout and expansion could not be built: preserve diagnostics: {}; expansion error: {other}",
                    diagnostics_message(preserve.verification().diagnostics()),
                ))),
            },
        }
    }

    /// Emit the rewrite using the best available layout plan.
    pub fn emit(&self) -> Result<Vec<u8>> {
        self.planned_rewrite()?.emit()
    }

    /// Build a planned rewrite that keeps the entry block in place.
    pub fn preserve_entry_block(&self) -> Result<PlannedRewrite<'a>> {
        self.build_planned_rewrite(RewriteLayout::PreserveEntryBlock, None)
    }

    /// Build a planned rewrite that relocates blocks contiguously from `base_address`.
    pub fn relocate_contiguous(&self, base_address: u64) -> Result<PlannedRewrite<'a>> {
        let module = self.planned_module()?;
        let layout = LayoutPlan::relocate_contiguous(&module, base_address)?;
        self.build_planned_rewrite(
            RewriteLayout::RelocateContiguous { base_address },
            Some(layout),
        )
    }

    /// Build a planned rewrite that extends the last executable segment.
    pub fn expand_last_executable_segment(&self) -> Result<PlannedRewrite<'a>> {
        let module = self.planned_module()?;
        let layout = expansion_layout(self.binary, &module)?;
        self.build_planned_rewrite(RewriteLayout::ExpandLastExecutableSegment, Some(layout))
    }

    fn build_planned_rewrite(
        &self,
        layout: RewriteLayout,
        layout_plan: Option<LayoutPlan>,
    ) -> Result<PlannedRewrite<'a>> {
        let module = self.planned_module()?;
        let verification = RewriteVerification::new(
            self.binary,
            &self.module,
            &module,
            &self.rewrite_plan,
            layout,
            layout_plan.as_ref(),
        )?;
        Ok(PlannedRewrite {
            binary: self.binary,
            module,
            rewrite_plan: self.rewrite_plan.clone(),
            layout,
            layout_plan,
            verification,
        })
    }

    fn ensure_target_block_exists(&self, block_address: u64) -> Result<()> {
        self.module
            .functions
            .iter()
            .flat_map(|function| function.blocks.iter())
            .find(|block| block.address == block_address)
            .ok_or_else(|| {
                BinaryPatchError::Rewrite(format!(
                    "rewrite transform targets unknown block {block_address:#x}"
                ))
            })?;
        Ok(())
    }

    fn ensure_target_block_has_instructions(&self, block_address: u64) -> Result<()> {
        let block = self
            .module
            .functions
            .iter()
            .flat_map(|function| function.blocks.iter())
            .find(|block| block.address == block_address)
            .ok_or_else(|| {
                BinaryPatchError::Rewrite(format!(
                    "rewrite transform targets unknown block {block_address:#x}"
                ))
            })?;
        if block.instructions.is_empty() {
            return Err(BinaryPatchError::Rewrite(format!(
                "block {block_address:#x} has no instructions"
            )));
        }
        Ok(())
    }
}

impl<'a> PlannedRewrite<'a> {
    /// Return the rewritten semantic module after applying queued transforms.
    pub fn module(&self) -> &Module {
        &self.module
    }

    pub fn rewrite_plan(&self) -> &RewritePlan {
        &self.rewrite_plan
    }

    /// Return the selected layout strategy.
    pub fn layout(&self) -> RewriteLayout {
        self.layout
    }

    /// Return the concrete layout plan when one is required.
    pub fn layout_plan(&self) -> Option<&LayoutPlan> {
        self.layout_plan.as_ref()
    }

    /// Return the combined verification state for the module, transforms, and layout.
    pub fn verification(&self) -> &RewriteVerification {
        &self.verification
    }

    /// Emit the planned rewrite.
    pub fn emit(&self) -> Result<Vec<u8>> {
        if self.verification.has_errors() {
            return Err(BinaryPatchError::Emit(format!(
                "rewrite plan failed validation: {}",
                diagnostics_message(self.verification.diagnostics())
            )));
        }
        match self.layout {
            RewriteLayout::PreserveEntryBlock => self.binary.emit(&self.rewrite_plan),
            RewriteLayout::RelocateContiguous { .. } => emit::emit_relocated(
                self.binary,
                &self.module,
                self.layout_plan.as_ref().ok_or_else(|| {
                    BinaryPatchError::Rewrite(
                        "relocated rewrite plan is missing a layout plan".to_string(),
                    )
                })?,
            ),
            RewriteLayout::ExpandLastExecutableSegment => {
                emit::emit_relocated_expanding_load_segment(self.binary, &self.module)
            }
        }
    }
}

impl RewriteVerification {
    fn new(
        binary: &Binary,
        original_module: &Module,
        module: &Module,
        rewrite_plan: &RewritePlan,
        layout: RewriteLayout,
        layout_plan: Option<&LayoutPlan>,
    ) -> Result<Self> {
        let module_analysis = ModuleAnalysis::from_module(module);
        let mut diagnostics = module_analysis.diagnostics().to_vec();
        diagnostics.extend(rewrite_plan.verify(original_module));

        let layout_diagnostics = match layout {
            RewriteLayout::PreserveEntryBlock => {
                Some(verify_preserve_entry_block(binary, module, rewrite_plan)?)
            }
            RewriteLayout::RelocateContiguous { .. }
            | RewriteLayout::ExpandLastExecutableSegment => {
                layout_plan.map(|plan| plan.verify(module))
            }
        };

        if let Some(layout_diagnostics) = &layout_diagnostics {
            diagnostics.extend(layout_diagnostics.diagnostics().iter().cloned());
        }

        diagnostics.extend(rewrite_plan_cfg_confidence_diagnostics(
            module_analysis.control_flow_confidence_tier(),
            rewrite_plan.transforms(),
            module,
        ));

        Ok(Self {
            module_analysis,
            layout_diagnostics,
            diagnostics,
        })
    }

    pub fn module_analysis(&self) -> &ModuleAnalysis {
        &self.module_analysis
    }

    pub fn layout_diagnostics(&self) -> Option<&LayoutDiagnostics> {
        self.layout_diagnostics.as_ref()
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewritePassReport {
    pub name: &'static str,
    pub analysis_diagnostics: Vec<Diagnostic>,
    pub validation_diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewriteWorkflowResult {
    pub plan: RewritePlan,
    pub reports: Vec<RewritePassReport>,
}

impl RewriteWorkflowResult {
    pub fn has_errors(&self) -> bool {
        self.reports.iter().any(|report| {
            report
                .analysis_diagnostics
                .iter()
                .chain(report.validation_diagnostics.iter())
                .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
        })
    }
}

pub trait RewritePass: std::fmt::Debug {
    fn name(&self) -> &'static str;
    fn analyze(&self, module: &Module) -> Result<Vec<Diagnostic>>;
    fn transform(&self, module: &Module, plan: &mut RewritePlan) -> Result<()>;
    fn cfg_confidence_requirement(&self) -> Option<ConfidenceTier> {
        None
    }
    fn validate(&self, module: &Module, plan: &RewritePlan) -> Result<Vec<Diagnostic>>;
}

#[derive(Debug, Default)]
pub struct RewriteWorkflow {
    passes: Vec<Box<dyn RewritePass>>,
}

impl RewriteWorkflow {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push<P: RewritePass + 'static>(&mut self, pass: P) -> &mut Self {
        self.passes.push(Box::new(pass));
        self
    }

    pub fn run(&self, module: &Module) -> Result<RewriteWorkflowResult> {
        let mut plan = RewritePlan::new();
        let mut reports = Vec::with_capacity(self.passes.len());
        let mut working_module = module.clone();

        for pass in &self.passes {
            let analysis_diagnostics = pass.analyze(&working_module)?;
            let analysis = ModuleAnalysis::from_module(&working_module);
            let mut validation_diagnostics = rewrite_pass_cfg_confidence_diagnostics(
                pass.cfg_confidence_requirement(),
                &analysis,
                pass.name(),
                &working_module,
            );

            if !validation_diagnostics
                .iter()
                .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
            {
                pass.transform(&working_module, &mut plan)?;
                validation_diagnostics.extend(pass.validate(module, &plan)?);
            }

            plan.diagnostics
                .extend(analysis_diagnostics.iter().cloned());
            plan.diagnostics
                .extend(validation_diagnostics.iter().cloned());
            reports.push(RewritePassReport {
                name: pass.name(),
                analysis_diagnostics,
                validation_diagnostics,
            });

            working_module = plan.apply(module)?;
        }

        Ok(RewriteWorkflowResult { plan, reports })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InsertEntryNopPass;

impl RewritePass for InsertEntryNopPass {
    fn name(&self) -> &'static str {
        "insert-entry-nop"
    }

    fn analyze(&self, module: &Module) -> Result<Vec<Diagnostic>> {
        Ok(match module.entry_block() {
            Some(_) => Vec::new(),
            None => vec![Diagnostic::error(
                "module has no entry block".to_string(),
                None,
            )],
        })
    }

    fn cfg_confidence_requirement(&self) -> Option<ConfidenceTier> {
        Some(ConfidenceTier::Medium)
    }

    fn transform(&self, module: &Module, plan: &mut RewritePlan) -> Result<()> {
        let mut entry_plan = RewritePlan::insert_entry_nop(module)?;
        plan.transforms.append(&mut entry_plan.transforms);
        plan.diagnostics.append(&mut entry_plan.diagnostics);
        Ok(())
    }

    fn validate(&self, module: &Module, plan: &RewritePlan) -> Result<Vec<Diagnostic>> {
        Ok(plan.verify(module))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloneEntryBlockPass {
    clone_address: u64,
}

impl CloneEntryBlockPass {
    pub fn new(clone_address: u64) -> Self {
        Self { clone_address }
    }

    pub fn clone_address(&self) -> u64 {
        self.clone_address
    }
}

impl RewritePass for CloneEntryBlockPass {
    fn name(&self) -> &'static str {
        "clone-entry-block"
    }

    fn analyze(&self, module: &Module) -> Result<Vec<Diagnostic>> {
        let mut diagnostics = Vec::new();
        let Some(entry_block) = module.entry_block() else {
            diagnostics.push(Diagnostic::error(
                "module has no entry block".to_string(),
                None,
            ));
            return Ok(diagnostics);
        };

        if self.clone_address == entry_block.address {
            diagnostics.push(Diagnostic::error(
                format!(
                    "clone address {:#x} must differ from the entry block",
                    self.clone_address
                ),
                Some(entry_block.file_offset),
            ));
        }

        if find_block(module, self.clone_address).is_some() {
            diagnostics.push(Diagnostic::error(
                format!(
                    "clone address {:#x} already exists in the module",
                    self.clone_address
                ),
                Some(entry_block.file_offset),
            ));
        }

        Ok(diagnostics)
    }

    fn cfg_confidence_requirement(&self) -> Option<ConfidenceTier> {
        Some(ConfidenceTier::Medium)
    }

    fn transform(&self, module: &Module, plan: &mut RewritePlan) -> Result<()> {
        let entry_block = module
            .entry_block()
            .ok_or_else(|| BinaryPatchError::Rewrite("module has no entry block".to_string()))?;
        plan.clone_block(entry_block.address, self.clone_address);
        Ok(())
    }

    fn validate(&self, module: &Module, plan: &RewritePlan) -> Result<Vec<Diagnostic>> {
        Ok(plan.verify(module))
    }
}

pub(crate) fn verify_preserve_entry_block(
    binary: &Binary,
    module: &Module,
    rewrite_plan: &RewritePlan,
) -> Result<LayoutDiagnostics> {
    let block_count = module
        .functions
        .iter()
        .map(|function| function.blocks.len())
        .sum();
    let mut diagnostics = Vec::new();
    let Some(entry_block) = module.entry_block() else {
        diagnostics.push(Diagnostic::error(
            "module has no entry block".to_string(),
            None,
        ));
        return Ok(LayoutDiagnostics::new(diagnostics, block_count, 0, 0, 0, 0));
    };

    for transform in rewrite_plan.transforms() {
        match transform {
            RewriteTransform::InsertBlockEntryOperation { block_address, .. }
            | RewriteTransform::InsertBeforeInstructionOperation { block_address, .. }
            | RewriteTransform::ReplaceBlockEntryOperation { block_address, .. }
                if *block_address != entry_block.address =>
            {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "preserved entry emission only supports transforms targeting the entry block; found {block_address:#x}"
                    ),
                    Some(entry_block.file_offset),
                ));
            }
            RewriteTransform::InsertBlockEntryOperation { .. } => {}
            RewriteTransform::InsertBeforeInstructionOperation { .. } => {}
            RewriteTransform::ReplaceBlockEntryOperation { .. } => {}
            RewriteTransform::CloneBlock {
                source_block_address,
                ..
            } => {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "preserved entry emission only supports transforms targeting the entry block; found clone from {source_block_address:#x}"
                    ),
                    Some(entry_block.file_offset),
                ));
            }
        }
    }

    if entry_block
        .instructions
        .iter()
        .any(|instruction| matches!(instruction.operation, Operation::Unknown { .. }))
    {
        diagnostics.push(Diagnostic::error(
            "entry block contains unknown operations and cannot be safely re-emitted".to_string(),
            Some(entry_block.file_offset),
        ));
    }

    if entry_block.instructions.iter().any(|instruction| {
        instruction.operation.direct_target().is_some_and(|target| {
            target > entry_block.address && target < entry_block.end_address()
        })
    }) {
        diagnostics.push(Diagnostic::error(
            "entry rewrite needs an intra-block target relocation map".to_string(),
            Some(entry_block.file_offset),
        ));
    }

    let encoded_len = encode_block_len(module, entry_block.address)?;
    let original_len = entry_block.encoded_len();
    if encoded_len > original_len {
        let required_extra = encoded_len - original_len;
        let padding_start = entry_block.end_file_offset() as usize;
        let padding_end = padding_start + required_extra;
        match binary.bytes().get(padding_start..padding_end) {
            Some(bytes) if bytes.iter().all(|byte| matches!(*byte, 0x00 | 0x90 | 0xcc)) => {}
            Some(_) => diagnostics.push(Diagnostic::error(
                "semantic entry rewrite would overwrite non-padding bytes".to_string(),
                Some(entry_block.end_file_offset()),
            )),
            None => diagnostics.push(Diagnostic::error(
                "not enough file space after the entry block".to_string(),
                Some(entry_block.end_file_offset()),
            )),
        }
    }

    Ok(LayoutDiagnostics::new(diagnostics, block_count, 0, 0, 0, 0))
}

fn encode_block_len(module: &Module, block_address: u64) -> Result<usize> {
    let block = module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
        .find(|block| block.address == block_address)
        .ok_or_else(|| {
            BinaryPatchError::Rewrite(format!("module has no block at {block_address:#x}"))
        })?;
    let mut total = 0usize;
    let mut cursor = block.address;
    for instruction in &block.instructions {
        let encoded = arch::encode_operation(module.architecture, cursor, &instruction.operation)?;
        cursor += encoded.len() as u64;
        total += encoded.len();
    }
    Ok(total)
}

fn expansion_layout(binary: &Binary, module: &Module) -> Result<LayoutPlan> {
    let entry_segment = binary.object().entry_segment().ok_or_else(|| {
        BinaryPatchError::Rewrite("entry is not in an executable segment".to_string())
    })?;
    let append_file_offset = binary.bytes().len() as u64;

    if binary.object().format == BinaryFormat::Pe {
        let section_file_end = entry_segment.file_offset + entry_segment.file_size;
        if section_file_end != append_file_offset {
            return Err(BinaryPatchError::Unsupported(
                "this expansion path requires the entry PE section to end at EOF".to_string(),
            ));
        }
    }

    let append_address =
        entry_segment.virtual_address + (append_file_offset - entry_segment.file_offset);
    LayoutPlan::relocate_contiguous(module, append_address)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentationSiteKind {
    Return,
    Call,
}

impl InstrumentationSiteKind {
    fn label(self) -> &'static str {
        match self {
            Self::Return => "return-like",
            Self::Call => "call",
        }
    }

    fn matches(self, operation: &Operation) -> bool {
        match self {
            Self::Return => matches!(
                operation,
                Operation::Return | Operation::ReturnWithStackAdjustment { .. }
            ),
            Self::Call => matches!(
                operation,
                Operation::DirectCall { .. } | Operation::IndirectCall { .. }
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentationSiteSelector {
    Block(u64),
    Instruction(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InstrumentationSite {
    block_address: u64,
    instruction_index: usize,
    instruction_address: u64,
    file_offset: u64,
}

fn collect_instrumentation_sites(
    module: &Module,
    kind: InstrumentationSiteKind,
) -> Vec<InstrumentationSite> {
    let mut sites = Vec::new();
    for block in module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
    {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if kind.matches(&instruction.operation) {
                sites.push(InstrumentationSite {
                    block_address: block.address,
                    instruction_index,
                    instruction_address: instruction.address,
                    file_offset: instruction.file_offset,
                });
            }
        }
    }
    sites
}

fn collect_instrumentation_sites_in_block(
    module: &Module,
    kind: InstrumentationSiteKind,
    block_address: u64,
) -> Vec<InstrumentationSite> {
    find_block(module, block_address)
        .into_iter()
        .flat_map(|block| {
            block.instructions.iter().enumerate().filter_map(
                move |(instruction_index, instruction)| {
                    kind.matches(&instruction.operation)
                        .then_some(InstrumentationSite {
                            block_address: block.address,
                            instruction_index,
                            instruction_address: instruction.address,
                            file_offset: instruction.file_offset,
                        })
                },
            )
        })
        .collect()
}

fn find_instrumentation_site(
    module: &Module,
    kind: InstrumentationSiteKind,
    instruction_address: u64,
) -> Option<InstrumentationSite> {
    for block in module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
    {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if instruction.address == instruction_address {
                if kind.matches(&instruction.operation) {
                    return Some(InstrumentationSite {
                        block_address: block.address,
                        instruction_index,
                        instruction_address: instruction.address,
                        file_offset: instruction.file_offset,
                    });
                }
                return None;
            }
        }
    }
    None
}

fn add_instrumentation_sites(
    plan: &mut RewritePlan,
    module: &Module,
    analysis: &ModuleAnalysis,
    kind: InstrumentationSiteKind,
    sites: impl IntoIterator<Item = InstrumentationSite>,
    operation: &Operation,
) {
    let dataflow = analysis.dataflow();
    for site in sites {
        plan.transforms
            .push(RewriteTransform::InsertBeforeInstructionOperation {
                block_address: site.block_address,
                instruction_index: site.instruction_index,
                operation: operation.clone(),
            });
        plan.diagnostics.extend(insertion_site_diagnostics(
            module,
            dataflow,
            kind.label(),
            site,
            operation,
        ));
    }
}

fn insertion_site_diagnostics(
    module: &Module,
    dataflow: &ModuleDataflow,
    site_label: &str,
    site: InstrumentationSite,
    operation: &Operation,
) -> Vec<Diagnostic> {
    let Some(block) = find_block(module, site.block_address) else {
        return vec![Diagnostic::error(
            format!(
                "rewrite transform targets unknown block {:#x}",
                site.block_address
            ),
            None,
        )];
    };
    let Some(block_dataflow) = dataflow.block_by_address(site.block_address) else {
        return vec![Diagnostic::error(
            format!(
                "rewrite transform targets unknown block {:#x}",
                site.block_address
            ),
            Some(site.file_offset),
        )];
    };
    if site.instruction_index >= block.instructions.len() {
        return vec![Diagnostic::error(
            format!(
                "rewrite transform targets instruction {:#x} beyond the end of block {:#x}",
                site.instruction_address, site.block_address
            ),
            Some(site.file_offset),
        )];
    }

    let live_before_site =
        live_resources_before_instruction(block, block_dataflow, site.instruction_index);
    let effect = operation.dataflow_effect();
    if effect.has_unknown_side_effects {
        return vec![Diagnostic::error(
            format!(
                "rewrite transform has unmodeled side effects and cannot be validated before {} instruction {:#x}",
                site_label,
                site.instruction_address
            ),
            Some(site.file_offset),
        )];
    }

    let writes = resources_written_by_effect(&effect);
    let clobbered_writes = writes.intersects(&live_before_site);
    let mut diagnostics = Vec::new();

    if clobbered_writes {
        let exact_clobbered = ResourceSet {
            registers: writes
                .registers
                .intersection(&live_before_site.registers)
                .copied()
                .collect(),
            flags: writes
                .flags
                .intersection(&live_before_site.flags)
                .copied()
                .collect(),
        };
        diagnostics.push(Diagnostic::error(
            format!(
                "rewrite transform clobbers resources live before {} instruction {:#x}: {}",
                site_label,
                site.instruction_address,
                describe_resource_set(&exact_clobbered)
            ),
            Some(site.file_offset),
        ));
    }

    diagnostics
}

fn live_resources_before_instruction(
    block: &crate::ir::BasicBlock,
    block_dataflow: &BasicBlockDataflow,
    instruction_index: usize,
) -> ResourceSet {
    let mut live = block_dataflow.live_out.clone();
    for (index, instruction) in block.instructions.iter().enumerate().rev() {
        if index <= instruction_index {
            break;
        }
        let effect = instruction.operation.dataflow_effect();
        if effect.has_unknown_side_effects {
            live = all_resources();
            continue;
        }
        let reads = resources_read_by_effect(&effect);
        let writes = resources_written_by_effect(&effect);
        live = reads.union(&live.difference(&writes));
    }
    live
}

fn resources_read_by_effect(effect: &crate::ir::DataflowEffect) -> ResourceSet {
    ResourceSet {
        registers: effect.register_reads.clone(),
        flags: effect.flag_reads.clone(),
    }
}

fn resources_written_by_effect(effect: &crate::ir::DataflowEffect) -> ResourceSet {
    ResourceSet {
        registers: effect.register_writes.clone(),
        flags: effect.flag_writes.clone(),
    }
}

fn all_resources() -> ResourceSet {
    ResourceSet {
        registers: BTreeSet::from([
            crate::ir::RegisterFamily::Rax,
            crate::ir::RegisterFamily::Rcx,
            crate::ir::RegisterFamily::Rdx,
            crate::ir::RegisterFamily::Rbx,
            crate::ir::RegisterFamily::Rsp,
            crate::ir::RegisterFamily::Rbp,
            crate::ir::RegisterFamily::Rsi,
            crate::ir::RegisterFamily::Rdi,
            crate::ir::RegisterFamily::R8,
            crate::ir::RegisterFamily::R9,
            crate::ir::RegisterFamily::R10,
            crate::ir::RegisterFamily::R11,
            crate::ir::RegisterFamily::R12,
            crate::ir::RegisterFamily::R13,
            crate::ir::RegisterFamily::R14,
            crate::ir::RegisterFamily::R15,
        ]),
        flags: BTreeSet::from([
            crate::ir::ProcessorFlag::Carry,
            crate::ir::ProcessorFlag::Parity,
            crate::ir::ProcessorFlag::AuxiliaryCarry,
            crate::ir::ProcessorFlag::Zero,
            crate::ir::ProcessorFlag::Sign,
            crate::ir::ProcessorFlag::Overflow,
            crate::ir::ProcessorFlag::Direction,
            crate::ir::ProcessorFlag::InterruptEnable,
            crate::ir::ProcessorFlag::Trap,
        ]),
    }
}

fn describe_resource_set(resources: &ResourceSet) -> String {
    let mut pieces = Vec::new();
    if !resources.registers.is_empty() {
        pieces.push(format!(
            "registers [{}]",
            resources
                .registers
                .iter()
                .map(|register| format!("{register:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !resources.flags.is_empty() {
        pieces.push(format!(
            "flags [{}]",
            resources
                .flags
                .iter()
                .map(|flag| format!("{flag:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if pieces.is_empty() {
        "none".to_string()
    } else {
        pieces.join("; ")
    }
}

fn insert_instruction_before(
    block: &mut crate::ir::BasicBlock,
    instruction_index: usize,
    operation: Operation,
    insertion_prefix_counts: &mut Vec<usize>,
) {
    if insertion_prefix_counts.len() < block.instructions.len() + 1 {
        insertion_prefix_counts.resize(block.instructions.len() + 1, 0);
    }
    let current_index = instruction_index + insertion_prefix_counts[instruction_index];
    block.instructions.insert(
        current_index,
        Instruction {
            address: block.address,
            file_offset: block.file_offset,
            bytes: Vec::new(),
            operation,
            jump_table: None,
            diagnostics: Vec::new(),
        },
    );
    for count in insertion_prefix_counts.iter_mut().skip(instruction_index) {
        *count += 1;
    }
}

fn find_block(module: &Module, block_address: u64) -> Option<&crate::ir::BasicBlock> {
    module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
        .find(|block| block.address == block_address)
}

fn find_block_mut(module: &mut Module, block_address: u64) -> Option<&mut crate::ir::BasicBlock> {
    module
        .functions
        .iter_mut()
        .flat_map(|function| function.blocks.iter_mut())
        .find(|block| block.address == block_address)
}

fn find_instruction_block(
    module: &Module,
    instruction_address: u64,
) -> Option<&crate::ir::BasicBlock> {
    module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
        .find(|block| {
            block
                .instructions
                .iter()
                .any(|instruction| instruction.address == instruction_address)
        })
}

fn find_block_location(
    module: &Module,
    block_address: u64,
) -> Option<(usize, usize, &crate::ir::BasicBlock)> {
    for (function_index, function) in module.functions.iter().enumerate() {
        for (block_index, block) in function.blocks.iter().enumerate() {
            if block.address == block_address {
                return Some((function_index, block_index, block));
            }
        }
    }
    None
}

fn next_block_id(module: &Module) -> crate::ir::BasicBlockId {
    let next_id = module
        .functions
        .iter()
        .flat_map(|function| function.blocks.iter())
        .map(|block| block.id.0)
        .max()
        .map(|id| id + 1)
        .unwrap_or(0);
    crate::ir::BasicBlockId(next_id)
}

fn clone_basic_block(block: &crate::ir::BasicBlock, clone_address: u64) -> crate::ir::BasicBlock {
    let mut cloned = block.clone();
    cloned.address = clone_address;
    cloned.file_offset = block.file_offset;
    let mut cursor = clone_address;
    for instruction in &mut cloned.instructions {
        instruction.address = cursor;
        cursor += instruction.bytes.len() as u64;
    }
    cloned.edges.clear();
    cloned
}

fn diagnostics_message(diagnostics: &[Diagnostic]) -> String {
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

fn rewrite_plan_cfg_confidence_diagnostics(
    confidence_tier: Option<ConfidenceTier>,
    transforms: &[RewriteTransform],
    module: &Module,
) -> Vec<Diagnostic> {
    let Some(actual_tier) = confidence_tier else {
        return Vec::new();
    };

    transforms
        .iter()
        .filter_map(|transform| {
            let required = transform_cfg_confidence_requirement(transform);
            if actual_tier.minimum_score() >= required.minimum_score() {
                return None;
            }

            let (label, offset) = transform_cfg_context(transform, module);
            Some(Diagnostic::error(
                format!(
                    "{label} requires at least {:?} CFG confidence, but analysis reached {:?}",
                    required, actual_tier
                ),
                offset,
            ))
        })
        .collect()
}

fn rewrite_pass_cfg_confidence_diagnostics(
    requirement: Option<ConfidenceTier>,
    analysis: &ModuleAnalysis,
    pass_name: &str,
    module: &Module,
) -> Vec<Diagnostic> {
    let Some(required) = requirement else {
        return Vec::new();
    };
    let Some(actual) = analysis.control_flow_confidence_tier() else {
        return Vec::new();
    };
    if actual.minimum_score() >= required.minimum_score() {
        return Vec::new();
    }

    let offset = module.entry_block().map(|block| block.file_offset);
    vec![Diagnostic::error(
        format!(
            "rewrite pass {pass_name} requires at least {:?} CFG confidence, but analysis reached {:?}",
            required, actual
        ),
        offset,
    )]
}

fn transform_cfg_confidence_requirement(transform: &RewriteTransform) -> ConfidenceTier {
    match transform {
        RewriteTransform::InsertBlockEntryOperation { .. } => ConfidenceTier::Low,
        RewriteTransform::InsertBeforeInstructionOperation { .. } => ConfidenceTier::Low,
        RewriteTransform::ReplaceBlockEntryOperation { .. } => ConfidenceTier::Medium,
        RewriteTransform::CloneBlock { .. } => ConfidenceTier::Medium,
    }
}

fn transform_cfg_context(transform: &RewriteTransform, module: &Module) -> (String, Option<u64>) {
    match transform {
        RewriteTransform::InsertBlockEntryOperation { block_address, .. } => {
            let offset = find_block(module, *block_address).map(|block| block.file_offset);
            (
                format!("insert transform at block {block_address:#x}"),
                offset,
            )
        }
        RewriteTransform::InsertBeforeInstructionOperation {
            block_address,
            instruction_index,
            ..
        } => {
            let offset = find_block(module, *block_address)
                .and_then(|block| block.instructions.get(*instruction_index))
                .map(|instruction| instruction.file_offset);
            (
                format!(
                    "insert-before-instruction transform at block {block_address:#x} instruction {instruction_index}"
                ),
                offset,
            )
        }
        RewriteTransform::ReplaceBlockEntryOperation { block_address, .. } => {
            let offset = find_block(module, *block_address).map(|block| block.file_offset);
            (
                format!("replace transform at block {block_address:#x}"),
                offset,
            )
        }
        RewriteTransform::CloneBlock {
            source_block_address,
            clone_address,
        } => {
            let offset = find_block(module, *source_block_address).map(|block| block.file_offset);
            (
                format!(
                    "clone transform from block {source_block_address:#x} to {clone_address:#x}"
                ),
                offset,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{Architecture, BinaryFormat};
    use crate::ir::{BasicBlock, BasicBlockId, Edge, EdgeKind, Function, Instruction, Module};

    #[test]
    fn verify_reports_clobbering_transform_at_block_entry() {
        let module = module_with_liveness_chain();
        let mut plan = RewritePlan::new();
        plan.insert_block_entry_operation(
            0x1000,
            Operation::SetRegisterImmediate {
                register: crate::ir::Register::Rax,
                value: 0,
                width_bits: 64,
            },
        );

        let diagnostics = plan.verify(&module);
        assert!(diagnostics.iter().any(|diagnostic| diagnostic
            .message
            .contains("clobbers resources live at block entry")));
    }

    fn module_with_liveness_chain() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: Default::default(),
            functions: vec![Function {
                entry: 0x1000,
                blocks: vec![
                    BasicBlock {
                        id: BasicBlockId(0),
                        address: 0x1000,
                        file_offset: 0x200,
                        instructions: vec![Instruction {
                            address: 0x1000,
                            file_offset: 0x200,
                            bytes: vec![0x48, 0x83, 0xf8, 0x01],
                            operation: Operation::CompareRegisterImmediate {
                                register: crate::ir::Register::Rax,
                                value: 1,
                                width_bits: 64,
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(0),
                            to: Some(BasicBlockId(1)),
                            target: Some(0x1010),
                            kind: EdgeKind::Fallthrough,
                        }],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x1010,
                        file_offset: 0x210,
                        instructions: vec![Instruction {
                            address: 0x1010,
                            file_offset: 0x210,
                            bytes: vec![0x48, 0x0f, 0x45, 0xc2],
                            operation: Operation::ConditionalMoveRegister {
                                condition: crate::ir::ConditionCode::Equal,
                                dst: crate::ir::Register::Rdx,
                                src: crate::ir::ControlFlowOperand::Register(
                                    crate::ir::Register::Rax,
                                ),
                                width_bits: 64,
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }
}
