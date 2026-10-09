/** Service registration and event delivery contracts for the native backend. */
export type RpcHandler = (event: unknown, ...args: any[]) => unknown

export interface RpcHandlerRegistry {
  handle: (channel: string, listener: RpcHandler) => void
}

/** The only event target shape agent backends need: guarded event delivery. */
export interface RendererEventTarget {
  webContents: {
    isDestroyed: () => boolean
    send: (channel: string, payload: unknown) => void
  }
}
