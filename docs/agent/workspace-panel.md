# 工作区面板（编辑区默认视图）

> **面向**：改「面板」的人 —— 标签条入口、画布交互、上浮链、落盘状态、测试
> **什么时候读**：动 `src/components/WorkspacePanel.tsx`、`src/components/RepoMapCanvas.tsx`、`src/components/RepoMapNodeCard.tsx`、`src/utils/repoMapLayout.ts`、`src/utils/repoMapCanvasState.ts` 之前
> **不在本文范围**：职责事实怎么扫描 / 缓存（见 [repo-map](./repo-map.md)）、颜色与组件样式（见 [DESIGN_SYSTEM §6.3](../design/DESIGN_SYSTEM.md)）、标签条本身的通用规则（见 [DESIGN_SYSTEM §6.1](../design/DESIGN_SYSTEM.md)）

面板是编辑区的**默认视图**，回答一个问题：**这个仓库里有哪些文件、各自负责什么**，并且用一张可以自由摆放的地图把它摆出来。

---

## 1. 名词

| 名词 | 含义 |
| --- | --- |
| **面板** | 编辑区内容区的一个视图，与「文件视图」互斥；入口是标签条最左那枚**固定标签** |
| **底层地图** | 只画顶层文件夹卡 + 根目录文件卡的那一层；位置可以手摆并落盘 |
| **上浮链（chain）** | 从某个顶层目录开始、逐层点开的路径，例如 `['src', 'src/store']`；字符数组，顺序即层级 |
| **当前层** | 链尾那张文件夹卡 + 它**直接**展开出的子项；唯一全亮、可点的一组 |
| **退后** | 底层与所有更浅的层：`opacity 0.4` + `pointer-events: none`，与底层同款 |
| **世界坐标** | 舞台坐标系里的 `left/top`；`{zoom, pan}` 只影响舞台 `transform`，不改世界坐标 |
| **LOD** | 按缩放档位只切显隐（`full` / `compact` / `tiny`），不重建 DOM |

---

## 2. 视图切换：面板 ↔ 文件

| 关注点 | 实现 |
| --- | --- |
| 状态 | `editorStore.panelActive`（**运行期状态，不落盘**）+ `setPanelActive(active)`；每个工作区各一份 `EditorStore` |
| 入口标签 | `EditorTabs` 里最左的固定标签（`sticky left-0`），**不进 `openFiles`**、不可关闭、不可排序、不写进 `editor-tabs.json` |
| 点文件标签 | `setPanelActive(false)` + 切 `currentFile`（标签条同一次点击内完成） |
| 打开文件 | `openFileInEditor` 的 5 个成功分支统一 `setPanelActive(false)`，所以任何「打开」动作都会离开面板 |
| 内容区 | `FileView` 里两个兄弟节点：面板 `hidden` 切换（**不卸载**），文件视图 `hidden` 切换；Monaco 撤销栈与滚动位置因此保留 |
| 关掉最后一个文件 | `editorStore.removeOpenFile` 在 `currentFile` 变空时置 `panelActive: true` —— 不存在「没有文件也没有面板」的空态 |
| 重启 | `panelActive` 初值 `true`；`restoreEditorTabs` 恢复出任何文件就置 `false`（有标签就停在文件视图，不再先闪一下面板）；恢复为空则留在面板 |
| 面板可见性 | `WorkspacePanel` 收 `active={panelActive && 工作区可见}`；不可见时**不扫描、不补描述、也不响应 `git:changed`**（隐藏期间只记一笔待办，重新可见时补扫一次）—— 多工作区常驻视图里隐藏的工作区零开销 |

---

## 3. 文件地图

```
主进程
  electron/repo-map.ts           扫描：git ls-files → 指纹增量 → 事实表（role/headComment/exports）
  electron/repo-map-canvas.ts    画布布局落盘：读 + 清洗 + 原子写（.pi-workbench/repo-map-canvas.json）
  electron/ipc/repo-map.ts       repo-map:scan / describe / canvas:get / canvas:set

渲染层
  store/repoMapStore.ts          按工作区隔离的扫描状态：scan / describe / files / truncated / 错误
  store/editorStore.ts           panelActive（运行期，不落盘）
  workspace/repoMapCanvas.ts     画布状态读取 + 400ms 防抖写回（唯一写入口）
  workspace/openFileInEditor.ts  打开文件 → 切回文件视图

  components/WorkspacePanel.tsx  工具条：搜索 / 刷新 / 缩放 / 适应 / 还原 + 降级提示 + 空态
  components/RepoMapCanvas.tsx   单一视口舞台：平移 / 缩放 / 拖动 / 吸附 / 上浮链 / 小地图 / 键盘
  components/RepoMapNodeCard.tsx 卡片：文件夹卡 / 文件卡 + 层级样式
  components/RepoMapMinimap.tsx  小地图：同一张世界图 + 视口框

  utils/repoMapText.ts           文案：事实 → 当前语言的一句话职责
  utils/repoMapLayout.ts         树构建 + 底层排版 + 上浮链排版 + 吸附 / 视口数学
  utils/repoMapCanvasState.ts    落盘形状、清洗、迁移、剪枝、坐标查询
  utils/repoMapLod.ts            缩放 → LOD 档位
```

---

## 4. 数据流

```
面板首次可见 ──► repo-map:scan ──► { files[], truncated, repoRoot }
                                     │
                                     ├─ repoMapStore（按工作区）
                                     │
                                     ├─► buildCanvasTree(files)      扁平路径 → 目录树（带 fileCount）
                                     │
                                     ├─► repoMapCanvas.get()         落盘的底层坐标 + 视口
                                     │        └─ sanitize / migrate / prune
                                     │
                                     ├─► topLevelLayout(tree, persisted)   底层位置（只排一次）
                                     │
                                     └─► chainLayout(tree, base, chain)    链上位置 + depths + focus
                                              │
                                              └─► 渲染：底层卡 + 链上卡（同一舞台、同一缩放）
```

- **落盘两份，互不触发**：`repo-map.json`（事实，主进程写）+ `repo-map-canvas.json`（视线，渲染层经 IPC 写）。
- **补描述**：`> 5000` 跟踪文件时只对「点名」的文件生成（打开目录 / 搜索命中），走 `repo-map:describe`。
- **重扫触发**：`git:changed` 合并 1.5s 后重扫（文件内容改动不触发）、工具条刷新按钮（`force` 忽略指纹）；**面板不可见时不扫**，只记一笔待办，重新可见时补扫一次。
- **增删路径**：`pruneCanvasState` 只保留仍然存在的**顶层**坐标；链上目录失效则回退到仍存在的最近祖先。

---

## 5. 布局：底层

`topLevelLayout(tree, persisted)` 只排一次，之后完全由用户拖拽决定。

| 规则 | 值 |
| --- | --- |
| 两个块 | 顶层文件夹一个块、根目录文件一个块，上下叠（根目录不套「根」文件夹卡） |
| 列数 | **固定 `ROOT_COLUMNS = 4`**：两块都是每行 4 个，行优先（从左到右填，第 5 个换行） |
| 间距 | 列距 `COLUMN_GAP = 40`；文件夹行距 `ROOT_GAP = 28`、文件行距 `SIBLING_GAP = 12`；两块之间 `ROOT_FILE_GAP = 48` |
| 卡片尺寸 | 文件夹 `176×76`、文件 `208×64`（`NODE_SIZES`） |
| 覆盖规则 | 落盘坐标优先（`persisted` 命中即用），没有才用自动位置；手摆的卡不影响别的卡 |

- **只有固定规则**：位置只由「第几个」决定（第 5 个目录永远在第 2 行第 1 列），不随节点数改形状。曾经的「按高度分栏 + 根文件 8 行折列」「按宽高比挑列数」都会随数量变形状，同一仓库前后两次扫描都对不上，看起来像随手堆的。
- 排版算法变动 → **递增 `CANVAS_LAYOUT_VERSION`**，旧坐标整批作废（`migrateCanvasLayout` 清空 `folders` / `files`，只保留视口），否则旧手摆位置会和新网格重叠。
- 底层可拖、位置落盘；拖动松手才写状态（拖动过程只改被拖元素 `left/top` 与参考线，不经过 React 重渲染）。

---

## 6. 布局：上浮链（点开目录）

```
  src 卡（原地抬起）  ──►  子块：它的直接子项
                            src/App.tsx
                            src/store        ──►  再点其中某个目录 → 下一层子块
                            src/components
                            每列最多 8 张，超出往右折列

  横向：子块左边缘 = 父卡右边缘 + DEPTH_GAP(40)
  纵向：子块中线 = 父卡中线（不贴上沿；块比父卡高时上下对称长，可以到负坐标）
```

`chainLayout(tree, basePositions, chain)` 的输出：

| 字段 | 含义 |
| --- | --- |
| `positions` | 链上节点的世界坐标；**链根直接用底层坐标**（原地抬起） |
| `nodes` | 要画的节点：链上每张文件夹卡 + 它展开出的直接子项 |
| `elevated` | 需要抬到画布之上的节点 id |
| `depths` | 链根 `0`、子项 `1`、再下 `2`…… |
| `maxDepth` | 链长（链空为 `0`） |
| `focus` | **当前层**：链尾文件夹卡 + 它的直接子项 |

**一层怎么排**（`chainLevelGrid`）：

| 规则 | 值 |
| --- | --- |
| 列优先网格 | 自上而下填，**每列最多 `CHAIN_MAX_ROWS = 8` 张**，超过就折到右边一列（文件夹多时不会变成一根 7000px 的柱子）|
| 列宽 | 取这一层**最宽的卡片**（文件夹 176 / 文件 208）→ 列边对齐，同层不重叠 |
| 行高 | 按卡片自身高度累加（文件夹 76 / 文件 64），行距 `SIBLING_GAP(12)`；块高取**最高列** |
| 横向 | 子块第一列左边缘 = **父卡右边缘 + `DEPTH_GAP(40)`** |
| 纵向 | **子块中线 = 父卡中线**（`y = 父卡上沿 + (76 − 块高) / 2`，取整像素）；块比父卡高时上下对称地长，**可以到负坐标** |

**四条不变量**（改布局时不要破坏）：

1. **原地抬起**：链根用底层坐标，`left/top/width/height/zoom` 一律不变。
2. **相对自己的父卡排版**：横向从父卡右边缘 +40 起，纵向与父卡**居中**；每层只看自己的父卡，不看别的层。
3. **任何已有卡片的坐标都不会被推动**：`0→1` 不动底层、`1→2` 不动 1 层、`2→3` 不动 2 层。所以「收起即还原」一直成立。
4. **同级兄弟不算当前层**：`focus` 只含链尾那张卡与它的**直接子项**，链尾的其他兄弟（例如 `src/App.tsx`）和祖先一样退后。

**跨层是刻意的覆盖**：每上浮一层就盖住下一层 —— 深层块（`z-index = 2 + depth`）会压住父卡所在列右侧那些深度更浅的卡；它们本来就已经退后（`opacity 0.4` + `pointer-events: none`）。因此**层间可以重叠，只有同层内不允许重叠**。

**链的增删**（`nextChain(current, tree, path)`）：

| 操作 | 结果 |
| --- | --- |
| 点链外目录 / 深层目录 | 链不变 |
| 点当前层里的子目录 | 链尾追加 → 展开下一层 |
| 点当前层里那张**已展开的**文件夹卡 | 截断到它之前 → 收起它和它的下游 |
| `Esc` | 退一层（链空时无动作） |
| 点画布空白 | 退一层（与 `Esc` 同一段逻辑） |

---

## 7. 视觉分层（唯一规则表）

| 状态 | 成员 | 样式 |
| --- | --- | --- | --- |
| **锚卡（父）** | `ChainLayout.anchor`：链尾那张**被点开的文件夹卡**（链空时为 `null`） | `bg-raised` + `border-accent` + 左边缘 2px `accent` 竖条、`shadow-print`、`data-role="anchor"` |
| **普通卡（子 / 底层）** | 各层展开出的子文件夹与子文件、底层全部卡片 | `bg-panel` + `border-rule-control`、`data-role` 取 `folder` / `file`；搜索命中时另叠一层 6% `accent` 叠层 |
| **当前层** | `ChainLayout.focus`（锚卡 + 直接子项） | 全亮、可点、`data-emphasized="true"`；颜色仍按上面的角色走 |
| **抬升梯度** | 所有 `elevated` 节点 | `z-index = 2 + depth`；`translateY(-4px × depth)`；阴影 `(5+depth, 6+depth) 0`（复用 `--shadow-color/--shadow-alpha`） |
| **退后（只有一档）** | 底层 + 所有更浅的祖先层 + 链尾的同级兄弟 | `opacity 0.4`、`pointer-events: none`、`tabIndex -1`（颜色不变，只是整体压暗） |

- **父/子的颜色区分由「角色」决定，不看 `depth`**：所以第 1 层的锚卡与第 3 层的锚卡长得完全一样，各层的子项也与底层同款。「在第几层」只由 `z-index` / 4px 上移 / 阴影表达，不叠第二套颜色梯度。
- 梯度只改 `transform` / `z-index` / `box-shadow`，**不改世界坐标、不影响落盘**；所以「收起后回到原样」的契约一直成立。
- 焦点层是唯一能点的：点文件 → 打开文件并保持链；点文件夹 → 进下一层；点链尾那张已展开的卡 → 收起它和下游。
- `data-depth` / `data-elevated` / `data-emphasized` / `data-role` 四个属性挂在卡片上，供测试与调试读取（`data-role` 取 `anchor` / `folder` / `file`）。

---

## 8. 视口、拖动、吸附

| 关注点 | 实现 |
| --- | --- |
| 单一视口 | 底层与链共用一份 `{zoom, pan}`；舞台 `transform: translate(pan) scale(zoom)`，`transform-origin: 0 0` |
| 缩放 | `zoomAt(point, factor)` 以光标为锚，钳制 `25%–200%`（`MIN_ZOOM`/`MAX_ZOOM`）；滚轮 / `+` `-` |
| 平移 | **只走「空格 + 左键拖动」**（手形工具：空白处与卡片上都能拖，光标 `grab` → `grabbing`）；按住空格时卡片的点击 / 拖动、小地图跳转、双击适应窗口一律让位，`window` 失焦或切标签即复位空格状态。另有方向键（`PAN_STEP = 96`）与点小地图 |
| 空白点击 | 不按空格的空白单击（移动 < `DRAG_THRESHOLD_PX = 3`）**退一层**（等价 `Esc`，链空时无动作）；按住空格时画布不吃任何点击 |
| 镜头 | **展开文件夹完全不动镜头**（父卡是锚点；看全用 `0` / 工具条「适应窗口」）。只有**搜索定位**会把命中卡带进视野：已完整可见就不动，否则以它为准**居中平移**（`REVEAL_PADDING = 24`，160ms 过渡），绝不改缩放、不动卡片 |
| 拖动 | 阈值 `DRAG_THRESHOLD_PX = 3`；拖动中 `data-dragging` 关掉过渡；松手才提交 |
| 吸附 | 先贴 `SNAP_GRID = 8` 网格，再与其他卡的左/中/右、上/中/下对齐（`SNAP_THRESHOLD = 6` ÷ zoom），命中画 1px `accent` 参考线 |
| 适应窗口 | `fitView` 把世界外接矩形居中留白（钳制在缩放区间内）；入口只有 `0` 键与工具条按钮（**没有**双击空白，双击会和「空白单击退层」打架） |
| LOD | `repoMapLod`：`≥0.6` 全量 / `0.35–0.6` 隐藏职责一句 / `<0.35` 再隐藏角色标签与文件夹计数 |
| 键盘 | `Esc` 退一层、`0` 适应窗口、`+`/`-` 缩放、方向键平移（画布需聚焦） |
| 小地图 | 始终一份，画同一张世界图（含抬起的卡）；`ResizeObserver` 跟随面板尺寸；`aria-hidden` |

---

## 9. 状态与落盘

**扫描状态**：`repoMapStore.byWorkspace[workspacePath]`（按工作区隔离）。`App.closeWorkspaceTab` 在卸载视图后调 `repoMapStore.reset(workspacePath)` 清条目，同时清掉 `inFlight` 标记 —— 否则重开同一工作区会命中旧结果、并可能卡住「正在扫描」。

**画布状态**（`src/utils/repoMapCanvasState.ts`）：

```json
{
  "version": 1,
  "layoutVersion": 4,
  "zoom": 0.9,
  "pan": { "x": -120, "y": 40 },
  "folders": { "src": { "x": 400, "y": 300 } },
  "files": { "AGENTS.md": { "x": 0, "y": 0 } }
}
```

| 概念 | 规则 |
| --- | --- |
| `layoutVersion` | 当前 `CANVAS_LAYOUT_VERSION = 4`；低于它就迁移（v3 → v4 清空坐标、只留视口），迁移后立刻写回 |
| `folders` | 只存**顶层**目录的手摆坐标；深层坐标由剪枝清掉 |
| `files` | 只存**根目录**文件的坐标 |
| 链的状态 | **完全不落盘**（`chain` 是 `useState`，链上卡片的手摆位置只在 `sessionRef`） |
| 写回 | `src/workspace/repoMapCanvas.ts`：读一次、写防抖 400ms；「还原初始布局」是显式动作，立即 flush |
| 清洗 | 主进程再清洗一遍：坐标钳制 ±1e6、键必须是不含 `..` 的相对 posix 路径、条目上限 5000、版本不符整份重置 |
| 迁移 | `migrateCanvasLayout`：`layoutVersion < 4` 的旧文件**清空 `folders` / `files`**（排版规则变了，旧坐标与新网格对不上），只保留视口；坐标清空后面板自动重新「适应窗口」 |

**不落盘的运行期状态**：面板宽度、终端开关、窗口句柄、面板宿主、链本身、链上卡片位置、搜索框内容、拖动中间态。

---

## 10. 工具条与提示

| 元素 | 说明 |
| --- | --- |
| 汇总 | `{total} 个文件 · {described} 个有描述`（`Caption`） |
| 搜索 | `SearchField`（宽 208px）；命中卡高亮、未命中文件卡 `opacity-25`；命中时按 `ancestorFolders` **逐层建链**并把镜头移到命中卡 |
| 刷新 | `IconButton` + `RefreshCw`；扫描中禁用并转圈；`force: true` |
| 缩放 / 适应 / 还原 | 左下角工具条：`ZoomOut` / 百分比（`aria-live`）/ `ZoomIn` / `Maximize2` / `RotateCcw` |
| 降级提示条 | `> 5000` 跟踪文件时 `role="status"`：已生成 N / M，打开目录或搜索补齐（不可省） |
| 卡片过多提示 | `state.total ≥ MANY_NODES_HINT = 600` 时常驻一句「逐层查看或用搜索」（`pointer-events-none`，不挡画布）；阈值与文案同取 `total` |
| 空态 | 非 Git 仓库 / 无跟踪文件 → `EmptyState`（`GitBranch`）；搜索无命中**不换空态**，只淡出未命中卡片 |

---

## 11. 测试

| 文件 | 覆盖（按行为列，改哪块就补哪条） |
| --- | --- |
| `tests/repo-map-layout.test.ts` | 树构建与排序 · 底层固定网格（每行 4 张 / 两块间距 / 顺序无关）· `chainLevelGrid`（列优先 / 8 行折列 / 列宽取最宽卡）· `chainLayout`（原地抬起 / 中线居中 / 折列 / 负坐标 / `depths` / `focus` / `anchor` / 不推动已有卡 / 同层不重叠）· `nextChain`（追加 / 截断 / 链外无效）· `collectFiles` / `ancestorFolders` · `boundsOf` / `fitView` / `zoomAt` · 吸附与参考线 |
| `tests/repo-map-canvas.test.tsx` | 底层渲染与落盘恢复 · 拖动提交（底层落盘 / 链上只进会话）· 缩放与 LOD · 键盘（`0` / `+` `-` / 方向键 / `Esc`）· 小地图 · 布局迁移与剪枝 · 展开不动镜头 · 父/子角色色（`data-role` + `bg-raised` + 竖条）· 搜索建链与命中叠层 · **空格手形工具**（不按空格拖动不平移 / 空格拖动平移 / 空格点卡片不作动 / 失焦复位 / 双击空白不触发适应窗口）· **空白单击退一层** |
| `tests/repo-map-canvas-state.test.ts` | 落盘形状、清洗、`layoutVersion` 迁移、剪枝、坐标查询 |
| `tests/workspace-panel.test.tsx` | 工具条与摘要 · 搜索 · 刷新 · 空态 / 非仓库 / 失败重试 · 展开与当前层 · 按需补描述 · 隐藏时零开销（不扫描、`git:changed` 只记待办）· 卡片过多提示的阈值边界（599 / 600） |
| `tests/design-system.test.ts` | 面板相关颜色 token 与组件类名门槛（强制） |
| `tests/main-ipc.test.ts` | `repo-map:*` 四个频道的注册与参数校验 |

```bash
npx vitest run tests/repo-map-layout.test.ts tests/repo-map-canvas.test.tsx
npx vitest run tests/workspace-panel.test.tsx tests/repo-map-canvas-state.test.ts
npm test && npm run lint && npm run type-check
```

---

## 12. 明确不做 / 已知取舍

- 不做列表视图 —— 画布是面板唯一形态。
- 不做依赖连线 —— 层级由「谁被抬起来」表达，不画线。
- 不做浮层窗口 / 面包屑 / 遮罩 / 第二套小地图 —— 展开就是被点的卡原地抬起、子项向右长。
- 不做「一眼看整棵树」—— 底层只有顶层，纵深逐层点开。
- 不做 treemap、不显示 Git 修改状态、不在面板里写文件。
- **链上拖动不落盘**：收起再打开回到自动阶梯（保证「收起即还原」可预期）。
- **退后的卡片不可点**：因此收起只走 `Esc` 与点空白（两者都只退一层）；「同层换一个子目录」需要先退一层。
- **链不落盘**：重启回到只有底层的地图，视口与底层坐标照旧恢复。

---

## 13. 常见改动指引

| 我要改 | 触点 |
| --- | --- |
| 卡片尺寸 / 间距 / 网格 | `NODE_SIZES`、`DEPTH_GAP`、`SIBLING_GAP`、`ROOT_GAP`、`ROOT_FILE_GAP`、`COLUMN_GAP`（`repoMapLayout.ts`）+ 卡片内边距（`RepoMapNodeCard.tsx`）+ §6.3 文档 |
| 底层每行列数 | `ROOT_COLUMNS = 4`（`topLevelLayout`） |
| 一层折列行数 | `CHAIN_MAX_ROWS = 8` + `chainLevelGrid`（改完补 `repo-map-layout` 用例） |
| 层间对齐方式 | `chainLayout` 里的 `top = Math.round(point.y + (76 − 块高) / 2)`（中线居中 → 改成贴顶/贴底就改这一行） |
| 层级视觉（上移 / 阴影 / 退后档） | `RepoMapNodeCard.tsx` 的 `STEP_PX` / `RECESSED_OPACITY` + `index.css` 的 `.repo-map-card` 过渡 + §6.3 文档 |
| 新增一种交互 | `RepoMapCanvas.tsx` 的事件层 + `tests/repo-map-canvas.test.tsx` + §7/§8 文档 |
| 改落盘形状 | `repoMapCanvasState.ts`（形状 + 清洗 + 迁移）、`electron/repo-map-canvas.ts`（主进程清洗）、`CANVAS_LAYOUT_VERSION` 递增 + 迁移用例 + §9 文档 |
| 改 LOD 阈值 | `repoMapLod.ts` + `index.css` 的 LOD 选择器 + §8 文档 |
| 改扫描口径 / 缓存 | 见 [repo-map](./repo-map.md)，本文不重复 |

---

## 14. 改面板的固定检查项

改任何一处面板行为，按这张单子走完再收尾（顺序即验证顺序）：

1. **常量**：尺寸 / 间距 / 折列 / 阈值都在 `repoMapLayout.ts` 与 `WorkspacePanel.tsx` 顶部，改完回到本文 §5 / §6 / §10 对齐数字。
2. **布局用例**：`tests/repo-map-layout.test.ts` —— 排布规则变了就补一条「形状只由索引决定」的断言（不写「看起来对」，写具体坐标 / 尺寸）。
3. **交互用例**：`tests/repo-map-canvas.test.tsx` / `tests/workspace-panel.test.tsx` —— 手势改动必须同时覆盖「做了什么」与「没做什么」（例：空格点卡片既没打开也没展开）。
4. **两份文档**：`docs/design/DESIGN_SYSTEM.md §6.3`（视觉 / 手势的唯一事实源，含变更记录）+ 本文 §7 / §8（规则表）。
5. **门禁**：`tests/design-system.test.ts`（颜色 / 类名）→ `npm run type-check` → `npm run lint` → `npm test`；UI 改动另跑 Paper / Ink 两套主题、1024 / 1440 两个宽度。
6. **别碰**：落盘形状（`repoMapCanvasState` + `CANVAS_LAYOUT_VERSION`）与 IPC 频道名属于兼容性契约，改它们要单独确认，并在 §9 记录迁移。
