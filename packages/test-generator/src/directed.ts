import {ConfigError} from '../../mips-core/src/errors.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';
import {ALL_INSTRUCTIONS, type InstructionName} from '../../mips-core/src/isa/instruction-set.js';

export type TestCategory = 'add-sub' | 'ori' | 'sll' | 'lui' | 'j' | 'nextpc' | 'lw-sw' | 'beq' | 'mixed' | 'stress';

export interface SignatureExpectation {
  byteAddress: number;
  expected: number;
}

export interface DirectedTest {
  id: string;
  name: string;
  category: TestCategory;
  description: string;
  assembly: string;
  /** Exact number of dynamic instructions the reference and CPU must execute. */
  steps: number;
  /** Expected final values in the logical DM. At least one must be non-zero. */
  signature: SignatureExpectation[];
  suites: string[];
  tags: string[];
  seed: number | null;
}

export interface TestLayout {
  ramBase: number;
  ramBytes: number;
  signatureBase: number;
  scratchBase: number;
  lastWordAddress: number;
}

/**
 * Derive test addresses from the configured RAM region instead of hardcoding a
 * course memory map. Signature and scratch areas are separate from address 0 so
 * "still zero" can never be mistaken for a real result.
 */
export function layoutForConfig(config: CpuConfig): TestLayout {
  const ram = config.ram;
  const bytes = ram.capacityWords * (1 << ram.addressShift);
  const base = ram.baseByteAddress;
  if (bytes < 256) {
    throw new ConfigError(
      'CONFIG_RANGE',
      `Directed tests need at least 256 bytes of RAM (configured: ${bytes})`,
      '$.ram',
    );
  }
  const signatureBase = base + (bytes >= 768 ? 0x100 : 0x40);
  const scratchBase = signatureBase + (bytes >= 768 ? 0x100 : 0x40);
  const lastWordAddress = base + (ram.capacityWords - 1) * 4;
  for (const [name, address] of [
    ['signatureBase', signatureBase],
    ['scratchBase', scratchBase],
    ['lastWordAddress', lastWordAddress],
  ] as const) {
    if (address > 0x7fff) {
      throw new ConfigError(
        'CONFIG_RANGE',
        `${name} 0x${address.toString(16)} exceeds the signed 16-bit offset range; choose a RAM base at or below 0x7000`,
        '$.ram.baseByteAddress',
      );
    }
  }
  if (scratchBase + 64 > base + bytes) {
    throw new ConfigError(
      'CONFIG_RANGE',
      'Configured RAM is too small for the directed signature and scratch areas',
      '$.ram',
    );
  }
  return {ramBase: base, ramBytes: bytes, signatureBase, scratchBase, lastWordAddress};
}
/** Mnemonics used by a concrete program, ignoring labels and comments. */
export function programInstructions(source: string): InstructionName[] {
  const result: InstructionName[] = [];
  for (const line of source.split(/\r?\n/)) {
    let text = line.replace(/#.*$/, '').trim();
    if (!text) continue;
    text = text.replace(/^(?:[A-Za-z_]\w*:\s*)+/, '');
    const match = /^([A-Za-z]\w*)\b/.exec(text);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if ((ALL_INSTRUCTIONS as readonly string[]).includes(name)) result.push(name as InstructionName);
  }
  return result;
}

export function selectSuite(tests: DirectedTest[], suite: string): DirectedTest[] {
  return tests.filter((test) => test.suites.includes(suite));
}
