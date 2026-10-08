import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store";
import { Service } from "../src/service";
import { ApiError } from "../src/errors";

function fresh() {
  const store = new Store(":memory:");
  return { store, svc: new Service(store) };
}

test("规则集导入原子性：含非法模式整体拒绝", () => {
  const { store } = fresh();
  const rs = store.createRuleset("t");
  assert.throws(
    () => store.importPatterns(rs.id, ["a1b", "a11b"]),
    (e: ApiError) => e.code === "CONSECUTIVE_DIGITS"
  );
  assert.equal(store.listPatterns(rs.id).length, 0);
});

test("例外重复冲突整体拒绝", () => {
  const { store } = fresh();
  const rs = store.createRuleset("t");
  assert.throws(
    () => store.importExceptions(rs.id, [
      { word: "Abc", points: [1] },
      { word: "abc", points: [2] },
    ]),
    (e: ApiError) => e.code === "DUPLICATE_EXCEPTION"
  );
  assert.equal(store.getExceptions(rs.id).size, 0);
});

test("批量查询：非法词逐词报告，正常词保留原行序", () => {
  const { store, svc } = fresh();
  const rs = store.createRuleset("t");
  store.importPatterns(rs.id, ["a1b"]);
  const r = svc.hyphenateWords(rs.id, ["abcd", "ab1", "xbcd"], 1, 1);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, false);
  assert.equal(r.results[2].ok, true);
  assert.deepEqual(r.results.map((x) => x.index), [0, 1, 2]);
  if (r.results[1].ok) assert.fail("应为错误");
  else assert.equal(r.results[1].error.code, "INVALID_WORD");
});

test("规则版本冻结：导入后版本变化，旧报告保留旧版本号", () => {
  const { store, svc } = fresh();
  const rs = store.createRuleset("t");
  store.importPatterns(rs.id, ["a1b"]);
  const v1 = store.getRuleset(rs.id).version;
  const r1 = svc.hyphenateWords(rs.id, ["abcd"], 1, 1);
  store.importPatterns(rs.id, ["a2b"]);
  const v2 = store.getRuleset(rs.id).version;
  assert.notEqual(v1, v2);
  const report = store.getReport(r1.reportId);
  assert.equal(report.ruleset_version, v1);
  // 新查询使用新模式：a2b 压制 a1b
  const r2 = svc.hyphenateWords(rs.id, ["abcd"], 1, 1);
  if (r2.results[0].ok) assert.equal(r2.results[0].result.hyphenated, "abcd");
  else assert.fail("应成功");
});

test("explain 返回全部最大值来源", () => {
  const { store, svc } = fresh();
  const rs = store.createRuleset("t");
  store.importPatterns(rs.id, ["a1b", "ab2c"]);
  const e = svc.explain(rs.id, "abcd", 1);
  assert.equal(e.weight, 1);
  assert.equal(e.totalSources, 1);
  assert.equal(e.sources[0].pattern, "a1b");
  const e2 = svc.explain(rs.id, "abcd", 2);
  assert.equal(e2.weight, 2);
  assert.equal(e2.hyphenatableByWeight, false);
});
