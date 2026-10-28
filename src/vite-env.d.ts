/// <reference types="vite/client" />

// pdf.js 静态资源包（由 vite.config.ts 的 pi-workbench-pdfjs-assets 插件生成）
declare module 'virtual:pdfjs-assets/cmaps' {
  const table: Record<string, string>
  export default table
}

declare module 'virtual:pdfjs-assets/standard_fonts' {
  const table: Record<string, string>
  export default table
}

declare module 'virtual:pdfjs-assets/wasm' {
  const table: Record<string, string>
  export default table
}
