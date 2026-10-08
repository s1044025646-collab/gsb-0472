import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store";
import { hyphenateWord, explainBoundary } from "./hyphenate";
import { createServer } from "./server";
import { ApiError } from "./pattern";

const DB_PATH = process.env.LIANG_DB ?? path.join(process.cwd(), "data", "liang.db");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "create": {
        const name = args[0];
        const patterns = flag(args, "patterns") ? readLines(flag(args, "patterns")!) : [];
        const rs = store.createRuleset(name, patterns);
        console.log(JSON.stringify(rs));
        break;
      }
      case "patterns":
        console.log(JSON.stringify(store.listPatterns(Number(args[0])), null, 2));
        break;
      case "add-patterns":
        console.log(JSON.stringify(store.addPatterns(Number(args[0]), readLines(flag(args, "file")!))));
        break;
      case "add-exceptions": {
        const list = readLines(flag(args, "file")!).map((line) => {
          const [word, bounds = ""] = line.split(/\s+/);
          return { word, boundaries: bounds ? bounds.split(",").map(Number) : [] };
        });
        console.log(JSON.stringify(store.addExceptions(Number(args[0]), list)));
        break;
      }
      case "hyphenate": {
        const id = Number(args[0]);
        const words: string[] = [];
        for (let i = 1; i < args.length; i++) {
          if (args[i].startsWith("--")) i++;
          else words.push(args[i]);
        }
        const leftMin = flag(args, "leftMin") !== undefined ? Number(flag(args, "leftMin")) : undefined;
        const rightMin = flag(args, "rightMin") !== undefined ? Number(flag(args, "rightMin")) : undefined;
        const patterns = store.listPatterns(id);
        const exceptions = store.listExceptions(id);
        for (const w of words) {
          const r = hyphenateWord(w, patterns, { leftMin, rightMin, exceptions });
          store.saveReport(id, "hyphenate", { word: w }, leftMin ?? 2, rightMin ?? 2, r);
          console.log(JSON.stringify(r));
        }
        break;
      }
      case "explain": {
        const { maxWeight, sources } = explainBoundary(args[1], Number(args[2]), store.listPatterns(Number(args[0])));
        console.log(JSON.stringify({ maxWeight, sources }, null, 2));
        break;
      }
      case "export": {
        const id = Number(args[0]);
        const words = readLines(flag(args, "file")!);
        const patterns = store.listPatterns(id);
        const exceptions = store.listExceptions(id);
        const table = words.map((w) => {
          const r = hyphenateWord(w, patterns, { exceptions });
          return { word: r.word, hyphenated: r.hyphenated, boundaries: r.boundaries };
        });
        store.saveReport(id, "export", { words }, 2, 2, table);
        console.log(JSON.stringify(table, null, 2));
        break;
      }
      case "serve": {
        const portArg = flag(args, "port");
        const server = createServer(store);
        server.listen(portArg ? Number(portArg) : 0, () => {
          const addr = server.address();
          console.log(`Liang 断字服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : "?"}`);
        });
        return; // 不关闭 store
      }
      default:
        console.log(`用法: node dist/cli.js <命令>
  create <名称> [--patterns 文件]        建规则集
  patterns <规则集id>                    查看模式解析
  add-patterns <id> --file 文件          追加模式(原子, 版本+1)
  add-exceptions <id> --file 文件        导入例外(每行: 单词 边界1,边界2 或仅单词)
  hyphenate <id> <词...> [--leftMin n --rightMin n]
  explain <id> <词> <边界>               查询边界最大值来源
  export <id> --file 词表                导出断字表
  serve [--port n]                       启动 HTTP 服务(默认空闲端口)`);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exitCode = 2;
    } else throw e;
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main();
