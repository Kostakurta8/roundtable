# The pixel office — module contract

Everything drawn in the room goes into one 480×270 canvas that is scaled up with
`image-rendering: pixelated`. A pixel here is a **decision**, not a hint: at this size a stray row
of the wrong colour is the difference between a chair and a smudge.

This file is the contract. Each module below is owned by exactly one author, exports exactly the
signatures listed, and imports **only** `./art` and `./preview` — never another pixel module,
never React, never the engine, never the store. That is what lets six of them be written at once.

---

## 1. The substrate — `src/office/pixel/art.ts` (done, do not edit)

```ts
export const PIX: { w: 480; h: 270 };
export const PAL: Record<PalKey, string>;             // the locked palette, see §2
export type Look = { skin; skinShade; hair; hairShade; shirt; shirtShade; trouser };
export type Art = { rows: readonly string[]; map: Readonly<Record<string, PalKey>> };

export function drawArt(ctx, art: Art, x, y, opts?: {
  flip?: boolean; look?: Look; alpha?: number; tint?: string;
}): void;                                  // x,y = TOP-LEFT of the sprite
export function rect(ctx, x, y, w, h, color: string, alpha?): void;
export function pool(ctx, cx, cy, rx, ry, color, strength?, bands?): void;  // banded, hard-edged
export function drawText(ctx, s, x, y, color, alpha?): void;      // x,y = top-left, 5px tall
export function drawTextOutlined(ctx, s, x, y, color, halo?, alpha?): void;
export function textWidth(s: string): number;
export const FONT_HEIGHT: 5;
export const artWidth: (a: Art) => number;
export const artHeight: (a: Art) => number;
```

**The `Art` format.** One character per pixel, `.` (or a space) transparent. `map` translates the
rest to palette keys. Rows need not be padded — trailing transparency is implied.

Seven characters are **reserved** and never appear in `map`; they are filled from the `Look` passed
at draw time, which is how one character sprite becomes twelve different people:

| char | slot | char | slot |
|---|---|---|---|
| `S` | skin | `s` | skin shadow |
| `H` | hair | `h` | hair shadow |
| `T` | shirt | `t` | shirt shadow |
| `P` | trouser | | |

```ts
const HEAD: Art = {
  rows: [
    '.hHHHh.',
    'hHHHHHh',
    'HSSSSSH',
    '.SoSoS.',      // `o` is an outline pixel, mapped below
    '.SSSSS.',
    '..sss..',
  ],
  map: { o: 'out' },
};
drawArt(ctx, HEAD, 10, 4, { look });
```

**Only these context members exist.** `fillStyle`, `globalAlpha`, `fillRect`. No paths, no
gradients, no `arc`, no images, no shadows, no `save`/`restore` state you depend on. The preview
harness implements exactly this subset, and anything else silently does nothing there and looks
different in the browser. Curves are drawn as stepped runs of `fillRect` — `pool()` shows how.

---

## 2. The palette

Use palette keys. Do not write raw hex except where a signature hands you a colour (an agent tint).

```
out ou2 shd            outlines, soft outline, drop shadow      (never pure black)
wal wa2 wa3 wtr wlt    wall, darker, darkest, skirting, lit wall
flr fl2 fl3 fl4 flt    floor plank tones, plank seam, floor lit by a lamp
wdt wdf wdd wdl        desk top, desk front, desk shadow side, lit edge
met me2 me3 blk bl2    metal, dark metal, light metal, dark plastic, lighter plastic
scr sc2 sc3 scg        screen dark, screen mid, screen bright, screen glow
lmp lm2 day wht gry    lamp warm, lamp deep, daylight cool, white, grey
lf1 lf2 lf3 pot po2    leaf, leaf shadow, leaf light, terracotta, terracotta shadow
ok err wrn acc         status green, red, amber, teal accent — STATUS ONLY, never decoration
pap pa2                paper, paper shadow
```

**Read the light.** Every surface picks a side: cool daylight from the windows on the left and
centre of the back wall, warm lamps over the desks. A surface facing up and left catches `wlt` /
`wdl` / `flt`; a surface facing down and right goes to `wa3` / `wdd` / `shd`. Flat fills read as
cardboard.

**Outline everything that stands in the room.** Characters, furniture and props carry a 1px `out`
silhouette on the sides and bottom — that hard edge is what makes the style read as pixel art
rather than as a low-resolution photo. Wall and floor do not.

---

## 3. The reference look

An HD-2D pixel office seen from a raised three-quarter angle. The traits to hit, in order of how
much they matter:

1. **Chunky and hard-edged.** No dithered gradients over more than 2 steps, no anti-aliasing, no
   1px noise scattered for "texture". Big readable shapes.
2. **Saturated, dark-outlined.** Deep teal-blue wall, warm mid-brown plank floor, and characters
   in saturated shirts, every one of them ringed in near-black.
3. **Dense with props.** Empty floor is what makes a pixel room look unfinished: mugs, papers,
   keyboards, bins, boxes, plants, cables, a coat rack, a water cooler. Every desk carries three
   or four objects, and no two neighbouring desks carry the same set.
4. **Characters read at a glance.** Big heads (roughly 2 heads to the body), distinct hair
   silhouettes — not just distinct hair *colours* — and distinct shirts. From 24 pixels away you
   should be able to tell two agents apart.
5. **Light does the depth work.** Warm pools under the desk lamps, cool wedges under the windows,
   a cool glow bouncing off each monitor onto the face and desk in front of it.
6. **Every surface has a top and a front.** Desks, tables and cabinets show their top face in a
   lighter tone and their front face in a darker one, with a lit edge along the near top corner.
   That two-tone split is the entire 2.5D illusion; a single-tone box reads flat.

---

## 4. Geometry and anchors

The engine works in a fixed 1600×900 basis; the renderer maps it by **×0.3** exactly. Useful
constants in canvas pixels:

| thing | canvas px |
|---|---|
| canvas | 480 × 270 |
| wall band | y 0 … 38 (`WALL_H`), floor from 38 down |
| pod seats (12) | x 110, 163, 378, 440 × y 100, 156, 212 — derive from `WAYPOINTS.podSeats`, never from this row |
| ceiling strip | 72 rows above the buffer's first row (`stage.ts`) — drawn, not letterboxed |
| manager seat | (293, 87) |
| coffee machine | (31, 68) |
| roundtable centre | (305, 190) |
| rug | x 262…348, y 154…232 |
| windows | centres x 72, 149, 278 |
| door | centre x 350, floor at y 36 |
| whiteboard | centre x 205, on the wall |
| desk sits above its seat by | 14 |

**Anchor rule, no exceptions:** every world draw function takes `(ctx, cx, yBase, …)` where `cx`
is the **horizontal centre** and `yBase` is the **bottom row the object occupies** — its contact
point with whatever it stands on. That is what lets the scene sort everything by `yBase` and get
correct occlusion for free. `drawArt` itself is the exception: it takes a top-left, because a
sprite has no idea what it is.

Wall fixtures use the same rule against the wall: `yBase` is their bottom row on the wall.

---

## 5. The self-review loop — not optional

Every module exports a `PREVIEW` array (`src/office/pixel/preview.ts`):

```ts
export const PREVIEW: PreviewItem[] = [
  { name: 'desk-pod', w: 48, h: 24, draw: (c) => drawDesk(c, 24, 23, 'pod') },
  { name: 'walk-s',   w: 18, h: 26, frames: 8, frameMs: 90,
    draw: (c, t) => drawChar(c, 9, 25, { act: 'walk', dir: 'front', look: DEMO, t }) },
];
```

Then:

```
npx tsx scripts/sheet.ts <yourmodule>      # writes .preview/<yourmodule>.png at 4x
```

**Open `.preview/<yourmodule>.png` with the Read tool and look at it.** Then fix what is wrong and
render again. Pixel art written without looking is wrong far more often than it is right, and
"it should look like a chair" is not evidence. Do at least three of these passes before you
report done; the last one must be a sheet you have actually viewed.

Give every sprite a `PREVIEW` entry, give every animation a `frames` strip, and put the character
poses on a common floor line so their heights can be compared.

Also run `npx tsc --noEmit` and make sure your file contributes no errors.

---

## 6. Module ownership

Import only `./art` and `./preview`. Do not edit any file but your own. Do not edit `art.ts`.
Do not run `npm run dev` (it is already running), do not commit, and do not write anything under
`~/.claude`.

### `environment.ts` — the room shell

```ts
export const WALL_H = 38;            // floor starts at this row
export const SKIRT_H = 3;
export function drawWall(ctx, night: number, t: number): void;    // fills y 0..WALL_H, full width
export function drawFloor(ctx, night: number): void;              // fills y WALL_H..270, full width
export const WINDOW: { w: number; h: number };                    // aim 34 x 30
export function drawWindow(ctx, cx: number, yBase: number, night: number, t: number): void;
export const DOOR: { w: number; h: number };                      // aim 22 x 32
export function drawDoor(ctx, cx: number, yBase: number, open: number): void;   // open 0..1 swing
export function drawWhiteboard(ctx, cx, yBase, lines: readonly string[]): void; // aim 62 x 30
export function drawWallArt(ctx, cx, yBase, variant: number): void;             // 3 variants
export function drawClock(ctx, cx, yBase, turn: number): void;                  // turn 0..1 = 12h
export function drawVent(ctx, cx, yBase): void;
export function drawRug(ctx, cx: number, cy: number): void;       // CENTRE anchor, aim 88 x 40
export function drawCeilingLamp(ctx, cx, yBase, night: number): void;  // the fixture only
export const PREVIEW: PreviewItem[];
```

Floor is warm brown planks running **horizontally** with a `fl4` seam every 8 rows and staggered
butt-joints, three plank tones mixed so it never tiles visibly. Wall is a flat-ish `wal` field
with a `wlt` lift toward the windows, a subtle horizontal panel line, `wtr` skirting `SKIRT_H`
tall at the bottom, and 2–3 rows of `wa3` ceiling shadow at the very top. `night` is 0 (day) to 1
(night) and shifts the window contents from bright sky to dark blue with a few `wht` stars, and
the wall from cool to warm.

### `furniture.ts` — the things people work at

```ts
export const DESK: { pod: { w: number; h: number }; manager: { w: number; h: number } };  // ~44x20, ~60x22
export function drawDesk(ctx, cx, yBase, kind: 'pod' | 'manager'): void;
export const CHAIR: { w: number; h: number };                    // aim 16 x 18
export function drawChair(ctx, cx, yBase, view: 'back' | 'front' | 'side', swivel: number): void;
export const MONITOR: { w: number; h: number; smallW: number; smallH: number }; // ~20x15, ~13x11
export function drawMonitor(ctx, cx, yBase, o: {
  on: boolean; tint: string; flicker: number; t: number; small?: boolean;
}): void;
export const TABLE: { w: number; h: number };                    // aim 58 x 26
export function drawRoundtable(ctx, cx, yBase): void;
export function drawTableChair(ctx, cx, yBase, view: 'back' | 'front' | 'side'): void;
export function drawCabinet(ctx, cx, yBase, variant: number): void;   // 3 variants, ~24x20
export function drawShelf(ctx, cx, yBase): void;                      // WALL shelf, books + plant
export function drawCounter(ctx, cx, yBase, w: number): void;         // kitchen run, tiled to w
export function drawFridge(ctx, cx, yBase): void;
export const PREVIEW: PreviewItem[];
```

Chairs are the modern high-backed kind from the reference: dark mesh back with a headrest, a
5-star base with castors, armrests. `swivel` is −1…1 and rotates the back slightly. `flicker` is
0…1 and modulates screen brightness; the screen carries 3–4 short code lines, the top one in
`tint` (a raw colour, passed through).

### `characters.ts` — the people

```ts
export const CHAR: { w: 16; h: 24 };
export type CharDir = 'front' | 'back' | 'side';
export type CharAct = 'idle' | 'walk' | 'sit' | 'type' | 'talk';
export type CharOpts = {
  act: CharAct; dir: CharDir; look: Look; t: number;
  flip?: boolean; alpha?: number; blink?: boolean; seed?: number; hairStyle?: number;
};
export function drawChar(ctx, cx: number, yFeet: number, o: CharOpts): void;
export const HAIR_STYLES: number;                     // how many distinct silhouettes exist
export function lookOf(a: { tint: string; color: string; skin: string; hair: string }): Look;
export const GHOST: { w: number; h: number };         // aim 10 x 13
export function drawGhost(ctx, cx, yFeet, look: Look, t: number, seed: number): void;
export function drawShadow(ctx, cx, yFeet, w: number, alpha?: number): void;
export const PREVIEW: PreviewItem[];
```

16 × 24 with the **feet at `yFeet`, centred on `cx`**. Roughly: head + hair rows 0–9, torso 10–17,
legs 18–22, shoes 23. `sit` draws a seated figure inside the same box — head lower, legs folded and
mostly hidden by the chair drawn behind it — so the anchor never changes.

- `idle` — 2 frames, a one-pixel breathing lift of the torso and head, ~2.6s cycle.
- `walk` — 4 frames, ~110ms each, arms and legs opposed, one-pixel body bob. It must actually read
  as walking in the preview strip.
- `sit` — breathing only.
- `type` — seated, forearms on the desk, hands alternating up/down every ~140ms.
- `talk` — standing, mouth open/closed and one arm gesturing, 2 frames.
- `blink` — closes the eyes to a 1px line for one frame when `blink` is true.

`dir: 'back'` is the view of someone facing their monitor (the seated default) — hair and shirt
only, no face. `dir: 'side'` faces **right**; the scene passes `flip` for left. `hairStyle` picks
between distinct silhouettes (short, bob, ponytail, buzz, curly, cap, long, bald+beard, …) so two
agents who hash to similar colours are still different people.

`lookOf` turns the store's muted agent colours into pixel-art `Look`s: **saturate them**, then
derive `skinShade`, `hairShade` and `shirtShade` as a darker version of each (roughly 65% toward
`out`). The store's palette is deliberately low-key for the DOM UI, and dropped into pixel art
unchanged it reads as mud.

### `props.ts` — clutter, bubbles, labels

```ts
export function drawMug(ctx, cx, yBase, hot: boolean): void;      // ~6x6
export function drawPapers(ctx, cx, yBase, n: number): void;
export function drawKeyboard(ctx, cx, yBase, pressed: number): void;   // pressed 0..1 lights keys
export function drawMouse(ctx, cx, yBase): void;
export function drawDeskLamp(ctx, cx, yBase, on: boolean): void;
export function drawBooks(ctx, cx, yBase): void;
export function drawBin(ctx, cx, yBase): void;
export function drawBox(ctx, cx, yBase): void;
export function drawPlant(ctx, cx, yBase, size: 0 | 1 | 2, sway: number): void;   // sway -1..1
export function drawHangingPlant(ctx, cx, yTop, sway: number): void;
export function drawCoffeeMachine(ctx, cx, yBase, on: boolean, t: number): void;
export function drawPrinter(ctx, cx, yBase, busy: number): void;   // busy 0..1 feeds a sheet out
export function drawWaterCooler(ctx, cx, yBase): void;
export function drawCoatRack(ctx, cx, yBase): void;
export function drawCable(ctx, x0, y0, x1, y1): void;              // slack cable, stepped catenary

export function measureBubble(text: string, maxW: number): { w: number; h: number; lines: string[] };
export function speechBubble(ctx, cx, yBase, text: string, o: {
  reveal?: number; verdict?: 'ok' | 'err'; maxW?: number;
}): void;                       // yBase = the tail's tip, i.e. just above the speaker's head
export function thoughtBubble(ctx, cx, yBase, text: string, t: number, maxW?: number): void;
export function nameplate(ctx, cx, yBase, name: string, color: string, o?: {
  sub?: string; selected?: boolean; dim?: boolean;
}): void;
export function emotePop(ctx, cx, yBase, kind: '!' | '?' | '...', age: number): void;  // age 0..1
export const PREVIEW: PreviewItem[];
```

Bubbles are the reference's boxy kind: a `pap` panel, a 1px `out` border, a 2px stepped tail, and
word-wrapped text drawn with `drawText`. `reveal` is 0…1 for the typewriter — `reveal: 0.5` shows
half the characters, and the **box does not resize** as it fills (measure the full text, reveal
into it), or the room will jitter. `verdict` tints the border `ok`/`err`. `thoughtBubble` is the
cloud kind with three trailing dots and an animated `…` inside. `nameplate` is the reference's
dark rounded label: an `out` box with a 1px `ou2` inner edge, the name in `color`, optional `sub`
line in `gry`, and a brighter border when `selected`.

### `effects.ts` — the air in the room

```ts
export function steam(ctx, cx, yBase, t: number, seed: number, strength?: number): void;
export function dust(ctx, x, y, w, h, t: number, density: number, alpha: number): void;
export function lightShaft(ctx, cx, yTop, yBot, wTop, wBot, color, alpha): void;
export function screenGlow(ctx, cx, cy, rx, ry, strength: number): void;
export function footPuff(ctx, cx, yBase, age: number): void;      // age 0..1
export function sparkle(ctx, cx, cy, t, seed): void;

export function flicker(t: number, seed: number): number;         // 0..1, screen brightness
export function sway(t: number, seed: number): number;            // -1..1, slow, for plants
export function breathe(t: number, seed: number): number;         // 0..1
export function blinkOn(t: number, seed: number): boolean;        // brief, irregular, per-seed
export function nightGrade(ctx, night: number): void;             // whole-canvas warm/cool grade
export function vignette(ctx, strength: number): void;
export const PREVIEW: PreviewItem[];
```

**No `Math.random()` and no `Date.now()` anywhere.** Every particle's position is a pure function
of `(t, seed, index)` — the simulation is deterministic and replayable, and the air in the room has
to be too. Use a small integer hash of the index for jitter. Particles must move in **whole
pixels**: a mote drifting at a third of a pixel per frame just shimmers.

---

## 7. What "done" means

- The module exports every signature above, with those exact names.
- `npx tsc --noEmit` reports nothing in your file.
- `npx tsx scripts/sheet.ts <module>` renders, and you have **looked at the PNG** and fixed it.
- Every sprite and every animation appears in `PREVIEW`.
- No `Math.random`, no `Date.now`, no imports beyond `./art` and `./preview`.
