/**
 * Git Tools —— Pi Workbench 工作台插件示例。
 *
 * 插件运行在主进程，可直接使用 Node.js API。它只扩展工作台本身，
 * 不接入 Pi Agent 的扩展机制。
 */
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

async function git(workspaceDir, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: workspaceDir,
      maxBuffer: 1024 * 1024,
    })
    return { success: true, output: (stdout || stderr || '').trim() }
  } catch (error) {
    const output = `${error.stdout || ''}${error.stderr || ''}`.trim()
    return {
      success: false,
      error: error.message,
      output: output || undefined,
    }
  }
}

module.exports = {
  activate(api) {
    api.registerCommand('git.status', () =>
      git(api.workspaceDir, ['status', '--short', '--branch'])
    )

    api.registerCommand('git.log', () =>
      git(api.workspaceDir, ['log', '--oneline', '--decorate', '-10'])
    )

    api.registerCommand('git.commitAll', async (args) => {
      const message = typeof args === 'string' ? args.trim() : ''
      if (!message) {
        return {
          success: false,
          error: 'Enter a commit message in the command arguments field',
        }
      }

      const staged = await git(api.workspaceDir, ['add', '-A'])
      if (!staged.success) return staged

      return git(api.workspaceDir, ['commit', '-m', message])
    })

    api.on('workspace:opened', () => {
      api.log('git-tools loaded for', api.workspaceDir)
    })

    api.on('file:saved', (payload) => {
      api.log('file saved:', payload && payload.path)
    })
  },

  deactivate() {
    // 释放插件持有的资源；本示例没有长期资源
  },
}
