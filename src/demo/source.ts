/**
 * The committed recording, bound to the player — the one thing `src/demo/main.tsx` hands the stream.
 *
 * Imported as text and parsed here rather than imported as a JSON module, for two reasons. The
 * compiler would otherwise infer a literal type for every one of its frames, which buys nothing and
 * costs every `tsc` run; and data crossing a JSON boundary is narrowed at that boundary in this
 * codebase, which is `parseRecording`'s job. The bundle is the same size either way — Vite ships a
 * large JSON module as a `JSON.parse` of a string too.
 *
 * Re-record with `npx tsx scripts/recordDemo.ts`.
 */
import raw from './recording.json?raw';
import { play, parseRecording, type Recording } from './playback';

let parsed: Recording | null = null;

export function playDemo(deliver: (msg: object) => void): () => void {
  parsed ??= parseRecording(JSON.parse(raw));
  return play(parsed, deliver);
}
