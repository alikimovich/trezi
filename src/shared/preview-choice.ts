import type { DetectedProject } from './api'

/** Which preview a repo with both a JS dev server and native roots runs (LKM-276). */
export type PreviewUse = 'js' | 'native'

/**
 * A mixed repo's preview choice, applied on top of detection. Detection itself (the
 * TypeScript reference and the Swift runtime owner, kept byte-identical by
 * `test/runtime-owner.mjs`) is unchanged: a JS app that also holds native roots keeps its
 * JS launch unless the user chose the native preview, stored in the project's launch spec.
 * React Native and Expo always keep the simulator. Pure.
 */
export function applyPreviewChoice(
  detected: DetectedProject,
  choice: PreviewUse | undefined
): DetectedProject {
  const native = detected.native
  const roots = native ? [...native.workspaces, ...native.projects, ...native.packages] : []
  if (
    !roots.length ||
    detected.framework === 'swift' ||
    detected.setupRequired ||
    !detected.devCommand
  )
    return detected
  const where = roots.join(', ')
  if (detected.previewKind === 'simulator')
    return {
      ...detected,
      previewChoice: {
        using: 'js',
        switchable: false,
        reason: `React Native and Expo preview in the iOS Simulator; their native folders (${where}) are part of that app.`
      }
    }
  if (choice !== 'native')
    return {
      ...detected,
      previewChoice: {
        using: 'js',
        switchable: true,
        reason: `Previewing the ${detected.framework} dev server (${detected.devCommand}); the native roots (${where}) can be previewed instead.`
      }
    }
  return {
    ...detected,
    framework: 'swift',
    scriptName: '',
    devCommand: '',
    previewKind: 'web',
    previewChoice: {
      using: 'native',
      switchable: true,
      reason: `Previewing the native roots (${where}) with Trezi's Swift preview driver; the ${detected.framework} dev server can be previewed instead.`
    }
  }
}
