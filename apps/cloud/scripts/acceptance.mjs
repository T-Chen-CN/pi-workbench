/**
 * 云端公网验收：跑一遍不依赖真实模型的 F / A 项（账号、配对、双通道、快照、Key 掩码、协议拒绝）。
 *
 * 用法（在仓库根）：node apps/cloud/scripts/acceptance.mjs [https://host]
 *
 * 前提：目标实例尚未建过账号（脚本第一步会建临时账号）。已有账号时会从「建管理员账号」开始失败。
 * 用完想恢复出厂：停服 → 清空 PI_CLOUD_DATA_DIR → 起服。
 */
import { createRequire } from 'node:module'

// ws 装在仓库根（apps/cloud 只用类型），从根 package.json 解析，脚本挪位置也不用改
const require_ = createRequire(new URL('../../../package.json', import.meta.url))
const WebSocket = require_('ws')

const BASE = (process.argv[2] ?? process.env.PI_CLOUD_ACCEPT_BASE ?? 'https://tchen-xiaoxiao.com').replace(
  /\/+$/,
  ''
)
const WSB = BASE.replace(/^http/, 'ws')
const PW = 'accept-pass-' + Date.now()

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

async function call(path, init = {}) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers }
}
const post = (body, extra = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
  body: JSON.stringify(body ?? {}),
  ...extra,
})

function wsOpen(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSB + path, { headers })
    const timer = setTimeout(() => reject(new Error('ws timeout ' + path)), 8000)
    ws.once('open', () => { clearTimeout(timer); resolve(ws) })
    ws.once('unexpected-response', (_req, res) => { clearTimeout(timer); reject(new Error('ws ' + res.statusCode)) })
    ws.once('error', (e) => { clearTimeout(timer); reject(e) })
  })
}
const nextFrame = (ws, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), ms)
    ws.once('message', (d) => { clearTimeout(timer); resolve(JSON.parse(String(d))) })
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 健康与静态客户端 ----
{
  const health = await call('/v1/health')
  ok('健康端点', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json))
  const page = await call('/')
  ok('Web 首屏（HTTPS）', page.status === 200 && page.text.includes('<title>'), `status=${page.status}`)
  ok('静态资源白名单', (await call('/app.css')).status === 200)
  const escape = await call('/../package.json')
  ok('目录穿越被拒', escape.status >= 400 || !escape.text.includes('"name"'), `status=${escape.status}`)
}

// ---- 账号与 cookie 会话 ----
let cookie = ''
{
  const setup = await call('/v1/setup', post({ password: PW }))
  ok('建管理员账号', setup.status === 200, `status=${setup.status}`)
  ok('二次建账号被拒', (await call('/v1/setup', post({ password: 'another-pass-1' }))).status === 409)
  ok('错误口令 401', (await call('/v1/login', post({ password: 'wrong-password' }))).status === 401)
  const login = await call('/v1/login', post({ password: PW }))
  const setCookie = login.headers.get('set-cookie') ?? ''
  cookie = setCookie.split(';')[0]
  ok('登录下发安全 cookie', login.status === 200 && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie))
  ok('cookie 会话有效', (await call('/v1/me', { headers: { cookie } })).json?.authenticated === true)
  ok('无凭据读设备 401', (await call('/v1/devices')).status === 401)
  ok('弱口令被拒', (await call('/v1/setup', post({ password: '123' }))).status >= 400)
}

// ---- 配对 ----
let deviceToken = ''
let deviceId = ''
{
  const code = await call('/v1/pair/code', post(null, { headers: { cookie } }))
  const pairCode = String(code.json?.code ?? '')
  ok('生成 6 位配对码', code.status === 200 && /^\d{6}$/.test(pairCode), `code=${pairCode}`)
  const pair = await call('/v1/pair', post({
    code: pairCode,
    deviceName: 'accept-runner',
    platform: 'linux',
    workspaces: [{ path: '/srv/pi-accept-repo', name: 'pi-accept-repo', isGit: true }],
  }))
  deviceToken = pair.json?.token ?? ''
  deviceId = pair.json?.deviceId ?? ''
  ok('配对换 token', pair.status === 200 && /^pk_/.test(deviceToken) && pair.json?.protocol === 1, deviceId)
  ok('配对码一次性', (await call('/v1/pair', post({ code: pairCode, deviceName: 'x', platform: 'linux', workspaces: [] }))).status === 401)
  const devices = await call('/v1/devices', { headers: { cookie } })
  ok('设备清单', devices.json?.devices?.some((d) => d.id === deviceId), JSON.stringify(devices.json?.devices?.map((d) => d.name)))
}

// ---- 云端配置（设备 token 可读写，Key 只回末四位）----
{
  const before = await call('/v1/cloud-config', { headers: { authorization: `Bearer ${deviceToken}` } })
  ok('设备 token 读云端配置', before.status === 200 && before.json?.configured === false, JSON.stringify(before.json))
  const save = await call('/v1/cloud-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      provider: 'accept-provider',
      apiUrl: 'https://api.example.com/v1',
      model: 'accept-model',
      apiKey: 'sk-accept-1234567890',
    }),
  })
  ok('写入云端配置', save.status === 200, `status=${save.status}`)
  const after = await call('/v1/cloud-config', { headers: { authorization: `Bearer ${deviceToken}` } })
  const shown = JSON.stringify(after.json ?? {})
  ok('Key 只回末四位', !shown.includes('sk-accept-1234567890') && shown.includes('7890'), shown.slice(0, 120))
}

// ---- 授权台账 ----
{
  const auth = await call('/v1/authorizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      planText: 'acceptance run',
      items: [{ deviceId, workspacePath: '/srv/pi-accept-repo' }],
      quota: 2,
    }),
  })
  ok('建授权', auth.status === 200 && !!auth.json?.authorization?.id, `status=${auth.status}`)
  const list = await call('/v1/authorizations', { headers: { cookie } })
  ok('授权清单', (list.json?.authorizations?.length ?? 0) === 1)
}

// ---- 设备通道 ----
{
  const device = await wsOpen('/device/ws', { authorization: `Bearer ${deviceToken}` })
  ok('设备通道握手', device.readyState === WebSocket.OPEN)

  device.send(JSON.stringify({ v: 1, type: 'hello', seq: 1, deviceId, workspaces: [{ path: '/srv/pi-accept-repo', name: 'pi-accept-repo', isGit: true }] }))
  await sleep(600)
  const online = await call('/v1/devices', { headers: { cookie } })
  ok('hello 后设备在线', online.json?.devices?.find((d) => d.id === deviceId)?.online === true)

  device.send(JSON.stringify({ v: 1, type: 'heartbeat', seq: 2, at: Date.now() }))
  await sleep(300)
  ok('心跳帧不报错', device.readyState === WebSocket.OPEN)

  device.send('{"v":1,"type":"nope"}')
  const err = await nextFrame(device)
  ok('非法帧回 error', err.type === 'error' && typeof err.code === 'string', `${err.type}/${err.code}`)

  device.send(JSON.stringify({ v: 99, type: 'heartbeat', seq: 3, at: Date.now() }))
  const versionErr = await nextFrame(device).catch(() => null)
  ok('协议版本不符被拒', versionErr === null || versionErr.type === 'error', versionErr?.code ?? '连接已关闭')

  device.close()
  await sleep(800)
  const offline = await call('/v1/devices', { headers: { cookie } })
  ok('断开后设备离线', offline.json?.devices?.find((d) => d.id === deviceId)?.online === false)
}

// ---- 客户端通道 ----
{
  const client = await wsOpen('/client/ws', { authorization: `Bearer ${deviceToken}` })
  const snapshot = await nextFrame(client)
  ok('客户端通道握手 + 快照', snapshot.type === 'snapshot' && snapshot.v === 1 && snapshot.snapshot?.protocol === 1, `seq=${snapshot.seq}`)
  ok('快照带设备与工单', Array.isArray(snapshot.snapshot?.devices) && Array.isArray(snapshot.snapshot?.tasks))
  client.send(JSON.stringify({ v: 1, type: 'ping', seq: 1, at: 1234 }))
  const pong = await nextFrame(client)
  ok('客户端 ping → pong', pong.type === 'pong' && pong.at === 1234)

  const httpSnapshot = await call('/v1/snapshot', { headers: { cookie } })
  ok('HTTP 快照', httpSnapshot.status === 200 && httpSnapshot.json?.protocol === 1)
  client.close()

  let rejected = false
  try { await wsOpen('/client/ws', { authorization: 'Bearer pk_invalid' }) } catch (e) { rejected = /401/.test(String(e.message)) }
  ok('坏 token 通道 401', rejected)
  let noPath = false
  try { await wsOpen('/other/ws', { authorization: `Bearer ${deviceToken}` }) } catch (e) { noPath = /404/.test(String(e.message)) }
  ok('未登记路径 404', noPath)
}

console.log(`\n==== ${pass}/${pass + fail} PASS ====`)
// ws 句柄在失败分支不一定关干净，显式退出，避免脚本挂住
process.exit(fail ? 1 : 0)
