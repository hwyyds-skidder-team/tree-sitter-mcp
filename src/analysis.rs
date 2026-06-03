use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::diagnostic::{Diagnostic, DiagnosticSeverity};
use crate::ir::{
    BasicBlock, BasicBlockId, ConditionCode, ControlFlowOperand, DataflowEffect, Edge, EdgeKind,
    JumpTableCandidate, MemoryOperand, Module, Operation, ProcessorFlag, Register, RegisterFamily,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CfgConfidence {
    pub score: u8,
}

impl CfgConfidence {
    pub fn new(score: u8) -> Self {
        Self {
            score: score.min(100),
        }
    }

    pub fn tier(&self) -> ConfidenceTier {
        match self.score {
            0..=39 => ConfidenceTier::Low,
            40..=69 => ConfidenceTier::Medium,
            70..=100 => ConfidenceTier::High,
            _ => ConfidenceTier::High,
        }
    }

    pub fn meets(&self, tier: ConfidenceTier) -> bool {
        self.score >= tier.minimum_score()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceTier {
    Low,
    Medium,
    High,
}

impl ConfidenceTier {
    pub fn minimum_score(self) -> u8 {
        match self {
            ConfidenceTier::Low => 0,
            ConfidenceTier::Medium => 40,
            ConfidenceTier::High => 70,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnresolvedEdgeReason {
    MissingSourceBlock,
    MissingDestinationBlock,
    MissingTarget,
    TargetBlockNotLinked,
    InteriorTarget,
    UnresolvedTarget,
}

impl UnresolvedEdgeReason {
    pub fn label(self) -> &'static str {
        match self {
            Self::MissingSourceBlock => "missing source block",
            Self::MissingDestinationBlock => "missing destination block",
            Self::MissingTarget => "missing target",
            Self::TargetBlockNotLinked => "target block not linked",
            Self::InteriorTarget => "interior target",
            Self::UnresolvedTarget => "unresolved target",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedEdge {
    pub edge: Edge,
    pub reason: UnresolvedEdgeReason,
    pub confidence: CfgConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundsCheckTerm {
    Register(Register),
    Immediate(i64),
    Memory(MemoryOperand),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundsCheckPattern {
    pub block: BasicBlockId,
    pub instruction_address: u64,
    pub file_offset: u64,
    pub condition: Option<ConditionCode>,
    pub left: BoundsCheckTerm,
    pub right: BoundsCheckTerm,
    pub branch_target: Option<u64>,
    pub confidence: CfgConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpTableBaseTrace {
    pub register: Register,
    pub value: u64,
    pub definition_block: BasicBlockId,
    pub definition_address: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlFlowRecoveryKind {
    JumpTable,
    TailCall,
    Thunk,
    Plt,
    Iat,
    Indirect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndirectControlFlow {
    pub block: BasicBlockId,
    pub instruction_address: u64,
    pub file_offset: u64,
    pub kind: EdgeKind,
    pub operand: ControlFlowOperand,
    pub recovery_kind: ControlFlowRecoveryKind,
    pub confidence: CfgConfidence,
    pub jump_table_base: Option<JumpTableBaseTrace>,
    pub bounds_check: Option<BoundsCheckPattern>,
    pub table_address: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpTableRecovery {
    pub block: BasicBlockId,
    pub instruction_address: u64,
    pub file_offset: u64,
    pub kind: EdgeKind,
    pub operand: MemoryOperand,
    pub candidate: JumpTableCandidate,
    pub base_trace: Option<JumpTableBaseTrace>,
    pub bounds_check: Option<BoundsCheckPattern>,
    pub confidence: CfgConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeRecoveryKind {
    Direct,
    IntraFunctionJump,
    JumpTable,
    TailCall,
    Thunk,
    Plt,
    Iat,
    Indirect,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedEdge {
    pub edge: Edge,
    pub recovery_kind: EdgeRecoveryKind,
    pub confidence: CfgConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportCallCandidate {
    pub edge: Edge,
    pub recovery_kind: EdgeRecoveryKind,
    pub confidence: CfgConfidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlFlowGraph {
    pub entry: BasicBlockId,
    pub blocks: Vec<BasicBlockId>,
    pub edges: Vec<Edge>,
    pub classified_edges: Vec<ClassifiedEdge>,
    import_call_candidates: Vec<ImportCallCandidate>,
    unresolved_edges: Vec<UnresolvedEdge>,
    indirect_control_flows: Vec<IndirectControlFlow>,
    jump_table_recoveries: Vec<JumpTableRecovery>,
    bounds_checks: Vec<BoundsCheckPattern>,
    confidence: CfgConfidence,
    diagnostics: Vec<Diagnostic>,
}

impl ControlFlowGraph {
    pub fn from_module(module: &Module) -> Option<Self> {
        let entry_block = module.entry_block()?;
        Some(build_control_flow_graph(module, entry_block.id))
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn indirect_control_flows(&self) -> &[IndirectControlFlow] {
        &self.indirect_control_flows
    }

    pub fn unresolved_dynamic_targets(&self) -> &[IndirectControlFlow] {
        &self.indirect_control_flows
    }

    pub fn jump_table_recoveries(&self) -> &[JumpTableRecovery] {
        &self.jump_table_recoveries
    }

    pub fn bounds_checks(&self) -> &[BoundsCheckPattern] {
        &self.bounds_checks
    }

    pub fn classified_edges(&self) -> &[ClassifiedEdge] {
        &self.classified_edges
    }

    pub fn import_call_candidates(&self) -> &[ImportCallCandidate] {
        &self.import_call_candidates
    }

    pub fn unresolved_edges(&self) -> &[UnresolvedEdge] {
        &self.unresolved_edges
    }

    pub fn confidence(&self) -> &CfgConfidence {
        &self.confidence
    }

    pub fn confidence_tier(&self) -> ConfidenceTier {
        self.confidence.tier()
    }

    pub fn confidence_meets(&self, tier: ConfidenceTier) -> bool {
        self.confidence.meets(tier)
    }

    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ResourceSet {
    pub registers: BTreeSet<RegisterFamily>,
    pub flags: BTreeSet<ProcessorFlag>,
}

impl ResourceSet {
    pub fn is_empty(&self) -> bool {
        self.registers.is_empty() && self.flags.is_empty()
    }

    pub fn union(&self, other: &Self) -> Self {
        let mut merged = self.clone();
        merged.registers.extend(other.registers.iter().copied());
        merged.flags.extend(other.flags.iter().copied());
        merged
    }

    pub fn difference(&self, other: &Self) -> Self {
        Self {
            registers: self
                .registers
                .difference(&other.registers)
                .copied()
                .collect(),
            flags: self.flags.difference(&other.flags).copied().collect(),
        }
    }

    pub fn intersects(&self, other: &Self) -> bool {
        !self.registers.is_disjoint(&other.registers) || !self.flags.is_disjoint(&other.flags)
    }
}

impl From<&DataflowEffect> for ResourceSet {
    fn from(effect: &DataflowEffect) -> Self {
        Self {
            registers: effect.register_reads.clone(),
            flags: effect.flag_reads.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasicBlockDataflow {
    pub block: BasicBlockId,
    pub address: u64,
    pub file_offset: u64,
    pub uses: ResourceSet,
    pub defs: ResourceSet,
    pub live_in: ResourceSet,
    pub live_out: ResourceSet,
}

impl BasicBlockDataflow {
    pub fn clobbers_live_in(&self, operation: &Operation) -> bool {
        let effect = operation.dataflow_effect();
        let writes = resources_written_by_effect(&effect);
        writes.intersects(&self.live_in)
    }

    pub fn unsafe_insertion_diagnostics(&self, operation: &Operation) -> Vec<Diagnostic> {
        let effect = operation.dataflow_effect();
        if effect.has_unknown_side_effects {
            return vec![Diagnostic::error(
                "rewrite transform has unmodeled side effects and cannot be validated at block entry"
                    .to_string(),
                Some(self.file_offset),
            )];
        }

        let writes = resources_written_by_effect(&effect);
        let clobbered_writes = writes.intersects(&self.live_in);
        let mut diagnostics = Vec::new();

        if clobbered_writes {
            let exact_clobbered = ResourceSet {
                registers: writes
                    .registers
                    .intersection(&self.live_in.registers)
                    .copied()
                    .collect(),
                flags: writes
                    .flags
                    .intersection(&self.live_in.flags)
                    .copied()
                    .collect(),
            };
            diagnostics.push(Diagnostic::error(
                format!(
                    "rewrite transform clobbers resources live at block entry: {}",
                    describe_resource_set(&exact_clobbered)
                ),
                Some(self.file_offset),
            ));
        }

        diagnostics
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionDataflow {
    pub entry: u64,
    pub blocks: Vec<BasicBlockDataflow>,
    block_index_by_address: BTreeMap<u64, usize>,
    block_index_by_id: BTreeMap<usize, usize>,
}

impl FunctionDataflow {
    pub fn blocks(&self) -> &[BasicBlockDataflow] {
        &self.blocks
    }

    pub fn block(&self, id: BasicBlockId) -> Option<&BasicBlockDataflow> {
        self.block_index_by_id
            .get(&id.0)
            .and_then(|index| self.blocks.get(*index))
    }

    pub fn block_by_address(&self, address: u64) -> Option<&BasicBlockDataflow> {
        self.block_index_by_address
            .get(&address)
            .and_then(|index| self.blocks.get(*index))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleDataflow {
    functions: Vec<FunctionDataflow>,
}

impl ModuleDataflow {
    pub fn from_module(module: &Module) -> Self {
        Self {
            functions: module.functions.iter().map(function_dataflow).collect(),
        }
    }

    pub fn functions(&self) -> &[FunctionDataflow] {
        &self.functions
    }

    pub fn function(&self, entry: u64) -> Option<&FunctionDataflow> {
        self.functions
            .iter()
            .find(|function| function.entry == entry)
    }

    pub fn block_by_address(&self, address: u64) -> Option<&BasicBlockDataflow> {
        self.functions
            .iter()
            .find_map(|function| function.block_by_address(address))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleAnalysis {
    control_flow: Option<ControlFlowGraph>,
    dataflow: ModuleDataflow,
    diagnostics: Vec<Diagnostic>,
}

impl ModuleAnalysis {
    pub fn from_module(module: &Module) -> Self {
        let control_flow = ControlFlowGraph::from_module(module);
        let dataflow = ModuleDataflow::from_module(module);
        let mut diagnostics = module.diagnostics.clone();

        match &control_flow {
            Some(graph) => diagnostics.extend(graph.diagnostics().iter().cloned()),
            None => diagnostics.push(Diagnostic::error(
                "module has no entry block".to_string(),
                None,
            )),
        }

        Self {
            control_flow,
            dataflow,
            diagnostics,
        }
    }

    pub fn control_flow(&self) -> Option<&ControlFlowGraph> {
        self.control_flow.as_ref()
    }

    pub fn dataflow(&self) -> &ModuleDataflow {
        &self.dataflow
    }

    pub fn control_flow_confidence(&self) -> Option<&CfgConfidence> {
        self.control_flow.as_ref().map(ControlFlowGraph::confidence)
    }

    pub fn control_flow_confidence_tier(&self) -> Option<ConfidenceTier> {
        self.control_flow
            .as_ref()
            .map(ControlFlowGraph::confidence_tier)
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

fn function_dataflow(function: &crate::ir::Function) -> FunctionDataflow {
    let mut blocks = Vec::with_capacity(function.blocks.len());
    let mut block_index_by_address = BTreeMap::new();
    let mut block_index_by_id = BTreeMap::new();

    for block in &function.blocks {
        let index = blocks.len();
        let (uses, defs) = block_resource_summary(block);
        blocks.push(BasicBlockDataflow {
            block: block.id,
            address: block.address,
            file_offset: block.file_offset,
            uses,
            defs,
            live_in: ResourceSet::default(),
            live_out: ResourceSet::default(),
        });
        block_index_by_address.insert(block.address, index);
        block_index_by_id.insert(block.id.0, index);
    }

    let universal = all_resources();
    let mut changed = true;
    while changed {
        changed = false;
        for (index, block) in function.blocks.iter().enumerate().rev() {
            let mut live_out = ResourceSet::default();
            let mut unresolved_successor = false;

            for edge in &block.edges {
                match edge.to {
                    Some(to) => {
                        if let Some(successor_index) = block_index_by_id.get(&to.0) {
                            live_out = live_out.union(&blocks[*successor_index].live_in);
                        }
                    }
                    None if edge.target.is_some() || edge_kind_requires_target(edge.kind) => {
                        unresolved_successor = true;
                    }
                    None => {}
                }
            }

            if unresolved_successor {
                live_out = live_out.union(&universal);
            }

            let live_in = blocks[index]
                .uses
                .union(&live_out.difference(&blocks[index].defs));
            if live_in != blocks[index].live_in || live_out != blocks[index].live_out {
                blocks[index].live_in = live_in;
                blocks[index].live_out = live_out;
                changed = true;
            }
        }
    }

    FunctionDataflow {
        entry: function.entry,
        blocks,
        block_index_by_address,
        block_index_by_id,
    }
}

fn block_resource_summary(block: &BasicBlock) -> (ResourceSet, ResourceSet) {
    let mut uses = ResourceSet::default();
    let mut defs = ResourceSet::default();

    for instruction in &block.instructions {
        let effect = instruction.operation.dataflow_effect();
        let reads = resources_read_by_effect(&effect);
        let writes = resources_written_by_effect(&effect);

        uses.registers.extend(
            reads
                .registers
                .difference(&defs.registers)
                .copied()
                .collect::<BTreeSet<_>>(),
        );
        uses.flags.extend(
            reads
                .flags
                .difference(&defs.flags)
                .copied()
                .collect::<BTreeSet<_>>(),
        );
        defs.registers.extend(writes.registers.iter().copied());
        defs.flags.extend(writes.flags.iter().copied());
    }

    (uses, defs)
}

fn resources_read_by_effect(effect: &DataflowEffect) -> ResourceSet {
    ResourceSet {
        registers: effect.register_reads.clone(),
        flags: effect.flag_reads.clone(),
    }
}

fn resources_written_by_effect(effect: &DataflowEffect) -> ResourceSet {
    ResourceSet {
        registers: effect.register_writes.clone(),
        flags: effect.flag_writes.clone(),
    }
}

fn all_resources() -> ResourceSet {
    ResourceSet {
        registers: BTreeSet::from([
            RegisterFamily::Rax,
            RegisterFamily::Rcx,
            RegisterFamily::Rdx,
            RegisterFamily::Rbx,
            RegisterFamily::Rsp,
            RegisterFamily::Rbp,
            RegisterFamily::Rsi,
            RegisterFamily::Rdi,
            RegisterFamily::R8,
            RegisterFamily::R9,
            RegisterFamily::R10,
            RegisterFamily::R11,
            RegisterFamily::R12,
            RegisterFamily::R13,
            RegisterFamily::R14,
            RegisterFamily::R15,
        ]),
        flags: BTreeSet::from([
            ProcessorFlag::Carry,
            ProcessorFlag::Parity,
            ProcessorFlag::AuxiliaryCarry,
            ProcessorFlag::Zero,
            ProcessorFlag::Sign,
            ProcessorFlag::Overflow,
            ProcessorFlag::Direction,
            ProcessorFlag::InterruptEnable,
            ProcessorFlag::Trap,
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

fn indirect_control_flow_diagnostic(site: &IndirectControlFlow) -> Diagnostic {
    let kind = control_flow_kind_label(site.kind);
    match &site.operand {
        ControlFlowOperand::Register(register) => match site.recovery_kind {
            ControlFlowRecoveryKind::Indirect => Diagnostic::warning(
                format!(
                    "{kind} at {:#x} uses unresolved register target {:?} (confidence {:?}:{})",
                    site.instruction_address,
                    register,
                    site.confidence.tier(),
                    site.confidence.score
                ),
                Some(site.file_offset),
            ),
            _ => Diagnostic::info(format!(
                "{kind} at {:#x} classified as {:?} through register target {:?} (confidence {:?}:{})",
                site.instruction_address,
                site.recovery_kind,
                register,
                site.confidence.tier(),
                site.confidence.score
            )),
        },
        ControlFlowOperand::Memory(memory) => match site.recovery_kind {
            ControlFlowRecoveryKind::Indirect => {
                let mut message = format!(
                    "{kind} at {:#x} uses unresolved memory target {:?}",
                    site.instruction_address, memory
                );
                if let Some(base) = &site.jump_table_base {
                    message.push_str(&format!(
                        "; tracked base {:?} from block {:#x} at {:#x}",
                        base.register, base.definition_block.0, base.definition_address
                    ));
                }
                if let Some(bounds_check) = &site.bounds_check {
                    message.push_str(&format!(
                        "; bounds check at {:#x}",
                        bounds_check.instruction_address
                    ));
                }
                message.push_str("; no file-backed jump table candidate was recovered");
                message.push_str(&format!(
                    " (confidence {:?}:{})",
                    site.confidence.tier(),
                    site.confidence.score
                ));
                Diagnostic::warning(message, Some(site.file_offset))
            }
            _ => Diagnostic::info(format!(
                "{kind} at {:#x} classified as {:?} through memory target {:?}{}{} (confidence {:?}:{})",
                site.instruction_address,
                site.recovery_kind,
                memory,
                site.jump_table_base
                    .as_ref()
                    .map(|base| format!(
                        "; tracked base {:?} from block {:#x} at {:#x}",
                        base.register, base.definition_block.0, base.definition_address
                    ))
                    .unwrap_or_default(),
                site.bounds_check
                    .as_ref()
                    .map(|bounds_check| format!(
                        "; bounds check at {:#x}",
                        bounds_check.instruction_address
                    ))
                    .unwrap_or_default(),
                site.confidence.tier(),
                site.confidence.score
            )),
        },
    }
}

fn jump_table_recovery_diagnostic(site: &JumpTableRecovery) -> Diagnostic {
    let mut message = format!(
        "{} at {:#x} recovered jump table at {:#x} with {} entries",
        control_flow_kind_label(site.kind),
        site.instruction_address,
        site.candidate.table_address,
        site.candidate.entries.len()
    );
    message.push_str(&format!(
        " (confidence {:?}:{})",
        site.confidence.tier(),
        site.confidence.score
    ));
    if let Some(base) = &site.base_trace {
        message.push_str(&format!(
            "; tracked base {:?} from block {:#x} at {:#x}",
            base.register, base.definition_block.0, base.definition_address
        ));
    }
    if let Some(bounds_check) = &site.bounds_check {
        message.push_str(&format!(
            "; bounds check at {:#x}",
            bounds_check.instruction_address
        ));
    }
    Diagnostic::info(message)
}

fn unresolved_edge_diagnostic(edge: &UnresolvedEdge) -> Diagnostic {
    let kind = edge.kind_label();
    let message = match edge.reason {
        UnresolvedEdgeReason::MissingSourceBlock => format!(
            "{kind} from missing source block {} could not be linked",
            edge.edge.from.0
        ),
        UnresolvedEdgeReason::MissingDestinationBlock => format!(
            "{kind} from block {} targets missing destination block {}",
            edge.edge.from.0,
            edge.edge.to.map(|to| to.0).unwrap_or_default()
        ),
        UnresolvedEdgeReason::MissingTarget => {
            format!(
                "{kind} from block {} has no resolved target",
                edge.edge.from.0
            )
        }
        UnresolvedEdgeReason::TargetBlockNotLinked => format!(
            "{kind} from block {} targets known block start {:#x} but is not linked to it",
            edge.edge.from.0,
            edge.edge.target.unwrap_or_default()
        ),
        UnresolvedEdgeReason::InteriorTarget => format!(
            "{kind} from block {} targets the interior of {:#x}; block splitting is required",
            edge.edge.from.0,
            edge.edge.target.unwrap_or_default()
        ),
        UnresolvedEdgeReason::UnresolvedTarget => format!(
            "{kind} from block {} targets {:#x}, which is not a decoded block boundary",
            edge.edge.from.0,
            edge.edge.target.unwrap_or_default()
        ),
    };
    let message = format!("{message} ({})", edge.reason.label());

    let offset = edge.edge.target.and_then(|target| {
        if matches!(
            edge.reason,
            UnresolvedEdgeReason::MissingSourceBlock
                | UnresolvedEdgeReason::MissingDestinationBlock
        ) {
            None
        } else {
            Some(target)
        }
    });
    match edge.reason {
        UnresolvedEdgeReason::MissingSourceBlock
        | UnresolvedEdgeReason::MissingDestinationBlock => Diagnostic::error(message, None),
        _ => Diagnostic::warning(message, offset),
    }
}

impl UnresolvedEdge {
    fn kind_label(&self) -> &'static str {
        match self.edge.kind {
            EdgeKind::Jump => "jump edge",
            EdgeKind::Call => "call edge",
            EdgeKind::Fallthrough => "fallthrough edge",
            EdgeKind::Return => "return edge",
            EdgeKind::Syscall => "syscall edge",
            EdgeKind::Unknown => "edge",
        }
    }
}

fn control_flow_kind_label(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Jump => "indirect jump",
        EdgeKind::Call => "indirect call",
        _ => "indirect control flow",
    }
}

fn edge_kind_requires_target(kind: EdgeKind) -> bool {
    matches!(
        kind,
        EdgeKind::Fallthrough | EdgeKind::Jump | EdgeKind::Call
    )
}

fn unresolved_edge_reason(
    edge: &Edge,
    block_ids: &BTreeSet<usize>,
    block_addresses: &BTreeMap<u64, usize>,
    ranges: &[(u64, u64, u64)],
) -> Option<UnresolvedEdgeReason> {
    if !block_ids.contains(&edge.from.0) {
        return Some(UnresolvedEdgeReason::MissingSourceBlock);
    }

    if let Some(to) = edge.to {
        if !block_ids.contains(&to.0) {
            return Some(UnresolvedEdgeReason::MissingDestinationBlock);
        }
        return None;
    }

    if edge.target.is_none() {
        return edge_kind_requires_target(edge.kind).then_some(UnresolvedEdgeReason::MissingTarget);
    }

    let target = edge.target?;
    if block_addresses.contains_key(&target) {
        return Some(UnresolvedEdgeReason::TargetBlockNotLinked);
    }

    if ranges
        .iter()
        .any(|(start, end, _)| *start < target && target < *end)
    {
        return Some(UnresolvedEdgeReason::InteriorTarget);
    }

    Some(UnresolvedEdgeReason::UnresolvedTarget)
}

fn unresolved_edge_confidence(reason: UnresolvedEdgeReason) -> CfgConfidence {
    let score = match reason {
        UnresolvedEdgeReason::MissingSourceBlock => 0,
        UnresolvedEdgeReason::MissingDestinationBlock => 0,
        UnresolvedEdgeReason::MissingTarget => 20,
        UnresolvedEdgeReason::TargetBlockNotLinked => 45,
        UnresolvedEdgeReason::InteriorTarget => 35,
        UnresolvedEdgeReason::UnresolvedTarget => 25,
    };
    CfgConfidence::new(score)
}

fn unresolved_edge_penalty(reason: UnresolvedEdgeReason) -> i32 {
    match reason {
        UnresolvedEdgeReason::MissingSourceBlock => 30,
        UnresolvedEdgeReason::MissingDestinationBlock => 30,
        UnresolvedEdgeReason::MissingTarget => 24,
        UnresolvedEdgeReason::TargetBlockNotLinked => 0,
        UnresolvedEdgeReason::InteriorTarget => 16,
        UnresolvedEdgeReason::UnresolvedTarget => 20,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegisterConstant {
    value: u64,
    definition_block: BasicBlockId,
    definition_address: u64,
}

type RegisterState = BTreeMap<Register, RegisterConstant>;

fn build_control_flow_graph(module: &Module, entry: BasicBlockId) -> ControlFlowGraph {
    let mut diagnostics = Vec::new();
    let mut block_ids = BTreeSet::new();
    let mut block_addresses = BTreeMap::new();
    let mut ranges = Vec::new();
    let mut blocks = Vec::new();
    let mut edges = Vec::new();
    let mut block_lookup = HashMap::new();
    let mut block_by_address = HashMap::new();

    for function in &module.functions {
        for block in &function.blocks {
            blocks.push(block.id);
            block_lookup.insert(block.id, block);
            block_by_address.insert(block.address, block.id);
            if !block_ids.insert(block.id.0) {
                diagnostics.push(Diagnostic::error(
                    format!("duplicate basic-block id {}", block.id.0),
                    Some(block.file_offset),
                ));
            }
            if let Some(previous) = block_addresses.insert(block.address, block.id.0) {
                diagnostics.push(Diagnostic::error(
                    format!(
                        "duplicate basic-block address {:#x} for ids {} and {}",
                        block.address, previous, block.id.0
                    ),
                    Some(block.file_offset),
                ));
            }
            if block.instructions.is_empty() {
                diagnostics.push(Diagnostic::warning(
                    format!("basic block {:#x} has no instructions", block.address),
                    Some(block.file_offset),
                ));
            }
            if let Some(last) = block.instructions.last() {
                if matches!(last.operation, Operation::Unknown { .. }) {
                    diagnostics.push(Diagnostic::warning(
                        format!(
                            "basic block {:#x} ends in an unknown instruction",
                            block.address
                        ),
                        Some(last.file_offset),
                    ));
                }
            }
            ranges.push((block.address, block.end_address(), block.file_offset));
            edges.extend(block.edges.iter().cloned());
        }
    }

    ranges.sort_unstable_by_key(|(start, _, _)| *start);
    for window in ranges.windows(2) {
        if window[0].1 > window[1].0 {
            diagnostics.push(Diagnostic::error(
                format!(
                    "basic-block ranges overlap at {:#x}..{:#x} and {:#x}..{:#x}",
                    window[0].0, window[0].1, window[1].0, window[1].1
                ),
                Some(window[1].2),
            ));
        }
    }

    let block_states = block_states(module, &blocks, &block_lookup, &block_by_address, entry);
    let function_bounds = module.entry_function().and_then(function_bounds);
    let bounds_check_states =
        bounds_check_states(module, &blocks, &block_lookup, &block_by_address, entry);
    let mut indirect_control_flows = Vec::new();
    let mut jump_table_recoveries = Vec::new();
    let mut bounds_checks = Vec::new();
    let mut unresolved_edges = Vec::new();

    for block_id in &blocks {
        let Some(block) = block_lookup.get(block_id) else {
            continue;
        };
        let mut register_state = block_states.get(block_id).cloned().unwrap_or_default();
        let mut last_bounds_check = bounds_check_states
            .get(block_id)
            .cloned()
            .unwrap_or_default();

        for instruction in &block.instructions {
            if let Some(pattern) = bounds_check_pattern(
                *block_id,
                instruction,
                &register_state,
                last_bounds_check.as_ref(),
            ) {
                bounds_checks.push(pattern.clone());
                last_bounds_check = Some(pattern);
            }

            if let Some(kind) = instruction.operation.indirect_control_flow_kind() {
                if let Some(operand) = instruction.operation.indirect_control_flow_operand() {
                    let base_trace = jump_table_base_trace(operand, &register_state);
                    let table_address = operand
                        .as_memory()
                        .and_then(MemoryOperand::rip_relative_target)
                        .or_else(|| base_trace.as_ref().map(|trace| trace.value));
                    let confidence = site_confidence(
                        instruction,
                        base_trace.as_ref(),
                        last_bounds_check.as_ref(),
                    );
                    let recovery_kind = classify_recovery_kind(
                        module,
                        instruction,
                        kind,
                        operand,
                        base_trace.as_ref(),
                    );
                    if let Some(candidate) = &instruction.jump_table {
                        if let ControlFlowOperand::Memory(memory) = operand {
                            jump_table_recoveries.push(JumpTableRecovery {
                                block: *block_id,
                                instruction_address: instruction.address,
                                file_offset: instruction.file_offset,
                                kind,
                                operand: memory.clone(),
                                candidate: candidate.clone(),
                                base_trace: base_trace.clone(),
                                bounds_check: last_bounds_check.clone(),
                                confidence,
                            });
                        }
                    } else {
                        indirect_control_flows.push(IndirectControlFlow {
                            block: *block_id,
                            instruction_address: instruction.address,
                            file_offset: instruction.file_offset,
                            kind,
                            operand: operand.clone(),
                            recovery_kind,
                            confidence,
                            jump_table_base: base_trace.clone(),
                            bounds_check: last_bounds_check.clone(),
                            table_address,
                        });
                    }
                }
            }

            update_register_state(
                &mut register_state,
                block.id,
                instruction.address,
                &instruction.operation,
            );
        }
    }

    diagnostics.extend(
        indirect_control_flows
            .iter()
            .map(indirect_control_flow_diagnostic),
    );
    diagnostics.extend(
        jump_table_recoveries
            .iter()
            .map(jump_table_recovery_diagnostic),
    );
    diagnostics.extend(bounds_checks.iter().map(bounds_check_diagnostic));

    for edge in &edges {
        if let Some(reason) = unresolved_edge_reason(edge, &block_ids, &block_addresses, &ranges) {
            unresolved_edges.push(UnresolvedEdge {
                edge: edge.clone(),
                reason,
                confidence: unresolved_edge_confidence(reason),
            });
        }
    }

    let (classified_edges, import_call_candidates) = classify_edges(
        module,
        &block_lookup,
        &edges,
        &jump_table_recoveries,
        function_bounds,
    );
    diagnostics.extend(unresolved_edges.iter().map(unresolved_edge_diagnostic));

    let confidence = cfg_confidence(
        &classified_edges,
        &indirect_control_flows,
        &jump_table_recoveries,
        &bounds_checks,
        &unresolved_edges,
    );

    ControlFlowGraph {
        entry,
        blocks,
        edges,
        classified_edges,
        import_call_candidates,
        unresolved_edges,
        indirect_control_flows,
        jump_table_recoveries,
        bounds_checks,
        confidence,
        diagnostics,
    }
}

fn block_states(
    module: &Module,
    blocks: &[BasicBlockId],
    block_lookup: &HashMap<BasicBlockId, &BasicBlock>,
    block_by_address: &HashMap<u64, BasicBlockId>,
    entry: BasicBlockId,
) -> HashMap<BasicBlockId, RegisterState> {
    let predecessors = block_predecessors(module, block_by_address);

    let mut incoming: HashMap<BasicBlockId, RegisterState> = blocks
        .iter()
        .copied()
        .map(|block| (block, RegisterState::new()))
        .collect();
    let mut outgoing = incoming.clone();
    let mut changed = true;

    while changed {
        changed = false;
        for block_id in blocks {
            let Some(block) = block_lookup.get(block_id) else {
                continue;
            };
            let new_incoming = if *block_id == entry {
                RegisterState::new()
            } else {
                meet_predecessor_states(
                    predecessors
                        .get(block_id)
                        .into_iter()
                        .flat_map(|preds| preds.iter().filter_map(|pred| outgoing.get(pred))),
                )
            };
            if incoming.get(block_id) != Some(&new_incoming) {
                incoming.insert(*block_id, new_incoming.clone());
                changed = true;
            }

            let new_outgoing = transfer_register_state(block, &new_incoming);
            if outgoing.get(block_id) != Some(&new_outgoing) {
                outgoing.insert(*block_id, new_outgoing);
                changed = true;
            }
        }
    }

    incoming
}

fn bounds_check_states(
    module: &Module,
    blocks: &[BasicBlockId],
    block_lookup: &HashMap<BasicBlockId, &BasicBlock>,
    block_by_address: &HashMap<u64, BasicBlockId>,
    entry: BasicBlockId,
) -> HashMap<BasicBlockId, Option<BoundsCheckPattern>> {
    let predecessors = block_predecessors(module, block_by_address);

    let mut incoming: HashMap<BasicBlockId, Option<BoundsCheckPattern>> =
        blocks.iter().copied().map(|block| (block, None)).collect();
    let mut outgoing = incoming.clone();
    let mut changed = true;

    while changed {
        changed = false;
        for block_id in blocks {
            let Some(block) = block_lookup.get(block_id) else {
                continue;
            };
            let new_incoming = if *block_id == entry {
                None
            } else {
                meet_predecessor_bounds_checks(
                    predecessors
                        .get(block_id)
                        .into_iter()
                        .flat_map(|preds| preds.iter().filter_map(|pred| outgoing.get(pred))),
                )
            };
            if incoming.get(block_id) != Some(&new_incoming) {
                incoming.insert(*block_id, new_incoming.clone());
                changed = true;
            }

            let new_outgoing = transfer_bounds_check_state(block, &new_incoming);
            if outgoing.get(block_id) != Some(&new_outgoing) {
                outgoing.insert(*block_id, new_outgoing);
                changed = true;
            }
        }
    }

    incoming
}

fn block_predecessors(
    module: &Module,
    block_by_address: &HashMap<u64, BasicBlockId>,
) -> HashMap<BasicBlockId, Vec<BasicBlockId>> {
    let mut predecessors: HashMap<BasicBlockId, Vec<BasicBlockId>> = HashMap::new();
    for function in &module.functions {
        for block in &function.blocks {
            for edge in &block.edges {
                if let Some(to) = edge.to.or_else(|| {
                    edge.target
                        .and_then(|target| block_by_address.get(&target).copied())
                }) {
                    predecessors.entry(to).or_default().push(block.id);
                }
            }
        }
    }
    predecessors
}

fn meet_predecessor_states<'a, I>(states: I) -> RegisterState
where
    I: IntoIterator<Item = &'a RegisterState>,
{
    let mut iter = states.into_iter();
    let Some(first) = iter.next() else {
        return RegisterState::new();
    };
    let mut merged = first.clone();
    for state in iter {
        merged.retain(|register, value| state.get(register) == Some(value));
    }
    merged
}

fn meet_predecessor_bounds_checks<'a, I>(states: I) -> Option<BoundsCheckPattern>
where
    I: IntoIterator<Item = &'a Option<BoundsCheckPattern>>,
{
    let mut iter = states.into_iter();
    let first = iter.next()?;
    let merged = first.clone()?;
    for state in iter {
        match state {
            Some(pattern) if *pattern == merged => {}
            _ => return None,
        }
    }
    Some(merged)
}

fn transfer_register_state(block: &BasicBlock, incoming: &RegisterState) -> RegisterState {
    let mut state = incoming.clone();
    for instruction in &block.instructions {
        update_register_state(
            &mut state,
            block.id,
            instruction.address,
            &instruction.operation,
        );
    }
    state
}

fn transfer_bounds_check_state(
    block: &BasicBlock,
    incoming: &Option<BoundsCheckPattern>,
) -> Option<BoundsCheckPattern> {
    let mut state = incoming.clone();
    for instruction in &block.instructions {
        if let Some(pattern) =
            bounds_check_pattern(block.id, instruction, &RegisterState::new(), state.as_ref())
        {
            state = Some(pattern);
        }
    }
    state
}

fn update_register_state(
    state: &mut RegisterState,
    block: BasicBlockId,
    instruction_address: u64,
    operation: &Operation,
) {
    for register in operation.registers_written() {
        state.remove(&register);
    }

    match operation {
        Operation::LoadEffectiveAddress {
            dst,
            address: MemoryOperand::RipRelative { target, .. },
            ..
        } => {
            state.insert(
                *dst,
                RegisterConstant {
                    value: *target,
                    definition_block: block,
                    definition_address: instruction_address,
                },
            );
        }
        Operation::MoveRegister { dst, src, .. } => {
            if let Some(target) = state.get(src).cloned() {
                state.insert(*dst, target);
            }
        }
        _ => {}
    }
}

fn bounds_check_pattern(
    block: BasicBlockId,
    instruction: &crate::ir::Instruction,
    state: &RegisterState,
    previous: Option<&BoundsCheckPattern>,
) -> Option<BoundsCheckPattern> {
    let confidence = if previous.is_some() {
        CfgConfidence::new(70)
    } else {
        CfgConfidence::new(55)
    };
    match &instruction.operation {
        Operation::CompareRegisterImmediate {
            register, value, ..
        } => Some(BoundsCheckPattern {
            block,
            instruction_address: instruction.address,
            file_offset: instruction.file_offset,
            condition: None,
            left: BoundsCheckTerm::Register(*register),
            right: BoundsCheckTerm::Immediate(*value),
            branch_target: None,
            confidence,
        }),
        Operation::CompareRegisterRegister { left, right, .. } => Some(BoundsCheckPattern {
            block,
            instruction_address: instruction.address,
            file_offset: instruction.file_offset,
            condition: None,
            left: BoundsCheckTerm::Register(*left),
            right: BoundsCheckTerm::Register(*right),
            branch_target: None,
            confidence,
        }),
        Operation::TestRegisterRegister { left, right, .. } => Some(BoundsCheckPattern {
            block,
            instruction_address: instruction.address,
            file_offset: instruction.file_offset,
            condition: None,
            left: BoundsCheckTerm::Register(*left),
            right: BoundsCheckTerm::Register(*right),
            branch_target: None,
            confidence,
        }),
        Operation::ConditionalJump { condition, target } => {
            previous.map(|pattern| BoundsCheckPattern {
                block,
                instruction_address: instruction.address,
                file_offset: instruction.file_offset,
                condition: Some(*condition),
                left: pattern.left.clone(),
                right: pattern.right.clone(),
                branch_target: Some(*target),
                confidence: CfgConfidence::new(pattern.confidence.score.saturating_add(10)),
            })
        }
        _ => {
            let _ = state;
            None
        }
    }
}

fn jump_table_base_trace(
    operand: &ControlFlowOperand,
    state: &RegisterState,
) -> Option<JumpTableBaseTrace> {
    let memory = operand.as_memory()?;
    let register = memory.base_register()?;
    let base = state.get(&register)?;
    let value = match memory {
        MemoryOperand::RipRelative { target, .. } => *target,
        MemoryOperand::BaseDisplacement { displacement, .. } => {
            if *displacement >= 0 {
                base.value.checked_add(*displacement as u64)?
            } else {
                base.value.checked_sub(displacement.checked_abs()? as u64)?
            }
        }
        MemoryOperand::BaseIndexScaleDisplacement {
            base, displacement, ..
        } => {
            let base_register = base.or(Some(register))?;
            let base = state.get(&base_register)?;
            if *displacement >= 0 {
                base.value.checked_add(*displacement as u64)?
            } else {
                base.value.checked_sub(displacement.checked_abs()? as u64)?
            }
        }
        MemoryOperand::SegmentDisplacement { .. } | MemoryOperand::Unsupported { .. } => {
            return None
        }
    };

    Some(JumpTableBaseTrace {
        register,
        value,
        definition_block: base.definition_block,
        definition_address: base.definition_address,
    })
}

fn classify_recovery_kind(
    module: &Module,
    instruction: &crate::ir::Instruction,
    _kind: EdgeKind,
    operand: &ControlFlowOperand,
    _base_trace: Option<&JumpTableBaseTrace>,
) -> ControlFlowRecoveryKind {
    if instruction.jump_table.is_some() {
        return ControlFlowRecoveryKind::JumpTable;
    }
    if let Some(target) = target_memory_address(operand) {
        if matches_import_target(module, target) {
            return ControlFlowRecoveryKind::Iat;
        }
        if module
            .metadata
            .elf_plt
            .as_ref()
            .is_some_and(|plt| plt.got_address == Some(target))
        {
            return ControlFlowRecoveryKind::Plt;
        }
    }
    ControlFlowRecoveryKind::Indirect
}

fn target_memory_address(operand: &ControlFlowOperand) -> Option<u64> {
    let memory = operand.as_memory()?;
    memory.rip_relative_target()
}

fn matches_import_target(module: &Module, address: u64) -> bool {
    module.metadata.imports.iter().any(|import| {
        import.address_table_address == address
            || import.lookup_table_address == Some(address)
            || import.bound_address_table_address == Some(address)
            || import.unload_address_table_address == Some(address)
            || import.entries.iter().any(|entry| {
                entry.address_table_address == address || entry.lookup_address == Some(address)
            })
    })
}

fn classify_edges(
    module: &Module,
    block_lookup: &HashMap<BasicBlockId, &BasicBlock>,
    edges: &[Edge],
    jump_table_recoveries: &[JumpTableRecovery],
    function_bounds: Option<(u64, u64)>,
) -> (Vec<ClassifiedEdge>, Vec<ImportCallCandidate>) {
    let mut jump_table_sources = HashSet::new();
    for recovery in jump_table_recoveries {
        jump_table_sources.insert(recovery.block);
    }

    let mut classified_edges = Vec::with_capacity(edges.len());
    let mut import_call_candidates = Vec::new();

    for edge in edges.iter().cloned() {
        let classification = if let Some(block) = edge.to.and_then(|to| block_lookup.get(&to)) {
            classify_target_block(module, block).unwrap_or_else(|| {
                classify_source_edge(
                    module,
                    block_lookup.get(&edge.from).copied(),
                    &edge,
                    &jump_table_sources,
                    function_bounds,
                )
            })
        } else if let Some(block) = block_lookup.get(&edge.from) {
            classify_source_edge(
                module,
                Some(*block),
                &edge,
                &jump_table_sources,
                function_bounds,
            )
        } else {
            EdgeRecoveryKind::Unknown
        };
        let confidence = match classification {
            EdgeRecoveryKind::JumpTable | EdgeRecoveryKind::Plt | EdgeRecoveryKind::Iat => {
                CfgConfidence::new(90)
            }
            EdgeRecoveryKind::Thunk | EdgeRecoveryKind::TailCall => CfgConfidence::new(70),
            EdgeRecoveryKind::Direct | EdgeRecoveryKind::IntraFunctionJump => {
                CfgConfidence::new(80)
            }
            EdgeRecoveryKind::Indirect => CfgConfidence::new(45),
            EdgeRecoveryKind::Unknown => CfgConfidence::new(25),
        };

        if edge.kind == EdgeKind::Call
            && matches!(
                classification,
                EdgeRecoveryKind::Thunk | EdgeRecoveryKind::Plt | EdgeRecoveryKind::Iat
            )
        {
            import_call_candidates.push(ImportCallCandidate {
                edge: edge.clone(),
                recovery_kind: classification.clone(),
                confidence: confidence.clone(),
            });
        }

        classified_edges.push(ClassifiedEdge {
            edge,
            recovery_kind: classification,
            confidence,
        });
    }

    (classified_edges, import_call_candidates)
}

fn classify_target_block(module: &Module, block: &BasicBlock) -> Option<EdgeRecoveryKind> {
    let first = block.instructions.first()?;
    match &first.operation {
        Operation::IndirectJump { target } | Operation::IndirectCall { target } => {
            let memory = target.as_memory()?;
            if let Some(address) = memory.rip_relative_target() {
                if matches_import_target(module, address) {
                    return Some(EdgeRecoveryKind::Iat);
                }
                if module
                    .metadata
                    .elf_plt
                    .as_ref()
                    .is_some_and(|plt| plt.got_address == Some(address))
                {
                    return Some(EdgeRecoveryKind::Plt);
                }
            }
            Some(EdgeRecoveryKind::Thunk)
        }
        _ => None,
    }
}

fn classify_source_edge(
    module: &Module,
    block: Option<&BasicBlock>,
    edge: &Edge,
    jump_table_sources: &HashSet<BasicBlockId>,
    function_bounds: Option<(u64, u64)>,
) -> EdgeRecoveryKind {
    let Some(block) = block else {
        return EdgeRecoveryKind::Unknown;
    };
    let Some(last) = block.instructions.last() else {
        return EdgeRecoveryKind::Unknown;
    };
    match &last.operation {
        Operation::IndirectJump { target } | Operation::IndirectCall { target } => {
            if jump_table_sources.contains(&block.id) && edge.kind == EdgeKind::Jump {
                return EdgeRecoveryKind::JumpTable;
            }
            if let Some(memory) = target.as_memory() {
                if let Some(address) = memory.rip_relative_target() {
                    if matches_import_target(module, address) {
                        return EdgeRecoveryKind::Iat;
                    }
                    if module
                        .metadata
                        .elf_plt
                        .as_ref()
                        .is_some_and(|plt| plt.got_address == Some(address))
                    {
                        return EdgeRecoveryKind::Plt;
                    }
                }
                if memory.looks_like_jump_table() {
                    return EdgeRecoveryKind::JumpTable;
                }
            }
            return EdgeRecoveryKind::Indirect;
        }
        Operation::DirectCall { .. } if edge.kind == EdgeKind::Call => {
            if let Some(target) = edge.target {
                if let Some(kind) = classify_absolute_target(module, target) {
                    return kind;
                }
            }
        }
        Operation::DirectJump { .. } if edge.kind == EdgeKind::Jump => {
            if let Some(target) = edge.target {
                if let Some(kind) = classify_absolute_target(module, target) {
                    return kind;
                }
                if function_bounds.is_some_and(|(start, end)| target >= start && target < end) {
                    return EdgeRecoveryKind::IntraFunctionJump;
                }
            }
            return EdgeRecoveryKind::TailCall;
        }
        _ => {}
    }
    EdgeRecoveryKind::Direct
}

fn classify_absolute_target(module: &Module, target: u64) -> Option<EdgeRecoveryKind> {
    if matches_import_target(module, target) {
        return Some(EdgeRecoveryKind::Iat);
    }
    if module
        .metadata
        .elf_plt
        .as_ref()
        .is_some_and(|plt| plt.got_address == Some(target))
    {
        return Some(EdgeRecoveryKind::Plt);
    }
    None
}

fn function_bounds(function: &crate::ir::Function) -> Option<(u64, u64)> {
    let start = function.blocks.iter().map(|block| block.address).min()?;
    let end = function.blocks.iter().map(BasicBlock::end_address).max()?;
    Some((start, end))
}

fn site_confidence(
    instruction: &crate::ir::Instruction,
    base_trace: Option<&JumpTableBaseTrace>,
    bounds_check: Option<&BoundsCheckPattern>,
) -> CfgConfidence {
    let mut score = if instruction.jump_table.is_some() {
        85
    } else {
        40
    };
    if base_trace.is_some() {
        score += 15;
    }
    if bounds_check.is_some() {
        score += 10;
    }
    CfgConfidence::new(score)
}

fn cfg_confidence(
    classified_edges: &[ClassifiedEdge],
    indirect_control_flows: &[IndirectControlFlow],
    jump_table_recoveries: &[JumpTableRecovery],
    bounds_checks: &[BoundsCheckPattern],
    unresolved_edges: &[UnresolvedEdge],
) -> CfgConfidence {
    let mut score: i32 = 50;
    score += (jump_table_recoveries.len() as i32) * 10;
    score += (bounds_checks.len() as i32) * 5;
    score += (indirect_control_flows
        .iter()
        .filter(|site| matches!(site.recovery_kind, ControlFlowRecoveryKind::JumpTable))
        .count() as i32)
        * 10;
    score += (indirect_control_flows
        .iter()
        .filter(|site| site.jump_table_base.is_some())
        .count() as i32)
        * 10;
    score += (indirect_control_flows
        .iter()
        .filter(|site| {
            matches!(
                site.recovery_kind,
                ControlFlowRecoveryKind::Thunk
                    | ControlFlowRecoveryKind::Plt
                    | ControlFlowRecoveryKind::Iat
            )
        })
        .count() as i32)
        * 4;
    score -= (indirect_control_flows
        .iter()
        .filter(|site| matches!(site.recovery_kind, ControlFlowRecoveryKind::Indirect))
        .count() as i32)
        * 10;
    score -= unresolved_edges
        .iter()
        .map(|edge| unresolved_edge_penalty(edge.reason))
        .sum::<i32>();
    score += classified_edges
        .iter()
        .filter(|edge| {
            matches!(
                edge.recovery_kind,
                EdgeRecoveryKind::JumpTable
                    | EdgeRecoveryKind::Plt
                    | EdgeRecoveryKind::Iat
                    | EdgeRecoveryKind::IntraFunctionJump
            )
        })
        .count() as i32
        * 3;
    CfgConfidence::new(score.clamp(0, 100) as u8)
}

fn bounds_check_diagnostic(site: &BoundsCheckPattern) -> Diagnostic {
    let condition = site
        .condition
        .map(|condition| format!(" with condition {:?}", condition))
        .unwrap_or_default();
    Diagnostic::info(format!(
        "bounds check at {:#x}{condition} (confidence {:?}:{})",
        site.instruction_address,
        site.confidence.tier(),
        site.confidence.score
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::DiagnosticSeverity;
    use crate::format::{
        Architecture, BinaryFormat, ElfPltMetadata, Import, ImportEntry, ImportKind,
    };
    use crate::ir::{
        BasicBlock, BasicBlockId, ControlFlowOperand, Edge, EdgeKind, Function, Instruction,
        JumpTableCandidate, JumpTableEntry, MemoryOperand, Module, ModuleMetadata, Operation,
        ProcessorFlag, Register, RegisterFamily,
    };

    #[test]
    fn surfaces_indirect_control_flow_operands_and_unresolved_targets() {
        let module = module_with_indirect_call(ControlFlowOperand::Register(Register::Rax));
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert_eq!(graph.indirect_control_flows().len(), 1);
        let site = &graph.indirect_control_flows()[0];
        assert_eq!(site.block, BasicBlockId(0));
        assert_eq!(site.instruction_address, 0x1000);
        assert_eq!(site.kind, EdgeKind::Call);
        assert_eq!(site.operand, ControlFlowOperand::Register(Register::Rax));
        assert_eq!(
            graph.unresolved_dynamic_targets(),
            graph.indirect_control_flows()
        );
        assert!(graph.jump_table_recoveries().is_empty());

        let analysis = ModuleAnalysis::from_module(&module);
        assert!(analysis
            .diagnostics()
            .iter()
            .any(
                |diagnostic| diagnostic.severity == DiagnosticSeverity::Warning
                    && diagnostic.message.contains("unresolved register target")
            ));
    }

    #[test]
    fn surfaces_recovered_jump_table_candidates_without_claiming_unresolved_targets() {
        let module = module_with_indirect_jump(ControlFlowOperand::Memory(
            MemoryOperand::BaseIndexScaleDisplacement {
                base: None,
                index: Register::Rax,
                scale: 8,
                displacement: 0x20,
                width_bits: 64,
            },
        ));
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert_eq!(graph.indirect_control_flows().len(), 1);
        assert_eq!(graph.jump_table_recoveries().len(), 0);

        let analysis = ModuleAnalysis::from_module(&module);
        assert!(analysis
            .diagnostics()
            .iter()
            .any(
                |diagnostic| diagnostic.severity == DiagnosticSeverity::Warning
                    && diagnostic.message.contains("unresolved memory target")
            ));
        assert!(!analysis
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Info
                && diagnostic.message.contains("recovered jump table")));
    }

    #[test]
    fn surfaces_recovered_jump_table_candidates_and_edges() {
        let module = module_with_recovered_jump_table();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert!(graph.indirect_control_flows().is_empty());
        assert_eq!(graph.jump_table_recoveries().len(), 1);
        let recovery = &graph.jump_table_recoveries()[0];
        assert_eq!(recovery.kind, EdgeKind::Jump);
        assert_eq!(recovery.candidate.table_address, 0x402000);
        assert!(recovery.bounds_check.is_some());
        assert_eq!(
            recovery.bounds_check.as_ref().expect("bounds check").block,
            BasicBlockId(0)
        );
        assert_eq!(
            recovery
                .bounds_check
                .as_ref()
                .expect("bounds check")
                .condition,
            Some(crate::ir::ConditionCode::Above)
        );
        assert_eq!(
            recovery.candidate.entries,
            vec![
                JumpTableEntry {
                    index: 0,
                    target: 0x401030,
                },
                JumpTableEntry {
                    index: 1,
                    target: 0x401040,
                },
                JumpTableEntry {
                    index: 2,
                    target: 0x401050,
                },
            ]
        );
        assert!(graph
            .edges
            .iter()
            .filter(|edge| edge.from == BasicBlockId(1))
            .any(|edge| edge.kind == EdgeKind::Jump && edge.target == Some(0x401030)));
        assert!(graph
            .edges
            .iter()
            .filter(|edge| edge.from == BasicBlockId(1))
            .any(|edge| edge.kind == EdgeKind::Jump && edge.target == Some(0x401040)));
        assert!(graph
            .edges
            .iter()
            .filter(|edge| edge.from == BasicBlockId(1))
            .any(|edge| edge.kind == EdgeKind::Jump && edge.target == Some(0x401050)));

        let analysis = ModuleAnalysis::from_module(&module);
        assert!(analysis
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Info
                && diagnostic.message.contains("recovered jump table")));
    }

    #[test]
    fn tracks_cross_block_jump_table_base_and_confidence() {
        let module = module_with_cross_block_jump_table_base();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert_eq!(graph.indirect_control_flows().len(), 1);
        let site = &graph.indirect_control_flows()[0];
        assert_eq!(site.recovery_kind, ControlFlowRecoveryKind::Indirect);
        assert_eq!(site.table_address, Some(0x402000));
        assert_eq!(
            site.jump_table_base
                .as_ref()
                .expect("base trace")
                .definition_block,
            BasicBlockId(0)
        );
        assert!(graph.confidence().score >= 50);
    }

    #[test]
    fn classifies_import_thunk_edges_when_metadata_exists() {
        let module = module_with_import_thunk();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert!(graph
            .classified_edges()
            .iter()
            .any(|edge| edge.edge.from == BasicBlockId(0)
                && edge.recovery_kind == EdgeRecoveryKind::Iat));
    }

    #[test]
    fn classifies_plt_edges_when_metadata_exists() {
        let module = module_with_plt_thunk();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert!(graph
            .classified_edges()
            .iter()
            .any(|edge| edge.edge.from == BasicBlockId(0)
                && edge.recovery_kind == EdgeRecoveryKind::Plt));
    }

    #[test]
    fn surfaces_import_call_candidates_for_thunks() {
        let module = module_with_import_entry_thunk();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert!(graph
            .classified_edges()
            .iter()
            .any(|edge| edge.edge.from == BasicBlockId(0)
                && edge.recovery_kind == EdgeRecoveryKind::Iat));
        assert!(graph
            .import_call_candidates()
            .iter()
            .any(|candidate| candidate.edge.from == BasicBlockId(0)
                && candidate.edge.kind == EdgeKind::Call
                && candidate.recovery_kind == EdgeRecoveryKind::Iat));
    }

    #[test]
    fn distinguishes_intra_function_jumps_from_tail_calls() {
        let module = module_with_intra_function_jump();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert!(graph
            .classified_edges()
            .iter()
            .any(|edge| edge.edge.from == BasicBlockId(0)
                && edge.recovery_kind == EdgeRecoveryKind::IntraFunctionJump));
    }

    #[test]
    fn classifies_tailcall_edges_conservatively() {
        let module = module_with_tailcall_edge();
        let graph = ControlFlowGraph::from_module(&module).expect("graph should build");

        assert!(graph
            .classified_edges()
            .iter()
            .any(|edge| edge.recovery_kind == EdgeRecoveryKind::TailCall));
    }

    #[test]
    fn summarizes_basic_block_def_use_and_function_liveness() {
        let module = module_with_liveness_chain();
        let analysis = ModuleAnalysis::from_module(&module);
        let dataflow = analysis.dataflow();
        let function = dataflow.function(0x1000).expect("function dataflow");
        let entry = function
            .block(BasicBlockId(0))
            .expect("entry block summary");
        let successor = function.block(BasicBlockId(1)).expect("successor summary");

        assert!(entry.uses.registers.contains(&RegisterFamily::Rax));
        assert!(entry.defs.flags.contains(&ProcessorFlag::Zero));
        assert!(entry.live_in.registers.contains(&RegisterFamily::Rax));
        assert!(entry.live_out.registers.contains(&RegisterFamily::Rax));
        assert!(!entry.live_out.flags.is_empty());
        assert!(entry.live_in.flags.is_empty());

        assert!(successor.live_in.registers.contains(&RegisterFamily::Rax));
        assert!(successor.live_in.flags.contains(&ProcessorFlag::Zero));
    }

    #[test]
    fn flags_aware_block_entry_checks_report_live_in_clobbers() {
        let module = module_with_liveness_chain();
        let analysis = ModuleAnalysis::from_module(&module);
        let dataflow = analysis.dataflow();
        let block = dataflow
            .block_by_address(0x1000)
            .expect("entry block summary");

        let diagnostics = block.unsafe_insertion_diagnostics(&Operation::SetRegisterImmediate {
            register: Register::Rax,
            value: 0,
            width_bits: 64,
        });

        assert!(diagnostics.iter().any(|diagnostic| diagnostic
            .message
            .contains("clobbers resources live at block entry")));
    }

    fn module_with_indirect_call(target: ControlFlowOperand) -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: Default::default(),
            functions: vec![Function {
                entry: 0x1000,
                blocks: vec![BasicBlock {
                    id: BasicBlockId(0),
                    address: 0x1000,
                    file_offset: 0x200,
                    instructions: vec![Instruction {
                        address: 0x1000,
                        file_offset: 0x200,
                        bytes: vec![0xff, 0xd0],
                        operation: Operation::IndirectCall { target },
                        jump_table: None,
                        diagnostics: Vec::new(),
                    }],
                    edges: vec![Edge {
                        from: BasicBlockId(0),
                        to: None,
                        target: None,
                        kind: EdgeKind::Unknown,
                    }],
                }],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_indirect_jump(target: ControlFlowOperand) -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: Default::default(),
            functions: vec![Function {
                entry: 0x1000,
                blocks: vec![BasicBlock {
                    id: BasicBlockId(0),
                    address: 0x1000,
                    file_offset: 0x200,
                    instructions: vec![Instruction {
                        address: 0x1000,
                        file_offset: 0x200,
                        bytes: vec![0xff, 0x24, 0xc5, 0x20, 0x00, 0x00, 0x00],
                        operation: Operation::IndirectJump { target },
                        jump_table: None,
                        diagnostics: Vec::new(),
                    }],
                    edges: vec![Edge {
                        from: BasicBlockId(0),
                        to: None,
                        target: None,
                        kind: EdgeKind::Unknown,
                    }],
                }],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_recovered_jump_table() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x401000,
            metadata: Default::default(),
            functions: vec![Function {
                entry: 0x401000,
                blocks: vec![
                    BasicBlock {
                        id: BasicBlockId(0),
                        address: 0x401000,
                        file_offset: 0x1000,
                        instructions: vec![
                            Instruction {
                                address: 0x401000,
                                file_offset: 0x1000,
                                bytes: vec![0x83, 0xff, 0x02],
                                operation: Operation::CompareRegisterImmediate {
                                    register: Register::Edi,
                                    value: 2,
                                    width_bits: 32,
                                },
                                jump_table: None,
                                diagnostics: Vec::new(),
                            },
                            Instruction {
                                address: 0x401003,
                                file_offset: 0x1003,
                                bytes: vec![0x77, 0x19],
                                operation: Operation::ConditionalJump {
                                    condition: crate::ir::ConditionCode::Above,
                                    target: 0x401020,
                                },
                                jump_table: None,
                                diagnostics: Vec::new(),
                            },
                        ],
                        edges: vec![
                            Edge {
                                from: BasicBlockId(0),
                                to: None,
                                target: Some(0x401020),
                                kind: EdgeKind::Jump,
                            },
                            Edge {
                                from: BasicBlockId(0),
                                to: None,
                                target: Some(0x401005),
                                kind: EdgeKind::Fallthrough,
                            },
                        ],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x401005,
                        file_offset: 0x1005,
                        instructions: vec![
                            Instruction {
                                address: 0x401005,
                                file_offset: 0x1005,
                                bytes: vec![0x48, 0x8d, 0x15, 0x74, 0x00, 0x00, 0x00],
                                operation: Operation::LoadEffectiveAddress {
                                    dst: Register::Rdx,
                                    address: MemoryOperand::RipRelative {
                                        target: 0x402000,
                                        width_bits: 64,
                                    },
                                    width_bits: 64,
                                },
                                jump_table: None,
                                diagnostics: Vec::new(),
                            },
                            Instruction {
                                address: 0x40100c,
                                file_offset: 0x100c,
                                bytes: vec![0xff, 0x24, 0xc2],
                                operation: Operation::IndirectJump {
                                    target: ControlFlowOperand::Memory(
                                        MemoryOperand::BaseIndexScaleDisplacement {
                                            base: Some(Register::Rdx),
                                            index: Register::Rax,
                                            scale: 8,
                                            displacement: 0,
                                            width_bits: 64,
                                        },
                                    ),
                                },
                                jump_table: Some(JumpTableCandidate {
                                    table_address: 0x402000,
                                    table_file_offset: 0x2000,
                                    entry_size_bytes: 8,
                                    entries: vec![
                                        JumpTableEntry {
                                            index: 0,
                                            target: 0x401030,
                                        },
                                        JumpTableEntry {
                                            index: 1,
                                            target: 0x401040,
                                        },
                                        JumpTableEntry {
                                            index: 2,
                                            target: 0x401050,
                                        },
                                    ],
                                }),
                                diagnostics: Vec::new(),
                            },
                        ],
                        edges: vec![
                            Edge {
                                from: BasicBlockId(1),
                                to: None,
                                target: Some(0x401030),
                                kind: EdgeKind::Jump,
                            },
                            Edge {
                                from: BasicBlockId(1),
                                to: None,
                                target: Some(0x401040),
                                kind: EdgeKind::Jump,
                            },
                            Edge {
                                from: BasicBlockId(1),
                                to: None,
                                target: Some(0x401050),
                                kind: EdgeKind::Jump,
                            },
                        ],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_cross_block_jump_table_base() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x401000,
            metadata: ModuleMetadata::default(),
            functions: vec![Function {
                entry: 0x401000,
                blocks: vec![
                    BasicBlock {
                        id: BasicBlockId(0),
                        address: 0x401000,
                        file_offset: 0x1000,
                        instructions: vec![Instruction {
                            address: 0x401000,
                            file_offset: 0x1000,
                            bytes: vec![0x48, 0x8d, 0x15, 0x00, 0x00, 0x00, 0x00],
                            operation: Operation::LoadEffectiveAddress {
                                dst: Register::Rdx,
                                address: MemoryOperand::RipRelative {
                                    target: 0x402000,
                                    width_bits: 64,
                                },
                                width_bits: 64,
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(0),
                            to: None,
                            target: Some(0x401008),
                            kind: EdgeKind::Fallthrough,
                        }],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x401008,
                        file_offset: 0x1008,
                        instructions: vec![Instruction {
                            address: 0x401008,
                            file_offset: 0x1008,
                            bytes: vec![0xff, 0x24, 0xc2],
                            operation: Operation::IndirectJump {
                                target: ControlFlowOperand::Memory(
                                    MemoryOperand::BaseIndexScaleDisplacement {
                                        base: Some(Register::Rdx),
                                        index: Register::Rax,
                                        scale: 8,
                                        displacement: 0,
                                        width_bits: 64,
                                    },
                                ),
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(1),
                            to: None,
                            target: None,
                            kind: EdgeKind::Unknown,
                        }],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_liveness_chain() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: ModuleMetadata::default(),
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
                                register: Register::Rax,
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
                                dst: Register::Rdx,
                                src: ControlFlowOperand::Register(Register::Rax),
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

    fn module_with_import_thunk() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: ModuleMetadata {
                imports: vec![Import {
                    library: "kernel32.dll".to_string(),
                    kind: ImportKind::Standard,
                    descriptor_address: 0x7000,
                    name_address: 0x7010,
                    lookup_table_address: Some(0x5000),
                    address_table_address: 0x5000,
                    module_handle_address: None,
                    bound_address_table_address: None,
                    unload_address_table_address: None,
                    timestamp: 0,
                    attributes: 0,
                    entries: Vec::new(),
                }],
                elf_plt: None,
            },
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
                            bytes: vec![0xe8, 0xfb, 0x0f, 0x00, 0x00],
                            operation: Operation::DirectCall { target: 0x2000 },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(0),
                            to: Some(BasicBlockId(1)),
                            target: Some(0x2000),
                            kind: EdgeKind::Call,
                        }],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x2000,
                        file_offset: 0x300,
                        instructions: vec![Instruction {
                            address: 0x2000,
                            file_offset: 0x300,
                            bytes: vec![0xff, 0x25, 0xfa, 0x2f, 0x00, 0x00],
                            operation: Operation::IndirectJump {
                                target: ControlFlowOperand::Memory(MemoryOperand::RipRelative {
                                    target: 0x5000,
                                    width_bits: 64,
                                }),
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(1),
                            to: None,
                            target: None,
                            kind: EdgeKind::Unknown,
                        }],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_import_entry_thunk() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: ModuleMetadata {
                imports: vec![Import {
                    library: "kernel32.dll".to_string(),
                    kind: ImportKind::Standard,
                    descriptor_address: 0x7000,
                    name_address: 0x7010,
                    lookup_table_address: Some(0x4000),
                    address_table_address: 0x5000,
                    module_handle_address: None,
                    bound_address_table_address: None,
                    unload_address_table_address: None,
                    timestamp: 0,
                    attributes: 0,
                    entries: vec![ImportEntry {
                        name: Some("ExitProcess".to_string()),
                        ordinal: None,
                        hint: Some(0),
                        lookup_address: Some(0x4008),
                        address_table_address: 0x5008,
                    }],
                }],
                elf_plt: None,
            },
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
                            bytes: vec![0xe8, 0xfb, 0x0f, 0x00, 0x00],
                            operation: Operation::DirectCall { target: 0x2000 },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(0),
                            to: Some(BasicBlockId(1)),
                            target: Some(0x2000),
                            kind: EdgeKind::Call,
                        }],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x2000,
                        file_offset: 0x300,
                        instructions: vec![Instruction {
                            address: 0x2000,
                            file_offset: 0x300,
                            bytes: vec![0xff, 0x25, 0xfa, 0x2f, 0x00, 0x00],
                            operation: Operation::IndirectJump {
                                target: ControlFlowOperand::Memory(MemoryOperand::RipRelative {
                                    target: 0x5008,
                                    width_bits: 64,
                                }),
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(1),
                            to: None,
                            target: None,
                            kind: EdgeKind::Unknown,
                        }],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_intra_function_jump() -> Module {
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
                            bytes: vec![0xe9, 0x0b, 0x00, 0x00, 0x00],
                            operation: Operation::DirectJump { target: 0x1010 },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(0),
                            to: Some(BasicBlockId(1)),
                            target: Some(0x1010),
                            kind: EdgeKind::Jump,
                        }],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x1010,
                        file_offset: 0x210,
                        instructions: vec![Instruction {
                            address: 0x1010,
                            file_offset: 0x210,
                            bytes: vec![0xc3],
                            operation: Operation::Return,
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(1),
                            to: None,
                            target: None,
                            kind: EdgeKind::Return,
                        }],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_tailcall_edge() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: ModuleMetadata::default(),
            functions: vec![Function {
                entry: 0x1000,
                blocks: vec![BasicBlock {
                    id: BasicBlockId(0),
                    address: 0x1000,
                    file_offset: 0x200,
                    instructions: vec![Instruction {
                        address: 0x1000,
                        file_offset: 0x200,
                        bytes: vec![0xe9, 0xfb, 0xff, 0xff, 0xff],
                        operation: Operation::DirectJump { target: 0x9000 },
                        jump_table: None,
                        diagnostics: Vec::new(),
                    }],
                    edges: vec![Edge {
                        from: BasicBlockId(0),
                        to: None,
                        target: Some(0x9000),
                        kind: EdgeKind::Jump,
                    }],
                }],
            }],
            diagnostics: Vec::new(),
        }
    }

    fn module_with_plt_thunk() -> Module {
        Module {
            format: BinaryFormat::Elf,
            architecture: Architecture::X86_64,
            entry: 0x1000,
            metadata: ModuleMetadata {
                imports: Vec::new(),
                elf_plt: Some(ElfPltMetadata {
                    got_address: Some(0x6000),
                    ..Default::default()
                }),
            },
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
                            bytes: vec![0xe8, 0xfb, 0x0f, 0x00, 0x00],
                            operation: Operation::DirectCall { target: 0x2000 },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(0),
                            to: Some(BasicBlockId(1)),
                            target: Some(0x2000),
                            kind: EdgeKind::Call,
                        }],
                    },
                    BasicBlock {
                        id: BasicBlockId(1),
                        address: 0x2000,
                        file_offset: 0x300,
                        instructions: vec![Instruction {
                            address: 0x2000,
                            file_offset: 0x300,
                            bytes: vec![0xff, 0x25, 0xfa, 0x3f, 0x00, 0x00],
                            operation: Operation::IndirectJump {
                                target: ControlFlowOperand::Memory(MemoryOperand::RipRelative {
                                    target: 0x6000,
                                    width_bits: 64,
                                }),
                            },
                            jump_table: None,
                            diagnostics: Vec::new(),
                        }],
                        edges: vec![Edge {
                            from: BasicBlockId(1),
                            to: None,
                            target: None,
                            kind: EdgeKind::Unknown,
                        }],
                    },
                ],
            }],
            diagnostics: Vec::new(),
        }
    }
}
