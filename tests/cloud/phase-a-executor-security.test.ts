/**
 * Phase A · Track 3 安全加固回归测试：
 * - D4 桌面端云执行器：读工具工作树边界、非递归越界 rm 拦截、pre-push hook fail-closed、
 *   里程碑/总结密钥脱敏、流式 git diff 防 8MB maxBuffer 静默丢命中、link-store 禁远程明文 HTTP 与 IMDS；
 * - D14 云端运维与供应链：裁剪 lockfile 确定性完整性校验、deploy 脚本与工作流加固断言。
 */

// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { CloudTaskMilestone, CloudTaskResult, CloudTaskSpec } from 'pi-bridge'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}))

const { createTaskGuardExtension } = await import('../../electron/cloud/task-guard')
const {
  classifyAttentionPath,
  collectTaskDiff,
  redactSecrets,
  redactTextSecrets,
  sanitizeDiffExcerpt,
  scanWorktreeSecrets,
} = await import('../../electron/cloud/task-report')
const { CloudTaskRunner } = await import('../../electron/cloud/task-runner')
const { normalizeBaseUrl } = await import('../../electron/cloud/link-store')
const bundleModuleUrl = '../../scripts/build-cloud-bundle.mjs'
const { buildPrunedLockfile, CLOUD_RUNTIME_DEPS } = (await import(bundleModuleUrl)) as {
  buildPrunedLockfile: (
    rootLock: Record<string, unknown>,
    names: readonly string[]
  ) => {
    pinnedDependencies: Record<string, string>
    packageLock: { lockfileVersion: number; packages: Record<string, Record<string, unknown>> }
    packageCount: number
  }
  CLOUD_RUNTIME_DEPS: readonly string[]
}

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function invokeGuard(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string
): Promise<{ block?: boolean; reason?: string } | undefined> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | null = null
  const factory = createTaskGuardExtension({
    logger: { info: vi.fn(), warn: vi.fn() },
  })
  factory({
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === 'tool_call') handler = fn
    },
  } as never)
  expect(handler).not.toBeNull()
  return (await handler!(
    { toolName, input, toolCallId: 'tc-1' },
    cwd === undefined ? {} : { cwd }
  )) as { block?: boolean; reason?: string } | undefined
}

describe('D4：工单守卫读工具工作树边界与非递归越界 rm 拦截', () => {
  it('拦截 read / ls / grep / find 越出工作树（含家目录密钥、邻近仓库与缺失 cwd）', async () => {
    const wt = await makeTempDir('pi-guard-read-wt-')
    const sibling = await makeTempDir('pi-guard-sibling-')
    const siblingEnv = path.join(sibling, '.env')
    await fs.writeFile(siblingEnv, 'SECRET=1\n')

    // 工作树外读取一律拒绝
    expect((await invokeGuard('read', { path: '~/.ssh/id_rsa' }, wt))?.block).toBe(true)
    expect((await invokeGuard('read', { file_path: '~/.aws/credentials' }, wt))?.block).toBe(true)
    expect((await invokeGuard('read', { path: siblingEnv }, wt))?.block).toBe(true)
    expect((await invokeGuard('read', { path: '../cloud-link.json' }, wt))?.block).toBe(true)
    expect((await invokeGuard('ls', { path: sibling }, wt))?.block).toBe(true)
    expect((await invokeGuard('grep', { pattern: 'token', path: sibling }, wt))?.block).toBe(true)
    expect((await invokeGuard('grep', { pattern: 'token', paths: ['src', sibling] }, wt))?.block).toBe(true)
    expect((await invokeGuard('find', { dir: sibling }, wt))?.block).toBe(true)

    // 读工具缺失 cwd 时 fail-closed
    expect((await invokeGuard('read', { path: 'src/a.ts' }, undefined))?.block).toBe(true)
    expect((await invokeGuard('grep', { pattern: 'foo' }, undefined))?.block).toBe(true)

    // 省略路径参数或工作树内路径放行
    expect(await invokeGuard('ls', {}, wt)).toBeUndefined()
    expect(await invokeGuard('grep', { pattern: 'foo' }, wt)).toBeUndefined()
    expect(await invokeGuard('find', { pattern: '*.ts' }, wt)).toBeUndefined()
    expect(await invokeGuard('read', { path: 'src/index.ts' }, wt)).toBeUndefined()
    expect(await invokeGuard('read', { path: path.join(wt, 'README.md') }, wt)).toBeUndefined()
  })

  it('拦截非递归越界 rm / del / rmdir / Remove-Item，同时放行工作树内删除', async () => {
    const wt = await makeTempDir('pi-guard-rm-wt-')
    const outside = await makeTempDir('pi-guard-rm-out-')
    const outsideFile = path.join(outside, 'target.txt')

    expect((await invokeGuard('bash', { command: 'rm ../outside.txt' }, wt))?.block).toBe(true)
    expect((await invokeGuard('bash', { command: `rm ${outsideFile}` }, wt))?.block).toBe(true)
    expect((await invokeGuard('bash', { command: 'rm -- ../outside.txt' }, wt))?.block).toBe(true)
    expect((await invokeGuard('bash', { command: 'rm ~/.bashrc' }, wt))?.block).toBe(true)
    expect((await invokeGuard('bash', { command: 'rmdir ../sibling' }, wt))?.block).toBe(true)
    expect((await invokeGuard('bash', { command: 'cd .. && rm secret.txt' }, wt))?.block).toBe(true)
    expect((await invokeGuard('powershell', { command: 'Remove-Item ../secret.txt' }, wt))?.block).toBe(true)
    expect((await invokeGuard('powershell', { command: `del ${outsideFile}` }, wt))?.block).toBe(true)

    // 工作树内非递归/递归删除照常放行
    expect(await invokeGuard('bash', { command: 'rm temp.log' }, wt)).toBeUndefined()
    expect(await invokeGuard('bash', { command: 'rm src/../dist/a.js' }, wt)).toBeUndefined()
    expect(await invokeGuard('powershell', { command: 'Remove-Item dist/bundle.js' }, wt)).toBeUndefined()
  })
})

describe('D4：pre-push hook fail-closed 与里程碑/总结密钥脱敏', () => {
  function makeSpec(repoPath: string, workUnitId: string): CloudTaskSpec {
    return {
      workUnitId,
      deviceId: 'dev-1',
      repo: { workspacePath: repoPath, baseBranch: 'main' },
      title: 'security check',
      background: 'bg',
      goal: 'goal',
      acceptance: 'acc',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    }
  }

  it('新建工作树安装 pre-push hook 失败时 fail-closed 失败并立即回收未受保护工作树', async () => {
    const dir = await makeTempDir('pi-hook-failclosed-')
    const repo = path.join(dir, 'repo')
    const wt = path.join(dir, 'wt')
    const dataDir = path.join(dir, 'data')
    await fs.mkdir(repo, { recursive: true })
    await fs.mkdir(wt, { recursive: true })

    const failedCalls: Array<{ taskId: string; error: string; clean?: boolean }> = []
    const released: string[] = []
    let ensureManagerCalled = false

    const runner = new CloudTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      dataDir,
      getApiConfig: async () => null,
      installPrePushHook: async () => ({ ok: false, error: 'git config --worktree failed' }),
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: wt, branch: 'pi/wt-sec' } }),
        getSessionBinding: () => ({ key: '', path: wt, branch: 'pi/wt-sec' }),
        hasBinding: () => true,
        release: async (sessionId: string) => {
          released.push(sessionId)
          return { success: true, removed: true, dirty: false, worktreePath: wt }
        },
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      onFailed: (taskId, error, _changed, clean) => failedCalls.push({ taskId, error, clean }),
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })
    ;(runner as any).ensureManager = async () => {
      ensureManagerCalled = true
      throw new Error('should never reach ensureManager')
    }
    await runner.load()

    await runner.start('T-hook-fail', makeSpec(repo, 'u-hook-fail'))

    expect(ensureManagerCalled).toBe(false)
    expect(released).toEqual(['cloud:u-hook-fail'])
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0].taskId).toBe('T-hook-fail')
    expect(failedCalls[0].error).toMatch(/pre-push guard/i)
    expect(failedCalls[0].clean).toBe(true)
    await runner.dispose()
  })

  it('复用已有工作树且 pre-push hook 安装失败时 fail-closed，且保留原脏树不误删', async () => {
    const dir = await makeTempDir('pi-hook-reuse-fail-')
    const repo = path.join(dir, 'repo')
    const dataDir = path.join(dir, 'data')
    await fs.mkdir(repo, { recursive: true })
    await fs.mkdir(dataDir, { recursive: true })

    // 预置一个带未提交改动的真实 git 目录作为缓存工作树
    const git = (args: string[]) => execFileAsync('git', ['-C', repo, ...args])
    await git(['init', '-b', 'main'])
    await git(['config', 'user.email', 'test@example.com'])
    await git(['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(repo, 'a.txt'), 'init\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'init'])
    await fs.writeFile(path.join(repo, 'dirty.txt'), 'wip\n')

    await fs.writeFile(
      path.join(dataDir, 'units.json'),
      JSON.stringify({
        'u-existing': {
          repoPath: repo,
          worktreePath: repo,
          branch: 'pi/existing',
          createdAt: Date.now(),
        },
      })
    )

    const failedCalls: Array<{ taskId: string; error: string; clean?: boolean }> = []
    const released: string[] = []
    const runner = new CloudTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      dataDir,
      getApiConfig: async () => null,
      // 走默认真实 installWorktreePrePushHook：repo === worktreePath 会拒绝给主工作树装钩子
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: repo, branch: 'pi/existing' } }),
        getSessionBinding: () => ({ key: '', path: repo, branch: 'pi/existing' }),
        hasBinding: () => true,
        release: async (sessionId: string) => {
          released.push(sessionId)
          return { success: true, removed: false, dirty: true, worktreePath: repo }
        },
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      onFailed: (taskId, error, _changed, clean) => failedCalls.push({ taskId, error, clean }),
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })
    await runner.load()

    await runner.start('T-reuse-fail', makeSpec(repo, 'u-existing'))

    expect(released).toEqual([])
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0].error).toMatch(/pre-push guard/i)
    expect(failedCalls[0].clean).toBe(false)
    await runner.dispose()
  })

  it('redactTextSecrets 脱敏单行密钥、多行及单行折叠 PEM 私钥并保留普通文本', () => {
    const fakeAws = ['AKIA', '9876543210ABCDEF'].join('')
    const fakeGh = ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')
    const fakeKey = ['sk-proj-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('')
    const begin = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')
    const end = ['-----END ', 'RSA PRIVATE KEY-----'].join('')

    const raw = [
      `Checked env: aws=${fakeAws} and gh=${fakeGh}`,
      `API token ${fakeKey} leaked`,
      `${begin}`,
      'MIIEpAIBAAKCAQEAsecretBodyOne1234567890',
      `${end}`,
      `Collapsed: ${begin} MIIEpAIBAAKCAQEAflatSecretBody ${end} done`,
      'Placeholder password=your_example_placeholder_1234 stays intact',
    ].join('\n')

    const { text, hits } = redactTextSecrets(raw, '<summary>')
    expect(text).not.toContain(fakeAws)
    expect(text).not.toContain(fakeGh)
    expect(text).not.toContain(fakeKey)
    expect(text).not.toContain('secretBodyOne')
    expect(text).not.toContain('flatSecretBody')
    expect(text).toContain('[REDACTED: aws-access-key]')
    expect(text).toContain('[REDACTED: github-token]')
    expect(text).toContain('[REDACTED: api-key]')
    expect(text).toContain('[REDACTED: private-key]')
    expect(text).toContain('your_example_placeholder_1234')
    expect(hits.map((h) => h.kind)).toEqual(
      expect.arrayContaining(['aws-access-key', 'github-token', 'api-key', 'private-key'])
    )
    expect(redactSecrets(`Bearer ${'A'.repeat(28)}`)).toContain('AAAA') // 重复占位符豁免
  })

  it('CloudTaskRunner 在发送 task_milestone（含跨 80 字符截断边界）与 task_result.summary 前强制脱敏密钥', async () => {
    const dir = await makeTempDir('pi-redact-runner-')
    const wt = path.join(dir, 'wt')
    const dataDir = path.join(dir, 'data')
    await fs.mkdir(wt, { recursive: true })
    await fs.mkdir(dataDir, { recursive: true })

    const fakeGh = ['ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'].join('')
    const fakeSk = ['sk-proj-', 'ZZZZZZZZZZZZZZZZZZZZZZZZ12345678'].join('')
    const fakeDb = 'postgres://admin:RealSuperPass9988@db.internal:5432/prod'

    const milestones: CloudTaskMilestone[] = []
    const results: CloudTaskResult[] = []
    let traceListener: ((event: any) => void) | null = null

    const runner = new CloudTaskRunner({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      dataDir,
      getApiConfig: async () => null,
      installPrePushHook: async () => ({ ok: true, hookPath: path.join(wt, 'pre-push') }),
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: wt, branch: 'pi/redact' } }),
        getSessionBinding: () => ({ key: '', path: wt, branch: 'pi/redact' }),
        hasBinding: () => true,
        release: async () => ({ success: true, removed: true, dirty: false, worktreePath: wt }),
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: (_taskId, milestone) => milestones.push(milestone),
      onQuestion: () => undefined,
      onResult: (_taskId, result) => results.push(result),
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })

    const fakeManager = {
      createSession: async () => ({ success: true, session: { id: 'sess-redact' } }),
      subscribeTrace: (_sid: string, listener: (event: any) => void) => {
        traceListener = listener
        return () => undefined
      },
      chat: async () => {
        // 故意把 token 放在第 65..105 字符处跨越 80 字符截断边界，验证必须先脱敏再截断
        const padding = `${'x'.repeat(64)} `
        traceListener?.({
          type: 'tool_end',
          toolCallId: 'c1',
          toolName: 'bash',
          status: 'success',
          resultPreview: `${padding}${fakeGh} trailing`,
        })
        return {
          success: true,
          response: `完成修改；命令输出包含 ${fakeSk} 与连接串 ${fakeDb}，测试全部通过。`,
        }
      },
      abort: async () => undefined,
      closeSession: async () => undefined,
      dispose: async () => undefined,
    }
    ;(runner as any).manager = fakeManager
    ;(runner as any).ensureManager = async () => fakeManager
    await runner.load()

    await runner.start('T-redact', makeSpec(wt, 'u-redact'))

    const bashMilestone = milestones.find((m) => m.text.startsWith('执行命令：'))
    expect(bashMilestone).toBeDefined()
    expect(bashMilestone!.text).not.toContain('ghp_')
    expect(bashMilestone!.text).not.toContain(fakeGh.slice(0, 16))
    expect(bashMilestone!.text).toContain('[REDACTED: gith')

    expect(results).toHaveLength(1)
    expect(results[0].summary).not.toContain(fakeSk)
    expect(results[0].summary).not.toContain('RealSuperPass9988')
    expect(results[0].summary).toContain('[REDACTED: api-key]')
    expect(results[0].summary).toContain('[REDACTED: database-url]')
    expect(results[0].summary).toContain('测试全部通过')
    await runner.dispose()
  })
})

describe('D4：流式 git diff（超 8MB 不崩溃）与敏感路径规则微调', () => {
  it('超过 8MB 的大 diff 下 scanWorktreeSecrets 仍能检出密钥，collectTaskDiff 正常返回脱敏截断摘要', async () => {
    const repo = await makeTempDir('pi-big-diff-')
    const git = (args: string[]) => execFileAsync('git', ['-C', repo, ...args])
    const fakeGh = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('')

    await git(['init', '-b', 'main'])
    await git(['config', 'user.email', 'test@example.com'])
    await git(['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(repo, 'README.md'), 'init\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'init'])

    await git(['checkout', '-b', 'pi/big-diff'])
    // 构造约 9MB 的新增文件 diff（超出原 execFile 8MB maxBuffer），首行埋入疑似密钥
    const fillerLine = `${'a'.repeat(1023)}\n`
    const hugeBody = `const leaked = "${fakeGh}"\n${fillerLine.repeat(9 * 1024)}`
    await fs.writeFile(path.join(repo, 'huge.txt'), hugeBody)
    await git(['add', 'huge.txt'])
    await git(['commit', '-m', 'add huge file'])

    const hits = await scanWorktreeSecrets('main', repo)
    expect(hits).toContainEqual({ path: 'huge.txt', line: 1, kind: 'github-token' })

    const diff = await collectTaskDiff('main', repo, 4096)
    expect(diff).toBeDefined()
    expect(diff!.truncated).toBe(true)
    expect(diff!.excerpt).toContain('+[REDACTED: github-token]')
    expect(diff!.excerpt).not.toContain(fakeGh)
    expect(Buffer.byteLength(diff!.excerpt, 'utf8')).toBeLessThanOrEqual(4096)

    // 显式小 raw 上限验证流式提前杀子进程后仍不丢失已有命中与截断摘要
    const cappedHits = await scanWorktreeSecrets('main', repo, { maxDiffBytes: 32 * 1024 })
    expect(cappedHits).toContainEqual({ path: 'huge.txt', line: 1, kind: 'github-token' })
    const cappedDiff = await collectTaskDiff('main', repo, 2048, { maxRawBytes: 32 * 1024 })
    expect(cappedDiff).toBeDefined()
    expect(cappedDiff!.truncated).toBe(true)
    expect(cappedDiff!.excerpt).toContain('+[REDACTED: github-token]')
  }, 30_000)

  it('classifyAttentionPath 豁免 .env 模板并拦截 tfvars / kubeconfig / p8 / service-account / credentials json', () => {
    expect(classifyAttentionPath('.env.example')).toBeUndefined()
    expect(classifyAttentionPath('.env.template')).toBeUndefined()
    expect(classifyAttentionPath('.env.sample')).toBeUndefined()
    expect(classifyAttentionPath('.env')).toBe('env-file')
    expect(classifyAttentionPath('.env.local')).toBe('env-file')

    expect(classifyAttentionPath('terraform.tfvars')).toBe('secret-file')
    expect(classifyAttentionPath('infra/prod.tfvars')).toBe('secret-file')
    expect(classifyAttentionPath('kubeconfig')).toBe('secret-file')
    expect(classifyAttentionPath('.kube/config')).toBe('secret-file')
    expect(classifyAttentionPath('certs/AuthKey_1234.p8')).toBe('secret-file')
    expect(classifyAttentionPath('service-account.json')).toBe('secret-file')
    expect(classifyAttentionPath('keys/gcp-service-account.json')).toBe('secret-file')
    expect(classifyAttentionPath('aws-credentials.json')).toBe('secret-file')
    expect(classifyAttentionPath('credentials-prod.json')).toBe('secret-file')

    const raw = [
      'diff --git a/.env.example b/.env.example',
      '@@ -0,0 +1,1 @@',
      '+PORT=8787',
      'diff --git a/terraform.tfvars b/terraform.tfvars',
      '@@ -0,0 +1,1 @@',
      '+db_pass = "secret"',
    ].join('\n')
    const sanitized = sanitizeDiffExcerpt(raw, 4096)
    expect(sanitized?.excerpt).toContain('+PORT=8787')
    expect(sanitized?.excerpt).not.toContain('db_pass')
    expect(sanitized?.excerpt).toContain('[omitted: secret-file]')
  })
})

describe('D4：link-store normalizeBaseUrl 拒绝远程明文 HTTP 与链路本地元数据地址', () => {
  it('允许 HTTPS 与回环 HTTP，拒绝远程 HTTP 与云元数据主机', () => {
    expect(normalizeBaseUrl('https://cloud.example.com/')).toBe('https://cloud.example.com')
    expect(normalizeBaseUrl('cloud.example.com')).toBe('https://cloud.example.com')
    expect(normalizeBaseUrl('http://localhost:8787/')).toBe('http://localhost:8787')
    expect(normalizeBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeBaseUrl('http://[::1]:8787')).toBe('http://[::1]:8787')

    // 拒绝非回环明文 HTTP
    expect(normalizeBaseUrl('http://cloud.example.com')).toBe('')
    expect(normalizeBaseUrl('http://192.168.1.10:8787')).toBe('')
    expect(normalizeBaseUrl('http://10.0.0.5:8787')).toBe('')
    expect(normalizeBaseUrl('http://0.0.0.0:8787')).toBe('')

    // 拒绝云元数据 / 链路本地地址（无论 HTTP 还是 HTTPS）
    expect(normalizeBaseUrl('http://169.254.169.254')).toBe('')
    expect(normalizeBaseUrl('https://169.254.169.254')).toBe('')
    expect(normalizeBaseUrl('https://169.254.170.2/v2/credentials')).toBe('')
    expect(normalizeBaseUrl('http://metadata.google.internal')).toBe('')
    expect(normalizeBaseUrl('https://metadata.google.internal')).toBe('')
    expect(normalizeBaseUrl('https://metadata.google.internal.')).toBe('')
    expect(normalizeBaseUrl('https://[::ffff:169.254.169.254]')).toBe('')
    expect(normalizeBaseUrl('https://[fe80::1]')).toBe('')
    expect(normalizeBaseUrl('https://[fd00:ec2::254]')).toBe('')
  })
})

describe('D14：云端打包锁文件传递闭包与运维/发布工作流加固', () => {
  it('buildPrunedLockfile 从根 package-lock.json 裁剪出完整且带 SHA-512 integrity 的传递闭包', async () => {
    const rootLock = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), 'package-lock.json'), 'utf-8')
    )
    const pruned = buildPrunedLockfile(rootLock, CLOUD_RUNTIME_DEPS)

    expect(pruned.packageLock.lockfileVersion).toBe(3)
    expect(Object.keys(pruned.pinnedDependencies).sort()).toEqual([...CLOUD_RUNTIME_DEPS].sort())
    expect(pruned.packageCount).toBeGreaterThan(20)

    const entries = Object.entries(pruned.packageLock.packages).filter(([k]) => k !== '')
    expect(entries.length).toBe(pruned.packageCount)
    for (const [key, entry] of entries as Array<[string, Record<string, unknown>]>) {
      expect(typeof entry.version, key).toBe('string')
      expect(typeof entry.resolved, key).toBe('string')
      expect(typeof entry.integrity, key).toBe('string')
      expect(entry.dev, key).toBeUndefined()
      expect(entry.link, key).toBeUndefined()
    }

    // 绝不把桌面端依赖带进云端运行包
    expect(pruned.packageLock.packages['node_modules/electron']).toBeUndefined()
    expect(pruned.packageLock.packages['node_modules/node-pty']).toBeUndefined()
    expect(pruned.packageLock.packages['node_modules/monaco-editor']).toBeUndefined()

    // 缺失 integrity 时 fail-closed 报错
    const brokenLock = {
      lockfileVersion: 3,
      packages: {
        'node_modules/ws': { version: '8.22.0', resolved: 'https://registry.npmjs.org/ws/-/ws-8.22.0.tgz' },
      },
    }
    expect(() => buildPrunedLockfile(brokenLock, ['ws'])).toThrow(/integrity/i)
  })

  it('deploy 脚本、systemd unit、Caddyfile 与 GitHub Actions 工作流包含 Phase A 加固项且脚本保持 LF', async () => {
    const read = (rel: string) => fs.readFile(path.resolve(process.cwd(), rel), 'utf-8')
    const [backupSh, updateSh, backupSvc, cloudSvc, caddy, cloudWf, releaseWf] = await Promise.all([
      read('apps/cloud/deploy/backup.sh'),
      read('apps/cloud/deploy/update.sh'),
      read('apps/cloud/deploy/pi-cloud-backup.service'),
      read('apps/cloud/deploy/pi-cloud.service'),
      read('apps/cloud/deploy/Caddyfile.snippet'),
      read('.github/workflows/cloud-release.yml'),
      read('.github/workflows/release.yml'),
    ])

    // backup.sh：LF、umask 077、sqlite3 .backup + integrity_check、排除 WAL
    expect(backupSh).not.toContain('\r')
    expect(backupSh).toContain('umask 077')
    expect(backupSh).toContain('.backup')
    expect(backupSh).toContain('PRAGMA integrity_check;')
    expect(backupSh).toContain("--exclude='./cloud.db-wal'")

    // update.sh：LF、安全解压、原子 mv -Tf、更新前 SQLite 备份、回滚复检、attestation 校验
    expect(updateSh).not.toContain('\r')
    expect(updateSh).toContain('tar --no-same-owner --no-same-permissions -xzf')
    expect(updateSh).toContain('mv -Tf "${CURRENT_LINK}.tmp" "$CURRENT_LINK"')
    expect(updateSh).toContain('pre-update-')
    expect(updateSh).toContain('gh attestation verify')
    expect(updateSh).toContain('rollback to ${PREV_TARGET} ALSO failed')

    // systemd units & Caddyfile
    expect(backupSvc).not.toContain('EnvironmentFile=')
    expect(cloudSvc).toContain('UMask=0077')
    expect(cloudSvc).toContain('CapabilityBoundingSet=')
    expect(cloudSvc).toContain('ProtectProc=invisible')
    expect(cloudSvc).toContain('SystemCallFilter=@system-service')
    expect(cloudSvc).toContain('StartLimitIntervalSec=60')
    expect(cloudSvc).toContain('StartLimitBurst=5')
    expect(cloudSvc).toContain('TimeoutStopSec=15s')
    expect(caddy).toContain('Strict-Transport-Security')
    expect(caddy).toContain('Referrer-Policy')
    expect(caddy).toContain('Permissions-Policy')

    // GitHub Workflows
    expect(cloudWf).toContain('id-token: write')
    expect(cloudWf).toContain('attestations: write')
    expect(cloudWf).toContain('actions/attest-build-provenance@v2')
    expect(cloudWf).toContain('ASSET_NAME="pi-cloud-bundle-${RELEASE_ID}.tar.gz"')
    expect(cloudWf).toContain('gh release delete-asset')
    expect(releaseWf).toContain('CSC_LINK: ${{ secrets.CSC_LINK }}')
    expect(releaseWf).toContain('WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}')
    expect(releaseWf).toContain('APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}')
    expect(releaseWf).not.toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
  })
})
