# Phase 7 实际运行记录

日期：2026-10-31。环境：Windows、Temurin OpenJDK 25.0.4.1、Node.js 24.16.0、Electron 45.2.1、Logisim 原版 2.7.1。

## 1. 新增程序

向 `test-suites/course.json` **追加 100 条**，原有程序未修改：

| 类别 | 数量 |
|---|---:|
| lw/sw/ori rs=rt 被误当 beq | 18 |
| ORI 零扩展 / LUI 非零目标 | 12 |
| lw/sw 负 offset 符号扩展 | 6 |
| GRF/DM 往返（非零 base） | 10 |
| 非零 base 访存循环 | 10 |
| 三路 beq 决策树 | 10 |
| 状态相关 beq 循环 | 10 |
| 反复符号扩展访存 | 6 |
| LUI/ORI live register | 6 |
| 分支+访存循环 | 12 |
| **合计** | **100** |

总数：165 条；默认八指令过滤 **147**，全十指令 **165**。

## 2. 自动化结果

```sh
npm test
```

退出码 **0**：**99 tests / 99 pass / 0 fail / 0 skipped，约 32 秒**。原始输出：[phase7-test-run.txt](phase7-test-run.txt)。

真实课程 CPU：

```text
默认 full: 147/147 PASS
全十指令 full: 165/165 PASS
Phase 2 外部时钟 CPU 默认: 121/121 PASS
```

新增的 rs=rt 误译码程序全部由正常 CPU 通过；另外三个受控参考故障：

| fault | 结果 |
|---|---|
| `lw-as-beq` | FAIL，首个 PC 差异 |
| `sw-as-beq` | FAIL，首个 PC 差异 |
| `ori-as-beq` | FAIL，首个 PC 差异 |

原有六类故障注入继续通过，共 **9/9**。

## 3. 代表性程序

```mips
# lw 字段相等；若误译码成 beq 会跳过后续写回
ori $t0, $zero, 0x100
lw  $t0, 4($t0)
ori $t1, $zero, 0x55
sw  $t1, 256($zero)
ori $t2, $zero, 1
sw  $t2, 260($zero)
```

```mips
# 非零 base + 负 offset，检查符号扩展
ori $t0, $zero, 0x300
ori $t1, $zero, 0x1234
sw  $t1, -4($t0)
lw  $t2, -4($t0)
sw  $t2, 256($zero)
```

```mips
# LUI/ORI 作用于已有值寄存器
ori $t0, $zero, 0x2222
lui $t0, 0x9000
ori $t0, $t0, 0x0100
sw  $t0, 256($zero)
```

## 4. 打包

重新构建：

```sh
npm run dist:win
```

结果：

```text
release/Logisim CPU Tester/Logisim CPU Tester.exe
release/Logisim-CPU-Tester-win-x64.zip (190.5 MB)
portable size: 414.5 MB
```

包内 `resources/app/test-suites/course.json` 为 165 条；打包版 smoke 退出码 0：

- basic 37/37
- Stress Quick 11/11
- 故障 CPU alu 58 例，50 PASS / 8 FAIL
- 外部测试集路径、指令集、结果窗口和独立覆盖率正常

普通双击 exe 启动成功，自动加载课程 CPU。

## 5. 注意

- 新程序只通过 append 添加；旧测试内容未改动。
- 误译码测试针对“控制信号把非 beq 当 beq”的错误；正常 CPU 上它们验证 PC+4 和写回。
- 课程 DM 仍只有 3072 字，负 offset/高位 base 测试仅使用合法有效地址。
- exe 未签名。
