# Pi Workbench 设计系统规范

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.5 |
| 状态 | Active（正式规范） |
| 最后更新 | 2026-10-21 |
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
| 纸（Paper） | 界面是纸面，不是面板堆叠 | 暖白底、纸卡、细墨线、错位硬阴影 |
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
| `--panel` | `bg-panel` | `#FBF9F4` | `#1A1815` | 面板、纸卡、编辑器、聊天 |
| `--raised` | `bg-raised` | `#FFFDF8` | `#201D19` | 浮起的纸片、Toast、菜单 |
| `--sunken` | `bg-sunken` | `#EFECE4` | `#221F1B` | 输入框、代码块、终端底 |
| `--hover` | `bg-hover` | `#EEEAE1` | `#2B2722` | hover 背景 |
| `--active` | `bg-active` | `#E8E3D9` | `#342F29` | 选中/按下背景 |
| `--line` | `border-line` | `rgba(23,21,18,.16)` | `rgba(237,231,220,.14)` | 分隔线、边框 |
| `--ink` | `text-ink` | `#171512` | `#EDE7DC` | 主文字 |
| `--ink-muted` | `text-ink-muted` | `#6D675C` | `#9C9487` | 次级文字 |
| `--ink-subtle` | `text-ink-subtle` | `#918A7D` | `#736C60` | 路径、时间等元数据 |
| `--accent` | `bg-accent` / `text-accent` / `border-accent` | `#2F5D4E` | `#8FC7B4` | 品牌强调、链接、选中、焦点、主按钮、印章 |
| `--accent-hover` | `bg-accent-hover` | `#24493D` | `#A9D8C8` | 强调色 hover |
| `--accent-fg` | `text-accent-fg` | `#FBFAF4` | `#141311` | 强调色上的文字 |
| `--success` | `text-success` / `bg-success` | `#5E6B2E` | `#A8BF7A` | 成功、Diff 新增、通过状态 |
| `--warning` | `text-warning` / `bg-warning` | `#9A5B1F` | `#D6B26E` | 警告、等待状态 |
| `--danger` | `text-danger` / `bg-danger` | `#A83A22` | `#E06A4A` | 错误、删除、冲突 |

**透明度用法**：选中/淡洗使用颜色 token 的透明度修饰符，例如 `bg-accent/[0.06]`、`bg-success/10`、`bg-danger/10`。

### 2.2 对比度基线

| 组合 | 对比度 | 结论 |
|---|---|---|
| `ink` / `surface` | 16.15:1 | AAA |
| `ink-muted` / `surface` | 4.97:1 | AA |
| `ink-subtle` / `surface` | 3.03:1 | 仅限元数据 |
| `accent` / `surface` | 6.66:1 | AA |
| `accent-fg` / `accent` | 7.18:1 | AAA |
| `success` / `surface` | 5.14:1 | AA |
| `warning` / `surface` | 4.79:1 | AA |
| `danger` / `surface` | 5.65:1 | AA |
| `accent` / Ink `surface` | 9.72:1 | AAA |

**规则**：正文、链接、按钮文字必须 ≥4.5:1；`ink-subtle` 只允许用于非关键元数据；任何新颜色组合在合并前必须实测。

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
| `--font-ui` | 默认 `font-sans` | Inter Variable → PingFang SC → Microsoft YaHei → system-ui | 控件、文件树、按钮、界面文字 |
| `--font-mono` | `font-mono` | IBM Plex Mono → Cascadia Code → Consolas | 路径、时间、状态、代码标签 |

**使用边界**：

- 衬线（display / reading）用于 ≥14px 的标题和阅读段落；
- 操作界面（按钮、输入框、文件树、状态栏、标签）保持 Inter / mono，避免小字号宋体发虚；
- 中文标题必须落到思源宋体，不允许回退成系统黑体作为主要视觉。

### 3.2 字号体系

| 角色 | 字号 / 行高 | 字体 | 用法 |
|---|---|---|---|
| Display | 37px / 1.18 | display | 欢迎页主标题（双行） |
| H1 | 28px / 1.2 | display | 弹窗标题、空状态标题 |
| H2 | 20px / 1.3 | display | 分区标题、项目名 |
| Reading | 14px / 1.85 | reading | 欢迎页导语、Agent 回复、设置说明 |
| Body | 13px / 1.6 | ui | 控件、文件树、按钮 |
| Meta | 10.5px / 1.5，大写 + 0.14em 字距 | mono | 眉题、角色标签、状态 |
| Code | 12.5px / 1.65 | mono | 编辑器、代码块 |

### 3.3 排版规则

- 中文正文不要手动加字距；只有 mono 眉题使用大写和字距。
- 标题使用 display 字体，正文中的 `em` 强调使用 `text-accent` 斜体。
- 长文本优先使用 `font-reading`，不要用 Inter 排大段中文。
- 代码、路径、时间、ID、快捷键使用 mono，并保持等宽数字。

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

- 常规边框统一 1px `border-line`。
- 不使用大圆角卡片（>6px）；不允许胶囊形按钮（圆形图标按钮除外）。

### 4.3 阴影

- 纸卡使用错位硬阴影：`shadow-print`（Paper：`5px 6px 0 rgba(23,21,18,.08)`；Ink：更深的黑色）。
- 普通面板、按钮、输入框**不使用阴影**；层级通过纸面/墨线/背景差异表达。
- 禁止柔光、发光、玻璃拟态。

### 4.4 动效

- 时长 120–200ms，`ease-out`；仅用于颜色、透明度、位移、下划线展开。
- 按钮按下位移 1px；不做缩放动画。
- 支持 `prefers-reduced-motion: reduce`，此时关闭位移与平滑滚动。
- 焦点态：1px `accent` 描边 + 2px offset；不要使用蓝色 ring。

---

## 5. 基础组件 API

所有基础组件位于 `src/components/ui.tsx`。新界面必须优先复用；不要在业务组件里重新实现按钮、输入框或弹窗。

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
- 背景 `bg-sunken`，1px `border-line`，2px 圆角。
- focus：边框转 `accent`，不额外加 ring。
- placeholder：`text-ink-subtle`；禁用态 50% 透明度。

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

**规则**：遮罩使用 `bg-black/35`；纸卡使用 `border-line bg-panel shadow-print`；标题 `font-display`；关闭按钮使用 IconButton。

### 5.8 Spinner

- `Loader2` + `animate-spin`；用于加载/思考态，不额外加文字时也必须保留可读上下文。

---

## 6. 页面与交互模式

### 6.1 应用外壳

- 顶栏 45px：衬线字标 `Pi` + mono `WORKBENCH` + 工作区路径；右侧文字操作（命令面板、Fleet、终端、设置）与主操作按钮。
- 工作区标签栏 34px：矩形 mono 标签，激活项纸面底 + 2px `accent` 顶线。
- 主区域三栏：文件树 232px / 编辑器自适应 / 聊天 336px；可拖拽、可折叠，默认宽度见上。
- 状态栏 28px：mono 文本，左侧品牌/本地优先/Agent 状态，右侧语言、编码、主题。

### 6.2 欢迎页

- 编辑式双栏：左侧眉题 + 37px 衬线双行标题 + 导语 + 全量最近工作区（内部滚动）；右侧 Agent 状态、最近项目、Fleet 摘要、开始使用 + 印章。
- 眉题与标题互为镜像：中文界面眉题为英文 mono 大写，标题中文；英文界面眉题为中文 reading 小字，标题英文。标题重音使用 `accent` 松绿。
- 最近工作区默认展示全部，标题旁显示“共 N 个项目”；搜索框过滤全部项目；列表在固定区域内滚动，滚动条常驻，快捷操作固定在列表底部，页面本身不滚动。
- 快捷操作只保留可执行项：打开文件夹、刷新最近项目、设置。
- 标题重音、打开箭头、印章全部使用 `accent`；印章使用 1.5px 绿边 + 斜置。
- 欢迎页不再提供页内提问框；提问在打开工作区后由聊天面板完成，避免与“打开项目”流程重复。
- 最近工作区为空时显示文本入口；无匹配结果时显示“没有匹配的项目”。

### 6.3 编辑器

- Monaco 主题固定为 `pi-paper` / `pi-ink`，随 `resolvedTheme` 切换。
- 字体 IBM Plex Mono 13.5px / 22px 行高；关闭 minimap；行号弱化。
- 光标、选区、当前行使用松绿（Paper `#2F5D4E` / Ink `#8FC7B4`）；语法色使用第 2.3 节内容色。
- 标签页：矩形、mono 10.5px、激活项纸面底 + 2px 绿顶线；未保存用 6px 绿点。

### 6.4 文件树

- 名称 Inter 12.5px；目录/文件使用 lucide 线性图标。
- 激活行：2px `accent` 左边线 + `bg-accent/[0.06]`；不要整块饱和高亮。
- 右键菜单：纸卡 + `shadow-print`；重命名/删除使用文字 + 图标。

### 6.5 聊天（稿纸）

- 不使用气泡；每条消息以 mono 大写角色标签 + 时间开头，消息之间用 1px 墨线分隔。
- 用户消息以绿色 `›` 起头；正文 `font-reading` 14px / 1.85。
- Agent 回复使用 Markdown：标题用 display 字体，正文 reading，代码块 mono；代码块左侧 2px 绿色线，允许换行。
- 代码块右上角提供复制按钮（hover/focus 显示）。
- 空状态、未配置 API、错误使用 EmptyState / 细线错误条，不使用大色块。

### 6.6 终端

- 浅色纸面终端（Paper）/ 深色纸面（Ink）；xterm 背景与面板一致。
- 光标与选区使用松绿；工具条为 mono 小字，不使用胶囊按钮。

### 6.7 设置 / 命令面板 / Diff / Fleet / Toast

- 设置：纸片弹窗 + 左侧分节导航（通用 / API 配置 / 快捷键 / 关于）；分节标签 mono 10px；字段使用 Field + Input/Select；主按钮绿色。
  - 快捷键分节：动作名使用 Inter 12px，键帽使用 mono 10px + 1px `border-line` + `bg-sunken`，用 `<kbd>` 语义；按平台显示 `Ctrl` 或 `⌘`。
  - 分组：全局 / 编辑器（打开文件时）/ 聊天（工作区内）/ 浮层；仅列出实际生效的快捷键。
- 命令面板：560px 纸片、mono 搜索、编号结果列表、选中项 2px 绿色左边线；Esc 关闭。
- Diff：纸面审阅单；新增用 `success/10` 橄榄淡洗，删除用 `danger/10` 朱砂淡洗；统计用印章式 mono 标签。
- Fleet：编号任务清单；状态使用 mono 文案 + 语义色（RUNNING 绿、DONE 橄榄、QUEUED 弱化、FAILED 红），不使用彩色胶囊。
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
- 尊重 `prefers-reduced-motion`。

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

### 9.2 新 UI 工作检查清单

- [ ] 只使用设计 token 与 `ui.tsx` 基础组件。
- [ ] Paper / Ink 两套截图均检查。
- [ ] 正文与链接对比度 ≥4.5:1。
- [ ] 键盘可访问，焦点可见，图标按钮有名称。
- [ ] 1024 / 1440 宽度无横向溢出。
- [ ] 空状态、加载态、错误态完整。
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
| 主题状态 | `src/store/themeStore.ts` |
| 欢迎页 | `src/components/WelcomeScreen.tsx` |
| 聊天稿纸 | `src/components/ChatPanel.tsx` |
| 编辑器主题 | `src/components/MonacoEditor.tsx`（`pi-paper` / `pi-ink`） |
| 终端主题 | `src/components/TerminalPanel.tsx` |
| 窗口外壳 / 标题栏 | `electron/main.ts`、`electron/preload.cts` |
| 自绘窗口按钮 | `src/components/WindowControls.tsx` |
| 拖拽区工具类 | `src/index.css`（`.app-drag` / `.app-no-drag`） |
| 字体入口 | `src/main.tsx` |
| 主题默认值 | `electron/main.ts`（`DEFAULT_SETTINGS.theme`） |
| 视觉历史 | [PAPER_INK.md](./PAPER_INK.md) |

**实现约定**：

- 组件保持扁平结构，不新增 `components/xxx` 子目录。
- 新组件优先组合 `ui.tsx`，不复制样式字符串。
- 样式类只使用本文件列出的 token 与 Tailwind 工具类。
- 新增 token 必须同时更新 `index.css`、`tailwind.config.js` 和本文档。

---

## 12. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.6 | 2026-10-21 | 欢迎页改为双语镜像标题与全量可滚动最近工作区；增加搜索、项目计数与固定快捷操作，右侧改为数据驱动的状态卡片 |
| v1.5 | 2026-10-21 | 设置新增“快捷键”分节，按平台展示快捷键键帽与分组说明 |
| v1.4 | 2026-10-21 | 顶栏与窗口按钮高度收到 45px，通过 `--titlebar-height` 统一控制，按钮保持正方形 |
| v1.3 | 2026-10-21 | 窗口按钮改为 52×52 正方形，图标换成 1.25px 直边直角定制 glyph |
| v1.2 | 2026-10-21 | 窗口外壳升级为方案 B：Windows/Linux 无边框 + 自绘窗口按钮（含 hover/active 与最大化状态），macOS 保留原生红绿灯 |
| v1.1 | 2026-10-21 | 新增无边框窗口/标题栏 overlay 规范（方案 A），Windows 原生窗口按钮与 macOS 红绿灯；主色改为松墨绿，阅读正文改用思源宋体 |
| v1.0 | 2026-10-20 | 建立正式设计规范；确定 Paper & Ink、松墨绿主色、暖橄榄成功、朱砂错误；收录组件 API 与变更流程 |
