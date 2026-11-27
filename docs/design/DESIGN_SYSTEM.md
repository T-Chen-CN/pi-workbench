# Pi Workbench 设计系统规范

> **面向**：所有改前端界面的人（桌面端渲染层、`packages/cloud-ui`、云端 Web 控制台）
> **什么时候读**：动手写任何 UI 之前（强制）
> **什么时候要改**：引入规范之外的 Token、排版角色或基础交互契约前，先更新本文件并经项目所有者确认

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v2.0（精简重构版；历史演进见 `git log`） |
| 状态 | Active（正式规范） |
| 最后更新 | 2026-11-27 |
| 适用范围 | `src/`、`packages/cloud-ui/`、`apps/cloud/web-src/`、Monaco / xterm 主题 |

---

## 1. 设计原则

**Paper & Ink —— 一张随时可以落笔的工作台。**

| 原则 | 含义 | 表现 |
| --- | --- | --- |
| 纸（Paper） | 界面是纸面，不是面板堆叠 | 暖白底、纸卡靠底色与发丝线分离、浮层错位硬阴影 |
| 墨（Ink） | 层级靠排版与留白，不靠灰色深浅 | 近黑正文、衬线标题、等宽元数据 |
| 松绿（Pine） | 唯一的品牌强调色 | 标题重音、链接、选中线、主按钮、印章；占比 <5% |

- **语义色职责不可互换**：松绿 = 品牌与交互，暖橄榄 = 成功与 Diff 新增，暖琥珀 = 警告/待操作，朱砂红 = 错误与删除。
- **气质基准**：印刷品、编辑排版、工程图纸；禁止金属灰暗色 IDE 堆砌、霓虹色、渐变或玻璃拟态。

---

## 2. 设计 Token

颜色以 RGB 三元组定义在 [index.css](../../src/index.css)，通过 `<html class="dark">` 在 Paper / Ink 之间切换。组件只用 Tailwind 语义类，**禁止在业务代码中硬编码十六进制色值、Tailwind 调色板色类（`gray-*` / `blue-*` / `red-*` 等）或 `dark:` 变体**。

### 2.1 表面、线条、文字与语义色

| CSS 变量 | Tailwind 类 | Paper（默认） | Ink（深色） | 用途 |
| --- | --- | --- | --- | --- |
| `--surface` | `bg-surface` | `#F4F1EA` | `#141311` | 主画布、编辑器、激活标签 |
| `--panel` | `bg-panel` | `#FBF9F4` | `#1A1815` | 顶栏、侧栏、状态栏、终端 |
| `--raised` | `bg-raised` | `#FFFDF8` | `#201D19` | 纸卡、弹窗、菜单、Toast |
| `--sunken` | `bg-sunken` | `#EFECE4` | `#221F1B` | 输入框、代码块、终端底 |
| `--hover` / `--active` | `bg-hover` / `bg-active` | `#EEEAE1` / `#E8E3D9` | `#2B2722` / `#342F29` | 悬停 / 选中按下背景 |
| `--line` | `border-line` | `#171512` | `#EDE7DC` | 满墨基色；**仅用于浮层外框** |
| `--rule-control` | `border-rule-control` | 墨 50% | 墨 50% | 控件边界（输入框/按钮/键帽，≥3:1） |
| `--rule-divide` | `border-rule-divide` | 墨 22% | 墨 22% | 结构分隔线（卡头、列表行、栏交界） |
| `--rule-hairline` | `border-rule-hairline` | 墨 18% | 墨 18% | 纸卡装饰收口 |
| `--rule-seam` | `bg-rule-seam` | 墨 11% | 墨 11% | 2px 拖拽接缝（125% DPI 下保持等宽） |
| `--overlay` | `bg-overlay` | `#000000` | `#000000` | 模态遮罩（`bg-overlay/35`~`/70`） |
| `--ink` | `text-ink` | `#171512` | `#EDE7DC` | 主文字（Paper 16.15:1 / Ink 15.09:1，AAA） |
| `--ink-muted` | `text-ink-muted` | `#615C52` | `#A8A093` | 次级与功能元数据（≥5.89:1，AA/AAA） |
| `--ink-subtle` | `text-ink-subtle` | `#918A7D` | `#736C60` | **仅装饰线、装饰点与禁用态（~3.1:1），禁止承载有效信息** |
| `--accent` / `hover` / `fg` | `*-accent*` | `#2F5D4E` / `#24493D` / `#FBFAF4` | `#8FC7B4` / `#A9D8C8` / `#141311` | 品牌强调、焦点、主按钮、印章（≥6.66:1） |
| `--success` / `--warning` / `--danger` | `*-success/warning/danger` | `#5E6B2E` / `#9A5B1F` / `#A83A22` | `#A8BF7A` / `#D6B26E` / `#E06A4A` | 状态语义色（全部 ≥4.79:1，AA） |

- 淡洗背景用语义透明度修饰符（如 `bg-accent/[0.06]`、`bg-danger/10`）；禁止 `border-line/50` 裸透明度与 `bg-line` 分隔线。`tailwind.config.js` 对 `rule-*` / `border` 采用函数式 `color-mix()` 映射，支持透明修饰符且不破坏 `src/index.css` 中的 RGB 线条变量格式。
- 语法高亮内容色（`--code-bg`、`--code-border`、`--hl-keyword/string/number/comment/function/type/attr`）定义于 [index.css](../../src/index.css)，由 [tokens.ts](../../src/theme/tokens.ts) 同步到 Monaco / xterm，不跟随品牌主色。

---

## 3. 字体与排版

- **桌面端**（`src/main.tsx`）：全部 4 套字体通过 `@fontsource` 本地打包（构建时过滤非中/英子集），完全离线可用。
- **云端 Web**（`apps/cloud/web-src/main.tsx`，D11）：只内嵌 `Instrument Serif` + `Geist Mono`（约 120 KB）保持标题与等宽印刷气质，中文字体直接走操作系统原生栈（`PingFang SC` / `Microsoft YaHei` / `Songti SC` / `SimSun`），将公网首屏静态包从 18.5 MB 瘦身并由服务端 `br`/`gzip` 预压缩下发。
- 全局 `body` **不开启** `text-rendering: optimizeLegibility`，确保长日志与编辑器在 Chromium 下走快速排版通道。

| 族 | 变量 / 用途 | 栈 |
| --- | --- | --- |
| Display | `--font-display`（标题、项目名、弹窗标题） | Instrument Serif → Noto Serif SC → Songti SC → serif |
| Reading | `--font-reading`（长正文、Agent 回复、说明） | Noto Serif SC → Songti SC → serif |
| UI Sans | `--font-ui`（默认；按钮、标签、字段值、文件树） | Noto Sans Variable → Noto Sans SC Variable → PingFang SC / Microsoft YaHei → system-ui |
| Mono | `--font-mono`（路径、ID、时间、快捷键、代码） | Geist Mono Variable → Noto Sans SC Variable → Consolas |

### 语义排版角色（`src/index.css` 唯一定义，功能字号底线 ≥12px，D10）

业务组件**禁止**直接写 `font-*`、`text-xs..3xl`、`text-[*px]`、`uppercase`、`tracking-[*]`、`leading-[*]`，统一使用下列 `.type-*` 类或语义文字组件：

| 角色类 | 规格 | 用途 |
| --- | --- | --- |
| `type-display` / `type-brand` | 37px display / 24px display | 欢迎页主标题 / 顶栏字标 |
| `type-title` / `type-subtitle` / `type-project` | 28px / 20px / 17px display | 弹窗标题 / 分区与空状态标题 / 项目名 |
| `type-reading` / `type-body` | 14px reading (1.85) / 13px ui (1.6) | 阅读正文 / 常规控件 |
| `type-label` / `type-value` | 12px 500 ui / 12.5px tabular-nums ui | 字段与分区标签 / 字段与状态值 |
| `type-data` / `type-code` / `type-caption` | 12px mono / 12.5px mono / 12px ui | 路径与时间 / 代码 / 计数与提示 |
| `type-key` / `type-eyebrow` / `type-eyebrow-cjk` | 12px mono / 12px upper mono / 12px ui | 键帽 / 纯 Latin 眉题 / 中文眉题 |
| `type-wordmark` / `type-signature` / `type-stamp` / `type-stamp-sub` | 7–9px 装饰微字 | 品牌副标、署名、欢迎页印章（**仅装饰，不得承载唯一信息**） |

- 中文标签与字段值一律用 UI sans，不用 mono，不加 `uppercase` 或宽字距；数字列使用 `tabular-nums`。
- **云端 Web 移动端防缩放与安全区**：`src/index.css` 在 `@media (max-width: 640px)` 下将 `[data-cloud-web='true']` 内的 `input/textarea/select` 统一提至 `16px` 以阻止 iOS Safari 聚焦自动缩放；顶栏、底栏与输入区使用 `.safe-top` / `.safe-bottom` / `.safe-x` 适配 `env(safe-area-inset-*)`。
- **品牌标志**（[BrandSeal.tsx](../../src/components/ui/BrandSeal.tsx)）：松绿印面（圆角 19.8%，Noto Serif π）底边与 `WORKBENCH` 基线对齐（`items-baseline`）；`WORKBENCH` 与署名 `TChen` 用 `text-ink-muted` 不上色。

---

## 4. 间距、形状、阴影、动效与命中区

- **间距**：严格 4px 基数（4 / 8 / 12 / 16 / 20 / 24 / 32 / 48）；常规面板与纸卡内边距 `12–16px`（`Card` `compact=12px` / `default=16px`），弹窗内容区 `16–20px`。
- **圆角与边框**：业务组件只使用 `rounded-sm`（1px）或 `rounded`（2px），禁止 `rounded-md/lg/xl/2xl/3xl`（圆形按钮/状态点可用 `rounded-full`；`tailwind.config.js` 保留 `md: 2px` / `lg: 4px` 仅用于收束 Streamdown 等第三方类名的圆角）。边框统一 1px，按 `border-rule-*` 角色取值；满墨 `border-line` 只留给浮层。
- **阴影**：浮层（Modal / 菜单 / 命令面板 / Toast）用 `bg-raised border border-line shadow-print`；页面内纸卡不投影，禁止柔光阴影（`shadow-sm..2xl`）。
- **Toast 与面板偏好（D8）**：常规 Toast（`info`/`success`）默认 3 秒自动消失（`role="status"`）；错误 Toast（`error`）使用 `role="alert"` + `aria-live="assertive"`，默认 8 秒自动消失，且鼠标悬停或键盘聚焦期间暂停倒计时、离开后恢复剩余时长。桌面端侧栏/面板宽度按用户偏好持久化，终端开关与窗口句柄保持运行期不落盘。
- **动效与减弱动态**：过渡控制在 120–200ms `ease-out`（禁止 `duration-300+`）；仅允许会话运行中 `pulse`（1.4s）与待操作 `breathe`（2.4s）透明度循环。**必须尊重系统 `@media (prefers-reduced-motion: reduce)`**（[index.css](../../src/index.css) 全局禁用非必要过渡与循环动画）。
- **命中区**：点击处理器挂在最大可视矩形本体，装饰图标设 `pointer-events-none`；次级动作（关闭/删除）命中区 **≥24×24px**（`h-6 w-6`），且必须作为**兄弟元素**位于主可交互元素外部（禁止 `nested-interactive`）。

---

## 5. 基础组件与共享原语 API

桌面端优先复用 [ui.tsx](../../src/components/ui/ui.tsx) 与 [patterns.tsx](../../src/components/ui/patterns.tsx)；云端 Web 与桌面端共享组件优先复用 `packages/cloud-ui`（零桌面 store / `i18n` / Electron 依赖）。

| 模块 | 导出组件 | 关键约定 |
| --- | --- | --- |
| `src/components/ui/ui.tsx` | `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Field`, `EmptyState`, `Modal`, `PopoverMenu`, `Spinner`, `Label`, `Value`, `Caption`, `DataText`, `Eyebrow` | `IconButton` 必填 `label`（作 `aria-label` 与 `title`）；不用 emoji 当图标；焦点态统一 1px `accent` 描边 |
| `src/components/ui/patterns.tsx` | `Card`, `CardHeader`, `SectionHeader`, `Stat`, `StatGrid`, `StatusText`, `QuickAction`, `ListRow`, `KeyCap`, `SearchField`, `Meter`, `Tab` | `Card` = `border border-rule-hairline bg-raised`（无投影）；`CardHeader` 同时渲染 `status` 与 `action`；所有标签页必须使用 `Tab` |
| `packages/cloud-ui` | 零桌面依赖的 Paper & Ink 原语、WS 帧归并器与云端卡片/弹窗 | 供桌面端云端页与 `apps/cloud/web-src` 共用，受 ESLint 跨包边界规则强制隔离 |

---

## 6. 窗口外壳、可访问性与聊天渲染契约

1. **原生标题栏与即时启动**：
   - Windows / Linux 主窗口与辅助窗口使用原生 `titleBarStyle: 'hidden' + titleBarOverlay`（恢复 Win11 Snap Layouts），随 Paper / Ink 主题热更新按钮色；渲染层检测到 `window.electronAPI?.nativeTitleBarOverlay` 时隐藏自绘 `<WindowControls />` 并在顶栏右侧预留 `pr-[140px]` 安全区。macOS 使用 `titleBarStyle: 'hiddenInset'`。
   - 移除启动期 1 秒 `setBounds` 形变动画，窗口直接以目标尺寸打开并在首帧就绪后立即呈现。
2. **焦点、Portal、Escape 与键盘导航**：
   - `Modal` 通过 `createPortal(..., hostDocument.body)` 渲染，打开时对非 Portal 的 `body` 兄弟节点加引用计数 `inert`，关闭时恢复焦点；`getVisibleFocusables` 跳过隐藏与 `inert` 元素。
   - `CommandPalette`、`DiffViewer` 与图片灯箱均须维持焦点陷阱、焦点恢复与分层 `Escape`（灯箱在捕获阶段消费 `Escape`，不穿透关闭父弹窗）。
   - 树形视图（`FileExplorer` `role="treeitem"`）提供 `ArrowUp/Down/Left/Right/Home/End` 与 roving `tabIndex`；标签条提供 `role="tablist"` + 兄弟关闭按钮。
   - 页面级交互与画布细则下沉至各特性文档：[workspace-panel](../agent/workspace-panel.md)（仓库地图画布）、[panels-and-windows](../agent/panels-and-windows.md)（面板拆窗）、[agent-runtime](../agent/agent-runtime.md)（审批与计划）。
3. **聊天消息单一推导源**：
   - 聊天消息与导出统一由 `pi-bridge/src/session-view.ts` 的 `deriveMessages()` 从持久化会话记录投影，轮末经 `reconcileMessages()` 以磁盘记录自愈，保留持久化 `entryId` / `userEntryId` 与多步聚合 `usage`。业务组件禁止自行拼装消息 `parts`。

---

## 7. 门禁与检查清单

所有 UI 改动合并前必须通过以下自动门禁（不再依赖人工肉眼排查）：

- **ESLint 门禁**（[eslint.config.js](../../eslint.config.js)）：`eslint-plugin-jsx-a11y` 推荐规则、跨包依赖边界（`packages/cloud-ui` / `apps/cloud/web-src` 禁引桌面 store / i18n / Electron；`src/` 禁引 Node / Electron）、AST 级十六进制色值禁令（仅 `src/theme/`、`shikiHighlighter.ts` 与原语文件豁免）。
- **设计系统单测**（[design-system.test.ts](../../tests/ui/design-system.test.ts)）：校验语义排版、语义色拼写、线条角色、浮层满墨边框、`Tab` 唯一入口、24px 关闭热区及云端 Web 零 XSS / Paper & Ink 一致性。
- **变更流程**：需新增 Token、排版角色或豁免项时，先修改本规范与对应门禁并获得项目所有者确认，再改业务代码。
