# hermes-plugin/pi-workbench

本地 Pi Workbench ↔ 云端 Hermes 的**唯一入口**。它是 Hermes 的 `kind: platform`
插件，跑在 VPS 的 gateway 进程里，负责：

| 能力 | 说明 |
| --- | --- |
| 设备身份 | 每台机器一把 `pi_…` token，服务端只存 sha256；token → `deviceId` 是唯一权威 |
| 权限 | scope：`chat`（对话）/ `dispatch`（派活）/ `admin`（改配置） |
| 反向代理 | 除 dashboard 外所有接口透明转发到 `127.0.0.1:8642`，重写鉴权、注入 `X-Pi-Device`、SSE 不缓冲 |
| 审计 | SQLite + `audit-*.jsonl` 双写（token 与 prompt 永不上日志） |
| 派活（H3） | 工作区级任务邮箱 + `local_workspaces` / `local_devices` / `local_dispatch` / `local_task` |

## 三层结构（改动前先读）

```
plugin.yaml  清单（不要写 capabilities：只接受 Hermes 注册表里的 id）
__init__.py  register(ctx) → 只调 shim
shim.py      唯一碰 Hermes 插件 API 的文件（register_platform + plugin_data_dir）
adapter.py   BasePlatformAdapter 子类：connect() 起服务线程，disconnect() 收
core/        纯 stdlib，不知道 Hermes 存在 → 能 5 分钟外提成独立服务
```

**硬约束**

- `core/` 不许 `import gateway` / `plugins`；需要的数据（数据目录、上游地址、密钥）由 `shim`/`adapter` 传进来。
- 传输用 stdlib（`ThreadingHTTPServer` + `http.client`），**不要换成 aiohttp**：
  服务跑在独立线程里，插件崩了打不死 gateway 的事件循环。
- 上游签名变更只允许改 `shim.py` / `adapter.py`。

## 本地开发

```bash
cd hermes-plugin/pi-workbench
python -m unittest discover -s tests -t . -v     # 50 个用例，约 10 秒，零依赖
```

## 部署到 VPS

```bash
# 1) 放插件（profile 级）
rsync -a --delete hermes-plugin/pi-workbench/ \
  ubuntu@43.160.243.96:/home/ubuntu/.hermes/profiles/pi-cloud/plugins/pi-workbench/

# 2) 启用（HERMES_HOME 必须指 profile，不是 ~/.hermes）
export HERMES_HOME=/home/ubuntu/.hermes/profiles/pi-cloud
hermes plugins list | grep pi-workbench
hermes plugins enable pi-workbench

# 3) 环境变量进 systemd drop-in（不要写 .env：agent 读得到）
#    PI_HUB_ADMIN_KEY / HERMES_API_BASE=http://127.0.0.1:8642 / PI_HUB_PORT=8484

# 4) 工具白名单（H3 起需要；provides_tools 不能绕过它）
#    config.yaml → platform_toolsets.api_server 追加 pi_workbench

# 5) Caddy（SSE 必须不缓冲）
#    hub.tchen-xiaoxiao.com { reverse_proxy 127.0.0.1:8484 { flush_interval -1 } }
sudo systemctl reload caddy
sudo systemctl restart hermes-gateway-pi-cloud.service
```

## 验收（G0）

```bash
curl -s https://hub.tchen-xiaoxiao.com/v1/hub/health                      # 200 + upstreamOk
curl -s -o /dev/null -w '%{http_code}\n' https://hub.tchen-xiaoxiao.com/v1/capabilities   # 401
curl -s -H "Authorization: Bearer pi_…" https://hub.tchen-xiaoxiao.com/v1/capabilities    # 200
curl -X POST -H "X-Pi-Admin-Key: …" https://hub.tchen-xiaoxiao.com/v1/devices/<id>/revoke
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer pi_…" .../v1/capabilities  # 401 device_revoked
```

设备登记（一次）：

```bash
curl -s -X POST https://hub.tchen-xiaoxiao.com/v1/devices/register \
  -H "X-Pi-Admin-Key: $PI_HUB_ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"TChen-Legion","scopes":["chat","dispatch"]}'
```

## 故障三分

| 现象 | 判断 |
| --- | --- |
| `/v1/hub/health` 连不上 | 插件没起（`journalctl -u hermes-gateway-pi-cloud`）/ Caddy vhost 错 |
| health 200 但 `upstreamOk:false` | Hermes api_server 挂了（看 `upstreamError`） |
| 401 `unauthorized` | 设备 token 错或未登记 |
| 401 `device_revoked` | 这台设备已被注销，需重新登记 |
| 403 `scope_required` | token 缺 scope |
