import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {TesterService} from '../../packages/desktop-service/src/index.js';
import {parseLogisimHex} from '../../packages/mips-core/src/index.js';

async function makeService(dataDir: string): Promise<TesterService> {
  const service = new TesterService({repoRoot: resolve('.'), dataDir});
  await service.init();
  return service;
}

test('desktop service loads the course CPU and runs a real suite', {timeout: 120000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cpu-tester-service-'));
  try {
    const service = await makeService(dataDir);
    const loaded = await service.loadCircuit('fixtures/course-cpu.circ');
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message);
    if (!loaded.ok) return;
    assert.equal(loaded.circuitName, 'main');
    assert.equal(loaded.config.clock.mode, 'internal');
    assert.equal(loaded.config.pc.initial, 0x3000);
    assert.equal(loaded.clocks.length, 1);

    const configPath = join(dataDir, 'course-copy.config.json');
    const savedConfig = await service.saveConfig({...loaded.config, name: 'course-copy'}, configPath);
    assert.equal(savedConfig.saved, true);
    const reloadedConfig = await service.loadConfig(configPath);
    assert.equal(reloadedConfig.name, 'course-copy');

    const assembly = service.assembleSource('ori $t0,$zero,5\nori $t1,$zero,7\nadd $t2,$t0,$t1\nsw $t2,256($zero)\n');
    assert.equal(assembly.ok, true, assembly.message);
    assert.deepEqual(assembly.words, ['0x34080005', '0x34090007', '0x01095020', '0xAC0A0100']);
    assert.deepEqual(loaded.config.instructions, ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop']);
    const disabled = service.assembleSource('sll $t0, $t0, 1');
    assert.equal(disabled.ok, false);
    assert.equal(disabled.diagnostics?.[0].code, 'ASM_INSTRUCTION_DISABLED');
    const updated = await service.setInstructions([
      'add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop', 'sll', 'j',
    ]);
    assert.equal(updated.ok, true, updated.error);
    assert.deepEqual(updated.config?.instructions.slice(-2), ['sll', 'j']);
    assert.equal(service.assembleSource('j target\ntarget:').ok, true);

    let sawLivePc = false;
    service.subscribe((update) => {
      if (update.type === 'progress' && update.currentPc && update.currentInstruction) sawLivePc = true;
    });
    const started = await service.startRun({kind: 'suite', suite: 'alu'});
    assert.equal(started.started, true, started.error);
    await service.waitForRun();
    assert.equal(sawLivePc, true);
    const state = service.getState();
    assert.equal(state.running, false);
    assert.equal(state.lastSummary?.totals.failed, 0);
    assert.equal(state.lastSummary?.totals.errors, 0);
    assert.ok((state.lastSummary?.totals.passed ?? 0) > 15);
    const meta = await service.getReportMeta(state.lastReportId!);
    assert.deepEqual(meta?.instructions, service.getState().config?.instructions);
    const reportTest = await service.getReportTest(state.lastReportId!, meta!.tests[0].id);
    assert.ok((reportTest?.instructions?.length ?? 0) > 0);
    const tracePage = await service.getReportTrace(state.lastReportId!, meta!.tests[0].id, 0, 200);
    assert.ok((tracePage?.rows.length ?? 0) > 0);
    const hexPath = join(dataDir, 'program.hex');
    await service.exportHex(state.lastReportId!, meta!.tests[0].id, hexPath);
    const hexText = await readFile(hexPath, 'utf8');
    assert.match(hexText, /^v2\.0 raw\n/);
    assert.ok(parseLogisimHex(hexText).length > 0);

    const custom = await service.startRun({
      kind: 'assembly',
      assembly: 'ori $t0,$zero,5\nori $t1,$zero,7\nadd $t2,$t0,$t1\nsw $t2,256($zero)\n',
      steps: 4,
    });
    assert.equal(custom.started, true, custom.error);
    await service.waitForRun();
    assert.equal(service.getState().lastSummary?.totals.passed, 1);

    const history = await service.listHistory();
    assert.equal(history.length, 2);
    const record = await service.getHistory(history.find((entry) => entry.suite === 'alu')!.id);
    assert.ok(record);
    assert.equal(record?.summary.totals.passed, state.lastSummary?.totals.passed);
    const exportPath = join(dataDir, 'export.json');
    await service.exportHistory(record!.meta.id, exportPath);
    const exported = JSON.parse(await readFile(exportPath, 'utf8')) as {meta: {totals: {passed: number}}};
    assert.equal(exported.meta.totals.passed, state.lastSummary?.totals.passed);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('desktop service runs the stress intensity and stores coverage/report pages', {timeout: 120000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cpu-tester-service-'));
  try {
    const service = await makeService(dataDir);
    const loaded = await service.loadCircuit('fixtures/course-cpu.circ');
    assert.equal(loaded.ok, true);
    const started = await service.startRun({kind: 'suite', suite: 'stress', intensity: 'quick'});
    assert.equal(started.started, true, started.error);
    await service.waitForRun();
    const state = service.getState();
    assert.equal(state.lastSummary?.totals.failed, 0);
    assert.equal(state.lastSummary?.totals.errors, 0);
    assert.ok((state.lastSummary?.coverage?.dynamicInstructions ?? 0) > 0);
    const meta = await service.getReportMeta(state.lastReportId!);
    assert.ok(meta?.tests.some((entry) => entry.staticInstructions > 0));
    assert.ok((meta?.coverage?.instructions.add ?? 0) > 0);
    const loop = meta?.tests.find((entry) => entry.id.includes('loop-sum'));
    assert.ok(loop);
    const page0 = await service.getReportTrace(state.lastReportId!, loop!.id, 0, 200);
    assert.equal(page0?.rows.length, 200);
    assert.ok((page0?.total ?? 0) > 200);
    const page1 = await service.getReportTrace(state.lastReportId!, loop!.id, 200, 200);
    assert.equal(page1?.rows[0].cycle, 201);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('desktop service accepts a course CPU with extra physical RAM components', {timeout: 120000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cpu-tester-service-'));
  try {
    const service = await makeService(dataDir);
    const loaded = await service.loadCircuit('fixtures/course-multi-ram.circ');
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message);
    if (!loaded.ok) return;
    assert.equal('ram' in loaded, false);
    assert.equal(loaded.config.ram.capacityWords, 3072);
    const started = await service.startRun({kind: 'suite', suite: 'basic'});
    assert.equal(started.started, true, started.error);
    await service.waitForRun();
    const summary = service.getState().lastSummary;
    assert.equal(summary?.totals.failed, 0);
    assert.equal(summary?.totals.errors, 0);
    assert.equal(summary?.totals.passed, summary?.totals.total);
    assert.ok((summary?.totals.total ?? 0) > 20);
    const reportId = service.getState().lastReportId;
    assert.ok(reportId);
    const meta = await service.getReportMeta(reportId!);
    assert.ok((meta?.tests[0].staticInstructions ?? 0) > 0);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('desktop service rejects a non-course circuit instead of faking a profile', {timeout: 60000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cpu-tester-service-'));
  try {
    const service = await makeService(dataDir);
    const loaded = await service.loadCircuit('fixtures/cpu.circ');
    assert.equal(loaded.ok, false);
    if (!loaded.ok) assert.match(loaded.message, /CIRCUIT_NOT_FOUND|main|顶层电路/);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('stop aborts a running suite without reporting an incomplete PASS', {timeout: 60000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cpu-tester-service-'));
  try {
    const service = await makeService(dataDir);
    const loaded = await service.loadCircuit('fixtures/course-cpu.circ');
    assert.equal(loaded.ok, true);
    let seenResults = 0;
    service.subscribe((update) => {
      if (update.type === 'test-result') seenResults++;
    });
    const started = await service.startRun({kind: 'suite', suite: 'full'});
    assert.equal(started.started, true);
    const deadline = Date.now() + 15000;
    while (seenResults === 0 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    await service.stop();
    const state = service.getState();
    assert.equal(state.running, false);
    const summary = state.lastSummary;
    if (summary) {
      assert.ok(
        summary.totals.total < 43 || summary.totals.failed + summary.totals.errors > 0,
        JSON.stringify(summary.totals),
      );
    }
    const history = await service.listHistory();
    if (history.length > 0) assert.equal(history[0].complete, false);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('settings and history are persisted under the service data directory', {timeout: 60000}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cpu-tester-service-'));
  try {
    const service = await makeService(dataDir);
    const updated = await service.updateSettings({javaPath: '', bridgeTimeoutMs: 12345, maxCycles: 4321});
    assert.equal(updated.bridgeTimeoutMs, 12345);
    const restarted = await makeService(dataDir);
    assert.equal(restarted.getState().settings.bridgeTimeoutMs, 12345);
    assert.equal(restarted.getState().settings.maxCycles, 4321);
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
});
