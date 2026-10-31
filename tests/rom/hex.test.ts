import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LogisimBridge} from '../../packages/bridge-client/src/index.js';
import {encodeLogisimHex, parseLogisimHex} from '../../packages/mips-core/src/index.js';

test('Logisim raw ROM HEX round-trips words with header and address layout', () => {
  const words = [0x34080005, 0x01095020, 0xac0a0100, 0x00000000];
  const text = encodeLogisimHex(words, {startIndex: 3});
  assert.match(text, /^v2\.0 raw\n/);
  assert.deepEqual(parseLogisimHex(text), [0, 0, 0, ...words]);
  assert.match(text.split('\n')[1], /^00000000/);
});

test('Logisim HEX parser accepts comments and run-length tokens', () => {
  const text = 'v2.0 raw\n# comment\n4*0 1 2\n';
  assert.deepEqual(parseLogisimHex(text), [0, 0, 0, 0, 1, 2]);
  assert.throws(() => parseLogisimHex('not a header\n0\n'), /header/i);
  assert.throws(() => parseLogisimHex('v2.0 raw\nxyz\n'), /hexadecimal/i);
});

test('original Logisim HexFile parser accepts the exported ROM image', {timeout: 60000}, async () => {
  const words = [0x34080005, 0x01095020, 0xac0a0100];
  const text = encodeLogisimHex(words, {startIndex: 2});
  const bridge = new LogisimBridge({timeoutMs: 30000});
  try {
    assert.deepEqual(await bridge.parseHex(text), ['0x00000000', '0x00000000', ...words.map((word) => `0x${word.toString(16).toUpperCase().padStart(8, '0')}`)]);
  } finally {
    await bridge.close();
  }
});
