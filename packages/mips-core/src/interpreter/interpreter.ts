import {ConfigError, ExecutionError, type ExecutionErrorInfo, type MipsErrorCode} from '../errors.js';
import {signExtend16, u32} from '../isa/constants.js';
import {decode, formatInstruction, type Instruction, type DecodeFailure} from '../isa/decode.js';
import {ALL_INSTRUCTIONS, type InstructionName} from '../isa/instruction-set.js';
import {AddressMap, type AddressRegion} from '../memory/address-map.js';

/**
 * CPU architectural state. `memory` contains only values written by sw, keyed
 * by MIPS byte address; reads fall back to the configured initial RAM image.
 * This keeps the address unit explicit while satisfying the Map-shaped state.
 */
export interface CpuState {
  pc: number;
  registers: Uint32Array;
  memory: Map<number, number>;
  executedInstructions: number;
}

export interface ReferenceImage {
  romWords: number[];
  rom: AddressRegion;
  ram: AddressRegion;
  initialPc: number;
  /** Initial RAM contents keyed by MIPS byte address. Missing addresses are zero. */
  initialRam?: ReadonlyMap<number, number>;
  /** Instruction set enabled for this image. Defaults to all supported instructions. */
  instructions?: readonly InstructionName[];
}

export interface InterpreterOptions {
  trace?: boolean;
  /** Optional defensive limit; run()/runSteps() also take explicit limits. */
  maxSteps?: number;
}

export interface RegisterWrite {
  index: number;
  name: string;
  value: number;
  /** True when the write targets $zero and is therefore discarded. */
  ignored: boolean;
}

export interface MemoryWrite {
  /** MIPS byte address. */
  address: number;
  /** Logisim component word index. */
  index: number;
  value: number;
}

export interface StepResult {
  ok: boolean;
  step: number;
  pcBefore: number;
  machineCode: number;
  instruction: Instruction | null;
  decodedText: string | null;
  pcAfter: number;
  registerWrite?: RegisterWrite;
  memoryWrite?: MemoryWrite;
  error?: ExecutionErrorInfo;
}

export interface TraceEntry extends StepResult {}

export type RunStatus = 'completed' | 'step-limit' | 'stop-pc' | 'error';

export interface RunResult {
  status: RunStatus;
  steps: number;
  pc: number;
  error?: ExecutionErrorInfo;
}

const MAX_STEPS_HARD_LIMIT = 1_000_000;

export class ReferenceInterpreter {
  readonly rom: AddressMap;
  readonly ram: AddressMap;
  readonly romWords: Uint32Array;
  readonly initialRam: ReadonlyMap<number, number>;
  readonly state: CpuState;
  readonly trace: TraceEntry[] = [];
  private readonly traceEnabled: boolean;
  private readonly maxSteps: number;
  private readonly enabledInstructions: ReadonlySet<InstructionName>;

  constructor(readonly image: ReferenceImage, options: InterpreterOptions = {}) {
    this.rom = new AddressMap(image.rom, 'ROM');
    this.ram = new AddressMap(image.ram, 'RAM');
    this.enabledInstructions = new Set(image.instructions ?? ALL_INSTRUCTIONS);
    this.traceEnabled = options.trace ?? false;
    this.maxSteps = clampMaxSteps(options.maxSteps ?? MAX_STEPS_HARD_LIMIT);
    if (image.romWords.length > this.rom.capacityWords) {
      throw new ConfigError(
        'CONFIG_RANGE',
        `ROM image has ${image.romWords.length} words but capacity is ${this.rom.capacityWords}`,
        'romWords',
      );
    }
    const words = new Uint32Array(this.rom.capacityWords);
    for (let i = 0; i < image.romWords.length; i++) {
      const value = image.romWords[i];
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new ConfigError('CONFIG_RANGE', `ROM word ${i} is not a 32-bit unsigned word`, 'romWords');
      }
      words[i] = value >>> 0;
    }
    this.romWords = words;
    if (!Number.isInteger(image.initialPc) || image.initialPc < 0 || image.initialPc > 0xffffffff) {
      throw new ConfigError('CONFIG_RANGE', 'pc.initial must be a 32-bit unsigned address', 'pc.initial');
    }
    if (image.initialPc % 4 !== 0) {
      throw new ConfigError('CONFIG_RANGE', 'pc.initial must be 4-byte aligned', 'pc.initial');
    }
    if (!this.rom.contains(image.initialPc)) {
      throw new ConfigError(
        'CONFIG_RANGE',
        `pc.initial 0x${image.initialPc.toString(16)} is outside the configured ROM range`,
        'pc.initial',
      );
    }
    const initialRam = new Map<number, number>();
    for (const [address, value] of image.initialRam ?? []) {
      this.ram.assertWordAlignment(address, 0);
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new ConfigError(
          'CONFIG_RANGE',
          `Initial RAM value at 0x${address.toString(16)} is not a 32-bit unsigned word`,
          'ram.initial',
        );
      }
      initialRam.set(address >>> 0, value >>> 0);
    }
    this.initialRam = initialRam;
    this.state = {
      pc: image.initialPc >>> 0,
      registers: new Uint32Array(32),
      memory: new Map(),
      executedInstructions: 0,
    };
  }

  get pc(): number {
    return this.state.pc;
  }

  register(index: number): number {
    return this.state.registers[index] ?? 0;
  }

  readRam(byteAddress: number): number {
    this.ram.assertWordAlignment(byteAddress, this.state.pc);
    const address = byteAddress >>> 0;
    return (this.state.memory.get(address) ?? this.initialRam.get(address) ?? 0) >>> 0;
  }

  /** Full RAM snapshot in component word-index order. */
  snapshotRamWords(): Uint32Array {
    const result = new Uint32Array(this.ram.capacityWords);
    for (let index = 0; index < this.ram.capacityWords; index++) {
      result[index] = this.readRam(this.ram.byteAddressOf(index));
    }
    return result;
  }

  /** True when the reference program wrote at least one RAM word. */
  get wroteMemory(): boolean {
    return this.state.memory.size > 0;
  }

  step(): StepResult {
    const pcBefore = this.state.pc >>> 0;
    const step = this.state.executedInstructions + 1;
    let word = 0;
    let instruction: Instruction | null = null;
    let registerWrite: RegisterWrite | undefined;
    let memoryWrite: MemoryWrite | undefined;
    let pcAfter = pcBefore;

    try {
      if (pcBefore % 4 !== 0) throw new ExecutionError('PC_MISALIGNED', `PC 0x${pcBefore.toString(16)} is not 4-byte aligned`, pcBefore);
      if (!this.rom.contains(pcBefore)) {
        throw new ExecutionError(
          'PC_OUT_OF_RANGE',
          `PC 0x${pcBefore.toString(16)} is outside ROM [0x${this.rom.baseByteAddress.toString(16)}, 0x${(
            this.rom.baseByteAddress + this.rom.byteSpan
          ).toString(16)})`,
          pcBefore,
        );
      }
      const index = this.rom.indexOf(pcBefore, pcBefore);
      word = this.romWords[index] >>> 0;
      const decoded = decode(word);
      if (!decoded.ok) {
        throw this.decodeFailure(decoded, pcBefore);
      }
      instruction = decoded.instruction;
      if (!this.enabledInstructions.has(instruction.kind)) {
        throw new ExecutionError(
          'INSTRUCTION_DISABLED',
          `Instruction ${instruction.kind} is not enabled for this CPU`,
          pcBefore,
        );
      }
      const registers = this.state.registers;
      switch (instruction.kind) {
        case 'nop': {
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'lui': {
          const value = u32(instruction.immediate << 16);
          registerWrite = this.writeRegister(instruction.rt, value);
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'j': {
          pcAfter = u32(((pcBefore + 4) & 0xf0000000) | ((instruction.index << 2) >>> 0));
          if (pcAfter % 4 !== 0) {
            throw new ExecutionError('PC_MISALIGNED', `Jump target 0x${pcAfter.toString(16)} is not word aligned`, pcBefore);
          }
          break;
        }
        case 'add': {
          const value = u32((registers[instruction.rs] >>> 0) + (registers[instruction.rt] >>> 0));
          registerWrite = this.writeRegister(instruction.rd, value);
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'sub': {
          const value = u32((registers[instruction.rs] >>> 0) - (registers[instruction.rt] >>> 0));
          registerWrite = this.writeRegister(instruction.rd, value);
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'ori': {
          const value = u32((registers[instruction.rs] >>> 0) | instruction.immediate);
          registerWrite = this.writeRegister(instruction.rt, value);
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'sll': {
          const value = u32((registers[instruction.rt] >>> 0) << instruction.shamt);
          registerWrite = this.writeRegister(instruction.rd, value);
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'lw': {
          const address = u32((registers[instruction.rs] >>> 0) + signExtend16(instruction.offset));
          this.ram.assertWordAlignment(address, pcBefore);
          const value = this.readRam(address);
          registerWrite = this.writeRegister(instruction.rt, value);
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'sw': {
          const address = u32((registers[instruction.rs] >>> 0) + signExtend16(instruction.offset));
          this.ram.assertWordAlignment(address, pcBefore);
          const index = this.ram.indexOf(address, pcBefore);
          const value = registers[instruction.rt] >>> 0;
          this.state.memory.set(address, value);
          memoryWrite = {address, index, value};
          pcAfter = u32(pcBefore + 4);
          break;
        }
        case 'beq': {
          const equal = (registers[instruction.rs] >>> 0) === (registers[instruction.rt] >>> 0);
          if (equal) {
            pcAfter = u32(pcBefore + 4 + (signExtend16(instruction.offset) << 2));
            if (pcAfter % 4 !== 0) {
              throw new ExecutionError('PC_MISALIGNED', `Branch target 0x${pcAfter.toString(16)} is not word aligned`, pcBefore);
            }
          } else {
            pcAfter = u32(pcBefore + 4);
          }
          break;
        }
      }
      this.state.pc = pcAfter;
      this.state.executedInstructions++;
      const result: StepResult = {
        ok: true,
        step,
        pcBefore,
        machineCode: word,
        instruction,
        decodedText: instruction ? formatInstruction(instruction) : null,
        pcAfter,
        registerWrite,
        memoryWrite,
      };
      if (this.traceEnabled) this.trace.push(result);
      return result;
    } catch (error) {
      const info = asExecutionError(error, pcBefore);
      const result: StepResult = {
        ok: false,
        step,
        pcBefore,
        machineCode: word,
        instruction,
        decodedText: instruction ? formatInstruction(instruction) : null,
        pcAfter: this.state.pc,
        registerWrite,
        memoryWrite,
        error: info,
      };
      if (this.traceEnabled) this.trace.push(result);
      return result;
    }
  }

  /** Execute exactly `count` instructions. Stops early on an execution error. */
  runSteps(count: number): RunResult {
    return this.runLoop(count, undefined);
  }

  /**
   * Execute until the next PC equals `stopPc` (checked before each fetch), or
   * until maxSteps is reached. `stopPc` may be one past the last instruction.
   */
  runUntilStop(stopPc: number, maxSteps = this.maxSteps): RunResult {
    return this.runLoop(maxSteps, stopPc >>> 0);
  }

  private runLoop(limit: number, stopPc: number | undefined): RunResult {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_STEPS_HARD_LIMIT) {
      throw new ConfigError('CONFIG_RANGE', `step limit ${limit} outside [0, ${MAX_STEPS_HARD_LIMIT}]`);
    }
    let steps = 0;
    while (steps < limit) {
      if (stopPc !== undefined && this.state.pc === stopPc) {
        return {status: 'stop-pc', steps, pc: this.state.pc};
      }
      const result = this.step();
      if (!result.ok) {
        return {status: 'error', steps, pc: this.state.pc, error: result.error};
      }
      steps++;
    }
    return {status: stopPc === undefined ? 'completed' : 'step-limit', steps, pc: this.state.pc};
  }

  private writeRegister(index: number, value: number): RegisterWrite {
    const unsigned = value >>> 0;
    if (index === 0) {
      return {index, name: '$zero', value: unsigned, ignored: true};
    }
    this.state.registers[index] = unsigned;
    return {index, name: `$${index}`, value: unsigned, ignored: false};
  }

  private decodeFailure(failure: DecodeFailure, pc: number): ExecutionError {
    return new ExecutionError(failure.code, failure.message, pc);
  }
}

function asExecutionError(error: unknown, pc: number): ExecutionErrorInfo {
  if (error instanceof ExecutionError) {
    return {code: error.code, message: error.message, pc: error.pc ?? pc, address: error.address};
  }
  if (error instanceof Error) {
    return {code: 'REFERENCE_ERROR' as MipsErrorCode, message: error.message, pc};
  }
  return {code: 'REFERENCE_ERROR' as MipsErrorCode, message: String(error), pc};
}

function clampMaxSteps(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_STEPS_HARD_LIMIT) {
    throw new ConfigError('CONFIG_RANGE', `maxSteps ${value} outside [1, ${MAX_STEPS_HARD_LIMIT}]`);
  }
  return value;
}
