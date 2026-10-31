# 黑盒 DM 改造 — 设计说明

## 1. 目标

CPU 的物理数据存储器（RAM）是内部实现细节。测试工具只依赖规范化的外部可观察行为：

- 顶层 `Instr`、`pc`、`RegWrite`、`RegAddr`、`RegData`、`MemWrite`、`MemAddr`、`MemData`。
- 唯一外部输入 `reset`（高电平有效异步复位）。
- 时钟在电路内部。

工具不扫描、不计数、不读取、不写入、不拼接、不比较任何物理 RAM；配置里也没有物理 RAM 路径或地址映射。DM 是参考模型中的逻辑、按字节编址状态。

唯一保留的物理内存写入是**指令 ROM**：仍要求唯一 ROM，通过 `loadRom` 注入机器码；Runner 不调用 `readMemory`，注入错误会由第 1 个周期的 `Instr` 比较发现。

## 2. 配置 Schema

`CpuConfig.ram` 只描述逻辑 DM：

```json
"ram": {"baseByteAddress": 0, "capacityWords": 3072}
```

旧配置中的 `ram.path`、`ram.addressBits`、`ram.addressShift`、`ram.dataBits`、`ram.initial` 和 `compare` 仍可被解析，以支持迁移：

- `ram.path` / `compare` 被忽略。
- `addressShift` 若存在必须为 2（逻辑 DM 按 4 字节字）；`dataBits` 必须为 32。
- `addressBits` 仅作为缺少 `capacityWords` 时的旧容量提示，派生逻辑几何后不再参与测试。
- 非空 `ram.initial` 明确报错：不能初始化物理 RAM，必须用 `sw` 写 DM。

`capacityWords` 独立于任何物理地址位宽；不再要求 `capacityWords == 2^addressBits`。

## 3. 采样时刻

每个周期严格分两段：

1. **时钟沿前**：一次 `readOutputs` 读取 8 个顶层输出，与参考解释器该步比较：
   - `pc` / `Instr` 始终比较。
   - 只有当参考步骤存在非 `$zero` 寄存器写时，比较 `RegWrite=1`、`RegAddr`、`RegData`。
   - 只有当参考步骤存在 `sw` 时，比较 `MemWrite=1`、`MemAddr`、`MemData`。
   - 无写事件时不比较地址/数据；`MemWrite` 仍比较（非 store 必须为 0）。
   - `$zero` 写回允许 `RegWrite=0` 或 `RegWrite=1/RegAddr=0`；写到非零寄存器判错。
2. **时钟沿**：内部 Clock 使用 `clockCycle`（两次半周期），外部 Clock 使用 `tick`。
3. **时钟沿后**：只读取 `pc`，与参考 `pcAfter` 比较。

首个不一致记录 `firstSignalMismatch` 或 `pc.firstDivergence`，停止并报告，不做任何最终 RAM 比较。

## 4. 逻辑 DM 与 store/load

参考解释器的 `memory` 只保存 `sw` 写入的字，未写地址读 0。所有 `lw` 测试必须先通过 `sw` 写入：

```mips
ori $t0, $zero, 123
sw  $t0, 0($zero)
lw  $t1, 0($zero)
sw  $t1, 256($zero)
```

验证方式：

- `sw`：顶层 `MemWrite=1`、`MemAddr`、`MemData` 与参考一致。
- `lw`：后续 `RegWrite/RegAddr/RegData` 与参考一致；再把 load 值 `sw` 到结果地址，形成可观察闭环。
- 32 位模式、覆盖、不同地址、正负偏移、边界、依赖链、分支+访存都由现有 49 例覆盖。

## 5. 测试强度

full 套件 49 例：

- 10 add/sub、6 ori、9 sll、9 lw/sw、8 beq、混合/GRF/seeded。
- `sll-all-shift-amounts`：32 种 shamt，源 `0xDEADBEEF`，每条结果都通过 store 事件观察。
- `grf-all-registers`：31 个非零 GRF 寄存器各写唯一值并读回。
- 4 个固定 seed 的 32 位 add/sub/sll 测试；同 seed 生成结果逐字一致。
- 保留 `add-wrap-32`、`sub-underflow`、`add-sign-bit`、`ori 0xFFFF/0x8000`、`sll 0/15/16/30/31`、lw/sw 覆盖/偏移/边界、beq 正/负/成立/不成立等。

## 6. 验收对应

1. 任意数量物理 RAM：`fixtures/course-multi-ram.circ` 增加 3 个未使用 RAM，49/49 PASS。
2. 不依赖读取/修改物理 RAM：Runner 不调用 `readMemory`；E2E 代理测试断言 `readMemory` 调用数为 0。
3. 唯一 ROM 注入：保留 `loadRom`；注入错误由首个周期 `Instr` 检查发现。
4. 逐周期读取/比较顶层输出：课程与 Phase 2 CPU 均 49/49。
5. sw/lw 组合：独立 4 指令 sw→lw→sw 测试通过，并检查 MemWrite/MemData/RegData 检查点。
6. 七指令强测：49 例 full 套件。
7. GUI/CLI：`npm run gui:smoke` 与 CLI 测试通过。
8. 首次差异周期/信号：`firstSignalMismatch`、`pc.firstDivergence`。
9. 自动化测试与多 RAM：70/70 通过。

## 7. 兼容与移除

- 保留底层 `readMemory`/`writeMemory` 作为 Bridge 诊断原语，但测试运行完全不再调用；`CpuBridge` 接口不再暴露 `readMemory`/`writeMemory`。
- 删除 `comparator.ts`、`compareRanges`、`--range`、`--initial-ram`、`ramInitVerified`、`expectedRam/actualRam/differences` 等业务字段。
- 旧历史报告中的 RAM 字段仅作为可选 legacy 数据保留类型，GUI 不再展示。
- `--expect` 仅对参考模型的最终逻辑 DM 做交叉断言；CPU 的 store 事件仍逐周期比较。
