import { ApiError } from "./errors";

export const MAX_PATTERN_LENGTH = 64;

export interface ParsedPattern {
  /** 原始模式串，如 "a1b" */
  raw: string;
  /** 去掉数字后的待匹配字符序列（含首尾点号），如 ".ab" */
  seq: string;
  /** 间隙权重数组，长度 = seq.length + 1 */
  weights: number[];
}

/**
 * 解析 Liang 风格模式。
 * 规则：小写字母、边界点号与 0-9 单个数字交替；禁止连续数字；
 * 至少含一个字母；点号只允许出现在字符序列开头或结尾。
 */
export function parsePattern(raw: string): ParsedPattern {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError("INVALID_PATTERN", "模式不能为空字符串");
  }
  if (raw.length > MAX_PATTERN_LENGTH) {
    throw new ApiError("LIMIT_EXCEEDED", `模式长度超过 ${MAX_PATTERN_LENGTH}`);
  }
  let seq = "";
  const weights: number[] = [0];
  let prevDigit = false;
  let letterCount = 0;
  let letterSeen = false;
  let dotSeen = false;
  for (let idx = 0; idx < raw.length; idx++) {
    const ch = raw[idx];
    if (ch >= "0" && ch <= "9") {
      if (prevDigit) {
        throw new ApiError("CONSECUTIVE_DIGITS", `模式 "${raw}" 含连续数字`);
      }
      weights[weights.length - 1] = Number(ch);
      prevDigit = true;
    } else if (ch >= "a" && ch <= "z") {
      seq += ch;
      weights.push(0);
      prevDigit = false;
      letterCount++;
      letterSeen = true;
    } else if (ch === ".") {
      if (dotSeen) {
        throw new ApiError("MISPLACED_DOT", `模式 "${raw}" 含多个点号`);
      }
      if (letterSeen && idx !== raw.length - 1) {
        throw new ApiError("MISPLACED_DOT", `模式 "${raw}" 的点号只能出现在开头或结尾`);
      }
      seq += ch;
      weights.push(0);
      prevDigit = false;
      dotSeen = true;
    } else {
      throw new ApiError("INVALID_PATTERN", `模式 "${raw}" 含非法字符 "${ch}"`);
    }
  }
  if (letterCount === 0) {
    throw new ApiError("NO_LETTERS", `模式 "${raw}" 至少需要一个字母`);
  }
  return { raw, seq, weights };
}
