import { ParsedPattern } from "./pattern";

export interface GapSource {
  pattern: string;
  /** 模式命中在匹配文本中的起始下标 */
  offset: number;
  /** 该来源在该间隙上的权重 */
  weight: number;
}

export interface GapResult {
  /** 原单词左边已有的字母数，1..word.length-1 为词内边界 */
  position: number;
  weight: number;
  hyphenatable: boolean;
  sources: GapSource[];
}

export interface HyphenationResult {
  word: string;
  hyphenated: string;
  points: number[];
  gaps: GapResult[];
  usedException: boolean;
  /** 例外表中被左右最短长度规则过滤掉的边界 */
  filteredExceptionPoints: number[];
}

/**
 * 计算匹配文本（"." + 小写单词 + "."）上每个间隙的最大权重与全部最大值来源。
 * 返回数组下标即文本间隙 g（0..text.length），词内边界 m 对应文本间隙 m+1。
 */
export function computeGapWeights(
  word: string,
  patterns: ParsedPattern[]
): { weights: number[]; sources: GapSource[][] } {
  const text = "." + word.toLowerCase() + ".";
  const n = text.length + 1;
  const weights = new Array<number>(n).fill(0);
  const sources: GapSource[][] = Array.from({ length: n }, () => []);
  for (const p of patterns) {
    const L = p.seq.length;
    for (let i = 0; i + L <= text.length; i++) {
      let ok = true;
      for (let k = 0; k < L; k++) {
        if (text[i + k] !== p.seq[k]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let k = 0; k <= L; k++) {
        const w = p.weights[k];
        if (w === 0) continue;
        const g = i + k;
        if (w > weights[g]) {
          weights[g] = w;
          sources[g] = [{ pattern: p.raw, offset: i, weight: w }];
        } else if (w === weights[g]) {
          sources[g].push({ pattern: p.raw, offset: i, weight: w });
        }
      }
    }
  }
  return { weights, sources };
}

export interface HyphenateOptions {
  leftMin?: number;
  rightMin?: number;
  /** 例外表：小写单词 -> 明确边界列表（可为空数组表示禁止断字） */
  exceptions?: Map<string, number[]>;
}

export function hyphenate(
  word: string,
  patterns: ParsedPattern[],
  opts: HyphenateOptions = {}
): HyphenationResult {
  const leftMin = opts.leftMin ?? 2;
  const rightMin = opts.rightMin ?? 2;
  const len = word.length;
  const lower = word.toLowerCase();
  const ex = opts.exceptions?.get(lower);

  let points: number[];
  let gaps: GapResult[] = [];
  let filtered: number[] = [];
  if (ex !== undefined) {
    // 例外命中：忽略模式推断，仍应用左右最短长度与首尾限制
    const uniq = [...new Set(ex)].sort((a, b) => a - b);
    points = [];
    for (const m of uniq) {
      if (m < 1 || m > len - 1) continue; // 首尾间隙永远不可断
      if (m < leftMin || len - m < rightMin) {
        filtered.push(m);
        continue;
      }
      points.push(m);
    }
    gaps = points.map((m) => ({
      position: m,
      weight: 1,
      hyphenatable: true,
      sources: [{ pattern: "(exception)", offset: 0, weight: 1 }],
    }));
  } else {
    const { weights, sources } = computeGapWeights(word, patterns);
    points = [];
    for (let m = 1; m <= len - 1; m++) {
      const g = m + 1; // 文本间隙下标
      const w = weights[g];
      const ok = w % 2 === 1 && m >= leftMin && len - m >= rightMin;
      gaps.push({
        position: m,
        weight: w,
        hyphenatable: ok,
        sources: sources[g],
      });
      if (ok) points.push(m);
    }
  }
  let hyphenated = "";
  for (let i = 0; i < len; i++) {
    hyphenated += word[i];
    if (points.includes(i + 1)) hyphenated += "-";
  }
  return {
    word,
    hyphenated,
    points,
    gaps,
    usedException: ex !== undefined,
    filteredExceptionPoints: filtered,
  };
}
