# pi-run-review

面向 pi 主 Agent 会话的本地运行诊断与评测插件。它把运行事件脱敏后写入 JSONL，通过确定性规则识别工具失败未恢复、无效重复调用、改动未验证和验证失败被忽略，并支持按需生成 LLM 解释。

## 开发

要求 Node.js 22+ 和已安装的 pi。

```powershell
npm install
npm test
npm run typecheck
```

## 在 pi 中试用

```powershell
pi -e ./extensions/run-review.ts
```

项目内自动加载时，将扩展放在 `.pi/extensions/`，或通过 package 的 `pi.extensions` 配置加载。

运行结束后，报告默认写入 `.pi/run-review/reports/`，原始脱敏事件写入 `.pi/run-review/events.jsonl`。交互模式中可执行：

```text
/run-review
/run-review --explain
```

`--explain` 使用当前模型对规则证据做按需解释；解释不会覆盖规则结论，也不会计入主 Agent 的统计。

## 评测

先复制示例配置并填入可用模型：

```powershell
Copy-Item eval/configs.example.json eval/configs.json
npm run eval -- --configs eval/configs.json
```

评测任务位于 `eval/tasks/`，每个任务从 `fixtures/` 的同一基线复制到独立临时工作区，并串行执行声明的验证命令。

## 边界

本项目不替代 pi 原生 session JSONL，不覆盖 `pi-subagents` 的子代理观测，不上传云端，也不自动修复 Agent。完整设计见 [spec.md](./spec.md)。
