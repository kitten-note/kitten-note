# 更新日志

本项目的所有重要变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号沿用项目的历史标签习惯。

## [Unreleased] — v3 大修

### 安全性

- 新增应用层端到端加密：配对时双方交换 ECDH P-256 公钥并各自签名握手内容（ECDSA P-256 / SHA-256），经 HKDF-SHA256 派生 AES-256-GCM 会话密钥，同步消息逐条加密（随机 96-bit IV）。实现见 `js/crypto.js`。
- 修复导入/导出流程中的 XSS 风险：对外部内容与文件名进行转义/清洗。
- 增加内容安全策略（CSP），收紧脚本与资源加载来源。
- 对远程载荷（同步消息、备份数据）增加结构校验，拒绝非法数据。

### 同步

- 删除操作改为 tombstone 传播：删除会同步到其他设备，不再被旧数据"复活"。
- 冲突合并明确为 Last-Write-Wins（LWW）：并发修改按最后修改时间取胜，行为可预期。
- 与未升级的旧版本配对时降级为仅 DTLS 加密，并给出明确提示。

### 数据

- 导入备份增加版本校验；导入前自动生成快照；补充数据恢复入口。
- OPFS 存储使用 Web Locks 协调多标签页写入，避免相互覆盖。
- 启动时通过 `navigator.storage.persist()` 申请持久化存储，降低被浏览器自动清理的风险。

### Service Worker

- 壳资源预缓存与运行时缓存分工，新增离线兜底。
- 修复 stale-while-revalidate 策略中的缓存更新问题。
- 缓存版本号升级到 v3。

### AI

- 模型下载改为流式，实时显示下载进度。
- 下载分片进行哈希校验，保证模型文件完整性。
- 模型分片缓存到 IndexedDB，推理时直接供 transformers.js 读取。

### 导出

- PDF 导出改为真正的文件生成：新增零依赖 PDF 生成器（`js/pdf.js`）与文字排版引擎（`js/pdf-text.js`），点击导出即下载 `.pdf` 文件，不再弹出浏览器打印对话框。
- **PDF 文字可选中**：文字笔记使用矢量文本 + 内嵌 Noto Sans SC 子集字体（OFL 1.1，~2 MiB），检索/复制/无障碍均可用；字体未覆盖的字符自动回退为图像渲染。新增 `js/truetype.js`、`js/pdf-layout.js`、`js/font.js` 与 `tools/build-font-subset.py`（可复现子集化）。
- 文字笔记按 A4 多页排版（标题、列表、引用、行内代码、下划线/删除线等，中文自动换行与分页，页脚页码）。
- 墨迹笔记按内容自适应铺满 A4 页面，支持导出任意笔记（包括当前未打开的笔记），图片素材完整内联。
- 顺带修复 PNG 导出同样的"只导出当前画布"问题。

### 测试与 CI

- 修复失配的测试。
- 新增 PDF 生成器测试（`tests/pdf.test.js`）、TrueType 解析测试（`tests/truetype.test.js`）与矢量排版测试（`tests/pdf-layout.test.js`）。
- 引入 GitHub Actions 持续集成。

### 文档

- 重写 README，使其与 v3 实现保持一致。
- 新增 `THIRD_PARTY_LICENSES.md` 第三方许可说明。
- 新增本更新日志。

## 历史版本

- `v1r1`
- `v1u2`
- `v2u1`
- `v2u2`
