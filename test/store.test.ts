import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store";
import { hyphenateWord } from "../src/hyphenate";
import { ApiError } from "../src/pattern";

const TMP = path.join(__dirname, "..", "data", "test-store.db");

function freshStore() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TMP + suffix); } catch {}
  }
  return new Store(TMP);
}

test("规则集导入原子性: 含坏模式整体失败", () => {
  const s = freshStore();
  assert.throws(() => s.createRuleset("bad", ["a1b", "a11b"]), (e: ApiError) => e.code === "CONSECUTIVE_DIGITS");
  assert.throws(() => s.getRuleset(1), (e: ApiError) => e.code === "RULESET_NOT_FOUND");
  s.close();
});

test("例外冲突整体拒绝, 空例外合法", () => {
  const s = freshStore();
  assert.throws(
    () => s.createRuleset("exc", [], [{ word: "Test", boundaries: [1] }, { word: "test", boundaries: [2] }]),
    (e: ApiError) => e.code === "DUPLICATE_EXCEPTION_CONFLICT"
  );
  const rs = s.createRuleset("ok", ["a1b"], [{ word: "abc", boundaries: [] }]);
  assert.equal(rs.version, 1);
  s.close();
});

test("版本冻结: 追加模式产生新版本, 报告记录当时版本", () => {
  const s = freshStore();
  const rs = s.createRuleset("v", ["a1b"]);
  const r1 = hyphenateWord("abcd", s.listPatterns(rs.id), { leftMin: 1, rightMin: 1 });
  s.saveReport(rs.id, "hyphenate", { word: "abcd" }, 1, 1, r1);
  s.addPatterns(rs.id, ["a2b"]);
  const r2 = hyphenateWord("abcd", s.listPatterns(rs.id), { leftMin: 1, rightMin: 1 });
  s.saveReport(rs.id, "hyphenate", { word: "abcd" }, 1, 1, r2);
  const reports = s.listReports(rs.id) as any[];
  assert.equal(reports[0].version, 1);
  assert.equal(reports[1].version, 2);
  assert.equal(JSON.parse(reports[0].result).scores["1"], 1);
  assert.equal(JSON.parse(reports[1].result).scores["1"], 2);
  s.close();
});

test("重启后查询一致", () => {
  const s1 = freshStore();
  const rs = s1.createRuleset("persist", ["a1b", "ab2c"], [{ word: "abcd", boundaries: [2] }]);
  s1.close();
  const s2 = new Store(TMP);
  const r = hyphenateWord("abcd", s2.listPatterns(rs.id), { leftMin: 1, rightMin: 1, exceptions: s2.listExceptions(rs.id) });
  assert.deepEqual(r.boundaries, [2]);
  s2.close();
});
