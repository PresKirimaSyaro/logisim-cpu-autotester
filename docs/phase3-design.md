# Phase 3 设计 — 桌面 GUI

## 1. 架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron Renderer (React + TypeScript, sandboxed)           │
│  工作台 / 汇编编辑器 / 测试历史 / 设置                       │
│  只通过 preload 暴露的 window.cpuTester 调用 typed IPC       │
└───────────────────────────┬─────────────────────────────────┘
                            │ ipcRenderer.invoke / 事件
┌───────────────────────────▼─────────────────────────────────┐
│ Electron Main (Node.js)                                     │
│  - 文件对话框、窗口、安全策略                                │
│  - TesterService（不依赖 Electron，可独立测试）              │
│      ├─ 加载/校验课程 CPU Profile                            │
│      ├─ 调用现有 assembler / generator / runner              │
│      ├─ 启动 Java Bridge 子进程                              │
│      └─ 设置 / 历史 JSON 持久化                              │
└───────────────────────────┬─────────────────────────────────┘
                            │ 现有 JSON Lines / child_process
┌───────────────────────────▼─────────────────────────────────┐
│ 原版 Logisim 2.7.1 JAR + Phase 2 差分引擎                   │
└─────────────────────────────────────────────────────────────┘
```

Renderer 中没有任何 `child_process`、`fs`、Java 调用或路径拼接；`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。preload 是 CommonJS，只暴露固定的方法，不暴露任意 `ipcRenderer` channel。

## 2. IPC 契约

共享类型在 `packages/desktop-ipc/src/index.ts`：

- `DesktopApi`：`getState`、`updateSettings`、`chooseCircuit`、`inspectCircuit`、`chooseConfig`、`loadConfig`、`saveConfig`、`chooseAsm`、`saveAsm`、`chooseReportPath`、`exportReport`、`run`、`stop`、`listHistory`、`getHistory`、`rerun`、`assemble`、`getLogs`、`onRunUpdate`、`onStateUpdate`。
- `RunUpdate`：`started`、`progress`、`test-result`、`finished`、`stopped`、`error`、`state`。
- `AppState` / `CircuitProfile` / `HistoryMeta` / `HistoryRecord` / `RunRequest` / `AssembleResult`。

每个 channel 常量为 `IPC` 对象；main 只注册这些 handler。Renderer 不能传入 channel 名称。

## 3. 测试服务

`packages/desktop-service/src/index.ts` 的 `TesterService` 完全不依赖 Electron，可由 Node 测试直接实例化。

- `loadCircuit(path)`：启动临时 Bridge，加载顶层电路 `main`，`inspect` 根 Pin 和组件树，构建并校验课程 Profile；失败返回结构化错误，不生成假配置。
- `loadConfig/saveConfig`：严格走现有 `parseCpuConfig`；配置保存到 JSON。
- `assembleSource`：复用现有 `tryAssemble`。
- `startRun`：构造内置测试集、自定义汇编或历史重跑；启动真实 `LogisimBridge`，用 `DifferentialRunner` 执行。
- `stop`：`AbortController` + `bridge.terminate()`，等待运行 promise 收尾；不会把未完成运行标为 PASS。
- `listHistory/getHistory/exportHistory`：本地 `userData/logisim-cpu-tester/history` 下的 JSON 报告；meta 文件用于快速列表。
- 设置保存到 `userData/logisim-cpu-tester/settings.json`。
- 日志保留 Bridge stderr 和服务事件，最多 500 行。

Bridge 只在 main 进程中启动；Renderer 不接触 Java。

## 4. 课程 CPU Profile

默认 Profile 对应题目固定规范：

- 顶层电路 `main`
- 唯一外部输入 `reset`（1 bit，高有效）
- 内部 Logisim `Clock`（Bridge `clockCycle` 驱动）
- 顶层输出：`Instr` 32、`pc` 32、`RegWrite` 1、`RegAddr` 5、`RegData` 32、`MemWrite` 1、`MemAddr` 32、`MemData` 32
- ROM 4096×32，索引 `(PC - 0x3000) >>> 2`，PC 初值 `0x3000`
- 逻辑 DM 3072 字，MIPS 地址 `0x0000..0x2FFF`，字索引 `address >>> 2`。它只存在于参考模型，不是物理 RAM 组件。

`buildCourseProfile` 只校验端口方向/位宽、Clock 数量和唯一指令 ROM；**不检查 RAM 数量/形状**。电路可以有 0 个、1 个或多个物理 RAM。若有多余 RAM，测试服务不会读取或比较它们。

fixture 实现细节：ROM 索引使用 `PC - 0x3000` 后再取 `[13:2]`；数据 RAM 地址取 ALU 字节地址的 `[13:2]`；PC/寄存器堆的时钟经过两级 NOT 门的轻微延迟，使数据 RAM 在同一上升沿先采到稳定的写使能/地址/数据，再让 PC 更新指令。这个延迟只是生成 fixture 的确定性措施，不是测试工具对用户 CPU 的要求。

### 内部时钟

Phase 2 只有外部 `tick(port)`。Phase 3 在 Java Bridge 增加 `clockCycle`：调用原版 `Propagator.tick()` 两次并每次 propagate。两次半周期必然包含一个上升沿和一个下降沿，因此每个 `clockCycle` 恰好一条上升沿指令；不依赖墙钟或自动计时。没有内部 Clock 时返回 `NO_INTERNAL_CLOCK`。

### 逐周期比较（黑盒）

所有配置都必须提供 `outputs`。Runner 不再读取 DM：

1. 每个周期开始读取 8 个顶层输出（`Instr/pc/RegWrite/RegAddr/RegData/MemWrite/MemAddr/MemData`）。
2. 与参考解释器该步的 `pcBefore`、机器码、寄存器写事件、存储器写事件比较；只在对应使能为 1 时比较地址/数据。
3. 对 `$zero` 的无效果写回，允许 `RegWrite=0` 或 `RegWrite=1/RegAddr=0`；写到非零寄存器会报错。
4. 执行一个时钟沿（内部 Clock 用 `clockCycle`，外部 Clock 用 `tick`），读取 `pc`，与参考 `pcAfter` 比较。
5. 首个不一致记录 `firstSignalMismatch`（信号、周期、期望/实际）或 `pc.firstDivergence`，停止并报告；没有“最终 RAM 兜底”。

采样时刻固定为**时钟沿前**；沿后只检查 PC。报告会明确写出这一点。

## 5. UI 结构

左侧导航 + 顶部工具栏 + 主内容区。四个页面按实际需要实现，不做空壳：

### 测试工作台（默认）

- 当前 `.circ` 路径、顶层电路、内部 Clock 数量、唯一指令 ROM、逻辑 DM 容量、端口列表、Profile warning。
- 内置测试集 / 自定义汇编切换；开始、停止。
- 实时进度、完成数、通过/失败/错误、耗时、当前周期。
- 结果表；点击用例显示详情：汇编、机器码、寄存器写回/存储器写入事件、首个信号/PC 不一致、逐周期信号检查点、Bridge 日志。不展示任何物理 RAM 内容。
- 未加载/未运行时显示空状态，不显示 PASS。

### 汇编编辑器

- 带行号、透明 textarea + 高亮层的 MIPS 语法高亮（注释、助记符、寄存器、数字、标签）。
- 汇编按钮、机器码/符号表、行/列诊断。
- 导入/导出 `.asm`（主进程文件对话框）。
- 指定周期数或 stop PC 后运行真实测试；运行切回工作台查看进度。

### 测试历史

- 服务端保存的本地记录列表（meta）。
- 选择后加载完整报告；显示 totals、用例表、详情。
- 导出 JSON；重跑全部/失败用例。

### 设置

- Java 路径、Bridge 超时、最大周期、主题。
- 默认电路/配置路径与浏览。
- CPU/ROM/逻辑 DM 字段编辑并保存配置（仍经过 Schema 校验；不包含物理 RAM 路径）。
- 当前 Bridge 状态、服务/Bridge 日志。

## 6. 构建与启动

```sh
npm ci
npm run gui
```

`build:gui` = Java Bridge 编译 + 现有 TypeScript + Electron main/preload + Vite Renderer，产物：

- `dist/electron/apps/desktop/main.js`
- `dist/electron/apps/desktop/preload.cjs`
- `dist/renderer/index.html` + assets

`scripts/launch-gui.mjs` 使用 Electron 包解析出的二进制启动；它移除部分环境里继承的 `ELECTRON_RUN_AS_NODE`，否则 Electron 会以纯 Node 模式运行而无法开窗。

`npm run gui:smoke` 使用真实课程 CPU 跑 basic 套件、真实故障 CPU 跑 alu 套件，并截取工作台/历史/编辑器/设置/失败详情页面到 `test-results/`。

## 7. 安全与持久化

- 文件选择由 main 的 `dialog` 完成；服务再次校验扩展名、文件存在。
- 用户输入（配置、汇编、设置）都在服务层校验；不会在 Renderer 中执行 shell。
- 禁止新窗口；外部导航被阻止；CSP 限制 script/style。
- 设置和历史只在 `app.getPath('userData')` 下，不写仓库文件。
- 不读取或修改用户原始 `.circ`；ROM 注入仍是 JVM 内存副本。

## 8. 本阶段范围外

不实现 AI 识别、通用 Circuit IR、子模块测试、电路编辑器、完整波形查看器、高级随机策略、自动失败缩减和 Electron 打包安装器。界面中也没有为这些功能放置假按钮。
