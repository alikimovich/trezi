/** Page-world entry for `slow-motion.js`. The host wraps the bundle in a block that
 *  declares `__treziSpeed`, the preview session's speed when the document starts. */
import { installSlowMotion } from './slow-motion'

declare const __treziSpeed: number | undefined

installSlowMotion(window, typeof __treziSpeed === 'number' ? __treziSpeed : 1)
