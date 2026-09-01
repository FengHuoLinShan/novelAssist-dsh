#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const SCHEMA = 'novelcraft-publish-bundle/v1';
const CURRENT_CHAPTER_STATUSES = new Set(['draft', 'published', 'canonical']);

class PublishError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new PublishError(code, message); };

function xml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function scanLine(text, start) {
  let end = start;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
  if (end >= text.length) return { end, next: end };
  return { end, next: end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : 1) };
}

function parseFrontmatter(raw, file) {
  const opening = scanLine(raw, 0);
  if (!/^---[ \t]*$/.test(raw.slice(0, opening.end))) fail('INVALID_CHAPTER', `${file} 缺少 frontmatter`);
  for (let start = opening.next; start < raw.length;) {
    const line = scanLine(raw, start);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(raw.slice(start, line.end))) {
      let data;
      try { data = parseYaml(raw.slice(opening.next, start)); }
      catch (error) { fail('INVALID_CHAPTER', `${file} frontmatter 无法解析: ${error instanceof Error ? error.message : String(error)}`); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_CHAPTER', `${file} frontmatter 必须是对象`);
      return { data, body: raw.slice(line.next) };
    }
    start = line.next;
  }
  fail('INVALID_CHAPTER', `${file} frontmatter 未闭合`);
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    fail('GIT_UNAVAILABLE', `git 读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readChapters(root) {
  const dir = path.join(root, 'chapters');
  if (!existsSync(dir)) fail('NO_CHAPTERS', '缺少 chapters 目录');
  const chapters = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name === 'pending') continue;
    if (!entry.isFile() || !/^\d{3}\.md$/.test(entry.name)) {
      fail('INVALID_CHAPTER_PATH', `chapters 只允许 NNN.md 当前章和 pending/，发现 ${entry.name}`);
    }
    const index = Number(entry.name.slice(0, 3));
    const file = path.join(dir, entry.name);
    const bytes = readFileSync(file);
    const parsed = parseFrontmatter(bytes.toString('utf8'), `chapters/${entry.name}`);
    if (Number(parsed.data.chapter_index) !== index) fail('INVALID_CHAPTER', `${entry.name} chapter_index 与文件名不一致`);
    const status = String(parsed.data.status ?? '');
    if (!CURRENT_CHAPTER_STATUSES.has(status)) fail('INVALID_CHAPTER', `${entry.name} 状态 ${status || '(缺失)'} 不是当前正文`);
    if (!parsed.body.trim()) fail('INVALID_CHAPTER', `${entry.name} 正文为空`);
    const actual = sha256(parsed.body);
    const declared = String(parsed.data.content_hash ?? '').replace(/^sha256:/i, '').trim();
    if (declared !== actual) fail('INVALID_CHAPTER', `${entry.name} content_hash 与正文不一致`);
    chapters.push({
      index,
      file: `chapters/${entry.name}`,
      title: typeof parsed.data.title === 'string' && parsed.data.title.trim() ? parsed.data.title.trim() : `第 ${index} 章`,
      status,
      body: parsed.body,
      content_hash: actual,
      file_sha256: sha256(bytes),
    });
  }
  if (chapters.length === 0) fail('NO_CHAPTERS', '没有可发布的当前章节');
  return chapters;
}

function readResources(root) {
  const base = path.join(root, 'world', 'atlas', 'images');
  if (!existsSync(base)) return [];
  const resources = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail('INVALID_RESOURCE', `Atlas 资源不得是符号链接: ${rel}`);
      if (stat.isDirectory()) walk(full, rel);
      else if (stat.isFile()) resources.push({ rel, full, size: stat.size, sha256: sha256(readFileSync(full)) });
      else fail('INVALID_RESOURCE', `Atlas 资源不是普通文件: ${rel}`);
    }
  };
  walk(base);
  return resources;
}

function sourceSnapshot(root) {
  const bookFile = path.join(root, 'book.yml');
  if (!existsSync(bookFile) || !statSync(bookFile).isFile()) fail('INVALID_VAULT', '缺少 book.yml');
  const dirty = git(root, ['status', '--porcelain=v1', '--', 'book.yml', 'chapters']);
  if (dirty) fail('DIRTY_SOURCE', '书籍元数据或当前章节存在未接收修改，请先通过保存流程同步');
  const bookBytes = readFileSync(bookFile);
  let book;
  try { book = parseYaml(bookBytes.toString('utf8')); } catch { fail('INVALID_VAULT', 'book.yml 无法解析'); }
  const title = typeof book?.title === 'string' && book.title.trim() ? book.title.trim() : path.basename(root);
  const chapters = readChapters(root);
  const resources = readResources(root);
  const snapshot = {
    head: git(root, ['rev-parse', '--verify', 'HEAD']),
    book_hash: sha256(bookBytes),
    chapters: chapters.map(({ body, ...chapter }) => chapter),
    resources: resources.map(({ full, ...resource }) => ({ path: `world/atlas/images/${resource.rel}`, ...resource })),
  };
  return { title, chapters, resources, snapshot, hash: sha256(JSON.stringify(snapshot)) };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(0, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function run(text, props = '') {
  return `<w:r><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS" w:hint="eastAsia"/>${props}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function paragraph(text, style = 'Normal', extra = '') {
  const lines = String(text).split('\n');
  const content = lines.map((line, index) => `${index ? '<w:r><w:br/></w:r>' : ''}${run(line)}`).join('');
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${content}</w:p>`;
}

function documentXml(title, chapters, head) {
  const body = [
    paragraph(title, 'NovelTitle'),
    paragraph('NovelCraft 发布导出', 'NovelSubtitle'),
    paragraph(`源版本 ${head.slice(0, 12)}`, 'NovelMeta'),
  ];
  for (const chapter of chapters) {
    body.push(paragraph(chapter.title, 'FictionChapter'));
    for (const block of chapter.body.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/)) body.push(paragraph(block.trim(), 'Normal'));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}
<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/><w:headerReference w:type="first" r:id="rId5"/><w:footerReference w:type="first" r:id="rId6"/><w:titlePg/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="320" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl/><w:spacing w:before="0" w:after="160" w:line="320" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="NovelTitle"><w:name w:val="Novel Title"/><w:basedOn w:val="Normal"/><w:next w:val="NovelSubtitle"/><w:qFormat/><w:pPr><w:spacing w:before="2640" w:after="160"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS"/><w:color w:val="203748"/><w:sz w:val="60"/><w:szCs w:val="60"/><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="NovelSubtitle"><w:name w:val="Novel Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="NovelMeta"/><w:pPr><w:spacing w:after="80"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="2B5163"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="NovelMeta"><w:name w:val="Novel Metadata"/><w:basedOn w:val="Normal"/><w:next w:val="FictionChapter"/><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="FictionChapter"><w:name w:val="Fiction Chapter"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pageBreakBefore/><w:keepNext/><w:spacing w:before="0" w:after="240"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS"/><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
</w:styles>`;
}

function makeDocx(title, chapters, head) {
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/></Relationships>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="left"/><w:spacing w:after="0"/></w:pPr>${run(title, '<w:color w:val="777777"/><w:sz w:val="18"/>')}</w:p></w:hdr>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS"/><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  const emptyHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:hdr>';
  const emptyFooter = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:ftr>';
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>NovelCraft</dc:creator><cp:lastModifiedBy>NovelCraft</cp:lastModifiedBy></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>NovelCraft</Application></Properties>`;
  return zipStored([
    ['[Content_Types].xml', types], ['_rels/.rels', rootRels], ['docProps/core.xml', core], ['docProps/app.xml', app],
    ['word/document.xml', documentXml(title, chapters, head)], ['word/_rels/document.xml.rels', docRels],
    ['word/styles.xml', stylesXml()], ['word/settings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:compat/><w:defaultTabStop w:val="720"/></w:settings>'],
    ['word/header1.xml', header], ['word/footer1.xml', footer], ['word/header2.xml', emptyHeader], ['word/footer2.xml', emptyFooter],
  ]);
}

function zipNames(bytes) {
  const names = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    names.push(bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'));
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

function writeFailure(destination, source, error) {
  const file = `${destination}.failure.json`;
  if (existsSync(file)) return;
  try {
    writeFileSync(file, `${JSON.stringify({
      schema: SCHEMA,
      status: 'failed',
      failed_at: new Date().toISOString(),
      source_name: path.basename(source),
      code: error instanceof PublishError ? error.code : 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch {
    // The original failure remains authoritative; never overwrite an existing receipt.
  }
}

export function publishVault(vaultPath, destinationPath) {
  const source = path.resolve(vaultPath);
  const destination = path.resolve(destinationPath);
  let temporary;
  try {
    if (!existsSync(source) || !statSync(source).isDirectory()) fail('INVALID_VAULT', '源 vault 不存在');
    if (existsSync(destination)) fail('TARGET_EXISTS', `目标已存在，拒绝覆盖: ${destination}`);
    if (existsSync(`${destination}.failure.json`)) fail('FAILURE_RECEIPT_EXISTS', '旧失败回执存在，请先审阅并归档');
    const parent = path.dirname(destination);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) fail('INVALID_TARGET', '目标父目录不存在');
    const before = sourceSnapshot(source);
    temporary = path.join(parent, `.${path.basename(destination)}.novelcraft-publish-${randomUUID()}`);
    mkdirSync(temporary);
    const docx = makeDocx(before.title, before.chapters, before.snapshot.head);
    const required = ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml'];
    if (!required.every((name) => zipNames(docx).includes(name))) fail('DOCX_INVALID', 'DOCX OOXML 结构不完整');
    writeFileSync(path.join(temporary, 'manuscript.docx'), docx);
    for (const resource of before.resources) {
      const target = path.join(temporary, 'resources', 'world', 'atlas', 'images', resource.rel);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(resource.full, target);
      if (sha256(readFileSync(target)) !== resource.sha256) fail('RESOURCE_COPY_FAILED', `资源复核失败: ${resource.rel}`);
    }
    const after = sourceSnapshot(source);
    if (before.hash !== after.hash) fail('SOURCE_DRIFT', '导出期间源章节、HEAD 或资源发生变化');
    const manifest = {
      schema: SCHEMA,
      status: 'completed',
      generated_at: new Date().toISOString(),
      title: before.title,
      style_preset: 'narrative_proposal',
      style_overrides: ['fiction_chapter_heading', 'Arial Unicode MS CJK coverage'],
      source: { ...before.snapshot, snapshot_hash: before.hash },
      artifact: { file: 'manuscript.docx', bytes: docx.length, sha256: sha256(docx) },
      resource_count: before.resources.length,
    };
    writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(temporary, destination);
    temporary = undefined;
    return { ok: true, destination, docx: path.join(destination, 'manuscript.docx'), manifest: path.join(destination, 'manifest.json'), chapters: before.chapters.length, resources: before.resources.length, source_head: before.snapshot.head };
  } catch (error) {
    if (temporary && existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    writeFailure(destination, source, error);
    throw error;
  }
}

function selfTest(keep) {
  const root = keep ? path.resolve(keep) : mkdtempSync(path.join(os.tmpdir(), 'novelcraft-publish-'));
  if (keep) {
    if (existsSync(root)) fail('TARGET_EXISTS', `self-test 目录已存在: ${root}`);
    mkdirSync(root);
  }
  try {
    const vault = path.join(root, 'vault');
    mkdirSync(path.join(vault, 'chapters', 'pending'), { recursive: true });
    mkdirSync(path.join(vault, 'world', 'atlas', 'images', 'city'), { recursive: true });
    writeFileSync(path.join(vault, 'book.yml'), 'title: 雾城纪事\n', 'utf8');
    for (const [index, title, text] of [[1, '雾城初醒', '雨落了一夜。\n\n她在钟声里睁开眼睛。'], [2, '北闸', '北闸只在冬季开启。\n\n城外的灯火正在逼近。']]) {
      const body = `${text}\n`;
      writeFileSync(path.join(vault, 'chapters', `${String(index).padStart(3, '0')}.md`), `---\nchapter_index: ${index}\nstatus: published\ntitle: ${title}\ncontent_hash: ${sha256(body)}\n---\n${body}`, 'utf8');
    }
    writeFileSync(path.join(vault, 'world', 'atlas', 'images', 'city', 'map.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    git(vault, ['init', '-q']);
    git(vault, ['config', 'user.name', 'NovelCraft Test']);
    git(vault, ['config', 'user.email', 'test@novelcraft.invalid']);
    git(vault, ['add', 'book.yml', 'chapters']);
    git(vault, ['commit', '-q', '-m', 'fixture']);
    const result = publishVault(vault, path.join(root, 'bundle'));
    const docx = readFileSync(result.docx);
    if (docx.readUInt32LE(0) !== 0x04034b50 || !zipNames(docx).includes('word/document.xml')) fail('SELF_TEST', 'DOCX 不是有效 OOXML ZIP');
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    if (manifest.source.chapters.length !== 2 || manifest.resource_count !== 1 || manifest.artifact.sha256 !== sha256(docx)) fail('SELF_TEST', '发布 manifest 不闭合');
    writeFileSync(path.join(vault, 'chapters', '001.md'), `${readFileSync(path.join(vault, 'chapters', '001.md'), 'utf8')}\n未接收修改`, 'utf8');
    const failedDestination = path.join(root, 'failed-bundle');
    let rejected = false;
    try { publishVault(vault, failedDestination); } catch { rejected = true; }
    const failure = JSON.parse(readFileSync(`${failedDestination}.failure.json`, 'utf8'));
    if (!rejected || existsSync(failedDestination) || failure.status !== 'failed' || failure.code !== 'DIRTY_SOURCE') {
      fail('SELF_TEST', '失败回执或原子目标不正确');
    }
    return { self_test: 'ok', ...result };
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    const result = args[0] === '--self-test'
      ? selfTest(args[1] === '--keep' && args[2] ? args[2] : undefined)
      : args[0] === 'export' && args.length === 3
        ? publishVault(args[1], args[2])
        : fail('USAGE', 'usage: vault-publish.mjs export <vault> <new-bundle-dir> | --self-test [--keep <new-dir>]');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
