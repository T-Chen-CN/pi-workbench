# 仓库地图（工作区面板）

> **面向**：维护「面板」内容、改职责推断规则或缓存格式的人
> **什么时候读**：动 `electron/repo-map.ts`、`electron/ipc/repo-map.ts`、`src/components/WorkspacePanel.tsx`、`src/store/repoMapStore.ts` 之前
> **什么时候要改**：角色分类、缓存字段、扫描上限、刷新触发条件变化时

> 面板是编辑区的默认视图（入口是标签条最左那枚固定标签，样式见 [DESIGN_SYSTEM §6.3](../design/DESIGN_SYSTEM.md)）。
> 它回答一个问题：**这个仓库里有哪些文件、各自负责什么**。
>
> 本文只讲**扫描口径 / 事实 / 缓存**。面板的视图切换、画布交互、上浮链与落盘状态见 [工作区面板实现说明](./workspace-panel.md)。

## 1. 边界

- **只读**：读 Git 索引、读文件头。不写 index、不碰 `.gitignore` / `info/exclude`、不做 add / commit。
- **离线**：不联网、不调模型。职责靠规则推断（路径 + 首部注释 + 顶层导出符号），没有 B2 那一层。
- **数据源**：`git ls-files -z --cached`（主仓库，不含会话工作树）。未跟踪文件、`node_modules`、构建产物天然不在列表里。
- **写盘唯一位置**：`{workspace}/.pi-workbench/`（`repo-map.json` 事实缓存 + `repo-map-canvas.json` 画布布局）。该目录是否被 Git 忽略由用户仓库自己决定，应用不做任何 Git 侧写入。

## 2. 扫描与增量

```
git ls-files -z ──► 路径全集（posix）
     │
     ├─ 每个路径 fs.stat → 指纹 size + mtimeMs
     │      ├─ 命中缓存且指纹一致 → 复用事实（不读内容）
     │      └─ 未命中 / 变更 / force → 读文件头 4KB → 提取事实
     │
     └─ 有变化才 writeJsonAtomic 回写缓存
```

- **指纹**：`size + mtimeMs`。改内容 / 改名 / 重写都会失配，只重算受影响的文件。
- **串行**：同一工作区的扫描在主进程排队（`serializeScan`），渲染层也做了单飞，避免重复读盘。
- **只读工作区内**：仓库根可能高于工作区根（工作区是仓库子目录时），工作区之外的文件不列、不读；符号链接按 `realpath` 再校验一次。

## 3. 事实（缓存内容，与语言无关）

| 字段 | 含义 |
| --- | --- |
| `role` | 11 类角色：`component` / `state` / `ipc` / `util` / `type` / `style` / `test` / `doc` / `config` / `asset` / `other` |
| `binary` | 文件头含 NUL |
| `size` / `mtimeMs` | 指纹 |
| `headComment` | 首部注释压缩成一行（≤160 字符），支持 `/** */`、`//`、`#`，跳过 shebang |
| `exports` / `symbol` | 顶层导出名（最多 3 个），`symbol` = 第一个 |

**文案不落盘**：句子由 `src/utils/repoMapText.ts` 按当前语言生成，所以切中英文不重扫。

角色判定顺序（`roleForPath`）：测试 → 文档 → 类型（`.d.ts` / `types/`）→ 样式 → 配置（`package*.json`、`*.json/yml/toml`、点文件、`config/`、`.github/`）→ 资源（图片 / 字体 / 媒体）→ `electron/` 主进程 → `src/store/` 状态 → `.tsx` 组件 → `.ts/.js` 工具 → 其他。规则是纯路径判断，降级模式下未描述的条目也有分类。

## 4. 画布布局（前端）

面板不是列表，是「**稳定的底层地图 + 点开目录时原地抬起的卡片**」（样式见 [DESIGN_SYSTEM §6.3](../design/DESIGN_SYSTEM.md)）。

| 关注点 | 实现 |
| --- | --- |
| 树结构 | `buildCanvasTree`（`src/utils/repoMapLayout.ts`）：扁平路径 → 递归目录树，目录节点带 `fileCount` |
| 底层内容 | `topLevelLayout`：只排顶层 —— 顶层文件夹一个块、根目录文件一个块**上下叠**（文件夹在上、根文件在下，隔 `ROOT_FILE_GAP=48`）；两块都按**固定 `ROOT_COLUMNS=4` 的行优先网格**排（列距 `COLUMN_GAP=40`，文件夹行距 28、文件行距 12）。位置只由「第几个」决定，不随节点数变形状；排一次就固定 |
| 展开（上浮链） | `chainLayout(tree, basePositions, chain)`：链根目录**用底层坐标**抬起；每层的直接子项排成一个**列优先网格**（每列最多 `CHAIN_MAX_ROWS=8` 张，超出折列，列宽取该层最宽卡片），子块左边缘 = 父卡右边缘 + `DEPTH_GAP=40`、**中线与父卡对齐** |
| 链的增删 | `nextChain(current, tree, path)`：点链外目录不改、点当前层里的子目录加一层、点当前层里那张已展开的文件夹则收起它及其下游；`Esc` 与点空白都只**退一层**（退后的卡片不可点，所以没有「点同级兄弟换目录」这条路） |
| 层间是覆盖关系 | 每上浮一层就盖住下一层：深层 `z-index = 2 + depth`，会压在父卡右侧那些更浅的卡上（它们已经 `opacity 0.4` + 不可点）；**同层内不重叠，跨层允许重叠**；任何已有卡片坐标都不被推动 |
| 层级梯度 | `chainLayout` 同时给出 `depths`（链根 0、子项 1、再下 2……）与 `maxDepth`；卡片按 `depth` 拿 `z-index = 2 + depth`、`translateY(-4 × depth)`、逐层加重的阴影；**当前层 = 链尾文件夹卡 + 它的直接子项**（`ChainLayout.focus`，两者都亮、都可点，同级兄弟不算）；链尾那张卡另由 `ChainLayout.anchor` 标出，渲染层据此给它 `bg-raised` + `accent` 边 + 左侧竖条（父/子配色见 DESIGN_SYSTEM §6.3）；**退后只有一档** —— 更浅的祖先层与底层同款 `opacity 0.4` + `pointer-events: none` |
| 唯一视口 | 底层与链共用一份 `{zoom, pan}`，单一 `transform: translate + scale` 舞台；`zoomAt` 以光标为锚点，钳制 25%–200%；**展开不动镜头**（父卡是锚点），只有**搜索定位**会把命中卡带进视野（已可见不动、否则居中平移 160ms，`centerOnRects`）；两者都不改缩放、不动卡片坐标 |
| 拖动 | 只改被拖元素的 `left/top` 与参考线（不经过 React），松手才写状态；吸附 8px 网格 + 其他卡的边 / 中线（阈值 6px ÷ zoom） |
| 平移 | 只走「空格 + 左键」手形工具：不按空格时空白拖动不平移（只判定单击 → 退一层）；按住空格时画布只认平移，卡片点击 / 拖动与小地图跳转全部让位 |
| 落盘边界 | **底层坐标落盘**（`repo-map-canvas.json`）；**链的状态与链上卡片位置只在内存**（`sessionRef`），收起链即丢、重开回到自动阶梯 |
| 缩放分级 | `data-zoom-lod` 挂在画布根：≥0.6 全量 / 0.35–0.6 隐藏职责一句 / <0.35 再隐藏角色标签（CSS 切换，DOM 不重建） |
| 搜索 | 命中卡高亮、未命中文件卡 `opacity-25`；同时按 `ancestorFolders` **逐层抬起**祖先目录并把镜头移到命中卡 |
| 小地图 | 始终一份，画的是同一张世界图（含抬起的卡）；`ResizeObserver` 跟随面板尺寸 |
| 刷新 | `src/workspace/repoMapCanvas.ts`：读一次、写防抖 400ms（`repo-map:canvas:get` / `set`）；还原布局是显式动作，立即 flush |
| 剪枝 | 扫描结果变化时只保留仍然存在的**顶层**路径坐标；链上目录失效则弹回最近一个仍存在的祖先 |

布局状态与扫描缓存**分开落盘**：`repo-map.json` 管事实，`repo-map-canvas.json` 管底层视线，互相不触发重建。

## 5. 降级（> 5000 个跟踪文件）

- 文件列表照旧完整返回；描述只对「点名」的文件生成（打开目录、搜索命中）。
- 返回 `truncated: true`，面板顶部常驻 `role="status"` 提示条：**已生成 N / M，打开目录或搜索补齐**（这是产品要求，不能省）。
- 补描述走 `repo-map:describe`（也就是带 `paths` 的扫描），同一份缓存继续复用。

## 6. 刷新触发

| 触发 | 行为 |
| --- | --- |
| 面板首次可见 | 扫一次（面板是默认视图，启动时不预先扫盘） |
| `git:changed`（index / refs） | 合并 1.5s 后重扫；文件内容改动本身不触发。**面板不可见时不扫**，只记一笔待办，重新可见时补扫一次 |
| 工具条刷新按钮 | `force: true`：忽略指纹缓存全部重读 |
| 搜索 / 打开目录（降级时） | `repo-map:describe` 补这批文件 |
| 切工作区 | 各工作区独立缓存；store 按工作区隔离，关工作区时清条目 |

## 7. 缓存格式

```json
{
  "version": 3,
  "repoRoot": "F:/path/to/repo",
  "updatedAt": 1730000000000,
  "files": {
    "src/store/editorStore.ts": {
      "role": "state",
      "binary": false,
      "size": 8123,
      "mtimeMs": 1730000000000,
      "headComment": "每个打开的工作区各持有一份编辑器状态…",
      "exports": ["createEditorStore", "editorStoreFor"],
      "symbol": "createEditorStore"
    }
  }
}
```

`version` 或 `repoRoot` 不匹配、JSON 损坏、`.bak` 也读不出来 → **静默丢弃重建**，不弹任何提示。

底层布局单独一份（键是相对路径；`folders` 只存**顶层**目录的手摆坐标，`files` 只存根目录文件坐标；上浮链状态一概不落盘）：

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

`layoutVersion` 与渲染层 `CANVAS_LAYOUT_VERSION` 对应：v3 → v4 时底层排版从「按高度分栏 + 根文件 8 行折列」改成「固定 `ROOT_COLUMNS=4` 的行优先网格」，旧坐标与新网格对不上，所以**整批作废（只留视口）**。

主进程写入前会再清洗一遍：版本不符整份重置、坐标钳制 ±1e6、键必须是不含 `..` 的相对 posix 路径、条目上限 5000。

## 8. 明确不做

- 不做依赖关系（谁 import 谁）、不做 treemap 面积图。
- 不做 Agent 逐文件解读（B1 之外一律不做）。
- 不显示 Git 修改状态（那是 Git 视图的职责）。
- 不在面板里写文件、不提供「重命名 / 删除」等操作。
- 不做列表视图（画布是面板的唯一形态），也不做任何连线（层级由「谁被抬起来」表达）。
- 不做浮层窗口 / 面包屑 / 遮罩：展开就是被点的卡原地抬起、子项向右长。
- 不做「一眼看整棵树」的总览视图：底层只有顶层，纵深逐层点开。
