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

## NES 模型权重

- 仓库中的 `assets/nes-model/` 仅包含模型元数据（`config.json`、`tokenizer.json` 等），**模型权重不随仓库分发**。
- 权重文件需自行放置在 `assets/nes-model/onnx/model_q4.onnx`，或通过应用内"下载模型"按钮获取。
- 模型权重不适用本项目的 GPL-3.0 许可，其许可取决于模型发布方。当前配置对应 **Qwen3 系**模型，使用前请自行确认上游模型仓库的许可证与使用条款。
