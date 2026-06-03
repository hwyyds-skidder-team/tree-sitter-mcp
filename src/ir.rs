use crate::diagnostic::Diagnostic;
use crate::format::{Architecture, BinaryFormat, ElfPltMetadata, Import};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Register {
    Al,
    Cl,
    Dl,
    Bl,
    Spl,
    Bpl,
    Sil,
    Dil,
    R8b,
    R9b,
    R10b,
    R11b,
    R12b,
    R13b,
    R14b,
    R15b,
    Eax,
    Ecx,
    Edx,
    Ebx,
    Esp,
    Ebp,
    Esi,
    Edi,
    R8d,
    R9d,
    R10d,
    R11d,
    R12d,
    R13d,
    R14d,
    R15d,
    Rax,
    Rcx,
    Rdx,
    Rbx,
    Rsp,
    Rbp,
    Rsi,
    Rdi,
    R8,
    R9,
    R10,
    R11,
    R12,
    R13,
    R14,
    R15,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RegisterFamily {
    Rax,
    Rcx,
    Rdx,
    Rbx,
    Rsp,
    Rbp,
    Rsi,
    Rdi,
    R8,
    R9,
    R10,
    R11,
    R12,
    R13,
    R14,
    R15,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum VectorRegister {
    Xmm0,
    Xmm1,
    Xmm2,
    Xmm3,
    Xmm4,
    Xmm5,
    Xmm6,
    Xmm7,
    Xmm8,
    Xmm9,
    Xmm10,
    Xmm11,
    Xmm12,
    Xmm13,
    Xmm14,
    Xmm15,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SegmentRegister {
    Fs,
    Gs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProcessorFlag {
    Carry,
    Parity,
    AuxiliaryCarry,
    Zero,
    Sign,
    Overflow,
    Direction,
    InterruptEnable,
    Trap,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DataflowEffect {
    pub register_reads: BTreeSet<RegisterFamily>,
    pub register_writes: BTreeSet<RegisterFamily>,
    pub vector_register_reads: BTreeSet<VectorRegister>,
    pub vector_register_writes: BTreeSet<VectorRegister>,
    pub flag_reads: BTreeSet<ProcessorFlag>,
    pub flag_writes: BTreeSet<ProcessorFlag>,
    pub has_unknown_side_effects: bool,
}

impl Register {
    pub fn family(self) -> RegisterFamily {
        match self {
            Self::Al | Self::Eax | Self::Rax => RegisterFamily::Rax,
            Self::Cl | Self::Ecx | Self::Rcx => RegisterFamily::Rcx,
            Self::Dl | Self::Edx | Self::Rdx => RegisterFamily::Rdx,
            Self::Bl | Self::Ebx | Self::Rbx => RegisterFamily::Rbx,
            Self::Spl | Self::Esp | Self::Rsp => RegisterFamily::Rsp,
            Self::Bpl | Self::Ebp | Self::Rbp => RegisterFamily::Rbp,
            Self::Sil | Self::Esi | Self::Rsi => RegisterFamily::Rsi,
            Self::Dil | Self::Edi | Self::Rdi => RegisterFamily::Rdi,
            Self::R8b | Self::R8d | Self::R8 => RegisterFamily::R8,
            Self::R9b | Self::R9d | Self::R9 => RegisterFamily::R9,
            Self::R10b | Self::R10d | Self::R10 => RegisterFamily::R10,
            Self::R11b | Self::R11d | Self::R11 => RegisterFamily::R11,
            Self::R12b | Self::R12d | Self::R12 => RegisterFamily::R12,
            Self::R13b | Self::R13d | Self::R13 => RegisterFamily::R13,
            Self::R14b | Self::R14d | Self::R14 => RegisterFamily::R14,
            Self::R15b | Self::R15d | Self::R15 => RegisterFamily::R15,
        }
    }

    pub fn family_root(self) -> Self {
        match self {
            Self::Al | Self::Eax | Self::Rax => Self::Rax,
            Self::Cl | Self::Ecx | Self::Rcx => Self::Rcx,
            Self::Dl | Self::Edx | Self::Rdx => Self::Rdx,
            Self::Bl | Self::Ebx | Self::Rbx => Self::Rbx,
            Self::Spl | Self::Esp | Self::Rsp => Self::Rsp,
            Self::Bpl | Self::Ebp | Self::Rbp => Self::Rbp,
            Self::Sil | Self::Esi | Self::Rsi => Self::Rsi,
            Self::Dil | Self::Edi | Self::Rdi => Self::Rdi,
            Self::R8b | Self::R8d | Self::R8 => Self::R8,
            Self::R9b | Self::R9d | Self::R9 => Self::R9,
            Self::R10b | Self::R10d | Self::R10 => Self::R10,
            Self::R11b | Self::R11d | Self::R11 => Self::R11,
            Self::R12b | Self::R12d | Self::R12 => Self::R12,
            Self::R13b | Self::R13d | Self::R13 => Self::R13,
            Self::R14b | Self::R14d | Self::R14 => Self::R14,
            Self::R15b | Self::R15d | Self::R15 => Self::R15,
        }
    }

    pub fn is_low_byte(self) -> bool {
        matches!(
            self,
            Self::Al
                | Self::Cl
                | Self::Dl
                | Self::Bl
                | Self::Spl
                | Self::Bpl
                | Self::Sil
                | Self::Dil
                | Self::R8b
                | Self::R9b
                | Self::R10b
                | Self::R11b
                | Self::R12b
                | Self::R13b
                | Self::R14b
                | Self::R15b
        )
    }

    pub fn is_zero_extending_32bit(self) -> bool {
        matches!(
            self,
            Self::Eax
                | Self::Ecx
                | Self::Edx
                | Self::Ebx
                | Self::Esp
                | Self::Ebp
                | Self::Esi
                | Self::Edi
                | Self::R8d
                | Self::R9d
                | Self::R10d
                | Self::R11d
                | Self::R12d
                | Self::R13d
                | Self::R14d
                | Self::R15d
        )
    }
}

impl VectorRegister {
    pub fn code(self) -> u8 {
        match self {
            Self::Xmm0 => 0,
            Self::Xmm1 => 1,
            Self::Xmm2 => 2,
            Self::Xmm3 => 3,
            Self::Xmm4 => 4,
            Self::Xmm5 => 5,
            Self::Xmm6 => 6,
            Self::Xmm7 => 7,
            Self::Xmm8 => 8,
            Self::Xmm9 => 9,
            Self::Xmm10 => 10,
            Self::Xmm11 => 11,
            Self::Xmm12 => 12,
            Self::Xmm13 => 13,
            Self::Xmm14 => 14,
            Self::Xmm15 => 15,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Flag {
    Carry,
    Parity,
    AuxiliaryCarry,
    Zero,
    Sign,
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum FlagEffect {
    #[default]
    Unused,
    Read,
    Defined,
    Undefined,
    ReadDefined,
    ReadUndefined,
}

impl FlagEffect {
    pub fn reads(self) -> bool {
        matches!(self, Self::Read | Self::ReadDefined | Self::ReadUndefined)
    }

    pub fn writes(self) -> bool {
        matches!(
            self,
            Self::Defined | Self::Undefined | Self::ReadDefined | Self::ReadUndefined
        )
    }
}

impl From<Flag> for ProcessorFlag {
    fn from(value: Flag) -> Self {
        match value {
            Flag::Carry => Self::Carry,
            Flag::Parity => Self::Parity,
            Flag::AuxiliaryCarry => Self::AuxiliaryCarry,
            Flag::Zero => Self::Zero,
            Flag::Sign => Self::Sign,
            Flag::Overflow => Self::Overflow,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FlagEffects {
    pub carry: FlagEffect,
    pub parity: FlagEffect,
    pub auxiliary_carry: FlagEffect,
    pub zero: FlagEffect,
    pub sign: FlagEffect,
    pub overflow: FlagEffect,
}

impl FlagEffects {
    pub const fn none() -> Self {
        Self {
            carry: FlagEffect::Unused,
            parity: FlagEffect::Unused,
            auxiliary_carry: FlagEffect::Unused,
            zero: FlagEffect::Unused,
            sign: FlagEffect::Unused,
            overflow: FlagEffect::Unused,
        }
    }

    pub fn effect(&self, flag: Flag) -> FlagEffect {
        match flag {
            Flag::Carry => self.carry,
            Flag::Parity => self.parity,
            Flag::AuxiliaryCarry => self.auxiliary_carry,
            Flag::Zero => self.zero,
            Flag::Sign => self.sign,
            Flag::Overflow => self.overflow,
        }
    }

    pub fn read_flags(&self) -> Vec<Flag> {
        [
            Flag::Carry,
            Flag::Parity,
            Flag::AuxiliaryCarry,
            Flag::Zero,
            Flag::Sign,
            Flag::Overflow,
        ]
        .into_iter()
        .filter(|flag| self.effect(*flag).reads())
        .collect()
    }

    pub fn written_flags(&self) -> Vec<Flag> {
        [
            Flag::Carry,
            Flag::Parity,
            Flag::AuxiliaryCarry,
            Flag::Zero,
            Flag::Sign,
            Flag::Overflow,
        ]
        .into_iter()
        .filter(|flag| self.effect(*flag).writes())
        .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConditionCode {
    Overflow,
    NotOverflow,
    Below,
    AboveOrEqual,
    Equal,
    NotEqual,
    BelowOrEqual,
    Above,
    Sign,
    NotSign,
    Parity,
    NotParity,
    Less,
    GreaterOrEqual,
    LessOrEqual,
    Greater,
}

impl ConditionCode {
    pub fn flags_read(self) -> &'static [Flag] {
        match self {
            Self::Overflow | Self::NotOverflow => &[Flag::Overflow],
            Self::Below | Self::AboveOrEqual => &[Flag::Carry],
            Self::Equal | Self::NotEqual => &[Flag::Zero],
            Self::BelowOrEqual | Self::Above => &[Flag::Carry, Flag::Zero],
            Self::Sign | Self::NotSign => &[Flag::Sign],
            Self::Parity | Self::NotParity => &[Flag::Parity],
            Self::Less | Self::GreaterOrEqual => &[Flag::Sign, Flag::Overflow],
            Self::LessOrEqual | Self::Greater => &[Flag::Zero, Flag::Sign, Flag::Overflow],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryOperand {
    RipRelative {
        target: u64,
        width_bits: u8,
    },
    BaseDisplacement {
        base: Register,
        displacement: i32,
        width_bits: u8,
    },
    BaseIndexScaleDisplacement {
        base: Option<Register>,
        index: Register,
        scale: u8,
        displacement: i32,
        width_bits: u8,
    },
    SegmentDisplacement {
        segment: SegmentRegister,
        displacement: i32,
        width_bits: u8,
    },
    Unsupported {
        description: String,
    },
}

impl MemoryOperand {
    pub fn looks_like_jump_table(&self) -> bool {
        matches!(
            self,
            Self::RipRelative { .. }
                | Self::BaseIndexScaleDisplacement {
                    scale: 2 | 4 | 8,
                    ..
                }
        )
    }

    pub fn width_bits(&self) -> u8 {
        match self {
            Self::RipRelative { width_bits, .. }
            | Self::BaseDisplacement { width_bits, .. }
            | Self::BaseIndexScaleDisplacement { width_bits, .. }
            | Self::SegmentDisplacement { width_bits, .. } => *width_bits,
            Self::Unsupported { .. } => 0,
        }
    }

    pub fn rip_relative_target(&self) -> Option<u64> {
        match self {
            Self::RipRelative { target, .. } => Some(*target),
            _ => None,
        }
    }

    pub fn base_register(&self) -> Option<Register> {
        match self {
            Self::BaseDisplacement { base, .. } => Some(*base),
            Self::BaseIndexScaleDisplacement { base, .. } => *base,
            _ => None,
        }
    }

    pub fn registers_read(&self) -> Vec<Register> {
        match self {
            Self::RipRelative { .. }
            | Self::SegmentDisplacement { .. }
            | Self::Unsupported { .. } => Vec::new(),
            Self::BaseDisplacement { base, .. } => vec![*base],
            Self::BaseIndexScaleDisplacement { base, index, .. } => {
                let mut registers = vec![*index];
                if let Some(base) = base {
                    registers.push(*base);
                }
                registers
            }
        }
    }

    pub fn register_families(&self) -> BTreeSet<RegisterFamily> {
        let mut registers = BTreeSet::new();
        match self {
            Self::RipRelative { .. }
            | Self::SegmentDisplacement { .. }
            | Self::Unsupported { .. } => {}
            Self::BaseDisplacement { base, .. } => {
                registers.insert(base.family());
            }
            Self::BaseIndexScaleDisplacement { base, index, .. } => {
                if let Some(base) = base {
                    registers.insert(base.family());
                }
                registers.insert(index.family());
            }
        }
        registers
    }

    pub fn is_supported(&self) -> bool {
        !matches!(self, Self::Unsupported { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlFlowOperand {
    Register(Register),
    Memory(MemoryOperand),
}

impl ControlFlowOperand {
    pub fn as_memory(&self) -> Option<&MemoryOperand> {
        match self {
            Self::Register(_) => None,
            Self::Memory(memory) => Some(memory),
        }
    }

    pub fn registers_read(&self) -> Vec<Register> {
        match self {
            Self::Register(register) => vec![*register],
            Self::Memory(memory) => memory.registers_read(),
        }
    }

    pub fn address_registers(&self) -> Vec<Register> {
        match self {
            Self::Register(_) => Vec::new(),
            Self::Memory(memory) => memory.registers_read(),
        }
    }

    pub fn register_families(&self) -> BTreeSet<RegisterFamily> {
        match self {
            Self::Register(register) => BTreeSet::from([register.family()]),
            Self::Memory(memory) => memory.register_families(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StringRepeatPrefix {
    Rep,
    Repe,
    Repne,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VectorOperand {
    Register(VectorRegister),
    Memory(MemoryOperand),
}

impl VectorOperand {
    pub fn as_memory(&self) -> Option<&MemoryOperand> {
        match self {
            Self::Register(_) => None,
            Self::Memory(memory) => Some(memory),
        }
    }

    pub fn registers_read(&self) -> Vec<Register> {
        match self {
            Self::Register(_) => Vec::new(),
            Self::Memory(memory) => memory.registers_read(),
        }
    }

    pub fn address_registers(&self) -> Vec<Register> {
        match self {
            Self::Register(_) => Vec::new(),
            Self::Memory(memory) => memory.registers_read(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpTableEntry {
    pub index: usize,
    pub target: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpTableCandidate {
    pub table_address: u64,
    pub table_file_offset: u64,
    pub entry_size_bytes: u8,
    pub entries: Vec<JumpTableEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operation {
    Nop,
    NopBytes {
        bytes: Vec<u8>,
    },
    EndBranch {
        width_bits: u8,
    },
    Breakpoint,
    Halt,
    Interrupt {
        vector: u8,
    },
    ClearRegister {
        register: Register,
        width_bits: u8,
    },
    MoveRegister {
        dst: Register,
        src: Register,
        width_bits: u8,
    },
    LoadEffectiveAddress {
        dst: Register,
        address: MemoryOperand,
        width_bits: u8,
    },
    LoadRegisterMemory {
        dst: Register,
        address: MemoryOperand,
        width_bits: u8,
    },
    StoreMemoryImmediate {
        address: MemoryOperand,
        value: i64,
        width_bits: u8,
    },
    StoreMemoryRegister {
        address: MemoryOperand,
        src: Register,
        width_bits: u8,
    },
    SimdMove {
        kind: SimdMoveKind,
        direction: SimdMoveDirection,
        dst: VectorRegister,
        src: VectorOperand,
        width_bits: u8,
    },
    StoreSimdMemoryRegister {
        kind: SimdMoveKind,
        address: MemoryOperand,
        src: VectorRegister,
        width_bits: u8,
    },
    SimdBinary {
        kind: SimdBinaryKind,
        dst: VectorRegister,
        src: VectorOperand,
        width_bits: u8,
    },
    FpuWait,
    FpuNoop,
    FpuInitialize {
        wait: bool,
    },
    FpuClearExceptions {
        wait: bool,
    },
    SetRegisterImmediate {
        register: Register,
        value: u64,
        width_bits: u8,
    },
    AddRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    AndRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    OrRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    XorRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    AddWithCarryOperandImmediate {
        dst: ControlFlowOperand,
        value: i64,
        width_bits: u8,
    },
    AddWithCarryOperandOperand {
        dst: ControlFlowOperand,
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SubtractWithBorrowOperandImmediate {
        dst: ControlFlowOperand,
        value: i64,
        width_bits: u8,
    },
    SubtractWithBorrowOperandOperand {
        dst: ControlFlowOperand,
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SubtractOperandOperand {
        dst: ControlFlowOperand,
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SubRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    CompareRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    TestRegisterImmediate {
        register: Register,
        value: i64,
        width_bits: u8,
    },
    CompareRegisterRegister {
        left: Register,
        right: Register,
        width_bits: u8,
    },
    TestRegisterRegister {
        left: Register,
        right: Register,
        width_bits: u8,
    },
    AndRegisterRegister {
        dst: Register,
        src: Register,
        width_bits: u8,
    },
    OrRegisterRegister {
        dst: Register,
        src: Register,
        width_bits: u8,
    },
    XorRegisterRegister {
        dst: Register,
        src: Register,
        width_bits: u8,
    },
    ShiftLeftRegisterImmediate {
        dst: ControlFlowOperand,
        amount: u8,
        width_bits: u8,
    },
    ShiftRightLogicalRegisterImmediate {
        dst: ControlFlowOperand,
        amount: u8,
        width_bits: u8,
    },
    ShiftRightArithmeticRegisterImmediate {
        dst: ControlFlowOperand,
        amount: u8,
        width_bits: u8,
    },
    ShiftLeftRegisterCl {
        dst: ControlFlowOperand,
        width_bits: u8,
    },
    ShiftRightLogicalRegisterCl {
        dst: ControlFlowOperand,
        width_bits: u8,
    },
    ShiftRightArithmeticRegisterCl {
        dst: ControlFlowOperand,
        width_bits: u8,
    },
    ConditionalMoveRegister {
        condition: ConditionCode,
        dst: Register,
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SetRegisterCondition {
        condition: ConditionCode,
        dst: ControlFlowOperand,
    },
    UnsignedMultiply {
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SignedMultiply {
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SignedMultiplyRegister {
        dst: Register,
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SignedMultiplyRegisterImmediate {
        dst: Register,
        src: ControlFlowOperand,
        value: i64,
        width_bits: u8,
    },
    UnsignedDivide {
        src: ControlFlowOperand,
        width_bits: u8,
    },
    SignedDivide {
        src: ControlFlowOperand,
        width_bits: u8,
    },
    PushRegister {
        register: Register,
        width_bits: u8,
    },
    PopRegister {
        register: Register,
        width_bits: u8,
    },
    PushImmediate {
        value: i64,
        width_bits: u8,
    },
    PushMemory {
        address: MemoryOperand,
        width_bits: u8,
    },
    PopMemory {
        address: MemoryOperand,
        width_bits: u8,
    },
    ExchangeRegisterOperand {
        register: Register,
        operand: ControlFlowOperand,
        width_bits: u8,
    },
    SignExtendRegister {
        dst: Register,
        src: ControlFlowOperand,
        source_width_bits: u8,
        width_bits: u8,
    },
    ZeroExtendRegister {
        dst: Register,
        src: ControlFlowOperand,
        source_width_bits: u8,
        width_bits: u8,
    },
    NotOperand {
        dst: ControlFlowOperand,
        width_bits: u8,
    },
    NegOperand {
        dst: ControlFlowOperand,
        width_bits: u8,
    },
    MoveString {
        prefix: Option<StringRepeatPrefix>,
        width_bits: u8,
    },
    StoreString {
        prefix: Option<StringRepeatPrefix>,
        width_bits: u8,
    },
    CompareString {
        prefix: Option<StringRepeatPrefix>,
        width_bits: u8,
    },
    LeaveFrame,
    Syscall,
    Return,
    ReturnWithStackAdjustment {
        bytes: u16,
    },
    DirectJump {
        target: u64,
    },
    ConditionalJump {
        condition: ConditionCode,
        target: u64,
    },
    DirectCall {
        target: u64,
    },
    IndirectJump {
        target: ControlFlowOperand,
    },
    IndirectCall {
        target: ControlFlowOperand,
    },
    Unknown {
        bytes: Vec<u8>,
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SimdMoveKind {
    Movaps,
    Movups,
    Movdqa,
    Movdqu,
    Movsd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SimdMoveDirection {
    Load,
    Store,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SimdBinaryKind {
    Xorps,
    Pxor,
    Addsd,
    Mulsd,
}

impl Operation {
    pub fn dataflow_effect(&self) -> DataflowEffect {
        let mut effect = DataflowEffect::default();
        let flag_effects = self.flag_effects();
        effect.flag_reads.extend(
            flag_effects
                .read_flags()
                .into_iter()
                .map(ProcessorFlag::from),
        );
        effect.flag_writes.extend(
            flag_effects
                .written_flags()
                .into_iter()
                .map(ProcessorFlag::from),
        );

        match self {
            Self::Nop | Self::NopBytes { .. } | Self::EndBranch { .. } => {}
            Self::Breakpoint | Self::Halt | Self::Interrupt { .. } => {
                mark_unknown(&mut effect);
            }
            Self::ClearRegister { register, .. } => {
                write_register(&mut effect, *register);
            }
            Self::MoveRegister { dst, src, .. } => {
                read_register(&mut effect, *src);
                write_register(&mut effect, *dst);
            }
            Self::LoadEffectiveAddress { dst, address, .. } => {
                effect.register_reads.extend(address.register_families());
                if !address.is_supported() {
                    mark_unknown(&mut effect);
                }
                write_register(&mut effect, *dst);
            }
            Self::LoadRegisterMemory { dst, address, .. } => {
                effect.register_reads.extend(address.register_families());
                if !address.is_supported() {
                    mark_unknown(&mut effect);
                }
                write_register(&mut effect, *dst);
            }
            Self::StoreMemoryRegister { address, src, .. } => {
                effect.register_reads.extend(address.register_families());
                if !address.is_supported() {
                    mark_unknown(&mut effect);
                }
                read_register(&mut effect, *src);
                mark_unknown(&mut effect);
            }
            Self::StoreMemoryImmediate { address, .. } => {
                effect.register_reads.extend(address.register_families());
                if !address.is_supported() {
                    mark_unknown(&mut effect);
                }
                mark_unknown(&mut effect);
            }
            Self::SimdMove { dst, src, .. } => {
                read_vector_operand(&mut effect, src);
                write_vector_register(&mut effect, *dst);
            }
            Self::StoreSimdMemoryRegister { address, src, .. } => {
                effect.register_reads.extend(address.register_families());
                if !address.is_supported() {
                    mark_unknown(&mut effect);
                }
                read_vector_register(&mut effect, *src);
                mark_unknown(&mut effect);
            }
            Self::SimdBinary { dst, src, .. } => {
                read_vector_register(&mut effect, *dst);
                read_vector_operand(&mut effect, src);
                write_vector_register(&mut effect, *dst);
            }
            Self::FpuWait
            | Self::FpuNoop
            | Self::FpuInitialize { .. }
            | Self::FpuClearExceptions { .. } => {
                mark_unknown(&mut effect);
            }
            Self::SetRegisterImmediate { register, .. } => {
                write_register(&mut effect, *register);
            }
            Self::AddRegisterImmediate { register, .. }
            | Self::AndRegisterImmediate { register, .. }
            | Self::OrRegisterImmediate { register, .. }
            | Self::XorRegisterImmediate { register, .. }
            | Self::SubRegisterImmediate { register, .. } => {
                read_register(&mut effect, *register);
                write_register(&mut effect, *register);
            }
            Self::AddWithCarryOperandImmediate { dst, .. }
            | Self::SubtractWithBorrowOperandImmediate { dst, .. } => {
                write_operand_registers(&mut effect, dst);
            }
            Self::AddWithCarryOperandOperand { dst, src, .. }
            | Self::SubtractWithBorrowOperandOperand { dst, src, .. }
            | Self::SubtractOperandOperand { dst, src, .. } => {
                write_operand_registers(&mut effect, dst);
                read_operand_registers(&mut effect, src);
            }
            Self::CompareRegisterImmediate { register, .. }
            | Self::TestRegisterImmediate { register, .. } => {
                read_register(&mut effect, *register);
            }
            Self::CompareRegisterRegister { left, right, .. }
            | Self::TestRegisterRegister { left, right, .. } => {
                read_register(&mut effect, *left);
                read_register(&mut effect, *right);
            }
            Self::AndRegisterRegister { dst, src, .. }
            | Self::OrRegisterRegister { dst, src, .. }
            | Self::XorRegisterRegister { dst, src, .. } => {
                read_register(&mut effect, *dst);
                read_register(&mut effect, *src);
                write_register(&mut effect, *dst);
            }
            Self::ShiftLeftRegisterImmediate { dst, .. }
            | Self::ShiftRightLogicalRegisterImmediate { dst, .. }
            | Self::ShiftRightArithmeticRegisterImmediate { dst, .. } => {
                write_operand_registers(&mut effect, dst);
            }
            Self::ShiftLeftRegisterCl { dst, .. }
            | Self::ShiftRightLogicalRegisterCl { dst, .. }
            | Self::ShiftRightArithmeticRegisterCl { dst, .. } => {
                read_register(&mut effect, Register::Cl);
                write_operand_registers(&mut effect, dst);
            }
            Self::ConditionalMoveRegister { dst, src, .. } => {
                read_operand_registers(&mut effect, src);
                write_register(&mut effect, *dst);
            }
            Self::SetRegisterCondition { dst, .. } => {
                write_operand_registers(&mut effect, dst);
            }
            Self::UnsignedMultiply { src, .. } | Self::SignedMultiply { src, .. } => {
                read_register(&mut effect, Register::Rax);
                read_operand_registers(&mut effect, src);
                write_register(&mut effect, Register::Rax);
                write_register(&mut effect, Register::Rdx);
            }
            Self::SignedMultiplyRegister { dst, src, .. }
            | Self::SignedMultiplyRegisterImmediate { dst, src, .. } => {
                read_register(&mut effect, *dst);
                read_operand_registers(&mut effect, src);
                write_register(&mut effect, *dst);
            }
            Self::UnsignedDivide { src, .. } | Self::SignedDivide { src, .. } => {
                read_register(&mut effect, Register::Rax);
                read_register(&mut effect, Register::Rdx);
                read_operand_registers(&mut effect, src);
                write_register(&mut effect, Register::Rax);
                write_register(&mut effect, Register::Rdx);
            }
            Self::PushRegister {
                register,
                width_bits,
            } => {
                read_register(&mut effect, *register);
                read_register(&mut effect, stack_pointer_register(*width_bits));
                write_register(&mut effect, stack_pointer_register(*width_bits));
                mark_unknown(&mut effect);
            }
            Self::PopRegister {
                register,
                width_bits,
            } => {
                read_register(&mut effect, stack_pointer_register(*width_bits));
                write_register(&mut effect, *register);
                write_register(&mut effect, stack_pointer_register(*width_bits));
                mark_unknown(&mut effect);
            }
            Self::PushImmediate { width_bits, .. } => {
                read_register(&mut effect, stack_pointer_register(*width_bits));
                write_register(&mut effect, stack_pointer_register(*width_bits));
                mark_unknown(&mut effect);
            }
            Self::PushMemory {
                address,
                width_bits,
            } => {
                effect.register_reads.extend(address.register_families());
                read_register(&mut effect, stack_pointer_register(*width_bits));
                write_register(&mut effect, stack_pointer_register(*width_bits));
                mark_unknown(&mut effect);
            }
            Self::PopMemory {
                address,
                width_bits,
            } => {
                effect.register_reads.extend(address.register_families());
                read_register(&mut effect, stack_pointer_register(*width_bits));
                write_register(&mut effect, stack_pointer_register(*width_bits));
                mark_unknown(&mut effect);
            }
            Self::ExchangeRegisterOperand {
                register, operand, ..
            } => {
                read_register(&mut effect, *register);
                match operand {
                    ControlFlowOperand::Register(other) => {
                        read_register(&mut effect, *other);
                        write_register(&mut effect, *other);
                    }
                    ControlFlowOperand::Memory(memory) => {
                        effect.register_reads.extend(memory.register_families());
                        mark_unknown(&mut effect);
                    }
                }
                write_register(&mut effect, *register);
            }
            Self::SignExtendRegister { dst, src, .. }
            | Self::ZeroExtendRegister { dst, src, .. } => {
                read_operand_registers(&mut effect, src);
                write_register(&mut effect, *dst);
            }
            Self::NotOperand { dst, .. } => {
                write_operand_registers(&mut effect, dst);
            }
            Self::NegOperand { dst, .. } => {
                write_operand_registers(&mut effect, dst);
                write_status_flags(&mut effect);
            }
            Self::MoveString { prefix, width_bits } => {
                read_register(&mut effect, string_source_index_register());
                read_register(&mut effect, string_destination_index_register());
                read_direction_flag(&mut effect);
                if prefix.is_some() {
                    read_register(&mut effect, repeat_counter_register(*width_bits));
                }
                write_register(&mut effect, string_source_index_register());
                write_register(&mut effect, string_destination_index_register());
                if prefix.is_some() {
                    write_register(&mut effect, repeat_counter_register(*width_bits));
                }
                mark_unknown(&mut effect);
            }
            Self::StoreString { prefix, width_bits } => {
                read_register(&mut effect, string_accumulator_register());
                read_register(&mut effect, string_destination_index_register());
                read_direction_flag(&mut effect);
                if prefix.is_some() {
                    read_register(&mut effect, repeat_counter_register(*width_bits));
                }
                write_register(&mut effect, string_destination_index_register());
                if prefix.is_some() {
                    write_register(&mut effect, repeat_counter_register(*width_bits));
                }
                mark_unknown(&mut effect);
            }
            Self::CompareString { prefix, width_bits } => {
                read_register(&mut effect, string_source_index_register());
                read_register(&mut effect, string_destination_index_register());
                read_direction_flag(&mut effect);
                if prefix.is_some() {
                    read_register(&mut effect, repeat_counter_register(*width_bits));
                    effect.flag_reads.insert(ProcessorFlag::Zero);
                }
                write_register(&mut effect, string_source_index_register());
                write_register(&mut effect, string_destination_index_register());
                if prefix.is_some() {
                    write_register(&mut effect, repeat_counter_register(*width_bits));
                }
                write_status_flags(&mut effect);
                mark_unknown(&mut effect);
            }
            Self::LeaveFrame => {
                read_register(&mut effect, Register::Rbp);
                read_register(&mut effect, Register::Rsp);
                write_register(&mut effect, Register::Rbp);
                write_register(&mut effect, Register::Rsp);
                mark_unknown(&mut effect);
            }
            Self::Syscall | Self::Return | Self::ReturnWithStackAdjustment { .. } => {
                mark_unknown(&mut effect);
            }
            Self::ConditionalJump { .. } => {
                mark_unknown(&mut effect);
            }
            Self::DirectJump { .. } | Self::DirectCall { .. } => {
                mark_unknown(&mut effect);
            }
            Self::IndirectJump { target } | Self::IndirectCall { target } => {
                effect.register_reads.extend(target.register_families());
                if let ControlFlowOperand::Memory(memory) = target {
                    if !memory.is_supported() {
                        mark_unknown(&mut effect);
                    }
                }
                mark_unknown(&mut effect);
            }
            Self::Unknown { .. } => {
                mark_unknown(&mut effect);
            }
        }

        effect
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Syscall
                | Self::Return
                | Self::ReturnWithStackAdjustment { .. }
                | Self::DirectJump { .. }
                | Self::ConditionalJump { .. }
                | Self::IndirectJump { .. }
                | Self::Unknown { .. }
        )
    }

    pub fn has_relative_control_flow(&self) -> bool {
        matches!(
            self,
            Self::DirectJump { .. } | Self::ConditionalJump { .. } | Self::DirectCall { .. }
        )
    }

    pub fn direct_target(&self) -> Option<u64> {
        match self {
            Self::DirectJump { target }
            | Self::ConditionalJump { target, .. }
            | Self::DirectCall { target } => Some(*target),
            _ => None,
        }
    }

    pub fn indirect_control_flow_operand(&self) -> Option<&ControlFlowOperand> {
        match self {
            Self::IndirectJump { target } | Self::IndirectCall { target } => Some(target),
            _ => None,
        }
    }

    pub fn indirect_control_flow_kind(&self) -> Option<EdgeKind> {
        match self {
            Self::IndirectJump { .. } => Some(EdgeKind::Jump),
            Self::IndirectCall { .. } => Some(EdgeKind::Call),
            _ => None,
        }
    }

    pub fn flag_effects(&self) -> FlagEffects {
        match self {
            Self::ClearRegister { .. } => logical_flag_effects(),
            Self::CompareRegisterImmediate { .. }
            | Self::CompareRegisterRegister { .. }
            | Self::TestRegisterImmediate { .. } => all_flags_defined(),
            Self::TestRegisterRegister { .. }
            | Self::AndRegisterImmediate { .. }
            | Self::AndRegisterRegister { .. }
            | Self::OrRegisterImmediate { .. }
            | Self::OrRegisterRegister { .. }
            | Self::XorRegisterImmediate { .. }
            | Self::XorRegisterRegister { .. } => logical_flag_effects(),
            Self::AddRegisterImmediate { .. }
            | Self::SubRegisterImmediate { .. }
            | Self::AddWithCarryOperandImmediate { .. }
            | Self::AddWithCarryOperandOperand { .. }
            | Self::SubtractWithBorrowOperandImmediate { .. }
            | Self::SubtractWithBorrowOperandOperand { .. }
            | Self::SubtractOperandOperand { .. } => arithmetic_flag_effects(matches!(
                self,
                Self::AddWithCarryOperandImmediate { .. }
                    | Self::AddWithCarryOperandOperand { .. }
                    | Self::SubtractWithBorrowOperandImmediate { .. }
                    | Self::SubtractWithBorrowOperandOperand { .. }
            )),
            Self::ShiftLeftRegisterImmediate { amount, .. }
            | Self::ShiftRightLogicalRegisterImmediate { amount, .. }
            | Self::ShiftRightArithmeticRegisterImmediate { amount, .. } => {
                shift_flag_effects(Some(*amount))
            }
            Self::ShiftLeftRegisterCl { .. }
            | Self::ShiftRightLogicalRegisterCl { .. }
            | Self::ShiftRightArithmeticRegisterCl { .. } => shift_flag_effects(None),
            Self::SignedMultiply { .. }
            | Self::SignedMultiplyRegister { .. }
            | Self::SignedMultiplyRegisterImmediate { .. } => signed_multiply_flag_effects(),
            Self::UnsignedMultiply { .. }
            | Self::UnsignedDivide { .. }
            | Self::SignedDivide { .. } => undefined_all_flags(),
            Self::NegOperand { .. } | Self::CompareString { .. } => all_flags_defined(),
            Self::NotOperand { .. }
            | Self::PushImmediate { .. }
            | Self::PushMemory { .. }
            | Self::PopMemory { .. }
            | Self::ExchangeRegisterOperand { .. }
            | Self::SignExtendRegister { .. }
            | Self::ZeroExtendRegister { .. }
            | Self::MoveString { .. }
            | Self::StoreString { .. } => FlagEffects::none(),
            Self::ConditionalJump { condition, .. }
            | Self::ConditionalMoveRegister { condition, .. }
            | Self::SetRegisterCondition { condition, .. } => condition_flag_effects(*condition),
            _ => FlagEffects::none(),
        }
    }

    pub fn flags_read(&self) -> Vec<Flag> {
        self.flag_effects().read_flags()
    }

    pub fn flags_written(&self) -> Vec<Flag> {
        self.flag_effects().written_flags()
    }

    pub fn registers_read(&self) -> Vec<Register> {
        match self {
            Self::MoveRegister { src, .. } => vec![*src],
            Self::LoadEffectiveAddress { address, .. } => address.registers_read(),
            Self::LoadRegisterMemory { address, .. } => address.registers_read(),
            Self::StoreMemoryRegister { address, src, .. } => {
                let mut registers = vec![*src];
                registers.extend(address.registers_read());
                registers
            }
            Self::StoreMemoryImmediate { address, .. } => address.registers_read(),
            Self::SimdMove { src, .. } => src.registers_read(),
            Self::StoreSimdMemoryRegister { address, .. } => address.registers_read(),
            Self::SimdBinary { src, .. } => src.registers_read(),
            Self::SetRegisterImmediate { .. }
            | Self::ClearRegister { .. }
            | Self::Breakpoint
            | Self::Halt
            | Self::Interrupt { .. }
            | Self::Nop
            | Self::NopBytes { .. }
            | Self::EndBranch { .. }
            | Self::Return
            | Self::ReturnWithStackAdjustment { .. }
            | Self::DirectJump { .. }
            | Self::DirectCall { .. }
            | Self::Syscall
            | Self::LeaveFrame
            | Self::FpuWait
            | Self::FpuNoop
            | Self::FpuInitialize { .. }
            | Self::FpuClearExceptions { .. }
            | Self::Unknown { .. } => Vec::new(),
            Self::AddRegisterImmediate { register, .. }
            | Self::AndRegisterImmediate { register, .. }
            | Self::OrRegisterImmediate { register, .. }
            | Self::XorRegisterImmediate { register, .. }
            | Self::SubRegisterImmediate { register, .. }
            | Self::CompareRegisterImmediate { register, .. }
            | Self::TestRegisterImmediate { register, .. } => vec![*register],
            Self::AddWithCarryOperandImmediate { dst, .. }
            | Self::SubtractWithBorrowOperandImmediate { dst, .. } => {
                control_flow_operand_reads(dst)
            }
            Self::AddWithCarryOperandOperand { dst, src, .. }
            | Self::SubtractWithBorrowOperandOperand { dst, src, .. }
            | Self::SubtractOperandOperand { dst, src, .. } => {
                let mut registers = control_flow_operand_reads(dst);
                registers.extend(control_flow_operand_reads(src));
                registers
            }
            Self::CompareRegisterRegister { left, right, .. }
            | Self::TestRegisterRegister { left, right, .. }
            | Self::AndRegisterRegister {
                dst: left,
                src: right,
                ..
            }
            | Self::OrRegisterRegister {
                dst: left,
                src: right,
                ..
            }
            | Self::XorRegisterRegister {
                dst: left,
                src: right,
                ..
            } => vec![*left, *right],
            Self::ShiftLeftRegisterImmediate { dst, .. }
            | Self::ShiftRightLogicalRegisterImmediate { dst, .. }
            | Self::ShiftRightArithmeticRegisterImmediate { dst, .. } => {
                control_flow_operand_reads(dst)
            }
            Self::ShiftLeftRegisterCl { dst, .. }
            | Self::ShiftRightLogicalRegisterCl { dst, .. }
            | Self::ShiftRightArithmeticRegisterCl { dst, .. } => {
                let mut registers = control_flow_operand_reads(dst);
                registers.push(Register::Cl);
                registers
            }
            Self::ConditionalMoveRegister { dst, src, .. } => {
                let mut registers = vec![*dst];
                registers.extend(control_flow_operand_reads(src));
                registers
            }
            Self::SetRegisterCondition { dst, .. } => control_flow_operand_address_reads(dst),
            Self::SignedMultiply { src, width_bits }
            | Self::UnsignedMultiply { src, width_bits } => {
                let mut registers = accumulator_registers(*width_bits);
                registers.extend(control_flow_operand_reads(src));
                registers
            }
            Self::SignedMultiplyRegister { dst, src, .. }
            | Self::SignedMultiplyRegisterImmediate { dst, src, .. } => {
                let mut registers = vec![*dst];
                registers.extend(control_flow_operand_reads(src));
                registers
            }
            Self::UnsignedDivide { src, width_bits } | Self::SignedDivide { src, width_bits } => {
                let mut registers = dividend_registers(*width_bits);
                registers.extend(control_flow_operand_reads(src));
                registers
            }
            Self::PushRegister {
                register,
                width_bits,
            } => vec![*register, stack_pointer_register(*width_bits)],
            Self::PopRegister { width_bits, .. } => vec![stack_pointer_register(*width_bits)],
            Self::PushImmediate { width_bits, .. } => {
                vec![stack_pointer_register(*width_bits)]
            }
            Self::PushMemory {
                address,
                width_bits,
            }
            | Self::PopMemory {
                address,
                width_bits,
            } => {
                let mut registers = address.registers_read();
                registers.push(stack_pointer_register(*width_bits));
                registers
            }
            Self::ExchangeRegisterOperand {
                register, operand, ..
            } => {
                let mut registers = vec![*register];
                registers.extend(control_flow_operand_reads(operand));
                registers
            }
            Self::SignExtendRegister { dst, src, .. }
            | Self::ZeroExtendRegister { dst, src, .. } => {
                let mut registers = vec![*dst];
                registers.extend(control_flow_operand_reads(src));
                registers
            }
            Self::NotOperand { dst, .. } | Self::NegOperand { dst, .. } => {
                control_flow_operand_reads(dst)
            }
            Self::MoveString { prefix, width_bits } => {
                let mut registers = vec![
                    string_source_index_register(),
                    string_destination_index_register(),
                ];
                if prefix.is_some() {
                    registers.push(repeat_counter_register(*width_bits));
                }
                registers
            }
            Self::StoreString { prefix, width_bits } => {
                let mut registers = vec![
                    string_accumulator_register(),
                    string_destination_index_register(),
                ];
                if prefix.is_some() {
                    registers.push(repeat_counter_register(*width_bits));
                }
                registers
            }
            Self::CompareString { prefix, width_bits } => {
                let mut registers = vec![
                    string_source_index_register(),
                    string_destination_index_register(),
                ];
                if prefix.is_some() {
                    registers.push(repeat_counter_register(*width_bits));
                }
                registers
            }
            Self::IndirectJump { target } | Self::IndirectCall { target } => {
                control_flow_operand_reads(target)
            }
            Self::ConditionalJump { .. } => Vec::new(),
        }
    }

    pub fn registers_written(&self) -> Vec<Register> {
        match self {
            Self::ClearRegister { register, .. }
            | Self::SetRegisterImmediate { register, .. }
            | Self::AddRegisterImmediate { register, .. }
            | Self::AndRegisterImmediate { register, .. }
            | Self::OrRegisterImmediate { register, .. }
            | Self::XorRegisterImmediate { register, .. }
            | Self::SubRegisterImmediate { register, .. } => vec![*register],
            Self::MoveRegister { dst, .. }
            | Self::LoadEffectiveAddress { dst, .. }
            | Self::LoadRegisterMemory { dst, .. }
            | Self::SignExtendRegister { dst, .. }
            | Self::ZeroExtendRegister { dst, .. } => vec![*dst],
            Self::AndRegisterRegister { dst, .. }
            | Self::OrRegisterRegister { dst, .. }
            | Self::XorRegisterRegister { dst, .. }
            | Self::ConditionalMoveRegister { dst, .. }
            | Self::SignedMultiplyRegister { dst, .. }
            | Self::SignedMultiplyRegisterImmediate { dst, .. } => vec![*dst],
            Self::ExchangeRegisterOperand {
                register, operand, ..
            } => {
                let mut registers = vec![*register];
                if let ControlFlowOperand::Register(other) = operand {
                    registers.push(*other);
                }
                registers
            }
            Self::SimdMove { .. }
            | Self::StoreSimdMemoryRegister { .. }
            | Self::SimdBinary { .. }
            | Self::FpuWait
            | Self::FpuNoop
            | Self::FpuInitialize { .. }
            | Self::FpuClearExceptions { .. } => Vec::new(),
            Self::PopRegister {
                register,
                width_bits,
            } => {
                vec![*register, stack_pointer_register(*width_bits)]
            }
            Self::PushImmediate { width_bits, .. }
            | Self::PushMemory { width_bits, .. }
            | Self::PopMemory { width_bits, .. } => {
                vec![stack_pointer_register(*width_bits)]
            }
            Self::ShiftLeftRegisterImmediate { dst, amount, .. }
            | Self::ShiftRightLogicalRegisterImmediate { dst, amount, .. }
            | Self::ShiftRightArithmeticRegisterImmediate { dst, amount, .. } => {
                if *amount == 0 {
                    Vec::new()
                } else {
                    control_flow_operand_register_write(dst)
                }
            }
            Self::ShiftLeftRegisterCl { dst, .. }
            | Self::ShiftRightLogicalRegisterCl { dst, .. }
            | Self::ShiftRightArithmeticRegisterCl { dst, .. } => {
                control_flow_operand_register_write(dst)
            }
            Self::SetRegisterCondition { dst, .. } => control_flow_operand_register_write(dst),
            Self::AddWithCarryOperandImmediate { dst, .. }
            | Self::AddWithCarryOperandOperand { dst, .. }
            | Self::SubtractWithBorrowOperandImmediate { dst, .. }
            | Self::SubtractWithBorrowOperandOperand { dst, .. }
            | Self::SubtractOperandOperand { dst, .. } => control_flow_operand_register_write(dst),
            Self::NotOperand { dst, .. } | Self::NegOperand { dst, .. } => {
                control_flow_operand_register_write(dst)
            }
            Self::UnsignedMultiply { width_bits, .. }
            | Self::SignedMultiply { width_bits, .. }
            | Self::UnsignedDivide { width_bits, .. }
            | Self::SignedDivide { width_bits, .. } => accumulator_pair_registers(*width_bits),
            Self::PushRegister { width_bits, .. } => vec![stack_pointer_register(*width_bits)],
            Self::MoveString { prefix, width_bits } => {
                let mut registers = vec![
                    string_source_index_register(),
                    string_destination_index_register(),
                ];
                if prefix.is_some() {
                    registers.push(repeat_counter_register(*width_bits));
                }
                registers
            }
            Self::StoreString { prefix, width_bits } => {
                let mut registers = vec![string_destination_index_register()];
                if prefix.is_some() {
                    registers.push(repeat_counter_register(*width_bits));
                }
                registers
            }
            Self::CompareString { prefix, width_bits } => {
                let mut registers = vec![
                    string_source_index_register(),
                    string_destination_index_register(),
                ];
                if prefix.is_some() {
                    registers.push(repeat_counter_register(*width_bits));
                }
                registers
            }
            Self::ConditionalJump { .. }
            | Self::Breakpoint
            | Self::Halt
            | Self::Interrupt { .. }
            | Self::Nop
            | Self::NopBytes { .. }
            | Self::EndBranch { .. }
            | Self::Return
            | Self::ReturnWithStackAdjustment { .. }
            | Self::DirectJump { .. }
            | Self::DirectCall { .. }
            | Self::Syscall
            | Self::LeaveFrame
            | Self::Unknown { .. } => Vec::new(),
            Self::CompareRegisterImmediate { .. }
            | Self::TestRegisterImmediate { .. }
            | Self::CompareRegisterRegister { .. }
            | Self::TestRegisterRegister { .. }
            | Self::StoreMemoryImmediate { .. }
            | Self::StoreMemoryRegister { .. }
            | Self::IndirectJump { .. }
            | Self::IndirectCall { .. } => Vec::new(),
        }
    }

    pub fn registers_clobbered(&self) -> Vec<Register> {
        self.registers_written()
            .into_iter()
            .map(Register::family_root)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

fn read_register(effect: &mut DataflowEffect, register: Register) {
    effect.register_reads.insert(register.family());
}

fn write_register(effect: &mut DataflowEffect, register: Register) {
    effect.register_writes.insert(register.family());
}

fn read_operand_registers(effect: &mut DataflowEffect, operand: &ControlFlowOperand) {
    effect.register_reads.extend(operand.register_families());
    if let ControlFlowOperand::Memory(memory) = operand {
        if !memory.is_supported() {
            mark_unknown(effect);
        }
    }
}

fn write_operand_registers(effect: &mut DataflowEffect, operand: &ControlFlowOperand) {
    match operand {
        ControlFlowOperand::Register(register) => write_register(effect, *register),
        ControlFlowOperand::Memory(memory) => {
            effect.register_reads.extend(memory.register_families());
            mark_unknown(effect);
        }
    }
}

fn read_direction_flag(effect: &mut DataflowEffect) {
    effect.flag_reads.insert(ProcessorFlag::Direction);
}

fn write_status_flags(effect: &mut DataflowEffect) {
    effect.flag_writes.extend(status_flags());
}

fn status_flags() -> BTreeSet<ProcessorFlag> {
    [
        Flag::Carry,
        Flag::Parity,
        Flag::AuxiliaryCarry,
        Flag::Zero,
        Flag::Sign,
        Flag::Overflow,
    ]
    .into_iter()
    .map(ProcessorFlag::from)
    .collect()
}

fn mark_unknown(effect: &mut DataflowEffect) {
    effect.has_unknown_side_effects = true;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instruction {
    pub address: u64,
    pub file_offset: u64,
    pub bytes: Vec<u8>,
    pub operation: Operation,
    pub jump_table: Option<JumpTableCandidate>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Instruction {
    pub fn end_file_offset(&self) -> u64 {
        self.file_offset + self.bytes.len() as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BasicBlockId(pub usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Fallthrough,
    Jump,
    Call,
    Return,
    Syscall,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub from: BasicBlockId,
    pub to: Option<BasicBlockId>,
    pub target: Option<u64>,
    pub kind: EdgeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasicBlock {
    pub id: BasicBlockId,
    pub address: u64,
    pub file_offset: u64,
    pub instructions: Vec<Instruction>,
    pub edges: Vec<Edge>,
}

impl BasicBlock {
    pub fn encoded_len(&self) -> usize {
        self.instructions
            .iter()
            .map(|instruction| instruction.bytes.len())
            .sum()
    }

    pub fn end_file_offset(&self) -> u64 {
        self.instructions
            .last()
            .map(Instruction::end_file_offset)
            .unwrap_or(self.file_offset)
    }

    pub fn end_address(&self) -> u64 {
        self.instructions
            .last()
            .map(|instruction| instruction.address + instruction.bytes.len() as u64)
            .unwrap_or(self.address)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Function {
    pub entry: u64,
    pub blocks: Vec<BasicBlock>,
}

impl Function {
    pub fn entry_block(&self) -> Option<&BasicBlock> {
        self.blocks.first()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Module {
    pub format: BinaryFormat,
    pub architecture: Architecture,
    pub entry: u64,
    pub metadata: ModuleMetadata,
    pub functions: Vec<Function>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Module {
    pub fn entry_function(&self) -> Option<&Function> {
        self.functions.first()
    }

    pub fn entry_block(&self) -> Option<&BasicBlock> {
        self.entry_function().and_then(Function::entry_block)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModuleMetadata {
    pub imports: Vec<Import>,
    pub elf_plt: Option<ElfPltMetadata>,
}

fn control_flow_operand_reads(operand: &ControlFlowOperand) -> Vec<Register> {
    operand.registers_read()
}

fn control_flow_operand_register_write(operand: &ControlFlowOperand) -> Vec<Register> {
    match operand {
        ControlFlowOperand::Register(register) => vec![*register],
        ControlFlowOperand::Memory(_) => Vec::new(),
    }
}

fn control_flow_operand_address_reads(operand: &ControlFlowOperand) -> Vec<Register> {
    operand.address_registers()
}

fn read_vector_register(effect: &mut DataflowEffect, register: VectorRegister) {
    effect.vector_register_reads.insert(register);
}

fn write_vector_register(effect: &mut DataflowEffect, register: VectorRegister) {
    effect.vector_register_writes.insert(register);
}

fn read_vector_operand(effect: &mut DataflowEffect, operand: &VectorOperand) {
    match operand {
        VectorOperand::Register(register) => read_vector_register(effect, *register),
        VectorOperand::Memory(memory) => {
            effect.register_reads.extend(memory.register_families());
            if !memory.is_supported() {
                mark_unknown(effect);
            }
        }
    }
}

fn stack_pointer_register(width_bits: u8) -> Register {
    if width_bits == 64 {
        Register::Rsp
    } else {
        Register::Esp
    }
}

fn accumulator_registers(width_bits: u8) -> Vec<Register> {
    match width_bits {
        8 => vec![Register::Al],
        32 => vec![Register::Eax],
        64 => vec![Register::Rax],
        _ => Vec::new(),
    }
}

fn dividend_registers(width_bits: u8) -> Vec<Register> {
    match width_bits {
        8 => vec![Register::Al],
        32 => vec![Register::Eax, Register::Edx],
        64 => vec![Register::Rax, Register::Rdx],
        _ => Vec::new(),
    }
}

fn accumulator_pair_registers(width_bits: u8) -> Vec<Register> {
    dividend_registers(width_bits)
}

fn string_source_index_register() -> Register {
    Register::Rsi
}

fn string_destination_index_register() -> Register {
    Register::Rdi
}

fn string_accumulator_register() -> Register {
    Register::Rax
}

fn repeat_counter_register(width_bits: u8) -> Register {
    match width_bits {
        64 => Register::Rcx,
        _ => Register::Ecx,
    }
}

fn all_flags_defined() -> FlagEffects {
    FlagEffects {
        carry: FlagEffect::Defined,
        parity: FlagEffect::Defined,
        auxiliary_carry: FlagEffect::Defined,
        zero: FlagEffect::Defined,
        sign: FlagEffect::Defined,
        overflow: FlagEffect::Defined,
    }
}

fn logical_flag_effects() -> FlagEffects {
    FlagEffects {
        carry: FlagEffect::Defined,
        parity: FlagEffect::Defined,
        auxiliary_carry: FlagEffect::Undefined,
        zero: FlagEffect::Defined,
        sign: FlagEffect::Defined,
        overflow: FlagEffect::Defined,
    }
}

fn arithmetic_flag_effects(read_carry: bool) -> FlagEffects {
    FlagEffects {
        carry: if read_carry {
            FlagEffect::ReadDefined
        } else {
            FlagEffect::Defined
        },
        parity: FlagEffect::Defined,
        auxiliary_carry: FlagEffect::Defined,
        zero: FlagEffect::Defined,
        sign: FlagEffect::Defined,
        overflow: FlagEffect::Defined,
    }
}

fn shift_flag_effects(amount: Option<u8>) -> FlagEffects {
    match amount {
        Some(0) => FlagEffects::none(),
        Some(1) => FlagEffects {
            carry: FlagEffect::Defined,
            parity: FlagEffect::Defined,
            auxiliary_carry: FlagEffect::Undefined,
            zero: FlagEffect::Defined,
            sign: FlagEffect::Defined,
            overflow: FlagEffect::Defined,
        },
        Some(_) | None => FlagEffects {
            carry: FlagEffect::Defined,
            parity: FlagEffect::Defined,
            auxiliary_carry: FlagEffect::Undefined,
            zero: FlagEffect::Defined,
            sign: FlagEffect::Defined,
            overflow: FlagEffect::Undefined,
        },
    }
}

fn signed_multiply_flag_effects() -> FlagEffects {
    FlagEffects {
        carry: FlagEffect::Defined,
        parity: FlagEffect::Undefined,
        auxiliary_carry: FlagEffect::Undefined,
        zero: FlagEffect::Undefined,
        sign: FlagEffect::Undefined,
        overflow: FlagEffect::Defined,
    }
}

fn undefined_all_flags() -> FlagEffects {
    FlagEffects {
        carry: FlagEffect::Undefined,
        parity: FlagEffect::Undefined,
        auxiliary_carry: FlagEffect::Undefined,
        zero: FlagEffect::Undefined,
        sign: FlagEffect::Undefined,
        overflow: FlagEffect::Undefined,
    }
}

fn condition_flag_effects(condition: ConditionCode) -> FlagEffects {
    let mut effects = FlagEffects::none();
    for flag in condition.flags_read() {
        let effect = FlagEffect::Read;
        match flag {
            Flag::Carry => effects.carry = effect,
            Flag::Parity => effects.parity = effect,
            Flag::AuxiliaryCarry => effects.auxiliary_carry = effect,
            Flag::Zero => effects.zero = effect,
            Flag::Sign => effects.sign = effect,
            Flag::Overflow => effects.overflow = effect,
        }
    }
    effects
}
