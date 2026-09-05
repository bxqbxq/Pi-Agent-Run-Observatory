# 预注册配置实验

每个实验由三类文件组成：`*-configs.json` 固定 baseline 和 candidate，`*-plan.json` 在运行前声明样本数、输入指纹与采用标准，`*-result.json` 保存脱敏聚合结果和实际输入指纹。原始本地结果保存在被 Git 忽略的 `eval/results/`。任务或配置发生变化时，判定器会拒绝沿用旧计划。

运行和判定示例：

```powershell
npm run eval -- --configs eval/experiments/bounded-mean-configs.json --tasks eval/tasks --task bounded-mean --repeats 5 --keep-failures --output eval/results/bounded-mean-5x2.json
npm run eval:assess -- --plan eval/experiments/bounded-mean-plan.json --result eval/results/bounded-mean-5x2.json --output eval/results/bounded-mean-5x2-assessment.json
```

前两个实验均为 `inconclusive`：baseline 在 `bounded-mean` 和 `allocate-by-weight` 上都是 5/5 成功，没有满足“至少一次 baseline 失败”的区分度门槛。两个候选提示词都没有提高成功率；其中分配任务的 invariant checklist 虽将 `tool-failure-unrecovered` 发生率从 60% 降到 0%，但平均耗时增加 59.2%、平均成本增加 31.0%，超过预注册预算。因此两个提示词都不采用。

第三个实验使用独立的 `eval/experiment-tasks/allocate-extreme-weights.test.json` 检验数值稳定性遗漏。该任务不加入常规 10 任务基准，避免为了制造区分度改变已建立的基准口径。baseline 成功率为 20%，numeric-invariants 候选为 80%，隐藏验收通过率从 20% 提高到 100%；但候选平均耗时增加 330.4%、平均成本增加 289.5%，超过预注册的 50% 预算，因此结论为 `reject`。唯一一个候选失败样本通过隐藏验收，但 Agent 自己写入了错误的公开测试期望，按完整任务契约仍应判失败。
