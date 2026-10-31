# 原版 Logisim 2.7.1 源码调研

研究对象为 SourceForge 官方 `logisim-generic-2.7.1.jar`，JAR 的 `src/` 内含对应源码。`com.cburch.logisim.Main` 声明 `VERSION = LogisimVersion.get(2, 7, 1)`；运行时 inspect 也返回 2.7.1。

官方来源：[2.7.1 发行目录](https://sourceforge.net/projects/circuit/files/2.7.x/2.7.1/)、[原版说明：源码位于 JAR 的 src](https://cburch.com/logisim/docs/2.7/en/html/guide/about/index.html)。不引用 evolution API。

以下位置均相对于 JAR 内 `src/`；可在 `vendor` 目录执行 `jar xf logisim-generic-2.7.1.jar src` 展开，展开内容被 gitignore 忽略。行号对应本次固定哈希 JAR。

| 能力 | 源码证据与实际调用 |
|---|---|
| 加载 `.circ` | `file/Loader.java:131 openLogisimFile(File)` → `file/LogisimFile.java:362 load(File,Loader)` → `:405 loadSub` → `file/XmlReader.java:368 readLibrary`。Engine 直接调用公开 `LogisimFile.load`，避免 Loader 私有 showMessages 弹窗；XML 解析和所有电路构建仍由原版执行。路径前缀均为 `com/cburch/logisim/`。 |
| 选择根电路 | `file/LogisimFile.java:128 getCircuit(String)`；不是只能仿真 main。POC 选择 Register 等指定名字。 |
| 独立状态 | `circuit/CircuitState.java:144 CircuitState(Project,Circuit)`；`:227 getPropagator` 首次创建 Propagator 并 markAllComponentsDirty。Engine 为每次 load/reset 创建新状态。 |
| 真实 Pin 及宽度 | `Circuit.getNonWires()` 筛选 `Pin.FACTORY`；`Instance.getInstanceFor(Component)`；`std/wiring/Pin.java:290 getWidth`, `:301 isInputPin`；`StdAttr.LABEL` 与 `Instance.getLocation()` 给出标签及坐标。没有用会自动补名的 Analyze.getPinLabels 作为身份。 |
| 设置输入 | `std/wiring/Pin.java:313 setValue` 更新 sending，但不自动传播。随后 `InstanceState.fireInvalidated()` 标脏；这是同文件 PinPoker 也采用的方式。 |
| 组合传播 | `circuit/Propagator.java:175 propagate` 清理 dirty points/components，消耗延迟事件队列至空；未超过阈值且无 oscillating 才成功。原版 Adder 的实际计算和延迟在 `std/arith/Adder.java:76 propagate`，桥接层没有加法实现。 |
| 读取输出 | `std/wiring/Pin.java:309 getValue(InstanceState)`；原版 `gui/start/TtyInterface.java` 同样用它读取输出。POC 与 RPC 均读取真实 sending Value。 |
| 时钟 | `std/memory/Register.java:95 propagate` → `std/memory/ClockState.java:23 updateClock`；Register 的 rising 配置在构造器中。Engine 对 input Pin 显式应用低/高值并在每步 propagate，寄存器逻辑由原版执行。 |
| 原版自动 tick 的区别 | `circuit/Propagator.java:346 tick` 增加 ticks → `CircuitState.java:405 tick(int)` 遍历 Clock 并递归子状态。本阶段不调用它，避免隐含 Clock 属性/半周期语义。 |
| reset | 原版 `CircuitState.java:388 reset` 和 `Propagator.reset` 非 public；无需反射，Engine 新建 CircuitState。`std/memory/RegisterData.java` 构造器令 value=0，POC 实测归零。 |
| 子电路层级 | `circuit/SubcircuitFactory.java:203 getSubstate` 按需创建状态，`:226 propagate` 把上层端口传到子层 Pin 并传回输出。`CircuitState.setData` 维护 parent/substates 和共同 base；初始 propagate 必须先运行（TtyInterface 注释也说明这点）。Hierarchy fixture 真实实例化 CombinationalAdder。 |
| 振荡 | `circuit/Propagator.java:149 isOscillating`；`:175 propagate` 达 simLimit 返回并置标记。1000 是传播步数限制，既可能是反馈振荡，也可能是极长传播网络；协议不把它包装成成功。NAND 反馈 fixture 在 EN=1 时真实触发，reset 恢复。 |
| 未定义/错误 | `data/Value.java` 的 FALSE/TRUE/UNKNOWN/ERROR/NIL，`:18 MAX_WIDTH=32`，`:174 get(int)`。逐位编码而非对未知调用 toIntValue。冲突常量与三态默认 Pin fixture 分别验证 ERROR 与 UNKNOWN。 |
| 无 GUI | `gui/start/TtyInterface.java` 已有 Loader→Project→CircuitState→Propagator 的 CLI 调用链。本项目不调用 GUI Main；强制 java.awt.headless=true，直接运行该内核路径，POC 实测成功。 |

## Phase 2 内存/寄存器适配（JAR 仍未修改）

原版把 `Mem`、`MemState`、`MemContents`、`RegisterData` 设为包私有，公开 API 不足以直接读写 ROM/RAM 内容。Phase 2 增加 `java-bridge/src/main/java/com/cburch/logisim/std/memory/BridgeMemory.java`，编译进同一 Java 包名，直接调用这些类的方法：

- `Rom.getMemContents(Instance)` + `MemContents.get/set/clear` 用于 ROM 注入与回读。
- `Ram.getState(Instance,CircuitState).getContents()` 用于当前 RAM 状态；不另造 RAM 模型。
- `RegisterData.getValue/setValue` 用于 PC 等 Register 的观测/初始化。
- `Mem.ADDR_ATTR`/`DATA_ATTR` 提供地址/数据位宽。

这不是反射、不是修改 JAR、也不是替换 Logisim 内核；所有内容仍由原版 `MemContents` 存储。未增加任何 `--add-opens` 或模块补丁。

发现的原版 XML 行为：ROM 组件若省略 `contents` 属性，`XmlReader` 会用工厂默认值安装一个 8×8 的 `MemContents`，即使 `addrWidth/dataWidth` 已经设为 32。适配层在访问 ROM 时用属性位宽调用 `MemContents.setDimensions` 归一化；`fixtures/cpu.circ` 和 `fixtures/memory.circ` 同时显式写入 `contents` 头，保证 GUI 直接打开也正确。回归测试 `tests/bridge/memory.test.ts` 覆盖 32 位 ROM 注入/回读。

`inspectComponents` 的路径由根电路名、组件名和坐标组成；子电路按实例坐标递归。层级子电路的状态在检查时按需创建（`SubcircuitFactory.getSubstate`），因此层级 CPU 中的 ROM/RAM/Register 可在第一次时钟边沿前被定位。`readMemory`/`writeMemory` 的下标是 Logisim 组件字索引；MIPS 字节地址映射由 TypeScript 配置层显式完成。

## 障碍、适配点及补丁清单

**原版源码修改：0；JAR 修改：0；反射调用：0。**

1. `Loader.showError` 和私有 `showMessages` 使用 JOptionPane；直接使用更低一级公开 `LogisimFile.load`，Loader 子类覆盖 `showError` 抛结构化失败，并检查 `LogisimFile.getMessage()`。加载前标准 XML 预检查禁用 DTD/实体、拒绝外部库；这不是 Circuit IR，也不代替 Logisim 解析。
2. `Loader.getFileFor` 对缺失外部库会弹 JFileChooser；当前明确拒绝非 `#` 内置库。后续支持外部库须先实现无需 GUI 的解析/路径策略，不能偷偷加载替代内核。
3. `proj/Project.java:74` 创建 Simulator，`circuit/Simulator.java:171` 启动 manager/ticker，`:186 shutDown` 提供关闭。创建 Project 后立即禁用并关闭，直接同步调用独立状态的 Propagator，避免后台竞争。
4. `prefs/AppPreferences.java:213` 调用 `Preferences.userNodeForPackage`，本次 Windows 受限环境实际抛 SecurityException（注册表拒绝访问）。使用标准 `PreferencesFactory` 的进程内实现，避免注册表和桌面配置污染。POC 与 RPC 入口均提前设置工厂。
5. Propagator 根据 `Options.sim_rand_attr` 注入随机延迟；固定为 0。固定 `sim_limit_attr=1000`，不继承 GUI 文件中的随机传播设置。没有使用自动时钟频率。
6. Logisim 对 stdout 的旧诊断被重定向到 stderr，保留原 stdout 专供协议。

原版寄存器对未知 D 的固有行为是 `in.isFullyDefined()` 时才写 value，否则保留旧值；这与“桥接层把未知变 0”不同。此阶段完整保留原版行为。未来 CPU 测试器需要据此定义未知信号策略。

## 兼容性

仅承诺固定的原版 2.7.1 JAR。其 manifest 为旧 Java 6 编译环境，本项目桥接源码要求 JDK 17+，实际在 JDK 25 运行验证。没有验证其他原版版本、evolution、第三方器件、外部工程库或所有历史 `.circ` 格式。Linux 代码路径已准备，实机结果由 CI 后续确认。
