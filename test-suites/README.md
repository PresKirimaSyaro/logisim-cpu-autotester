# 外部测试程序集

`course.json` 是应用运行时读取的**唯一内置测试程序集**。直接编辑此 JSON 即可增删/修改测试，不需要重新编译或重新打包。

## 文件格式

```json
{
  "schemaVersion": 1,
  "name": "course-directed",
  "tests": [
    {
      "id": "add-basic",
      "name": "add 5 + 7",
      "category": "add-sub",
      "description": "ordinary addition",
      "assembly": "    ori $t0, $zero, 5\n    ori $t1, $zero, 7\n    add $t2, $t0, $t1\n    sw $t2, 256($zero)\n",
      "steps": 4,
      "signature": [{"index": 0, "expected": 12}],
      "suites": ["basic", "full", "alu"],
      "tags": ["custom"],
      "seed": null,
      "requiredRamBytes": 260
    }
  ]
}
```

- `assembly` 是完整的 MIPS 汇编，标签可用；只能使用当前启用的指令。
- `steps` 是精确动态指令数；必须与参考执行一致。
- `signature` 的 `index` 相对 `signatureBase`（课程逻辑 DM 为 `0x100`），不是绝对字节地址。
- `suites` 决定 `basic/full/branch/memory/alu` 选哪些测试；`full` 仍包含所有适用测试。
- `requiredRamBytes` 可选，用于拒绝地址范围超过当前逻辑 DM 的测试（例如课程最后 RAM 字测试不能在 256 字 Phase 2 CPU 上运行）。
- `seed` 可为 null 或确定性的非负整数。

## 命令

```sh
npm run test:cpu -- --circuit fixtures/course-cpu.circ --config fixtures/course.config.json \
  --suite full --suite-file test-suites/course.json
```

GUI 从安装目录的 `test-suites/course.json` 读取；每次开始测试都会重新读取，因此修改后无需重启。

`course.json` 由 `npm run build && node scripts/export-test-suite.mjs` 从当前生成器导出，作为迁移/维护工具；应用/CLI 的正常运行路径不再调用硬编码 `generateDirectedTests`。
