import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LogisimBridge, BridgeError} from '../../packages/bridge-client/src/index.js';

async function expectBridgeError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof BridgeError && error.code === code,
    `expected bridge error ${code}`,
  );
}

test('real Logisim component discovery exposes ROM, RAM and register paths', async () => {
  const bridge = new LogisimBridge();
  try {
    await bridge.load('fixtures/memory.circ', 'MemoryHarness');
    const inventory = await bridge.inspectComponents();
    assert.equal(inventory.circuit, 'MemoryHarness');
    const rom = inventory.components.find((component) => component.kind === 'rom');
    const ram = inventory.components.find((component) => component.kind === 'ram');
    const register = inventory.components.find((component) => component.kind === 'register');
    assert.ok(rom);
    assert.ok(ram);
    assert.ok(register);
    assert.equal(rom.addressBits, 8);
    assert.equal(rom.dataBits, 32);
    assert.equal(rom.capacity, 256);
    assert.equal(ram.addressBits, 8);
    assert.equal(register.width, 32);
    assert.match(rom.path, /^MemoryHarness\/ROM@\d+,\d+$/);
  } finally {
    await bridge.close();
  }
});

test('hierarchical circuit discovery walks into subcircuit state', async () => {
  const bridge = new LogisimBridge();
  try {
    await bridge.load('fixtures/hierarchy.circ', 'HierarchicalCircuit');
    const inventory = await bridge.inspectComponents();
    const subcircuits = inventory.components.filter((component) => component.kind === 'subcircuit');
    assert.ok(subcircuits.length >= 1);
    assert.ok(subcircuits.some((component) => component.subcircuit === 'CombinationalAdder'));
    assert.ok(inventory.components.some((component) => component.circuit === 'CombinationalAdder'));
    // Loading the flat adder still works after the recursive walk.
    await bridge.load('fixtures/adder.circ', 'CombinationalAdder');
    assert.equal((await bridge.inspect()).circuit, 'CombinationalAdder');
  } finally {
    await bridge.close();
  }
});

test('real ROM injection and read-back preserve 32-bit words', async () => {
  const bridge = new LogisimBridge();
  try {
    await bridge.load('fixtures/memory.circ', 'MemoryHarness');
    const inventory = await bridge.inspectComponents();
    const rom = inventory.components.find((component) => component.kind === 'rom')!;
    await bridge.loadRom(rom.path, 0, ['0xDEADBEEF', '0x0000002A', '0xFFFFFFFF']);
    const read = await bridge.readMemory(rom.path, 0, 4);
    assert.equal(read.kind, 'rom');
    assert.deepEqual(read.words, ['0xDEADBEEF', '0x0000002A', '0xFFFFFFFF', '0x00000000']);
    await bridge.setInput('ADDR', '0x1', 8);
    await bridge.propagate();
    const output = await bridge.getOutput('ROMOUT');
    assert.equal(output.status, 'known');
    assert.equal(output.value, '0x0000002A');
    await bridge.loadRom(rom.path, 0, ['0x00000001']);
    assert.deepEqual((await bridge.readMemory(rom.path, 0, 2)).words, ['0x00000001', '0x00000000']);
  } finally {
    await bridge.close();
  }
});

test('real RAM writes and reads use Logisim MemContents', async () => {
  const bridge = new LogisimBridge();
  try {
    await bridge.load('fixtures/memory.circ', 'MemoryHarness');
    const inventory = await bridge.inspectComponents();
    const ram = inventory.components.find((component) => component.kind === 'ram')!;
    await bridge.setInput('RST', '0x1', 1);
    await bridge.propagate();
    await bridge.setInput('RST', '0x0', 1);
    await bridge.propagate();
    await bridge.writeMemory(ram.path, 0, ['0x11223344', '0xAABBCCDD']);
    assert.deepEqual((await bridge.readMemory(ram.path, 0, 2)).words, ['0x11223344', '0xAABBCCDD']);
    await bridge.setInput('ADDR', '0x0', 8);
    await bridge.setInput('OE', '0x1', 1);
    await bridge.propagate();
    assert.equal((await bridge.getOutput('DOUT')).value, '0x11223344');
    await bridge.setInput('ADDR', '0x1', 8);
    await bridge.propagate();
    assert.equal((await bridge.getOutput('DOUT')).value, '0xAABBCCDD');
    await bridge.setInput('DIN', '0x00000007', 32);
    await bridge.setInput('WE', '0x1', 1);
    await bridge.tick('CLK');
    assert.equal((await bridge.readMemory(ram.path, 1, 1)).words[0], '0x00000007');
    await bridge.writeMemory(ram.path, 255, ['0xFFFFFFFF']);
    assert.equal((await bridge.readMemory(ram.path, 255, 1)).words[0], '0xFFFFFFFF');
  } finally {
    await bridge.close();
  }
});

test('real Register exposes architectural state without touching the .circ file', async () => {
  const bridge = new LogisimBridge();
  try {
    await bridge.load('fixtures/memory.circ', 'MemoryHarness');
    const inventory = await bridge.inspectComponents();
    const register = inventory.components.find((component) => component.kind === 'register')!;
    await bridge.setInput('RST', '0x0', 1);
    await bridge.writeRegister(register.path, '0xCAFEBABE');
    await bridge.propagate();
    const read = await bridge.readRegister(register.path);
    assert.equal(read.width, 32);
    assert.equal(read.initialized, true);
    assert.equal(read.value, '0xCAFEBABE');
    assert.equal((await bridge.getOutput('Q')).value, '0xCAFEBABE');
    await bridge.setInput('DIN', '0x00000005', 32);
    await bridge.setInput('WE', '0x1', 1);
    await bridge.tick('CLK');
    assert.equal((await bridge.readRegister(register.path)).value, '0x00000005');
  } finally {
    await bridge.close();
  }
});

test('memory operations reject wrong component kinds and invalid ranges', async () => {
  const bridge = new LogisimBridge();
  try {
    await bridge.load('fixtures/memory.circ', 'MemoryHarness');
    const inventory = await bridge.inspectComponents();
    const rom = inventory.components.find((component) => component.kind === 'rom')!;
    const ram = inventory.components.find((component) => component.kind === 'ram')!;
    const register = inventory.components.find((component) => component.kind === 'register')!;
    await expectBridgeError(bridge.writeMemory(rom.path, 0, ['0x1']), 'NOT_RAM');
    await expectBridgeError(bridge.loadRom(ram.path, 0, ['0x1']), 'NOT_ROM');
    await expectBridgeError(bridge.readMemory(register.path, 0, 1), 'NOT_MEMORY');
    await expectBridgeError(bridge.readRegister(ram.path), 'NOT_REGISTER');
    await expectBridgeError(bridge.readMemory(ram.path, 255, 2), 'MEMORY_RANGE');
    await expectBridgeError(bridge.loadRom(rom.path, 255, ['0x1', '0x2']), 'MEMORY_RANGE');
    await expectBridgeError(bridge.writeMemory(ram.path, 0, ['0xINPUT']), 'INVALID_REQUEST');
    await expectBridgeError(bridge.readMemory('MemoryHarness/nope', 0, 1), 'COMPONENT_NOT_FOUND');
    assert.deepEqual((await bridge.readMemory(rom.path, 0, 1)).words, ['0x00000000']);
  } finally {
    await bridge.close();
  }
});
