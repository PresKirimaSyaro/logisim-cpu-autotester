# Phase 4 设计 — 独立结果窗口与强测

## 1. 职责分离

```text
Main Window (React)
  ├─ circuit/config, run/stop, live progress
  └─ open result(reportId) ─────────────┐
                                        │ IPC: result:open(reportId)
History Window/page                     │
  └─ open result(historyId) ────────────┤
                                        ▼
Result Window (separate BrowserWindow, React result.html)
  ├─ report:meta(reportId)
  ├─ report:test(reportId, testId)
  └─ report:trace(reportId, testId, offset, limit)
                                        │
                                        ▼
TesterService ── HistoryStore (userData/logisim-cpu-tester/history)
```

- 详细用例、机器码和逐周期轨迹只存在于结果窗口的临时 state。
- 主窗口只保留 totals、进度、当前 PC/指令和 `lastReportId`；服务层 `getState().lastSummary` 在发给主窗口前清空 `results`。
- 结果窗口通过报告 ID 查询；`finished` 事件只携带轻量 summary（results 为空），完整报告从磁盘按需读取。
- 结果窗口使用独立 `BrowserWindow`，不设 modal/parent，可单独关闭和缩放；关闭不影响主窗口或测试服务。

## 2. 报告模型

`HistoryStore` 保存 `HistoryRecord = {meta, summary, tests, request}`。新增只读接口：

- `getReportMeta(id)`：totals、耗时、coverage、每个测试的静态指令数/动态周期/状态/首次差异；不包含信号轨迹。
- `getReportTest(id,testId)`：单个测试的汇编、机器码、静态指令、状态、reference、PC 摘要；删除 `signalCheckpoints`/`trace`。
- `getReportTrace(id,testId,offset,limit)`：从信号检查点构造分页 `TraceRow`，最多 500 行；保留 expected/actual/actualStatus、静态指令索引和首次差异周期/信号。
- 服务缓存最多 2 份完整报告；旧报告缺少的静态指令字段可按汇编重建，缺失轨迹字段显示“未采样”，不伪造。

## 3. 结果窗口

### 左侧列表

- 名称、id、静态指令数、动态/预期周期、状态、首次差异周期/信号。
- 默认失败/错误优先，再按首次差异周期、名称排序；可按状态、静态、动态、首次差异排序；只看失败。
- 静态指令数来自 `AssembledProgram.instructions.length`；动态周期来自实际执行，循环程序二者不同。

### 汇编 / 机器码

- 每条静态指令显示 ROM 地址/PC（ROM index 0 = PC origin）、源文本、32 位机器码、编码字段。
- R 型：`opcode|rs|rt|rd|shamt|funct`；I 型：`opcode|rs|rt|immediate`。opcode 与 funct 分开标注。
- 显示格式：十六进制、完整二进制、分段二进制。
- 复制单条/全部机器码；按测试导出 Logisim ROM HEX。

### 逐周期轨迹

- 每周期 8 个顶层信号，E/A 两行；缺失 expected 显示“—”，未采样/未知/错误不显示为 0。
- 首个不一致的 signal/cycle 对应单元格高亮；可只看差异、跳转第 N 周期、上一页/下一页（每页 200）。
- 点击周期行定位到 `staticIndex` 对应的静态汇编行；循环指令可以对应多个动态周期。
- 写使能为 0 时地址/数据未进入比较，服务返回 unsampled，UI 显示“未采样”，不误报。
- 数值格式：全局默认 + 每个信号局部覆盖；无符号/有符号十进制、十六进制、二进制；按位宽补零、符号扩展、截断，仅影响展示。

## 4. Logisim HEX

`packages/mips-core/src/rom/hex.ts` 实现：

```text
v2.0 raw
34080005 01095020 ...
```

- 文件头与 Logisim 2.7.1 `HexFile` 一致；从 ROM index 0 开始，`startIndex` 之前的字写零，Logisim 导入时补齐余下 ROM。
- 支持 `#` 注释和 `n*value` 运行长度解析。
- 自动化测试包含 TS 往返和 Java Bridge `parseHex` → 原版 `HexFile.parse` 的真实解析验证。
- ROM index 0 对应课程 PC `0x3000`；导出使用报告的 `romStartIndex`。

## 5. 长周期与差分

- Runner 在时钟沿前批量读取 8 个输出，沿后读取 PC；每 64 周期用一次 `bridge.batch` 发送 `readOutputs + clock + getOutput` 序列，避免每周期多次 RPC。
- 进度事件在 Runner 内逐周期产生，但服务层按 150ms/每 32 周期节流到 IPC。
- `maxCycles` 是执行上限：达到时状态为 error + `cycle-limit`，消息明确“不是 CPU mismatch”；不判 PASS，也不把截断当作 CPU 错误。
- 手动取消保留 cancelled；Bridge timeout 保留 timeout；正常 PASS、FAIL、ERROR 分开。
- `steps` 精确动态周期；`stopPc` 仍支持。

## 6. Stress 生成

`packages/test-generator/src/stress.ts`：

- 模板：循环求和、嵌套循环、循环 store/load、负偏移非零基址、全 GRF+$zero、地址 walk、RAW 链、长距离前向分支、固定 seed 32 位混合程序。
- 档位 Quick/Standard/Stress 控制循环次数、nested 规模、RAW 长度、分支填充、seed 数。
- 每个程序由参考解释器实际执行，自动得到精确动态周期和最终逻辑 DM signature；生成时校验所有指令/分支/地址只使用七指令和合法范围。
- Stress Quick 9 例、Standard 12 例、Stress 16 例；Stress 的 loop-sum 超过 10k 动态周期，静态程序仍远小于 ROM 4096 指令。

## 7. 覆盖率

Runner 从真实参考 trace 计算 `CoverageSummary`：

- 每条指令动态执行次数；
- 寄存器写/读集合；
- sll shamt 集合；
- beq taken/not-taken；
- lw/sw 次数、offset 0/正/负、非零基址；
- 静态指令总数/动态执行总数。

`RunSummary.coverage` 聚合所有结果；结果窗口显示覆盖率并明确来自真实执行记录，不以测试数量代替覆盖率。

## 8. 兼容

- 旧历史报告仍可打开；缺失 `instructions` 时服务尝试按汇编重建，缺失 `signalCheckpoints` 时轨迹显示未采样。
- 旧报告 `complete`、物理 RAM legacy 字段不伪造；结果窗口不展示物理 RAM。
- 主窗口/CLI/黑盒测试核心保持原有接口；新增接口向后兼容。
