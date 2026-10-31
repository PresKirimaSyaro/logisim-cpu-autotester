# Phase 6 设计 — 外部测试程序集与 Windows 便携版

## 1. 外部测试程序集

### 运行时来源

Phase 5 及之前的定向测试定义位于 `packages/test-generator/src/directed.ts`，修改测试需要重新编译。Phase 6 改为：

```text
test-suites/course.json
  └─ Service/CLI 每次 startRun 读取
       └─ parseTestSuite → testsFromSuite → 按启用指令集过滤
            └─ DifferentialRunner
```

- Electron 工作台显示当前外部集合路径。
- 文件可以在安装目录中直接编辑，下一次运行立即生效。
- CLI `--suite-file` 可运行任意外部 JSON。
- `test-suites/example.json` 提供最小可复制模板。
- `scripts/export-test-suite.mjs` 是维护工具，从旧生成器导出 JSON；硬编码 builder 已移到 `builtin-directed.ts`，不导出到运行入口，也**不被打包**。应用运行路径不调用 `generateDirectedTests`。

### JSON 结构

```json
{
  "schemaVersion": 1,
  "name": "course-directed",
  "tests": [{
    "id": "lui-ffff",
    "name": "lui 0xFFFF then ori 0x8000",
    "category": "lui",
    "description": "...",
    "assembly": "    lui $t0, 0xffff\n    ori $t0, $t0, 0x8000\n    sw $t0, 256($zero)\n",
    "steps": 3,
    "signature": [{"index": 0, "expected": 4294934528}],
    "suites": ["basic", "full", "alu"],
    "tags": ["lui", "32-bit"],
    "seed": null,
    "requiredRamBytes": 260
  }]
}
```

- `steps` 精确动态周期。
- `signature.index` 相对 `signatureBase`；loader 映射为实际 byteAddress。
- `requiredRamBytes` 防止小 RAM Profile 运行越界程序（例如最后 RAM 字测试需要 3072 字）。
- loader 校验 schema、重复 id、签名、汇编语法、签名范围；按当前 `config.instructions` 过滤。
- 所有程序仍由参考解释器验证 signature/可观测写；外部文件不会绕过安全校验。

### 程序集内容

`test-suites/course.json` 包含 65 条：

- add/sub、ori、LUI、NextPC、lw/sw、beq、j、sll、mixed；
- 32 位边界、正负偏移、高位基址、栈保存/恢复、长分支、依赖链；
- 全 GRF、seeded 32 位程序；
- 每条测试带 suite/tag，默认指令集过滤后 47 条，全十指令 65 条。

Stress 套件仍是**算法生成**的模板（循环规模、seed），不是固定用例表；它不依赖外部 JSON，但遵守同一指令集过滤。

## 2. Windows 便携版

### 构建

```sh
npm run dist:win
```

`scripts/package-win.mjs`：

1. 执行 `build:gui`，得到 Java classes、TS、Electron main/preload、Vite renderer。
2. 复制 Electron 45.2.1 runtime 到 `release/Logisim CPU Tester`。
3. 将 `electron.exe` 重命名为 `Logisim CPU Tester.exe`。
4. 创建 `resources/app`，复制：
   - `dist/`（main/preload/renderer/packages）
   - `fixtures/`
   - **`test-suites/`（外部可编辑）**
   - `java-bridge/build/classes`
   - Logisim/Gson JAR 和 license
   - 精简 package.json（main 指向 dist main）
5. 如果找到 `jlink`，生成 `resources/app/runtime`：
   `java.base,java.desktop,java.logging,java.xml,java.prefs,java.datatransfer,java.scripting,java.naming,java.management,java.instrument,jdk.unsupported`。
6. 写入便携版 README。

### 启动

`apps/desktop/main.ts` 启动时检测 `resources/app/runtime/bin/java.exe`；若存在且用户的 `javaPath` 为空，将 Bridge 的 Java 路径设置为 bundling runtime。没有 runtime 时回退系统 `java`，仍可在设置页指定。

用户数据仍位于 Electron `userData`（`%APPDATA%\Logisim CPU Tester\logisim-cpu-tester`），不会污染便携目录。

### 限制

- 未签名 exe 可能触发 SmartScreen；这是分发签名限制，不是应用错误。
- 便携目录约 415 MB（Electron + 49 MB Java runtime），可压缩为 zip。
- 未在 Linux/JDK 17 实机验证；`jlink` runtime 由构建机 JDK 生成。
