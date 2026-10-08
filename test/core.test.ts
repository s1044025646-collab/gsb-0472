import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern, ApiError } from "../src/pattern";
import { hyphenateWord, overlay, explainBoundary } from "../src/hyphenate";

/** 独立基准: 直接遍历文本所有子串, 与模式字母序列逐一比较 */
function baselineScores(word: string, raws: string[]): Record<number, number> {
  const text = "." + word.toLowerCase() + ".";
  const parsed = raws.map(parsePattern);
  const max = new Array(text.length + 1).fill(0);
  for (let start = 0; start < text.length; start++) {
    for (let end = start + 1; end <= text.length; end++) {
      const sub = text.slice(start, end);
      for (const p of parsed) {
        if (sub !== p.letters) continue;
        for (let j = 0; j < p.weights.length; j++) {
          const gap = start + j;
          if (p.weights[j] > max[gap]) max[gap] = p.weights[j];
        }
      }
    }
  }
  const scores: Record<number, number> = {};
  for (let i = 1; i <= word.length - 1; i++) scores[i] = max[i + 1];
  return scores;
}

function checkAgainstBaseline(word: string, raws: string[]) {
  const patterns = raws.map(parsePattern);
  const r = hyphenateWord(word, patterns, { leftMin: 1, rightMin: 1 });
  assert.deepEqual(r.scores, baselineScores(word, raws), `scores mismatch for ${word}`);
  // 来源核对: 基准逐命中收集
  const text = "." + word.toLowerCase() + ".";
  const { hits } = overlay(text, patterns);
  for (let i = 1; i <= word.length - 1; i++) {
    const exp = explainBoundary(word, i, patterns);
    const baselineHits: { pattern: string; weight: number }[] = [];
    for (let start = 0; start <= text.length; start++) {
      for (const p of patterns) {
        if (text.slice(start, start + p.letters.length) !== p.letters) continue;
        const j = i + 1 - start;
        if (j >= 0 && j < p.weights.length && p.weights[j] > 0) {
          baselineHits.push({ pattern: p.raw, weight: p.weights[j] });
        }
      }
    }
    const byKey = (a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    const got = hits[i + 1].map((h) => ({ pattern: h.pattern, weight: h.weight })).sort(byKey);
    assert.deepEqual(got, baselineHits.sort(byKey), `hits mismatch for ${word}@${i}`);
    assert.equal(exp.maxWeight, r.scores[i]);
  }
}

test("模式解析: 权重与字母", () => {
  assert.deepEqual(parsePattern("a1bc"), { raw: "a1bc", letters: "abc", weights: [0, 1, 0, 0] });
  assert.deepEqual(parsePattern("ab2c"), { raw: "ab2c", letters: "abc", weights: [0, 0, 2, 0] });
  assert.deepEqual(parsePattern("abc"), { raw: "abc", letters: "abc", weights: [0, 0, 0, 0] });
  assert.deepEqual(parsePattern(".a1b"), { raw: ".a1b", letters: ".ab", weights: [0, 0, 1, 0] });
  assert.deepEqual(parsePattern("1ab"), { raw: "1ab", letters: "ab", weights: [1, 0, 0] });
});

test("模式解析: 非法输入拒绝", () => {
  assert.throws(() => parsePattern("a11b"), (e: ApiError) => e.code === "CONSECUTIVE_DIGITS");
  assert.throws(() => parsePattern("123"), (e: ApiError) => e.code === "CONSECUTIVE_DIGITS");
  assert.throws(() => parsePattern("1"), (e: ApiError) => e.code === "NO_LETTERS");
  assert.throws(() => parsePattern("a.b"), (e: ApiError) => e.code === "INVALID_DOT");
  assert.throws(() => parsePattern("ABC"), (e: ApiError) => e.code === "INVALID_PATTERN");
  assert.throws(() => parsePattern(""), (e: ApiError) => e.code === "INVALID_PATTERN");
});

test("题目示例: a1b + ab2c 查询 abcd", () => {
  const p = ["a1b", "ab2c"].map(parsePattern);
  const r = hyphenateWord("abcd", p, { leftMin: 1, rightMin: 1 });
  assert.equal(r.scores[1], 1);
  assert.equal(r.scores[2], 2);
  assert.deepEqual(r.boundaries, [1]);
  assert.equal(r.hyphenated, "a-bcd");
});

test("偶数压制奇数, 更大奇数恢复", () => {
  const r1 = hyphenateWord("abcd", ["a1b", "ab2c", "a2b"].map(parsePattern), { leftMin: 1, rightMin: 1 });
  assert.equal(r1.scores[1], 2);
  assert.deepEqual(r1.boundaries, []);
  const r2 = hyphenateWord("abcd", ["a1b", "ab2c", "a2b", "a3b"].map(parsePattern), { leftMin: 1, rightMin: 1 });
  assert.equal(r2.scores[1], 3);
  assert.deepEqual(r2.boundaries, [1]);
});

test("边界点号: .a1b 仅词首生效", () => {
  const p = [".a1b"].map(parsePattern);
  const head = hyphenateWord("abcd", p, { leftMin: 1, rightMin: 1 });
  assert.equal(head.scores[1], 1);
  const mid = hyphenateWord("xabc", p, { leftMin: 1, rightMin: 1 });
  assert.equal(mid.scores[1], 0);
  assert.equal(mid.scores[2], 0);
});

test("重叠匹配: 重复字母", () => {
  const p = ["a1a"].map(parsePattern);
  const r = hyphenateWord("aaa", p, { leftMin: 1, rightMin: 1 });
  assert.equal(r.scores[1], 1);
  assert.equal(r.scores[2], 1);
  assert.equal(r.hyphenated, "a-a-a");
});

test("leftMin/rightMin 过滤与默认 2", () => {
  const p = ["a1b"].map(parsePattern);
  const r = hyphenateWord("abcd", p);
  assert.deepEqual(r.boundaries, []); // 边界 1 被 leftMin=2 过滤
  assert.equal(r.scores[1], 1); // 先叠加后过滤, 分值仍在
});

test("大小写保留", () => {
  const r = hyphenateWord("AbCd", ["a1b"].map(parsePattern), { leftMin: 1, rightMin: 1 });
  assert.equal(r.hyphenated, "A-bCd");
});

test("例外表: 覆盖模式, 空列表禁止断字, 长度过滤报告", () => {
  const p = ["a1b", "b1c"].map(parsePattern);
  const exc = new Map([["abcd", [1, 3]]]);
  const r = hyphenateWord("abcd", p, { leftMin: 2, rightMin: 2, exceptions: exc });
  assert.deepEqual(r.boundaries, []);
  assert.deepEqual(r.exception, { boundaries: [], filteredOut: [1, 3] });
  const ban = hyphenateWord("abcd", p, { leftMin: 1, rightMin: 1, exceptions: new Map([["abcd", []]]) });
  assert.deepEqual(ban.boundaries, []);
});

test("短词返回空集合", () => {
  const r = hyphenateWord("ab", ["a1b"].map(parsePattern));
  assert.deepEqual(r.boundaries, []);
  assert.equal(r.scores[1], 1);
});

test("输入重排结果不变", () => {
  const a = hyphenateWord("abcd", ["a1b", "ab2c", "a3b"].map(parsePattern), { leftMin: 1, rightMin: 1 });
  const b = hyphenateWord("abcd", ["a3b", "ab2c", "a1b"].map(parsePattern), { leftMin: 1, rightMin: 1 });
  assert.deepEqual(a.scores, b.scores);
  assert.deepEqual(a.boundaries, b.boundaries);
});

test("基准核对: 多词多模式逐间隙分值与来源", () => {
  const raws = ["a1b", "ab2c", ".a1b", "b3c", "c1d2e", "a2a", "x9y"];
  for (const word of ["abcd", "aaa", "aabcde", "xyab", "abcabc"]) {
    checkAgainstBaseline(word, raws);
  }
});
