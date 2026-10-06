# EFT / NES 256M run - status
- finished: 2026-10-06T21:33:15+0800
- wall clock: 88.6 min
- parameters: 260,047,072
- training: 581600 steps / 973,160,890 samples / 80.0 min
- eval: {'n': 3240, 'top1': 0.8867283950617284, 'edit_top1': 0.7735470941883767, 'gate_auc': 0.9612498860343345}
- int8 export: {'int8_bytes': 276824064, 'rows': 8388608, 'dim': 31}
- artifacts: artifacts/big/ (model.pt, embedding_int8.npz, REPORT.md, metrics.json)
