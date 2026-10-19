/**
 * Agent Manager
 *
 * 管理 Pi Coding Agent 实例的创建、配置和消息处理
 * Agent 运行在 Electron 主进程中，与 main.ts 同进程
 */
export interface AgentConfig {
    workspaceDir: string;
    apiKey: string;
    provider?: 'anthropic' | 'openai' | 'google';
    model?: string;
}
export interface AgentMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}
/**
 * Agent Manager 类
 *
 * 负责：
 * 1. 创建和初始化 Pi Agent 会话
 * 2. 处理用户消息和 Agent 响应
 * 3. 管理会话状态
 */
export declare class AgentManager {
    private session;
    private config;
    private messageHistory;
    private isProcessing;
    /**
     * 初始化 Agent 会话
     *
     * @param config Agent 配置
     * @returns 初始化结果
     */
    initialize(config: AgentConfig): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * 发送消息给 Agent
     *
     * @param message 用户消息
     * @returns Agent 响应
     */
    chat(message: string): Promise<{
        success: boolean;
        response?: string;
        error?: string;
    }>;
    /**
     * 等待 Agent 完成当前处理
     *
     * 简单的轮询实现，等待 isProcessing 状态变为 false
     */
    private waitForCompletion;
    /**
     * 获取消息历史
     */
    getMessageHistory(): AgentMessage[];
    /**
     * 清理资源
     */
    dispose(): Promise<void>;
    /**
     * 检查 Agent 是否已初始化
     */
    isInitialized(): boolean;
    /**
     * 获取当前配置
     */
    getConfig(): AgentConfig | null;
}
