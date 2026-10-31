import {ConfigError} from '../../mips-core/src/errors.js';
import type {CpuConfig} from '../../mips-core/src/config/config.js';

export type TestCategory = 'add-sub' | 'ori' | 'sll' | 'lw-sw' | 'beq' | 'mixed';

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

export function generateDirectedTests(layout: TestLayout): DirectedTest[] {
  const S = (index: number) => layout.signatureBase + index * 4;
  const M = (index: number) => layout.scratchBase + index * 4;
  const sw = (register: string, index: number) => `    sw ${register}, ${S(index)}($zero)`;
  const test = (
    id: string,
    name: string,
    category: TestCategory,
    description: string,
    lines: string[],
    steps: number,
    signature: [number, number][],
    options: {suites?: string[]; tags?: string[]; seed?: number} = {},
  ): DirectedTest => {
    if (signature.length === 0) throw new Error('Directed test must have a signature');
    if (!signature.some(([, value]) => (value >>> 0) !== 0)) {
      throw new Error(`Directed test ${id} has an all-zero signature`);
    }
    const defaultSuites =
      category === 'lw-sw'
        ? ['basic', 'full', 'memory']
        : category === 'beq'
          ? ['full', 'branch']
          : category === 'mixed'
            ? ['basic', 'full']
            : ['basic', 'full', 'alu'];
    return {
      id,
      name,
      category,
      description,
      assembly: lines.join('\n') + '\n',
      steps,
      signature: signature.map(([index, value]) => ({byteAddress: S(index), expected: value >>> 0})),
      suites: options.suites ?? defaultSuites,
      tags: options.tags ?? [],
      seed: options.seed ?? null,
    };
  };

  const cases: DirectedTest[] = [
    // ---------------------------------------------------------------- add/sub
    test(
      'add-zero',
      'add 0 + 0',
      'add-sub',
      'Zero operands, with a non-zero marker so the test is observable.',
      [
        '    ori $t0, $zero, 0',
        '    ori $t1, $zero, 0',
        '    add $t2, $t0, $t1',
        sw('$t2', 0),
        '    ori $t3, $zero, 1',
        sw('$t3', 1),
      ],
      6,
      [
        [0, 0],
        [1, 1],
      ],
      {tags: ['zero', 'marker']},
    ),
    test(
      'add-basic',
      'add 5 + 7',
      'add-sub',
      'Ordinary addition and a RAM signature.',
      ['    ori $t0, $zero, 5', '    ori $t1, $zero, 7', '    add $t2, $t0, $t1', sw('$t2', 0)],
      4,
      [[0, 12]],
    ),
    test(
      'sub-basic',
      'sub 9 - 4',
      'add-sub',
      'Ordinary subtraction.',
      ['    ori $t0, $zero, 9', '    ori $t1, $zero, 4', '    sub $t2, $t0, $t1', sw('$t2', 0)],
      4,
      [[0, 5]],
    ),
    test(
      'add-wrap-32',
      'add wraps modulo 2^32',
      'add-sub',
      '0xFFFFFFFF + 1 must produce 0 without an overflow exception.',
      [
        ...const32('$t0', 0xffffffff),
        '    ori $t1, $zero, 1',
        '    add $t2, $t0, $t1',
        sw('$t2', 0),
        sw('$t1', 1),
      ],
      7,
      [
        [0, 0],
        [1, 1],
      ],
      {tags: ['wrap']},
    ),
    test(
      'sub-underflow',
      'sub underflows to 0xFFFFFFFF',
      'add-sub',
      '0 - 1 must wrap, not trap.',
      ['    ori $t0, $zero, 0', '    ori $t1, $zero, 1', '    sub $t2, $t0, $t1', sw('$t2', 0)],
      4,
      [[0, 0xffffffff]],
      {tags: ['wrap']},
    ),
    test(
      'add-sign-bit',
      'add crosses the sign bit',
      'add-sub',
      '0x7FFFFFFF + 1 becomes 0x80000000, not an overflow exception.',
      [
        ...const32('$t0', 0x7fffffff),
        '    ori $t1, $zero, 1',
        '    add $t2, $t0, $t1',
        sw('$t2', 0),
      ],
      6,
      [[0, 0x80000000]],
      {tags: ['sign-bit']},
    ),
    test(
      'add-same-register',
      'add rd = rs = rt',
      'add-sub',
      'Source and destination register are the same.',
      ['    ori $t0, $zero, 21', '    add $t0, $t0, $t0', sw('$t0', 0)],
      3,
      [[0, 42]],
      {tags: ['aliasing']},
    ),
    test(
      'add-zero-register',
      'add with $zero and write to $zero',
      'add-sub',
      '$zero reads as zero and ignores writes.',
      [
        '    ori $t0, $zero, 0x1234',
        '    add $t1, $t0, $zero',
        sw('$t1', 0),
        '    add $zero, $t1, $t1',
        sw('$zero', 1),
      ],
      5,
      [
        [0, 0x1234],
        [1, 0],
      ],
      {tags: ['zero']},
    ),
    test(
      'add-dependency-chain',
      'add data-dependency chain',
      'add-sub',
      'Back-to-back dependent additions.',
      [
        '    ori $t0, $zero, 1',
        '    ori $t1, $zero, 2',
        '    add $t2, $t0, $t1',
        '    add $t3, $t2, $t1',
        '    add $t4, $t3, $t2',
        sw('$t4', 0),
      ],
      6,
      [[0, 8]],
      {tags: ['dependency']},
    ),
    test(
      'sub-same-source',
      'sub rs = rt',
      'add-sub',
      'Equal source registers produce zero; a marker proves execution.',
      ['    ori $t0, $zero, 123', '    sub $t1, $t0, $t0', sw('$t1', 0), sw('$t0', 1)],
      4,
      [
        [0, 0],
        [1, 123],
      ],
    ),

    // -------------------------------------------------------------------- ori
    test(
      'ori-zero-immediate',
      'ori immediate 0',
      'ori',
      'ori with zero immediate leaves the low half unchanged; source high half is preserved.',
      [
        '    ori $t0, $zero, 0',
        '    ori $t1, $zero, 0x1234',
        '    ori $t2, $t0, 0x1234',
        sw('$t2', 0),
        sw('$t0', 1),
      ],
      5,
      [
        [0, 0x1234],
        [1, 0],
      ],
    ),
    test(
      'ori-ffff',
      'ori immediate 0xFFFF',
      'ori',
      '0xFFFF is zero-extended, not sign-extended.',
      ['    ori $t0, $zero, 0xffff', sw('$t0', 0)],
      2,
      [[0, 0x0000ffff]],
      {tags: ['zero-extend']},
    ),
    test(
      'ori-preserve-high',
      'ori preserves the high 16 bits',
      'ori',
      '0x12340000 | 0xABCD = 0x1234ABCD.',
      [...const32('$t0', 0x12340000), '    ori $t0, $t0, 0xabcd', sw('$t0', 0)],
      5,
      [[0, 0x1234abcd]],
    ),
    test(
      'ori-same-register',
      'ori with rd = rs',
      'ori',
      'In-place OR-immediate.',
      ['    ori $t0, $zero, 0x00ff', '    ori $t0, $t0, 0x1100', sw('$t0', 0)],
      3,
      [[0, 0x11ff]],
      {tags: ['aliasing']},
    ),
    test(
      'ori-negative-literal',
      'ori -1 encodes 0xFFFF',
      'ori',
      'A negative literal is encoded as its 16-bit two\'s-complement pattern and zero-extended on read.',
      ['    ori $t0, $zero, -1', sw('$t0', 0)],
      2,
      [[0, 0x0000ffff]],
      {tags: ['negative']},
    ),
    test(
      'ori-high-bit',
      'ori 0x8000 is not sign-extended',
      'ori',
      'The immediate high bit must not propagate into the upper 16 bits.',
      ['    ori $t0, $zero, 0x8000', sw('$t0', 0)],
      2,
      [[0, 0x00008000]],
      {tags: ['zero-extend']},
    ),

    // -------------------------------------------------------------------- sll
    test(
      'sll-zero',
      'sll by 0',
      'sll',
      'shamt = 0 returns the input unchanged.',
      [...const32('$t0', 0x12345678), '    sll $t1, $t0, 0', sw('$t1', 0)],
      5,
      [[0, 0x12345678]],
    ),
    test(
      'sll-one-high-bit-out',
      'sll by 1 shifts the top bit out',
      'sll',
      '0x80000001 << 1 = 0x00000002.',
      [...const32('$t0', 0x80000001), '    sll $t1, $t0, 1', sw('$t1', 0)],
      5,
      [[0, 0x00000002]],
      {tags: ['shift-out']},
    ),
    test(
      'sll-15',
      'sll by 15',
      'sll',
      '0x12345678 << 15 = 0x2B3C0000.',
      [...const32('$t0', 0x12345678), '    sll $t1, $t0, 15', sw('$t1', 0)],
      5,
      [[0, 0x2b3c0000]],
    ),
    test(
      'sll-16',
      'sll by 16',
      'sll',
      '0x12345678 << 16 = 0x56780000.',
      [...const32('$t0', 0x12345678), '    sll $t1, $t0, 16', sw('$t1', 0)],
      5,
      [[0, 0x56780000]],
    ),
    test(
      'sll-30',
      'sll by 30',
      'sll',
      '3 << 30 = 0xC0000000.',
      ['    ori $t0, $zero, 3', '    sll $t1, $t0, 30', sw('$t1', 0)],
      3,
      [[0, 0xc0000000]],
    ),
    test(
      'sll-31',
      'sll by 31',
      'sll',
      '1 << 31 = 0x80000000.',
      ['    ori $t0, $zero, 1', '    sll $t1, $t0, 31', sw('$t1', 0)],
      3,
      [[0, 0x80000000]],
    ),
    test(
      'sll-same-register',
      'sll rd = rt',
      'sll',
      'In-place shift left.',
      ['    ori $t0, $zero, 1', '    sll $t0, $t0, 4', sw('$t0', 0)],
      3,
      [[0, 16]],
      {tags: ['aliasing']},
    ),
    test(
      'sll-zero-destination',
      'sll writes to $zero',
      'sll',
      '$zero must remain zero after being used as rd.',
      [
        '    ori $t0, $zero, 1',
        '    sll $zero, $t0, 1',
        '    add $t1, $zero, $zero',
        '    ori $t1, $t1, 7',
        sw('$t1', 0),
        sw('$zero', 1),
      ],
      6,
      [
        [0, 7],
        [1, 0],
      ],
      {tags: ['zero']},
    ),
    test(
      'sll-dependency',
      'sll result feeds another sll',
      'sll',
      '1 << 4 = 16; 16 << 1 = 32; 32 + 1 = 33.',
      [
        '    ori $t0, $zero, 1',
        '    sll $t1, $t0, 4',
        '    sll $t2, $t1, 1',
        '    add $t3, $t2, $t0',
        sw('$t3', 0),
      ],
      5,
      [[0, 33]],
      {tags: ['dependency']},
    ),
    test(
      'sll-all-shift-amounts',
      'sll covers all 32 shift amounts',
      'sll',
      'Shift 0xDEADBEEF by every shamt 0..31 and store each 32-bit result.',
      [
        ...const32('$t0', 0xdeadbeef),
        ...Array.from({length: 32}, (_, shamt) => [
          `    sll $t1, $t0, ${shamt}`,
          `    sw $t1, ${S(shamt)}($zero)`,
        ]).flat(),
      ],
      67,
      Array.from({length: 32}, (_, shamt) => [shamt, (0xdeadbeef << shamt) >>> 0] as [number, number]),
      {tags: ['shift-amounts', '32-bit']},
    ),

    // ------------------------------------------------------------------ lw/sw
    test(
      'store-load',
      'sw then lw',
      'lw-sw',
      'Store 0x1234, load it back and store through a register.',
      [
        '    ori $t0, $zero, 0x1234',
        `    sw $t0, ${M(0)}($zero)`,
        `    lw $t1, ${M(0)}($zero)`,
        '    add $t2, $t1, $zero',
        sw('$t2', 0),
      ],
      5,
      [[0, 0x1234]],
    ),
    test(
      'multiple-addresses',
      'multiple RAM addresses',
      'lw-sw',
      'Two distinct words are written and read independently.',
      [
        '    ori $t0, $zero, 0x11',
        `    sw $t0, ${M(0)}($zero)`,
        '    ori $t1, $zero, 0x22',
        `    sw $t1, ${M(1)}($zero)`,
        `    lw $t2, ${M(0)}($zero)`,
        `    lw $t3, ${M(1)}($zero)`,
        '    add $t4, $t2, $t3',
        sw('$t4', 0),
      ],
      8,
      [[0, 0x33]],
    ),
    test(
      'overwrite-same-address',
      'repeated overwrite',
      'lw-sw',
      'The second store to the same address must win.',
      [
        '    ori $t0, $zero, 1',
        `    sw $t0, ${M(0)}($zero)`,
        '    ori $t1, $zero, 2',
        `    sw $t1, ${M(0)}($zero)`,
        `    lw $t2, ${M(0)}($zero)`,
        sw('$t2', 0),
      ],
      6,
      [[0, 2]],
    ),
    test(
      'negative-offset',
      'negative offset with a non-zero base',
      'lw-sw',
      'Base = M0+8, access at -8(base).',
      [
        `    ori $t6, $zero, ${M(0) + 8}`,
        '    ori $t0, $zero, 0x55',
        `    sw $t0, -8($t6)`,
        `    lw $t1, -8($t6)`,
        sw('$t1', 0),
      ],
      5,
      [[0, 0x55]],
      {tags: ['negative-offset', 'base-register']},
    ),
    test(
      'base-not-zero',
      'base register is not $zero',
      'lw-sw',
      'Use $t6 = M0 as the base and offset 0.',
      [
        `    ori $t6, $zero, ${M(0)}`,
        '    ori $t0, $zero, 0x77',
        '    sw $t0, 0($t6)',
        '    lw $t1, 0($t6)',
        sw('$t1', 0),
      ],
      5,
      [[0, 0x77]],
      {tags: ['base-register']},
    ),
    test(
      'load-after-store-32bit',
      'lw reads a 32-bit value just stored',
      'lw-sw',
      'Initialize the logical DM with sw, then load the full 0xCAFEBABE pattern back.',
      [
        ...const32('$t0', 0xcafebabe),
        `    sw $t0, ${M(0)}($zero)`,
        `    lw $t1, ${M(0)}($zero)`,
        sw('$t1', 0),
      ],
      6,
      [[0, 0xcafebabe]],
      {tags: ['store-load', '32-bit']},
    ),
    test(
      'address-boundary-last-word',
      'store/load at the last RAM word',
      'lw-sw',
      'Exercises the upper address boundary of the configured RAM.',
      [
        '    ori $t0, $zero, 0x5a5a',
        `    sw $t0, ${layout.lastWordAddress}($zero)`,
        `    lw $t1, ${layout.lastWordAddress}($zero)`,
        sw('$t1', 0),
      ],
      4,
      [[0, 0x5a5a]],
      {tags: ['boundary']},
    ),
    test(
      'store-load-dependency',
      'store then immediately load and use',
      'lw-sw',
      '0xABCD * 2 = 0x0001579A.',
      [
        '    ori $t0, $zero, 0xabcd',
        `    sw $t0, ${M(0)}($zero)`,
        `    lw $t1, ${M(0)}($zero)`,
        '    add $t2, $t1, $t1',
        sw('$t2', 0),
      ],
      5,
      [[0, 0x0001579a]],
      {tags: ['dependency']},
    ),
    test(
      'load-use-immediate',
      'lw result feeds an ALU operation',
      'lw-sw',
      '0x10 + 5 = 0x15.',
      [
        '    ori $t0, $zero, 0x10',
        `    sw $t0, ${M(0)}($zero)`,
        `    lw $t1, ${M(0)}($zero)`,
        '    ori $t2, $zero, 5',
        '    add $t3, $t1, $t2',
        sw('$t3', 0),
      ],
      6,
      [[0, 0x15]],
      {tags: ['dependency']},
    ),

    // -------------------------------------------------------------------- beq
    test(
      'beq-taken',
      'beq taken',
      'beq',
      'Equal registers skip one instruction.',
      [
        '    ori $t0, $zero, 3',
        '    ori $t1, $zero, 3',
        '    beq $t0, $t1, equal',
        '    ori $t2, $zero, 0xbad',
        'equal:',
        '    ori $t2, $zero, 0x600d',
        sw('$t2', 0),
      ],
      5,
      [[0, 0x600d]],
      {suites: ['basic', 'full', 'branch'], tags: ['taken']},
    ),
    test(
      'beq-not-taken',
      'beq not taken',
      'beq',
      'Unequal registers fall through.',
      [
        '    ori $t0, $zero, 3',
        '    ori $t1, $zero, 4',
        '    beq $t0, $t1, skip',
        '    ori $t2, $zero, 0x1111',
        sw('$t2', 0),
        'skip:',
        sw('$t2', 1),
      ],
      6,
      [
        [0, 0x1111],
        [1, 0x1111],
      ],
      {suites: ['full', 'branch'], tags: ['not-taken']},
    ),
    test(
      'beq-offset-zero',
      'beq with offset 0',
      'beq',
      'Target is PC+4, the same address as fall-through.',
      [
        '    ori $t0, $zero, 1',
        '    ori $t1, $zero, 1',
        '    beq $t0, $t1, next',
        'next:',
        '    ori $t2, $zero, 0x2222',
        sw('$t2', 0),
      ],
      5,
      [[0, 0x2222]],
      {suites: ['full', 'branch'], tags: ['offset-zero']},
    ),
    test(
      'beq-forward-skip',
      'beq with a positive offset',
      'beq',
      'Skip a store and a marker instruction.',
      [
        '    ori $t0, $zero, 1',
        '    ori $t1, $zero, 1',
        '    beq $t0, $t1, forward',
        '    ori $t2, $zero, 0xbad',
        sw('$t2', 1),
        'forward:',
        '    ori $t2, $zero, 0x3333',
        sw('$t2', 0),
      ],
      5,
      [
        [0, 0x3333],
        [1, 0],
      ],
      {suites: ['full', 'branch'], tags: ['forward']},
    ),
    test(
      'beq-backward-loop',
      'beq backward loop',
      'beq',
      'Count 3 + 2 + 1 = 6 with a backward branch and an unconditional beq.',
      [
        '    ori $t0, $zero, 3',
        '    ori $t1, $zero, 0',
        'loop:',
        '    add $t1, $t1, $t0',
        '    ori $t2, $zero, 1',
        '    sub $t0, $t0, $t2',
        '    beq $t0, $zero, done',
        '    beq $zero, $zero, loop',
        'done:',
        sw('$t1', 0),
      ],
      17,
      [[0, 6]],
      {suites: ['basic', 'full', 'branch'], tags: ['backward', 'loop']},
    ),
    test(
      'beq-consecutive',
      'consecutive beq instructions',
      'beq',
      'Two taken branches in a row.',
      [
        '    ori $t0, $zero, 1',
        '    ori $t1, $zero, 1',
        '    beq $t0, $t1, one',
        '    ori $t2, $zero, 0xbad',
        'one:',
        '    beq $t0, $t1, two',
        '    ori $t2, $zero, 0xbad',
        'two:',
        sw('$t0', 0),
        sw('$t1', 1),
      ],
      6,
      [
        [0, 1],
        [1, 1],
      ],
      {suites: ['full', 'branch'], tags: ['consecutive']},
    ),
    test(
      'beq-dependency',
      'beq not taken, then dependent add',
      'beq',
      '5 + 2 = 7 on the fall-through path.',
      [
        '    ori $t0, $zero, 5',
        '    ori $t1, $zero, 0',
        '    beq $t0, $t1, skip',
        '    ori $t2, $zero, 2',
        '    add $t3, $t0, $t2',
        sw('$t3', 0),
        'skip:',
      ],
      6,
      [[0, 7]],
      {suites: ['full', 'branch'], tags: ['dependency']},
    ),
    test(
      'beq-zero-equal',
      'beq comparing $zero with itself',
      'beq',
      '$zero == $zero must always be true.',
      [
        '    beq $zero, $zero, eq',
        '    ori $t0, $zero, 0xbad',
        'eq:',
        '    ori $t0, $zero, 0x4444',
        sw('$t0', 0),
      ],
      3,
      [[0, 0x4444]],
      {suites: ['full', 'branch'], tags: ['zero']},
    ),

    // ------------------------------------------------------------------ mixed
    test(
      'mixed-all-seven',
      'mixed program using all seven instructions',
      'mixed',
      'ori/ori/add/sub/sll/sw/lw/beq in one program; result 28.',
      [
        '    ori $t0, $zero, 5',
        '    ori $t1, $zero, 7',
        '    add $t2, $t0, $t1',
        '    sub $t3, $t2, $t0',
        '    sll $t4, $t3, 2',
        `    sw $t4, ${M(0)}($zero)`,
        `    lw $t5, ${M(0)}($zero)`,
        '    beq $t5, $t4, eq',
        '    ori $t6, $zero, 0xbad',
        'eq:',
        sw('$t5', 0),
      ],
      9,
      [[0, 28]],
      {suites: ['basic', 'full'], tags: ['all-seven']},
    ),
    test(
      'grf-all-registers',
      'all 31 general-purpose registers',
      'mixed',
      'Write a distinct value to every nonzero GRF register and read each one back through sw.',
      [
        ...Array.from({length: 31}, (_, index) => `    ori $${index + 1}, $zero, ${index + 1}`),
        ...Array.from({length: 31}, (_, index) => sw(`$${index + 1}`, index)),
      ],
      62,
      Array.from({length: 31}, (_, index) => [index, index + 1] as [number, number]),
      {suites: ['basic', 'full'], tags: ['grf', 'register-coverage']},
    ),
  ];

  const seeded = [0x5eed0001, 0x5eed0002, 0x5eed0003, 0x5eed0004].map((seed) => {
    let state = seed >>> 0;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const a = next() || 1;
    const b = next() || 2;
    const shamt = (next() >>> 27) & 31;
    const sum = (a + b) >>> 0;
    const difference = (a - b) >>> 0;
    const shifted = (sum << shamt) >>> 0;
    const lines = [
      ...const32('$t0', a),
      ...const32('$t1', b),
      '    add $t2, $t0, $t1',
      sw('$t2', 0),
      '    sub $t3, $t0, $t1',
      sw('$t3', 1),
      `    sll $t4, $t2, ${shamt}`,
      sw('$t4', 2),
    ];
    return test(
      `seeded-${seed.toString(16)}`,
      `seeded 32-bit mix 0x${seed.toString(16)}`,
      'mixed',
      'Deterministic seeded 32-bit add/sub/sll program; rerunning the same seed reproduces the same expectations.',
      lines,
      lines.length,
      [
        [0, sum],
        [1, difference],
        [2, shifted],
      ],
      {suites: ['full'], tags: ['seeded', 'reproducible'], seed},
    );
  });
  return [...cases, ...seeded];
}

export function selectSuite(tests: DirectedTest[], suite: string): DirectedTest[] {
  return tests.filter((test) => test.suites.includes(suite));
}

function const32(register: string, value: number): string[] {
  const unsigned = value >>> 0;
  const high = unsigned >>> 16;
  const low = unsigned & 0xffff;
  if (high === 0) return [`    ori ${register}, $zero, 0x${low.toString(16)}`];
  return [
    `    ori ${register}, $zero, 0x${high.toString(16)}`,
    `    sll ${register}, ${register}, 16`,
    `    ori ${register}, ${register}, 0x${low.toString(16)}`,
  ];
}
