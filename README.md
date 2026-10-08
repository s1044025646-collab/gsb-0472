# Liang 断字模式叠加与词内边界解释后端

离线英文单词断字服务。输入一组 Liang 风格模式与单词，计算可插入连字符的词内边界，并解释每个边界的模式来源。只做 API 与 CLI，不做整段排版、列宽、拼写纠错、词干提取等。算法输出只表示当前模式集允许的断字点，不保证符合自然语言断字习惯。

技术栈：TypeScript + Node.js（内置 node:http 与 node:sqlite，零运行时依赖），Windows 本地运行，无需 Docker / WSL / 外部服务。

## 快速开始

    npm install        # 仅安装开发依赖 typescript / @types/node
    npm run build      # 编译到 dist/
    npm test           # 编译并运行全部测试
    npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
    npm run demo       # 端到端演示

数据目录默认为项目内 data/（可用环境变量 HYPHEN_DATA_DIR、HYPHEN_DB 覆盖）。端口用 --port N 指定，缺省为 0（操作系统分配空闲端口），启动后控制台打印实际地址。

## 模式语法

模式由小写字母、边界点号 . 与单个数字 0-9 交替组成：

- 去掉数字得到待匹配字符序列 seq；数字表示其左侧间隙的优先级权重，未写出的间隙为 0。
- 禁止连续数字；至少含一个字母；点号只允许出现在字符序列的开头或结尾（表示词首/词尾锚点，是字面字符，不是通配符）。
- 例：a1bc → 序列 abc，权重 [0,1,0,0]；ab2c → [0,0,2,0]；.a1b 只匹配以 ab 开头的词。
- 同一字母序列可有多条模式，后导入的不会覆盖先导入的，一律按最大值叠加。

## 索引与最大值规则

匹配文本为 "." + 单词小写 + "."。文本间隙 g（0..text.length）表示第 g 个字符之后的位置。模式在文本偏移 i 处命中时，其第 k 个权重映射到文本间隙 i+k：

- 每个文本间隙取所有来源权重的最大值（不相加、不覆盖）；并列最大值的来源全部记录，用于解释。
- 词内边界位置用原单词左边已有的字母数表示（1..词长-1），对应文本间隙 位置+1，不含两侧点号下标。
- 最大权重为奇数的间隙可断，偶数不可断；较大的偶数会压制已有的奇数（如 a1b+a2b → 权重 2 不可断，再加 a3b → 权重 3 恢复）。
- 先做模式叠加，再按 leftMin / rightMin（默认均为 2）过滤；首尾间隙永远不可断，短词返回空集合。
- 匹配统一小写，输出带连字符的词保留原大小写。

## 例外表

每条例外给出一个单词与明确边界列表（可为空数组表示禁止断字）。命中例外时忽略模式推断，但仍应用左右最短长度与首尾限制，并在结果中返回被长度规则过滤掉的例外边界 filteredExceptionPoints。例外词按小写身份唯一，同批或库内重复冲突时整体拒绝（原子导入）。

## 规则版本

模式与例外组成冻结规则版本：每次成功导入版本号递增，查询报告记录当时的 ruleset_version，旧报告不会自动引用最新模式。报告持久化在 SQLite 中，服务重启后查询与解释结果一致。

## HTTP API

- POST   /rulesets                                建规则集 {name}
- GET    /rulesets 、 /rulesets/:id               列出 / 查看规则集
- POST   /rulesets/:id/patterns                   原子导入模式 {patterns:[...]}
- GET    /rulesets/:id/patterns                   查看模式解析结果（raw/seq/weights）
- POST   /rulesets/:id/exceptions                 原子导入例外 {exceptions:[{word,points}]}
- GET    /rulesets/:id/exceptions                 查看例外表
- POST   /rulesets/:id/hyphenate                  断字 {words:[...],leftMin?,rightMin?}
- GET    /rulesets/:id/explain?word=&pos=&page=   某边界全部最大值来源（分页只影响展示）
- GET    /rulesets/:id/export                     导出断字表（模式+例外+版本快照）
- GET    /reports/:id                             查询历史报告

错误统一返回 {"error":{"code","message"}}，错误码包括：INVALID_PATTERN、CONSECUTIVE_DIGITS、NO_LETTERS、MISPLACED_DOT、INVALID_WORD、INVALID_BOUNDS、DUPLICATE_EXCEPTION、LIMIT_EXCEEDED、NOT_FOUND、BAD_REQUEST。

批量断字逐词校验：非法词单独报错，正常词保留原行序（index 字段）。规则集导入则要求原子成功。

## CLI

    node dist/src/cli.js serve [--port N]
    node dist/src/cli.js create-ruleset [name]
    node dist/src/cli.js import-patterns <id> "@demo/patterns.json"
    node dist/src/cli.js list-patterns <id>
    node dist/src/cli.js import-exceptions <id> "@demo/exceptions.json"
    node dist/src/cli.js hyphenate <id> word1 word2 ... [--leftMin N] [--rightMin N]
    node dist/src/cli.js explain <id> <word> <pos>
    node dist/src/cli.js export <id>
    node dist/src/cli.js report <reportId>

JSON 参数支持内联字符串或 @文件路径（PowerShell 下推荐文件方式避免转义问题）。

## 限制

- 单词仅接受 ASCII 英文字母，长度不超过 64；模式长度不超过 64；每规则集模式数不超过 10000；批量不超过 1000 词。
- 模式匹配为朴素子串扫描，教学规模足够；大规模模式表未做 Aho-Corasick 等优化。
- 输出只反映所给模式集，不代表真实语言断字质量。

## 测试

npm test 运行 18 个用例，覆盖：任务书示例（a1b/ab2c/a2b/a3b）、边界点号锚定、重叠匹配、例外覆盖与长度过滤、模式重排不变性、无数字模式、空例外、连续数字拒绝、大小写保留、导入原子性、版本冻结，以及一个独立基准（对每个间隙直接遍历所有子串重新计算最大值与来源数量）与引擎结果逐间隙核对。
