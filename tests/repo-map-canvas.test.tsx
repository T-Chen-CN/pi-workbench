// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoMapCanvasState, RepoMapFile } from '../src/types/electron'
import { useI18nStore } from '../src/store/i18nStore'

const canvasGet = vi.fn()
const canvasSet = vi.fn()

vi.mock('../src/api', () => ({
  api: {
    repoMapScan: vi.fn(),
    repoMapDescribe: vi.fn(),
    repoMapCanvasGet: (workspaceDir: string) => canvasGet(workspaceDir),
    repoMapCanvasSet: (workspaceDir: string, state: unknown) => canvasSet(workspaceDir, state),
    onGitChanged: vi.fn(() => () => {})
  }
}))

const { RepoMapCanvas } = await import('../src/components/RepoMapCanvas')

const file = (path: string, overrides: Partial<RepoMapFile> = {}): RepoMapFile => ({
  path,
  role: 'util',
  binary: false,
  size: 10,
  mtimeMs: 1,
  described: true,
  ...overrides
})

const FILES: RepoMapFile[] = [
  file('AGENTS.md', { role: 'doc', headComment: '项目说明' }),
  file('src/App.tsx', { role: 'component', headComment: '应用入口' }),
  file('src/store/editorStore.ts', { role: 'state', headComment: '编辑器状态' })
]

const empty = (): RepoMapCanvasState => ({
  version: 1,
  layoutVersion: 4,
  zoom: 1,
  pan: { x: 0, y: 0 },
  folders: {},
  files: {}
})

const onOpenFile = vi.fn()

async function renderCanvas(options: { query?: string; state?: RepoMapCanvasState; files?: RepoMapFile[] } = {}) {
  canvasGet.mockResolvedValue({ success: true, state: options.state ?? empty() })
  const utils = render(
    <RepoMapCanvas
      workspacePath="/ws"
      files={options.files ?? FILES}
      query={options.query ?? ''}
      onOpenFile={onOpenFile}
      onEnsureDescribed={vi.fn()}
    />
  )
  await waitFor(() => expect(screen.getByTestId('repo-map-canvas')).toBeTruthy())
  await waitFor(() =>
    expect(screen.getAllByTestId(/repo-map-(card|folder)/).length).toBeGreaterThan(0)
  )
  return utils
}

const cards = () => screen.getAllByTestId(/repo-map-(card|folder)/)
const cardByPath = (path: string) => cards().find((node) => node.dataset.path === path)!
const elevatedCards = () =>
  cards().filter((node) => node.dataset.elevated === 'true')
const lastSaved = (): RepoMapCanvasState | undefined => {
  const calls = canvasSet.mock.calls
  return calls.length > 0 ? (calls[calls.length - 1][1] as RepoMapCanvasState) : undefined
}

function drag(element: HTMLElement, dx: number, dy: number) {
  fireEvent.pointerDown(element, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(window, { pointerId: 1 })
}

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  canvasGet.mockReset()
  canvasSet.mockReset()
  onOpenFile.mockReset()
  canvasSet.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('底层地图', () => {
  it('默认只画顶层文件夹卡与根目录文件卡，并带小地图', async () => {
    await renderCanvas()

    expect(screen.getAllByTestId('repo-map-folder').map((node) => node.dataset.path)).toEqual([
      'src'
    ])
    expect(screen.getAllByTestId('repo-map-card').map((node) => node.dataset.path)).toEqual([
      'AGENTS.md'
    ])
    expect(screen.getByTestId('repo-map-minimap')).toBeTruthy()
  })

  it('拖动前先关掉文本选择（否则按住一拖就变成原生划词）', async () => {
    await renderCanvas()

    // 卡片的文本是卡片按钮的子元素，`select-none` 从画布根继承下来：
    // pointerdown 落在画布内任何位置都不会种下选择锚点。
    expect(screen.getByTestId('repo-map-canvas').className).toContain('select-none')
  })

  it('恢复落盘的底层位置而不是重新铺', async () => {
    await renderCanvas({
      state: {
        ...empty(),
        folders: { src: { x: 500, y: 320 } },
        files: { 'AGENTS.md': { x: 20, y: 40 } }
      }
    })

    expect(cardByPath('src').style.left).toBe('500px')
    expect(cardByPath('src').style.top).toBe('320px')
    expect(cardByPath('AGENTS.md').style.left).toBe('20px')
    expect(cardByPath('AGENTS.md').style.top).toBe('40px')
  })

  it('拖动底层卡片后提交新位置并落盘', async () => {
    await renderCanvas()
    const card = cardByPath('AGENTS.md')
    const startX = Number.parseFloat(card.style.left)
    const startY = Number.parseFloat(card.style.top)

    drag(card, 41, 33)

    await waitFor(() => expect(lastSaved()?.files['AGENTS.md']).toBeTruthy())
    const saved = lastSaved()!.files['AGENTS.md']
    // 吸附到 8px 网格，允许 ±4px 的偏差
    expect(Math.abs(saved.x - (startX + 41))).toBeLessThanOrEqual(4)
    expect(Math.abs(saved.y - (startY + 33))).toBeLessThanOrEqual(4)
  })

  it('拖动后松手不会误触打开文件', async () => {
    await renderCanvas()
    const card = cardByPath('AGENTS.md')
    drag(card, 60, 60)
    fireEvent.click(card)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('点击文件卡会打开文件', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('AGENTS.md'))
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'AGENTS.md' }))
  })

  it('滚轮缩放按光标锚定，并切换 LOD 档位', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')

    fireEvent.wheel(canvas, { deltaY: -400, clientX: 200, clientY: 150 })
    expect(canvas.dataset.zoomLod).toBe('full')

    for (let index = 0; index < 20; index++) {
      fireEvent.wheel(canvas, { deltaY: 600, clientX: 200, clientY: 150 })
    }
    expect(canvas.dataset.zoomLod).toBe('tiny')
    await waitFor(() => expect(lastSaved()).toBeTruthy())
    expect(lastSaved()!.zoom).toBeCloseTo(0.25, 5)
  })

  it('键盘 0 适应窗口、+ 放大、方向键平移', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')
    canvas.focus()

    fireEvent.keyDown(canvas, { key: '+' })
    await waitFor(() => expect(lastSaved()!.zoom).toBeGreaterThan(1))

    const zoomAfterPlus = lastSaved()!.zoom
    fireEvent.keyDown(canvas, { key: '0' })
    await waitFor(() => expect(lastSaved()!.zoom).not.toBe(zoomAfterPlus))

    const panBefore = lastSaved()!.pan
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    await waitFor(() => expect(lastSaved()!.pan.x).not.toBe(panBefore.x))
  })

  it('点小地图会移动视口', async () => {
    await renderCanvas()
    fireEvent.pointerDown(screen.getByTestId('repo-map-minimap'), {
      clientX: 20,
      clientY: 20,
      pointerId: 2
    })
    await waitFor(() => expect(lastSaved()).toBeTruthy())
    expect(lastSaved()!.pan).toBeTruthy()
  })

  it('旧布局版本的迁移：坐标整批作废、按新网格重铺并自动适应窗口', async () => {
    await renderCanvas({
      state: {
        version: 1,
        layoutVersion: 2,
        zoom: 0.8,
        pan: { x: 12, y: 34 },
        folders: { src: { x: 900, y: 900 }, 'src/store': { x: 400, y: 300 } },
        files: { 'AGENTS.md': { x: 0, y: 0 } }
      }
    })

    await waitFor(() => expect(lastSaved()?.layoutVersion).toBe(4))
    const saved = lastSaved()!
    expect(saved.folders).toEqual({})
    expect(saved.files).toEqual({})
    // 旧坐标没了 = 第一次铺，视口重新适应窗口（不再沿用旧 zoom）
    expect(saved.zoom).toBeGreaterThan(0)
    // 新布局生效：src 回到固定网格的左上角而不是旧坐标
    expect(cardByPath('src').style.left).toBe('0px')
    expect(cardByPath('src').style.top).toBe('0px')
  })

  it('仓库文件减少时剪掉失效坐标', async () => {
    await renderCanvas({
      state: {
        ...empty(),
        folders: { src: { x: 10, y: 10 }, gone: { x: 1, y: 1 } },
        files: { 'AGENTS.md': { x: 0, y: 0 }, 'deleted.ts': { x: 5, y: 5 } }
      }
    })

    await waitFor(() => expect(lastSaved()).toBeTruthy())
    const saved = lastSaved()!
    expect(saved.folders.gone).toBeUndefined()
    expect(saved.files['deleted.ts']).toBeUndefined()
    expect(saved.files['AGENTS.md']).toBeTruthy()
  })
})

describe('卡片上浮', () => {
  it('子项超过上限就折列，且整块与父卡纵向居中', async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      file(`big/f${String(index).padStart(2, '0')}.ts`)
    )
    await renderCanvas({ files: many })

    fireEvent.click(cardByPath('big'))
    await waitFor(() => expect(cardByPath('big/f00.ts')).toBeTruthy())

    const left = (path: string) => Number.parseFloat(cardByPath(path).style.left)
    const top = (path: string) => Number.parseFloat(cardByPath(path).style.top)
    // 每列 8 张：第 1、9、17 张分别是三列的第一行
    expect(left('big/f08.ts')).toBe(left('big/f00.ts') + 208 + 40)
    expect(left('big/f16.ts')).toBe(left('big/f00.ts') + (208 + 40) * 2)
    expect(top('big/f08.ts')).toBe(top('big/f00.ts'))

    // 20 张 = 3 列（8/8/4），块高按最高列 596 > 父卡 76 → 第一行在父卡上方，中线对齐
    const blockTop = top('big/f00.ts')
    const blockBottom = top('big/f07.ts') + 64
    const parentTop = Number.parseFloat(cardByPath('big').style.top)
    expect(blockTop).toBeLessThan(parentTop)
    expect((blockTop + blockBottom) / 2).toBe(parentTop + 76 / 2)
  })

  it('展开文件夹不动镜头：父卡留在原地，不被整块居中带跑', async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      file(`big/f${String(index).padStart(2, '0')}.ts`)
    )
    await renderCanvas({ files: many })
    const stage = () => screen.getByTestId('repo-map-stage').style.transform
    await waitFor(() => expect(stage()).not.toBe(''))
    const before = stage()

    fireEvent.click(cardByPath('big'))
    await waitFor(() => expect(cardByPath('big/f00.ts')).toBeTruthy())

    // 子块 3 列 × 8 行、远大于视口：以前会被「整块居中」甩走
    expect(stage()).toBe(before)
  })

  it('父卡与子卡的颜色区分由角色决定，每一层都一致', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))

    const anchor = cardByPath('src')
    const childFolder = cardByPath('src/store')
    const childFile = cardByPath('src/App.tsx')
    // 角色：锚卡 / 子文件夹 / 子文件；底层没有锚，文件夹与文件各自归位
    expect(anchor.dataset.role).toBe('anchor')
    expect(childFolder.dataset.role).toBe('folder')
    expect(childFile.dataset.role).toBe('file')
    expect(cardByPath('AGENTS.md').dataset.role).toBe('file')
    // 颜色：只有锚卡是 bg-raised + 左竖条，子项与底层同款 bg-panel
    expect(anchor.className).toContain('bg-raised')
    expect(anchor.querySelector('[data-anchor-bar="true"]')).toBeTruthy()
    expect(childFolder.className).toContain('bg-panel')
    expect(childFolder.className).not.toContain('bg-raised')
    expect(childFolder.querySelector('[data-anchor-bar="true"]')).toBeNull()
    expect(childFile.className).toContain('bg-panel')

    // 再开一层：新锚卡换成子目录，原锚卡退化成普通文件夹卡 —— 规则不随层级变
    fireEvent.click(childFolder)
    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())
    expect(cardByPath('src/store').dataset.role).toBe('anchor')
    expect(cardByPath('src/store').className).toContain('bg-raised')
    expect(cardByPath('src').dataset.role).toBe('folder')
    expect(cardByPath('src').className).toContain('bg-panel')
  })

  it('点文件夹：那张卡原位抬起，子项在右侧展开，底层其他卡不动', async () => {
    await renderCanvas()
    const before = {
      left: cardByPath('src').style.left,
      top: cardByPath('src').style.top,
      width: cardByPath('src').style.width,
      zoom: cardByPath('src').style.transform
    }

    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src').dataset.elevated).toBe('true'))

    // 位置 / 尺寸 / 缩放都没变
    const elevated = cardByPath('src')
    expect(elevated.style.left).toBe(before.left)
    expect(elevated.style.top).toBe(before.top)
    expect(elevated.style.width).toBe(before.width)

    // 子项在右侧一列（父卡宽 176 + DEPTH_GAP 40）
    const parentX = Number.parseFloat(before.left)
    expect(Number.parseFloat(cardByPath('src/store').style.left)).toBe(parentX + 176 + 40)
    expect(Number.parseFloat(cardByPath('src/App.tsx').style.left)).toBe(parentX + 176 + 40)
    expect(cardByPath('src/store').dataset.elevated).toBe('true')

    // 底层其他卡：压暗、不可点
    expect(cardByPath('AGENTS.md').dataset.elevated).toBe('false')
    expect(cardByPath('AGENTS.md').style.pointerEvents).toBe('none')

    // 多层级梯度：链根是 0 层、子项是 1 层；
    // 当前层 = 被点的文件夹 + 它展开出的子项，两者都亮
    expect(cardByPath('src').dataset.depth).toBe('0')
    expect(cardByPath('src').dataset.emphasized).toBe('true')
    expect(cardByPath('src/store').dataset.depth).toBe('1')
    expect(cardByPath('src/store').dataset.emphasized).toBe('true')
    expect(Number(cardByPath('src/store').style.zIndex)).toBeGreaterThan(
      Number(cardByPath('src').style.zIndex)
    )
  })

  it('再点链上目录会继续向右叠一层，上一层与底层的卡片都不动', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))

    const before = {
      srcLeft: cardByPath('src').style.left,
      srcTop: cardByPath('src').style.top,
      storeLeft: cardByPath('src/store').style.left,
      storeTop: cardByPath('src/store').style.top,
      appTop: cardByPath('src/App.tsx').style.top
    }

    fireEvent.click(cardByPath('src/store'))
    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())

    // 0→1 不动底层，1→2 也不动 1 层：规则一致
    expect(cardByPath('src').style.left).toBe(before.srcLeft)
    expect(cardByPath('src').style.top).toBe(before.srcTop)
    expect(cardByPath('src/store').style.left).toBe(before.storeLeft)
    expect(cardByPath('src/store').style.top).toBe(before.storeTop)
    expect(cardByPath('src/App.tsx').style.top).toBe(before.appTop)
    // 新一列在 store 卡右侧
    expect(Number.parseFloat(cardByPath('src/store/editorStore.ts').style.left)).toBe(
      Number.parseFloat(before.storeLeft) + 176 + 40
    )
    // 层级梯度：只有被点的 store 与它的子项在当前层，
    // 更浅的 src 退后，src 的同级兄弟（App.tsx）也跟着退后
    expect(cardByPath('src').dataset.depth).toBe('0')
    expect(cardByPath('src').dataset.emphasized).toBe('false')
    expect(cardByPath('src/App.tsx').dataset.emphasized).toBe('false')
    expect(cardByPath('src/store').dataset.depth).toBe('1')
    expect(cardByPath('src/store').dataset.emphasized).toBe('true')
    expect(cardByPath('src/store/editorStore.ts').dataset.depth).toBe('2')
    expect(cardByPath('src/store/editorStore.ts').dataset.emphasized).toBe('true')
    // 退后档与底层一致
    expect(cardByPath('src/App.tsx').style.opacity).toBe(cardByPath('AGENTS.md').style.opacity)
    expect(cardByPath('src/App.tsx').style.pointerEvents).toBe('none')
  })

  it('退后只有一档：底层与更浅的祖先层同样压暗、同样不可点', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))
    fireEvent.click(cardByPath('src/store'))
    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())

    const base = cardByPath('AGENTS.md')
    const ancestor = cardByPath('src')
    expect(base.style.opacity).toBe(ancestor.style.opacity)
    expect(base.style.pointerEvents).toBe('none')
    expect(ancestor.style.pointerEvents).toBe('none')

    // 更浅的祖先层不可点：点它不会收起、也不会再展开
    fireEvent.click(ancestor)
    expect(cards().some((node) => node.dataset.path === 'src/store/editorStore.ts')).toBe(true)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('点当前层里那张被展开的文件夹 → 收起它和它的下游（自己不会掉回上一层）', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))
    fireEvent.click(cardByPath('src/store'))
    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())

    fireEvent.click(cardByPath('src/store'))
    await waitFor(() =>
      expect(cards().some((node) => node.dataset.path === 'src/store/editorStore.ts')).toBe(false)
    )
    // 回到只有 src 展开的状态，src 重新成为当前层的一部分
    expect(cardByPath('src').dataset.emphasized).toBe('true')
    expect(cardByPath('src/store').dataset.emphasized).toBe('true')
  })

  it('Esc 逐层收起，最后全部回到只有底层', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')

    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))
    fireEvent.click(cardByPath('src/store'))
    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())

    fireEvent.keyDown(canvas, { key: 'Escape' })
    await waitFor(() =>
      expect(cards().some((node) => node.dataset.path === 'src/store/editorStore.ts')).toBe(false)
    )
    expect(elevatedCards().map((node) => node.dataset.path)).toEqual([
      'src',
      'src/store',
      'src/App.tsx'
    ])

    fireEvent.keyDown(canvas, { key: 'Escape' })
    await waitFor(() => expect(elevatedCards()).toHaveLength(0))
  })

  it('点空白退一层（等价 Esc），不是收整条链', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))
    fireEvent.click(cardByPath('src/store'))
    await waitFor(() => expect(cardByPath('src/store/editorStore.ts').dataset.elevated).toBe('true'))

    const canvas = screen.getByTestId('repo-map-canvas')
    const clickEmpty = (pointerId: number) => {
      fireEvent.pointerDown(canvas, { button: 0, clientX: 400, clientY: 300, pointerId })
      fireEvent.pointerUp(window, { pointerId })
    }

    // 第一下：只退掉最深那层 —— editorStore 那张卡消失，src 仍然是锚卡、src/store 退成普通子项
    clickEmpty(3)
    await waitFor(() =>
      expect(cards().some((node) => node.dataset.path === 'src/store/editorStore.ts')).toBe(false)
    )
    expect(cardByPath('src').dataset.role).toBe('anchor')
    expect(cardByPath('src/store').dataset.role).toBe('folder')

    // 第二下：退到只剩底层
    clickEmpty(4)
    await waitFor(() => expect(elevatedCards()).toHaveLength(0))
  })

  it('链上卡片可以拖，但只存在本次会话（不落盘）', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/App.tsx').dataset.elevated).toBe('true'))

    const callsBefore = canvasSet.mock.calls.length
    const card = cardByPath('src/App.tsx')
    const startX = Number.parseFloat(card.style.left)
    drag(card, 60, 40)

    await waitFor(() => expect(Number.parseFloat(card.style.left)).toBeGreaterThan(startX))
    expect(canvasSet.mock.calls.length).toBe(callsBefore)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('链上点文件会在编辑器打开，链保持不变', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/App.tsx').dataset.elevated).toBe('true'))

    fireEvent.click(cardByPath('src/App.tsx'))
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/App.tsx' }))
    expect(cardByPath('src/App.tsx').dataset.elevated).toBe('true')
  })

  it('搜索命中会把祖先目录逐层抬起来并高亮', async () => {
    await renderCanvas({ query: 'editorstore' })

    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())
    expect(elevatedCards().map((node) => node.dataset.path).sort()).toEqual([
      'src',
      'src/App.tsx',
      'src/store',
      'src/store/editorStore.ts'
    ])
    const hit = cardByPath('src/store/editorStore.ts')
    expect(hit.className).toContain('border-accent')
    // 命中色是独立叠层，底色始终是角色底色：两个 bg-* 类不会互相顶掉
    expect(hit.className).toContain('bg-panel')
    expect(hit.querySelector('.inset-0')).toBeTruthy()
  })
})

describe('空格手形工具', () => {
  const pressSpace = () => fireEvent.keyDown(window, { code: 'Space' })
  const releaseSpace = () => fireEvent.keyUp(window, { code: 'Space' })
  const stageTransform = () => screen.getByTestId('repo-map-stage').style.transform
  const panDrag = (element: HTMLElement, dx: number, dy: number) => {
    fireEvent.pointerDown(element, { button: 0, clientX: 300, clientY: 200, pointerId: 9 })
    fireEvent.pointerMove(window, { clientX: 300 + dx, clientY: 200 + dy, pointerId: 9 })
    fireEvent.pointerUp(window, { pointerId: 9 })
  }

  it('不按空格：空白处拖动不动镜头，且不算「点空白收链」', async () => {
    await renderCanvas()
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))

    const canvas = screen.getByTestId('repo-map-canvas')
    const before = stageTransform()
    panDrag(canvas, -120, -60)

    expect(stageTransform()).toBe(before)
    expect(elevatedCards().length).toBeGreaterThan(0)
  })

  it('按住空格：空白处拖动平移镜头', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')
    const before = stageTransform()

    pressSpace()
    await waitFor(() => expect(canvas.dataset.space).toBe('true'))
    panDrag(canvas, -120, -60)

    expect(stageTransform()).not.toBe(before)
    releaseSpace()
    await waitFor(() => expect(canvas.dataset.space).toBe('false'))
  })

  it('按住空格：卡片既不能打开也不能展开，拖动只平移镜头', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')
    pressSpace()
    await waitFor(() => expect(canvas.dataset.space).toBe('true'))

    const fileCard = cardByPath('AGENTS.md')
    fireEvent.pointerDown(fileCard, { button: 0, clientX: 100, clientY: 100, pointerId: 5 })
    fireEvent.pointerUp(window, { pointerId: 5 })
    fireEvent.click(fileCard)
    expect(onOpenFile).not.toHaveBeenCalled()

    const folderCard = cardByPath('src')
    fireEvent.pointerDown(folderCard, { button: 0, clientX: 100, clientY: 100, pointerId: 6 })
    fireEvent.pointerUp(window, { pointerId: 6 })
    fireEvent.click(folderCard)
    expect(elevatedCards()).toHaveLength(0)

    // 在卡片上按住空格拖动 = 平移，卡片自己的位置不动
    const before = stageTransform()
    const cardLeft = folderCard.style.left
    panDrag(folderCard, -90, 0)
    expect(stageTransform()).not.toBe(before)
    expect(cardByPath('src').style.left).toBe(cardLeft)

    releaseSpace()
    // 刚平移完的那一次 click 仍被吞掉（suppressClickRef 在下一个 tick 复位）
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))
  })

  it('切走窗口 / 失焦时复位空格状态，卡片恢复可点', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')
    pressSpace()
    await waitFor(() => expect(canvas.dataset.space).toBe('true'))

    fireEvent.blur(window)
    await waitFor(() => expect(canvas.dataset.space).toBe('false'))

    fireEvent.click(cardByPath('src'))
    await waitFor(() => expect(cardByPath('src/store').dataset.elevated).toBe('true'))
  })

  it('双击空白不再触发「适应窗口」（空格与否都不触发）', async () => {
    await renderCanvas()
    const canvas = screen.getByTestId('repo-map-canvas')
    const savedBefore = canvasSet.mock.calls.length

    fireEvent.doubleClick(canvas)
    expect(canvasSet.mock.calls.length).toBe(savedBefore)

    pressSpace()
    await waitFor(() => expect(canvas.dataset.space).toBe('true'))
    fireEvent.doubleClick(canvas)
    expect(canvasSet.mock.calls.length).toBe(savedBefore)
    releaseSpace()
  })
})
