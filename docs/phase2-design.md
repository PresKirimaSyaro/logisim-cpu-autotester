# Phase 2 设计 — 差分验证核心

> Phase 3 在本文基础上改为**黑盒 DM**：不再要求/读取物理 RAM，只比较顶层输出；逻辑 DM 由参考模型维护，`ram` 仅保留逻辑基址/容量。内部 Clock `clockCycle`、8 个输出信号的逐周期比较和 Electron GUI 也已加入。当前行为以 [phase3-design.md](phase3-design.md) 和 [blackbox-dm.md](blackbox-dm.md) 为准；本文保留 Phase 2 的原始设计记录。

## 1. 总体流程

```text
MIPS assembly
   │  packages/mips-core/assembler (two passes)
   ▼
machine code words
   ├──────────────────────────────┐
   ▼                              ▼
ReferenceInterpreter          Java Bridge
(decodes machine words)       ROM injection
   │                              │
   ▼                              ▼
expected RAM / PC              Logisim CPU cycles
   │                              │
   └──────────┬───────────────────┘
              ▼
       RAM comparator
              │
              ▼
   report (terminal + JSON)
```

参考解释器和真实 CPU 接收**同一份机器码**；解释器从机器码解码执行，不执行汇编 AST。这样汇编器的错误也会在差分链路中暴露。

## 2. 模块

```text
packages/
  mips-core/
    src/isa/            constants, encoding, decoding
    src/assembler/      lexer, two-pass assembler
    src/interpreter/    ReferenceInterpreter, StepResult, trace
    src/memory/         AddressMap (byte address ↔ word index)
    src/config/         CpuConfig schema, compare ranges
  test-generator/
    src/directed.ts     deterministic directed suite + signatures
  differential-runner/
    src/runner.ts       DifferentialRunner
    src/comparator.ts   full/partial RAM comparison
    src/report.ts       JSON + terminal reports
  bridge-client/         Phase 1 client, extended methods
  protocol/              shared JSON Lines types
  cli/                   thin command-line shell
tests/
  assembler/ interpreter/ config/ generator/ bridge/ e2e/ cli/
```

业务逻辑不依赖 CLI；CLI 只解析参数、读取文件、启动 Bridge、调用 Runner。未来 Electron 可以直接复用 `mips-core`、`test-generator` 和 `differential-runner`。

## 3. ISA 语义

只实现 `add/sub/ori/lw/sw/beq/sll`。所有 32 位值使用显式 `>>> 0` 归一化：

| 指令 | 语义 |
|---|---|
| `add` | `(rs + rt) mod 2^32`，不抛溢出异常 |
| `sub` | `(rs - rt) mod 2^32` |
| `ori` | `rs OR zero_extend16(imm)` |
| `lw` | `addr = rs + sign_extend16(offset)`；4 字节对齐、范围检查；读 32 位字 |
| `sw` | 同 `lw` 地址计算；写 32 位字 |
| `beq` | 完整 32 位寄存器相等；`PC = PC + 4 + (sign_extend16(offset) << 2)` |
| `sll` | `(rt << shamt) mod 2^32`，shamt 0..31 |
| `$zero` | 读恒 0；写被忽略，但在 StepResult 中记录 `ignored: true` |

`add/sub` 的机器码 opcode=0、funct=0x20/0x22，不是 `addu/subu`。`sll` 的 rs 字段在真实 MIPS 中要求 0；解码器接受并忽略 rs，与硬件行为一致并在文档中说明。

不支持的机器码在解码时返回 `UNSUPPORTED_INSTRUCTION`，绝不静默当作 NOP。全零字恰好是 `sll $zero,$zero,0`，解释器会正常执行它，而不是把它当停止标记。

## 4. Assembler

- 手写 Lexer，保留 1-based line/column、原文行文本；支持 `#` 和 `;` 注释、空行、标签、同一行标签+指令。
- 两遍：第一遍分配字节地址和符号表；第二遍解析操作数、检查范围、编码。
- 操作数形式：`add/sub rd,rs,rt`；`ori rt,rs,imm`；`lw/sw rt,offset(base)`；`beq rs,rt,label|byteOffset`；`sll rd,rt,shamt`。
- 立即数：十进制/`0x`/有符号；`ori` 接受 `-32768..65535`（负数编码为 16 位二补码，硬件零扩展）；`lw/sw` 接受 `-32768..32767`；`shamt` 0..31；寄存器 `$zero`/`$t0`/.../`$0`..`$31`。
- `beq` 标签：`offset = (target - (PC+4))/4`，检查目标 4 字节对齐和 16 位有符号字段范围。数字操作数按**字节偏移**解释并同样检查。
- 所有字段做显式范围检查；不静默截断。`nop` 等伪指令不接受。
- 错误包含稳定 code、行、列、原文行；CLI 打印 caret。

黄金测试向量独立于 assembler 内部：测试直接写死机器码，并用 `fieldsOf` 做独立位字段检查。

## 5. ReferenceInterpreter

状态：

```ts
interface CpuState {
  pc: number;                 // MIPS byte address
  registers: Uint32Array;     // 32 x uint32
  memory: Map<number, number>;// sw writes, keyed by MIPS byte address
  executedInstructions: number;
}
```

`memory` 只保存写过的字；读取时回退到配置的初始 RAM（缺省 0）。`snapshotRamWords()` 按 ROM/RAM 组件字索引导出完整快照。

- `step()`：恰好一条；返回执行前/后 PC、机器码、解码指令、寄存器写、内存写、错误。
- `runSteps(n)`：固定动态指令数；提前遇到错误则 status=error。
- `runUntilStop(stopPc,maxSteps)`：每步前检查 stop PC；可停在 ROM 末尾；达到上限返回 step-limit。
- 执行边界：PC 对齐/ROM 范围、地址对齐/RAM 范围、不支持机器码、最大步数。
- 可选 trace；runner 始终用 trace 获取逐周期 PC 检查点。
- 没有 `halt`；固定步数或 stop PC 由调用者显式给出。

## 6. 地址映射

`AddressMap` 显式区分：

1. MIPS 字节地址（汇编、PC、`lw/sw` 有效地址）。
2. Logisim ROM/RAM 组件字索引（地址输入）。
3. Java Bridge 的 `readMemory/writeMemory/loadRom` 下标（就是组件字索引）。

配置：

```text
index = (byteAddress - baseByteAddress) >>> addressShift
```

- `addressShift=2`：按字寻址组件；字节地址 0x100 → 组件索引 64。
- `addressShift=0`：按字节寻址 RAM。
- 当前配置只允许 ROM `addressShift=2`（本阶段按字寻址指令 ROM）；RAM 允许 0/1/2。更大的 shift 会让不同 4 字节字映射到同一下标，因此显式拒绝，不做静默截断。
- `capacityWords` 必须等于 `2^addressBits`；地址位宽、数据位宽、容量都会与真实组件 `inspectComponents` 结果交叉检查。
- `lw/sw` 先检查 MIPS 4 字节对齐，再映射到组件索引；越界/不对齐是显式执行错误。

## 7. CpuConfig

示例见 `fixtures/cpu.config.json`。关键字段：

- `circuitName`
- `clock`（pin, edge）
- `reset`（`state` / `pin` / `none`；pin 策略含 activeLow、ticks）
- `pc`（`register` / `pin` / `none`；initial、checkEachCycle）
- `rom` / `ram`（path、baseByteAddress、addressBits、addressShift、dataBits、capacityWords；RAM 可带 initial）
- `compare`（full 或 ranges）
- `limits`（maxSteps、maxCycles）
- `inputs`（额外静态输入）
- `notes`

Schema 验证是手写的严格解析器：未知字段、类型错误、范围错误、容量不一致、PC 越界、初始 RAM 越界/不对齐、重复地址、compare 越界、clock/reset 同 pin 都会拒绝并给 JSON path。不会把未识别的字段静默忽略。

## 8. 结束语义与周期前提

- 内置测试给出精确动态指令数；runner 用同一数字驱动参考解释器和 CPU 时钟周期。
- 手写程序可用 `--steps` 或 `--stop-pc`。`--stop-pc` 由参考解释器先跑到 stop PC，得到实际动态条数，再用同样条数驱动 CPU。
- 每个 tick 必须恰好提交一条指令；runner 在 PC 可观测时逐周期比较 PC。若 PC 偏离，默认在第一个偏离周期停止，并把参考状态回退到同周期比较 RAM，报告 `firstDivergence.cycle`。
- 如果电路是流水线/多周期/自动时钟，这个前提不成立；报告会以 PC 偏离或周期数不符失败，而不是继续输出 PASS。

## 9. 差分比较

- 默认比较配置 RAM 的**全部** capacity 字，包括从未被程序写过的地址；这能抓到 CPU 意外写无关地址。
- `compare.ranges` 或 CLI `--range` 支持显式部分比较；报告的 `comparedRanges` 和 `comparisonScope: partial` 会注明实际范围。
- 比较前：
  1. ROM 注入后立即回读并逐字比较。
  2. RAM 初始化写入全部 capacity 字后回读并逐字比较。
  3. 参考解释器执行完整步数并由其快照给出 expected RAM。
- 失败报告包含：测试 id/name、汇编源、机器码、seed（确定性测试为 null）、初始/期望/实际 RAM、比较范围、步数/周期、第一处差异（字节地址、word index、期望/实际）、PC 检查点、Bridge stderr/错误分类、耗时。
- 只有具备逐周期 PC 检查点时报告 `firstDivergence.cycle`；仅比较最终 RAM 时不会声称定位到第一条错误指令。

## 10. 防虚假通过

- 空汇编拒绝（`assembly` 错误）。
- 参考程序没有任何 RAM 写入，或 expected RAM 与 initial RAM 完全相同 → `observability` 错误，不进入 PASS。
- 每个内置测试至少有一个非零 signature 值；signature 先与参考结果交叉校验。
- ROM 回读、RAM 初始化回读必须一致，否则 init 错误。
- Bridge/tick/读 RAM 失败一律 error，不会 PASS。
- 受控 dead CPU（PC 不使能）在 37 个 basic 测试上全部失败；在 `pc.mode=none` 下也通过最终 RAM 比较失败。
- 受控 faulty CPU（sll shamt 恒 0）被检出 11 个失败，报告第一处 RAM 差异。

## 11. 内置测试生成器

`generateDirectedTests(layout)` 生成 43 个确定性定向测试，覆盖：

- add/sub：0+0、普通、32 位截断、下溢、符号位、同寄存器、`$zero`、连续依赖。
- ori：0、0xffff、零扩展、保高 16 位、同寄存器、负数/最高位。
- sll：shamt 0/1/15/16/30/31、移出高位、同寄存器、目标 `$zero`、依赖。
- lw/sw：写后读、多地址、覆盖、负偏移、非 `$zero` 基址、已知初始 RAM、最后字边界、store→load、load→use。
- beq：taken/not-taken、offset 0、正/负偏移、循环、连续分支、依赖、`$zero==$zero`。
- mixed：七条指令混合。

地址从 `CpuConfig` 的 RAM 区域派生（signature/scratch 分开），不写死课程地址映射。生成器同时给出 `steps`、`initialRam`、`signature`、`suites`、`tags`；测试本身在单元测试中逐条用参考解释器验证步数和 signature。

## 12. 真实 CPU fixture

`scripts/generate-cpu-fixture.mjs` 用原版内置组件生成真实单周期 CPU：

- PC Register + PC+4 Adder + 分支目标 Adder/Shifter/BitExtender。
- 8×32 指令 ROM（显式 `contents` 头）。
- 32 个 32 位 Register 组成寄存器堆；5→32 Decoder + 32 个 EN 门 + 两个 32:1 读多路器；写地址在 R 型的 rd 与 I 型的 rt 之间选择；`$zero` 写使能恒 0。
- ALU：Adder/Subtractor/OR/Shifter + 多路器；ori 零扩展，lw/sw 符号扩展。
- 8×32 数据 RAM（word-index 地址由 ALUOUT[9:2] 得到）。
- 控制：opcode/funct 比较器 + 门；RegWrite/MemWrite/MemRead/ALUSrc/MemToReg/Branch/ALUOp/ZeroExt。
- `RST` 高有效，`CLK` 上升沿；PC 作为 `Register` 可由 Bridge 写入/读取。

生成器同时写 `fixtures/cpu.config.json`；`cpu-faulty.circ` 和 `cpu-dead.circ` 是从同一组件列表克隆的受控变体，原 CPU 文件不被修改。

## 13. 错误分类

`TestErrorType`：`assembly`、`config`、`circuit-load`、`init`、`simulation`、`timeout`、`ram-mismatch`、`reference`、`observability`、`bridge`、`internal`。CLI 退出码：0 全部 PASS；1 至少一个差分失败；2 装配/配置/加载/仿真错误。

## 14. 已知限制

- 无流水线、异常、中断、halt；只支持七条指令。
- 单周期前提；每个 tick 一条指令。
- PC 观测可选；没有逐周期可观测状态时只能给出最终 RAM 差异。
- 部分比较只覆盖配置范围，报告会明确标注。
- ROM 注入修改 JVM 内存中的属性副本，不写回 `.circ`。
- 不实现自动失败最小化、约束随机生成、子模块单元测试、通用电路 IR、Electron GUI。
