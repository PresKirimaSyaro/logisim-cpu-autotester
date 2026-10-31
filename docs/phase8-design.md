# Phase 8 设计 — 随机测试与 EXE 同目录记录

## 1. 随机测试套件

新增 `random` 套件，独立于固定定向集：

```text
generateRandomTests(layout, {count, seed, instructions})
```

每个程序：

1. 用 `ori`/`lui` 初始化 8 个数据寄存器为确定性随机 32 位值；
2. 设置非零 `$s7` 为 scratch 区基址；
3. 生成 10..28 条随机数据指令：`add/sub/ori/lui/lw/sw`（可选 `sll`）；
4. 以低概率插入**仅前向**的 `beq`，跳过的指令仍收敛到后续标签，保证终止；
5. 将全部数据寄存器写入 signature DM，并写一个非零标记；
6. 用真实参考解释器运行到唯一终点，得到精确 dynamic steps 和 final DM signature。

同一 `seed` 完全可复现；不同 seed 不同。程序只使用当前 `config.instructions` 中的指令。`ori` 和 `sw` 是随机套件生成签名/常量的最低要求，不满足时返回明确配置错误。

CLI：

```sh
npm run test:cpu -- --suite random --seed 1234 --seed-count 10
```

GUI 工作台选择 `random · 随机程序`，填写随机种子和程序数量。

## 2. 记录目录

`apps/desktop/main.ts`：

```text
app.isPackaged ? dirname(process.execPath) : repositoryRoot
  └─ test-records/
       ├─ settings.json
       └─ history/
            ├─ <id>.json
            └─ <id>.meta.json
```

- 便携版记录与 EXE 同目录，复制整个目录即可迁移。
- 开发版记录在仓库 `test-records/`（gitignore）。
- 历史页/工作台显示 `AppState.dataDir`。
- 不写系统 `%APPDATA%`；程序目录可写时完全便携。

## 3. 删除记录

- `HistoryStore.delete(id)` 删除 `<id>.json` 和 `<id>.meta.json`。
- `TesterService.deleteHistory(id)`：
  - 运行中拒绝删除；
  - 清除报告缓存；
  - 若删除的是 `lastReportId`，切换到剩余最新记录；
  - 发出 state 更新。
- IPC `history:delete`；main 同时关闭对应结果窗口。
- 历史页每条记录有“删除”按钮，带不可恢复确认。

## 4. 打包

`scripts/package-win.mjs` 仍构建 `release/Logisim CPU Tester`，额外：

- 不复制根目录 `test-records`，首次启动在 EXE 旁边创建；
- 保持 `test-suites`、fixtures、Java runtime、外部 suite 可编辑；
- 重新构建并 smoke 验证记录目录位置、删除/随机功能。
