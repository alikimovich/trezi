// Bun's FFI types are not part of this project's Node-only typecheck. Only the
// macOS flock binding used by the product log is declared here.
declare module 'bun:ffi' {
  export function dlopen(
    path: string,
    symbols: { flock: { args: ['i32', 'i32']; returns: 'i32' } }
  ): { symbols: { flock: (fd: number, operation: number) => number } }
}
