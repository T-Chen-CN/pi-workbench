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
  scanDiffForSecrets,
  scanWorktreeSecrets,
} from '../electron/cloud/task-report'

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
