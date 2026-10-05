import { inspectUntil, waitFor } from './smoke-wait'
import { checkVisibleComposer } from './smoke-composer'
import { checkSourceStamps } from './smoke-source-stamp'
import { checkLegacyProject } from './smoke-legacy-project'
import { checkSourceEditor } from './smoke-source-editor'
import { checkChatIslands } from './smoke-islands'
import { checkInspectorIsland } from './smoke-inspector-island'
import { checkPreviewInspector } from './smoke-preview-inspector'
import { checkAgentPreview, restoreAgentPreview } from './smoke-agent-preview'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { dispatchIPC, serviceEvents } from './platform'
import { nativeWorkspace } from './workspace-runtime'
import { nativeChat } from './chat-runtime'
import { checkProjectSwitching } from './smoke-projects'
import { captureChatGate, checkChatGate, restoreChatGate } from './smoke-chat-gate'
import { checkNativeSheets } from './smoke-sheets'
import { checkSecuritySession } from './smoke-session'
import { checkNativeChat } from './smoke-chat'
import { checkSelectionInput, preparePreviewInput } from './smoke-input'
import { checkToolbarAddress, restoreToolbarAddress } from './smoke-toolbar'
import { formatSmokeSummary, parseInjectedFailures, runSmokeChecks, type SmokeCheck } from './smoke-runner'
import { captureSmokeFailure, restoreSmokeState } from './smoke-restore'
import { parseSmokeGroups, selectSmokeChecks } from './smoke-groups'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))
/** Named checks run by smoke-runner: a failure no longer stops the run. `dependsOn`
 *  lists the checks whose app/window state a check builds on; an independent check
 *  still runs after a failure (the restore hook resets the foreground first). */
export async function runNativeCoreSmoke(host: NativeBridge, fixture: string, root: string, preference: (key: string) => string | null) {
  const invoke = (channel: string, ...args: any[]) => dispatchIPC('main',{type:'invoke',channel,args})
  const send = (channel: string, ...args: any[]) => dispatchIPC('main',{type:'send',channel,args})
  const page = (code: string) => host.request('evaluate',{view:'preview',code})
  // Timeouts report the last inspected state (composer waits add the Bun-side
  // chat inputs to `enabled`/attachments/text), not just the predicate's `false`.
  const chatContext = () => { const chat = nativeChat.get(nativeChat.active); return { ready: chat?.ready, switching: chat?.switching, running: chat?.isRunning, textLength: chat?.text?.length, attachments: chat?.attachments?.length } }
  const wait = (check: () => Promise<any> | any, label: string, timeout=10000) => waitFor(check, label, timeout)
  const inspect = (method: string, check: (s:any)=>boolean) => inspectUntil(m => host.request(m), method, check, method === 'composerInspect' ? chatContext : undefined)
  const geometry = async (stage: string) => { const value = await host.request('layoutInspect'); console.log('Native geometry', stage, JSON.stringify(value)); assert.ok(value.windowHeight >= 550 && value.canvasHeight >= 450, `Collapsed workspace at ${stage}`) }
  const artifacts=join(root,'test/artifacts/native');mkdirSync(artifacts,{recursive:true})
  writeFileSync(join(fixture,'native-style.tsx'), 'export function Fixture() { return <h1 style={{ opacity: 1 }}>Hello</h1> }')
  let firstProject = '', originalURL = '', firstChat = ''
  const clearComposer = async () => {
    await host.request('composerPerform', { text: '' })
    for (let i = 0; i < 10 && (await host.request('composerInspect')).attachments.length; i++) await host.request('composerPerform', { remove: 0 })
  }
  const checks: SmokeCheck[] = [
    { name: 'startup', run: async () => {
      await geometry('startup')
      assert.deepEqual(await host.request('webViews'),['preview'])
      const welcome=await host.request('welcomeInspect');assert.ok(welcome.visible&&welcome.catFrames>=10)
      await captureChatGate(host, artifacts, 'no-project', false)
      writeFileSync(join(artifacts,'welcome.png'),Buffer.from(await host.request('captureShell'),'base64'))
      // No gear in the sidebar: Settings opens from Trezi → Settings… (Command-,), even with no project.
      assert.deepEqual((await host.request('shellInspect')).sidebarActions,['new-project','open-project'])
      assert.deepEqual(await host.request('settingsMenu'),{menu:'Trezi',title:'Settings…',key:',',command:true,enabled:true})
      await host.request('settingsMenu',{perform:true})
      await inspect('sheetInspect',s=>s.visible&&s.title==='Settings'&&s.section==='general'&&s.fields.includes('default'))
      assert.equal(nativeWorkspace.state.activeKey ?? null,null,'Settings opened without a project')
      await delay(250)
      writeFileSync(join(artifacts,'settings-no-project.png'),Buffer.from(await host.request('captureSheet'),'base64'))
      await host.request('sheetPerform',{action:'closeWindow'})
      await inspect('sheetInspect',s=>!s.visible)
    } },
    { name: 'open-project', run: async () => {
      await host.request('shellPerform',{action:'open-project'})
      await wait(()=>nativeWorkspace.state.status.kind==='running','project running',30000)
      await wait(()=>page('!!document.querySelector("#native-title")'),'fixture loaded')
      firstProject = nativeWorkspace.state.activeKey ?? ''
    } },
    { name: 'mobile-viewport', dependsOn: ['open-project'], run: async () => {
      await host.request('shellPerform', { action: 'device' })
      await wait(() => page(`getComputedStyle(document.documentElement).scrollbarWidth === 'none'`), 'mobile scrollbars hidden')
      assert.equal(await page(`!!document.querySelector('[data-trezi-frame]')`), false, 'Native mobile must not inject a second phone frame')
      await page(`(() => {
        const scroller = document.createElement('div'); scroller.id = 'scrollbar-check';
        scroller.style.cssText = 'height:60px;overflow:scroll';
        scroller.innerHTML = '<div style="height:400px">Scrollable fixture</div>';
        document.body.append(scroller); scroller.scrollTop = 80;
      })()`)
      assert.equal(await page(`getComputedStyle(document.querySelector('#scrollbar-check')).scrollbarWidth`), 'none')
      assert.equal(await page(`document.querySelector('#scrollbar-check').scrollTop`), 80, 'Hiding scrollbars preserves scrolling')
      writeFileSync(join(artifacts, 'mobile-scrollbars.png'), Buffer.from(await host.request('captureShell'), 'base64'))
      // Reload must use WebKit's current document, including History API navigation.
      originalURL = await page('location.href')
      const route = new URL('/about.html?tab=details#section', originalURL).href
      await page(`(() => { history.pushState({}, '', ${JSON.stringify(route)}); window.reloadSentinel = true; return true })()`)
      host.emit('menu', { action: 'reload' })
      await wait(()=>page('!!document.querySelector("#native-title") && !window.reloadSentinel'),'reload completes')
      assert.equal(await page('location.href'), route, 'Reload preserves the current path, query and fragment')
      // Restore the actual document, not just its History API URL, before later
      // fixtures edit index.html and depend on its live-reload connection.
      await page(`(() => { window.reloadSentinel = true; location.href = ${JSON.stringify(originalURL)}; return true })()`)
      await wait(() => page(`location.href === ${JSON.stringify(originalURL)} && !!document.querySelector('#native-title') && !window.reloadSentinel`), 'original fixture restored')
      console.log('Native reload preserves History API route, query and fragment.')
      await wait(() => page(`getComputedStyle(document.documentElement).scrollbarWidth === 'none'`), 'mobile scrollbar policy restored after navigation')
      await host.request('shellPerform', { action: 'device' })
      await wait(() => page(`!document.querySelector('[data-trezi-frame-style]')`), 'desktop scrollbar policy restored')
      console.log('Native mobile hides document/nested scrollbars, preserves scrolling and survives navigation.')
    }, cleanup: async () => {
      if (nativeWorkspace.active?.viewport === 'mobile') await host.request('shellPerform', { action: 'device' })
      if (originalURL && await page('location.href') !== originalURL) {
        await page(`(() => { location.href = ${JSON.stringify(originalURL)}; return true })()`)
        await wait(() => page(`location.href === ${JSON.stringify(originalURL)} && !!document.querySelector('#native-title')`), 'original fixture restored')
      }
    } },
    { name: 'chat-ready', dependsOn: ['open-project'], run: async () => {
      await wait(()=>nativeChat.chats.get(nativeChat.active)?.ready,'native chat ready',30000)
    } },
    { name: 'source-stamps', dependsOn: ['open-project'], run: async () => {
      await checkSourceStamps(page)
    } },
    { name: 'chat-islands', dependsOn: ['chat-ready'], run: async () => {
      await checkChatIslands(host, fixture, artifacts)
    } },
    { name: 'composer', dependsOn: ['chat-ready'], run: async () => {
      await inspect('composerInspect', s => s.welcomedChat)
      writeFileSync(join(artifacts,'composer-ready-beam.png'),Buffer.from(await host.request('captureComposer'),'base64'))
      await inspect('composerInspect', s => !s.readyBeam)
      assert.deepEqual(await host.request('composerIMECheck'), { marked: true, swallowed: false })
      await host.request('composerPerform', { text: '' })
      await inspect('composerInspect', s => s.text === '')
      const compactComposer = await host.request('composerInspect')
      const bottom = compactComposer.bounds.y + compactComposer.bounds.height
      // The shared bottom row leaves more text space in the minimum-height form.
      // Nine lines exercise >60pt growth; mirrored by the windowless layout fixture.
      await host.request('composerPerform', { text: Array(9).fill('A line of draft text').join('\n') + '\n' })
      const grownComposer = await inspect('composerInspect', s => s.bounds.height > compactComposer.bounds.height + 60)
      assert.equal(grownComposer.bounds.y + grownComposer.bounds.height, bottom, 'Composer grows upward from its anchored bottom')
      assert.ok(grownComposer.documentHeight <= grownComposer.inputHeight + 1, 'Uncapped draft fits without scrolling, including trailing newline')
      await host.request('composerPerform', { text: Array(80).fill('A long draft line').join('\n') })
      const cappedComposer = await inspect('composerInspect', s => s.bounds.height > grownComposer.bounds.height && s.documentHeight > s.inputHeight + 100)
      assert.ok(cappedComposer.bounds.height <= 368 && cappedComposer.bounds.height > grownComposer.bounds.height)
      writeFileSync(join(artifacts, 'composer-expanded.png'), Buffer.from(await host.request('captureComposer', { contentOnly: true }), 'base64'))
      await host.request('composerPerform', { text: 'wrap text '.repeat(40) })
      const wrappedComposer = await inspect('composerInspect', s => s.bounds.height > compactComposer.bounds.height && s.bounds.height < cappedComposer.bounds.height)
      assert.ok(wrappedComposer.documentHeight <= wrappedComposer.inputHeight + 1, 'Soft-wrapped draft fits before reaching the cap: ' + JSON.stringify(wrappedComposer))
      await host.request('composerPerform', { text: '' })
      await inspect('composerInspect', s => s.text === '' && s.bounds.height === compactComposer.bounds.height)
      for (const clipboard of [{ image: 'png' }, { image: 'tiff' }, { paths: [join(fixture, 'index.html'), join(fixture, 'native-style.tsx')] }]) {
        assert.deepEqual(await host.request('composerPasteCheck', clipboard), { enabled: true, dispatched: true })
        const count = 'paths' in clipboard ? 2 : 1
        const previews = await inspect('composerInspect', s => s.attachments.length === count && s.enabled && s.text === '')
        assert.equal(previews.attachmentPreviews.count, count)
        assert.equal(previews.attachmentPreviews.images, 'paths' in clipboard ? 0 : 1)
        assert.equal(previews.attachmentPreviews.height, 108)
        assert.ok(previews.inputHeight >= compactComposer.inputHeight - 1)
        const attached = nativeChat.get(nativeChat.active).attachments
        if ('paths' in clipboard) assert.deepEqual(attached.map(a => a.path), clipboard.paths)
        else { assert.equal(attached[0].type, 'image/png'); assert.ok(attached[0].data.length > 0) }
        writeFileSync(join(artifacts, `paste-${'image' in clipboard ? clipboard.image : 'files'}.png`), Buffer.from(await host.request('captureShell'), 'base64'))
        for (let i = 0; i < count; i++) await host.request('composerPerform', { remove: 0 })
        await inspect('composerInspect', s => s.attachments.length === 0)
      }
      assert.deepEqual(await host.request('composerPasteCheck', { text: 'Pasted text に' }), { enabled: true, dispatched: true })
      await inspect('composerInspect', s => s.text === 'Pasted text に' && s.attachments.length === 0)
      await host.request('composerPerform', { text: '' })
      assert.deepEqual(await host.request('composerPasteCheck'), { enabled: false, dispatched: false })
      const previewFixture = join(artifacts, 'composer-ready-beam.png')
      await host.request('composerPerform', { files: [previewFixture, join(fixture, 'index.html'), previewFixture, previewFixture] })
      const mixed = await inspect('composerInspect', s => s.attachmentPreviews.count === 4)
      assert.equal(mixed.attachmentPreviews.images, 3)
      assert.ok(mixed.attachmentPreviews.documentWidth > mixed.attachmentPreviews.viewportWidth, 'Attachments scroll horizontally')
      writeFileSync(join(artifacts, 'composer-attachments.png'), Buffer.from(await host.request('captureComposer'), 'base64'))
      await host.request('composerPerform', { remove: 1 })
      const removed = await inspect('composerInspect', s => s.attachments.length === 3)
      assert.equal(removed.attachmentPreviews.images, 3, 'Remove targets the file between images')
      for (let i = 0; i < 3; i++) await host.request('composerPerform', { remove: 0 })
      await inspect('composerInspect', s => s.attachments.length === 0 && s.bounds.height === compactComposer.bounds.height)
      console.log('Native attachment thumbnails, file cards, overflow and removal passed.')
    }, cleanup: async () => {
      await clearComposer()
    } },
    { name: 'project-switching', dependsOn: ['chat-ready'], run: async () => {
      await checkProjectSwitching(host, fixture, artifacts)
      assert.equal((await host.request('composerInspect')).readyBeam, false, 'Returning to a ready chat replayed its beam')
    } },
    { name: 'chat-gate', dependsOn: ['chat-ready'], run: async () => {
      await checkChatGate(host, fixture, artifacts)
    }, cleanup: async () => {
      await restoreChatGate(firstProject)
    } },
    { name: 'sheets', dependsOn: ['open-project'], run: async () => {
      await checkNativeSheets(host,nativeWorkspace.state.activeKey!,artifacts)
    }, cleanup: async () => {
      host.emit('activity-action', { action: 'hide' })
    } },
    { name: 'security-session', run: async () => {
      await checkSecuritySession(host, artifacts)
    } },
    { name: 'shell-layout', dependsOn: ['open-project'], run: async () => {
      if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1') await preparePreviewInput(host)
      await geometry('sheets')
      const shell=await inspect('shellInspect',s=>s.enabled.code)
      assert.equal(shell.outlineRows,shell.rows.filter((r:any)=>r.kind==='project').length)
      assert.deepEqual(shell.toolGroup,['code','layers','expand']);assert.deepEqual(shell.interactionGroup,['select-object','device'])
      assert.ok(shell.sidebarContainsTrafficLights&&shell.chatTitlePlain&&shell.publishStandard)
      await page(`(()=>{document.documentElement.style.backgroundColor='rgb(40,80,120)';document.body.style.backgroundColor='transparent'})()`)
      const surface=await inspect('previewSurfaceInspect',s=>Math.abs(s.red-40/255)<.02)
      assert.equal(surface.dividerHeight,surface.surfaceHeight)
      await inspect('shellInspect',s=>s.previewHeaderLightText)
      await page(`(()=>{document.documentElement.style.backgroundColor='rgb(250,250,250)'})()`)
      await inspect('shellInspect',s=>!s.previewHeaderLightText)
      await page(`(()=>{document.documentElement.style.removeProperty('background-color');document.body.style.removeProperty('background-color')})()`)
      const initial=await host.request('layoutInspect')
      for(const delta of [-30,30,-20,20])await host.request('dividerPerform',{delta})
      await inspect('layoutInspect',s=>Math.abs(s.width-initial.width)<1)
      await host.request('shellPerform',{action:'expand'});await inspect('layoutInspect',s=>s.fraction===0)
      await host.request('shellPerform',{action:'expand'});await inspect('layoutInspect',s=>s.fraction===1)
      await host.request('shellPerform',{action:'device'});await wait(()=>nativeWorkspace.active?.viewport==='mobile','mobile viewport')
      await host.request('shellPerform',{action:'device'});await wait(()=>nativeWorkspace.active?.viewport==='desktop','desktop viewport')
      await host.request('shellPerform',{action:'layers'});await inspect('layersInspect',s=>s.visible&&s.count>0)
      await host.request('shellPerform',{action:'layers'});await inspect('layersInspect',s=>!s.visible)
    }, cleanup: async () => {
      await page(`(()=>{document.documentElement.style.removeProperty('background-color');document.body.style.removeProperty('background-color')})()`)
      if ((await host.request('layersInspect')).visible) await host.request('shellPerform',{action:'layers'})
      // A passing run leaves the split at fraction 1; expand toggles 0 ⇄ 1.
      for (let i = 0; i < 2 && (await host.request('layoutInspect')).fraction !== 1; i++) { await host.request('shellPerform',{action:'expand'}); await delay(300) }
    } },
    { name: 'toolbar-address', dependsOn: ['chat-ready'], run: async () => {
      await checkToolbarAddress(host, artifacts)
    }, cleanup: async () => {
      await restoreToolbarAddress(host)
    } },
    { name: 'selection-input', dependsOn: ['open-project'], run: async () => {
      await host.request('shellPerform',{action:'select-object'})
      await wait(()=>page(`document.documentElement.style.cursor==='crosshair'`),'select mode')
      if(process.env.TREZI_NATIVE_BACKGROUND_TEST==='1')console.log('SKIP real preview pointer gestures/animation timing: TREZI_NATIVE_BACKGROUND_TEST')
      else await checkSelectionInput(host)
      await invoke('preview:set-select-mode',false)
      assert.equal(await page('typeof window.api'), 'undefined')
      await assert.rejects(()=>dispatchIPC('preview',{type:'invoke',channel:'source:read',args:[fixture,'index.html:1:0']}))
    }, cleanup: async () => {
      await invoke('preview:set-select-mode',false)
      // Inline editing may have left the heading contentEditable or edited; reload it from disk.
      await page('window.reloadSentinel = true')
      host.emit('menu', { action: 'reload' })
      await wait(()=>page(`!!document.querySelector('#native-title') && !window.reloadSentinel`),'fixture reloaded')
    } },
    { name: 'inspector', dependsOn: ['open-project'], run: async () => {
      // Give the real preview selection the style fixture's source. A synthetic
      // element-picked event races with WebKit's layout-driven selection refresh.
      await page(`document.querySelector('#native-title').setAttribute('data-trezi-source','native-style.tsx:1:36')`)
      const layers=await invoke('layers:read'), heading=layers.nodes.find((n:any)=>n.id==='native-title');assert.ok(heading)
      await send('layers:select',{path:heading.path,fingerprint:{tag:heading.tag,source:heading.source}})
      await inspect('inspectorInspect',s=>!s.visible&&s.fields>2)
      serviceEvents.emit('event','preview:toolbar-action','props')
      await inspect('inspectorInspect',s=>s.visible&&s.fields>2)
      serviceEvents.emit('event','preview:toolbar-action','props')
      await inspect('inspectorInspect',s=>!s.visible)
      serviceEvents.emit('event','preview:toolbar-action','props')
      await inspect('inspectorInspect',s=>s.visible)
      assert.deepEqual(await host.request('webViews'),['preview'])
      await wait(async()=> (await invoke('styles:read',['font-size']))?.values?.['font-size'], 'preview computed style after selection')
      // Wait for the opened inspector's preview relayout to settle before capturing
      // the generation used by the same native action contract as the UI.
      let inspector = await host.request('inspectorInspect')
      for (let i=0;i<20;i++) {
        await delay(100)
        const next = await host.request('inspectorInspect')
        if (next.generation === inspector.generation) { inspector = next; break }
        inspector = next
      }
      // Visual evidence for the Styles tab's Layout sliders (LKM-115: no tick marks).
      writeFileSync(join(artifacts,'inspector.png'),Buffer.from(await host.request('captureShell'),'base64'))
      await host.request('inspectorPerform',{action:{root:fixture,generation:inspector.generation,action:'apply',field:'style:opacity',value:'0.8'}})
      try { await wait(()=>readFileSync(join(fixture,'native-style.tsx'),'utf8').includes('0.8'),'native style source edit') } catch (error) { console.error('Native inspector failure', { expected: inspector, actual: await host.request('inspectorInspect') }); throw error }
      await host.request('inspectorPerform',{action:{root:fixture,generation:inspector.generation,action:'close'}})
      await inspect('inspectorInspect',s=>!s.visible)
      await checkInspectorIsland(host,artifacts,()=>serviceEvents.emit('event','preview:toolbar-action','props'),()=>preference('trezi:native-panel-sizes'),{evaluate:page,source:()=>readFileSync(join(fixture,'native-style.tsx'),'utf8'),selectMode:on=>invoke('preview:set-select-mode',on)})
    }, cleanup: async () => {
      const state = await host.request('inspectorInspect')
      if (state.visible) await host.request('inspectorPerform',{action:{root:fixture,generation:state.generation,action:'close'}})
    } },
    { name: 'text-edit', dependsOn: ['open-project'], run: async () => {
      await checkLegacyProject(fixture,invoke,page,wait)
      const edited=await invoke('text:apply',fixture,{source:'index.html:3:1',text:'Edited through Trezi Native'});assert.ok(edited.applied)
      await wait(()=>page(`document.querySelector('#native-title')?.textContent==='Edited through Trezi Native'`),'managed reload')
      assert.ok((await invoke('edit:undo',fixture)).ok);assert.ok((await invoke('edit:redo',fixture)).ok)
    } },
    { name: 'chat-drafts', dependsOn: ['chat-ready'], run: async () => {
      await host.request('composerPerform',{text:'Native draft'})
      await inspect('composerInspect',s=>s.text==='Native draft')
      firstChat=nativeChat.active
      host.emit('shell-action',{action:'new-chat',project:nativeWorkspace.state.activeKey})
      await wait(()=>nativeChat.active!==firstChat,'new chat');await inspect('composerInspect',s=>s.text==='')
      await nativeWorkspace.command({type:'chat',key:nativeWorkspace.state.activeKey!,session:firstChat})
      await inspect('composerInspect',s=>s.text==='Native draft')
      nativeChat.event({type:'commands',projectKey:firstChat,commands:[{name:'native-fixture',description:'Native keyboard test',source:'project'}]})
      await host.request('composerPerform',{text:'/native'});await inspect('composerInspect',s=>s.skillListVisible&&s.skillCount>0)
      await host.request('composerPerform',{key:'Tab'});await inspect('composerInspect',s=>s.text==='/native-fixture ')
      await host.request('composerPerform',{text:''})
    }, cleanup: async () => {
      if (firstChat && nativeChat.active !== firstChat && nativeWorkspace.state.activeKey)
        await nativeWorkspace.command({type:'chat',key:nativeWorkspace.state.activeKey,session:firstChat})
      await clearComposer()
    } },
    { name: 'source-editor', dependsOn: ['open-project'], run: async () => {
      await geometry('before popout')
      await invoke('source:popout',fixture,'index.html:3:1')
      await inspect('sourceInspect',s=>s.popped&&s.source==='index.html')
      await checkSourceEditor(host,fixture,artifacts,inspect)
      await host.request('sourcePerform',{action:{root:fixture,action:'hide'}});await inspect('sourceInspect',s=>!s.visible)
      await geometry('after docking')
    }, cleanup: async () => {
      if ((await host.request('sourceInspect')).popped) await host.request('sourcePerform',{action:{root:fixture,action:'dock'}})
      if ((await host.request('sourceInspect')).visible) await host.request('sourcePerform',{action:{root:fixture,action:'hide'}})
    } },
    { name: 'visible-composer', dependsOn: ['chat-ready'], run: async () => {
      await checkVisibleComposer(host, fixture, artifacts)
    }, cleanup: async () => {
      await clearComposer()
    } },
    { name: 'native-chat', dependsOn: ['chat-ready'], run: async () => {
      await checkNativeChat(host,join(artifacts,'swift-chat.png'))
    } },
    { name: 'preview-inspector', dependsOn: ['open-project'], run: async () => {
      await host.request('previewInspector',{action:'show'});await inspect('previewInspector',s=>s.visible&&s.inspectable)
      await host.request('previewInspector',{action:'close'})
      await checkPreviewInspector(host,artifacts,()=>serviceEvents.emit('event','preview:toolbar-action','props'))
    }, cleanup: async () => {
      await host.request('previewInspector',{action:'close'})
    } },
    { name: 'agent-preview', dependsOn: ['open-project'], run: async () => {
      await checkAgentPreview(page, artifacts)
    }, cleanup: async () => {
      await restoreAgentPreview(page)
    } },
    { name: 'final-shell', run: async () => {
      writeFileSync(join(artifacts,'shell.png'),Buffer.from(await host.request('captureShell'),'base64'))
      assert.deepEqual(await host.request('webViews'),['preview'])
    } },
  ]
  if(process.argv.includes('--live')) checks.push({ name: 'live-provider', dependsOn: ['chat-ready', 'text-edit'], run: async () => {
    const provider=process.env.TREZI_NATIVE_TEST_PROVIDER||'claude'
    if(!['claude','codex'].includes(provider))throw new Error('Unsupported live provider')
    const options={provider,permissionMode:'bypassPermissions',...(provider==='claude'?{model:'haiku'}:{})}
    const restarted=await invoke('agent:restart-chat',fixture,nativeChat.active,options);assert.ok(restarted.ok)
    let done=false,error='';const listener=(channel:string,e:any)=>{if(channel==='agent:event'&&e.projectKey===nativeChat.active){if(e.type==='done')done=true;if(e.type==='error'){error=e.message;done=true}}};serviceEvents.on('event',listener)
    try { await host.request('composerPerform',{text:'Edit index.html. Replace the heading text "Edited through Trezi Native" with "NATIVE_AGENT_VERIFIED". Make the edit now.'});await inspect('composerInspect',s=>s.enabled);await host.request('composerPerform',{action:'send'});await wait(()=>done,'live provider',180000);assert.equal(error,'');await wait(()=>readFileSync(join(fixture,'index.html'),'utf8').includes('NATIVE_AGENT_VERIFIED'),'live file edit',30000) } finally {serviceEvents.off('event',listener)}
  } })
  let hostClosed = false
  void host.closed.then(() => { hostClosed = true })
  // `--only` filters which named checks run; failure collection is unchanged.
  const results = await runSmokeChecks(selectSmokeChecks(checks, parseSmokeGroups(process.argv)), {
    capture: name => captureSmokeFailure(host, artifacts, name),
    restore: () => restoreSmokeState(host, firstProject),
    inject: parseInjectedFailures(process.env.TREZI_NATIVE_SMOKE_FAIL),
    halted: () => hostClosed ? 'native host (it exited)' : undefined
  })
  console.log(formatSmokeSummary(results))
  const failed = results.filter(r => r.outcome !== 'pass')
  if (failed.length) throw new Error(`Native smoke: ${failed.length} of ${results.length} checks did not pass (${failed.map(r => r.name).join(', ')})`)
  console.log('NATIVE CORE PASS — no React/main/panel/editor WebViews; workspace, sheets, layout, native editing, streams and preview isolation.')
}
