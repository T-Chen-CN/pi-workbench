/** 工单改动清单分类与疑似密钥扫描（F-36 / A-29） */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { buildTaskEventMessage } from 'pi-bridge'
import {
  annotateChangedFiles,
  classifyAttentionPath,
  collectTaskDiff,
  sanitizeDiffExcerpt,
  scanDiffForSecrets,
  scanWorktreeSecrets,
} from '../../electron/cloud/task-report'
import { createCloudToolsExtension } from '../../apps/cloud/src/agent/tools'
import { CloudStore } from '../../apps/cloud/src/store/store'

const execFileAsync = promisify(execFile)

describe('classifyAttentionPath / annotateChangedFiles（F-36）', () => {
  it('为 .env*、依赖锁、CI、git hooks、发布配置打上 attention 标记', () => {
    expect(classifyAttentionPath('.env')).toBe('env-file')
    expect(classifyAttentionPath('apps/cloud/.env.production')).toBe('env-file')
    expect(classifyAttentionPath('package-lock.json')).toBe('lockfile')
    expect(classifyAttentionPath('rust/Cargo.lock')).toBe('lockfile')
    expect(classifyAttentionPath('.github/workflows/release.yml')).toBe('ci-workflow')
    expect(classifyAttentionPath('.husky/pre-push')).toBe('git-hook')
    expect(classifyAttentionPath('electron-builder.yml')).toBe('release-config')
    expect(classifyAttentionPath('Dockerfile.prod')).toBe('release-config')
    expect(classifyAttentionPath('src/components/CloudView.tsx')).toBeUndefined()
  })

  it('annotateChangedFiles 保留普通与注意分组，供云端事件按组汇报', () => {
    const annotated = annotateChangedFiles([
      { path: 'src/app.ts', kind: 'modified' },
      { path: '.env.local', kind: 'added' },
      { path: 'package-lock.json', kind: 'modified' },
    ])
    expect(annotated).toEqual([
      { path: 'src/app.ts', kind: 'modified' },
      { path: '.env.local', kind: 'added', attention: 'env-file' },
      { path: 'package-lock.json', kind: 'modified', attention: 'lockfile' },
    ])

    const event = buildTaskEventMessage({
      eventId: 'evt-1',
      kind: 'done',
      taskId: 'T-001',
      deviceId: 'dev-1',
      at: 1,
      summary: 'completed',
      changedFiles: annotated,
    })
    expect(event.content).toContain('attention-files: .env.local (env-file), package-lock.json (lockfile)')
    expect(event.content).toContain('changed-files: src/app.ts')
  })
})

describe('scanDiffForSecrets / scanWorktreeSecrets（F-36 / A-29）', () => {
  it('扫描 diff 新增行，只报位置与类型，绝不打印原始密钥值', () => {
    const fakeAws = ['AKIA', '1234567890ABCDEF'].join('')
    const fakeGh = ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -10,0 +11,4 @@',
      `+const aws = "${fakeAws}"`,
      `+const gh = "${fakeGh}"`,
      '+const demo = "api_key = \'your_example_placeholder_key\'"',
      '-const oldAws = "AKIAZZZZZZZZZZZZZZZZ"',
    ].join('\n')

    const hits = scanDiffForSecrets(diff)
    expect(hits).toEqual([
      { path: 'src/config.ts', line: 11, kind: 'aws-access-key' },
      { path: 'src/config.ts', line: 12, kind: 'github-token' },
    ])

    const event = buildTaskEventMessage({
      eventId: 'evt-2',
      kind: 'done',
      taskId: 'T-002',
      deviceId: 'dev-1',
      at: 2,
      summary: 'done',
      secretHits: hits,
    })
    expect(event.content).toContain('src/config.ts:11 (aws-access-key)')
    expect(event.content).toContain('src/config.ts:12 (github-token)')
    // 硬规则：任何情况下都不打印原始密钥值
    expect(event.content).not.toContain(fakeAws)
    expect(event.content).not.toContain(fakeGh)
  })

  it('真实 git 工作树：同时扫到已提交 diff 与未跟踪新文件里的密钥', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-secret-scan-'))
    const git = (args: string[]) => execFileAsync('git', ['-C', tmp, ...args])
    const fakeKey = ['sk-proj-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('')
    const fakePriv = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')

    try {
      await git(['init', '-b', 'main'])
      await git(['config', 'user.email', 'test@example.com'])
      await git(['config', 'user.name', 'Test'])
      await fs.writeFile(path.join(tmp, 'README.md'), 'hello\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'init'])

      await git(['checkout', '-b', 'pi/task-sec'])
      await fs.writeFile(path.join(tmp, 'committed.ts'), `const a = 1\nconst k = "${fakeKey}"\n`)
      await git(['add', 'committed.ts'])
      await git(['commit', '-m', 'add file'])

      await fs.writeFile(path.join(tmp, 'untracked.pem'), `${fakePriv}\nabc\n`)

      const hits = await scanWorktreeSecrets('main', tmp)
      expect(hits).toEqual(
        expect.arrayContaining([
          { path: 'committed.ts', line: 2, kind: 'api-key' },
          { path: 'untracked.pem', line: 1, kind: 'private-key' },
        ])
      )
      expect(JSON.stringify(hits)).not.toContain(fakeKey)
      expect(JSON.stringify(hits)).not.toContain(fakePriv)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 20_000)
})

describe('C-03b：脱敏 diff 采集与云端 get_task 按需拉取', () => {
  it('sanitizeDiffExcerpt 跳过 .env* 与 lockfile，脱敏密钥行并按字节上限截断', () => {
    const fakeKey = ['sk-proj-', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('')
    const raw = [
      'diff --git a/.env.local b/.env.local',
      '--- a/.env.local',
      '+++ b/.env.local',
      '@@ -0,0 +1,1 @@',
      '+SECRET=super-secret-env',
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,1 +1,1 @@',
      '+{"lock":true}',
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,3 @@',
      ' export const ok = true',
      `+const leaked = "${fakeKey}"`,
      '+export const safe = 42',
    ].join('\n')

    const clean = sanitizeDiffExcerpt(raw, 4096)
    expect(clean).toBeDefined()
    expect(clean?.excerpt).toContain('[omitted: env-file]')
    expect(clean?.excerpt).toContain('[omitted: lockfile]')
    expect(clean?.excerpt).not.toContain('super-secret-env')
    expect(clean?.excerpt).not.toContain('{"lock":true}')
    expect(clean?.excerpt).toContain('+[REDACTED: api-key]')
    expect(clean?.excerpt).not.toContain(fakeKey)
    expect(clean?.excerpt).toContain('+export const safe = 42')
    expect(clean?.truncated).toBeUndefined()

    const huge = `diff --git a/src/big.ts b/src/big.ts\n${'+line-content-0123456789\n'.repeat(80)}`
    const clipped = sanitizeDiffExcerpt(huge, 512)
    expect(clipped?.truncated).toBe(true)
    expect(clipped?.excerpt).toContain('[truncated, total')
    expect(Buffer.byteLength(clipped?.excerpt ?? '', 'utf8')).toBeLessThanOrEqual(512)
  })

  it('collectTaskDiff 在真实 git 工作树里同时采集已提交与未跟踪文件并排除 .env', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-diff-collect-'))
    const git = (args: string[]) => execFileAsync('git', ['-C', tmp, ...args])
    const fakeGh = ['ghp_', '1234567890abcdefghijklmnopqrstuvwxyz'].join('')
    try {
      await git(['init', '-b', 'main'])
      await git(['config', 'user.email', 'test@example.com'])
      await git(['config', 'user.name', 'Test'])
      await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 1\n')
      await git(['add', '.'])
      await git(['commit', '-m', 'init'])

      await git(['checkout', '-b', 'pi/diff-unit'])
      await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 2\n')
      await git(['add', 'a.ts'])
      await git(['commit', '-m', 'update a'])
      await fs.writeFile(path.join(tmp, 'new.ts'), `const token = "${fakeGh}"\nexport const n = 1\n`)
      await fs.writeFile(path.join(tmp, '.env'), 'DB_PASS=never-leak\n')

      const diff = await collectTaskDiff('main', tmp, 8192)
      expect(diff).toBeDefined()
      expect(diff?.excerpt).toContain('export const a = 2')
      expect(diff?.excerpt).toContain('export const n = 1')
      expect(diff?.excerpt).toContain('+[REDACTED: github-token]')
      expect(diff?.excerpt).not.toContain(fakeGh)
      expect(diff?.excerpt).not.toContain('never-leak')
      expect(diff?.excerpt).toContain('[omitted: env-file]')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 20_000)

  it('云端 get_task 默认不附 diff（省上下文），传 includeDiff=true 才返回脱敏 diff', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-diff-tool-'))
    let store: CloudStore | null = null
    try {
      store = await CloudStore.open(tmp)
      await store.saveTask({
        id: 'T-010',
        spec: {
          workUnitId: 'u-diff',
          deviceId: 'dev-1',
          repo: { workspacePath: '/repo' },
          title: 'Refactor auth',
          background: 'b',
          goal: 'g',
          acceptance: 'a',
          output: { summary: true, changeList: true, testResult: true },
          commit: true,
          authorizationId: 'auth-1',
        },
        status: 'done',
        idempotencyKey: 'k-diff',
        createdAt: 1,
        dispatchedAt: 2,
        updatedAt: 3,
        progress: {
          step: 2,
          lastEventAt: 3,
          summary: 'Refactored auth helper',
          changedFiles: [{ path: 'src/auth.ts', kind: 'modified' }],
          diff: { bytes: 64, excerpt: 'diff --git a/src/auth.ts b/src/auth.ts\n+export const v = 2' },
        },
      })

      const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<any> }>()
      const ext = createCloudToolsExtension({
        store,
        hub: {} as never,
        dispatcher: {} as never,
      })
      ext({
        registerTool: (def: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<any> }) => {
          tools.set(def.name, def)
        },
      } as never)

      const getTask = tools.get('get_task')!
      const withoutDiff = await getTask.execute('call-1', { taskId: 'T-010' })
      const textWithout = withoutDiff.content[0].text as string
      expect(textWithout).toContain('includeDiff=true')
      expect(textWithout).not.toContain('+export const v = 2')

      const withDiff = await getTask.execute('call-2', { taskId: 'T-010', includeDiff: true })
      const textWith = withDiff.content[0].text as string
      expect(textWith).toContain('+export const v = 2')
    } finally {
      store?.close()
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
