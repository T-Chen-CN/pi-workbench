/**
 * Pi Agent API client
 * Handles communication with Pi Agent for chat and code analysis
 */

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentResponse {
  content: string
  isSuccess: boolean
  error?: string
}

export interface AgentContext {
  currentFile?: string
  openFiles?: string[]
}

class PiAgentClient {
  private initialized: boolean = false
  private context: AgentContext = {}

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Mock initialization
    console.log('Initializing Pi Agent...')
    await new Promise((resolve) => setTimeout(resolve, 500))

    this.initialized = true
    console.log('Pi Agent initialized')
  }

  async sendMessage(userMessage: string): Promise<AgentResponse> {
    if (!this.initialized) {
      await this.initialize()
    }

    try {
      // Simulate API latency
      await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 500))

      // Generate mock response
      const response = this.generateMockResponse(userMessage)

      return {
        content: response,
        isSuccess: true,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        content: '',
        isSuccess: false,
        error: errorMsg,
      }
    }
  }

  async analyzeCode(code: string, fileName: string): Promise<AgentResponse> {
    if (!this.initialized) {
      await this.initialize()
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const analysis = this.generateCodeAnalysis(code, fileName)
      return {
        content: analysis,
        isSuccess: true,
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        content: '',
        isSuccess: false,
        error: errorMsg,
      }
    }
  }

  setContext(context: Partial<AgentContext>): void {
    this.context = { ...this.context, ...context }
  }

  private generateMockResponse(userMessage: string): string {
    const lowerMessage = userMessage.toLowerCase()

    // Context-aware responses
    if (lowerMessage.includes('what') || lowerMessage.includes('什么')) {
      return '这是一个很好的问题。我建议您详细说明您想要了解的内容，这样我可以提供更具体的帮助。'
    }

    if (lowerMessage.includes('error') || lowerMessage.includes('错误')) {
      return '错误信息通常会指向问题的根源。请检查错误堆栈跟踪，通常最后几行会告诉你真正的问题在哪里。'
    }

    if (lowerMessage.includes('code') || lowerMessage.includes('代码')) {
      return '我可以帮你审查代码、提出优化建议或解答特定问题。请提供代码段或具体问题。'
    }

    if (lowerMessage.includes('how') || lowerMessage.includes('怎样')) {
      return '这取决于您具体的需求。您能提供更多背景信息吗？'
    }

    if (this.context.currentFile) {
      return `我看到您正在处理 ${this.context.currentFile}。有什么具体的问题我可以帮助吗？`
    }

    // Default response
    return `我收到了您的问题："${userMessage}"。这是一个很好的想法。让我思考一下最佳的回答方式...`
  }

  private generateCodeAnalysis(code: string, fileName: string): string {
    const lines = code.split('\n').length
    const hasComments = code.includes('//')
    const hasTypeScript = code.includes(':')

    let analysis = `关于 ${fileName} 的分析:\n\n`
    analysis += `📊 代码统计:\n`
    analysis += `  - 行数: ${lines}\n`
    analysis += `  - 包含注释: ${hasComments ? '是' : '否'}\n`
    analysis += `  - 可能使用 TypeScript: ${hasTypeScript ? '是' : '否'}\n\n`
    analysis += `💡 建议:\n`
    analysis += `  1. 确保代码有适当的注释\n`
    analysis += `  2. 考虑添加类型定义\n`
    analysis += `  3. 检查代码的模块化程度`

    return analysis
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

// Singleton instance
const piAgentClient = new PiAgentClient()

export async function initializeAgent(): Promise<void> {
  await piAgentClient.initialize()
}

export async function sendMessageToAgent(
  message: string
): Promise<AgentResponse> {
  return piAgentClient.sendMessage(message)
}

export async function analyzeCodeWithAgent(
  code: string,
  fileName: string
): Promise<AgentResponse> {
  return piAgentClient.analyzeCode(code, fileName)
}

export function setAgentContext(context: Partial<AgentContext>): void {
  piAgentClient.setContext(context)
}

export function isAgentInitialized(): boolean {
  return piAgentClient.isInitialized()
}
