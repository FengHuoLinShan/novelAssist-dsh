// tokenizeRagText — 检索文本确定性分词(M6 Track A1, L0)。
// 规则:
// - CJK 字符(基本区 + 扩展A + 兼容区)按字输出单字, 且相邻 CJK 字输出 bigram(两字词不丢召回);
// - 拉丁字母/数字连续串小写化整词输出(大小写不敏感检索);
// - 其余字符(标点/空白/符号)为分隔符, 不产出词;
// - 空串/全标点输入返回 []。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM_RE = /[0-9a-zA-Z]/;

/** 是否 CJK 表意字符(按 code unit 判定; 扩展区字符均在 BMP 内)。 */
function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/** 是否拉丁字母/数字(ASCII)。 */
function isAlnum(ch: string): boolean {
  return ALNUM_RE.test(ch);
}

/** 纯确定性分词: 同输入恒同输出。 */
export function tokenizeRagText(text: string): string[] {
  const out: string[] = [];
  let alnum = "";
  let prevCjk = ""; // 上一个 CJK 字符(用于相邻 bigram; 非 CJK 邻居会断开链)。

  const flushAlnum = () => {
    if (alnum.length > 0) {
      out.push(alnum);
      alnum = "";
    }
  };

  for (const ch of text) {
    if (isCjk(ch)) {
      flushAlnum();
      out.push(ch);
      if (prevCjk !== "") {
        out.push(prevCjk + ch);
      }
      prevCjk = ch;
    } else if (isAlnum(ch)) {
      alnum += ch.toLowerCase();
      prevCjk = ""; // 字母/数字打断 bigram 链。
    } else {
      flushAlnum();
      prevCjk = ""; // 标点/空白打断 bigram 链。
    }
  }
  flushAlnum();
  return out;
}
