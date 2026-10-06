"""
EFT / NES v0 - Evaluation metrics and report writer.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np

from atoms import ATOM_CLASSES, ID_TO_CLASS


def top_k_accuracy(probs: np.ndarray, labels: np.ndarray, k: int = 1) -> float:
    order = np.argsort(-probs, axis=1)[:, :k]
    return float(np.mean([labels[i] in order[i] for i in range(len(labels))]))


def per_class_recall(probs: np.ndarray, labels: np.ndarray) -> Dict[str, float]:
    predictions = probs.argmax(axis=1)
    out = {}
    for index, name in enumerate(ATOM_CLASSES):
        mask = labels == index
        if mask.sum() == 0:
            continue
        out[name] = float(np.mean(predictions[mask] == index))
    return out


def edit_gate_metrics(edit_prob: np.ndarray, labels: np.ndarray, threshold: float) -> Dict[str, float]:
    is_edit = labels != 0
    fired = edit_prob >= threshold
    tp = int(np.sum(fired & is_edit))
    fp = int(np.sum(fired & ~is_edit))
    fn = int(np.sum(~fired & is_edit))
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-9)
    return {
        "threshold": float(threshold),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "fired": int(fired.sum()),
    }


def gate_only_metrics(edit_prob: np.ndarray, labels: np.ndarray) -> Dict[str, float]:
    """Discrimination quality of the edit/no-edit decision, threshold-free."""
    is_edit = (labels != 0).astype(np.int64)
    order = np.argsort(edit_prob)
    ranks = np.empty_like(order)
    ranks[order] = np.arange(len(edit_prob))
    positives = int(is_edit.sum())
    negatives = len(is_edit) - positives
    if positives == 0 or negatives == 0:
        return {"auc": 0.5}
    auc = float((ranks[is_edit == 1].sum() - positives * (positives - 1) / 2) / (positives * negatives))
    return {"auc": auc}


def expected_calibration_error(probs: np.ndarray, labels: np.ndarray, bins: int = 10) -> float:
    confidence = probs.max(axis=1)
    correct = (probs.argmax(axis=1) == labels).astype(np.float64)
    ece = 0.0
    edges = np.linspace(0.0, 1.0, bins + 1)
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (confidence > low) & (confidence <= high)
        if mask.sum() == 0:
            continue
        gap = abs(correct[mask].mean() - confidence[mask].mean())
        ece += gap * mask.sum() / len(labels)
    return float(ece)


def balanced_accuracy(probs: np.ndarray, labels: np.ndarray) -> float:
    recalls = per_class_recall(probs, labels)
    return float(np.mean(list(recalls.values()))) if recalls else 0.0


def edit_only_top1(probs: np.ndarray, labels: np.ndarray) -> float:
    mask = labels != 0
    if mask.sum() == 0:
        return 0.0
    order = np.argsort(-probs[mask], axis=1)[:, :1]
    return float(np.mean([labels[mask][i] == order[i][0] for i in range(mask.sum())]))


def evaluate_model(
    name: str,
    probabilities: np.ndarray,
    labels: np.ndarray,
    *,
    threshold: Optional[float] = None,
) -> Dict:
    edit_prob = 1.0 - probabilities[:, 0]
    result = {
        "name": name,
        "n": int(len(labels)),
        "top1": top_k_accuracy(probabilities, labels, 1),
        "top3": top_k_accuracy(probabilities, labels, 3),
        "edit_top1": edit_only_top1(probabilities, labels),
        "balanced_acc": balanced_accuracy(probabilities, labels),
        "per_class_recall": per_class_recall(probabilities, labels),
        "ece": expected_calibration_error(probabilities, labels),
        "gate": gate_only_metrics(edit_prob, labels),
    }
    if threshold is not None:
        result["gate_at_threshold"] = edit_gate_metrics(edit_prob, labels, threshold)
        result["edit_at_gate"] = edit_accuracy_at_gate(probabilities, labels, threshold)
    return result


def edit_accuracy_at_gate(probabilities: np.ndarray, labels: np.ndarray, threshold: float) -> Dict[str, float]:
    """Among fired gate samples, how accurate is the edit-class decision?"""
    edit_prob = 1.0 - probabilities[:, 0]
    fired = (edit_prob >= threshold) & (labels != 0)
    if fired.sum() == 0:
        return {"n": 0, "edit_class_acc": 0.0}
    predictions = probabilities.argmax(axis=1)
    return {
        "n": int(fired.sum()),
        "edit_class_acc": float(np.mean(predictions[fired] == labels[fired])),
    }


def grounding_rates(rows: Sequence[Dict], content_index, sample_limit: int = 2000) -> Dict[str, float]:
    """Copy-only groundedness of INS_SPAN_COPY payloads in the test split."""
    copy_rows = [r for r in rows if r.get("atom", {}).get("type") == "INS_SPAN_COPY"][:sample_limit]
    if not copy_rows:
        return {}
    in_doc = in_corpus = 0
    for row in copy_rows:
        payload = row["atom"].get("payload", "")
        window = row.get("left", "") + row.get("span", "") + row.get("right", "")
        if payload and payload in window:
            in_doc += 1
        if payload and content_index.can_ground(payload) in ("doc", "corpus"):
            in_corpus += 1
    return {
        "n": len(copy_rows),
        "payload_in_window": in_doc / len(copy_rows),
        "payload_groundable": in_corpus / len(copy_rows),
    }


def class_distribution(rows: Sequence[Dict]) -> Dict[str, int]:
    counter = Counter(ID_TO_CLASS.get(r["label"], "?") for r in rows)
    return dict(counter)


def write_report(
    path: Path,
    *,
    config: Dict,
    results: Dict[str, Dict],
    class_counts: Dict[str, Dict],
    grounding: Dict,
    latency_ms: Dict[str, float],
) -> None:
    lines: List[str] = []
    lines.append("# EFT / NES v0 - Evaluation Report\n")
    lines.append(f"- generated: {config.get('generated_at', '')}")
    lines.append(f"- corpus articles: {config.get('corpus_articles')}, chars: {config.get('corpus_chars')}")
    lines.append(f"- samples: {config.get('sample_counts')}")
    lines.append(f"- device: {config.get('device')}")
    lines.append(f"- depth-1 contract: softmax over fixed hashed feature field (D={config.get('feature_dim')})\n")

    lines.append("## Class distribution\n")
    lines.append("| split | " + " | ".join(ATOM_CLASSES) + " |")
    lines.append("|" + "---|" * (len(ATOM_CLASSES) + 1))
    for split, counts in class_counts.items():
        row = " | ".join(str(counts.get(name, 0)) for name in ATOM_CLASSES)
        lines.append(f"| {split} | {row} |")
    lines.append("")

    lines.append("## Model comparison (test split)\n")
    lines.append("| model | top1 | top3 | edit-top1 | bal-acc | edit AUC | ECE | gate P | gate R | gate F1 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for name, result in results.items():
        gate = result.get("gate_at_threshold", {})
        lines.append(
            f"| {name} | {result['top1']:.4f} | {result['top3']:.4f} | "
            f"{result.get('edit_top1', 0):.4f} | {result.get('balanced_acc', 0):.4f} | "
            f"{result.get('gate', {}).get('auc', 0):.4f} | {result['ece']:.4f} | "
            f"{gate.get('precision', 0):.4f} | {gate.get('recall', 0):.4f} | {gate.get('f1', 0):.4f} |"
        )
    lines.append("")
    lines.append("> top1 is diluted by the 65% NO_EDIT share; **edit-top1** is the accuracy of choosing")
    lines.append("> the right edit class at true edit positions, and **bal-acc** is the mean per-class recall.\n")

    lines.append("## Per-class recall (best model)\n")
    if results:
        best = max(results.values(), key=lambda r: r["top1"])
        lines.append(f"model: **{best['name']}**\n")
        lines.append("| class | recall |")
        lines.append("|---|---|")
        for name, recall in best["per_class_recall"].items():
            lines.append(f"| {name} | {recall:.4f} |")
        lines.append("")

    if grounding:
        lines.append("## Copy-only grounding (INS_SPAN_COPY)\n")
        lines.append(f"- samples: {grounding.get('n')}")
        lines.append(f"- payload present in context window: {grounding.get('payload_in_window', 0):.4f}")
        lines.append(f"- payload groundable (doc or corpus): {grounding.get('payload_groundable', 0):.4f}")
        lines.append("")

    if latency_ms:
        lines.append("## Latency (Python reference implementation)\n")
        lines.append("| stage | ms/sample |")
        lines.append("|---|---|")
        for stage, value in latency_ms.items():
            lines.append(f"| {stage} | {value:.4f} |")
        lines.append("")
        lines.append("> Browser (WASM) latency is a future measurement; HDC scoring is O(D/64) popcounts per sample.\n")

    lines.append("## Notes\n")
    lines.append("- 'gate P/R/F1' uses the validation-tuned threshold targeting precision 0.88.")
    lines.append("- Baselines share the same evaluation split; the hashed-softmax/HDC rows are the paper's depth-1 models.\n")
    path.write_text("\n".join(lines), encoding="utf-8")
