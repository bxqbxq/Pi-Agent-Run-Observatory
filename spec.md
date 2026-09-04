# pi-run-review 规格说明

状态：已确认，MVP 规格

## 1. 摘要

`pi-run-review` 是一个面向 pi 主 Agent 会话的本地、隐私优先运行诊断与评测插件。

它将 pi 的运行事件归一化为一次任务的执行记录，使用可解释的确定性规则识别失败和低质量模式，并提供按需的 LLM 解释。插件还提供一个独立的基准任务 runner，用于比较不同模型和系统提示词配置在相同任务上的表现。

项目不替代 pi 原生 session JSONL，也不替代 `pi-subagents` 的子代理观测。它关注的是主 Agent 的工作质量：失败发生在哪里、是否正确恢复、代码改动是否完成验证，以及配置变化是否带来可重复的改善。

## 2. 背景与问题

Agent 的最终报错通常不能直接说明根因。常见情况包括：

- 工具调用失败后，Agent 没有修正参数或改变策略；
- 同一类搜索、读取或命令被重复执行，却没有产生新的进展；
- Agent 修改了代码，但没有运行对应的测试、构建或类型检查；
- 验证命令失败后，Agent 仍然宣称任务完成；
- 不同模型或提示词的优劣缺少统一、可复现的比较方法。

只保存完整会话日志不能解决这些问题。用户需要的是带证据的诊断，以及可以复跑的评测结果。

## 3. 目标

### 3.1 MVP 目标

1. 捕获一次 pi 主 Agent 运行的结构化事件。
2. 在持久化前对事件进行脱敏和截断。
3. 使用确定性规则诊断四类问题：
   - 工具失败未恢复；
   - 无效重复调用；
   - 改动未验证；
   - 验证失败被忽略。
4. 每条诊断输出证据链、严重级别、置信度和建议动作。
5. 支持 `/run-review` 查看当前或最近一次运行的 Markdown 报告。
6. 支持 `/run-review --explain`，按需调用 LLM 生成人类可读解释。
7. 使用独立临时工作区和固定 Git 基线运行 8～12 个基准任务，比较模型和系统提示词配置；正常任务支持隐藏验收，避免仅凭任意改动和基线测试通过判定完成。
8. 输出稳定的版本化 JSON 报告，并渲染为 Markdown 和静态 HTML。

### 3.2 非目标

- 不做云端数据上传、团队协作或远程 Dashboard。
- 不做自动修复、自动续跑或自动选择恢复策略。
- 不替代 pi 原生会话存储。
- 不覆盖 `pi-subagents` 的子代理监控能力。
- 不承诺完全确定性的 Agent 回放。
- 首版不引入 SQLite、`better-sqlite3` 或其他原生数据库依赖。

## 4. 用户与使用场景

主要用户是使用 pi 进行编码任务的开发者，以及需要比较 Agent 配置的工程师。

### 场景 A：失败复盘

用户完成一次任务后执行 `/run-review`，看到失败发生的工具调用、后续恢复路径和相关验证证据。

### 场景 B：配置比较

用户准备一个基准任务集，使用两个模型或系统提示词配置分别运行，获得成功率、`unknown` 比例、诊断分布、耗时、token 和成本对比。

### 场景 C：面试演示

演示一个“首次失败 → trace 定位 → 修改配置 → 重跑改善”的案例，并展示规则测试和评测数据。

## 5. 核心概念

### 5.1 Run

一次 `agent_start` 到 `agent_settled` 的生命周期视为一个 `run`。使用 `agent_settled` 作为结束边界，因为 `agent_end` 之后可能发生自动重试、上下文压缩或队列续跑。

每个 run 至少包含：

- `runId`：插件生成的唯一标识；
- `sessionId`：pi 会话标识；
- 项目路径和 Git commit；
- 模型及版本；
- 开始与结束时间；
- 规范化事件列表；
- 最终 outcome；
- findings 列表。

### 5.2 Event

事件是追加写入的最小事实单元。事件包含 `eventId`、`runId`、`timestamp`、`type` 和版本化 `payload`。

并行工具调用的完成顺序不保证与开始顺序一致，分析器必须使用 `toolCallId` 关联开始、更新、完成和结果事件，不能假设工具事件天然线性排列。

## 6. Pi 事件采集

插件入口为 TypeScript 模块，使用 pi `ExtensionAPI`：

- `agent_start`：创建 run；
- `agent_end`：记录低层 Agent 结束，但不立即关闭 run；
- `agent_settled`：关闭 run 并触发分析；
- `turn_start` / `turn_end`：记录回合边界；
- `message_*`：提取用户消息、助手消息、工具结果和 stop reason 的受控摘要；
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`：记录工具生命周期；
- `tool_call` / `tool_result`：补充工具调用与结果信息；
- `model_select`：记录模型配置变化；
- `before_provider_request` / `after_provider_response`：在可用时记录模型请求和响应的状态、耗时及 usage 摘要。

没有直接名为 `model_called` 的事件。模型调用记录由 provider request/response 事件与助手消息中的 usage 组合得到。

## 7. 数据存储

### 7.1 目录布局

默认使用项目目录下的 `.pi/run-review/`：

```text
.pi/run-review/
  events.jsonl
  reports/
    <runId>.json
    <runId>.md
    <runId>.html
  config.json
```

用户可以通过配置覆盖存储目录。事件采用 JSONL 追加写入，报告在 run settled 后一次性生成。MVP 通过扫描 JSONL 聚合数据，不维护独立数据库索引。

### 7.2 事件 schema

```json
{
  "schemaVersion": 1,
  "eventId": "evt_01...",
  "runId": "run_01...",
  "sessionId": "session_01...",
  "timestamp": "2026-09-03T12:00:00.000Z",
  "type": "tool_execution_end",
  "toolCallId": "call_01...",
  "payload": {
    "toolName": "bash",
    "isError": true,
    "exitCode": 1,
    "durationMs": 842,
    "summary": "脱敏后的截断摘要"
  }
}
```

必填字段的名称和类型构成内部稳定契约。未来不兼容变更必须递增 `schemaVersion`。

### 7.3 报告 schema

```json
{
  "schemaVersion": 1,
  "run": {
    "runId": "run_01...",
    "sessionId": "session_01...",
    "model": "provider/model@version",
    "gitCommit": "abc123",
    "startedAt": "2026-09-03T12:00:00.000Z",
    "settledAt": "2026-09-03T12:02:00.000Z",
    "durationMs": 120000,
    "turnCount": 6,
    "toolCount": 14,
    "usage": {},
    "cost": null
  },
  "outcome": {
    "status": "failed",
    "source": "rule",
    "verification": "failed"
  },
  "findings": [
    {
      "findingId": "finding_01...",
      "ruleId": "verification-failure-ignored",
      "severity": "high",
      "confidence": "high",
      "evidence": ["evt_12", "evt_15", "evt_17"],
      "trigger": "验证命令退出码为 1，后续没有成功验证事件，run 结束",
      "recommendation": "先修复验证失败，再重新执行验证命令"
    }
  ]
}
```

`outcome.status` 允许 `success`、`failed`、`partial` 和 `unknown`。硬性验证失败必须为 `failed`；缺少可执行验证结果时为 `unknown`，不得强行判定成功。

## 8. 隐私与脱敏

### 8.1 默认保存

- 模型标识及版本；
- 工具名称和工具类别；
- 参数结构摘要及哈希；
- 退出码、错误标志、耗时；
- token usage、stop reason 和 provider 状态码；
- Git commit；
- 截断后的错误或结果摘要。

### 8.2 默认不保存

- 完整用户 Prompt；
- 完整模型输出；
- 完整工具输出；
- 环境变量原文；
- 未脱敏的命令参数和文件内容。

### 8.3 脱敏规则

持久化前执行脱敏：

- 删除或替换 API key、Bearer token、密码、私钥等常见凭据格式；
- 替换环境变量值；
- 对绝对路径按项目根目录做相对化，无法相对化时截断；
- 摘要限制最大字符数；
- 工具参数保留结构化字段名，但对敏感字段做哈希或替换。

完整内容只有在用户显式开启 `captureFullContent` 后才允许保存，并在报告中标记该模式。

## 9. 诊断规则

所有规则均为纯函数：输入规范化事件和配置，输出零条或多条 finding。规则不调用 LLM，不修改工作区。

### 9.1 工具失败未恢复

触发条件：

1. 某个工具调用以错误结束；
2. 在配置的恢复窗口内，没有出现成功的同类操作、参数修正或替代工具路径；
3. run 随后结束，或继续执行但没有消除该失败影响。

高置信度证据至少包括失败事件和后续结束/结果事件。若存在可能的恢复操作但无法确认有效，输出 warning。

### 9.2 无效重复调用

调用参数经过 JSON key 排序、空白归一化、项目路径归一化后计算结构化哈希。

默认策略：在最近 5 次工具调用窗口内，同一工具出现 3 次相同调用，并且期间没有新的产物或状态变化时触发 warning；连续重复且没有推进证据时升级为 high-confidence。

### 9.3 改动未验证

改动候选来自 `write`、`edit`、补丁类工具事件，最终以 Git diff 确认文件实际发生变化。

验证候选来自：

- 任务声明的验证命令；
- 默认识别的 `test`、`build`、`typecheck`、`lint` 命令。

若确认存在代码改动，但在 run 结束前没有成功验证事件，输出 high-confidence 或 warning。无法识别验证命令时输出 `unknown`，不直接判定失败。

### 9.4 验证失败被忽略

触发条件：

1. 声明或识别出的验证命令退出码非 0；
2. 后续没有成功的同一验证或等价验证；
3. Agent 结束时将任务标记为完成，或没有说明该失败。

硬性验证失败直接将 outcome 设为 `failed`。证据包括失败验证事件、后续消息摘要和 run settled 事件。

## 10. LLM 解释

`/run-review --explain` 才触发解释调用，默认关闭。

发送给 LLM 的输入只包括：

- 已生成的 findings；
- 引用的事件证据；
- 脱敏后的摘要；
- 任务和验证元数据。

输出必须包含：

- 根因解释；
- 证据引用；
- 可执行建议；
- 不确定性说明。

解释调用记录为 `analysis` 类型，不计入被评测 Agent 的成功率、token、成本或工具调用统计。LLM 不得覆盖规则结论。

## 11. CLI 与 UI

### `/run-review`

分析当前已 settled 的 run，默认输出终端摘要，并写入 JSON 和 Markdown 报告。

选项：

- `--run <runId>`：查看指定 run；
- `--format markdown|json|html`：选择输出格式；
- `--explain`：按需生成 LLM 解释；
- `--full`：在已显式开启完整采集时显示更多内容。

### `/run-diff <baseline> <candidate>`

比较两个评测配置或两个报告集合，输出成功率、`unknown` 比例、诊断分布、平均耗时、token 和成本差异。

### 会话结束摘要

在 `agent_settled` 后通过 pi UI 输出一行摘要，包括 outcome、finding 数量、主要问题和报告路径。摘要不能阻塞 Agent 主流程。

## 12. 评测 runner

评测 runner 是独立 CLI，不在插件进程内递归启动 pi。

### 任务文件

首版使用 JSON：

```json
{
  "id": "add-pagination",
  "prompt": "给用户列表接口增加分页",
  "fixture": "fixtures/users-api",
  "validate": ["npm test", "npm run typecheck"],
  "acceptance": {
    "fixture": "eval/acceptance",
    "commands": ["node .eval/acceptance/check.mjs"],
    "requiredChanges": ["src/users.ts"],
    "forbiddenChanges": ["package-lock.json"]
  },
  "tags": ["backend", "coding"],
  "timeoutMs": 300000
}
```

每个任务必须有明确的验证命令，除非明确声明只能人工标注。

### 执行协议

1. 从同一个 Git 基线创建独立临时工作区。
2. 串行执行每个任务与配置组合。
3. 固定可配置的模型、系统提示词、工具集和运行参数。
4. 任务完成后运行声明的验证命令。
5. Agent 结束后再注入隐藏验收夹具并运行 acceptance commands；夹具不得提前暴露给 Agent。
6. 用 Git baseline 之后的真实改动文件检查 required/forbidden changes。
7. 收集 run-review JSON 报告和验证结果。
8. 清理临时工作区，保留报告和必要的脱敏产物。

### 比较指标

- `successRate`；
- `failedRate`；
- `unknownRate`；
- 四类 finding 的发生率；
- 平均和 P95 耗时；
- 平均 turn/tool 数量；
- input/output/total token；
- 成本（provider 有提供时）。
- `acceptancePassRate`：带任务级验收的运行中，隐藏验收和改动文件契约同时通过的比例；不能与 `successRate` 混为同一指标。

首版基准集包含 8～12 个手工任务，并补充从真实失败运行中脱敏、人工标注的案例。

## 13. 代码结构

```text
extensions/run-review.ts   # pi 扩展入口与事件适配
src/analyzer/               # 规范化、规则和 outcome 判定
src/schema/                 # 事件、报告和任务 schema
src/storage/                # JSONL 追加写入与扫描
src/render/                 # Markdown / HTML 渲染
src/redaction/              # 脱敏、截断和路径归一化
eval/run.ts                 # 外部评测 runner
fixtures/                   # 基准项目与任务
tests/                      # 规则、schema、脱敏和 runner 测试
README.md
spec.md
```

分析器、脱敏器和渲染器应尽量保持纯函数，便于脱离 pi 做单元测试。

## 14. 测试要求

### 单元测试

- 四类规则各至少覆盖：命中、未命中、证据不足；
- 并行工具完成顺序乱序时仍能正确关联 `toolCallId`；
- `agent_end` 后仍有事件时，run 不提前关闭；
- `agent_settled` 才生成最终报告；
- 规则优先级和 `unknown` 判定；
- 脱敏覆盖 token、环境变量、路径和长摘要；
- 报告 schema 版本校验。

### 集成测试

- 捕获一次真实 pi run；
- 工具失败后继续运行；
- 代码改动后测试失败；
- `/run-review --explain` 的分析调用不污染运行统计；
- runner 能从同一 Git 基线串行执行两个配置。

## 15. 性能与可靠性要求

- 事件写入采用追加方式，单个事件写入失败不得崩溃 Agent 主流程；
- 插件异常必须被隔离，并通过 UI 提示，不得阻断用户任务；
- 事件采集不等待 LLM；
- 终端摘要和报告生成应在 run settled 后异步完成；
- 默认摘要长度和单 run 事件数量受配置限制；
- 并发工具事件不依赖到达顺序。

## 16. 配置

配置文件默认为 `.pi/run-review/config.json`：

```json
{
  "storageDir": ".pi/run-review",
  "captureFullContent": false,
  "summaryMaxChars": 1000,
  "duplicateWindow": 5,
  "duplicateThreshold": 3,
  "recoveryWindow": 5,
  "verificationCommands": ["test", "build", "typecheck", "lint"],
  "autoSummary": true
}
```

配置读取失败时使用安全默认值，并给出警告。

## 17. 验收标准

项目达到以下条件视为 MVP 完成：

1. 能捕获并脱敏一次真实 pi 主 Agent run。
2. 四类规则都有单元测试、fixture 和稳定的 finding 输出。
3. `/run-review` 能输出终端摘要、JSON 和 Markdown。
4. `--explain` 能生成带事件证据引用的解释，且不改变规则结论。
5. 8～12 个基准任务能从同一个 Git 基线执行。
6. 能输出至少两个模型或系统提示词配置的对比结果。
7. 有一个“失败 → 定位 → 配置修改 → 重跑改善”的可复现演示。
8. README 包含安装、使用、架构图、隐私说明、已知限制和演示命令。
9. 插件异常、日志写入失败和缺失验证不会阻断 pi 主 Agent。

## 18. 分阶段实现

### Phase 1：事件与 schema

- 建立扩展入口；
- 接入生命周期和工具事件；
- 实现事件归一化、脱敏和 JSONL 存储；
- 添加 schema 测试。

### Phase 2：分析器

- 实现 outcome 判定；
- 实现四类规则；
- 建立固定事件 fixture；
- 输出版本化 JSON 报告。

### Phase 3：交互与渲染

- 实现 `/run-review`；
- 实现会话结束摘要；
- 添加 Markdown 和 HTML 渲染；
- 实现按需 LLM explain。

### Phase 4：评测闭环

- 实现 JSON 任务格式；
- 实现独立 runner 和临时工作区；
- 准备 8～12 个基准任务；
- 实现 `/run-diff` 和指标聚合。

### Phase 5：演示与发布准备

- 补充真实失败案例；
- 完成 README 和架构图；
- 验证安装、热加载和异常隔离；
- 明确已知限制，不承诺自动修复或完全回放。

## 19. 已知限制与风险

- 规则只能基于可观测事件推断，无法保证识别所有根因；
- 工具输出默认被截断，某些诊断可能缺少上下文；
- Git diff 不能代表所有外部副作用；
- LLM explain 的质量和成本取决于用户配置，但不影响规则结论；
- 不同模型的输出存在随机性，评测结果需要重复运行并报告样本量；
- pi API 和事件 schema 升级时需要适配层和版本测试；
- 与已有 `pi-subagents` 功能重叠的范围必须保持在主 Agent 质量诊断之外。

## 20. 面试叙事

项目应围绕以下工程问题展开，而不是只展示命令数量：

- 如何定义 Agent run 的稳定边界；
- 如何处理并行工具事件和事件关联；
- 如何让失败诊断可解释、可测试，而不是依赖不可验证的模型判断；
- 如何在准确率、隐私和日志完整性之间取舍；
- 如何设计固定基线和独立工作区，保证模型比较可复现；
- 如何使用 `unknown` 和证据链避免虚假的成功率；
- 插件自身的性能开销、异常隔离和 API 兼容策略。
