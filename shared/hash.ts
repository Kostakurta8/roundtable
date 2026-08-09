/**
 * FNV-1a over a string — the one copy.
 *
 * Small, dependency-free, and it spreads short hex ids evenly enough for a palette pick. It was
 * written out three times (`src/store.ts` for an agent's look, `src/office/pixel/scene.ts` for its
 * face and blink rhythm, and once in the engine) with no test tying them together. Identical today
 * is not the same as identical after somebody improves one of them: an agent's shirt is chosen in
 * the store and its face is chosen in the renderer, so the two hashes drifting apart would give one
 * agent two appearances that disagree — a bug with no error message, visible only as a room that
 * looks subtly wrong to somebody who knows what it should look like.
 */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
