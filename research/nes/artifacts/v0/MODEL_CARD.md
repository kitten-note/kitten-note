# EFT-NES v0 - Model Card

## 基本信息
- 产物: `research/nes/artifacts/v0/`（hdc.npz / softmax.npz / browser/）
- 生成时间: 2026-10-06T20:46:39+0800
- 设备: cuda（训练）；推理为纯查表/点积，可运行于浏览器 WASM

## 这是什么
- 一个 **depth-1 编辑预测器**：软注意力（softmax）在固定特征场上的线性打分，
  输出类型化编辑原子（NO_EDIT / FIX_CHAR / DEL_CHAR / INS_CHAR / DEL_SPAN / INS_SPAN_COPY / FMT_BULLET）。
- 不生成自由文本；`INS_SPAN_COPY` 的载荷必须可溯源（copy-only 接地）。

## 训练数据
- 语料: 中文维基百科条目导语 8015 篇 / 1520566 字符（CC BY-SA 4.0，不随仓库分发）
- 合成: 扰动即真值（同音字/标点/赘字/漏标点/短语省略/列表符）+ 近失负例；train 使用文档级 6 轮增广
- 划分: 文档级 train/val/test（无文档泄漏）
- 样本: {'train': 200000, 'val': 2150, 'test': 2203}

## 指标（test，文档留出）
- 最佳模型: **softmax**
- top-1 / top-3: 0.7090 / 1.0000
- 编辑门控 AUC: 0.9066
- 门控 @ 目标精确率 0.88: P=0.916 R=0.663 F1=0.769
- ECE（校准误差）: 0.0509
- 接地率（INS_SPAN_COPY）: 载荷在文档/语料中可溯源 1.000（n=95）
- 参考延迟（Python）: feature_extraction=0.037ms, hdc_scoring=0.211ms, softmax_scoring=0.029ms

## 已知局限
- 训练信号来自规则扰动（合成域），尚未包含真实用户编辑流（wiki 修订历史是下一步）。
- FMT_BULLET 类样本稀疏（<2%），召回预期偏低。
- 位置精度以近失负例代理评估，尚未做全位置扫掠评测。
- 内容层为最长匹配（∞-gram-lite），论文版将替换为后缀数组/自动机。

## 集成说明
- 浏览器参考实现: `research/nes/browser/eft.mjs`（与 Python 逐位对齐，金标向量测试 `test_infer.mjs`）
- 交互建议: 决策层（本地、<10ms）→ 门控（精度优先，宁缺毋滥）→ 原子应用器（可回滚）→ 内容层填充载荷

## 许可与出处
- 代码: GPL-3.0（同仓库）
- 语料: zh.wikipedia.org，CC BY-SA 4.0（仅用于研究训练，不随仓库分发）
- 模型权重（本产物）: 由上述数据训练所得，随仓库以 GPL-3.0 分发