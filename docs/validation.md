# 实际运行记录

> 本文件是 Phase 1 Bridge 的运行记录。Phase 2/3 的 70 项测试、课程 CPU 与 Phase 2 CPU 各 49/49、黑盒 DM、故障/死 CPU 检出和 GUI smoke 见 [phase2-validation.md](phase2-validation.md) 与 [phase3-validation.md](phase3-validation.md)。

2026-10-30，Windows，Temurin OpenJDK 25.0.4.1、Node.js 24.16.0、npm 11.13.0。内核为官方原版 Logisim 2.7.1，固定哈希见 vendor/README.md。没有 mock 或自制器件逻辑。

## 验收命令与结果

`npm test`：退出码 **0**。先编译 Java（release 17）和 TypeScript，再运行独立 Java POC，最后运行启动真实 Java 子进程的 Node 测试。

POC 实测：

| 电路 | 输入/动作 | 期望与实际 |
|---|---|---|
| CombinationalAdder | 1 + 2 | 0x03，known |
| CombinationalAdder | 255 + 1 | 0x00，known |
| CombinationalAdder | 127 + 128 | 0xFF，known |
| HierarchicalCircuit | 同上三组 | 0x03 / 0x00 / 0xFF，全部 known |
| Register | WE=1，D=0x2A，上升沿 | Q=0x2A |
| Register | WE=0，D=0x55，上升沿 | Q 保持 0x2A |
| Register | WE=1，连续写 0x55、0xAA | Q 分别为 0x55、0xAA |
| Register | 重建 CircuitState | Q=0x00 |

端到端结果：**8 tests / 8 pass / 0 fail / 0 skipped**，最终运行约 10.53 秒：

1. 真实加法器与层级电路、端口信息、三组连续输入、batch、20 个并发 ID 请求。
2. 寄存器无边沿保持、指定上升/下降沿、写使能、连续写、reset 和重复 reset。
3. 缺失文件/电路/端口、值与位宽错误、方向/时钟错误、非法 XML、外部库拒绝、batch 首错停止及失败后继续服务。
4. 真实未知输入和驱动冲突输出分别编码 unknownMask/errorMask，未伪装为已知零。
5. 32 位无符号 0xFFFFFFFF、溢出拒绝、同名端口消歧、坐标 ID 和 reset 后身份保持。
6. 真实 NAND 反馈振荡，返回 OSCILLATION，reset 后恢复。
7. 在操作待完成时从外部终止 Java，客户端检测 PROCESS_EXIT；新进程重启成功；启动失败与 1ms 超时均正确拒绝并释放资源。
8. 原始 JSON Lines 非法 JSON、重复 ID、未知操作、错误时钟边沿和正常 shutdown。

完整原始输出：[test-run.txt](test-run.txt)。

`.\java-bridge\gradlew.bat --no-daemon build poc installDist`：退出码 **0**，**BUILD SUCCESSFUL**，7 个任务执行；独立 POC 同样通过。Gradle 的 `test` 为 NO-SOURCE，不能将其当作 E2E 通过证据；E2E 由上面的 npm test 执行。完整输出：[gradle-run.txt](gradle-run.txt)。JDK 25 对 Gradle 原生库输出的受限方法 warning 不影响本次构建。

生成的 Windows 分发启动器也实际运行 load → batch(setInput, setInput, propagate, getOutput) → shutdown，输出 8 位已知 0x03，退出码 0；原始协议输出见 [rpc-run.jsonl](rpc-run.jsonl)。

## 未验证范围

Linux 和 JDK 17 没有在本次本机运行；已提供 Windows/Linux × JDK 17/25 的 CI 配置，但没有把尚未执行的 CI 说成通过。未验证外部库、第三方器件、内置自动 Clock、RAM/ROM 调试接口或完整 CPU。

早期遇到的 Windows 注册表访问失败和解决方式已记录于 logisim-internals.md。最终测试运行不需要读取或写入用户注册表设置。
