/**
 * Pi Agent Bridge
 *
 * This module exposes Pi Agent functionality to Tauri backend.
 * Currently using mock implementation for local development.
 * Will integrate with real Pi modules once available.
 */

export interface AgentConfig {
  apiKey: string
  model?: string
  workspaceDir: string
}

export class PiAgentBridge {
  private agent: any
  private config: AgentConfig
  private messageHistory: Array<{ role: string; content: string }> = []

  constructor(config: AgentConfig) {
    this.config = config
  }

  async initialize(): Promise<void> {
    // Mock initialization
    console.log(`[Pi Agent] Initialized in ${this.config.workspaceDir}`)
    this.agent = {
      ready: true,
      model: this.config.model || 'claude-opus',
    }
  }

  async chat(message: string, context?: any): Promise<string> {
    if (!this.agent) {
      throw new Error('Agent not initialized')
    }

    this.messageHistory.push({ role: 'user', content: message })

    // Mock response based on message content
    let response = ''
    if (message.toLowerCase().includes('test')) {
      response = `I understand you want to test. In the ${this.config.workspaceDir} workspace, I can help you with testing strategies.`
    } else if (message.toLowerCase().includes('code')) {
      response = `Here's a code suggestion:\n\`\`\`javascript\nfunction example() {\n  console.log('Hello from Pi Agent');\n}\n\`\`\``
    } else {
      response = `I received your message: "${message}". How can I help you develop in this workspace?`
    }

    this.messageHistory.push({ role: 'assistant', content: response })
    return response
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.agent) {
      throw new Error('Agent not initialized')
    }
    return `[Mock] Reading file: ${filePath}`
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (!this.agent) {
      throw new Error('Agent not initialized')
    }
    console.log(`[Mock] Writing to ${filePath}: ${content.substring(0, 50)}...`)
  }

  async listDir(dirPath: string): Promise<string[]> {
    if (!this.agent) {
      throw new Error('Agent not initialized')
    }
    return ['mock-file-1.ts', 'mock-file-2.ts', 'mock-folder/']
  }

  getMessageHistory() {
    return this.messageHistory
  }
}

export default PiAgentBridge

