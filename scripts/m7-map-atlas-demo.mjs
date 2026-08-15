// M7 map-atlas demo(纯 node, 无 DSH CLI; 计划 §4 Phase 6 验收: demo 可复现):
//   MockProvider 建 vault → planMapAtlas 规划(prompt_only 候选)→ adoptAtlasPlaceholder 空占位 →
//   本机图片导入(挂 prompt_only 页 → review_ready)→ approval adopt 图片页 → 标签 CRUD → 树。
// 运行: node scripts/m7-map-atlas-demo.mjs(先 npm run build --workspaces)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { initVault } from "../packages/novelcraft/vault/dist/index.js";
import { gitAdd, gitCommit, serializeFrontmatter } from "../packages/novelcraft/store/dist/index.js";
import { MockProvider } from "../packages/novelcraft/llm-step/dist/index.js";
import {
  addAtlasAnnotation,
  adoptAtlasPage,
  adoptAtlasPlaceholder,
  deleteAtlasAnnotation,
  importAtlasImage,
  planMapAtlas,
  readAtlasTree,
  updateAtlasAnnotation,
} from "../packages/novelcraft/world/dist/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "nc-m7-atlas-"));
const root = join(dataDir, "demo-book");
const allowAll = async () => "allowed-once";

/** 最小合法 PNG(magic + IHDR 宽高)。 */
function pngBytes(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

try {
  console.log("① initVault + 写 1 个 canonical 地点 + 1 页 canonical bible");
  initVault(root, { title: "M7 地图册演示之书", language: "zh", target_length: "short" });
  const loc = join(root, "world", "objects", "loc-linshui.md");
  writeFileSync(
    loc,
    serializeFrontmatter(
      { id: "loc-linshui", name: "临水城", kind: "location", status: "canonical", aliases: [], tags: [], evidence: [] },
      "",
    ),
    "utf8",
  );
  const bp = join(root, "bible", "bp-linshui.md");
  writeFileSync(
    bp,
    serializeFrontmatter(
      { id: "bp-linshui", status: "canonical", page_type: "location", page_key: "bp-linshui", title: "临水城志", version_number: 1 },
      "临水城依雾河而建, 城东有码头, 城北是旧城墙; 雾岭在城南三十里。",
    ),
    "utf8",
  );
  gitAdd(root, [loc, bp]);
  gitCommit(root, "demo: canonical 资料");

  console.log("② planMapAtlas(MockProvider: 空间事实 + AtlasPlan 两步)");
  const provider = new MockProvider({
    responses: [
      { text: JSON.stringify({ locations: [{ location_key: "loc-linshui", facts: [{ statement: "临水城依雾河而建, 城东有码头", basis: "explicit", source_keys: ["wiki:bp-linshui"] }] }] }) },
      {
        text: JSON.stringify({
          style_brief: "写实暗色水彩",
          nodes: [
            {
              plan_key: "root-cover", title: "全书封面", level: "cover", summary: "故事发生地总览",
              visual_brief: "雾气中的河谷平原, 临水城居中", prompt: "写实暗色水彩, 河谷平原俯瞰, 雾气, 远处小城",
              evidence: { supported: [], visual_fill: [], conflicts: [] }, sources: [], annotations: [],
            },
            {
              plan_key: "n-linshui", parent_plan_key: "root-cover", location_ref: "loc-linshui", title: "临水城",
              level: "city", summary: "依雾河而建的省城", visual_brief: "临水城全景: 雾河绕城, 城东码头, 城北旧城墙",
              prompt: "写实暗色水彩, 河畔中国城市全景, 码头, 旧城墙",
              evidence: { supported: ["临水城依雾河而建, 城东有码头"], visual_fill: [], conflicts: [] },
              sources: [{ source_type: "bible_page", source_id: "bp-linshui", open_target: { kind: "bible_page", slug: "bp-linshui" } }],
              annotations: [{ label: "码头", position_x: 0.72, position_y: 0.35 }],
            },
          ],
        }),
      },
    ],
  });
  const r = await planMapAtlas(root, provider, { run_kind: "initial" });
  console.log(`   run=${r.run.id} status=${r.run.status} 规划 ${r.run.planned_page_count} 页(prompt_only 候选, 本系统不生图 N28)`);

  console.log("③ adoptAtlasPlaceholder(空页占位, approval-gated)");
  const ph = await adoptAtlasPlaceholder(root, "root-cover", allowAll);
  console.log(`   已采用空页占位节点: ${ph.adoptedNodeIds.join("/")}`);

  console.log("④ importAtlasImage(本机路径 → 挂到 prompt_only 候选页, 置 review_ready)");
  const src = join(dataDir, "linshui.png");
  writeFileSync(src, pngBytes(640, 400));
  const imp = importAtlasImage(root, src, { nodeRef: "n-linshui" });
  console.log(`   页 ${imp.page.id} ← ${imp.page.image.file}(${imp.page.image.width}×${imp.page.image.height}, sha256 前12 ${imp.page.image.sha256.slice(0, 12)})`);

  console.log("⑤ adoptAtlasPage(approval + 祖先链原子 adopt; 图片永不进 git N29)");
  const adopted = await adoptAtlasPage(root, imp.page.id, {}, allowAll);
  console.log(`   已采用页 ${adopted.page.id}; 连带节点 ${adopted.adoptedNodeIds.join("/") || "无"}`);
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  console.log(`   git ls-files 含 images/? ${tracked.includes("images/") ? "是(违规!)" : "否 ✓"}`);

  console.log("⑥ 标签 CRUD(ann- 前缀, 坐标 0–1, content_hash 重算)");
  const annId = addAtlasAnnotation(root, imp.page.id, { label: "旧城墙", position_x: 0.3, position_y: 0.15 });
  updateAtlasAnnotation(root, imp.page.id, annId, { position_x: 0.32, label: "旧城墙(北)" });
  const tmp = addAtlasAnnotation(root, imp.page.id, { label: "临时", position_x: 0.5, position_y: 0.5 });
  deleteAtlasAnnotation(root, imp.page.id, tmp);
  const tree = readAtlasTree(root);
  const pg = tree.pages.find((p) => p.id === imp.page.id);
  console.log(`   现有标签: ${pg.annotations.map((a) => `${a.label}@(${a.position_x},${a.position_y})`).join(", ")}`);

  console.log("⑦ 地图册树");
  for (const n of tree.nodes) {
    const pages = tree.pages.filter((p) => p.node_ref === n.id);
    console.log(`   ${n.parent_ref ? "  " : ""}${n.title} [${n.level}]${n.is_placeholder ? " ◇空页占位" : ""}${pages.length ? ` ×${pages.length}页` : ""}`);
  }
  console.log(`\n演示完成 ✓ vault: ${root}(已自动清理)`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
