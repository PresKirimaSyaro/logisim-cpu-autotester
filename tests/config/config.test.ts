import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  ConfigError,
  initialRamMap,
  parseCpuConfig,
  regionOf,
} from '../../packages/mips-core/src/index.js';

async function validConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile('fixtures/cpu.config.json', 'utf8')) as Record<string, any>;
}

function expectConfigError(value: unknown, code: string, pathPart?: string): void {
  assert.throws(
    () => parseCpuConfig(value),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError, 'expected ConfigError');
      assert.equal(error.code, code);
      if (pathPart) assert.ok(error.path.includes(pathPart), `${error.path} should include ${pathPart}`);
      return true;
    },
  );
}

test('generated CPU config validates and exposes the expected regions', async () => {
  const config = parseCpuConfig(await validConfig());
  assert.equal(config.circuitName, 'SingleCycleCPU');
  assert.equal(config.clock.mode, 'pin');
  if (config.clock.mode === 'pin') assert.equal(config.clock.pin, 'CLK');
  assert.equal(config.rom.addressBits, 8);
  assert.equal(config.ram.addressShift, 2);
  assert.equal(config.ram.capacityWords, 256);
  assert.equal(config.pc.mode, 'pin');
  assert.equal(config.ram.addressBits, 8);
  assert.equal(config.ram.capacityWords, 256);
  assert.equal(regionOf(config.ram).capacityWords, 256);
  assert.equal(initialRamMap(config.ram).size, 0);
  assert.equal(config.outputs?.instruction, 'Instr');
});

test('course profile config uses internal clock, 0x3000 ROM and logical 3072-word RAM', async () => {
  const config = parseCpuConfig(JSON.parse(await readFile('fixtures/course.config.json', 'utf8')));
  assert.equal(config.circuitName, 'main');
  assert.equal(config.clock.mode, 'internal');
  assert.equal(config.pc.initial, 0x3000);
  assert.equal(config.rom.baseByteAddress, 0x3000);
  assert.equal(config.rom.addressBits, 12);
  assert.equal(config.rom.capacityWords, 4096);
  assert.equal(config.ram.addressBits, 12);
  assert.equal(config.ram.capacityWords, 3072);
  assert.equal(config.outputs?.instruction, 'Instr');
});

test('already-parsed configs can be revalidated', async () => {
  const config = parseCpuConfig(await validConfig());
  const again = parseCpuConfig(config);
  assert.equal(again.name, config.name);
  assert.equal(again.ram.capacityWords, config.ram.capacityWords);
});

test('unknown keys and wrong types are rejected with paths', async () => {
  const unknown = await validConfig();
  unknown.typo = 1;
  expectConfigError(unknown, 'CONFIG_UNKNOWN_KEY', 'typo');

  const nested = await validConfig();
  nested.ram.typo = 1;
  expectConfigError(nested, 'CONFIG_UNKNOWN_KEY', 'ram.typo');

  const wrongType = await validConfig();
  wrongType.rom.addressBits = '8';
  expectConfigError(wrongType, 'CONFIG_TYPE', 'rom.addressBits');

  const missing = await validConfig();
  delete missing.ram;
  expectConfigError(missing, 'CONFIG_INVALID', 'ram');
});

test('logical DM capacity is independent of any physical address width', async () => {
  const logical = await validConfig();
  logical.ram.capacityWords = 512;
  assert.equal(parseCpuConfig(logical).ram.capacityWords, 512);

  const smaller = await validConfig();
  smaller.ram.capacityWords = 128;
  assert.equal(parseCpuConfig(smaller).ram.capacityWords, 128);

  const shift = await validConfig();
  shift.rom.addressShift = 3;
  expectConfigError(shift, 'CONFIG_INVALID', 'rom.addressShift');

  const ramShift = await validConfig();
  ramShift.ram.addressShift = 3;
  expectConfigError(ramShift, 'CONFIG_INVALID', 'ram.addressShift');

  const width = await validConfig();
  width.ram.dataBits = 8;
  expectConfigError(width, 'CONFIG_INVALID', 'ram.dataBits');

  const pcOutside = await validConfig();
  pcOutside.pc.initial = 0x1000;
  expectConfigError(pcOutside, 'CONFIG_INVALID', 'pc.initial');

  // The old physical RAM path is ignored, even if it equals the ROM path.
  const samePath = await validConfig();
  samePath.ram.path = samePath.rom.path;
  assert.equal(parseCpuConfig(samePath).ram.capacityWords, 256);
});

test('legacy physical RAM fields are ignored but initial contents are rejected', async () => {
  const initial = await validConfig();
  initial.ram.initial = [{byteAddress: 2, value: '0x1'}];
  expectConfigError(initial, 'CONFIG_INVALID', 'ram.initial');

  const nonEmpty = await validConfig();
  nonEmpty.ram.initial = [{byteAddress: 0x100, value: 1}];
  expectConfigError(nonEmpty, 'CONFIG_INVALID', 'ram.initial');

  const legacy = await validConfig();
  legacy.compare = {mode: 'ranges', ranges: [{byteAddress: 0x100, words: 2}]};
  legacy.ram.path = 'Some/Other/RAM@1,2';
  const config = parseCpuConfig(legacy);
  assert.equal(config.ram.capacityWords, 256);
  assert.equal('compare' in config, false);

  const noPhysical = await validConfig();
  delete noPhysical.ram.path;
  delete noPhysical.ram.addressBits;
  delete noPhysical.ram.addressShift;
  delete noPhysical.ram.dataBits;
  delete noPhysical.ram.initial;
  delete noPhysical.compare;
  const parsed = parseCpuConfig(noPhysical);
  assert.equal(parsed.ram.capacityWords, 256);
  assert.equal(parsed.ram.path, undefined);
});

test('PC modes and reset strategies are validated', async () => {
  const none = await validConfig();
  none.pc = {mode: 'none', initial: 0};
  const parsed = parseCpuConfig(none);
  assert.equal(parsed.pc.mode, 'none');
  assert.equal(parseCpuConfig(parsed).pc.mode, 'none');

  const badPc = await validConfig();
  badPc.pc = {mode: 'register', initial: 0};
  expectConfigError(badPc, 'CONFIG_INVALID', 'pc.path');

  const reset = await validConfig();
  reset.reset = {strategy: 'pin', pin: 'RST'};
  const parsedReset = parseCpuConfig(reset);
  assert.equal(parsedReset.reset.strategy, 'pin');
  if (parsedReset.reset.strategy === 'pin') {
    assert.equal(parsedReset.reset.ticks, 1);
    assert.equal(parsedReset.reset.activeLow, false);
  }

  const badReset = await validConfig();
  badReset.reset = {strategy: 'magic'};
  expectConfigError(badReset, 'CONFIG_INVALID', 'reset.strategy');
});

test('input pins reject duplicates and clock/reset conflicts are left to the runner', async () => {
  const duplicate = await validConfig();
  duplicate.inputs = [
    {port: 'A', value: 1},
    {port: 'A', value: 2},
  ];
  expectConfigError(duplicate, 'CONFIG_INVALID', 'inputs');
});
