/**
 * MCP 工具的 Pi SDK 扩展工厂：将 `McpClientHost` 已发现的 MCP 工具逐一注册进会话。
 *
 * 工具执行统一委托给 `host.callTool`，保留超时、AbortSignal、128 KB 截断与脱敏护栏。
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { McpClientHost, McpToolContentPart } from './mcp-host.js'

export interface McpExtensionOptions {
  /** 可选附加输出脱敏钩子（若 McpClientHost 自身未注入 outputRedactor 时使用） */
  outputRedactor?: (text: string) => string
}

function toArgumentsRecord(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  return params as Record<string, unknown>
}

function summarizeSnippet(description: string | undefined, fallback: string): string {
  const firstLine = (description ?? '').split(/\r?\n/)[0]?.trim()
  const base = firstLine || fallback
  return base.length > 140 ? `${base.slice(0, 140)}…` : base
}

function applyOptionalRedactor(
  content: McpToolContentPart[],
  redactor?: (text: string) => string
): McpToolContentPart[] {
  if (!redactor) return content
  return content.map((part) =>
    part.type === 'text' ? { type: 'text', text: redactor(part.text) } : part
  )
}

export function createMcpExtension(
  host: McpClientHost,
  options?: McpExtensionOptions
): ExtensionFactory {
  return (pi) => {
    for (const tool of host.getTools()) {
      const description = tool.description?.trim()
        ? `[MCP: ${tool.serverName}] ${tool.description.trim()}`
        : `[MCP: ${tool.serverName}] ${tool.name}`
      const promptSnippet = `${tool.qualifiedName}: [MCP: ${tool.serverName}] ${summarizeSnippet(
        tool.description,
        tool.name
      )}`

      pi.registerTool({
        name: tool.qualifiedName,
        label: `${tool.serverName}: ${tool.name}`,
        description,
        promptSnippet,
        annotations: {
          readOnlyHint: tool.readOnly,
        },
        parameters: tool.inputSchema as any,
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
          const res = await host.callTool(tool.qualifiedName, toArgumentsRecord(params), signal)
          return {
            content: applyOptionalRedactor(res.content, options?.outputRedactor),
            details: res.details,
            ...(res.isError ? { isError: true } : {}),
          }
        },
      })
    }
  }
}
