export type Language = 'zh' | 'en'

export const translations = {
  zh: {
    // App
    appTitle: 'Pi 工作台',
    openProject: '打开项目',
    closeProject: '关闭项目',
    welcome: '欢迎使用 Pi 工作台',
    welcomeSubtitle: '打开项目文件夹开始编辑和聊天',

    // File Explorer
    files: '文件',
    createNewFile: '创建新文件',
    createFile: '创建新文件',
    fileName: '文件名 (例如: index.ts)',
    create: '创建',
    cancel: '取消',
    noWorkspace: '无工作区',
    openWorkspaceFirst: '请先打开工作区',

    // Monaco Editor
    noFileOpen: '没有文件打开',
    selectFileToEdit: '从文件树中选择文件进行编辑',
    saved: '已保存',
    saveFailed: '保存失败',
    close: '关闭',

    // Chat Panel
    piAgent: 'Pi Agent',
    startConversation: '开始对话',
    chatSubtitle: '与 Pi Agent 讨论你的代码问题',
    inputPlaceholder: '输入问题... (Shift+Enter 换行)',
    send: '发送',
    initializing: '初始化中',
    initializingAgent: '正在启动 Pi Agent...',
    startingAgent: '正在启动 Pi Agent...',
    discussCode: '与 Pi Agent 讨论你的代码问题',
    typeQuestion: '输入问题... (Shift+Enter 换行)',
    sendMessage: '发送消息 (Enter)',
    agentReplyReceived: '收到 Pi Agent 回复',
    agentReplyFailed: 'Agent 回复失败',
    messageSendFailed: '消息发送失败',
    receivedReply: '收到 Pi Agent 回复',
    replyFailed: 'Agent 回复失败',
    sendFailed: '消息发送失败',

    // Diff Viewer
    diffViewer: '代码对比',
    splitView: '并排视图',
    unifiedView: '统一视图',
    comparingFiles: '文件对比中...',
    comparing: '文件对比中...',

    // IPC Debug
    ipcDebug: 'IPC 通信调试',
    runTests: '运行测试',
    testing: '测试中...',
    results: '结果',
    allPassed: '全部通过',

    // Settings
    settings: '设置',
    language: '语言',
    chinese: '中文',
    english: 'English',
    recentWorkspaces: '最近打开',
    discardChangesConfirm: '有未保存的修改，确定要关闭吗？未保存的内容会丢失。',
    rename: '重命名',
    delete: '删除',
    deleteConfirm: '确定要删除吗？此操作不可撤销。',
    renamePrompt: '输入新的名称：',
  },

  en: {
    // App
    appTitle: 'Pi Workbench',
    openProject: 'Open Project',
    closeProject: 'Close Project',
    welcome: 'Welcome to Pi Workbench',
    welcomeSubtitle: 'Open a project folder to get started',

    // File Explorer
    files: 'Files',
    createNewFile: 'Create new file',
    createFile: 'Create New File',
    fileName: 'File name (e.g., index.ts)',
    create: 'Create',
    cancel: 'Cancel',
    noWorkspace: 'No workspace',
    openWorkspaceFirst: 'Please open a workspace first',

    // Monaco Editor
    noFileOpen: 'No file open',
    selectFileToEdit: 'Select a file from the explorer to edit',
    saved: 'Saved',
    saveFailed: 'Save failed',
    close: 'Close',

    // Chat Panel
    piAgent: 'Pi Agent',
    startConversation: 'Start Conversation',
    chatSubtitle: 'Discuss your code with Pi Agent',
    inputPlaceholder: 'Type your question... (Shift+Enter for new line)',
    send: 'Send',
    initializing: 'Initializing',
    initializingAgent: 'Starting Pi Agent...',
    startingAgent: 'Starting Pi Agent...',
    discussCode: 'Discuss your code with Pi Agent',
    typeQuestion: 'Type your question... (Shift+Enter for new line)',
    sendMessage: 'Send message (Enter)',
    agentReplyReceived: 'Received reply from Pi Agent',
    agentReplyFailed: 'Agent reply failed',
    messageSendFailed: 'Failed to send message',
    receivedReply: 'Received reply from Pi Agent',
    replyFailed: 'Agent reply failed',
    sendFailed: 'Failed to send message',

    // Diff Viewer
    diffViewer: 'Diff Viewer',
    splitView: 'Split view',
    unifiedView: 'Unified view',
    comparingFiles: 'Comparing files...',
    comparing: 'Comparing files...',

    // IPC Debug
    ipcDebug: 'IPC Communication Debug',
    runTests: 'Run Tests',
    testing: 'Testing...',
    results: 'Results',
    allPassed: 'All Passed',

    // Settings
    settings: 'Settings',
    language: 'Language',
    chinese: '中文',
    english: 'English',
    recentWorkspaces: 'Recent workspaces',
    discardChangesConfirm: 'You have unsaved changes. Close anyway? Unsaved changes will be lost.',
    rename: 'Rename',
    delete: 'Delete',
    deleteConfirm: 'Delete this item? This cannot be undone.',
    renamePrompt: 'Enter a new name:',
  },
}

export type TranslationKey = keyof typeof translations.zh
