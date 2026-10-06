import { productLogDirectory, readLogs } from '../main/product-log'

/**
 * LKM-168: the chat smoke's turn wrote its start and end lines, and the host, the
 * service and Bun all wrote to the one log folder (the test run's own, `TREZI_LOG_DIR`).
 */
export async function checkProductLog(chat: string, turn: string) {
  const dir = productLogDirectory()
  if (!process.env.TREZI_LOG_DIR || dir !== process.env.TREZI_LOG_DIR)
    throw new Error(`The smoke must log into its test folder, not ${dir}`)
  const has = (lines: string[], level: string, process: string, text: string) =>
    lines.some(
      (line) =>
        line.split(' ')[1] === level && line.split(' ')[2] === process && line.includes(text)
    )
  let lines: string[] = []
  // The host and the service write on their own queues; give them a moment.
  for (let i = 0; i < 40; i++) {
    lines = readLogs(dir, 60 * 60_000)
    if (
      has(lines, 'info', 'app', 'App started') &&
      has(lines, 'info', 'service', 'Service started')
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const turnLines = lines.filter((line) => line.includes(`turn=${turn}`) && line.includes(chat))
  const missing = [
    ['info', 'app', 'App started'],
    ['info', 'service', 'Service started'],
    ['info', 'service', 'Backend started'],
    ['info', 'backend', 'Backend started']
  ].filter(([level, process, text]) => !has(lines, level, process, text))
  if (
    !turnLines.some((line) =>
      / info backend chat .*Turn started provider=claude model=fixture/.test(line)
    )
  )
    missing.push(['info', 'backend', 'Turn started'])
  if (!turnLines.some((line) => / info backend chat .*Turn ended /.test(line)))
    missing.push(['info', 'backend', 'Turn ended'])
  if (missing.length)
    throw new Error(
      `Product log is missing ${missing.map((m) => m.join(' ')).join('; ')}:\n${lines.slice(-20).join('\n')}`
    )
  console.log(
    `Product log: ${lines.length} lines in the test folder; turn ${turn} logged its start and end.`
  )
}
