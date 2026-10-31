# Logisim CPU Autotester — Phase 8

面向 **Carl Burch 原版 Logisim 2.7.1** 的单周期 MIPS 子集差分测试工具。保留 Java Bridge、CLI、Electron GUI、独立结果窗口和原有测试框架；新增动态指令集、`lui`/`j`/`nop`、外部测试程序集、强测与故障注入。

输入 `.circ` 和 MIPS 汇编后，程序被编译为机器码，同时送入纯 TypeScript 参考解释器和真实 Logisim CPU。测试是**黑盒差分**：在时钟沿前采样顶层 `Instr`、`pc`、寄存器写回、存储器写事件，在时钟沿后检查 `pc`；不扫描、读取、写入或比较 CPU 内部的物理 RAM。逻辑 DM 只存在于参考模型和测试生成器中。

## 当前状态

- `npm test`：**103 tests / 103 pass / 0 fail**，约 33 秒。
- 外部测试集 `test-suites/course.json`：**165 条**定向程序。
  - 默认八指令过滤后 **147/147 PASS**；
  - 全十指令（额外 `sll`、`j`）**165/165 PASS**。
- 课程 CPU 默认 `basic` **37/37**；Phase 2 CPU 按默认配置 **121/121**。
- Stress Quick **11/11**；Stress 全档位 **18/18**（10,242 周期 loop、14,339 周期 stack walk）。
- `sw` NextPC 故障 CPU 在 cycle 3 报 PC 偏离，不是 PASS。
- 九类故障注入：sw NextPC、lw/sw 零扩展、beq 负偏移、ori 符号扩展、lui 高位、add/sub 最高位、lw/sw/ori 被误当 beq。
- Windows 便携版：`release/Logisim CPU Tester/Logisim CPU Tester.exe`；压缩包 190.5 MB。
- 随机测试套件：seed + 数量生成确定性 constrained-random 程序，真实参考执行计算 steps/signature。
- 测试记录默认保存到 **EXE 同目录的 `test-records/`**，历史页支持逐条删除。
- 验证记录：[docs/phase8-validation.md](docs/phase8-validation.md)、[docs/phase7-validation.md](docs/phase7-validation.md)、[docs/phase6-validation.md](docs/phase6-validation.md)。

## 快速开始

```sh
npm ci
npm test
npm run gui
npm run gui:smoke
npm run dist:win
```

需要 JDK 17+、Node 22+。`npm run gui` 构建并启动桌面应用；`dist:win` 生成便携版。

## 推送到 GitHub

当前本地仓库在 `master` 分支，尚未配置 remote。首次推送步骤：

1. 在 GitHub 新建一个**空仓库**（不要勾选自动生成 README、.gitignore 或 license）。
2. 配置提交身份并检查要提交的文件：

```sh
git config user.name  "Your Name"
git config user.email "you@example.com"

git status --short
git add .gitignore README.md docs
git status --short
git commit -m "docs: GitHub README, validation records and ignore rules"
```

3. 关联远程并推送：

```sh
git remote add origin https://github.com/<your-account>/<repo>.git
git branch -M main
git push -u origin main
```

如果希望继续使用 `master`，最后两行改成：

```sh
git push -u origin master
```

GitHub 已配置凭据后，也可以直接使用 SSH：

```sh
git remote add origin git@github.com:<your-account>/<repo>.git
```

### 需要推送/不推送的内容

**应该提交：**

- `apps/`、`packages/`、`java-bridge/src/`、`scripts/`、`tests/`
- `fixtures/`（课程/Phase 2/故障 CPU 与配置）
- `test-suites/`（外部测试程序集）
- `docs/`（设计、验证记录和截图）
- `package.json`、`package-lock.json`、`tsconfig.json`
- `vendor/` 顶层 JAR 与 license；这是构建/运行所需的 Logisim 2.7.1 和 Gson

**不要提交：**

- `node_modules/`、`dist/`、`java-bridge/build/`、`.gradle/`
- `test-records/`（用户历史与设置）
- `test-results/`（本地截图/报告）
- `release/`（数百 MB 的 exe/runtime；应作为 GitHub Release 附件）
- `vendor/src/`、`vendor/META-INF/`（上游解包源码，构建不需要）

`.gitignore` 已处理这些目录。便携版 `.zip` 用 GitHub Releases 上传：

```sh
gh release create v1.0.0 \
  "release/Logisim-CPU-Tester-win-x64.zip" \
  --title "Logisim CPU Tester v1.0.0" \
  --notes "Portable Windows build"
```

也可以在 GitHub 网页的 **Releases → Draft a new release** 中上传 zip。若仓库还没有提交，先执行 `git add`/`git commit`；检查忽略项可运行：

```sh
git status --short --ignored
git ls-files | wc -l        # Linux/macOS
# PowerShell: (git ls-files | Measure-Object).Count
```

推送后建议在仓库 About 中填写描述并添加 Topics：`logisim`、`mips`、`cpu`、`testing`、`electron`。

## 外部测试程序集（Phase 6/7）

定向测试不再由运行时硬编码生成。应用和 CLI 每次开始测试都会读取：

```text
test-suites/course.json
```

- 165 条程序、精确动态 steps、signature、suite 标签和 RAM 需求都在 JSON 中。
- 编辑/新增测试后，**下一次运行直接生效，无需重新编译**。
- 默认八指令过滤后 147 条；启用 `sll`/`j` 后 165 条。
- 自定义文件：`--suite-file my-suite.json`；示例：[test-suites/example.json](test-suites/example.json)。
- `signature.index` 相对 `signatureBase`（课程为 `0x100`），不是绝对地址。
- `requiredRamBytes` 防止把需要更大 DM 的测试误用于小 RAM Profile。
- 硬编码 builder 已拆到 `builtin-directed.ts`，只用于迁移导出，不导出到运行入口，也不进入便携包。应用实际只读外部 JSON。

Schema/编辑说明：[test-suites/README.md](test-suites/README.md)。

Phase 7 新增的 100 条程序集中在：

- `lw`/`sw`/`ori` 的 rs=rt 字段被错误当作 beq 时，后续 PC 会跳过标记；正确控制器必须 PC+4。
- `lw`/`sw` 负 offset 的符号扩展，以及 `ori` 的零扩展。
- GRF/DM 反复写读和求和；非零 base 的访存。
- beq 多路分支、状态变化循环、分支+访存组合。
- `lui`/`ori` 作用于已有值的寄存器。

## 动态指令集与 LUI/J/NOP

默认启用课程八条：

```text
add, sub, ori, lw, sw, beq, lui, nop
```

`sll`、`j` 是可选扩展，默认关闭；工作台复选框允许修改并持久化。选择统一约束：

- 汇编器：手动汇编使用未启用指令返回 `ASM_INSTRUCTION_DISABLED`；
- 测试生成器/外部 suite loader：只返回使用已启用指令的程序；
- 参考解释器：未启用指令返回 `INSTRUCTION_DISABLED`；
- 报告与结果窗口：记录实际启用的集合，覆盖率按真实执行统计。

`lui`：opcode `0x0F`，`GPR[rt] = (imm16 << 16) & 0xFFFFFFFF`。  
`j`：opcode `0x02`，目标 `{(PC+4)[31:28], instr_index, 2'b00}`，无延迟槽。  
`nop`：全零机器码，不写 GRF/DM，PC+4；不要求启用 sll。

## 结果窗口

Electron `BrowserWindow` 独立窗口，可按报告 ID 同时打开多个、独立关闭/缩放，不影响主窗口或后台测试。数据来自 EXE 同目录 `test-records/` 的持久化报告存储：

- 左侧列表：名称、静态指令数、动态/预期周期、PASS/FAIL/TIMEOUT/LIMIT/ERROR、首次差异周期和信号；失败优先，可排序/过滤。
- 汇编/机器码：ROM 地址/PC、源文本、32 位机器码、R/I/J 字段；HEX/完整二进制/分段二进制；复制和 Logisim HEX 导出。
- 逐周期轨迹：8 个顶层信号的 Expected/Actual、首差异高亮、只看差异、跳转周期、点击回静态指令；循环指令对应多个动态周期；未采样/未知/错误不显示为 0。
- 数值格式：全局默认 + 每信号局部覆盖；无符号/有符号十进制、十六进制、二进制；按位宽补零/符号扩展。
- 长轨迹每页 200 周期；覆盖率面板显示指令次数、GRF 读写、sll shamt、beq taken/not、分支前/后向、lw/sw、offset、非零 base、非分支 PC+4 合规/违规、最长用例周期、静态/动态指令数。

## 随机测试与记录目录（Phase 8）

工作台新增 `random · 随机程序` 套件：

- 输入随机种子与程序数量，默认 20 条；同一 seed 完全可复现。
- 程序由约束随机生成器构造：随机 ALU/ORI/LUI、非零 base 的 lw/sw、仅前向 beq，确保终止。
- 每个程序都经真实参考解释器运行，得到精确 `steps` 和 DM signature；遵守当前启用指令集。
- CLI：

```sh
npm run test:cpu -- \
  --circuit fixtures/course-cpu.circ \
  --config fixtures/course.config.json \
  --suite random --seed 1234 --seed-count 10
```

测试记录位置：

```text
<EXE 所在目录>/test-records/
  settings.json
  history/*.json
  history/*.meta.json
```

工作台/历史页显示记录目录；历史页每条记录都有“删除”按钮，删除完整报告和 meta，并关闭对应的结果窗口。便携版不再使用 `%APPDATA%`，因此拷贝整个便携目录即可带走记录。

## Stress

```sh
npm run test:cpu -- --suite stress --intensity quick
npm run test:cpu -- --suite stress --intensity standard
npm run test:cpu -- --suite stress --intensity stress
```

Quick/Standard/Stress 控制循环规模、seed 数和长周期数量；覆盖全部 GRF、RAW 链、嵌套循环、循环访存、负偏移/非零 base、长距离分支、栈保存/恢复、固定 seed 条件程序。Stress 模板是算法生成器，不是固定用例表；执行在 64 周期批内采样。达到 `maxCycles` 记为 `cycle-limit`，不是 CPU 错误。

## 课程 CPU Profile

- 顶层电路 `main`，唯一外部输入 `reset`，内部 Logisim `Clock`。
- 顶层输出：`Instr`、`pc`、`RegWrite`、`RegAddr`、`RegData`、`MemWrite`、`MemAddr`、`MemData`。
- ROM 4096×32，PC 初值 `0x3000`，ROM index `(PC - 0x3000) >>> 2`。
- 逻辑 DM 3072×32，地址 `0x0000..0x2FFF`。
- Java Bridge 使用内部时钟 `clockCycle` 和批量 `readOutputs`；Runner 在时钟沿前采样输出、沿后检查 PC，并比较寄存器/存储器写事件。
- `fixtures/course-cpu.circ` 完整实现 add/sub/ori/lw/sw/beq/lui/j/nop/sll。
- `fixtures/course-cpu-fault-sw-nextpc.circ` 是独立故障 fixture，不修改用户 `.circ`。

## CLI

```sh
npm run test:cpu -- \
  --circuit fixtures/course-cpu.circ \
  --config fixtures/course.config.json \
  --suite full
```

```sh
npm run test:cpu -- \
  --circuit fixtures/course-cpu.circ \
  --config fixtures/course.config.json \
  --suite basic \
  --suite-file test-suites/example.json
```

常用选项：

```text
--suite basic|full|branch|memory|alu|stress|random
--suite-file <path>      外部定向测试 JSON（默认 test-suites/course.json）
--instructions <list>    覆盖启用指令集
--intensity quick|standard|stress
--seed <n>               Stress 基种子
--seed-count <n>         Stress seed 程序数量 / random 程序数量
--steps <n> / --stop-pc  手写汇编的终止条件
--max-cycles <n>         单次运行周期上限
--report <path>          JSON 报告
--trace / --json / --list
```

退出码：0 全部通过；1 有 FAIL；2 harness/配置/汇编错误。

## Windows 便携版

```sh
npm run dist:win
```

生成：

```text
release/Logisim CPU Tester/Logisim CPU Tester.exe
release/Logisim-CPU-Tester-win-x64.zip  (190.5 MB)
```

便携目录约 414 MB，包含 Electron、Java Bridge classes、Logisim/Gson JAR、fixtures、外部 `test-suites/course.json` 和 jlink 精简 Java runtime。解压后双击 exe 即可；首次启动自动加载课程 CPU。用户历史/设置保存在 `%APPDATA%\Logisim CPU Tester\logisim-cpu-tester`。

## 防虚假通过

- 空汇编/零指令拒绝；参考程序没有任何非 `$zero` 写或存储器写 → error，不 PASS。
- 只注入 ROM；Runner 不调用 `readMemory`；Bridge/clock/输出读取失败一律 error。
- 所有 CPU 都从顶层信号逐周期比较；不依赖最终 RAM 兜底。
- 受控故障 CPU 和故障注入用例必须给出首个可观察差异。
- 未知/错误/未采样值保持原状态，不伪造为 0。

## 已知限制

- 课程逻辑 DM 只有 3072 字；`0x7FFF`/`0x8000`/`0xFFFF` 等立即数只有在形成合法地址时才会生成；“高位 1 base + 负偏移”无法映射到当前合法 DM。
- 六类旧故障注入使用受控参考 trace 变异；`lw/sw/ori` 误当 beq 和 sw NextPC 另有专门回归。所有测试不修改用户 `.circ`。
- 历史报告仍是单个 JSON；Stress 全量报告较大，结果窗口按元数据/单测试/200 周期分页读取。
- exe 未签名，SmartScreen 可能提示。
- 未在 Linux/JDK 17 实机验证。

## 目录

```text
apps/desktop          Electron main/preload
apps/renderer         React 主窗口 + 独立结果窗口
packages/mips-core    汇编器、解码、参考解释器、配置、HEX
packages/differential-runner  差分执行/报告/覆盖率
packages/test-generator      Stress、外部 suite loader、迁移 builder
packages/desktop-service     设置/历史/报告服务
packages/cli          CLI
test-suites           外部测试程序集
fixtures              课程/Phase2/故障 CPU 与配置
docs                  设计与验证记录
scripts               构建、导出 suite、打包
```

## 文档

- [Phase 8：随机测试、EXE 同目录记录与删除](docs/phase8-validation.md) · [设计](docs/phase8-design.md)
- [Phase 7：新增 100 条测试与重新打包](docs/phase7-validation.md)
- [Phase 6：外部测试集与 Windows 便携版](docs/phase6-design.md) · [验证](docs/phase6-validation.md)
- [Phase 5：动态指令集与故障注入](docs/phase5-design.md) · [验证](docs/phase5-validation.md)
- [Phase 4：独立结果窗口与 Stress](docs/phase4-design.md) · [验证](docs/phase4-validation.md)
- [Phase 3：桌面 GUI](docs/phase3-design.md)
- [Phase 2：差分核心](docs/phase2-design.md)
- [黑盒 DM/物理 RAM 解耦](docs/blackbox-dm.md)
- [协议](docs/protocol.md)
