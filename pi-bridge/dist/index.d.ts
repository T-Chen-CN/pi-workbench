/**
 * Pi Agent Bridge
 *
 * This module exposes Pi Agent functionality to Tauri backend.
 * Currently using mock implementation for local development.
 * Will integrate with real Pi modules once available.
 */
export interface AgentConfig {
    apiKey: string;
    model?: string;
    workspaceDir: string;
}
export declare class PiAgentBridge {
    private agent;
    private config;
    private messageHistory;
    constructor(config: AgentConfig);
    initialize(): Promise<void>;
    chat(message: string, context?: any): Promise<string>;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, content: string): Promise<void>;
    listDir(dirPath: string): Promise<string[]>;
    getMessageHistory(): {
        role: string;
        content: string;
    }[];
}
export default PiAgentBridge;
