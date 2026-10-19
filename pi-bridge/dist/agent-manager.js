/**
 * Agent Manager
 *
 * 管理 Pi Coding Agent 实例的创建、配置和消息处理
 * Agent 运行在 Electron 主进程中，与 main.ts 同进程
 */
import { createAgentSession, } from '@earendil-works/pi-coding-agent';
import * as path from 'path';
import * as os from 'os';
/**
 * Agent Manager 类
 *
 * 负责：
 * 1. 创建和初始化 Pi Agent 会话
 * 2. 处理用户消息和 Agent 响应
 * 3. 管理会话状态
 */
export class AgentManager {
    constructor() {
        this.session = null;
        this.config = null;
        this.messageHistory = [];
        this.isProcessing = false;
    }
    /**
     * 初始化 Agent 会话
     *
     * @param config Agent 配置
     * @returns 初始化结果
     */
    async initialize(config) {
        try {
            console.log('[Agent Manager] Initializing agent...');
            console.log('[Agent Manager] Workspace:', config.workspaceDir);
            console.log('[Agent Manager] Provider:', config.provider || 'anthropic');
            this.config = config;
            // 设置环境变量（Pi Agent 会从环境变量读取 API Key）
            const providerKey = (config.provider || 'anthropic').toUpperCase();
            process.env[`${providerKey}_API_KEY`] = config.apiKey;
            // 创建 Pi Coding Agent 会话
            // Pi Agent 自带 read/write/edit/bash 工具
            const result = await createAgentSession({
                // 工作目录
                cwd: config.workspaceDir,
                // Agent 配置目录（可选，用于持久化设置和认证）
                // 使用临时目录避免污染用户的 ~/.pi
                agentDir: path.join(os.tmpdir(), 'pi-workbench-agent'),
            });
            this.session = result.session;
            console.log('[Agent Manager] Agent initialized successfully');
            console.log('[Agent Manager] Available tools: read, write, edit, bash (built-in)');
            return { success: true };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('[Agent Manager] Initialization failed:', errorMessage);
            console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '');
            return {
                success: false,
                error: `Failed to initialize agent: ${errorMessage}`
            };
        }
    }
    /**
     * 发送消息给 Agent
     *
     * @param message 用户消息
     * @returns Agent 响应
     */
    async chat(message) {
        if (!this.session) {
            return {
                success: false,
                error: 'Agent not initialized. Please initialize first.',
            };
        }
        if (this.isProcessing) {
            return {
                success: false,
                error: 'Agent is currently processing another request.',
            };
        }
        try {
            this.isProcessing = true;
            console.log('[Agent Manager] Sending message to agent:', message.substring(0, 100));
            // 记录用户消息
            this.messageHistory.push({
                role: 'user',
                content: message,
                timestamp: Date.now(),
            });
            // 发送用户消息并等待 Agent 完成
            await this.session.prompt(message);
            // 等待 Agent 完成处理
            await this.waitForCompletion();
            // 获取 Agent 的最新消息
            const messages = this.session.messages;
            let assistantResponse = '';
            // 从后往前查找最后一条 assistant 消息
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role === 'assistant') {
                    // 提取文本内容
                    if (typeof msg.content === 'string') {
                        assistantResponse = msg.content;
                    }
                    else if (Array.isArray(msg.content)) {
                        assistantResponse = msg.content
                            .filter((part) => part.type === 'text')
                            .map((part) => part.text)
                            .join('\n');
                    }
                    break;
                }
            }
            if (!assistantResponse) {
                assistantResponse = 'Agent completed but returned no text response.';
            }
            // 记录 Assistant 响应
            this.messageHistory.push({
                role: 'assistant',
                content: assistantResponse,
                timestamp: Date.now(),
            });
            console.log('[Agent Manager] Agent response received');
            console.log('[Agent Manager] Response preview:', assistantResponse.substring(0, 200));
            return {
                success: true,
                response: assistantResponse,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('[Agent Manager] Chat error:', errorMessage);
            console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '');
            return {
                success: false,
                error: `Agent error: ${errorMessage}`,
            };
        }
        finally {
            this.isProcessing = false;
        }
    }
    /**
     * 等待 Agent 完成当前处理
     *
     * 简单的轮询实现，等待 isProcessing 状态变为 false
     */
    async waitForCompletion() {
        // 给 Agent 一些时间开始处理
        await new Promise(resolve => setTimeout(resolve, 500));
        // 等待直到处理完成（最多等待 60 秒）
        const startTime = Date.now();
        const maxWaitTime = 60000; // 60 seconds
        while (Date.now() - startTime < maxWaitTime) {
            // 检查是否还有消息在处理
            // Pi Agent 内部会更新 session.messages
            // 简单策略：等待一段时间让 agent 完成
            await new Promise(resolve => setTimeout(resolve, 1000));
            // 如果消息列表已经有了 assistant 响应，认为完成了
            const messages = this.session?.messages || [];
            const hasResponse = messages.some(m => m.role === 'assistant');
            if (hasResponse) {
                break;
            }
        }
    }
    /**
     * 获取消息历史
     */
    getMessageHistory() {
        return this.messageHistory;
    }
    /**
     * 清理资源
     */
    async dispose() {
        if (this.session) {
            this.session = null;
        }
        this.config = null;
        this.messageHistory = [];
    }
    /**
     * 检查 Agent 是否已初始化
     */
    isInitialized() {
        return this.session !== null;
    }
    /**
     * 获取当前配置
     */
    getConfig() {
        return this.config;
    }
}
