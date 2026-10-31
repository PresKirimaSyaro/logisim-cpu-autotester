import {assemble} from '../../mips-core/src/assembler/assembler.js';
import {ReferenceInterpreter} from '../../mips-core/src/interpreter/interpreter.js';
import {ALL_INSTRUCTIONS, type InstructionName} from '../../mips-core/src/isa/instruction-set.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';
import type {AddressRegion} from '../../mips-core/src/memory/address-map.js';
import type {DirectedTest, TestLayout} from './directed.js';

export interface RandomOptions {
  /** Number of programs to generate. Clamped to 1..500. */
  count?: number;
  seed?: number;
  instructions?: readonly InstructionName[];
  /** Upper bound on generated instructions per program. */
  maxInstructions?: number;
}

const DEFAULT_SEED = 0x5eedc0de;
const DATA_REGISTERS = Array.from({length: 8}, (_, index) => `$t${index}`);
const BASE_REGISTER = '$s7';

/**
 * Build deterministic constrained-random programs. Every program:
 *  - initializes all data registers;
 *  - uses only enabled mnemonics;
 *  - uses a non-zero memory base for lw/sw;
 *  - contains only forward beq targets, so it always terminates;
 *  - is run through the real reference interpreter to obtain exact steps and
 *    final-DM signatures.
 */
export function generateRandomTests(layout: TestLayout, options: RandomOptions = {}): DirectedTest[] {
  const count = Math.max(1, Math.min(500, Math.trunc(options.count ?? 20)));
  const seed = (options.seed ?? DEFAULT_SEED) >>> 0;
  const allowed = new Set<InstructionName>(options.instructions ?? ALL_INSTRUCTIONS);
  const maxInstructions = Math.max(8, Math.min(200, Math.trunc(options.maxInstructions ?? 28)));
  if (!allowed.has('ori') || !allowed.has('sw')) {
    throw new Error('random tests require both ori (constants/signatures) and sw (observable memory writes) to be enabled');
  }
  const ram = ramRegion(layout);
  const tests: DirectedTest[] = [];

  for (let index = 0; index < count; index++) {
    const random = mulberry32((seed + Math.imul(index, 0x9e3779b1)) >>> 0);
    const lines: string[] = [];
    let branchId = 0;

    const const32 = (register: string, value: number): string[] => {
      const unsigned = value >>> 0;
      const high = unsigned >>> 16;
      const low = unsigned & 0xffff;
      if (high === 0) return [`    ori ${register}, $zero, 0x${low.toString(16)}`];
      if (allowed.has('lui')) {
        return [
          `    lui ${register}, 0x${high.toString(16)}`,
          `    ori ${register}, ${register}, 0x${low.toString(16)}`,
        ];
      }
      if (allowed.has('sll')) {
        return [
          `    ori ${register}, $zero, 0x${high.toString(16)}`,
          `    sll ${register}, ${register}, 16`,
          `    ori ${register}, ${register}, 0x${low.toString(16)}`,
        ];
      }
      return [`    ori ${register}, $zero, 0x${low.toString(16)}`];
    };

    const randomValue = () => {
      const choice = random() % 6;
      if (choice === 0) return 0;
      if (choice === 1) return 0x7fffffff;
      if (choice === 2) return 0x80000000;
      if (choice === 3) return 0xffffffff;
      return random() >>> 0;
    };

    // Seed the signature/scratch area and all data registers.
    lines.push(`    ori ${BASE_REGISTER}, $zero, 0x${(layout.scratchBase + 0x100).toString(16)}`);
    for (const register of DATA_REGISTERS) lines.push(...const32(register, randomValue()));
    const initial = DATA_REGISTERS.map((register) => register);

    const nonBranch = ['add', 'sub', 'ori'].filter((name) => allowed.has(name as InstructionName));
    if (allowed.has('lui')) nonBranch.push('lui');
    if (allowed.has('sll')) nonBranch.push('sll');
    if (allowed.has('lw')) nonBranch.push('lw');
    if (allowed.has('sw')) nonBranch.push('sw');
    if (nonBranch.length === 0) throw new Error('random tests need at least one data instruction');

    const instructionCount = 10 + (random() % Math.max(1, maxInstructions - 9));
    for (let step = 0; step < instructionCount; step++) {
      const op = nonBranch[random() % nonBranch.length];
      const dest = initial[random() % initial.length];
      const left = initial[random() % initial.length];
      const right = initial[random() % initial.length];
      switch (op) {
        case 'add':
          lines.push(`    add ${dest}, ${left}, ${right}`);
          break;
        case 'sub':
          lines.push(`    sub ${dest}, ${left}, ${right}`);
          break;
        case 'ori':
          lines.push(`    ori ${dest}, ${left}, 0x${(random() & 0xffff).toString(16)}`);
          break;
        case 'lui':
          lines.push(`    lui ${dest}, 0x${(random() & 0xffff).toString(16)}`);
          break;
        case 'sll':
          lines.push(`    sll ${dest}, ${left}, ${random() & 31}`);
          break;
        case 'lw':
        case 'sw': {
          const offset = ((random() % 33) - 16) * 4;
          const value = initial[random() % initial.length];
          lines.push(`    ${op} ${value}, ${offset}(${BASE_REGISTER})`);
          break;
        }
      }

      // Forward branches skip 1-3 generated data instructions; every path
      // converges at the label, so the program cannot loop forever.
      if (allowed.has('beq') && random() % 9 === 0) {
        const target = `random_target_${index}_${branchId++}`;
        const a = initial[random() % initial.length];
        const b = initial[random() % initial.length];
        lines.push(`    beq ${a}, ${b}, ${target}`);
        const skipCount = 1 + (random() % 3);
        for (let skip = 0; skip < skipCount; skip++) {
          lines.push(`    ori $t7, $t7, 0x${(random() & 0xffff).toString(16)}`);
        }
        lines.push(`${target}:`);
      }
    }

    for (let i = 0; i < DATA_REGISTERS.length; i++) {
      lines.push(`    sw ${DATA_REGISTERS[i]}, ${layout.signatureBase + i * 4}($zero)`);
    }
    lines.push('    ori $s6, $zero, 0x5a');
    lines.push(`    sw $s6, ${layout.signatureBase + DATA_REGISTERS.length * 4}($zero)`);
    const endLabel = `random_end_${index}`;
    lines.push(`${endLabel}:`);

    const assembly = `${lines.join('\n')}\n`;
    const program = assemble(assembly, {origin: 0x3000, instructions: ALL_INSTRUCTIONS});
    const endPc = program.symbols[endLabel];
    if (endPc === undefined) throw new Error('random program has no end label');
    const cpu = new ReferenceInterpreter({
      romWords: program.words,
      rom: {baseByteAddress: 0x3000, addressBits: 12, addressShift: 2, dataBits: 32, capacityWords: 4096},
      ram,
      initialPc: 0x3000,
      instructions: ALL_INSTRUCTIONS,
    });
    const run = cpu.runUntilStop(endPc, 200000);
    if (run.status !== 'stop-pc') throw new Error(`random reference stopped with ${run.status}`);
    const memory = cpu.snapshotRamWords();
    const signature = Array.from({length: DATA_REGISTERS.length + 1}, (_, i) => ({
      byteAddress: layout.signatureBase + i * 4,
      expected: memory[(layout.signatureBase + i * 4) >>> 2] >>> 0,
    }));
    if (!signature.some((entry) => entry.expected !== 0)) throw new Error('random test has all-zero signature');

    tests.push({
      id: `random-${seed.toString(16)}-${index}`,
      name: `random program ${index + 1} (seed 0x${seed.toString(16)})`,
      category: 'random',
      description: 'Deterministic constrained-random program with non-zero memory base and forward-only branches.',
      assembly,
      steps: run.steps,
      signature,
      suites: ['random'],
      tags: ['random', 'seeded', '32-bit', 'non-zero-base'],
      seed,
    });
  }
  return tests;
}

/** Convenience for callers that already have a CpuConfig. */
export function randomTestsForConfig(
  config: CpuConfig,
  layout: TestLayout,
  options: RandomOptions = {},
): DirectedTest[] {
  return generateRandomTests(layout, options);
}

function ramRegion(layout: TestLayout): AddressRegion {
  return {
    baseByteAddress: layout.ramBase,
    addressBits: 32,
    addressShift: 2,
    dataBits: 32,
    capacityWords: layout.ramBytes >>> 2,
  };
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}
