/**
 * The software canvas: exactly the slice of `CanvasRenderingContext2D` that `art.ts` uses —
 * `fillStyle`, `globalAlpha`, `fillRect` — over a flat RGBA buffer.
 *
 * It lived in `scripts/pixpreview.ts` beside the PNG writer, which reaches for `node:zlib` and
 * `node:fs` at the top of the file. That was fine while only node drew offscreen. The share
 * dialog draws the same clip in a browser worker, and a worker that imported this from there
 * would have pulled the file system in with it — so the canvas moved here, with nothing around it
 * that a browser cannot load, and `pixpreview.ts` re-exports it so the review sheets and the
 * visual-regression hashes still name it where they always did.
 */

/** `#rgb`, `#rrggbb` and `#rrggbbaa` — the only colour forms the renderer writes. */
function parseColor(css: string): [number, number, number, number] {
  const s = css.trim();
  if (s[0] !== '#') return [255, 0, 255, 255]; // loud magenta: an unparsed colour must be visible
  const hex = s.slice(1);
  const grab = (i: number, n: number): number =>
    n === 1 ? parseInt(hex[i] + hex[i], 16) : parseInt(hex.slice(i, i + 2), 16);
  if (hex.length === 3) return [grab(0, 1), grab(1, 1), grab(2, 1), 255];
  if (hex.length === 6) return [grab(0, 2), grab(2, 2), grab(4, 2), 255];
  if (hex.length === 8) return [grab(0, 2), grab(2, 2), grab(4, 2), grab(6, 2)];
  return [255, 0, 255, 255];
}

/**
 * The subset of the 2D context the renderer touches, over a flat RGBA buffer.
 *
 * Source-over blending is done by hand because that is the whole job: a sprite is a stack of
 * translucent rectangles and the compositing has to match what the browser would do, or a
 * light pool previewed here would not be the light pool that ships.
 */
export class SoftCtx {
  readonly data: Uint8ClampedArray;
  fillStyle = '#000000';
  globalAlpha = 1;
  imageSmoothingEnabled = false;

  private rgba: [number, number, number, number] = [0, 0, 0, 255];
  private lastStyle = '';

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  private color(): [number, number, number, number] {
    if (this.fillStyle !== this.lastStyle) {
      this.rgba = parseColor(this.fillStyle);
      this.lastStyle = this.fillStyle;
    }
    return this.rgba;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, ca] = this.color();
    const a = this.globalAlpha * (ca / 255);
    if (a <= 0) return;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x) + Math.round(w));
    const y1 = Math.min(this.height, Math.round(y) + Math.round(h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * this.width + px) * 4;
        const d = this.data;
        d[i] = r * a + d[i] * (1 - a);
        d[i + 1] = g * a + d[i + 1] * (1 - a);
        d[i + 2] = b * a + d[i + 2] * (1 - a);
        d[i + 3] = 255 * a + d[i + 3] * (1 - a);
      }
    }
  }

  /** `save`/`restore` are not used by the renderer, but a stray call must not crash a preview. */
  save(): void {}
  restore(): void {}
  clearRect(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, x0 + Math.round(w));
    const y1 = Math.min(this.height, y0 + Math.round(h));
    for (let py = y0; py < y1; py++) this.data.fill(0, (py * this.width + x0) * 4, (py * this.width + x1) * 4);
  }
}

/** A `SoftCtx` typed as the real thing, for calling code that wants the DOM signature. */
export const asCtx = (c: SoftCtx): CanvasRenderingContext2D => c as unknown as CanvasRenderingContext2D;
