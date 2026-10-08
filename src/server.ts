import * as http from "node:http";
import { Store } from "./store";
import { Service } from "./service";
import { ApiError } from "./errors";

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
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("BAD_REQUEST", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  const svc = new Service(store);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "GET" ? {} : await readBody(req);

      if (method === "POST" && url.pathname === "/rulesets") {
        return send(res, 201, store.createRuleset(body.name));
      }
      if (method === "GET" && url.pathname === "/rulesets") {
        return send(res, 200, store.listRulesets());
      }
      if (parts[0] === "rulesets" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new ApiError("BAD_REQUEST", "规则集 id 非法");
        const sub = parts[2];
        if (method === "GET" && !sub) return send(res, 200, store.getRuleset(id));
        if (method === "POST" && sub === "patterns")
          return send(res, 201, store.importPatterns(id, body.patterns));
        if (method === "GET" && sub === "patterns")
          return send(res, 200, store.listPatterns(id));
        if (method === "POST" && sub === "exceptions")
          return send(res, 201, store.importExceptions(id, body.exceptions));
        if (method === "GET" && sub === "exceptions")
          return send(res, 200, Object.fromEntries(store.getExceptions(id)));
        if (method === "POST" && sub === "hyphenate")
          return send(res, 200, svc.hyphenateWords(id, body.words, body.leftMin, body.rightMin));
        if (method === "GET" && sub === "explain") {
          return send(res, 200, svc.explain(
            id,
            url.searchParams.get("word") ?? "",
            Number(url.searchParams.get("pos")),
            Number(url.searchParams.get("page") ?? 1),
            Number(url.searchParams.get("pageSize") ?? 50)
          ));
        }
        if (method === "GET" && sub === "export")
          return send(res, 200, svc.exportTable(id));
      }
      if (method === "GET" && parts[0] === "reports" && parts.length === 2) {
        return send(res, 200, store.getReport(Number(parts[1])));
      }
      throw new ApiError("NOT_FOUND", `未知路由 ${method} ${url.pathname}`, 404);
    } catch (e: any) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
    }
  });
}

export function startServer(dbPath: string, port: number): Promise<{ port: number; close: () => void }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as any;
      console.log(`断字服务已启动: http://127.0.0.1:${addr.port} (数据: ${dbPath})`);
      resolve({
        port: addr.port,
        close: () => server.close(() => store.close()),
      });
    });
  });
}
