# Phase 2 实际运行记录

> 本文是 Phase 2 的历史 **57 项**测试记录。Phase 3 扩展到 **63 项**并新增课程 CPU/GUI 验证，见 [phase3-validation.md](phase3-validation.md)。

日期：2026-10-30。环境：Windows、Temurin OpenJDK **25.0.4.1**、Node.js **24.16.0**、npm **11.13.0**。Logisim 内核为仓库内固定的官方原版 **2.7.1** JAR。没有 mock 替代 Logisim；CPU/内存/寄存器都由原版内核执行。

## 1. 基线

```sh
npm test
```

修改前 Phase 1：退出码 0，Node 测试 **8/8 pass**，POC 的 Adder/Hierarchy/Register 检查通过。详见 [compatibility.md](compatibility.md) 与 [validation.md](validation.md)。

## 2. 最终完整测试

```sh
npm test
```

结果：退出码 **0**，**57 tests / 57 pass / 0 fail / 0 skipped，约 11.42 秒**。完整原始输出：[phase2-test-run.txt](phase2-test-run.txt)。

| 测试组 | 数量 | 内容 |
|---|---:|---|
| Phase 1 Bridge | 8 | 真实 Logisim 加法器/层级/寄存器/振荡/进程异常/JSON Lines |
| Assembler | 8 | 七指令黄金机器码、字段、标签、范围、诊断 |
| Reference interpreter | 13 | 解码、PC、add/sub 模运算、ori/sll、lw/sw、$zero、分支、地址映射、trace |
| Config | 7 | 严格 schema、容量/位宽、初始 RAM、compare ranges、PC/reset |
| Generator | 3 | 43 例全部参考执行/步数/signature、suite 选择、layout |
| Bridge memory | 6 | 真实 ROM/RAM/Register、层级发现、32 位 ROM 注入、错误码 |
| Real CPU E2E | 7 | 43/43 全 PASS、故障 CPU、死 CPU、`pc.mode=none`、state reset + PC pin、Bridge 失败、防虚假通过 |
| CLI | 5 | `--asm`、partial range、失败退出码、错误退出码、`--list` |

Gradle 入口也实际运行：

```powershell
.\java-bridge\gradlew.bat --no-daemon build poc
```

结果：**BUILD SUCCESSFUL**，POC 的 Adder/Hierarchy/Register 检查全部通过；原始输出：[phase2-gradle.txt](phase2-gradle.txt)。`build-java.mjs` 递归编译 `bridge` 与原版包名下的 `BridgeMemory` 适配类；两条构建路径使用同一源码。

## 3. 真实 CPU 全套差分

```sh
npm run test:cpu -- \
  --circuit fixtures/cpu.circ \
  --config fixtures/cpu.config.json \
  --suite full \
  --report test-results/final-full.json
```

结果：**43 total / 43 pass / 0 fail / 0 error / 0 skipped**，退出码 **0**。完整终端输出：[phase2-cli-full.txt](phase2-cli-full.txt)。

覆盖的实际指令/行为：

- add/sub：0+0、普通、32 位回绕、下溢、符号位、rd=rs=rt、`$zero` 参与、连续依赖。
- ori：0、0xffff、零扩展、保高 16 位、同寄存器、负数、最高位。
- sll：shamt 0/1/15/16/30/31、移出高位、同寄存器、目标 `$zero`、依赖。
- lw/sw：写后读、多地址、覆盖、负偏移、非零基址、已知初始 RAM、最后字边界、store→load、load→use。
- beq：taken/not-taken、offset 0、正/负偏移、循环、连续分支、依赖、`$zero==$zero`。
- mixed：七条指令混合。

每例都执行了 ROM 回读校验、完整 256 字 RAM 初始化回读、逐周期 PC 比较和完整 256 字 RAM 比较（`comparisonScope: full`），全部 0 difference。

## 4. 故障检出

受控故障 CPU `fixtures/cpu-faulty.circ` 把 `sll` 的 shamt 恒接 0；原 CPU 文件未修改。

```sh
npm run test:cpu -- \
  --circuit fixtures/cpu-faulty.circ \
  --config fixtures/cpu.config.json \
  --suite alu \
  --report test-results/final-faulty.json
```

结果：**25 total / 14 pass / 11 fail / 0 error**，退出码 **1**。完整终端输出：[phase2-cli-faulty.txt](phase2-cli-faulty.txt)。

典型失败：

```text
FAIL sll-15  RAM mismatch at byte 0x100: expected 0x2B3C0000, actual 0x0000567C
FAIL sll-30  RAM mismatch at byte 0x100: expected 0xC0000000, actual 0x00000003
FAIL add-wrap-32  RAM mismatch at byte 0x100: expected 0x00000000, actual 0x00010000
```

由于多个测试使用 `ori` + `sll` 构造 32 位常量，故障也影响了这些常量路径；这正是真实差分应有的传播效果。报告包含 first difference 的字节地址、word index、expected/actual 和 actual RAM。

## 5. 死 CPU 与防虚假通过

受控死 CPU `fixtures/cpu-dead.circ` 把 PC Register 的 EN 恒接 0；CPU 永远停留在 PC=0。

```sh
npm run test:cpu -- \
  --circuit fixtures/cpu-dead.circ \
  --config fixtures/cpu.config.json \
  --suite basic \
  --report test-results/final-dead.json
```

结果：**37 total / 0 pass / 37 fail / 0 error**，退出码 **1**。完整终端输出：[phase2-cli-dead.txt](phase2-cli-dead.txt)。

典型失败：

```text
FAIL add-basic  PC diverged at cycle 1: expected 0x00000004, actual 0x00000000
```

逐周期 PC 检查点把错误定位到第 1 个周期，而不是只报告最终 RAM。`tests/e2e/cpu.test.ts` 还验证了 `pc.mode=none` 时（只比较 RAM）死 CPU 仍因 RAM 差异失败，以及空程序/无 RAM 变化程序被 `observability`/`assembly` 拒绝。

## 6. JSON 报告形状（节选）

完整报告由 CLI 写入 `--report` 路径；以下是 PASS/FAIL 的关键字段（省略完整 RAM 数组）：

```json
{
  "schemaVersion": 2,
  "circuitPath": ".../fixtures/cpu.circ",
  "configName": "generated-single-cycle-mips",
  "totals": {"total": 43, "passed": 43, "failed": 0, "errors": 0, "skipped": 0},
  "results": [
    {
      "id": "add-basic",
      "status": "pass",
      "machineCode": ["0x34080005", "0x34090007", "0x01095020", "0xAC0A0100"],
      "stepsRequested": 4,
      "stepsExecuted": 4,
      "cyclesRequested": 4,
      "cyclesCompleted": 4,
      "comparedRanges": [{"startByteAddress": 0, "words": 256, "kind": "full"}],
      "comparisonScope": "full",
      "differenceCount": 0,
      "romReadbackVerified": true,
      "ramInitVerified": true,
      "pc": {"mode": "register", "expectedFinal": "0x00000010", "actualFinal": "0x00000010", "finalMatch": true}
    },
    {
      "id": "sll-15",
      "status": "fail",
      "errorType": "ram-mismatch",
      "firstDifference": {
        "byteAddress": 256,
        "wordIndex": 64,
        "expected": "0x2B3C0000",
        "actual": "0x0000567C"
      },
      "differenceCount": 1,
      "pc": {"mode": "register", "expectedFinal": "0x00000014", "actualFinal": "0x00000014", "finalMatch": true}
    }
  ]
}
```

实际 JSON 还包含 assembly、initial/expected/actual RAM 每个字、signature、bridgeErrors、耗时和可选 trace。

## 7. CLI 退出码

| 场景 | 退出码 |
|---|---:|
| 43/43 PASS | 0 |
| 故障 CPU（有 RAM mismatch） | 1 |
| 死 CPU（有失败） | 1 |
| 空汇编 | 2 |
| 非法配置 | 2 |

CLI 输出同时写 JSON 报告；`--json` 时 stdout 为完整 JSON，进度写 stderr。

## 8. 真实 Bridge 内存测试

`tests/bridge/memory.test.ts` 使用 `fixtures/memory.circ`（真实 ROM/RAM/Register）验证：

- `inspectComponents` 路径、位宽、容量。
- 32 位 ROM 注入/回读（`0xDEADBEEF`、`0xFFFFFFFF` 等）。
- RAM `writeMemory`/`readMemory`，以及通过真实 Logisim RAM 的输出 Pin 读取。
- Register `writeRegister`/`readRegister`/时钟沿写入。
- 错误码：`NOT_RAM`、`NOT_ROM`、`NOT_MEMORY`、`NOT_REGISTER`、`MEMORY_RANGE`。

## 9. 关键设计验证点

- 参考解释器从机器码解码，不是执行汇编 AST。
- 汇编器与解码器测试使用独立的固定机器码黄金向量与位字段检查。
- ROM 注入后回读、RAM 初始化后全量回读。
- 比较完整 RAM，而不是只比较参考程序写过的地址。
- PC 可观测时逐周期比较；PC 首个偏离周期可报告。
- `$zero` 写忽略、ori 零扩展、lw/sw 符号扩展、add/sub 模 2^32、beq 无延迟槽，都有纯 TS 测试和真实 CPU 测试。
- 地址映射由 `CpuConfig`/`AddressMap` 显式表达；组件实际位宽/容量与配置不一致时在运行前报错。
- 没有把未实现的 Bridge 功能换成 mock 后声称 E2E；新增的内存/寄存器操作有真实 Logisim 回归测试。

## 10. 未验证范围与已知限制

- **Linux / JDK 17 实机**：没有本次本机运行记录；只保留 CI 配置，不能声称已验证。
- **其他 Logisim 版本 / evolution / 第三方插件库 / 外部工程库**：未验证。
- **自动 Clock、流水线、多周期存储器、异常/中断**：不在本阶段范围；单周期每 tick 一条指令的前提不满足时会失败。
- **PC 观测**：配置可关闭；关闭时只能比较最终 RAM，不能定位第一条错误指令。
- **部分比较**：`--range`/`compare.ranges` 可能排除真实错误地址；报告会标注 `partial`，不会声称全 RAM 通过。
- **ROM 注入**：只改 JVM 内属性副本，不写回 `.circ`；下一次 `load` 从磁盘重新读取。
- **CPU fixture**：由内置组件生成的真实电路，但不是用户的课程 CPU；真实课程 CPU 需要按其组件路径填写配置。生成器路径由 `fixtures/cpu.config.json` 自动导出。
- **报告定位粒度**：逐周期 PC + 最终 RAM 只能定位到周期/内存差异；没有内部信号 trace 时不能定位到具体内部线网。
- 未实现 GUI、AI 模块识别、通用电路 IR、约束随机生成、自动失败最小化。

## 11. 复现

```sh
npm ci
npm test
npm run test:cpu -- --circuit fixtures/cpu.circ --config fixtures/cpu.config.json --suite full
npm run test:cpu -- --circuit fixtures/cpu-faulty.circ --config fixtures/cpu.config.json --suite alu
npm run test:cpu -- --circuit fixtures/cpu-dead.circ --config fixtures/cpu.config.json --suite basic
```

原始完整输出：[phase2-test-run.txt](phase2-test-run.txt)、[phase2-cli-full.txt](phase2-cli-full.txt)、[phase2-cli-faulty.txt](phase2-cli-faulty.txt)、[phase2-cli-dead.txt](phase2-cli-dead.txt)。
