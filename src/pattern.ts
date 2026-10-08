export interface ParsedPattern {
  raw: string;
  letters: string;
  weights: number[];
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const MAX_PATTERN_LEN = 64;

export function parsePattern(raw: string): ParsedPattern {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError("INVALID_PATTERN", "模式不能为空字符串");
  }
  if (raw.length > MAX_PATTERN_LEN) {
    throw new ApiError("PATTERN_TOO_LONG", `模式长度超过 ${MAX_PATTERN_LEN}`);
  }
  if (!/^[a-z0-9.]+$/.test(raw)) {
    throw new ApiError("INVALID_PATTERN", `模式含非法字符: ${raw}`);
  }
  if (/[0-9]{2}/.test(raw)) {
    throw new ApiError("CONSECUTIVE_DIGITS", `模式含连续数字: ${raw}`);
  }
  const dotCount = (raw.match(/\./g) || []).length;
  if (dotCount > 2 || (dotCount > 0 && !/^\.?[a-z0-9]+\.?$/.test(raw))) {
    throw new ApiError("INVALID_DOT", `点号只允许出现在字符序列开头或结尾: ${raw}`);
  }
  const letters = raw.replace(/[0-9]/g, "");
  if (!/[a-z]/.test(letters)) {
    throw new ApiError("NO_LETTERS", `模式至少含一个字母: ${raw}`);
  }
  // 间隙权重: 字母序列长度 k -> k+1 个间隙, 默认 0
  const k = letters.length;
  const weights = new Array<number>(k + 1).fill(0);
  // 逐字符扫描, 数字作用于其左侧间隙
  let gap = 0; // 当前字符前的间隙下标
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === ".") { gap++; continue; } // 点号占据字符序列位置
    if (c >= "0" && c <= "9") {
      weights[gap] = Number(c);
    } else {
      gap++;
    }
  }
  return { raw, letters, weights };
}
