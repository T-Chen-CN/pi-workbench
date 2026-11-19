# Pi Cloud 部署件

| 文件 | 用途 |
| --- | --- |
| `pi-cloud.service` | systemd 单元（只监听 127.0.0.1，权限收紧，`Restart=always`） |
| `Caddyfile.snippet` | 站点块：`/client/ws`、`/device/ws` 与其余 API 都反代到 `127.0.0.1:8787` |
| `backup.sh` + `.service` + `.timer` | 每日 03:20 UTC 备份到 `/var/backups/pi-cloud`，留 7 天 |
| `env.example` | `/etc/pi-cloud/env` 模板（`PI_CLOUD_ENC_KEY` 丢了就解不开云端模型 Key） |

目录约定：`/opt/pi-cloud/releases/<时间戳>` + `current` 软链；健康检查失败回滚上一条软链。

完整部署与回滚步骤见 `docs/agent/cloud-agent.md`。
