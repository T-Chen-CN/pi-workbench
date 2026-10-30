import { describe, expect, it } from 'vitest'
import type { RepoMapFile } from '../src/types/electron'
import type { CanvasNodeInput } from '../src/utils/repoMapLayout'
import {
  CHAIN_MAX_ROWS,
  COLUMN_GAP,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_SIZES,
  ROOT_COLUMNS,
  ROOT_FILE_GAP,
  DEPTH_GAP,
  ROOT_GAP,
  SIBLING_GAP,
  ancestorFolders,
  boundsOf,
  buildCanvasTree,
  chainLevelGrid,
  collectFiles,
  fitView,
  intersects,
  chainLayout,
  nextChain,
  nodeId,
  rectOf,
  snapToGuides,
  topLevelLayout,
  zoomAt,
  type Rect,
} from '../src/utils/repoMapLayout'

function file(path: string): RepoMapFile {
  return { path, role: 'other', binary: false, size: 0, mtimeMs: 0, described: true }
}

const FILES: RepoMapFile[] = [
  file('AGENTS.md'),
  file('package.json'),
  file('electron/main.ts'),
  file('electron/preload.cts'),
  file('electron/ipc/git.ts'),
  file('src/App.tsx'),
  file('src/store/editorStore.ts'),
  file('src/components/EditorTabs.tsx'),
  file('docs/README.md'),
]

const noPersisted = { folders: {}, files: {} }

const tree = buildCanvasTree(FILES)

function rectsOf(
  positions: Map<string, { x: number; y: number }>,
  nodes: CanvasNodeInput[]
) {
  return nodes
    .map((item) => {
      const point = positions.get(nodeId(item))
      return point ? rectOf(item, point) : null
    })
    .filter((rect): rect is Rect => rect !== null)
}

function expectNoOverlap(rects: Rect[]) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(intersects(rects[i], rects[j])).toBe(false)
    }
  }
}

describe('buildCanvasTree', () => {
  it('把扁平文件列表折成目录树，目录带递归文件数', () => {
    expect(tree.children.get(null)?.map((item) => item.path)).toEqual([
      'docs',
      'electron',
      'src',
      'AGENTS.md',
      'package.json',
    ])
    expect(tree.children.get('src')?.map((item) => item.path)).toEqual([
      'src/components',
      'src/store',
      'src/App.tsx',
    ])
    expect(tree.nodes.find((item) => item.path === 'electron')?.fileCount).toBe(3)
  })

  it('同类节点按路径稳定排序，不依赖输入顺序', () => {
    const reversed = buildCanvasTree([...FILES].reverse())
    expect(reversed.children.get('electron')?.map((item) => item.path)).toEqual(
      tree.children.get('electron')?.map((item) => item.path)
    )
  })

  it('同一个目录只生成一个目录节点', () => {
    const folders = tree.nodes.filter((item) => item.kind === 'folder')
    expect(folders.map((item) => item.path)).toEqual([
      'docs',
      'electron',
      'electron/ipc',
      'src',
      'src/components',
      'src/store',
    ])
  })
})

describe('topLevelLayout', () => {
  it('只排顶层：目录在前、根文件在后', () => {
    const layout = topLevelLayout(tree, noPersisted)
    expect(layout.nodes.map((item) => item.path)).toEqual([
      'docs',
      'electron',
      'src',
      'AGENTS.md',
      'package.json',
    ])
  })

  it('顶层目录按行优先固定网格：每行 ROOT_COLUMNS 个，列距 COLUMN_GAP、行距 ROOT_GAP', () => {
    const layout = topLevelLayout(tree, noPersisted)
    const docs = layout.positions.get('folder:docs')!
    const electron = layout.positions.get('folder:electron')!
    const src = layout.positions.get('folder:src')!
    expect(docs).toEqual({ x: 0, y: 0 })
    expect(electron).toEqual({ x: NODE_SIZES.folder.width + COLUMN_GAP, y: 0 })
    expect(src).toEqual({
      x: (NODE_SIZES.folder.width + COLUMN_GAP) * 2,
      y: 0
    })
  })

  it('超过 ROOT_COLUMNS 个就换行（从左到右填，不按列堆）', () => {
    const many = buildCanvasTree(
      Array.from({ length: 9 }, (_, index) => file(`dir${index}/a.ts`))
    )
    const layout = topLevelLayout(many, noPersisted)
    const point = (path: string) => layout.positions.get(`folder:${path}`)!
    const step = NODE_SIZES.folder.width + COLUMN_GAP
    const rowStep = NODE_SIZES.folder.height + ROOT_GAP
    expect(ROOT_COLUMNS).toBe(4)
    expect(point('dir0')).toEqual({ x: 0, y: 0 })
    expect(point('dir3')).toEqual({ x: step * 3, y: 0 })
    expect(point('dir4')).toEqual({ x: 0, y: rowStep })
    expect(point('dir8')).toEqual({ x: 0, y: rowStep * 2 })
  })

  it('根文件排自己的网格，左对齐、整块在文件夹块下方隔 ROOT_FILE_GAP', () => {
    const layout = topLevelLayout(tree, noPersisted)
    // 3 个目录只占 1 行
    const folderBottom = NODE_SIZES.folder.height
    const firstFile = layout.positions.get('file:AGENTS.md')!
    const secondFile = layout.positions.get('file:package.json')!
    expect(firstFile).toEqual({ x: 0, y: folderBottom + ROOT_FILE_GAP })
    expect(secondFile).toEqual({
      x: NODE_SIZES.file.width + COLUMN_GAP,
      y: folderBottom + ROOT_FILE_GAP
    })
  })

  it('根文件同样每行 ROOT_COLUMNS 个，行距 SIBLING_GAP', () => {
    const many = buildCanvasTree(Array.from({ length: 20 }, (_, i) => file(`root${String(i).padStart(2, '0')}.md`)))
    const layout = topLevelLayout(many, noPersisted)
    const point = (path: string) => layout.positions.get(`file:${path}`)!
    const step = NODE_SIZES.file.width + COLUMN_GAP
    const rowStep = NODE_SIZES.file.height + SIBLING_GAP
    expect(point('root00.md')).toEqual({ x: 0, y: 0 })
    expect(point('root03.md')).toEqual({ x: step * 3, y: 0 })
    expect(point('root04.md')).toEqual({ x: 0, y: rowStep })
    expectNoOverlap(rectsOf(layout.positions, layout.nodes))
  })

  it('固定规则：形状只由数量决定，与文件顺序无关', () => {
    const build = (paths: string[]) =>
      topLevelLayout(buildCanvasTree(paths.map((path) => file(path))), noPersisted)
    const a = build(['a/x.ts', 'b/x.ts', 'c/x.ts'])
    const b = build(['c/x.ts', 'b/x.ts', 'a/x.ts'])
    expect([...a.positions.entries()].sort()).toEqual([...b.positions.entries()].sort())
  })

  it('落盘坐标覆盖自动位置，且不影响别的卡', () => {
    const layout = topLevelLayout(tree, {
      folders: { electron: { x: 500, y: 300 } },
      files: {},
    })
    expect(layout.positions.get('folder:electron')).toEqual({ x: 500, y: 300 })
    expect(layout.positions.get('folder:docs')).toEqual({ x: 0, y: 0 })
  })

  it('空仓库不炸', () => {
    const layout = topLevelLayout(buildCanvasTree([]), noPersisted)
    expect(layout.nodes).toEqual([])
    expect(layout.positions.size).toBe(0)
  })
})

describe('chainLayout（上浮链的右侧阶梯）', () => {
  const base = topLevelLayout(tree, noPersisted)

  it('没有链时不产出任何节点', () => {
    const result = chainLayout(tree, base.positions, [])
    expect(result.nodes).toEqual([])
    expect(result.elevated.size).toBe(0)
  })

  it('给出抬升层级：链根 0、子项 1、再下一层 2，最深一层等于链长', () => {
    const base = topLevelLayout(tree, { folders: {}, files: {} })

    const one = chainLayout(tree, base.positions, [])
    expect(one.maxDepth).toBe(0)
    expect(one.depths.size).toBe(0)

    const src = chainLayout(tree, base.positions, ['src'])
    expect(src.maxDepth).toBe(1)
    expect(src.depths.get('folder:src')).toBe(0)
    for (const kid of tree.children.get('src')!) expect(src.depths.get(nodeId(kid))).toBe(1)

    const deep = chainLayout(tree, base.positions, ['src', 'src/components'])
    expect(deep.maxDepth).toBe(2)
    expect(deep.depths.get('folder:src')).toBe(0)
    expect(deep.depths.get('folder:src/components')).toBe(1)
    for (const kid of tree.children.get('src/components')!) {
      expect(deep.depths.get(nodeId(kid))).toBe(2)
    }
  })

  it('链根目录用底层坐标原地抬起，子项在右侧成一块、与父卡纵向居中', () => {
    const result = chainLayout(tree, base.positions, ['electron'])
    const parent = base.positions.get('folder:electron')!
    expect(result.positions.get('folder:electron')).toEqual(parent)

    const kids = tree.children.get('electron')!
    const childX = parent.x + NODE_SIZES.folder.width + DEPTH_GAP
    for (const kid of kids) {
      expect(result.positions.get(nodeId(kid))?.x).toBe(childX)
    }
    const rects = kids.map((kid) => rectOf(kid, result.positions.get(nodeId(kid))!))
    const top = Math.min(...rects.map((rect) => rect.y))
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
    // 子块中线 = 父卡中线（不再贴父卡上沿，所以块高时会长到父卡上方）
    expect((top + bottom) / 2).toBe(parent.y + NODE_SIZES.folder.height / 2)
  })

  it('多级链逐层向右，每层相对自己的父卡居中', () => {
    const result = chainLayout(tree, base.positions, ['electron', 'electron/ipc'])
    const root = base.positions.get('folder:electron')!
    const ipc = result.positions.get('folder:electron/ipc')!
    expect(ipc.x).toBe(root.x + NODE_SIZES.folder.width + DEPTH_GAP)

    const grandchild = result.positions.get('file:electron/ipc/git.ts')!
    expect(grandchild.x).toBe(ipc.x + NODE_SIZES.folder.width + DEPTH_GAP)
    // 单个子项（64）比父卡（76）矮 → 在父卡高度内居中
    expect(grandchild.y).toBe(
      ipc.y + (NODE_SIZES.folder.height - NODE_SIZES.file.height) / 2
    )
  })

  it('多开一层不移动上一层的子项（每层只在右侧追加新列）', () => {
    const base = topLevelLayout(tree, { folders: {}, files: {} })
    const one = chainLayout(tree, base.positions, ['src'])
    const two = chainLayout(tree, base.positions, ['src', 'src/components'])

    for (const kid of tree.children.get('src')!) {
      expect(two.positions.get(nodeId(kid))).toEqual(one.positions.get(nodeId(kid)))
    }
    // 链根同样原地不动
    expect(two.positions.get('folder:src')).toEqual(one.positions.get('folder:src'))
    // 第二层只新增自己的子项，且都在更右一列
    const extra = two.nodes.filter((node) => !one.elevated.has(nodeId(node)))
    expect(extra.length).toBeGreaterThan(0)
    for (const node of extra) {
      expect(two.positions.get(nodeId(node))!.x).toBeGreaterThan(
        two.positions.get('folder:src/components')!.x
      )
    }
  })

  it('anchor 指向链尾那张锚卡，链空时为 null', () => {
    expect(chainLayout(tree, base.positions, []).anchor).toBeNull()

    const one = chainLayout(tree, base.positions, ['src'])
    expect(one.anchor).toBe('folder:src')

    // 每层都有一个自己的锚卡：第 2 层的锚是第 2 层那张文件夹卡，不是链根
    const two = chainLayout(tree, base.positions, ['src', 'src/store'])
    expect(two.anchor).toBe('folder:src/store')
    expect(two.focus.has(two.anchor!)).toBe(true)
  })

  it('当前层只含链尾文件夹卡与它的直接子项，不含同级兄弟', () => {
    const base = topLevelLayout(tree, { folders: {}, files: {} })

    const one = chainLayout(tree, base.positions, ['src'])
    expect(one.focus.has('folder:src')).toBe(true)
    for (const kid of tree.children.get('src')!) expect(one.focus.has(nodeId(kid))).toBe(true)

    const two = chainLayout(tree, base.positions, ['src', 'src/store'])
    expect(two.focus.has('folder:src/store')).toBe(true)
    for (const kid of tree.children.get('src/store')!) expect(two.focus.has(nodeId(kid))).toBe(true)
    // 链尾的同级兄弟不算当前层
    expect(two.focus.has('folder:src')).toBe(false)
    expect(two.focus.has('file:src/App.tsx')).toBe(false)
  })

  it('链上节点都标记为 elevated，链外节点一个不碰', () => {
    const result = chainLayout(tree, base.positions, ['src', 'src/store'])
    const ids = result.nodes.map((node) => nodeId(node))
    expect(ids).toContain('folder:src')
    expect(ids).toContain('folder:src/store')
    expect(ids).toContain('file:src/App.tsx')
    expect(ids).toContain('file:src/store/editorStore.ts')
    expect(ids).not.toContain('folder:docs')
    for (const id of ids) expect(result.elevated.has(id)).toBe(true)
  })

  it('链根目录不在底层时返回空（例如路径已失效）', () => {
    const result = chainLayout(tree, base.positions, ['nope'])
    expect(result.nodes).toEqual([])
  })

  it('同一层内不重叠（跨层是刻意的覆盖）', () => {
    const result = chainLayout(tree, base.positions, ['src', 'src/store'])
    const byDepth = new Map<number, Rect[]>()
    for (const node of result.nodes) {
      const depth = result.depths.get(nodeId(node))!
      const rect = rectOf(node, result.positions.get(nodeId(node))!)
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), rect])
    }
    for (const rects of byDepth.values()) expectNoOverlap(rects)
  })

  it('子项超过 CHAIN_MAX_ROWS 就折列，不再是一根长柱', () => {
    const many = buildCanvasTree(
      Array.from({ length: 20 }, (_, index) => file(`big/f${String(index).padStart(2, '0')}.ts`))
    )
    const baseMany = topLevelLayout(many, noPersisted)
    const result = chainLayout(many, baseMany.positions, ['big'])
    const parent = baseMany.positions.get('folder:big')!
    const pointOf = (name: string) => result.positions.get(`file:big/${name}`)!
    const columnStep = NODE_SIZES.file.width + COLUMN_GAP
    const rowStep = NODE_SIZES.file.height + SIBLING_GAP

    expect(CHAIN_MAX_ROWS).toBe(8)
    // 第 1、9、17 张分别是三列的第一行
    expect(pointOf('f00.ts').x).toBe(parent.x + NODE_SIZES.folder.width + DEPTH_GAP)
    expect(pointOf('f08.ts').x).toBe(pointOf('f00.ts').x + columnStep)
    expect(pointOf('f16.ts').x).toBe(pointOf('f00.ts').x + columnStep * 2)
    expect(pointOf('f08.ts').y).toBe(pointOf('f00.ts').y)
    expect(pointOf('f07.ts').y).toBe(pointOf('f00.ts').y + rowStep * 7)
  })

  it('块高时往上下两边长，坐标仍是整数且与父卡居中', () => {
    const many = buildCanvasTree(
      Array.from({ length: 20 }, (_, index) => file(`big/f${String(index).padStart(2, '0')}.ts`))
    )
    const baseMany = topLevelLayout(many, noPersisted)
    const result = chainLayout(many, baseMany.positions, ['big'])
    const parent = baseMany.positions.get('folder:big')!
    const kids = many.children.get('big')!
    const rects = kids.map((kid) => rectOf(kid, result.positions.get(nodeId(kid))!))
    const top = Math.min(...rects.map((rect) => rect.y))
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))

    // 20 张 / 8 行 = 3 列，块高 8 × 76 − 12 = 596 → 父卡（高 76）上方 -260
    expect((top + bottom) / 2).toBe(parent.y + NODE_SIZES.folder.height / 2)
    expect(top).toBeLessThan(parent.y)
    expect(Number.isInteger(top)).toBe(true)
    for (const point of result.positions.values()) {
      expect(Number.isInteger(point.x)).toBe(true)
      expect(Number.isInteger(point.y)).toBe(true)
    }
  })
})

describe('chainLevelGrid（一层折列）', () => {
  const kid = (path: string, kind: 'folder' | 'file'): CanvasNodeInput => ({
    path,
    kind,
    parent: null
  })

  it('一层只有几到十几张时是单列', () => {
    const kids = Array.from({ length: 5 }, (_, index) => kid(`f${index}.ts`, 'file'))
    const grid = chainLevelGrid(kids)
    expect(new Set(grid.points.map((point) => point.x))).toEqual(new Set([0]))
    expect(grid.points.map((point) => point.y)).toEqual([0, 76, 152, 228, 304])
    expect(grid.width).toBe(NODE_SIZES.file.width)
    expect(grid.height).toBe(5 * NODE_SIZES.file.height + 4 * SIBLING_GAP)
  })

  it('列宽取最宽的卡片，文件夹与文件混排也不重叠', () => {
    const kids = [kid('sub', 'folder'), kid('a.ts', 'file'), kid('b.ts', 'file')]
    const grid = chainLevelGrid(kids)
    // 文件夹 76 高、文件 64 高，按各自高度累加
    expect(grid.points.map((point) => point.y)).toEqual([0, 88, 164])
    expect(grid.width).toBe(NODE_SIZES.file.width)
    expect(grid.height).toBe(164 + NODE_SIZES.file.height)
    expectNoOverlap(
      kids.map((node, index) => rectOf(node, grid.points[index]))
    )
  })

  it('空层不产出任何东西', () => {
    expect(chainLevelGrid([])).toEqual({ points: [], width: 0, height: 0 })
  })
})

describe('nextChain', () => {
  it('空链点顶层目录 → 开一层', () => {
    expect(nextChain([], tree, 'src')).toEqual(['src'])
  })

  it('点链上目录的子目录 → 再开一层', () => {
    expect(nextChain(['src'], tree, 'src/store')).toEqual(['src', 'src/store'])
  })

  it('点已展开的目录 → 收起它和它的下游', () => {
    expect(nextChain(['src', 'src/store'], tree, 'src/store')).toEqual(['src'])
    expect(nextChain(['src', 'src/store'], tree, 'src')).toEqual([])
  })

  it('点同一层的另一个子目录 → 切分支，前面的层保留', () => {
    expect(nextChain(['src', 'src/store'], tree, 'src/components')).toEqual([
      'src',
      'src/components'
    ])
    expect(nextChain(['src'], tree, 'src/components')).toEqual(['src', 'src/components'])
  })

  it('点链外目录 / 深层目录不改链', () => {
    const chain = ['src']
    expect(nextChain(chain, tree, 'docs')).toBe(chain)
    expect(nextChain(chain, tree, 'src/components/EditorTabs.tsx')).toBe(chain)
    expect(nextChain([], tree, 'src/store')).toEqual([])
  })
})

describe('collectFiles / ancestorFolders', () => {
  it('collectFiles 收集目录下所有层级的文件', () => {
    const paths = collectFiles(tree, 'electron').map((item) => item.path)
    expect(paths.sort()).toEqual(['electron/ipc/git.ts', 'electron/main.ts', 'electron/preload.cts'])
  })

  it('ancestorFolders 返回浅到深的祖先目录', () => {
    expect(ancestorFolders('src/store/editorStore.ts')).toEqual(['src', 'src/store'])
    expect(ancestorFolders('AGENTS.md')).toEqual([])
  })
})

describe('boundsOf / fitView / zoomAt', () => {
  it('boundsOf 计算外接矩形', () => {
    expect(
      boundsOf([
        { x: 10, y: 20, width: 100, height: 50 },
        { x: 60, y: 40, width: 100, height: 50 },
      ])
    ).toEqual({ x: 10, y: 20, width: 150, height: 70 })
    expect(boundsOf([])).toBeNull()
  })

  it('fitView 把内容居中并留白', () => {
    const view = fitView({ x: 0, y: 0, width: 400, height: 200 }, { width: 800, height: 600 })
    expect(view.zoom).toBeGreaterThan(MIN_ZOOM)
    // 内容中心落在视口中心
    expect(200 * view.zoom + view.pan.x).toBeCloseTo(400, 0)
    expect(100 * view.zoom + view.pan.y).toBeCloseTo(300, 0)
  })

  it('fitView 没有内容时返回兜底视口', () => {
    expect(fitView(null, { width: 800, height: 600 })).toEqual({ zoom: 1, pan: { x: 48, y: 48 } })
  })

  it('zoomAt 保持光标下的世界坐标不动', () => {
    const start = { zoom: 1, pan: { x: 0, y: 0 } }
    const next = zoomAt(start, 2, { x: 100, y: 50 })
    expect(next.zoom).toBe(2)
    // 光标处的世界坐标 (100, 50) 在缩放后仍落在同一个屏幕位置
    expect(100 * next.zoom + next.pan.x).toBeCloseTo(100, 5)
    expect(50 * next.zoom + next.pan.y).toBeCloseTo(50, 5)
  })

  it('zoomAt 钳制在 25%–200%', () => {
    expect(zoomAt({ zoom: 1, pan: { x: 0, y: 0 } }, 10, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM)
    expect(zoomAt({ zoom: 1, pan: { x: 0, y: 0 } }, 0.01, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM)
  })
})

describe('snapToGuides', () => {
  const other: Rect = { x: 200, y: 100, width: 100, height: 50 }

  it('靠近别的卡片的左边会吸附并给出参考线', () => {
    const result = snapToGuides(
      { x: 203, y: 300, width: 100, height: 50 },
      [other],
      { threshold: 6 }
    )
    expect(result.x).toBe(200)
    expect(result.guides.some((guide) => guide.axis === 'x')).toBe(true)
  })

  it('中线对齐也能吸附', () => {
    const result = snapToGuides(
      { x: 246, y: 300, width: 100, height: 50 },
      [other],
      { threshold: 6 }
    )
    // 左 246 与 other 的中线 250 差 4px（阈值内）→ 吸附到 250
    expect(result.x).toBe(250)
  })

  it('远离时退化成网格吸附', () => {
    const result = snapToGuides(
      { x: 1003, y: 500, width: 100, height: 50 },
      [other],
      { threshold: 6 }
    )
    expect(result.x % 8).toBe(0)
    expect(result.guides).toEqual([])
  })

  it('阈值按 zoom 折算后手感一致', () => {
    const rect = { x: 204, y: 300, width: 100, height: 50 }
    expect(snapToGuides(rect, [other], { threshold: 6 / 0.5 }).x).toBe(200)
    expect(snapToGuides(rect, [other], { threshold: 0.5 }).x).not.toBe(200)
  })
})
