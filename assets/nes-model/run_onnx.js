// 运行 ONNX 模型的 Node.js 示例
// 需要安装 transformers.js 和 onnxruntime-web
// 安装命令：npm install @xenova/transformers onnxruntime-web

const { pipeline } = require('@xenova/transformers');
const path = require('path');

async function main() {
    // 加载本地 ONNX 模型
    const modelPath = path.join(__dirname, 'onnx/model_q4.onnx');
    // 这里以文本生成任务为例，实际任务请根据模型类型调整
    const generator = await pipeline('text-generation', modelPath);
    // 输入文本
    const input = '你好，猫咪笔记';
    // 推理
    const output = await generator(input);
    console.log('输出:', output);
}

main().catch(console.error);
