/** 提交图 lane 布局：把 git log 顺序的提交排成可绘制的树状图 */

export interface GraphCommitInput {
  sha: string
  parents: string[]
}

export interface GraphParentEdge {
  from: number
  to: number
}

export interface GraphRow {
  sha: string
  lane: number
  before: Array<string | null>
  after: Array<string | null>
  /** 这一行里指向当前提交的 lane（第一个是节点所在 lane，其余是汇入的边） */
  incoming: number[]
  parentEdges: GraphParentEdge[]
}

export interface CommitGraph {
  rows: GraphRow[]
  laneCount: number
}

/**
 * 按 git log 的顺序逐行处理：
 * - lane 保存"下一个期望的提交"；
 * - 当前提交出现在哪个 lane，节点就画在那里；
 * - 第一个父提交优先复用当前 lane，其余父提交分配到空闲 lane；
 * - 多个 lane 同时等待同一个提交时，它们在节点处汇合。
 */
export function buildCommitGraph(commits: readonly GraphCommitInput[]): CommitGraph {
  let lanes: Array<string | null> = []
  const rows: GraphRow[] = []
  let laneCount = 1

  for (const commit of commits) {
    const before = [...lanes]
    const incoming: number[] = []
    before.forEach((sha, index) => {
      if (sha === commit.sha) incoming.push(index)
    })

    let lane = incoming[0]
    if (lane === undefined) {
      lane = before.indexOf(null)
      if (lane === -1) {
        lane = before.length
        before.push(null)
        lanes.push(null)
      }
    }

    const after = [...before]
    for (const index of incoming) after[index] = null

    const parentEdges: GraphParentEdge[] = []
    const parents = commit.parents.filter(Boolean)
    const firstParent = parents[0]

    if (firstParent) {
      // 第一个父提交始终沿当前 lane 继续；多个 branch 共用祖先时，
      // 它们会在祖先提交那一行汇合，形成常见的分叉/合并形状。
      after[lane] = firstParent
      parentEdges.push({ from: lane, to: lane })
    } else {
      after[lane] = null
    }

    for (const parent of parents.slice(1)) {
      let newLane = after.findIndex((value, index) => value === null && index !== lane)
      if (newLane === -1) {
        newLane = after.length
        after.push(null)
      }
      after[newLane] = parent
      parentEdges.push({ from: lane, to: newLane })
    }

    lanes = after
    laneCount = Math.max(laneCount, before.length, after.length)
    rows.push({ sha: commit.sha, lane, before, after, incoming, parentEdges })
  }

  return { rows, laneCount }
}
