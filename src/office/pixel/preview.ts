/**
 * The one thing every pixel module owes the rest of the world besides its draw functions: a list
 * of things it can draw in isolation.
 *
 * Sprites authored without looking at them are wrong more often than they are right, and opening
 * the app to check a mug is far too slow a loop. `scripts/sheet.ts` renders these entries to a PNG
 * contact sheet with a software canvas, so a sprite can be inspected — and fixed — without a
 * browser, a dev server, or a running session.
 *
 * Deliberately not `Art[]`: half of what the renderer draws is procedural (a light pool, a plank
 * floor, a steam plume) and has no sprite to point at. A draw callback covers both.
 */
export type PreviewItem = {
  /** Shown under the cell. Keep it short — the label font is 3px wide per glyph. */
  name: string;
  /** Cell size in canvas pixels. The drawing is clipped to it by the sheet's layout, not by code. */
  w: number;
  h: number;
  /**
   * Paints one cell. The origin is the cell's top-left, `t` is milliseconds of animation time.
   * Anything anchored at its base should draw at `y = h - 1`, so cells line up on a floor line.
   */
  draw: (ctx: CanvasRenderingContext2D, t: number) => void;
  /** Frames to lay out side by side, for anything animated. Defaults to 1. */
  frames?: number;
  /** Milliseconds between those frames. Defaults to 120. */
  frameMs?: number;
  /** Cell background, when the default checker would hide the sprite. */
  bg?: string;
};
