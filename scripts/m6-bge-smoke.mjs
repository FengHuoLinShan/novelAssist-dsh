// M6 Track B 真实模型冒烟(尽力而为, 非测试): 下载并嵌入两条中文句子。
// 硬上限 2 次尝试: 首次直连; 失败后 HF_ENDPOINT=https://hf-mirror.com 重试一次。
// 运行: node scripts/m6-bge-smoke.mjs
import { createBgeEmbeddingBackend } from "../packages/novelcraft/rag-bge/dist/index.js";

const sentences = ["雨夜孤灯, 林晚推开窗", "苏婉握着青锋剑, 站在桥上"];
const backend = createBgeEmbeddingBackend();
console.log(`backend.name=${backend.name}`);
const vectors = await backend.embed(sentences);
console.log(`embed OK: ${vectors.length} 条, 维度 ${vectors[0].length}, 与输入同序`);
const [a, b] = vectors;
let dot = 0, na = 0, nb = 0;
for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
console.log(`两向量余弦 = ${(dot / Math.sqrt(na * nb)).toFixed(4)}`);
console.log("M6 BGE 冒烟 OK");
