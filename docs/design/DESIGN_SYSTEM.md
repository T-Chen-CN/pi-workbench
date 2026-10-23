# Pi Workbench 设计系统规范

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.19 |
| 状态 | Active（正式规范） |
| 最后更新 | 2026-10-23 |
| 适用范围 | 渲染进程全部 UI、Monaco / xterm 主题、应用主题设置 |
| 唯一事实来源 | 本文件。所有前端设计相关实现以此为准 |
| 历史方案 | [PAPER_INK.md](./PAPER_INK.md)（方案、决策与实施记录） |

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
| `--surface` | `bg-surface` | `#F4F1EA` | `#141311` | 应用画布、顶栏、状态栏 |
| `--panel` | `bg-panel` | `#FBF9F4` | `#1A1815` | 面板、编辑器、聊天 |
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
- 保持原生键盘行为；不要用自定义下拉替代，除非设计规范更新。

### 5.5 Field

| Prop | 类型 | 说明 |
|---|---|---|
| `label` | `string` | mono 10px 大写 + 0.14em 字距 |
| `hint` | `string?` | 右侧 mono 10px 次要说明 |
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

**规则**：遮罩使用 `bg-black/35`；浮层纸卡使用 `border-line bg-raised shadow-print`，标题栏与底栏分隔使用 `border-rule-divide`；标题 `font-display`；关闭按钮使用 IconButton。

### 5.8 Spinner

- `Loader2` + `animate-spin`；用于加载/思考态，不额外加文字时也必须保留可读上下文。

### 5.9 语义文字与内容模式（强制）

**问题背景**：设计 token 只能管理颜色和字体族；如果页面直接写字号、字重和 `font-*`，一次设计调整仍然要扫所有页面。因此本项目把“内容类型 → 设计组件”做成代码层契约。

**语义文字角色**（定义在 `src/index.css`，只允许在 `ui.tsx` / `patterns.tsx` 中使用原始字体声明）：

| 角色 | 用途 | 不允许 |
|---|---|---|
| `type-eyebrow` | 纯 Latin 眉题 | 中文、混合标签 |
| `type-wordmark` | 品牌副标 `WORKBENCH` | 正文、标签 |
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

**页面组合规则**：

- 业务组件只组合上述模式与 `ui.tsx` 原语；不直接写 `font-*`、`text-[Npx]`、`uppercase`、`tracking-[...]`、`leading-[...]`。
- 例外只能落在 `ui.tsx` / `patterns.tsx`，或者新增一个命名变体；不允许页面级一次性样式。
- `tests/design-system.test.ts` 会扫描 `src/**/*.tsx`，发现业务组件中的原始字体声明直接失败。
- 新增内容类型时，先在 `patterns.tsx` 定义组件/变体，再写页面；不要直接写页面样式。

---

## 6. 页面与交互模式

### 6.1 应用外壳

- 顶栏 45px：衬线字标 `Pi` + mono `WORKBENCH` + 工作区路径；右侧文字操作（命令面板、Fleet、终端、设置）与主操作按钮。
- 工作区标签栏 34px：矩形 mono 标签，激活项纸面底 + 2px `accent` 顶线。
- 主区域三栏：文件树 232px / 编辑器自适应 / 聊天 336px；可拖拽、可折叠，默认宽度见上。
- **区域分层**：顶栏、工作区标签栏、状态栏、文件树、聊天与终端使用 `bg-panel`；编辑器画布与激活标签页使用 `bg-surface`（更深的"墨池"）；纸卡使用 `bg-raised`。区域先靠底色区分，接缝只做收口。
- 可拖拽分隔条：2px `bg-rule-seam`，hover / 拖拽时转 `accent`；不要用满墨 `bg-line` 或 1px 线画分栏接缝。
- 状态栏 28px：mono 文本，左侧品牌/本地优先/Agent 状态，右侧版本号、更新状态、语言、编码、主题。版本号可点击进入设置“关于”；有新版本时在版本号旁显示文字提示，下载中显示 `Meter` 进度，不使用弹跳或彩色胶囊。

### 6.2 欢迎页

- 编辑式双栏：左侧眉题 + 37px 衬线双行标题 + 14px / 1.85 导语 + 全量最近工作区（内部滚动）；右侧 Agent 状态、最近项目、Fleet 摘要、开始使用 + 印章。
- 右侧状态卡片使用 `Card`（`bg-raised` + 发丝边，无投影）；卡头标题 `text-ink`，卡头下沿与列表行为 `rule-divide`。
- 眉题与标题互为镜像：中文界面眉题为英文 mono 大写，标题中文；英文界面眉题为中文 reading 小字，标题英文。标题重音使用 `accent` 松绿。
- 最近工作区默认展示全部，标题旁显示“共 N 个项目”；搜索框过滤全部项目；列表在固定区域内滚动，滚动条常驻，快捷操作固定在列表底部，页面本身不滚动。
- 所有功能性次级文字——分区标题、项目计数、字段标签、空状态、Fleet 状态、快捷操作——使用 `ink-muted` 与 UI sans；标签 12px / 500、字段值 12.5px / 400；路径使用 mono 11.5px。`ink-subtle` 只用于装饰和禁用态。
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

### 6.4 文件树

- 名称 Noto Sans / Noto Sans SC 12.5px；目录/文件使用 lucide 线性图标。
- 激活行：2px `accent` 左边线 + `bg-accent/[0.06]`；不要整块饱和高亮。
- 右键菜单：纸卡 + `shadow-print`；重命名/删除使用文字 + 图标。

### 6.5 聊天（稿纸）

- 不使用气泡；每条消息以 UI sans 11.5px 角色标签 + 时间开头，消息之间用 1px `rule-divide` 分隔。
- 用户消息以绿色 `›` 起头；正文 `font-reading` 14px / 1.85。
- Agent 回复使用 Markdown：标题用 display 字体，正文 reading，代码块 mono；代码块左侧 2px 绿色线，允许换行。
- 代码块右上角提供复制按钮（hover/focus 显示）。
- 空状态、未配置 API、错误使用 EmptyState / 细线错误条，不使用大色块。
- 上下文附件支持整文件与选区片段：片段 chip 显示 `文件:起止行`，内容是附加时快照（≤40k 字符）；整文件在发送时读取（≤120k 字符，合计 ≤300k）。
- 会话标签栏（34px，位于聊天头部下方）：标签代表"已打开"会话，激活标签 `bg-surface` + 2px `accent` 顶线；最多同时打开 8 个，关闭标签只释放运行时、保留会话文件。
- 标签状态按优先级只显示一个标记：**运行中**（`accent` 实心点 + 1.4s 脉冲）> **错误**（`danger` 感叹号图标；保留到下次发送或成功回复）> **待操作**（`warning` 空心环 + 中心点 + 2px 硬边外环，2.4s 呼吸；工具审批等待时触发）> **未读**（`success` 实心点，静态；激活标签时清除）> **已读**（无标记）。
- 草稿是独立标记：标题旁 9px `Pencil` 图标（`ink-subtle`），可与任意主状态并存，不占状态槽。
- 标签的 `title` / `aria-label` 必须包含状态与草稿文案，运行中同时设置 `aria-busy`；状态不能只靠颜色或动效传达。
- 会话列表：聊天列内的全高抽屉，行显示标题、消息数、相对时间与"已打开"标记；当前会话用 2px `accent` 左边线 + `accent/[0.06]`；hover 显示置顶 / 归档 / 导出 / 重命名 / 删除。顶部为 `SearchField` 与“显示已归档”开关；置顶会话排在前面并带 10px `accent` Pin，归档会话显示“已归档”标记且默认隐藏。
- 会话标题：首轮回复后由模型生成一次（中文 ≤16 字 / 英文 ≤8 词），存为 `session_info`；手动重命名后不再自动覆盖；无标题时回退首条用户消息。
- 过程轨迹：助手消息内的 thinking / text / tool 按发生顺序排列；相邻 thinking/tool 合并为一个**默认收起**的过程组。组标题实时显示“思考中… / 运行命令…”或完成摘要“过程 · 思考 N 秒 · N 个工具”；用户手动展开后保持展开，不随正文开始或轮次结束自动改变。
- 过程组触发器：`type-label` + `text-ink-muted`，chevron 14px，运行中状态点为 `accent` 1.4s 脉冲；内容左侧 `rule-hairline` 发丝线 + 12px 缩进，不使用卡片、阴影或渐变。
- 思考正文：`.chat-markdown.agent-trace-markdown`（reading 13px / 1.7）+ `text-ink-muted`，Markdown 渲染但流式期间关闭代码高亮。
- 工具行：状态图标（`accent` spinner / `success` Check / `danger` AlertCircle）+ `type-label` 工具名 + `type-data` 目标 + `type-caption` 耗时；展开后的参数与结果使用 `type-data`，结果块使用 `bg-sunken` + `rule-hairline`，最大高度约 240px 内部滚动；执行中结果预览随 `tool_update` 实时刷新；write/edit 有对应 Diff 时提供“查看修改”。
- 过程组收起时不挂载内容 DOM；触发器使用 `aria-expanded` / `aria-controls`，运行中的内容加 `aria-busy`；失败与状态必须有文字，不能只靠颜色或动效传达。
- 工具审批卡：位于输入框上方，`bg-raised` + `border-rule-hairline`，不设阴影。标题行 `warning` ShieldAlert + `type-label`；工具与参数摘要用 `type-value`，类别与路径用 `type-caption` / `type-data`。命令与写入预览放在 `bg-sunken` + `rule-hairline` 的 mono 块中（命令 ≤400 字符、预览 ≤280 字符），不展示完整文件内容。底部按钮依次为允许一次（primary）/ 本会话允许（secondary）/ 始终允许（ghost）/ 拒绝（danger，右对齐）；拒绝进入二次确认并可选填原因。
- Plan / Act 切换：输入区左下角两段式控件（`type-caption`，激活 `bg-active text-ink`，无圆角胶囊）；Plan 模式只读，助手回复后输入框上方出现执行条（`bg-raised` + 发丝边 + `type-caption` 提示 + primary 按钮“执行计划”）。
- 待发送消息：输入框上方的发丝边纸卡列表，`type-caption` 行为标签（排队 / 插话，运行中可点击切换）+ `type-value` 单行截断正文 + 移除按钮；空闲时额外显示发送按钮。运行中右下角同时出现“排队 / 插话”切换与停止按钮，发送按钮始终可用。
- 上下文占用：输入区上方的 1px 细条（`Meter`，`tone` 随占用切换 accent / warning / danger）+ `type-data` 计数「42% · 40k / 96k」+ `type-caption` 文本按钮“压缩上下文”；细条不使用发光或渐变。
- 检查点菜单：聊天头部 `RotateCcw` 图标按钮打开的浮层（`bg-raised` + 满墨边 + `shadow-print`，宽 320px）；每行显示时间（`type-value`）与“修改 N 个文件”（`type-caption`），操作按钮为发丝边文本按钮（恢复代码 / 恢复对话 / 两者都恢复），底部一句说明命令副作用不可回退。
- 消息操作：悬停或键盘聚焦时在消息头部右侧显示 14px 图标按钮（复制 / 重新生成 / 编辑），默认 `opacity-0`，`group-hover` 与 `focus-within` 时显现；只对最后一条助手回复和最后一条用户消息提供重复生成与编辑入口。
- 模型与思考：输入区上方一行两个紧凑 `Select`（模型 176px / 思考 112px，高度 24px），值来自会话级设置；切换失败时回滚并 Toast。
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

### 6.7 设置 / 命令面板 / Diff / Fleet / Toast

- 设置：纸片弹窗 + 左侧分节导航（通用 / API 配置 / 快捷键 / 关于）；分节标签 sans 12px / 500；字段使用 Field + Input/Select；主按钮绿色。
  - 快捷键分节：动作名使用 sans 12.5px，键帽使用 mono 10.5px + 1px `border-rule-control` + `bg-sunken`，用 `<kbd>` 语义；按平台显示 `Ctrl` 或 `⌘`。
  - 分组：全局 / 编辑器（打开文件时）/ 聊天（工作区内）/ 浮层；仅列出实际生效的快捷键。
- 命令面板：560px 纸片、sans 搜索、编号结果列表、选中项 2px 绿色左边线；Esc 关闭。
- Diff：纸面审阅单；新增用 `success/10` 橄榄淡洗，删除用 `danger/10` 朱砂淡洗；统计与行号使用 mono，说明文字使用 sans。长行横向滚动、行高固定 22px；大 Diff 使用虚拟渲染。
- Fleet：编号任务清单；状态使用 sans 11.5px 文案 + 语义色（运行中绿、成功橄榄、排队弱化、失败红），不使用彩色胶囊。
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

---

## 7. 可访问性

- 正文、链接、按钮文字 ≥4.5:1；`ink-subtle` 仅用于元数据。
- 所有交互元素有可见焦点：1px `accent` 描边 + 2px offset。
- 图标按钮必须有 `aria-label`；装饰性图标 `aria-hidden`。
- 弹窗使用 `role="dialog"` + `aria-modal="true"`；Esc 关闭；设置/命令面板/Fleet/Diff 一致。
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
- [ ] 区域分层正确：外壳/侧栏 `panel`，编辑器与激活标签 `surface`；接缝为 2px `bg-rule-seam`。
- [ ] 满墨 `border-line` 只出现在浮层（Modal、菜单、命令面板、Toast）上。
- [ ] `tests/design-system.test.ts` 通过。
- [ ] placeholder 使用 `ink-muted`。
- [ ] 键盘可访问，焦点可见，图标按钮有名称。
- [ ] 1024 / 1440 宽度无横向溢出。
- [ ] 空状态、加载态、错误态完整。
- [ ] 对比度自动检查通过。
- [ ] `npm run type-check`、`npm run lint`、`npm test` 通过。
- [ ] 如引入新设计元素，已更新本文档并获得确认。

---

## 10. 设计变更流程

任何超出本规范的设计改动，按以下顺序执行：

1. **提案**：说明变更动机、影响范围、替代方案。
2. **更新规范**：修改本文件（必要时更新 `PAPER_INK.md` 历史记录）。
3. **确认**：获得项目所有者明确确认；未确认不得进入实现。
4. **实现**：只通过 token / `ui.tsx` / 现有模式落地；不引入临时样式。
5. **验证**：双主题截图、对比度、窄窗口、键盘、测试与构建。
6. **记录**：在“变更记录”中写明版本、日期、变更内容。

> 未经文档化的设计例外视为技术债，需在下一个迭代补回规范或移除。

---

## 11. 代码索引与实现约定

| 内容 | 位置 |
|---|---|
| 颜色 / 字体 / 全局样式 | `src/index.css` |
| Token 到 Tailwind 的映射 | `tailwind.config.js` |
| 基础组件 | `src/components/ui.tsx` |
| 内容模式组件 | `src/components/patterns.tsx` |
| 语义文字角色 | `src/index.css`（`.type-*`） |
| 线条角色 token | `src/index.css`（`--rule-*`）、`tailwind.config.js`（`border-rule-*`） |
| 设计系统约束测试 | `tests/design-system.test.ts` |
| 主题状态 | `src/store/themeStore.ts` |
| 欢迎页 | `src/components/WelcomeScreen.tsx` |
| 聊天稿纸 | `src/components/ChatPanel.tsx` |
| 会话标签栏 / 列表 | `src/components/SessionTabs.tsx`、`src/components/ChatSessionList.tsx`、`src/store/sessionStore.ts` |
| 编辑器主题 | `src/components/MonacoEditor.tsx`（`pi-paper` / `pi-ink`） |
| 终端主题 | `src/components/TerminalPanel.tsx` |
| 第三方主题 token 桥 | `src/theme/tokens.ts`（`readThemeTokens` / `tokenHex`） |
| 窗口外壳 / 标题栏 | `electron/main.ts`、`electron/preload.cts` |
| 自绘窗口按钮 | `src/components/WindowControls.tsx` |
| 拖拽区工具类 | `src/index.css`（`.app-drag` / `.app-no-drag`） |
| 字体入口 | `src/main.tsx` |
| 主题默认值 | `electron/main.ts`（`DEFAULT_SETTINGS.theme`） |
| 视觉历史 | [PAPER_INK.md](./PAPER_INK.md) |

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
