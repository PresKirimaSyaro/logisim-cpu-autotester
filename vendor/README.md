# 固定依赖与来源

- `logisim-generic-2.7.1.jar`，Carl Burch 原版 2.7.1，未经修改。
  - 来源：https://downloads.sourceforge.net/project/circuit/2.7.x/2.7.1/logisim-generic-2.7.1.jar
  - SHA-256：`362a78c12ad18c203fed868872c4a01cd9c12141379d92e892bbe2c37e627bc2`
  - GPL-2.0-or-later；完整对应源码在 JAR 的 `src/`，许可证为 `COPYING.TXT`，本目录另附拷贝。
- `gson-2.11.0.jar`，Google Gson，未经修改。
  - 来源：https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar
  - SHA-256：`57928d6e5a6edeb2abd3770a8f95ba44dce45f3b23b7a9dc2b309c581552a78b`
  - Apache-2.0；本目录附许可证。
- `../java-bridge/gradle/wrapper/gradle-wrapper.jar` 来自 Gradle 官方 v9.1.0 GitHub，Apache-2.0。

桥接代码与原版 GPL 程序直接链接；如再分发组合产物，应按原版 GPL 要求提供对应源码、许可证和修改记录。当前内核补丁清单为空。下载哈希用于固定本次研究版本，不代表对上游签名的独立验证。
