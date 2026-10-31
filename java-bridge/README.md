# Java bridge

JDK 17+。依赖固定的原版 `../vendor/logisim-generic-2.7.1.jar` 和 Gson 2.11.0。

从仓库根目录执行 `java-bridge\gradlew.bat build poc installDist`（Windows）或 `sh java-bridge/gradlew build poc installDist`（Linux）。`poc` 是真实 Logisim 测试，不依赖 RPC。

也可 `npm run build:java`，然后直接启动：

```powershell
java -cp 'java-bridge/build/classes;vendor/logisim-generic-2.7.1.jar;vendor/gson-2.11.0.jar' bridge.Main
```

Linux 将 classpath 的 `;` 换成 `:`。`Main` 强制无界面模式和进程内偏好存储。stdin/stdout 为 UTF-8 JSON Lines；日志写 stderr。EOF 和 `shutdown` 都释放引擎与后台线程。

源码职责：

- `Engine`：Logisim 加载/传播/Pin/时钟/组件发现/ROM/RAM/Register 适配。
- `Main`：RPC 分发与 JSON 参数解析。
- `Poc`：独立可行性验收。
- `MemoryPreferences`：避免注册表及用户设置依赖。
- `com.cburch.logisim.std.memory.BridgeMemory`：编译进原版组件包名的适配类，直接访问包私有 `MemContents`/`RegisterData`；**不修改 JAR、不使用反射**。原版 ROM 在缺少 `contents` 属性时可能安装 8×8 默认内容，适配层按 `addrWidth/dataWidth` 归一化。

Phase 2 新增 RPC：`inspectComponents`、`readMemory`、`writeMemory`、`loadRom`、`readRegister`、`writeRegister`。`readMemory`/`writeMemory`/`loadRom` 的下标是 Logisim 组件字索引，不是 MIPS 字节地址。详细协议见 [protocol.md](../docs/protocol.md)，兼容性与适配原因见 [compatibility.md](../docs/compatibility.md) 和 [logisim-internals.md](../docs/logisim-internals.md)。
