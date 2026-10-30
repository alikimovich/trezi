import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import type { NativeContextController } from './context-controller'
import { nativeDreamer } from './dreamer-controller'
import type { NativeGitController } from './git-controller'
import type { NativeInspectorController } from './inspector-controller'
import { dispatchIPC, serviceEvents } from './platform'
import { checkAgentIntegration, restoreAgentIntegration } from './smoke-agent-integration'
import { checkAgentInteract } from './smoke-agent-interact'
import { checkAgentNavigation } from './smoke-agent-navigation'
import { checkAgentPreview, restoreAgentPreview } from './smoke-agent-preview'
import { checkAgentQuestion } from './smoke-agent-question'
import { checkAgentRuntime } from './smoke-agent-runtime'
import { checkAgentVerify } from './smoke-agent-verify'
import { checkBrowserSetup, restoreBrowserSetup } from './smoke-browser-setup'
import { checkBuildBadge, restoreBuildBadge } from './smoke-build-badge'
import { checkChangesPanel, restoreChangesPanel } from './smoke-changes-panel'
import { checkNativeChat } from './smoke-chat'
import { captureChatGate, checkChatGate, restoreChatGate } from './smoke-chat-gate'
import { checkChatText } from './smoke-chat-text'
import { checkChatUi } from './smoke-chat-ui'
import { checkCodeLinkClick, restoreCodeLinkClick } from './smoke-code-link'
import { checkCommentRows } from './smoke-comment-rows'
import { checkVisibleComposer } from './smoke-composer'
import { checkComposerSend } from './smoke-composer-send'
import { checkDeviceFrame, restoreDeviceFrame } from './smoke-device-frame'
import { checkDreamerReview } from './smoke-dreamer'
import {
  checkEditorFreshness,
  type FreshnessSmoke,
  restoreEditorFreshness
} from './smoke-editor-freshness'
import { smokeFocusHooks } from './smoke-focus'
import { checkGitUpdates } from './smoke-git-updates'
import { parseSmokeGroups, selectSmokeChecks } from './smoke-groups'
import { checkIncidentRow } from './smoke-incident'
import { checkSelectionInput, preparePreviewInput } from './smoke-input'
import {
  type CustomSmoke,
  checkInspectorCustom,
  restoreInspectorCustom
} from './smoke-inspector-custom'
import { checkInspectorIsland } from './smoke-inspector-island'
import { checkIslandNewChat, restoreIslandNewChat } from './smoke-island-new-chat'
import { checkChatIslands } from './smoke-islands'
import { checkLandingChecks } from './smoke-landing-check'
import { checkLayersIsland, type LayersSmoke, restoreLayersIsland } from './smoke-layers'
import { checkLegacyProject } from './smoke-legacy-project'
import { checkManagedAgentBrowser } from './smoke-managed-agent-browser'
import { checkMovableIslands, restoreMovableIslands } from './smoke-movable-islands'
import { checkParallelStream, restoreParallelStream } from './smoke-parallel-stream'
import { checkPreviewHistory, restorePreviewHistory } from './smoke-preview-history'
import { checkPreviewInspector } from './smoke-preview-inspector'
import { checkPreviewOverlay, restorePreviewOverlay } from './smoke-preview-overlay'
import { checkPreviewSpeed, restorePreviewSpeed } from './smoke-preview-speed'
import { checkPreviewTiming, restorePreviewTiming } from './smoke-preview-timing'
import { checkProjectSwitching } from './smoke-projects'
import { checkPublishProgress } from './smoke-publish'
import { checkQuitAlert } from './smoke-quit'
import {
  formatFailureReport,
  SMOKE_EXIT_PRODUCT,
  SmokeRunFailure,
  smokeExitCode
} from './smoke-report'
import { captureSmokeFailure, restoreSmokeState } from './smoke-restore'
import {
  formatSmokeSummary,
  parseInjectedFailures,
  runSmokeChecks,
  type SmokeCheck
} from './smoke-runner'
import { checkScraibOpen, restoreScraibOpen } from './smoke-scraib-open'
import { checkScraibXcode, restoreScraibXcode } from './smoke-scraib-xcode'
import { checkSelectOff, restoreSelectOff } from './smoke-select-off'
import { checkSentAttachments } from './smoke-sent-attachments'
import { checkSecuritySession } from './smoke-session'
import { checkNativeSheets, restoreNativeSheets } from './smoke-sheets'
import { checkSidebarChats, restoreSidebarChats } from './smoke-sidebar-chats'
import { checkSidebarStatus, restoreSidebarStatus } from './smoke-sidebar-status'
import { checkSkillsSettings, restoreSkillsSettings } from './smoke-skills'
import { checkSourceEditor } from './smoke-source-editor'
import { checkSourceStamps } from './smoke-source-stamp'
import { checkSourceSyntax, restoreSourceSyntax } from './smoke-source-syntax'
import { checkSourceWrap, restoreSourceWrap } from './smoke-source-wrap'
import { checkStartComposer, restoreStartComposer } from './smoke-start'
import { checkSwiftBuild, restoreSwiftBuild } from './smoke-swift-build'
import { checkSwiftGraph, restoreSwiftGraph } from './smoke-swift-graph'
import { checkSwiftMacros, restoreSwiftMacros } from './smoke-swift-macros'
import { checkSwiftPreview, restoreSwiftPreview } from './smoke-swift-preview'
import { checkThreeD, removeThreeDCard } from './smoke-three-d'
import { checkToggleUI } from './smoke-toggle-ui'
import {
  assertIslandDividers,
  capture,
  checkToolbarAddress,
  restoreToolbarAddress
} from './smoke-toolbar'
import { checkToolbarFullScreen } from './smoke-toolbar-fullscreen'
import { checkToolbarMore } from './smoke-toolbar-more'
import { checkToolbarOverflow, observeFirstExpansion } from './smoke-toolbar-overflow'
import { inspectUntil, waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Named checks run by smoke-runner: a failure no longer stops the run. `dependsOn`
 *  lists the checks whose app/window state a check builds on; an independent check
 *  still runs after a failure (the restore hook resets the foreground first). */
export async function runNativeCoreSmoke(
  host: NativeBridge,
  fixture: string,
  root: string,
  preference: (key: string) => string | null,
  context: NativeContextController,
  inspector: NativeInspectorController,
  git: NativeGitController
) {
  const invoke = (channel: string, ...args: any[]) =>
    dispatchIPC('main', { type: 'invoke', channel, args })
  const send = (channel: string, ...args: any[]) =>
    dispatchIPC('main', { type: 'send', channel, args })
  const page = (code: string, isolated = false) =>
    host.request('evaluate', { view: 'preview', code, isolated })
  // Timeouts report the last inspected state (composer waits add the Bun-side
  // chat inputs to `enabled`/attachments/text), not just the predicate's `false`.
  const chatContext = () => {
    const chat = nativeChat.get(nativeChat.active)
    return {
      ready: chat?.ready,
      switching: chat?.switching,
      running: chat?.isRunning,
      textLength: chat?.text?.length,
      attachments: chat?.attachments?.length
    }
  }
  const wait = (check: () => Promise<any> | any, label: string, timeout = 10000) =>
    waitFor(check, label, timeout)
  const inspect = (method: string, check: (s: any) => boolean) =>
    inspectUntil(
      (m) => host.request(m),
      method,
      check,
      method === 'composerInspect' ? chatContext : undefined
    )
  const geometry = async (stage: string) => {
    const value = await host.request('layoutInspect')
    console.log('Native geometry', stage, JSON.stringify(value))
    assert.ok(
      value.windowHeight >= 550 && value.canvasHeight >= 450,
      `Collapsed workspace at ${stage}`
    )
  }
  const artifacts = join(root, 'test/artifacts/native')
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(
    join(fixture, 'native-style.tsx'),
    'export function Fixture() { return <h1 style={{ opacity: 1, paddingLeft: "var(--space-a)", paddingRight: "18px", paddingTop: "6px", paddingBottom: "6px", marginLeft: "auto", marginRight: "-4px", marginTop: "-2px", marginBottom: "3px" }}>Hello</h1> }'
  )
  writeFileSync(
    join(fixture, 'native-layout.module.css'),
    '.layoutCard { display: grid; row-gap: 8px; column-gap: 16px; }\n'
  )
  writeFileSync(
    join(fixture, 'native-layout.tsx'),
    'export function Layout() { return <div className="flex gap-4">Layout</div> }\n'
  )
  const layoutCss =
    '@layer utilities { .native-layout { column-gap: 3px; row-gap: 77px; } } .native-layout { display:flex; gap:0; flex-direction:column; flex-wrap:wrap; justify-content:space-between; align-items:end; } #native-layout { align-items:center !important; } @media (min-width: 1px) { .native-layout { row-gap: 1rem; column-gap: calc(2rem + 1px); align-content:normal; } } @media (max-width: 1px) { .native-layout { row-gap: 99px; } }'
  writeFileSync(join(fixture, 'native-layout.css'), layoutCss)
  writeFileSync(join(fixture, 'native-plain.css'), '.plainLayout { display:flex; gap:8px; }\n')
  let firstProject = '',
    originalURL = '',
    historyURL = '',
    firstChat = ''
  const clearComposer = async () => {
    await host.request('composerPerform', { text: '' })
    for (let i = 0; i < 10 && (await host.request('composerInspect')).attachments.length; i++)
      await host.request('composerPerform', { remove: 0 })
  }
  const layersSmoke: LayersSmoke = {
    fixture,
    invoke,
    send,
    evaluate: page,
    props: () => serviceEvents.emit('event', 'preview:toolbar-action', 'props'),
    cancel: () => serviceEvents.emit('event', 'preview:select-cancelled'),
    saved: () => preference('trezi:native-panel-sizes')
  }
  const freshnessSmoke: FreshnessSmoke = {
    fixture,
    invoke,
    send,
    page,
    props: () => serviceEvents.emit('event', 'preview:toolbar-action', 'props')
  }
  const customSmoke: CustomSmoke = {
    host,
    fixture,
    artifacts,
    inspector,
    invoke,
    select: async (source) => {
      await page(
        `document.querySelector('#native-title').setAttribute('data-trezi-source',${JSON.stringify(source)})`
      )
      const heading = (await invoke('layers:read')).nodes.find((n: any) => n.id === 'native-title')
      assert.ok(heading, 'preview heading in layers')
      await send('layers:select', {
        path: heading.path,
        fingerprint: { tag: heading.tag, source: heading.source }
      })
      await wait(
        () => inspector.element?.source === source && inspector.state.fields.length > 0,
        'custom fixture selected'
      )
    },
    open: async () => {
      if (!(await host.request('inspectorInspect')).visible)
        serviceEvents.emit('event', 'preview:toolbar-action', 'props')
      await inspect('inspectorInspect', (s) => s.visible)
    }
  }
  let freshnessURL = ''
  let layersOriginal = '',
    layersWindow = { width: 0, height: 0 },
    islandsWindow: { width: number; height: number } | undefined
  const checks: SmokeCheck[] = [
    {
      name: 'startup',
      run: async () => {
        await geometry('startup')
        assert.deepEqual(await host.request('webViews'), ['preview'])
        const welcome = await host.request('welcomeInspect')
        assert.ok(welcome.visible && welcome.catFrames >= 10)
        await captureChatGate(host, artifacts, 'no-project', false)
        writeFileSync(
          join(artifacts, 'welcome.png'),
          Buffer.from(await host.request('captureShell'), 'base64')
        )
        // No gear in the sidebar: Settings opens from Trezi → Settings… (Command-,), even with no project.
        assert.deepEqual((await host.request('shellInspect')).sidebarActions, [
          'new-project',
          'open-project'
        ])
        assert.deepEqual(await host.request('settingsMenu'), {
          menu: 'Trezi',
          title: 'Settings…',
          key: ',',
          command: true,
          enabled: true
        })
        await host.request('settingsMenu', { perform: true })
        await inspect(
          'sheetInspect',
          (s) =>
            s.visible &&
            s.title === 'Settings' &&
            s.section === 'general' &&
            s.fields.includes('default')
        )
        assert.equal(
          nativeWorkspace.state.activeKey ?? null,
          null,
          'Settings opened without a project'
        )
        await delay(250)
        writeFileSync(
          join(artifacts, 'settings-no-project.png'),
          Buffer.from(await host.request('captureSheet'), 'base64')
        )
        await host.request('sheetPerform', { action: 'closeWindow' })
        await inspect('sheetInspect', (s) => !s.visible)
      }
    },
    {
      name: 'open-project',
      run: async () => {
        await host.request('shellPerform', { action: 'open-project' })
        await wait(() => nativeWorkspace.state.status.kind === 'running', 'project running', 30000)
        await wait(() => page('!!document.querySelector("#native-title")'), 'fixture loaded')
        firstProject = nativeWorkspace.state.activeKey ?? ''
      }
    },
    {
      name: 'mobile-viewport',
      dependsOn: ['open-project'],
      run: async () => {
        await host.request('shellPerform', { action: 'device' })
        await wait(
          () => page(`getComputedStyle(document.documentElement).scrollbarWidth === 'none'`),
          'mobile scrollbars hidden'
        )
        assert.equal(
          await page(`!!document.querySelector('[data-trezi-frame]')`),
          false,
          'Native mobile must not inject a second phone frame'
        )
        await page(`(() => {
        const scroller = document.createElement('div'); scroller.id = 'scrollbar-check';
        scroller.style.cssText = 'height:60px;overflow:scroll';
        scroller.innerHTML = '<div style="height:400px">Scrollable fixture</div>';
        document.body.append(scroller); scroller.scrollTop = 80;
      })()`)
        assert.equal(
          await page(`getComputedStyle(document.querySelector('#scrollbar-check')).scrollbarWidth`),
          'none'
        )
        assert.equal(
          await page(`document.querySelector('#scrollbar-check').scrollTop`),
          80,
          'Hiding scrollbars preserves scrolling'
        )
        writeFileSync(
          join(artifacts, 'mobile-scrollbars.png'),
          Buffer.from(await host.request('captureShell'), 'base64')
        )
        // Reload must use WebKit's current document, including History API navigation.
        originalURL = await page('location.href')
        const route = new URL('/about.html?tab=details#section', originalURL).href
        await page(
          `(() => { history.pushState({}, '', ${JSON.stringify(route)}); window.reloadSentinel = true; return true })()`
        )
        host.emit('menu', { action: 'reload' })
        await wait(
          () => page('!!document.querySelector("#native-title") && !window.reloadSentinel'),
          'reload completes'
        )
        assert.equal(
          await page('location.href'),
          route,
          'Reload preserves the current path, query and fragment'
        )
        // Restore the actual document, not just its History API URL, before later
        // fixtures edit index.html and depend on its live-reload connection.
        await page(
          `(() => { window.reloadSentinel = true; location.href = ${JSON.stringify(originalURL)}; return true })()`
        )
        await wait(
          () =>
            page(
              `location.href === ${JSON.stringify(originalURL)} && !!document.querySelector('#native-title') && !window.reloadSentinel`
            ),
          'original fixture restored'
        )
        console.log('Native reload preserves History API route, query and fragment.')
        await wait(
          () => page(`getComputedStyle(document.documentElement).scrollbarWidth === 'none'`),
          'mobile scrollbar policy restored after navigation'
        )
        await host.request('shellPerform', { action: 'device' })
        await wait(
          () => page(`!document.querySelector('[data-trezi-frame-style]')`),
          'desktop scrollbar policy restored'
        )
        console.log(
          'Native mobile hides document/nested scrollbars, preserves scrolling and survives navigation.'
        )
      },
      cleanup: async () => {
        if (nativeWorkspace.active?.viewport === 'mobile')
          await host.request('shellPerform', { action: 'device' })
        if (originalURL && (await page('location.href')) !== originalURL) {
          await page(`(() => { location.href = ${JSON.stringify(originalURL)}; return true })()`)
          await wait(
            () =>
              page(
                `location.href === ${JSON.stringify(originalURL)} && !!document.querySelector('#native-title')`
              ),
            'original fixture restored'
          )
        }
      }
    },
    {
      name: 'chat-ready',
      dependsOn: ['open-project'],
      run: async () => {
        await wait(() => nativeChat.chats.get(nativeChat.active)?.ready, 'native chat ready', 30000)
      }
    },
    {
      name: 'source-stamps',
      dependsOn: ['open-project'],
      run: async () => {
        await checkSourceStamps(page)
      }
    },
    {
      name: 'chat-islands',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkChatIslands(host, fixture, artifacts)
      }
    },
    {
      name: 'island-new-chat',
      dependsOn: ['chat-ready'],
      run: () => checkIslandNewChat(host, fixture, wait, inspect),
      cleanup: () => restoreIslandNewChat(fixture, clearComposer)
    },
    {
      name: 'composer',
      dependsOn: ['chat-ready'],
      run: async () => {
        await inspect('composerInspect', (s) => s.welcomedChat)
        writeFileSync(
          join(artifacts, 'composer-ready-beam.png'),
          Buffer.from(await host.request('captureComposer'), 'base64')
        )
        await inspect('composerInspect', (s) => !s.readyBeam)
        assert.deepEqual(await host.request('composerIMECheck'), { marked: true, swallowed: false })
        await host.request('composerPerform', { text: '' })
        await inspect('composerInspect', (s) => s.text === '')
        const compactComposer = await host.request('composerInspect')
        const bottom = compactComposer.bounds.y + compactComposer.bounds.height
        // The shared bottom row leaves more text space in the minimum-height form.
        // Nine lines exercise >60pt growth; mirrored by the windowless layout fixture.
        await host.request('composerPerform', {
          text: Array(9).fill('A line of draft text').join('\n') + '\n'
        })
        const grownComposer = await inspect(
          'composerInspect',
          (s) => s.bounds.height > compactComposer.bounds.height + 60
        )
        assert.equal(
          grownComposer.bounds.y + grownComposer.bounds.height,
          bottom,
          'Composer grows upward from its anchored bottom'
        )
        assert.ok(
          grownComposer.documentHeight <= grownComposer.inputHeight + 1,
          'Uncapped draft fits without scrolling, including trailing newline'
        )
        await host.request('composerPerform', {
          text: Array(80).fill('A long draft line').join('\n')
        })
        const cappedComposer = await inspect(
          'composerInspect',
          (s) =>
            s.bounds.height > grownComposer.bounds.height && s.documentHeight > s.inputHeight + 100
        )
        assert.ok(
          cappedComposer.bounds.height <= 368 &&
            cappedComposer.bounds.height > grownComposer.bounds.height
        )
        writeFileSync(
          join(artifacts, 'composer-expanded.png'),
          Buffer.from(await host.request('captureComposer', { contentOnly: true }), 'base64')
        )
        await host.request('composerPerform', { text: 'wrap text '.repeat(40) })
        const wrappedComposer = await inspect(
          'composerInspect',
          (s) =>
            s.bounds.height > compactComposer.bounds.height &&
            s.bounds.height < cappedComposer.bounds.height
        )
        assert.ok(
          wrappedComposer.documentHeight <= wrappedComposer.inputHeight + 1,
          'Soft-wrapped draft fits before reaching the cap: ' + JSON.stringify(wrappedComposer)
        )
        await host.request('composerPerform', { text: '' })
        await inspect(
          'composerInspect',
          (s) => s.text === '' && s.bounds.height === compactComposer.bounds.height
        )
        for (const clipboard of [
          { image: 'png' },
          { image: 'tiff' },
          { paths: [join(fixture, 'index.html'), join(fixture, 'native-style.tsx')] }
        ]) {
          assert.deepEqual(await host.request('composerPasteCheck', clipboard), {
            enabled: true,
            dispatched: true
          })
          const count = 'paths' in clipboard ? 2 : 1
          const previews = await inspect(
            'composerInspect',
            (s) => s.attachments.length === count && s.enabled && s.text === ''
          )
          assert.equal(previews.attachmentPreviews.count, count)
          assert.equal(previews.attachmentPreviews.images, 'paths' in clipboard ? 0 : 1)
          assert.equal(previews.attachmentPreviews.height, 84)
          assert.ok(previews.inputHeight >= compactComposer.inputHeight - 1)
          const attached = nativeChat.get(nativeChat.active).attachments
          if ('paths' in clipboard)
            assert.deepEqual(
              attached.map((a) => a.path),
              clipboard.paths
            )
          else {
            assert.equal(attached[0].type, 'image/png')
            assert.ok(attached[0].data.length > 0)
          }
          writeFileSync(
            join(artifacts, `paste-${'image' in clipboard ? clipboard.image : 'files'}.png`),
            Buffer.from(await host.request('captureShell'), 'base64')
          )
          for (let i = 0; i < count; i++) await host.request('composerPerform', { remove: 0 })
          await inspect('composerInspect', (s) => s.attachments.length === 0)
        }
        assert.deepEqual(await host.request('composerPasteCheck', { text: 'Pasted text に' }), {
          enabled: true,
          dispatched: true
        })
        await inspect(
          'composerInspect',
          (s) => s.text === 'Pasted text に' && s.attachments.length === 0
        )
        await host.request('composerPerform', { text: '' })
        assert.deepEqual(await host.request('composerPasteCheck'), {
          enabled: false,
          dispatched: false
        })
        const previewFixture = join(artifacts, 'composer-ready-beam.png')
        // Compact tiles (LKM-166): six images and a file card overflow the strip.
        await host.request('composerPerform', {
          files: [previewFixture, join(fixture, 'index.html'), ...Array(5).fill(previewFixture)]
        })
        const mixed = await inspect('composerInspect', (s) => s.attachmentPreviews.count === 7)
        assert.equal(mixed.attachmentPreviews.images, 6)
        assert.ok(
          mixed.attachmentPreviews.documentWidth > mixed.attachmentPreviews.viewportWidth,
          'Attachments scroll horizontally'
        )
        writeFileSync(
          join(artifacts, 'composer-attachments.png'),
          Buffer.from(await host.request('captureComposer'), 'base64')
        )
        await host.request('composerPerform', { remove: 1 })
        const removed = await inspect('composerInspect', (s) => s.attachments.length === 6)
        assert.equal(removed.attachmentPreviews.images, 6, 'Remove targets the file between images')
        for (let i = 0; i < 6; i++) await host.request('composerPerform', { remove: 0 })
        await inspect(
          'composerInspect',
          (s) => s.attachments.length === 0 && s.bounds.height === compactComposer.bounds.height
        )
        console.log('Native attachment thumbnails, file cards, overflow and removal passed.')
      },
      cleanup: async () => {
        await clearComposer()
      }
    },
    {
      name: 'project-switching',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkProjectSwitching(host, fixture, artifacts, context, inspector)
        assert.equal(
          (await host.request('composerInspect')).readyBeam,
          false,
          'Returning to a ready chat replayed its beam'
        )
      }
    },
    {
      name: 'chat-gate',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkChatGate(host, fixture, artifacts, preference)
      },
      cleanup: async () => {
        await restoreChatGate(firstProject, host)
      }
    },
    {
      name: 'sheets',
      dependsOn: ['open-project'],
      run: async () => {
        await checkNativeSheets(host, nativeWorkspace.state.activeKey!, artifacts)
      },
      cleanup: async () => {
        host.emit('activity-action', { action: 'hide' })
        await restoreNativeSheets(host)
      }
    },
    {
      name: 'build-badge',
      dependsOn: ['open-project'],
      run: async () => {
        await checkBuildBadge(host, artifacts)
      },
      cleanup: restoreBuildBadge
    },
    {
      name: 'dreamer',
      dependsOn: ['open-project'],
      run: async () => {
        assert.ok(nativeDreamer.current, 'Dreamer controller')
        await checkDreamerReview(host, nativeDreamer.current, artifacts)
      }
    },
    {
      name: 'skills-settings',
      dependsOn: ['open-project'],
      run: async () => {
        await checkSkillsSettings(host, artifacts)
      },
      cleanup: async () => {
        await restoreSkillsSettings(host)
      }
    },
    {
      name: 'browser-setup',
      run: async () => {
        await checkBrowserSetup(host, artifacts)
      },
      cleanup: async () => {
        await restoreBrowserSetup(host)
      }
    },
    {
      name: 'security-session',
      run: async () => {
        await checkSecuritySession(host, artifacts)
      }
    },
    {
      name: 'shell-layout',
      dependsOn: ['open-project'],
      run: async () => {
        if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1') await preparePreviewInput(host)
        await geometry('sheets')
        const shell = await inspect('shellInspect', (s) => s.enabled.code)
        // Each project row, plus the selected project's nested recent chats (LKM-378).
        assert.equal(
          shell.outlineRows,
          shell.rows.filter((r: any) => r.kind === 'project').length + shell.sidebarChats.length
        )
        assert.deepEqual(shell.toolGroup, ['code', 'layers', 'expand'])
        assert.deepEqual(shell.interactionGroup, ['select-object', 'device', 'overlay', 'speed'])
        // LKM-319: no divider between the buttons of a toolbar island on macOS 27, at rest and
        // after island buttons were used (read in the live toolbar; the capture is evidence).
        await assertIslandDividers(host, 'shell-layout at rest', shell)
        assert.ok(
          shell.sidebarContainsTrafficLights && shell.chatTitlePlain && shell.publishStandard
        )
        await page(
          `(()=>{document.documentElement.style.backgroundColor='rgb(40,80,120)';document.body.style.backgroundColor='transparent'})()`
        )
        const surface = await inspect(
          'previewSurfaceInspect',
          (s) => Math.abs(s.red - 40 / 255) < 0.02
        )
        assert.equal(surface.dividerHeight, surface.surfaceHeight)
        await inspect('shellInspect', (s) => s.previewHeaderLightText)
        await page(`(()=>{document.documentElement.style.backgroundColor='rgb(250,250,250)'})()`)
        await inspect('shellInspect', (s) => !s.previewHeaderLightText)
        await page(
          `(()=>{document.documentElement.style.removeProperty('background-color');document.body.style.removeProperty('background-color')})()`
        )
        const initial = await host.request('layoutInspect')
        for (const delta of [-30, 30, -20, 20]) await host.request('dividerPerform', { delta })
        await inspect('layoutInspect', (s) => Math.abs(s.width - initial.width) < 1)
        // LKM-296: the session's first expansion, read as laid out (asserted in toolbar-address).
        await observeFirstExpansion(host, artifacts)
        await host.request('shellPerform', { action: 'expand' })
        await inspect('layoutInspect', (s) => s.fraction === 1)
        await assertIslandDividers(host, 'after expand')
        await host.request('shellPerform', { action: 'device' })
        await wait(() => nativeWorkspace.active?.viewport === 'mobile', 'mobile viewport')
        await assertIslandDividers(host, 'after device (mobile)')
        await host.request('shellPerform', { action: 'device' })
        await wait(() => nativeWorkspace.active?.viewport === 'desktop', 'desktop viewport')
        await assertIslandDividers(host, 'after device (desktop)')
        await host.request('shellPerform', { action: 'layers' })
        await inspect('layersInspect', (s) => s.visible && s.count > 0)
        await assertIslandDividers(host, 'after layers (open)')
        await capture(host, artifacts, 'islands-layers-open')
        await host.request('shellPerform', { action: 'layers' })
        await inspect('layersInspect', (s) => !s.visible)
        await assertIslandDividers(host, 'after layers (closed)')
        await capture(host, artifacts, 'islands-after-use')
      },
      cleanup: async () => {
        await page(
          `(()=>{document.documentElement.style.removeProperty('background-color');document.body.style.removeProperty('background-color')})()`
        )
        if ((await host.request('layersInspect')).visible)
          await host.request('shellPerform', { action: 'layers' })
        // A passing run leaves the split at fraction 1; expand toggles 0 ⇄ 1.
        for (let i = 0; i < 2 && (await host.request('layoutInspect')).fraction !== 1; i++) {
          await host.request('shellPerform', { action: 'expand' })
          await delay(300)
        }
      }
    },
    {
      name: 'toolbar-address',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkToolbarAddress(host, artifacts)
        await checkToolbarOverflow(host, artifacts)
        await checkToolbarFullScreen(host, artifacts)
      },
      cleanup: async () => {
        await restoreToolbarAddress(host)
      }
    },
    {
      name: 'toggle-ui',
      dependsOn: ['chat-ready'],
      run: () => checkToggleUI(host, artifacts),
      cleanup: async () => {
        await host.request('previewOverlayTest', { action: 'fullscreen', value: false })
        if ((await host.request('layoutInspect')).fraction === 0)
          await host.request('shellPerform', { action: 'expand' })
        await clearComposer()
      }
    },
    {
      name: 'device-frame',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkDeviceFrame(host, artifacts)
        await restoreDeviceFrame(host)
      },
      cleanup: async () => {
        await restoreDeviceFrame(host)
      }
    },
    {
      name: 'selection-input',
      dependsOn: ['open-project'],
      run: async () => {
        await host.request('shellPerform', { action: 'select-object' })
        await wait(() => page(`document.documentElement.style.cursor==='crosshair'`), 'select mode')
        if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1')
          console.log(
            'SKIP real preview pointer gestures/animation timing: TREZI_NATIVE_BACKGROUND_TEST'
          )
        else
          await checkSelectionInput(
            host,
            async (shown) => {
              // The offscreen shell capture does not paint the preview's WebKit overlay: take
              // the foreground window, retrying when ScreenCaptureKit sees the focus move.
              let png: string | undefined
              for (let attempt = 1; !png; attempt++) {
                await preparePreviewInput(host, true)
                try {
                  png = (await host.request('captureVisibleWindow')).png
                } catch (error) {
                  if (attempt === 3) throw error
                }
              }
              writeFileSync(join(artifacts, 'element-toolbar.json'), JSON.stringify(shown, null, 2))
              writeFileSync(join(artifacts, 'element-toolbar.png'), Buffer.from(png, 'base64'))
            },
            async (state) => {
              await preparePreviewInput(host, true)
              const capture = await host.request('captureVisibleWindow')
              writeFileSync(
                join(artifacts, 'selection-lifecycle.json'),
                JSON.stringify(state, null, 2)
              )
              writeFileSync(
                join(artifacts, 'selection-lifecycle.png'),
                Buffer.from(capture.png, 'base64')
              )
            }
          )
        await invoke('preview:set-select-mode', false)
        assert.equal(await page('typeof window.api'), 'undefined')
        await assert.rejects(() =>
          dispatchIPC('preview', {
            type: 'invoke',
            channel: 'source:read',
            args: [fixture, 'index.html:1:0']
          })
        )
      },
      cleanup: async () => {
        await invoke('preview:set-select-mode', false)
        // Inline editing may have left the heading contentEditable or edited; reload it from disk.
        await page('window.reloadSentinel = true')
        host.emit('menu', { action: 'reload' })
        await wait(
          () => page(`!!document.querySelector('#native-title') && !window.reloadSentinel`),
          'fixture reloaded'
        )
      }
    },
    {
      name: 'inspector',
      dependsOn: ['open-project'],
      run: async () => {
        await page(`(() => {
          document.documentElement.style.setProperty('--space-a', '8px');
          document.querySelector('#native-title').style.cssText = 'padding-left:var(--space-a);padding-right:18px;padding-top:6px;padding-bottom:6px;margin-left:auto;margin-right:-4px;margin-top:-2px;margin-bottom:3px';
        })()`)
        // Give the real preview selection the style fixture's source. A synthetic
        // element-picked event races with WebKit's layout-driven selection refresh.
        await page(
          `document.querySelector('#native-title').setAttribute('data-trezi-source','native-style.tsx:1:36')`
        )
        const layers = await invoke('layers:read'),
          heading = layers.nodes.find((n: any) => n.id === 'native-title')
        assert.ok(heading)
        await send('layers:select', {
          path: heading.path,
          fingerprint: { tag: heading.tag, source: heading.source }
        })
        await inspect('inspectorInspect', (s) => !s.visible && s.fields > 2)
        serviceEvents.emit('event', 'preview:toolbar-action', 'props')
        await inspect('inspectorInspect', (s) => s.visible && s.fields > 2)
        serviceEvents.emit('event', 'preview:toolbar-action', 'props')
        await inspect('inspectorInspect', (s) => !s.visible)
        serviceEvents.emit('event', 'preview:toolbar-action', 'props')
        await inspect('inspectorInspect', (s) => s.visible)
        assert.deepEqual(await host.request('webViews'), ['preview'])
        await wait(
          async () => (await invoke('styles:read', ['font-size']))?.values?.['font-size'],
          'preview computed style after selection'
        )
        // Wait for the opened inspector's preview relayout to settle before capturing
        // the generation used by the same native action contract as the UI.
        let inspectorState = await host.request('inspectorInspect')
        for (let i = 0; i < 20; i++) {
          await delay(100)
          const next = await host.request('inspectorInspect')
          if (next.generation === inspectorState.generation) {
            inspectorState = next
            break
          }
          inspectorState = next
        }
        // Visual evidence for the Styles tab's Layout sliders (LKM-115: no tick marks).
        writeFileSync(
          join(artifacts, 'inspector.png'),
          Buffer.from(await host.request('captureShell'), 'base64')
        )
        const styleSource = () => readFileSync(join(fixture, 'native-style.tsx'), 'utf8')
        // `busy` alone cannot say an edit finished: a selection refresh resets it while
        // the write is still in flight. The controller counts finished edits (`edits`,
        // never reset), so wait for that count to move past the one seen before the
        // request, then for the expected source text.
        const performEdit = async (
          field: string,
          value: string,
          landed: (s: string) => boolean
        ) => {
          const seen = (await host.request('inspectorInspect')).edits
          await host.request('inspectorPerform', {
            action: {
              root: fixture,
              generation: inspectorState.generation,
              action: 'apply',
              field,
              value
            }
          })
          try {
            await wait(async () => {
              const state = await host.request('inspectorInspect')
              return state.edits > seen && !state.busy && landed(styleSource())
            }, `${field} edit settled`)
          } catch (error) {
            console.error('Native inspector failure', {
              field,
              seen,
              expected: inspectorState,
              actual: await host.request('inspectorInspect'),
              source: styleSource()
            })
            throw error
          }
        }
        await performEdit('style:opacity', '0.8', (s) => s.includes('0.8'))
        const beforePair = styleSource()
        await performEdit(
          'style:padding-vertical',
          '12',
          (s) => s.includes('paddingTop: "12px"') && s.includes('paddingBottom: "12px"')
        )
        const paired = styleSource()
        for (const untouched of [
          'paddingLeft: "var(--space-a)"',
          'paddingRight: "18px"',
          'marginLeft: "auto"',
          'marginRight: "-4px"',
          'marginTop: "-2px"',
          'marginBottom: "3px"'
        ])
          assert.ok(paired.includes(untouched), `pair kept ${untouched}`)
        const undone = await invoke('edit:undo', fixture)
        assert.ok(undone.ok, 'one ledger Undo reverts the pair')
        try {
          await wait(() => styleSource() === beforePair, 'one Undo restores both vertical sides')
        } catch (error) {
          console.error('Native inspector Undo mismatch', {
            beforePair,
            paired,
            after: styleSource(),
            undone,
            generation: inspectorState.generation,
            actual: await host.request('inspectorInspect')
          })
          throw error
        }
        // Source writes live-reload the page, possibly after the write returns; a late
        // reload would wipe the next injected fixture, so let it land first. An apply and its
        // Undo can each reload, the second one well after the first: after the first reload,
        // require a quiet window (a fresh sentinel survives 1.2 s) before returning.
        const settleLiveReload = async () => {
          await page('window.reloadSentinel = true')
          for (let i = 0; i < 30; i++) {
            await delay(100)
            const pending = await page('!!window.reloadSentinel').catch(() => false)
            if (!pending) break
          }
          for (let quiet = 0; quiet < 8; quiet++) {
            await wait(
              () =>
                page(
                  `document.readyState === 'complete' && !!document.querySelector('#native-title')`
                ).catch(() => false),
              'live reload loaded'
            )
            await page('window.reloadSentinel = true')
            await delay(1200)
            const reloaded = await page('!window.reloadSentinel').catch(() => true)
            if (!reloaded) break
          }
          await page('window.reloadSentinel = false').catch(() => {})
          await wait(
            () =>
              page(
                `document.readyState === 'complete' && !!document.querySelector('#native-title') && !window.reloadSentinel`
              ).catch(() => false),
            'live reload settled'
          )
        }
        await settleLiveReload()
        // Real CSSOM cascade evidence for the new layout controls. The active
        // media rule wins; the inactive one must not be reported as authored.
        await page(`(() => {
          const style = document.createElement('style');
          style.id = 'native-layout-css';
          style.setAttribute('data-vite-dev-id', 'native-layout.css');
          style.textContent = ${JSON.stringify(layoutCss)};
          document.head.append(style);
          const layout = document.createElement('div');
          layout.id = 'native-layout';
          layout.className = 'native-layout';
          layout.setAttribute('data-trezi-source', 'index.html:3:1');
          layout.textContent = 'Layout fixture';
          document.body.append(layout);
        })()`)
        const layoutNodes = await invoke('layers:read')
        const layoutNode = layoutNodes.nodes.find((n: any) => n.id === 'native-layout')
        assert.ok(layoutNode, 'layout fixture is selectable')
        await send('layers:select', {
          path: layoutNode.path,
          fingerprint: { tag: layoutNode.tag, source: layoutNode.source }
        })
        const layoutState = await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.values?.['style:row-gap'] === '1rem' && state
        }, 'native layout fields use the winning media rule')
        assert.equal(layoutState.values['style:column-gap'], 'calc(1px + 2rem)')
        assert.equal(layoutState.values['style:flex-direction'], 'column')
        assert.equal(layoutState.values['style:flex-wrap'], 'wrap')
        assert.equal(layoutState.values['style:justify-content'], 'space-between')
        assert.equal(layoutState.values['style:align-items'], 'center')
        assert.equal(layoutState.values['style:align-content'], 'normal')
        assert.equal(layoutState.disabled['style:row-gap'], true, 'responsive source is read-only')
        const layoutRead = inspector.styles
        assert.ok(layoutRead, 'inspector retains the winning layout declarations')
        assert.equal(layoutRead.specified['row-gap'], '1rem')
        assert.equal(layoutRead.origins?.['row-gap'].conditional, true)
        // An unlayered rule beats a layered one of equal specificity, so the layered
        // `column-gap: 3px` / `row-gap: 77px` must not be reported as the winner.
        assert.equal(layoutRead.specified['column-gap'], 'calc(1px + 2rem)')
        assert.equal(layoutRead.origins?.['column-gap'].layer, undefined)
        assert.equal(layoutRead.specified['align-items'], 'center')
        assert.equal(layoutRead.origins?.['align-items'].important, true)
        const conditionalSource = readFileSync(join(fixture, 'native-layout.css'), 'utf8')
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: layoutState.generation,
            action: 'apply',
            field: 'style:row-gap',
            value: '24px'
          }
        })
        assert.equal(readFileSync(join(fixture, 'native-layout.css'), 'utf8'), conditionalSource)
        writeFileSync(
          join(artifacts, 'inspector-layout.png'),
          Buffer.from(await host.request('captureShell'), 'base64')
        )
        await page(`(() => {
          document.querySelector('#native-layout')?.remove();
          document.querySelector('#native-layout-css')?.remove();
          const style = document.createElement('style');
          style.id = 'native-module-css';
          style.setAttribute('data-vite-dev-id', 'native-layout.module.css');
          style.textContent = '._layoutCard_abcde_1 { display:grid; row-gap:8px; column-gap:16px; }';
          document.head.append(style);
          const card = document.createElement('div');
          card.id = 'native-module-card';
          card.className = '_layoutCard_abcde_1';
          card.textContent = 'CSS Module fixture';
          document.body.append(card);
        })()`)
        const moduleNodes = await invoke('layers:read')
        const moduleNode = moduleNodes.nodes.find((n: any) => n.id === 'native-module-card')
        assert.ok(moduleNode, 'CSS Module fixture is selectable')
        await send('layers:select', {
          path: moduleNode.path,
          fingerprint: { tag: moduleNode.tag, source: moduleNode.source }
        })
        const moduleState = await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.values?.['style:row-gap'] === '8px' && state
        }, 'CSS Module gap fields')
        assert.equal(
          moduleState.disabled['style:row-gap'],
          false,
          'exact CSS Module rule is editable'
        )
        const moduleSource = () => readFileSync(join(fixture, 'native-layout.module.css'), 'utf8')
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: moduleState.generation,
            action: 'preview',
            field: 'style:row-gap',
            value: '12px'
          }
        })
        await wait(
          () =>
            page(
              `getComputedStyle(document.querySelector('#native-module-card')).rowGap === '12px'`
            ),
          'CSS Module gap previews live'
        )
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: moduleState.generation,
            action: 'cancel-preview',
            field: 'style:row-gap'
          }
        })
        const moduleEdits = moduleState.edits
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: moduleState.generation,
            action: 'apply',
            field: 'style:row-gap',
            value: '12px'
          }
        })
        await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.edits > moduleEdits && moduleSource().includes('row-gap: 12px')
        }, 'CSS Module source edit persisted')
        assert.ok((await invoke('edit:undo', fixture)).ok, 'CSS Module edit has Undo')
        await wait(() => moduleSource().includes('row-gap: 8px'), 'CSS Module Undo restores source')
        await settleLiveReload()
        await page(`(() => {
          document.querySelector('#native-module-card')?.remove();
          document.querySelector('#native-module-css')?.remove();
          const style = document.createElement('style');
          style.id = 'native-utility-css';
          // Tailwind v4 emits every utility inside an @layer utilities block.
          style.textContent = '@layer utilities { .flex { display:flex } .gap-4 { gap:1rem } }';
          document.head.append(style);
          const card = document.createElement('div');
          card.id = 'native-utility-card';
          card.className = 'flex gap-4';
          card.setAttribute('data-trezi-source', 'native-layout.tsx:1');
          card.textContent = 'Utility fixture';
          document.body.append(card);
        })()`)
        const utilityNodes = await invoke('layers:read')
        const utilityNode = utilityNodes.nodes.find((n: any) => n.id === 'native-utility-card')
        assert.ok(utilityNode, 'utility fixture is selectable')
        await send('layers:select', {
          path: utilityNode.path,
          fingerprint: { tag: utilityNode.tag, source: utilityNode.source }
        })
        const utilityState = await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.values?.['style:gap'] === '1rem' && state
        }, 'utility gap is authored')
        assert.equal(utilityState.disabled['style:gap'], false)
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: utilityState.generation,
            action: 'preview',
            field: 'style:gap',
            value: '24px'
          }
        })
        await wait(
          () =>
            page(`getComputedStyle(document.querySelector('#native-utility-card')).gap === '24px'`),
          'utility gap previews live'
        )
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: utilityState.generation,
            action: 'cancel-preview',
            field: 'style:gap'
          }
        })
        const utilitySource = () => readFileSync(join(fixture, 'native-layout.tsx'), 'utf8')
        const utilityEdits = utilityState.edits
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: utilityState.generation,
            action: 'apply',
            field: 'style:gap',
            value: '24px'
          }
        })
        await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.edits > utilityEdits && utilitySource().includes('gap-6')
        }, 'utility class rewrite persisted')
        assert.ok((await invoke('edit:undo', fixture)).ok, 'utility edit has Undo')
        await wait(() => utilitySource().includes('gap-4'), 'utility Undo restores source')
        await settleLiveReload()
        await page(`(() => {
          document.querySelector('#native-utility-card')?.remove();
          document.querySelector('#native-utility-css')?.remove();
          const style = document.createElement('style');
          style.id = 'native-plain-css';
          style.setAttribute('data-vite-dev-id', 'native-plain.css');
          style.textContent = '.plainLayout { display:flex; gap:8px; }';
          document.head.append(style);
          const card = document.createElement('div');
          card.id = 'native-plain-card';
          card.className = 'plainLayout';
          card.textContent = 'Plain CSS fixture';
          document.body.append(card);
        })()`)
        const plainNodes = await invoke('layers:read')
        const plainNode = plainNodes.nodes.find((n: any) => n.id === 'native-plain-card')
        assert.ok(plainNode, 'plain CSS fixture is selectable')
        await send('layers:select', {
          path: plainNode.path,
          fingerprint: { tag: plainNode.tag, source: plainNode.source }
        })
        const plainState = await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.values?.['style:gap'] === '8px' && state
        }, 'plain CSS gap is authored')
        assert.equal(plainState.disabled['style:gap'], false)
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: plainState.generation,
            action: 'preview',
            field: 'style:gap',
            value: '12px'
          }
        })
        await wait(
          () =>
            page(`getComputedStyle(document.querySelector('#native-plain-card')).gap === '12px'`),
          'plain CSS gap previews live'
        )
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: plainState.generation,
            action: 'cancel-preview',
            field: 'style:gap'
          }
        })
        const plainSource = () => readFileSync(join(fixture, 'native-plain.css'), 'utf8')
        const plainEdits = plainState.edits
        await host.request('inspectorPerform', {
          action: {
            root: fixture,
            generation: plainState.generation,
            action: 'apply',
            field: 'style:gap',
            value: '12px'
          }
        })
        await wait(async () => {
          const state = await host.request('inspectorInspect')
          return state.edits > plainEdits && plainSource().includes('gap:12px')
        }, 'plain CSS source edit persisted')
        assert.ok((await invoke('edit:undo', fixture)).ok, 'plain CSS edit has Undo')
        await wait(() => plainSource().includes('gap:8px'), 'plain CSS Undo restores source')
        await host.request('inspectorPerform', {
          action: { root: fixture, generation: plainState.generation, action: 'close' }
        })
        await inspect('inspectorInspect', (s) => !s.visible)
        await page(`(() => {
          document.querySelector('#native-plain-card')?.remove();
          document.querySelector('#native-plain-css')?.remove();
        })()`)
        await checkInspectorIsland(
          host,
          artifacts,
          () => serviceEvents.emit('event', 'preview:toolbar-action', 'props'),
          () => preference('trezi:native-panel-sizes'),
          {
            evaluate: page,
            source: () => readFileSync(join(fixture, 'native-style.tsx'), 'utf8'),
            styles: (prop) => invoke('styles:read', [prop]),
            select: async () => {
              // Source edits live-reload the page, which drops the stamp set above.
              await page(`(() => {
                document.documentElement.style.setProperty('--space-a', '8px');
                document.querySelector('#native-title').style.cssText = 'padding-left:var(--space-a);padding-right:18px;padding-top:6px;padding-bottom:6px;margin-left:auto;margin-right:-4px;margin-top:-2px;margin-bottom:3px';
              })()`)
              await page(
                `document.querySelector('#native-title').setAttribute('data-trezi-source','native-style.tsx:1:36')`
              )
              const layers = await invoke('layers:read'),
                heading = layers.nodes.find((n: any) => n.id === 'native-title')
              assert.ok(heading)
              await send('layers:select', {
                path: heading.path,
                fingerprint: { tag: heading.tag, source: heading.source }
              })
            },
            selectMode: (on) => invoke('preview:set-select-mode', on)
          }
        )
      },
      cleanup: async () => {
        const state = await host.request('inspectorInspect')
        if (state.visible)
          await host.request('inspectorPerform', {
            action: { root: fixture, generation: state.generation, action: 'close' }
          })
      }
    },
    {
      name: 'inspector-custom',
      dependsOn: ['open-project'],
      run: async () => {
        await checkInspectorCustom(customSmoke)
        // The runner's cleanup only runs after a failure: a pass closes the island itself.
        await restoreInspectorCustom(customSmoke)
      },
      cleanup: () => restoreInspectorCustom(customSmoke)
    },
    {
      name: 'select-off',
      dependsOn: ['open-project'],
      run: async () => {
        await checkSelectOff(host, artifacts, inspector)
        await restoreSelectOff(host)
      },
      cleanup: () => restoreSelectOff(host)
    },
    {
      name: 'layers-island',
      dependsOn: ['open-project'],
      run: async () => {
        layersOriginal = readFileSync(join(fixture, 'index.html'), 'utf8')
        // `inspector` re-stamps the heading as native-style.tsx and nothing reloads the page after
        // it; a move across two files goes to the agent and writes nothing. Start from the
        // fixture's own stamp.
        await page(
          `document.querySelector('#native-title').setAttribute('data-trezi-source','index.html:3:1')`
        )
        layersWindow = (await host.request('inspectorIsland')).window
        await checkLayersIsland(host, artifacts, layersSmoke)
      },
      cleanup: async () => {
        if (layersOriginal)
          await restoreLayersIsland(host, layersSmoke, layersOriginal, layersWindow)
      }
    },
    {
      name: 'movable-islands',
      dependsOn: ['open-project'],
      run: async () => {
        islandsWindow = (await host.request('inspectorIsland')).window
        await checkMovableIslands(host, artifacts, layersSmoke)
      },
      cleanup: async () => {
        if (islandsWindow) await restoreMovableIslands(host, layersSmoke, islandsWindow)
      }
    },
    {
      name: 'preview-overlay',
      dependsOn: ['open-project'],
      run: () => checkPreviewOverlay(host, fixture, artifacts, preference),
      cleanup: () => restorePreviewOverlay(host)
    },
    {
      name: 'text-edit',
      dependsOn: ['open-project'],
      run: async () => {
        await checkLegacyProject(fixture, invoke, page, wait)
        const edited = await invoke('text:apply', fixture, {
          source: 'index.html:3:1',
          text: 'Edited through Trezi Native'
        })
        assert.ok(edited.applied)
        await wait(
          () =>
            page(
              `document.querySelector('#native-title')?.textContent==='Edited through Trezi Native'`
            ),
          'managed reload'
        )
        assert.ok((await invoke('edit:undo', fixture)).ok)
        assert.ok((await invoke('edit:redo', fixture)).ok)
      }
    },
    {
      name: 'editor-freshness',
      dependsOn: ['open-project'],
      run: async () => {
        freshnessURL = String(await page('location.href'))
        await checkEditorFreshness(host, artifacts, freshnessSmoke)
        // The runner's cleanup only runs after a failure: a pass leaves the page itself.
        await restoreEditorFreshness(host, freshnessSmoke, freshnessURL)
      },
      cleanup: () => restoreEditorFreshness(host, freshnessSmoke, freshnessURL)
    },
    {
      name: 'chat-drafts',
      dependsOn: ['chat-ready'],
      run: async () => {
        await host.request('composerPerform', { text: 'Native draft' })
        await inspect('composerInspect', (s) => s.text === 'Native draft')
        firstChat = nativeChat.active
        host.emit('shell-action', { action: 'new-chat', project: nativeWorkspace.state.activeKey })
        await wait(() => nativeChat.active !== firstChat, 'new chat')
        await inspect('composerInspect', (s) => s.text === '')
        await nativeWorkspace.command({
          type: 'chat',
          key: nativeWorkspace.state.activeKey!,
          session: firstChat
        })
        await inspect('composerInspect', (s) => s.text === 'Native draft')
        nativeChat.event({
          type: 'commands',
          projectKey: firstChat,
          commands: [
            { name: 'native-fixture', description: 'Native keyboard test', source: 'project' }
          ]
        })
        await host.request('composerPerform', { text: '/native' })
        await inspect('composerInspect', (s) => s.skillListVisible && s.skillCount > 0)
        await host.request('composerPerform', { key: 'Tab' })
        await inspect('composerInspect', (s) => s.text === '/native-fixture ')
        await host.request('composerPerform', { text: '' })
      },
      cleanup: async () => {
        if (firstChat && nativeChat.active !== firstChat && nativeWorkspace.state.activeKey)
          await nativeWorkspace.command({
            type: 'chat',
            key: nativeWorkspace.state.activeKey,
            session: firstChat
          })
        await clearComposer()
      }
    },
    {
      name: 'source-editor',
      dependsOn: ['open-project'],
      run: async () => {
        await geometry('before popout')
        await invoke('source:popout', fixture, 'index.html:3:1')
        await inspect('sourceInspect', (s) => s.popped && s.source === 'index.html')
        await checkSourceEditor(host, fixture, artifacts, inspect)
        await host.request('sourcePerform', { action: { root: fixture, action: 'hide' } })
        await inspect('sourceInspect', (s) => !s.visible)
        await geometry('after docking')
      },
      cleanup: async () => {
        if ((await host.request('sourceInspect')).popped)
          await host.request('sourcePerform', { action: { root: fixture, action: 'dock' } })
        if ((await host.request('sourceInspect')).visible)
          await host.request('sourcePerform', { action: { root: fixture, action: 'hide' } })
      }
    },
    {
      name: 'source-syntax',
      dependsOn: ['open-project'],
      run: () => checkSourceSyntax(host, fixture, artifacts),
      cleanup: () => restoreSourceSyntax(host, fixture)
    },
    {
      name: 'source-wrap',
      dependsOn: ['open-project'],
      run: () => checkSourceWrap(host, fixture, artifacts),
      cleanup: () => restoreSourceWrap(host, fixture)
    },
    {
      name: 'changes-panel',
      dependsOn: ['open-project'],
      run: () => checkChangesPanel(host, fixture, artifacts),
      cleanup: () => restoreChangesPanel(host, fixture)
    },
    {
      name: 'visible-composer',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkVisibleComposer(host, fixture, artifacts)
      },
      cleanup: async () => {
        await clearComposer()
      }
    },
    {
      name: 'composer-send',
      dependsOn: ['chat-ready'],
      run: () => checkComposerSend(host),
      cleanup: clearComposer
    },
    {
      name: 'start-composer',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkStartComposer(host, fixture, artifacts)
        // The runner's cleanup only runs after a failure: its sends stub must not outlive a pass.
        await restoreStartComposer(host)
      },
      cleanup: async () => {
        await restoreStartComposer(host)
        await clearComposer()
      }
    },
    {
      name: 'native-chat',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkNativeChat(host, join(artifacts, 'swift-chat.png'))
      }
    },
    {
      name: 'sidebar-status',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkSidebarStatus(host, artifacts)
      },
      cleanup: () => restoreSidebarStatus()
    },
    {
      name: 'sidebar-chats',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkSidebarChats(host, artifacts)
      },
      cleanup: () => restoreSidebarChats(host)
    },
    {
      name: 'sent-attachments',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkSentAttachments(host, artifacts)
      },
      cleanup: async () => {
        await host.request('chatAttachmentPreview', { attachment: null })
        await clearComposer()
      }
    },
    {
      name: 'comment-rows',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkCommentRows(host, artifacts)
      }
    },
    {
      name: 'incident-row',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkIncidentRow(host, artifacts)
      }
    },
    {
      name: 'landing-check',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkLandingChecks(host, artifacts)
      }
    },
    {
      name: 'agent-question',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkAgentQuestion(host, context, artifacts)
      }
    },
    {
      name: 'chat-text',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkChatText(host, artifacts)
      }
    },
    {
      name: 'chat-ui',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkChatUi(host, artifacts)
      }
    },
    {
      name: 'code-link-click',
      dependsOn: ['chat-ready'],
      run: () => checkCodeLinkClick(host, fixture, artifacts),
      cleanup: () => restoreCodeLinkClick(host, fixture)
    },
    // After the checks that read message frames: its long replies stay in the shared chat.
    {
      name: 'parallel-stream',
      dependsOn: ['chat-ready'],
      run: () => checkParallelStream(host, artifacts),
      cleanup: () => restoreParallelStream(host)
    },
    {
      name: 'quit-alert',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkQuitAlert(host, artifacts, preference)
      }
    },
    {
      name: 'preview-inspector',
      dependsOn: ['open-project'],
      run: async () => {
        await host.request('previewInspector', { action: 'show' })
        await inspect('previewInspector', (s) => s.visible && s.inspectable)
        await host.request('previewInspector', { action: 'close' })
        await checkPreviewInspector(host, artifacts, () =>
          serviceEvents.emit('event', 'preview:toolbar-action', 'props')
        )
      },
      cleanup: async () => {
        await host.request('previewInspector', { action: 'close' })
      }
    },
    {
      name: 'agent-preview',
      dependsOn: ['open-project'],
      run: async () => {
        await checkAgentPreview(page, artifacts)
      },
      cleanup: async () => {
        await restoreAgentPreview(page)
      }
    },
    {
      name: 'agent-interact',
      dependsOn: ['open-project'],
      run: async () => {
        await checkAgentInteract(page, artifacts)
      }
    },
    {
      name: 'agent-runtime',
      dependsOn: ['open-project'],
      run: async () => {
        await checkAgentRuntime(host, page, artifacts)
      }
    },
    {
      name: 'agent-navigation',
      dependsOn: ['open-project'],
      run: async () => {
        await checkAgentNavigation(artifacts)
      }
    },
    {
      name: 'agent-verify',
      dependsOn: ['open-project'],
      run: async () => {
        await checkAgentVerify(page, artifacts)
      }
    },
    {
      name: 'managed-agent-browser',
      dependsOn: ['open-project'],
      run: async () => {
        await checkManagedAgentBrowser(host, page, artifacts)
      }
    },
    {
      name: 'agent-integration',
      dependsOn: ['open-project'],
      run: () => checkAgentIntegration(host, fixture, artifacts, firstProject),
      cleanup: () => restoreAgentIntegration(host, firstProject)
    },
    {
      name: 'preview-timing',
      dependsOn: ['open-project'],
      run: async () => {
        await checkPreviewTiming(page, artifacts)
      },
      cleanup: restorePreviewTiming
    },
    {
      name: 'preview-speed',
      dependsOn: ['open-project'],
      run: async () => {
        await checkPreviewSpeed(host, page, fixture, artifacts)
      },
      cleanup: async () => {
        await restorePreviewSpeed(page)
      }
    },
    {
      name: 'preview-history',
      dependsOn: ['open-project'],
      run: async () => {
        historyURL = String(await page('location.href'))
        await checkPreviewHistory(host, page, invoke, historyURL, artifacts)
      },
      cleanup: async () => {
        await restorePreviewHistory(page, invoke, historyURL)
      }
    },
    {
      name: 'toolbar-more',
      dependsOn: ['open-project'],
      run: async () => {
        await checkToolbarMore(host, page)
      }
    },
    {
      name: 'three-d',
      dependsOn: ['open-project'],
      run: () => checkThreeD(host, artifacts, fixture),
      cleanup: async () => {
        if ((await host.request('threeDInspect')).active)
          await host.request('threeDPerform', { action: 'close' })
        await page(removeThreeDCard)
        if ((await host.request('sourceInspect')).popped)
          await host.request('sourcePerform', { action: { root: fixture, action: 'dock' } })
        if ((await host.request('sourceInspect')).visible)
          await host.request('sourcePerform', { action: { root: fixture, action: 'hide' } })
      }
    },
    {
      name: 'git-updates',
      dependsOn: ['chat-ready'],
      run: () => checkGitUpdates(host, git, artifacts),
      cleanup: async () => {
        if ((await host.request('sheetInspect')).visible)
          await host.request('sheetPerform', { action: 'cancel' })
      }
    },
    {
      name: 'publish-progress',
      dependsOn: ['chat-ready'],
      run: async () => {
        await checkPublishProgress(host, git, artifacts)
      },
      cleanup: async () => {
        if ((await host.request('sheetInspect')).visible)
          await host.request('sheetPerform', { action: 'cancel' })
      }
    },
    {
      name: 'swift-preview',
      dependsOn: ['open-project'],
      run: () => checkSwiftPreview(host, fixture, root, artifacts, firstProject),
      cleanup: () => restoreSwiftPreview(host, firstProject)
    },
    {
      name: 'swift-graph',
      dependsOn: ['open-project'],
      run: () => checkSwiftGraph(host, invoke, fixture, root, artifacts, firstProject),
      cleanup: () => restoreSwiftGraph(host, firstProject)
    },
    {
      name: 'swift-build',
      dependsOn: ['open-project'],
      run: () => checkSwiftBuild(host, invoke, fixture, root, artifacts, firstProject),
      cleanup: () => restoreSwiftBuild(host, firstProject)
    },
    {
      name: 'swift-macros',
      dependsOn: ['open-project'],
      run: () => checkSwiftMacros(host, invoke, fixture, root, artifacts, firstProject),
      cleanup: () => restoreSwiftMacros(host, firstProject)
    },
    {
      name: 'scraib-xcode',
      dependsOn: ['open-project'],
      run: () => checkScraibXcode(host, invoke, fixture, root, artifacts, firstProject),
      cleanup: () => restoreScraibXcode(host, firstProject)
    },
    {
      name: 'scraib-open',
      dependsOn: ['open-project'],
      run: () => checkScraibOpen(host, invoke, fixture, root, artifacts),
      cleanup: () => restoreScraibOpen(host, firstProject)
    },
    {
      name: 'final-shell',
      run: async () => {
        writeFileSync(
          join(artifacts, 'shell.png'),
          Buffer.from(await host.request('captureShell'), 'base64')
        )
        assert.deepEqual(await host.request('webViews'), ['preview'])
      }
    }
  ]
  if (process.argv.includes('--live'))
    checks.push({
      name: 'live-provider',
      dependsOn: ['chat-ready', 'text-edit'],
      run: async () => {
        const provider = process.env.TREZI_NATIVE_TEST_PROVIDER || 'claude'
        if (!['claude', 'codex'].includes(provider)) throw new Error('Unsupported live provider')
        const options = {
          provider,
          permissionMode: 'bypassPermissions',
          ...(provider === 'claude' ? { model: 'haiku' } : {})
        }
        const restarted = await invoke('agent:restart-chat', fixture, nativeChat.active, options)
        assert.ok(restarted.ok)
        let done = false,
          error = ''
        const listener = (channel: string, e: any) => {
          if (channel === 'agent:event' && e.projectKey === nativeChat.active) {
            if (e.type === 'done') done = true
            if (e.type === 'error') {
              error = e.message
              done = true
            }
          }
        }
        serviceEvents.on('event', listener)
        try {
          await host.request('composerPerform', {
            text: 'Edit index.html. Replace the heading text "Edited through Trezi Native" with "NATIVE_AGENT_VERIFIED". Make the edit now.'
          })
          await inspect('composerInspect', (s) => s.enabled)
          await host.request('composerPerform', { action: 'send' })
          await wait(() => done, 'live provider', 180000)
          assert.equal(error, '')
          await wait(
            () =>
              readFileSync(join(fixture, 'index.html'), 'utf8').includes('NATIVE_AGENT_VERIFIED'),
            'live file edit',
            30000
          )
        } finally {
          serviceEvents.off('event', listener)
        }
      }
    })
  let hostClosed = false
  void host.closed.then(() => {
    hostClosed = true
  })
  // `--only` filters which named checks run; failure collection is unchanged.
  const results = await runSmokeChecks(selectSmokeChecks(checks, parseSmokeGroups(process.argv)), {
    capture: (name) => captureSmokeFailure(host, artifacts, name),
    restore: () => restoreSmokeState(host, firstProject),
    deadline: Number(process.env.TREZI_NATIVE_SMOKE_DEADLINE_MS) || undefined,
    inject: parseInjectedFailures(process.env.TREZI_NATIVE_SMOKE_FAIL),
    halted: () => (hostClosed ? 'native host (it exited)' : undefined),
    ...smokeFocusHooks(host)
  })
  console.log(formatSmokeSummary(results))
  const failures = results.filter((r) => r.outcome === 'fail')
  const lines = formatFailureReport(failures)
  if (lines.length) console.log(lines.join('\n'))
  const failed = results.filter((r) => r.outcome !== 'pass')
  if (failed.length)
    throw new SmokeRunFailure(
      `Native smoke: ${failed.length} of ${results.length} checks did not pass (${failed.map((r) => r.name).join(', ')})`,
      lines,
      // Skips follow a failure or a host exit, which the launcher reports itself.
      failures.length ? smokeExitCode(failures) : SMOKE_EXIT_PRODUCT
    )
  console.log(
    'NATIVE CORE PASS — no React/main/panel/editor WebViews; workspace, sheets, layout, native editing, streams and preview isolation.'
  )
}
