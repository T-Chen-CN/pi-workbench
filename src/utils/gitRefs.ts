/** 解析 `git log --format=%D` 的 ref decoration，供提交行上的徽章使用 */

export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface GitRefChip {
  kind: GitRefKind
  /** 徽章上显示的文字（远端只显示远端名） */
  label: string
  /** 悬浮提示里的完整 ref */
  title: string
}

/**
 * remoteNames 必须由调用方提供（默认 origin）：本地分支名本身可以带斜杠，
 * 只有已知远端名开头的 ref 才能判定为远端分支。
 */
export function parseGitRefs(
  refs: string,
  remoteNames: readonly string[] = ['origin']
): GitRefChip[] {
  const chips: GitRefChip[] = []
  const seenRemotes = new Set<string>()
  let headChip: GitRefChip | null = null

  for (const raw of refs
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)) {
    if (raw === 'HEAD') continue
    if (raw.startsWith('HEAD -> ')) {
      const name = raw.slice(8)
      headChip = { kind: 'head', label: name, title: `${name}（HEAD）` }
      continue
    }
    if (raw.startsWith('tag: ')) {
      const name = raw.slice(5)
      chips.push({ kind: 'tag', label: name, title: `tag ${name}` })
      continue
    }
    const remote = remoteNames.find((name) => raw.startsWith(`${name}/`))
    if (remote) {
      if (raw === `${remote}/HEAD`) continue
      if (!seenRemotes.has(remote)) {
        seenRemotes.add(remote)
        chips.push({ kind: 'remote', label: remote, title: raw })
      }
      continue
    }
    chips.push({ kind: 'branch', label: raw, title: raw })
  }

  return headChip ? [headChip, ...chips] : chips
}
