/**
 * Unified API layer for Electron
 */

import type {
  SelectDirectoryResult,
  ReadDirectoryResult,
  ReadFileResult,
  WriteFileResult,
} from '../types/electron'

// Mock API for browser development
const mockAPI = {
  selectDirectory: async (): Promise<SelectDirectoryResult> => {
    console.log('[Mock] selectDirectory');
    return { success: true, path: '/mock/selected/path' };
  },
  readDirectory: async (dirPath: string): Promise<ReadDirectoryResult> => {
    console.log('[Mock] readDirectory:', dirPath);
    return {
      success: true,
      items: [
        { name: 'src', path: '/mock/src', isDirectory: true },
        { name: 'package.json', path: '/mock/package.json', isDirectory: false },
      ]
    };
  },
  readFile: async (filePath: string): Promise<ReadFileResult> => {
    console.log('[Mock] readFile:', filePath);
    return { success: true, content: `// Mock content for ${filePath}` };
  },
  writeFile: async (filePath: string, content: string): Promise<WriteFileResult> => {
    console.log('[Mock] writeFile:', filePath, content.length, 'bytes');
    return { success: true };
  },
};

const electronAPI = window.electronAPI || mockAPI;

export const api = {
  openDirectoryDialog: () => electronAPI.selectDirectory(),
  listDirectory: (path: string) => electronAPI.readDirectory(path),
  readFile: (path: string) => electronAPI.readFile(path),
  writeFile: (path: string, content: string) => electronAPI.writeFile(path, content),
};
