import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import type { AgentEvent } from '../shared/api'
import { buildStamp } from './app-version'
import type { NativeBridge } from './bridge'
import {
  BUSY_MARKER,
  BUSY_WITHIN_MS,
  busyProblems,
  CHAT_RECOVERY_RED_MODES,
  delayRenders,
  failureProblems,
  idleProblems,
  PLANTED,
  RECOVERY_LABEL,
  type RecoveryKind,
  type RecoveryMeasure,
  reportProblems,
  stillHeldProblems
} from './chat-recovery-acceptance'
import { readableRecoveryReport } from './chat-recovery-report'
import { nativeChat } from './chat-runtime'
import { CHAT_RECOVERY_ACCEPTANCE_CHECK } from './smoke-groups'
import { cleanSharedChat } from './smoke-shared-chat'
import { waitFor } from './smoke-wait'

/**
 * LKM-453: the LKM-446 recovery flow on the shipping chat, opt-in
 * (`--chat-recovery-acceptance`; the operator command is `bun run acceptance:chat-recovery`,
 * docs/TESTING.md "Chat recovery acceptance"). The disposable `--test` profile's shared chat,
 * the provider stub of the native smoke and synthetic isolation events; Retry and Resolve
 * pressed on the real conflict card with a click or focus plus Space
 * (src/native/ChatRecoveryAcceptance.swift). Each recovery request is held at the backend
 * seam (`services.invoke`) until the card's busy state (progress, no recovery row, LKM-590)
 * has been measured and captured, and a second dispatch, Discard and the other recovery
 * were tried on it. Outcomes: still held, clean,
 * agent handover, failure with its written report, a second chat kept apart, terminal clear.
 * Evidence: test/artifacts/native/chat-recovery-acceptance/.
 */
export async function checkChatRecoveryAcceptance(host: NativeBridge, artifacts: string) {
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1')
    throw new Error(
      'The chat recovery acceptance needs the foreground; unset TREZI_NATIVE_BACKGROUND_TEST'
    )
  const red = process.env.TREZI_CHAT_RECOVERY_ACCEPTANCE_RED || ''
  if (red && !(CHAT_RECOVERY_RED_MODES as readonly string[]).includes(red))
    throw new Error(`Unknown TREZI_CHAT_RECOVERY_ACCEPTANCE_RED: ${red}`)
  const dir = join(artifacts, 'chat-recovery-acceptance')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const build = buildStamp()
  const sha = process.env.TREZI_ACCEPTANCE_SOURCE_SHA || build?.sha || null
  // biome-ignore lint/suspicious/noExplicitAny: host step payloads are untyped JSON
  const step = (op: string, extra: Record<string, unknown> = {}): Promise<any> =>
    host.request('chatRecoveryAcceptance', { op, card: 'conflict', ...extra })
  const measure = (card = 'conflict'): Promise<RecoveryMeasure> => step('measure', { card })
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const evidence: Record<string, unknown> & {
    outcomes: Record<string, unknown>
    captures: Record<string, string[]>
  } = {
    ticket: 'LKM-453',
    check: CHAT_RECOVERY_ACCEPTANCE_CHECK,
    sha,
    build,
    red: red || null,
    profile: 'disposable --test profile (start-native removes it)',
    startedAt: new Date().toISOString(),
    outcomes: {},
    captures: {}
  }
  const record = () =>
    writeFileSync(join(dir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)

  const shown = await waitFor(async () => {
    const state = await host.request('chatInspect')
    return state.visible && state.chat ? state : null
  }, 'the shared chat is shown')
  const chat: string = shown.chat
  const other = `native-recovery-acceptance-${crypto.randomUUID()}`
  const files = ['src/recovery-fixture.ts']
  const sent: unknown[][] = []
  const provider = stubAgentSendForSmoke(chat, (...args) => {
    sent.push(args)
  })
  const send = (event: object) => provider.emit(event as AgentEvent)
  const calls = { retry: 0, resolve: 0, discard: 0 }
  let held: { kind: RecoveryKind; chat: string; release: (value: unknown) => void } | null = null
  const originalInvoke = nativeChat.services.invoke
  // The deferred boundary: the owner's reply is withheld until the fixture releases it.
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:discard-conflict') {
      calls.discard++
      return { ok: false, error: 'The recovery acceptance never discards.' }
    }
    const kind =
      channel === 'agent:retry-landing'
        ? 'retry'
        : channel === 'agent:resolve-conflict'
          ? 'resolve'
          : null
    if (!kind) return originalInvoke(channel, ...args)
    calls[kind]++
    return new Promise((release) => {
      held = { kind, chat: String(args[0]), release }
    })
  }
  // Arm before the input: recoveryRequest renders busy before it calls services.invoke.
  // The RED card can therefore show its busy state only after the reply is released.
  let suppressBusy = false
  const gate = red === 'delay-busy' ? delayRenders(nativeChat.services, () => suppressBusy) : null
  const release = (value: unknown) => {
    const request = held
    held = null
    suppressBusy = false
    gate?.flush()
    request?.release(value)
  }
  const controller = (key: string) => {
    const c = nativeChat.get(key)
    return {
      isolation: c.isolation ?? null,
      recovery: c.recovery ?? null,
      problem: c.recoveryProblem ?? null,
      report: !!c.recoveryReport,
      outcome: c.recoveryOutcome ?? null,
      running: c.isRunning
    }
  }
  const capture = async (name: string, extra: Record<string, unknown> = {}) => {
    const png = join(dir, `${name}.png`)
    writeFileSync(png, Buffer.from((await host.request('captureVisibleShell')).png, 'base64'))
    const json = join(dir, `${name}.json`)
    const state = {
      sha,
      outcome: name,
      at: new Date().toISOString(),
      measure: await measure(),
      chat: controller(chat),
      otherChat: controller(other),
      calls: { ...calls },
      agentTurns: sent.length,
      held: held ? (held as { kind: string }).kind : null,
      ...extra
    }
    writeFileSync(json, `${JSON.stringify(state, null, 2)}\n`)
    // Relative names keep the manifest valid after the command copies this run to its
    // immutable SHA-keyed directory.
    evidence.captures[name] = [`${name}.png`, `${name}.json`]
    record()
    return state
  }
  // LKM-458: evidence before every fallible wait or refusal, so a refused run keeps what it
  // saw. Numbered flat files (the command hashes the run's top-level files): the card's
  // measurement with its frame sources and stored row, the window, the layout geometry and
  // the controllers. A failing capture is noted, never thrown over the real error.
  const steps: { name: string; files: string[]; error?: string }[] = []
  evidence.steps = steps
  let otherShown = false
  const checkpoint = async (name: string, extra: Record<string, unknown> = {}) => {
    const base = `step-${String(steps.length + 1).padStart(2, '0')}-${name}`
    const entry: (typeof steps)[number] = { name, files: [] }
    steps.push(entry)
    try {
      const state = {
        sha,
        step: name,
        at: new Date().toISOString(),
        measure: await measure(),
        geometry: await host.request('layoutInspect'),
        chat: controller(chat),
        otherChat: otherShown ? controller(other) : null,
        calls: { ...calls },
        agentTurns: sent.length,
        held: held ? (held as { kind: string }).kind : null,
        ...extra
      }
      writeFileSync(join(dir, `${base}.json`), `${JSON.stringify(state, null, 2)}\n`)
      entry.files.push(`${base}.json`)
      const png = (await host.request('captureVisibleShell')).png
      writeFileSync(join(dir, `${base}.png`), Buffer.from(png, 'base64'))
      entry.files.push(`${base}.png`)
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
    }
    record()
  }
  // LKM-590: `failed` parks as a failed landing (its one action is Try applying again);
  // otherwise the project moved under the work (its one action is Combine).
  const parked = async (key = chat, failed = false) => {
    nativeChat.event({
      type: 'isolation',
      projectKey: key,
      state: 'parked',
      files,
      ...(failed ? { reason: 'failed' as const, error: 'Fixture landing failed.' } : {})
    })
    if (key !== chat) return
    const label = RECOVERY_LABEL[failed ? 'retry' : 'resolve']
    await checkpoint('parked', { failed })
    await waitFor(async () => {
      const m = await measure()
      return !m.problem && m.actions.join() === label && !idleProblems(m).length
    }, `the parked card is drawn with ${label}`)
  }
  /** Presses `label` with real input while its request is held: busy within the bound, before any reply. */
  const pressHeld = async (kind: RecoveryKind, label: string, input: 'pointer' | 'keyboard') => {
    await checkpoint(`press-${input}-${kind}`, { label })
    const before = await measure()
    const problems = idleProblems(before)
    if (problems.length) throw new Error(`${label}: the card was not ready: ${problems.join('; ')}`)
    const count = calls[kind]
    if (gate) suppressBusy = true
    const posted = await step(input === 'pointer' ? 'click' : 'key', { label })
    const started = Date.now()
    let last: RecoveryMeasure = before
    let busyAfter = -1
    while (Date.now() - started < BUSY_WITHIN_MS) {
      last = await measure()
      if (held && !busyProblems(last, kind).length) {
        busyAfter = Date.now() - started
        break
      }
      await delay(25)
    }
    // The keyboard route is diagnosed on its own: a Space that never reached the request is
    // not a late busy state. Focus was programmatic; this names what the key step saw.
    if (busyAfter < 0 && input === 'keyboard' && calls[kind] === count)
      throw new Error(
        `${label}: keyboard route — focus reached the key-view proxy programmatically, but the posted Space sent no ${kind} request within ${BUSY_WITHIN_MS} ms (${JSON.stringify(
          {
            keyboardNavigation: posted.keyboardNavigation,
            proxyAcceptsFirstResponder: posted.proxyAcceptsFirstResponder,
            focusedBeforeSpace: posted.focusedBeforeSpace,
            firstResponderBeforeSpace: posted.firstResponderBeforeSpace,
            foreground: posted.foreground,
            firstResponderAfter: last.firstResponder
          }
        )}); the check never changes keyboard settings`
      )
    if (busyAfter < 0)
      throw new Error(
        `${label}: ${BUSY_MARKER} — not shown within ${BUSY_WITHIN_MS} ms while the request was ${held ? 'held' : 'not yet reached'}: ${busyProblems(last, kind).join('; ')}`
      )
    const request = held as { kind: RecoveryKind; chat: string } | null
    if (calls[kind] !== count + 1 || request?.kind !== kind || request.chat !== chat)
      throw new Error(`${label}: the request held at the boundary is not this chat's one ${kind}`)
    if (nativeChat.get(other).recovery) throw new Error(`${label}: the other chat became busy`)
    if (input === 'keyboard') await step('blur')
    return { input: posted, busyAfterMs: busyAfter, boundMs: BUSY_WITHIN_MS, busy: last }
  }
  /** A second dispatch of `action` on a held card (as a double press would send) must
   *  change nothing: no request, still busy. LKM-590: the held card draws no recovery
   *  buttons, so the dispatch goes through the host's chat action route. */
  const blocked = async (kind: RecoveryKind, action: string) => {
    await checkpoint(`blocked-${kind}`, { action })
    const counts = { ...calls }
    const posted = await host.request('chatPerform', { action, card: 'conflict' })
    await delay(400)
    const after = await measure()
    if (JSON.stringify(calls) !== JSON.stringify(counts))
      throw new Error(`${action} on the busy card sent a request: ${JSON.stringify(calls)}`)
    const problems = busyProblems(after, kind)
    if (problems.length || nativeChat.get(chat).recovery !== kind)
      throw new Error(`${action} on the busy card changed it: ${problems.join('; ')}`)
    return { action, input: posted ?? 'chatPerform', requests: { ...calls } }
  }
  const settle = async (label: string, check: (m: RecoveryMeasure) => string[], card?: string) => {
    await checkpoint('settle', { waitingFor: label })
    return waitFor(
      async () => {
        const m = await measure(card)
        return check(m).length ? null : m
      },
      label,
      10000,
      async () => check(await measure(card))
    )
  }

  let reset: unknown
  try {
    await checkpoint('prepare')
    const prepared = await step('prepare')
    if (!prepared.foreground) throw new Error('The chat window did not come to the foreground')
    evidence.keyboardNavigation = prepared.keyboardNavigation
    // A turn in the transcript, so the conversation (not the start screen) holds the card.
    await host.request('composerPerform', { text: 'Change the heading for the recovery check.' })
    await checkpoint('fixture-turn')
    await waitFor(async () => (await host.request('composerInspect')).enabled, 'composer ready')
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === 1, 'the fixture turn reached the provider stub')
    send({ type: 'delta', text: 'Changed the heading.' })
    send({ type: 'done' })
    await waitFor(() => !nativeChat.get(chat).isRunning, 'the fixture turn ended')
    // A second chat with its own held changes and Problem, set up by events, not input.
    nativeChat.get(other)
    otherShown = true
    await parked(other)
    await checkpoint('other-parked')
    await waitFor(() => !!nativeChat.get(other).recoveryReport, "the other chat's report")
    await parked(chat, true)
    const turns = sent.length

    // 1. Try applying again by pointer, held: busy before the reply, with no recovery row;
    // a second Retry, Discard and Resolve dispatched meanwhile change nothing.
    const retry = await pressHeld('retry', RECOVERY_LABEL.retry, 'pointer')
    const heldShot = await capture('held-busy', { press: retry })
    const tries = [
      await blocked('retry', 'landing-retry'),
      await blocked('retry', 'discard'),
      await blocked('retry', 'resolve')
    ]
    await capture('held-blocked', { tries })
    release({ ok: true, state: 'parked' })
    await settle('Retry settles still held', stillHeldProblems)
    if (sent.length !== turns) throw new Error('A still-held Retry started an agent turn')
    evidence.outcomes['held-busy'] = { busyAfterMs: retry.busyAfterMs, at: heldShot.at, tries }
    evidence.outcomes['still-held'] = await capture('still-held')

    // 2. Combine by pointer that lands cleanly: one outcome line, no agent turn.
    await parked()
    const clean = await pressHeld('resolve', RECOVERY_LABEL.resolve, 'pointer')
    nativeChat.event({ type: 'isolation', projectKey: chat, state: 'merged', files: [] })
    release({ ok: true, conflicted: [], prompt: null })
    await checkpoint('clean-released')
    const outcome = await waitFor(async () => {
      const m = await measure('recovery-outcome')
      return m.present && !m.cards.includes('conflict') && !m.cards.includes('error') ? m : null
    }, 'a clean Resolve shows its outcome')
    if (outcome.detail !== 'Changes applied to the project.' || sent.length !== turns)
      throw new Error(`A clean Resolve did not settle in one outcome: ${outcome.detail}`)
    if (nativeChat.get(chat).recovery) throw new Error('A clean Resolve left the chat busy')
    evidence.outcomes.clean = await capture('clean', { press: clean, outcome: outcome.detail })

    // 3. Resolve by keyboard that hands over to one agent turn.
    await parked()
    const handover = await pressHeld('resolve', RECOVERY_LABEL.resolve, 'keyboard')
    release({ ok: true, conflicted: files, prompt: 'Resolve the recovery fixture conflict.' })
    await checkpoint('handover-released')
    await waitFor(
      () => sent.length === turns + 1 && nativeChat.get(chat).isRunning,
      'one agent turn'
    )
    if (nativeChat.get(chat).recovery) throw new Error('The handover kept the request busy')
    evidence.outcomes.handover = await capture('handover', { press: handover })
    send({ type: 'done' })
    await checkpoint('handover-done')
    await waitFor(() => !nativeChat.get(chat).isRunning, 'the handover turn ended')

    // 4. Retry by pointer that fails: the same card states the Problem; its report is written.
    await parked(chat, true)
    const failing = await pressHeld('retry', RECOVERY_LABEL.retry, 'pointer')
    release({ ok: false, error: `Fixture recovery failed ${PLANTED.key} token=${PLANTED.token}` })
    await settle('a failed Retry states its Problem', (m) =>
      failureProblems(m).concat(
        /Fixture recovery failed/.test(m.detail) ? [] : ['not this failure']
      )
    )
    const path = nativeChat.get(chat).recoveryReport
    const content = readableRecoveryReport(chat)
    const mode = path ? statSync(path).mode & 0o777 : null
    const report = reportProblems(content, mode, { chat, others: [other] })
    if (report.length) throw new Error(`The support report: ${report.join('; ')}`)
    if (path) copyFileSync(path, join(dir, 'failure-report.json'))
    evidence.outcomes.failure = await capture('failure', {
      press: failing,
      report: { mode: '600', kept: 'failure-report.json', bytes: content?.length }
    })

    // 5. Two chats: the other chat's Problem and report are its own and were never busy.
    const otherPath = nativeChat.get(other).recoveryReport
    const otherMode = otherPath ? statSync(otherPath).mode & 0o777 : null
    // Its reason holds no secret, so there is nothing for the redaction to replace.
    const crossed = reportProblems(readableRecoveryReport(other), otherMode, {
      chat: other,
      others: [chat]
    }).filter((problem) => !/redacted nothing/.test(problem))
    if (crossed.length || !nativeChat.get(other).recoveryProblem)
      throw new Error(`The other chat's recovery: ${crossed.join('; ') || 'no Problem'}`)
    evidence.outcomes.isolation = await capture('isolation', {
      setup: 'the other chat was parked by an isolation event (programmatic, not input)',
      otherReport: 'names only the other chat'
    })

    // 6. The changes land: this chat's card, Problem and report clear; the other chat keeps its own.
    nativeChat.event({ type: 'isolation', projectKey: chat, state: 'merged', files })
    await checkpoint('landed')
    const cleared = await waitFor(async () => {
      const m = await measure()
      return !m.present && !m.cards.includes('error') ? m : null
    }, 'the landed changes clear the card')
    const after = controller(chat)
    if (after.problem || after.report || after.recovery)
      throw new Error(`The terminal event left recovery state: ${JSON.stringify(after)}`)
    const kept = controller(other)
    if (!kept.problem || !kept.report)
      throw new Error("The terminal event cleared the other chat's")
    evidence.outcomes['terminal-clear'] = await capture('terminal-clear', { cards: cleared.cards })
    evidence.outcome = 'pass'
  } catch (error) {
    evidence.outcome = 'fail'
    evidence.error = error instanceof Error ? error.message : String(error)
    // The refusal as it stood, before `finally` releases a held request.
    await checkpoint('refused', { error: evidence.error })
    throw error
  } finally {
    evidence.finishedAt = new Date().toISOString()
    record()
    // A request still held (a failure above) ends as still held, so the chat is free again.
    release({ ok: true, state: 'parked' })
    gate?.restore()
    nativeChat.services.invoke = originalInvoke
    reset = await cleanSharedChat(
      host,
      {
        state: () => originalInvoke('agent:turn-state', chat),
        controller: () => nativeChat.get(chat)
      },
      () => send({ type: 'done' })
    )
    // A late agent:send must never reach a real provider: the stub stays when nothing was sent.
    if (sent.length) provider.restore()
  }
  // A reset failure fails only a check that otherwise passed (as in smoke-chat.ts).
  if (reset) throw reset
  console.log(
    `Chat recovery acceptance: every outcome captured on ${sha ?? 'an unstamped build'}; evidence in ${dir}.`
  )
}
