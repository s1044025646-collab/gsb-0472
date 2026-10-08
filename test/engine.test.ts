import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePattern, ParsedPattern } from "../src/pattern";
import { computeGapWeights, hyphenate } from "../src/engine";
import { ApiError } from "../src/errors";

const P = (raws: string[]): ParsedPattern[] => raws.map(parsePattern);

test("模式解析：权重映射", () => {
  assert.deepEqual(parsePattern("a1bc"), { raw: "a1bc", seq: "abc", weights: [0, 1, 0, 0] });
  assert.deepEqual(parsePattern("ab2c"), { raw: "ab2c", seq: "abc", weights: [0, 0, 2, 0] });
  assert.deepEqual(parsePattern(".a1b"), { raw: ".a1b", seq: ".ab", weights: [0, 0, 1, 0] });
  assert.deepEqual(parsePattern("ab."), { raw: "ab.", seq: "ab.", weights: [0, 0, 0, 0] });
  assert.deepEqual(parsePattern("abc"), { raw: "abc", seq: "abc", weights: [0, 0, 0, 0] });
});

test("模式解析：非法输入拒绝", () => {
  assert.throws(() => parsePattern("a11b"), (e: ApiError) => e.code === "CONSECUTIVE_DIGITS");
  assert.throws(() => parsePattern("1"), (e: ApiError) => e.code === "NO_LETTERS");
  assert.throws(() => parsePattern("."), (e: ApiError) => e.code === "NO_LETTERS");
  assert.throws(() => parsePattern("a.b"), (e: ApiError) => e.code === "MISPLACED_DOT");
  assert.throws(() => parsePattern(".a.b"), (e: ApiError) => e.code === "MISPLACED_DOT");
  assert.throws(() => parsePattern("ab.1"), (e: ApiError) => e.code === "MISPLACED_DOT");
  assert.throws(() => parsePattern("AB1c"), (e: ApiError) => e.code === "INVALID_PATTERN");
  assert.throws(() => parsePattern(""), (e: ApiError) => e.code === "INVALID_PATTERN");
});

test("示例：a1b + ab2c 查询 abcd（leftMin=rightMin=1）", () => {
  const r = hyphenate("abcd", P(["a1b", "ab2c"]), { leftMin: 1, rightMin: 1 });
  assert.equal(r.gaps[0].weight, 1);
  assert.equal(r.gaps[0].hyphenatable, true);
  assert.equal(r.gaps[1].weight, 2);
  assert.equal(r.gaps[1].hyphenatable, false);
  assert.equal(r.hyphenated, "a-bcd");
});

test("偶数压制奇数：a2b 抑制，a3b 恢复", () => {
  const base = ["a1b", "ab2c"];
  let r = hyphenate("abcd", P([...base, "a2b"]), { leftMin: 1, rightMin: 1 });
  assert.equal(r.gaps[0].weight, 2);
  assert.equal(r.gaps[0].hyphenatable, false);
  assert.equal(r.hyphenated, "abcd");
  r = hyphenate("abcd", P([...base, "a2b", "a3b"]), { leftMin: 1, rightMin: 1 });
  assert.equal(r.gaps[0].weight, 3);
  assert.equal(r.gaps[0].hyphenatable, true);
  assert.equal(r.hyphenated, "a-bcd");
});

test("同字母序列多条模式取最大而非覆盖", () => {
  const r = hyphenate("abcd", P(["a3b", "a1b"]), { leftMin: 1, rightMin: 1 });
  assert.equal(r.gaps[0].weight, 3); // 后导入的 a1b 不能覆盖 a3b
});

test("边界点号：.a1b 只匹配以 ab 开头的词", () => {
  const p = P([".a1b"]);
  assert.equal(hyphenate("abcd", p, { leftMin: 1, rightMin: 1 }).hyphenated, "a-bcd");
  assert.equal(hyphenate("xabcd", p, { leftMin: 1, rightMin: 1 }).hyphenated, "xabcd");
  // 点号是字面字符，不是任意字符
  const r = hyphenate("abcd", P(["z1a1b"]), { leftMin: 1, rightMin: 1 });
  assert.equal(r.hyphenated, "abcd");
});

test("重叠匹配：重复字母", () => {
  const { weights } = computeGapWeights("aaaa", P(["a1a"]));
  // 文本 .aaaa.，模式 a1a 在偏移 1 和 2 各命中一次
  assert.equal(weights[2], 1); // a|a
  assert.equal(weights[3], 1); // 重叠命中 aa|a
  assert.equal(weights[4], 1);
});

test("默认 leftMin=rightMin=2，短词返回空集合", () => {
  assert.deepEqual(hyphenate("abcd", P(["a1b", "ab2c"])).points, []);
  assert.deepEqual(hyphenate("ab", P(["a1b"])).points, []);
  const r = hyphenate("abcdef", P(["a1b"]), {});
  assert.deepEqual(r.points, []); // 位置 1 不满足 leftMin=2
});

test("大小写保留：匹配统一小写，输出保留原大小写", () => {
  const r = hyphenate("AbCd", P(["a1b"]), { leftMin: 1, rightMin: 1 });
  assert.equal(r.hyphenated, "A-bCd");
});

test("例外表覆盖模式，空列表禁止断字", () => {
  const patterns = P(["a1b", "b1c"]);
  const ex = new Map([["abcd", [2]]]);
  const r = hyphenate("abcd", patterns, { leftMin: 1, rightMin: 1, exceptions: ex });
  assert.equal(r.usedException, true);
  assert.deepEqual(r.points, [2]); // 模式给的 1 被忽略
  const blocked = hyphenate("abcd", patterns, {
    leftMin: 1, rightMin: 1, exceptions: new Map([["abcd", []]]),
  });
  assert.deepEqual(blocked.points, []);
  assert.equal(blocked.hyphenated, "abcd");
});

test("例外边界被最短长度过滤并报告", () => {
  const r = hyphenate("abcdef", [], {
    leftMin: 2, rightMin: 2,
    exceptions: new Map([["abcdef", [1, 3, 5]]]),
  });
  assert.deepEqual(r.points, [3]);
  assert.deepEqual(r.filteredExceptionPoints, [1, 5]);
});

test("模式输入重排结果不变", () => {
  const a = hyphenate("abcd", P(["a1b", "ab2c", "a2b"]), { leftMin: 1, rightMin: 1 });
  const b = hyphenate("abcd", P(["a2b", "ab2c", "a1b"]), { leftMin: 1, rightMin: 1 });
  assert.deepEqual(a.gaps.map((g) => g.weight), b.gaps.map((g) => g.weight));
  assert.equal(a.hyphenated, b.hyphenated);
});

test("独立基准：遍历所有子串核对每个间隙分值与来源", () => {
  const words = ["abcd", "aaaa", "xabyabz", "ABCd"];
  const patternSets = [
    ["a1b", "ab2c"],
    ["a1a", ".a2b", "b3c.", "aa1aa", "z9z"],
    ["a1b", "a2b", "a3b", "abc", ".a1b", "b1c", "c1d", "1a", "d1"],
  ];
  for (const raws of patternSets) {
    const patterns = P(raws);
    for (const word of words) {
      const text = "." + word.toLowerCase() + ".";
      const { weights, sources } = computeGapWeights(word, patterns);
      // 基准：对每个间隙独立枚举所有模式的所有出现位置
      for (let g = 0; g <= text.length; g++) {
        let best = 0;
        let bestCount = 0;
        for (const p of patterns) {
          for (let i = 0; i + p.seq.length <= text.length; i++) {
            if (text.substring(i, i + p.seq.length) !== p.seq) continue;
            const k = g - i;
            if (k < 0 || k > p.seq.length) continue;
            const w = p.weights[k];
            if (w > best) { best = w; bestCount = 1; }
            else if (w === best && w > 0) { bestCount++; }
          }
        }
        assert.equal(weights[g], best, `word=${word} gap=${g} patterns=${raws}`);
        assert.equal(sources[g].length, bestCount, `sources word=${word} gap=${g}`);
        for (const s of sources[g]) assert.equal(s.weight, best);
      }
    }
  }
});
