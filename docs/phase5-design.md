# Phase 5 设计 — 动态指令集、LUI/J/NOP 与故障注入

## 1. 动态指令集

### 默认与可选

```text
默认：add, sub, ori, lw, sw, beq, lui, nop
可选：sll, j
```

`CpuConfig.instructions` 保存实际启用集合；缺少该字段的旧配置按默认八条补全。`fixtures/course.config.json` 使用默认集合，Phase 2 的外部时钟 CPU 配置使用它实际支持的 `add/sub/ori/lw/sw/beq/sll/nop`。

### 配置传播

```text
Workbench 复选框
  └─ IPC instructions:set
       └─ TesterService.setInstructions
            ├─ 内存中的 CpuConfig.instructions
            ├─ TesterSettings.instructions（持久化）
            └─ 下一次 RunSummary.instructions / 报告元数据
```

服务重新加载电路时把持久化选择应用到新 Profile；载入配置/保存配置也会同步选择。GUI 只在没有运行测试时允许修改。

统一约束：

- `assemble(source,{instructions})`：未启用 mnemonic 抛 `ASM_INSTRUCTION_DISABLED`，并列出已启用集合。
- `ReferenceImage.instructions`：参考解释器执行未启用指令抛 `INSTRUCTION_DISABLED`。
- `generateDirectedTests(layout, instructions)` / `generateStressTests(...,{instructions})`：按实际程序文本过滤，返回结果中不含未启用指令。
- Report：`RunSummary.instructions` 和 `ReportMeta.instructions` 记录实际集合。
- Coverage：按实际执行的 trace 统计；结果窗口用启用集合展示每条指令的计数。

`nop` 不依赖 `sll` 的启用状态：汇编器接受 nop 并编码为 0x00000000，参考解释器把它作为独立 nop 处理；真实 CPU 用全零 sll 实现，体系结构上无写回、PC+4。

## 2. LUI / J / NOP 语义

### LUI

```text
opcode = 0x0F
rs = 0
GPR[rt] = (imm16 << 16) & 0xFFFFFFFF
```

- 汇编：`lui $t0, 0xFFFF`；立即数按 16 位无符号位模式，范围 0..0xFFFF。
- 编码：`0x3C08FFFF`（`lui $t0,0xFFFF`）。
- 参考：写 rt 的 `RegisterWrite`，无内存写，PC+4。
- 课程 CPU：IMM16 zero-extend → 左移 16 → 写回 mux（`IS_LUI`）。

示例：`lui $t0,0xFFFF; ori $t0,$t0,0x8000` → `0xFFFF8000`。

### J

```text
opcode = 0x02
index = instr[25:0]
target = {(PC+4)[31:28], index, 2'b00}
```

- 汇编：`j label`（标签）或绝对地址；标签必须 4 字对齐且与 PC+4 同一 256 MB 区域。
- 编码：`encodeJ(index)`；`j start` 在 origin 0x3000 编码为 `0x08000C00`。
- 无延迟槽；J 不写寄存器/内存。
- 课程 CPU：INSTR[25:0] zero-extend、左移 2，与 PC+4 高 4 位 OR，作为 J 目标 mux 输入。

### NOP

全零字。参考解码为 `nop`；不产生寄存器/内存写，PC+4。课程 CPU 的全零字由 sll 零位移实现；结果上等价。

## 3. 教学 CPU fixture

`scripts/generate-course-cpu-fixture.mjs` 增加：

- LUI 写回 mux 和 `IMM16 << 16` shifter；
- J 的 `INSTR[25:0]` splitter、zero-extend、左移 2、PC 高 4 位 OR、PC 选择 mux；
- `IS_LUI`/`IS_J` opcode 比较；
- 控制信号和输出观测保持原有 8 个顶层输出。

同时生成一个只用于回归的 `fixtures/course-cpu-fault-sw-nextpc.circ`：把 PC 分支 mux 的 select 改为 `TAKEN || IS_SW`，使 sw 错误地使用分支目标。正常 `course-cpu.circ` 不受影响，用户原始 `.circ` 从不被写入。

## 4. NextPC 强测

所有非控制指令必须 PC+4：

```text
add, sub, ori, lw, sw, lui, nop (+ sll when enabled)
```

- `nextpc-sw-offset`：正/负 offset、非零 base、连续 store/load、多个明显写回。
- `nextpc-memory-positive-offset`：正 offset 不能变分支位移。
- `nextpc-all-non-control`：LUI/ORI/ADD/SUB/LW/SW/NOP 连续路径。
- Runner 逐周期比较顶层 `pc`/`Instr`，并在时钟沿后比较 PC，不依赖最终 RAM。
- 对 `sw` NextPC 故障 CPU fixture 断言首个 PC 差异，而不是 PASS。

## 5. 符号扩展/32 位/分支/访存强度

- LUI+ORI 构造 `0xFFFFFFFF`、`0x80000000`、`0x7FFFFFFF`、`0xFFFF0000`、`0x00008000`、`0xFFFF8000` 等边界。
- add/sub 负数、溢出、最高位、连续依赖和目标覆盖。
- beq 负数相等/不等、正负比较、0 与负数、正/负/大偏移、taken/not-taken、连续分支、循环。
- lw/sw 正负 offset、非零/高位基址（结果地址仍合法）、同一地址重复读写、交错读写、地址边界、load-use 依赖。
- `stack-frames`：`$sp` + negative offsets 保存/恢复三个局部变量。
- Stress 增加 stack walk、连续正负 offsets、条件状态变化；Stress 档位的 loop/stack 均超过一万动态周期。

## 6. 故障注入回归

生产 Runner 不启用故障模式。测试通过 `referenceFault` 对参考 trace 做受控 mutation：

- `sw-nextpc`：sw 的 expected PC 改为 `PC+4+(sign_extend(imm16)<<2)`；
- `lw-sw-offset-zero`：负 offset sw 地址按零扩展偏移，lw 期望值按错误地址变异；
- `beq-negative-offset`：负分支目标按零扩展偏移；
- `ori-sign-extend`：ori 高半字被符号扩展；
- `lui-high`：LUI 写回高 16 位清零；
- `add-sub-msb`：add/sub 结果 bit31 翻转。

每个测试都要求 CPU 产生 FAIL、首个可观察差异和 message，而不是 PASS。真实 `sw` NextPC 故障 CPU 另有一条端到端回归。

## 7. 覆盖率

`CoverageSummary` 新增：

- `branchForward`/`branchBackward`；
- `nonControlExecuted`/`nonControlPcPlus4`/`nonControlPcBad`；
- `negativeResults`/`highBitResults`/`zeroResults`；
- `maxTestCycles`。

原有指令次数、GRF 写/读、sll shamt、beq taken/not-taken、lw/sw、offset、非零 base、静态/动态指令数保留。结果窗口显示启用指令的覆盖计数。

## 8. 兼容与安全

- 旧报告没有 `instructions` 时按未记录处理；新报告有完整集合。
- 旧配置缺少 `instructions` 时补默认八条。
- 不在 GUI 自动检测 CPU 指令支持；用户显式选择。
- 不读取物理 RAM；不修改用户 `.circ`。
- 生成的每个程序由参考解释器计算精确动态步数与 signature；所有循环有退出标签/上限。
