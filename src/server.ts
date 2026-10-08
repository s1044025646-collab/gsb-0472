import * as http from "node:http";
import { Store, MAX_BATCH } from "./store";
import { hyphenateWord, explainBoundary, WordResult } from "./hyphenate";
import { ApiError } from "./pattern";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError("INVALID_JSON", "请求体不是合法 JSON"); }
}

function batchResults(store: Store, rulesetId: number, words: unknown[], leftMin?: number, rightMin?: number) {
  if (!Array.isArray(words) || words.length === 0) throw new ApiError("INVALID_BATCH", "words 须为非空数组");
  if (words.length > MAX_BATCH) throw new ApiError("BATCH_TOO_LARGE", `批量规模超过 ${MAX_BATCH}`);
  const patterns = store.listPatterns(rulesetId);
  const exceptions = store.listExceptions(rulesetId);
  const results: ({ index: number } & ({ ok: true; result: WordResult } | { ok: false; error: { code: string; message: string } }))[] = [];
  words.forEach((w, index) => {
    try {
      results.push({ index, ok: true, result: hyphenateWord(w as string, patterns, { leftMin, rightMin, exceptions }) });
    } catch (e) {
      if (e instanceof ApiError) results.push({ index, ok: false, error: { code: e.code, message: e.message } });
      else throw e;
    }
  });
  return results;
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const body = req.method === "POST" ? await readBody(req) : {};

      if (req.method === "POST" && url.pathname === "/rulesets") {
        return send(res, 201, store.createRuleset(body.name, body.patterns ?? [], body.exceptions ?? []));
      }
      if (parts[0] === "rulesets" && parts[1]) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new ApiError("INVALID_ID", "规则集 id 非法");
        if (req.method === "GET" && parts.length === 2) {
          const rs = store.getRuleset(id);
          return send(res, 200, { ...rs, patterns: store.listPatterns(id), exceptions: Object.fromEntries(store.listExceptions(id)) });
        }
        if (req.method === "GET" && parts[2] === "patterns") return send(res, 200, store.listPatterns(id));
        if (req.method === "POST" && parts[2] === "patterns") return send(res, 200, store.addPatterns(id, body.patterns ?? []));
        if (req.method === "POST" && parts[2] === "exceptions") return send(res, 200, store.addExceptions(id, body.exceptions ?? []));
        if (req.method === "POST" && parts[2] === "hyphenate") {
          const leftMin = body.leftMin, rightMin = body.rightMin;
          if (body.word !== undefined) {
            const patterns = store.listPatterns(id);
            const exceptions = store.listExceptions(id);
            const result = hyphenateWord(body.word, patterns, { leftMin, rightMin, exceptions });
            store.saveReport(id, "hyphenate", body, leftMin ?? 2, rightMin ?? 2, result);
            return send(res, 200, result);
          }
          const results = batchResults(store, id, body.words, leftMin, rightMin);
          store.saveReport(id, "hyphenate-batch", body, leftMin ?? 2, rightMin ?? 2, results);
          return send(res, 200, results);
        }
        if (req.method === "GET" && parts[2] === "explain") {
          const word = url.searchParams.get("word") ?? "";
          const boundary = Number(url.searchParams.get("boundary"));
          const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 50));
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
          const { maxWeight, sources } = explainBoundary(word, boundary, store.listPatterns(id));
          return send(res, 200, { word, boundary, maxWeight, total: sources.length, sources: sources.slice(offset, offset + limit) });
        }
        if (req.method === "POST" && parts[2] === "export") {
          const results = batchResults(store, id, body.words, body.leftMin, body.rightMin);
          const table = results.map((r) => r.ok ? { word: r.result.word, hyphenated: r.result.hyphenated, boundaries: r.result.boundaries } : { index: r.index, error: (r as any).error });
          store.saveReport(id, "export", body, body.leftMin ?? 2, body.rightMin ?? 2, table);
          return send(res, 200, table);
        }
        if (req.method === "GET" && parts[2] === "reports") return send(res, 200, store.listReports(id));
      }
      throw new ApiError("NOT_FOUND", "路由不存在", 404);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(e);
      return send(res, 500, { error: { code: "INTERNAL", message: "服务器内部错误" } });
    }
  });
}
