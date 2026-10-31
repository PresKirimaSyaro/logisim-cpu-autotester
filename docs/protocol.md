# JSON Lines v1

每行一个 UTF-8 JSON 对象。stdin 请求、stdout 响应，stderr 日志。无握手。请求 `id` 是进程生命周期内唯一的非空字符串；重复 ID 返回 `DUPLICATE_ID`。无法解析 ID 的错误响应为 `id:null`。调用串行执行，同一 JVM 可处理连续请求。

成功：`{"id":"1","ok":true,"result":null}`。

失败：`{"id":"1","ok":false,"error":{"code":"PORT_NOT_FOUND","message":"missing"}}`。

| op | 参数 | result |
|---|---|---|
| load | path, circuit | null；成功替换旧电路，失败保留旧电路 |
| inspect | 无 | circuit, logisimVersion, ports |
| setInput | port, value, 可选 width | null；只更新 Pin 并标记 dirty，不自动传播 |
| propagate | 无 | null；同步传播至稳定，或返回传播/振荡错误 |
| getOutput | port | LogicValue；读取最近一次传播后的输出 |
| reset | 无 | null；新建 CircuitState 并初始传播；恢复文件定义的初始状态和 Pin 默认值 |
| tick | port, 可选 edge | null；edge 默认 rising，也支持 falling |
| clockCycle | 可选 halfCycles（1 或 2，默认 2） | null；驱动所有内部 Logisim Clock，先 tick 再 propagate |
| readOutputs | ports 数组 | 以端口名为键的 LogicValue 映射；只允许根输出 Pin |
| parseHex | text | 用原版 `HexFile.parse` 解析 `v2.0 raw` 文本，返回 32 位字数组（用于导出往返验证） |
| inspectComponents | 可选 recursive | circuit, components；递归默认 true |
| readMemory | path, 可选 start/count | 底层内存诊断；黑盒 Runner 不调用 |
| writeMemory | path, start, words 数组 | null；底层诊断，只允许 RAM，黑盒流程不调用 |
| loadRom | path, start, words 数组 | null；只允许 ROM，替换内存中的 ROM 属性副本 |
| readRegister | path | path, width, initialized, value |
| writeRegister | path, value | null；写 Register 的当前状态并标脏 |
| batch | operations 数组 | completed, results |
| shutdown | 无 | null，响应后退出；EOF 也退出 |

`load.path` 在 Java 进程工作目录下解析；客户端在发送前转为绝对路径。加载期间禁用随机传播延迟，传播步数上限固定 1000。失败不退出 JVM。

## 端口标识

`inspect.ports` 的每项：

```json
{"id":"CombinationalAdder/pin@100,90","label":"A","direction":"input","width":8,"x":100,"y":90}
```

方向为相对被测试电路的 input/output。ID 使用目标电路名、`/pin@` 与整数坐标；同一未编辑电路下跨重载、reset 稳定，不依赖组件遍历顺序。名称只作便利别名：仅非空且唯一 label 可定位，否则 `AMBIGUOUS_PORT`。此阶段只暴露根 Pin；移动 Pin 会改变 ID。同坐标重复 Pin 在 load 时返回 INVALID_FILE。

## 位向量

输入 `value` 匹配 `0x[0-9a-fA-F]+`，无符号，允许前导零；超出 Pin 位宽返回 `WIDTH_MISMATCH`，不截断。可选 `width` 必须与真实端口宽度相同。字符串位数本身不是位宽，`0x000000FF` 可以设置 8 位端口。

输出：

```json
{"width":8,"value":"0x03","unknownMask":"0x00","errorMask":"0x00","status":"known"}
```

三个十六进制字符串都补到 `ceil(width/4)` 位、大写。`value` 只承载已知 1 位，未知或错误位由 mask 表达，**不能在忽略 mask 的情况下把 value 当成完整数值**。未知/高阻类位在 `unknownMask` 中为 1；错误位在 `errorMask` 中为 1；两者互斥。status 优先 error，其次 unknown，否则 known。原版 Value 不区分独立的 Z 状态；NIL 为宽度 0 的哨兵，不作为正常 Pin 输出。

## 时钟

`tick` 要求显式指定根电路的一位 input Pin。

- rising：设置 0 → 传播稳定 → 设置 1 → 传播稳定，结束为高。
- falling：设置 1 → 传播稳定 → 设置 0 → 传播稳定，结束为低。

一次 tick 包含建立基准电平和指定边沿；基准电平改变也可能触发相反边沿器件。对于双边沿或混合边沿电路，使用 `setInput` + `propagate` 自行控制每一次电平变化。

`clockCycle` 用于课程 CPU 的**内部** Clock。结果窗口的 ROM HEX 导出使用 Logisim `v2.0 raw`，通过 `parseHex`（实际调用原版 `HexFile.parse`）做导入/解析往返测试。它调用原版 `Propagator.tick()`（推进所有内置 Clock 的计数），然后 propagate；`halfCycles=2` 表示两次半周期，必然包含一个上升沿和一个下降沿，因此上升沿 CPU 恰好提交一条指令。若当前相位为高，顺序为高→低→高；若为低，为低→高→低，终态保持原相位。该操作不依赖墙钟、不自动计时；每次调用最多两次半周期。没有内部 Clock 时返回 `NO_INTERNAL_CLOCK`。

## 组件、ROM/RAM 与 Register

`inspectComponents` 返回当前状态树中的组件。路径格式：

```text
<根电路名>/<组件名>@<x>,<y>
<根电路名>/<子电路实例名>@<x>,<y>/<组件名>@<x>,<y>
```

名称中的 `%`、`/`、`@`、`,` 会被百分号转义。`path` 是稳定、可重新解析的定位方式；label 只作为展示信息。子电路状态在检查时按需创建，以便层级 CPU 暴露内部 ROM/RAM/Register。

`kind` 为 `rom`、`ram`、`register`、`clock`、`subcircuit` 或 `other`。内存组件额外给出 `addressBits`、`dataBits`、`capacity`；Register 给出 `width`；子电路给出 `subcircuit`；Clock 用于确认课程 CPU 的内部时钟存在且唯一（图形界面加载时会校验）。

内存操作的 `start`、`count`、`words` 下标都是 **Logisim 组件字索引**，不是 MIPS 字节地址。`words` 接受 `"0x..."` 字符串或 32 位无符号 JSON 整数，元素数量有上限（当前 `1<<20`）。`loadRom` 只允许 ROM，是黑盒测试唯一需要的内存注入/回读路径。

`readMemory`/`writeMemory` 作为底层诊断原语保留，但**不是 DM 测试契约**：Runner 不读取或写入任何数据 RAM；只对指令 ROM 做注入后的回读校验。DUT 内部的物理 RAM 数量、位宽、层级和内容都不参与测试，配置中也没有物理 RAM 路径。

`loadRom` 只修改当前 JVM 内 Logisim 属性对象的副本；原 `.circ` 文件不变。`reset` 会重建 CircuitState，因此 ROM 注入应在 reset 之前、RAM 初始化应在 reset 之后执行。`readRegister`/`writeRegister` 访问原版 Register 的 `RegisterData`；未传播过的 Register 报 `initialized=false` 并返回 0。

原版 Logisim 的 ROM XML 读取器在缺少 `contents` 属性时可能给 ROM 安装默认 8×8 的 `MemContents`，即使 `addrWidth/dataWidth` 已设置。桥接适配层会按属性位宽归一化 contents 维度，避免 32 位机器码被静默截断；fixture 仍显式写出 `contents` 头，保证 GUI 直接打开也正确。

## Batch 与错误恢复

operations 为不含 id 的普通操作数组，可以包含 load/inspect/setInput/propagate/getOutput/reset/tick/inspectComponents/readMemory/writeMemory/loadRom/readRegister/writeRegister；禁止嵌套 batch 和 shutdown。顺序执行，首个错误停止；results 包含已完成操作和该错误，completed=false。外层仍 ok=true，必须检查 completed/results。无回滚，前面的 setInput/load 已生效。

振荡发生后可 reset 或 load；原版已执行的传播不会回滚。getOutput 不隐式传播，振荡后不要把部分结果当成稳定输出。

错误码：`INVALID_JSON`, `INVALID_REQUEST`, `DUPLICATE_ID`, `UNKNOWN_OPERATION`, `NOT_LOADED`, `INVALID_FILE`, `UNSUPPORTED_LIBRARY`, `CIRCUIT_NOT_FOUND`, `PORT_NOT_FOUND`, `AMBIGUOUS_PORT`, `WRONG_DIRECTION`, `WIDTH_MISMATCH`, `INVALID_VALUE`, `PROPAGATION_ERROR`, `OSCILLATION`, `INVALID_CLOCK`, `NO_INTERNAL_CLOCK`, `INVALID_HEX`, `COMPONENT_NOT_FOUND`, `NOT_MEMORY`, `NOT_RAM`, `NOT_ROM`, `NOT_REGISTER`, `MEMORY_RANGE`, `MEMORY_VALUE`, `REGISTER_VALUE`, `EXPLICIT_COUNT_REQUIRED`, `READ_TOO_LARGE`, `HIERARCHY_TOO_DEEP`, `INTERNAL_ERROR`。

客户端本地错误：`PROCESS_START`, `PROCESS_IO`, `PROCESS_EXIT`, `PROTOCOL_ERROR`, `TIMEOUT`, `TERMINATED`, `CLOSED`。默认超时 10 秒，可配置。超时会终止子进程并拒绝所有待处理请求，避免后续使用不确定的变更状态；调用者新建客户端后重新 load，不自动重放写入。stderr 保存最近 64 KiB，也可回调接收。close 幂等，等待退出，2 秒后强制终止。

## 示例

请求按行发送：

```jsonl
{"id":"1","op":"load","path":"fixtures/adder.circ","circuit":"CombinationalAdder"}
{"id":"2","op":"batch","operations":[{"op":"setInput","port":"A","value":"0x01","width":8},{"op":"setInput","port":"B","value":"0x02","width":8},{"op":"propagate"},{"op":"getOutput","port":"S"}]}
{"id":"3","op":"shutdown"}
```

相应响应（JSON 属性顺序不构成协议）：

```jsonl
{"id":"1","ok":true,"result":null}
{"id":"2","ok":true,"result":{"completed":true,"results":[{"ok":true,"result":null},{"ok":true,"result":null},{"ok":true,"result":null},{"ok":true,"result":{"width":8,"value":"0x03","unknownMask":"0x00","errorMask":"0x00","status":"known"}}]}}
{"id":"3","ok":true,"result":null}
```

Phase 2 内存/寄存器示例（组件路径来自 `inspectComponents`）：

```jsonl
{"id":"10","op":"inspectComponents","recursive":true}
{"id":"11","op":"loadRom","path":"SingleCycleCPU/ROM@3200,10200","start":0,"words":["0x34080005","0xAC0A0000"]}
{"id":"12","op":"readMemory","path":"SingleCycleCPU/RAM@5200,27200","start":0,"count":256}
{"id":"13","op":"readRegister","path":"SingleCycleCPU/Register@1200,10200"}
```
