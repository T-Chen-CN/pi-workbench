# 云端 Agent 服务器端可行性实测报告

> **面向**：决定是否开工实现云端 Agent 的人
> **什么时候读**：P0 开工前，或部署形态要调整时
> **类型**：临时分析（用户审查后可删或并入 [requirements/CLOUD_AGENT_PI.md](../requirements/CLOUD_AGENT_PI.md)）

**日期**：2026-11-19
**被测机器**：`43.160.243.96`（腾讯云 · 新加坡）· IPv6 `240d:c000:f020:1000:707a:5d2:7698:3`
**域名**：`tchen-xiaoxiao.com`（A + AAAA 都已指向该机）
**结论**：**可行**。IPv6 直连、TLS、WebSocket、SSE 流式、`AgentManager` 运行时、systemd 托管全部实测通过；唯一未验证项是"真实模型调用"（缺 API Key，见 §5.1）。

---

## 1. 为什么之前连不上（已定位，不是配置问题）

| 观察 | 数据 |
| --- | --- |
| 我的机器（中国移动出口）到 `43.160.243.96` 的 IPv4 | 22/80/443 全部超时，`tracert` 在 CMI 国际出口（`223.120.x`）后丢包 |
| check-host 六国节点（ch/de/il/jp/us×2） | 22 端口 0.15s 连通 → **服务器本身没问题** |
| 同一代理访问该机的 80 端口 | `502`（代理上游失败）；而访问香港机是 200 |
| 代理对 22 端口 | `ssh.github.com:443` 能拿到 SSH banner，`22` 一律无数据 → **代理只放 80/443** |

判定：**该 IPv4 在中国大陆方向被封**，属于云厂商海外 IP 回收后的常见情况。与安全组、sshd、密钥都无关。

**IPv6 反向验证**：同一台机器加上 IPv6 后，从本机 `ping6` 52–59 ms、0% 丢包，SSH 直接登录成功。说明封锁只针对那个 IPv4。

---

## 2. 环境基线（实测）

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 26.04 LTS · kernel `7.0.0-30-generic` · x86_64 |
| CPU | 2 vCPU（Xeon Platinum 8255C @2.5GHz） |
| 内存 | 3.7 GB（可用 3.1 GB）+ 2 GB swap（`/swap.img`） |
| 磁盘 | 59 GB，已用 6.2 GB（12%）；journal 占 24 MB |
| 时间同步 | `chrony` active（TLS / token 校验依赖它） |
| 网络 | IPv6 `/128` 静态（`eth0`），默认路由正常；IPv4 `43.160.243.96` 对国内被封 |
| 防火墙 | `ufw` inactive、`ip6tables` 全 ACCEPT → **实际边界只有云安全组** |
| 监听（初始状态） | 只有 `sshd :22`（v4+v6），干净机 |
| 已装（本次） | Node **v24.22.3**、npm 11.19.1、Caddy **v2.11.9** |
| 原有 | git 2.53、python 3.14，无 docker |
| 出网 | `registry.npmjs.org` 200 · `github.com` 200 · `api.deepseek.com` 401（可达） |
| SSH | 免密 sudo 可用；`PasswordAuthentication no`、`PermitRootLogin yes`；未装 fail2ban（用 OpenSSH 自带的 `PerSourcePenalties`） |

> 踩坑记录：OpenSSH 10.2 的 `PerSourcePenalties` 会在连续多次认证失败后临时拒绝该源，表现为 `Connection closed by ... port 22` / banner `Not allowed at this time`，约 75 秒自愈。**不要连续试错密钥**，容易被误判成网络故障。

---

## 3. 传输链路实测

服务：`/opt/cloud-test/ws-echo.mjs`（零依赖 Node 服务）→ Caddy 反代 → `tchen-xiaoxiao.com`，全部从**本机经 IPv6 直连**测试，未走代理。

| 验证项 | 结果 | 判断 |
| --- | --- | --- |
| Let's Encrypt 证书 | Caddy `tls-alpn-01` 挑战通过（验证请求来自 IPv6 地址），`certificate obtained successfully` | ✅ 续期不依赖被墙的 IPv4 |
| HTTPS（`/healthz`） | HTTP 200，冷连接 TLS 1.3 握手 271 ms，总 0.93 s；热连接 0.32 s | ✅ |
| WebSocket 升级 | `HTTP 101`，从 TCP 到升级完成 337 ms | ✅ |
| WS 回显延迟 | 200B 往返 **avg 56.4 ms · p50 55 ms · min 53 ms · max 66 ms**（50 次） | ✅ 与 ICMP 52–59 ms 一致，无额外损耗 |
| 长连接保活 | 空闲 **90 秒**后发送仍 55 ms 回显，未被 Caddy/中间设备断开 | ✅ |
| 并发连接 | 20 条 WS 全部建立 377 ms，回显 0 失败 | ✅ |
| SSE 流式（token 流地基） | 服务端每 200 ms 推一帧，公网侧到达间隔 200/201/201/188 ms | ✅ **反代不缓冲** |
| DNS | DoH 与本地解析均返回 AAAA（TTL 600），A 记录同时保留 | ✅ |

结论：**token 级流式、工单事件、审批往返所需的传输能力全部可用**，延迟 ~55 ms（国内 ↔ 新加坡）。

---

## 4. 运行时可行性（真正的核心）

把本地构建的 `pi-bridge/dist`（69 KB，24 个模块）+ SDK `@earendil-works/pi-coding-agent@1.3.0` 上传到服务器运行：

```
npm install 用时 41s，node_modules 155 MB
基线 RSS        140 MB   （node v24.22.3，2 CPU）
initialize      33 ms
createSession ×8  28 ms 合计（约 3.5 ms/个，8 个 id 互不相同）
8 个会话后 RSS   145 MB  （空会话约 0.6 MB/个）
dispose 后 RSS   145 MB
JSONL 落盘       {agentDir}/sessions/*.jsonl 正常生成
```

推断：

- **2C / 3.7 GB 足够**：按空会话 ~1 MB 估算，即使 10 个会话带历史，加上上下文缓存也远低于可用内存。
- Node 冷启动 48 ms，`initialize` 33 ms → 进程重启代价可忽略，适合 systemd 托管。
- 需要显式注意：**服务单元的 `ulimit -n` 默认是 1024**（当前 shell 值），WS 长连接 + 文件句柄叠加时要给 `LimitNOFILE=65536`。

---

## 5. 运维能力实测

| 验证项 | 结果 |
| --- | --- |
| systemd 托管 | 自写 unit + `enable --now` 正常 |
| 崩溃自动重启 | `kill -9` 主进程后 **3 秒内 `active`**，新 PID 自动接替 |
| 开机自启 | `multi-user.target.wants` 软链已建立 |
| 日志 | `journalctl -u caddy` 结构化可读；journal 总量 24 MB |
| 磁盘余量 | 50 GB 可用，按日志 + 会话记录估算可支撑很久 |
| 出网 | npm / GitHub / 模型 API 均可达（安装依赖与调用模型都不受阻） |

---

## 6. 未验证项与风险

### 6.1 未验证：真实模型调用（唯一硬缺口）

服务器上没有 API Key，桌面端 `config/api-config.json` 里的 key 是 Electron `safeStorage` 加密的（`enc:`），无法在服务器上解密。

- 已确认：`api.deepseek.com` 从服务器可达（HTTP 401 = 通，只是没带 key）。
- 需要：按需求文档的方案，由桌面端把云端模型配置推上去，或临时给一个测试 key。
- 风险等级：低（HTTP 通路已验证，本地同一条 SDK 路径在跑）。

### 6.2 IPv4 仍然被封（对产品有影响）

- 国内客户端必须**优先走 IPv6**（Node/Electron 默认 happy-eyeballs 会选 AAAA）。
- 只有 IPv4 的网络（部分企业网、部分手机流量）会连不上 → 需要在文档里写明，并考虑后续换 IP 或加中转。
- Let's Encrypt 续期已验证走 IPv6 成功，不受影响。

### 6.3 单 IPv6 地址，无冗余

`/128` 单地址，没有备用地址。若该地址被墙（概率低）或实例重建，需要改 DNS。
建议：把"IPv6 地址变更 → 更新 AAAA"写进运维清单。

### 6.4 SSH 暴露面偏松

`PermitRootLogin yes` + 密码登录已禁用 + 未装 fail2ban（靠 OpenSSH 自带惩罚机制）。
建议部署前改为 `PermitRootLogin prohibit-password`，或新建专用非 root 账号跑服务。

### 6.5 本地防火墙未启用

`ufw` inactive、`ip6tables` 全 ACCEPT，边界只有云安全组。可接受，但建议最少化端口（22 限源、仅放 80/443）。

### 6.6 并发上限未压测

只测到 8 个空会话与 20 条 WS 并发。真实负载（多会话同时流式、工具执行）未压测，需在 P0 联调阶段补一次。

---

## 7. 资源预算（按实测推算）

| 资源 | 估算 |
| --- | --- |
| 内存 | 基线 140 MB + 每空会话 ~1 MB + 上下文缓存（按模型上下文线性增长，需设上限） → 10 会话预计 < 1 GB |
| CPU | 空闲 <5%；流式与工具执行按会话数线性，2 vCPU 可支撑 8–10 并发 |
| 磁盘 | 依赖 ~155 MB + 会话 JSONL（每轮几 KB~几十 KB）→ 50 GB 可用足够 |
| 带宽 | 事件流为文本增量，单会话峰值几十 KB/s 量级；需按腾讯云按流量计费核算 |

---

## 8. 对需求文档的修订建议

1. **§8 待定项 O-04（部署形态）可以定稿**：systemd + Caddy 反代，Node 24 LTS，服务绑定 `127.0.0.1:PORT`，对外只有 Caddy 的 80/443。
2. **新增前置条件**：域名必须有 **AAAA 记录**；客户端必须支持 IPv6（happy-eyeballs）。
3. **新增运维清单**：`LimitNOFILE`、日志轮转、证书续期监控、IPv6 地址变更流程。
4. **§4.8 传输**：WS 空闲 90 秒不掉线已实测；但客户端仍需 25 s 心跳（防中间设备超时 + 快速发现半开连接）。
5. **§6 配置与凭据**：云端模型 key 的"桌面端推送"流程要在 P0 里实现——它同时是唯一未验证链路（真实模型调用）的入口。

---

## 9. 结论

| 维度 | 判定 |
| --- | --- |
| 可达性 | ✅ 已解决（IPv6 直连，52–59 ms） |
| TLS / 证书 | ✅ 自动签发与续期可用 |
| 传输（WS / SSE / 长连接 / 并发） | ✅ 全部通过，无缓冲、无异常断开 |
| 运行时（AgentManager + SDK） | ✅ 正常，启动与建会话毫秒级 |
| 资源（2C / 3.7 GB） | ✅ 够用（10 会话量级） |
| 运维（systemd / 日志 / 磁盘） | ✅ 满足 |
| 真实模型调用 | ⚠️ 未验证（缺 key，通路已通） |
| 国内 IPv4 可达 | ❌ 被封（依赖 IPv6） |

**结论：服务器端可行性成立，可以进入 P0。** 唯一待补的是"配置下发 + 一次真实模型调用"，它本来就在 P0 范围内。

---

## 附：本次在服务器上留下的东西

| 路径 | 说明 |
| --- | --- |
| `/usr/local/bin/node`、`/usr/local/lib/nodejs` | Node 24.22.3 |
| `/usr/local/bin/caddy`、`/etc/caddy/Caddyfile`、`caddy.service` | Caddy 2.11.9，反代 `tchen-xiaoxiao.com` → `127.0.0.1:8080` |
| `/opt/cloud-test/ws-echo.mjs`、`ws-echo.service` | 验证用零依赖服务（`/healthz`、`/stream`、`/ws`） |
| `/opt/cloud-test/poc/` | SDK + `pi-bridge/dist` 的运行时 PoC |

清理方式（正式部署前执行即可）：

```bash
sudo systemctl disable --now ws-echo caddy
sudo rm -rf /opt/cloud-test
sudo rm -f /etc/systemd/system/ws-echo.service
```
