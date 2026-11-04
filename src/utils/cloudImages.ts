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

/**
 * 云端 Agent 回图的标记：`MEDIA:<服务器上绝对路径>`。
 *
 * 这是 Hermes 自己的约定（`agent/prompt_builder.py` 里教模型用的），标签可以单独成行，
 * 也可以跟在说明文字后面（`截图已附上 MEDIA:/tmp/shot.png`），还能带 `[[as_document]]` 前缀。
 * 上游按 `MEDIA:\\S+` 切，这里保持一致。
 */
const MEDIA_TAG = /(\[\[as_document\]\]\s*)?MEDIA:(\S+)/g

/** 只认图片扩展名：MEDIA 标签也可能是音频 / 视频 / 文档 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export function isImagePath(path: string): boolean {
  const clean = String(path ?? '')
    .split(/[?#]/)[0]
    .toLowerCase()
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(clean.slice(dot + 1))
}

/** 收集 `MEDIA:` 标签里的图片路径（去重，保持出现顺序） */
export function collectMediaPaths(text: string): string[] {
  const paths: string[] = []
  const pattern = new RegExp(MEDIA_TAG.source, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    const path = match[2]
    if (path && isImagePath(path) && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/**
 * 去掉**图片**的 `MEDIA:` 标签（说明文字保留）。
 * 非图片的标签原样留着 —— 音频 / 文档我们既显示不了也不该悄悄吞掉。
 */
export function stripMediaTags(text: string): string {
  const next = String(text ?? '')
    .replace(new RegExp(MEDIA_TAG.source, 'g'), (whole, _doc: string, path: string) =>
      path && isImagePath(path) ? '' : whole
    )
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return next
}
