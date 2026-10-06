# EFT / NES v0 - Evaluation Report

- generated: 2026-10-06T19:11:52+0800
- corpus articles: 2161, chars: 415554
- samples: {'train': 65014, 'val': 553, 'test': 618}
- device: cuda
- depth-1 contract: softmax over fixed hashed feature field (D=16384)

## Class distribution

| split | NO_EDIT | FIX_CHAR | DEL_CHAR | INS_CHAR | DEL_SPAN | INS_SPAN_COPY | FMT_BULLET |
|---|---|---|---|---|---|---|---|
| train | 29256 | 13745 | 6621 | 5038 | 5756 | 3855 | 743 |
| val | 361 | 60 | 45 | 21 | 39 | 23 | 4 |
| test | 402 | 88 | 37 | 28 | 29 | 31 | 3 |

## Model comparison (test split)

| model | top1 | top3 | edit-top1 | bal-acc | edit AUC | ECE | gate P | gate R | gate F1 |
|---|---|---|---|---|---|---|---|---|---|
| hdc | 0.6181 | 1.0000 | 0.5833 | 0.6031 | 0.7955 | 0.2488 | 0.9127 | 0.5324 | 0.6725 |
| softmax | 0.7039 | 0.9951 | 0.7500 | 0.7936 | 0.8931 | 0.0208 | 0.8784 | 0.6019 | 0.7143 |
| markov | 0.6505 | 0.8722 | 0.0417 | 0.3027 | 0.5673 | 0.1861 | 1.0000 | 0.0093 | 0.0183 |
| prior | 0.6505 | 0.8528 | 0.0000 | 0.1429 | 0.4865 | 0.2005 | 0.3495 | 1.0000 | 0.5180 |

> top1 is diluted by the 65% NO_EDIT share; **edit-top1** is the accuracy of choosing
> the right edit class at true edit positions, and **bal-acc** is the mean per-class recall.

## Per-class recall (best model)

model: **softmax**

| class | recall |
|---|---|
| NO_EDIT | 0.6791 |
| FIX_CHAR | 0.6932 |
| DEL_CHAR | 0.6486 |
| INS_CHAR | 0.8571 |
| DEL_SPAN | 1.0000 |
| INS_SPAN_COPY | 0.6774 |
| FMT_BULLET | 1.0000 |

## Copy-only grounding (INS_SPAN_COPY)

- samples: 31
- payload present in context window: 0.5806
- payload groundable (doc or corpus): 1.0000

## Latency (Python reference implementation)

| stage | ms/sample |
|---|---|
| feature_extraction | 0.0332 |
| hdc_scoring | 0.2183 |
| softmax_scoring | 0.0302 |

> Browser (WASM) latency is a future measurement; HDC scoring is O(D/64) popcounts per sample.

## Notes

- 'gate P/R/F1' uses the validation-tuned threshold targeting precision 0.88.
- Baselines share the same evaluation split; the hashed-softmax/HDC rows are the paper's depth-1 models.
