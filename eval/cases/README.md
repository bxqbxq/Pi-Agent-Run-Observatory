# 评测案例档案

本目录保存经过脱敏的稳定案例汇总和事件案例。前两份汇总可由 `/run-diff` 读取，事件案例由 `src/cases.ts` 校验；它与 `eval/results/` 不同：后者是被 Git 忽略的原始本地运行结果，可能含较长的验证输出和临时路径。

`add-validation-observed-recovery.json` 提供一组真实的失败与成功运行，用于验证 `/run-diff` 能否正确展示状态、验证结果、耗时和资源差异。对应的可重跑配置位于 `eval/demo-configs.json`；失败由公开测试捕获，隐藏验收通过，说明问题来自 Agent 生成的实现与测试不一致，而不是 runner 启动或验收基础设施异常。

`add-validation-replication-3x2.json` 提供同一任务的多次运行，用于验证 `/run-diff` 对聚合指标和重复样本的处理。案例中的配置名称是历史记录的一部分；这些数据只作为命令回归夹具，不用于评价或推荐模型提示词。

`tool-failure-unrecovered-trace.json` 是一次真实 Pi 评测运行的脱敏失败案例。它保留相关事件链、规则实际 finding、人工预期 finding 和脱敏限制，用于验证事件证据可回溯性；它不是完整运行日志，也不用于推断模型总体能力。

```text
/run-diff baseline-deepseek checklist-deepseek --file eval/cases/add-validation-observed-recovery.json
/run-diff baseline-deepseek checklist-deepseek --file eval/cases/add-validation-replication-3x2.json
```
