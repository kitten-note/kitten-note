# EFT / NES v0 - Evaluation Report

- generated: 2026-10-06T20:46:39+0800
- corpus articles: 8015, chars: 1520566
- samples: {'train': 200000, 'val': 2150, 'test': 2203}
- device: cuda
- depth-1 contract: softmax over fixed hashed feature field (D=16384)

## Class distribution

| split | NO_EDIT | FIX_CHAR | DEL_CHAR | INS_CHAR | DEL_SPAN | INS_SPAN_COPY | FMT_BULLET |
|---|---|---|---|---|---|---|---|
| train | 90217 | 42493 | 20367 | 15345 | 17480 | 11910 | 2188 |
| val | 1403 | 273 | 145 | 106 | 138 | 78 | 7 |
| test | 1447 | 309 | 133 | 102 | 102 | 95 | 15 |

## Model comparison (test split)

| model | top1 | top3 | edit-top1 | bal-acc | edit AUC | ECE | gate P | gate R | gate F1 |
|---|---|---|---|---|---|---|---|---|---|
| hdc | 0.6509 | 1.0000 | 0.5952 | 0.6860 | 0.8245 | 0.2834 | 0.8529 | 0.5291 | 0.6531 |
| softmax | 0.7090 | 1.0000 | 0.7659 | 0.8004 | 0.9066 | 0.0509 | 0.9159 | 0.6627 | 0.7690 |
| markov | 0.6555 | 0.8820 | 0.0489 | 0.3032 | 0.5721 | 0.1899 | 0.8333 | 0.0066 | 0.0131 |
| prior | 0.6568 | 0.8575 | 0.0000 | 0.1429 | 0.4980 | 0.2057 | 0.0000 | 0.0000 | 0.0000 |

> top1 is diluted by the 65% NO_EDIT share; **edit-top1** is the accuracy of choosing
> the right edit class at true edit positions, and **bal-acc** is the mean per-class recall.

## Per-class recall (best model)

model: **softmax**

| class | recall |
|---|---|
| NO_EDIT | 0.6793 |
| FIX_CHAR | 0.7217 |
| DEL_CHAR | 0.6466 |
| INS_CHAR | 0.7549 |
| DEL_SPAN | 1.0000 |
| INS_SPAN_COPY | 0.8000 |
| FMT_BULLET | 1.0000 |

## Copy-only grounding (INS_SPAN_COPY)

- samples: 95
- payload present in context window: 0.5684
- payload groundable (doc or corpus): 1.0000

## Local end-to-end sweep (gate fired at every position)

| model | n | fired | position hit (±1) | class hit | false fire |
|---|---|---|---|---|---|
| softmax | 756 | 0.975 | 0.179 | 0.165 | 0.796 |
| hdc | 300 | 0.890 | 0.060 | 0.060 | 0.830 |

## Latency (Python reference implementation)

| stage | ms/sample |
|---|---|
| feature_extraction | 0.0367 |
| hdc_scoring | 0.2106 |
| softmax_scoring | 0.0293 |

> Browser (WASM) latency is a future measurement; HDC scoring is O(D/64) popcounts per sample.

## Notes

- 'gate P/R/F1' uses the validation-tuned threshold targeting precision 0.88.
- Baselines share the same evaluation split; the hashed-softmax/HDC rows are the paper's depth-1 models.
