# Phase 7 设计 — 扩展编码/符号测试与重新打包

## 1. 目标

在**不修改现有测试程序**的前提下，向外部测试集追加约 100 条程序，重点覆盖：

- 非 beq 指令字段恰好满足 beq 条件时的错误译码；
- `ori` 零扩展、`lw/sw` 符号扩展；
- GRF/DM 频繁写读；
- 非零 base、多路 beq、状态相关循环；
- `lui`/`ori` 作用于已有值的寄存器。

## 2. 新增程序分布

| 类别 | 数量 | 关键点 |
|---|---:|---|
| `lw` rs=rt 误当 beq | 6 | `lw $t0,off($t0)`，错误分支会跳过标记 |
| `sw` rs=rt 误当 beq | 6 | `sw $t0,off($t0)`，错误分支会跳过标记 |
| `ori` rs=rt 误当 beq | 6 | `ori $t0,$t0,imm`，错误用 imm 作位移 |
| ORI 零扩展 | 6 | 高半字非零 + 0x8000/0xFFFF |
| LUI/ORI 非零目标 | 6 | LUI 覆盖原值，ORI 零扩展 |
| lw/sw 负 offset | 6 | 非零 base + -4..-64 |
| GRF/DM 往返 | 10 | 8 个寄存器存/取/求和，非零 base |
| 非零 base 访存循环 | 10 | 循环 store/load + beq |
| 三路 beq 决策树 | 10 | 相等/左零/右零/fallthrough |
| 状态相关 beq 循环 | 10 | 条件随每轮状态变化 |
| 反复符号扩展访存 | 6 | 同一负 offset 多次读写 |
| LUI/ORI live register | 6 | 高地址位 + 低位 |
| 分支+访存循环 | 12 | beq 控制非零 base 的 DM 累加 |
| **合计** | **100** | |

程序集总数：165；默认八指令 147，启用 sll/j 165。

### 错误译码可观察性

`lw`/`sw`/`ori` 编码中的 rs/rt 可相等：

```mips
lw  $t0, 4($t0)        # rs=rt=t0
sw  $t0, 4($t0)        # rs=rt=t0
ori $t0, $t0, 1        # rs=rt=t0
```

若控制器把这些 opcode 错误解释成 `beq`，条件立刻成立，并在下一周期使用 memory/imm 字段作为分支位移。每条测试后面放置可观察写回和 PC 跟踪；Runner 逐周期比较 PC/Instr，所以不是仅靠最终 DM 检测。

## 3. 生成/校验

`scripts/add-phase7-tests.mjs`：

1. 用真实汇编器编码每个程序（origin `0x3000`）；
2. 用参考解释器运行到唯一终点标签，得到精确 `steps`；
3. 从逻辑 DM 读取指定 `signature` 索引的真实值；
4. 校验 signature 非全零；
5. 追加到 `test-suites/course.json`，不修改既有条目。

## 4. 故障注入

`ReferenceFault` 新增：

- `lw-as-beq`：对 `rs===rt` 的 lw，把 expected pcAfter 改成 branch target；
- `sw-as-beq`；
- `ori-as-beq`。

这些测试与外部程序集使用相同的逐周期比较路径；生产应用不开启故障模式。

## 5. 兼容/打包

- 现有 65 条程序保持原样，新程序只是 append。
- 新程序使用默认指令（无 sll/j），因此默认套件可运行；也包含在 full。
- `requiredRamBytes=0x400`，确保在课程/Phase2 RAM 上不越界。
- 重新 `npm run dist:win`，把 165 条外部 JSON 和最新 `dist` 复制进 portable app，重新执行 packaged smoke 并压缩。
