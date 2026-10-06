# EFT / NES - 256M-parameter predictor

- parameters: **260,047,072** (E: 8,388,608 x 31 + head)
- training: 581600 steps / 973,160,890 samples / 80.0 min on cuda
- data: 374,169 train samples (shards), val 7,622
- eval: {'n': 3240, 'top1': 0.8867283950617284, 'edit_top1': 0.7735470941883767, 'gate_auc': 0.9612498860343345}
- int8 export: {'int8_bytes': 276824064, 'rows': 8388608, 'dim': 31}
- paradigm: single forward propagation (embedding-bag + linear), no attention, no autoregression;
  outputs the same 7 typed atoms and passes the same type checker / copy-only grounding layer as v0.
