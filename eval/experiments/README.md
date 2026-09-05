# 预注册配置实验

每个实验由三类文件组成：`*-configs.json` 固定 baseline 和 candidate，`*-plan.json` 在运行前声明样本数、输入指纹与采用标准，`*-result.json` 保存脱敏聚合结果和实际输入指纹。原始本地结果保存在被 Git 忽略的 `eval/results/`。任务或配置发生变化时，判定器会拒绝沿用旧计划。

计划中的 `criteria.resourceBasis` 可显式选择 `per-run` 或 `per-success`。前者约束单次调用资源，后者用“平均资源 / 成功率”估算获得一次成功结果的资源；省略时保持 `per-run`。两种口径代表不同产品目标，必须在运行前选择，不能根据结果事后切换。

运行和判定示例：

```powershell
npm run eval -- --configs eval/experiments/bounded-mean-configs.json --tasks eval/tasks --task bounded-mean --repeats 5 --keep-failures --output eval/results/bounded-mean-5x2.json
npm run eval:assess -- --plan eval/experiments/bounded-mean-plan.json --result eval/results/bounded-mean-5x2.json --output eval/results/bounded-mean-5x2-assessment.json
```

前两个实验均为 `inconclusive`：baseline 在 `bounded-mean` 和 `allocate-by-weight` 上都是 5/5 成功，没有满足“至少一次 baseline 失败”的区分度门槛。两个候选提示词都没有提高成功率；其中分配任务的 invariant checklist 虽将 `tool-failure-unrecovered` 发生率从 60% 降到 0%，但平均耗时增加 59.2%、平均成本增加 31.0%，超过预注册预算。因此两个提示词都不采用。

第三个实验使用独立的 `eval/experiment-tasks/allocate-extreme-weights.test.json` 检验数值稳定性遗漏。该任务不加入常规 10 任务基准，避免为了制造区分度改变已建立的基准口径。baseline 成功率为 20%，numeric-invariants 候选为 80%，隐藏验收通过率从 20% 提高到 100%；但候选平均耗时增加 330.4%、平均成本增加 289.5%，超过预注册的 50% 预算，因此结论为 `reject`。唯一一个候选失败样本通过隐藏验收，但 Agent 自己写入了错误的公开测试期望，按完整任务契约仍应判失败。

第四个实验把候选提示词压缩为一条数值 guardrail。baseline 再次为 20%，候选达到 100%；平均耗时增幅降至 118.3%，平均成本增幅降至 104.6%，但仍超过预注册的单次运行预算，结论仍为 `reject`。事后探索性计算显示，若失败任务需要重试，则候选的期望成功成本约低 59%、期望成功耗时约低 56%；该口径没有预注册，不能用于改写本轮结论，只用于设计后续复现实验。

第五个实验在运行前改用 `per-success` 资源口径，并保持同一任务和精简候选。baseline 为 0/5，候选为 5/5，质量改善再次出现；但 baseline 没有观测成功，单轮数据无法估算每成功资源，因此结论为 `inconclusive`，不能自动采用。第四、第五轮合并观察为 baseline 1/10、候选 10/10，这支持 guardrail 的质量收益，但合并口径未预注册且样本仍小，只作为后续扩大样本或跨任务复现的依据。

第六个实验把同一精简 guardrail 原样迁移到 `weightedMean`。baseline 完整任务成功率和隐藏验收通过率均为 0/5；候选完整成功率为 1/5，隐藏验收通过率为 3/5。两个候选样本实现通过隐藏验收但写错了公开测试期望，因此仍按完整任务失败。由于 baseline 零成功，`per-success` 资源仍不可估算，正式结论为 `inconclusive`。结果说明该 guardrail 对实现数值稳定性有一定帮助，但没有复现整数分配任务上的强完整成功收益，不应升级为通用数值算法默认提示词。
