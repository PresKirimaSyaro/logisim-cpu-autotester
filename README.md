# Logisim CPU Autotester — Phase 6

面向 **Carl Burch 原版 Logisim 2.7.1** 的单周期 MIPS 子集差分测试工具，包含可配置指令集、`lui`/`j`/`nop`、独立结果窗口、NextPC/符号扩展强测、外部测试程序集和 Windows 便携版。

输入 `.circ` 和 MIPS 汇编后，程序被编译为机器码，同时送入纯 TypeScript 参考解释器和真实 Logisim CPU。测试是**黑盒差分**：在时钟沿前采样顶层 `Instr`、`pc`、寄存器写回、存储器写事件，在时钟沿后检查 `pc`；完全不扫描、读取、写入或比较 CPU 内部的物理 RAM。逻辑 DM 只存在于参考模型和测试生成器中。

当前状态（2026-10-31，Windows，Temurin JDK 25.0.4.1，Node 24.16.0，Electron 45.2.1）：

- `npm test`：**96 tests / 96 pass / 0 fail**，包含真实 Bridge、LUI/J/NOP、动态指令集过滤、NextPC 故障 CPU、六类参考故障注入、外部测试集加载、Stress 栈/循环、结果报告分页、HEX 导入往返、CLI 和 Electron-free 测试服务。
- 默认课程指令集（`add,sub,ori,lw,sw,beq,lui,nop`）：**47/47 PASS**；全十指令可选项：**65/65 PASS**。
- 课程 Profile CPU（`main`、内部 Clock、0x3000 ROM、逻辑 DM 3072 字、标准观测输出）：默认 basic **37/37**、默认 alu **20/20**。
- Phase 2 外部时钟 CPU（七指令 + nop）：**56/56 PASS**。
- 包含 3 个额外物理 RAM 组件的课程 CPU：默认指令集 **47/47 PASS**。
- Stress Quick：**11/11 PASS**；Stress 全档位：**18/18 PASS**，含 10,242 周期 loop、14,339 周期间栈保存/恢复、全 GRF 和固定 seed 程序。
- `sw` NextPC 故障 CPU：在生成测试的 **cycle 3** 报 PC 偏离（期望 `0x300C`，实际 `0x2FFC`），不是 PASS。
- 六类受控参考故障注入（sw NextPC、lw/sw 零扩展、beq 负偏移、ori 符号扩展、lui 高位、add/sub 最高位）均产生 FAIL 和首个可观察差异。
- GUI smoke 实际启动 Electron，验证默认 8 条/可选 sll/j 切换、运行 basic、Stress Quick 和故障 CPU，并截取独立结果窗口。
- **外部测试程序集**：运行时从 `test-suites/course.json` 读取 65 条定向测试；修改 JSON 后下一次运行立即生效，无需重新编译。
- **Windows 便携版**：`npm run dist:win` 生成 `release/Logisim CPU Tester/Logisim CPU Tester.exe`，双击即可启动；包含 Electron、Java Bridge、Logisim JAR、fixtures、外部测试集和 jlink Java runtime（可用时）。
- 验证记录：[docs/phase6-validation.md](docs/phase6-validation.md)、[docs/phase5-validation.md](docs/phase5-validation.md)、[docs/phase4-validation.md](docs/phase4-validation.md)。

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
npm run gui:smoke     # 真实课程 CPU + Stress + 故障 CPU + 结果窗口 smoke（生成截图）
npm run dist:win      # 构建 release/Logisim CPU Tester 便携版（双击 exe）
npm run build:gui     # 只构建 Java/TS/Electron/Renderer
npm run typecheck:gui
npm run test:asm      # 汇编器黄金向量/错误诊断
npm run test:isa      # 解码、寄存器、内存、分支、PC 语义
npm run test:unit     # 纯 TS 单元测试
npm run test:bridge   # 真实 Logisim 内存/寄存器 Bridge 测试
npm run test:e2e      # 真实 CPU 默认/可选指令集 + NextPC 故障 CPU + 多 RAM + 死 CPU
npm run test:cpu -- --help
```

## 桌面 GUI（Phase 3）

界面为左侧导航 + 顶部工具栏 + 主内容区：

- **测试工作台**：加载 `.circ`、配置/执行、实时进度、当前 PC/指令、通过/失败/错误；详细结果不堆在主窗口，完成后自动打开独立结果窗口。
- **汇编编辑器**：MIPS 语法高亮、行号、汇编、机器码/符号表、行列诊断、导入/导出 `.asm`、直接运行。
- **测试历史**：本地历史、按记录打开独立结果窗口、导出 JSON、重跑失败用例。
- **设置**：Java 路径、Bridge 超时、最大周期、主题、默认电路/配置、CPU/ROM/逻辑 DM 字段、Bridge 日志。界面不展示物理 RAM 数量或内容。

## 外部测试程序集（Phase 6）

定向测试不再由运行时硬编码生成。应用/CLI 每次开始测试都会读取：

```text
test-suites/course.json
```

- 65 条测试程序、精确 steps、signature、suite 标签和 RAM 需求都在 JSON 中。
- 修改/新增测试不需要 TypeScript 编译或重新打包；下一次运行即加载。
- 默认指令集过滤后 47 条，启用 `sll`/`j` 后 65 条。
- 自定义文件：`--suite-file my-suite.json`；示例见 `test-suites/example.json`。
- `signature.index` 相对 `signatureBase`（课程为 `0x100`），不是绝对地址。
- `requiredRamBytes` 防止把需要 3072 字 DM 的测试误用在 256 字 Phase 2 CPU。
- `npm run export:suite` 仅作为维护迁移工具，从旧生成器导出 JSON；硬编码 builder 已拆到不参与打包的 `builtin-directed.ts`，应用运行入口和便携包都不包含用例表。

Schema/编辑说明见 [test-suites/README.md](test-suites/README.md)。

## Windows 便携版（Phase 6）

```sh
npm run dist:win
```

生成：

```text
release/Logisim CPU Tester/Logisim CPU Tester.exe
release/Logisim-CPU-Tester-win-x64.zip  (190.5 MB)
```

便携目录约 414 MB；exe 可直接双击，启动后自动加载随包课程 CPU 和外部测试集。

双击 exe 启动，无需安装 Node/Electron。便携目录包含：

- Electron 运行时、Renderer、preload；
- `java-bridge/build/classes`、Logisim 2.7.1/Gson JAR；
- 课程 CPU fixtures；
- 可编辑的 `resources/app/test-suites/course.json`；
- 若系统有 `jlink`，还包含约 49 MB 的精简 Java runtime（`resources/app/runtime`），因此不要求机器预装 JDK；没有 jlink 时回退系统 Java/设置页选择。
- 用户历史/设置位于 `%APPDATA%\Logisim CPU Tester\logisim-cpu-tester`，不写入程序目录。

## 动态指令集与 LUI/J/NOP（Phase 5）

默认启用课程要求的八条指令：

```text
add, sub, ori, lw, sw, beq, lui, nop
```

`sll`、`j` 是可选扩展，默认不勾选。工作台“启用的指令集”复选框会在加载 `.circ` 后允许修改，并通过 settings 持久化；每次报告记录实际启用的集合。选择同时约束：

- 汇编器：手动汇编使用未启用指令会返回 `ASM_INSTRUCTION_DISABLED`，不会静默执行；
- 测试生成器：定向、seeded 和 Stress 程序只返回使用已启用指令的用例；
- 参考解释器：执行未启用指令产生 `INSTRUCTION_DISABLED`；
- 覆盖率与结果窗口：显示启用集合及每条指令的真实执行次数。

`lui` 的 opcode 为 `0x0F`，`GPR[rt] = (imm16 << 16) & 0xFFFFFFFF`；`j` 的 opcode 为 `0x02`，目标为 `{(PC+4)[31:28], instr_index, 2'b00}`，无延迟槽。`nop` 编码为 `0x00000000`，不写寄存器/内存，PC 正常 +4；因此启用 nop 不要求启用 sll。

## 独立测试结果窗口（Phase 4/5）

Electron `BrowserWindow` 独立窗口，可按报告 ID 同时打开多个、独立关闭和缩放，不影响主窗口或后台测试。数据来自 `userData` 下的持久化报告存储：

- 左侧用例列表：名称、静态指令数、动态/预期周期、PASS/FAIL/TIMEOUT/LIMIT/ERROR、首次差异周期和信号；默认失败优先并按首次差异周期排序，可按状态/静态指令数/动态周期/首次差异排序并只看失败。
- **汇编 / 机器码**：每条静态指令的 ROM 地址/PC、源文本、32 位机器码、R/I 字段；支持 HEX/完整二进制/分段二进制，复制单条/整段，导出 Logisim `v2.0 raw` HEX。
- **逐周期轨迹**：Cycle、PC、Instr、RegWrite/RegAddr/RegData、MemWrite/MemAddr/MemData 的 Expected/Actual；首个差异单元格高亮；只看差异；跳转周期；点击周期定位回静态汇编；循环程序的同一静态指令关联多个动态周期；写使能为 0 的地址/数据不参与比较；未知/错误/未采样保持原状态。
- 数值格式：全局默认、每个信号局部覆盖；无符号/有符号十进制、十六进制、二进制，按信号位宽补零/符号扩展。
- 长轨迹每页 200 个周期，支持跳页；不一次渲染数万行。
- 覆盖率面板来自参考执行记录：启用指令次数、GRF 读写、sll shamt、beq taken/not-taken 与前后向、lw/sw、正负/零 offset、非零基址、非分支 PC+4 合规数/违规数、负/高位/零结果、最长用例周期、静态/动态指令数。

## Stress / 强测套件

新增独立 `stress` 套件，不替代 basic/full：

```sh
npm run test:cpu -- --suite stress --intensity quick
npm run test:cpu -- --suite stress --intensity standard
npm run test:cpu -- --suite stress --intensity stress
```

- Quick / Standard / Stress 控制循环规模、随机 seed 数和长周期数量。
- 覆盖边界值、31 个 GRF 寄存器与 `$zero`、RAW 依赖、嵌套循环、循环访存、栈保存/恢复、连续正负 offset、负偏移/非零基址、长距离前向分支、固定 seed 的 32 位混合程序和条件分支。
- 支持数千至一万四千以上动态周期（Stress loop 10,242、stack walk 14,339）；执行在 64 周期批内采样，避免逐周期 IPC。
- 达到 `maxCycles` 记为 `cycle-limit`，不是 CPU 错误；手动停止记为取消；Bridge 超时保留 timeout。

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

`--suite` 可选 `basic`、`full`、`branch`、`memory`、`alu`、`stress`；`full` 是当前启用指令集下的全部定向测试（默认 47 例，十指令全开 65 例），`stress` 使用独立强测生成器。`--instructions add,sub,...` 可覆盖配置中的选择。

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
--max-cycles <n>            覆盖单次运行周期上限（达到时报告 cycle-limit）
--intensity <level>         stress: quick / standard / stress
--seed <n>                  stress 随机程序基种子
--seed-count <n>            覆盖 stress 的固定 seed 程序数量
--instructions <list>       逗号分隔的启用指令集，覆盖配置
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
  "limits": {"maxSteps": 200000, "maxCycles": 200000},
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

Phase 2 核心设计见 [docs/phase2-design.md](docs/phase2-design.md)，Phase 3 GUI 设计见 [docs/phase3-design.md](docs/phase3-design.md)，Phase 4 独立结果窗口/Stress 设计见 [docs/phase4-design.md](docs/phase4-design.md)，Phase 5 动态指令集与故障注入设计见 [docs/phase5-design.md](docs/phase5-design.md)，Phase 6 外部测试集/Windows 便携版设计见 [docs/phase6-design.md](docs/phase6-design.md)，黑盒 DM/物理 RAM 解耦见 [docs/blackbox-dm.md](docs/blackbox-dm.md)。

## 报告

每次运行写 JSON 报告，终端同时输出可读表格。JSON 包含：

- 测试 id/name/category、汇编源、机器码、静态指令列表、seed（定向测试为 null，seeded 测试带数值）。
- 步数/实际完成周期、静态指令数/动态指令数、时钟沿前采样说明。
- 覆盖率：指令执行次数、GRF 读写、sll shamt、beq taken/not-taken、lw/sw 与 offset 类型。
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
- 历史报告以单个 JSON 存储；Stress 全量报告可能较大，结果窗口已按元数据/单测试/200 周期分页读取，但报告文件本身不拆分。
- 课程逻辑 DM 仅 3072 字；`0x7FFF`/`0x8000`/`0xFFFF` 这类立即数只有形成合法地址时才会生成，无法在 0x0000..0x2FFF 内构造“高位 1 基址 + 负偏移”的合法访问。
- 六类故障注入测试使用受控参考 trace 变异（以及真实 `sw` NextPC 故障 CPU fixture），不修改用户原始 `.circ`。

完整验证记录：Phase 5 见 [docs/phase5-validation.md](docs/phase5-validation.md)，Phase 4 见 [docs/phase4-validation.md](docs/phase4-validation.md)，Phase 3 见 [docs/phase3-validation.md](docs/phase3-validation.md)，Phase 2 见 [docs/phase2-validation.md](docs/phase2-validation.md)。
