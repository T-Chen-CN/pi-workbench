/**
 * Pi Cloud 的 Web 客户端（D-19 / D-26）。
 *
 * 约束：纯 ESM、零构建、零依赖；所有文本都用 textContent 渲染，
 * 任何地方都不拼 HTML 字符串 —— 模型输出、路径、工单标题都是不可信输入。
 */

const THEME_STORAGE_KEY = 'pi-cloud-theme'
const SVG_NS = 'http://www.w3.org/2000/svg'
const SEAL_PATH =
  'M45 417 14 427C26 463 38.3 490.5 57 508.5C75.7 526.5 102 536 142 536H615L605 453H111C89 453 65 443 45 417ZM113 0 169 483H236L215 0ZM494 -6C458 -6 431 14.2 419 49.5C413 67.2 411 88 413 112L443 483H494L501 116C501.7 89.3 505 72.5 511 65.5C517 58.5 524 55 532 55C545.3 55 557 57.7 573 71L590 29C569.3 12.3 552 2.3 538 -1C524 -4.3 509.3 -6 494 -6Z'

const state = {
  me: null,
  ws: null,
  wsStatus: 'closed',
  reconnectDelay: 1000,
  lastSeq: 0,
  lastReadSeq: 0,
  unreadCount: 0,
  tab: 'chat',
  asideCollapsed: false,
  agentStatus: 'idle',
  canStopReply: false,
  messages: [],
  tasks: [],
  units: [],
  devices: [],
  authorizations: [],
  notices: [],
  awaySummary: null,
  stoppingTaskIds: {},
  config: null,
  pairCode: null,
  configDraft: null,
  configModels: [],
  error: null,
  draft: '',
  answerDrafts: {},
  instructionDrafts: {},
  memories: [],
  docs: [],
  dreams: [],
  memoryLoaded: false,
  memoryBusy: false,
  memoryKindDraft: 'fact',
  memoryContentDraft: '',
  editingMemoryId: null,
  editingMemoryDraft: null,
  selectedDoc: 'AGENTS.md',
  docDrafts: {},
  memoryFeedback: '',
  openDetails: new Set(),
}

/** 持久外壳 DOM 句柄：局部事件只刷新对应槽位，避免整页重建冲掉焦点与折叠状态 */
const ui = {
  mounted: false,
  tabButtons: {},
  statusStrip: null,
  themeButton: null,
  main: null,
  footer: null,
  transcript: null,
  composerTextarea: null,
  sendButton: null,
  stopReplyButton: null,
  agentStatusLabel: null,
  asideSlots: null,
  tabPageInner: null,
}

const root = document.getElementById('root')

// ----------------------------------------------------------------- 主题管理

function readStoredTheme() {
  try {
    const value = window.localStorage?.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function writeStoredTheme(theme) {
  try {
    window.localStorage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 隐私模式或无存储环境静默跳过
  }
}

function resolveTheme() {
  const attr = document.documentElement?.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function initTheme() {
  const saved = readStoredTheme()
  if (saved && document.documentElement) {
    document.documentElement.setAttribute('data-theme', saved)
  }
}

function toggleTheme() {
  const next = resolveTheme() === 'dark' ? 'light' : 'dark'
  if (document.documentElement) {
    document.documentElement.setAttribute('data-theme', next)
  }
  writeStoredTheme(next)
  updateThemeButton()
}

function updateThemeButton() {
  if (!ui.themeButton) return
  const dark = resolveTheme() === 'dark'
  ui.themeButton.textContent = dark ? 'Ink' : 'Paper'
  ui.themeButton.title = dark ? '当前：Ink 深色（点击切到 Paper）' : '当前：Paper 浅色（点击切到 Ink）'
  ui.themeButton.setAttribute('aria-label', ui.themeButton.title)
}

// ----------------------------------------------------------------- DOM 帮助

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key === 'value') node.value = value
    else if (key === 'open') node.open = Boolean(value)
    else if (key === 'disabled') node.disabled = Boolean(value)
    else if (key === 'selected') node.selected = Boolean(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

function createBrandSeal(size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '128 128 768 768')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('class', 'brand-seal')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Pi Cloud')

  const rect = document.createElementNS(SVG_NS, 'rect')
  rect.setAttribute('x', '128')
  rect.setAttribute('y', '128')
  rect.setAttribute('width', '768')
  rect.setAttribute('height', '768')
  rect.setAttribute('rx', '152')
  rect.setAttribute('fill', 'rgb(var(--accent))')

  const g = document.createElementNS(SVG_NS, 'g')
  g.setAttribute('transform', 'translate(262.5 722.2) scale(0.7934 -0.7934)')
  g.setAttribute('fill', 'rgb(var(--accent-fg))')
  g.setAttribute('fill-rule', 'nonzero')

  const pathNode = document.createElementNS(SVG_NS, 'path')
  pathNode.setAttribute('d', SEAL_PATH)
  g.append(pathNode)
  svg.append(rect, g)
  return svg
}

function time(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function duration(from, to) {
  if (!from) return ''
  const seconds = Math.max(0, Math.round(((to || Date.now()) - from) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`
}

function parseTagsInput(raw) {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function makeDetails(key, summaryText, bodyNodes) {
  const details = el(
    'details',
    {
      class: 'trace',
      open: state.openDetails.has(key),
      ontoggle: (event) => {
        if (event.target.open) state.openDetails.add(key)
        else state.openDetails.delete(key)
      },
    },
    [el('summary', { text: summaryText }), ...bodyNodes.filter(Boolean)]
  )
  return details
}

async function copyToClipboard(text) {
  if (typeof window !== 'undefined' && window.navigator?.clipboard?.writeText) {
    try {
      await window.navigator.clipboard.writeText(text)
      return true
    } catch {
      // 回落到临时 textarea
    }
  }
  try {
    const area = el('textarea', { value: text })
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    area.remove()
    return ok
  } catch {
    return false
  }
}

// ------------------------------------------------------ 安全 DOM Markdown

function isSafeLinkUrl(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return false
  try {
    const parsed = new window.URL(trimmed, 'https://example.invalid')
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}

/** 行内 Markdown：行内代码 / 链接 / 加粗 / 斜体，全程用 createTextNode 构造 */
function renderInlineNodes(text) {
  const nodes = []
  const tokenRe = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g
  let lastIndex = 0
  let match
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(document.createTextNode(text.slice(lastIndex, match.index)))
    }
    if (match[1] !== undefined) {
      nodes.push(el('code', { class: 'md-inline-code', text: match[1] }))
    } else if (match[2] !== undefined && match[3] !== undefined) {
      if (isSafeLinkUrl(match[3])) {
        nodes.push(
          el('a', {
            href: match[3],
            target: '_blank',
            rel: 'noopener noreferrer',
            text: match[2],
          })
        )
      } else {
        nodes.push(document.createTextNode(match[0]))
      }
    } else if (match[4] !== undefined) {
      nodes.push(el('strong', { text: match[4] }))
    } else if (match[5] !== undefined) {
      nodes.push(el('em', { text: match[5] }))
    }
    lastIndex = tokenRe.lastIndex
  }
  if (lastIndex < text.length) {
    nodes.push(document.createTextNode(text.slice(lastIndex)))
  }
  return nodes
}

function renderCodeBlock(lang, codeText) {
  const copyBtn = el('button', {
    class: 'ghost sm',
    type: 'button',
    text: '复制',
    onclick: async () => {
      const ok = await copyToClipboard(codeText)
      copyBtn.textContent = ok ? '已复制' : '复制失败'
      setTimeout(() => {
        copyBtn.textContent = '复制'
      }, 1500)
    },
  })
  return el('div', { class: 'md-code-block' }, [
    el('div', { class: 'md-code-head' }, [el('span', { text: lang || 'code' }), copyBtn]),
    el('pre', { class: 'md-code-pre' }, [el('code', { text: codeText })]),
  ])
}

function splitTableCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

/** 块级安全 DOM Markdown 渲染（零依赖、零 HTML 注入） */
function renderMarkdown(source) {
  const container = el('div', { class: 'md-body' })
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i += 1
      continue
    }

    // 围栏代码块
    const fenceMatch = line.match(/^```([A-Za-z0-9_+-]*)\s*$/)
    if (fenceMatch) {
      const lang = fenceMatch[1] || ''
      const codeLines = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      container.append(renderCodeBlock(lang, codeLines.join('\n')))
      continue
    }

    // 分隔线
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      container.append(el('hr'))
      i += 1
      continue
    }

    // 标题
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      container.append(el(`h${level}`, {}, renderInlineNodes(headingMatch[2].trim())))
      i += 1
      continue
    }

    // 引用块
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      container.append(el('blockquote', {}, [el('p', {}, renderInlineNodes(quoteLines.join(' ')))]))
      continue
    }

    // GFM 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = splitTableCells(line)
      i += 2
      const bodyRows = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitTableCells(lines[i]))
        i += 1
      }
      const thead = el('thead', {}, [
        el(
          'tr',
          {},
          headerCells.map((cell) => el('th', {}, renderInlineNodes(cell)))
        ),
      ])
      const tbody = el(
        'tbody',
        {},
        bodyRows.map((row) =>
          el(
            'tr',
            {},
            row.map((cell) => el('td', {}, renderInlineNodes(cell)))
          )
        )
      )
      container.append(el('div', { class: 'md-table-wrap' }, [el('table', {}, [thead, tbody])]))
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(el('li', {}, renderInlineNodes(lines[i].replace(/^\s*[-*+]\s+/, ''))))
        i += 1
      }
      container.append(el('ul', {}, items))
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(el('li', {}, renderInlineNodes(lines[i].replace(/^\s*\d+\.\s+/, ''))))
        i += 1
      }
      container.append(el('ol', {}, items))
      continue
    }

    // 段落
    const paraLines = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i])
      i += 1
    }
    const paraNodes = []
    paraLines.forEach((pLine, index) => {
      if (index > 0) paraNodes.push(el('br'))
      paraNodes.push(...renderInlineNodes(pLine))
    })
    container.append(el('p', {}, paraNodes))
  }

  return container
}

// ----------------------------------------------------------------- HTTP 通信

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  // 401 = cookie 过期/密钥轮换：回查 /v1/me 决定是否回登录页（登录接口自己的 401 不算）
  if (response.status === 401 && path !== '/v1/login') void handleUnauthorized()
  return { ok: response.ok, status: response.status, payload }
}

function resetShellRefs() {
  ui.mounted = false
  ui.tabButtons = {}
  ui.statusStrip = null
  ui.themeButton = null
  ui.main = null
  ui.footer = null
  ui.transcript = null
  ui.composerTextarea = null
  ui.sendButton = null
  ui.stopReplyButton = null
  ui.agentStatusLabel = null
  ui.asideSlots = null
  ui.tabPageInner = null
}

/** 登录态失效：回登录页并说明原因。否则页面会停在“正在重连…”且永远不成功。 */
function showExpired(me) {
  if (me) state.me = me
  const socket = state.ws
  state.ws = null
  state.wsStatus = 'closed'
  try {
    socket?.close()
  } catch {
    // 已经断了
  }
  if (state.me && !state.me.hasAccount) return renderSetup()
  renderLogin('登录已过期，请重新登录')
}

let sessionProbe = false

async function handleUnauthorized() {
  // WS 升级阶段被 401 拒时浏览器只给 1006，拿不到状态码；只能靠 /v1/me 反查
  if (sessionProbe) return
  sessionProbe = true
  try {
    const me = await request('GET', '/v1/me')
    if (me.ok && me.payload && me.payload.authenticated === false) showExpired(me.payload)
  } finally {
    sessionProbe = false
  }
}

// --------------------------------------------------------------------- 引导

async function boot() {
  initTheme()
  const me = await request('GET', '/v1/me')
  if (!me.ok) {
    renderFatal('Cannot reach the server')
    return
  }
  state.me = me.payload
  if (!state.me.hasAccount) return renderSetup()
  if (!state.me.authenticated) return renderLogin()
  await enterApp()
}

function renderFatal(message) {
  resetShellRefs()
  root.className = 'center'
  root.replaceChildren(
    el('div', { class: 'panel stack' }, [
      el('div', { class: 'panel-head' }, [el('h1', { text: 'Pi Cloud' })]),
      el('p', { class: 'danger', text: message }),
    ])
  )
}

function renderSetup() {
  resetShellRefs()
  root.className = 'center'
  const password = el('input', { type: 'password', autocomplete: 'new-password' })
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' })
  const error = el('p', { class: 'danger caption' })
  const submit = el('button', { class: 'primary', type: 'button', text: '创建管理员账号' })
  submit.addEventListener('click', async () => {
    error.textContent = ''
    if (password.value.length < 8) {
      error.textContent = '密码至少 8 位'
      return
    }
    if (password.value !== confirm.value) {
      error.textContent = '两次输入的密码不一致'
      return
    }
    const result = await request('POST', '/v1/setup', { password: password.value })
    if (!result.ok) {
      error.textContent = result.payload?.error || '创建失败'
      return
    }
    renderLogin()
  })
  root.replaceChildren(
    el('div', { class: 'panel stack' }, [
      el('div', { class: 'panel-head' }, [
        el('div', { class: 'row' }, [createBrandSeal(24), el('h1', { text: 'Pi Cloud' })]),
      ]),
      el('p', { class: 'muted', text: '首次使用：创建唯一的管理员账号。' }),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '密码' }), password]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '确认密码' }), confirm]),
      error,
      submit,
    ])
  )
}

function renderLogin(notice) {
  resetShellRefs()
  root.className = 'center'
  const password = el('input', { type: 'password', autocomplete: 'current-password' })
  const error = el('p', { class: 'danger caption' })
  if (notice) error.textContent = notice
  const submit = el('button', { class: 'primary', type: 'button', text: '登录' })
  const doLogin = async () => {
    error.textContent = ''
    const result = await request('POST', '/v1/login', { password: password.value })
    if (!result.ok) {
      error.textContent = result.status === 429 ? '尝试过于频繁，稍后再试' : '密码不正确'
      return
    }
    const me = await request('GET', '/v1/me')
    if (me.ok && me.payload) state.me = me.payload
    await enterApp()
  }
  submit.addEventListener('click', () => void doLogin())
  password.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void doLogin()
  })
  root.replaceChildren(
    el('div', { class: 'panel stack' }, [
      el('div', { class: 'panel-head' }, [
        el('div', { class: 'row' }, [createBrandSeal(24), el('h1', { text: 'Pi Cloud' })]),
      ]),
      el('p', { class: 'muted', text: '登录云端控制台。' }),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '密码' }), password]),
      error,
      submit,
    ])
  )
  password.focus()
}

// ------------------------------------------------------------------ 主界面

async function enterApp() {
  mountAppShell()
  renderMain()
  updateHeaderState()
  updateFooter()
  connect()
  void loadAuxiliary()
}

async function loadAuxiliary() {
  const [devices, authorizations, config] = await Promise.all([
    request('GET', '/v1/devices'),
    request('GET', '/v1/authorizations'),
    request('GET', '/v1/cloud-config'),
  ])
  if (devices.ok) state.devices = devices.payload.devices || []
  if (authorizations.ok) state.authorizations = authorizations.payload.authorizations || []
  if (config.ok) state.config = config.payload
  updateStatusStrip()
  updateFooter()
  updateAsideSection('devices')
  updateAsideSection('auth')
  if (state.tab === 'devices') renderTabPageContent()
  if (state.tab === 'settings' && !state.configDraft) renderTabPageContent()
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // 没有游标时不能带 lastAckSeq=0：那会让服务端走「续传」分支、只重放旧事件，
  // 而新连上的页面需要的是整份快照（含历史消息）
  const cursor = state.lastSeq > 0 ? `?lastAckSeq=${state.lastSeq}` : ''
  const url = `${scheme}//${location.host}/client/ws${cursor}`
  let socket
  try {
    socket = new WebSocket(url)
  } catch {
    scheduleReconnect(true)
    return
  }
  state.ws = socket
  state.wsStatus = 'connecting'
  let opened = false
  updateStatusStrip()
  updateFooter()

  socket.addEventListener('open', () => {
    opened = true
    state.wsStatus = 'open'
    state.reconnectDelay = 1000
    updateStatusStrip()
    updateFooter()
  })
  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    applyFrame(frame)
  })
  socket.addEventListener('close', () => {
    state.wsStatus = 'closed'
    state.ws = null
    updateStatusStrip()
    updateFooter()
    // 升级阶段就被拒（登录态过期 → 401）时只会看到 1006：标记一下，重连前先回查登录态，
    // 否则就是无限“正在重连…”且永远不成功。
    if (state.me?.authenticated) scheduleReconnect(!opened)
  })
  socket.addEventListener('error', () => {
    state.wsStatus = 'closed'
    updateStatusStrip()
    updateFooter()
  })
}

function scheduleReconnect(handshakeFailed = false) {
  const delay = state.reconnectDelay
  state.reconnectDelay = Math.min(30000, Math.round(state.reconnectDelay * 1.8))
  setTimeout(async () => {
    if (handshakeFailed) {
      const me = await request('GET', '/v1/me')
      // 服务端也够不着（/v1/me 自己失败）时继续退避重连，别把网络故障当成登录过期
      if (me.ok && me.payload && me.payload.authenticated === false) {
        showExpired(me.payload)
        return
      }
    }
    connect()
  }, delay)
}

function send(frame) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    pushNotice('error', '连接已断开，正在重连…')
    return false
  }
  state.ws.send(JSON.stringify({ v: 1, ...frame }))
  return true
}

function applyFrame(frame) {
  if (!frame || frame.v !== 1) return
  if (typeof frame.seq === 'number' && frame.seq > state.lastSeq) {
    state.lastSeq = frame.seq
    updateFooter()
  }

  if (frame.type === 'snapshot') {
    const snapshot = frame.snapshot || {}
    state.messages = (snapshot.messages || []).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text || '',
      at: message.at || Date.now(),
      streaming: Boolean(message.streaming),
      traces: [],
      error: message.error,
    }))
    state.tasks = snapshot.tasks || []
    state.devices = snapshot.devices || []
    state.units = snapshot.units || []
    state.authorizations = snapshot.authorizations || []
    state.awaySummary = snapshot.awaySummary || null
    state.lastReadSeq = Number(snapshot.lastReadSeq || 0)
    state.unreadCount = Number(snapshot.unreadCount || 0)
    state.stoppingTaskIds = {}
    state.agentStatus = snapshot.cloud?.status || 'idle'
    state.canStopReply = Boolean(snapshot.cloud?.canStopReply)
    updateDocumentTitle()
    if (state.tab === 'chat' && !document.hidden && state.unreadCount > 0) {
      markRead()
    }
    updateHeaderState()
    updateFooter()
    updateChatControls()
    renderTranscript()
    updateAllAside()
    if (state.tab === 'tasks' || state.tab === 'devices') renderTabPageContent()
    return
  }

  if (frame.type === 'error') {
    pushNotice('error', frame.message || 'cloud error')
    return
  }
  if (frame.type !== 'event') return

  const event = frame.event || {}
  switch (event.type) {
    case 'message_start': {
      const id = String(event.messageId || `m-${Date.now()}`)
      if (state.messages.some((row) => row.id === id)) return
      state.messages.push({
        id,
        role: event.role === 'user' ? 'user' : 'assistant',
        text: '',
        at: event.at || Date.now(),
        streaming: event.role !== 'user',
        traces: [],
      })
      renderTranscript()
      return
    }
    case 'text_delta': {
      const delta = String(event.delta || '')
      if (!delta) return
      const last = state.messages[state.messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) last.text += delta
      else
        state.messages.push({
          id: event.messageId || `m-${Date.now()}`,
          role: 'assistant',
          text: delta,
          at: Date.now(),
          streaming: true,
          traces: [],
        })
      renderTranscript()
      return
    }
    case 'message_end': {
      const target = String(event.messageId || '')
      let row = target ? state.messages.find((item) => item.id === target) : undefined
      if (!row) {
        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
          const candidate = state.messages[index]
          if (candidate.role === 'assistant' && candidate.streaming) {
            row = candidate
            break
          }
        }
      }
      if (row) {
        if (event.text) row.text = event.text
        row.streaming = false
        row.error = event.error
      }
      if (!target.startsWith('u-') && String(event.text || '').trim()) {
        onUnreadWorthyEvent()
      }
      renderTranscript()
      return
    }
    case 'trace': {
      const trace = event.trace || {}
      let row = state.messages[state.messages.length - 1]
      if (!row || row.role !== 'assistant') {
        row = {
          id: `m-${Date.now()}`,
          role: 'assistant',
          text: '',
          at: Date.now(),
          streaming: true,
          traces: [],
        }
        state.messages.push(row)
      }
      const id = String(trace.toolCallId || '')
      const existing = row.traces.find((item) => item.id === id)
      if (trace.type === 'tool_start') {
        row.traces.push({
          id,
          toolName: trace.toolName || 'tool',
          summary: trace.argsSummary || '',
          status: 'running',
        })
      } else if (trace.type === 'tool_end' && existing) {
        existing.status = trace.status === 'error' ? 'error' : 'ok'
        existing.summary = trace.resultPreview || existing.summary
      }
      renderTranscript()
      return
    }
    case 'cloud_status':
      state.agentStatus = event.status || 'idle'
      state.canStopReply = event.status === 'thinking' || event.status === 'replying'
      updateStatusStrip()
      updateChatControls()
      updateFooter()
      return
    case 'task': {
      const task = event.task
      if (!task) return
      const index = state.tasks.findIndex((item) => item.id === task.id)
      if (index >= 0) state.tasks[index] = task
      else state.tasks.unshift(task)
      if (!ACTIVE_STATUS.includes(task.status)) {
        delete state.stoppingTaskIds[task.id]
      }
      updateStatusStrip()
      updateAsideSection('tasks')
      if (state.tab === 'tasks') renderTabPageContent()
      return
    }
    case 'unit': {
      const unit = event.unit
      if (!unit) return
      const index = state.units.findIndex((item) => item.unitId === unit.unitId)
      if (index >= 0) state.units[index] = unit
      else state.units.unshift(unit)
      updateAsideSection('units')
      return
    }
    case 'device': {
      const device = event.device
      if (!device) return
      const index = state.devices.findIndex((item) => item.id === device.id)
      if (index >= 0) state.devices[index] = device
      else state.devices.push(device)
      updateStatusStrip()
      updateFooter()
      updateAsideSection('devices')
      if (state.tab === 'devices') renderTabPageContent()
      return
    }
    case 'notice':
      pushNotice(event.level || 'info', event.text || '')
      return
    case 'read_state':
      state.lastReadSeq = Number(event.lastReadSeq || 0)
      state.unreadCount = Number(event.unreadCount || 0)
      updateDocumentTitle()
      updateTabs()
      updateFooter()
      return
    default:
      return
  }
}

function updateDocumentTitle() {
  document.title = state.unreadCount > 0 ? `(${state.unreadCount}) Pi Cloud` : 'Pi Cloud'
}

function markRead() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
  const seq = state.lastSeq
  state.lastReadSeq = Math.max(state.lastReadSeq, seq)
  state.unreadCount = 0
  updateDocumentTitle()
  updateTabs()
  send({ type: 'mark_read', seq, at: Date.now() })
}

function onUnreadWorthyEvent() {
  if (state.tab === 'chat' && !document.hidden) {
    markRead()
    return
  }
  state.unreadCount += 1
  updateDocumentTitle()
  updateTabs()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.tab === 'chat' && state.unreadCount > 0) {
      markRead()
    }
  })
}

function pushNotice(level, text) {
  state.notices.unshift({ level, text, at: Date.now() })
  state.notices = state.notices.slice(0, 20)
  updateAsideSection('notices')
}

// ------------------------------------------------------------------ 外壳与局部刷新

const TASK_STATUS = {
  queued: '排队中',
  assigned: '已接单',
  running: '执行中',
  waiting_human: '等回答',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  expired: '已过期',
}

const AGENT_STATUS_LABELS = {
  idle: '空闲',
  thinking: '思考中…',
  replying: '回复中…',
}

const ACTIVE_STATUS = ['queued', 'assigned', 'running', 'waiting_human']

const TAB_ITEMS = [
  { id: 'chat', label: '会话' },
  { id: 'tasks', label: '工单' },
  { id: 'devices', label: '设备' },
  { id: 'memory', label: '记忆' },
  { id: 'settings', label: '设置' },
]

function mountAppShell() {
  if (ui.mounted) return
  root.className = 'app'

  const tabButtons = {}
  const tabsNode = el(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Pi Cloud 视图' },
    TAB_ITEMS.map(({ id, label }) => {
      const btn = el('button', {
        class: state.tab === id ? 'tab active' : 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': state.tab === id ? 'true' : 'false',
        onclick: () => switchTab(id),
      })
      btn.append(document.createTextNode(label))
      tabButtons[id] = btn
      return btn
    })
  )

  const statusStrip = el('div', { class: 'status-strip' })
  const themeButton = el('button', {
    class: 'ghost sm',
    type: 'button',
    onclick: () => toggleTheme(),
  })

  const header = el('header', { class: 'top' }, [
    el('div', { class: 'brand-lockup' }, [
      createBrandSeal(20),
      el('div', { class: 'brand-words' }, [
        el('span', { class: 'brand-wordmark', text: 'WORKBENCH' }),
        el('span', { class: 'brand-sep', 'aria-hidden': 'true' }),
        el('span', { class: 'brand-sub', text: 'CLOUD' }),
      ]),
    ]),
    tabsNode,
    el('div', { class: 'header-right' }, [statusStrip, themeButton]),
  ])

  const main = el('main', { class: 'workspace' })
  const footer = el('footer', { class: 'bottom' })

  ui.mounted = true
  ui.tabButtons = tabButtons
  ui.statusStrip = statusStrip
  ui.themeButton = themeButton
  ui.main = main
  ui.footer = footer

  updateThemeButton()
  root.replaceChildren(header, main, footer)
}

function switchTab(id) {
  const changed = state.tab !== id
  state.tab = id
  if (id === 'chat' && !document.hidden && state.unreadCount > 0) {
    markRead()
  }
  if (id === 'memory' && !state.memoryLoaded) {
    void loadMemoryData()
  }
  updateTabs()
  if (changed || !ui.main?.firstChild) {
    renderMain()
  }
}

function updateHeaderState() {
  updateTabs()
  updateStatusStrip()
  updateThemeButton()
}

function updateTabs() {
  if (!ui.mounted) return
  for (const { id, label } of TAB_ITEMS) {
    const btn = ui.tabButtons[id]
    if (!btn) continue
    const active = state.tab === id
    btn.className = active ? 'tab active' : 'tab'
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
    if (id === 'chat' && state.unreadCount > 0) {
      btn.replaceChildren(
        document.createTextNode(label),
        el('span', { class: 'tab-badge', text: String(state.unreadCount) })
      )
    } else {
      btn.replaceChildren(document.createTextNode(label))
    }
  }
}

function updateStatusStrip() {
  if (!ui.statusStrip) return
  const nodes = []
  const online = state.devices.filter((device) => device.online).length

  const wsTone =
    state.wsStatus === 'open' ? 'ok' : state.wsStatus === 'closed' ? 'err' : 'warn'
  const wsLabel =
    state.wsStatus === 'open'
      ? '云端已连接'
      : state.wsStatus === 'connecting'
        ? '连接中…'
        : '云端离线'

  nodes.push(
    el('span', { class: `status-item ${wsTone}` }, [
      el('span', { class: 'status-dot', 'aria-hidden': 'true' }),
      el('span', { text: wsLabel }),
    ]),
    el('span', { class: 'status-item status-devices' }, [
      el('span', { text: `${online}/${state.devices.length} 台设备在线` }),
    ])
  )

  if (state.agentStatus === 'thinking' || state.agentStatus === 'replying') {
    nodes.push(
      el('span', { class: 'status-item ok' }, [
        el('span', { class: 'status-dot', 'aria-hidden': 'true' }),
        el('span', { text: AGENT_STATUS_LABELS[state.agentStatus] || state.agentStatus }),
      ])
    )
  }

  const running = state.tasks.filter((task) => ACTIVE_STATUS.includes(task.status))
  if (running.length > 0) {
    const latest = running[0]
    const device = state.devices.find((item) => item.id === latest.spec?.deviceId)
    const deviceName = device?.name || latest.spec?.deviceId || ''
    const statusText = state.stoppingTaskIds[latest.id]
      ? '正在停止…'
      : TASK_STATUS[latest.status] || latest.status
    if (running.length === 1) {
      const offline = device ? !device.online : false
      nodes.push(
        el('span', {
          class: 'status-task-tag',
          title: `${deviceName} · ${latest.spec?.title || latest.id}`,
          text: `${deviceName} · ${latest.spec?.title || latest.id} · ${statusText} ${duration(latest.startedAt || latest.createdAt)}`,
        }),
        el('button', {
          class: 'sm',
          type: 'button',
          text: state.stoppingTaskIds[latest.id]
            ? '正在停止…'
            : offline
              ? '设备离线，工单已取消'
              : '停止工单',
          disabled: Boolean(state.stoppingTaskIds[latest.id]) || offline,
          onclick: () => {
            state.stoppingTaskIds[latest.id] = true
            send({ type: 'stop_task', taskId: latest.id })
            updateStatusStrip()
            updateAsideSection('tasks')
            if (state.tab === 'tasks') renderTabPageContent()
          },
        })
      )
    } else {
      nodes.push(
        el('button', {
          class: 'status-task-tag',
          type: 'button',
          text: `${running.length} 个工单执行中 · 最近：${latest.id} ${statusText} ${duration(latest.startedAt || latest.createdAt)}`,
          onclick: () => switchTab('tasks'),
        })
      )
    }
  }

  ui.statusStrip.replaceChildren(...nodes)
}

function updateFooter() {
  if (!ui.footer) return
  const online = state.devices.filter((device) => device.online).length
  const versionText = state.me?.version ? `v${state.me.version}` : 'Pi Cloud'
  const agentText = AGENT_STATUS_LABELS[state.agentStatus] || state.agentStatus
  ui.footer.replaceChildren(
    el('span', { text: versionText }),
    el('span', { text: `ws: ${state.wsStatus}` }),
    el('span', { text: `agent: ${agentText}` }),
    el('span', { text: `${online}/${state.devices.length} 在线` }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'footer-seq', text: `seq: ${state.lastSeq}` })
  )
}

function renderMain() {
  if (!ui.mounted || !ui.main) return
  ui.transcript = null
  ui.composerTextarea = null
  ui.sendButton = null
  ui.stopReplyButton = null
  ui.agentStatusLabel = null
  ui.asideSlots = null
  ui.tabPageInner = null

  if (state.tab === 'chat') {
    ui.main.className = state.asideCollapsed ? 'workspace aside-collapsed' : 'workspace'
    const chatNode = renderChat()
    const asideNode = state.asideCollapsed ? renderCollapsedAsideStrip() : renderAside()
    ui.main.replaceChildren(chatNode, asideNode)
    renderTranscript()
    updateChatControls()
    return
  }

  ui.main.className = 'workspace single'
  const inner = el('div', { class: 'tab-page-inner' })
  ui.tabPageInner = inner
  ui.main.replaceChildren(el('div', { class: 'tab-page' }, [inner]))
  renderTabPageContent()
}

function renderTabPageContent() {
  if (!ui.tabPageInner) return
  const focusSnapshot = captureTaskInputFocus(ui.tabPageInner)
  if (state.tab === 'tasks') {
    ui.tabPageInner.replaceChildren(renderTaskCard())
    restoreTaskInputFocus(ui.tabPageInner, focusSnapshot)
    return
  }
  if (state.tab === 'devices') {
    ui.tabPageInner.replaceChildren(renderDeviceCard())
    return
  }
  if (state.tab === 'memory') {
    ui.tabPageInner.replaceChildren(renderMemoryTab())
    return
  }
  ui.tabPageInner.replaceChildren(renderConfigCard())
}

function updateChatControls() {
  if (ui.stopReplyButton) {
    ui.stopReplyButton.disabled = !state.canStopReply
  }
  if (ui.sendButton) {
    ui.sendButton.disabled = !state.draft.trim()
  }
  if (ui.agentStatusLabel) {
    ui.agentStatusLabel.textContent =
      state.agentStatus === 'thinking' || state.agentStatus === 'replying'
        ? AGENT_STATUS_LABELS[state.agentStatus] || state.agentStatus
        : ''
  }
}

function captureTaskInputFocus(container) {
  const active = document.activeElement
  if (!active || !container || !container.contains(active)) return null
  const key = active.getAttribute?.('data-task-input')
  if (!key) return null
  return {
    key,
    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
  }
}

function restoreTaskInputFocus(container, snapshot) {
  if (!snapshot || !container) return
  const escaped =
    typeof window !== 'undefined' && window.CSS?.escape ? window.CSS.escape(snapshot.key) : snapshot.key
  const target = container.querySelector(`[data-task-input="${escaped}"]`)
  if (!target) return
  target.focus()
  if (snapshot.start !== null && snapshot.end !== null && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(snapshot.start, snapshot.end)
  }
}

// ------------------------------------------------------------------ 会话视图

function renderChat() {
  const transcript = el('div', { class: 'transcript', id: 'transcript' })
  let composing = false

  const textarea = el('textarea', {
    placeholder: '说说你想让终端做什么…',
    value: state.draft,
    oncompositionstart: () => {
      composing = true
    },
    oncompositionend: () => {
      composing = false
    },
    oninput: (event) => {
      state.draft = event.target.value
      updateChatControls()
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        sendChat()
      }
    },
  })

  // 绝不能命名为 send，否则会遮蔽全局 WebSocket send(frame)（F-02）
  const sendBtn = el('button', {
    class: 'primary',
    type: 'button',
    text: '发送',
    disabled: !state.draft.trim(),
    onclick: () => sendChat(),
  })

  const stopReply = el('button', {
    type: 'button',
    text: '停止回复',
    disabled: !state.canStopReply,
    onclick: () => send({ type: 'stop_reply' }),
  })

  const confirm = el('button', {
    type: 'button',
    text: '确认方案…',
    onclick: () => renderConfirmPlan(),
  })

  const agentStatusLabel = el('span', { class: 'caption' })

  ui.transcript = transcript
  ui.composerTextarea = textarea
  ui.sendButton = sendBtn
  ui.stopReplyButton = stopReply
  ui.agentStatusLabel = agentStatusLabel

  return el('section', { class: 'chat' }, [
    transcript,
    el('div', { class: 'composer' }, [
      el('div', { class: 'composer-inner' }, [
        textarea,
        el('div', { class: 'row' }, [
          sendBtn,
          stopReply,
          confirm,
          el('span', { class: 'caption composer-hint', text: 'Enter 发送 · Shift+Enter 换行' }),
          el('span', { class: 'spacer' }),
          agentStatusLabel,
        ]),
      ]),
    ]),
  ])
}

function sendChat() {
  const body = state.draft.trim()
  if (!body) return
  state.draft = ''
  state.awaySummary = null
  send({ type: 'say', text: body, clientMessageId: `c-${Date.now().toString(36)}` })
  if (ui.composerTextarea) ui.composerTextarea.value = ''
  updateChatControls()
}

function renderTranscript() {
  const container = ui.transcript || document.getElementById('transcript')
  if (!container) return
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  const nodes = []
  if (state.awaySummary?.text) {
    nodes.push(
      el('article', { class: 'msg away' }, [
        el('div', { class: 'msg-meta' }, [el('span', { class: 'field-label', text: '离线期间汇总' })]),
        el('p', { class: 'plain-body', text: state.awaySummary.text }),
      ])
    )
  }
  if (state.messages.length === 0) {
    nodes.push(
      el('div', { class: 'empty-state' }, [
        el('h2', { class: 'empty-title', text: 'Pi Cloud' }),
        el('p', { class: 'empty-desc', text: '还没有消息。直接说你想让终端做什么。' }),
      ])
    )
  }
  for (const message of state.messages) {
    const traces = message.traces || []
    const isUser = message.role === 'user'
    nodes.push(
      el('article', { class: isUser ? 'msg user' : 'msg' }, [
        el('div', { class: 'msg-meta' }, [
          el('span', { class: 'msg-role', text: isUser ? 'YOU' : 'CLOUD' }),
          el('span', { class: 'msg-time', text: time(message.at) }),
          message.streaming ? el('span', { class: 'msg-streaming', 'aria-label': '输出中' }) : null,
        ]),
        message.text
          ? isUser
            ? el('p', { class: 'plain-body', text: message.text })
            : renderMarkdown(message.text)
          : null,
        traces.length > 0
          ? makeDetails(`trace:${message.id}`, `工具调用（${traces.length}）`, [
              el(
                'ul',
                { class: 'list' },
                traces.map((trace) =>
                  el('li', { class: trace.status === 'error' ? 'danger mono' : 'mono' }, [
                    `${trace.toolName} ${trace.summary}`,
                  ])
                )
              ),
            ])
          : null,
        message.error ? el('p', { class: 'danger mono', text: message.error }) : null,
      ])
    )
  }
  container.replaceChildren(...nodes)
  if (distance < 64) container.scrollTop = container.scrollHeight
}

// ------------------------------------------------------------------ 浮层弹窗

function renderConfirmPlan() {
  const planText = el('textarea', { rows: 4, placeholder: '方案原文（会写进会话记录）' })
  const quota = el('input', { type: 'number', min: '1', max: '50', value: '5' })
  const deviceSelect = el(
    'select',
    {},
    state.devices.map((device) =>
      el('option', { value: device.id, text: `${device.name} (${device.id})` })
    )
  )
  const repoSelect = el('select', {})
  const refreshRepos = () => {
    const device = state.devices.find((item) => item.id === deviceSelect.value)
    const workspaces = (device?.workspaces || []).filter((workspace) => workspace.isGit)
    repoSelect.replaceChildren(
      ...workspaces.map((workspace) =>
        el('option', { value: workspace.path, text: `${workspace.name} — ${workspace.path}` })
      )
    )
  }
  deviceSelect.addEventListener('change', refreshRepos)
  refreshRepos()

  const error = el('p', { class: 'danger caption' })

  const closeModal = () => {
    document.removeEventListener('keydown', onKeyDown)
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeModal()
    }
  }
  document.addEventListener('keydown', onKeyDown)

  const overlay = el(
    'div',
    {
      class: 'modal-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '确认方案并授权派活',
      onclick: (event) => {
        if (event.target === overlay) closeModal()
      },
    },
    [
      el('div', { class: 'panel stack' }, [
        el('div', { class: 'panel-head' }, [
          el('h1', { text: '确认方案并授权派活' }),
          el('button', {
            class: 'ghost sm',
            type: 'button',
            'aria-label': '关闭',
            text: '关闭',
            onclick: closeModal,
          }),
        ]),
        el('p', { class: 'caption', text: '授权范围是「设备 × 仓库」，换设备或换仓库必须重新确认。' }),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '方案原文' }),
          planText,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '设备' }),
          deviceSelect,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '仓库（仅 git）' }),
          repoSelect,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '工单额度' }),
          quota,
        ]),
        error,
        el('div', { class: 'panel-foot' }, [
          el('button', {
            type: 'button',
            text: '取消',
            onclick: closeModal,
          }),
          el('button', {
            class: 'primary',
            type: 'button',
            text: '确认',
            onclick: () => {
              const text = planText.value.trim()
              const deviceId = deviceSelect.value
              const workspacePath = repoSelect.value
              if (!text) {
                error.textContent = '请填写方案原文'
                return
              }
              if (!deviceId || !workspacePath) {
                error.textContent = '请选择设备与仓库'
                return
              }
              const ok = send({
                type: 'confirm_plan',
                planText: text,
                items: [{ deviceId, workspacePath }],
                quota: Number(quota.value) || 5,
              })
              if (ok) closeModal()
            },
          }),
        ]),
      ]),
    ]
  )
  document.body.append(overlay)
  planText.focus()
}

// ------------------------------------------------------------------ 右侧运行态栏

function renderCollapsedAsideStrip() {
  return el('button', {
    class: 'side-collapsed-strip',
    type: 'button',
    title: '展开运行态面板',
    'aria-label': '展开运行态面板',
    'aria-expanded': 'false',
    text: '‹',
    onclick: () => {
      state.asideCollapsed = false
      renderMain()
    },
  })
}

function renderAside() {
  const slots = {
    tasks: el('div', {}, [renderTaskCard()]),
    units: el('div', {}, [renderUnitCard()]),
    devices: el('div', {}, [renderDeviceCard()]),
    auth: el('div', {}, [renderAuthCard()]),
    notices: el('div', {}, [renderNoticeCard()]),
  }
  ui.asideSlots = slots

  return el('aside', { class: 'side-rail' }, [
    el('div', { class: 'side-rail-head' }, [
      el('button', {
        class: 'ghost sm',
        type: 'button',
        title: '收起运行态面板',
        'aria-label': '收起运行态面板',
        'aria-expanded': 'true',
        text: '收起',
        onclick: () => {
          state.asideCollapsed = true
          renderMain()
        },
      }),
      el('span', { class: 'side-rail-title', text: '运行态' }),
    ]),
    el('div', { class: 'side-scroll' }, [
      slots.tasks,
      slots.units,
      slots.devices,
      slots.auth,
      slots.notices,
    ]),
  ])
}

function updateAsideSection(section) {
  if (!ui.asideSlots || !ui.asideSlots[section]) return
  const slot = ui.asideSlots[section]
  if (section === 'tasks') {
    const focusSnapshot = captureTaskInputFocus(slot)
    slot.replaceChildren(renderTaskCard())
    restoreTaskInputFocus(slot, focusSnapshot)
    return
  }
  if (section === 'units') {
    slot.replaceChildren(renderUnitCard())
    return
  }
  if (section === 'devices') {
    slot.replaceChildren(renderDeviceCard())
    return
  }
  if (section === 'auth') {
    slot.replaceChildren(renderAuthCard())
    return
  }
  if (section === 'notices') {
    slot.replaceChildren(renderNoticeCard())
  }
}

function updateAllAside() {
  if (!ui.asideSlots) return
  updateAsideSection('tasks')
  updateAsideSection('units')
  updateAsideSection('devices')
  updateAsideSection('auth')
  updateAsideSection('notices')
}

// ------------------------------------------------------------------ 业务卡片

/**
 * 工作单元（F-19a / A-43）：干净树在工单结束时就自动回收了，
 * 这里出现「有未提交改动」才需要手动结束。
 */
function renderUnitCard() {
  const units = state.units || []
  const items = units.slice(0, 8).map((unit) => {
    const closed = typeof unit.closedAt === 'number'
    const closing = !closed && Boolean(unit.closeRequestedAt)
    const dirty = !closed && Boolean(unit.dirtyAt)
    const label = closed ? '已结束' : closing ? '回收中…' : dirty ? '有未提交改动' : '使用中'
    return el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: 'mono', text: unit.branch || unit.unitId }),
        el('span', { class: 'spacer' }),
        el('span', { class: dirty ? 'caption warn' : 'caption', text: label }),
      ]),
      el('div', { class: 'mono muted', text: unit.worktreePath || unit.workspacePath || '' }),
      closed
        ? null
        : el('button', {
            class: 'sm',
            type: 'button',
            text: closing ? '回收中…' : '结束并回收',
            disabled: closing,
            onclick: () => send({ type: 'close_unit', unitId: unit.unitId }),
          }),
    ])
  })
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h3', { text: '工作单元' })]),
    items.length === 0
      ? el('p', { class: 'caption', text: '还没有工作单元（派活后自动创建，一个单元一个工作树）' })
      : el('ul', { class: 'list' }, items),
    items.length === 0
      ? null
      : el('p', { class: 'caption', text: '工作树干净时工单结束就自动回收；这里只为脏树保留手动入口' }),
  ])
}

function renderTaskCard() {
  const items = state.tasks.map((task) => {
    const active = ACTIVE_STATUS.includes(task.status)
    const spec = task.spec || {}
    const question = task.question
    const device = state.devices.find((item) => item.id === spec.deviceId)
    const offline = device ? !device.online : false
    const stopping = Boolean(state.stoppingTaskIds[task.id])
    const changedFiles = task.result?.changedFiles || task.progress?.changedFiles || []
    const attentionFiles = changedFiles.filter((file) => Boolean(file.attention))
    const normalFiles = changedFiles.filter((file) => !file.attention)
    const secretHits = task.result?.secretHits || task.progress?.secretHits || []
    const hasDetails = Boolean(task.result?.summary) || changedFiles.length > 0 || secretHits.length > 0

    return el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: 'value', text: spec.title || task.id }),
        el('span', { class: 'spacer' }),
        el('span', {
          class: task.status === 'failed' ? 'caption danger' : task.status === 'waiting_human' ? 'caption warn' : 'caption',
          text: stopping ? '正在停止…' : TASK_STATUS[task.status] || task.status,
        }),
      ]),
      el('div', { class: 'mono muted', text: `${spec.deviceId || ''} · ${spec.repo?.workspacePath || ''}` }),
      task.progress?.summary ? el('div', { class: 'caption', text: task.progress.summary }) : null,
      task.status === 'waiting_human' && question
        ? el('div', { class: 'stack' }, [
            el('span', { class: 'caption warn', text: '终端在等你回答' }),
            el('span', { class: 'value', text: question.text }),
            el('div', { class: 'row-nowrap' }, [
              el('input', {
                'data-task-input': `answer:${task.id}`,
                placeholder: '回答',
                value: state.answerDrafts[task.id] || '',
                oninput: (event) => {
                  state.answerDrafts[task.id] = event.target.value
                },
              }),
              el('button', {
                class: 'primary sm',
                type: 'button',
                text: '发送',
                onclick: () => {
                  const text = (state.answerDrafts[task.id] || '').trim()
                  if (!text) return
                  state.answerDrafts[task.id] = ''
                  send({ type: 'task_message', taskId: task.id, text })
                  updateAsideSection('tasks')
                  if (state.tab === 'tasks') renderTabPageContent()
                },
              }),
            ]),
          ])
        : null,
      task.status === 'running' && !offline
        ? el('div', { class: 'row-nowrap' }, [
            el('input', {
              'data-task-input': `inst:${task.id}`,
              placeholder: '向运行中工单追加指令…',
              value: state.instructionDrafts[task.id] || '',
              oninput: (event) => {
                state.instructionDrafts[task.id] = event.target.value
              },
            }),
            el('button', {
              class: 'sm',
              type: 'button',
              text: '追加指令',
              onclick: () => {
                const text = (state.instructionDrafts[task.id] || '').trim()
                if (!text) return
                state.instructionDrafts[task.id] = ''
                send({ type: 'task_message', taskId: task.id, text })
                updateAsideSection('tasks')
                if (state.tab === 'tasks') renderTabPageContent()
              },
            }),
          ])
        : null,
      hasDetails
        ? makeDetails(`task:${task.id}`, '结果与改动清单', [
            task.result?.summary ? el('p', { class: 'plain-body', text: task.result.summary }) : null,
            attentionFiles.length > 0
              ? el('div', {
                  class: 'mono warn',
                  text: `注意：${attentionFiles.map((file) => `${file.path} (${file.attention})`).join(', ')}`,
                })
              : null,
            normalFiles.length > 0
              ? el('div', {
                  class: 'mono muted',
                  text: `普通：${normalFiles.map((file) => file.path).join(', ')}`,
                })
              : null,
            secretHits.length > 0
              ? el('div', {
                  class: 'mono danger',
                  text: `疑似密钥（仅报位置）：${secretHits.map((hit) => `${hit.path}:${hit.line} (${hit.kind})`).join(', ')}`,
                })
              : null,
          ])
        : null,
      task.error ? el('div', { class: 'danger mono', text: task.error }) : null,
      active
        ? el('button', {
            class: 'sm',
            type: 'button',
            text: stopping ? '正在停止…' : offline ? '设备离线，工单已取消' : '停止工单',
            disabled: stopping || offline,
            onclick: () => {
              state.stoppingTaskIds[task.id] = true
              send({ type: 'stop_task', taskId: task.id })
              updateStatusStrip()
              updateAsideSection('tasks')
              if (state.tab === 'tasks') renderTabPageContent()
            },
          })
        : null,
    ])
  })
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h3', { text: '工单' }),
      el('span', { class: 'caption', text: `${state.tasks.length}` }),
    ]),
    items.length === 0 ? el('p', { class: 'caption', text: '还没有工单' }) : el('ul', { class: 'list' }, items),
  ])
}

function renderDeviceCard() {
  const items = state.devices.map((device) =>
    el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: device.online ? 'status-item ok' : 'status-item' }, [
          el('span', { class: 'status-dot', 'aria-hidden': 'true' }),
          el('span', { text: device.name }),
        ]),
        el('span', { class: 'spacer' }),
        el('span', { class: 'mono muted', text: device.platform }),
      ]),
      el('div', { class: 'mono muted', text: device.id }),
      el(
        'div',
        { class: 'mono muted' },
        (device.workspaces || []).map((workspace) =>
          el('div', { text: `${workspace.name}${workspace.isGit ? '' : '（非 git，不可派活）'}` })
        )
      ),
      el('button', {
        class: 'sm danger-btn',
        type: 'button',
        text: '移除',
        onclick: async () => {
          const result = await request('DELETE', `/v1/devices/${encodeURIComponent(device.id)}`)
          if (result.ok) void loadAuxiliary()
        },
      }),
    ])
  )

  const pairButton = el('button', {
    class: 'primary',
    type: 'button',
    text: '生成配对码',
    onclick: async () => {
      const result = await request('POST', '/v1/pair/code')
      if (!result.ok) return
      state.pairCode = result.payload
      updateAsideSection('devices')
      if (state.tab === 'devices') renderTabPageContent()
    },
  })

  const codeBlock = state.pairCode
    ? el('div', { class: 'stack' }, [
        el('div', { class: 'pair-code-value', text: state.pairCode.code }),
        el('div', { class: 'caption', text: `5 分钟内有效：${time(state.pairCode.expiresAt)}` }),
        el('div', { class: 'caption', text: '在桌面端「云端 → 连接云端」里填入这个码。' }),
      ])
    : el('p', { class: 'caption', text: '生成一次性 6 位码，把一台设备接进来。' })

  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h3', { text: '设备' }),
      el('span', { class: 'caption', text: `${state.devices.length}` }),
    ]),
    items.length === 0 ? el('p', { class: 'caption', text: '还没有设备' }) : el('ul', { class: 'list' }, items),
    el('div', { class: 'stack' }, [pairButton, codeBlock]),
  ])
}

function renderAuthCard() {
  const items = state.authorizations.map((item) =>
    el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: 'value', text: `额度 ${item.used}/${item.quota}` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'caption', text: `至 ${time(item.expiresAt)}` }),
      ]),
      el('div', { class: 'caption', text: item.confirmedSummary }),
      el(
        'div',
        { class: 'mono muted' },
        item.items.map((target) => el('div', { text: `${target.deviceId} → ${target.workspacePath}` }))
      ),
      el('button', {
        class: 'sm danger-btn',
        type: 'button',
        text: '撤销',
        onclick: async () => {
          const result = await request('DELETE', `/v1/authorizations/${encodeURIComponent(item.id)}`)
          if (result.ok) void loadAuxiliary()
        },
      }),
    ])
  )
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h3', { text: '已确认的授权' })]),
    items.length === 0
      ? el('p', { class: 'caption', text: '还没有授权：确认方案之后才允许派活' })
      : el('ul', { class: 'list' }, items),
  ])
}

function renderNoticeCard() {
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h3', { text: '最近提示' })]),
    state.notices.length === 0
      ? el('p', { class: 'caption', text: '暂无提示' })
      : el(
          'ul',
          { class: 'list' },
          state.notices.slice(0, 6).map((notice) =>
            el('li', {
              class: notice.level === 'error' ? 'danger caption' : notice.level === 'warn' ? 'warn caption' : 'caption',
              text: `${time(notice.at)} ${notice.text}`,
            })
          )
        ),
  ])
}

/** 固定供应商白名单（与桌面端同一份；模型能力全部来自 Pi catalog） */
const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xiaomi', label: '小米 MiMo' },
  { id: 'xiaomi-token-plan-cn', label: '小米（Token 套餐）' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
]

function formatTokens(value) {
  if (!value) return '-'
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  return `${Math.round(value / 1024)}K`
}

/**
 * 云端模型配置卡。
 *
 * 输入值存在 `state.configDraft` 里，切换供应商或刷新目录只做局部更新，不整页重建。
 */
function renderConfigCard() {
  const config = state.config || { configured: false }
  if (!state.configDraft) {
    state.configDraft = {
      providerId: config.providerId || 'deepseek',
      model: config.model || '',
      apiKey: '',
    }
  }
  const draft = state.configDraft
  const status = el('p', { class: 'caption' })

  const providerSelect = el(
    'select',
    {
      onchange: (event) => {
        draft.providerId = event.target.value
        draft.model = ''
        state.configModels = []
        void loadCatalog()
      },
    },
    PROVIDER_PRESETS.map((entry) => el('option', { value: entry.id, text: entry.label }))
  )
  providerSelect.value = draft.providerId

  const apiKey = el('input', {
    type: 'password',
    autocomplete: 'off',
    value: draft.apiKey,
    placeholder: config.apiKeyMasked
      ? `已保存：${config.apiKeyMasked}（留空表示不改）`
      : 'sk-...',
    oninput: (event) => {
      draft.apiKey = event.target.value
    },
  })

  const modelLabel = el('label', { class: 'field-label', text: '模型' })
  const modelSlot = el('div', {})
  const capabilitySlot = el('p', { class: 'caption' })

  const paintModelField = () => {
    const models = state.configModels || []
    modelLabel.textContent = `模型（catalog 内 ${models.length} 个）`
    if (models.length === 0) {
      modelSlot.replaceChildren(el('p', { class: 'caption', text: '目录里没有这个供应商的模型' }))
      capabilitySlot.textContent = ''
      return
    }
    if (!models.some((model) => model.id === draft.model)) draft.model = models[0].id
    const select = el(
      'select',
      {
        onchange: (event) => {
          draft.model = event.target.value
          paintCapabilities()
        },
      },
      models.map((model) => el('option', { value: model.id, text: model.name || model.id }))
    )
    select.value = draft.model
    modelSlot.replaceChildren(select)
    paintCapabilities()
  }

  const paintCapabilities = () => {
    const model = (state.configModels || []).find((entry) => entry.id === draft.model)
    if (!model) {
      capabilitySlot.textContent = ''
      return
    }
    capabilitySlot.textContent = [
      `上下文 ${formatTokens(model.contextWindow)}`,
      `输出 ${formatTokens(model.maxTokens)}`,
      model.reasoning ? '支持思考' : '不支持思考',
      model.vision ? '图片输入' : '纯文本',
    ].join(' · ')
  }

  const loadCatalog = async () => {
    const result = await request(
      'GET',
      `/v1/cloud-config/catalog?providerId=${encodeURIComponent(draft.providerId)}`
    )
    state.configModels = result.ok ? result.payload?.models || [] : []
    paintModelField()
  }

  const saveButton = el('button', {
    class: 'primary',
    type: 'button',
    text: '保存',
    onclick: async () => {
      const body = {
        providerId: draft.providerId.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim(),
      }
      if (!body.providerId || !body.model) {
        status.textContent = '供应商与模型都要选'
        return
      }
      if (!body.apiKey && !config.apiKeyMasked) {
        status.textContent = '首次配置要填 API Key'
        return
      }
      if (!body.apiKey) {
        status.textContent = '这里需要重新填一次 Key（云端不保存明文可回填的那份）'
        return
      }
      const result = await request('PUT', '/v1/cloud-config', body)
      if (!result.ok) {
        status.textContent = result.payload?.error || '保存失败'
        return
      }
      status.textContent = result.payload?.warning
        ? `已保存，下一轮生效（${result.payload.warning}）`
        : '已保存，下一轮生效'
      // 落盘成功后清空 draft：Key 不再留在页面状态里
      state.configDraft = null
      await loadAuxiliary()
    },
  })

  // 首次进来目录还没拉过则拉取；已有缓存时重渲染必须立刻把模型下拉重画进新 DOM
  if (!state.configModels || state.configModels.length === 0) void loadCatalog()
  else paintModelField()

  return el('div', { class: 'card stack' }, [
    el('div', { class: 'card-head' }, [el('h3', { text: '云端模型配置' })]),
    el('p', {
      class: 'caption',
      text: '只支持 8 家内置供应商；模型能力来自 Pi catalog。Key 加密落盘，只回末四位，设备端的 Key 不会上传到这里。',
    }),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '供应商' }), providerSelect]),
    el('div', { class: 'field' }, [el('label', { class: 'field-label', text: 'API Key' }), apiKey]),
    el('div', { class: 'field' }, [modelLabel, modelSlot]),
    capabilitySlot,
    status,
    el('div', { class: 'row' }, [
      saveButton,
      el('button', {
        type: 'button',
        text: '刷新目录',
        onclick: () => void loadCatalog(),
      }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'danger-btn',
        type: 'button',
        text: '退出登录',
        onclick: async () => {
          await request('POST', '/v1/logout')
          location.reload()
        },
      }),
    ]),
  ])
}

// ------------------------------------------------------------------ 记忆与留存文档

const MEMORY_KIND_LABELS = {
  fact: '事实',
  preference: '偏好',
  project: '项目',
  decision: '决策',
  todo: '待办',
}

async function loadMemoryData() {
  state.memoryBusy = true
  state.memoryFeedback = ''
  if (state.tab === 'memory') renderTabPageContent()
  try {
    const [memRes, docRes, dreamRes] = await Promise.all([
      request('GET', '/v1/memories'),
      request('GET', '/v1/cloud-docs'),
      request('GET', '/v1/dreams'),
    ])
    if (memRes.ok && Array.isArray(memRes.payload?.memories)) {
      state.memories = memRes.payload.memories
    }
    if (docRes.ok && Array.isArray(docRes.payload?.docs)) {
      state.docs = docRes.payload.docs
      for (const doc of state.docs) {
        if (!(doc.name in state.docDrafts)) {
          state.docDrafts[doc.name] = doc.content || ''
        }
      }
    }
    if (dreamRes.ok && Array.isArray(dreamRes.payload?.dreams)) {
      state.dreams = dreamRes.payload.dreams
    }
    state.memoryLoaded = true
  } catch (error) {
    state.memoryFeedback = String(error)
  } finally {
    state.memoryBusy = false
    if (state.tab === 'memory') renderTabPageContent()
  }
}

function renderMemoryTab() {
  const kindSelect = el(
    'select',
    {
      onchange: (event) => {
        state.memoryKindDraft = event.target.value
      },
    },
    Object.entries(MEMORY_KIND_LABELS).map(([value, label]) =>
      el('option', {
        value,
        text: label,
        selected: value === state.memoryKindDraft,
      })
    )
  )

  const memInput = el('input', {
    placeholder: '手工记录一条长期记忆（不会被自动抽取或梦境覆盖）…',
    value: state.memoryContentDraft,
    oninput: (event) => {
      state.memoryContentDraft = event.target.value
    },
  })

  const memoryItems = state.memories.map((item) => {
    const kindText = MEMORY_KIND_LABELS[item.kind] || item.kind
    const sourceText = item.source === 'manual' ? '手工' : item.source === 'dream' ? '梦境' : '自动'
    const editing = state.editingMemoryId === item.id && state.editingMemoryDraft

    if (editing) {
      const editDraft = state.editingMemoryDraft
      const editKindSelect = el(
        'select',
        {
          onchange: (event) => {
            editDraft.kind = event.target.value
          },
        },
        Object.entries(MEMORY_KIND_LABELS).map(([value, label]) =>
          el('option', { value, text: label, selected: value === editDraft.kind })
        )
      )
      const editContentArea = el('textarea', {
        rows: 3,
        value: editDraft.content,
        oninput: (event) => {
          editDraft.content = event.target.value
        },
      })
      const editTagsInput = el('input', {
        placeholder: '标签（逗号分隔，可选）',
        value: editDraft.tagsText,
        oninput: (event) => {
          editDraft.tagsText = event.target.value
        },
      })
      return el('li', {}, [
        el('div', { class: 'mem-edit-box' }, [
          el('div', { class: 'row' }, [
            el('span', { class: 'field-label', text: '编辑记忆（保存后自动升为手工保护）' }),
            el('span', { class: 'spacer' }),
            editKindSelect,
          ]),
          editContentArea,
          editTagsInput,
          el('div', { class: 'row' }, [
            el('button', {
              class: 'primary sm',
              type: 'button',
              text: '保存',
              onclick: async () => {
                const nextContent = editDraft.content.trim()
                if (!nextContent) return
                const res = await request('PATCH', `/v1/memories/${encodeURIComponent(item.id)}`, {
                  kind: editDraft.kind,
                  content: nextContent,
                  tags: parseTagsInput(editDraft.tagsText),
                })
                if (res.ok && res.payload?.memory) {
                  state.memories = state.memories.map((m) => (m.id === item.id ? res.payload.memory : m))
                  state.editingMemoryId = null
                  state.editingMemoryDraft = null
                  state.memoryFeedback = '已保存（已升为手工保护）'
                  renderTabPageContent()
                } else {
                  state.memoryFeedback = res.payload?.error || `保存失败 (HTTP ${res.status})`
                  renderTabPageContent()
                }
              },
            }),
            el('button', {
              class: 'ghost sm',
              type: 'button',
              text: '取消',
              onclick: () => {
                state.editingMemoryId = null
                state.editingMemoryDraft = null
                renderTabPageContent()
              },
            }),
          ]),
        ]),
      ])
    }

    return el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: 'caption', text: `${kindText} · ${sourceText}${item.pinned ? ' · 已置顶' : ''}` }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost sm',
          type: 'button',
          text: '编辑',
          onclick: () => {
            state.editingMemoryId = item.id
            state.editingMemoryDraft = {
              kind: item.kind || 'fact',
              content: item.content || '',
              tagsText: Array.isArray(item.tags) ? item.tags.join(', ') : '',
            }
            renderTabPageContent()
          },
        }),
        el('button', {
          class: 'ghost sm',
          type: 'button',
          text: item.pinned ? '取消置顶' : '置顶',
          onclick: async () => {
            const res = await request('PATCH', `/v1/memories/${encodeURIComponent(item.id)}`, {
              pinned: !item.pinned,
            })
            if (res.ok && res.payload?.memory) {
              state.memories = state.memories.map((m) => (m.id === item.id ? res.payload.memory : m))
              renderTabPageContent()
            }
          },
        }),
        el('button', {
          class: 'ghost sm danger-btn',
          type: 'button',
          text: '删除',
          onclick: async () => {
            const res = await request('DELETE', `/v1/memories/${encodeURIComponent(item.id)}`)
            if (res.ok) {
              state.memories = state.memories.filter((m) => m.id !== item.id)
              renderTabPageContent()
            }
          },
        }),
      ]),
      el('div', { class: 'plain-body', text: item.content }),
      Array.isArray(item.tags) && item.tags.length > 0
        ? el(
            'div',
            { class: 'tag-list' },
            item.tags.map((tag) => el('span', { class: 'tag-chip', text: tag }))
          )
        : null,
    ])
  })

  const currentDocName = state.selectedDoc || 'AGENTS.md'
  const currentDocMeta = state.docs.find((doc) => doc.name === currentDocName)
  const docTextarea = el('textarea', {
    rows: 10,
    placeholder:
      currentDocName === 'SOUL.md'
        ? '定义云端 Agent 的人格、语气与沟通风格…'
        : '定义云端 Agent 必须遵守的长期工作约定与规则…',
    value: state.docDrafts[currentDocName] ?? currentDocMeta?.content ?? '',
    oninput: (event) => {
      state.docDrafts[currentDocName] = event.target.value
    },
  })

  const dreamItems = state.dreams.map((dream) =>
    el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: 'mono muted', text: time(dream.at) }),
        el('span', { class: 'caption', text: dream.trigger === 'manual' ? '手动' : '空闲自动' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'mono muted', text: `+${dream.added} / -${dream.removed}` }),
      ]),
      el('div', { class: 'value', text: dream.summary }),
    ])
  )

  return el('div', { class: 'stack' }, [
    el('div', { class: 'card stack' }, [
      el('div', { class: 'card-head' }, [
        el('h3', { text: '结构化长期记忆' }),
        el('button', {
          class: 'sm',
          type: 'button',
          text: state.memoryBusy ? '刷新中…' : '刷新',
          disabled: state.memoryBusy,
          onclick: () => void loadMemoryData(),
        }),
      ]),
      el('div', { class: 'row-nowrap' }, [
        kindSelect,
        memInput,
        el('button', {
          class: 'primary',
          type: 'button',
          text: '新增记忆',
          onclick: async () => {
            const content = state.memoryContentDraft.trim()
            if (!content) return
            const res = await request('POST', '/v1/memories', {
              kind: state.memoryKindDraft,
              content,
            })
            if (res.ok && res.payload?.memory) {
              state.memoryContentDraft = ''
              state.memories = [res.payload.memory, ...state.memories]
              state.memoryFeedback = '已添加手工记忆'
              renderTabPageContent()
            } else {
              state.memoryFeedback = res.payload?.error || `保存失败 (HTTP ${res.status})`
              renderTabPageContent()
            }
          },
        }),
      ]),
      state.memoryFeedback ? el('p', { class: 'caption accent', text: state.memoryFeedback }) : null,
      memoryItems.length === 0
        ? el('p', { class: 'caption', text: '还没有保存任何长期记忆。对话压缩前会自动提炼，也可以手工新增。' })
        : el('ul', { class: 'list' }, memoryItems),
    ]),

    el('div', { class: 'card stack' }, [
      el('div', { class: 'card-head' }, [
        el('h3', { text: '云端留存文档（实时生效）' }),
        el(
          'div',
          { class: 'row' },
          ['AGENTS.md', 'SOUL.md'].map((name) =>
            el('button', {
              class: currentDocName === name ? 'primary sm' : 'sm',
              type: 'button',
              text: name,
              onclick: () => {
                state.selectedDoc = name
                renderTabPageContent()
              },
            })
          )
        ),
      ]),
      el('p', {
        class: 'caption',
        text: currentDocMeta?.updatedAt
          ? `上次保存：${new Date(currentDocMeta.updatedAt).toLocaleString()}`
          : '尚未创建（保存后立即对下一轮生效）',
      }),
      docTextarea,
      el('div', { class: 'row' }, [
        el('button', {
          class: 'primary',
          type: 'button',
          text: '保存文档',
          onclick: async () => {
            const content = state.docDrafts[currentDocName] ?? ''
            const res = await request('PUT', `/v1/cloud-docs/${encodeURIComponent(currentDocName)}`, {
              content,
            })
            if (res.ok && res.payload?.doc) {
              const saved = res.payload.doc
              state.docs = state.docs.some((d) => d.name === saved.name)
                ? state.docs.map((d) => (d.name === saved.name ? saved : d))
                : [...state.docs, saved]
              state.docDrafts[saved.name] = saved.content
              state.memoryFeedback = `已保存 ${saved.name}`
              renderTabPageContent()
            } else {
              state.memoryFeedback = res.payload?.error || `保存失败 (HTTP ${res.status})`
              renderTabPageContent()
            }
          },
        }),
      ]),
    ]),

    el('div', { class: 'card stack' }, [
      el('div', { class: 'card-head' }, [
        el('h3', { text: '梦境整理记录' }),
        el('button', {
          class: 'sm',
          type: 'button',
          text: '立即整理（梦境）',
          onclick: async () => {
            state.memoryFeedback = '正在整理记忆…'
            renderTabPageContent()
            const res = await request('POST', '/v1/dreams/run', {})
            if (res.ok) {
              await loadMemoryData()
              state.memoryFeedback = res.payload?.dream?.summary || '梦境整理完成'
              renderTabPageContent()
            } else {
              state.memoryFeedback = res.payload?.error || `整理失败 (HTTP ${res.status})`
              renderTabPageContent()
            }
          },
        }),
      ]),
      dreamItems.length === 0
        ? el('p', { class: 'caption', text: '还没有梦境整理记录（空闲 ≥30 分钟且无活跃工单时自动运行，也可手动触发）' })
        : el('ul', { class: 'list' }, dreamItems),
    ]),
  ])
}

void boot()
