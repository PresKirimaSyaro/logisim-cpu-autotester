import {ConfigError} from '../errors.js';
import {parseIntegerLiteral, u32} from '../isa/constants.js';
import type {AddressRegion} from '../memory/address-map.js';

/** A physical instruction ROM. ROM injection is the one memory operation we keep. */
export interface MemorySpec extends AddressRegion {
  /** Deterministic component path from inspectComponents. */
  path: string;
}

/**
 * The logical data memory (DM) used by the reference model and test generator.
 *
 * This is deliberately *not* a description of a Logisim RAM component. The CPU
 * is tested as a black box: DM is byte-addressed logical state, and its physical
 * implementation (zero, one or many RAM components, registers, etc.) is
 * irrelevant. `path` and the legacy geometry fields are accepted for migration
 * but ignored.
 */
export interface RamSpec extends AddressRegion {
  /** Legacy physical component path. Ignored. */
  path?: string;
  /** Legacy initial contents. Non-empty images are rejected: use sw to initialize. */
  initial?: InitialRamWord[];
}

export interface InitialRamWord {
  byteAddress: number;
  value: number;
}

export type ClockSpec =
  | {mode: 'pin'; pin: string; edge: 'rising' | 'falling'}
  | {mode: 'internal'; halfCycles: 1 | 2};

/** Top-level observation pins used by the course CPU profile. */
export interface OutputsSpec {
  instruction: string;
  pc: string;
  regWrite: string;
  regAddr: string;
  regData: string;
  memWrite: string;
  memAddr: string;
  memData: string;
}

export type ResetSpec =
  | {strategy: 'none'}
  | {strategy: 'state'}
  | {strategy: 'pin'; pin: string; activeLow: boolean; ticks: number};

export type PcSpec =
  | {mode: 'none'; initial: number; checkEachCycle?: false}
  | {mode: 'register'; path: string; initial: number; checkEachCycle: boolean}
  | {mode: 'pin'; port: string; initial: number; checkEachCycle: boolean};

export interface LimitsSpec {
  maxSteps: number;
  maxCycles: number;
}

export interface InputSpec {
  port: string;
  value: number;
}

export interface CpuConfig {
  schemaVersion: 1;
  name: string;
  circuitName: string;
  clock: ClockSpec;
  reset: ResetSpec;
  pc: PcSpec;
  rom: MemorySpec;
  /** Logical DM only; no physical RAM path or contents are used. */
  ram: RamSpec;
  limits: LimitsSpec;
  inputs: InputSpec[];
  outputs?: OutputsSpec;
  notes?: string;
}

const MAX_MEMORY_WORDS = 1 << 20;

export function parseCpuConfig(value: unknown): CpuConfig {
  const root = object(value, '$');
  checkKeys(root, [
    'schemaVersion',
    'name',
    'circuitName',
    'clock',
    'reset',
    'pc',
    'rom',
    'ram',
    'compare',
    'limits',
    'inputs',
    'outputs',
    'notes',
  ], '$');

  const schemaVersion = integerField(root, 'schemaVersion', '$', 1, 1, true)!;
  if (schemaVersion !== 1) throw new ConfigError('CONFIG_RANGE', 'schemaVersion must be 1', '$.schemaVersion');

  const circuitName = stringField(root, 'circuitName', '$', true)!;
  const name = optionalString(root, 'name', '$') ?? circuitName;
  const clock = parseClock(required(root, 'clock', '$'));
  const reset = parseReset(required(root, 'reset', '$'));
  const pc = parsePc(required(root, 'pc', '$'));
  const rom = parseRom(required(root, 'rom', '$'));
  const ram = parseLogicalRam(required(root, 'ram', '$'));
  // `compare` belonged to the old physical-RAM implementation. It is accepted
  // for configuration migration but has no effect in black-box mode.
  if (root['compare'] !== undefined) object(root['compare'], '$.compare');
  const limits = parseLimits(root['limits']);
  const inputs = parseInputs(root['inputs']);
  const outputs = parseOutputs(root['outputs']);
  const notes = optionalString(root, 'notes', '$');

  if (reset.strategy === 'pin' && clock.mode === 'pin' && reset.pin === clock.pin) {
    throw new ConfigError('CONFIG_INVALID', 'reset.pin must differ from clock.pin', '$.reset.pin');
  }
  if (pc.initial % 4 !== 0) {
    throw new ConfigError('CONFIG_INVALID', 'pc.initial must be 4-byte aligned', '$.pc.initial');
  }
  if (pc.initial < rom.baseByteAddress || pc.initial >= rom.baseByteAddress + (rom.capacityWords << rom.addressShift)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `pc.initial 0x${pc.initial.toString(16)} is outside ROM [0x${rom.baseByteAddress.toString(16)}, 0x${(
        rom.baseByteAddress + (rom.capacityWords << rom.addressShift)
      ).toString(16)})`,
      '$.pc.initial',
    );
  }
  if (rom.dataBits !== 32) {
    throw new ConfigError('CONFIG_INVALID', 'rom.dataBits must be 32 for MIPS instructions', '$.rom.dataBits');
  }
  if (rom.addressShift !== 2) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'rom.addressShift must be 2: this phase models a word-addressed instruction ROM and will not silently collapse 4-byte-spaced instructions',
      '$.rom.addressShift',
    );
  }
  if ((pc.initial - rom.baseByteAddress) % (1 << rom.addressShift) !== 0) {
    throw new ConfigError('CONFIG_INVALID', 'pc.initial is not aligned to a ROM word index', '$.pc.initial');
  }
  if (pc.mode === 'register' && pc.path === rom.path) {
    throw new ConfigError('CONFIG_INVALID', 'pc.register path must not be the ROM', '$.pc.path');
  }

  return {
    schemaVersion: 1,
    name,
    circuitName,
    clock,
    reset,
    pc,
    rom,
    ram,
    limits,
    inputs,
    outputs,
    notes,
  };
}

export function regionOf(spec: AddressRegion): AddressRegion {
  return {
    baseByteAddress: spec.baseByteAddress,
    addressBits: spec.addressBits,
    addressShift: spec.addressShift,
    dataBits: spec.dataBits,
    capacityWords: spec.capacityWords,
  };
}

/** Kept for callers that still inspect legacy configs; black-box mode has no initial DM image. */
export function initialRamMap(spec: RamSpec): Map<number, number> {
  return new Map((spec.initial ?? []).map((word) => [word.byteAddress, word.value]));
}

function parseClock(value: unknown): ClockSpec {
  const clock = object(value, '$.clock');
  const mode = optionalString(clock, 'mode', '$.clock') ?? 'pin';
  if (mode === 'pin') {
    checkKeys(clock, ['mode', 'pin', 'edge'], '$.clock');
    const pin = stringField(clock, 'pin', '$.clock', true)!;
    const edge = optionalString(clock, 'edge', '$.clock') ?? 'rising';
    if (edge !== 'rising' && edge !== 'falling') {
      throw new ConfigError('CONFIG_INVALID', 'clock.edge must be rising or falling', '$.clock.edge');
    }
    return {mode: 'pin', pin, edge};
  }
  if (mode === 'internal') {
    checkKeys(clock, ['mode', 'halfCycles'], '$.clock');
    const halfCycles = integerField(clock, 'halfCycles', '$.clock', 1, 2, false) ?? 2;
    return {mode: 'internal', halfCycles: halfCycles as 1 | 2};
  }
  throw new ConfigError('CONFIG_INVALID', 'clock.mode must be pin or internal', '$.clock.mode');
}

function parseOutputs(value: unknown): OutputsSpec | undefined {
  if (value === undefined) return undefined;
  const outputs = object(value, '$.outputs');
  const keys = [
    'instruction',
    'pc',
    'regWrite',
    'regAddr',
    'regData',
    'memWrite',
    'memAddr',
    'memData',
  ] as const;
  checkKeys(outputs, [...keys], '$.outputs');
  return {
    instruction: stringField(outputs, 'instruction', '$.outputs', true)!,
    pc: stringField(outputs, 'pc', '$.outputs', true)!,
    regWrite: stringField(outputs, 'regWrite', '$.outputs', true)!,
    regAddr: stringField(outputs, 'regAddr', '$.outputs', true)!,
    regData: stringField(outputs, 'regData', '$.outputs', true)!,
    memWrite: stringField(outputs, 'memWrite', '$.outputs', true)!,
    memAddr: stringField(outputs, 'memAddr', '$.outputs', true)!,
    memData: stringField(outputs, 'memData', '$.outputs', true)!,
  };
}

function parseReset(value: unknown): ResetSpec {
  const reset = object(value, '$.reset');
  const strategy = stringField(reset, 'strategy', '$.reset', true)!;
  if (strategy === 'none') {
    checkKeys(reset, ['strategy'], '$.reset');
    return {strategy: 'none'};
  }
  if (strategy === 'state') {
    checkKeys(reset, ['strategy'], '$.reset');
    return {strategy: 'state'};
  }
  if (strategy !== 'pin') {
    throw new ConfigError('CONFIG_INVALID', 'reset.strategy must be none, state or pin', '$.reset.strategy');
  }
  checkKeys(reset, ['strategy', 'pin', 'activeLow', 'ticks'], '$.reset');
  const pin = stringField(reset, 'pin', '$.reset', true)!;
  const activeLow = optionalBoolean(reset, 'activeLow', '$.reset') ?? false;
  const ticks = integerField(reset, 'ticks', '$.reset', 0, 100, false) ?? 1;
  return {strategy: 'pin', pin, activeLow, ticks};
}

function parsePc(value: unknown): PcSpec {
  const pc = object(value, '$.pc');
  const mode = stringField(pc, 'mode', '$.pc', true)!;
  const initial = parseWordField(required(pc, 'initial', '$.pc'), '$.pc.initial');
  if (mode === 'none') {
    // `checkEachCycle` is present when an already-parsed config is revalidated;
    // it is meaningless without a PC observation source and is ignored.
    checkKeys(pc, ['mode', 'initial', 'checkEachCycle'], '$.pc');
    return {mode: 'none', initial, checkEachCycle: false};
  }
  if (mode === 'register') {
    checkKeys(pc, ['mode', 'initial', 'path', 'checkEachCycle'], '$.pc');
    const path = stringField(pc, 'path', '$.pc', true)!;
    const checkEachCycle = optionalBoolean(pc, 'checkEachCycle', '$.pc') ?? true;
    return {mode: 'register', initial, path, checkEachCycle};
  }
  if (mode === 'pin') {
    checkKeys(pc, ['mode', 'initial', 'port', 'checkEachCycle'], '$.pc');
    const port = stringField(pc, 'port', '$.pc', true)!;
    const checkEachCycle = optionalBoolean(pc, 'checkEachCycle', '$.pc') ?? true;
    return {mode: 'pin', initial, port, checkEachCycle};
  }
  throw new ConfigError('CONFIG_INVALID', 'pc.mode must be none, register or pin', '$.pc.mode');
}

function parseRom(value: unknown): MemorySpec {
  const memory = object(value, '$.rom');
  checkKeys(memory, ['path', 'baseByteAddress', 'addressBits', 'addressShift', 'dataBits', 'capacityWords'], '$.rom');
  const path = stringField(memory, 'path', '$.rom', true)!;
  const baseByteAddress = parseWordField(required(memory, 'baseByteAddress', '$.rom'), '$.rom.baseByteAddress');
  const addressBits = integerField(memory, 'addressBits', '$.rom', 1, 24, true)!;
  const addressShift = integerField(memory, 'addressShift', '$.rom', 0, 3, true)!;
  const dataBits = integerField(memory, 'dataBits', '$.rom', 1, 32, true)!;
  const computedCapacity = 2 ** addressBits;
  if (computedCapacity > MAX_MEMORY_WORDS) {
    throw new ConfigError(
      'CONFIG_RANGE',
      `rom.addressBits=${addressBits} implies ${computedCapacity} words, above the supported limit ${MAX_MEMORY_WORDS}`,
      '$.rom.addressBits',
    );
  }
  const capacityWords = integerField(memory, 'capacityWords', '$.rom', 1, MAX_MEMORY_WORDS, false) ?? computedCapacity;
  if (capacityWords > computedCapacity) {
    throw new ConfigError(
      'CONFIG_MISMATCH',
      `rom.capacityWords ${capacityWords} exceeds the component capacity 2^addressBits = ${computedCapacity}`,
      '$.rom.capacityWords',
    );
  }
  const byteSpan = capacityWords * (1 << addressShift);
  if (baseByteAddress + byteSpan > 0x100000000) {
    throw new ConfigError('CONFIG_RANGE', 'rom region wraps past 0xFFFFFFFF', '$.rom');
  }
  return {path, baseByteAddress, addressBits, addressShift, dataBits, capacityWords};
}

function parseLogicalRam(value: unknown): RamSpec {
  const path = '$.ram';
  const memory = object(value, path);
  checkKeys(
    memory,
    ['path', 'baseByteAddress', 'addressBits', 'addressShift', 'dataBits', 'capacityWords', 'initial'],
    path,
  );
  // Legacy physical fields are accepted but intentionally not used.
  const legacyPath = optionalString(memory, 'path', path);
  const baseByteAddress = parseWordField(required(memory, 'baseByteAddress', path), `${path}.baseByteAddress`);
  const legacyBits = integerField(memory, 'addressBits', path, 1, 24, false);
  const legacyShift = integerField(memory, 'addressShift', path, 0, 3, false);
  const legacyDataBits = integerField(memory, 'dataBits', path, 1, 32, false);
  if (legacyShift !== undefined && legacyShift !== 2) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'The logical DM is word-addressed; legacy ram.addressShift must be 2 when present',
      `${path}.addressShift`,
    );
  }
  if (legacyDataBits !== undefined && legacyDataBits !== 32) {
    throw new ConfigError('CONFIG_INVALID', 'The logical DM is 32-bit word addressed', `${path}.dataBits`);
  }
  const explicitCapacity = integerField(memory, 'capacityWords', path, 1, MAX_MEMORY_WORDS, false);
  const capacityWords = explicitCapacity ?? (legacyBits === undefined ? undefined : 2 ** legacyBits);
  if (capacityWords === undefined) {
    throw new ConfigError('CONFIG_INVALID', 'ram.capacityWords is required for the logical DM', `${path}.capacityWords`);
  }
  const byteSpan = capacityWords * 4;
  if (baseByteAddress + byteSpan > 0x100000000) {
    throw new ConfigError('CONFIG_RANGE', 'Logical DM region wraps past 0xFFFFFFFF', path);
  }
  const initial = parseLegacyInitialRam(memory['initial'], path, baseByteAddress, capacityWords);
  return {
    path: legacyPath,
    baseByteAddress,
    // AddressMap needs geometry; derive it from the logical capacity. The
    // physical component (if any) is never inspected.
    addressBits: Math.max(1, Math.ceil(Math.log2(capacityWords))),
    addressShift: 2,
    dataBits: 32,
    capacityWords,
    initial,
  };
}

function parseLegacyInitialRam(
  value: unknown,
  path: string,
  baseByteAddress: number,
  capacityWords: number,
): InitialRamWord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError('CONFIG_TYPE', 'ram.initial must be an array', `${path}.initial`);
  if (value.length > 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'Physical/logical RAM initialization was removed; initialize DM with sw instructions instead of ram.initial',
      `${path}.initial`,
    );
  }
  return [];
}

function parseLimits(value: unknown): LimitsSpec {
  if (value === undefined) return {maxSteps: 10000, maxCycles: 10000};
  const limits = object(value, '$.limits');
  checkKeys(limits, ['maxSteps', 'maxCycles'], '$.limits');
  const maxSteps = integerField(limits, 'maxSteps', '$.limits', 1, 1_000_000, false) ?? 10000;
  const maxCycles = integerField(limits, 'maxCycles', '$.limits', 1, 1_000_000, false) ?? 10000;
  return {maxSteps, maxCycles};
}

function parseInputs(value: unknown): InputSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError('CONFIG_TYPE', 'inputs must be an array', '$.inputs');
  const seen = new Set<string>();
  return value.map((item, i) => {
    const path = `$.inputs[${i}]`;
    const input = object(item, path);
    checkKeys(input, ['port', 'value'], path);
    const port = stringField(input, 'port', path, true)!;
    const word = parseWordField(required(input, 'value', path), `${path}.value`);
    if (seen.has(port)) throw new ConfigError('CONFIG_INVALID', `Duplicate input port ${port}`, `${path}.port`);
    seen.add(port);
    return {port, value: word};
  });
}

function parseWordField(value: unknown, path: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new ConfigError('CONFIG_RANGE', 'Expected a 32-bit unsigned integer', path);
    }
    return value >>> 0;
  }
  if (typeof value === 'string') {
    const parsed = parseIntegerLiteral(value);
    if (parsed === null || parsed < 0 || parsed > 0xffffffff) {
      throw new ConfigError('CONFIG_RANGE', `Invalid unsigned word "${value}"`, path);
    }
    return u32(parsed);
  }
  throw new ConfigError('CONFIG_TYPE', 'Expected a number or 0x-prefixed string', path);
}

function required(objectValue: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(objectValue, key) || objectValue[key] === undefined) {
    throw new ConfigError('CONFIG_INVALID', `Missing required field "${key}"`, joinPath(path, key));
  }
  return objectValue[key];
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('CONFIG_TYPE', 'Expected an object', path);
  }
  return value as Record<string, unknown>;
}

function checkKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ConfigError('CONFIG_UNKNOWN_KEY', `Unknown field "${key}"`, joinPath(path, key));
    }
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  requiredField: boolean,
): string | undefined {
  const field = value[key];
  if (field === undefined) {
    if (requiredField) throw new ConfigError('CONFIG_INVALID', `Missing required field "${key}"`, joinPath(path, key));
    return undefined;
  }
  if (typeof field !== 'string' || field.length === 0) {
    throw new ConfigError('CONFIG_TYPE', 'Expected a non-empty string', joinPath(path, key));
  }
  return field;
}

function optionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  return stringField(value, key, path, false);
}

function optionalBoolean(value: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'boolean') throw new ConfigError('CONFIG_TYPE', 'Expected a boolean', joinPath(path, key));
  return field;
}

function integerField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  requiredField: boolean,
): number | undefined {
  const field = value[key];
  if (field === undefined) {
    if (requiredField) throw new ConfigError('CONFIG_INVALID', `Missing required field "${key}"`, joinPath(path, key));
    return undefined;
  }
  if (typeof field !== 'number' || !Number.isInteger(field)) {
    throw new ConfigError('CONFIG_TYPE', 'Expected an integer', joinPath(path, key));
  }
  if (field < min || field > max) {
    throw new ConfigError('CONFIG_RANGE', `Expected value in [${min}, ${max}]`, joinPath(path, key));
  }
  return field;
}

function joinPath(path: string, key: string): string {
  return path === '$' ? `$.${key}` : `${path}.${key}`;
}
