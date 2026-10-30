/**
 * 仓库地图的几何与排版（纯函数，不碰 DOM、不碰状态）。
 *
 * 模型是「**底层地图 + 卡片上浮**」：
 * - 底层只画顶层节点（顶层文件夹 + 根目录文件），按**固定列数**排网格，之后**永不重排**；
 * - 点开文件夹时，那张卡**原地抬起**（位置 / 尺寸 / 缩放都不变），它的子项在右侧用同一套
 *   世界坐标长成一个**列优先网格**（每列最多 `CHAIN_MAX_ROWS` 张，超过就折列），整个子块
 *   与父卡**纵向居中**（中线对齐）；再点一层就继续往右，形成一条向右的阶梯。
 *
 * 所以这里只有两种排版：`topLevelLayout`（底层固定网格）与 `chainLayout`（上浮链的一层一网格）。
 * 没有浮层窗口、没有内容自适应、没有连线 —— 层级由「谁被抬起来」表达，越深越盖在上面。
 */

import type { RepoMapFile } from '../types/electron'

export type CanvasNodeKind = 'folder' | 'file'

export interface CanvasNodeInput {
  path: string
  kind: CanvasNodeKind
  /** 父目录路径；根目录下的节点为 null */
  parent: string | null
  /** 目录：递归文件数 */
  fileCount?: number
}

export interface Point {
  x: number
  y: number
}

export interface Rect extends Point {
  width: number
  height: number
}

/** 卡片尺寸固定：布局按矩形计算，尺寸变化只影响常量表 */
export const NODE_SIZES: Record<CanvasNodeKind, { width: number; height: number }> = {
  folder: { width: 176, height: 76 },
  file: { width: 208, height: 64 },
}

/** 卡片右边缘 → 子列左边缘 */
export const DEPTH_GAP = 40
/** 同列兄弟之间的间距 */
export const SIBLING_GAP = 12
/** 同层相邻两列之间的间距 */
export const COLUMN_GAP = 40
/** 底层：文件夹块内的行间距（比文件的兄弟间距松，块内更有呼吸感） */
export const ROOT_GAP = 28
/** 底层：文件夹块与根文件块之间的留白 */
export const ROOT_FILE_GAP = 48
/** 底层：每行放几张卡（文件夹块与文件块用同一个列数，两块节奏一致） */
export const ROOT_COLUMNS = 4
/** 拖动吸附的网格步长 */
export const SNAP_GRID = 8
/** 吸附到其他卡片边线 / 中线的阈值（调用方按 zoom 折算） */
export const SNAP_THRESHOLD = 6
/** 缩放范围 */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 2
/** 适应窗口的四周留白 */
export const FIT_PADDING = 48

export function nodeId(node: Pick<CanvasNodeInput, 'kind' | 'path'>): string {
  return `${node.kind}:${node.path}`
}

export function sizeOf(node: CanvasNodeKind): { width: number; height: number } {
  return NODE_SIZES[node]
}

export interface CanvasTree {
  nodes: CanvasNodeInput[]
  children: Map<string | null, CanvasNodeInput[]>
}

/**
 * 扁平文件列表 → 目录树节点。目录节点是递归的（浮层里点文件夹还能再进一层），
 * 但树只用来查询「某个目录的直接子项」，不再参与底层排版。
 */
export function buildCanvasTree(files: RepoMapFile[]): CanvasTree {
  const folders = new Map<string, CanvasNodeInput>()
  const children = new Map<string | null, CanvasNodeInput[]>()
  const addChild = (parent: string | null, node: CanvasNodeInput) => {
    const list = children.get(parent)
    if (list) list.push(node)
    else children.set(parent, [node])
  }

  for (const file of files) {
    const segments = file.path.split('/')
    let parent: string | null = null
    for (let index = 0; index < segments.length - 1; index++) {
      const folderPath = segments.slice(0, index + 1).join('/')
      let folder = folders.get(folderPath)
      if (!folder) {
        folder = { path: folderPath, kind: 'folder', parent, fileCount: 0 }
        folders.set(folderPath, folder)
        addChild(parent, folder)
      }
      folder.fileCount = (folder.fileCount ?? 0) + 1
      parent = folderPath
    }
    addChild(parent, { path: file.path, kind: 'file', parent })
  }

  // 文件夹在前、文件在后；同类按路径排序，保证每次扫描结果稳定
  const byPath = (left: CanvasNodeInput, right: CanvasNodeInput) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    return left.path.localeCompare(right.path)
  }
  for (const list of children.values()) list.sort(byPath)

  const nodes = [
    ...folders.values(),
    ...files.map((file) => ({
      path: file.path,
      kind: 'file' as const,
      parent: parentOf(file.path),
    })),
  ]
  nodes.sort(byPath)

  return { nodes, children }
}

function parentOf(path: string): string | null {
  const index = path.lastIndexOf('/')
  return index > 0 ? path.slice(0, index) : null
}

export interface PersistedPositions {
  folders: Record<string, Point>
  files: Record<string, Point>
}

export interface TopLevelLayout {
  positions: Map<string, Point>
  /** 按绘制顺序排好的顶层节点（文件夹在前） */
  nodes: CanvasNodeInput[]
}

function blockSize(
  count: number,
  size: { width: number; height: number },
  rowGap: number
): { width: number; height: number } {
  if (count === 0) return { width: 0, height: 0 }
  const columns = Math.min(count, ROOT_COLUMNS)
  const rows = Math.ceil(count / ROOT_COLUMNS)
  return {
    width: columns * size.width + (columns - 1) * COLUMN_GAP,
    height: rows * size.height + (rows - 1) * rowGap,
  }
}

/**
 * 底层地图：**固定列数的行优先网格**，没有自适应。
 *
 * - 顶层文件夹块：从左上角起按行填，每行 `ROOT_COLUMNS = 4` 个，列距 `COLUMN_GAP`、行距 `ROOT_GAP`；
 * - 根目录文件块：同样每行 4 个（行距 `SIBLING_GAP` 更紧），左对齐摆在文件夹块下方，隔 `ROOT_FILE_GAP`。
 *
 * 为什么不用「按高度分栏 / 折列」或「按宽高比挑列数」：那两类规则都会随节点数变形状，
 * 同一个仓库前后两次扫描都对不上，看起来就像随手堆的。固定列数时位置只由
 * 「第几个」决定 —— 第 5 个目录永远在第 2 行第 1 列。
 *
 * 落盘坐标（手动拖过的卡）逐张覆盖自动位置，不影响别的卡。
 */
export function topLevelLayout(
  tree: CanvasTree,
  persisted: PersistedPositions
): TopLevelLayout {
  const roots = tree.children.get(null) ?? []
  const folders = roots.filter((node) => node.kind === 'folder')
  const files = roots.filter((node) => node.kind === 'file')

  const positions = new Map<string, Point>()
  const nodes: CanvasNodeInput[] = []

  const place = (node: CanvasNodeInput, auto: Point): void => {
    const saved = persisted[node.kind === 'folder' ? 'folders' : 'files'][node.path]
    const point = saved ?? auto
    positions.set(nodeId(node), { x: point.x, y: point.y })
    nodes.push(node)
  }

  /** 位置只由下标决定（第几行第几列），不随总数量改形状 */
  const placeGrid = (
    list: CanvasNodeInput[],
    size: { width: number; height: number },
    rowGap: number,
    originY: number
  ): void => {
    list.forEach((node, index) => {
      place(node, {
        x: (index % ROOT_COLUMNS) * (size.width + COLUMN_GAP),
        y: originY + Math.floor(index / ROOT_COLUMNS) * (size.height + rowGap),
      })
    })
  }

  const folderBlock = blockSize(folders.length, NODE_SIZES.folder, ROOT_GAP)
  placeGrid(folders, NODE_SIZES.folder, ROOT_GAP, 0)
  placeGrid(
    files,
    NODE_SIZES.file,
    SIBLING_GAP,
    folders.length > 0 ? folderBlock.height + ROOT_FILE_GAP : 0
  )

  return { positions, nodes }
}

/** 上浮链：浅 → 深，每项是一个被抬起来的目录路径 */
export type Chain = string[]

export interface ChainLayout {
  /** 链上节点的世界坐标（链根目录用底层坐标） */
  positions: Map<string, Point>
  /** 链上要画的节点：被抬起的目录卡 + 它们的直接子项 */
  nodes: CanvasNodeInput[]
  /** 需要抬到画布之上的节点 id */
  elevated: Set<string>
  /**
   * 抬升层级：链根目录是 0、它的子项是 1、再下一层是 2……
   * 用来做「越深越靠上」的视觉梯度。
   */
  depths: Map<string, number>
  /** 当前最深层（没有链时为 0） */
  maxDepth: number
  /**
   * 当前层（唯一亮着、可点的一组）：**链尾那张文件夹卡** + **它展开出的子项**。
   * 注意不是「所有 depth ≥ maxDepth-1 的节点」—— 那会把链尾的同级兄弟也点亮。
   */
  focus: Set<string>
  /**
   * 当前层的**锚卡** id（链尾那张被点开的文件夹卡），链空时为 `null`。
   * 渲染层用它做父/子的颜色区分：锚卡 = `bg-raised` + `accent` 边 + 左侧竖条，
   * 其余卡 = `bg-panel` + 普通描边。角色决定颜色（**不看 depth**），所以每一层长得完全一样。
   */
  anchor: string | null
}

/** 上浮链：一层里每列最多放几张卡，放满就折到下一列 */
export const CHAIN_MAX_ROWS = 8

export interface ChainLevelGrid {
  /** 与传入 kids 一一对应的块内相对坐标 */
  points: Point[]
  /** 块宽：列宽 × 列数 + 列距 */
  width: number
  /** 块高：最高那一列的高度 */
  height: number
}

/**
 * 一层卡片排成**列优先网格**：自上而下填 `CHAIN_MAX_ROWS` 张，再往右一列。
 *
 * 列宽取这一层最宽的卡片（文件夹 176 / 文件 208），所以同层列距固定、列边对齐；
 * 各列高度按各自卡片高度累加（文件夹 76 与文件 64 混排也不会重叠），块高取最高列。
 * 一层只有几到十几张时就是单列，和以前一样。
 */
export function chainLevelGrid(kids: CanvasNodeInput[]): ChainLevelGrid {
  if (kids.length === 0) return { points: [], width: 0, height: 0 }
  const columnWidth = Math.max(...kids.map((kid) => NODE_SIZES[kid.kind].width))
  const points: Point[] = []
  let height = 0
  for (let start = 0; start < kids.length; start += CHAIN_MAX_ROWS) {
    const end = Math.min(start + CHAIN_MAX_ROWS, kids.length)
    const columnX = (start / CHAIN_MAX_ROWS) * (columnWidth + COLUMN_GAP)
    let cursor = 0
    for (let index = start; index < end; index++) {
      points.push({ x: columnX, y: cursor })
      cursor += NODE_SIZES[kids[index].kind].height + SIBLING_GAP
    }
    height = Math.max(height, cursor - SIBLING_GAP)
  }
  const columns = Math.ceil(kids.length / CHAIN_MAX_ROWS)
  return { points, width: columns * columnWidth + (columns - 1) * COLUMN_GAP, height }
}

/**
 * 上浮链：一层一个网格，逐层向右叠，每层都与自己的父卡**纵向居中**。
 *
 * - 一层 = 一个列优先网格（每列最多 `CHAIN_MAX_ROWS` 张，超出折列）；
 * - 横向：子块第一列起点 = **父卡右边缘 + `DEPTH_GAP(40)`**；
 * - 纵向：**子块的中线与父卡的中线对齐**（所以子块比父卡高时会往上下两边对称长，可以到负坐标）；
 * - 跨层**允许重叠**：越深越盖在上面（`z-index = 2 + depth`），浅层退后压暗且不可点 ——
 *   这就是「每上浮一层就盖住下一层」；
 * - 同层内不重叠；任何已有卡片的坐标不会因为展开 / 折列 / 收起而改变，所以「收起即还原」。
 *
 * 链以外的节点一概不参与排版 —— 底层地图因此永远不动。
 */
export function chainLayout(
  tree: CanvasTree,
  basePositions: Map<string, Point>,
  chain: Chain
): ChainLayout {
  const positions = new Map<string, Point>()
  const nodes: CanvasNodeInput[] = []
  const elevated = new Set<string>()
  const depths = new Map<string, number>()
  const empty: ChainLayout = {
    positions,
    nodes,
    elevated,
    depths,
    maxDepth: 0,
    focus: new Set<string>(),
    anchor: null
  }
  const rootPath = chain[0]
  const rootPoint = rootPath ? basePositions.get(`folder:${rootPath}`) : undefined
  if (!rootPath || !rootPoint) return empty

  const kidsOf = (path: string) => tree.children.get(path) ?? []

  // 链根目录：用底层坐标，原地抬起
  const rootNode: CanvasNodeInput = { path: rootPath, kind: 'folder', parent: null }
  positions.set(nodeId(rootNode), { x: rootPoint.x, y: rootPoint.y })
  nodes.push(rootNode)
  elevated.add(nodeId(rootNode))
  depths.set(nodeId(rootNode), 0)

  for (let depth = 0; depth < chain.length; depth++) {
    const folder = chain[depth]
    const point = positions.get(`folder:${folder}`)
    if (!point) break

    const kids = kidsOf(folder)
    const grid = chainLevelGrid(kids)
    const childX = point.x + NODE_SIZES.folder.width + DEPTH_GAP
    // 子块整体与父卡纵向居中（中线对齐）；取整像素，避免半像素进落盘状态
    const top = Math.round(point.y + (NODE_SIZES.folder.height - grid.height) / 2)
    kids.forEach((kid, index) => {
      const offset = grid.points[index]
      positions.set(nodeId(kid), { x: childX + offset.x, y: top + offset.y })
      elevated.add(nodeId(kid))
      depths.set(nodeId(kid), depth + 1)
      if (!nodes.some((node) => nodeId(node) === nodeId(kid))) nodes.push(kid)
    })
  }

  // 当前层：链尾文件夹卡 + 它的直接子项（同级兄弟不算）
  const focus = new Set<string>()
  const tail = chain[chain.length - 1]
  const tailId = `folder:${tail}`
  if (positions.has(tailId)) {
    focus.add(tailId)
    for (const kid of kidsOf(tail)) {
      const id = nodeId(kid)
      if (positions.has(id)) focus.add(id)
    }
  }

  return {
    positions,
    nodes,
    elevated,
    depths,
    maxDepth: chain.length,
    focus,
    anchor: focus.has(tailId) ? tailId : null
  }
}

/**
 * 点某个目录后应有的链：
 * - 点已抬起的目录 → 收起它和它的下游；
 * - 点链上某一层的子目录 → 切到那条分支（前面的层保留）；
 * - 其余情况（链外目录、深层目录）不改。
 */
export function nextChain(current: Chain, tree: CanvasTree, path: string): Chain {
  const index = current.indexOf(path)
  if (index >= 0) return current.slice(0, index)
  if (current.length === 0) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
    return parent === null ? [path] : []
  }
  for (let depth = current.length - 1; depth >= 0; depth--) {
    const kids = tree.children.get(current[depth]) ?? []
    if (kids.some((kid) => kid.kind === 'folder' && kid.path === path)) {
      return [...current.slice(0, depth + 1), path]
    }
  }
  return current
}

/** 某个目录下的全部文件节点（打开浮层时用来补齐描述） */
export function collectFiles(tree: CanvasTree, folderPath: string | null): CanvasNodeInput[] {
  const result: CanvasNodeInput[] = []
  const walk = (children: CanvasNodeInput[] | undefined): void => {
    for (const child of children ?? []) {
      if (child.kind === 'file') result.push(child)
      else walk(tree.children.get(child.path))
    }
  }
  walk(tree.children.get(folderPath))
  return result
}

/** 某个路径的全部祖先目录（浅 → 深）；用于搜索定位时重建浮层栈 */
export function ancestorFolders(path: string): string[] {
  const segments = path.split('/')
  const result: string[] = []
  for (let index = 1; index < segments.length; index++) {
    result.push(segments.slice(0, index).join('/'))
  }
  return result
}

/** 一组节点的外接矩形（用于 fit / 小地图） */
export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function rectOf(node: CanvasNodeInput, point: Point): Rect {
  const size = sizeOf(node.kind)
  return { x: point.x, y: point.y, width: size.width, height: size.height }
}

/** 两个矩形是否重叠（带间距） */
export function intersects(left: Rect, right: Rect, margin = 0): boolean {
  return (
    left.x - margin < right.x + right.width &&
    left.x + left.width + margin > right.x &&
    left.y - margin < right.y + right.height &&
    left.y + left.height + margin > right.y
  )
}

export interface SnapGuide {
  axis: 'x' | 'y'
  /** 世界坐标里的参考线位置 */
  position: number
}

export interface SnapResult {
  x: number
  y: number
  guides: SnapGuide[]
}

/**
 * 拖动吸附：先跟网格，再跟其他卡片的左 / 中 / 右、上 / 中 / 下对齐。
 * `threshold` 由调用方按 zoom 折算（6px / zoom），保证不同缩放下手感一致。
 */
export function snapToGuides(
  rect: Rect,
  others: Rect[],
  options: { grid?: number; threshold?: number } = {}
): SnapResult {
  const grid = options.grid ?? SNAP_GRID
  const threshold = options.threshold ?? SNAP_THRESHOLD

  const snapAxis = (
    edges: number[],
    candidates: number[],
    axis: 'x' | 'y'
  ): { delta: number | null; guide: SnapGuide | null } => {
    let best: { delta: number; position: number } | null = null
    for (const value of edges) {
      for (const candidate of candidates) {
        const delta = candidate - value
        if (Math.abs(delta) > threshold) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, position: candidate }
        }
      }
    }
    if (!best) return { delta: null, guide: null }
    return { delta: best.delta, guide: { axis, position: best.position } }
  }

  const gridX = Math.round(rect.x / grid) * grid
  const gridY = Math.round(rect.y / grid) * grid
  const gridDx = gridX - rect.x
  const gridDy = gridY - rect.y

  const xEdges = [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
  const yEdges = [rect.y, rect.y + rect.height / 2, rect.y + rect.height]

  const xCandidates: number[] = []
  const yCandidates: number[] = []
  for (const other of others) {
    xCandidates.push(other.x, other.x + other.width / 2, other.x + other.width)
    yCandidates.push(other.y, other.y + other.height / 2, other.y + other.height)
  }

  const snappedX = snapAxis(xEdges, xCandidates, 'x')
  const snappedY = snapAxis(yEdges, yCandidates, 'y')

  const dx = Math.abs(gridDx) <= threshold ? gridDx : 0
  const dy = Math.abs(gridDy) <= threshold ? gridDy : 0

  return {
    x: rect.x + (snappedX.delta ?? dx),
    y: rect.y + (snappedY.delta ?? dy),
    guides: [snappedX.guide, snappedY.guide].filter(
      (guide): guide is SnapGuide => guide !== null
    ),
  }
}

/** 适应窗口：把外接矩形放进视口，返回 zoom 与 pan（世界原点对齐视口左上角） */
export function fitView(
  bounds: Rect | null,
  viewport: { width: number; height: number },
  padding = FIT_PADDING
): { zoom: number; pan: Point } {
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) {
    return { zoom: 1, pan: { x: padding, y: padding } }
  }
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min(
        availableWidth / Math.max(1, bounds.width),
        availableHeight / Math.max(1, bounds.height)
      )
    )
  )
  const pan = {
    x: padding - bounds.x * zoom + (availableWidth - bounds.width * zoom) / 2,
    y: padding - bounds.y * zoom + (availableHeight - bounds.height * zoom) / 2,
  }
  return { zoom, pan }
}

/** 缩放时保持光标下的世界坐标不动：返回新的 pan */
export function zoomAt(
  current: { zoom: number; pan: Point },
  nextZoom: number,
  point: Point
): { zoom: number; pan: Point } {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom))
  if (zoom === current.zoom) return { zoom: current.zoom, pan: current.pan }
  const worldX = (point.x - current.pan.x) / current.zoom
  const worldY = (point.y - current.pan.y) / current.zoom
  return {
    zoom,
    pan: { x: point.x - worldX * zoom, y: point.y - worldY * zoom },
  }
}
