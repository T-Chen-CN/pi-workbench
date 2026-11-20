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
  devices: [],
  authorizations: [],
  notices: [],
  config: null,
  pairCode: null,
  configDraft: null,
  configModels: [],
  fetchingModels: false,
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
  return { ok: response.ok, status: response.status, payload }
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

function renderLogin() {
  root.className = 'center'
  const password = el('input', { type: 'password', autocomplete: 'current-password' })
  const error = el('p', { class: 'danger' })
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
  const url = `${scheme}//${location.host}/client/ws?lastAckSeq=${state.lastSeq}`
  let socket
  try {
    socket = new WebSocket(url)
  } catch {
    scheduleReconnect()
    return
  }
  state.ws = socket
  state.wsStatus = 'connecting'
  render()

  socket.addEventListener('open', () => {
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
    if (state.me?.authenticated) scheduleReconnect()
  })
  socket.addEventListener('error', () => {
    state.wsStatus = 'closed'
  })
}

function scheduleReconnect() {
  const delay = state.reconnectDelay
  state.reconnectDelay = Math.min(30000, Math.round(state.reconnectDelay * 1.8))
  setTimeout(() => connect(), delay)
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
    state.authorizations = snapshot.authorizations || []
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
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const row = state.messages[index]
        if (row.role !== 'assistant' || !row.streaming) continue
        row.text = event.text || row.text
        row.streaming = false
        row.error = event.error
        break
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

  const main =
    state.tab === 'chat'
      ? el('main', {}, [renderChat(), renderAside()])
      : el('main', {}, [renderTabBody(), renderAside()])

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
    pills.push(
      el('span', {
        class: 'pill on',
        text:
          running.length === 1
            ? `${latest.spec?.title || latest.id} · ${TASK_STATUS[latest.status] || latest.status} ${duration(latest.startedAt)}`
            : `${running.length} 个工单执行中 · ${latest.spec?.title || latest.id}`,
      })
    )
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
  send({ type: 'say', text: body, clientMessageId: `c-${Date.now().toString(36)}` })
  const textarea = document.querySelector('textarea')
  if (textarea) textarea.value = ''
}

function renderTranscript() {
  const container = document.getElementById('transcript')
  if (!container) return
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight
  const nodes = []
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

function renderAside() {
  const aside = document.querySelector('aside')
  if (!aside) return
  aside.replaceChildren(renderTaskCard(), renderDeviceCard(), renderAuthCard(), renderNoticeCard())
}

function renderTaskCard() {
  const items = state.tasks.map((task) => {
    const active = ACTIVE_STATUS.includes(task.status)
    const spec = task.spec || {}
    const question = task.question
    return el('li', {}, [
      el('div', { class: 'row' }, [
        el('span', { text: spec.title || task.id }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'mono muted', text: TASK_STATUS[task.status] || task.status }),
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
      task.status === 'done' && task.result?.summary
        ? el('details', { class: 'trace' }, [
            el('summary', { text: '结果与改动清单' }),
            el('p', { class: 'body', text: task.result.summary }),
            task.result.changedFiles?.length
              ? el('div', { class: 'mono muted', text: task.result.changedFiles.map((file) => file.path).join(', ') })
              : null,
          ])
        : null,
      task.error ? el('div', { class: 'danger mono', text: task.error }) : null,
      active
        ? el('button', {
            text: '停止工单',
            onclick: () => send({ type: 'stop_task', taskId: task.id }),
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
      renderAside()
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

/** 渠道预设：选中后自动填 Base URL（与桌面端 apiConfig 同一套口径） */
const PROVIDER_PRESETS = [
  { id: 'custom', label: 'custom（任意 OpenAI 兼容 / 代理）', apiUrl: '' },
  { id: 'openai', label: 'openai', apiUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'anthropic', apiUrl: 'https://api.anthropic.com/v1' },
]

function renderConfigCard() {
  const config = state.config || { configured: false }
  const draft = state.configDraft || {
    provider: config.provider || 'custom',
    apiUrl: config.apiUrl || '',
    model: config.model || '',
    apiKey: '',
  }
  const models = state.configModels || []
  const status = el('p', { class: 'muted' })
  const modelInput = el('input', {
    value: draft.model || '',
    placeholder: '可以手填，例如 claude-sonnet-4-5',
  })

  const providerSelect = el(
    'select',
    {
      onchange: (event) => {
        draft.provider = event.target.value
        const preset = PROVIDER_PRESETS.find((entry) => entry.id === draft.provider)
        if (preset && preset.apiUrl && !draft.apiUrl) draft.apiUrl = preset.apiUrl
        state.configDraft = draft
        render()
      },
    },
    PROVIDER_PRESETS.map((entry) =>
      el('option', { value: entry.id, text: entry.label, selected: entry.id === draft.provider })
    )
  )

  const apiUrl = el('input', {
    value: draft.apiUrl || '',
    placeholder: 'https://api.example.com/v1',
    oninput: (event) => {
      draft.apiUrl = event.target.value
    },
  })

  const apiKey = el('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: config.apiKeyMasked ? `已保存：${config.apiKeyMasked}（留空表示不改）` : 'sk-...',
    oninput: (event) => {
      draft.apiKey = event.target.value
    },
  })

  // 拿到列表就用下拉，拿不到就允许手填 —— 不是所有代理商都实现 /models
  const modelField =
    models.length > 0
      ? el(
          'select',
          {
            onchange: (event) => {
              draft.model = event.target.value
            },
          },
          models.map((id) => el('option', { value: id, text: id, selected: id === draft.model }))
        )
      : modelInput

  const fetchButton = el('button', {
    text: state.fetchingModels ? '拉取中…' : '获取可用模型',
    onclick: async () => {
      state.fetchingModels = true
      state.configDraft = draft
      render()
      const result = await request('POST', '/v1/cloud-config/models', {
        provider: draft.provider,
        apiUrl: draft.apiUrl,
        apiKey: draft.apiKey,
      })
      state.fetchingModels = false
      if (result.ok) {
        state.configModels = result.payload?.models || []
        if (state.configModels.length === 0) status.textContent = '供应商返回了空列表，可以手填'
        else if (!draft.model || !state.configModels.includes(draft.model)) draft.model = state.configModels[0]
      } else {
        status.textContent = `获取失败：${result.payload?.error || result.status}`
      }
      render()
    },
  })

  return el('div', { class: 'card stack' }, [
    el('h3', { text: '云端模型配置' }),
    el('p', { class: 'muted', text: '桌面端与 Web 写的是同一份配置；Key 加密落盘，只回末四位。' }),
    el('label', { class: 'mono muted', text: '渠道' }),
    providerSelect,
    el('label', { class: 'mono muted', text: 'Base URL' }),
    apiUrl,
    el('label', { class: 'mono muted', text: 'API Key（留空表示不改）' }),
    apiKey,
    el('div', { class: 'row' }, [fetchButton]),
    el('label', { class: 'mono muted', text: models.length > 0 ? `模型（共 ${models.length} 个）` : '模型' }),
    modelField,
    status,
    el('button', {
      class: 'primary',
      text: '保存',
      onclick: async () => {
        const body = {
          provider: String(providerSelect.value || '').trim(),
          apiUrl: String(apiUrl.value || '').trim(),
          model: String(modelField.value || draft.model || '').trim(),
          apiKey: String(apiKey.value || '').trim(),
        }
        if (!body.provider || !body.apiUrl || !body.model) {
          status.textContent = '渠道、Base URL、模型都要填'
          return
        }
        if (!body.apiKey && !config.apiKeyMasked) {
          status.textContent = '首次配置要填 API Key'
          return
        }
        const result = await request('PUT', '/v1/cloud-config', body)
        status.textContent = result.ok ? '已保存，下一轮生效' : result.payload?.error || '保存失败'
        if (result.ok) {
          state.configDraft = null
          state.configModels = []
          await loadAuxiliary()
          render()
        }
      },
    }),
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
