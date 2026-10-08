import { ParsedPattern } from "./pattern";
import { ApiError } from "./pattern";

export interface SourceHit {
  pattern: string;
  letters: string;
  /** 命中在加点文本中的起始下标 */
  position: number;
  /** 命中贡献到该边界的权重 */
  weight: number;
}

export interface WordResult {
  word: string;
  hyphenated: string;
  /** 可断边界(左侧字母数, 1..len-1) */
  boundaries: number[];
  /** 每个词内边界的最大权重 */
  scores: Record<number, number>;
  /** 例外命中信息 */
  exception?: { boundaries: number[]; filteredOut: number[] };
}

const MAX_WORD_LEN = 100;

export function validateWord(word: unknown): string {
  if (typeof word !== "string" || !/^[A-Za-z]+$/.test(word)) {
    throw new ApiError("INVALID_WORD", `单词必须为 ASCII 英文字母: ${String(word)}`);
  }
  if (word.length > MAX_WORD_LEN) {
    throw new ApiError("WORD_TOO_LONG", `单词长度超过 ${MAX_WORD_LEN}`);
  }
  return word;
}

/** 计算加点文本上每个间隙的最大权重及全部命中 */
export function overlay(
  text: string,
  patterns: ParsedPattern[]
): { max: number[]; hits: SourceHit[][] } {
  const m = text.length;
  const max = new Array<number>(m + 1).fill(0);
  const hits: SourceHit[][] = Array.from({ length: m + 1 }, () => []);
  for (const p of patterns) {
    const k = p.letters.length;
    for (let pos = 0; pos + k <= m; pos++) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (text[pos + j] !== p.letters[j]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let j = 0; j <= k; j++) {
        const w = p.weights[j];
        if (w === 0) continue;
        const gap = pos + j;
        hits[gap].push({ pattern: p.raw, letters: p.letters, position: pos, weight: w });
        if (w > max[gap]) max[gap] = w;
      }
    }
  }
  return { max, hits };
}

export interface HyphenateOptions {
  leftMin?: number;
  rightMin?: number;
  /** 例外表: 小写单词 -> 边界列表 */
  exceptions?: Map<string, number[]>;
}

export function hyphenateWord(
  word: string,
  patterns: ParsedPattern[],
  opts: HyphenateOptions = {}
): WordResult {
  validateWord(word);
  const leftMin = opts.leftMin ?? 2;
  const rightMin = opts.rightMin ?? 2;
  if (!Number.isInteger(leftMin) || leftMin < 0 || !Number.isInteger(rightMin) || rightMin < 0) {
    throw new ApiError("INVALID_MIN", "leftMin/rightMin 必须为非负整数");
  }
  const len = word.length;
  const lower = word.toLowerCase();
  const scores: Record<number, number> = {};

  const exc = opts.exceptions?.get(lower);
  if (exc !== undefined) {
    const kept: number[] = [];
    const filteredOut: number[] = [];
    for (const b of [...new Set(exc)].sort((a, b) => a - b)) {
      if (!Number.isInteger(b) || b < 1 || b > len - 1) {
        throw new ApiError("INVALID_EXCEPTION_BOUNDARY", `例外边界越界: ${b} (词 ${word})`);
      }
      if (b >= leftMin && len - b >= rightMin) kept.push(b);
      else filteredOut.push(b);
    }
    return {
      word,
      hyphenated: insertHyphens(word, kept),
      boundaries: kept,
      scores,
      exception: { boundaries: kept, filteredOut },
    };
  }

  const text = "." + lower + ".";
  const { max } = overlay(text, patterns);
  const boundaries: number[] = [];
  for (let i = 1; i <= len - 1; i++) {
    const w = max[i + 1]; // 文本间隙: 点前间隙 0, 词内边界 i -> i+1
    scores[i] = w;
    if (w % 2 === 1 && i >= leftMin && len - i >= rightMin) boundaries.push(i);
  }
  return { word, hyphenated: insertHyphens(word, boundaries), boundaries, scores };
}

export function insertHyphens(word: string, boundaries: number[]): string {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    if (boundaries.includes(i)) out += "-";
    out += word[i];
  }
  return out;
}

/** 某边界全部最大值来源(完整计算, 分页仅作用于返回切片) */
export function explainBoundary(
  word: string,
  boundary: number,
  patterns: ParsedPattern[]
): { maxWeight: number; sources: SourceHit[] } {
  validateWord(word);
  if (!Number.isInteger(boundary) || boundary < 1 || boundary > word.length - 1) {
    throw new ApiError("INVALID_BOUNDARY", `边界须在 1..${word.length - 1}`);
  }
  const text = "." + word.toLowerCase() + ".";
  const { max, hits } = overlay(text, patterns);
  const gap = boundary + 1;
  const maxWeight = max[gap];
  return { maxWeight, sources: hits[gap].filter((h) => h.weight === maxWeight) };
}
