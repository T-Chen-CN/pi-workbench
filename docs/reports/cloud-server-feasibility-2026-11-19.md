# 云端 Agent 服务器端可行性实测报告

> **面向**：决定是否开工实现云端 Agent 的人
> **什么时候读**：P0 开工前，或部署形态要调整时
> **类型**：临时分析（用户审查后可删或并入 [requirements/CLOUD_AGENT_PI.md](../requirements/CLOUD_AGENT_PI.md)）

**日期**：2026-11-19（同日更新：公网 IPv4 已更换；2026-11-26 已脱敏移除具体公网 IP / 域名与主机配置细节）
**被测机器**：新加坡区域双栈云主机（IPv4/IPv6 地址已脱敏）
**域名**：`<cloud-host>`（A + AAAA 双栈解析）
**结论**：**可行**。双栈（v4/v6）直连、TLS、WebSocket、SSE 流式、`AgentManager` 运行时、systemd 托管全部实测通过；唯一未验证项是"真实模型调用"（缺 API Key，见 §6.1）。

---

## 1. 曾经的封锁问题（已通过更换公网 IPv4 解决）

> **当前状态：已解决。** 原公网 IPv4 在国内方向被封，更换为新弹性公网 IP 后 22/80/443 全部直连可用（实测数据见 §3.1）。以下保留原始排查记录，作为"如何区分被墙与配置错误"的判据。

| 观察 | 数据 |
| --- | --- |
| 本机直连原公网 IPv4 | 22/80/443 全部超时，`tracert` 在国际出口后丢包 |
| check-host 六国节点（ch/de/il/jp/us×2） | 22 端口 0.15s 连通 → **服务器本身没问题** |
| 同一代理访问该机的 80 端口 | `502`（代理上游失败）；而访问香港机是 200 |
| 代理对 22 端口 | `ssh.github.com:443` 能拿到 SSH banner，`22` 一律无数据 → **代理只放 80/443** |

判定：**该 IPv4 在中国大陆方向被封**，属于云厂商海外 IP 回收后的常见情况。与安全组、sshd、密钥都无关。

**IPv6 反向验证**：同一台机器加上 IPv6 后，从本机 `ping6` 52–59 ms、0% 丢包，SSH 直接登录成功。说明封锁只针对那个 IPv4，机器与服务本身无问题。

**最终处理**：更换弹性公网 IP，DNS A 记录同步更新，IPv4 立即恢复（见 §3.1）。

---

## 2. 环境基线（实测）

| 项 | 值 |
| --- | --- |
| 系统 | Ubuntu 26.04 LTS · x86_64 |
| CPU | 2 vCPU |
| 内存 | 3.7 GB（可用 3.1 GB）+ 2 GB swap（`/swap.img`） |
| 磁盘 | 59 GB，已用 6.2 GB（12%）；journal 占 24 MB |
| 时间同步 | `chrony` active（TLS / token 校验依赖它） |
| 网络 | IPv4 + IPv6 双栈（具体地址已脱敏） |
| 防火墙 | 仅放通必要端口（上线前需启用本机防火墙与云安全组最小化策略） |
| 监听（初始状态） | 只有 `sshd :22`（v4+v6），干净机 |
| 已装（本次） | Node **v24.22.3**、npm 11.19.1、Caddy **v2.11.9** |
| 原有 | git 2.53、python 3.14，无 docker |
| 出网 | `registry.npmjs.org` 200 · `github.com` 200 · `api.deepseek.com` 401（可达） |
| SSH | 仅公钥登录（`PasswordAuthentication no`），具体策略在服务器侧最小化加固 |

> 踩坑记录：OpenSSH 10.2 的 `PerSourcePenalties` 会在连续多次认证失败后临时拒绝该源，表现为 `Connection closed by ... port 22` / banner `Not allowed at this time`，约 75 秒自愈。**不要连续试错密钥**，容易被误判成网络故障。

---

## 3. 传输链路实测

服务：`/opt/cloud-test/ws-echo.mjs`（零依赖 Node 服务）→ Caddy 反代 → `<cloud-host>`，全部从**本机直连**测试（未走代理）。

以下表格是 IPv6 通道的实测数据；IPv4 更换公网 IP 后的对照数据见 §3.1。

| 验证项 | 结果 | 判断 |
| --- | --- | --- |
| Let's Encrypt 证书 | Caddy `tls-alpn-01` 挑战通过（验证请求来自 IPv6 地址），`certificate obtained successfully` | ✅ 自动签发与续期可用 |
| HTTPS（`/healthz`） | HTTP 200，冷连接 TLS 1.3 握手 271 ms，总 0.93 s；热连接 0.32 s | ✅ |
| WebSocket 升级 | `HTTP 101`，从 TCP 到升级完成 337 ms | ✅ |
| WS 回显延迟 | 200B 往返 **avg 56.4 ms · p50 55 ms · min 53 ms · max 66 ms**（50 次） | ✅ 与 ICMP 52–59 ms 一致，无额外损耗 |
| 长连接保活 | 空闲 **90 秒**后发送仍 55 ms 回显，未被 Caddy/中间设备断开 | ✅ |
| 并发连接 | 20 条 WS 全部建立 377 ms，回显 0 失败 | ✅ |
| SSE 流式（token 流地基） | 服务端每 200 ms 推一帧，公网侧到达间隔 200/201/201/188 ms | ✅ **反代不缓冲** |
| DNS | A + AAAA 均正常解析（TTL 600） | ✅ |

结论：**token 级流式、工单事件、审批往返所需的传输能力全部可用**，延迟 ~55 ms（国内 ↔ 新加坡）。

### 3.1 更换公网 IPv4 后的双栈对照

更换弹性公网 IPv4 并同步 DNS A 记录后复测（同一台机器、同一份 Caddy 配置）：

| 验证项 | IPv4 | IPv6 |
| --- | --- | --- |
| TCP 22 / 80 / 443 | **CONNECTED 56–61 ms**（全部三个端口） | 可连 |
| HTTPS 200 | ✅ TLS 335 ms | ✅ TLS 271–315 ms |
| WS 升级 | ✅ `HTTP 101` | ✅ `HTTP 101` |
| WS 回显 p50（50 次） | **54 / 58 / 54 ms**（三次连测） | **56 / 53 ms**（两次连测） |
| WS 回显 min–max | 53–66 ms | 53–61 ms |
| 证书 | 同一张 LE 证书，双栈共用 | 同左 |

首次 v4 连接出现过一次劣化（TLS 1.31 s、50 次回显里一次 566 ms 抖动，avg 102 ms），随后三次复测全部恢复到 54 ms 量级 —— 判定为首包路由预热，不是链路问题。

**结论：两条通道质量相当（p50 均 ~54 ms），IPv4 封锁问题已彻底消除，IPv6 由“唯一通路”降为“可选项”。**

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

### 6.2 公网 IP 曾被墙（已通过换 IP 解决，但需保留运维预案）

- 现状态：新弹性公网 IP 双栈均可用，IPv6 为可选而非必需。
- 残留风险：海外 IPv4 随时可能再次被列入封禁名单（无预告、无可申诉渠道），届时只能再换 IP 或前置一层 CDN。
- 预案：客户端原生支持双栈即可（已实测：不指定 family 时 Node 自动选路 300 ms 内成功），不需要写任何 IPv6 专有代码；连接超时（建议 8 s）要能把“静默不通”变成可读错误。
- 注意：只有 v4 且被墙时表现为**静默超时**（12 s 无任何回应），不是快速失败，因此必须有客户端超时与错误分级。

### 6.3 公网 IP 无冗余

单 IPv4（EIP）+ 单 IPv6（`/128`），无备用地址。若两者同时不可用或实例重建，需要改 DNS。
建议：把“公网 IP 变更 → 更新 A / AAAA 记录”写进运维清单。

### 6.4 SSH 安全加固建议

生产部署前需在服务器侧落实最小化 SSH 策略（仅公钥登录、禁用 root 密码/交互登录、按需配合 fail2ban 与专用非 root 账号跑服务）。

### 6.5 本地防火墙加固建议

除云安全组最小化端口（22 限源、仅放 80/443）外，建议同步启用本机防火墙（`ufw` / `nftables`，同时覆盖 IPv4 与 IPv6）。

### 6.6 并发上限未压测

只测到 8 个空会话与 20 条 WS 并发。真实负载（多会话同时流式、工具执行）未压测，需在 P0 联调阶段补一次。

---

## 7. 资源预算（按实测推算）

| 资源 | 估算 |
| --- | --- |
| 内存 | 基线 140 MB + 每空会话 ~1 MB + 上下文缓存（按模型上下文线性增长，需设上限） → 10 会话预计 < 1 GB |
| CPU | 空闲 <5%；流式与工具执行按会话数线性，2 vCPU 可支撑 8–10 并发 |
| 磁盘 | 依赖 ~155 MB + 会话 JSONL（每轮几 KB~几十 KB）→ 50 GB 可用足够 |
| 带宽 | 事件流为文本增量，单会话峰值几十 KB/s 量级；需按云厂商按流量计费核算 |

---

## 8. 对需求文档的修订建议

1. **§8 待定项 O-04（部署形态）可以定稿**：systemd + Caddy 反代，Node 24 LTS，服务绑定 `127.0.0.1:PORT`，对外只有 Caddy 的 80/443。
2. **新增前置条件**：域名同时配 A 与 AAAA；客户端保持默认双栈选路（不写死 IP、不强制 `family`），并设 8 s 连接超时把“静默不通”转成可读错误。
3. **新增运维清单**：`LimitNOFILE`、日志轮转、证书续期监控、**公网 IP 变更→同步 A/AAAA**。
4. **§4.8 传输**：WS 空闲 90 秒不掉线已实测；但客户端仍需 25 s 心跳（防中间设备超时 + 快速发现半开连接）。
5. **§6 配置与凭据**：云端模型 key 的"桌面端推送"流程要在 P0 里实现——它同时是唯一未验证链路（真实模型调用）的入口。

---

## 9. 结论

| 维度 | 判定 |
| --- | --- |
| 可达性 | ✅ 已解决（双栈直连，v4/v6 均 ~54 ms） |
| TLS / 证书 | ✅ 自动签发与续期可用 |
| 传输（WS / SSE / 长连接 / 并发） | ✅ 全部通过，无缓冲、无异常断开 |
| 运行时（AgentManager + SDK） | ✅ 正常，启动与建会话毫秒级 |
| 资源（2C / 3.7 GB） | ✅ 够用（10 会话量级） |
| 运维（systemd / 日志 / 磁盘） | ✅ 满足 |
| 真实模型调用 | ⚠️ 未验证（缺 key，通路已通） |
| 国内 IPv4 可达 | ✅ 已恢复（更换 EIP 后直连 56–61 ms） |

**结论：服务器端可行性成立，可以进入 P0。** 唯一待补的是"配置下发 + 一次真实模型调用"，它本来就在 P0 范围内。

---

## 附：本次在服务器上留下的东西

| 路径 | 说明 |
| --- | --- |
| `/usr/local/bin/node`、`/usr/local/lib/nodejs` | Node 24.22.3 |
| `/usr/local/bin/caddy`、`/etc/caddy/Caddyfile`、`caddy.service` | Caddy 2.11.9，反代 `<cloud-host>` → `127.0.0.1:8080` |
| `/opt/cloud-test/ws-echo.mjs`、`ws-echo.service` | 验证用零依赖服务（`/healthz`、`/stream`、`/ws`） |
| `/opt/cloud-test/poc/` | SDK + `pi-bridge/dist` 的运行时 PoC |

清理方式（正式部署前执行即可）：

```bash
sudo systemctl disable --now ws-echo caddy
sudo rm -rf /opt/cloud-test
sudo rm -f /etc/systemd/system/ws-echo.service
```
