import {useEffect, useState} from 'react';
import type {AppState, TesterSettings} from '../../../../packages/desktop-ipc/src/index.js';

interface Props {
  state: AppState | null;
  onRefresh: () => Promise<void>;
  onMessage: (message: string | null) => void;
  onUpdateSettings: (patch: Partial<TesterSettings>) => Promise<void>;
}

interface FormState {
  javaPath: string;
  defaultCircuit: string;
  defaultConfig: string;
  bridgeTimeoutMs: number;
  maxCycles: number;
  theme: 'light' | 'dark';
  circuitName: string;
  resetPin: string;
  pcInitial: string;
  romBase: string;
  romAddrBits: number;
  romCapacity: number;
  ramBase: string;
  ramCapacity: number;
}

export function SettingsPage({state, onRefresh, onMessage, onUpdateSettings}: Props) {
  const [form, setForm] = useState<FormState>(() => toForm(state));
  const [logs, setLogs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(toForm(state));
  }, [state?.config, state?.settings]);

  useEffect(() => {
    window.cpuTester.getLogs().then(setLogs).catch(() => undefined);
  }, []);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({...current, [key]: value}));
  }

  async function saveSettings(): Promise<void> {
    setSaving(true);
    try {
      await onUpdateSettings({
        javaPath: form.javaPath,
        defaultCircuit: form.defaultCircuit,
        defaultConfig: form.defaultConfig,
        bridgeTimeoutMs: form.bridgeTimeoutMs,
        maxCycles: form.maxCycles,
        theme: form.theme,
      });
      onMessage('设置已保存');
    } catch (error) {
      onMessage(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveConfig(): Promise<void> {
    if (!state?.config) {
      onMessage('尚未加载 CPU 配置');
      return;
    }
    setSaving(true);
    try {
      const config = structuredClone(state.config);
      config.circuitName = form.circuitName;
      if (config.reset.strategy === 'pin') config.reset.pin = form.resetPin;
      config.pc = {...config.pc, initial: parseAddress(form.pcInitial) ?? config.pc.initial};
      config.rom = {
        ...config.rom,
        baseByteAddress: parseAddress(form.romBase) ?? config.rom.baseByteAddress,
        addressBits: form.romAddrBits,
        capacityWords: form.romCapacity,
      };
      config.ram = {
        baseByteAddress: parseAddress(form.ramBase) ?? config.ram.baseByteAddress,
        capacityWords: form.ramCapacity,
        // Logical geometry is derived; these fields are accepted for migration
        // and never refer to a physical RAM component.
        addressBits: Math.max(1, Math.ceil(Math.log2(form.ramCapacity))),
        addressShift: 2,
        dataBits: 32,
      };
      const result = await window.cpuTester.saveConfig(config, form.defaultConfig || undefined);
      if (result.saved) onMessage(`CPU 配置已保存：${result.path}`);
      await onRefresh();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function browseCircuit(): Promise<void> {
    const path = await window.cpuTester.chooseCircuit();
    if (!path) return;
    patch('defaultCircuit', path);
    const result = await window.cpuTester.inspectCircuit(path);
    if (!result.ok) onMessage(result.message);
    else onMessage(`已加载 ${path}`);
    await onRefresh();
  }

  async function browseConfig(): Promise<void> {
    const path = await window.cpuTester.chooseConfig();
    if (!path) return;
    patch('defaultConfig', path);
    try {
      await window.cpuTester.loadConfig(path);
      await onRefresh();
      onMessage(`已载入配置 ${path}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshLogs(): Promise<void> {
    setLogs(await window.cpuTester.getLogs());
  }

  return (
    <div className="settings-page" data-testid="settings">
      <section className="card">
        <div className="card-head">
          <div>
            <div className="eyebrow">运行环境</div>
            <h2>Java / Bridge</h2>
          </div>
          <span className={`badge ${state?.bridgeStatus === 'error' ? 'fail' : state?.bridgeStatus === 'running' ? 'warn' : 'ok'}`}>
            {bridgeLabel(state?.bridgeStatus)}
          </span>
        </div>
        <div className="muted small" style={{marginBottom: 12}}>
          Logisim 内核：官方 2.7.1（仓库内固定 JAR，不修改、不 fork）
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Java 可执行文件</span>
            <input
              value={form.javaPath}
              onChange={(event) => patch('javaPath', event.target.value)}
              placeholder="留空使用 java / $JAVA"
            />
          </label>
          <label className="field">
            <span>Bridge 超时（ms）</span>
            <input
              type="number"
              min={1000}
              value={form.bridgeTimeoutMs}
              onChange={(event) => patch('bridgeTimeoutMs', Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>单次最大周期</span>
            <input
              type="number"
              min={1}
              value={form.maxCycles}
              onChange={(event) => patch('maxCycles', Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>主题</span>
            <select value={form.theme} onChange={(event) => patch('theme', event.target.value as 'light' | 'dark')}>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>默认电路</span>
            <div className="input-with-button">
              <input value={form.defaultCircuit} onChange={(event) => patch('defaultCircuit', event.target.value)} />
              <button className="btn ghost" onClick={browseCircuit}>浏览</button>
            </div>
          </label>
          <label className="field">
            <span>默认配置</span>
            <div className="input-with-button">
              <input value={form.defaultConfig} onChange={(event) => patch('defaultConfig', event.target.value)} />
              <button className="btn ghost" onClick={browseConfig}>浏览</button>
            </div>
          </label>
        </div>
        <div className="toolbar-row end">
          <button className="btn primary" onClick={saveSettings} disabled={saving}>保存设置</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <div className="eyebrow">CPU Profile</div>
            <h2>CPU / ROM / 逻辑 DM 配置</h2>
          </div>
          {state?.config && <span className="badge muted">{state.config.name}</span>}
        </div>
        {!state?.config ? (
          <div className="empty-inline">加载电路或配置后可编辑课程 CPU 参数。</div>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">
                <span>顶层电路名</span>
                <input value={form.circuitName} onChange={(event) => patch('circuitName', event.target.value)} />
              </label>
              <label className="field">
                <span>复位 Pin</span>
                <input
                  value={form.resetPin}
                  onChange={(event) => patch('resetPin', event.target.value)}
                  disabled={state.config.reset.strategy !== 'pin'}
                />
              </label>
              <label className="field">
                <span>PC 初值</span>
                <input value={form.pcInitial} onChange={(event) => patch('pcInitial', event.target.value)} placeholder="0x3000" />
              </label>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>ROM 基址</span>
                <input value={form.romBase} onChange={(event) => patch('romBase', event.target.value)} />
              </label>
              <label className="field">
                <span>ROM 地址位宽</span>
                <input type="number" value={form.romAddrBits} onChange={(event) => patch('romAddrBits', Number(event.target.value))} />
              </label>
              <label className="field">
                <span>ROM 容量（字）</span>
                <input type="number" value={form.romCapacity} onChange={(event) => patch('romCapacity', Number(event.target.value))} />
              </label>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>逻辑 DM 基址</span>
                <input value={form.ramBase} onChange={(event) => patch('ramBase', event.target.value)} />
              </label>
              <label className="field">
                <span>逻辑 DM 容量（字）</span>
                <input type="number" value={form.ramCapacity} onChange={(event) => patch('ramCapacity', Number(event.target.value))} />
              </label>
            </div>
            <div className="config-outputs">
              {Object.entries(state.config.outputs ?? {}).map(([key, value]) => (
                <span className="chip" key={key}>{key} → {value}</span>
              ))}
            </div>
            <div className="muted small">
              当前时钟：{state.config.clock.mode === 'internal' ? '内部 Logisim Clock（Bridge 驱动）' : `外部 ${state.config.clock.pin}`}
              {' · '}
              ROM {state.config.rom.path} · 逻辑 DM 由参考模型维护，不读取物理 RAM
            </div>
            <div className="toolbar-row end">
              <button className="btn primary" onClick={saveConfig} disabled={saving}>保存 CPU 配置</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <div className="eyebrow">诊断</div>
            <h2>Bridge 日志</h2>
          </div>
          <button className="btn ghost" onClick={refreshLogs}>刷新日志</button>
        </div>
        {logs.length === 0 ? (
          <div className="empty-inline">暂无日志。</div>
        ) : (
          <pre className="code-block log-block">{logs.slice(-120).join('\n')}</pre>
        )}
      </section>
    </div>
  );
}

function toForm(state: AppState | null): FormState {
  const settings = state?.settings;
  const config = state?.config;
  return {
    javaPath: settings?.javaPath ?? '',
    defaultCircuit: settings?.defaultCircuit ?? '',
    defaultConfig: settings?.defaultConfig ?? '',
    bridgeTimeoutMs: settings?.bridgeTimeoutMs ?? 30000,
    maxCycles: settings?.maxCycles ?? 200000,
    theme: settings?.theme ?? 'light',
    circuitName: config?.circuitName ?? 'main',
    resetPin: config?.reset.strategy === 'pin' ? config.reset.pin : 'reset',
    pcInitial: config ? `0x${config.pc.initial.toString(16)}` : '0x3000',
    romBase: config ? `0x${config.rom.baseByteAddress.toString(16)}` : '0x3000',
    romAddrBits: config?.rom.addressBits ?? 12,
    romCapacity: config?.rom.capacityWords ?? 4096,
    ramBase: config ? `0x${config.ram.baseByteAddress.toString(16)}` : '0x0',
    ramCapacity: config?.ram.capacityWords ?? 3072,
  };
}

function parseAddress(text: string): number | null {
  const value = /^0x/i.test(text.trim()) ? Number.parseInt(text.trim().slice(2), 16) : Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

function bridgeLabel(status: AppState['bridgeStatus'] | undefined): string {
  switch (status) {
    case 'running': return '运行中';
    case 'starting': return '启动中';
    case 'stopping': return '停止中';
    case 'error': return '错误';
    default: return '就绪';
  }
}
