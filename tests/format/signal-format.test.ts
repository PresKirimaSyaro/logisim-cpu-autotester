import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatSignalValue} from '../../packages/mips-core/src/index.js';

test('signal formatting preserves 32-bit bit patterns in all formats', () => {
  assert.equal(formatSignalValue('0xAC0A0100', 32, 'hex'), '0xac0a0100');
  assert.equal(formatSignalValue('0xAC0A0100', 32, 'binary'), '0b10101100000010100000000100000000');
  assert.equal(formatSignalValue('0xAC0A0100', 32, 'udec'), '2886336768');
  assert.equal(formatSignalValue('0xAC0A0100', 32, 'sdec'), '-1408630528');
  assert.equal(formatSignalValue('0xFFFFFFFF', 32, 'sdec'), '-1');
});

test('signal formatting uses each signal width for padding, sign and truncation', () => {
  assert.equal(formatSignalValue('0x1F', 5, 'hex'), '0x1f');
  assert.equal(formatSignalValue('0x1F', 5, 'binary'), '0b11111');
  assert.equal(formatSignalValue('0x1F', 5, 'sdec'), '-1');
  assert.equal(formatSignalValue('0x1', 1, 'sdec'), '-1');
  assert.equal(formatSignalValue('0x1', 1, 'udec'), '1');
  assert.equal(formatSignalValue('0x1F', 5, 'hex'), '0x1f');
});

test('unsampled, unknown and error values are not rendered as zero', () => {
  assert.equal(formatSignalValue(undefined, 32, 'hex', 'unsampled'), '未采样');
  assert.equal(formatSignalValue(undefined, 32, 'hex', 'unknown'), '未知');
  assert.equal(formatSignalValue(undefined, 32, 'hex', 'error'), '错误');
  assert.equal(formatSignalValue(undefined, 32, 'hex'), '—');
});
