import type { StatesCanvasController } from './states-canvas-controller'

let active: StatesCanvasController | null = null
export const canvasController = () => active
export const setCanvasController = (controller: StatesCanvasController | null) => {
  active = controller
}
