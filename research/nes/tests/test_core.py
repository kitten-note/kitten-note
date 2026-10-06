"""
Quick unit tests for the EFT / NES v0 pipeline.
Run: python tests/test_core.py   (from research/nes/)
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atoms import apply_atom, diff_to_atoms, make_atom  # noqa: E402
from content import ContentIndex  # noqa: E402
from features import FEATURE_DIM, HDCEncoder, extract_feature_ids  # noqa: E402
from synth import Synthesizer, make_bullet_doc  # noqa: E402

PASSED = []
FAILED = []


def check(name: str, condition: bool) -> None:
    (PASSED if condition else FAILED).append(name)
    print(("  ok  " if condition else "  FAIL") + "  " + name)


print("== atoms ==")
check("fix same char is ill-typed", apply_atom("我喜欢", make_atom("FIX_CHAR", pos=0, char="我")) is None)
check("fix valid", apply_atom("我喜欢", make_atom("FIX_CHAR", pos=0, char="你")) == "你喜欢")
check("fix out of range", apply_atom("我喜欢", make_atom("FIX_CHAR", pos=99, char="你")) is None)
check("ins_char whitelist ok", apply_atom("你好", make_atom("INS_CHAR", pos=2, char="。")) == "你好。")
check("ins_char non-whitelist rejected", apply_atom("你好", make_atom("INS_CHAR", pos=2, char="猫")) is None)
check("ins_span_copy grounded", apply_atom("ABCABC", make_atom("INS_SPAN_COPY", pos=6, payload="ABC")) == "ABCABCABC")
check("ins_span_copy ungrounded rejected", apply_atom("ABCABC", make_atom("INS_SPAN_COPY", pos=6, payload="XYZ")) is None)
check("del_span needs >=2", apply_atom("你好", make_atom("DEL_SPAN", start=0, end=1)) is None)
check("del_span ok", apply_atom("你好啊", make_atom("DEL_SPAN", start=1, end=3)) == "你")
check("noop no_edit", apply_atom("abc", make_atom("NO_EDIT")) == "abc")

print("== diff_to_atoms ==")
check("insert punct", [a["type"] for a in diff_to_atoms("你好", "你好。")] == ["INS_CHAR"])
check("delete punct", [a["type"] for a in diff_to_atoms("你好。", "你好")] == ["DEL_CHAR"])
check("replace char", [a["type"] for a in diff_to_atoms("我爱中国", "我喜欢中国")] != [])
same = diff_to_atoms("一模一样", "一模一样")
check("no diff -> no atoms", same == [])

print("== features ==")
ids_a = extract_feature_ids("今天天气很", "好", "。今天")
ids_b = extract_feature_ids("今天天气很", "好", "。今天")
check("deterministic", ids_a.tolist() == ids_b.tolist())
check("range", bool((ids_a < FEATURE_DIM).all()) and len(ids_a) > 5)
check("context sensitivity", extract_feature_ids("明天天气很", "好", "。").tolist() != ids_a.tolist())

encoder = HDCEncoder(dim=1024)
v1 = encoder.vector(ids_a)
v2 = encoder.vector(ids_a)
v3 = encoder.vector(extract_feature_ids("完全不同的", "词", "语"))
check("hdc deterministic", (v1 == v2).all())
check("hdc differs across contexts", not (v1 == v3).all())
check("hdc bipolar", set(v1.tolist()) <= {-1, 1})

print("== content index ==")
index = ContentIndex("今天天气很好。今天天气不错。明天可能下雨。")
nexts = dict(index.propose_next("今天天气"))
check("longest match right chars", "很" in nexts and "不" in nexts)
check("groundable in corpus", index.can_ground("天气很好") == "corpus")
check("ungroundable", index.can_ground("紫色独角兽") == "none")

print("== synthesis ==")
corpus = [
    "我们在公园里慢慢地走着，他觉得这样做是对的。",
    "她的意见得到了大家的认同，他也再没有反对。",
    "做作业的时候要认真，再检查一遍也不为过。",
    "地球是我们的家园，保护环境就是保护自己。",
    "他慢慢地走过来，好像在想什么事情。",
    "在图书馆里看书，得保持安静，这样才对得起别人。",
]
synth = Synthesizer(corpus, seed=7)
docs = [
    "我们在美丽的公园里慢慢地走着，他觉得这样做是对的，因为大家都开心。"
    "她认真地做完了作业，然后再仔细地检查了一遍，发现了一个小错误并改正了。"
    "他慢慢地走过来，对我们说其实他早就知道了这件事的来龙去脉，只是没说而已。",
    "地球是我们的家园，保护环境就是保护自己。我们在日常生活中要节约用水用电，"
    "减少浪费，做好垃圾分类，让地球变得更加美好，也让未来的人们能够继续幸福地生活。"
    "她认为这样做是对的，而且在图书馆里看书得保持安静才对得起别人。",
    "做作业的时候要认真，再检查一遍也不为过。他慢慢地走过来，好像在想什么事情。"
    "我们在公园里慢慢地走着，他觉得这样做是对的，因为大家都开心，所以没有人反对。"
    "她的意见得到了大家的认同，他也再没有反对，事情就这样定了下来。",
]
all_samples = []
for doc in docs:
    all_samples.extend(synth.make_doc_samples(doc))
types = {s["atom"]["type"] for s in all_samples}
check("samples produced", len(all_samples) > 0)
check("has edits", any(t != "NO_EDIT" for t in types))
check("has no_edit", "NO_EDIT" in types)
check("valid classes", all(0 <= s["label"] <= 6 for s in all_samples))
check("windows assembled", all(isinstance(s["left"], str) and isinstance(s["span"], str) and isinstance(s["right"], str) for s in all_samples))

rng = random.Random(3)
bullet_doc = make_bullet_doc(
    rng,
    "第一件事一定要在今天做完。第二件事也要认真做好才行。第三件事别忘了提前准备。"
    "第四件事很重要需要大家配合。第五件事情其实也不难完成。"
    "我们在公园里慢慢地走着，他觉得这样做是对的。",
)
seen_bullet = False
for _ in range(30):
    samples = synth.make_doc_samples(bullet_doc, bullet_doc=True)
    if any(s["atom"]["type"] == "FMT_BULLET" for s in samples):
        seen_bullet = True
        break
check("bullet samples reachable", seen_bullet or bullet_doc.count("- ") == 0)

print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
if FAILED:
    print("failures:", FAILED)
    sys.exit(1)
