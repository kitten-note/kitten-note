"""
EFT / NES v0 - Model card generator.

Reads artifacts/v0/{config.json, metrics.json} and writes MODEL_CARD.md with
scope, training data, metrics, limitations and integration notes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
ART = BASE / "artifacts" / "v0"


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    config = json.loads((ART / "config.json").read_text(encoding="utf-8"))
    metrics = json.loads((ART / "metrics.json").read_text(encoding="utf-8"))
    results = metrics.get("results", {})
    best = max(results.values(), key=lambda r: r["top1"]) if results else {}
    gate = best.get("gate_at_threshold", {})

    lines = [
        "# EFT-NES v0 - Model Card",
        "",
        "## 基本信息",
        f"- 产物: `research/nes/artifacts/v0/`（hdc.npz / softmax.npz / browser/）",
        f"- 生成时间: {config.get('generated_at')}",
        f"- 设备: {config.get('device')}（训练）；推理为纯查表/点积，可运行于浏览器 WASM",
        "",
        "## 这是什么",
        "- 一个 **depth-1 编辑预测器**：软注意力（softmax）在固定特征场上的线性打分，",
        "  输出类型化编辑原子（NO_EDIT / FIX_CHAR / DEL_CHAR / INS_CHAR / DEL_SPAN / INS_SPAN_COPY / FMT_BULLET）。",
        "- 不生成自由文本；`INS_SPAN_COPY` 的载荷必须可溯源（copy-only 接地）。",
        "",
        "## 训练数据",
        f"- 语料: 中文维基百科条目导语 {config.get('corpus_articles')} 篇 / {config.get('corpus_chars')} 字符（CC BY-SA 4.0，不随仓库分发）",
        f"- 合成: 扰动即真值（同音字/标点/赘字/漏标点/短语省略/列表符）+ 近失负例；train 使用文档级 6 轮增广",
        f"- 划分: 文档级 train/val/test（无文档泄漏）",
        f"- 样本: {config.get('sample_counts')}",
        "",
        "## 指标（test，文档留出）",
    ]
    if best:
        lines += [
            f"- 最佳模型: **{best['name']}**",
            f"- top-1 / top-3: {best['top1']:.4f} / {best['top3']:.4f}",
            f"- 编辑门控 AUC: {best.get('gate', {}).get('auc', 0):.4f}",
            f"- 门控 @ 目标精确率 {config.get('target_precision')}: "
            f"P={gate.get('precision', 0):.3f} R={gate.get('recall', 0):.3f} F1={gate.get('f1', 0):.3f}",
            f"- ECE（校准误差）: {best['ece']:.4f}",
        ]
    grounding = metrics.get("grounding", {})
    if grounding:
        lines.append(
            f"- 接地率（INS_SPAN_COPY）: 载荷在文档/语料中可溯源 "
            f"{grounding.get('payload_groundable', 0):.3f}（n={grounding.get('n')}）"
        )
    latency = metrics.get("latency_ms", {})
    if latency:
        lines.append(
            "- 参考延迟（Python）: "
            + ", ".join(f"{k}={v:.3f}ms" for k, v in latency.items())
        )

    lines += [
        "",
        "## 已知局限",
        "- 训练信号来自规则扰动（合成域），尚未包含真实用户编辑流（wiki 修订历史是下一步）。",
        "- FMT_BULLET 类样本稀疏（<2%），召回预期偏低。",
        "- 位置精度以近失负例代理评估，尚未做全位置扫掠评测。",
        "- 内容层为最长匹配（∞-gram-lite），论文版将替换为后缀数组/自动机。",
        "",
        "## 集成说明",
        "- 浏览器参考实现: `research/nes/browser/eft.mjs`（与 Python 逐位对齐，金标向量测试 `test_infer.mjs`）",
        "- 交互建议: 决策层（本地、<10ms）→ 门控（精度优先，宁缺毋滥）→ 原子应用器（可回滚）→ 内容层填充载荷",
        "",
        "## 许可与出处",
        "- 代码: GPL-3.0（同仓库）",
        "- 语料: zh.wikipedia.org，CC BY-SA 4.0（仅用于研究训练，不随仓库分发）",
        "- 模型权重（本产物）: 由上述数据训练所得，随仓库以 GPL-3.0 分发",
    ]

    (ART / "MODEL_CARD.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"[model-card] wrote {ART / 'MODEL_CARD.md'}")


if __name__ == "__main__":
    main()
