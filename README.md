# Pi-Agent-Run-Observatory

面向 pi 主 Agent 会话的本地运行诊断与评测插件。它把运行事件脱敏后写入 JSONL，通过确定性规则识别工具失败未恢复、无效重复调用、改动未验证和验证失败被忽略，并支持按需生成 LLM 解释。

```text
Pi lifecycle/tool events -> redact + JSONL -> deterministic analyzer -> JSON/Markdown/HTML
                                                               \-> optional LLM explanation
Fixtures + model configs -> isolated temp workspaces -> validations -> comparison summary
```

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
/run-review --run <runId> --format json
```

`--explain` 使用当前模型对规则证据做按需解释；解释不会覆盖规则结论，也不会计入主 Agent 的统计。

## 评测

先复制示例配置并填入可用模型：

```powershell
Copy-Item eval/configs.example.json eval/configs.json
npm run eval -- --configs eval/configs.json
```

评测任务位于 `eval/tasks/`，每个任务从 `fixtures/` 的同一基线复制到独立临时工作区，并串行执行声明的验证命令。

合成负向行为探针单独位于 `eval/failure-tasks/`，不会混入正常任务的成功率。运行该目录时，汇总中的 `expectationPassRate` 表示端到端结果是否符合任务声明的失败状态、finding、验证结果和改动状态：

```powershell
npm run eval -- --configs eval/configs.json --tasks eval/failure-tasks --output eval/results/failure-latest.json
```

正常基准固定为 `eval/tasks/` 下的 8 个任务；例如两个配置各跑一次：

```powershell
npm run eval -- --configs eval/configs.json --tasks eval/tasks --output eval/results/8x2.json
```

负向任务的 `status` 预期为 `failed` 并不代表评测器失效。`expectationPassRate` 同时受模型是否按提示触发场景、插件是否采集到事件和规则是否正确识别影响，不能单独当作诊断准确率。规则正确性应以确定性的单元和集成测试为主，真实模型探针只作为端到端补充；正常任务成功率和负向探针预期匹配率也不能合并成一个分数。

任务默认不向 Agent 开放命令工具，由 runner 在结束后执行外部验证。需要验证 Agent 如何处理内部失败命令时，任务必须显式声明 `agentTools` 和 `agentRunsValidation: true`；分析器只把失败验证之后出现的助手完成消息视为“验证失败被忽略”的证据。

## 边界

本项目不替代 pi 原生 session JSONL，不覆盖 `pi-subagents` 的子代理观测，不上传云端，也不自动修复 Agent。完整设计见 [spec.md](./spec.md)。

## 演示路径

1. 让 Agent 修改 fixture 后故意跳过测试，运行 `/run-review` 查看 `change-without-verification` 及证据。
2. 在 `.pi/run-review/config.json` 中补充项目验证命令，重新运行同一任务和测试。
3. 用两个模型/提示词配置执行 `npm run eval -- --configs eval/configs.json`，比较成功率、unknown 比例、finding 分布和 P95 耗时。

## 已知限制

- 规则基于可观测事件推断，不能证明所有替代工具路径都已恢复失败。
- 文件改动目前主要依据写入类工具事件，尚未逐次保存 Git diff 快照。
- Agent 结果具有随机性，模型比较应重复运行并报告样本量。
- LLM explanation 只提供解释，不得覆盖规则结论。
