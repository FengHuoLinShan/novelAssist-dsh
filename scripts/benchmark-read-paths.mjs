#!/usr/bin/env node
/** 合成 Vault/RAG 基准；只写系统临时目录，不改变仓库或真实小说数据。 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { initVault } from '@novelcraft/vault'
import { rebuildIndexSnapshot, storyMapFromSnapshot } from '@novelcraft/store'
import {
  INDEX_VERSION_CN,
  embedPendingChunks,
  rebuildRagIndex,
  scoreChunksBm25,
} from '@novelcraft/rag'

const SIZES = [300, 1000]
const SEARCH_RUNS = 30

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

function seedVault(root, size) {
  for (let i = 0; i < size; i++) {
    const slug = `obj-${String(i).padStart(4, '0')}`
    writeFileSync(join(root, 'world', 'objects', `${slug}.md`), [
      '---',
      `id: ${slug}`,
      `name: 对象${i}`,
      `kind: ${i % 3 === 0 ? 'character' : 'location'}`,
      'status: canonical',
      `aliases: [别名${i}]`,
      `evidence: [第${(i % 100) + 1}章]`,
      '---',
      '',
    ].join('\n'))
  }
}

function chunks(size) {
  return Array.from({ length: size }, (_, i) => ({
    chunk_id: `bench-${i}`,
    source_type: 'chapter_text',
    chapter_index: i + 1,
    chunk_index: 0,
    char_count: 180,
    text: `第${i + 1}章 苏婉沿河寻找怀表 线索${i % 17} `.repeat(6),
    visibility: 'author_only',
    importance: 0.5,
    index_version: INDEX_VERSION_CN,
    embedding_status: 'pending',
  }))
}

async function run(size) {
  const root = mkdtempSync(join(tmpdir(), `novelcraft-bench-${size}-`))
  try {
    initVault(root, { title: `基准-${size}`, language: 'zh' })
    seedVault(root, size)

    const scanStart = performance.now()
    const snapshot = rebuildIndexSnapshot(root)
    const map = storyMapFromSnapshot(root, snapshot)
    const vaultMs = performance.now() - scanStart

    const corpus = chunks(size)
    const searchMs = []
    for (let i = 0; i < SEARCH_RUNS; i++) {
      const started = performance.now()
      scoreChunksBm25(corpus, '苏婉 怀表')
      searchMs.push(performance.now() - started)
    }

    rebuildRagIndex(root, corpus)
    const backend = { name: 'benchmark-zero-vector', embed: async (texts) => texts.map(() => [0, 0, 0, 0]) }
    const embedStart = performance.now()
    await embedPendingChunks(root, backend, { batch: 32 })
    const embedMs = performance.now() - embedStart
    const indexFile = join(root, '.assistant', 'rag-index.json')
    const indexBytes = statSync(indexFile).size
    const p95 = percentile(searchMs, 0.95)

    return {
      assets: size,
      indexed_objects: snapshot.index.objects.length,
      story_edges: map.edges.length,
      vault_snapshot_ms: Number(vaultMs.toFixed(2)),
      bm25_p95_ms: Number(p95.toFixed(2)),
      embed_persist_ms: Number(embedMs.toFixed(2)),
      rag_index_mb: Number((indexBytes / 1024 / 1024).toFixed(2)),
      cache_threshold_crossed: size > 2000 || p95 > 100,
      checkpoint_threshold_crossed: indexBytes > 50 * 1024 * 1024 || embedMs > 1000,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

mkdirSync(tmpdir(), { recursive: true })
const results = []
for (const size of SIZES) results.push(await run(size))
console.table(results)
