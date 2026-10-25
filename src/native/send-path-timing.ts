/** Product-log timing records only: never parse or print a message or attachment. */
export interface SendPathStage {
  at: number
  process: string
  action: 'send' | 'code'
  stage: string
  uptimeNs: bigint
  queueMs?: number
}

export function sendPathStages(lines: string): SendPathStage[] {
  const stages: SendPathStage[] = []
  for (const line of lines.split('\n')) {
    const header = /^(\S+) debug (app|service|backend) send-path (.*)$/.exec(line)
    if (!header) continue
    const [, timestamp, process, details] = header
    const action = /\baction=(send|code)\b/.exec(details)?.[1]
    const stage = /\bstage=([\w-]+)\b/.exec(details)?.[1]
    const uptime = /\buptimeNs=(\d+)\b/.exec(details)?.[1]
    if (!action || !stage || !uptime) continue
    const at = Date.parse(timestamp)
    if (!Number.isFinite(at)) continue
    const queue = /\bqueueMs=(\d+)\b/.exec(details)?.[1]
    stages.push({
      at,
      process,
      action: action as 'send' | 'code',
      stage,
      uptimeNs: BigInt(uptime),
      ...(queue ? { queueMs: Number(queue) } : {})
    })
  }
  return stages
}

/** A clock is comparable only within its process; log stamps order cross-process hops. */
export function summarizeSendPath(stages: SendPathStage[], since: number): string {
  return stages
    .filter((stage) => stage.at >= since)
    .map(
      (stage) =>
        `${stage.action}:${stage.process}:${stage.stage}@${stage.at - since}ms${stage.queueMs === undefined ? '' : ` queue=${stage.queueMs}ms`}`
    )
    .join(' ')
}
