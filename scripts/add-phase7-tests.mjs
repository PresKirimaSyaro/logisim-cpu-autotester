import {readFileSync, writeFileSync} from 'node:fs';
import {assemble, ReferenceInterpreter, ALL_INSTRUCTIONS} from '../dist/packages/mips-core/src/index.js';

const S = (i) => 0x100 + i * 4;
const M = (i) => 0x200 + i * 4;
const suitePath = 'test-suites/course.json';
const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
const generated = [];
let counter = 0;

function make(id, name, category, description, lines, signatureIndexes, tags, suites) {
  const endLabel = `phase7_end_${counter}`;
  const assembly = `${lines.join('\n')}\n${endLabel}:\n`;
  let program;
  let cpu;
  let run;
  try {
    program = assemble(assembly, {origin: 0x3000, instructions: ALL_INSTRUCTIONS});
    const endPc = program.symbols[endLabel];
    if (endPc === undefined) throw new Error('missing end label');
    cpu = new ReferenceInterpreter({
      romWords: program.words,
      rom: {baseByteAddress: 0x3000, addressBits: 12, addressShift: 2, dataBits: 32, capacityWords: 4096},
      ram: {baseByteAddress: 0, addressBits: 12, addressShift: 2, dataBits: 32, capacityWords: 3072},
      initialPc: 0x3000,
      instructions: ALL_INSTRUCTIONS,
    });
    run = cpu.runUntilStop(endPc, 200000);
    if (run.status !== 'stop-pc') throw new Error(`reference stopped with ${run.status}`);
  } catch (error) {
    throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const memory = cpu.snapshotRamWords();
  const signature = signatureIndexes.map((index) => ({
    index,
    expected: memory[S(index) >>> 2] >>> 0,
  }));
  if (!signature.some((entry) => entry.expected !== 0)) {
    throw new Error(`${id}: all-zero signature`);
  }
  generated.push({
    id,
    name,
    category,
    description,
    assembly,
    steps: run.steps,
    signature,
    suites,
    tags,
    seed: null,
    requiredRamBytes: 0x400,
  });
  counter++;
}

function ori(reg, value) {
  return `    ori ${reg}, $zero, ${value}`;
}

// 1-6: lw fields equal (rs=rt) are not a beq.
for (let i = 0; i < 6; i++) {
  const base = 0x100 + i * 0x20;
  const offset = 4 + (i % 3) * 4;
  make(
    `phase7-misdecode-lw-${i + 1}`,
    `lw with rs=rt must not branch (${i + 1})`,
    'nextpc',
    'The load opcode must execute as lw; a controller that decoded its equal rs/rt fields as beq would skip the marker.',
    [
      ori('$t0', base),
      `    lw $t0, ${offset}($t0)`,
      ori('$t1', 0x40 + i),
      `    sw $t1, ${S(0)}($zero)`,
      ori('$t2', 0x80 + i),
      `    sw $t2, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['misdecode', 'lw-as-beq', 'next-pc'],
    ['full', 'branch'],
  );
}

// 7-12: sw fields equal (rs=rt) are not a beq.
for (let i = 0; i < 6; i++) {
  const base = 0x180 + i * 0x20;
  const offset = 4 + (i % 3) * 4;
  make(
    `phase7-misdecode-sw-${i + 1}`,
    `sw with rs=rt must not branch (${i + 1})`,
    'nextpc',
    'The store opcode must execute as sw and fall through; an erroneous beq decode would skip the marker.',
    [
      ori('$t0', base),
      `    sw $t0, ${offset}($t0)`,
      ori('$t1', 0x50 + i),
      `    sw $t1, ${S(0)}($zero)`,
      ori('$t2', 0x90 + i),
      `    sw $t2, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['misdecode', 'sw-as-beq', 'next-pc'],
    ['full', 'branch'],
  );
}

// 13-18: ori fields equal (rs=rt) are not a beq.
for (let i = 0; i < 6; i++) {
  const immediate = 1 + i * 2;
  make(
    `phase7-misdecode-ori-${i + 1}`,
    `ori with rs=rt must not branch (${i + 1})`,
    'nextpc',
    'The immediate OR must modify the register and fall through, not use its immediate as a beq displacement.',
    [
      ori('$t0', 0x100 + i),
      `    ori $t0, $t0, ${immediate}`,
      ori('$t1', 0x60 + i),
      `    sw $t1, ${S(0)}($zero)`,
      `    sw $t0, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['misdecode', 'ori-as-beq', 'next-pc'],
    ['full', 'branch'],
  );
}

// 19-24: ori zero extension with high immediate bits on non-zero values.
const oriCases = [
  [0x1234, 0x8000],
  [0xabcd, 0xffff],
  [0x8000, 0x8001],
  [0xffff, 0xffff],
  [0x7fff, 0xabcd],
  [0x0001, 0x8000],
];
for (const [high, immediate] of oriCases) {
  make(
    `phase7-ori-zeroext-${high.toString(16)}-${immediate.toString(16)}`,
    `ori zero-extension 0x${immediate.toString(16)} on 0x${high.toString(16)}xxxx`,
    'ori',
    'ORI immediate is a zero-extended 16-bit pattern even when bit 15 is set.',
    [
      `    lui $t0, 0x${high.toString(16)}`,
      `    ori $t0, $t0, 0x${immediate.toString(16)}`,
      `    sw $t0, ${S(0)}($zero)`,
      ori('$t1', 0x21),
      `    sw $t1, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['ori', 'zero-extension', 'high-immediate'],
    ['full', 'alu'],
  );
}

// 25-30: LUI/ORI on an already non-zero destination.
const luiCases = [
  [0x1234, 0xabcd, 0x5678],
  [0xaaaa, 0x8000, 0x0001],
  [0x5555, 0xffff, 0x8000],
  [0x1111, 0x7fff, 0xffff],
  [0x8888, 0x0001, 0x8001],
  [0xdef0, 0xffff, 0xffff],
];
for (const [oldValue, high, low] of luiCases) {
  make(
    `phase7-lui-nonzero-${high.toString(16)}-${low.toString(16)}`,
    `lui/ori overwrite non-zero destination 0x${high.toString(16)}${low.toString(16)}`,
    'lui',
    'LUI ignores rs and overwrites the rt high half even when the destination already contains data.',
    [
      ori('$t0', oldValue),
      `    lui $t0, 0x${high.toString(16)}`,
      `    ori $t0, $t0, 0x${low.toString(16)}`,
      `    sw $t0, ${S(0)}($zero)`,
      ori('$t1', 0x31),
      `    sw $t1, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['lui', 'non-zero-destination', '32-bit'],
    ['full', 'alu'],
  );
}

// 31-36: lw/sw sign-extended immediate offsets with non-zero bases.
const memoryCases = [
  [0x300, -4],
  [0x300, -8],
  [0x2c0, -16],
  [0x380, -64],
  [0x300, 0],
  [0x240, 0x40],
];
for (const [base, offset] of memoryCases) {
  make(
    `phase7-mem-signext-${base.toString(16)}-${offset}`,
    `lw/sw sign-extended offset ${offset} from base 0x${base.toString(16)}`,
    'lw-sw',
    'The 16-bit offset is sign-extended before adding the non-zero base register.',
    [
      ori('$t0', base),
      ori('$t1', 0x1234),
      `    sw $t1, ${offset}($t0)`,
      `    lw $t2, ${offset}($t0)`,
      `    sw $t2, ${S(0)}($zero)`,
      ori('$t3', 0x77),
      `    sw $t3, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['lw-sw', 'sign-extension', 'non-zero-base'],
    ['full', 'memory'],
  );
}

// 37-46: every register is written, stored through a non-zero base, loaded back, and summed.
for (let caseIndex = 0; caseIndex < 10; caseIndex++) {
  const values = Array.from({length: 8}, (_, index) => 0x101 + caseIndex * 0x11 + index * 0x23);
  const lines = [
    '    ori $s1, $zero, 0xfc',
    ...values.map((value, index) => ori(`$t${index}`, value)),
    ...values.map((_, index) => `    sw $t${index}, ${4 + index * 4}($s1)`),
    ...values.map((_, index) => `    lw $t${index}, ${4 + index * 4}($s1)`),
    '    ori $s0, $zero, 0',
    ...values.map((_, index) => `    add $s0, $s0, $t${index}`),
    `    sw $s0, ${S(8)}($zero)`,
    ...values.map((_, index) => `    sw $t${index}, ${S(index)}($zero)`),
    ori('$s2', 0x99),
    `    sw $s2, ${S(9)}($zero)`,
  ];
  make(
    `phase7-grf-dm-${caseIndex + 1}`,
    `GRF/DM round trip with non-zero base (${caseIndex + 1})`,
    'mixed',
    'Eight registers are stored, loaded back, summed, and individually checked while the base register is non-zero.',
    lines,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    ['grf', 'dm', 'non-zero-base', 'dependency'],
    ['full', 'alu', 'memory'],
  );
}

// 47-56: store/load loop through a non-zero base.
for (let caseIndex = 0; caseIndex < 10; caseIndex++) {
  const count = 2 + caseIndex;
  make(
    `phase7-memory-loop-${caseIndex + 1}`,
    `store/load loop with non-zero base (${count})`,
    'lw-sw',
    'A loop stores and reloads a changing value through a non-zero base; the final sum is checked in DM.',
    [
      ori('$t2', 0x200),
      ori('$t0', count),
      ori('$t1', 0),
      'phase7_memory_loop:',
      '    sw $t0, 0($t2)',
      '    lw $t3, 0($t2)',
      '    add $t1, $t1, $t3',
      ori('$t4', 1),
      '    sub $t0, $t0, $t4',
      '    beq $t0, $zero, phase7_memory_done',
      '    beq $zero, $zero, phase7_memory_loop',
      'phase7_memory_done:',
      `    sw $t1, ${S(0)}($zero)`,
      ori('$t5', 0x44),
      `    sw $t5, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['memory-loop', 'non-zero-base', 'beq', 'dependency'],
    ['full', 'memory'],
  );
}

// 57-66: three-way beq decision tree.
const branchPairs = [
  [5, 5],
  [5, 0],
  [0, 5],
  [0, 0],
  [7, 7],
  [7, 9],
  [0, 9],
  [9, 0],
  [0x7f, 0x7f],
  [0x80, 0x80],
];
for (let caseIndex = 0; caseIndex < branchPairs.length; caseIndex++) {
  const [a, b] = branchPairs[caseIndex];
  make(
    `phase7-branch-tree-${caseIndex + 1}`,
    `multi-way beq decision tree (${a}, ${b})`,
    'beq',
    'Three dependent beq conditions choose one of four paths; every path leaves a distinct visible value.',
    [
      ori('$t0', a),
      ori('$t1', b),
      '    beq $t0, $t1, phase7_eq',
      '    beq $t0, $zero, phase7_zero_a',
      '    beq $t1, $zero, phase7_zero_b',
      ori('$t2', 0x11),
      `    sw $t2, ${S(0)}($zero)`,
      '    beq $zero, $zero, phase7_branch_done',
      'phase7_eq:',
      ori('$t2', 0x22),
      `    sw $t2, ${S(0)}($zero)`,
      '    beq $zero, $zero, phase7_branch_done',
      'phase7_zero_a:',
      ori('$t2', 0x33),
      `    sw $t2, ${S(0)}($zero)`,
      '    beq $zero, $zero, phase7_branch_done',
      'phase7_zero_b:',
      ori('$t2', 0x44),
      `    sw $t2, ${S(0)}($zero)`,
      'phase7_branch_done:',
      ori('$t3', 0xaa),
      `    sw $t3, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['beq', 'multi-branch', 'control-flow'],
    ['full', 'branch'],
  );
}

// 67-76: conditional branch loop whose state changes every iteration.
for (let caseIndex = 0; caseIndex < 10; caseIndex++) {
  const count = 1 + caseIndex;
  make(
    `phase7-branch-loop-${caseIndex + 1}`,
    `state-dependent beq loop (${count})`,
    'beq',
    'The branch condition changes with the loop-carried decrement; the final sum is stored in DM.',
    [
      ori('$t0', count),
      ori('$t1', 0),
      'phase7_state_loop:',
      '    add $t1, $t1, $t0',
      ori('$t2', 1),
      '    sub $t0, $t0, $t2',
      '    beq $t0, $zero, phase7_state_done',
      '    beq $zero, $zero, phase7_state_loop',
      'phase7_state_done:',
      `    sw $t1, ${S(0)}($zero)`,
      ori('$t3', 0x55),
      `    sw $t3, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['beq', 'loop', 'state-dependent'],
    ['full', 'branch'],
  );
}

// 77-82: more sign-extended loads/stores, including repeated reads.
for (let caseIndex = 0; caseIndex < 6; caseIndex++) {
  const base = 0x280 + caseIndex * 0x10;
  const offset = -4 * (caseIndex + 1);
  make(
    `phase7-songsign-${caseIndex + 1}`,
    `repeated sign-extended memory operation (${caseIndex + 1})`,
    'lw-sw',
    'A negative offset is reused for multiple stores and loads; a zero-extended address would be far outside DM.',
    [
      ori('$t0', base),
      ori('$t1', 0x1000 + caseIndex),
      `    sw $t1, ${offset}($t0)`,
      `    lw $t2, ${offset}($t0)`,
      `    sw $t1, ${offset}($t0)`,
      `    lw $t3, ${offset}($t0)`,
      `    add $t4, $t2, $t3`,
      `    sw $t4, ${S(0)}($zero)`,
      ori('$t5', 0x66),
      `    sw $t5, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['lw-sw', 'sign-extension', 'repeated-access'],
    ['full', 'memory'],
  );
}

// 83-88: LUI/ORI mixed with immediate source values.
for (let caseIndex = 0; caseIndex < 6; caseIndex++) {
  const high = 0x9000 + caseIndex * 0x111;
  const low = 0x0100 + caseIndex * 0x111;
  make(
    `phase7-lui-ori-mix-${caseIndex + 1}`,
    `LUI then ORI on a live register (${caseIndex + 1})`,
    'lui',
    'LUI overwrites the high half and ORI zero-extends its immediate into a live destination.',
    [
      ori('$t0', 0x2222),
      `    lui $t0, 0x${high.toString(16)}`,
      `    ori $t0, $t0, 0x${(low & 0xffff).toString(16)}`,
      `    sw $t0, ${S(0)}($zero)`,
      ori('$t1', 0x77),
      `    sw $t1, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['lui', 'ori', 'live-register'],
    ['full', 'alu'],
  );
}

// 89-100: branch + memory combinations.
for (let caseIndex = 0; caseIndex < 12; caseIndex++) {
  const count = 2 + (caseIndex % 5);
  const base = 0x240 + (caseIndex % 4) * 0x10;
  make(
    `phase7-branch-memory-${caseIndex + 1}`,
    `branch-controlled memory accumulator (${caseIndex + 1})`,
    'mixed',
    'A beq loop updates memory through a non-zero base while a register accumulator tracks the same values.',
    [
      ori('$t2', base),
      ori('$t0', count),
      ori('$t1', 0),
      'phase7_branch_mem_loop:',
      '    sw $t0, 0($t2)',
      '    lw $t3, 0($t2)',
      '    add $t1, $t1, $t3',
      ori('$t4', 1),
      '    sub $t0, $t0, $t4',
      '    beq $t0, $zero, phase7_branch_mem_done',
      '    beq $zero, $zero, phase7_branch_mem_loop',
      'phase7_branch_mem_done:',
      `    sw $t1, ${S(0)}($zero)`,
      `    sw $t2, ${S(1)}($zero)`,
    ],
    [0, 1],
    ['beq', 'memory', 'non-zero-base', 'loop'],
    ['full', 'branch', 'memory'],
  );
}

if (generated.length !== 100) throw new Error(`expected 100 tests, got ${generated.length}`);
suite.tests.push(...generated);
writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
console.log(`appended ${generated.length} tests; total ${suite.tests.length}`);
