# 方案设计 v4：PDF / Office 的 Agent 可读 + 程序内预览

> **类型**：设计方案（只设计，未实施）
> **日期**：2026-10-30
> **范围**：只做两件事——**① Agent 能读 ② 人能预览**。不做编辑、**不做老格式 `.doc/.xls/.ppt`（要求另存为）**、不装外部程序。

---

## 0. 范围

| 做 | 不做 |
| --- | --- |
| Agent 读 PDF / docx / xlsx / pptx / ODF / csv / html / epub | 任何形式的**编辑** |
| Agent 读扫描件（渲染成图片交给视觉模型） | **老格式 `.doc/.xls/.ppt`**（检测到就提示另存为） |
| 程序内**只读预览** PDF / Office | OCR、WYSIWYG 套件、LibreOffice / OnlyOffice / Univer |
| **零外部程序**、离线开箱即用 | 随包分发第三方办公套件 |

**相比 v3 的关键简化**：老格式一去，**LibreOffice 就彻底不需要了**——没有子进程、没有安装要求、没有转换缓存目录，全部在进程内用 Node 自带能力完成。

---

## 1. 依赖结论

| 阶段 | 新增 npm | 外部程序 | 说明 |
| --- | --- | --- | --- |
| **阶段 A：Agent 可读** | **0** | **0** | `pdfjs-dist`（已在 `dependencies`，主进程已实测可跑）+ 手写 `zip-xml.ts`（`node:zlib`，docx 已实测 4,299 字干净中文） |
| **阶段 B：预览** | **+0.9MB**（`docx-preview`，Apache-2.0，可选） | **0** | docx 用成熟渲染器；xlsx / pptx 用自建视图 |

被排除的候选（2026-10-30 npm registry 实测）：

| 候选 | 体积 | 排除原因 |
| --- | --- | --- |
| `officeparser` | 33.8MB + 重复的 35MB pdfjs（依赖锁死 `6.2.108`） | ≈+69MB，且只读 |
| `mammoth` | 1.6MB | 只出 HTML/文本，预览还要自己做样式；`docx-preview` 直接渲染原排版更省事 |
| `exceljs` / `docx` / `pdf-lib` | 20.8 / 19.5 / 18.6MB | 都是**写**库 |
| `superdoc` / OnlyOffice / Univer Pro | 13MB / 1–2GB / 付费 | AGPL 或商业授权 |
| `@napi-rs/canvas` | 0.2MB + win 二进制 37.9MB | 渲染层已有 pdf.js + canvas |
| LibreOffice | 350MB 安装 | 只为老格式和高保真预览存在，两者都已出范围 |

---

## 2. 总体架构

```
┌──────────────── 渲染进程 ────────────────┐
│ FileView.tsx ── fileKind 分发            │
│   ├─ pdf      → PdfReadingView（现状）    │
│   ├─ docx     → DocxView（docx-preview）  │
│   ├─ xlsx     → SheetPreviewView（自建表格）│
│   ├─ pptx     → SlidePreviewView（大纲+图片）│
│   └─ 老格式   → 提示「请另存为 docx/xlsx/pptx」│
│   扫描页渲染：pdf.js canvas → PNG（供 Agent）│
└────────▲────────────────────┬────────────┘
         │ IPC（渲页请求/回传；预览取文档数据）│
┌────────┴────────────────────▼────────────┐
│ 主进程 electron/documents/                │
│  detect.ts   魔数（PK / D0CF11E0 / %PDF）+ 扩展名│
│  ooxml.ts    ZIP 读 + docx/xlsx/pptx/odf 抽取  │
│  pdf.ts      pdfjs-dist 文本 / 页数 / 扫描判定  │
│  extract.ts  统一入口：path → {text|images|error}│
│  legacy.ts   老格式判定 + 统一错误文案           │
└────────▲─────────────────────────────────┘
         │ 同进程直接函数调用
┌────────┴─────────────────────────────────┐
│ pi-bridge：同名 customTool 覆盖内置 read      │
│  文档 → 文本 + 扫描页图片；其余文件交给内置实现   │
└──────────────────────────────────────────┘
```

**注入点（已核对现有代码/类型）**

| 内容 | 位置 | 现状 |
| --- | --- | --- |
| `customTools` | `pi-coding-agent/dist/core/sdk.d.ts:56` | SDK 支持；`AgentManager` 未传 → 加一个 |
| 同名覆盖 | `agent-session.js:2850` `definitionRegistry.set(name, …)`（内置先入表，自定义后写覆盖） | **已验证**：注册名为 `read` 的 customTool 会替换内置 `read`，工具列表里仍只有一个 `read` |
| 工具白名单 | `pi-bridge/src/tool-policy.ts` `READ_ONLY_TOOLS` | `read` 已在其中 → **无需改动** |
| 构造 AgentManager | `electron/ipc/agent.ts:149` | 注入 `documentReader` 回调（同进程，无新 IPC） |
| 视图分发 | `src/components/FileView.tsx`（`fileKind === 'pdf'` 分支） | 追加新分支 |
| 类型判定 | `src/utils/fileKind.ts` | 加 `docx/xlsx/pptx/office-legacy` |

---

## 3. 阶段 A：Agent 可读（预估 3 天）

### 3.1 格式路由（全部进程内，零外部）

| 格式 | 路由 |
| --- | --- |
| **PDF** | `pdfjs-dist` 逐页 `getTextContent()`；同时算每页 `textLength` / 图像占比 |
| **PDF（扫描件）** | 每页文本 <20 字符 → 渲染前 N 页 PNG → 图片通道 |
| **DOCX** | `zip-xml`：`word/document.xml` → 段落 / 标题 / 列表 / 表格 |
| **XLSX** | `zip-xml`：`sharedStrings.xml` + `xl/worksheets/sheetN.xml` → 按 sheet 输出 TSV（公式取缓存值 `<v>`） |
| **PPTX** | `zip-xml`：`ppt/slides/slideN.xml` 的 `<a:t>`，按 `presentation.xml.rels` 排序 |
| **ODT / ODS / ODP** | `zip-xml`：`content.xml` |
| **EPUB** | `zip-xml`：OPF spine 顺序 → XHTML 脱标签 |
| **CSV / TSV / HTML / MD** | 已有文本通道 |
| **`.doc/.xls/.ppt`（OLE，魔数 `D0CF11E0`）** | 直接返回：「这是旧版二进制格式，请在 Office/WPS 里另存为 .docx/.xlsx/.pptx 后再试」 |

### 3.2 输出契约

```
--- document: 销售报表.xlsx (3 sheets) ---
--- sheet: 汇总 (A1:F42) ---
产品	一月	二月
Aura	1,200	1,340
--- sheet: 明细 (A1:D1200, truncated) ---
（第 1–500 行，共 1200 行；继续读用 offset=500）
```

- 分节标记：`--- page N ---` / `--- sheet: 名称 (范围) ---` / `--- slide N ---`。
- 截断 + 续读：单次 ≤50KB 且 ≤2000 行（与 SDK `read` 同量级），超出时明确写出从哪里续读。
- 扫描件：先文字说明「第 N 页为图像，已作为图片提供」，随后附 `ImageContent`。

### 3.3 工具设计：**不新增工具，覆盖现有 `read`**

为什么能覆盖（已核对 SDK 实现 `agent-session.js:2850`）：工具注册表是按名字的 `Map`，内置工具先入表、`customTools` 后写 → **同名即覆盖**；`tool-policy` 按名字过滤，`read` 本来就在 `READ_ONLY_TOOLS` 里，所以**模式白名单零改动**，模型看到的工具列表也仍然只有 `read`（不会在 `read` / `read_document` 之间犹豫）。

| 项 | 内容 |
| --- | --- |
| 注册方式 | `customTools: [createReadWithDocuments(cwd)]`，`name: 'read'` |
| schema | 内置 `read` 的 schema + 三个可选参数：`pages?`（`"1-5"`）、`sheet?`、`slide?`（`offset` / `limit` 沿用内置语义） |
| 分发 | 扩展名/魔数判定为文档 → 走文档管线；**其余一律委托给内置实现**（`createReadToolDefinition(cwd).execute`），文本/图片行为与现在完全一致（含图片缩放与行长截断） |
| 返回 | `content: [TextContent, …ImageContent]`；`details: { pages, sheets, truncated, nextOffset }` |
| 提示词 | 复制内置定义的 `promptSnippet` / `promptGuidelines`，正文里补一句「pdf/docx/xlsx/pptx 会自动抽文本，扫描件返回图片」；`src/api/chatContext.ts` 的附件说明改为「直接 `read` 即可」 |
| 降级原则 | 若将来 SDK 改了内置 `read` 的实现导致委托失效 → 那时才退回「独立工具名」。不在本轮预先加一个工具 |

#### 3.3.1 业界参考（现有产品都是怎么做的）

| 产品 | 做法 | 对我们的含义 |
| --- | --- | --- |
| **Gemini CLI**（`read_file`） | **就一个**读文件工具：文本走 `offset`/`limit`，图片与 **PDF** 直接返回 `inlineData`（mimeType + base64）。没有单独的“读文档”工具 | 直接印证「能力挂在读取工具上」，不新增工具名 |
| **Claude Code**（`Read`） | 一个 `Read` 工具，PDF 逐页「抽文本 + 转图片」交给模型（单请求上限 32MB / 100 页，超出报错），有 `pages` 参数。**docx/xlsx 不内建**，官方用 **skills**（`pdf` / `xlsx` / `docx` skill）教模型调代码库处理 | “读工具处理可直读格式 + 参数控页码范围”是主流；Office 的业内方案是“转换/技能/MCP”，我们内置掉这层反而更省事 |
| **LlamaIndex 总结的三种模式** | ①MCP（预先解析+索引后检索）②CLI（`semtools parse/search`，Agent 自己跑命令）③写进 `CLAUDE.md` 的规则 | 适用于“成百上千份文档”的场景；单个附件随手读不需要这么大阵仗 |
| **MarkItDown MCP** | 外部服务提供一个 `convert_to_markdown(uri)` 工具 | “新工具”的正确形态是 **MCP server**（可插拔、不污染宿主工具表），而不是在宿主体内固定一个新名字 |

**结论**：行业主流是「**一个读工具 + 按需参数**」，其次是「MCP/技能外部扩展」；**把专用于某类格式的工具硬编进宿主工具表**这种做法很少见——这也是你之前那个「多一个 `read` 很怪」的直觉的由来。所以本轮定为：覆盖 `read`（同 Gemini CLI / Claude Code），不新增名字；将来真要「海量文档检索」，再考虑接 MCP。

### 3.4 扫描件渲染链路（零新依赖）

主进程发现无文本层 → `webContents.send('documents:render-pages', {requestId, path, pages, scale})` → 渲染层用现有 `src/pdf/loadPdf.ts` 渲染 PNG（scale 2、单页 ≤1MB）→ `invoke('documents:render-result', …)` 回传 → 组装成 `ImageContent`。8s 超时；无窗口时降级为「扫描件，请打开窗口后重试」。默认渲 3 页、上限 10 页。

### 3.5 任务清单

| # | 文件 | 内容 |
| --- | --- | --- |
| A1 | `electron/documents/detect.ts` | 魔数 + 扩展名判定（含 OLE 识别） |
| A2 | `electron/documents/ooxml.ts` | ZIP 读（中央目录 + `inflateRawSync`）+ 四种格式抽取 |
| A3 | `electron/documents/pdf.ts` | 文本 / 页数 / 扫描判定 |
| A4 | `electron/documents/extract.ts` | 统一入口 + 分节 + 截断/续读 |
| A5 | `electron/documents/legacy.ts` | 老格式统一文案 |
| A6 | `pi-bridge/src/tools/read-with-documents.ts` | 覆盖用的 `read` ToolDefinition（文档分支 + 其余委托内置） |
| A7 | `pi-bridge/src/agent-manager.ts` | `customTools` 注入 + 渲页回调透传 |
| A8 | `pi-bridge/src/tool-policy.ts` | **不改**（`read` 已允许） |
| A9 | `electron/ipc/agent.ts` | 注入 `documentReader` / 渲页回调 |
| A10 | `electron/ipc/documents.ts` + `preload.cts` + `src/types/electron.d.ts` + `src/api/index.ts` | 渲页通道（含 Web mock） |
| A11 | `src/components/PdfReadingView.tsx`（或新 hook） | 监听渲页请求 → 渲 PNG → 回传 |
| A12 | `src/api/chatContext.ts` + 系统提示 | 引导直接 `read`（pdf/docx/xlsx/pptx 自动抽文本） |
| A13 | `tests/documents-*.test.ts` | 见 §6 |

---

## 4. 阶段 B：程序内预览（预估 2–3 天）

| 格式 | 预览实现 | 新增依赖 |
| --- | --- | --- |
| **PDF** | 现状 `PdfReadingView` | 0 |
| **DOCX** | `docx-preview` 渲染成 HTML（保留段落/样式/表格/图片） | **+0.9MB** |
| **XLSX** | 自建表格：sheet 切换、合并单元格、列宽、数字格式（简）、虚拟滚动（上限 5000 行） | 0 |
| **PPTX** | 卡片式大纲：每页标题 + 文本 + 抽取的内嵌图片（zip `ppt/media/*`，blob URL） | 0 |
| **老格式** | 居中提示卡「不支持旧版二进制格式，请另存为 .docx/.xlsx/.pptx」+ 复制路径按钮 | 0 |

三个注意点：

1. **docx 样式隔离**：`docx-preview` 会注入自己的 CSS（前缀 `docx`）——渲染容器需做样式重置/作用域，避免污染 DESIGN_SYSTEM 的 token；实现时先验证再决定是否需要 shadow DOM。
2. **XSS**：`docx-preview` 内部转义文本，但仍按不可信输入处理，渲染后不执行任何脚本（CSP 已禁止内联 eval）。
3. **大文件**：xlsx / pptx 预览设上限（sheet 行数、图片数量），超限显示「仅预览前 N 行」。

### 4.1 任务清单

| # | 文件 | 内容 |
| --- | --- | --- |
| B1 | `src/utils/fileKind.ts` | 新 `FileKind`（`docx/xlsx/pptx/office-legacy`）+ 能力函数 |
| B2 | `electron/ipc/documents.ts` | `documents:read-model` → 返回预览所需的解析结果（docx: ArrayBuffer；xlsx: sheets；pptx: slides） |
| B3 | `src/components/DocxView.tsx` | docx-preview 渲染 + 加载/错误态 + 样式隔离 |
| B4 | `src/components/SheetPreviewView.tsx` | 表格视图（虚拟滚动、合并单元格、列宽） |
| B5 | `src/components/SlidePreviewView.tsx` | 卡片大纲 + 图片 |
| B6 | `src/components/LegacyOfficeView.tsx` | 另存提示卡 |
| B7 | `src/components/FileView.tsx` | 四个新分支 |
| B8 | `tests/file-kind.test.ts` + `tests/documents-preview.test.tsx` | 见 §6 |

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 自写 ZIP/XML 解析有边界 bug | 抽取出错 | 只读不写（不会损坏文件）；异常回退到「纯文本尝试」并给明确错误 |
| docx-preview 样式与主题冲突 | 视觉不一致 | 容器样式隔离；必要时 shadow DOM；`tests/design-system.test.ts` 兜底 |
| 超大文档 | token 爆炸 / 卡顿 | 分页 + 截断 + 续读；预览侧行数/sheet/图片上限 |
| 加密 / 损坏文件 | 体验差 | 统一错误码 + 中文可执行提示 |
| 扫描件渲染依赖窗口 | 托盘态读不到 | 明确降级文案 |
| 老格式被拒 | 用户挫败 | 文案给「怎么另存」的具体步骤 + 复制路径 |

---

## 6. 测试策略

- **单元**：`detect`（PK / OLE / %PDF / 扩展名）、`ooxml`（docx/xlsx/pptx 抽取；**测试内用小 ZIP 写入器现造 fixture**，不提交二进制）、`extract`（分节 / 截断 / 续读 offset）、`legacy`（文案与分支）。
- **工具**：覆盖后的 `read` —— 文档路径走文档管线、非文档路径逐字回归内置行为（文本行号/截断、图片缩放）；`pages/sheet/slide` 参数校验；错误分支；readonly 模式可用。
- **渲染层**：`fileKind` 新类型；四个视图的加载/成功/错误态（mock API）。
- **门槛**：`npm run type-check`、`npm run lint`、`npm test`（含 `design-system.test.ts`）、`npm run build`。
- **手工**：拖入真实 docx / xlsx / pptx / 文本 PDF / 扫描 PDF / `.doc` 各一份，确认 Agent 能引用页码 / sheet / slide，预览正常。

---

## 7. 需要你确认的 2 件事

1. **docx 预览用 `docx-preview`（+0.9MB）** 可以吗？它能把 Word 排版（样式/表格/图片）直接渲染出来；不用它就得自己写 OOXML→HTML（约 300 行，且保真差）。
2. **PPTX 预览接受「卡片式大纲 + 图片」** 吗？（免费生态没有 pptx 版面渲染器；要做到像素级只能引重依赖）
