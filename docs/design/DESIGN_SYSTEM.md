# Pi Workbench 设计系统规范

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.46 |
| 状态 | Active（正式规范） |
| 最后更新 | 2026-10-28 |
| 适用范围 | 渲染进程全部 UI、Monaco / xterm 主题、应用主题设置 |
| 唯一事实来源 | 本文件。所有前端设计相关实现以此为准 |

> **强制约束**：任何新增或修改前端界面的工作（颜色、字体、间距、圆角、阴影、图标、动效、组件、布局、主题、空状态、提示文案等），必须先阅读本规范并按规范执行。需要引入规范之外的设计元素时，先更新本文件并获得项目所有者确认，再写代码。

---

## 目录

1. [设计原则](#1-设计原则)
2. [设计 Token](#2-设计-token)
3. [字体与排版](#3-字体与排版)
4. [间距、形状、阴影与动效](#4-间距形状阴影与动效)
5. [基础组件 API](#5-基础组件-api)
6. [页面与交互模式](#6-页面与交互模式)
7. [可访问性](#7-可访问性)
8. [内容与文案](#8-内容与文案)
9. [禁止项与检查清单](#9-禁止项与检查清单)
10. [设计变更流程](#10-设计变更流程)
11. [代码索引与实现约定](#11-代码索引与实现约定)
12. [变更记录](#12-变更记录)

---

## 1. 设计原则

**Paper & Ink —— 一张随时可以落笔的工作台。**

| 原则 | 含义 | 表现 |
|---|---|---|
| 纸（Paper） | 界面是纸面，不是面板堆叠 | 暖白底、纸卡靠底色分离、分层细线、浮层错位硬阴影 |
| 墨（Ink） | 层级靠排版与留白，不靠灰色深浅 | 近黑正文、衬线标题、等宽元数据 |
| 松绿（Pine） | 唯一的品牌强调色 | 标题重音、链接、选中线、主按钮、印章；占比 <5% |

- **配色关系**：松绿负责“品牌与交互”，暖橄榄负责“成功与 Diff 新增”，朱砂红只负责“错误与删除”。三者职责不可互换。
- **不要再用“深色 IDE”思路扩展界面**：不追随金属灰、霓虹色、渐变或玻璃拟态。
- **参考气质**：印刷品、编辑排版、工程图纸；不是 macOS 原生工具，也不是 SaaS 仪表盘。

---

## 2. 设计 Token

颜色以 RGB 三元组定义在 `src/index.css`，通过 `<html class="dark">` 在 Paper / Ink 之间切换。Tailwind 类名使用语义别名（见下表），**禁止在组件中写十六进制色值或调色板类**。

### 2.1 颜色 Token

| CSS 变量 | Tailwind 类 | Paper（默认） | Ink（深色） | 用途 |
|---|---|---|---|---|
| `--surface` | `bg-surface` | `#F4F1EA` | `#141311` | 编辑器画布、激活标签 |
| `--panel` | `bg-panel` | `#FBF9F4` | `#1A1815` | 顶栏、侧栏、状态栏、终端 |
| `--raised` | `bg-raised` | `#FFFDF8` | `#201D19` | 纸卡、浮层（弹窗、菜单、Toast） |
| `--sunken` | `bg-sunken` | `#EFECE4` | `#221F1B` | 输入框、代码块、终端底 |
| `--hover` | `bg-hover` | `#EEEAE1` | `#2B2722` | hover 背景 |
| `--active` | `bg-active` | `#E8E3D9` | `#342F29` | 选中/按下背景 |
| `--line` | `border-line` | `#171512` | `#EDE7DC` | 墨线基色；通过线条角色派生，不直接用于卡片外框 |
| `--rule-control` | `border-rule-control` | 墨 50% | 墨 50% | 控件边界：输入框、按钮、键帽、搜索框；≥3:1 |
| `--rule-divide` | `border-rule-divide` | 墨 22% | 墨 22% | 分隔线：卡头下沿、列表行、顶栏/状态栏/面板交界 |
| `--rule-hairline` | `border-rule-hairline` | 墨 18% | 墨 18% | 卡片外框（装饰性收口） |
| `--rule-seam` | `bg-rule-seam` | 墨 11% | 墨 11% | 2px 拖拽接缝（等效 1px×22%，125% DPI 下宽度一致） |
| `--overlay` | `bg-overlay` | `#000000` | `#000000` | 模态遮罩 |
| `--ink` | `text-ink` | `#171512` | `#EDE7DC` | 主文字 |
| `--ink-muted` | `text-ink-muted` | `#615C52` | `#A8A093` | 次级文字、功能性元数据（路径、计数、标签、空状态、placeholder） |
| `--ink-subtle` | `text-ink-subtle` | `#918A7D` | `#736C60` | 仅装饰线、装饰点、禁用态；不承载信息文字 |
| `--accent` | `bg-accent` / `text-accent` / `border-accent` | `#2F5D4E` | `#8FC7B4` | 品牌强调、链接、选中、焦点、主按钮、印章 |
| `--accent-hover` | `bg-accent-hover` | `#24493D` | `#A9D8C8` | 强调色 hover |
| `--accent-fg` | `text-accent-fg` | `#FBFAF4` | `#141311` | 强调色上的文字 |
| `--success` | `text-success` / `bg-success` | `#5E6B2E` | `#A8BF7A` | 成功、Diff 新增、通过、后台会话完成待读 |
| `--warning` | `text-warning` / `bg-warning` | `#9A5B1F` | `#D6B26E` | 警告、等待、需要关注（含待操作） |
| `--danger` | `text-danger` / `bg-danger` | `#A83A22` | `#E06A4A` | 错误、删除、冲突 |

**透明度用法**：选中/淡洗使用颜色 token 的透明度修饰符，例如 `bg-accent/[0.06]`、`bg-success/10`、`bg-danger/10`。

**线条角色**：`--rule-control` / `--rule-divide` / `--rule-hairline` 由 `--line` 以固定透明度派生（`rgb(var(--line) / α)`），在 `:root` 定义一次，随 Paper / Ink 自动切换。组件只使用 `border-rule-*`，不得再写 `border-line/50` 这类裸透明度；满墨 `border-line` 只用于浮层外框。

### 2.2 对比度基线

| 组合 | 对比度 | 结论 |
|---|---|---|
| Paper `ink` / `surface` | 16.15:1 | AAA |
| Paper `ink` / `panel` | 17.32:1 | AAA |
| Paper `ink-muted` / `surface` | 5.89:1 | AA |
| Paper `ink-muted` / `panel` | 6.31:1 | AA |
| Paper `ink-subtle` / `surface` | 3.03:1 | 仅装饰/禁用 |
| Paper `ink-subtle` / `panel` | 3.25:1 | 仅装饰/禁用 |
| Ink `ink` / `surface` | 15.09:1 | AAA |
| Ink `ink` / `panel` | 14.40:1 | AAA |
| Ink `ink-muted` / `surface` | 7.17:1 | AAA |
| Ink `ink-muted` / `panel` | 6.85:1 | AA |
| Ink `ink-subtle` / `surface` | 3.57:1 | 仅装饰/禁用 |
| Ink `ink-subtle` / `panel` | 3.41:1 | 仅装饰/禁用 |
| Paper `accent` / `surface` | 6.66:1 | AA |
| Ink `accent` / `surface` | 9.72:1 | AAA |
| `accent-fg` / `accent` | 7.18:1 | AAA |
| Paper `success` / `surface` | 5.14:1 | AA |
| Paper `warning` / `surface` | 4.79:1 | AA |
| Paper `danger` / `surface` | 5.65:1 | AA |
| Paper `rule-control` / `surface` | 3.35:1 | 控件边界（≥3:1） |
| Ink `rule-control` / `surface` | 4.54:1 | 控件边界（≥3:1） |

`rule-divide`（Paper 1.60:1 / Ink 1.85:1）与 `rule-hairline`（Paper 1.46:1 / Ink 1.61:1）属于装饰线，不进入 3:1 基线，但不得充当控件边界或区域的唯一标识。

**文字层级规则**：

- 承载信息的文字——正文、链接、按钮、字段标签、路径、计数、空状态、时间、placeholder——必须 ≥4.5:1。
- `ink-subtle` 不进入文字层级，只用于装饰线、装饰点、禁用态；不得承载唯一信息。
- 层级优先通过字号、字体、字距和留白表达，不通过继续降低文字对比度表达。
- UI 组件边界、有意义的图标与控件至少 3:1；焦点态使用 `accent`。
- 线条角色：`rule-control` 对 `surface` / `panel` ≥3:1，用于控件边界；`rule-divide` 与 `rule-hairline` 属于装饰线，不要求 3:1，但不得充当控件边界，也不得作为区域的唯一标识——区域必须同时有底色或排版层级。
- 任何新颜色组合在合并前必须同时实测 Paper / Ink、`surface` / `panel` 四种组合。

### 2.3 代码与语法 Token

| 变量 | Paper | Ink | 用途 |
|---|---|---|---|
| `--code-bg` | `#EFECE4` | `#221F1B` | 代码块底 |
| `--code-border` | `#D6D0C4` | `#3D3830` | 代码块边框 |
| `--hl-keyword` | `#8A3B2A` | `#E08A72` | 关键字 |
| `--hl-string` | `#4F6B3A` | `#9DBF8A` | 字符串 |
| `--hl-number` | `#8A6A3B` | `#D6B26E` | 数字 |
| `--hl-comment` | `#9A9284` | `#7C7466` | 注释（斜体） |
| `--hl-function` | `#6B4E2E` | `#DEC49E` | 函数 |
| `--hl-type` | `#3E5D66` | `#8FC4CF` | 类型 |
| `--hl-attr` | `#7A4B36` | `#C8A88A` | 属性 |

代码语法色属于“内容色”，**不跟随品牌主色**；不要为了统一而把关键字改成绿色。

---

## 3. 字体与排版

### 3.1 字体族

全部通过 `@fontsource` 本地打包，不使用 CDN，保持离线与便携。

| CSS 变量 | Tailwind 类 | 字体栈 | 用途 |
|---|---|---|---|
| `--font-display` | `font-display` | Instrument Serif → Noto Serif SC → Songti SC → SimSun → serif | 展示标题、项目名、弹窗标题 |
| `--font-reading` | `font-reading` | Noto Serif SC → Songti SC → SimSun → serif | 阅读型正文（欢迎页导语、Agent 回复、设置说明） |
| `--font-ui` | 默认 `font-sans` | Noto Sans Variable → Noto Sans → Noto Sans SC Variable → Noto Sans SC → PingFang SC → Microsoft YaHei → system-ui | 控件、文件树、按钮、界面文字、标签与字段值 |
| `--font-mono` | `font-mono` | Geist Mono Variable → Geist Mono → Noto Sans SC Variable → Noto Sans SC → Consolas | 路径、ID、时间、快捷键、代码 |

**使用边界**：

- 衬线（display / reading）用于 ≥14px 的标题和阅读段落；
- 操作界面（按钮、输入框、文件树、状态栏、标签、字段值）统一使用 UI sans；**不要用 mono 排中文标签或字段值**；
- 中文标签不使用 uppercase 或字距；uppercase + tracking 只用于纯 Latin 眉题；
- 中文标题必须落到思源宋体，不允许回退成系统黑体作为主要视觉。

### 3.2 字号体系

| 角色 | 字号 / 行高 | 字体 | 用法 |
|---|---|---|---|
| Display | 37px / 1.18 | display | 欢迎页主标题（双行） |
| Brand | 24px / 1 | display | 顶栏字标 `Pi` |
| H1 | 28px / 1.2 | display | 弹窗标题、空状态标题 |
| H2 | 20px / 1.3 | display | 分区标题、空状态标题 |
| Project | 17px / 1.2 | display | 项目名、列表主标题 |
| Reading | 14px / 1.85 | reading | 欢迎页导语、Agent 回复、设置说明 |
| Body | 13px / 1.6 | ui | 控件、文件树、按钮 |
| Label | 12px / 1.45，500 | ui | 分区标题、卡片标签、字段标签 |
| Value | 12.5px / 1.4，400，tabular-nums | ui | 字段值、状态值、模型名 |
| Data | 11.5px / 1.4 | mono | 路径、ID、时间 |
| Caption | 11px / 1.4，tabular-nums | ui | 计数、时间、提示 |
| Key | 10.5px / 1.2 | mono | 快捷键键帽 |
| Eyebrow | 10.5px / 1.2，uppercase + 0.14em | mono | 纯 Latin 眉题 |
| Wordmark | 8.5px / 1.2，uppercase + 0.2em | mono | 品牌副标 |
| Signature | 8.5px / 1.2，0.08em | mono | 作者署名 |
| Code | 12.5px / 1.65 | mono | 编辑器、代码块 |
| Stamp | 9px / 1.2 + 7px 副标 | mono | 印章装饰 |

**字号下限**：Label 12px、Value 12.5px、Data 11.5px；不得用 8–9px 承载路径、计数、字段标签、字段值或空状态。印章等纯装饰微字可低至 7–8px，但不得承载唯一信息，且必须保证在双主题下仍可辨认。

**中英混排**：中文标签与字段值一律使用 UI sans；uppercase 和字距只用于纯 Latin 眉题。mono 只承担路径、ID、时间、快捷键和代码，不承担中文标签。

### 3.3 排版规则

- 中文标签、字段值不要加 uppercase 或字距；uppercase + tracking 只用于纯 Latin 眉题。
- 标题使用 display 字体，正文中的 `em` 强调使用 `text-accent` 斜体。
- 长文本优先使用 `font-reading`，不要用 UI sans 排大段中文。
- 路径、ID、时间、快捷键和代码使用 mono；字段值和状态值使用 UI sans，不要用 mono 排。
- 数字型内容使用 `tabular-nums`，保证计数、时间和价格对齐。

### 3.4 品牌标志

**构成**：松绿印面（即应用图标本身）＋ `WORKBENCH` ＋ 署名 `TChen`。π 取自 Noto Serif 的真实轮廓（OFL），不做手绘近似、不拉伸。

| 部位 | 规格 |
|---|---|
| 印面 | 顶栏 20px、主锁定 60px、竖排 80px；圆角 19.8%（`rx 152 / 768`），与 `app-icon` 同一份路径 |
| 对齐 | 印面底边与 `WORKBENCH` 的基线对齐（`items-baseline`）；不按中心对齐，也不按行盒底对齐 |
| WORKBENCH | `type-wordmark` |
| 署名 | `type-signature`，前面 1px `bg-rule-divide` 竖线；不放大、不改衬线、不单独作为标志 |
| 间距 | 印面与文字 7px（顶栏）/ 12px（主锁定），约为印面高度的 0.2–0.35 倍 |
| 颜色 | 印面 `bg-accent`、字 `text-accent-fg`（`BrandSeal` 用 token，Ink 下自动转浅松绿）；`WORKBENCH` 与署名 `text-ink-muted`，不上色 |
| 全名 | “Pi Workbench”只出现在窗口标题、关于页、README 标题，不进入标志 |

**图标分稿**：256 带 `TChen` 署名，128 及以下用简化稿（π 放大到 56%）；ICO 每个尺寸单独出图，不做全尺寸统一。

**禁止**：给 `WORKBENCH` 或署名上色；把印面拉成非等比；改用中心 / 行盒底对齐；在 16px 稿里保留署名。

---

## 4. 间距、形状、阴影与动效

### 4.1 间距

- 基数 **4px**：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48。
- 常规面板内边距 12–16px；纸卡 20–24px；页面左右留白 48–52px。
- 不要用奇数间距制造“视觉微调”；对齐到 4px 网格。

### 4.2 圆角与边框

| 场景 | 值 | Tailwind |
|---|---|---|
| 纸卡、输入框、标签 | 2px | `rounded` / `rounded-md` |
| 极小元素、内嵌块 | 1px | `rounded-sm` |
| 弹窗、较大容器 | 4px | `rounded-lg` |
| 圆形按钮、头像、LED | 9999px | `rounded-full` |

- 边框统一 1px，按角色取值：强调用 `border-accent`；控件边界用 `border-rule-control`；结构分隔用 `border-rule-divide`；卡片外框用 `border-rule-hairline`。
- 可拖拽接缝使用 **2px `bg-rule-seam`**（等效 1px×22% 的墨量）：1px 在 125% 缩放/DPI 下可能栅格化为 1 或 2 个设备像素，导致两侧接缝一宽一窄；2px 带宽可保证两端一致。
- 满墨 `border-line` 只用于浮层（弹窗、菜单、命令面板、Toast）外框；不要用它画普通区域或纸卡外框。
- 不使用大圆角卡片（>6px）；不允许胶囊形按钮（圆形图标按钮除外）。

### 4.3 阴影

- 浮层（Modal、菜单、命令面板、Toast）使用 `bg-raised` + 1px `border-line` + `shadow-print`（Paper：`5px 6px 0 rgba(23,21,18,.08)`；Ink：更深的黑色）。
- 页面内的纸卡（Card）不投影：区域由 `bg-raised` 底色与 `border-rule-hairline` 界定，线只收口。
- 普通面板、按钮、输入框**不使用阴影**；层级通过纸面/墨线/背景差异表达。
- 禁止柔光、发光、玻璃拟态。

### 4.4 动效

- 时长 120–200ms，`ease-out`；仅用于颜色、透明度、位移、下划线展开。
- 会话标签状态动效是唯一的长循环例外：运行中 `pulse` 1.4s（透明度 0.35 → 1），待操作 `breathe` 2.4s（透明度 0.55 → 1）；两者只改变透明度，不做缩放。
- 按钮按下位移 1px；不做缩放动画。
- 焦点态：1px `accent` 描边 + 2px offset；不要使用蓝色 ring。

### 4.5 命中区

可点区域必须等于可视矩形：悬停亮起的范围、鼠标指针变化的范围、真正响应点击的范围三者重合。

- **控件本体拥有点击**。内边距长在带 `onClick` 的元素上，不把 padding 留在一层无 handler 的 wrapper 上、再在内部放一个小按钮。文字、图标等装饰层统一 `pointer-events-none`，让整块矩形都是同一个点击目标。
- **不嵌套可交互元素**。行 / 标签需要次级动作（关闭、删除）时，次级动作放在同一矩形内并用 `stopPropagation` + `data-*-aux` 标记阻断冒泡，本体点击处理器再加一层 `closest('[data-*-aux]')` 兜底。
- **次级动作不小于 24×24px**（WCAG 2.2 §2.5.8），图标本身可以更小（8–12px）；激活项常显，非激活项 hover / `focus-visible` 时显示。
- **横向滚动的标签条不显示滚动条**（`.tab-strip-scroll`）：10px 滚动条会占掉 34px 标签近三成高度；溢出改用滚轮横移 + 键盘聚焦自动滚入视野。
- **键盘模型**：一组互斥标签用 `role="tablist"` + `role="tab"` + `aria-selected`，roving tabindex（恰好一个 0）+ ←/→/Home/End 移动并自动激活，Enter / Space 激活当前项。标签撑满标签条高度，焦点环用 `outline-offset-[-2px]` 内收，避免被横向滚动容器裁掉。
- **约定命中区不能靠“看起来像”**：只做视觉高亮、不放点击处理的最大矩形，等同于 bug。

---

## 5. 基础组件 API

基础控件位于 `src/components/ui.tsx`，内容模式位于 `src/components/patterns.tsx`。新界面必须优先复用；不要在业务组件里重新实现按钮、输入框、文字角色或卡片/分区模式。

### 5.1 Button

| Prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `variant` | `primary \| secondary \| ghost \| danger` | `secondary` | primary = 松绿底 + 纸色字 |
| `size` | `sm \| md` | `md` | sm：28px 高；md：32px 高 |
| `icon` | `LucideIcon` | — | 左侧图标，14/13px |
| `loading` | `boolean` | `false` | 显示 spinner 并禁用 |
| `disabled` | `boolean` | — | 原生禁用 |
| 其余 | `ButtonHTMLAttributes` | — | 原生属性透传 |

**状态**：hover 改变背景；focus-visible 使用全局 1px accent 描边；disabled 50% 透明度。

### 5.2 IconButton

| Prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `icon` | `LucideIcon` | 必填 | 图标 |
| `label` | `string` | 必填 | 同时用于 `aria-label` 和 `title` |
| `size` | `sm \| md` | `md` | 图标 14/16px |
| `variant` | `ghost \| secondary` | `ghost` | 工具栏默认 ghost |
| `active` | `boolean` | `false` | 激活态背景 `bg-active` |

**规则**：图标按钮必须提供 `label`；不要用 emoji 作为图标。

### 5.3 Input / Textarea

- 基于原生 input/textarea，`forwardRef`。
- 背景 `bg-sunken`，1px `border-rule-control`，2px 圆角。
- focus：边框转 `accent`，不额外加 ring。
- placeholder：`text-ink-muted`；禁用态 50% 透明度。

### 5.4 Select

- 原生 select + 右侧 `ChevronDown` 图标；背景/边框与 Input 一致。
- 保持原生键盘行为；不要用自定义下拉替代——唯一例外是聊天输入区的状态行分段菜单（见 6.5）。

### 5.5 Field

| Prop | 类型 | 说明 |
|---|---|---|
| `label` | `string` | 12px UI sans（`type-label`） |
| `hint` | `string?` | 右侧 12px 次要说明（`type-caption`） |
| `htmlFor` | `string?` | 关联输入框 |
| `children` | ReactNode | 输入控件 |

### 5.6 EmptyState

| Prop | 类型 | 说明 |
|---|---|---|
| `icon` | `LucideIcon` | 小图标 16/20px，不放在圆形底中 |
| `title` | `string` | `font-display` 衬线标题 |
| `description` | `string?` | `font-reading` 12.5px |
| `action` | `ReactNode?` | 可选主操作 |
| `compact` | `boolean` | 侧栏/小面板使用 |

### 5.7 Modal

| Prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `open` | `boolean` | — | 是否显示 |
| `onClose` | `() => void` | — | 遮罩点击 / 关闭按钮 / Esc |
| `title` | `ReactNode?` | — | 衬线标题 |
| `children` | `ReactNode` | — | 内容 |
| `footer` | `ReactNode?` | — | 底部操作区 |
| `size` | `sm \| md \| lg` | `md` | `max-w-md/2xl/4xl` |
| `closeLabel` | `string` | `Close` | 关闭按钮的 aria-label |

**规则**：遮罩使用 `bg-overlay/35`；浮层纸卡使用 `border-line bg-raised shadow-print`，标题栏与底栏分隔使用 `border-rule-divide`；标题 `font-display`；关闭按钮使用 IconButton。

**alert 变体（单按钮提示）**：只用于“操作被拦下、需要告知原因”的场景（如保存时存在运行中会话）。`size="sm"`，底部只有一个 `primary` 按钮（`autoFocus`，文案「知道了」），无取消/危险按钮——操作本身没有执行，不需要二次决策。`confirm` 保留给两选一决策，不要用 alert 承载选择。

### 5.8 Spinner

- `Loader2` + `animate-spin`；用于加载/思考态，不额外加文字时也必须保留可读上下文。

### 5.9 语义文字与内容模式（强制）

**问题背景**：设计 token 只能管理颜色和字体族；如果页面直接写字号、字重和 `font-*`，一次设计调整仍然要扫所有页面。因此本项目把“内容类型 → 设计组件”做成代码层契约。

**语义文字角色**（定义在 `src/index.css`，只允许在 `ui.tsx` / `patterns.tsx` 中使用原始字体声明）：

| 角色 | 用途 | 不允许 |
|---|---|---|
| `type-eyebrow` | 纯 Latin 眉题 | 中文、混合标签 |
| `type-wordmark` | 品牌副标 `WORKBENCH` | 正文、标签 |
| `type-signature` | 作者署名 `TChen` | 正文、标签、放大 |
| `type-eyebrow-cjk` | 英文界面里的中文眉题 | Latin 长句 |
| `type-display` / `type-brand` / `type-title` / `type-subtitle` / `type-project` | 展示标题层级 | 正文、控件 |
| `type-reading` | 14px 阅读型正文 | 高密度控件 |
| `type-body` | 13px 控件 / 文件树文字 | 长阅读段 |
| `type-label` | 12px / 500 分区标题、卡片标题、字段标签 | 字段值、路径 |
| `type-value` | 12.5px / 400 字段值、状态值、模型名 | 路径、代码 |
| `type-caption` | 11px 计数、时间、提示 | 主要标签 |
| `type-brand` | 顶栏 `Pi` 字标 | 正文、控件 |
| `type-data` | 11.5px 路径、ID、时间、快捷键 | 中文标签 |
| `type-code` / `type-key` | 代码、键帽 | 普通正文 |
| `type-stamp` / `type-stamp-sub` | 印章装饰 | 唯一信息 |

**文字原语**（`src/components/ui.tsx`）：`Label`、`Value`、`Caption`、`DataText`、`Eyebrow`。

**内容模式组件**（`src/components/patterns.tsx`）：

| 组件 | 用途 | 变体 |
|---|---|---|
| `Card` | 纸卡容器（`bg-raised` + 发丝边，无投影） | `density="default \| compact"` |
| `CardHeader` | 卡片标题 + 状态/操作 | `status` / `action` |
| `SectionHeader` | 分区标题 + 计数 + 搜索/操作 | `count` / `action` |
| `Stat` / `StatGrid` | 字段标签 + 字段值 | 2 列网格 |
| `StatusText` | 状态文字 | `tone` + `dot` |
| `QuickAction` | 快捷操作 | 图标 + 文案 |
| `ListRow` | 列表行（项目、文件、任务） | `titleVariant="project \| value"` |
| `KeyCap` | 键盘快捷键键帽 | — |
| `SearchField` | 搜索输入 | 统一高度与图标 |
| `Meter` | 线性进度（下载进度等） | 1px 轨道，`accent` 填充，无动画发光 |
| `RingMeter` | 圆环进度（状态行上下文占用） | 默认 14px、2px 描边，`accent` / `warning` / `danger` |
| `LegendRow` | 非交互图例行（模式说明） | 图标 + 名称 + 说明 + 右侧元信息 |
| `SettingsTable` / `SettingsTableRow` | 设置页能力表（列头 + 行内控件列） | 行 `selected` 选中态 |
| `Tab` | 标签（工作区 / 文件 / 会话共用） | `size="md \| sm"`、`leading` / `trailing`、可选关闭按钮（24px）、中键关闭 |

**页面组合规则**：

- 业务组件只组合上述模式与 `ui.tsx` 原语；不直接写 `font-*`、`text-[Npx]`、`uppercase`、`tracking-[...]`、`leading-[...]`。
- 例外只能落在 `ui.tsx` / `patterns.tsx`，或者新增一个命名变体；不允许页面级一次性样式。
- `tests/design-system.test.ts` 会扫描 `src/**/*.tsx`，发现业务组件中的原始字体声明直接失败。
- 新增内容类型时，先在 `patterns.tsx` 定义组件/变体，再写页面；不要直接写页面样式。
- 标签只能由 `patterns.tsx` 的 `Tab` 实现（命中区规则见 4.5）；业务组件自行拼 `role="tab"` 会被 `tests/design-system.test.ts` 拦下。

### 5.10 PopoverMenu / MenuOption

锚定浮层与选项行，位于 `src/components/ui.tsx`。用于“点哪一段、就在哪一段上方展开”的紧凑菜单。

| 组件 | Prop | 说明 |
|---|---|---|
| `PopoverMenu` | `open` / `onClose` / `label` | 是否展开、关闭回调、`aria-label` |
| | `role="menu \| dialog"` | `menu` 支持 ↑↓ / Home / End 导航；`dialog` 为自由面板（如上下文明细） |
| | `placement="up \| down"` | 默认向上展开；只有位于面板顶部的触发器（文件树头部）改为向下 |
| `MenuOption` | `selected` / `disabled` / `onSelect` | 当前项 `accent` 勾选；禁用项置灰且不可聚焦 |
| | `role="menuitemradio \| menuitemcheckbox"` | 互斥选项用 radio（默认）；独立开关用 checkbox，同样参与 ↑↓ 导航 |
| | `variant="value \| data"` | 中文标签用 `value`；模型名、ID 用 `data`（mono） |
| | `meta` / `title` | 右侧次要说明 / 悬停说明 |

**规则**：

- 触发器与 `PopoverMenu` 必须放在同一个 `relative` 容器内，默认 `bottom-full` 向上展开、间距 4px（`mb-1`）；位于面板顶部的触发器改用 `placement="down"`，否则会被窗口上沿裁掉；不做需要鼠标移动的居中弹窗。
- 菜单优先与触发器左缘对齐；超出最近裁剪容器的右缘时，自动向左收进容器内（左右各留 4px），不依赖固定的左/右对齐参数。
- 浮层使用 `bg-raised` + 1px `border-line` + `shadow-print`；圆角不超过 2px。
- `role="menu"` 打开时聚焦当前项，Esc 关闭并把焦点还给触发器；点击外部关闭但不抢回焦点。
- 菜单宽度使用 Tailwind 标准宽度（`w-36` / `w-56` / `w-64`），不以内容撑开导致面板变形。

### 5.11 OverlayButton

浮在内容之上的图标按钮（内容区右下角等），位于 `src/components/ui.tsx`。

| Prop | 类型 | 说明 |
|---|---|---|
| `icon` | `LucideIcon` | 必填，14px |
| `label` | `string` | 必填，同时用于 `aria-label` 和 `title` |
| `className` | `string?` | 只用来放定位（如 `absolute bottom-4 right-4 z-10`） |
| 其余 | `ButtonHTMLAttributes` | 原生属性透传（`data-testid` 等） |

**形态**：28×28px、2px 圆角、`bg-raised/90` + `border-rule-control` + `shadow-print`；hover / focus-visible 转为 `bg-raised` + 满墨 `border-line` + `text-ink`。定位与避让规则见 6.15。

---

## 6. 页面与交互模式

### 6.1 应用外壳

- 顶栏 45px：衬线字标 `Pi` + mono `WORKBENCH` + 工作区路径；右侧文字操作（命令面板、终端、设置）与主操作按钮。主操作按钮在工作区视图为「返回首页」（`Home`），在首页为「返回工作区」（`ArrowLeft`），没有工作区时为「打开项目」；关闭工作区只由工作区标签上的 × 提供，顶栏不再放关闭按钮。`终端` 入口只在工作区视图显示。
- 工作区标签栏 34px：矩形 mono 标签，激活项纸面底 + 2px `accent` 顶线。每个标签最多显示一个状态标记，优先级为**待操作 > 错误 > 运行中**（复用会话标签的 warning 靶心环 / `AlertCircle` / `accent` 脉冲点），活动标签同样显示；标记必须有 `aria-label` / `title` 文案，不能只靠颜色或动效。整块标签矩形都是点击目标（见 4.5），标签条右侧的「打开项目」`+` 不属于 tablist。
- 首页：工作区打开后点击「返回首页」切到欢迎页，顶部路径、Agent 状态与工作区标签栏保留；首页不卸载工作区视图。点工作区标签或「返回工作区」回到原视图，编辑器、聊天、终端和滚动位置原样恢复。
- 多工作区：每个打开的工作区各自保留一套常驻视图（文件树 / 编辑器 / 聊天 / 终端 / Diff），非活动视图用 `visibility: hidden` + `pointer-events: none` + `inert` 隐藏，不卸载、不重置；只有关闭标签才释放运行时状态。
- 主区域三栏：文件树 232px / 编辑器自适应 / 聊天 336px；可拖拽、可折叠，默认宽度见上。
- 面板折叠：文件树与聊天面板的头部各有一个收起按钮——文件树在头部最右端（新建文件之后），聊天在头部最左端（标题之前），都紧贴分隔条；顶栏不提供面板开关。收起后该侧显示 26px 宽的全高窄条（`bg-panel` + 内侧 1px `rule-divide`），整条窄条即按钮，图标在正中，hover 整条 `bg-hover`，点击展开；收起与展开后焦点分别落到窄条按钮与面板头部按钮。
- **区域分层**：顶栏、工作区标签栏、状态栏、文件树、终端与聊天标签栏使用 `bg-panel`；编辑器画布、聊天正文列与激活标签页使用 `bg-surface`（更深的"墨池"）；纸卡使用 `bg-raised`。区域先靠底色区分，接缝只做收口。聊天正文列与编辑器画布同底，中缝两侧不得出现两种底色。
- 可拖拽分隔条：2px `bg-rule-seam`，hover / 拖拽时转 `accent`；不要用满墨 `bg-line` 或 1px 线画分栏接缝。
- 状态栏 28px：mono 文本，左侧品牌/本地优先/Agent 状态，右侧版本号、更新状态、语言、编码、主题。版本号可点击进入设置“关于”；有新版本时在版本号旁显示文字提示，下载中显示 `Meter` 进度，不使用弹跳或彩色胶囊。

### 6.2 欢迎页

- 编辑式双栏：左侧眉题 + 37px 衬线双行标题 + 14px / 1.85 导语 + 全量最近工作区（内部滚动）；右侧 Agent 状态、最近项目、开始使用 + 印章。
- 右侧状态卡片使用 `Card`（`bg-raised` + 发丝边，无投影）；卡头标题 `text-ink`，卡头下沿与列表行为 `rule-divide`。
- 眉题与标题互为镜像：中文界面眉题为英文 mono 大写，标题中文；英文界面眉题为中文 reading 小字，标题英文。标题重音使用 `accent` 松绿。
- 最近工作区默认展示全部，标题旁显示“共 N 个项目”；搜索框过滤全部项目；列表在固定区域内滚动，滚动条常驻，快捷操作固定在列表底部，页面本身不滚动。
- 所有功能性次级文字——分区标题、项目计数、字段标签、空状态、快捷操作——使用 `ink-muted` 与 UI sans；标签 12px / 500、字段值 12.5px / 400；路径使用 mono 11.5px。`ink-subtle` 只用于装饰和禁用态。
- 快捷操作只保留可执行项：打开文件夹、刷新最近项目、设置。
- 标题重音、打开箭头、印章全部使用 `accent`；印章使用 1.5px 绿边 + 斜置。
- 欢迎页不再提供页内提问框；提问在打开工作区后由聊天面板完成，避免与“打开项目”流程重复。
- 最近工作区为空时显示文本入口；无匹配结果时显示“没有匹配的项目”。

### 6.3 编辑器

- Monaco 主题固定为 `pi-paper` / `pi-ink`，随 `resolvedTheme` 切换；编辑器背景取 `surface`（工作中的墨池），文件标签条取 `panel`，激活标签取 `surface` 与画布连通。
- 大文件（>2MB 或 >50k 行）关闭换行与折叠；>10MB 或 >200k 行以只读打开。标签下方显示一条 `rule-divide` 细线提示，可关闭，沿用 `type-caption`。
- 字体 Geist Mono 13.5px / 22px 行高；中文回退 Noto Sans SC；关闭 minimap；行号弱化。
- Monaco / xterm 等第三方渲染器通过 `src/theme/tokens.ts` 的 `readThemeTokens(dark)` / `tokenHex` 从 CSS token 读取颜色，不硬编码；行号激活色使用 `ink-muted`。修改主题 token 时只需保证 `TOKEN_NAMES` 覆盖对应变量。
- 光标、选区、当前行使用松绿（Paper `#2F5D4E` / Ink `#8FC7B4`）；语法色使用第 2.3 节内容色。
- 标签页：矩形、sans 12px、激活项纸面底 + 2px 绿顶线；未保存用 6px 绿点。

#### 6.3.1 文件阅读视图

编辑器按文件类型分派两种形态：**阅读视图**（渲染结果）与**源码视图**（Monaco）。默认形态由类型决定，打开即就位，不弹选择。

| 类型 | 默认 | 可切源码 | 呈现 |
|---|---|---|---|
| Markdown | 阅读 | 是 | 块级排版 + 就地编辑 |
| HTML | 阅读 | 是 | 沙箱 iframe 直出文件 |
| 图片（png/jpg/webp/svg…） | 预览 | 否 | `<img>` + 适应窗口 / 原始尺寸 |
| 视频 / 音频 | 预览 | 否 | 原生播放器（支持拖动进度） |
| PDF | 预览 | 否 | pdf.js 自绘阅读器 |
| 纯文本 / 代码 / JSON | 源码 | — | Monaco |
| 未知二进制 | 占位 | 否 | 空状态 + 系统打开 |

**标签条**：高度 34px、`bg-panel`；图标按类型区分（`FileText` / `Globe` / `Image` / `Film` / `Music` / `FileJson` / `FileCode`），激活标签图标转 `accent`。脏标记仍为 6px `accent` 圆点，保存中显示 10px `Loader2`。整块标签矩形都是点击目标（含左右内边距与文字上下空白，见 4.5）；关闭按钮命中区 24px、图标 10px，激活标签常显；中键同样关闭。标签条不显示横向滚动条，溢出时滚轮横移。

**视图切换**：只在可切源码的类型（Markdown / HTML）上出现，浮在编辑器内容区**右下角**（`absolute bottom-4 right-4 z-10`，`OverlayButton`，28px），阅读视图与源码视图共用同一个落点、切换时不跳动；规则见 6.15。**不再放在标签条里**——标签条是横向滚动容器，标签一多就会把最右端的按钮挤出可视区。图标与名称都指向**将要切换到的**形态：阅读视图下为 `Code` +「源码视图」，源码视图下为 `Eye` +「阅读视图」。不使用 `active` 填充，当前形态由内容本身表达。切换只改呈现：**阅读视图与 Monaco 都常驻、只切换显隐**（撤销栈、光标、滚动、iframe 状态全部保留）。Markdown / HTML 打开后在空闲时段预热 Monaco 模块，避免第一次切到源码时现等加载；阅读视图隐藏期间冻结解析结果，源码视图里的每个按键不会触发重排。

**Markdown 阅读视图**

- 版心 `w-full max-w-[64rem] mx-auto px-8 pt-6 pb-12`：**随编辑区宽度自适应**，超宽屏才封顶 64rem 居中；正文 14px / 1.85（`type-reading`），标题沿用 display 字体；首尾段落 margin 折叠，图片 `max-width: 100%`。不要用 `ch` 定宽——版心自身的 `font-size` 不是正文的 14px，`ch` 会算出远小于预期的列宽。底部 `pb-12` 是为右下角视图切换浮层留位（见 6.15），不缩小正文列宽。
- 代码块沿用聊天稿纸的样式（`bg-sunken` + 2px `accent` 左边线 + 允许换行），不出现横向滚动条：阅读视图不覆盖 `white-space`。
- frontmatter 单独成块，等宽 11.5px、`ink-muted`、`bg-sunken` 底，不渲染成正文。
- **块级就地编辑**：每个顶层块悬停 / 聚焦时右上角出现 `Pencil` 图标按钮（「编辑此块」）；点击后该块的**原文**（非渲染结果）替换为等宽 `Textarea`，下方一行「保存 / 取消 + 「Ctrl+Enter 保存」提示」。提交只替换该块偏移，文件其余字节不变；空文档显示一个虚线占位块（「开始编辑」）。
- 键盘：`Ctrl/⌘+Enter` 保存，`Esc` 取消；切换文件自动退出编辑态。

**媒体与 HTML 工具条**：内容区上方一条 1px `rule-divide` 工具条，左侧文件名（`type-caption` / `ink-muted`），右侧图标按钮组，不做整块标题栏。

- 图片：`适应窗口`（`Maximize2`，`active`）与 `原始尺寸`（`Minimize2`）二态切换，默认适应窗口；图片居中，容器滚动。
- 视频：内容区 `bg-sunken`，播放器居中，`max-h-full max-w-full`；音频：`w-full max-w-[480px]` 居中 + 文件名 caption。
- HTML：`重新加载`（`RotateCw`）+ `系统打开`；源码保存后 500ms 防抖刷新，避免连续输入反复重载。
- 所有媒体与 PDF 均提供 `系统打开`（`ExternalLink`）；加载失败时在内容区中部给出说明文字 + `系统打开` 按钮，不使用红色告警块。

**PDF 阅读视图**

PDF 不再交给 Chromium 内置查看器（iframe 里套一个浏览器，工具条与滚动都是黑盒），改用 pdf.js 自绘。工具条与媒体一致（1px `rule-divide`，左侧文件名 `type-caption` / `ink-muted`，右侧图标按钮组），从左到右：上一页（`ChevronUp`）、页码指示、下一页（`ChevronDown`）、缩小（`ZoomOut`）、放大（`ZoomIn`）、适应宽度（`Maximize2`，`active` 表示处于适应宽度）、`系统打开`（`ExternalLink`）。

- 页码指示是 `type-data`（mono 11.5）的 `3 / 12`，两侧按钮不可用时禁用而非隐藏。
- 内容区 `bg-sunken`（文档台面），页面纸张 `bg-surface` + 1px `rule-hairline`，页间 16px；纸张**不随主题反色**：Ink 主题下仍是纸白，因为 PDF 呈现的是文档本身，黑底反白会失真。
- 加载失败的页（损坏 / 加密 / 权限）只保留文件名，页码与缩放整组隐去，不要留一排点不动的按钮。
- 默认**适应宽度**：宽度随编辑区变化实时重算，不写字面缩放百分比；手动缩放后切到自由模式，范围 50%–400%，`Ctrl/⌘+0` 回到适应宽度。
- 滚动是**单一滚动容器**（不嵌套 iframe / 不嵌套滚动区），只渲染视口 ±2 页的 canvas，其余页保留等高占位，滚动条长度稳定不跳动；canvas 按 `devicePixelRatio` 绘制，超过 16M 像素时自动降采样。
- 键盘：`PageUp` / `PageDown` 翻页，`Home` / `End` 首末页，`+` / `-` 缩放，`Ctrl/⌘+0` 适应宽度；焦点不在阅读区时不劫持按键。
- v1 不提供文本层：不可选中、不可查找；补齐时以 pdf.js `textLayer` 叠加在 canvas 之上，视觉不变。
- 文档加载失败（损坏、加密、权限）在内容区中部给说明文字 + `系统打开`，**不退回内置查看器**——一条渲染路径，不做双实现。
- 资源全部随包分发、按需加载：pdf.js 主库与 worker 独立 chunk（仅打开 PDF 时载入），CMap / 标准字体 / wasm 解码器由构建期插件生成 base64 虚拟模块（`vite.config.ts` 的 `pi-workbench-pdfjs-assets`）并按类懒加载，不发起任何协议请求；PDF 本体仍走 `pw-file://`（协议支持 Range，pdf.js 对本地协议通常一次取回整份，本地盘上比分块更省事）。

**安全与协议**：预览资源由主进程的只读协议 `pw-file://` 提供（仅 GET/HEAD、路径必须落在受信任工作区或应用缓存、支持 Range）。HTML 预览的 iframe `sandbox` 为 `allow-scripts allow-forms allow-modals allow-popups allow-downloads`，**不含 `allow-same-origin`**：脚本可执行，但文档处于不透明源，拿不到父窗口与 Electron API。生产 CSP 在 `img-src` / `media-src` / `frame-src` 放行 `pw-file:`。

**二进制与空态**：未知二进制使用 `EmptyState`（「无法预览此文件」+ 说明 + `openExternally` 按钮）；无打开文件时显示 `noFileOpen` / `selectFileToEdit`，与旧编辑器空态一致。

### 6.4 文件树

- 名称 Noto Sans / Noto Sans SC 12.5px；目录/文件使用 lucide 线性图标。
- 头部右侧依次为加载/错误指示、排序、新建文件与收起按钮；排序入口使用 `ArrowUpDown`，label「文件排序」；收起按钮使用 `PanelLeftClose`，label「收起文件面板」，紧贴分隔条。
- 排序菜单（`PopoverMenu`，宽 144px，`placement="down"`）：名称 / 类型单选，「文件夹优先」「倒序」两个独立开关；默认名称 + 文件夹优先；选择排序键后关闭菜单，开关保持展开便于连续调整。偏好写入 `config/settings.json`（`explorerSortBy` / `explorerFoldersFirst` / `explorerSortReverse`）。名称使用 `Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })` 自然排序（`file2` 在 `file10` 前），倒序只翻转组内顺序，文件夹仍置顶；类型排序按扩展名分组，无扩展名文件排最后。
- 激活行：2px `accent` 左边线 + `bg-accent/[0.06]`；不要整块饱和高亮。
- 右键菜单：纸卡 + `shadow-print`；重命名/删除使用文字 + 图标。

### 6.5 聊天（稿纸）

- 聊天头部 34px（`ChatPanelHeader`，与聊天标签栏合计两层，共 68px）：最左端为收起按钮（`PanelRightClose`，label「收起聊天面板」，紧贴分隔条），其后为「Pi Agent 对话」标题（不承载状态），右端为工作树 chip 与面板拖出柄；未配置 API 的空状态共用同一个头部组件。
- 标题不显示「就绪」等常态信息：仅在初始化期间把标题文案替换为「初始化中…」并附 4px `warning` 脉冲点，初始化完成后不保留任何状态文字与圆点。
- 工作树 chip（24px 高，`rounded-sm` + `border-rule-control` + `px-2`）：`GitBranch` 12px + 分支名 `type-value` + 副标 `type-caption`（主工作树 / 相对路径）+ 共享 `Users` 标记 + 脏文件计数 + `ChevronDown` 12px（展开时旋转 180°）。它是工作树切换的唯一入口（原独立工作树条已合并进头部），必须可点、可键盘操作，`aria-haspopup="menu"` + `aria-expanded` + `aria-label` 含当前分支、`title` 保留完整路径；无 git 仓库时整个 chip 不渲染，头部高度不变。
- 不使用气泡；每条消息以 UI sans 11.5px 角色标签 + 时间开头，消息之间用 1px `rule-divide` 分隔。
- 用户消息以绿色 `›` 起头；正文 `font-reading` 14px / 1.85。
- Agent 回复使用 Markdown：标题用 display 字体，正文 reading，代码块 mono；代码块左侧 2px 绿色线，允许换行。
- 代码块右上角提供复制按钮（hover/focus 显示）。
- 空状态、未配置 API、错误使用 EmptyState / 细线错误条，不使用大色块。
- 上下文附件支持整文件与选区片段：片段 chip 显示 `文件:起止行`，内容是附加时快照（≤40k 字符）；整文件在发送时读取（≤120k 字符，合计 ≤300k）。图片附件在提交瞬间按 id 被本轮消费（缩略图立即消失），与消息一起发送；流式期间新加的图片属于下一轮，不随本轮结束被清空。重试 / 编辑重发 / 计划执行等系统触发的发送不读取也不消费输入框附件，只重发消息自带的图片。
- 会话标签栏（34px，位于聊天头部下方）：标签代表"已打开"会话，容器 `bg-panel` + `border-rule-divide` 底边（与工作区标签栏、编辑器标签条同一套结构）；激活标签 `bg-surface`（与下方正文列同底）+ 2px `accent` 顶线，非激活标签 hover 为 `bg-hover`。最多同时打开 8 个，关闭标签只释放运行时、保留会话文件。
- 标签命中区：34px 整高 × 标签宽度（含左内边距 12px 与左右空位）；文字与标记层 `pointer-events-none`，点击任何位置都切换会话（见 4.5）。
- 关闭按钮命中区 24px（图标仍 10px）：激活标签常显，非激活标签 hover / `focus-visible` 时显示；中键点击标签同样关闭。
- 未命名会话显示「新会话」；同一工作区存在 ≥2 个未命名会话时追加序号（「新会话 2」），避免多开时无法区分；首轮回复后由模型标题覆盖。
- 标签状态按优先级只显示一个标记：**运行中**（`accent` 实心点 + 1.4s 脉冲）> **错误**（`danger` 感叹号图标；保留到下次发送或成功回复）> **待操作**（`warning` 空心环 + 中心点 + 2px 硬边外环，2.4s 呼吸；工具审批等待时触发）> **未读**（`success` 实心点，静态；激活标签时清除）> **已读**（无标记）。
- 草稿是独立标记：标题旁 9px `Pencil` 图标（`ink-subtle`），可与任意主状态并存，不占状态槽。
- 标签的 `title` / `aria-label` 必须包含状态与草稿文案，运行中同时设置 `aria-busy`；状态不能只靠颜色或动效传达。
- 会话列表：聊天列内的全高抽屉，行显示标题、消息数、相对时间与"已打开"标记；当前会话用 2px `accent` 左边线 + `accent/[0.06]`；hover 显示置顶 / 归档 / 导出 / 重命名 / 删除。顶部为 `SearchField` 与“显示已归档”开关；置顶会话排在前面并带 10px `accent` Pin，归档会话显示“已归档”标记且默认隐藏。
- 会话标题：首轮回复后由模型生成一次（中文 ≤16 字 / 英文 ≤8 词），存为 `session_info`；**标题一旦确定（记录里有 `session_info` 或用户手动重命名）后不再自动改写**，后续轮次、压缩后重开、切换工作树都不得重新生成；自动生成失败或首轮尚无文本回复时保留回退标题、不覆盖已有标题；命名输入取首条用户消息 + **最后一条**文本回复的开头，并先剔除「工作目录 / 已加载的规矩 / 工作树状态」这类环境说明段落（这类内容会把标题带成项目名或路径）；模型必须只回 `{"title": ...}`，解析为空或直接复述用户原话的标题判为不可用；无标题时回退首条用户消息（与磁盘列表同一取法：记录行序首条用户消息）。纯图片对话没有可摘取的用户文本，直接写固定标题「图片对话 / Image chat」，不调用模型（Anthropic 端点会在请求里补一句占位文本以绕过空 text 块校验，标题判断仍按纯图片会话处理）。
- 过程轨迹：助手消息内的 thinking / text / tool 按发生顺序排列；相邻 thinking/tool 合并为一个**默认收起**的过程组。组标题实时显示“思考中… / 运行命令…”或完成摘要“过程 · 思考 N 秒 · N 个工具”；用户手动展开后保持展开，不随正文开始或轮次结束自动改变。
- 过程组触发器：`type-label` + `text-ink-muted`，chevron 14px，运行中状态点为 `accent` 1.4s 脉冲；内容左侧 `rule-hairline` 发丝线 + 12px 缩进，不使用卡片、阴影或渐变。
- 思考正文：`.chat-markdown.agent-trace-markdown`（reading 13px / 1.7）+ `text-ink-muted`，Markdown 渲染但流式期间关闭代码高亮。
- 工具行：状态图标（`accent` spinner / `success` Check / `danger` AlertCircle）+ `type-label` 工具名 + `type-data` 目标 + `type-caption` 耗时；展开后的参数与结果使用 `type-data`，结果块使用 `bg-sunken` + `rule-hairline`，最大高度约 240px 内部滚动；执行中结果预览随 `tool_update` 实时刷新；write/edit 有对应 Diff 时提供“查看修改”。
- 过程组收起时不挂载内容 DOM；触发器使用 `aria-expanded` / `aria-controls`，运行中的内容加 `aria-busy`；失败与状态必须有文字，不能只靠颜色或动效传达。
- 工具审批卡：位于输入框上方，`bg-raised` + `border-rule-hairline`，不设阴影。标题行 `warning` ShieldAlert + `type-label`；工具与参数摘要用 `type-value`，类别与路径用 `type-caption` / `type-data`。命令与写入预览放在 `bg-sunken` + `rule-hairline` 的 mono 块中（命令 ≤400 字符、预览 ≤280 字符），不展示完整文件内容。底部按钮依次为允许一次（primary）/ 始终允许（ghost，文案“始终允许（本会话）”）/ 拒绝（danger，右对齐）；“始终允许”只写入当前会话的额外授权，不改动全局默认；拒绝进入二次确认并可选填原因。
- 计划执行：不再提供独立的 Plan / Act 切换，模式统一由状态行的「模式」分段控制。计划模式下助手回复后，若没有结构化计划，输入框上方出现执行条（`bg-raised` + 发丝边 + `type-caption` 提示 + 「完全执行」ghost / 「同意并执行」primary）；结构化计划卡底部依次为拒绝（ghost）/ 完全执行（secondary）/ 同意并执行（primary），“同意并执行”切换到询问模式，“完全执行”切换到完全模式。
- 待发送消息：输入框上方的发丝边纸卡列表，`type-caption` 状态标签（运行中「下一轮发送」/ 空闲「待发送」）+ `type-value` 单行截断正文 + 移除按钮；正文为空时显示「含图 N 张」。排队项自带入队时的图片（只存在内存，不跨重启），插话与「立即发送」都按排队项自己的图片发送。运行中提供「立即插入当前轮」文本按钮，空闲时提供「立即发送」图标按钮。插话成功提示「已插入当前轮」；失败时消息留在列表并提示当前轮已结束。
- 发送与停止：输入区右下角只有一个按钮槽位。空闲时显示「发送」（`primary`，无文本且无图片附件、或图片仍在预处理时禁用）；运行中且无可发送内容时显示「停止」（实心 `Square` 图标 + `danger` 文字，无描边）；运行中且有输入或图片时显示「发送」。纯图片（无文本）消息允许发送。运行中的发送行为取设置项「任务运行时发送消息」的默认值（排到下一轮 / 立即插入当前轮），点击与 Enter 等价；预处理未完成时 Enter 不发送；不提供 Esc 停止快捷键。
- 输入区状态行：输入框下方一行分段触发器（模式 · 模型 · 思考 · 上下文）。每段 24px 高、`rounded-sm`，hover / 展开 `bg-hover`，chevron 展开时旋转 180°；模型名与百分比用 `type-data`，思考标签与模式档位用 `type-caption`。模型名超长截断，整行不换行、不横向溢出。宽度不足时先隐藏上下文段的 token 数字，再隐藏模式段的文字只保留模式图标（`aria-label` 与 `title` 保留完整档位）。
- 模式段：显示当前会话的模式（只读 / 计划 / 询问 / 完全），不提供“自定义”档位。图标按模式着色：只读 `Eye` / `text-ink-muted`、计划 `ListChecks` / `text-accent`、询问 `ShieldQuestion` / `text-warning`、完全 `ShieldOff` / `text-danger`；文字保持 `text-ink-muted`，颜色只做辅助，不是唯一信号。运行中触发器禁用，避免切换工具集打断当前轮；空闲时切换立即生效。
- 状态行菜单：四段各自锚定、就地向上展开（`PopoverMenu`，距触发器 4px；`bg-raised` + 满墨边 + `shadow-print`；模式 176px / 模型 224px / 思考 144px / 上下文 256px，菜单超出面板时自动收进面板内）。选项用 `MenuOption`：当前项 `accent` 勾选，不可用项置灰；模式菜单四个档位都带 14px 模式图标（仅图标着色）；模型菜单底部脚注显示上下文窗口与能力，思考菜单在中文级别旁附英文枚举；模式菜单四个档位之外，若本会话存在额外授权，在底部以 `rule-divide` 分隔一行 `type-caption`“本会话额外允许：修改文件、执行命令”，并提供“重置额外允许”选项；键盘 ↑↓ / Enter / Esc，Esc 后焦点回到触发器。运行中模型、思考与模式触发器禁用，上下文面板仍可查看。
- 上下文面板（A 档）：已用百分比（取整）+ token / 窗口、线性 `Meter`、剩余、本会话累计（token · 费用）与“压缩上下文”行。不做分类估算；压缩后尚未回复时 token 显示占位并提示“待下一次回复后更新”。“压缩上下文”只在此面板提供一个入口，状态行保持纯信息。
- 状态行 token 自适应：上下文段始终显示 14px `RingMeter`（2px 描边，轨道 `rule-divide`，弧色按阈值 `accent` / `warning` / `danger`）与整数百分比；宽度足够时在其后追加 `token / 窗口`，放不下时整段隐藏（按实际测量各段宽度，不使用固定断点），面板内始终保留完整数字。
- 消息操作：悬停或键盘聚焦时在消息头部右侧显示 14px 图标按钮（复制 / 重新生成 / 编辑），默认 `opacity-0`，`group-hover` 与 `focus-within` 时显现；只对最后一条助手回复和最后一条用户消息提供重复生成与编辑入口。
- 快捷键可达：设置“快捷键”页顶部为“可自定义”区，每行左侧 `type-value` 命令名、右侧 `KeyCap` 组合键与 ghost 按钮“修改”；捕获中显示 `warning` 提示文案，冲突用 Toast 报错，页头提供“恢复默认”。
- 文件引用：Markdown 行内代码中的 `path[:line]` 使用 `type-data` 样式，hover 变 `accent` 并加下划线，点击打开编辑器；`@` 搜索弹层为 `bg-raised` + 满墨边 + `shadow-print` 的列表（单行 `type-data`，hover `bg-hover`），拖入文件直接进入附件区。
- 符号附加：附件菜单右上角提供“附加符号 / 附加文件”切换；符号列表每行显示 kind（`type-caption`）、名称（`type-value`，单行截断）与行范围（`type-data`），空态一句“未识别到符号，可改用整文件”。
- 内联变更卡：助手消息下方的 `bg-raised` + 发丝边卡片；标题行“本轮修改了 N 个文件”（`type-label`）+ 右侧“全部还原”（`type-caption`）；每行文件名为单行截断的 `type-data`，右侧“查看修改 / 还原此文件”文本按钮；还原按钮 hover 变 `danger`。
- 重试与错误：重试提示为输入区上方的 `type-caption text-warning` 一行（Spinner + 次数/等待 + 错误摘要）；错误条保持左侧 2px `danger` 线，右侧提供 `type-caption` 文本按钮“重新生成 / 打开设置”。
- 本轮任务：输入区上方的发丝边折叠条（`bg-raised`），标题行“本轮任务 + done/total”，展开后逐行显示 `accent` / `success` / `danger` 状态点、工具名与参数；不使用进度条填充。
- 回到底部：输入区上方的悬浮小按钮（`bg-raised` + 满墨边 + `shadow-print`，`type-caption` + 12px `ArrowDown`），离开底部 120px 后出现；有未读新增时显示“N 条新消息”。

### 6.6 终端

- 浅色纸面终端（Paper）/ 深色纸面（Ink）；xterm 背景与面板一致。
- 终端内容使用 Geist Mono，中文回退 Noto Sans SC；工具条为 UI sans 11.5px，不使用胶囊按钮。
- 光标与选区使用松绿。

### 6.7 设置 / 命令面板 / Diff / Toast

- 设置：纸片弹窗 + 左侧分节导航（通用 / API 配置 / 模式 / 快捷键 / 关于）；分节标签 sans 12px / 500；字段使用 Field + Input/Select；主按钮绿色。
  - 通用分节：「任务运行时发送消息」使用原生 `Select`，选项「排到下一轮」（默认）/「立即插入当前轮」，说明为运行中发送消息的默认处理方式；存储于 `config/settings.json` 的 `runWhileBusy`。
  - 通用分节：「关闭主窗口」使用原生 checkbox（与「自动保存」同一行形态：12px 方框 + `type-value` 文案，整行 `label` 可点，勾选色 `accent`），勾选显示「收进托盘」、取消显示「直接退出」；说明写明收进托盘时会话 / 终端 / 监听继续运行、可从托盘图标重新打开，Linux 上改为最小化到任务栏；存储于 `config/settings.json` 的 `closeToTray`（默认 `true`）。
  - 供应商 API 分节：模型列表使用**模型能力表**（`SettingsTable`）——每行一个模型，列为「模型」（伸缩、`type-data`、单行截断）/「上下文容量」（96px 原生 `Select`）/「图片」（48px checkbox 居中）；行高由控件决定（`Select` 32px + 上下 4px，约 40px），行间 1px `rule-divide`，整表外框 1px `rule-hairline` + `bg-raised`，表头 `bg-panel` + `type-label` + `text-ink-muted`；表体最长 256px，超出纵向滚动；当前选中模型行 `bg-active`；表下附 `type-caption` 说明。容量档位固定为 `64K / 128K / 256K / 1M` 四个字面量，不翻译、不提供自动档与手填；默认 128K。保存时若存在运行中会话，用 alert 弹窗告知原因，保存按钮不禁用。
  - 模式分节：单个原生 `Select` 选择「默认模式」（只读 / 询问 / 完全），说明写明“仅用于新会话，不影响已有会话；计划模式可在会话中随时切换，不作为默认值”；不提供按工具类别的自定义组合，也不提供“自定义”档位；存储于 `config/settings.json` 的 `permissionLevel`。选择器下方提供四行非交互图例（`LegendRow`）：图标与颜色和状态行一致，说明各模式；「计划」标记“仅会话内”，其余标记“可设为默认”。
  - 快捷键分节：动作名使用 sans 12.5px，键帽使用 mono 10.5px + 1px `border-rule-control` + `bg-sunken`，用 `<kbd>` 语义；按平台显示 `Ctrl` 或 `⌘`。
  - 分组：全局 / 编辑器（打开文件时）/ 聊天（工作区内）/ 浮层；仅列出实际生效的快捷键。
- 命令面板：560px 纸片、sans 搜索、编号结果列表、选中项 2px 绿色左边线；Esc 关闭。
- Diff：纸面审阅单；新增用 `success/10` 橄榄淡洗，删除用 `danger/10` 朱砂淡洗；统计与行号使用 mono，说明文字使用 sans。长行横向滚动、行高固定 22px；大 Diff 使用虚拟渲染。
- Toast：纸片 + 左侧 2px 语义色线 + 错位阴影；出现位置右上，避开顶栏。

### 6.8 主题

- 默认 **Paper**；设置中提供 Paper / Ink / 跟随系统。
- 主题写入 `{appDir}/config/settings.json`；已保存偏好优先。
- 切换时同步 `<html class="dark">`、`document.documentElement.lang`、窗口标题、Monaco、xterm。
- 不要在组件内写 `dark:` 变体；全部通过 token 自动切换。

### 6.9 窗口外壳与标题栏

采用 **无边框窗口（方案 B）**：Windows / Linux 使用 `frame: false` 与自绘窗口按钮；macOS 保留原生红绿灯。

- **Windows / Linux**：
  - `frame: false`，顶栏即标题栏，高度由 `--titlebar-height` 控制（当前 45px）。
  - 右上角为自绘窗口按钮，单颗 **45×45px 正方形**（宽度绑定 `--titlebar-height`），贴齐窗口边缘。
  - 图标为定制细线 glyph（不使用 lucide）：13px、`stroke-width: 1.25`、`stroke-linecap: butt`、`stroke-linejoin: miter`。
    - 最小化：10px 水平线；
    - 最大化：9×9 直角方框；
    - 还原：两个错位的 7×7 直角方框；
    - 关闭：两条 9px 斜线。
  - 悬停：最小化/最大化 `bg-hover` + `text-ink`；关闭 `bg-danger` + `text-danger-fg`；按下 `bg-active`；过渡 150ms。
  - 最大化状态通过主进程事件同步，图标在 `Square` / `Copy` 之间切换。
  - 双击顶栏空白区域切换最大化；按钮、链接、输入框不触发。
  - 菜单栏隐藏（`autoHideMenuBar` + `setMenuBarVisibility(false)`），但保留应用菜单角色以维持快捷键。
  - 已知取舍：自绘最大化按钮不会触发 Windows 11 的 Snap Layouts 悬停菜单；拖拽到屏幕边缘的吸附仍可用。
- **macOS**：`titleBarStyle: 'hiddenInset'`；保留左上角原生红绿灯，顶栏左侧预留 78px，不渲染自绘按钮。
- **拖拽区**：顶栏使用 `.app-drag`；按钮、链接、输入框通过 `.app-drag` 子选择器或 `.app-no-drag` 设为 `no-drag`。
- **不要在顶栏重复窗口标题**；品牌区 `Pi / WORKBENCH` 已承担标题作用。
- **窗口控制 IPC**：`window:minimize` / `window:toggleMaximize` / `window:close` / `window:isMaximized`，以及 `window:maximized-changed` 事件；Web 模式下所有窗口控制为空操作。
- **跨平台**：Windows 已实测；macOS / Linux 需要在对应系统上验证红绿灯/自绘按钮、拖拽与缩放。

### 6.10 启动页与窗口形变

启动时只有一个窗口，它从小尺寸长成工作台，全程没有第二个窗口或渲染进程。

- **静态启动页**：`src/index.html` 在 React 之前直接绘制，`src/public/boot.js` 依据 URL 上的 `theme` / `lang` 在首帧前给 `<html>` 加 `dark` 与 `data-lang`。内容只有品牌印（44px）、`type-brand` 的 `Pi Workbench`、`Spinner` + `type-label` 的「工作台启动中…」；颜色与 `index.css` 的 token 一一对应（`boot-screen.test.ts` 校验）。顶部 45px 为拖动区（无边框窗口）。
- **尺寸与时序**：小窗 420×260，居中于当前显示器工作区；小窗可见后至少停留 600ms，面板数据（设置 / 最近工作区 / 更新状态）就绪后放大；放大 400ms（easeOutCubic，16ms 步进），即最短总时长 1 秒；面板更慢则按就绪时间顺延。放大目标 1200×800，围绕窗口当前中心、限制在所在显示器工作区内。
- **唯一允许的窗口尺寸动效**：只用于启动；其他场景仍禁止缩放动画。
- **交接**：放大结束前外壳不挂载，窗口里只有启动页参与重排；结束后外壳以终态尺寸挂载，遮罩 150ms 淡出，用户看到的第一帧即完整工作台。
- **兜底**：8 秒未收到就绪信号直接放大；启动页 10 秒后追加提示；渲染进程崩溃或页面加载失败同样结束启动态。

---

### 6.11 Git 面板

提交列表在同一个组件里维护宽 / 窄两套行布局，切换点是面板宽度 420px；被折叠的 ref 一律以 `+N` 徽章收口，全名放在 `title` 里。

- **宽面板行**：单行网格 `图 / 提交 / 作者 / 变更环 / 时间 / SHA / 操作`，后四列可拖拽调宽（作者 40–80、变更环 26–56、时间 56–150、SHA 44–110）。行内最多显示 2 个 ref 徽章，超出时只留第一个并折成 `+N`（按个数折叠）。
- **窄面板行**：行高 44px，内容格为两行两列 `minmax(0,1fr) 52px`。第一行是「标题 + 右列相对时间」，第二行是「ref 徽章 + 右列短哈希」；时间与短哈希共享这 52px 固定列并右对齐，ref 行因此与标题等宽。窄面板不显示作者与变更环。
- **固定列宽 52px 的依据**：7 位短哈希（`type-data` mono）≈48px，`59分钟前` ≈46px，`25/12/31` ≈43px，一列通吃中英文与哈希。溢出用 `truncate` 兜底，不做动态列宽。
- **窄面板 ref 折叠按宽度而非个数**：先累加徽章宽度并为末尾 `+N` 预留位置，放不下的整体折起；量不到字宽（字体未就绪）时退回宽面板的计数折叠。单个徽章就超过整列时保留第一个并允许截断。
- **时间文案**：`59分钟前` / `23小时前` / `29天前`（中文保留 `昨天` / `前天`），英文走紧凑单位 `59m` / `23h` / `29d`；超过 30 天用两位年份的本地化日期（`25/12/31`、`12/31/25`），保证两语言同为 8 字符。工作区行右侧的日期标签（`今天` / `9月2日`）不在此列。
- **操作按钮**：复制 SHA 与「在此建分支」是 12px 图标按钮，只在悬停 / 聚焦 / 选中的行出现；窄面板下它们覆盖在固定时间列之上，时间保持常驻不与按钮交换位置。

---

### 6.12 辅助窗口（面板拆分）

面板（文件树 / Git / 聊天 / 终端）可以拆成一个独立窗口，关掉那个窗口就回到主窗口原位。拆分只换渲染落点，状态不复制：同一份 store，同一个 JS 上下文。

- **外壳与主窗口一致**：Windows / Linux 无边框（`frame: false`），macOS `titleBarStyle: 'hiddenInset'` + 红绿灯（`trafficLightPosition { x: 12, y: 10 }`）。最小尺寸 320×220；首帧背景取 `--panel`，避免开窗白闪。
- **34px 自绘标题栏**是辅助窗口内唯一新增的结构：整条 `app-drag` 可拖动窗口、双击最大化；`bg-panel` + 底部 `border-rule-divide`；左侧 `type-label text-ink-muted` 显示工作区名（`basename(workspacePath)`，`truncate`，光标 `pl-3`；macOS 为红绿灯让位 `pl-[84px]`），右侧 28px `IconButton`（`PanelRightClose`，label「还原到主窗口」）+ `WindowControls compact`（三个 36px×34px 按钮，macOS 不渲染）。标题栏只有一个信息位，不与面板内头部重复、不加第二行元数据。
  - **窗口按钮按目标窗口寻址**：渲染层只跑在主窗口的 JS 上下文里，IPC 来源恒为主窗口，因此辅助窗口的最小化 / 最大化 / 关闭必须显式带 `frameName`（`aux:window-command`），不能由主进程从 sender 推断；最大化状态同理带 `host` 回传（`window:maximized-changed`），每个 `WindowControls` 只认自己的 `host`。
- **拆出后主窗口彻底让位**：原位置不渲染任何内容（不占宽、不占高、无占位卡），空间交给编辑器。侧栏是 files / git 共用：还剩一个停靠就保留侧栏与 2px 接缝，两个都拆出则侧栏、接缝、26px 导轨一并消失；对话列拆出时连同接缝一起消失；终端拆出后不留行高。侧栏标签条上拆出的标签隐去，当前标签被拆走时自动切到还在的一边。面板组件仍保持挂载（portal 的 fiber 挂在主窗口树上，只是容器 `hidden` 不参与布局），卸载 `PanelSlot` 等于拆掉独立窗口。回位入口只有关闭窗口。
- **两个入口：右键菜单与拖出柄**。
  - 右键菜单：面板头部右键弹出。形态与 `FileExplorer` 的节点菜单一致（`fixed inset-0` 遮罩 + `bg-raised` + 满墨 `border-line` + `shadow-print`，`min-w-[190px]`，`type-value` 行 `px-3 py-1.5`），按当前状态只给一个动作：`ExternalLink`「在独立窗口中打开」或 `PanelRightClose`「还原到主窗口」。
  - 拖出柄：面板头部标题左侧的 14px `GripVertical`（`text-ink-muted`，hover `text-ink`，`cursor-grab`/`active:cursor-grabbing`）。拖到主窗口之外松手即拆出，落点由主进程读真实光标位置决定；在主窗口内松手不算拆分。`dataTransfer.dropEffect` 不能作为取消判据（拖出窗口松手时同样为 `'none'`）。拖出柄只在面板停靠主窗口时出现，拆出的面板靠关闭按钮回位，不新增常驻按钮。
  - 拆出瞬间主窗口这一侧立即让位，不等子窗口首帧。
- **主题与语言跟随主窗口**：辅助窗口镜像 `html.class`（Paper / Ink）、`lang`、`data-lang`，切换主题即时同步，不重开窗口。辅助窗口内不执行任何脚本（`script-src 'none'`）。
- **提示与对话框按窗口落点**：toast 与 `DialogHost` 每个窗口各挂一份，只显示属于该窗口的条目；落点由「哪个窗口持有焦点」决定，不再弹回主窗口。
- **明确不做**：不做布局持久化（重启回到默认布局）、不做窗口内拖拽重排、辅助窗口里不放 Monaco / Diff / 设置。

### 6.13 主窗口关闭与托盘常驻

主窗口的关闭按钮默认不是退出，而是把窗口收进系统托盘；进程、会话、终端与文件监听继续运行。

- **入口与出口**：`X` = 收进托盘（设置项「关闭主窗口 → 收进托盘」可改回直接退出）；恢复只走托盘图标 / 菜单、第二个实例、macOS Dock 或系统级唤回，窗口回到原位置原尺寸。真退出只有两个入口：托盘菜单「退出」与系统级退出（Cmd+Q、关机）。
- **收进托盘不拦未保存确认**：窗口只是隐藏，渲染进程不卸载，因此不会弹「还有未完成的工作」；该确认仍然只属于真退出路径。
- **托盘图标**：Windows / Linux 用彩色 `app-icon.ico`（16px 托盘尺寸），macOS 菜单栏用单色 π 模板图 `tray-template.png`（`scripts/make-tray-icon.mjs` 由品牌图标生成 16 / 32 两档，`setTemplateImage` 让颜色跟随系统深浅色，不区分 Paper / Ink）。Linux 各桌面环境托盘支持不一致，不创建托盘，关闭按钮降级为最小化到任务栏。
- **托盘菜单是系统原生菜单**（`Menu.buildFromTemplate`），不受本文档的颜色与字体 token 约束，只有文案跟随应用语言：`显示主窗口` / 分隔线 / `退出`。
- **Windows 首次收起提示**：托盘气泡（`displayBalloon`）说明一次「仍在后台运行」，不使用应用内 Toast 或模态框，每次启动最多一次。
- **辅助窗口完全独立**：主窗口收进托盘时辅助窗口留在屏幕上，主窗口恢复时也不动它们；辅助窗口没有「恢复 / 重现」语义，唯一出口是关闭 → 面板回位（主窗口即使正藏在托盘里也只是静默回位，不唤醒、不重新拆出）。

### 6.14 上下文压缩点

压缩点是对话时间线上的一个事件，既不是系统消息，也不是可操作的系统卡片。

- **形态**：两侧 1px `bg-rule-divide` 细线 + 居中 `Caption`（`text-ink-subtle`），容器 `py-1` 与 `role="separator"`。不新增颜色、图标或按钮。
- **位置由输出顺序决定**：压缩点以 `compaction` part 存在消息的 `parts` 时间线里，前后文本 / 思考 / 工具严格按发生顺序排列；遇到压缩点必须先结束当前工作块，不能把它折进可收起的过程组。
- **归属轮次**：压缩发生在哪一轮就属于那一轮。整条消息只有压缩点时（压缩发生在两轮之间），不渲染消息头（角色名、时间、分支切换与操作区），只显示分隔线。
- **文案只有两档**：已知压缩前用量时 `上下文已压缩 · 压缩前 N tokens`，未知时 `上下文已压缩`。不区分手动 / 自动，不显示压缩原因。
- **明确不做**：不做点击展开压缩摘要、不用警告色、不做可操作卡片。

### 6.15 内容区浮动控件

贴在内容上的常驻操作（目前是编辑器的「源码 / 阅读视图」切换）不占标签条或工具条的一行，而是浮在内容区右下角。

- **落点**：内容容器（`FileView` 的 `relative` 层）右下角内缩 16px（`bottom-4 right-4`），`z-10`。16px 是为了把滚动条让出来——竖条约 10–14px，大文件关闭换行时底部还有 10px 水平条；12px 会压住滚动条的拖动区。
- **不参与内容滚动**：浮层挂在内容容器的滚动区**之外**，正文滚动时不跟着走；不能放进阅读视图自己的滚动容器里。
- **常态半透明**：`bg-raised/90` + 1px `border-rule-control` + `text-ink-muted`，28×28px；hover / focus-visible 升为 `bg-raised` + 满墨 `border-line` + `text-ink`。禁止 `backdrop-filter`（玻璃拟态）；半透明只允许用 token 的不透明度变体，不写裸 rgba。
- **为什么不在标签条**：标签条是 `overflow-x-auto`，标签一多，靠 `ml-auto` 贴右的那一格会被挤出可视区（甚至要横向滚动才看得见）。功能性入口不放在会溢出的容器里。
- **避让**：Markdown 阅读视图版心底部留 `pb-12`，滚到底时最后一行仍在浮层上方；不为浮层缩小正文列宽。
- **已知可接受重叠**：正文里宽代码块的横向滚动条、Monaco 自动补全弹层（编辑器很窄时）可能被压住一角，可接受；滚动条必须让开，其余必须可点的控件不得被覆盖。
- **同一功能只有一个位置**：阅读 / 源码两种视图共用同一落点，切换时按钮不跳动。
- **可访问性**：必须有 `aria-label` / `title`，键盘可聚焦，focus 走全局 1px `accent` 描边；不用 `opacity` 把按钮藏起来（半透明不等于不可见）。

---

## 7. 可访问性

- 正文、链接、按钮文字 ≥4.5:1；`ink-subtle` 仅用于元数据。
- 所有交互元素有可见焦点：1px `accent` 描边 + 2px offset。
- 图标按钮必须有 `aria-label`；装饰性图标 `aria-hidden`。
- 弹窗使用 `role="dialog"` + `aria-modal="true"`；Esc 关闭；设置/命令面板/Diff 一致。
- 状态不能只靠颜色：同时使用文字、图标或形状（如 `● RUNNING`、`+18 −6`）。
- 支持 200% 缩放与 1024/1440 宽度；不产生横向溢出。

---

## 8. 内容与文案

- 中文为默认语言，英文完整对等；所有用户可见文案必须走 `t()`。
- 语气简洁、编辑式，不使用营销口号；错误信息给出可执行的下一步。
- 技术标识（文件路径、命令、模型名、快捷键）使用 mono，不翻译。
- mono 眉题可以大写；普通界面标签不使用全大写。
- 不写“请稍候”这类空泛提示；用具体状态（“正在读取 6 个文件”）。

---

## 9. 禁止项与检查清单

### 9.1 禁止

- ❌ 硬编码十六进制颜色、`gray-*` / `blue-*` / `red-*` 调色板类。
- ❌ 在组件中使用 `dark:` 变体（应使用 token）。
- ❌ 新增大圆角（>4px）卡片、胶囊按钮、彩色胶囊状态。
- ❌ 渐变、玻璃拟态、柔光/发光、装饰性阴影。
- ❌ emoji 充当图标；混用多套图标库。
- ❌ 未登记的字体、字号、间距、圆角、阴影、动效。
- ❌ 用颜色作为唯一状态信号。
- ❌ 在业务组件里重复实现 Button / Input / Modal。
- ❌ 用满墨 `border-line` 画区内卡片外框或普通区域边界（只允许浮层）。
- ❌ 给页面内的纸卡加投影（`shadow-print` 只属于浮层）。
- ❌ 绕过线条角色直接写 `border-line/50` 等裸透明度。
- ❌ 把功能性入口（视图切换等）放在会横向溢出的容器里；内容区常驻操作按 6.15 浮在右下角。
- ❌ 对浮动控件使用 `backdrop-filter` / 玻璃拟态，或压住滚动条拖动区。
- ❌ 把点击处理留在无 handler 的 wrapper 里的内层小按钮上（padding / 行高变成死区，命中区不满）；标签不得自行拼 `role="tab"`。

### 9.2 新 UI 工作检查清单

- [ ] 只使用设计 token 与 `ui.tsx` 基础组件。
- [ ] Paper / Ink 两套截图均检查。
- [ ] 所有承载信息的文字在 Paper / Ink、surface / panel 上 ≥4.5:1。
- [ ] `ink-subtle` 只用于装饰/禁用态，不承载信息文字。
- [ ] Label 12px / 500、Value 12.5px / 400、Data 11.5px、阅读正文 14px / 1.85。
- [ ] 中文标签与字段值使用 UI sans，未使用 mono；uppercase/tracking 只用于纯 Latin 眉题。
- [ ] 业务组件未直接写 `font-*`、任意字号、`uppercase`、`tracking-[...]`、`leading-[...]`。
- [ ] 新增内容类型已落到 `patterns.tsx`，页面只做组合。
- [ ] 卡片为 `bg-raised` + `border-rule-hairline` 且无投影；控件边界为 `border-rule-control` 且 ≥3:1。
- [ ] 区域分层正确：外壳/侧栏/聊天标签栏 `panel`，编辑器画布、聊天正文列与激活标签 `surface`；接缝为 2px `bg-rule-seam`。
- [ ] 聊天面板头部为两层 34px（共 68px），收起按钮图标、标签状态点、工作树 chip 图标的左边缘同为 12px，拖出柄与右侧图标按钮右边缘同为 12px。
- [ ] 满墨 `border-line` 只出现在浮层（Modal、菜单、命令面板、Toast）上。
- [ ] `tests/design-system.test.ts` 通过。
- [ ] 阅读视图：可切源码的类型才显示视图切换；切换按钮浮在内容区右下角（6.15），不占标签条；媒体/PDF/二进制没有源码入口，均提供「系统打开」；HTML 预览的 `sandbox` 不含 `allow-same-origin`。
- [ ] placeholder 使用 `ink-muted`。
- [ ] 键盘可访问，焦点可见，图标按钮有名称。
- [ ] 可点区域 = 可视矩形（4.5）：标签整块可点、次级动作 ≥24×24px、装饰层 `pointer-events-none`。
- [ ] 1024 / 1440 宽度无横向溢出。
- [ ] 空状态、加载态、错误态完整。
- [ ] 对比度自动检查通过。
- [ ] `npm run type-check`、`npm run lint`、`npm test` 通过。
- [ ] 如引入新设计元素，已更新本文档并获得确认。

---

## 10. 设计变更流程

任何超出本规范的设计改动，按以下顺序执行：

1. **提案**：说明变更动机、影响范围、替代方案。
2. **更新规范**：修改本文件并同步 `src/index.css` 中的 token 定义。
3. **确认**：获得项目所有者明确确认；未确认不得进入实现。
4. **实现**：只通过 token / `ui.tsx` / 现有模式落地；不引入临时样式。
5. **验证**：双主题截图、对比度、窄窗口、键盘、测试与构建。
6. **记录**：在“变更记录”中写明版本、日期、变更内容。

> 未经文档化的设计例外视为技术债，需在下一个迭代补回规范或移除。

---

## 11. 代码索引与实现约定

| 内容 | 位置 |
|---|---|
| Git 面板 | `src/components/GitView.tsx` |
| ref 徽章折叠（宽 / 窄两套） | `src/utils/refBadges.ts` |
| 字宽实测探针 | `src/utils/textWidth.ts` |
| 相对时间与两位年份日期 | `src/utils/relativeTime.ts` |
| 颜色 / 字体 / 全局样式 | `src/index.css` |
| Token 到 Tailwind 的映射 | `tailwind.config.js` |
| 基础组件 | `src/components/ui.tsx` |
| 品牌标记 | `src/components/BrandSeal.tsx` |
| 内容模式组件 | `src/components/patterns.tsx` |
| 标签（`Tab` / 键盘与滚轮模型） | `src/components/patterns.tsx`（`Tab`、`handleTabListKeyDown`、`handleTabStripWheel`） |
| 语义文字角色 | `src/index.css`（`.type-*`） |
| 线条角色 token | `src/index.css`（`--rule-*`）、`tailwind.config.js`（`border-rule-*`） |
| 设计系统约束测试 | `tests/design-system.test.ts` |
| 主题状态 | `src/store/themeStore.ts` |
| 欢迎页 | `src/components/WelcomeScreen.tsx` |
| 聊天稿纸 | `src/components/ChatPanel.tsx` |
| 聊天头部 | `src/components/ChatPanelHeader.tsx`、`src/components/ChatHeader.tsx` |
| 工作树切换 chip | `src/components/WorktreeChip.tsx` |
| 会话标签栏 / 列表 | `src/components/SessionTabs.tsx`、`src/components/ChatSessionList.tsx`、`src/store/sessionStore.ts` |
| 编辑器主题 | `src/components/MonacoEditor.tsx`（`pi-paper` / `pi-ink`） |
| 文件视图容器 / 标签条 | `src/components/FileView.tsx`、`src/components/EditorTabs.tsx` |
| 内容区浮动控件 | `src/components/ui.tsx`（`OverlayButton`）、`src/components/FileView.tsx`（右下角落点） |
| 阅读视图（Markdown / HTML / 媒体 / PDF） | `src/components/MarkdownReadingView.tsx`、`src/components/HtmlPreview.tsx`、`src/components/MediaView.tsx`、`src/components/PdfReadingView.tsx` |
| 文件类型分派与预览 URL | `src/utils/fileKind.ts`（`detectFileKind` / `defaultViewFor` / `filePreviewUrl`） |
| 只读文件协议 | `electron/file-protocol.ts`（`pw-file://`，Range + 信任校验） |
| 保存 / 草稿 / 外部变更 | `src/workspace/useFileDocument.ts` |
| 统一打开入口 | `src/workspace/openFileInEditor.ts` |
| 终端主题 | `src/components/TerminalPanel.tsx` |
| 第三方主题 token 桥 | `src/theme/tokens.ts`（`readThemeTokens` / `tokenHex`） |
| 辅助窗口（面板拆分） | `src/panelHost/`、`src/components/PanelSlot.tsx`、`src/components/PanelWindowFrame.tsx`、`src/components/PanelContextMenu.tsx`、`src/components/PanelDragHandle.tsx`、`src/store/panelStore.ts` |
| 窗口外壳 / 标题栏 | `electron/main.ts`、`electron/preload.cts` |
| 自绘窗口按钮 | `src/components/WindowControls.tsx` |
| 拖拽区工具类 | `src/index.css`（`.app-drag` / `.app-no-drag`） |
| 字体入口 | `src/main.tsx` |
| 主题默认值 | `electron/main.ts`（`DEFAULT_SETTINGS.theme`） |
| 视觉历史 | 早期 Paper & Ink 方案稿已清理，需要时查 Git 历史 |

**实现约定**：

- 组件保持扁平结构，不新增 `components/xxx` 子目录。
- 新组件优先组合 `ui.tsx` / `patterns.tsx`，不复制样式字符串。
- 业务组件只使用 `type-*` 语义文字类；禁止直接写 `font-*`、任意字号、`uppercase`、`tracking-[...]`、`leading-[...]`。
- 新增内容类型时，先在 `patterns.tsx` 增加组件或命名的密度/语气变体，再在页面组合。
- 样式类只使用本文件列出的 token 与 Tailwind 工具类。
- 新增 token 必须同时更新 `index.css`、`tailwind.config.js` 和本文档。
- `tests/design-system.test.ts` 是强制门槛；绕过它等同于设计规范未落地。

---

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.46 | 2026-10-28 | 会话标题改用去噪后的回复摘录并校验模型输出：命名输入剔除环境说明段落、取最后一条文本回复，要求 JSON 输出，复述原话的标题判为不可用 |
| v1.45 | 2026-10-28 | 会话标题生成容错：6.3.1 补充「模型返回空内容不算确定、最多重试 3 次」，标题请求为推理型模型留足 token 预算 |
| v1.44 | 2026-10-28 | 会话标题确定后不再改写：6.3.1 标题规则改写（记录或手动重命名即为确定、失败与无文本回复只保留回退标题、回退取法与会话列表一致） |
| v1.43 | 2026-10-28 | 标签命中区修满：新增 4.5 命中区（控件本体拥有点击、装饰层 `pointer-events-none`、次级动作 ≥24×24px、标签条不显示横向滚动条、roving tabindex + ←/→/Home/End）；`patterns.tsx` 新增 `Tab` 与 `handleTabListKeyDown` / `handleTabStripWheel`，工作区标签条、编辑器标签条、会话标签条统一改用它（整块矩形可点、中键关闭、关闭命中区 24px）；工作区「打开项目」+ 移出 tablist |
| v1.42 | 2026-10-28 | 视图切换按钮离开标签条，改为内容区右下角浮层：新增 6.15（16px 让开滚动条、常态 `bg-raised/90` 半透明、hover/focus 实心、阅读视图版心 `pb-12` 避让、可接受重叠清单）与 5.11 `OverlayButton`；6.3.1 视图切换位置改写 |
| v1.41 | 2026-10-28 | 上下文压缩点改为时间线 part：新增 6.14（位置由 parts 顺序决定、压缩点单独成组、纯分隔线消息不渲染表头、文案统一为「上下文已压缩 · 压缩前 N tokens」并删除手动 / 自动措辞） |
| v1.40 | 2026-10-28 | 主窗口关闭按钮改为收进托盘常驻（可在设置关闭）：新增 6.13 托盘图标 / 原生菜单 / Windows 首次气泡 / 辅助窗口完全独立；设置「通用」新增「关闭主窗口」复选框与对应文案 |
| v1.39 | 2026-10-28 | 面板拆出后主窗口彻底让位：撤掉原位 `EmptyState` 占位（连带「定位到独立窗口 / 还原到主窗口」两个按钮），侧栏 / 对话列 / 终端行连同 2px 接缝一起消失，空间交给编辑器；辅助窗口标题栏由面板名改为工作区名；拆出的侧栏标签从标签条隐去，当前标签被拆走时自动切换；回位只靠关闭窗口 |
| v1.38 | 2026-10-28 | 聊天头部三层合两层：工作树切换条并入头部为 24px chip（带 `ChevronDown`）、会话标签栏升为 34px，头部由 38 + 34 + 32 收到 34 + 34；移除常态「就绪」状态；聊天正文列改 `bg-surface`，激活标签与正文列同底（与编辑器标签同一套连通规则）；关闭按钮命中区 16px → 24px 且激活标签常显；未命名会话按需加序号；未配置 API 的空状态复用共享头部 |
| v1.37 | 2026-10-28 | PDF 阅读视图改为 pdf.js 自绘：单一滚动容器 + canvas 虚拟化（视口 ±2 页、离开视口释放像素内存）、适应宽度默认与 50%–400% 手动缩放、页码 / 翻页 / 键盘、失败只留系统打开；工具条与媒体视图同构；移除 Chromium 内置查看器依赖（`webPreferences.plugins`） |
| v1.36 | 2026-10-28 | 辅助窗口改用与主窗口同一套外壳：Windows / Linux 无边框、macOS `hiddenInset`，32px 信息栏升级为 34px 自绘标题栏（拖动窗口 / 双击最大化 / 回位 / 窗口按钮）；窗口按钮按 `frameName` 寻址，最大化状态带 `host` 回传；拖出柄 14px，`dropEffect` 不再作为取消判据 |
| v1.35 | 2026-10-28 | 辅助窗口（面板拆分）：原生标题栏 + 32px 信息栏 + 原位占位；右键菜单拆分/回位；主题与提示按窗口落点；不持久化布局 |
| v1.34 | 2026-10-28 | 聊天图片附件：提交即按 id 消费（缩略图立即消失），流式期间新图留给下一轮；排队项与运行中插话可带图，正文为空时显示「含图 N 张」；纯图片（无文本）允许发送；系统触发的发送（重试 / 编辑重发 / 计划执行）不消费输入框附件；纯图片会话标题固定为「图片对话 / Image chat」，Anthropic 端由 AgentManager 补占位文本避免空 text 块被拒 |
| v1.33 | 2026-10-27 | 模型能力表：设置页供应商 API 分节把「支持图片的模型」勾选列表升级为三列能力表（模型 / 上下文容量 / 图片），新增 `SettingsTable` / `SettingsTableRow` 模式与 `Modal` 的 alert 单按钮变体；容量为四档固定字面量（64K / 128K / 256K / 1M，默认 128K） |
| v1.32 | 2026-10-27 | Git 面板提交行：窄面板（<420px）改为两行两列布局，ref 徽章与标题等宽、短哈希右对齐进固定 52px 时间列；窄面板 ref 按实测宽度折叠为 `+N`（宽面板仍按个数）；相对时间英文改紧凑单位（`59m` / `23h` / `29d`），超过 30 天改两位年份本地化日期（`25/12/31` / `12/31/25`），会话列表同步 |
| v1.32 | 2026-10-27 | 启动页与窗口形变：静态启动页 + React 启动闸门，小窗 420×260 → 1 秒（停留 600ms + 放大 400ms）→ 1200×800；主题与语言随 URL 预置；唯一允许的窗口尺寸动效，其他场景仍禁止缩放 |
| v1.31 | 2026-10-26 | 品牌标志：新增松绿印面 + π（Noto Serif 轮廓，OFL）+ `WORKBENCH` + 署名 `TChen` 的锁定；印面底边压基线、圆角 19.8%；新增 `type-signature` 与 `BrandSeal` 组件；应用图标改为 256 带署名、128 及以下简化的分稿，重生 app-icon.png / 多尺寸 ICO |
| v1.30 | 2026-10-26 | 文件树排序：头部新增排序菜单（名称 / 类型单选、文件夹优先 / 倒序开关），偏好持久化到 `config/settings.json`；排序改为目录优先 + `Intl.Collator` 自然排序，倒序只翻转组内顺序；`MenuOption` 新增 `menuitemcheckbox` 角色并入 ↑↓ 导航 |
| v1.29 | 2026-10-26 | 多工作区与首页：每个打开的工作区常驻视图，切换标签/返回首页只隐藏不卸载；顶栏主操作改为「返回首页 / 返回工作区」，关闭只在标签 ×；工作区标签新增待操作 / 错误 / 运行中状态标记；关闭后固定状态（打开的文件、会话、草稿）保留并恢复 |
| v1.28 | 2026-10-26 | 面板开关回归面板：文件树头部最右端、聊天头部最左端各一个收起按钮，顶栏移除两个开关；收起后显示 26px 全高窄条，整条可点击、图标居中，点击展开；未配置 API 的聊天空状态保留头部与收起按钮 |
| v1.27 | 2026-10-24 | 聊天头部移除重复的快捷键提示与设置按钮，入口统一到顶栏；头部仅保留「Pi Agent 对话 · 就绪」标题与状态 |
| v1.26 | 2026-10-24 | 移除检查点：聊天头部不再提供检查点入口与回退浮层；代码回退由 git 与单文件还原承担，消息重试 / 编辑与分支切换保持不变 |
| v1.25 | 2026-10-24 | 模式与上下文可视化：状态行模式段与菜单使用模式图标并着色（只读 `Eye` 中性 / 计划 `ListChecks` 松绿 / 询问 `ShieldQuestion` 琥珀 / 完全 `ShieldOff` 朱砂），文字保持中性；上下文段改用 14px `RingMeter`（2px 描边，阈值色），详情面板保留线性 `Meter`；设置页模式分节新增 `LegendRow` 四模式图例 |
| v1.24 | 2026-10-24 | 会话模式合并 Plan / Act：状态行「模式」段提供只读 / 计划 / 询问 / 完全四档，移除输入区 Plan / Act 切换；计划卡与兜底执行条改为拒绝 / 同意并执行 / 完全执行三按钮，批准时原子切换到目标模式；设置页「模式」分节只提供只读 / 询问 / 完全三个默认档 |
| v1.23 | 2026-10-24 | 会话级权限：状态行新增「权限」分段（只读 / 询问 / 全自动），菜单内展示本会话额外授权并支持重置；审批卡收敛为允许一次 / 始终允许（仅本会话）/ 拒绝；设置页权限分节改为单一「默认权限」选择，仅作为新会话的种子；Plan 模式下权限段禁用并强制只读 |
| v1.22 | 2026-10-24 | 移除 Fleet 后台任务：顶栏不再提供 Fleet 入口，欢迎页右侧去掉 Fleet 摘要卡，活动视图只汇总运行中的会话；保留 `.pi-worktrees` 忽略规则用于清理旧遗留目录 |
| v1.21 | 2026-10-24 | 聊天输入区：发送与停止合并为单一按钮槽位（空闲发送 / 运行中空输入停止 / 运行中有输入发送）；移除「排队 / 插话」分段切换，改为设置项「任务运行时发送消息」默认值；待发送卡片提供「立即插入当前轮 / 立即发送」；不提供 Esc 停止快捷键 |
| v1.20 | 2026-10-24 | 聊天输入区状态行：模型 / 思考 / 上下文三段改为就地向上展开的分段菜单（新增 `PopoverMenu` / `MenuOption`）；上下文面板（A 档）显示已用百分比、token / 窗口、剩余、本会话累计与压缩入口，宽度 256px；状态行的 token 数字按可用宽度自适应显隐；移除常驻 `Select` 与重复的快捷键提示 |
| v1.19 | 2026-10-23 | 新增 `Meter` 线性进度组件（下载进度）；状态栏增加版本号与更新提示；更新安装弹窗复用 `Modal`，更新说明使用 `bg-sunken` + 发丝边 |
| v1.18 | 2026-10-22 | 动效始终播放，不再跟随 `prefers-reduced-motion` |
| v1.17 | 2026-10-22 | Agent 过程轨迹：thinking/text/tool 有序 parts；相邻过程组合并为默认收起的过程组；工具步骤状态、耗时与结果预览；思考正文降低一级排版；补充展开/收起规则与无障碍要求 |
| v1.16 | 2026-10-22 | 会话标签状态：运行中 accent 脉冲、错误 danger 图标、待操作 warning 靶心环（占位、无触发）、未读 success 实心点、已读无标记；草稿用标题旁铅笔；补充状态动效与可访问性规则 |
| v1.15 | 2026-10-21 | 多会话：聊天会话标签栏与会话列表抽屉、同工作区并发会话、模型自动标题与手动重命名；标签持久化到工作区 `.pi-workbench/chat-tabs.json` |
| v1.14 | 2026-10-21 | 长列表性能：聊天消息、Diff 行、文件树改为虚拟渲染；Diff 长行横向滚动、行高 22px；Monaco 大文件模式（关闭换行/折叠，超大文件只读）与细线提示 |
| v1.13 | 2026-10-21 | 工作区区域分层：外壳/侧栏/终端用 `bg-panel`，编辑器画布与激活标签用 `bg-surface`，Monaco 背景改为 surface；拖拽接缝改为 2px `--rule-seam`（等效 1px×22%），解决 125% 缩放下两侧线宽不一致 |
| v1.12 | 2026-10-21 | 线条角色化与卡片表面分离：新增 `--rule-control`（控件 50%）/ `--rule-divide`（分隔 22%）/ `--rule-hairline`（卡片外框 18%）三档；纸卡改为 `bg-raised` + 发丝边、取消区内投影，`shadow-print` 只保留给浮层；修正 `--panel` / `--raised` 用途冲突与文首版本号 |
| v1.11 | 2026-10-21 | Monaco / xterm 主题颜色改由 `src/theme/tokens.ts` 从 CSS token 读取；移除“硬编码颜色例外”规则，守卫不再豁免这两个文件 |
| v1.10 | 2026-10-21 | 修复设计系统审查问题：搜索焦点可见、移除未定义 `border-line-strong`、同步 Monaco 行号色；`ui.tsx` 原语全部角色化；新增 overlay token；修正圆角/阴影/Toast 时长；Fleet 使用 `StatusText`、Settings 使用 `KeyCap`；扩展守卫检查颜色、圆角、阴影与动效 |
| v1.9 | 2026-10-21 | 建立代码层组件管理：新增 `.type-*` 语义文字角色、`Label / Value / Caption / DataText / Eyebrow` 原语与 `patterns.tsx` 内容模式；业务组件禁止原始字体声明，新增 `tests/design-system.test.ts` 扫描约束；欢迎页、顶栏、聊天、设置、命令面板、文件树、Fleet、Diff、终端全部迁移 |
| v1.8 | 2026-10-21 | 小字体系改为 Noto Sans + Noto Sans SC；UI 标签与字段值退出 mono，字号提升为 Label 12px / Value 12.5px；路径与数据改用 Geist Mono 11.5px；中文标签取消 uppercase/字距；编辑器与终端同步切换到 Geist Mono |
| v1.7 | 2026-10-21 | 重定义文字层级：`ink-subtle` 退出承载信息，功能性元数据统一 `ink-muted`；Paper muted 压深至 `#615C52`，Ink muted 提亮至 `#A8A093`；Meta 下限 10.5px、路径 10px、阅读正文 14px / 1.85；补充双主题对比度矩阵与自动检查要求 |
| v1.6 | 2026-10-21 | 欢迎页改为双语镜像标题与全量可滚动最近工作区；增加搜索、项目计数与固定快捷操作，右侧改为数据驱动的状态卡片 |
| v1.5 | 2026-10-21 | 设置新增“快捷键”分节，按平台展示快捷键键帽与分组说明 |
| v1.4 | 2026-10-21 | 顶栏与窗口按钮高度收到 45px，通过 `--titlebar-height` 统一控制，按钮保持正方形 |
| v1.3 | 2026-10-21 | 窗口按钮改为 52×52 正方形，图标换成 1.25px 直边直角定制 glyph |
| v1.2 | 2026-10-21 | 窗口外壳升级为方案 B：Windows/Linux 无边框 + 自绘窗口按钮（含 hover/active 与最大化状态），macOS 保留原生红绿灯 |
| v1.1 | 2026-10-21 | 新增无边框窗口/标题栏 overlay 规范（方案 A），Windows 原生窗口按钮与 macOS 红绿灯；主色改为松墨绿，阅读正文改用思源宋体 |
| v1.0 | 2026-10-20 | 建立正式设计规范；确定 Paper & Ink、松墨绿主色、暖橄榄成功、朱砂错误；收录组件 API 与变更流程 |
