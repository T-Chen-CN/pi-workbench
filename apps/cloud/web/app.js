/**
 * Pi Cloud 的 Web 客户端（D-19 / D-26）。
 *
 * 约束：纯 ESM、零构建、零依赖；所有文本都用 textContent 渲染，
 * 任何地方都不拼 innerHTML —— 模型输出、路径、工单标题都是不可信输入。
 */

const state = {
  me: null,
  ws: null,
  wsStatus: 'closed',
  reconnectDelay: 1000,
  lastSeq: 0,
  tab: 'chat',
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
}

const root = document.getElementById('root')

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
    else node.setAttribute(key, String(value))
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
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
  root.className = 'center'
  root.replaceChildren(
    el('div', { class: 'panel stack' }, [
      el('h1', { text: 'Pi Cloud' }),
      el('p', { class: 'danger', text: message }),
    ])
  )
}

function renderSetup() {
  root.className = 'center'
  const password = el('input', { type: 'password', autocomplete: 'new-password' })
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' })
  const error = el('p', { class: 'danger' })
  const submit = el('button', { class: 'primary', text: '创建管理员账号' })
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
      el('h1', { text: 'Pi Cloud' }),
      el('p', { class: 'muted', text: '首次使用：创建唯一的管理员账号。' }),
      el('label', { class: 'mono muted', text: '密码' }),
      password,
      el('label', { class: 'mono muted', text: '确认密码' }),
      confirm,
      error,
      submit,
    ])
  )
}

function renderLogin(notice) {
  root.className = 'center'
  const password = el('input', { type: 'password', autocomplete: 'current-password' })
  const error = el('p', { class: 'danger' })
  if (notice) error.textContent = notice
  const submit = el('button', { class: 'primary', text: '登录' })
  const doLogin = async () => {
    error.textContent = ''
    const result = await request('POST', '/v1/login', { password: password.value })
    if (!result.ok) {
      error.textContent =
        result.status === 429 ? '尝试过于频繁，稍后再试' : '密码不正确'
      return
    }
    await enterApp()
  }
  submit.addEventListener('click', () => void doLogin())
  password.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void doLogin()
  })
  root.replaceChildren(
    el('div', { class: 'panel stack' }, [
      el('h1', { text: 'Pi Cloud' }),
      el('p', { class: 'muted', text: '登录云端控制台。' }),
      el('label', { class: 'mono muted', text: '密码' }),
      password,
      error,
      submit,
    ])
  )
  password.focus()
}

// ------------------------------------------------------------------ 主界面

async function enterApp() {
  root.className = 'app'
  root.replaceChildren()
  render()
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
  render()
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
  render()

  socket.addEventListener('open', () => {
    opened = true
    state.wsStatus = 'open'
    state.reconnectDelay = 1000
    render()
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
    render()
    // 升级阶段就被拒（登录态过期 → 401）时只会看到 1006：标记一下，重连前先回查登录态，
    // 否则就是无限“正在重连…”且永远不成功。
    if (state.me?.authenticated) scheduleReconnect(!opened)
  })
  socket.addEventListener('error', () => {
    state.wsStatus = 'closed'
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
  if (typeof frame.seq === 'number' && frame.seq > state.lastSeq) state.lastSeq = frame.seq

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
    state.stoppingTaskIds = {}
    state.agentStatus = snapshot.cloud?.status || 'idle'
    state.canStopReply = Boolean(snapshot.cloud?.canStopReply)
    render()
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
      renderPills()
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
      render()
      return
    }
    case 'unit': {
      const unit = event.unit
      if (!unit) return
      const index = state.units.findIndex((item) => item.unitId === unit.unitId)
      if (index >= 0) state.units[index] = unit
      else state.units.unshift(unit)
      renderAside()
      return
    }
    case 'device': {
      const device = event.device
      if (!device) return
      const index = state.devices.findIndex((item) => item.id === device.id)
      if (index >= 0) state.devices[index] = device
      else state.devices.push(device)
      renderAside()
      return
    }
    case 'notice':
      pushNotice(event.level || 'info', event.text || '')
      return
    default:
      return
  }
}

function pushNotice(level, text) {
  state.notices.unshift({ level, text, at: Date.now() })
  state.notices = state.notices.slice(0, 20)
  renderAside()
}

// ------------------------------------------------------------------ 渲染

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

const ACTIVE_STATUS = ['queued', 'assigned', 'running', 'waiting_human']

function render() {
  const header = el('header', { class: 'top' }, [
    el('span', { class: 'brand', text: 'PI CLOUD' }),
    el('div', { class: 'tabs' }, [
      tabButton('chat', '会话'),
      tabButton('tasks', '工单'),
      tabButton('devices', '设备'),
      tabButton('settings', '设置'),
    ]),
    el('span', { class: 'spacer' }),
    ...renderPills(),
  ])

  // 右栏只跟会话页搭配；工单 / 设备 / 设置页本来就是整页看同一批卡片，再放一遍就重复了
  const main =
    state.tab === 'chat'
      ? el('main', {}, [renderChat(), renderAside()])
      : el('main', {}, [renderTabBody()])

  root.replaceChildren(
    header,
    main,
    el('footer', { class: 'bottom' }, [
      el('span', { text: `v${state.config?.updatedAt ? '1' : '1'}` }),
      el('span', { text: `ws: ${state.wsStatus}` }),
      el('span', { text: `agent: ${state.agentStatus}` }),
      el('span', { text: `seq: ${state.lastSeq}` }),
    ])
  )
  renderTranscript()
}

function tabButton(id, label) {
  return el('button', {
    class: state.tab === id ? 'tab active' : 'tab',
    text: label,
    onclick: () => {
      state.tab = id
      render()
    },
  })
}

function renderPills() {
  const pills = []
  const online = state.devices.filter((device) => device.online).length
  pills.push(
    el('span', {
      class: state.wsStatus === 'open' ? 'pill on' : state.wsStatus === 'closed' ? 'pill err' : 'pill',
      text: state.wsStatus === 'open' ? '云端已连接' : '云端离线',
    }),
    el('span', { class: 'pill', text: `${online}/${state.devices.length} 台设备在线` })
  )
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
      pills.push(
        el('span', {
          class: 'pill on',
          text: `${deviceName} · ${latest.spec?.title || latest.id} · ${statusText} ${duration(latest.startedAt || latest.createdAt)}`,
        }),
        el('button', {
          text: state.stoppingTaskIds[latest.id]
            ? '正在停止…'
            : offline
              ? '设备离线，工单已取消'
              : '停止工单',
          disabled: Boolean(state.stoppingTaskIds[latest.id]) || offline,
          onclick: () => {
            state.stoppingTaskIds[latest.id] = true
            send({ type: 'stop_task', taskId: latest.id })
            render()
          },
        })
      )
    } else {
      pills.push(
        el('button', {
          class: 'pill on',
          text: `${running.length} 个工单执行中 · 最近：${latest.id} ${statusText} ${duration(latest.startedAt || latest.createdAt)}`,
          onclick: () => {
            state.tab = 'tasks'
            render()
          },
        })
      )
    }
  }
  return pills
}

function renderChat() {
  const transcript = el('div', { class: 'transcript', id: 'transcript' })
  const textarea = el('textarea', {
    placeholder: '说说你想让终端做什么…',
    value: state.draft,
    oninput: (event) => {
      state.draft = event.target.value
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        sendChat()
      }
    },
  })
  const send = el('button', {
    class: 'primary',
    text: '发送',
    onclick: () => sendChat(),
  })
  const stopReply = el('button', {
    text: '停止回复',
    disabled: !state.canStopReply,
    onclick: () => send({ type: 'stop_reply' }),
  })
  const confirm = el('button', {
    text: '确认方案…',
    onclick: () => renderConfirmPlan(),
  })

  return el('section', { class: 'chat' }, [
    transcript,
    el('div', { class: 'composer' }, [
      textarea,
      el('div', { class: 'row' }, [
        send,
        stopReply,
        confirm,
        el('span', { class: 'spacer' }),
        el('span', { class: 'mono muted', text: state.agentStatus }),
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
  const textarea = document.querySelector('textarea')
  if (textarea) textarea.value = ''
}

function renderTranscript() {
  const container = document.getElementById('transcript')
  if (!container) return
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  const nodes = []
  if (state.awaySummary?.text) {
    nodes.push(
      el('article', { class: 'msg' }, [
        el('div', { class: 'meta' }, [el('span', { text: '离线期间汇总' })]),
        el('p', { class: 'body', text: state.awaySummary.text }),
      ])
    )
  }
  if (state.messages.length === 0) {
    nodes.push(
      el('p', { class: 'muted', text: '还没有消息。直接说你想让终端做什么。' })
    )
  }
  for (const message of state.messages) {
    const traces = message.traces || []
    nodes.push(
      el('article', { class: message.role === 'user' ? 'msg user' : 'msg' }, [
        el('div', { class: 'meta' }, [
          el('span', { text: message.role === 'user' ? 'YOU' : 'CLOUD' }),
          el('span', { text: time(message.at) }),
          message.streaming ? el('span', { class: 'accent', text: '···' }) : null,
        ]),
        message.text ? el('p', { class: 'body', text: message.text }) : null,
        traces.length > 0
          ? el('details', { class: 'trace' }, [
              el('summary', { text: `${traces.length} tool calls` }),
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

function renderConfirmPlan() {
  const planText = el('textarea', { placeholder: '方案原文（会写进会话记录）' })
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

  const error = el('p', { class: 'danger' })
  const overlay = el('div', { class: 'center' }, [
    el('div', { class: 'panel stack' }, [
      el('h1', { text: '确认方案并授权派活' }),
      el('p', { class: 'muted', text: '授权范围是「设备 × 仓库」，换设备或换仓库必须重新确认。' }),
      planText,
      el('label', { class: 'mono muted', text: '设备' }),
      deviceSelect,
      el('label', { class: 'mono muted', text: '仓库（仅 git）' }),
      repoSelect,
      el('label', { class: 'mono muted', text: '工单额度' }),
      quota,
      error,
      el('div', { class: 'row' }, [
        el('button', {
          class: 'primary',
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
            if (ok) document.body.removeChild(overlay)
          },
        }),
        el('button', {
          text: '取消',
          onclick: () => document.body.removeChild(overlay),
        }),
      ]),
    ]),
  ])
  document.body.append(overlay)
}

function renderTabBody() {
  if (state.tab === 'tasks') return el('section', { class: 'transcript' }, [renderTaskCard()])
  if (state.tab === 'devices') return el('section', { class: 'transcript' }, [renderDeviceCard()])
  return el('section', { class: 'transcript' }, [renderConfigCard()])
}

/**
 * 右栏：工单 / 设备 / 授权 / 提示。
 *
 * 必须是**纯构造**并返回节点：之前写成去 `querySelector('aside')` 原地替换，可页面上
 * 根本没有 aside（它本身就负责生成它），于是返回 undefined、整栏静默不渲染，
 * 连带「点生成配对码没反应，切个页面才出现」。
 */
function renderAside() {
  return el('aside', {}, [
    renderTaskCard(),
    renderUnitCard(),
    renderDeviceCard(),
    renderAuthCard(),
    renderNoticeCard(),
  ])
}

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
        el('span', { text: unit.branch || unit.unitId }),
        el('span', { class: 'spacer' }),
        el('span', { class: dirty ? 'mono warn' : 'mono muted', text: label }),
      ]),
      el('div', { class: 'mono muted', text: unit.worktreePath || unit.workspacePath || '' }),
      closed
        ? null
        : el('button', {
            text: closing ? '回收中…' : '结束并回收',
            disabled: closing ? 'disabled' : null,
            onclick: () => send({ type: 'close_unit', unitId: unit.unitId }),
          }),
    ])
  })
  return el('div', { class: 'card' }, [
    el('h3', { text: '工作单元' }),
    items.length === 0
      ? el('p', { class: 'muted', text: '还没有工作单元（派活后自动创建，一个单元一个工作树）' })
      : el('ul', { class: 'list' }, items),
    items.length === 0
      ? null
      : el('p', { class: 'muted', text: '工作树干净时工单结束就自动回收；这里只为脏树保留手动入口' }),
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
        el('span', { text: spec.title || task.id }),
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'mono muted',
          text: stopping ? '正在停止…' : TASK_STATUS[task.status] || task.status,
        }),
      ]),
      el('div', { class: 'mono muted', text: `${spec.deviceId || ''} · ${spec.repo?.workspacePath || ''}` }),
      task.progress?.summary ? el('div', { class: 'muted', text: task.progress.summary }) : null,
      task.status === 'waiting_human' && question
        ? el('div', { class: 'stack' }, [
            el('span', { class: 'warn', text: '终端在等你回答' }),
            el('span', { text: question.text }),
            el('div', { class: 'row' }, [
              el('input', {
                placeholder: '回答',
                value: state.answerDrafts[task.id] || '',
                oninput: (event) => {
                  state.answerDrafts[task.id] = event.target.value
                },
              }),
              el('button', {
                text: '发送',
                onclick: () => {
                  const text = (state.answerDrafts[task.id] || '').trim()
                  if (!text) return
                  state.answerDrafts[task.id] = ''
                  send({ type: 'say', text: `关于工单 ${task.id}：${text}`, clientMessageId: `c-${Date.now().toString(36)}` })
                },
              }),
            ]),
          ])
        : null,
      hasDetails
        ? el('details', { class: 'trace' }, [
            el('summary', { text: '结果与改动清单' }),
            task.result?.summary ? el('p', { class: 'body', text: task.result.summary }) : null,
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
            text: stopping ? '正在停止…' : offline ? '设备离线，工单已取消' : '停止工单',
            disabled: stopping || offline,
            onclick: () => {
              state.stoppingTaskIds[task.id] = true
              send({ type: 'stop_task', taskId: task.id })
              render()
            },
          })
        : null,
    ])
  })
  return el('div', { class: 'card' }, [
    el('h3', { text: '工单' }),
    items.length === 0 ? el('p', { class: 'muted', text: '还没有工单' }) : el('ul', { class: 'list' }, items),
  ])
}

function renderDeviceCard() {
  const items = state.devices.map((device) =>
    el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { class: device.online ? 'accent' : 'muted', text: device.name }),
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
    text: '生成配对码',
    onclick: async () => {
      const result = await request('POST', '/v1/pair/code')
      if (!result.ok) return
      state.pairCode = result.payload
      render()
    },
  })

  const codeBlock = state.pairCode
    ? el('div', { class: 'stack' }, [
        el('div', { class: 'mono accent', style: 'font-size:22px;letter-spacing:0.24em', text: state.pairCode.code }),
        el('div', { class: 'muted mono', text: `5 分钟内有效：${time(state.pairCode.expiresAt)}` }),
        el('div', { class: 'muted', text: '在桌面端「云端 → 连接云端」里填入这个码。' }),
      ])
    : el('p', { class: 'muted', text: '生成一次性 6 位码，把一台设备接进来。' })

  return el('div', { class: 'card' }, [
    el('h3', { text: '设备' }),
    items.length === 0 ? el('p', { class: 'muted', text: '还没有设备' }) : el('ul', { class: 'list' }, items),
    el('div', { class: 'stack' }, [pairButton, codeBlock]),
  ])
}

function renderAuthCard() {
  const items = state.authorizations.map((item) =>
    el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { text: `额度 ${item.used}/${item.quota}` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'mono muted', text: `至 ${time(item.expiresAt)}` }),
      ]),
      el('div', { class: 'muted', text: item.confirmedSummary }),
      el(
        'div',
        { class: 'mono muted' },
        item.items.map((target) => el('div', { text: `${target.deviceId} → ${target.workspacePath}` }))
      ),
      el('button', {
        text: '撤销',
        onclick: async () => {
          const result = await request('DELETE', `/v1/authorizations/${encodeURIComponent(item.id)}`)
          if (result.ok) void loadAuxiliary()
        },
      }),
    ])
  )
  return el('div', { class: 'card' }, [
    el('h3', { text: '已确认的授权' }),
    items.length === 0
      ? el('p', { class: 'muted', text: '还没有授权：确认方案之后才允许派活' })
      : el('ul', { class: 'list' }, items),
  ])
}

function renderNoticeCard() {
  if (state.notices.length === 0) return el('div', { class: 'card' }, [el('h3', { text: '最近提示' })])
  return el('div', { class: 'card' }, [
    el('h3', { text: '最近提示' }),
    el(
      'ul',
      { class: 'list' },
      state.notices.slice(0, 6).map((notice) =>
        el('li', {
          class: notice.level === 'error' ? 'danger mono' : notice.level === 'warn' ? 'warn mono' : 'muted mono',
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
 * **输入值必须存在 `state.configDraft` 里，不能只靠 DOM**：整页 `render()` 在收到任何
 * WS 帧（流式输出）时都会重跑，DOM 会被重建一次；值只留在 input 上等于「说一句话就把
 * 刚填的 Key 抹掉」。所以输入都从 draft 回填，oninput 立刻写回 draft。
 * 同理，切换供应商时只做局部更新，不整页 render()。
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
  const status = el('p', { class: 'muted' })

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

  const modelLabel = el('label', { class: 'mono muted', text: '模型' })
  const modelSlot = el('div', {})
  const capabilitySlot = el('p', { class: 'muted mono' })

  const paintModelField = () => {
    const models = state.configModels || []
    modelLabel.textContent = `模型（catalog 内 ${models.length} 个）`
    if (models.length === 0) {
      modelSlot.replaceChildren(el('p', { class: 'muted', text: '目录里没有这个供应商的模型' }))
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
      render()
    },
  })

  // 首次进来目录还没拉过则拉取；已有缓存时重渲染必须立刻把模型下拉重画进新 DOM
  if (!state.configModels || state.configModels.length === 0) void loadCatalog()
  else paintModelField()

  return el('div', { class: 'card stack' }, [
    el('h3', { text: '云端模型配置' }),
    el('p', {
      class: 'muted',
      text: '只支持 8 家内置供应商；模型能力来自 Pi catalog。Key 加密落盘，只回末四位，设备端的 Key 不会上传到这里。',
    }),
    el('label', { class: 'mono muted', text: '供应商' }),
    providerSelect,
    el('label', { class: 'mono muted', text: 'API Key' }),
    apiKey,
    modelLabel,
    modelSlot,
    capabilitySlot,
    status,
    el('div', { class: 'row' }, [
      saveButton,
      el('button', {
        text: '刷新目录',
        onclick: () => void loadCatalog(),
      }),
    ]),
    el('button', {
      text: '退出登录',
      onclick: async () => {
        await request('POST', '/v1/logout')
        location.reload()
      },
    }),
  ])
}

void boot()
