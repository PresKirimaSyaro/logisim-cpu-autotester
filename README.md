# Logisim CPU Autotester — Phase 3

面向 **Carl Burch 原版 Logisim 2.7.1** 的单周期 MIPS 子集差分测试工具，包含 Phase 2 的 CLI/差分核心和 Phase 3 的 Electron + React 桌面界面。

输入 `.circ` 和 MIPS 汇编后，程序被编译为机器码，同时送入纯 TypeScript 参考解释器和真实 Logisim CPU。测试是**黑盒差分**：在时钟沿前采样顶层 `Instr`、`pc`、寄存器写回、存储器写事件，在时钟沿后检查 `pc`；完全不扫描、读取、写入或比较 CPU 内部的物理 RAM。逻辑 DM 只存在于参考模型和测试生成器中。

当前状态（2026-10-31，Windows，Temurin JDK 25.0.4.1，Node 24.16.0，Electron 45.2.1）：

- `npm test`：**70 tests / 70 pass / 0 fail**，包含真实 Bridge、真实 CPU、课程 CPU、多物理 RAM、故障/死 CPU、CLI、Electron-free 测试服务和课程 Profile。
- 课程 Profile CPU（`main`、内部 Clock、0x3000 ROM、逻辑 DM 3072 字、标准观测输出）：**49/49 PASS**。
- Phase 2 外部时钟 CPU（新增标准输出后）：**49/49 PASS**。
- 包含 3 个额外物理 RAM 组件的课程 CPU：**49/49 PASS**，证明物理 RAM 数量不参与判定。
- 受控故障 CPU 检出 **12** 个失败；死 CPU 的 basic 套件 **39/39 失败**，PC 首个偏离周期为 1。
- GUI smoke 实际启动 Electron，通过界面按钮运行 basic（39 例）和自定义汇编，并截取工作台/历史/编辑器/设置/失败详情页面。
- 验证记录：[docs/phase3-validation.md](docs/phase3-validation.md)、[docs/blackbox-dm.md](docs/blackbox-dm.md)。

## 快速开始

```sh
npm ci
npm test
npm run gui
```

`npm test` 依次编译 Java Bridge（`javac --release 17`）、TypeScript、运行 Java POC，再运行全部 Node 测试。`npm run gui` 构建并启动 Electron 桌面应用。需要 JDK 17+、Node 22+。

常用入口：

```sh
npm run gui           # 构建并启动桌面 GUI
npm run gui:smoke     # 真实课程 CPU + 故障 CPU 的 GUI smoke（生成截图）
npm run build:gui     # 只构建 Java/TS/Electron/Renderer
npm run typecheck:gui
npm run test:asm      # 汇编器黄金向量/错误诊断
npm run test:isa      # 解码、寄存器、内存、分支、PC 语义
npm run test:unit     # 纯 TS 单元测试
npm run test:bridge   # 真实 Logisim 内存/寄存器 Bridge 测试
npm run test:e2e      # 真实 CPU 49 例 + 课程/多 RAM CPU + 故障/死 CPU + 防虚假通过
npm run test:cpu -- --help
```

## 桌面 GUI（Phase 3）

界面为左侧导航 + 顶部工具栏 + 主内容区：

- **测试工作台**：加载 `.circ`、显示课程 Profile/端口/Clock/逻辑 DM、内置测试集或自定义汇编、实时进度、当前 PC/指令、通过/失败/错误、耗时、用例表与失败详情。
- **汇编编辑器**：MIPS 语法高亮、行号、汇编、机器码/符号表、行列诊断、导入/导出 `.asm`、直接运行。
- **测试历史**：本地历史、完整报告、导出 JSON、重跑全部/失败用例。
- **设置**：Java 路径、Bridge 超时、最大周期、主题、默认电路/配置、CPU/ROM/逻辑 DM 字段、Bridge 日志。界面不展示物理 RAM 数量或内容。

Renderer 不启动 Java 进程；`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`，只通过 preload 暴露的类型化 IPC 调用 main 中的 `TesterService`。核心逻辑不依赖 Electron，`tests/desktop/service.test.ts` 直接测试同一服务。详细设计见 [docs/phase3-design.md](docs/phase3-design.md)。

课程固定 Profile（`fixtures/course.config.json`）：

- 顶层电路 `main`，唯一外部输入 `reset`，内部 Logisim `Clock`。
- 顶层输出 `Instr`、`pc`、`RegWrite`、`RegAddr`、`RegData`、`MemWrite`、`MemAddr`、`MemData`。
- ROM 4096×32，PC 初值 `0x3000`，ROM 索引 `(PC - 0x3000) >>> 2`。
- 逻辑 DM 3072×32，地址 `0x0000..0x2FFF`，字索引 `address >>> 2`。它只是参考模型的字节编址状态，不对应某个物理 RAM 组件。
- Java Bridge 使用内部时钟 `clockCycle`（原版 `Propagator.tick()`）和批量 `readOutputs`；Runner 在时钟沿前采样 8 个顶层输出、沿后检查 PC，并对寄存器/存储器写事件检查使能后比较地址和数据。若电路不满足该 Profile，界面会显示明确错误，不会伪造配置或 PASS。

## CLI

> CLI 保留，但物理 RAM 相关选项已移除。`--range`、`--initial-ram` 会明确报错；`--expect` 仅作为参考模型最终逻辑 DM 的交叉断言。

运行内置测试集：

```sh
npm run test:cpu -- \
  --circuit fixtures/cpu.circ \
  --config fixtures/cpu.config.json \
  --suite basic
```

`--suite` 可选 `basic`、`full`、`branch`、`memory`、`alu`；`full` 是全部 49 例。

运行手写汇编：

```sh
npm run test:cpu -- \
  --circuit fixtures/cpu.circ \
  --config fixtures/cpu.config.json \
  --asm tests/programs/basic.asm \
  --steps 4 \
  --expect 256=12
```

`--steps` 是精确动态指令数；也可用 `--stop-pc 0x...` 让参考解释器先跑到停止 PC，再驱动同样周期数。

其他选项：

```text
--expect <addr=value>       参考模型最终逻辑 DM 期望值（可重复；CPU 写事件逐周期比较）
--report <path>             JSON 报告路径（默认 test-results/report-<time>.json）
--trace                     在 JSON 报告中带参考执行轨迹
--json                      把完整 JSON 报告打印到 stdout
--list                      列出生成的测试，不启动 Bridge
--java <path>               指定 Java
--timeout <ms>              Bridge 请求超时
--max-cycles <n>            覆盖单次运行周期上限
```

退出码：`0` 全部 PASS；`1` 至少一个差分失败；`2` 汇编/配置/加载/初始化/仿真错误。

## 真实 CPU fixture

仓库原本没有完整课程 CPU `.circ`。`scripts/generate-cpu-fixture.mjs` 用原版 Logisim 内置组件生成真实单周期 CPU：

```sh
npm run generate:cpu
npm run generate:course
```

产物：

- [fixtures/cpu.circ](fixtures/cpu.circ)：Phase 2 外部时钟 CPU，788 个组件；32 个真实 `Register` 构成寄存器堆，8×32 指令 ROM，8×32 数据 RAM，真实 ALU/移位/比较/多路器/控制门，并暴露标准 8 个顶层输出。
- [fixtures/cpu.config.json](fixtures/cpu.config.json)：生成器同步写出的配置；`ram` 只有逻辑基址/容量。
- [fixtures/cpu-faulty.circ](fixtures/cpu-faulty.circ)：受控故障（`sll` shamt 恒 0）。
- [fixtures/cpu-dead.circ](fixtures/cpu-dead.circ)：受控死 CPU（PC 不使能）。
- [fixtures/course-cpu.circ](fixtures/course-cpu.circ)：课程 Profile，`main`、内部 Clock、4096×32 ROM（0x3000 起）、逻辑 DM 3072 字、标准 8 个观测输出，714 个组件。
- [fixtures/course.config.json](fixtures/course.config.json)：课程 Profile 配置（内部时钟、输出映射、逻辑 DM 3072 字）。
- [fixtures/course-faulty.circ](fixtures/course-faulty.circ)：课程 CPU 的受控 `sll` 故障，用于验证 GUI 失败详情。
- [fixtures/course-multi-ram.circ](fixtures/course-multi-ram.circ)：同一课程 CPU 加 3 个未使用的物理 RAM，用于验证“任意数量 RAM”不会影响测试。

生成器是 fixture 生成脚本，不是通用电路 IR，也没有替换 Logisim 仿真。CPU 中的每条指令、每个寄存器、ROM/RAM 都由原版 JAR 执行。Phase 2 CPU 还暴露若干只读调试输出 Pin（`INSTR`、`ALUOUT`、`TAKEN`、`OPCODE` 等），它们不参与逻辑；课程 Profile 只暴露规范要求的 8 个输出。已提供 `fixtures/memory.circ` 作为最小 ROM/RAM/Register Bridge fixture。

## CpuConfig

`fixtures/cpu.config.json` 是完整示例。关键点：

```json
{
  "schemaVersion": 1,
  "circuitName": "SingleCycleCPU",
  "clock": {"pin": "CLK", "edge": "rising"},
  "reset": {"strategy": "pin", "pin": "RST", "activeLow": false, "ticks": 1},
  "pc": {"mode": "pin", "port": "pc", "initial": 0, "checkEachCycle": true},
  "rom": {"path": "...", "baseByteAddress": 0, "addressBits": 8, "addressShift": 2, "dataBits": 32, "capacityWords": 256},
  "ram": {"baseByteAddress": 0, "capacityWords": 256},
  "limits": {"maxSteps": 10000, "maxCycles": 10000},
  "inputs": [],
  "outputs": {"instruction": "Instr", "pc": "pc", "regWrite": "RegWrite", "regAddr": "RegAddr",
              "regData": "RegData", "memWrite": "MemWrite", "memAddr": "MemAddr", "memData": "MemData"}
}
```

旧配置中的 `ram.path`、`ram.addressBits`、`ram.addressShift`、`ram.dataBits` 和 `compare` 会被接受但忽略，以方便迁移。非空 `ram.initial` 会明确报错：物理/逻辑 RAM 不再由测试工具注入，必须用 `sw` 初始化 DM。

课程 Profile 的配置形态（完整文件见 [fixtures/course.config.json](fixtures/course.config.json)）：

```json
{
  "circuitName": "main",
  "clock": {"mode": "internal", "halfCycles": 2},
  "reset": {"strategy": "pin", "pin": "reset", "activeLow": false, "ticks": 1},
  "pc": {"mode": "pin", "port": "pc", "initial": 12288, "checkEachCycle": true},
  "rom": {"baseByteAddress": 12288, "addressBits": 12, "addressShift": 2, "dataBits": 32, "capacityWords": 4096},
  "ram": {"baseByteAddress": 0, "capacityWords": 3072},
  "outputs": {
    "instruction": "Instr", "pc": "pc", "regWrite": "RegWrite", "regAddr": "RegAddr",
    "regData": "RegData", "memWrite": "MemWrite", "memAddr": "MemAddr", "memData": "MemData"
  }
}
```

逻辑 DM 的容量独立于任何物理地址位宽，Runner 也不会检查物理 RAM 容量。配置经过严格 Schema 验证；未知字段、ROM 位宽/容量、PC 越界、非空初始 RAM 都会报错。

内置定向测试用 `$zero` 加 16 位有符号偏移访问 signature/scratch，因此逻辑 DM base 高于 `0x7000` 时生成器会明确报错，而不是截断地址；手写汇编不受此限制。

### 地址空间

1. **MIPS 字节地址**：汇编标签、PC、`lw/sw` 有效地址。
2. **Logisim ROM 组件字索引**：仅指令 ROM 注入使用。
3. **逻辑 DM 索引**：参考模型内部按 4 字节字维护；不映射到任何物理 RAM。

```text
logical index = (byteAddress - baseByteAddress) >>> 2
```

任何物理 RAM 数量、位宽、层级和内容都不参与这个映射。`lw/sw` 仍要求 4 字节对齐。

## 流程与模块

```text
assembler (two passes)
      │ machine code
      ├──────────────► ReferenceInterpreter ──► expected pc / Instr / writes
      │                        ▲
      │                        │ same machine words
      └──────────────► Java Bridge ──► Logisim ROM + CPU top-level outputs
                                          │
                                          ▼
                               per-cycle signal comparator + report
```

```text
packages/
  mips-core/            ISA、assembler、decoder、interpreter、AddressMap、CpuConfig
  test-generator/       定向/全 GRF/32 种 sll/可重复 seed 测试 + 逻辑 DM signature
  differential-runner/  ROM 注入、时钟沿采样、PC/写回/访存信号比较、报告
  bridge-client/        JSON Lines 客户端 + 内存/寄存器/内部时钟扩展
  protocol/             共享协议类型
  desktop-ipc/          Renderer ↔ Main 的共享类型与 channel 常量
  desktop-service/      Electron-free 的 TesterService（设置/历史/运行/组装）
  cli/                  命令行入口
apps/
  desktop/              Electron main + preload（CJS preload，沙箱）
  renderer/             React + Vite 界面
tests/
  assembler/ interpreter/ config/ generator/ bridge/ e2e/ cli/ desktop/
```

Phase 2 核心设计见 [docs/phase2-design.md](docs/phase2-design.md)，Phase 3 GUI 设计见 [docs/phase3-design.md](docs/phase3-design.md)，黑盒 DM/物理 RAM 解耦见 [docs/blackbox-dm.md](docs/blackbox-dm.md)。

## 报告

每次运行写 JSON 报告，终端同时输出可读表格。JSON 包含：

- 测试 id/name/category、汇编源、机器码、seed（定向测试为 null，seeded 测试带数值）。
- 步数/实际完成周期、时钟沿前采样说明。
- 逐周期顶层信号检查点：`pc`、`instruction`、`RegWrite/RegAddr/RegData`、`MemWrite/MemAddr/MemData`。
- `firstSignalMismatch`（信号、周期、期望/实际）以及 PC 逐周期检查点/首个偏离。
- 参考模型可观察写入数量、时钟沿前采样说明。
- 错误类型、Bridge 错误/stderr、耗时。

报告不再包含物理 RAM 内容或“第一处 RAM 差异”；失败首行给出首个信号/周期，可直接对应到汇编和机器码。

## 防虚假通过

- 空汇编直接拒绝。
- 参考程序没有任何非 `$zero` 寄存器写或存储器写 → `observability` 错误，不进入 PASS。
- 只做 ROM 注入；Runner 不调用 `readMemory`，注入错误会由第 1 个周期的 `Instr` 比较发现。
- Bridge/clock/顶层输出读取失败一律 error，不输出 PASS。
- 内置 49 例每例至少一个非零逻辑 DM signature；signature 先与参考结果交叉校验。
- 所有 CPU 都从顶层 `Instr/pc/写回/访存` 信号比较；没有“最终 RAM 兜底”。
- 受控 dead CPU 在 basic 套件全失败；受控 faulty CPU 被检出并给出首个信号/周期。
- `$zero` 的无效果写回（RegWrite=1、RegAddr=0）被接受；写到非零寄存器会被判为错误。
- GUI 未加载电路、未运行或运行失败时只显示空状态/错误；不会构造 PASS。GUI smoke 使用真实课程 CPU、多 RAM 和真实故障 CPU，不使用 mock 结果。

## Bridge 扩展

Phase 1 的 JSON Lines 协议、Pin 级操作、层级子电路、batch、超时和真实 Logisim 内核保持不变。Phase 2 增加组件发现与内存/寄存器诊断；Phase 3 增加内部 Clock `clockCycle` 和批量 `readOutputs`。黑盒测试只使用 `loadRom` 和顶层输出；`readMemory`/`writeMemory` 仍作为底层诊断能力存在，但 Runner 完全不调用它们。`BridgeMemory` 适配类编译进原版包名访问包私有 `MemContents`/`RegisterData`；未修改 JAR。协议见 [docs/protocol.md](docs/protocol.md)，兼容性说明见 [docs/compatibility.md](docs/compatibility.md)。

## 已知限制

- 只支持七条指令；无异常/中断/流水线/halt。
- 单周期前提：每个 tick 必须恰好提交一条指令。
- 黑盒模式要求顶层 8 个观测输出；缺少输出时明确报错，不回退到物理 RAM。
- `lw/sw` 仍要求 4 字节对齐；逻辑 DM 初始化必须通过 `sw` 完成。
- ROM 注入只改 JVM 内属性副本，不写回 `.circ`。
- 未在 Linux/JDK 17 实机验证；仅保留 CI 配置。
- GUI 未做安装包/签名、完整波形查看器、电路编辑器、AI 识别、通用 Circuit IR 或自动失败缩减。

完整验证记录：Phase 3 见 [docs/phase3-validation.md](docs/phase3-validation.md)，Phase 2 见 [docs/phase2-validation.md](docs/phase2-validation.md)。
