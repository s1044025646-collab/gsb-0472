# Liang 断字模式叠加与词内边界解释后端

离线英文单词断字服务。输入一组 Liang 风格断字模式与单词，计算可插入连字符的词内边界，并解释每个边界的模式来源。仅 TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无网络服务），Windows 本地直接运行。

## 环境要求

- Node.js ≥ 22.5（开发用的是 v25；`node:sqlite` 为内置实验模块，启动时有一条 ExperimentalWarning，属正常）
- 不需要 Docker / WSL / 任何外部 API

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（含独立基准核对）
npm start          # 启动 HTTP 服务，默认选择空闲端口
node dist/cli.js serve --port 8080   # 指定端口
```

演示（对应题目示例）：

```powershell
"a1b","ab2c" | Set-Content data\demo.txt
node dist/cli.js create demo --patterns data\demo.txt     # => 规则集 id=1
node dist/cli.js hyphenate 1 abcd --leftMin 1 --rightMin 1
# => {"hyphenated":"a-bcd","boundaries":[1],"scores":{"1":1,"2":2,"3":0}}
"a2b" | Set-Content data\p2.txt
node dist/cli.js add-patterns 1 --file data\p2.txt        # 版本 2，第一处被偶数 2 压制
"a3b" | Set-Content data\p3.txt
node dist/cli.js add-patterns 1 --file data\p3.txt        # 版本 3，奇数 3 恢复
node dist/cli.js explain 1 abcd 1                          # 查看边界 1 的最大值来源
```

## 模式语法

- 模式由小写字母 `a-z`、边界点号 `.`、单个数字 `0-9` 组成。
- 去掉数字得到待匹配字符序列；数字表示其左侧间隙的优先级，未写出的间隙为 0。
  - `a1bc` → 字母 `abc`，间隙权重 `[0,1,0,0]`
  - `ab2c` → 字母 `abc`，间隙权重 `[0,0,2,0]`
- 点号只允许在字符序列开头或结尾（如 `.a1b`、`ab2c.`），匹配时只对应文本两端。
- 禁止：连续数字（`a11b`）、无字母、点号出现在中间、大写或非法字符。
- 同一字母序列可有多条模式，全部参与叠加，不存在“后导入覆盖先导入”。

## 叠加与最大值规则

1. 单词小写后两端加点得到匹配文本，如 `abcd` → `.abcd.`。
2. 对每个模式在文本上寻找**全部出现位置（含重叠）**，逐字符精确比较，点号不是通配符。
3. 每次命中把模式各间隙权重映射到文本对应间隙；同一间隙取**所有来源的最大值**，不相加、不覆盖。
4. 词内边界 `i`（左边已有 `i` 个字母，`1..词长-1`）对应文本间隙 `i+1`；两侧点号间隙永不可断。
5. 最大权重为**奇数可断，偶数不可断**；较大的偶数会压制较小的奇数（`a1b`+`a2b` → 不可断），更大的奇数再恢复（`a3b`）。
6. 先完成全部叠加，再按 `leftMin`/`rightMin`（默认均为 2）过滤：断点左右至少保留的字母数。分值计算不受过滤影响。
7. 匹配统一小写，输出带连字符的词保留原大小写（`AbCd` → `A-bCd`）。

## 例外表

- 每条例外 = 一个单词 + 明确边界列表；空列表表示禁止断字。
- 命中例外时完全忽略模式推断，但仍应用 `leftMin`/`rightMin` 与首尾限制；返回中被长度规则过滤的边界列在 `exception.filteredOut`。
- 例外词按小写身份唯一；同一批导入中同一词边界冲突则**整批拒绝**（原子）。

## 规则版本

- 模式与例外组成冻结规则版本。每次追加模式或例外，版本号 +1。
- 每份报告记录产生它的版本号、原输入与过滤参数；旧报告不会因规则更新而改变含义。
- 数据保存在项目内 `data/liang.db`（可用环境变量 `LIANG_DB` 覆盖），重启后查询与解释结果一致。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rulesets` | 建规则集 `{name, patterns?, exceptions?}`，原子导入 |
| GET | `/rulesets/:id` | 规则集详情（含解析后的模式与例外） |
| GET | `/rulesets/:id/patterns` | 查看模式解析结果（字母序列 + 间隙权重） |
| POST | `/rulesets/:id/patterns` | 追加模式 `{patterns:[...]}`，原子，版本 +1 |
| POST | `/rulesets/:id/exceptions` | 导入例外 `{exceptions:[{word,boundaries}]}`，原子，版本 +1 |
| POST | `/rulesets/:id/hyphenate` | `{word}` 或 `{words:[...]}`，可选 `leftMin`/`rightMin` |
| GET | `/rulesets/:id/explain?word=&boundary=&limit=&offset=` | 某边界全部最大值来源，分页只影响返回切片 |
| POST | `/rulesets/:id/export` | 导出断字表 `{words:[...]}` |
| GET | `/rulesets/:id/reports` | 历史报告（含版本与过滤参数） |

批量查询逐词独立报告：非法词返回 `{index, ok:false, error}`，正常词保持原行序。

## CLI

```
node dist/cli.js create <名称> [--patterns 文件]
node dist/cli.js patterns <规则集id>
node dist/cli.js add-patterns <id> --file 文件
node dist/cli.js add-exceptions <id> --file 文件   # 每行: 单词 边界1,边界2（无边界列即空列表）
node dist/cli.js hyphenate <id> <词...> [--leftMin n --rightMin n]
node dist/cli.js explain <id> <词> <边界>
node dist/cli.js export <id> --file 词表
node dist/cli.js serve [--port n]
```

## 错误码

`INVALID_PATTERN` / `CONSECUTIVE_DIGITS` / `NO_LETTERS` / `INVALID_DOT` / `PATTERN_TOO_LONG`（模式非法）；`INVALID_WORD` / `WORD_TOO_LONG`（单词非法）；`INVALID_MIN` / `INVALID_BOUNDARY` / `INVALID_EXCEPTION_BOUNDARY`（参数非法）；`DUPLICATE_EXCEPTION_CONFLICT`（例外冲突）；`RULESET_NOT_FOUND` / `NOT_FOUND`（404）；`TOO_MANY_PATTERNS` / `BATCH_TOO_LARGE`（超限制）。

## 限制（内置上限）

- 单规则集模式数 ≤ 10000；单模式长度 ≤ 64；单词长度 ≤ 100；批量规模 ≤ 1000。
- 来源展示接口分页（`limit`/`offset`），但最大值始终完整计算，不受分页影响。
- 仅接受 ASCII 英文字母单词；不做排版、列宽、拼写纠错、词干提取、音频识别或子词训练。
- 输出只表示当前模式集允许的断字点，不保证符合自然语言断字习惯。

## 测试与基准

`npm test` 运行 16 个用例，覆盖：题目示例（`a1b`+`ab2c` 查询 `abcd`）、偶数压制与奇数恢复、边界点号（`.a1b` 仅词首生效）、重复字母重叠匹配、例外覆盖与最短长度过滤、空例外、连续数字拒绝、无数字模式、大小写保留、输入重排不变、短词空集合、导入原子性、例外冲突拒绝、版本冻结、重启一致性。

其中“基准核对”用例用**独立实现**（直接遍历文本所有子串逐一与模式比较）逐间隙核对分值与全部命中来源，不只核对最终带连字符字符串。
