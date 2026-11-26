/**
 * 运行时配置。
 *
 * 只从环境变量取（systemd 的 EnvironmentFile），不读仓库内文件：
 * 服务器上不做代码检出，配置与密钥都随部署写入 /etc/pi-cloud/env。
 */

import * as path from 'path'

export interface CloudConfig {
  /** 对外域名，仅用于日志与 Web 客户端提示 */
  domain: string
  /** 只监听回环地址（Caddy 反代） */
  host: string
  port: number
  /** /var/lib/pi-cloud：账号、设备、会话、工单、outbox */
  dataDir: string
  /** 云端 Agent 的 workspaceDir / agentDir（SDK 要求存在） */
  workspaceDir: string
  agentDir: string
  /** AES-256-GCM 主密钥（base64，32 字节）；用于加密云端模型配置 */
  encryptionKey: Buffer
  /** cookie 签名密钥 */
  cookieSecret: string
  /** 生产模式下 cookie 带 Secure（本机 http 调试时不带） */
  secureCookies: boolean
  /** 服务版本，进 /v1/health 与协议握手 */
  version: string
  /** Web 客户端静态目录；空表示用包内默认（apps/cloud/web-dist 或部署包内 web） */
  webDir: string
}

function required(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`Missing required env ${name}`)
  return value.trim()
}

function decodeKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('PI_CLOUD_ENC_KEY must be 32 bytes, base64 encoded')
  }
  return key
}

export function loadConfig(overrides: Partial<CloudConfig> = {}): CloudConfig {
  const dataDir = overrides.dataDir || process.env.PI_CLOUD_DATA_DIR || '/var/lib/pi-cloud'
  const config: CloudConfig = {
    domain: process.env.PI_CLOUD_DOMAIN || 'tchen-xiaoxiao.com',
    host: process.env.PI_CLOUD_HOST || '127.0.0.1',
    port: Number(process.env.PI_CLOUD_PORT || 8787),
    dataDir,
    workspaceDir: process.env.PI_CLOUD_WORKSPACE_DIR || path.join(dataDir, 'workspace'),
    agentDir: process.env.PI_CLOUD_AGENT_DIR || path.join(dataDir, 'agent'),
    // 测试/嵌入调用方可以直接给 key 与 secret，不必先造环境变量
    encryptionKey: overrides.encryptionKey ?? decodeKey(required('PI_CLOUD_ENC_KEY')),
    cookieSecret: overrides.cookieSecret ?? required('PI_CLOUD_COOKIE_SECRET'),
    secureCookies: process.env.NODE_ENV === 'production',
    version: process.env.PI_CLOUD_VERSION || '0.1.0',
    webDir: process.env.PI_CLOUD_WEB_DIR || '',
    ...overrides,
  }
  if (!Number.isFinite(config.port) || config.port < 0) {
    throw new Error(`Invalid PI_CLOUD_PORT: ${process.env.PI_CLOUD_PORT}`)
  }
  return config
}
