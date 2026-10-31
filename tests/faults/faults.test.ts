import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {LogisimBridge} from '../../packages/bridge-client/src/index.js';
import {parseCpuConfig} from '../../packages/mips-core/src/index.js';
import {
  DifferentialRunner,
  type ReferenceFault,
  type TestInput,
} from '../../packages/differential-runner/src/index.js';

const ROOT = process.cwd();

async function config() {
  return parseCpuConfig(JSON.parse(await readFile(resolve(ROOT, 'fixtures/course.config.json'), 'utf8')));
}

const CASES: {
  fault: ReferenceFault;
  id: string;
  assembly: string;
  steps: number;
  signal?: string;
}[] = [
  {
    fault: 'sw-nextpc',
    id: 'fault-sw-nextpc',
    steps: 7,
    assembly: `
      ori $t0, $zero, 64
      ori $t1, $zero, 123
      sw $t1, -4($t0)
      ori $t2, $zero, 456
      sw $t2, 0($t0)
      lw $t3, -4($t0)
      sw $t3, 0x100($zero)
    `,
  },
  {
    fault: 'lw-sw-offset-zero',
    id: 'fault-lw-sw-zero-extend',
    steps: 7,
    signal: 'MemAddr',
    assembly: `
      ori $t0, $zero, 64
      ori $t1, $zero, 123
      sw $t1, -4($t0)
      ori $t2, $zero, 456
      sw $t2, 0($t0)
      lw $t3, -4($t0)
      sw $t3, 0x100($zero)
    `,
  },
  {
    fault: 'beq-negative-offset',
    id: 'fault-beq-negative',
    steps: 11,
    assembly: `
      ori $t0, $zero, 3
      ori $t1, $zero, 1
      loop:
      sub $t0, $t0, $t1
      beq $t0, $zero, done
      beq $zero, $zero, loop
      done:
      sw $t0, 0x100($zero)
    `,
  },
  {
    fault: 'ori-sign-extend',
    id: 'fault-ori-sign-extend',
    steps: 3,
    signal: 'RegData',
    assembly: `
      ori $t0, $zero, 0x8000
      sw $t0, 0x100($zero)
      ori $t1, $zero, 1
    `,
  },
  {
    fault: 'lui-high',
    id: 'fault-lui-high',
    steps: 3,
    signal: 'RegData',
    assembly: `
      lui $t0, 0x1234
      sw $t0, 0x100($zero)
      ori $t1, $zero, 1
    `,
  },
  {
    fault: 'add-sub-msb',
    id: 'fault-add-msb',
    steps: 5,
    signal: 'RegData',
    assembly: `
      lui $t0, 0x8000
      add $t1, $t0, $t0
      sub $t2, $t1, $t0
      sw $t2, 0x100($zero)
      ori $t3, $zero, 1
    `,
  },
];

for (const entry of CASES) {
  test(`fault injection is observed: ${entry.fault}`, {timeout: 60000}, async () => {
    const cfg = await config();
    const bridge = new LogisimBridge({timeoutMs: 30000});
    try {
      const input: TestInput = {
        id: entry.id,
        name: entry.id,
        category: 'fault-injection',
        description: 'controlled reference mutation regression',
        assembly: entry.assembly,
        steps: entry.steps,
        signature: [],
        seed: null,
      };
      const runner = new DifferentialRunner({
        circuitPath: resolve(ROOT, 'fixtures/course-cpu.circ'),
        config: cfg,
        bridge,
        referenceFault: entry.fault,
      });
      const result = await runner.runTest(input);
      assert.equal(result.status, 'fail', `${entry.fault} must be detected`);
      assert.ok(
        Boolean(result.firstSignalMismatch || result.pc?.firstDivergence),
        `${entry.fault} must report a first observable difference`,
      );
      if (entry.signal) {
        assert.equal(result.firstSignalMismatch?.signal, entry.signal);
      }
      assert.match(result.message ?? '', /diverged|mismatch/i);
    } finally {
      await bridge.close();
    }
  });
}
