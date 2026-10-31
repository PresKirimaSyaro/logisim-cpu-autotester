import {assemble} from '../../mips-core/src/assembler/assembler.js';
import {ReferenceInterpreter} from '../../mips-core/src/interpreter/interpreter.js';
import {ConfigError} from '../../mips-core/src/errors.js';
import type {AddressRegion} from '../../mips-core/src/memory/address-map.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';
import {programInstructions, type DirectedTest, type TestLayout} from './directed.js';
import {ALL_INSTRUCTIONS, type InstructionName} from '../../mips-core/src/isa/instruction-set.js';

export type StressIntensity = 'quick' | 'standard' | 'stress';

export interface StressOptions {
  intensity?: StressIntensity;
  /** Override the number of seeded random programs. */
  seedCount?: number;
  /** Base seed for deterministic random programs. */
  seed?: number;
  /** Only programs using these instructions are returned. */
  instructions?: readonly InstructionName[];
}

export interface StressProfile {
  loopCount: number;
  nestedOuter: number;
  nestedInner: number;
  memoryCount: number;
  chainLength: number;
  branchFillers: number;
  seedCount: number;
}

const PROFILES: Record<StressIntensity, StressProfile> = {
  quick: {
    loopCount: 64,
    nestedOuter: 4,
    nestedInner: 4,
    memoryCount: 16,
    chainLength: 16,
    branchFillers: 16,
    seedCount: 1,
  },
  standard: {
    loopCount: 512,
    nestedOuter: 12,
    nestedInner: 12,
    memoryCount: 64,
    chainLength: 64,
    branchFillers: 64,
    seedCount: 4,
  },
  stress: {
    loopCount: 2048,
    nestedOuter: 24,
    nestedInner: 24,
    memoryCount: 256,
    chainLength: 256,
    branchFillers: 128,
    seedCount: 8,
  },
};

export function generateStressTests(layout: TestLayout, options: StressOptions = {}): DirectedTest[] {
  const intensity = options.intensity ?? 'standard';
  const profile = PROFILES[intensity];
  if (!profile) throw new ConfigError('CONFIG_INVALID', `Unknown stress intensity "${intensity}"`, '$.intensity');
  const enabled = new Set<InstructionName>(options.instructions ?? ALL_INSTRUCTIONS);
  const S = (index: number) => layout.signatureBase + index * 4;
  const M = (index: number) => layout.scratchBase + index * 4;
  const ram: AddressRegion = {
    baseByteAddress: layout.ramBase,
    addressBits: Math.max(1, Math.ceil(Math.log2(Math.max(1, layout.ramBytes / 4)))),
    addressShift: 2,
    dataBits: 32,
    capacityWords: Math.floor(layout.ramBytes / 4),
  };

  function make(
    id: string,
    name: string,
    description: string,
    lines: string[],
    signatureIndexes: number[],
    tags: string[],
    seed: number | null = null,
  ): DirectedTest {
    const assembly = `${lines.join('\n')}\n`;
    let program;
    try {
      program = assemble(assembly, {origin: 0});
    } catch (error) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `Generated stress program ${id} failed to assemble: ${error instanceof Error ? error.message : String(error)}`,
        '$.stress',
      );
    }
    const donePc = program.symbols['stress_done'];
    if (donePc === undefined) throw new Error(`Stress test ${id} has no stress_done label`);
    const cpu = new ReferenceInterpreter({
      romWords: program.words,
      rom: {baseByteAddress: 0, addressBits: 12, addressShift: 2, dataBits: 32, capacityWords: 4096},
      ram,
      initialPc: 0,
      instructions: ALL_INSTRUCTIONS,
    });
    const run = cpu.runUntilStop(donePc, 200000);
    if (run.status !== 'stop-pc') {
      throw new ConfigError(
        'CONFIG_INVALID',
        `Stress reference ${id} did not reach stress_done (${run.status})`,
        '$.stress',
      );
    }
    const memory = cpu.snapshotRamWords();
    const signature = signatureIndexes.map((index) => {
      const address = S(index);
      const wordIndex = (address - ram.baseByteAddress) >>> 2;
      return {byteAddress: address, expected: memory[wordIndex] >>> 0};
    });
    if (!signature.some((entry) => entry.expected !== 0)) {
      throw new ConfigError('CONFIG_INVALID', `Stress test ${id} has an all-zero signature`, '$.stress');
    }
    return {
      id,
      name,
      category: 'stress',
      description,
      assembly,
      steps: run.steps,
      signature,
      suites: ['stress'],
      tags,
      seed,
    };
  }

  const tests: DirectedTest[] = [];

  tests.push(
    make(
      `stress-loop-sum-${intensity}`,
      `loop sum × ${profile.loopCount}`,
      'Countdown loop accumulating a 32-bit sum and storing the result.',
      [
        `    ori $t0, $zero, ${profile.loopCount}`,
        '    ori $t1, $zero, 0',
        'loop:',
        '    add $t1, $t1, $t0',
        '    ori $t2, $zero, 1',
        '    sub $t0, $t0, $t2',
        '    beq $t0, $zero, loop_done',
        '    beq $zero, $zero, loop',
        'loop_done:',
        `    sw $t1, ${S(0)}($zero)`,
        'stress_done:',
      ],
      [0],
      ['loop', 'long-cycle', 'raw'],
    ),
  );

  tests.push(
    make(
      `stress-nested-loop-${intensity}`,
      `nested loop ${profile.nestedOuter}×${profile.nestedInner}`,
      'Nested countdown loops with dependent accumulation and branch/loop control.',
      [
        `    ori $t0, $zero, ${profile.nestedOuter}`,
        '    ori $t1, $zero, 0',
        'outer:',
        `    ori $t2, $zero, ${profile.nestedInner}`,
        'inner:',
        '    add $t1, $t1, $t0',
        '    ori $t3, $zero, 1',
        '    sub $t2, $t2, $t3',
        '    beq $t2, $zero, inner_done',
        '    beq $zero, $zero, inner',
        'inner_done:',
        '    sub $t0, $t0, $t3',
        '    beq $t0, $zero, outer_done',
        '    beq $zero, $zero, outer',
        'outer_done:',
        `    sw $t1, ${S(0)}($zero)`,
        'stress_done:',
      ],
      [0],
      ['loop', 'nested', 'long-cycle'],
    ),
  );

  tests.push(
    make(
      `stress-memory-loop-${intensity}`,
      `store/load loop × ${profile.memoryCount}`,
      'Repeated same-address store/load with a dependent ALU chain.',
      [
        `    ori $t0, $zero, ${profile.memoryCount}`,
        '    ori $t1, $zero, 0x1234',
        'mem_loop:',
        `    sw $t1, ${M(0)}($zero)`,
        `    lw $t2, ${M(0)}($zero)`,
        '    add $t1, $t1, $t2',
        '    ori $t3, $zero, 1',
        '    sub $t0, $t0, $t3',
        '    beq $t0, $zero, mem_done',
        '    beq $zero, $zero, mem_loop',
        'mem_done:',
        `    sw $t2, ${S(0)}($zero)`,
        '    ori $t5, $zero, 1',
        `    sw $t5, ${S(1)}($zero)`,
        'stress_done:',
      ],
      [0, 1],
      ['loop', 'memory', 'store-load'],
    ),
  );

  tests.push(
    make(
      `stress-negative-offset-${intensity}`,
      'negative offset with nonzero base',
      'Store and load through a nonzero base register with a negative word offset.',
      [
        `    ori $t6, $zero, ${layout.scratchBase + 16}`,
        '    ori $t0, $zero, 0x55',
        '    sw $t0, -16($t6)',
        '    lw $t1, -16($t6)',
        `    sw $t1, ${S(0)}($zero)`,
        'stress_done:',
      ],
      [0],
      ['memory', 'negative-offset', 'base-register'],
    ),
  );

  tests.push(
    make(
      `stress-grf-all-${intensity}`,
      'all GRF registers and $zero under stress',
      'Write and read every nonzero GRF register, then verify a write to $zero has no effect.',
      [
        ...Array.from({length: 31}, (_, index) => `    ori $${index + 1}, $zero, ${index + 1}`),
        ...Array.from({length: 31}, (_, index) => `    sw $${index + 1}, ${S(index)}($zero)`),
        '    add $zero, $t0, $t1',
        `    sw $zero, ${S(31)}($zero)`,
        'stress_done:',
      ],
      Array.from({length: 32}, (_, index) => index),
      ['grf', 'zero', 'register-coverage'],
    ),
  );

  tests.push(
    make(
      `stress-address-walk-${intensity}`,
      'address walk / boundary pattern',
      'Walk a register base through several aligned DM words with positive offsets.',
      [
        `    ori $t0, $zero, ${layout.scratchBase}`,
        '    ori $t1, $zero, 0x1111',
        '    ori $t2, $zero, 4',
        '    ori $t3, $zero, 8',
        'walk:',
        '    sw $t1, 0($t0)',
        '    add $t0, $t0, $t2',
        '    add $t1, $t1, $t3',
        '    ori $t4, $zero, 16',
        '    sub $t3, $t3, $t2',
        '    beq $t3, $zero, walk_done',
        '    beq $zero, $zero, walk',
        'walk_done:',
        `    sw $t1, ${S(0)}($zero)`,
        'stress_done:',
      ],
      [0],
      ['memory', 'address', 'offset'],
    ),
  );

  const chainLines: string[] = ['    ori $t0, $zero, 1'];
  for (let i = 0; i < profile.chainLength; i++) {
    chainLines.push('    add $t0, $t0, $t0');
  }
  chainLines.push(
    `    sw $t0, ${S(0)}($zero)`,
    '    ori $t5, $zero, 1',
    `    sw $t5, ${S(1)}($zero)`,
    'stress_done:',
  );
  tests.push(
    make(
      `stress-raw-chain-${intensity}`,
      `RAW chain × ${profile.chainLength}`,
      'A long back-to-back read-after-write dependency chain.',
      chainLines,
      [0, 1],
      ['raw', 'dependency', 'unrolled'],
    ),
  );

  const branchLines = [
    '    ori $t0, $zero, 0x55',
    '    beq $zero, $zero, branch_target',
  ];
  for (let i = 0; i < profile.branchFillers; i++) {
    branchLines.push(`    ori $t1, $zero, 0x${(i + 1).toString(16)}`);
  }
  branchLines.push(
    'branch_target:',
    `    sw $t0, ${S(0)}($zero)`,
    '    beq $zero, $zero, branch_done',
    '    ori $t2, $zero, 0xbad',
    'branch_done:',
    'stress_done:',
  );
  tests.push(
    make(
      `stress-long-branch-${intensity}`,
      'long forward branch over varied instructions',
      'Skip a long block of distinct instructions with an unconditional branch.',
      branchLines,
      [0],
      ['branch', 'forward', 'long-branch'],
    ),
  );

  tests.push(
    make(
      `stress-stack-walk-${intensity}`,
      'stack save/load walk',
      'Use a nonzero stack pointer, repeated negative-offset save/load and a loop-carried sum.',
      [
        `    ori $sp, $zero, ${layout.scratchBase + 0x100}`,
        `    ori $t0, $zero, ${profile.loopCount}`,
        '    ori $t1, $zero, 0',
        'stack_loop:',
        '    sw $t0, -4($sp)',
        '    lw $t2, -4($sp)',
        '    add $t1, $t1, $t2',
        '    ori $t3, $zero, 1',
        '    sub $t0, $t0, $t3',
        '    beq $t0, $zero, stack_done',
        '    beq $zero, $zero, stack_loop',
        'stack_done:',
        `    sw $t1, ${S(0)}($zero)`,
        'stress_done:',
      ],
      [0],
      ['stack', 'negative-offset', 'loop', 'data-dependency'],
    ),
  );

  tests.push(
    make(
      `stress-many-offsets-${intensity}`,
      'many positive and negative offsets',
      'Read/write a range of offsets from one base and sum the values after the reverse pass.',
      [
        `    ori $s1, $zero, ${layout.scratchBase + 0x80}`,
        ...Array.from({length: 8}, (_, index) => `    ori $t${index}, $zero, ${0x40 + index}`),
        ...Array.from({length: 8}, (_, index) => `    sw $t${index}, ${(index - 4) * 4}($s1)`),
        '    ori $s0, $zero, 0',
        ...Array.from({length: 8}, (_, index) => `    lw $t${index}, ${(index - 4) * 4}($s1)`),
        ...Array.from({length: 8}, (_, index) => `    add $s0, $s0, $t${index}`),
        `    sw $s0, ${S(0)}($zero)`,
        'stress_done:',
      ],
      [0],
      ['memory', 'offset', 'positive-negative', 'dependency'],
    ),
  );

  const seeded = options.seedCount ?? profile.seedCount;
  const baseSeed = options.seed ?? 0x5a17c0de;
  for (let index = 0; index < seeded; index++) {
    const seed = (baseSeed + Math.imul(index, 0x9e3779b1)) >>> 0;
    let state = seed || 1;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const lines: string[] = [];
    const registers = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `$t${n}`);
    for (const register of registers) {
      lines.push(...const32(register, next() || 1));
    }
    for (let step = 0; step < 24; step++) {
      const dst = registers[next() % registers.length];
      const left = registers[next() % registers.length];
      const right = registers[next() % registers.length];
      const choice = next() % (enabled.has('sll') ? 5 : 4);
      switch (choice) {
        case 0:
          lines.push(`    add ${dst}, ${left}, ${right}`);
          break;
        case 1:
          lines.push(`    sub ${dst}, ${left}, ${right}`);
          break;
        case 2:
          lines.push(`    ori ${dst}, ${left}, 0x${(next() & 0xffff).toString(16)}`);
          break;
        case 3: {
          const branch = `seed_skip_${index}_${step}`;
          lines.push(`    beq ${left}, ${right}, ${branch}`);
          lines.push(`    add ${dst}, ${left}, $zero`);
          lines.push(`${branch}:`);
          break;
        }
        default:
          lines.push(`    sll ${dst}, ${left}, ${next() & 31}`);
          break;
      }
    }
    for (let i = 0; i < 8; i++) {
      lines.push(`    sw ${registers[i]}, ${S(i)}($zero)`);
    }
    lines.push('stress_done:');
    tests.push(
      make(
        `stress-seeded-${intensity}-${index}`,
        `seeded 32-bit mix ${index}`,
        'Fixed-seed constrained random ALU/register program with 32-bit values.',
        lines,
        [0, 1, 2, 3, 4, 5, 6, 7],
        ['seeded', 'random', '32-bit'],
        seed,
      ),
    );
  }

  return tests.filter((test) => programInstructions(test.assembly).every((name) => enabled.has(name)));
}

function const32(register: string, value: number): string[] {
  const unsigned = value >>> 0;
  const high = unsigned >>> 16;
  const low = unsigned & 0xffff;
  if (high === 0) return [`    ori ${register}, $zero, 0x${low.toString(16)}`];
  return [
    `    lui ${register}, 0x${high.toString(16)}`,
    `    ori ${register}, ${register}, 0x${low.toString(16)}`,
  ];
}

export function stressProfile(intensity: StressIntensity): StressProfile {
  return {...PROFILES[intensity]};
}

/** Convenience for callers that already have a CpuConfig but only need layout. */
export function stressTestsForConfig(
  config: CpuConfig,
  layout: TestLayout,
  options: StressOptions = {},
): DirectedTest[] {
  if (config.ram.capacityWords < 64) {
    throw new ConfigError('CONFIG_RANGE', 'Stress tests require at least 64 logical DM words', '$.ram');
  }
  return generateStressTests(layout, options);
}
