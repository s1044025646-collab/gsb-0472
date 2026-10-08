import { Store, validateWord, validateMin, MAX_BATCH_SIZE } from "./store";
import { hyphenate, HyphenationResult } from "./engine";
import { ApiError } from "./errors";

/** 业务逻辑层：API 与 CLI 共用。 */
export class Service {
  constructor(public store: Store) {}

  hyphenateWords(rulesetId: number, words: string[], leftMin?: number, rightMin?: number) {
    const lm = validateMin("leftMin", leftMin, 2);
    const rm = validateMin("rightMin", rightMin, 2);
    if (!Array.isArray(words) || words.length === 0) {
      throw new ApiError("BAD_REQUEST", "words 必须是非空数组");
    }
    if (words.length > MAX_BATCH_SIZE) {
      throw new ApiError("LIMIT_EXCEEDED", `批量规模超过上限 ${MAX_BATCH_SIZE}`);
    }
    const patterns = this.store.listPatterns(rulesetId);
    const exceptions = this.store.getExceptions(rulesetId);
    // 逐词报告非法输入，正常词仍保留原行序
    const results: ({ index: number } & (
      | { ok: true; result: HyphenationResult }
      | { ok: false; error: { code: string; message: string } }
    ))[] = words.map((w, index) => {
      try {
        validateWord(w);
        return {
          index,
          ok: true as const,
          result: hyphenate(w, patterns, { leftMin: lm, rightMin: rm, exceptions }),
        };
      } catch (e: any) {
        return {
          index,
          ok: false as const,
          error: { code: e.code ?? "BAD_REQUEST", message: e.message },
        };
      }
    });
    const report = this.store.saveReport(rulesetId, lm, rm, JSON.stringify(words), results);
    return { reportId: report.id, rulesetVersion: report.version, leftMin: lm, rightMin: rm, results };
  }

  /** 查询某词某边界的全部最大值来源（分页只影响展示，不影响最大值计算）。 */
  explain(rulesetId: number, word: string, position: number, page = 1, pageSize = 50) {
    validateWord(word);
    if (!Number.isInteger(position) || position < 1 || position > word.length - 1) {
      throw new ApiError("INVALID_BOUNDS", `边界位置必须在 1..${word.length - 1}`);
    }
    const patterns = this.store.listPatterns(rulesetId);
    const res = hyphenate(word, patterns, {
      leftMin: 0,
      rightMin: 0,
      exceptions: this.store.getExceptions(rulesetId),
    });
    const gap = res.gaps.find((g) => g.position === position)!;
    const start = (page - 1) * pageSize;
    return {
      word,
      position,
      weight: gap.weight,
      hyphenatableByWeight: gap.weight % 2 === 1,
      totalSources: gap.sources.length,
      sources: gap.sources.slice(start, start + pageSize),
      page,
      pageSize,
    };
  }

  /** 导出断字表：当前规则集全部模式与例外（冻结版本快照）。 */
  exportTable(rulesetId: number) {
    const rs = this.store.getRuleset(rulesetId);
    return {
      ruleset: rs,
      patterns: this.store.listPatterns(rulesetId),
      exceptions: Object.fromEntries(this.store.getExceptions(rulesetId)),
    };
  }
}
