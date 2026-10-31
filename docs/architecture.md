# Phase 1 架构

> Phase 2 在保持本架构不变的前提下，扩展了组件发现、ROM 注入、RAM 读写和 Register 访问。Phase 2 的模块和差分流程见 [phase2-design.md](phase2-design.md)；协议扩展见 [protocol.md](protocol.md)。

```text
TypeScript LogisimBridge
  └─ Node child_process，ID 关联、超时、stderr、退出回收
       └─ UTF-8 JSON Lines
            └─ Java Main，逐请求隔离错误、顺序 batch
                 └─ Engine
                      └─ 原版 Logisim 2.7.1 JAR
                           Loader / CircuitState / Pin / Propagator / SubcircuitFactory
```

独立 POC 直接调用 Engine，不依赖 RPC；通过 POC 后才增加 Main 和 TypeScript 层。测试 fixture 是原版 XML 格式真实电路，Adder/Register 器件在 Logisim 内核运行。fixture 可以在原版 GUI 手动打开，但自动测试不会启动 GUI。

一个 Engine 一次持有一个 Project 和根 CircuitState。load 在新状态初始传播成功后提交；reset 复用解析后的电路，创建新的状态树，不重新读磁盘。Project 自带的模拟线程立即关闭；所有运行时操作直接在 stdin 请求线程中同步调用内核。电路包含层级时初始传播生成 substates 并共享根传播队列。Circuit 的事件监听器是 weak support，旧状态可回收。

构建有 Gradle 和无额外构建下载的 Node/JDK 入口，共用相同源码和本地依赖。协议与客户端分别放在 packages 中；本阶段通过根 tsconfig 构建，没有发布 npm 包。

## 后续 PC、GRF、ROM、RAM 接口建议

优先把 PC、GRF 的观测/控制信号暴露为 CPU 电路的调试 Pin，在 TypeScript 做课程适配，避免把 Java 对象结构直接变成公开协议。

需要内部访问时，增加 `inspectInstances`，以电路实例路径（子电路名 + 实例坐标）逐级定位，再用本级器件坐标定位 Register/RAM/ROM；不要只用类名或 label。读内部信号返回同一 LogicValue，并记录读取时是否已传播稳定。

- PC：`readRegister(instancePath)` 返回位宽和值；明确位于哪个边沿前/后。写寄存器应作为独立的调试能力，正常测试仍由输入/时钟驱动。
- GRF：先确定被测设计是 32 个 Register、RAM 还是自定义层级；协议可提供批量读寄存器的公共形状，Java/模块适配负责映射。
- ROM：原版 `Rom.CONTENTS_ATTR` 为公共属性；建议 `loadMemoryImage` + `readMemory`，统一地址位宽、数据位宽、镜像格式。每个会话隔离 ROM 属性副本，避免修改共享电路影响 reset。
- RAM：原版 TtyInterface 已通过 `Ram.loadImage` 装载，适合作为下一步源码验证入口。使用原版 `MemContents` 存储，不另造 RAM。区分初始镜像和运行时内容，明确 reset 是否重载镜像。

这些是扩展建议，当前没有实现或声称验证内存/CPU 调试 API。
