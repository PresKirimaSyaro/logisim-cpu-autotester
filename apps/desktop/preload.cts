import type {
  AssembleResult,
  CircuitInspectResult,
  DesktopApi,
  FileText,
  HistoryMeta,
  HistoryRecord,
  RunRequest,
  RunStartResult,
  RunUpdate,
  TesterSettings,
} from '../../packages/desktop-ipc/src/index.js';
import type {CpuConfig} from '../../packages/mips-core/src/index.js';
import type {IpcRendererEvent} from 'electron';

const {contextBridge, ipcRenderer} = require('electron') as typeof import('electron');

// Kept inline (not imported at runtime) because a sandboxed preload is CommonJS
// while the shared package is ESM. The channel strings match desktop-ipc.
const IPC = {
  stateGet: 'state:get',
  settingsUpdate: 'settings:update',
  circuitChoose: 'circuit:choose',
  circuitInspect: 'circuit:inspect',
  configChoose: 'config:choose',
  configLoad: 'config:load',
  configSave: 'config:save',
  asmChoose: 'asm:choose',
  asmSave: 'asm:save',
  reportChoosePath: 'report:choosePath',
  reportExport: 'report:export',
  runStart: 'run:start',
  runStop: 'run:stop',
  historyList: 'history:list',
  historyGet: 'history:get',
  historyRerun: 'history:rerun',
  assemble: 'assemble',
  logsGet: 'logs:get',
  runUpdate: 'run:update',
  stateUpdate: 'state:update',
} as const;

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: DesktopApi = {
  getState: () => ipcRenderer.invoke(IPC.stateGet),
  updateSettings: (patch: Partial<TesterSettings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  chooseCircuit: () => ipcRenderer.invoke(IPC.circuitChoose),
  inspectCircuit: (path: string): Promise<CircuitInspectResult> => ipcRenderer.invoke(IPC.circuitInspect, path),
  chooseConfig: () => ipcRenderer.invoke(IPC.configChoose),
  loadConfig: (path: string): Promise<CpuConfig> => ipcRenderer.invoke(IPC.configLoad, path),
  saveConfig: (config: CpuConfig, path?: string) => ipcRenderer.invoke(IPC.configSave, config, path),
  chooseAsm: (): Promise<FileText | null> => ipcRenderer.invoke(IPC.asmChoose),
  saveAsm: (source: string, suggestedPath?: string) => ipcRenderer.invoke(IPC.asmSave, source, suggestedPath),
  chooseReportPath: (suggestedName: string) => ipcRenderer.invoke(IPC.reportChoosePath, suggestedName),
  exportReport: (historyId: string, path?: string) => ipcRenderer.invoke(IPC.reportExport, historyId, path),
  run: (request: RunRequest): Promise<RunStartResult> => ipcRenderer.invoke(IPC.runStart, request),
  stop: () => ipcRenderer.invoke(IPC.runStop),
  listHistory: (): Promise<HistoryMeta[]> => ipcRenderer.invoke(IPC.historyList),
  getHistory: (id: string): Promise<HistoryRecord | null> => ipcRenderer.invoke(IPC.historyGet, id),
  rerun: (historyId: string, onlyFailed: boolean) => ipcRenderer.invoke(IPC.historyRerun, historyId, onlyFailed),
  assemble: (source: string): Promise<AssembleResult> => ipcRenderer.invoke(IPC.assemble, source),
  getLogs: (): Promise<string[]> => ipcRenderer.invoke(IPC.logsGet),
  onRunUpdate: (listener: (update: RunUpdate) => void) => subscribe(IPC.runUpdate, listener),
  onStateUpdate: (listener) => subscribe(IPC.stateUpdate, listener),
};

contextBridge.exposeInMainWorld('cpuTester', api);
