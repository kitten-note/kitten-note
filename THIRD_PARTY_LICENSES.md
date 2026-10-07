# 第三方许可声明

KittenNote 本体以 **GNU GPL v3.0** 发布，详见 [LICENSE](LICENSE)。

本文件列出随仓库分发的第三方组件及其许可。为便于核对，许可名称保留英文原文，并附简体中文说明。

## Font Awesome Free

- 位置：`assets/fontawesome/`
- 用途：应用界面图标
- 许可组成：
  - 图标（Icons）：**CC BY 4.0**（Creative Commons Attribution 4.0 International）
  - 字体（Fonts）：**SIL OFL 1.1**（SIL Open Font License 1.1）
  - 代码（Code）：**MIT License**
- 许可详情：<https://fontawesome.com/license/free>

## @huggingface/transformers

- 位置：`assets/transformers.js/transformers.js`
- 用途：浏览器端 AI 推理框架（NES 本地模式）
- 许可：**Apache License 2.0**

## onnxruntime-web

- 位置：`assets/transformers.js/ort-wasm-simd-threaded.jsep.mjs`、`assets/transformers.js/ort-wasm-simd-threaded.jsep.wasm`（随 transformers.js 打包分发）
- 用途：ONNX 模型运行时
- 许可：**MIT License**

## 二维码相关库（`assets/qrcode/`）

- **qrcode-generator** v1.4.4（`qrcode-generator.min.js`）
  - 用途：生成同步配对二维码
  - 许可：**MIT License**
- **jsQR** v1.4.0（`jsQR.min.js`）
  - 用途：摄像头扫描识别二维码
  - 许可：**Apache License 2.0**

## MathJax

- 位置：`assets/mathjax/tex-svg-full.js`（v3.2.2，SHA-256 见 `assets/mathjax/README.md`）
- 用途：LaTeX 笔记的公式与文档渲染（SVG 输出，纯离线）
- 许可：**Apache License 2.0**（© MathJax Consortium）
- 许可原文：`assets/mathjax/LICENSE`

## Noto Sans SC（PDF 文本字体子集）

- 位置：`assets/fonts/NotoSansSC-Regular-subset.ttf`
- 用途：导出 PDF 时嵌入的正文字体，使文字可选中/可搜索（含 ~6,763 常用汉字与常用符号）
- 来源：Google Fonts 的 Noto Sans SC 可变字体，经 `tools/build-font-subset.py` 固定 wght=400 并子集化
- 许可：**SIL Open Font License 1.1**
- 版权：Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
- 许可原文：`assets/fonts/OFL.txt`
- OFL 要求：分发二进制时保留版权与许可声明；**不得单独出售该字体**；修改后的字体版本不得使用保留字体名（本仓库仅为子集化，未改动字形）

## NES 模型权重

- 仓库中的 `assets/nes-model/` 仅包含模型元数据（`config.json`、`tokenizer.json` 等），**模型权重不随仓库分发**。
- 权重文件需自行放置在 `assets/nes-model/onnx/model_q4.onnx`，或通过应用内"下载模型"按钮获取。
- 模型权重不适用本项目的 GPL-3.0 许可，其许可取决于模型发布方。当前配置对应 **Qwen3 系**模型，使用前请自行确认上游模型仓库的许可证与使用条款。

## EFT / NES 内置预测器（assets/eft/）

- 位置：`assets/eft/`（`eft.js` 推理运行时 + 模型权重 + `content.json` 字符表，约 6MB）
- 说明：KittenNote 自研的 **EFT v0 预测器**——从零训练、非 LLM、单次前向、类型化输出（改字 / 删重复 / 补标点 / 删冗余），推理完全在本地进行，数据不出设备。
- 许可：运行时与模型权重为自研产物，随本仓库以 **GPL-3.0** 分发。
- 语料来源：`content.json` 由中文维基百科语料统计生成（语料许可 **CC BY-SA 4.0**，Wikimedia Foundation）；语料本身不随仓库分发。
- 研究复现：训练、评测与浏览器金标对齐测试在 `research/nes/`。
