# Phase 2 Step A — 仓库检查与接口兼容性

日期：2026-10-30。环境：Windows 11、Temurin OpenJDK **25.0.4.1**、Node.js **24.16.0**、npm **11.13.0**。Logisim 内核为仓库内固定的官方原版 **2.7.1** JAR（`vendor/logisim-generic-2.7.1.jar`）。

## 第一阶段基线

在修改任何代码前实际运行：

```sh
npm test
```

结果：退出码 **0**，POC 的 Adder/Hierarchy/Register 检查通过，Node 测试 **8 tests / 8 pass / 0 fail / 0 skip**，耗时约 11.1 秒。原始记录保存在 `test-results/phase1-baseline.txt`（本地运行产物）并摘录于 [validation.md](validation.md)。

第一阶段实际可用的能力：

| 能力 | 状态 |
|---|---|
| 加载 `.circ`、选择任意命名根电路 | 可用 |
| 根电路 Pin 的宽度/方向/坐标标识 | 可用 |
| `setInput`、`propagate`、`getOutput` | 可用 |
| `tick` 驱动一位时钟 Pin 的上升/下降沿 | 可用 |
| `reset` 新建 CircuitState | 可用 |
| 层级子电路 | 可用 |
| 未知/错误位、振荡、batch、超时、进程异常 | 可用并已有回归测试 |
| ROM 注入 / RAM 读 / RAM 写 / Register 读 | **第一阶段没有** |
| PC 观测 | **第一阶段没有** |

第一阶段 README、`docs/protocol.md`、`docs/logisim-internals.md` 和 `tests/bridge.test.ts` 是接口事实来源。仓库中没有完整的课程 CPU `.circ`，只有 Adder、Hierarchy、Register、Oscillator、LogicValues 等小电路。

## 接口差异与最小修改

原始 Phase 2 规划假定 Bridge 能直接注入 ROM、读取 RAM、观测 PC。实际 Phase 1 API 只有 Pin 级操作，因此做了以下**最小**扩展：

1. `inspectComponents`：按稳定路径列出根/层级组件，供唯一 ROM/Register 诊断；黑盒 Runner 不寻找 RAM。
2. `readMemory` / `writeMemory` / `loadRom`：复用原版 `MemContents`，不另造内存模型。黑盒流程只用 `loadRom` 和 ROM 回读；不读取/写入数据 RAM。
3. `readRegister` / `writeRegister`：复用原版 `RegisterData`；课程 Profile 用顶层 `pc` 输出，不再依赖物理 RAM。
4. `clockCycle` / `readOutputs`：驱动内部 Clock 并在时钟沿前批量采样顶层输出。
5. `java-bridge/src/main/java/com/cburch/logisim/std/memory/BridgeMemory.java`：因 `Mem/MemContents/RegisterData` 是包私有，适配类编译进同一 Java 包名直接调用；**未反射、未修改 JAR、未 fork Logisim**。
6. 发现并处理原版 ROM XML 读取器在缺少 `contents` 属性时安装 8×8 默认内容的怪癖；适配层按 `addrWidth/dataWidth` 归一化，并在 fixture 中显式写 `contents` 头。

所有扩展都有回归测试：`tests/bridge/memory.test.ts`（真实 Logisim `fixtures/memory.circ`）和 `tests/e2e/cpu.test.ts`（真实 CPU）。黑盒测试还使用代理 Bridge 断言 `readMemory` 只访问唯一 ROM。没有用一个 mock 代替未实现的 Bridge 功能来声称端到端通过。

## 真实 CPU fixture

仓库原本没有完整 CPU `.circ`。为了让差分流程得到真实 Logisim 验证，新增 `scripts/generate-cpu-fixture.mjs`，用原版内置组件生成：

- `fixtures/cpu.circ`：单周期 32 位 MIPS 子集 CPU，32 个真实 `Register` 组成寄存器堆，8×32 指令 ROM，8×32 数据 RAM，真实 ALU/移位/比较/多路选择/控制门，并暴露标准 8 个顶层输出；共 788 个组件。所有组合逻辑和状态仍由原版 Logisim 执行。
- `fixtures/cpu.config.json`：由生成器同步写出的 `CpuConfig`，`ram` 只有逻辑基址/容量。
- `fixtures/cpu-faulty.circ`：受控故障版本（`sll` 移位数恒为 0），用于验证差分检出。
- `fixtures/cpu-dead.circ`：受控“PC 不使能”版本，用于验证不会把未执行 CPU 判为 PASS。
- `fixtures/course-multi-ram.circ`：课程 CPU 加 3 个未使用物理 RAM，验证任意 RAM 数量不会导致拒绝。

生成器是一个 fixture 生成脚本，不是通用电路 IR；产物是普通、可用 Logisim GUI 打开的原版 `.circ`。详细运行记录见 [phase2-validation.md](phase2-validation.md)。

## 未验证/限制

- Linux、JDK 17 仅保留 CI 配置，本次仍没有实机结果；不能声称已验证。
- 没有验证除 2.7.1 之外的原版版本、evolution、第三方插件库或外部工程库。
- Phase 2 未验证自动 `Clock`；Phase 3 已增加课程 CPU 的内部 Clock 路径（`clockCycle`），但仍未验证门控/多相时钟、流水线、多周期存储器、异常/中断。单周期、每周期一条指令的前提不变。
- Phase 3 提供 Electron GUI；仍未实现 AI 模块识别、子模块单元测试、通用电路 IR、电路编辑器、波形查看器或自动程序最小化。
- 物理 RAM 不再是测试依据；无法通过 `ram.initial` 预置 DM，必须用 `sw` 初始化。非空旧字段会明确报错。
