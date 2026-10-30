# 文档读取能力调研：PDF / Office

> **类型**：临时调研报告（只调研，未实施）
> **日期**：2026-10-30
> **背景**：R-21 已让附件支持任意位置 / 任意格式，但 PDF / Office 只交路径，模型看不见内容（R-22 未做）。
> **问题**：有没有成熟方案，直接给「程序」或「Agent」配上这类文件的读取识别能力？

---

## 1. 结论先说

**三条路线都成熟，但只有一条同时满足本仓库约束**（零/极小依赖、主进程内进程、离线可用、三平台不装原生 SDK）：

| 结论 | 内容 |
| --- | --- |
| ✅ 推荐基线 | **主进程内「文档抽取」能力**：PDF 用已在 `dependencies` 里的 `pdfjs-dist`（或换零依赖 `unpdf`）；docx / xlsx / pptx 用 **Node 自带 `zlib` 手写 ZIP+XML**（docx 本机已实测，约 35 行）；扫描件走「渲染成图片 → 视觉通道」，不用 OCR |
| ⚠️ 可选增强 | `unpdf` 2.x（2.4MB、零运行时依赖、自带扫描页检测）；`officeparser`（一把梭全格式 + 可选 OCR，但 +35MB、OCR 语言包再 +21MB） |
| ⛔ 不建议当基线 | SheetJS（npm 版停在 2022-03 的 0.18.5，新版只在自己的 CDN 发）、模型原生 PDF（SDK 内容模型只有 text/image）、外部 CLI（用户机器上不一定有） |

一句话：**不需要引入新依赖就能把 PDF/DOCX/XLSX/PPTX 的文本抽取做出来**；要「扫描件 OCR」或「Office 高保真结构」时才需要加依赖。

---

## 2. 现状与卡点（本地证据）

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 附件链路 | 只交路径 + 元信息（R-21） | `src/api/chatContext.ts` |
| Agent 读 PDF | `read` 把 buffer 当 utf8 文本 → 乱码/空 | `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js`：只有两支（图片 mime → 图片块；否则 `buffer.toString('utf-8')`） |
| SDK 内容模型 | **只有 `TextContent \| ImageContent`，没有 document 类型** | `pi-agent-core/dist/types.d.ts:372` `content: (TextContent \| ImageContent)[]` |
| 渲染层 PDF | 已有完整 pdf.js 6.4.299 阅读器（自绘 canvas、虚拟化） | `src/pdf/loadPdf.ts`、`src/components/PdfReadingView.tsx` |
| 依赖情况 | `pdfjs-dist@6.4.299` 已在 `dependencies`（35MB，**已经打进 app.asar**）；`unpdf@1.9.1` 已在 `node_modules`（`pi-web-access` 的传递依赖，2.4MB） | `package.json`、`npm ls unpdf` |
| MCP | SDK **内建** MCP（`mcp.json`、stdio/http、工具名 `mcp__<server>__<tool>`），但 `pi-bridge` 完全没接线（0 处命中） | `pi-coding-agent/dist/core/mcp-servers.d.ts`；`grep -rn mcp pi-bridge/src` 空 |
| 工具扩展点 | 可以给会话挂内联 extension（approval / plan / worktree 就是这么做的），工具结果可含图片 | `pi-bridge/src/agent-manager.ts:1457-1500`；`AgentToolResult.content: (TextContent \| ImageContent)[]` |

---

## 3. 候选方案矩阵

| # | 方案 | 新依赖 | 体积代价 | 离线 | 覆盖格式 | 保真度 | 扫描件 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | **零依赖自写**：`pdfjs-dist` + `node:zlib` 手解 ZIP+XML | 0 | 0（pdfjs 已在包里） | ✅ | pdf / docx / xlsx / pptx / odt 系 | 文本级（表格压平、无样式） | 需另配渲染 | 最符合仓库约束；代码量约 250 行 |
| B | **`unpdf`** 2.0.1 | 1（2.4MB，零运行时依赖） | +2.4MB | ✅ | pdf | 文本级 + 链接 / 元信息 / 页图 | ✅ `inspectPages` 判扫描页（v2） | 服务端版 pdf.js，专为 AI 抽取设计 |
| C | **`officeparser`** 8.4.1 | 1（+35MB unpacked，含 pdfjs 6.2 / fflate / xmldom） | +35MB；OCR 再 +21MB 语言包 | ✅（OCR 默认不下模型，但 tesseract 需 worker + wasm + 语言包路径） | docx/pptx/xlsx/odt/odp/ods/pdf/rtf/csv/md/html/epub/tex | 高（v8 有 TrueHeading/表格/XY-cut 版面还原、`to('text')` 栅格保真） | ✅ 懒加载 tesseract.js（`await import('tesseract.js')`，不用不启动） | 一把梭；engines `node>=22.13`（我们 24 ✅）；peer 里 pdf-lib / puppeteer 是可选 |
| D | `mammoth` + SheetJS/`exceljs` | 2–3 | mammoth ~1MB + xlsx 7.2MB | ✅ | docx→HTML/MD；xlsx 读 | 中（docx 结构较好，xlsx 数据好） | ❌ | SheetJS npm 版停在 2022；`exceljs` 2023 后未更新 |
| E | 外部 CLI：MarkItDown / pandoc / poppler / LibreOffice | 0（不打包） | 0 | ⚠️ 用户自装 | 极广（含老格式 .doc/.xls/.ppt） | 高（LibreOffice 最全） | 部分 | 微软 MarkItDown 是 Python 包、确定性解析无 ML；Agent 有 `bash` 就能用，但三平台可用性不可控 |
| F | MCP 文档服务器 | 0 | 0 | 视服务器 | 视服务器 | 视服务器 | 视服务器 | SDK 已支持，`pi-bridge` 只需接线；顺带解锁其它工具生态 |
| G | 模型原生 PDF（`document` block） | 0 | 0 | ❌ 在线 | pdf | **最高**（文本+版面+图表，原生视觉） | ✅ 原生可读 | Anthropic 支持 base64 / URL / `file_id` 三种来源；但 **SDK 内容模型无 document 类型**，要上游改动 |

关键数据（2026-10-30 查 npm registry）：

| 包 | 最新版 | 发布时间 | unpacked | 备注 |
| --- | --- | --- | --- | --- |
| `unpdf` | 2.0.1 | 2026-10-29 | 2.4MB | 无运行时依赖 |
| `officeparser` | 8.4.1 | 2026-10-29 | 35MB | 依赖 fflate / file-type / pdfjs-dist 6.2 / tesseract.js 7 / @xmldom |
| `mammoth` | 1.13.0 | 2026-09-26 | — | jszip 系，docx→HTML/MD |
| `tesseract.js` | 7.0.0 | 2025-12-15 | 1.3MB（+ core wasm） | `@tesseract.js-data/chi_sim` 单独 20.9MB |
| `xlsx`（SheetJS） | 0.18.5 | **2022-03-24** | 7.2MB | 官方已迁到 cdn.sheetjs.com |
| `exceljs` | 4.4.0 | 2023-10-19 | — | 维护停滞 |
| `pdfjs-dist`（本仓库） | 6.4.299 | — | 35MB | 已在 `dependencies` |

---

## 4. 分格式选型建议

| 格式 | 建议 | 说明 |
| --- | --- | --- |
| **PDF（有文本层）** | `pdfjs-dist` 取 `getTextContent()` 按页拼装（零新依赖），或 `unpdf.extractText()` | 按页分节输出，保留页码，便于 Agent 说「第 7 页」 |
| **PDF（扫描件）** | 判「每页文本 < 20 字符且图像覆盖率高」→ 渲染前 N 页为 PNG，走**视觉通道**（`ImageContent`，SDK 支持工具结果带图） | 不引入 OCR 就能读；渲染可用渲染层现成 pdf.js（离线、无原生模块）或 `@napi-rs/canvas`。模型无视觉能力时给明确错误 |
| **DOCX** | 零依赖 ZIP+XML（`word/document.xml` → `<w:p>` / `<w:t>`），或 `mammoth` 换 HTML | 本机已实测可行 |
| **XLSX** | 零依赖：`xl/sharedStrings.xml` + `xl/worksheets/sheetN.xml`，输出 TSV/markdown 表；或 `officeparser` | 表格是文本天然友好；注意合并单元格与公式值 |
| **PPTX** | 零依赖：`ppt/slides/slideN.xml` 的 `a:t`，按 slide 分节 | 顺序按 `presentation.xml.rels` 而非文件名 |
| **ODT / ODS / ODP** | 同构（`content.xml`） | 低优先级 |
| **老二进制 `.doc` / `.xls` / `.ppt`** | **不走 ZIP 路线**（OLE 复合文档），建议直接提示「请另存为 docx/xlsx/pptx」；真要支持只能 LibreOffice headless / 在线转换 | 收益低、风险高 |
| **加密文件** | 检测到加密就给明确错误（`officeparser` 8 支持 `password` 选项） | 不猜密码 |
| **RTF / CSV / EPUB / HTML** | CSV/HTML 已按文本可读；其余低优先级 | |

---

## 5. 本机实测记录（2026-10-30）

用的是真实文件，不是构造样本：

1. **扫描件 PDF 确认**：`E:/Projects/开发测试工作区/1111.pdf`（1.5MB / 3 页，`Print To PDF` 导出）
   - `unpdf@1.9.1` `extractText` → `per-page chars: [0, 0, 0]`
   - `pdfjs-dist@6.4.299` legacy build（Node 24）→ `getTextContent().items = 0`
   - 结论：**纯图、无文本层**，任何「文本抽取」都不可能出内容；只能渲染成图 + 视觉，或 OCR。
2. **零依赖 DOCX 抽取可行**：`E:/Projects/LUMIÈRE/LUMIERE智能体需求清单.docx`
   - 手写 ZIP 中央目录解析 + `zlib.inflateRawSync` → `word/document.xml` 90,450 字节
   - 极简 XML → 文本 → **4,299 字符，中文完整、段落顺序正确**
   - 代码量 ~35 行（含 ZIP 解析），**零依赖**
3. **`pdfjs-dist` 可在主进程直接跑**：Node 24 + ESM + `pdfjs-dist/legacy/build/pdf.mjs`，无需 canvas 即可抽取文本（渲染页图才需要 canvas）。
4. **`officeparser` 的 OCR 是懒加载**：`dist/utils/ocrUtils.js` 里是 `await import('tesseract.js')`，不打开 OCR 就不会拉起 worker。

> 已验证：A / B / C 三条路线在本机环境都能跑起来；未实测 xlsx / pptx 样本（同构，风险低）。

---

## 6. 推荐落地顺序

**Phase 0（先拍板，0 代码）**
确认第 8 节的 5 个问题，尤其「要不要新依赖」和「扫描件走 OCR 还是视觉」。

**Phase 1（零新依赖 MVP，约 1–1.5 天）**
- 在 `pi-bridge` 挂一个内联 extension，提供文档抽取能力：**优先扩展现有 `read`**（`read` 的 operations 可插拔），让 `read a.pdf` / `read b.docx` 直接产出文本，不新增工具名、不改模式白名单、不改系统提示里的工具清单。
- PDF → `pdfjs-dist` 按页抽文本；无文本层 → 返回明确错误（提示「这是扫描件，共 N 页」）。
- DOCX/XLSX/PPTX/ODT → `node:zlib` ZIP+XML。
- 沿用 `read` 的截断语义（2000 行 / 50KB），但**加「按页 / 按 sheet / 按 slide」分段 + `offset` 续读**，避免长文档只能看开头。
- 输出格式：`--- page 3 ---` / `--- sheet: 销售 ---` / `--- slide 12 ---`，便于模型引用。

**Phase 2（增强，按需）**
- 换 `unpdf` 2.x 拿 `inspectPages`（更准的扫描页判定）与页图导出；体积 +2.4MB。
- 扫描件：渲染前 N 页 PNG → 作为图片内容返回（工具结果支持图片）。渲染用渲染层 pdf.js（零原生模块）或 `@napi-rs/canvas`（原生预编译，三平台各 ~5MB）。
- 只有确实需要「扫描件离线 OCR」时才上 `tesseract.js` + 语言包（+21MB/语言），并解决 asar 内的 worker/wasm/语言包路径问题。

**Phase 3（策略级，可并行）**
- 给 `pi-coding-agent` 提上游需求：Message 内容支持 `document` 块 → 直接拿 Anthropic / Gemini / OpenAI 的原生 PDF 理解（含图表、扫描件），**长期最优、本地零成本**。
- 或者先接 MCP（SDK 已支持，`pi-bridge` 只缺接线），让文档能力以服务器形式可插拔，顺带解锁其它工具。

---

## 7. 风险与边界

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 打包体积 | electron-builder 会把 `dependencies` 原样再打一份进 asar（`BUILD_AND_PACKAGE` §3 已记录 156MB 教训） | 新依赖必须算进预算：unpdf +2.4MB 可接受；officeparser +35MB、OCR +21MB 要慎重 |
| 恶意 / 畸形文件 | ZIP 炸弹、页数炸弹、超大图（pdf.js 默认不限 `maxImageSize`） | 限页数（如 300 页）、限解压后总字节、限单页图尺寸、全程 `AbortSignal` |
| Token 成本 | 100 页文本 PDF ≈ 5–8 万 token；扫描件渲染 3 页 = 3 张图 | 分段 + 摘要模式；提示模型先 `grep` 式定位再读全页 |
| 模型视觉能力 | 扫描件走图片依赖模型 `input` 含 `image` | 无视觉能力时明确报错（SDK 已有 `getNonVisionImageNote` 类似语义可参考） |
| 密码 / 损坏文件 | 加密 PDF、损坏 zip | 明确错误信息，不静默返回空 |
| 老格式 | `.doc/.xls/.ppt` 是 OLE，不是 ZIP | 提示另存；或后续接 LibreOffice |
| 上游依赖 SDK 行为 | `read` 的 operations 是否稳定可插拔、截断语义 | Phase 1 先做 spike 验证，不行就退回独立工具名 `read_document`（需加模式白名单） |
| 供应链 | SheetJS 不在 npm 主线、officeparser 发布很新（8.4.1 一天前） | 优先零依赖路线，避免频繁跟版 |

---

## 8. 需要你拍板的问题

1. **依赖策略**：走「零依赖自写（A）」还是「引一个小依赖（B `unpdf`）就收工」？（C `officeparser` 体积太大，除非要 OCR 与高保真）
2. **扫描件怎么办**：渲染成图片交给模型视觉（无新依赖，但依赖模型能力）／ 离线 OCR（+21MB 语言包/语言）／ 先明确报错不做（最小成本）？
3. **要不要「程序内」也能看**：DOCX / XLSX 在阅读视图里预览（如 mammoth→HTML、表格渲染），还是只解决「Agent 能读」？
4. **老格式** `.doc/.xls/.ppt`：直接提示另存，还是接 LibreOffice headless？
5. **是否提上游**：给 `pi-coding-agent` 加 `document` 内容块（一次解决原生 PDF，长期最省），还是先自己做本地抽取？

---

## 参考来源

- unpdf（PDF 抽取/渲染，含扫描页检测）— <https://github.com/unjs/unpdf>；npm `unpdf@2.0.1`
- pdf.js / pdfjs-dist — 本仓库 `package.json` 已用 `^6.4.299`
- officeparser（全格式 AST + 可选 OCR）— npm `officeparser@8.4.1`，README（v8 PDF 版面还原、密码、生成器）
- mammoth（docx→HTML/MD）— npm `mammoth@1.13.0`
- Anthropic PDF 支持（`document` 块：URL / base64 / `file_id`）— <https://platform.claude.com/docs/en/build-with-claude/pdf-support>
- 页数与体积上限（100 页 <1M 上下文 / 600 页 1M 模型、单请求 32MB）— <https://blog.jztan.com/llm-api-pdf-page-limits>
- OpenAI PDF 输入（Files API / `input_file`）— <https://platform.openai.com/docs/guides/pdf-files>
- Google Gemini 文档理解（PDF inline）— <https://ai.google.dev/gemini-api/docs/document-processing>
- Microsoft MarkItDown（Python，确定性转换，适合 LLM 摄取）— <https://github.com/microsoft/markitdown>
- MCP 文档读取服务器示例 — <https://www.claudemcp.org/mcp/registry/io-github-xt765-mcp-documents-reader-a46a664b3b6d.html>
