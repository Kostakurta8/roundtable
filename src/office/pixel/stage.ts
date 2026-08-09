/**
 * Where the room lands on a screen.
 *
 * The buffer is a fixed 480x270; a stage is whatever shape the window and the rail leave it. This
 * module is the whole of the arithmetic between those two — the camera and its clamp, the blit, the
 * inverse of the blit, and what fills the strip of stage the room does not reach. It draws nothing.
 *
 * It is a module rather than a section of `PixelOffice.tsx` because of what it has to be checked
 * against. The component imports React and a stylesheet, so anything living inside it can only be
 * exercised by something that can load both — which ruled out the offline renderer that writes the
 * review PNGs, and so the strip above the room was, for as long as it was wrong, the one part of
 * the picture that no sheet in `.preview/` could show. Arithmetic that decides what a viewer sees
 * has to be reachable by the thing that renders what a viewer sees.
 *
 * Only `./art` is imported, per the pixel contract, and nothing here knows what a canvas is.
 */
import { PIX } from './art';

// ------------------------------------------------------------------- camera

export type Cam = { x: number; y: number; z: number };

/** Zoom limits. 1 is the whole room; past 3 a pixel is the size of a word. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;

export const CAM_HOME: Cam = { x: PIX.w / 2, y: PIX.h / 2, z: 1 };

/**
 * Keeps the view inside the buffer, so the camera can never show the void past the room.
 *
 * The invariant, and the thing worth asserting rather than the arithmetic: the window
 * `[x - halfW, x + halfW]` by `[y - halfH, y + halfH]` lies wholly inside the buffer, at every
 * zoom. At `ZOOM_MIN` the half-extents *are* the buffer's own, so the room's centre is the only
 * legal camera and every pan is a no-op — which is why pointing the camera at a fresh selection
 * appears to do nothing until somebody has zoomed in.
 */
export function clampCam(cam: Cam): Cam {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.z));
  const halfW = PIX.w / z / 2;
  const halfH = PIX.h / z / 2;
  return {
    z,
    x: Math.min(PIX.w - halfW, Math.max(halfW, cam.x)),
    y: Math.min(PIX.h - halfH, Math.max(halfH, cam.y)),
  };
}

// --------------------------------------------------------------------- blit

/** The stage, as the blit needs to know it: CSS pixels, device ratio, and the rail's bite. */
export type Geo = { w: number; h: number; dpr: number; insetLeft: number };

/**
 * Where the buffer lands on the canvas, and at what magnification.
 *
 * Everything that has to agree about where a buffer pixel is on screen goes through here: the
 * `drawImage` call, the DOM layer laid over it, the fixtures, the hover card, and the inverse used
 * to zoom about the cursor. `px` is buffer pixels to CSS pixels, and `dx`/`dy` are the room's top
 * left corner in CSS pixels relative to the stage — the two numbers every placement needs.
 */
export type Blit = {
  viewW: number;
  viewH: number;
  scale: number;
  destW: number;
  destH: number;
  destX: number;
  destY: number;
  srcX: number;
  srcY: number;
  px: number;
  dx: number;
  dy: number;
};

export function blitOf(cam: Cam, g: Geo): Blit {
  const usableW = Math.max(g.w * 0.55, g.w - g.insetLeft);
  const viewW = PIX.w / cam.z;
  const viewH = PIX.h / cam.z;
  const scale = Math.min((usableW * g.dpr) / viewW, (g.h * g.dpr) / viewH);
  const destW = viewW * scale;
  const destH = viewH * scale;
  const destX = Math.round((g.w * g.dpr - g.insetLeft * g.dpr - destW) / 2 + g.insetLeft * g.dpr);
  // Bottom-aligned: the stage is usually taller than 16:9, and space left above the ceiling can be
  // painted as more room, where space left below the floor is a visible seam under the near wall.
  // What fills that space is `headroomOf`, below — leaving it bare is what made the choice look
  // like a mistake for as long as the fill was black.
  const destY = Math.round(g.h * g.dpr - destH);
  // The source origin is snapped to whole buffer pixels: a fractional source offset resamples
  // the whole room every frame and the art shimmers as the camera eases.
  const srcX = Math.round(cam.x - viewW / 2);
  const srcY = Math.round(cam.y - viewH / 2);
  return {
    viewW,
    viewH,
    scale,
    destW,
    destH,
    destX,
    destY,
    srcX,
    srcY,
    px: scale / g.dpr,
    dx: destX / g.dpr,
    dy: destY / g.dpr,
  };
}

/**
 * A point on the stage, in CSS pixels from its top left, as a point in the buffer.
 *
 * The exact inverse of the placement every mark, fixture and hover card is written by —
 * `b.dx + (v - b.srcX) * b.px` — and the only reason that is safe to say is that
 * `tests/pixel.test.ts` round-trips the two against each other over a spread of cameras, zooms,
 * device ratios and rail insets. Both directions read the *derived* fields (`srcX`, `dx`, `px`)
 * rather than re-deriving them from the camera, which is what makes an inverse possible at all.
 */
export const toBuffer = (b: Blit, x: number, y: number): { x: number; y: number } => ({
  x: b.srcX + (x - b.dx) / b.px,
  y: b.srcY + (y - b.dy) / b.px,
});

// ----------------------------------------------------------------- headroom

/**
 * The strip of stage above the room, resolved into the pieces that fill it. Device pixels.
 *
 * Bottom-aligning a 16:9 room on a stage that is taller than 16:9 leaves a strip across the top,
 * and with the rail taking a bite out of the width there is nearly always one — around a sixth of
 * the stage at 1600x900. The old comment defended leaving it, on the grounds that space above the
 * ceiling reads as a taller room where space below the floor reads as a seam. The first half of
 * that is right and the second half is why this is not fixed by centring instead. What was wrong
 * was the *paint*: the strip was filled with `PAL.out` and `PAL.shd`, the two near-blacks the art
 * uses for outlines, so what was actually above the ceiling was a black rectangle. Nothing in this
 * room is black, and the office read as a picture pinned to a void.
 */
export type Headroom = {
  /** The strip's own height — `blit.destY`, named for what it is rather than for where it ends. */
  h: number;
  /**
   * Buffer rows of the **room itself** that sit above the view and can be shown in the strip.
   *
   * The first thing to try, and free: at any zoom past 1 the camera is showing a window into the
   * buffer, and the rows immediately above that window are real room that simply is not in the
   * nominal view. Painting a fictional ceiling over them would be inventing something the room
   * already has. Never more than `srcY`, so this can never sample above the buffer's first row.
   */
  roomRows: number;
  /** Where those rows start. */
  roomY: number;
  /** Buffer rows taken from the ceiling strip — the room continued past its own first row. */
  ceilRows: number;
  /** Where the ceiling starts. Anything above it is the ceiling's own top row, stretched. */
  ceilY: number;
  /** The ceiling strip is sampled from its **last** rows: its bottom row abuts the room's first. */
  ceilSrcY: number;
};

/**
 * What fills the headroom, given the blit and how many rows of ceiling art there are to spend.
 *
 * Deliberately additive: it reads `blitOf`'s output and changes none of it. `toBuffer` is the
 * inverse of the placement every mark, fixture and hover card is written by, and `clampCam` is what
 * keeps the view inside the room — neither can be affected by a strip painted above the room, which
 * is exactly why the fix is drawn on top of that arithmetic rather than into it. The strip survives
 * a zoom because it is expressed in the same buffer rows the camera is (`roomRows` grows as the
 * zoom does, and the strip fills with real room instead of ceiling); it survives a device ratio of
 * 2 because every number here is in device pixels off `b.scale`, the units `destY` and `destH` are
 * already in; and it survives the rail because the rail moves `destX`, which this never reads.
 *
 * The one property worth stating twice: `roomY` is `b.dy - roomRows * b.px` in CSS pixels, which is
 * `place`'s own formula continued above the view. An actor standing above the top of the view at a
 * high zoom is therefore drawn in the strip *under their own DOM mark*, rather than beside it.
 */
export function headroomOf(b: Blit, ceilH: number): Headroom {
  const h = b.destY;
  if (!(h > 0)) return { h: 0, roomRows: 0, roomY: 0, ceilRows: 0, ceilY: 0, ceilSrcY: ceilH };
  // Whole rows, rounded up: a strip covered by a fraction of a row leaves a hairline of whatever
  // was under it, which on this canvas is a hairline of the surround colour across the ceiling.
  const roomRows = Math.max(0, Math.min(b.srcY, Math.ceil(h / b.scale)));
  const roomY = h - roomRows * b.scale;
  const ceilRows = Math.max(0, Math.min(ceilH, Math.ceil(roomY / b.scale)));
  return {
    h,
    roomRows,
    roomY,
    ceilRows,
    ceilY: roomY - ceilRows * b.scale,
    ceilSrcY: ceilH - ceilRows,
  };
}

/** One `drawImage`, as its nine arguments and which of the two buffers it reads. */
export type Piece = {
  from: 'room' | 'ceiling';
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

/**
 * The headroom as a list of blits, bottom to top.
 *
 * A list rather than four calls written out in the frame loop, because the offline renderer draws
 * the same strip through a software canvas that has no `drawImage` at all. Two hand-written copies
 * of "which rows go where" is precisely how a preview stops being evidence about the app — so the
 * arithmetic is here, once, and each caller supplies only its own way of moving pixels.
 *
 * The last piece is the widest departure from a plain letterbox and the one worth understanding: if
 * the strip is deeper than the ceiling art, the ceiling's **topmost row** is stretched to cover the
 * rest. It costs nothing, it cannot be the wrong colour — it is by construction the colour the
 * ceiling arrived at, night wash and all — and it means a freakishly tall window degrades to a flat
 * ceiling rather than to a rectangle of whatever the surround happens to be.
 */
export function headroomBlits(b: Blit, ceilH: number): readonly Piece[] {
  const hr = headroomOf(b, ceilH);
  if (hr.h <= 0) return [];
  const out: Piece[] = [];
  if (hr.roomRows > 0) {
    out.push({
      from: 'room',
      sx: b.srcX,
      sy: b.srcY - hr.roomRows,
      sw: b.viewW,
      sh: hr.roomRows,
      dx: b.destX,
      dy: hr.roomY,
      dw: b.destW,
      dh: hr.roomRows * b.scale,
    });
  }
  if (hr.ceilRows > 0) {
    out.push({
      from: 'ceiling',
      sx: b.srcX,
      sy: hr.ceilSrcY,
      sw: b.viewW,
      sh: hr.ceilRows,
      dx: b.destX,
      dy: hr.ceilY,
      dw: b.destW,
      dh: hr.ceilRows * b.scale,
    });
  }
  if (hr.ceilY > 0) {
    out.push({
      from: 'ceiling',
      sx: b.srcX,
      sy: 0,
      sw: b.viewW,
      sh: 1,
      dx: b.destX,
      dy: 0,
      dw: b.destW,
      dh: hr.ceilY,
    });
  }
  return out;
}
