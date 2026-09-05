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

## 安装

从本地仓库安装：

```powershell
pi install D:\path\to\pi-plugins
```

也可以从 GitHub 安装：

```powershell
pi install git:github.com/bxqbxq/Pi-Agent-Run-Observatory
```

安装后正常启动 `pi` 即会加载扩展。交互模式中执行 `/reload` 可重新加载已安装的扩展；开发时也可以不安装，直接临时加载当前源码：

```powershell
pi -e ./extensions/run-review.ts
```

`pi -e` 仅适合快速试用；需要验证热加载时，应使用上述 package 安装方式，或将扩展放入 `.pi/extensions/` 自动发现目录。卸载本地或 Git package 时，向 `pi remove` 传入安装时使用的同一来源：

```powershell
pi remove D:\path\to\pi-plugins
pi remove git:github.com/bxqbxq/Pi-Agent-Run-Observatory
```

本仓库已在 Windows + pi 0.84.2 上验证本地路径安装、`/reload` 和卸载；GitHub 安装命令遵循 pi package 标准格式，未纳入离线测试。

## 使用

运行结束后，报告默认写入 `.pi/run-review/reports/`，原始脱敏事件写入 `.pi/run-review/events.jsonl`。交互模式中可执行：

```text
/run-review
/run-review --explain
/run-review --run <runId> --format json
/run-diff <baselineRunId> <candidateRunId>
/run-diff <baselineConfigId> <candidateConfigId> --file eval/results/8x2.json
```

`--explain` 使用当前模型对规则证据做按需解释；解释不会覆盖规则结论，也不会计入主 Agent 的统计。

`/run-diff` 传入两个 `runId` 时比较单次运行；传入两个配置 ID 时比较评测集合中的成功率、失败率、unknown、隐藏验收、finding、平均/P95 耗时、turn、工具、token 和成本。配置比较可用 `--file` 指定评测汇总；省略时会从 `eval/results/` 中选择最新且同时包含两个配置的有效汇总。旧报告没有采集到 token 或成本时，相应值显示为 `null`，不会按 0 处理。

## 隐私模式

默认 `captureFullContent` 为 `false`。事件日志不会保存用户 Prompt、助手回复、工具参数或 provider payload 原文：消息只记录长度和完成/失败信号，参数只记录字段结构和经过脱敏后计算的 SHA-256 指纹。指纹用于判断重复调用，只表示两个参数是否相同，不是对原文的加密存储。工具结果和错误仍会经过凭据、项目路径、外部绝对路径替换及长度截断后保存。

只有在 `.pi/run-review/config.json` 中显式设置 `"captureFullContent": true` 时，才会保存经过凭据和路径脱敏的完整内容。JSON、Markdown 和 HTML 报告都会以 `captureMode: full` 或“采集模式：full”标记该模式。修改配置不会清理此前生成的事件和报告，需要由用户按本地数据保留策略自行处理旧文件。

事件和报告在读写边界执行运行时 schema 校验。JSONL 中单个损坏或版本不兼容的事件会被跳过并输出警告，其余有效事件继续参与分析；配置损坏或字段类型错误时整份配置会被忽略并回退安全默认值。日志或报告写入失败只产生警告，不应中断主 Agent 任务。

同一 run 的事件通过串行队列追加写入，并以 `toolCallId` 关联交错完成的工具调用。`agent_end` 只记录底层结束事件，最终报告在 `agent_settled` 后异步生成。单次运行默认最多采集 10000 条普通事件，可通过 `maxEventsPerRun` 调整；达到上限后保留最终 `run_ended`，并且每个 run 只警告一次。

## 评测

先复制示例配置并填入可用模型：

```powershell
Copy-Item eval/configs.example.json eval/configs.json
npm run eval -- --configs eval/configs.json
```

评测任务位于 `eval/tasks/`，每个任务从 `fixtures/` 的同一基线复制到独立临时工作区，并串行执行声明的验证命令。正常任务可通过 `acceptance` 声明必改文件、禁改文件和隐藏验收夹具；隐藏文件只在 Agent 结束后复制到 `.eval/acceptance/`，不会提前暴露给模型。

合成负向行为探针单独位于 `eval/failure-tasks/`，不会混入正常任务的成功率。运行该目录时，汇总中的 `expectationPassRate` 表示端到端结果是否符合任务声明的失败状态、finding、验证结果和改动状态：

```powershell
npm run eval -- --configs eval/configs.json --tasks eval/failure-tasks --output eval/results/failure-latest.json
```

正常基准当前包含 `eval/tasks/` 下的 10 个任务；例如两个配置各跑一次：

```powershell
npm run eval -- --configs eval/configs.json --tasks eval/tasks --output eval/results/10x2.json
```

用 `--task` 只运行一个任务，用 `--repeats` 对每个“配置 x 任务”组合重复采样。每条结果会记录从 1 开始的 `sampleIndex`，配置汇总中的 `runs` 是全部重复样本数：

```powershell
npm run eval -- --configs eval/configs.json --tasks eval/tasks --task add-validation --repeats 3 --output eval/results/add-validation-3x2.json
```

仓库还保留一份仅用于复现演示案例的固定配置 `eval/demo-configs.json`。它不是实验框架，也不用于证明某种提示词更优；需要重跑“baseline → checklist”案例时执行：

```powershell
npm run eval -- --configs eval/demo-configs.json --tasks eval/tasks --task add-validation --output eval/results/demo-add-validation-2x1.json
```

使用 `--keep-failures` 时，runner 会在结果文件旁为每个失败运行导出证据包；也可用 `--failure-artifacts <path>` 指定目录。证据包包含 manifest、再次脱敏的事件、JSON/Markdown/HTML 报告、验证输出、配置快照和仅含文件名及增删行数的 diff 摘要。它不会保留完整临时工作区或源码 diff：

```powershell
npm run eval -- --configs eval/configs.json --tasks eval/failure-tasks --task no-change --keep-failures --output eval/results/failure-smoke.json
```

结果中的 `changedFiles` 记录 Agent 在隐藏夹具注入前产生的真实改动；`acceptance` 给出单次任务级验收及失败原因。汇总中的 `acceptancePassRate` 是配置在带验收任务上的语义通过率，较旧版仅依赖“任意改动 + 基线测试通过”的 `successRate` 更严格。

负向任务的 `status` 预期为 `failed` 并不代表评测器失效。`expectationPassRate` 同时受模型是否按提示触发场景、插件是否采集到事件和规则是否正确识别影响，不能单独当作诊断准确率。规则正确性应以确定性的单元和集成测试为主，真实模型探针只作为端到端补充；正常任务成功率和负向探针预期匹配率也不能合并成一个分数。

任务默认不向 Agent 开放命令工具，由 runner 在结束后执行外部验证。需要验证 Agent 如何处理内部失败命令时，任务必须显式声明 `agentTools` 和 `agentRunsValidation: true`；分析器只把失败验证之后出现的助手完成消息视为“验证失败被忽略”的证据。

## 边界

本项目不替代 pi 原生 session JSONL，不覆盖 `pi-subagents` 的子代理观测，不上传云端，也不自动修复 Agent。完整设计见 [spec.md](./spec.md)。

## 演示路径

1. 用 `/run-review` 查看最近一次真实运行的诊断证据和报告路径。
2. 用 `/run-review --explain` 检查解释是否引用证据且不改变规则结论。
3. 用上面的 `eval/demo-configs.json` 命令重跑固定演示配置，再用 `/run-diff baseline-deepseek checklist-deepseek --file eval/results/demo-add-validation-2x1.json` 验证本次配置集合比较；也可用 `/run-diff baseline-deepseek checklist-deepseek --file eval/cases/add-validation-observed-recovery.json` 读取仓库内的脱敏稳定案例。案例和配置仅作为稳定功能示例，不用于宣称某种提示词更优。
4. 用两个模型配置执行完整基准，比较成功率、unknown 比例、隐藏验收、finding 分布和 P95 耗时。

## 已知限制

- 规则基于可观测事件推断，不能证明所有替代工具路径都已恢复失败。
- 文件改动目前主要依据写入类工具事件，尚未逐次保存 Git diff 快照。
- Agent 结果具有随机性，模型比较应重复运行并报告样本量。
- LLM explanation 只提供解释，不得覆盖规则结论。
