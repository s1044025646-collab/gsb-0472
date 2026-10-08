import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePattern, ParsedPattern, ApiError } from "./pattern";

export const MAX_PATTERNS = 10000;
export const MAX_BATCH = 1000;

export interface RulesetRow {
  id: number;
  name: string;
  version: number;
  created_at: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rulesets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        raw TEXT NOT NULL,
        letters TEXT NOT NULL,
        weights TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exceptions (
        ruleset_id INTEGER NOT NULL REFERENCES rulesets(id),
        word TEXT NOT NULL,
        boundaries TEXT NOT NULL,
        PRIMARY KEY (ruleset_id, word)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ruleset_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        input TEXT NOT NULL,
        left_min INTEGER NOT NULL,
        right_min INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  getRuleset(id: number): RulesetRow {
    const row = this.db.prepare("SELECT * FROM rulesets WHERE id = ?").get(id) as RulesetRow | undefined;
    if (!row) throw new ApiError("RULESET_NOT_FOUND", `规则集不存在: ${id}`, 404);
    return row;
  }

  createRuleset(name: string, patterns: string[] = [], exceptions: { word: string; boundaries: number[] }[] = []): RulesetRow {
    if (!name || typeof name !== "string") throw new ApiError("INVALID_NAME", "规则集名称不能为空");
    if (patterns.length > MAX_PATTERNS) throw new ApiError("TOO_MANY_PATTERNS", `模式数超过 ${MAX_PATTERNS}`);
    const parsed = patterns.map(parsePattern); // 先全部解析, 失败则不落库
    const tx = this.db.prepare("SELECT 1");
    void tx;
    this.db.exec("BEGIN");
    try {
      const info = this.db.prepare("INSERT INTO rulesets (name, version, created_at) VALUES (?, 1, ?)")
        .run(name, new Date().toISOString());
      const id = Number(info.lastInsertRowid);
      this.insertPatterns(id, parsed);
      this.insertExceptions(id, exceptions);
      this.db.exec("COMMIT");
      return this.getRuleset(id);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private insertPatterns(rulesetId: number, parsed: ParsedPattern[]) {
    const stmt = this.db.prepare("INSERT INTO patterns (ruleset_id, raw, letters, weights, seq) VALUES (?, ?, ?, ?, ?)");
    parsed.forEach((p, i) => stmt.run(rulesetId, p.raw, p.letters, JSON.stringify(p.weights), i));
  }

  private insertExceptions(rulesetId: number, exceptions: { word: string; boundaries: number[] }[]) {
    const seen = new Map<string, string>();
    for (const e of exceptions) {
      if (typeof e.word !== "string" || !/^[A-Za-z]+$/.test(e.word)) {
        throw new ApiError("INVALID_WORD", `例外词非法: ${String(e.word)}`);
      }
      if (!Array.isArray(e.boundaries) || e.boundaries.some((b) => !Number.isInteger(b) || b < 0)) {
        throw new ApiError("INVALID_EXCEPTION_BOUNDARY", `例外边界须为非负整数数组: ${e.word}`);
      }
      const key = e.word.toLowerCase();
      const sig = JSON.stringify([...e.boundaries].sort((a, b) => a - b));
      if (seen.has(key) && seen.get(key) !== sig) {
        throw new ApiError("DUPLICATE_EXCEPTION_CONFLICT", `例外词冲突: ${e.word}`);
      }
      seen.set(key, sig);
    }
    const stmt = this.db.prepare("INSERT INTO exceptions (ruleset_id, word, boundaries) VALUES (?, ?, ?)");
    for (const [word, sig] of seen) stmt.run(rulesetId, word, sig);
  }

  addPatterns(rulesetId: number, patterns: string[]): RulesetRow {
    this.getRuleset(rulesetId);
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM patterns WHERE ruleset_id = ?").get(rulesetId) as { c: number };
    if (count.c + patterns.length > MAX_PATTERNS) throw new ApiError("TOO_MANY_PATTERNS", `模式数超过 ${MAX_PATTERNS}`);
    const parsed = patterns.map(parsePattern);
    this.db.exec("BEGIN");
    try {
      const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), -1) AS s FROM patterns WHERE ruleset_id = ?").get(rulesetId) as { s: number };
      const stmt = this.db.prepare("INSERT INTO patterns (ruleset_id, raw, letters, weights, seq) VALUES (?, ?, ?, ?, ?)");
      parsed.forEach((p, i) => stmt.run(rulesetId, p.raw, p.letters, JSON.stringify(p.weights), maxSeq.s + 1 + i));
      this.bumpVersion(rulesetId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.getRuleset(rulesetId);
  }

  addExceptions(rulesetId: number, exceptions: { word: string; boundaries: number[] }[]): RulesetRow {
    this.getRuleset(rulesetId);
    this.db.exec("BEGIN");
    try {
      this.insertExceptions(rulesetId, exceptions);
      this.bumpVersion(rulesetId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.getRuleset(rulesetId);
  }

  private bumpVersion(rulesetId: number) {
    this.db.prepare("UPDATE rulesets SET version = version + 1 WHERE id = ?").run(rulesetId);
  }

  listPatterns(rulesetId: number): ParsedPattern[] {
    this.getRuleset(rulesetId);
    const rows = this.db.prepare("SELECT raw, letters, weights FROM patterns WHERE ruleset_id = ? ORDER BY seq").all(rulesetId) as unknown as { raw: string; letters: string; weights: string }[];
    return rows.map((r) => ({ raw: r.raw, letters: r.letters, weights: JSON.parse(r.weights) }));
  }

  listExceptions(rulesetId: number): Map<string, number[]> {
    this.getRuleset(rulesetId);
    const rows = this.db.prepare("SELECT word, boundaries FROM exceptions WHERE ruleset_id = ?").all(rulesetId) as unknown as { word: string; boundaries: string }[];
    return new Map(rows.map((r) => [r.word, JSON.parse(r.boundaries)]));
  }

  saveReport(rulesetId: number, kind: string, input: unknown, leftMin: number, rightMin: number, result: unknown) {
    const rs = this.getRuleset(rulesetId);
    this.db.prepare("INSERT INTO reports (ruleset_id, version, kind, input, left_min, right_min, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(rulesetId, rs.version, kind, JSON.stringify(input), leftMin, rightMin, JSON.stringify(result), new Date().toISOString());
  }

  listReports(rulesetId: number) {
    this.getRuleset(rulesetId);
    return this.db.prepare("SELECT * FROM reports WHERE ruleset_id = ? ORDER BY id").all(rulesetId);
  }
}
