/**
 * Contact sheets for the pixel modules.
 *
 *   npx tsx scripts/sheet.ts characters          one module
 *   npx tsx scripts/sheet.ts characters props    several, one PNG each
 *   npx tsx scripts/sheet.ts all                 every module that exports PREVIEW
 *
 * Each module exports `PREVIEW: PreviewItem[]` (see `src/office/pixel/preview.ts`); this lays
 * those out on a grid, labels them, and writes `.preview/<module>.png` at 4x. Animated entries
 * are laid out as a strip of frames on one row, which is the only way to see whether a walk cycle
 * actually cycles.
 *
 * A missing module is reported and skipped rather than thrown, so the sheet still renders while
 * its neighbours are being written.
 */
import { drawText, textWidth, PAL } from '../src/office/pixel/art';
import type { PreviewItem } from '../src/office/pixel/preview';
import { asCtx, save, SoftCtx } from './pixpreview';

const MODULES = ['environment', 'furniture', 'characters', 'props', 'effects', 'scene'] as const;

/**
 * Upscale factor for the written PNG. 3 is legible and keeps a busy sheet around 2 megapixels;
 * 4 pushed the character sheet past 7, which is slow to write and expensive for anything that
 * has to look at it. Override with a trailing number: `sheet.ts characters 4`.
 */
const ZOOM = (() => {
  const n = Number(process.argv[process.argv.length - 1]);
  return Number.isFinite(n) && n >= 1 && n <= 8 ? Math.round(n) : 3;
})();

const PAD = 4;
const LABEL_H = 7;
const GAP = 6;
/** Cells wrap once a row would pass this, in canvas pixels. Wide enough for a 12-frame strip. */
const SHEET_W = 460;

/** A two-tone checker, so a sprite's transparent pixels are visibly transparent. */
function checker(ctx: SoftCtx, x: number, y: number, w: number, h: number): void {
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      ctx.fillStyle = ((px >> 2) + (py >> 2)) % 2 === 0 ? '#242833' : '#2c3140';
      ctx.fillRect(x + px, y + py, 1, 1);
    }
  }
}

type Placed = { item: PreviewItem; x: number; y: number; w: number; h: number; frames: number };

/** Left-to-right, wrapping, rows as tall as their tallest cell. */
function layout(items: readonly PreviewItem[]): { placed: Placed[]; w: number; h: number } {
  const placed: Placed[] = [];
  let x = PAD;
  let y = PAD;
  let rowH = 0;
  let maxX = 0;
  for (const item of items) {
    const frames = Math.max(1, item.frames ?? 1);
    const w = Math.max(item.w * frames + (frames - 1), textWidth(item.name));
    const h = item.h + LABEL_H;
    if (x > PAD && x + w > SHEET_W) {
      x = PAD;
      y += rowH + GAP;
      rowH = 0;
    }
    placed.push({ item, x, y, w, h, frames });
    x += w + GAP;
    rowH = Math.max(rowH, h);
    maxX = Math.max(maxX, x);
  }
  return { placed, w: Math.max(SHEET_W, maxX) + PAD, h: y + rowH + PAD };
}

function render(name: string, items: readonly PreviewItem[]): void {
  const { placed, w, h } = layout(items);
  const ctx = new SoftCtx(w, h);
  ctx.fillStyle = '#181b24';
  ctx.fillRect(0, 0, w, h);

  for (const p of placed) {
    const frameMs = p.item.frameMs ?? 120;
    for (let f = 0; f < p.frames; f++) {
      const fx = p.x + f * (p.item.w + 1);
      if (p.item.bg) {
        ctx.fillStyle = p.item.bg;
        ctx.fillRect(fx, p.y, p.item.w, p.item.h);
      } else {
        checker(ctx, fx, p.y, p.item.w, p.item.h);
      }
      const c = asCtx(ctx);
      // Cells are drawn in module coordinates offset to the cell; the module never knows.
      const shifted = new Proxy(c, {
        get(target, key) {
          if (key === 'fillRect') {
            return (rx: number, ry: number, rw: number, rh: number) => {
              // Clip to the cell so a sprite that overruns its declared box cannot bleed into its
              // neighbour and be mistaken for part of it.
              const x0 = Math.max(fx, fx + Math.round(rx));
              const y0 = Math.max(p.y, p.y + Math.round(ry));
              const x1 = Math.min(fx + p.item.w, fx + Math.round(rx) + Math.round(rw));
              const y1 = Math.min(p.y + p.item.h, p.y + Math.round(ry) + Math.round(rh));
              if (x1 > x0 && y1 > y0) target.fillRect(x0, y0, x1 - x0, y1 - y0);
            };
          }
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        },
        set(target, key, value) {
          return Reflect.set(target, key, value);
        },
      });
      try {
        p.item.draw(shifted, f * frameMs);
      } catch (err) {
        ctx.fillStyle = PAL.err;
        ctx.fillRect(fx, p.y, p.item.w, p.item.h);
        console.error(`  ! ${p.item.name} frame ${f}: ${(err as Error).message}`);
      }
    }
    drawText(asCtx(ctx), p.item.name, p.x, p.y + p.item.h + 1, '#8f9bb3');
  }

  const file = save(name, ctx, ZOOM);
  console.log(`${name}: ${items.length} items -> ${file}`);
}

async function sheetFor(mod: string): Promise<void> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(`../src/office/pixel/${mod}`)) as Record<string, unknown>;
  } catch (err) {
    console.log(`${mod}: not available yet (${(err as Error).message.split('\n')[0]})`);
    return;
  }
  const items = loaded.PREVIEW as PreviewItem[] | undefined;
  if (!Array.isArray(items) || items.length === 0) {
    console.log(`${mod}: no PREVIEW export`);
    return;
  }
  render(mod, items);
}

// Wrapped rather than top-level `await`: there is no `"type": "module"` in package.json, so tsx
// transpiles this to CommonJS and a top-level await is a build error rather than a runtime one.
async function main(): Promise<void> {
  // A trailing number is the zoom, not a module name.
  const args = process.argv.slice(2).filter((a) => !Number.isFinite(Number(a)));
  const wanted = args.length === 0 || args[0] === 'all' ? MODULES : args;
  for (const mod of wanted) await sheetFor(mod);
}

void main();
