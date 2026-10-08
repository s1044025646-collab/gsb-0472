// 端到端演示：规则集 -> 模式 -> 例外 -> 断字 -> 解释 -> 导出
const { Store } = require("../dist/src/store");
const { Service } = require("../dist/src/service");

const store = new Store("data/demo.db");
const svc = new Service(store);

const rs = store.createRuleset("demo-" + Date.now());
console.log("规则集:", rs);

store.importPatterns(rs.id, ["a1b", "ab2c"]);
console.log("abcd (a1b+ab2c):", svc.hyphenateWords(rs.id, ["abcd"], 1, 1).results[0].result.hyphenated);

store.importPatterns(rs.id, ["a2b"]);
console.log("加入 a2b 抑制:", svc.hyphenateWords(rs.id, ["abcd"], 1, 1).results[0].result.hyphenated);

store.importPatterns(rs.id, ["a3b"]);
console.log("加入 a3b 恢复:", svc.hyphenateWords(rs.id, ["abcd"], 1, 1).results[0].result.hyphenated);

store.importPatterns(rs.id, [".a1b", "a1a"]);
console.log(".a1b 只匹配词首 abcd/xabcd:",
  svc.hyphenateWords(rs.id, ["abcd", "xabcd"], 1, 1).results.map((r) => r.result.hyphenated));
console.log("重叠匹配 aaaa:", svc.hyphenateWords(rs.id, ["aaaa"], 1, 1).results[0].result.hyphenated);

store.importExceptions(rs.id, [
  { word: "abcdef", points: [1, 3, 5] },
  { word: "silent", points: [] },
]);
const r = svc.hyphenateWords(rs.id, ["AbCd", "abcdef", "silent", "ab1"], 2, 2);
for (const item of r.results) {
  if (item.ok) {
    const x = item.result;
    console.log(`${x.word} -> ${x.hyphenated}` +
      (x.usedException ? ` (例外, 被长度过滤: [${x.filteredExceptionPoints}])` : ""));
  } else {
    console.log(`行 ${item.index + 1} 非法: ${item.error.code} ${item.error.message}`);
  }
}
console.log("边界解释 abcd@1:", svc.explain(rs.id, "abcd", 1));
console.log("报告已保存, reportId =", r.reportId, "version =", r.rulesetVersion);
store.close();
