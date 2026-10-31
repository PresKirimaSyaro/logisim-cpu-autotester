import {app, BrowserWindow, dialog, ipcMain} from 'electron';
import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {IPC, type RunRequest, type TesterSettings} from '../../packages/desktop-ipc/src/index.js';
import {TesterService} from '../../packages/desktop-service/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(app.getAppPath());
// Records live next to the EXE in the portable package; development keeps them
// in the repository root. This makes the portable folder self-contained.
const exeDir = app.isPackaged ? dirname(process.execPath) : resolve('.');
const dataDir = join(exeDir, 'test-records');
let mainWindow: BrowserWindow | null = null;
let service: TesterService | null = null;
const resultWindows = new Map<string, BrowserWindow>();

app.setName('Logisim CPU Tester');

function sendState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !service) return;
  mainWindow.webContents.send(IPC.stateUpdate, service.getState());
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0f172a',
    title: 'Logisim CPU Tester',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function openResultWindow(reportId: string): BrowserWindow {
  const existing = resultWindows.get(reportId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f172a',
    title: `测试结果 · ${reportId}`,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'result.html'), {query: {reportId}});
  resultWindows.set(reportId, win);
  win.on('closed', () => {
    if (resultWindows.get(reportId) === win) resultWindows.delete(reportId);
  });
  return win;
}

async function pickFile(options: Electron.OpenDialogOptions): Promise<string | null> {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function pickSave(options: Electron.SaveDialogOptions): Promise<string | null> {
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? null : result.filePath ?? null;
}

function registerIpc(): void {
  ipcMain.handle(IPC.stateGet, () => service!.getState());
  ipcMain.handle(IPC.settingsUpdate, async (_event, patch: Partial<TesterSettings>) => {
    if (!patch || typeof patch !== 'object') throw new Error('设置参数无效');
    const settings = await service!.updateSettings(patch);
    sendState();
    return settings;
  });
  ipcMain.handle(IPC.circuitChoose, () =>
    pickFile({
      title: '选择 CPU 电路',
      properties: ['openFile'],
      filters: [{name: 'Logisim 电路', extensions: ['circ']}],
    }),
  );
  ipcMain.handle(IPC.circuitInspect, async (_event, path: string) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('电路路径无效');
    const result = await service!.loadCircuit(path);
    sendState();
    return result;
  });
  ipcMain.handle(IPC.configChoose, () =>
    pickFile({
      title: '选择 CPU 配置',
      properties: ['openFile'],
      filters: [{name: 'CPU 配置', extensions: ['json']}],
    }),
  );
  ipcMain.handle(IPC.configLoad, async (_event, path: string) => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('配置路径无效');
    const config = await service!.loadConfig(path);
    sendState();
    return config;
  });
  ipcMain.handle(IPC.configSave, async (_event, config, path?: string) => {
    if (!config || typeof config !== 'object') throw new Error('配置无效');
    let target = path;
    if (!target) {
      target = await pickSave({
        title: '保存 CPU 配置',
        defaultPath: join(repoRoot, 'fixtures', 'course.config.json'),
        filters: [{name: 'CPU 配置', extensions: ['json']}],
      }) ?? undefined;
    }
    if (!target) return {saved: false};
    return service!.saveConfig(config, target);
  });
  ipcMain.handle(IPC.asmChoose, async () => {
    const path = await pickFile({
      title: '导入 MIPS 汇编',
      properties: ['openFile'],
      filters: [{name: 'MIPS 汇编', extensions: ['asm']}],
    });
    if (!path) return null;
    return service!.readAsm(path);
  });
  ipcMain.handle(IPC.asmSave, async (_event, source: string, suggestedPath?: string) => {
    if (typeof source !== 'string') throw new Error('汇编内容无效');
    const target = await pickSave({
      title: '导出 MIPS 汇编',
      defaultPath: suggestedPath || join(repoRoot, 'tests', 'programs', 'program.asm'),
      filters: [{name: 'MIPS 汇编', extensions: ['asm']}],
    });
    if (!target) return {saved: false};
    return service!.saveAsm(source, target);
  });
  ipcMain.handle(IPC.instructionsSet, async (_event, instructions: string[]) => {
    if (!Array.isArray(instructions) || instructions.some((entry) => typeof entry !== 'string')) {
      return {ok: false, error: '指令集参数无效'};
    }
    const result = await service!.setInstructions(instructions);
    sendState();
    return result;
  });
  ipcMain.handle(IPC.reportChoosePath, async (_event, suggestedName: string) => {
    const name = typeof suggestedName === 'string' && suggestedName.length > 0 ? suggestedName : 'report.json';
    return pickSave({
      title: '导出测试报告',
      defaultPath: join(repoRoot, 'test-results', name),
      filters: [{name: 'JSON 报告', extensions: ['json']}],
    });
  });
  ipcMain.handle(IPC.reportExport, async (_event, historyId: string, path?: string) => {
    if (typeof historyId !== 'string') throw new Error('历史记录无效');
    let target = path;
    if (!target) {
      target = await pickSave({
        title: '导出测试报告',
        defaultPath: join(repoRoot, 'test-results', `report-${historyId}.json`),
        filters: [{name: 'JSON 报告', extensions: ['json']}],
      }) ?? undefined;
    }
    if (!target) return {saved: false};
    return service!.exportHistory(historyId, target);
  });
  ipcMain.handle(IPC.runStart, async (_event, request: RunRequest) => {
    if (!request || typeof request !== 'object') return {started: false, error: '测试请求无效'};
    if (!['suite', 'assembly', 'history'].includes(request.kind)) {
      return {started: false, error: '未知测试类型'};
    }
    const result = await service!.startRun(request);
    sendState();
    return result;
  });
  ipcMain.handle(IPC.runStop, async () => {
    await service!.stop();
    sendState();
  });
  ipcMain.handle(IPC.historyList, () => service!.listHistory());
  ipcMain.handle(IPC.historyGet, (_event, id: string) => {
    if (typeof id !== 'string') return null;
    return service!.getHistory(id);
  });
  ipcMain.handle(IPC.resultOpen, async (_event, reportId: string) => {
    if (typeof reportId !== 'string' || reportId.length === 0) return false;
    const meta = await service!.getReportMeta(reportId);
    if (!meta) return false;
    openResultWindow(reportId);
    return true;
  });
  ipcMain.handle(IPC.reportMeta, (_event, reportId: string) => {
    if (typeof reportId !== 'string') return null;
    return service!.getReportMeta(reportId);
  });
  ipcMain.handle(IPC.reportTest, (_event, reportId: string, testId: string) => {
    if (typeof reportId !== 'string' || typeof testId !== 'string') return null;
    return service!.getReportTest(reportId, testId);
  });
  ipcMain.handle(IPC.reportTrace, (_event, reportId: string, testId: string, offset: number, limit: number) => {
    if (typeof reportId !== 'string' || typeof testId !== 'string') return null;
    return service!.getReportTrace(reportId, testId, offset, limit);
  });
  ipcMain.handle(IPC.hexExport, async (_event, reportId: string, testId: string) => {
    if (typeof reportId !== 'string' || typeof testId !== 'string') return {saved: false};
    const target = await pickSave({
      title: '导出 Logisim ROM HEX',
      defaultPath: join(repoRoot, 'test-results', `${testId}.hex`),
      filters: [{name: 'Logisim ROM HEX', extensions: ['hex']}],
    });
    if (!target) return {saved: false};
    return service!.exportHex(reportId, testId, target);
  });
  ipcMain.handle(IPC.historyDelete, async (_event, historyId: string) => {
    if (typeof historyId !== 'string') return {deleted: false, error: '记录 id 无效'};
    const result = await service!.deleteHistory(historyId);
    if (result.deleted) {
      const window = resultWindows.get(historyId);
      window?.close();
    }
    sendState();
    return result;
  });
  ipcMain.handle(IPC.historyRerun, async (_event, historyId: string, onlyFailed: boolean) => {
    if (typeof historyId !== 'string') return {started: false, error: '历史记录无效'};
    const result = await service!.startRun({kind: 'history', historyId, onlyFailed: Boolean(onlyFailed)});
    sendState();
    return result;
  });
  ipcMain.handle(IPC.assemble, (_event, source: string) => {
    if (typeof source !== 'string') return {ok: false, message: '汇编内容无效'};
    return service!.assembleSource(source);
  });
  ipcMain.handle(IPC.logsGet, () => service!.getLogs());
}

async function loadDefaults(): Promise<void> {
  const settings = service!.getState().settings;
  // A fresh portable install has no saved defaults: open the bundled course
  // CPU so double-clicking the exe lands on a usable workbench.
  const fallbackCircuit = join(repoRoot, 'fixtures', 'course-cpu.circ');
  const circuitPath = settings.defaultCircuit || (existsSync(fallbackCircuit) ? fallbackCircuit : '');
  if (!circuitPath) return;
  const loaded = await service!.loadCircuit(circuitPath);
  if (!loaded.ok) {
    console.error('DEFAULT_CIRCUIT_FAILED', loaded.message);
    return;
  }
  if (settings.defaultConfig) {
    try {
      await service!.loadConfig(settings.defaultConfig);
    } catch (error) {
      console.error('DEFAULT_CONFIG_FAILED', error);
    }
  }
  // The user's last instruction selection survives loading the default config.
  await service!.setInstructions(service!.getState().settings.instructions);
  sendState();
}

async function settleFrame(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Smoke timeout');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

async function runSmoke(win: BrowserWindow): Promise<void> {
  const circuit = join(app.getAppPath(), 'fixtures', 'course-cpu.circ');
  await mkdir(join(app.getAppPath(), 'test-results'), {recursive: true});
  await service!.setInstructions(['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop']);
  const loaded = await service!.loadCircuit(circuit);
  if (!loaded.ok) throw new Error(`Smoke load failed: ${loaded.message}`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const instructionSetText = await win.webContents.executeJavaScript(
    `JSON.stringify(Array.from(document.querySelectorAll('.instruction-check')).map((label) => ({name: label.querySelector('span')?.textContent, checked: label.querySelector('input')?.checked})))`,
  );
  const instructionSet = JSON.parse(instructionSetText) as {name: string; checked: boolean}[];
  if (instructionSet.filter((entry) => entry.checked).length !== 8) {
    throw new Error(`Smoke default instruction set is not eight: ${instructionSetText}`);
  }
  if (instructionSet.find((entry) => entry.name === 'sll')?.checked || instructionSet.find((entry) => entry.name === 'j')?.checked) {
    throw new Error('Smoke optional instructions must default off');
  }
  for (let round = 0; round < 2; round++) {
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.instruction-check')).find((label) => label.querySelector('span')?.textContent === 'sll')?.querySelector('input')?.click()`,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const toggled = service!.getState().config?.instructions ?? [];
  if (toggled.includes('sll') || toggled.length !== 8) {
    throw new Error(`Smoke instruction toggle did not round-trip: ${toggled.join(',')}`);
  }
  console.log('SMOKE_INSTRUCTIONS', instructionSetText);
  // Exercise the renderer -> preload -> IPC -> service path for the run button.
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="run-suite"]')?.click()`);
  await waitFor(() => service!.getState().running, 10000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  await settleFrame(win);
  const running = await win.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-running.png'), running.toPNG());
  await waitFor(() => !service!.getState().running && Boolean(service!.getState().lastSummary), 30000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  await mkdir(join(app.getAppPath(), 'test-results'), {recursive: true});
  await settleFrame(win);
  const workbench = await win.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-workbench.png'), workbench.toPNG());
  const summaryText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 1200)');
  await win.webContents.executeJavaScript(`document.querySelector('[data-nav="history"]')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await settleFrame(win);
  const history = await win.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-history.png'), history.toPNG());
  const historyText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 700)');

  const reportId = service!.getState().lastReportId;
  if (!reportId) throw new Error('Smoke report id missing');
  // The history page must open the same report ID in its own window.
  await win.webContents.executeJavaScript(`document.querySelector('.history-open')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  if (resultWindows.size === 0) throw new Error('History did not open a result window');
  for (const window of resultWindows.values()) window.close();
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));

  // The workbench card must also open the report window.
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('打开测试结果窗口'))?.click()`,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const resultWin = resultWindows.get(reportId) ?? openResultWindow(reportId);
  await new Promise<void>((resolveLoad) => resultWin.webContents.once('did-finish-load', () => resolveLoad()));
  await new Promise((resolveWait) => setTimeout(resolveWait, 900));
  await settleFrame(resultWin);
  const resultCode = await resultWin.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-result-code.png'), resultCode.toPNG());
  const resultCodeText = await resultWin.webContents.executeJavaScript('document.body.innerText.slice(0, 1200)');
  await resultWin.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('逐周期'))?.click()`,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await settleFrame(resultWin);
  const resultTrace = await resultWin.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-result-trace.png'), resultTrace.toPNG());
  const resultTraceText = await resultWin.webContents.executeJavaScript('document.body.innerText.slice(0, 1200)');
  const resultTraceTable = await resultWin.webContents.executeJavaScript(
    'document.querySelector(\'.trace-table\')?.innerText.slice(0, 1600) ?? \'missing trace table\'',
  );
  resultWin.close();

  const stress = await service!.startRun({kind: 'suite', suite: 'stress', intensity: 'quick'});
  if (!stress.started) throw new Error(`Smoke stress run failed: ${stress.error}`);
  await service!.waitForRun();
  const stressId = service!.getState().lastReportId;
  if (!stressId) throw new Error('Smoke stress report id missing');
  const stressWin = openResultWindow(stressId);
  await new Promise<void>((resolveLoad) => stressWin.webContents.once('did-finish-load', () => resolveLoad()));
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  await stressWin.webContents.executeJavaScript(
    `new Promise((resolve) => {
      let attempts = 0;
      const timer = setInterval(() => {
        const item = Array.from(document.querySelectorAll('.result-test-item')).find((button) => button.textContent?.includes('stress-loop-sum-quick'));
        if (item) { item.click(); clearInterval(timer); resolve(true); }
        else if (++attempts > 50) { clearInterval(timer); resolve(false); }
      }, 100);
    })`,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  await stressWin.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('逐周期'))?.click()`,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await stressWin.webContents.executeJavaScript(`document.querySelector('.coverage-panel summary')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  await settleFrame(stressWin);
  const stressTrace = await stressWin.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-result-stress.png'), stressTrace.toPNG());
  const stressText = await stressWin.webContents.executeJavaScript('document.body.innerText.slice(0, 1200)');
  stressWin.close();

  await win.webContents.executeJavaScript(`document.querySelector('[data-nav="editor"]')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '汇编')?.click()`,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await settleFrame(win);
  const editor = await win.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-editor.png'), editor.toPNG());
  const editorText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 900)');
  await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '运行测试')?.click()`,
  );
  await waitFor(
    () =>
      !service!.getState().running &&
      service!.getState().lastSummary?.totals.total === 1 &&
      service!.getState().lastSummary?.totals.passed === 1,
    30000,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  console.log('SMOKE_CUSTOM_ASM', JSON.stringify(service!.getState().lastSummary?.totals));
  await win.webContents.executeJavaScript(`document.querySelector('[data-nav="settings"]')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await settleFrame(win);
  const settings = await win.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-settings.png'), settings.toPNG());
  const settingsText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 700)');

  // Controlled faulty fixture: the first failing result and its detail must be visible.
  const faultyLoad = await service!.loadCircuit(join(app.getAppPath(), 'fixtures', 'course-faulty.circ'));
  if (!faultyLoad.ok) throw new Error(`Smoke faulty load failed: ${faultyLoad.message}`);
  const allEnabled = await service!.setInstructions([
    'add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop', 'sll', 'j',
  ]);
  if (!allEnabled.ok) throw new Error(`Smoke instruction enable failed: ${allEnabled.error}`);
  const faultyRun = await service!.startRun({kind: 'suite', suite: 'alu'});
  if (!faultyRun.started) throw new Error(`Smoke faulty run failed: ${faultyRun.error}`);
  await service!.waitForRun();
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  await win.webContents.executeJavaScript(`document.querySelector('.result-detail')?.scrollIntoView({block: 'start'})`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await settleFrame(win);
  const failure = await win.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-failure.png'), failure.toPNG());
  const failureText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 1400)');

  const failureReportId = service!.getState().lastReportId;
  if (!failureReportId) throw new Error('Smoke failure report id missing');
  const failureWin = openResultWindow(failureReportId);
  await new Promise<void>((resolveLoad) => failureWin.webContents.once('did-finish-load', () => resolveLoad()));
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  await failureWin.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('逐周期'))?.click()`,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await settleFrame(failureWin);
  const resultFailure = await failureWin.webContents.capturePage();
  await writeFile(join(app.getAppPath(), 'test-results', 'gui-result-failure.png'), resultFailure.toPNG());
  const resultFailureText = await failureWin.webContents.executeJavaScript('document.body.innerText.slice(0, 1600)');
  failureWin.close();
  await service!.setInstructions(['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop']);

  console.log('SMOKE_WORKBENCH', JSON.stringify(summaryText));
  console.log('SMOKE_HISTORY', JSON.stringify(historyText));
  console.log('SMOKE_RESULT_CODE', JSON.stringify(resultCodeText));
  console.log('SMOKE_RESULT_TRACE', JSON.stringify(resultTraceText));
  console.log('SMOKE_RESULT_TRACE_TABLE', JSON.stringify(resultTraceTable));
  console.log('SMOKE_STRESS_RESULT', JSON.stringify(stressText));
  console.log('SMOKE_RESULT_FAILURE', JSON.stringify(resultFailureText));
  console.log('SMOKE_EDITOR', JSON.stringify(editorText));
  console.log('SMOKE_SETTINGS', JSON.stringify(settingsText));
  console.log('SMOKE_FAILURE', JSON.stringify(failureText));
  app.exit(0);
}

app.whenReady().then(async () => {
  service = new TesterService({
    repoRoot,
    dataDir,
    onUpdate: (update) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (update.type === 'state') mainWindow.webContents.send(IPC.stateUpdate, update.state);
      else mainWindow.webContents.send(IPC.runUpdate, update);
      if (update.type === 'finished' && process.env.CPU_TESTER_SMOKE !== '1') {
        openResultWindow(update.historyId);
      }
    },
  });
  await service.init();
  const bundledJava = join(app.getAppPath(), 'runtime', 'bin', 'java.exe');
  if (existsSync(bundledJava) && !service.getState().settings.javaPath) {
    await service.updateSettings({javaPath: bundledJava});
  }
  registerIpc();
  mainWindow = createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    sendState();
    if (process.env.CPU_TESTER_SMOKE === '1') {
      runSmoke(mainWindow!)
        .then(() => {
          process.exitCode = 0;
        })
        .catch((error) => {
          console.error('SMOKE_FAILED', error);
          process.exitCode = 1;
          app.exit(1);
        });
    } else {
      void loadDefaults();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  service?.stop().catch(() => undefined);
});
