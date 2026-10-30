/**
 * 仓库地图画布：**底层地图 + 卡片上浮**。
 *
 * - 底层只有顶层节点（顶层文件夹 + 根目录文件），排一次就固定；拖动 / 缩放 / 平移**落盘**；
 * - 点开文件夹时**那张卡原地抬起**（位置 / 尺寸 / 缩放都不变），子项在它右侧用同一套
 *   世界坐标长出来；再点一层继续往右，形成一条向右阶梯。没有浮层窗口、没有第二套视口；
 * - 链上卡片的拖动只在本次会话生效（不落盘），收起链即回到自动阶梯。
 *
 * 拖动 / 缩放期间直接改 DOM，松手才提交状态 —— 60fps 的交互不经过 React。
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RepoMapCanvasState, RepoMapFile } from '../types/electron'
import { useI18nStore } from '../store/i18nStore'
import { createRepoMapCanvasSaver, loadRepoMapCanvas } from '../workspace/repoMapCanvas'
import {
  describeRepoMapFile,
  repoMapBaseName,
  repoMapRoleKey,
  type Translate,
} from '../utils/repoMapText'
import { lodForZoom } from '../utils/repoMapLod'
import {
  SNAP_THRESHOLD,
  ancestorFolders,
  boundsOf,
  buildCanvasTree,
  chainLayout,
  collectFiles,
  fitView,
  nextChain,
  nodeId,
  rectOf,
  sizeOf,
  snapToGuides,
  topLevelLayout,
  zoomAt,
  type CanvasNodeInput,
  type Chain,
  type Point,
  type Rect,
  type SnapGuide,
} from '../utils/repoMapLayout'
import {
  canvasStateEquals,
  migrateCanvasLayout,
  persistedPositionsFor,
  pruneCanvasState,
} from '../utils/repoMapCanvasState'
import { Caption } from './ui'
import { RepoMapMinimap } from './RepoMapMinimap'
import { RepoMapNodeCard } from './RepoMapNodeCard'

export { lodForZoom } from '../utils/repoMapLod'

/** 拖动超过这个像素才算「拖」，否则当点击 */
const DRAG_THRESHOLD_PX = 3
/** 键盘 / 按钮缩放的步长 */
const ZOOM_STEP = 1.2
/** 方向键平移距离 */
const PAN_STEP = 96
/** 镜头跟随的视口留白 */
const REVEAL_PADDING = 24

export interface RepoMapCanvasHandle {
  fit: () => void
  resetLayout: () => void
  /** 按倍率缩放（工具条的 +/- 按钮） */
  zoomBy: (factor: number) => void
}

export interface RepoMapCanvasProps {
  workspacePath: string
  files: RepoMapFile[]
  /** 搜索词：命中亮点亮、其余淡出，并自动把祖先目录逐层抬起来 */
  query: string
  onOpenFile: (file: RepoMapFile) => void
  /** 降级模式下补齐描述 */
  onEnsureDescribed: (paths: string[]) => void
  onZoomChange?: (zoom: number) => void
}

function hasAnyPosition(state: RepoMapCanvasState): boolean {
  return Object.keys(state.folders).length > 0 || Object.keys(state.files).length > 0
}

export const RepoMapCanvas = forwardRef<RepoMapCanvasHandle, RepoMapCanvasProps>(
  function RepoMapCanvas(
    { workspacePath, files, query, onOpenFile, onEnsureDescribed, onZoomChange },
    ref
  ) {
    const { t, language } = useI18nStore()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const stageRef = useRef<HTMLDivElement | null>(null)
    const guideXRef = useRef<HTMLDivElement | null>(null)
    const guideYRef = useRef<HTMLDivElement | null>(null)
    const stateRef = useRef<RepoMapCanvasState | null>(null)
    const viewRef = useRef<{ zoom: number; pan: Point }>({ zoom: 1, pan: { x: 0, y: 0 } })
    const saverRef = useRef(createRepoMapCanvasSaver(workspacePath))
    /** 上浮链上卡片的手动位置：只在本次会话有效，收起链即清空 */
    const sessionRef = useRef<Map<string, Point>>(new Map())
    const dragRef = useRef<{
      id: string
      path: string
      kind: 'folder' | 'file'
      element: HTMLElement
      startClientX: number
      startClientY: number
      originX: number
      originY: number
      current: Point
      moved: boolean
      width: number
      height: number
    } | null>(null)
    const panRef = useRef<{
      startClientX: number
      startClientY: number
      origin: Point
      moved: boolean
      /** 是不是「空格 + 左键」的平移；否则这次按下只用来判定「点了空白」 */
      canPan: boolean
      /** 按在空白上（而不是卡片 / 小地图上） */
      fromBackground: boolean
    } | null>(null)
    /** 空格手形工具：按住空格时画布只认平移，卡片全部让位 */
    const spaceRef = useRef(false)
    const [spaceHeld, setSpaceHeld] = useState(false)
    const [panning, setPanning] = useState(false)
    const suppressClickRef = useRef(false)
    const frameRef = useRef<number | null>(null)
    const pendingFitRef = useRef(false)
    const [loaded, setLoaded] = useState(false)
    const [revision, setRevision] = useState(0)
    const [chain, setChain] = useState<Chain>([])
    const [viewportRect, setViewportRect] = useState<Rect>({ x: 0, y: 0, width: 1, height: 1 })

    const tree = useMemo(() => buildCanvasTree(files), [files])
    const fileByPath = useMemo(() => {
      const map = new Map<string, RepoMapFile>()
      for (const file of files) map.set(file.path, file)
      return map
    }, [files])
    const tRef = useRef(t)
    tRef.current = t
    const languageRef = useRef(language)
    languageRef.current = language
    const treeRef = useRef(tree)
    treeRef.current = tree
    const chainRef = useRef(chain)
    chainRef.current = chain

    const describe = useCallback(
      (file: RepoMapFile) =>
        describeRepoMapFile(file, tRef.current as Translate, languageRef.current),
      []
    )

    const layout = useMemo(() => {
      // stateRef 是可变引用：用 revision 明确表达「状态已提交」这件事
      void revision
      return topLevelLayout(tree, persistedPositionsFor(stateRef.current))
    }, [tree, revision])

    const layoutRef = useRef(layout)
    layoutRef.current = layout

    const chainResult = useMemo(
      () => chainLayout(tree, layout.positions, chain),
      [tree, layout, chain]
    )

    /** 链上节点的最终位置 = 自动阶梯 + 本会话里拖过的位置 */
    const chainPositions = useMemo(() => {
      void revision
      const merged = new Map(chainResult.positions)
      for (const [id, point] of sessionRef.current) {
        if (merged.has(id)) merged.set(id, { x: point.x, y: point.y })
      }
      return merged
    }, [chainResult, revision])

    const baseNodes = useMemo(
      () => layout.nodes.filter((node) => !chainResult.elevated.has(nodeId(node))),
      [layout, chainResult]
    )

    const rectsOf = useCallback(
      (nodes: CanvasNodeInput[], positions: Map<string, Point>): Rect[] =>
        nodes
          .map((node) => {
            const point = positions.get(nodeId(node))
            return point ? rectOf(node, point) : null
          })
          .filter((rect): rect is Rect => rect !== null),
      []
    )

    const baseRects = useMemo(
      () => rectsOf(baseNodes, layout.positions),
      [baseNodes, layout, rectsOf]
    )
    const chainRects = useMemo(
      () => rectsOf(chainResult.nodes, chainPositions),
      [chainResult, chainPositions, rectsOf]
    )
    const allRects = useMemo(() => [...baseRects, ...chainRects], [baseRects, chainRects])

    const save = useCallback((state: RepoMapCanvasState) => {
      saverRef.current.save(state)
    }, [])

    const worldViewport = useCallback((): Rect => {
      const element = viewportRef.current
      const width = element?.clientWidth ?? 1
      const height = element?.clientHeight ?? 1
      const view = viewRef.current
      return {
        x: -view.pan.x / view.zoom,
        y: -view.pan.y / view.zoom,
        width: width / view.zoom,
        height: height / view.zoom,
      }
    }, [])

    const applyView = useCallback((animate = false) => {
      const stage = stageRef.current
      const view = viewRef.current
      if (stage) {
        stage.style.transition = animate ? 'transform 160ms ease-out' : ''
        stage.style.transform = `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`
      }
      const viewport = viewportRef.current
      if (viewport) {
        viewport.dataset.zoomLod = lodForZoom(view.zoom)
        // 点阵底跟手：平移同步位移，缩放同步间距
        viewport.style.backgroundPosition = `${view.pan.x}px ${view.pan.y}px`
        viewport.style.backgroundSize = `${24 * view.zoom}px ${24 * view.zoom}px`
      }
    }, [])

    /** 视口变化后按帧节流同步给 React（小地图 / 百分比），避免每像素一次渲染 */
    const scheduleSync = useCallback(() => {
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        setViewportRect(worldViewport())
        onZoomChange?.(viewRef.current.zoom)
      })
    }, [onZoomChange, worldViewport])

    const commitView = useCallback(
      (immediate = false) => {
        const state = stateRef.current
        if (!state) return
        state.zoom = viewRef.current.zoom
        state.pan = { ...viewRef.current.pan }
        if (immediate) void saverRef.current.flush()
        else save(state)
      },
      [save]
    )

    const fit = useCallback(() => {
      const viewport = viewportRef.current
      if (!viewport) return
      const next = fitView(boundsOf(allRects), {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      })
      viewRef.current = next
      applyView()
      scheduleSync()
      commitView()
    }, [allRects, applyView, commitView, scheduleSync])

    const resetLayout = useCallback(() => {
      const state = stateRef.current
      if (!state) return
      state.folders = {}
      state.files = {}
      sessionRef.current.clear()
      setChain([])
      pendingFitRef.current = true
      // 还原是显式动作：立刻落盘，不留 400ms 的窗口
      save(state)
      void saverRef.current.flush()
      setRevision((value) => value + 1)
    }, [save])

    // 加载落盘的底层状态；没有位置时铺完自动适应窗口
    useEffect(() => {
      let cancelled = false
      setLoaded(false)
      saverRef.current = createRepoMapCanvasSaver(workspacePath)
      void loadRepoMapCanvas(workspacePath).then((loadedState) => {
        if (cancelled) return
        const migrated = migrateCanvasLayout(loadedState)
        stateRef.current = migrated
        viewRef.current = { zoom: migrated.zoom, pan: { ...migrated.pan } }
        // 迁移只丢折叠态、不丢坐标：视口照旧；只有完全没摆过才自动适应窗口
        pendingFitRef.current = !hasAnyPosition(migrated)
        if (migrated !== loadedState) save(migrated)
        sessionRef.current.clear()
        setChain([])
        setLoaded(true)
        setRevision((value) => value + 1)
      })
      return () => {
        cancelled = true
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current)
          frameRef.current = null
        }
        const state = stateRef.current
        if (state) void saverRef.current.flush()
        saverRef.current.dispose()
      }
    }, [workspacePath, save])

    // 扫描结果变化：只留顶层坐标（深层坐标是旧版本遗留）
    useEffect(() => {
      const state = stateRef.current
      if (!state) return
      const topFolders: string[] = []
      const topFiles: string[] = []
      for (const node of tree.children.get(null) ?? []) {
        if (node.kind === 'folder') topFolders.push(node.path)
        else topFiles.push(node.path)
      }
      const pruned = pruneCanvasState(state, { folders: topFolders, files: topFiles })
      if (canvasStateEquals(pruned, state)) return
      stateRef.current = pruned
      setRevision((value) => value + 1)
      save(pruned)
    }, [files, tree, save, loaded])

    // 链上目录失效（刷新后没了）→ 弹回最近一个仍存在的祖先
    useEffect(() => {
      if (chain.length === 0) return
      const invalid = chain.findIndex((path) => !tree.children.has(path))
      if (invalid < 0) return
      sessionRef.current.clear()
      setChain((current) => (invalid === 0 ? [] : current.slice(0, invalid)))
    }, [chain, tree])

    // 首次铺完（或还原布局后）适应窗口
    useEffect(() => {
      if (!loaded || !pendingFitRef.current) return
      pendingFitRef.current = false
      applyView()
      fit()
    }, [loaded, revision, applyView, fit])

    useEffect(() => {
      applyView()
      setViewportRect(worldViewport())
    }, [loaded, applyView, worldViewport])

    const matchIds = useMemo(() => {
      const needle = query.trim().toLowerCase()
      if (!needle) return null
      const matched = new Set<string>()
      for (const node of tree.nodes) {
        if (node.kind === 'folder') {
          if (node.path.toLowerCase().includes(needle)) matched.add(nodeId(node))
          continue
        }
        const file = fileByPath.get(node.path)
        const description = file ? describe(file).toLowerCase() : ''
        if (node.path.toLowerCase().includes(needle) || description.includes(needle)) {
          matched.add(nodeId(node))
        }
      }
      return matched
    }, [tree, fileByPath, query, describe])

    const showGuides = useCallback((guides: SnapGuide[]) => {
      const vertical = guides.find((guide) => guide.axis === 'x')
      const horizontal = guides.find((guide) => guide.axis === 'y')
      if (guideXRef.current) {
        guideXRef.current.style.opacity = vertical ? '1' : '0'
        if (vertical) guideXRef.current.style.left = `${vertical.position}px`
      }
      if (guideYRef.current) {
        guideYRef.current.style.opacity = horizontal ? '1' : '0'
        if (horizontal) guideYRef.current.style.top = `${horizontal.position}px`
      }
    }, [])

    const hideGuides = useCallback(() => {
      if (guideXRef.current) guideXRef.current.style.opacity = '0'
      if (guideYRef.current) guideYRef.current.style.opacity = '0'
    }, [])

    /**
     * 搜索定位用：命中卡如果完整落在视野里就什么都不做，否则把它**居中**平移过来
     * （只平移，不改缩放）。
     *
     * 注意：展开文件夹**不再调用它** —— 点开目录时镜头一动不动，父卡作为锚点必须留在原地，
     * 否则子块一大就会「整块居中」，把刚点的卡甩出视野。看全用 `0` / 工具条的「适应窗口」。
     */
    const centerOnRects = useCallback(
      (rects: Rect[]) => {
        const viewport = viewportRef.current
        const bounds = boundsOf(rects)
        if (!viewport || !bounds) return
        const view = viewRef.current
        const width = viewport.clientWidth
        const height = viewport.clientHeight
        const left = bounds.x * view.zoom + view.pan.x
        const top = bounds.y * view.zoom + view.pan.y
        const right = left + bounds.width * view.zoom
        const bottom = top + bounds.height * view.zoom
        if (
          left >= REVEAL_PADDING &&
          top >= REVEAL_PADDING &&
          right <= width - REVEAL_PADDING &&
          bottom <= height - REVEAL_PADDING
        ) {
          return
        }
        viewRef.current = {
          zoom: view.zoom,
          pan: {
            x: width / 2 - (bounds.x + bounds.width / 2) * view.zoom,
            y: height / 2 - (bounds.y + bounds.height / 2) * view.zoom,
          },
        }
        applyView(true)
        scheduleSync()
        commitView()
      },
      [applyView, commitView, scheduleSync]
    )

    /* ------------------------------ 上浮链 ------------------------------ */

    const openFolder = useCallback(
      (path: string) => {
        const currentTree = treeRef.current
        const current = chainRef.current
        const next = nextChain(current, currentTree, path)
        if (next === current) return
        sessionRef.current.clear()
        setChain(next)
        if (next.length <= current.length) return

        onEnsureDescribed(
          collectFiles(currentTree, path)
            .map((node) => node.path)
            .slice(0, 200)
        )

        // 展开只长卡片，**不动镜头**：父卡是锚点，镜头一跟随就会把它甩出视野
        // （子块一大就成了「整块居中」）。想看全就按 `0` / 工具条的「适应窗口」。
      },
      [onEnsureDescribed]
    )

    /** 退一层：空白单击与 `Esc` 共用这一段，保证两条路永远一致（链空时无动作） */
    const popLevel = useCallback(() => {
      if (chainRef.current.length === 0) return
      sessionRef.current.clear()
      setChain((current) => current.slice(0, -1))
    }, [])

    /* ------------------------------ 拖动 / 平移 ------------------------------ */

    const dragMoveRef = useRef<(event: PointerEvent) => void>(() => {})
    const dragEndRef = useRef<() => void>(() => {})
    const panMoveRef = useRef<(event: PointerEvent) => void>(() => {})
    const panEndRef = useRef<() => void>(() => {})
    const onWindowPointerMove = useCallback((event: PointerEvent) => {
      dragMoveRef.current(event)
      panMoveRef.current(event)
    }, [])
    const onWindowPointerUp = useCallback(() => {
      dragEndRef.current()
      panEndRef.current()
    }, [])

    const handleNodePointerDown = useCallback(
      (event: React.PointerEvent<HTMLElement>, node: CanvasNodeInput) => {
        if (event.button !== 0) return
        // 按住空格：这一笔归平移，卡片既不拖动也不点击
        if (spaceRef.current) return
        const elevated = chainResult.elevated.has(nodeId(node))
        if (!elevated && chainRef.current.length > 0) return
        const positions = elevated ? chainPositions : layoutRef.current.positions
        const point = positions.get(nodeId(node))
        if (!point) return
        const size = sizeOf(node.kind)
        dragRef.current = {
          id: nodeId(node),
          path: node.path,
          kind: node.kind,
          element: event.currentTarget as HTMLElement,
          startClientX: event.clientX,
          startClientY: event.clientY,
          originX: point.x,
          originY: point.y,
          current: point,
          moved: false,
          width: size.width,
          height: size.height,
        }
        window.addEventListener('pointermove', onWindowPointerMove)
        window.addEventListener('pointerup', onWindowPointerUp, { once: true })
      },
      [chainPositions, chainResult, onWindowPointerMove, onWindowPointerUp]
    )

    dragMoveRef.current = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startClientX
      const dy = event.clientY - drag.startClientY
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      const zoom = viewRef.current.zoom
      const rect: Rect = {
        x: drag.originX + dx / zoom,
        y: drag.originY + dy / zoom,
        width: drag.width,
        height: drag.height,
      }
      const others: Rect[] = []
      for (const other of [...baseRects, ...chainRects]) {
        if (
          Math.abs(other.x - rect.x) < 0.5 &&
          Math.abs(other.y - rect.y) < 0.5 &&
          other.width === rect.width
        ) {
          continue
        }
        others.push(other)
      }
      const snapped = snapToGuides(rect, others, { threshold: SNAP_THRESHOLD / zoom })
      drag.current = { x: snapped.x, y: snapped.y }
      drag.element.style.left = `${snapped.x}px`
      drag.element.style.top = `${snapped.y}px`
      drag.element.dataset.dragging = 'true'
      showGuides(snapped.guides)
    }

    dragEndRef.current = () => {
      window.removeEventListener('pointermove', onWindowPointerMove)
      const drag = dragRef.current
      dragRef.current = null
      hideGuides()
      if (!drag) return
      delete drag.element.dataset.dragging
      if (!drag.moved) return
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      // 链上卡片：只进本会话内存，不落盘
      if (chainRef.current.length > 0) {
        sessionRef.current.set(drag.id, { x: drag.current.x, y: drag.current.y })
        setRevision((value) => value + 1)
        return
      }

      const state = stateRef.current
      if (!state) return
      if (drag.kind === 'folder') {
        state.folders[drag.path] = { x: drag.current.x, y: drag.current.y }
      } else {
        state.files[drag.path] = { x: drag.current.x, y: drag.current.y }
      }
      save(state)
      setRevision((value) => value + 1)
    }

    panMoveRef.current = (event: PointerEvent) => {
      const pan = panRef.current
      if (!pan) return
      const dx = event.clientX - pan.startClientX
      const dy = event.clientY - pan.startClientY
      if (!pan.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        pan.moved = true
        if (pan.canPan) setPanning(true)
      }
      // 不按空格的空白左键：只记「有没有动过」，镜头一动不动
      if (!pan.canPan) return
      viewRef.current = {
        zoom: viewRef.current.zoom,
        pan: { x: pan.origin.x + dx, y: pan.origin.y + dy },
      }
      applyView()
      scheduleSync()
    }

    panEndRef.current = () => {
      window.removeEventListener('pointermove', onWindowPointerMove)
      const pan = panRef.current
      if (!pan) return
      panRef.current = null
      setPanning(false)
      if (pan.moved) {
        if (!pan.canPan) return
        commitView()
        // 空格平移常常是在卡片上抬手：拦掉随之而来的 click，别顺手把文件打开
        suppressClickRef.current = true
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
        return
      }
      // 没移动 = 一次点击：按住空格时画布什么点击都不吃；否则空白单击退一层（等价 Esc）
      if (!pan.canPan && pan.fromBackground) popLevel()
    }

    const handleViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      const onCard = Boolean(target.closest('[data-kind]'))
      const onMinimap = Boolean(target.closest('[data-testid="repo-map-minimap"]'))
      const space = spaceRef.current
      // 不按空格：卡片 / 小地图各自处理自己的手势，只有空白处记一笔「点击判定」
      if (!space && (onCard || onMinimap)) return
      panRef.current = {
        startClientX: event.clientX,
        startClientY: event.clientY,
        origin: { ...viewRef.current.pan },
        moved: false,
        canPan: space,
        fromBackground: !onCard && !onMinimap,
      }
      window.addEventListener('pointermove', onWindowPointerMove)
      window.addEventListener('pointerup', onWindowPointerUp, { once: true })
    }

    const zoomBy = useCallback(
      (factor: number) => {
        const viewport = viewportRef.current
        if (!viewport) return
        const point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
        viewRef.current = zoomAt(viewRef.current, viewRef.current.zoom * factor, point)
        applyView()
        scheduleSync()
        commitView()
      },
      [applyView, commitView, scheduleSync]
    )

    useImperativeHandle(ref, () => ({ fit, resetLayout, zoomBy }), [fit, resetLayout, zoomBy])

    const navigateTo = useCallback(
      (world: Point) => {
        if (spaceRef.current) return
        const viewport = viewportRef.current
        if (!viewport) return
        const zoom = viewRef.current.zoom
        viewRef.current = {
          zoom,
          pan: {
            x: viewport.clientWidth / 2 - world.x * zoom,
            y: viewport.clientHeight / 2 - world.y * zoom,
          },
        }
        applyView()
        scheduleSync()
        commitView()
      },
      [applyView, commitView, scheduleSync]
    )

    // 滚轮缩放：用原生监听器（React 的 wheel 是 passive，拦不住页面滚动）
    useEffect(() => {
      const viewport = viewportRef.current
      if (!viewport) return
      const handleWheel = (event: WheelEvent) => {
        event.preventDefault()
        const bounds = viewport.getBoundingClientRect()
        const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
        const factor = Math.exp(-event.deltaY * 0.0015)
        viewRef.current = zoomAt(viewRef.current, viewRef.current.zoom * factor, point)
        applyView()
        scheduleSync()
        commitView()
      }
      viewport.addEventListener('wheel', handleWheel, { passive: false })
      return () => viewport.removeEventListener('wheel', handleWheel)
    }, [applyView, commitView, scheduleSync])

    // 视口尺寸变化（窗口缩放 / 面板拖宽）：只更新小地图，不改用户的缩放
    useEffect(() => {
      const viewport = viewportRef.current
      if (!viewport) return
      const sync = () => setViewportRect(worldViewport())
      sync()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(sync)
      observer.observe(viewport)
      return () => observer.disconnect()
    }, [worldViewport])

    /* ------------------------------ 搜索定位 ------------------------------ */

    const revealFile = useCallback(
      (filePath: string) => {
        const currentTree = treeRef.current
        const ancestors = ancestorFolders(filePath).filter((folder) =>
          currentTree.children.has(folder)
        )
        if (ancestors.length === 0) return
        sessionRef.current.clear()
        setChain(ancestors)
        const nextLayout = chainLayout(currentTree, layoutRef.current.positions, ancestors)
        const point = nextLayout.positions.get(`file:${filePath}`)
        if (!point) return
        centerOnRects([rectOf({ path: filePath, kind: 'file', parent: null }, point)])
        onEnsureDescribed(
          collectFiles(currentTree, ancestors[0])
            .map((node) => node.path)
            .slice(0, 200)
        )
      },
      [onEnsureDescribed, centerOnRects]
    )

    const revealedRef = useRef('')
    useEffect(() => {
      if (!loaded) return
      const needle = query.trim().toLowerCase()
      if (!needle) {
        revealedRef.current = ''
        return
      }
      if (revealedRef.current === needle) return
      const first = tree.nodes.find((node) => node.kind === 'file' && matchIds?.has(nodeId(node)))
      if (!first) return
      revealedRef.current = needle
      revealFile(first.path)
    }, [loaded, query, matchIds, tree, revealFile])

    /* ------------------------------ 空格手形工具 ------------------------------ */

    // 平移只走「空格 + 左键」这一条路（Figma / Sketch 的手形工具）：按住空格时画布
    // 只认平移，卡片的点击 / 拖动 / 小地图跳转 / 双击适应窗口全部让位。
    // 监听挂在 window 上：焦点可能不在画布，而且必须赶在卡片（<button>）被空格激活之前拦掉。
    useEffect(() => {
      const isEditable = (target: EventTarget | null) => {
        const element = target as HTMLElement | null
        if (!element || !element.tagName) return false
        return (
          element.tagName === 'INPUT' ||
          element.tagName === 'TEXTAREA' ||
          element.isContentEditable
        )
      }
      const setHeld = (held: boolean) => {
        if (spaceRef.current === held) return
        spaceRef.current = held
        setSpaceHeld(held)
      }
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.code !== 'Space' || isEditable(event.target)) return
        // 拦掉滚动与「空格 = 激活按钮」，否则按住空格会顺手打开焦点所在的卡片
        event.preventDefault()
        setHeld(true)
      }
      const onKeyUp = (event: KeyboardEvent) => {
        if (event.code !== 'Space' || isEditable(event.target)) return
        event.preventDefault()
        setHeld(false)
      }
      // 切窗口 / 切标签 / 失焦：必须复位，否则空格状态会卡住（光标永远是手、卡片永远点不动）
      const reset = () => setHeld(false)
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', reset)
      document.addEventListener('visibilitychange', reset)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
        window.removeEventListener('blur', reset)
        document.removeEventListener('visibilitychange', reset)
      }
    }, [])

    /* ------------------------------ 键盘 ------------------------------ */

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && chainRef.current.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        popLevel()
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        fit()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(ZOOM_STEP)
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(1 / ZOOM_STEP)
        return
      }
      if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        const delta = {
          x: event.key === 'ArrowLeft' ? PAN_STEP : event.key === 'ArrowRight' ? -PAN_STEP : 0,
          y: event.key === 'ArrowUp' ? PAN_STEP : event.key === 'ArrowDown' ? -PAN_STEP : 0,
        }
        viewRef.current = {
          zoom: viewRef.current.zoom,
          pan: { x: viewRef.current.pan.x + delta.x, y: viewRef.current.pan.y + delta.y },
        }
        applyView()
        scheduleSync()
        commitView()
      }
    }

    /* ------------------------------ 渲染 ------------------------------ */

    const chainOpen = chain.length > 0

    const renderCard = (node: CanvasNodeInput, elevated: boolean) => {
      const positions = elevated ? chainPositions : layout.positions
      const point = positions.get(nodeId(node))
      if (!point) return null
      const id = nodeId(node)
      const file = node.kind === 'file' ? fileByPath.get(node.path) : undefined
      const matched = matchIds !== null && matchIds.has(id)
      const depth = elevated ? (chainResult.depths.get(id) ?? 0) : 0
      return (
        <RepoMapNodeCard
          key={id}
          node={node}
          point={point}
          name={repoMapBaseName(node.path)}
          description={file ? describe(file) : ''}
          countLabel={t('repoMapCanvasFolderCount', { count: node.fileCount ?? 0 })}
          role={file?.role ?? 'other'}
          roleLabel={t(repoMapRoleKey(file?.role ?? 'other'))}
          matched={matched}
          elevated={elevated}
          depth={depth}
          // 当前层 = 你刚点开的那张文件夹卡 + 它展开出的子项（不含同级兄弟）
          emphasized={chainResult.focus.has(id)}
          // 锚卡（链尾那张被点开的文件夹卡）拿 accent 边 + 最亮底 + 左侧竖条，
          // 它的子项与底层同款 —— 父/子的颜色区分不看 depth，每层一致
          anchor={elevated && chainResult.anchor === id}
          // 上浮链之外的文件卡在搜索时淡出；链上的不淡（它是当前的焦点）
          dimmed={!elevated && matchIds !== null && !matched && node.kind === 'file'}
          muted={!elevated && chainOpen}
          onOpenFolder={(path) => {
            // 空格按住时卡片完全不作动；刚拖完/刚平移完的那次 click 也吞掉
            if (spaceRef.current || suppressClickRef.current) return
            openFolder(path)
          }}
          onOpenFile={(path) => {
            if (spaceRef.current || suppressClickRef.current) return
            const target = fileByPath.get(path)
            if (target) onOpenFile(target)
          }}
          onPointerDown={handleNodePointerDown}
        />
      )
    }

    return (
      <div
        ref={viewportRef}
        data-testid="repo-map-canvas"
        data-space={spaceHeld ? 'true' : 'false'}
        data-panning={panning ? 'true' : 'false'}
        tabIndex={0}
        role="application"
        aria-label={t('repoMapCanvasLabel')}
        title={t('repoMapCanvasHint')}
        // 画布全程禁用文本选择：按住卡片 / 空白拖动时，鼠标一旦划过文字
        // 浏览器就会把它当成原生划词（选择锚点在 pointerdown 那一刻就种下了），
        // 拖动 60fps 的样式改动拦不住它 —— 只能在容器上直接关掉 user-select。
        style={{ touchAction: 'none' }}
        className="repo-map-canvas relative min-h-0 flex-1 select-none overflow-hidden bg-surface focus-visible:outline-none"
        onPointerDown={handleViewportPointerDown}
        onKeyDown={handleKeyDown}
      >
        <div
          ref={stageRef}
          data-testid="repo-map-stage"
          className="repo-map-stage absolute left-0 top-0 origin-top-left"
        >
          <div
            ref={guideXRef}
            aria-hidden="true"
            className="pointer-events-none absolute -top-[10000px] h-[20000px] w-px bg-accent opacity-0"
          />
          <div
            ref={guideYRef}
            aria-hidden="true"
            className="pointer-events-none absolute -left-[10000px] w-[20000px] h-px bg-accent opacity-0"
          />
          {baseNodes.map((node) => renderCard(node, false))}
          {chainResult.nodes.map((node) => renderCard(node, true))}
        </div>

        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Caption className="text-ink-muted">{t('repoMapCanvasLoading')}</Caption>
          </div>
        )}

        <RepoMapMinimap nodes={allRects} viewport={viewportRect} onNavigate={navigateTo} />
      </div>
    )
  }
)
