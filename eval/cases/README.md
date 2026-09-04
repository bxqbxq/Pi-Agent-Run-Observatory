# 评测案例档案

本目录保存经过脱敏、可由 `/run-diff` 读取的稳定案例汇总。它与 `eval/results/` 不同：后者是被 Git 忽略的原始本地运行结果，可能含较长的验证输出和临时路径。

`add-validation-observed-recovery.json` 记录一次真实观察到的 baseline 失败和加入检查清单提示词后的成功运行。失败由公开测试捕获，隐藏验收通过，说明问题是 Agent 生成的实现与测试不一致，而不是 runner 启动或验收基础设施异常。

`add-validation-replication-3x2.json` 记录随后在相同任务、模型、thinking 和工具条件下进行的三次重复实验。两种配置均为 3/3 成功，检查清单没有提高成功率，反而增加了耗时、工具调用、token 和成本。因此前一个文件只能用于演示一次“失败、定位、调整、重跑”的真实过程，不能用于宣称该提示词普遍更优。

```text
/run-diff baseline-deepseek checklist-deepseek --file eval/cases/add-validation-observed-recovery.json
/run-diff baseline-deepseek checklist-deepseek --file eval/cases/add-validation-replication-3x2.json
```
