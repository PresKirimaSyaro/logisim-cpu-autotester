import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  AddressMap,
  MipsError,
  ReferenceInterpreter,
  assemble,
  decode,
  fieldsOf,
  toHex32,
  type AddressRegion,
  type ReferenceImage,
} from '../../packages/mips-core/src/index.js';

const ROM: AddressRegion = {
  baseByteAddress: 0,
  addressBits: 8,
  addressShift: 2,
  dataBits: 32,
  capacityWords: 256,
};
const RAM: AddressRegion = {
  baseByteAddress: 0,
  addressBits: 8,
  addressShift: 2,
  dataBits: 32,
  capacityWords: 256,
};

function image(source: string, initialRam?: Map<number, number>): ReferenceImage {
  const program = assemble(source);
  return {
    romWords: program.words,
    rom: ROM,
    ram: RAM,
    initialPc: 0,
    initialRam,
  };
}

function run(source: string, steps: number, initialRam?: Map<number, number>) {
  const cpu = new ReferenceInterpreter(image(source, initialRam), {trace: true});
  const result = cpu.runSteps(steps);
  return {cpu, result};
}

test('decoder accepts exactly the seven instructions and rejects others', () => {
  const accepted = [
    [0x012a4020, 'add'],
    [0x01ee8022, 'sub'],
    [0x3408ffff, 'ori'],
    [0x8fa8fffc, 'lw'],
    [0xafdf0008, 'sw'],
    [0x11090001, 'beq'],
    [0x00085100, 'sll'],
  ] as const;
  for (const [word, kind] of accepted) {
    const decoded = decode(word);
    assert.equal(decoded.ok, true, toHex32(word));
    if (decoded.ok) assert.equal(decoded.instruction.kind, kind);
  }
  for (const word of [0x00000021, 0x20080001, 0xffffffff, 0x0000000c]) {
    const decoded = decode(word);
    assert.equal(decoded.ok, false, toHex32(word));
    if (!decoded.ok) assert.equal(decoded.code, 'UNSUPPORTED_INSTRUCTION');
  }
  // rd/shamt/funct are just immediate bits in an I-type word; fieldsOf exposes
  // the raw 32-bit slicing, while decode interprets them by opcode.
  assert.deepEqual(fieldsOf(0x8fa8fffc), {
    opcode: 0x23,
    rs: 29,
    rt: 8,
    rd: 31,
    shamt: 31,
    funct: 0x3c,
    immediate: 0xfffc,
  });
});

test('PC advances by 4 and a taken beq uses PC+4+offset<<2', () => {
  const {cpu, result} = run(
    `
    ori $t0, $zero, 1
    beq $t0, $t0, taken
    ori $t1, $zero, 0xbad
taken:
    ori $t1, $zero, 7
`,
    3,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.state.pc, 16);
  assert.equal(cpu.register(9), 7);
  assert.equal(cpu.trace[1].pcBefore, 4);
  assert.equal(cpu.trace[1].pcAfter, 12);
});

test('beq not taken falls through and compares full 32-bit patterns', () => {
  const {cpu, result} = run(
    `
    ori $t0, $zero, 1
    ori $t1, $zero, 2
    beq $t0, $t1, skip
    ori $t2, $zero, 9
skip:
    sll $zero, $zero, 0
`,
    4,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.register(10), 9);
  assert.equal(cpu.trace[2].pcAfter, 12);
});

test('add/sub are modulo 2^32 and never overflow-trap', () => {
  const {cpu, result} = run(
    `
    ori $t0, $zero, 0xffff
    sll $t0, $t0, 16
    ori $t0, $t0, 0xffff
    ori $t1, $zero, 1
    add $t2, $t0, $t1
    sw $t2, 0($zero)
    sub $t3, $zero, $t1
    sw $t3, 4($zero)
`,
    8,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.register(10), 0);
  assert.equal(cpu.register(11), 0xffffffff);
  const ram = cpu.snapshotRamWords();
  assert.equal(ram[0], 0);
  assert.equal(ram[1], 0xffffffff);
});

test('ori zero-extends its 16-bit immediate', () => {
  const {cpu, result} = run(
    `
    ori $t0, $zero, 0xffff
    ori $t1, $zero, 0xffff
    sll $t1, $t1, 16
    ori $t1, $t1, 0xffff
`,
    4,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.register(8), 0x0000ffff);
  assert.equal(cpu.register(9), 0xffffffff);
});

test('sll uses the five-bit shamt and truncates to 32 bits', () => {
  const {cpu, result} = run(
    `
    ori $t0, $zero, 1
    sll $t1, $t0, 4
    sll $t2, $t1, 27
    sll $t3, $t0, 31
`,
    4,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.register(9), 16);
  assert.equal(cpu.register(10), 0x80000000);
  assert.equal(cpu.register(11), 0x80000000);
});

test('lw/sw use sign-extended offsets and honor initial RAM', () => {
  const initial = new Map<number, number>([[0x100, 0xcafebabe]]);
  const {cpu, result} = run(
    `
    ori $t0, $zero, 0x104
    lw $t1, -4($t0)
    sw $t1, 0x200($zero)
    ori $t2, $zero, 0x108
    sw $t1, -8($t2)
`,
    5,
    initial,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.register(9), 0xcafebabe);
  const ram = cpu.snapshotRamWords();
  assert.equal(ram[0x200 >>> 2], 0xcafebabe);
  assert.equal(ram[0x100 >>> 2], 0xcafebabe);
  assert.equal(cpu.state.memory.get(0x200), 0xcafebabe);
});

test('lw rejects misaligned and out-of-range addresses', () => {
  for (const [offset, code] of [
    [1, 'ADDRESS_MISALIGNED'],
    [1024, 'ADDRESS_OUT_OF_RANGE'],
    [-4, 'ADDRESS_OUT_OF_RANGE'],
  ] as const) {
    const cpu = new ReferenceInterpreter(
      image(`lw $t0, ${offset}($zero)`),
      {trace: true},
    );
    const result = cpu.step();
    assert.equal(result.ok, false, `offset ${offset}`);
    assert.equal(result.error?.code, code, `offset ${offset}`);
    assert.equal(cpu.state.executedInstructions, 0);
  }
});

test('$zero ignores writes but still reports the attempted write', () => {
  const {cpu, result} = run(
    `
    ori $t0, $zero, 5
    add $zero, $t0, $t0
    sub $zero, $t0, $t0
`,
    3,
  );
  assert.equal(result.status, 'completed');
  assert.equal(cpu.register(0), 0);
  assert.equal(cpu.trace[1].registerWrite?.ignored, true);
  assert.equal(cpu.trace[1].registerWrite?.index, 0);
});

test('fixed-step execution, stop-PC execution and step limit', () => {
  const cpu1 = new ReferenceInterpreter(
    image('ori $t0,$zero,1\nori $t1,$zero,2\nori $t2,$zero,3\n'),
    {trace: true},
  );
  const fixed = cpu1.runSteps(2);
  assert.deepEqual(
    {status: fixed.status, steps: fixed.steps, pc: cpu1.state.pc},
    {status: 'completed', steps: 2, pc: 8},
  );

  const cpu2 = new ReferenceInterpreter(
    image('ori $t0,$zero,1\nori $t1,$zero,2\nori $t2,$zero,3\n'),
  );
  const stopped = cpu2.runUntilStop(8, 10);
  assert.deepEqual(
    {status: stopped.status, steps: stopped.steps, pc: cpu2.state.pc},
    {status: 'stop-pc', steps: 2, pc: 8},
  );

  const cpu3 = new ReferenceInterpreter(
    image('back:\n  beq $zero,$zero,back\n'),
  );
  const limited = cpu3.runUntilStop(999, 5);
  assert.equal(limited.status, 'step-limit');
  assert.equal(limited.steps, 5);
});

test('PC out of range and unsupported machine code produce explicit errors', () => {
  const outOfRange = new ReferenceInterpreter(
    {
      romWords: [0x34080001],
      rom: {baseByteAddress: 0, addressBits: 1, addressShift: 2, dataBits: 32, capacityWords: 1},
      ram: RAM,
      initialPc: 0,
    },
    {trace: true},
  );
  assert.equal(outOfRange.step().ok, true);
  const second = outOfRange.step();
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'PC_OUT_OF_RANGE');

  const unsupported = new ReferenceInterpreter({
    romWords: [0x00000021],
    rom: ROM,
    ram: RAM,
    initialPc: 0,
  });
  const result = unsupported.step();
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'UNSUPPORTED_INSTRUCTION');
});

test('address mapping distinguishes MIPS bytes, component words and bridge indices', () => {
  const map = new AddressMap(RAM, 'RAM');
  assert.equal(map.indexOf(0x100), 64);
  assert.equal(map.byteAddressOf(64), 0x100);
  assert.equal(map.contains(0x3fc), true);
  assert.equal(map.contains(0x400), false);
  assert.throws(
    () => map.indexOf(0x102),
    (error: unknown) => error instanceof MipsError && error.code === 'ADDRESS_MISALIGNED',
  );
  const byteAddressed = new AddressMap(
    {baseByteAddress: 0, addressBits: 10, addressShift: 0, dataBits: 32, capacityWords: 1024},
    'byte RAM',
  );
  assert.equal(byteAddressed.indexOf(0x100), 0x100);
  assert.equal(byteAddressed.byteAddressOf(0x100), 0x100);
});

test('trace and state keep pre/post PC, decoded instruction and memory writes', () => {
  const {cpu} = run('ori $t0,$zero,5\nsw $t0,0($zero)\n', 2);
  assert.equal(cpu.trace.length, 2);
  assert.equal(cpu.trace[0].pcBefore, 0);
  assert.equal(cpu.trace[0].pcAfter, 4);
  assert.equal(cpu.trace[0].instruction?.kind, 'ori');
  assert.equal(cpu.trace[1].memoryWrite?.address, 0);
  assert.equal(cpu.trace[1].memoryWrite?.value, 5);
  assert.equal(cpu.state.executedInstructions, 2);
});
