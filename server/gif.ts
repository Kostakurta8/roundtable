/**
 * The GIF encoder, as the CLI holds it.
 *
 * The encoder itself is `src/clip/gif.ts`, where the share dialog's browser worker can load it too:
 * one encoder, so a clip saved from the app and a clip written by `--gif` are the same file. It
 * returns a `Uint8Array` because a browser has no `Buffer`; this hands the CLI the same bytes as a
 * `Buffer`, over the same memory, so `writeFileSync` and every caller that reads the file back with
 * `readUInt16LE` go on working exactly as they did.
 */
import { encodeGif as encodeBytes, type GifInput } from '../src/clip/gif';

export { cutPalette, packRgb, type GifInput, type RgbFrame } from '../src/clip/gif';

/** The whole clip as the bytes of one looping GIF89a. */
export function encodeGif(input: GifInput): Buffer {
  const bytes = encodeBytes(input);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
