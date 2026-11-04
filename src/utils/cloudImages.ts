/**
 * 云端图片指令。
 *
 * 平台的取图方式是文本指令 `/image <服务器上绝对路径>`：用户消息在库里就是一串文本，
 * 图片本身不进消息体。所以客户端要做两件事：
 * 1. 发图时先把本地图片传到控制台，拿到路径再拼成 `/image <path>`；
 * 2. 显示历史时把这种行的路径抽出来，换成缩略图（路径本身不该占一行正文）。
 */

/** 匹配单独的 `/image <path>` 行；行内其它文本不受影响 */
const IMAGE_LINE = /(^|\n)[ \t]*\/image[ \t]+(\S+)[ \t]*/g

export function collectImagePaths(text: string): string[] {
  const paths: string[] = []
  const pattern = new RegExp(IMAGE_LINE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    if (match[2]) paths.push(match[2])
  }
  return paths
}

/** 去掉 `/image <path>` 行，并把因此产生的多余空行收掉 */
export function stripImageDirectives(text: string): string {
  const next = String(text ?? '')
    .replace(new RegExp(IMAGE_LINE.source, 'g'), '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return next
}

/** `/image <path>` 拼回一条消息的开头（多张图按顺序各占一行） */
export function withImageDirectives(text: string, paths: string[]): string {
  if (paths.length === 0) return text
  const head = paths.map((path) => `/image ${path}`).join('\n')
  return text.trim() ? `${head}\n${text}` : head
}
