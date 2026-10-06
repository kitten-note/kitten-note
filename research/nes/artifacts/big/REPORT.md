# EFT / NES - 256M-parameter predictor

- parameters: **260,047,072** (E: 8,388,608 x 31 + head)
- training: 3680 steps / 60,268,420 samples / 2.0 min on cuda
- data: 3,128,044 train samples (shards), val 62,915
- eval: {'n': 62915, 'top1': 0.8967177938488436, 'edit_top1': 0.7208323012137726, 'gate_auc': 0.9632498986527673}
- int8 export: {'int8_bytes': 276824064, 'rows': 8388608, 'dim': 31}
- paradigm: single forward propagation (embedding-bag + linear), no attention, no autoregression;
  outputs the same 7 typed atoms and passes the same type checker / copy-only grounding layer as v0.
