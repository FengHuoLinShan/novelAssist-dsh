// M6 Track A3 RAG L0 demo(纯 node, 无 DSH CLI):
//   initVault → 手写 3 章 + 1 个世界对象(frontmatter 资产)→ syncRagIndex 两次
//   (首次建索引 / 二次幂等全 0)→ searchRag 无 provider 检索两个中文查询(BM25)。
// M6 Track B 追加 ⑤b: 模型已缓存时演示 L2 向量召回(embedPendingChunks + searchRag(embeddingBackend));
//   未缓存则提示跳过(首次启用会自动下载)。
// 运行: node scripts/m6-rag-demo.mjs
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../packages/novelcraft/vault/dist/index.js";
import { serializeFrontmatter } from "../packages/novelcraft/store/dist/index.js";
import { embedPendingChunks, syncRagIndex, searchRag } from "../packages/novelcraft/rag/dist/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "nc-m6-rag-"));
const root = join(dataDir, "demo-book");
try {
  console.log("① initVault(建目录骨架 + book.yml + git init)");
  initVault(root, { title: "M6 RAG 演示之书", language: "zh", target_length: "short" });

  console.log("② 写 3 章 + 1 个世界对象(frontmatter 资产)");
  writeFileSync(
    join(root, "chapters", "001.md"),
    serializeFrontmatter(
      { chapter_index: 1, status: "draft", content_hash: "demo-ch1", title: "雨夜" },
      "雨下了一夜。林晚推开窗, 看见街角亮着一盏孤灯。",
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "chapters", "002.md"),
    serializeFrontmatter(
      { chapter_index: 2, status: "draft", content_hash: "demo-ch2", title: "对峙" },
      "苏婉站在桥上, 手里握着那柄青锋剑, 雨还在下。",
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "chapters", "003.md"),
    serializeFrontmatter(
      { chapter_index: 3, status: "draft", content_hash: "demo-ch3", title: "黎明" },
      "天亮了, 林晚与苏婉并肩走下石阶。",
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "world", "objects", "qingfeng-sword.md"),
    serializeFrontmatter(
      { id: "qingfeng-sword", kind: "item", name: "青锋剑", status: "canonical" },
      "青锋剑: 苏婉的佩剑, 剑身泛青, 能斩断夜雾。",
    ),
    "utf8",
  );

  console.log("③ syncRagIndex(首次: 增量建索引)");
  const first = syncRagIndex(root);
  console.log(`   首次: added=${first.added} updated=${first.updated} removed=${first.removed} total=${first.total}`);

  console.log("④ syncRagIndex(二次: 幂等, 应全 0)");
  const second = syncRagIndex(root);
  console.log(`   二次: added=${second.added} updated=${second.updated} removed=${second.removed} total=${second.total}`);

  console.log("⑤ searchRag 无 provider(L0 BM25)两个中文查询");
  for (const q of ["青锋剑", "林晚"]) {
    const r = await searchRag(root, q);
    console.log(`   查询「${q}」: ranking=${r.ranking}${r.degraded ? ` degraded=${r.degraded}` : ""} hits=${r.hits.length}`);
    for (const h of r.hits) {
      console.log(`     - [${h.chunk_id}] ${h.source_type}${h.chapter_index !== undefined ? ` ch${h.chapter_index}` : ""} 「${h.text.slice(0, 40)}」`);
    }
  }

  console.log("⑤b BGE L2 向量召回演示(模型缓存存在才启用)");
  const modelCache = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "novelcraft", "models");
  const hasCache = existsSync(modelCache) && readdirSync(modelCache).length > 0;
  if (!hasCache) {
    console.log("   BGE 模型未缓存, 跳过 L2 演示(首次启用会自动下载)");
  } else {
    const { createBgeEmbeddingBackend } = await import("../packages/novelcraft/rag-bge/dist/index.js");
    const backend = createBgeEmbeddingBackend();
    const stats = await embedPendingChunks(root, backend);
    console.log(`   嵌入: embedded=${stats.embedded} failed=${stats.failed} skipped=${stats.skipped}(模型缓存: ${modelCache})`);
    for (const q of ["青锋剑", "林晚"]) {
      const r = await searchRag(root, q, { embeddingBackend: backend });
      console.log(`   查询「${q}」: ranking=${r.ranking}${r.degraded ? ` degraded=${r.degraded}` : ""} hits=${r.hits.length}`);
      for (const h of r.hits) {
        console.log(`     - [${h.chunk_id}] ${h.source_type}${h.chapter_index !== undefined ? ` ch${h.chapter_index}` : ""} 「${h.text.slice(0, 40)}」`);
      }
    }
  }

  console.log("M6 RAG L0/L2 demo OK");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
