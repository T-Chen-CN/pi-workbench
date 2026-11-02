# 对外文案（仓库门面 / Release 说明 / README）

> **面向**：要改 GitHub 仓库介绍、发版说明或 README 的人与 agent。
> **什么时候读**：发布新版本、改仓库 About / Topics、改写 README 之前。
> **什么时候要改**：定位变化、发版流程变化、README 结构调整时。

对外文案的定位以 [PROJECT_PLAN §一](../PROJECT_PLAN.md) 为准：**本地优先的 Agent 原生开发工作台**。不要用「Cursor 类」「Copilot 替代」这类类比当卖点，写具体差异：Agent 在权限模式内改真实文件、会话绑定工作树、面板可拆窗、PDF / Office 可读。

---

## 1. 仓库门面

改这三项只能通过 GitHub 平台（或 `gh`），不在仓库文件里：

| 项 | 要求 |
| --- | --- |
| **Description** | 一行，讲清「是什么 + 与同类不同的地方」，英文，≤ 200 字符 |
| **Topics** | 8–12 个，覆盖 `ai` / `coding-agent` / `electron` / `monaco-editor` 等技术词，这是唯一的自然搜索入口 |
| **Website** | 指向 `releases/latest`，让读者一眼能下载 |
| **Social preview** | 1280×640，Paper 主题主界面截图 + 品牌印章，不要用默认灰卡 |

现用 Description（可直接替换）：

```
Local-first desktop workbench where a real coding agent works beside a Monaco editor — permission modes, session worktrees, plan mode, detachable panels. Electron + React + TypeScript.
```

Topics：

```
ai  coding-agent  developer-tools  desktop-app  electron  editor  git-worktree  local-first  monaco-editor  react  typescript
```

`gh` 命令（需要已登录且有仓库权限，**执行前确认**）：

```bash
gh repo edit T-Chen-CN/pi-workbench \
  --description "Local-first desktop workbench where a real coding agent works beside a Monaco editor — permission modes, session worktrees, plan mode, detachable panels. Electron + React + TypeScript." \
  --homepage "https://github.com/T-Chen-CN/pi-workbench/releases/latest" \
  --add-topic ai --add-topic coding-agent --add-topic developer-tools \
  --add-topic desktop-app --add-topic electron --add-topic editor \
  --add-topic git-worktree --add-topic local-first --add-topic monaco-editor \
  --add-topic react --add-topic typescript
```

---

## 2. Release 说明

### 结构（固定五段，缺一不可）

```markdown
<一句话：这版最值得升级的那件事>

## Highlights
- **<能力名>** — <做了什么>；<用户能感知的结果>。

## Downloads
| Platform | Asset |
| --- | --- |
| Windows | `Pi-Workbench-Setup-<version>.exe` |
| macOS | `Pi-Workbench-<version>-universal.dmg` |
| Linux | `Pi-Workbench-<version>.AppImage` |

## Upgrade notes
<从上一版升级需要做什么；不需要就写「自动更新即可，无需手工操作」>

## Known issues
<未签名 / 未公证、暂不支持的格式、平台差异；没有就删掉这一节>

**Full Changelog**: https://github.com/T-Chen-CN/pi-workbench/compare/<prev>...<version>
```

### 写作规则

- **不写内部语汇**：Phase、BACKLOG 编号、IPC 频道名、用例数量以外的实现细节，都留在 `docs/`。用例数可以留一句「1,200+ tests green」。
- **每条 Highlight 落到用户能看见的结果**，不写「重构了 X」「拆分了 Y」。
- **必须写清楚升级方式**，Windows 自动更新只替换程序文件、保留 `config/ data/ logs/ cache/`。
- **Known issues 诚实写**：未签名未公证、`.doc/.xls/.ppt` 旧格式只给另存为指引、扫描件不做 OCR。
- 资产名由 `package.json` 的 `artifactName` 决定，改名时同步本节。

### v0.7.5 成品（可直接粘贴覆盖现有说明）

```markdown
附件只给路径、PDF / Office 可读、退出可靠性重做 —— 这一版把「Agent 能不能真的读到你的文档」和「关掉它能不能干净退出」两件事做完了。

## Highlights

- **附件改为只给路径，任意位置任意格式** — 单条消息最多 10 个附件，工作区外的文件也能选；路径与元信息进上下文，由 Agent 用自己的工具去读，渲染层仍然没有「任意路径读内容」的能力。
- **PDF / Word / Excel / PowerPoint / OpenDocument / EPUB 可读** — 按魔数分流解析（`.pdf` 里是文本就交回内置 `read`，`.docx` 里是 OLE 就给另存为指引），零新增依赖；没有文本层的扫描件走视觉通道。Office 文档另有编辑器内只读预览。
- **退出可靠性重做** — 清理链逐步超时 + 双看门狗，子进程按进程树回收；单实例锁被拒时落日志并弹原生提示，不再出现「双击没反应」。
- **用户消息回显引用与附件** — 划词引用、附加文件、纯引用消息都在气泡里如实显示，编辑重发与运行中插话不再丢引用。
- **独立面板窗口关闭修复** — 关闭拆出的面板不再报 `Object has been destroyed`，面板可靠回位。
- **模型静默超时 120s → 180s** — 长思考不再被误判卡死。

## Downloads

| Platform | Asset |
| --- | --- |
| Windows | `Pi-Workbench-Setup-0.7.5.exe` |
| macOS | `Pi-Workbench-0.7.5-universal.dmg` |
| Linux | `Pi-Workbench-0.7.5.AppImage` |

## Upgrade notes

0.7.4 及更早版本可直接通过应用内更新升级：Windows / Linux 后台下载、点确认后安装，数据目录不受影响；macOS 请下载 dmg 覆盖安装。

## Known issues

- 构建未做代码签名与公证，首次启动需在 SmartScreen / Gatekeeper 中确认一次。
- 旧格式 `.doc / .xls / .ppt / .wps` 不解析，只返回「另存为 .docx / .xlsx / .pptx」指引；扫描件不做 OCR。

**Full Changelog**: https://github.com/T-Chen-CN/pi-workbench/compare/v0.7.4...v0.7.5
```

粘贴方式（**执行前确认**）：`gh release edit v0.7.5 --notes-file <上面这段存成的文件>`。

### 仍未接入

`.github/workflows/release.yml` 目前用 `gh release create --generate-notes`，说明只有自动生成的 Full Changelog。要自动化成上面的结构，需要改该 workflow（属于 `.github/workflows` 变更，按 [AGENTS §3](../../AGENTS.md) 需先确认）：改为从 `.github/release-notes/<tag>.md` 取正文，取不到时回退 `--generate-notes`。

---

## 3. README 结构

**中文优先**：`README.md` 是中文（GitHub 首屏显示它），英文对等版在 `README.en.md`，两份首屏都有一行 `简体中文 · English` 互链。两份**必须同结构、同信息量**，不能英文版缩水。节序固定：

1. **banner**（`<picture>` 双主题）+ **标题 + 一句话定位 + 徽章**（CI / 最新版本 / 许可证 / 平台 / Node）+ 语言切换行
2. **目录** —— 10 条锚点
3. **特性一览** —— 五组，每组「一句导语 + 一个截图位 + 3–4 条 bullet」：Agent / 文档 / Git 与工作树 / 工作台 / 本地优先
4. **下载** —— 三平台资产表 + 未签名说明 + 更新策略。桌面应用的第一诉求，不要埋在最后
5. **开始使用** —— A 下载即用 / B 从源码运行 / C 自己打包，三条路并列
6. **配置** —— 供应商 → 地址 → Key → 拉模型 → 联网搜索（五步编号）
7. **开发情况** —— 版本 / 发布 / 阶段 / 质量 / 依赖 / 已知边界 / 接下来，表格化
8. **工作原理** —— 进程模型简图，点明 Agent 在主进程内
9. **项目结构** —— 五个目录一行说明 + 指向 `PROJECT_STRUCTURE`
10. **参与贡献** —— 报问题 / 提 PR / 翻译 / 写插件
11. **文档** —— 只留对外有用的 6–8 条，全量索引指向 `docs/README.md`
12. **许可证** + 另一语言 README 互链

### 视觉资产

全部在 `docs/assets/`。**banner 已产出**；截图位目前是空的 HTML 注释占位（不渲染、不产生断链）：

| 文件 | 状态 | 内容 |
| --- | --- | --- |
| `banner-light.svg` / `banner-dark.svg` | 已产出 | 1280×320，Paper / Ink 双主题，`<picture>` + `prefers-color-scheme` 切换 |
| `shot-agent.png` | 待补 | Ink 主题：工具轨迹展开 + 内联变更卡 + 审批卡 |
| `shot-docs.png` | 待补 | Paper 主题：Office / PDF 只读预览 + 附件 chip |
| `shot-worktree.png` | 待补 | Ink 主题：工作树 chip + Git 提交图 |
| `shot-panel.png` | 待补 | Ink 主题：主窗口 + 拆出的面板窗口 |

截图规格：宽 1800px（2x）、单张 ≤ 400KB、总量 ≤ 2MB；不含真实 API Key 与个人目录名。补图时把对应 `<!-- 截图位：… -->` 注释换成指向 `docs/assets/shot-xxx.png` 的图片引用（带 alt）。

banner 的色值 / 字体 / 字号只允许取自 [DESIGN_SYSTEM](../design/DESIGN_SYSTEM.md) §2.1 与 §3.1–§3.4，印面复用 `BrandSeal` 的同一份 π 路径，印面底边与副标基线对齐。

---

## 4. 维护清单

发版时按顺序勾：

- [ ] banner 右侧的 `vX.Y.Z`（`banner-light.svg` / `banner-dark.svg` 各一处）；徽章自动，正文不再手写版本号
- [ ] `README.md` 与 `README.en.md` 的节序、节数一致（改一边必须改另一边）
- [ ] Highlights 与 STATUS.md 的最新条目一致，不写未交付的能力
- [ ] 「开发情况」表的版本 / 发布数 / 用例数 / 已知边界与 STATUS 对齐
- [ ] Release 说明按 §2 结构写，含 Downloads 与 Known issues
- [ ] 仓库 About / Topics / Website 未过期
- [ ] 截图与界面不一致时重截（改版后至少重截 Agent 与工作台两张）
