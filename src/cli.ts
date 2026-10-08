#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store";
import { Service } from "./service";
import { startServer } from "./server";

const DATA_DIR = process.env.HYPHEN_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.HYPHEN_DB ?? path.join(DATA_DIR, "hyphen.db");

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function readJsonArg(arg: string): any {
  // 支持内联 JSON 或 @文件路径
  if (arg.startsWith("@")) return JSON.parse(fs.readFileSync(arg.slice(1), "utf8"));
  return JSON.parse(arg);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (cmd === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 0; // 0 = 自动选择空闲端口
    await startServer(DB_PATH, port);
    return;
  }
  const store = new Store(DB_PATH);
  const svc = new Service(store);
  try {
    switch (cmd) {
      case "create-ruleset":
        out(store.createRuleset(args[0] ?? "default"));
        break;
      case "list-rulesets":
        out(store.listRulesets());
        break;
      case "import-patterns": {
        // node cli.js import-patterns <rulesetId> '["a1b","ab2c"]' 或 @file.json
        out(store.importPatterns(Number(args[0]), readJsonArg(args[1])));
        break;
      }
      case "list-patterns":
        out(store.listPatterns(Number(args[0])));
        break;
      case "import-exceptions": {
        // '[{"word":"example","points":[3,5]}]'
        out(store.importExceptions(Number(args[0]), readJsonArg(args[1])));
        break;
      }
      case "hyphenate": {
        // node cli.js hyphenate <rulesetId> word1 word2 ... [--leftMin 1] [--rightMin 1]
        const id = Number(args[0]);
        const words: string[] = [];
        let leftMin: number | undefined, rightMin: number | undefined;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--leftMin") leftMin = Number(args[++i]);
          else if (args[i] === "--rightMin") rightMin = Number(args[++i]);
          else words.push(args[i]);
        }
        const r = svc.hyphenateWords(id, words, leftMin, rightMin);
        for (const item of r.results) {
          if (item.ok) console.log(item.result.hyphenated);
          else console.error(`[行 ${item.index + 1}] ${item.error.code}: ${item.error.message}`);
        }
        console.error(`报告已保存: reportId=${r.reportId} version=${r.rulesetVersion}`);
        break;
      }
      case "explain":
        out(svc.explain(Number(args[0]), args[1], Number(args[2])));
        break;
      case "export":
        out(svc.exportTable(Number(args[0])));
        break;
      case "report":
        out(store.getReport(Number(args[0])));
        break;
      default:
        console.error(`用法:
  node dist/src/cli.js serve [--port N]            启动 HTTP 服务（默认自动选空闲端口）
  node dist/src/cli.js create-ruleset [name]
  node dist/src/cli.js list-rulesets
  node dist/src/cli.js import-patterns <id> '["a1b","ab2c"]'
  node dist/src/cli.js list-patterns <id>
  node dist/src/cli.js import-exceptions <id> '[{"word":"example","points":[3]}]'
  node dist/src/cli.js hyphenate <id> word... [--leftMin N] [--rightMin N]
  node dist/src/cli.js explain <id> <word> <pos>
  node dist/src/cli.js export <id>
  node dist/src/cli.js report <reportId>`);
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(`${e.code ?? "ERROR"}: ${e.message}`);
  process.exitCode = 1;
});
