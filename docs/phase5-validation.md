# Phase 5 实际运行记录

> 后续 Phase 6/7 将测试程序移到外部 JSON 并扩展到 165 条；本文保留 Phase 5 当时记录。

日期：2026-10-31。环境：Windows、Temurin OpenJDK **25.0.4.1**、Node.js **24.16.0**、Electron **45.2.1**、Logisim 原版 **2.7.1**。所有 CPU/GUI 结果来自真实 Java Bridge；故障注入测试使用受控参考 trace 或独立故障 CPU fixture，不修改用户 `.circ`。

## 1. 自动化测试

```sh
npm test
```

结果：退出码 **0**，**94 tests / 94 pass / 0 fail / 0 skipped，约 21.9 秒**。原始输出：[phase5-test-run.txt](phase5-test-run.txt)。

| 测试组 | 数量 | Phase 5 内容 |
|---|---:|---|
| Bridge | 8 | 原 Logisim 内核/层级/内存/寄存器 |
| Assembler | 9 | LUI/J/NOP 编码、禁用指令诊断 |
| Interpreter | 15 | LUI/J/NOP 语义、指令集执行限制 |
| Config | 8 | 默认八条、可选 sll/j、未知指令拒绝 |
| Generator | 6 | 默认/全指令过滤、NextPC、LUI、栈、seed、Stress |
| Bridge memory | 6 | 原诊断能力 |
| Real CPU E2E | 17 | 默认 47、全开 65、Phase2 56、NextPC 故障 CPU、Stress、未知值、死 CPU |
| Desktop service | 6 | 指令选择持久化、报告 instructions、分页、HEX、Stress |
| CLI | 7 | 原 CLI + Stress/coverage |
| Signal format | 3 | 32/5/1 位数值格式 |
| Logisim HEX | 3 | 原版解析往返 |
| Fault injection | 6 | 六类目标错误均 FAIL |

## 2. 指令集/LUI/J 实测

- 默认课程指令集：`add, sub, ori, lw, sw, beq, lui, nop`。
- `fixtures/course.config.json` 默认八条；`sll`/`j` 未启用。
- 全十指令启用后真实课程 CPU：**65/65 PASS**（默认 `full` 47/47）。
- Phase 2 CPU（无 LUI/J）：按其配置 **56/56 PASS**。
- `lui $t0,0xFFFF; ori $t0,$t0,0x8000` 的真实 CPU 运行结果为 `0xFFFF8000`。
- `j start` 编码 `0x08000C00`；J 前向/反向/边界测试在真实 CPU 通过。
- `nop` 为 0x00000000，真实 CPU 不产生寄存器/内存写，PC+4；默认关闭 sll 时仍可使用 nop。
- 手动汇编包含未启用指令时返回 `ASM_INSTRUCTION_DISABLED`；默认集生成器不会产生 sll/j 指令。

## 3. 强测与 NextPC

默认 `full`：**47/47 PASS**；全十指令 `full`：**65/65 PASS**；默认 `basic`：**37/37**，默认 `alu`：**20/20**。

NextPC 专项：

- `nextpc-sw-offset`：sw 正/负 offset、后续多次写回；CPU 逐周期 PC/Instr 全部一致。
- `nextpc-memory-positive-offset`：正 offset 不会变成分支目标。
- `nextpc-all-non-control`：LUI/ORI/ADD/SUB/LW/SW/NOP 连续 PC+4。

真实 NextPC 故障 CPU（`fixtures/course-cpu-fault-sw-nextpc.circ`）：

```text
FAIL: PC diverged at cycle 3:
expected 0x0000300C, actual 0x00002FFC
```

该 fixture 由生成脚本在正常 CPU 基础上把 sw 加入 PC 分支 mux select；用户原始 `.circ` 不变。

## 4. 六类故障注入

[fault tests](../tests/faults/faults.test.ts) 全部通过；每项都产生 `status=fail`、首个可观察差异和 message：

| fault | 观察点 |
|---|---|
| `sw-nextpc` | sw 后 PC 偏离 |
| `lw-sw-offset-zero` | 负 offset sw 的 MemAddr 期望值错误 |
| `beq-negative-offset` | 负分支目标 PC 偏离 |
| `ori-sign-extend` | ori 高半字 RegData 错误 |
| `lui-high` | LUI 写回高 16 位错误 |
| `add-sub-msb` | add/sub 最高位 RegData 错误 |

这些测试证明新套件不会把上述实现错误判为 PASS。测试只变异参考 trace 的期望值（或独立故障 CPU fixture），生产 Runner 不启用故障模式。

## 5. Stress/栈/覆盖率

- Stress Quick：**11/11 PASS**。
- Stress 全档位：**18/18 PASS**。
- `stress-loop-sum-stress`：10,242 动态周期。
- `stress-stack-walk-stress`：14,339 动态周期，循环内负 offset 保存/恢复。
- `stress-many-offsets-quick/stress`：8 个正负 offset 连续读写。
- 固定 seed 程序：同 seed 可重复；包含条件分支。
- coverage 示例（Stress Quick）：静态/动态 248/1177、GRF 31/32、beq taken/not 168/157、分支前向/反向 168/157、lw/sw 89/142、PC+4 合规 852/852、违规 0、最长用例 451 周期。

## 6. GUI smoke

```sh
npm run gui:smoke
```

退出码 **0**。验证：

1. 加载课程 CPU，默认 8 条指令勾选，sll/j 未勾选。
2. 点击 sll 两次 verify renderer → preload → IPC → service → 设置持久化往返，最终恢复默认。
3. 运行 basic（默认集）：全部通过。
4. 打开历史/工作台结果窗口，查看汇编/机器码、逐周期轨迹、覆盖率。
5. 运行 Stress Quick，选择 loop-sum，查看 322 周期分页与 stack coverage。
6. 打开故障 CPU，启用 sll，alu 显示失败首差异；结果窗口表头显示实际指令集。
7. 自定义汇编、编辑器和设置页面正常。

证据：[phase5-gui-smoke.txt](phase5-gui-smoke.txt)。

截图：

![Workbench 指令集](screenshots/phase5-workbench.png)

![结果窗口指令集与覆盖率](screenshots/phase5-result-stress.png)

![故障结果首差异](screenshots/phase5-result-failure.png)

## 7. 兼容

- 旧历史报告/旧配置继续可读；缺失 instructions 按默认八条处理。
- CLI 原有 `--circuit/--config/--asm/--suite/--steps/--expect/--list/--json` 通过。
- 原有 Phase 2/课程黑盒、物理 RAM 数量、结果窗口、HEX、长轨迹分页不回归。
- 不访问物理 RAM，不修改用户 `.circ`。

## 8. 已知限制

- 课程逻辑 DM 只有 3072 字，无法形成“高位 1 基址 + 负 offset”的合法地址；这类边界只在能映射到 RAM 时生成。
- 六类故障中只有 sw NextPC 做了独立 CPU fixture；其余使用明确允许的受控参考 trace 变异。
- 历史报告仍是单个 JSON；Stress 全量报告较大，结果窗口按元数据/单测试/200 周期分页读取。
- 未在 Linux/JDK 17 实机验证。
