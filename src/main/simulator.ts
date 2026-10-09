import { app, ipcMain, type NativeView } from '../native/platform'
import { platformOwner } from './platform-owner'

/**
 * iOS-Simulator preview — the React Native / Expo counterpart to `devserver.ts`. The
 * service's platform owner (S14, `SimulatorOwner.swift`, `SimulatorBridge.swift`,
 * `SimulatorTools.swift`) boots a simulator, runs the app's launch command as a
 * supervised process group and serves the device screen as an MJPEG page on a
 * loopback bridge, which the preview view loads like any local URL. This module wires
 * the renderer's IPC to it and forwards its log lines and element picks.
 */

let getWin: () => NativeView | null = () => null
// Send to the renderer, guarding a destroyed webContents: the owner keeps emitting
// log lines and picks while the window's renderer may be gone.
const sendToWin = (channel: string, ...args: unknown[]): void => {
  const wc = getWin()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

export function registerSimulatorIpc(getWindow: () => NativeView | null): void {
  getWin = getWindow
  const owner = platformOwner()
  owner.onSimulatorLog((line) => sendToWin('simulator:log', line))
  owner.onSimulatorPick((pick) => sendToWin('simulator:element-picked', pick))
  ipcMain.handle('simulator:preflight', () => owner.simulatorPreflight())
  ipcMain.handle('simulator:start', (_e, opts: { root: string; command?: string; udid?: string }) =>
    owner.simulatorStart(opts)
  )
  ipcMain.handle('simulator:stop', () => owner.simulatorStop())
  // Arm/disarm element-select for the sim (a tap then becomes a pick).
  ipcMain.handle('simulator:set-select-mode', (_e, active: boolean) =>
    owner.simulatorSelect(!!active)
  )
  // The service also stops it when it shuts down; this ends it with the window.
  app.on('before-quit', () => {
    void owner.simulatorStop().catch(() => {})
  })
}
