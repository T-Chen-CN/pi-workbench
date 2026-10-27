export declare const PROTECTED_TOP_LEVEL: readonly string[]
export declare const MANIFEST_FILES: string
export declare const MANIFEST_DIRS: string
export declare const MANIFEST_PROTECTED: string
export declare const MANIFEST_DIR: string

export interface InstallerManifest {
  files: string[]
  dirs: string[]
}

export interface InstallerManifestWriteResult {
  files: number
  dirs: number
  filesPath: string
  dirsPath: string
  protectedPath: string
}

export declare function validateManifestEntry(entry: string): void
export declare function buildInstallerManifest(rootDir: string): InstallerManifest
export declare function writeInstallerManifest(appOutDir: string): InstallerManifestWriteResult
