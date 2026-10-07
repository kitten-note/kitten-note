# EFT / NES - 256M-parameter predictor

- parameters: **260,047,072** (E: 8,388,608 x 31 + head)
- training: 900 steps / 14,713,574 samples / 1.0 min on cuda
- data: 4,981,107 train samples (shards), val 100,125
- eval: {'n': 100125, 'top1': 0.909692883895131, 'edit_top1': 0.6485374318294497, 'gate_auc': 0.943972131448382}
- int8 export: {'int8_bytes': 276824064, 'rows': 8388608, 'dim': 31}
- paradigm: single forward propagation (embedding-bag + linear), no attention, no autoregression;
  outputs the same 7 typed atoms and passes the same type checker / copy-only grounding layer as v0.
