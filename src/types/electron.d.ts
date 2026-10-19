export interface ElectronAPI {
  // File system operations
  selectDirectory: () => Promise<SelectDirectoryResult>;
  readDirectory: (path: string) => Promise<ReadDirectoryResult>;
  readFile: (path: string) => Promise<ReadFileResult>;
  writeFile: (path: string, content: string) => Promise<WriteFileResult>;

  // Dialog operations
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogResult>;
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
}

export interface SelectDirectoryResult {
  success: boolean;
  path?: string;
  canceled?: boolean;
}

export interface ReadDirectoryResult {
  success: boolean;
  items?: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
  }>;
  error?: string;
}

export interface ReadFileResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface WriteFileResult {
  success: boolean;
  error?: string;
}

export interface OpenDialogOptions {
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface OpenDialogResult {
  success: boolean;
  filePaths?: string[];
  canceled?: boolean;
}

export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveDialogResult {
  success: boolean;
  filePath?: string;
  canceled?: boolean;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
