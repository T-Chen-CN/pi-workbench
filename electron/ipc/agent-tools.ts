/** Agent 工具结果查看、会话导出、模型能力、提示资源与结构化计划 IPC */

import * as fs from 'fs/promises'
import * as path from 'path'
import { shell, dialog, BrowserWindow } from 'electron'
import { getAppDir } from '../app-paths.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import { handleIpc } from './register.js'
import { isValidSessionId, type AgentIpcContext } from './agent-helpers.js'

export function registerAgentToolAndExportIpc(context: AgentIpcContext): void {
  // 工具结果全量查看（R-20）：只读访问会话消息中的完整结果
  handleIpc(
    'agent:tool-result:meta',
    async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.getToolResultMeta !== 'function') {
          return { success: false, error: 'Tool results are not supported by this agent' }
        }
        return await agent.getToolResultMeta(sessionId, toolCallId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'agent:tool-result:chunk',
    async (
      _event,
      workspaceDir: string,
      sessionId: string,
      toolCallId: string,
      offset?: number,
      limit?: number
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.readToolResultChunk !== 'function') {
          return { success: false, error: 'Tool results are not supported by this agent' }
        }
        const safeOffset = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0
        const safeLimit = typeof limit === 'number' && Number.isFinite(limit) ? limit : 65_536
        return await agent.readToolResultChunk(sessionId, toolCallId, safeOffset, safeLimit)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'agent:tool-result:image',
    async (_event, workspaceDir: string, sessionId: string, toolCallId: string, index?: number) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.getToolResultImage !== 'function') {
          return { success: false, error: 'Tool results are not supported by this agent' }
        }
        return await agent.getToolResultImage(
          sessionId,
          toolCallId,
          typeof index === 'number' && Number.isFinite(index) ? index : 0
        )
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 完整结果导出到应用缓存并用系统编辑器打开（不产生第二份长期副本）
  handleIpc(
    'agent:tool-result:open',
    async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.getToolResultText !== 'function') {
          return { success: false, error: 'Tool results are not supported by this agent' }
        }
        const result = await agent.getToolResultText(sessionId, toolCallId)
        if (!result.success || typeof result.text !== 'string') return result

        const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'result'
        const filePath = path.join(getAppDir(), 'cache', 'temp', `tool-result-${safeId}.txt`)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, result.text, 'utf-8')
        const openError = await shell.openPath(filePath)
        return openError
          ? { success: false, error: openError, path: filePath }
          : { success: true, path: filePath }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 会话导出（R-10）：Markdown / 自带样式 HTML / 原始 JSONL
  handleIpc(
    'agent:export-session',
    async (
      _event,
      workspaceDir: string,
      sessionId: string,
      format: string,
      language?: string
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        if (format !== 'md' && format !== 'html' && format !== 'jsonl') {
          return { success: false, error: 'Unsupported export format' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        const lang: 'zh' | 'en' = language === 'en' ? 'en' : 'zh'

        let title = sessionId
        let content: string | null = null
        let sourcePath: string | null = null

        if (format === 'jsonl') {
          if (typeof agent.getSessionJsonlPath !== 'function') {
            return { success: false, error: 'JSONL export is not supported by this agent' }
          }
          const result = await agent.getSessionJsonlPath(sessionId)
          if (!result.success || !result.path) return result
          title = result.title ?? sessionId
          sourcePath = result.path
        } else if (format === 'md') {
          if (typeof agent.exportSessionMarkdown !== 'function') {
            return { success: false, error: 'Markdown export is not supported by this agent' }
          }
          const result = await agent.exportSessionMarkdown(sessionId, lang)
          if (!result.success || typeof result.content !== 'string') return result
          title = result.title ?? sessionId
          content = result.content
        } else {
          if (typeof agent.exportSessionHtml !== 'function') {
            return { success: false, error: 'HTML export is not supported by this agent' }
          }
          const result = await agent.exportSessionHtml(sessionId, lang)
          if (!result.success || typeof result.content !== 'string') return result
          title = result.title ?? sessionId
          content = result.content
        }

        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'session'
        const extension = format === 'md' ? 'md' : format === 'html' ? 'html' : 'jsonl'
        const filterName = format === 'md' ? 'Markdown' : format === 'html' ? 'HTML' : 'JSONL'
        const options = {
          defaultPath: path.join(workspaceDir, `${safeTitle}.${extension}`),
          filters: [{ name: filterName, extensions: [extension] }],
        }
        const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        const picked = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options)
        if (picked.canceled || !picked.filePath) {
          return { success: true, canceled: true }
        }

        if (sourcePath) {
          await fs.copyFile(sourcePath, picked.filePath)
        } else {
          await fs.writeFile(picked.filePath, content ?? '', 'utf-8')
        }
        return { success: true, path: picked.filePath }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 模型能力提示（R-06）：上下文窗口、思考与图像输入
  handleIpc('agent:models:capabilities', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getModelCapabilities !== 'function') {
        return { success: false, error: 'Model capabilities are not supported by this agent' }
      }
      return await agent.getModelCapabilities()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 提示模板与技能（R-13）
  handleIpc(
    'agent:prompt-resources',
    async (_event, workspaceDir: string, sessionId: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.listPromptResources !== 'function') {
          return { success: false, error: 'Prompt resources are not supported by this agent' }
        }
        return await agent.listPromptResources(sessionId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 结构化计划（R-04）：读取 / 批准 / 拒绝
  handleIpc('agent:plan:get', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getPlan !== 'function') {
        return { success: false, error: 'Plans are not supported by this agent' }
      }
      return await agent.getPlan(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'agent:plan:approve',
    async (
      _event,
      workspaceDir: string,
      sessionId: string,
      planId: string,
      targetMode: 'ask' | 'auto'
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        if (targetMode !== 'ask' && targetMode !== 'auto') {
          return { success: false, error: 'Invalid execute mode' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.approvePlan !== 'function') {
          return { success: false, error: 'Plans are not supported by this agent' }
        }
        return await agent.approvePlan(sessionId, planId, targetMode)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'agent:plan:reject',
    async (_event, workspaceDir: string, sessionId: string, planId: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.rejectPlan !== 'function') {
          return { success: false, error: 'Plans are not supported by this agent' }
        }
        return await agent.rejectPlan(sessionId, planId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
