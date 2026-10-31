import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  MipsError,
  assemble,
  fieldsOf,
  tryAssemble,
} from '../../packages/mips-core/src/index.js';

function encode(source: string, origin = 0): number[] {
  return assemble(source, {origin}).words;
}

test('golden machine-code vectors for all seven instructions', () => {
  const vectors: [string, string, number][] = [
    ['add $t0, $t1, $t2', 'R-type add, rs=9 rt=10 rd=8', 0x012a4020],
    ['sub $s0, $t7, $t6', 'R-type sub, rs=15 rt=14 rd=16', 0x01ee8022],
    ['ori $t0, $zero, 0xffff', 'ori zero-extends 0xFFFF', 0x3408ffff],
    ['lw $t0, -4($sp)', 'lw sign-extended -4, base $sp', 0x8fa8fffc],
    ['sw $ra, 8($fp)', 'sw, base $fp, rt $ra', 0xafdf0008],
    ['sll $t2, $t0, 4', 'sll rd=10 rt=8 shamt=4', 0x00085100],
    ['lui $t0, 0xFFFF', 'lui opcode 0x0F, rt=8, imm=0xFFFF', 0x3c08ffff],
    ['nop', 'nop is the architectural all-zero word', 0x00000000],
  ];
  for (const [source, description, expected] of vectors) {
    const words = encode(source);
    assert.equal(words.length, 1, description);
    assert.equal(words[0], expected >>> 0, description);
  }

  const branch = encode(`
start:
    beq $t0, $t1, target
    sll $zero, $zero, 0
target:
    sll $zero, $zero, 0
`);
  assert.equal(branch[0], 0x11090001, 'beq offset is (target - (PC+4))/4 = 1');

  // Independent field checks, not derived from the assembler internals.
  const add = fieldsOf(0x012a4020);
  assert.deepEqual(
    {opcode: add.opcode, rs: add.rs, rt: add.rt, rd: add.rd, shamt: add.shamt, funct: add.funct},
    {opcode: 0, rs: 9, rt: 10, rd: 8, shamt: 0, funct: 0x20},
  );
  const lw = fieldsOf(0x8fa8fffc);
  assert.equal(lw.opcode, 0x23);
  assert.equal(lw.rs, 29);
  assert.equal(lw.rt, 8);
  assert.equal(lw.immediate, 0xfffc);

  const jump = assemble('start:\n j start\n', {origin: 0x3000});
  assert.equal(jump.words[0], 0x08000c00, 'j uses (target >>> 2) & 0x03ffffff');
  assert.equal(fieldsOf(jump.words[0]).opcode, 0x02);
});

test('instruction-set selection rejects disabled sll/j but keeps nop available', () => {
  const courseOnly = ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop'] as const;
  assert.equal(assemble('nop', {instructions: courseOnly}).words[0], 0);
  assert.throws(
    () => assemble('j target\ntarget:', {instructions: courseOnly}),
    (error: unknown) => error instanceof MipsError && error.code === 'ASM_INSTRUCTION_DISABLED',
  );
  assert.throws(
    () => assemble('sll $t0, $t0, 1', {instructions: courseOnly}),
    (error: unknown) => error instanceof MipsError && error.code === 'ASM_INSTRUCTION_DISABLED',
  );
  assert.equal(assemble('j target\ntarget:', {instructions: [...courseOnly, 'j']}).words.length, 1);
});

test('labels, forward/backward branches, comments, hex and signed literals', () => {
  const program = assemble(`
# a comment
start:                       ; a second comment style
    ori $t0, $zero, 0x10
    ori $t1, $zero, -1
    add $t2, $t0, $t1

forward:
    beq $t2, $zero, back
    sll $zero, $zero, 0
back:
    beq $zero, $zero, forward
`);
  assert.deepEqual(program.symbols, {start: 0, forward: 12, back: 20});
  assert.equal(program.words.length, 6);
  // forward branch at address 12 -> back at 20: (20 - 16)/4 = 1.
  assert.equal(program.hex[3], '0x11400001');
  // backward branch at address 20 -> forward at 12: (12 - 24)/4 = -3.
  assert.equal(program.hex[5], '0x1000FFFD');
  assert.equal(program.instructions[0].line, 4);
  assert.equal(program.instructions[0].address, 0);
});

test('numeric registers and origin-relative addresses', () => {
  const program = assemble(
    `
    ori $8, $0, 1
    sll $9, $8, 2
    beq $8, $9, done
done:
    sw $9, 0($8)
`,
    {origin: 0x100},
  );
  assert.equal(program.origin, 0x100);
  assert.equal(program.instructions[0].address, 0x100);
  assert.equal(program.symbols.done, 0x10c);
  // beq at 0x108, target 0x10c -> (0x10c - 0x10c)/4 = 0.
  assert.equal(program.hex[2], '0x11090000');
});

test('maximum legal immediates and branch offsets are accepted', () => {
  assert.equal(encode('ori $t0, $zero, 0xffff')[0], 0x3408ffff);
  assert.equal(encode('ori $t0, $zero, -32768')[0], 0x34088000);
  assert.equal(encode('lw $t0, 32767($zero)')[0], 0x8c087fff);
  assert.equal(encode('lw $t0, -32768($zero)')[0], 0x8c088000);
  assert.equal(encode('sll $t0, $t0, 31')[0], 0x000847c0);
  assert.equal(encode('beq $zero, $zero, 131068')[0], 0x10007fff);
  assert.equal(encode('beq $zero, $zero, -131072')[0], 0x10008000);
});

test('assembly diagnostics carry code, line, column and text', () => {
  const cases: [string, string, number][] = [
    ['add $t0, $t1, $t2, extra', 'ASM_INVALID_OPERAND', 1],
    ['add $t0, $t1, $t9,', 'ASM_SYNTAX', 1],
    ['ori $t0, $zero, 0x10000', 'ASM_IMMEDIATE_RANGE', 1],
    ['lw $t0, 40000($zero)', 'ASM_IMMEDIATE_RANGE', 1],
    ['sll $t0, $t1, 32', 'ASM_IMMEDIATE_RANGE', 1],
    ['add $t32, $t1, $t2', 'ASM_INVALID_REGISTER', 1],
    ['beq $t0, $t1, missing', 'ASM_UNDEFINED_LABEL', 1],
    ['nop 1', 'ASM_INVALID_OPERAND', 1],
    ['beq $t0, $t1, 6', 'ASM_BRANCH_ALIGNMENT', 1],
    ['foo $t0, $t1, $t2', 'ASM_UNKNOWN_MNEMONIC', 1],
    ['add $t0, $t1', 'ASM_INVALID_OPERAND', 1],
    ['lw $t0, 0($t1', 'ASM_INVALID_OPERAND', 1],
    ['add $t0, $t1, $t2\n  nope $t0', 'ASM_UNKNOWN_MNEMONIC', 2],
    ['add $t0, $t1, $t2\n  ori $t0, $zero, 0x10000', 'ASM_IMMEDIATE_RANGE', 2],
  ];
  for (const [source, code, line] of cases) {
    assert.throws(
      () => assemble(source),
      (error: unknown) => {
        assert.ok(error instanceof MipsError, `${source} should throw MipsError`);
        assert.equal(error.code, code, `${source}: ${error.message}`);
        assert.equal(error.position?.line, line, `${source}: wrong line`);
        assert.ok((error.position?.column ?? 0) >= 1, `${source}: missing column`);
        return true;
      },
    );
    const attempt = tryAssemble(source);
    assert.equal(attempt.ok, false);
    if (!attempt.ok) {
      assert.equal(attempt.diagnostic.code, code);
      assert.equal(attempt.diagnostic.line, line);
    }
  }
});

test('duplicate labels and non-4-aligned branch targets are rejected', () => {
  assert.throws(
    () => assemble('a:\na:\n  sll $zero, $zero, 0'),
    (error: unknown) => error instanceof MipsError && error.code === 'ASM_DUPLICATE_LABEL',
  );
  assert.throws(
    () => assemble('beq $zero, $zero, 2'),
    (error: unknown) => error instanceof MipsError && error.code === 'ASM_BRANCH_ALIGNMENT',
  );
});

test('branch offset outside the signed 16-bit field is rejected', () => {
  const lines = ['start:'];
  for (let i = 0; i < 32770; i++) lines.push('  sll $zero, $zero, 0');
  lines.push('  beq $zero, $zero, start');
  assert.throws(
    () => assemble(lines.join('\n')),
    (error: unknown) => error instanceof MipsError && error.code === 'ASM_BRANCH_RANGE',
  );
});

test('empty and whitespace-only programs assemble to zero words', () => {
  assert.equal(assemble('').words.length, 0);
  assert.equal(assemble('\n# comment\n\n').words.length, 0);
});
