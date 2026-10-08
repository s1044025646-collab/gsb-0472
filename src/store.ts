import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiError } from "./errors";
import { parsePattern, ParsedPattern } from "./pattern";

export const MAX_PATTERNS_PER_RULESET = 10000;
export const MAX_WORD_LENGTH = 64;
export const MAX_BATCH_SIZE = 1000;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rulesets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        raw TEXT NOT NULL,
        seq TEXT NOT NULL,
        weights TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_ruleset ON patterns(ruleset_id);
      CREATE TABLE IF NOT EXISTS exceptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        word TEXT NOT NULL,
        points TEXT NOT NULL,
        UNIQUE(ruleset_id, word)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        ruleset_version INTEGER NOT NULL,
        left_min INTEGER NOT NULL,
        right_min INTEGER NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close() { this.db.close(); }

  createRuleset(name: string) {
    if (!name || typeof name !== "string") {
      throw new ApiError("BAD_REQUEST", "规则集需要 name 字段");
    }
    const version = Date.now();
    const r = this.db
      .prepare("INSERT INTO rulesets(name, version) VALUES (?, ?)")
      .run(name, version);
    return { id: Number(r.lastInsertRowid), name, version };
  }

  getRuleset(id: number) {
    const row = this.db
      .prepare("SELECT id, name, version, created_at FROM rulesets WHERE id = ?")
      .get(id) as any;
    if (!row) throw new ApiError("NOT_FOUND", `规则集 ${id} 不存在`, 404);
    return row;
  }

  listRulesets() {
    return this.db
      .prepare("SELECT id, name, version, created_at FROM rulesets ORDER BY id")
      .all();
  }

  /** 原子导入模式：全部合法才提交，导入后版本号递增（冻结旧版本）。 */
  importPatterns(rulesetId: number, raws: string[]) {
    this.getRuleset(rulesetId);
    if (!Array.isArray(raws) || raws.length === 0) {
      throw new ApiError("BAD_REQUEST", "patterns 必须是非空数组");
    }
    const existing = (this.db
      .prepare("SELECT COUNT(*) AS c FROM patterns WHERE ruleset_id = ?")
      .get(rulesetId) as any).c as number;
    if (existing + raws.length > MAX_PATTERNS_PER_RULESET) {
      throw new ApiError("LIMIT_EXCEEDED", `模式数量超过上限 ${MAX_PATTERNS_PER_RULESET}`);
    }
    const parsed = raws.map((r) => parsePattern(r)); // 任一失败则整体拒绝
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(
        "INSERT INTO patterns(ruleset_id, raw, seq, weights) VALUES (?, ?, ?, ?)"
      );
      for (const p of parsed) {
        stmt.run(rulesetId, p.raw, p.seq, JSON.stringify(p.weights));
      }
      this.bumpVersion(rulesetId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { imported: parsed.length, version: this.getRuleset(rulesetId).version };
  }

  listPatterns(rulesetId: number): ParsedPattern[] {
    this.getRuleset(rulesetId);
    const rows = this.db
      .prepare("SELECT raw, seq, weights FROM patterns WHERE ruleset_id = ? ORDER BY id")
      .all(rulesetId) as any[];
    return rows.map((r) => ({
      raw: r.raw,
      seq: r.seq,
      weights: JSON.parse(r.weights),
    }));
  }

  /** 原子导入例外表；同一单词（小写身份）重复冲突整体拒绝。 */
  importExceptions(rulesetId: number, entries: { word: string; points: number[] }[]) {
    this.getRuleset(rulesetId);
    if (!Array.isArray(entries)) {
      throw new ApiError("BAD_REQUEST", "exceptions 必须是数组");
    }
    const seen = new Set<string>();
    for (const e of entries) {
      validateWord(e.word);
      const key = e.word.toLowerCase();
      if (seen.has(key)) {
        throw new ApiError("DUPLICATE_EXCEPTION", `例外单词 "${e.word}" 重复，整体拒绝`);
      }
      seen.add(key);
      if (!Array.isArray(e.points) || e.points.some((p) => !Number.isInteger(p) || p < 0)) {
        throw new ApiError("INVALID_BOUNDS", `例外 "${e.word}" 的边界列表非法`);
      }
    }
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(
        "INSERT INTO exceptions(ruleset_id, word, points) VALUES (?, ?, ?)"
      );
      for (const e of entries) {
        try {
          stmt.run(rulesetId, e.word.toLowerCase(), JSON.stringify([...new Set(e.points)].sort((a, b) => a - b)));
        } catch (err: any) {
          if (String(err.message).includes("UNIQUE")) {
            throw new ApiError("DUPLICATE_EXCEPTION", `例外单词 "${e.word}" 已存在，整体拒绝`);
          }
          throw err;
        }
      }
      this.bumpVersion(rulesetId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { imported: entries.length, version: this.getRuleset(rulesetId).version };
  }

  getExceptions(rulesetId: number): Map<string, number[]> {
    const rows = this.db
      .prepare("SELECT word, points FROM exceptions WHERE ruleset_id = ?")
      .all(rulesetId) as any[];
    return new Map(rows.map((r) => [r.word, JSON.parse(r.points)]));
  }

  saveReport(rulesetId: number, leftMin: number, rightMin: number, input: string, result: unknown) {
    const version = this.getRuleset(rulesetId).version;
    const r = this.db
      .prepare(
        "INSERT INTO reports(ruleset_id, ruleset_version, left_min, right_min, input, result) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(rulesetId, version, leftMin, rightMin, input, JSON.stringify(result));
    return { id: Number(r.lastInsertRowid), version };
  }

  getReport(id: number) {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as any;
    if (!row) throw new ApiError("NOT_FOUND", `报告 ${id} 不存在`, 404);
    return { ...row, result: JSON.parse(row.result) };
  }

  private bumpVersion(rulesetId: number) {
    const cur = this.getRuleset(rulesetId).version as number;
    const next = Math.max(Date.now(), cur + 1);
    this.db.prepare("UPDATE rulesets SET version = ? WHERE id = ?").run(next, rulesetId);
  }
}

export function validateWord(word: unknown): asserts word is string {
  if (typeof word !== "string" || !/^[A-Za-z]+$/.test(word)) {
    throw new ApiError("INVALID_WORD", `非法单词：${JSON.stringify(word)}（仅接受 ASCII 英文字母）`);
  }
  if (word.length > MAX_WORD_LENGTH) {
    throw new ApiError("LIMIT_EXCEEDED", `单词长度超过 ${MAX_WORD_LENGTH}`);
  }
}

export function validateMin(name: string, v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || (v as number) < 0) {
    throw new ApiError("INVALID_BOUNDS", `${name} 必须是非负整数`);
  }
  return v as number;
}
