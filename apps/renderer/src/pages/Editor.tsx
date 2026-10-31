import {useRef, useState} from 'react';
import type {AssembleResult} from '../../../../packages/desktop-ipc/src/index.js';

interface Props {
  source: string;
  onChange: (value: string) => void;
  onRun: (steps: number, stopPc?: number) => Promise<void>;
  running: boolean;
  onOpenWorkbench: () => void;
  onMessage: (message: string | null) => void;
}

export function Editor({source, onChange, onRun, running, onOpenWorkbench, onMessage}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [assembled, setAssembled] = useState<AssembleResult | null>(null);
  const [steps, setSteps] = useState(4);
  const [stopPcText, setStopPcText] = useState('');
  const [busy, setBusy] = useState(false);
  const lineCount = source.split('\n').length;

  function syncScroll(): void {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop;
      highlightRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
  }

  function insertTab(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${source.slice(0, start)}    ${source.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = start + 4;
    });
  }

  async function assembleNow(): Promise<void> {
    setBusy(true);
    try {
      const result = await window.cpuTester.assemble(source);
      setAssembled(result);
      if (!result.ok) onMessage(result.message ?? '汇编失败');
      else onMessage(null);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function importAsm(): Promise<void> {
    const file = await window.cpuTester.chooseAsm();
    if (!file) return;
    onChange(file.source);
    setAssembled(null);
    onMessage(`已导入 ${file.path}`);
  }

  async function exportAsm(): Promise<void> {
    const result = await window.cpuTester.saveAsm(source);
    if (result.saved) onMessage(`已导出 ${result.path}`);
  }

  async function run(): Promise<void> {
    const stopPc = stopPcText.trim().length > 0 ? parseAddress(stopPcText) : undefined;
    if (stopPcText.trim().length > 0 && stopPc === null) {
      onMessage('停止 PC 格式无效');
      return;
    }
    if (stopPc === undefined && (!Number.isInteger(steps) || steps <= 0)) {
      onMessage('周期数必须是正整数');
      return;
    }
    await onRun(steps, stopPc ?? undefined);
  }

  return (
    <div className="editor-page" data-testid="editor">
      <section className="card editor-card">
        <div className="card-head">
          <div>
            <div className="eyebrow">MIPS 汇编</div>
            <h2>程序编辑器</h2>
          </div>
          <div className="toolbar-row">
            <button className="btn ghost" onClick={importAsm} disabled={busy || running}>
              导入 .asm
            </button>
            <button className="btn ghost" onClick={exportAsm} disabled={busy}>
              导出 .asm
            </button>
            <button className="btn" onClick={assembleNow} disabled={busy || running}>
              {busy ? '汇编中…' : '汇编'}
            </button>
          </div>
        </div>

        <div className="editor-shell">
          <div className="editor-gutter" ref={gutterRef}>
            {Array.from({length: lineCount}, (_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
          <div className="editor-main">
            <pre
              className="editor-highlight"
              ref={highlightRef}
              aria-hidden="true"
              dangerouslySetInnerHTML={{__html: `${highlightMips(source)}\n`}}
            />
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={source}
              onChange={(event) => {
                onChange(event.target.value);
                setAssembled(null);
              }}
              onScroll={syncScroll}
              onKeyDown={insertTab}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="MIPS 汇编编辑器"
            />
          </div>
        </div>

        <div className="editor-footer">
          <div className="inline-fields">
            <label className="field narrow">
              <span>周期数</span>
              <input
                type="number"
                min={1}
                value={steps}
                onChange={(event) => setSteps(Number(event.target.value))}
                disabled={running}
              />
            </label>
            <label className="field narrow">
              <span>或停止 PC</span>
              <input
                value={stopPcText}
                onChange={(event) => setStopPcText(event.target.value)}
                placeholder="0x3030"
                disabled={running}
              />
            </label>
            <button className="btn primary" onClick={run} disabled={running}>
              {running ? '运行中…' : '运行测试'}
            </button>
            <button className="link-btn" onClick={onOpenWorkbench}>
              查看工作台 ↗
            </button>
          </div>
          <span className="muted small">支持 add / sub / ori / lw / sw / beq / sll</span>
        </div>
      </section>

      <section className="card compile-card">
        <div className="card-head">
          <div>
            <div className="eyebrow">汇编结果</div>
            <h2>机器码与诊断</h2>
          </div>
          {assembled?.ok && <span className="badge ok">{assembled.words?.length ?? 0} 字</span>}
        </div>
        {!assembled && <div className="empty-inline">点击“汇编”后显示机器码、地址和错误位置。</div>}
        {assembled && !assembled.ok && (
          <div className="notice notice-error">
            {assembled.diagnostics?.map((diagnostic, index) => (
              <div key={index}>
                第 {diagnostic.line} 行，第 {diagnostic.column} 列：{diagnostic.message}
                {diagnostic.lineText && <pre className="diagnostic-line">{diagnostic.lineText}</pre>}
              </div>
            )) ?? assembled.message}
          </div>
        )}
        {assembled?.ok && (
          <>
            <div className="table-wrap compact">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>地址</th>
                    <th>机器码</th>
                    <th>源文本</th>
                  </tr>
                </thead>
                <tbody>
                  {(assembled.lines ?? []).map((line) => (
                    <tr key={`${line.address}-${line.hex}`}>
                      <td className="mono">0x{line.address.toString(16).padStart(8, '0')}</td>
                      <td className="mono">{line.hex}</td>
                      <td className="mono muted">{line.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className="symbols">
              <summary>符号表（{Object.keys(assembled.symbols ?? {}).length}）</summary>
              <div className="code-grid">
                {Object.entries(assembled.symbols ?? {}).map(([name, address]) => (
                  <div className="code-word" key={name}>
                    <span>{name}</span>
                    <strong>0x{address.toString(16).padStart(8, '0')}</strong>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}

function parseAddress(text: string): number | null {
  const value = /^0x/i.test(text.trim()) ? Number.parseInt(text.trim().slice(2), 16) : Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOKEN =
  /(\$[A-Za-z0-9_]+)|(\b(?:add|sub|ori|lw|sw|beq|sll)\b)|(\b0x[0-9a-fA-F]+\b|\b-?\d+\b)|([A-Za-z_.][A-Za-z0-9_.]*:)/g;

function highlightMips(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const hashIndex = line.indexOf('#');
      const semiIndex = line.indexOf(';');
      const commentIndex =
        hashIndex < 0 ? semiIndex : semiIndex < 0 ? hashIndex : Math.min(hashIndex, semiIndex);
      const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
      const comment = commentIndex >= 0 ? line.slice(commentIndex) : '';
      let result = '';
      let lastIndex = 0;
      TOKEN.lastIndex = 0;
      for (let match = TOKEN.exec(code); match; match = TOKEN.exec(code)) {
        result += escapeHtml(code.slice(lastIndex, match.index));
        const token = match[0];
        let className = '';
        if (match[1]) className = 'tok-register';
        else if (match[2]) className = 'tok-mnemonic';
        else if (match[3]) className = 'tok-number';
        else if (match[4]) className = 'tok-label';
        result += className ? `<span class="${className}">${escapeHtml(token)}</span>` : escapeHtml(token);
        lastIndex = match.index + token.length;
      }
      result += escapeHtml(code.slice(lastIndex));
      if (comment) result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
      return result;
    })
    .join('\n');
}
