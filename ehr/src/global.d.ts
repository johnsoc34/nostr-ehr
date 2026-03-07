// Fix Uint8Array / BufferSource compatibility issue in TypeScript 5.x
interface Uint8Array {
  buffer: ArrayBuffer;
}