/**
 * The people.
 *
 * A character is 16x24 with its feet on the row it is drawn at, and it is assembled from parts
 * rather than authored as one sprite per frame. Twenty-odd frames of a whole body would be six
 * hundred lines of art that nobody could correct without re-counting every row; a head, a hair
 * silhouette, a torso and a set of legs, composed with per-frame offsets, is a fifth of that and
 * every piece can be looked at on its own.
 *
 * The parts split along the lines identity actually falls on. What tells two agents apart at this
 * size is the **hair silhouette** first and the **shirt colour** second — a face is four pixels and
 * carries almost nothing — so hair is its own layer with eight genuinely different shapes, and the
 * colours arrive at draw time through `Look`. One body, twelve people.
 *
 * Then the body itself varies. Eight hair styles over one physique still read as one sprite drawn
 * twelve times, because the eye reads *outline* before it reads colour and every outline was the
 * same. Three heights, two builds and a handful of accessories multiply those eight silhouettes by
 * an order of magnitude for the cost of a few offsets — and headphones, which break the head's
 * outline on both sides, are worth more at this size than any amount of shading.
 *
 * `CHAR` stays 16x24 through all of it. It is the *box* — the tallest a person can be, and what the
 * scene uses for hit boxes and nameplates — while `charHeight(seed)` is the figure inside it. A
 * shorter person keeps their feet on `yFeet` and starts their head lower down.
 *
 * The walk is clocked by **distance travelled**, not by time. A cycle driven off `t` slides the
 * feet the instant anything changes speed — the character covers ground the cycle knows nothing
 * about, and at the start and end of every trip the shoes skate across the floor like a shop
 * mannequin on a trolley. `dist` is the only honest clock for a gait: one stride of travel is one
 * frame of leg, by construction, at any speed.
 *
 * And the cycle is phased and shaped per person. Twelve agents crossing the room on the same frame
 * index do not read as twelve people walking; they read as one animation playing twelve times, and
 * the eye catches that instantly even when it cannot say why. Stride length, bob and lean all come
 * out of the seed, so the room is a crowd rather than a chorus line. The same argument runs through
 * the idle schedule: everybody is a statue between events unless somebody occasionally stretches,
 * and twelve people stretching on the same frame is worse than twelve statues.
 *
 * Nothing here reads a clock or rolls a die: every frame index comes from the `t` and `dist` handed
 * in, and every per-person variation from an integer `seed`. The room has to replay identically.
 */
import { drawArt, PAL, pool, rect, type Art, type Look } from './art';
import type { PreviewItem } from './preview';

/**
 * The box a character occupies. Feet on the bottom row, centred horizontally.
 *
 * Not the height of any particular person — see `charHeight`. This is the envelope, and it is a
 * constant the scene lays nameplates and hit boxes out against, so it does not move.
 */
export const CHAR = { w: 16, h: 24 } as const;

export type CharDir = 'front' | 'back' | 'side';

/**
 * What somebody is doing, in the only vocabulary the sprite has.
 *
 * The first five are postures the room has always had. The rest exist because the office now knows
 * which *tool* an agent is running, and a room where twelve identical people sit identically can
 * answer "twelve agents exist" but not "is this going well". `read`, `gaze`, `handoff` and `wait`
 * are held for as long as the tool call runs; `cheer` and `slump` are reactions, played for well
 * under a second when one comes back.
 */
export type CharAct =
  | 'idle'
  | 'walk'
  | 'sit'
  | 'type'
  | 'talk'
  /** Seated, leaning back with a sheet held up, turning a page every few seconds. */
  | 'read'
  /** Standing, squared away from the camera, looking at something in the distance. */
  | 'gaze'
  /** Standing, one arm out with a clipboard — a `Task` call being handed over. */
  | 'handoff'
  /** Seated, hands behind the head, waiting on somebody else's work. */
  | 'wait'
  /** A fist-pump. */
  | 'cheer'
  /** Head in hands. */
  | 'slump'
  /**
   * Sitting on a stool at the break-corner table. Not `sit`: nothing is drawn in front of this
   * person, so the torso, the thighs and the shins all have to be there.
   */
  | 'perch'
  /** Holding a mug, raised to the mouth every few seconds. */
  | 'drink'
  /** A cigarette held down by the hip, raised for a drag, and a puff on the exhale. */
  | 'smoke'
  /** Two colleagues by the coffee machine: loose hands, shifting weight, a mouth of its own. */
  | 'chat';

/** What somebody is doing with an idle moment. */
export type IdleAct = 'rest' | 'stretch' | 'sip' | 'scratch' | 'lean' | 'spin';

/**
 * The seeded extra a person is wearing.
 *
 * Chosen to sit in four different places so they never fight each other or the hair: a beanie
 * replaces the crown, headphones clamp over whatever is underneath, glasses go on the face (and so
 * vanish from behind), a lanyard hangs on the chest.
 */
export type Accessory = 'none' | 'glasses' | 'headphones' | 'lanyard' | 'beanie';

export type CharOpts = {
  act: CharAct;
  dir: CharDir;
  look: Look;
  /** Animation time in ms — still the clock for breathing, blinking, typing and idle schedules. */
  t: number;
  /** Mirror horizontally — `dir: 'side'` faces right, so left is this flag. */
  flip?: boolean;
  alpha?: number;
  /** Eyes closed this frame. The scene owns the schedule so nobody blinks in unison. */
  blink?: boolean;
  /** Per-person phase offset, so twelve people do not breathe — or step — as one. */
  seed?: number;
  hairStyle?: number;
  /**
   * Canvas pixels walked so far. THE WALK CYCLE'S ONLY CLOCK — never `t`.
   * Undefined falls back to the old time-driven behaviour so nothing breaks mid-wiring.
   */
  dist?: number;
  /** 0..1 — fraction of full walking speed. Shortens the stride and straightens the lean near 0. */
  speed?: number;
  /** True for the couple of frames a change of facing takes. */
  turning?: boolean;
  /**
   * Head turned toward whoever is speaking: -1 left, 1 right, 0 straight ahead.
   *
   * One pixel of head and a shifted pupil. Two pixels looks like a broken neck — the head is ten
   * wide and the neck is two, so the second pixel puts the skull clear of the body it sits on.
   */
  glance?: -1 | 0 | 1;
  /**
   * Whether a reaction (`cheer`, `slump`) is happening in a chair. Ignored for every other act,
   * which already knows whether it is seated. Defaults to standing.
   */
  seated?: boolean;
  /** Overrides for the seeded body. The scene never needs these; the contact sheet does. */
  height?: number;
  build?: 0 | 1;
  accessory?: Accessory;
  /** Forces one idle micro-action, for previewing them. Otherwise `idleAct` decides. */
  idle?: IdleAct;
};

/**
 * How the body is oriented for this frame.
 *
 * `q34` and `q34b` are the three-quarter poses, front-ish and back-ish. They are not `CharDir`
 * values — the caller never asks for them by name, it asks for `turning` and gets whichever of the
 * two lies between the facing it has and the facing it is heading for.
 */
type Pose = 'front' | 'back' | 'side' | 'q34' | 'q34b';

/** The room's walking speed in canvas pixels per second: 150 scene px/s times the x0.3 basis. */
const WALK_PX_PER_S = 45;

// --------------------------------------------------------------------- parts

/**
 * The head, 10 wide and drawn at sprite x+3.
 *
 * Rows 0-7 are the skull, row 8 the jaw's shadow. The face is drawn on top rather than baked in,
 * because eyes that blink and a mouth that opens are two pixels each and would otherwise multiply
 * the head into six near-identical sprites.
 */
const HEAD: Art = {
  rows: [
    '..oooooo..',
    '.oSSSSSSo.',
    'oSSSSSSSSo',
    'oSSSSSSSSo',
    'oSSSSSSSSo',
    'oSSSSSSSSo',
    '.oSSSSSSo.',
    '..oSSSSo..',
    '...ssss...',
  ],
  map: { o: 'out' },
};

/** The back of a head is all hair, so the skin shape is filled with the hair slot instead. */
const HEAD_BACK: Art = {
  rows: [
    '..oooooo..',
    '.oHHHHHHo.',
    'oHHHHHHHHo',
    'oHHHHHHHHo',
    'oHHHHHHHHo',
    'oHHHHHHHHo',
    '.oHHHHHHo.',
    '..ohhhho..',
    '...ssss...',
  ],
  map: { o: 'out' },
};

/**
 * Hair, 12 wide and drawn at sprite x+2 so it can overhang the skull by a pixel on each side.
 *
 * These are the eight silhouettes the room tells people apart by. They deliberately differ in
 * *outline* — height, width, what hangs below the jaw — and not merely in how they are shaded: two
 * agents whose ids hash to similar colours still have to be two people.
 */
const HAIR: readonly Art[] = [
  // 0 — short crop
  {
    rows: ['...oooooo...', '..oHHHHHHo..', '.oHHHHHHHHo.', '.oHHhhhhHHo.', '..H......H..'],
    map: { o: 'out' },
  },
  // 1 — bob with a fringe, squared off at the jaw
  {
    rows: [
      '...oooooo...',
      '..oHHHHHHo..',
      '.oHHHHHHHHo.',
      'oHHHHHHHHHHo',
      'oHHhhhhhhHHo',
      'oHHo....oHHo',
      'oHHo....oHHo',
      '.oo......oo.',
    ],
    map: { o: 'out' },
  },
  // 2 — high ponytail
  {
    rows: [
      '.....oo.....',
      '...ooHHoo...',
      '..oHHHHHHo..',
      '.oHHHHHHHHo.',
      '.oHHhhhhHHo.',
      '..H......H..',
      '.........HH.',
      '.........HH.',
      '..........h.',
    ],
    map: { o: 'out' },
  },
  // 3 — buzz cut, barely more than a shadow on the skull
  {
    rows: ['...oooooo...', '..ohhhhhho..', '.ohHHHHHHho.', '..hhhhhhhh..'],
    map: { o: 'out' },
  },
  // 4 — curly, wide and tall
  {
    rows: [
      '..oo.oo.oo..',
      '.oHHoHHoHHo.',
      'oHHHHHHHHHHo',
      'oHHHHHHHHHHo',
      'oHHhhhhhhHHo',
      'oHHo....oHHo',
      '.oo......oo.',
    ],
    map: { o: 'out' },
  },
  // 5 — a cap, with a brim over the brow
  {
    rows: ['...oooooo...', '..oHHHHHHo..', '.oHHHHHHHHo.', 'oHHHHHHHHHHo', 'ohhhhhhhhhho', '.oooooooooo.'],
    map: { o: 'out' },
  },
  // 6 — long, past the shoulders
  {
    rows: [
      '...oooooo...',
      '..oHHHHHHo..',
      '.oHHHHHHHHo.',
      'oHHHHHHHHHHo',
      'oHHhhhhhhHHo',
      'oHHo....oHHo',
      'oHHo....oHHo',
      'oHHo....oHHo',
      'ohHo....oHho',
      '.oo......oo.',
    ],
    map: { o: 'out' },
  },
  // 7 — bald on top, with a beard. Twelve wide like the rest: the first version was ten, which
  // shifted the whole style two pixels left and hung the beard off the side of the jaw.
  {
    rows: [
      '............',
      '............',
      '............',
      '............',
      '...h....h...',
      '...hHHHHh...',
      '...HHHHHH...',
      '....HHHH....',
    ],
    map: { o: 'out' },
  },
];

export const HAIR_STYLES = HAIR.length;

/**
 * The torso, 8 wide at sprite x+4 — narrow on purpose, because the arms are drawn beside it.
 *
 * The first version of this made the torso twelve wide and then drew the arms on top of it, which
 * put them entirely inside the silhouette: every character came out as one flat slab of shirt with
 * no limbs at all. An arm has to break the outline to exist.
 */
const TORSO: Art = {
  rows: [
    '.oooooo.',
    'oTTTTTTo',
    'oTtTTtTo',
    'oTTTTTTo',
    'oTTTTTTo',
    'oTTTTtTo',
    'oTTTTtTo',
    'oPPPPPPo',
  ],
  map: { o: 'out' },
};

/** From behind: no collar notch, and a seam down the middle instead. */
const TORSO_BACK: Art = {
  rows: [
    '.oooooo.',
    'oTTTTTTo',
    'oTTTtTTo',
    'oTTTtTTo',
    'oTTTtTTo',
    'oTTTtTTo',
    'oTTTtTTo',
    'oPPPPPPo',
  ],
  map: { o: 'out' },
};

/** Edge-on: narrower, and shaded down the trailing side. */
const TORSO_SIDE: Art = {
  rows: [
    '..oooo..',
    '.oTTTTo.',
    '.oTTTto.',
    '.oTTTto.',
    '.oTTTto.',
    '.oTTTto.',
    '.oTTTto.',
    '.oPPPPo.',
  ],
  map: { o: 'out' },
};

/**
 * Three-quarter: one pixel narrower than the front and pushed off-centre, with the whole trailing
 * edge in shadow.
 *
 * A body turning is a body that is *asymmetric*, and this is the cheapest way to say so at this
 * size. A symmetric in-between torso reads as the front view drawn slightly wrong; an off-centre
 * one reads as a shoulder coming toward the camera.
 */
const TORSO_34: Art = {
  rows: [
    '.ooooo..',
    'oTTTTTo.',
    'oTtTTto.',
    'oTTTTto.',
    'oTTTTto.',
    'oTTTTto.',
    'oTTTTto.',
    'oPPPPPo.',
  ],
  map: { o: 'out' },
};

/** Legs, 8 wide at sprite x+4. Six rows: hips, four of leg, and a shoe. */
const LEGS_STAND: Art = {
  rows: ['oPPPPPPo', 'oPP..PPo', 'oPP..PPo', 'oPP..PPo', 'oPP..PPo', 'kkk..kkk'],
  map: { k: 'out', o: 'out' },
};

/**
 * The four-frame walk: contact, passing, the opposite contact, passing again.
 *
 * Frames 0 and 2 have to put the *other* leg forward. Written as one splayed pose used twice they
 * are a palindrome — the legs scissor open, shut, open the same way, shut — and the eye reads a
 * shiver rather than a walk. (The previous version carried a note saying this was fixed, and a
 * `P: 'out'` entry in frame 0's map that looked like the fix; `P` is a reserved slot, so `drawArt`
 * resolves it from the `Look` and never consults the map at all. The two frames were byte for byte
 * identical. They are now genuinely mirrored.)
 */
const LEGS_WALK: readonly Art[] = [
  // 0 — contact, leading leg swung forward (to the right; `flip` handles the other way)
  {
    rows: ['oPPPPPPo', 'oPP..PPo', 'oPP..PPo', 'oPP...PP', '.PP...PP', '.kk...kk'],
    map: { k: 'out', o: 'out' },
  },
  // 1 — passing, legs together under the hips
  {
    rows: ['oPPPPPPo', '.oPPPPo.', '.oPPPPo.', '.oPPPPo.', '.oPP.PPo', '.kk..kk.'],
    map: { k: 'out', o: 'out' },
  },
  // 2 — the opposite contact: frame 0 mirrored, so the trailing leg is now the one out front
  {
    rows: ['oPPPPPPo', 'oPP..PPo', 'oPP..PPo', 'PP...PPo', 'PP...PP.', 'kk...kk.'],
    map: { k: 'out', o: 'out' },
  },
  // 3 — passing the other way
  {
    rows: ['oPPPPPPo', '.oPPPPo.', '.oPPPPo.', '.oPPPPo.', 'oPP.PPo.', '.kk..kk.'],
    map: { k: 'out', o: 'out' },
  },
];

/**
 * The same four frames with the contacts narrowed, for the ends of a trip.
 *
 * Somebody arriving at a desk is still cycling, but a full stride at a crawl looks like a mime
 * walking on the spot. Shortening the step is what makes the last metre read as settling rather
 * than as the animation being switched off.
 */
const LEGS_WALK_SHORT: readonly Art[] = [
  {
    rows: ['oPPPPPPo', 'oPP..PPo', 'oPP..PPo', 'oPP..PPo', '.PP..PPo', '.kk..kk.'],
    map: { k: 'out', o: 'out' },
  },
  LEGS_WALK[1],
  {
    rows: ['oPPPPPPo', 'oPP..PPo', 'oPP..PPo', 'oPP..PPo', 'oPP..PP.', '.kk..kk.'],
    map: { k: 'out', o: 'out' },
  },
  LEGS_WALK[3],
];

/** Seated: thighs forward toward the camera, shins dropping away under the desk. */
const LEGS_SIT: Art = {
  rows: ['oPPPPPPo', 'oPPPPPPo', 'oPP..PPo', 'oPP..PPo', '.k....k.', '........'],
  map: { k: 'out', o: 'out' },
};

// ------------------------------------------------------------- posture parts

/**
 * Both arms bent up with the hands behind the head — the `wait` pose, drawn at (x, headTop + 2).
 *
 * The elbows are the entire point. Hands behind the head, drawn inside the body's outline, is a
 * shape indistinguishable from arms hanging down; what a person actually recognises is two
 * triangles sticking out at ear height. So the art starts at the very edges of the 16px box on both
 * sides and works inward and down to the shoulders, and the hands themselves are never drawn at
 * all — they are behind the skull, which is drawn afterwards.
 */
const ARMS_WAIT: Art = {
  rows: [
    '.oo..........oo.',
    'oSS..........SSo',
    'oTT..........TTo',
    'oTT..........TTo',
    'oTt..........tTo',
    '.oTT........TTo.',
    '.oTT........TTo.',
    '..oTT......TTo..',
    '..oTT......TTo..',
  ],
  map: { o: 'out' },
};

/**
 * The hands of `slump`, drawn at (x, headTop + 2) — over the face, after the head.
 *
 * A face buried in hands is one of the few gestures that survives being four pixels tall, and it
 * survives it by *hiding* the face rather than by drawing a sad one. The two shade columns inside
 * the block are fingers; without them the band reads as a bandage.
 */
const SLUMP_HANDS: Art = {
  rows: [
    '....SSSSSSSS....',
    '...oSsSSSSsSo...',
    '...oSsSSSSsSo...',
    '...ossSSSSsso...',
  ],
  map: { o: 'out' },
};

/** The forearms and hunched shoulders under those hands, at (x, headTop + 6). */
const SLUMP_ARMS: Art = {
  rows: [
    '..otTo....oTto..',
    '.otTTo....oTTto.',
    '.oTTTo....oTTTo.',
    '.oTTo......oTTo.',
  ],
  map: { o: 'out' },
};

/**
 * The `handoff` arm and the clipboard hanging off it, drawn at (x, torsoTop) and mirrored by
 * `flip` like any other sprite.
 *
 * Authored as one Art rather than as a dozen `rect` calls precisely so that mirroring is free: the
 * arm, the hand and the board have to move together, and every hand-mirrored limb in this file has
 * at some point ended up on the wrong side of the body.
 */
const HANDOFF: Art = {
  rows: [
    '............oo..',
    '............TTo.',
    '............Tto.',
    '............SSSo',
    '...........oSso.',
    '...........ooooo',
    '...........oKKKo',
    '...........oaaao',
    '...........oaLao',
    '...........oaaao',
    '...........ooooo',
  ],
  map: { o: 'out', K: 'blk', a: 'pap', L: 'pa2' },
};

/** A mug and the forearm holding it, drawn at (x, mugTop). Cols 9-13, so `flip` puts it left. */
const MUG_ARM: Art = {
  rows: [
    '.........oooo...',
    '.........oWWoo..',
    '.........oWWoo..',
    '.........oggo...',
    '.........oooo...',
    '..........oSSo..',
    '..........oSSo..',
    '..........oTTo..',
    '..........oTTo..',
  ],
  map: { o: 'out', W: 'wht', g: 'gry' },
};

/** A beanie, 12 wide like the hair it sits on, drawn at (headX - 1, headTop - 2). */
const BEANIE: Art = {
  rows: [
    '....cccc....',
    '..ccBBBBcc..',
    '.cBBBBBBBBc.',
    'cbbbbbbbbbbc',
    '.cccccccccc.',
  ],
  map: { c: 'out', B: 'pot', b: 'po2' },
};

// ------------------------------------------------------- the break corner

/**
 * The stool a `perch` sits on, 12 wide at sprite x+2, with its feet on the bottom row.
 *
 * It is drawn by the character rather than by the furniture module for one reason: `yFeet` has to
 * keep meaning the same thing everywhere. A person on a stool is still a thing standing on the
 * floor at `yFeet`, and the only way to say that without a second anchor rule is to let the figure
 * carry its own seat.
 *
 * Seven rows is the whole budget. Head, neck, torso and a stool tall enough to read as a stool do
 * not fit in twenty-four rows at once — so the seat sits low, the legs splay, and the foot ring is
 * two rows off the floor where a real bar stool puts it.
 */
const STOOL_H = 8;

/**
 * Fourteen wide, which is wider than the person sitting on it, and that is the entire trick.
 *
 * The first version was twelve wide at x+2, under an eight-wide pair of thighs, and the sitter's
 * legs covered the seat, the splay and the ring — every pixel that says "stool" — leaving a figure
 * that read as standing with dark legs. Furniture has to be broader than its occupant or it is not
 * in the picture at all.
 */
const STOOL: Art = {
  rows: [
    '..oooooooooooo..',
    '.oWWWWWWWWWWWWo.',
    '.oDDDDDDDDDDDDo.',
    '....oM....Mo....',
    '...oM......Mo...',
    '..orrrrrrrrrro..',
    '..oM........Mo..',
    '.oM..........Mo.',
  ],
  map: { o: 'out', W: 'wdt', D: 'wdd', M: 'met', r: 'me3' },
};

/**
 * A perched pair of legs, 12 wide at sprite x+2, hung from the hips down to the foot ring.
 *
 * Two rows of thigh, two of shin and a row of shoe. That split is the entire difference between
 * this and `sit`: seated at a desk the shins are the chair's business and are simply not drawn,
 * and a break corner that reused `sit` would be a row of people cut off at the knee by nothing.
 */
const LEGS_PERCH: Art = {
  rows: [
    '....oPPPPPPo....',
    '...oPPPPPPPPo...',
    '...oPPo..oPPo...',
    '...oPPo..oPPo...',
    '...obbo..obbo...',
  ],
  map: { o: 'out', b: 'bl2' },
};

/** The same, edge-on: the thigh runs forward to a knee, and only the near shin and shoe show. */
const LEGS_PERCH_SIDE: Art = {
  rows: [
    '....oPPPPPo.....',
    '....oPPPPPPo....',
    '........oPPo....',
    '........oPPo....',
    '.......obbbbo...',
  ],
  map: { o: 'out', b: 'bl2' },
};

/**
 * The forearm of a raised cigarette, from the fingers at the mouth down to the shoulder, drawn at
 * (x, headTop + 7).
 *
 * The cigarette itself is not in here. It has to land on the mouth, and the mouth moves with the
 * seeded head carriage while the shoulder does not — one sprite spanning both would tear at one end
 * or the other, so the three pixels that matter are drawn separately and the arm stays welded on.
 */
const CIG_HAND: Art = {
  rows: [
    '.........oSSo...',
    '.........oSSo...',
    '..........oSSo..',
    '..........oSSo..',
    '..........oTTo..',
    '..........oTTo..',
  ],
  map: { o: 'out' },
};

/**
 * The same hand hanging by the hip, drawn at (x, torsoY), with the cigarette dangling off the
 * fingers.
 *
 * The arm's geometry is copied from `arm()` exactly — cap at row 1, cuff at row 4, outline at row
 * 9 — so that swapping between this and the ordinary hanging arm is invisible. What it buys is the
 * two paper pixels and the lit one, which cannot be placed by hand on both sides of the body
 * without the mirroring going wrong, and has, twice.
 */
const CIG_DOWN: Art = {
  rows: [
    '................',
    '............ooo.',
    '............TTo.',
    '............TTo.',
    '............tto.',
    '............SSo.',
    '............SSo.',
    '............SSo.',
    '............SSo.',
    '............oo..',
    '.............WW.',
    '..............e.',
  ],
  map: { o: 'out', W: 'wht', e: 'lm2' },
};

// --------------------------------------------------------------------- looks

/** `#rrggbb` to its three components. */
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** Mixes toward a target colour. `k` is how far, 0 to 1. */
function mix(a: string, b: string, k: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return hex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k);
}

/**
 * Pushes a colour away from grey without moving its hue.
 *
 * The store's palette is deliberately low-key, because in the DOM shell the only saturated thing
 * is meant to be a verdict. Dropped into pixel art unchanged those shirts read as mud: a small
 * palette needs its colours to be *decided*, and a desaturated mid-tone next to a hard black
 * outline just looks like a mistake.
 */
function punch(color: string, amount: number): string {
  const [r, g, b] = rgb(color);
  const mid = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  return hex(mid + (r - mid) * amount, mid + (g - mid) * amount, mid + (b - mid) * amount);
}

/** The store's four muted colours, resolved into the seven slots a sprite needs. */
export function lookOf(a: { tint: string; color: string; skin: string; hair: string }): Look {
  const shirt = punch(a.tint, 1.75);
  const skin = punch(a.skin, 1.15);
  return {
    skin,
    skinShade: mix(skin, PAL.out, 0.42),
    hair: a.hair,
    hairShade: mix(a.hair, PAL.out, 0.5),
    shirt,
    shirtShade: mix(shirt, PAL.out, 0.4),
    // Everyone wears the same dark trousers, which is both true of offices and the thing that
    // keeps twelve saturated shirts from turning the room into a paint chart.
    trouser: '#2c3444',
  };
}

// ------------------------------------------------------------------ the draw

/** A tiny integer hash, for per-person phase offsets. */
const jitter = (seed: number): number => ((seed * 2654435761) >>> 8) % 1000;

/**
 * A second hash, salted, so one seed can yield several independent numbers.
 *
 * `jitter` alone gives a person exactly one dial; a gait needs four (stride, bob, lean, phase) and
 * deriving them from slices of the same thousand correlates them — everyone with a long stride
 * would also lean, which is a caricature rather than a crowd. `Math.imul` keeps the arithmetic in
 * exact 32-bit territory whatever integer the scene hands in, so this stays replayable.
 */
function hash(seed: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ Math.imul(salt, 0x27d4eb2d), 0x9e3779b1);
  h ^= h >>> 15;
  return (Math.imul(h, 0x85ebca6b) >>> 8) % 1000;
}

/**
 * `hash` spread across an arbitrary range instead of across the 0..999 it returns.
 *
 * This is not a nicety. Every schedule in this file offsets a multi-second period by a per-person
 * phase, and `hash(seed, salt) % period` with a period of five thousand and a hash of a thousand is
 * the identity — so the phase only ever covered the first second, every idle schedule in the room
 * started inside its own window at t=0, and twelve people stretched in perfect unison at the exact
 * moment the room opened. Which is the failure the phasing exists to prevent.
 */
const spread = (seed: number, salt: number, range: number): number =>
  Math.floor((hash(seed, salt) * range) / 1000);

/** 0 or 1: the slow breathing lift, on a ~2.6s cycle offset per person. */
const breath = (t: number, seed: number): number =>
  Math.sin((t + jitter(seed) * 2.6) / 414) > 0.35 ? 1 : 0;

/**
 * One person's walk, from their seed. `stride` is canvas pixels of travel per animation frame
 * (the four-frame cycle therefore also *takes* longer or shorter per person — at a fixed walking
 * speed, stride length and cycle length are one knob, not two).
 *
 * The average is deliberately pinned at 5px, which is the room's 45 canvas px/s over the old
 * 110ms frame. Tempo is a property of the office, not of the person; what varies is who covers
 * that ground in long lazy paces and who does it in a quick short-stepped scurry.
 */
export function gaitOf(seed: number): {
  stride: number;
  bob: number;
  lean: number;
  swing: number;
  armPhase: number;
} {
  // 3.6 .. 6.4 in eight even steps, mean still exactly 5. The old range was 4.2 .. 5.8, which is
  // plus or minus sixteen percent — a difference you can measure and cannot see. Two people side
  // by side now genuinely fall out of step within a couple of strides.
  const stride = 3.6 + (hash(seed, 1) % 8) * (2.8 / 7);
  // One in eight glides, five bob a pixel, two bounce two. A two-pixel bob on a 24-pixel figure is
  // a lot, which is the point: it is the walk you can pick out of a crowd from the far wall.
  const b = hash(seed, 2) % 8;
  const bob = b === 0 ? 0 : b < 6 ? 1 : 2;
  // -1 to 2. Slightly forward-biased, because walking people are.
  const lean = [-1, -1, 0, 0, 1, 1, 2, 2][hash(seed, 3) % 8];
  // How far the arms swing, in pixels of lift on the forward stroke. The back stroke stays at one
  // whatever this is: an arm that swings *down* by three ends up inside the shin.
  const swing = 1 + (hash(seed, 5) % 3);
  // Half a frame of arm lead for half the room, so the arms are not bolted to the legs. Whole
  // frames would read as a mistake; half lands the arm's turnaround inside a leg frame, which is
  // what an unhurried walk actually does.
  const armPhase = hash(seed, 6) % 2 === 0 ? 0 : 0.5;
  return { stride, bob, lean, swing, armPhase };
}

/** Where in the four-frame cycle this person starts, in frames. Kills the lockstep. */
const walkPhase = (seed: number): number => hash(seed, 4) / 250;

/**
 * How this person carries their head: -1 chin up and proud, 0 level, 1 sunk into the shoulders.
 *
 * One pixel, and it is the cheapest per-person difference in the file — it costs no art, applies to
 * every act at once, and posture is the thing the eye reads at this size after silhouette. Twelve
 * agents with the same head on the same shoulders are twelve copies however different their hair is.
 */
function headCarry(seed: number): -1 | 0 | 1 {
  const r = hash(seed, 43) % 6;
  return r < 2 ? -1 : r < 4 ? 0 : 1;
}

// ------------------------------------------------------------------ the body

/**
 * How tall this person actually is, inside the 16x24 box. 21 to 24, weighted toward the top.
 *
 * A real office is not two heads shorter at one desk than the next, so the spread is deliberately
 * small and lopsided: most people are 23 or 24 and a short person is the exception. Three pixels
 * is enough — at this scale the eye compares heads against a common floor line and notices one row.
 */
export function charHeight(seed: number): number {
  const r = hash(seed, 40) % 10;
  return r < 4 ? 24 : r < 7 ? 23 : r < 9 ? 22 : 21;
}

/** 0 slim, 1 broad. One pixel of shoulder on each side, which is all this size can carry. */
export function charBuild(seed: number): 0 | 1 {
  return hash(seed, 41) % 2 === 0 ? 0 : 1;
}

/** What this person is wearing on top of their hair. Most people wear nothing. */
export function accessoryOf(seed: number): Accessory {
  const r = hash(seed, 42) % 12;
  if (r < 5) return 'none';
  if (r < 7) return 'glasses';
  if (r < 9) return 'headphones';
  if (r < 11) return 'lanyard';
  return 'beanie';
}

// -------------------------------------------------------------- idle moments

const IDLE_ACTS = ['stretch', 'sip', 'scratch', 'lean', 'spin'] as const;
/** How long one micro-action runs, and how long one of its eight frames lasts. */
const IDLE_MS = 960;
const IDLE_FRAME_MS = 120;
const IDLE_FRAMES = 8;

/**
 * The micro-action *and* the frame within it. `idleAct` is the public half; the frame stays
 * private because a caller that wanted it would be re-deriving the pose, which is this file's job.
 */
function idleSlot(t: number, seed: number): { act: IdleAct; frame: number } {
  // Between five and eleven seconds per person, so twelve people never come round together.
  const period = 5200 + (hash(seed, 20) % 9) * 700;
  const shifted = t + spread(seed, 21, period);
  const n = Math.floor(shifted / period);
  const u = shifted - n * period;
  if (u >= IDLE_MS) return { act: 'rest', frame: 0 };
  return {
    // Salting with the repetition index is what stops one person doing the same thing forever.
    act: IDLE_ACTS[hash(seed + n * 7919, 22) % IDLE_ACTS.length],
    frame: Math.min(IDLE_FRAMES - 1, Math.floor(u / IDLE_FRAME_MS)),
  };
}

/**
 * What this person is doing with an idle moment, at time `t`. Pure, seeded, no clock.
 *
 * `drawChar` calls this itself for `idle` and `sit`; the scene calls it too, because two of these
 * are not only a change of pose — `spin` has to swivel the chair, which another module draws, and
 * `sip` wants a mug that came off a desk.
 */
export function idleAct(t: number, seed: number): IdleAct {
  return idleSlot(t, seed).act;
}

/**
 * Frame-by-frame fist heights for the raised-arm idles, relative to the head's top row.
 *
 * The first and last frames sit down at shoulder height on purpose: an eight-frame action that
 * *starts* with the arms already up is a pop, not a stretch, and next to eleven people standing
 * still a pop is the only thing anybody sees.
 */
const STRETCH_FIST = [8, 3, -1, -2, -2, -1, 3, 8] as const;
const SCRATCH_FIST = [9, 4, 1, 0, 1, 0, 4, 9] as const;
/** Which frames of `sip` have the mug at the mouth rather than down at the chest. */
const SIP_DRINK = [0, 0, 1, 1, 1, 1, 0, 0] as const;
/** A full swivel: out to the camera and back, ending on the facing it started from. */
const SPIN_RING: readonly Pose[] = ['back', 'q34b', 'side', 'q34', 'front', 'q34', 'side', 'q34b'];

/**
 * Which foot somebody standing has their weight on. 0 or 1, on a slow seeded cycle.
 *
 * A standing figure that never moves reads as furniture. One pixel every few seconds is under the
 * threshold of "that sprite is animating" and over the threshold of "that is a person".
 */
function weightShift(t: number, seed: number): number {
  const period = 3200 + (hash(seed, 30) % 6) * 540;
  const shifted = t + spread(seed, 31, period);
  return Math.abs(Math.floor(shifted / (period / 2))) % 2;
}

/** The page-turn schedule for `read`: a short flick every four seconds or so. */
function pageTurn(t: number, seed: number): boolean {
  const period = 3400 + (hash(seed, 33) % 5) * 420;
  const shifted = t + spread(seed, 34, period);
  return shifted - Math.floor(shifted / period) * period < 380;
}

// --------------------------------------------------- the break corner's clocks

/** Milliseconds into this person's own copy of a `period`-long cycle. Pure, seeded, no clock. */
function phaseOf(t: number, seed: number, salt: number, period: number): number {
  const shifted = t + spread(seed, salt, period);
  return shifted - Math.floor(shifted / period) * period;
}

/**
 * Where a `drink` mug is: 0 at the chest, 1 on its way, 2 at the mouth.
 *
 * The middle step is not decoration. A mug that teleports between the chest and the lips reads as
 * a sprite swap, and next to `type` — whose whole tell is hands snapping up and down — a two-state
 * drink is exactly the thing it must not be mistaken for.
 */
function drinkPhase(t: number, seed: number): 0 | 1 | 2 {
  const u = phaseOf(t, seed, 36, 3600 + (hash(seed, 35) % 7) * 480);
  if (u < 200) return 1;
  if (u < 1100) return 2;
  if (u < 1300) return 1;
  return 0;
}

/**
 * The smoking cycle: the hand comes up, holds for a drag, goes back down, and a moment later the
 * exhale drifts out. `exhale` is 0..1 across the puff, or -1 for the rest of the cycle.
 *
 * The gap between the drag and the puff is what sells it. Smoke leaving the mouth at the same
 * instant the cigarette does reads as a hiccup; a beat of nothing in between reads as a lungful.
 */
function smokePhase(t: number, seed: number): { up: boolean; exhale: number } {
  const period = 5200 + (hash(seed, 37) % 8) * 520;
  const u = phaseOf(t, seed, 38, period);
  return { up: u >= 300 && u < 1400, exhale: u >= 1750 && u < 2950 ? (u - 1750) / 1200 : -1 };
}

/**
 * Which of the six `chat` gesture beats this frame is on.
 *
 * 190ms a beat over six beats, against `talk`'s 220ms over two. The periods are deliberately not
 * multiples of each other: a break corner and a desk report visible in the same frame must not
 * find a common beat, or the whole room pulses.
 */
const chatBeat = (t: number, seed: number): number =>
  Math.floor(phaseOf(t, seed, 46, 1140) / 190) % 6;

/** The mouth of somebody chatting: open two ticks in three, on a beat `talk` never lands on. */
const chatMouth = (t: number, seed: number): boolean =>
  Math.floor(phaseOf(t, seed, 45, 780) / 260) % 3 !== 0;

/** The weight shift of somebody standing in a conversation — twice the tempo of standing alone. */
function chatShift(t: number, seed: number): number {
  const period = 1500 + (hash(seed, 39) % 5) * 260;
  return phaseOf(t, seed, 44, period) < period / 2 ? 0 : 1;
}

/**
 * The gesture heights of the six `chat` beats, as [far arm, near arm] lift.
 *
 * Both arms move, and further than `talk` ever does. `talk` is a person reporting: one hand, held
 * politely, mostly still. This is two people by the coffee machine, and the difference the eye
 * actually catches is not the mouth — it is how much air the hands are moving.
 */
const CHAT_LIFT: readonly (readonly [number, number])[] = [
  [-1, -3],
  [1, 0],
  [-3, -1],
  [0, -3],
  [-2, 1],
  [1, -2],
];

/**
 * The exhale: three pixels of grey stepping up and away from the mouth, and gone.
 *
 * Drawn here rather than handed to the effects module because it belongs to a person rather than
 * to the air — it has to mirror with them, fade with their alpha, and never outlive the act. And it
 * stays this small on purpose: the head is ten pixels wide, and anything worth calling a cloud
 * swallows it.
 */
function exhale(
  ctx: CanvasRenderingContext2D,
  ux: number,
  mouthY: number,
  p: number,
  flip: boolean,
): void {
  // Four whole steps. A puff drifting a third of a pixel a frame shimmers instead of moving.
  const k = Math.min(3, Math.max(0, Math.floor(p * 4)));
  const px = (dx: number, w: number): number => (flip ? ux + CHAR.w - dx - w : ux + dx);
  const a = (1 - p) * 0.9;
  rect(ctx, px(10 + k, 2), mouthY - 1 - k * 2, 2, 1, PAL.gry, a);
  if (k >= 1) rect(ctx, px(11 + k, 2), mouthY - 2 - k * 2, 2, 1, PAL.gry, a * 0.7);
  if (k >= 2) rect(ctx, px(12 + k, 1), mouthY - 3 - k * 2, 1, 1, PAL.gry, a * 0.5);
}

/** The head is ten wide, and a turned face is placed against its edges rather than its centre. */
const HEAD_W = 10;

/**
 * The eyes, and the mouth when talking. Drawn over the head rather than baked into it.
 *
 * The turned poses mirror with `flip`. They have to: `drawArt` mirrors each part inside its own
 * width, but a face is `rect` calls at absolute offsets, and left over unflipped offsets a
 * character walking left wore its eye and its nose on the back of its head.
 */
function face(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  pose: Pose,
  look: Look,
  blink: boolean,
  mouthOpen: boolean,
  flip: boolean,
  glance = 0,
): void {
  if (pose === 'back' || pose === 'q34b') return;
  const eye = PAL.out;
  /** An offset and width in head space, mirrored when the head is. */
  const fx = (dx: number, w: number): number => (flip ? x + HEAD_W - dx - w : x + dx);
  if (pose === 'front') {
    if (blink) {
      rect(ctx, x + 4, y + 4, 2, 1, eye);
      rect(ctx, x + 8, y + 4, 2, 1, eye);
    } else {
      rect(ctx, x + 4, y + 3, 2, 2, eye);
      rect(ctx, x + 8, y + 3, 2, 2, eye);
      // The glint is the pupil. Moving it to the leading edge of each eye is the whole of a
      // sideways look — the eye rects themselves cannot move, because the right one already sits
      // on the head's outline column and a pixel further would be off the face.
      const g = glance < 0 ? 0 : 1;
      rect(ctx, x + 4 + g, y + 3, 1, 1, PAL.wht);
      rect(ctx, x + 8 + g, y + 3, 1, 1, PAL.wht);
    }
    rect(ctx, x + 6 + glance, y + 5, 2, 1, look.skinShade); // the nose, such as it is
    if (mouthOpen) rect(ctx, x + 6, y + 6, 2, 2, PAL.out);
    else rect(ctx, x + 6, y + 7, 2, 1, look.skinShade);
    return;
  }
  if (pose === 'q34') {
    // Three-quarter: the far eye is foreshortened to a single pixel, both eyes crowd toward the
    // near side, and the nose breaks the silhouette by one. That last pixel is what stops this
    // reading as the front view with the eyes mis-drawn.
    //
    // The near eye sits at 6, not at 7: the sideburn pixel most hair styles put at head column 8
    // is drawn *after* the face, and at 7 it ate half of it — leaving two one-pixel eyes, which is
    // exactly the front view again.
    if (blink) {
      rect(ctx, fx(3, 1), y + 4, 1, 1, eye);
      rect(ctx, fx(6, 2), y + 4, 2, 1, eye);
    } else {
      rect(ctx, fx(3, 1), y + 3, 1, 2, eye);
      rect(ctx, fx(6, 2), y + 3, 2, 2, eye);
      rect(ctx, fx(6, 1), y + 3, 1, 1, PAL.wht);
    }
    rect(ctx, fx(10, 1), y + 5, 1, 2, look.skin);
    rect(ctx, fx(11, 1), y + 5, 1, 2, PAL.out); // the nose, proud of the head but short of the side
    if (mouthOpen) rect(ctx, fx(6, 2), y + 6, 2, 2, PAL.out);
    else rect(ctx, fx(6, 2), y + 7, 2, 1, look.skinShade);
    return;
  }
  // Side: one eye, and a nose that breaks the silhouette so the head reads as turned.
  if (blink) rect(ctx, fx(8, 2), y + 4, 2, 1, eye);
  else {
    rect(ctx, fx(8, 2), y + 3, 2, 2, eye);
    rect(ctx, fx(9, 1), y + 3, 1, 1, PAL.wht);
  }
  rect(ctx, fx(11, 1), y + 4, 1, 2, look.skin);
  rect(ctx, fx(12, 1), y + 4, 1, 2, PAL.out);
  if (mouthOpen) rect(ctx, fx(8, 2), y + 6, 2, 2, PAL.out);
}

/**
 * One arm: a sleeve, a forearm and a hand, two pixels wide, drawn *beside* the torso.
 *
 * `outerLeft` says which side the silhouette's outline goes on, so the arm reads as an edge of the
 * body rather than as a stripe painted on it. `reach` shortens it — a hand on a desk or held out
 * while speaking is foreshortened, and a full-length arm there reads as a dangling limb.
 */
function arm(
  ctx: CanvasRenderingContext2D,
  ax: number,
  top: number,
  look: Look,
  outerLeft: boolean,
  reach: boolean,
): void {
  const len = reach ? 5 : 7;
  rect(ctx, ax, top - 1, 2, 1, PAL.out); // shoulder cap
  rect(ctx, ax, top, 2, 3, look.shirt);
  rect(ctx, ax, top + 2, 2, 1, look.shirtShade); // cuff
  rect(ctx, ax, top + 3, 2, len - 3, look.skin);
  rect(ctx, ax, top + len, 2, 1, PAL.out);
  rect(ctx, ax + (outerLeft ? -1 : 2), top - 1, 1, len + 1, PAL.out);
}

/**
 * An arm thrown straight up, from a fist at `fistY` down to the shoulder — `cheer`, `stretch` and
 * `scratch` are all this shape with a different fist height.
 *
 * Outlined on *both* sides, unlike a hanging arm: it is raised clear of the body, so neither edge
 * of it is the body's edge, and one-sided outlining left it looking welded to the head.
 */
function raisedArm(
  ctx: CanvasRenderingContext2D,
  ax: number,
  fistY: number,
  shoulderY: number,
  look: Look,
): void {
  const h = Math.max(6, shoulderY - fistY);
  rect(ctx, ax - 1, fistY - 1, 4, 1, PAL.out);
  rect(ctx, ax - 1, fistY, 1, h, PAL.out);
  rect(ctx, ax + 2, fistY, 1, h, PAL.out);
  rect(ctx, ax, fistY, 2, 2, look.skin);
  rect(ctx, ax, fistY + 2, 2, 1, look.skinShade); // knuckles
  rect(ctx, ax, fistY + 3, 2, 2, look.skin);
  rect(ctx, ax, fistY + 5, 2, 1, look.shirtShade); // cuff
  rect(ctx, ax, fistY + 6, 2, h - 6, look.shirt);
}

/**
 * Both arms, at the per-frame offsets the pose asks for.
 *
 * Mirrored by hand for the same reason the face is: these are `rect` calls at absolute offsets, and
 * a side view drawn unflipped hung its one visible arm off the far side of the body.
 *
 * `spread` pushes both arms a pixel outward for a broad build, and `skipNear` leaves the near one
 * off entirely for the postures that replace it with something else — a raised fist, a clipboard,
 * a mug.
 */
function arms(
  ctx: CanvasRenderingContext2D,
  x: number,
  torsoY: number,
  pose: Pose,
  look: Look,
  lift: readonly [number, number],
  reach: boolean,
  flip: boolean,
  spread = 0,
  skipNear = false,
): void {
  const top = torsoY + 2;
  /** A 2px-wide arm's offset in the 16px box, mirrored when the body is. */
  const ax = (dx: number): number => (flip ? x + CHAR.w - dx - 2 : x + dx);
  if (pose === 'side') {
    // Edge-on, only the near arm is worth drawing; the far one is behind the body.
    if (!skipNear) arm(ctx, ax(9), top + lift[0], look, flip, reach);
    return;
  }
  if (pose === 'q34' || pose === 'q34b') {
    // The near arm rides in a pixel with the shoulder it hangs from, and the far shoulder drops a
    // row because it is further away. That dropped row is most of what the turn is made of — a
    // torso one pixel narrower on its own would just read as a smaller person.
    arm(ctx, ax(2 - spread), top + lift[0] + 1, look, !flip, reach);
    if (!skipNear) arm(ctx, ax(11 + spread), top + lift[1], look, flip, reach);
    return;
  }
  arm(ctx, ax(2 - spread), top + lift[0], look, !flip, reach);
  if (!skipNear) arm(ctx, ax(12 + spread), top + lift[1], look, flip, reach);
}

/**
 * The extra columns that turn the slim torso into a broad one.
 *
 * A wider torso Art would have to be authored four times over — front, back, side, three-quarter —
 * to move one column, and every one of those would then need its own broad walk and broad sit. The
 * torso's own outline stepping out a column, with shirt filling the space it left, is the same
 * picture for eight `rect` calls and no new art at all.
 */
function broaden(
  ctx: CanvasRenderingContext2D,
  ux: number,
  torsoY: number,
  look: Look,
): void {
  rect(ctx, ux + 4, torsoY, 1, 1, PAL.out);
  rect(ctx, ux + 11, torsoY, 1, 1, PAL.out);
  rect(ctx, ux + 4, torsoY + 1, 1, 6, look.shirt);
  rect(ctx, ux + 11, torsoY + 1, 1, 6, look.shirtShade);
  rect(ctx, ux + 4, torsoY + 7, 1, 1, look.trouser);
  rect(ctx, ux + 11, torsoY + 7, 1, 1, look.trouser);
  rect(ctx, ux + 3, torsoY + 1, 1, 7, PAL.out);
  rect(ctx, ux + 12, torsoY + 1, 1, 7, PAL.out);
}

/** The sheet of paper `read` holds up, and the two hands gripping its lower corners. */
function heldSheet(
  ctx: CanvasRenderingContext2D,
  ux: number,
  torsoY: number,
  look: Look,
  back: boolean,
  turning: boolean,
  flip: boolean,
): void {
  const sx = ux + 3;
  rect(ctx, sx, torsoY, 10, 7, PAL.out);
  rect(ctx, sx + 1, torsoY + 1, 8, 5, back ? PAL.pa2 : PAL.pap);
  if (!back) {
    rect(ctx, sx + 2, torsoY + 2, 6, 1, PAL.pa2);
    rect(ctx, sx + 2, torsoY + 4, 4, 1, PAL.pa2);
  }
  if (turning) {
    // A page going over: the leading third lifts, catches its own shadow and shows its back.
    const ex = flip ? sx + 1 : sx + 6;
    rect(ctx, ex, torsoY + 1, 3, 5, PAL.pa2);
    rect(ctx, flip ? sx + 3 : sx + 6, torsoY, 1, 7, PAL.out);
  }
  rect(ctx, ux + 2, torsoY + 3, 2, 3, PAL.out);
  rect(ctx, ux + 2, torsoY + 4, 2, 2, look.skin);
  rect(ctx, ux + 11, torsoY + 3, 2, 3, PAL.out);
  rect(ctx, ux + 11, torsoY + 4, 2, 2, look.skin);
}

/** Glasses, over the face and therefore invisible from behind. */
function glasses(
  ctx: CanvasRenderingContext2D,
  hx: number,
  hy: number,
  pose: Pose,
  flip: boolean,
): void {
  if (pose === 'back' || pose === 'q34b') return;
  const o = PAL.out;
  const lens = (lx: number): void => {
    rect(ctx, lx, hy + 2, 3, 1, o);
    rect(ctx, lx, hy + 5, 3, 1, o);
    rect(ctx, lx, hy + 3, 1, 2, o);
    rect(ctx, lx + 2, hy + 3, 1, 2, o);
    rect(ctx, lx + 1, hy + 3, 1, 2, PAL.day, 0.3);
  };
  if (pose === 'front') {
    lens(hx + 3);
    lens(hx + 7);
    rect(ctx, hx + 6, hy + 3, 1, 1, o);
    return;
  }
  // Turned: one lens over the near eye, and a temple arm running back toward the ear.
  const fx = (dx: number, w: number): number => (flip ? hx + HEAD_W - dx - w : hx + dx);
  lens(fx(pose === 'side' ? 7 : 5, 3));
  rect(ctx, fx(3, 1), hy + 3, 1, 1, o);
}

/**
 * Headphones: a band over the crown and a cup on each side, clear of the face.
 *
 * The cups sit *outside* the skull rather than over the ears, which is anatomically wrong and
 * visually right. The head is ten pixels wide and the eyes reach its outline column, so an
 * ear-shaped cup eats an eye; three pixels out at each edge of the box costs no face at all and
 * gives the silhouette the one shape nothing else in the room has.
 */
function headphones(ctx: CanvasRenderingContext2D, hx: number, hy: number): void {
  rect(ctx, hx + 1, hy - 1, 8, 1, PAL.out);
  rect(ctx, hx + 1, hy, 8, 1, PAL.bl2);
  rect(ctx, hx + 3, hy, 4, 1, PAL.me3);
  rect(ctx, hx - 1, hy, 1, 2, PAL.out);
  rect(ctx, hx + 10, hy, 1, 2, PAL.out);
  for (const cx of [hx - 3, hx + 10]) {
    rect(ctx, cx, hy + 1, 3, 6, PAL.out);
    rect(ctx, cx, hy + 2, 3, 4, PAL.bl2);
  }
  rect(ctx, hx - 3, hy + 3, 1, 2, PAL.me3);
  rect(ctx, hx + 12, hy + 3, 1, 2, PAL.me3);
}

/** A lanyard: a cord over both shoulders and a badge on the chest. */
function lanyard(ctx: CanvasRenderingContext2D, ux: number, torsoY: number, back: boolean): void {
  rect(ctx, ux + 6, torsoY + 1, 1, 2, PAL.blk);
  rect(ctx, ux + 9, torsoY + 1, 1, 2, PAL.blk);
  // From behind a lanyard is two pixels of cord and nothing else, which is exactly right.
  if (back) return;
  rect(ctx, ux + 7, torsoY + 3, 1, 1, PAL.blk);
  rect(ctx, ux + 8, torsoY + 3, 1, 1, PAL.blk);
  rect(ctx, ux + 6, torsoY + 4, 4, 3, PAL.out);
  rect(ctx, ux + 7, torsoY + 5, 2, 1, PAL.pap);
}

/** Acts that put somebody in a chair. `cheer` and `slump` ask, because they happen either way. */
const SEATED_ACTS: readonly CharAct[] = ['sit', 'type', 'read', 'wait'];

/**
 * Acts that happen standing *or* sitting and take `seated` to say which.
 *
 * `perch` is not on this list and never will be: it is not a chair the scene draws in front of
 * somebody, it is a stool the person carries, and it has its own layout from the hips down.
 */
const OPTIONAL_SEAT: readonly CharAct[] = ['cheer', 'slump', 'drink', 'smoke', 'chat'];

/**
 * One person.
 *
 * `cx` is the centre of the box and `yFeet` the row they stand on, so an actor's simulated
 * position maps onto a sprite with no offset table anywhere.
 */
export function drawChar(ctx: CanvasRenderingContext2D, cx: number, yFeet: number, o: CharOpts): void {
  const {
    act,
    dir,
    look,
    t,
    flip = false,
    alpha = 1,
    blink = false,
    seed = 0,
    turning = false,
    glance = 0,
  } = o;
  if (alpha <= 0) return;
  const style = (o.hairStyle ?? 0) % HAIR.length;
  const height = o.height ?? charHeight(seed);
  const build = o.build ?? charBuild(seed);
  const accessory = o.accessory ?? accessoryOf(seed);
  const x = Math.round(cx - CHAR.w / 2);
  // The figure hangs from its feet, not from the top of the box: a 21px person and a 24px one both
  // stand on `yFeet`, and the shorter one simply starts three rows further down.
  const y = Math.round(yFeet - height);

  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;

  const perched = act === 'perch';
  const seated =
    SEATED_ACTS.includes(act) || (OPTIONAL_SEAT.includes(act) && (o.seated ?? false));
  const walking = act === 'walk';
  const gait = gaitOf(seed);
  const spd = Math.max(0, Math.min(1, o.speed ?? 1));

  // The idle schedule. Only somebody who is otherwise doing nothing gets one, and a chair spin is
  // meaningless on somebody standing up, so it degrades to a shift of weight.
  const idling = act === 'idle' || act === 'sit';
  const slot =
    idling && o.idle !== undefined
      ? { act: o.idle, frame: Math.floor(Math.max(0, t) / IDLE_FRAME_MS) % IDLE_FRAMES }
      : idling
        ? idleSlot(t, seed)
        : { act: 'rest' as IdleAct, frame: 0 };
  const micro: IdleAct = slot.act === 'spin' && !seated ? 'lean' : slot.act;
  const mf = slot.frame;

  // Mid-turn, the body goes three-quarter rather than snapping between two orientations. Seated
  // people are excused: a chair does not pivot in two frames.
  let pose: Pose = !seated && !perched && turning ? (dir === 'back' ? 'q34b' : 'q34') : dir;
  // Gazing is a body squared away from the camera. Asked for from the front there is no honest
  // way to draw that and still say which way they turned, so it degrades to the back three-quarter
  // rather than to a straight back view, which would read as a bug in the facing.
  if (act === 'gaze') pose = dir === 'side' ? 'side' : 'q34b';
  if (micro === 'spin') {
    const from = dir === 'back' ? 0 : dir === 'side' ? 2 : 4;
    pose = SPIN_RING[(from + mf) % SPIN_RING.length];
  }
  const quarter = pose === 'q34' || pose === 'q34b';
  const facingAway = pose === 'back' || pose === 'q34b';

  // Seated, everything drops a single pixel — just enough to read as settling into the chair. It
  // cannot drop further: the scene draws the chair back in front of a seated person, so every
  // pixel down is a pixel of head that disappears behind it, and at three the room was a row of
  // office chairs with hair.
  const drop = seated ? 1 : 0;

  // The walk cycle. Distance is the clock: one stride of travel is one frame of leg whatever the
  // speed, which is the only way the feet can stay stuck to the floor through an acceleration.
  // Slowing down shortens the stride, so the cycle keeps ticking over as somebody arrives instead
  // of freezing them mid-scissor. `walkPhase` is what stops a crowd from marching in step.
  const stride = Math.max(1.6, gait.stride * (0.55 + 0.45 * spd));
  const cycle =
    o.dist !== undefined
      ? o.dist / stride
      : // No distance wired up yet: fall back to the clock, at this person's own tempo.
        t / (stride * (1000 / WALK_PX_PER_S));
  const step = walking ? (((Math.floor(cycle + walkPhase(seed)) % 4) + 4) % 4) : 0;
  // The arms run off the same cycle a fraction of a frame ahead for half the room. Same clock, so
  // they can never drift; different rounding, so they are not bolted on.
  const armStep = walking
    ? ((Math.floor(cycle + walkPhase(seed) + gait.armPhase) % 4) + 4) % 4
    : 0;

  // A walk bobs on the passing frames — for those people who bob at all; standing still breathes.
  const bob = walking ? (step % 2 === 1 ? gait.bob : 0) : breath(t, seed);
  // A pixel of torso and head thrown in the direction of travel. It straightens out as the person
  // slows, which is most of why the end of a trip reads as settling rather than as a full stop.
  const lean = walking ? Math.round(gait.lean * spd) * (flip ? -1 : 1) : 0;

  // Reactions and stretches come *up* off the chair. Nothing here is allowed to push the figure
  // down, because a seated head is already one row into the chair back the scene draws over it.
  const cheerFrame = Math.floor(Math.max(0, t) / 130) % 3;
  const rise =
    (act === 'cheer' && cheerFrame !== 1 ? 1 : 0) + (micro === 'stretch' && mf >= 2 && mf <= 5 ? 1 : 0);

  // A standing figure shifts its weight; a walking one is already moving and a seated one has
  // nowhere to shift it to.
  const swayX =
    seated || perched || walking
      ? 0
      : act === 'chat'
        ? chatShift(t, seed)
        : weightShift(t, seed);
  const leanBack = micro === 'lean' ? (hash(seed, 32) % 2 === 0 ? -1 : 1) : 0;

  // Perch stacks upward from the stool instead of downward from the top of the box: the seat is
  // furniture pinned to `yFeet`, and the hips have to land on it. The neck gap closes to a single
  // row for this act alone — head, neck, torso and seven rows of stool do not otherwise fit in
  // twenty-four, and a stool short enough to fit is a footstool. A shorter person sinks half their
  // missing height into the seat and keeps the other half, because most of what a short person is
  // short by is leg, and their legs are not holding them up here.
  const perchTop = yFeet - 24 + ((24 - height) >> 1);
  const headTop = perched ? perchTop + bob : y + drop + bob - rise;
  const torsoY = perched ? headTop + 9 : y + 10 + drop + bob - rise;
  // The legs hang off the floor rather than off the top of the box, so a short person loses their
  // shin rather than sinking their shoes through the floorboards.
  const legY = yFeet - 6;
  /** The upper body leans; the legs stay where the feet are. */
  const ux = x + lean + swayX + leanBack;

  // The head can move independently of the shoulders: that pixel of lead is what a turn, a glance
  // and a tipped-back chin are all made of. The neck stays put, so the gap never opens.
  let headDX = quarter ? (flip ? -1 : 1) : 0;
  // How this person carries their head, always. Seated it is only ever allowed to go *up*: a
  // seated head is already one row into the chair back the scene draws over it, and a second row
  // down turns the desk row into office chairs with hair.
  let headDY = seated ? Math.min(0, headCarry(seed)) : headCarry(seed);
  if (act === 'gaze') {
    headDY -= 1;
    headDX += flip ? -1 : 1;
  }
  if (act === 'slump' && !seated) headDY += 1;
  if (micro === 'lean') headDY -= 1;
  if (micro === 'stretch' && mf >= 2 && mf <= 5) headDY -= 1;
  if (micro === 'sip' && SIP_DRINK[mf] === 1) headDY -= 1;
  if (act === 'drink' && drinkPhase(t, seed) === 2) headDY -= 1;
  headDX += glance;
  // Two pixels puts the skull clear of the two-pixel neck it sits on, whatever the reasons for
  // each of them were. The carriage, the turn and a glance can all pull the same way at once.
  headDX = Math.max(-1, Math.min(1, headDX));
  // And one pixel vertically, for a blunter reason: the neck is drawn against the *unshifted* head
  // and is three rows tall, so at two the skull lifts clear of it and the character comes apart at
  // the throat. A proud carriage on top of an upward glance is still one pixel of proud.
  headDY = Math.max(-1, Math.min(1, headDY));
  const headX = ux + 3 + headDX;
  const headY = headTop + headDY;

  // --- legs, first, so the torso overlaps them at the hip -------------------
  if (perched) {
    // The stool goes down before the person does, so the thighs sit on the seat rather than the
    // seat sitting on the thighs. Its feet are on `yFeet`, like everything else in the room.
    drawArt(ctx, STOOL, x, yFeet - STOOL_H, { look });
    drawArt(ctx, pose === 'side' ? LEGS_PERCH_SIDE : LEGS_PERCH, x, yFeet - STOOL_H, {
      look,
      flip,
    });
  } else if (seated) drawArt(ctx, LEGS_SIT, x + 4, legY + 1, { look, flip });
  else if (walking) {
    const set = spd < 0.45 ? LEGS_WALK_SHORT : LEGS_WALK;
    drawArt(ctx, set[step], x + 4, legY, { look, flip });
  } else drawArt(ctx, LEGS_STAND, x + 4, legY, { look, flip });

  // --- torso ----------------------------------------------------------------
  const torso =
    pose === 'back'
      ? TORSO_BACK
      : pose === 'side'
        ? TORSO_SIDE
        : quarter
          ? TORSO_34
          : TORSO;
  drawArt(ctx, torso, ux + 4, torsoY, { look, flip });
  // A broad build only widens the square poses. Edge-on, a broad person is deeper rather than
  // wider, and there is no pixel in a 16-wide box that says "deeper"; three-quarter is transient.
  if (build === 1 && (pose === 'front' || pose === 'back')) broaden(ctx, ux, torsoY, look);
  if (accessory === 'lanyard') lanyard(ctx, ux, torsoY, facingAway);
  // The neck, which is the one pixel that stops a head from sitting straight on a pair of
  // shoulders like a bust. Anchored to the *unshifted* head, so a glance does not tear it open.
  rect(ctx, ux + 7, headTop + 8, 2, 3, look.skinShade);

  // --- arms -----------------------------------------------------------------
  const typing = Math.floor(t / 140) % 2 === 0;
  const lift: readonly [number, number] = walking
    ? // The back stroke stays at one however hard this person swings; only the forward one grows.
      // An arm lifted by a negative offset rises off the shoulder, but a positive one lengthens
      // toward the floor, and at three it hangs somewhere inside the shin.
      armStep === 0
      ? [1, -gait.swing]
      : armStep === 2
        ? [-gait.swing, 1]
        : [0, 0]
    : act === 'type'
      ? // Reaching up and forward: the desk is farther from the camera than the chair, so hands
        // go *up* the screen toward it, and the alternation is the keystroke.
        [typing ? -2 : -1, typing ? -1 : -2]
      : act === 'talk'
        ? [Math.floor(t / 220) % 2 === 0 ? -3 : -1, 0]
        : act === 'chat'
          ? CHAT_LIFT[chatBeat(t, seed)]
          : act === 'read'
            ? [-1, -1]
            : [0, 0];

  const cig = act === 'smoke' ? smokePhase(t, seed) : null;
  const mug = act === 'drink' ? drinkPhase(t, seed) : 0;

  const armSpread = build === 1 && (pose === 'front' || pose === 'back') ? 1 : 0;
  const armless = act === 'wait' || act === 'slump' || micro === 'stretch';
  const nearBusy =
    act === 'cheer' ||
    act === 'handoff' ||
    act === 'drink' ||
    act === 'smoke' ||
    micro === 'sip' ||
    micro === 'scratch';
  if (!armless) {
    arms(
      ctx,
      ux,
      torsoY,
      pose,
      look,
      lift,
      act === 'type' || act === 'talk' || act === 'read' || act === 'chat',
      flip,
      armSpread,
      nearBusy,
    );
  }
  if (act === 'wait') drawArt(ctx, ARMS_WAIT, ux, headTop + 2, { look, flip });
  if (act === 'handoff') drawArt(ctx, HANDOFF, ux, torsoY, { look, flip });
  if (act === 'read') heldSheet(ctx, ux, torsoY, look, facingAway, pageTurn(t, seed), flip);
  // A cigarette at rest hangs off the fingers by the hip, well clear of the head, so it goes down
  // with the rest of the arms whichever way the body is facing.
  if (cig && !cig.up) {
    drawArt(ctx, CIG_DOWN, ux + (pose === 'side' ? (flip ? 3 : -3) : 0), torsoY, { look, flip });
  }

  /**
   * The mug or the raised cigarette, which are the only things in this file that can end up on
   * the *far* side of the head.
   *
   * Drawn before the skull when the body is facing away and after it otherwise. Held at the mouth
   * they land squarely on the head's near cheek, which is exactly right from the front and is a
   * mug painted on the back of somebody's scalp from behind.
   */
  const prop = (): void => {
    // Edge-on the body is four pixels narrower and its one visible arm hangs three columns further
    // in, so a prop authored for the square poses floats out in space beside it. `arms()` already
    // moves the arm; anything that replaces the arm has to move with it.
    const inset = (n: number): number => ux + (flip ? n : -n);
    if (act === 'drink') {
      // Chest, halfway, mouth. The chest position is what says "not typing": four rows of travel
      // on a slow cycle cannot be confused with hands snapping at a keyboard twice a second.
      drawArt(ctx, MUG_ARM, inset(pose === 'side' ? 2 : 0), headTop + [10, 7, 4][mug], {
        look,
        flip,
      });
      return;
    }
    if (!cig?.up) return;
    drawArt(ctx, CIG_HAND, inset(pose === 'side' ? 1 : 0), headTop + 7, { look, flip });
    const sx = (dx: number, w: number): number => (flip ? ux + CHAR.w - dx - w : ux + dx);
    rect(ctx, sx(10, 2), headTop + 6, 2, 1, PAL.wht);
    rect(ctx, sx(12, 1), headTop + 6, 1, 1, PAL.lm2);
  };
  if (facingAway) prop();

  // --- head -----------------------------------------------------------------
  const headArt = facingAway ? HEAD_BACK : HEAD;
  drawArt(ctx, headArt, headX, headY, { look, flip });
  const mouthOpen =
    (act === 'talk' && Math.floor(t / 180) % 2 === 0) ||
    (act === 'chat' && chatMouth(t, seed)) ||
    (act === 'cheer' && cheerFrame !== 1);
  face(ctx, headX, headY, pose, look, blink, mouthOpen, flip, glance);
  // A bald crown is the whole point of style 7, so from behind it draws no hair at all — only the
  // beard, which from behind is not visible either.
  if (!(facingAway && style === 7)) {
    // Seen from the side the parting moves with the face: shifting the silhouette a pixel back is
    // the cheapest cue that the head is turned rather than merely wearing a different hat. Hair
    // rides the head, so the three-quarter offset comes along for free.
    const part = pose === 'side' ? (flip ? 1 : -1) : 0;
    drawArt(ctx, HAIR[style], headX - 1 + part, headY, { look, flip });
  }
  // Hats and headphones go over the hair; glasses go over the face, which the hair already covered.
  if (accessory === 'beanie') drawArt(ctx, BEANIE, headX - 1, headY - 2, { look, flip });
  if (accessory === 'headphones') headphones(ctx, headX, headY);
  if (accessory === 'glasses') glasses(ctx, headX, headY, pose, flip);

  // --- what goes in front of the head ---------------------------------------
  /** A 2px-wide limb's offset in the 16px box, mirrored when the body is. */
  const ax = (dx: number): number => (flip ? ux + CHAR.w - dx - 2 : ux + dx);
  const shoulderY = torsoY + 2;
  if (!facingAway) prop();
  if (cig && cig.exhale >= 0 && !facingAway) exhale(ctx, ux, headY + 6, cig.exhale, flip);
  if (act === 'cheer') {
    raisedArm(ctx, ax(13), headY + [-2, 2, -1][cheerFrame], shoulderY, look);
  }
  if (act === 'slump') {
    // Facing away there is no face to bury, so only the arms and the hunch are drawn — a band of
    // skin over the back of somebody's skull is `wait`, not despair.
    if (!facingAway) drawArt(ctx, SLUMP_HANDS, ux, headY + 2, { look, flip });
    drawArt(ctx, SLUMP_ARMS, ux, headTop + 6, { look, flip });
  }
  if (micro === 'stretch') {
    const fistY = headY + STRETCH_FIST[mf];
    raisedArm(ctx, ax(1), fistY, shoulderY, look);
    raisedArm(ctx, ax(13), fistY, shoulderY, look);
  }
  if (micro === 'scratch') raisedArm(ctx, ax(13), headY + SCRATCH_FIST[mf], shoulderY, look);
  if (micro === 'sip') {
    drawArt(ctx, MUG_ARM, ux, headTop + (SIP_DRINK[mf] === 1 ? 4 : 8), { look, flip });
  }

  ctx.globalAlpha = prev;
}

// -------------------------------------------------------------------- ghosts

/** The off-site strip's avatar: a head and a pair of shoulders, and nothing else that fits. */
export const GHOST = { w: 10, h: 13 } as const;

const GHOST_HEAD: Art = {
  rows: ['..oooo..', '.oHHHHo.', 'oHSSSSHo', 'oHSSSSHo', '.oSSSSo.', '..oooo..'],
  map: { o: 'out' },
};

const GHOST_BODY: Art = {
  rows: ['..oooo..', '.oTTTTo.', 'oTTTTTTo', 'oTTTTTTo', 'oTTTTTTo'],
  map: { o: 'out' },
};

export function drawGhost(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yFeet: number,
  look: Look,
  t: number,
  seed: number,
): void {
  const x = Math.round(cx - GHOST.w / 2);
  const y = Math.round(yFeet - GHOST.h);
  // `t` is handed in as zero for an idle agent, which parks the bob rather than freezing a phase.
  const bob = t > 0 && breath(t, seed) ? 1 : 0;
  // The body starts where the head ends. Parking it two rows lower left a gap, and forty of those
  // in a row read as forty floating heads over forty unrelated shirts.
  drawArt(ctx, GHOST_BODY, x + 1, y + 6, { look });
  drawArt(ctx, GHOST_HEAD, x + 1, y + bob, { look });
}

/**
 * The contact shadow.
 *
 * Banded rather than blurred, like every other soft thing in the room: a real gradient is the one
 * place smoothness leaks into pixel art, and a hard black ellipse under everyone reads as a hole
 * in the floor rather than as a person standing on it.
 */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  yFeet: number,
  w = 12,
  alpha = 0.32,
): void {
  pool(ctx, cx, yFeet - 1, w / 2, Math.max(1, w / 5), PAL.shd, alpha, 3);
}

// ------------------------------------------------------------------- preview

const DEMO: readonly Look[] = [
  lookOf({ tint: '#3E9AA8', color: '#1E7280', skin: '#B97C50', hair: '#1F1C19' }),
  lookOf({ tint: '#D06E88', color: '#B04462', skin: '#F2CBA8', hair: '#8C4A33' }),
  lookOf({ tint: '#D89440', color: '#A06A18', skin: '#8E5A38', hair: '#14110E' }),
];

const cell = (
  name: string,
  draw: (c: CanvasRenderingContext2D, t: number) => void,
  frames = 1,
  frameMs = 120,
): PreviewItem => ({ name, w: CHAR.w + 2, h: CHAR.h + 2, frames, frameMs, bg: PAL.flr, draw });

const stand = (act: CharAct, dir: CharDir, i = 0, extra: Partial<CharOpts> = {}) =>
  (c: CanvasRenderingContext2D, t: number): void =>
    drawChar(c, (CHAR.w + 2) / 2, CHAR.h + 1, { act, dir, look: DEMO[i], t, seed: i * 7, ...extra });

/**
 * A walker clocked the way the scene clocks one: distance accumulating at `speed` x the room's
 * walking pace. A strip of these is the only way to tell a walk from a shiver.
 */
const walker =
  (i: number, dir: CharDir, speed = 1, extra: Partial<CharOpts> = {}) =>
  (c: CanvasRenderingContext2D, t: number): void =>
    drawChar(c, (CHAR.w + 2) / 2, CHAR.h + 1, {
      act: 'walk',
      dir,
      look: DEMO[i % 3],
      t,
      seed: i * 7 + 3,
      hairStyle: i,
      dist: (t * WALK_PX_PER_S * speed) / 1000,
      speed,
      ...extra,
    });

/**
 * A taller cell, for the postures that reach above the head.
 *
 * A stretch, a fist-pump and a beanie all put pixels three rows over the top of the box, and in a
 * 26-row cell they were simply cut off — which looks exactly like a sprite drawn wrong.
 */
const TW = CHAR.w + 4;
const TH = CHAR.h + 6;
const YF = TH - 3;

const tall = (
  name: string,
  draw: (c: CanvasRenderingContext2D, t: number) => void,
  frames = 1,
  frameMs = 120,
  cols = 1,
): PreviewItem => ({ name, w: TW * cols, h: TH, frames, frameMs, bg: PAL.flr, draw });

/** One figure in a tall cell. */
const one =
  (extra: Partial<CharOpts> & { act: CharAct; dir: CharDir }, i = 0) =>
  (c: CanvasRenderingContext2D, t: number): void =>
    drawChar(c, TW / 2, YF, { look: DEMO[i % 3], t, seed: i * 7, ...extra });

/** A row of figures in one tall cell, on a common floor line. */
const lineup =
  (n: number, at: (i: number) => Partial<CharOpts> & { act: CharAct; dir: CharDir }) =>
  (c: CanvasRenderingContext2D, t: number): void => {
    for (let i = 0; i < n; i++) {
      drawChar(c, TW * i + TW / 2, YF, { look: DEMO[i % 3], t, seed: i * 7, ...at(i) });
    }
  };

export const PREVIEW: PreviewItem[] = [
  cell('idle-fr', stand('idle', 'front', 0, { idle: 'rest' })),
  cell('idle-sd', stand('idle', 'side', 0, { idle: 'rest' })),
  cell('idle-bk', stand('idle', 'back', 0, { idle: 'rest' })),
  cell('blink', stand('idle', 'front', 0, { blink: true, idle: 'rest' })),
  cell('sit', stand('sit', 'back', 0, { idle: 'rest' })),
  // The time-driven fallback, kept so it is visible that nothing broke while the scene is wired up.
  cell('walk-t-fr', stand('walk', 'front'), 4, 110),
  cell('walk-t-sd', stand('walk', 'side'), 4, 110),
  cell('walk-t-bk', stand('walk', 'back'), 4, 110),
  cell('type', stand('type', 'back'), 4, 140),
  cell('talk', stand('talk', 'front'), 4, 180),

  // --- the distance-driven walk -------------------------------------------
  cell('walk-d-sd', walker(0, 'side'), 8, 110),
  cell('walk-d-fr', walker(1, 'front'), 8, 110),
  cell('walk-d-bk', walker(2, 'back'), 8, 110),
  // Half a stride per frame: the same cycle, half as fast, with no foot slip anywhere in it.
  cell('walk-half', walker(0, 'side', 0.5), 8, 110),
  // Arriving. Short steps, no lean.
  cell('walk-slow', walker(0, 'side', 0.25), 8, 110),
  cell('slow-fr', walker(1, 'front', 0.25), 8, 110),

  // --- decelerating into a stop -------------------------------------------
  {
    name: 'decel',
    w: CHAR.w + 2,
    h: CHAR.h + 2,
    frames: 8,
    frameMs: 110,
    bg: PAL.flr,
    draw: (c, t) => {
      // Speed ramps 1 -> 0 across the strip, with distance integrated from it, which is exactly
      // what the scene hands in at the end of a trip.
      const f = Math.round(t / 110);
      const speed = Math.max(0.08, 1 - f / 7);
      let dist = 0;
      for (let k = 0; k < f; k++) dist += Math.max(0.08, 1 - k / 7) * 4.95;
      drawChar(c, (CHAR.w + 2) / 2, CHAR.h + 1, {
        act: 'walk',
        dir: 'side',
        look: DEMO[0],
        t,
        seed: 3,
        dist,
        speed,
      });
    },
  },

  // --- the turn -------------------------------------------------------------
  {
    name: 'turn-sd-fr',
    w: CHAR.w + 2,
    h: CHAR.h + 2,
    frames: 6,
    frameMs: 140,
    bg: PAL.flr,
    draw: (c, t) => {
      const f = Math.round(t / 140);
      const turning = f === 2 || f === 3;
      drawChar(c, (CHAR.w + 2) / 2, CHAR.h + 1, {
        act: 'idle',
        dir: f < 2 ? 'side' : 'front',
        look: DEMO[1],
        t: 0,
        seed: 5,
        hairStyle: 1,
        turning,
      });
    },
  },
  {
    name: 'turn-bk-sd',
    w: CHAR.w + 2,
    h: CHAR.h + 2,
    frames: 6,
    frameMs: 140,
    bg: PAL.flr,
    draw: (c, t) => {
      const f = Math.round(t / 140);
      const turning = f === 2 || f === 3;
      drawChar(c, (CHAR.w + 2) / 2, CHAR.h + 1, {
        act: 'idle',
        dir: f < 4 ? 'back' : 'side',
        look: DEMO[2],
        t: 0,
        seed: 9,
        hairStyle: 6,
        turning,
      });
    },
  },
  {
    name: 'turn-walk',
    w: CHAR.w + 2,
    h: CHAR.h + 2,
    frames: 6,
    frameMs: 110,
    bg: PAL.flr,
    draw: (c, t) => {
      const f = Math.round(t / 110);
      drawChar(c, (CHAR.w + 2) / 2, CHAR.h + 1, {
        act: 'walk',
        dir: f < 2 ? 'side' : 'front',
        look: DEMO[0],
        t,
        seed: 3,
        dist: (t * WALK_PX_PER_S) / 1000,
        turning: f === 2 || f === 3,
      });
    },
  },

  // --- twelve people, twelve walks -----------------------------------------
  {
    name: 'gaits',
    w: (CHAR.w + 2) * 6,
    h: CHAR.h + 2,
    frames: 8,
    frameMs: 110,
    bg: PAL.flr,
    draw: (c, t) => {
      // Six people fed the identical distance. If any two of them are ever on the same frame with
      // the same bob, the phasing is not doing its job.
      for (let i = 0; i < 6; i++) {
        drawChar(c, (CHAR.w + 2) * i + (CHAR.w + 2) / 2, CHAR.h + 1, {
          act: 'walk',
          dir: 'side',
          look: DEMO[i % 3],
          t,
          seed: i * 11 + 2,
          hairStyle: i,
          dist: (t * WALK_PX_PER_S) / 1000,
        });
      }
    },
  },

  // --- six people, one distance --------------------------------------------
  // The gait spread in a single row: identical `dist`, identical everything else, six seeds. If
  // two of these are on the same leg with the same bob and the same lean, the seeding is asleep.
  {
    name: 'gait-spread',
    w: (CHAR.w + 2) * 6,
    h: CHAR.h + 2,
    bg: PAL.flr,
    draw: (c) => {
      for (let i = 0; i < 6; i++) {
        drawChar(c, (CHAR.w + 2) * i + (CHAR.w + 2) / 2, CHAR.h + 1, {
          act: 'walk',
          dir: 'side',
          look: DEMO[i % 3],
          t: 0,
          seed: i * 11 + 2,
          hairStyle: i,
          dist: 12,
        });
      }
    },
  },

  // --- the break corner -----------------------------------------------------
  tall('perch-fr', one({ act: 'perch', dir: 'front', hairStyle: 1, accessory: 'none' }, 0), 2, 1400),
  tall('perch-sd', one({ act: 'perch', dir: 'side', hairStyle: 0, accessory: 'none' }, 1), 2, 1400),
  tall('perch-bk', one({ act: 'perch', dir: 'back', hairStyle: 6, accessory: 'none' }, 2), 2, 1400),
  // Three heights on the same stool: the seat does not move, so the difference is all upper body.
  tall(
    'perch-tall',
    lineup(3, (i) => ({
      act: 'perch',
      dir: 'front',
      height: [24, 23, 21][i],
      hairStyle: i + 2,
      accessory: 'none',
    })),
    1,
    120,
    3,
  ),
  tall('drink-fr', one({ act: 'drink', dir: 'front', hairStyle: 0, accessory: 'none' }, 0), 10, 600),
  tall('drink-sd', one({ act: 'drink', dir: 'side', hairStyle: 4, accessory: 'none' }, 1), 10, 600),
  tall('drink-bk', one({ act: 'drink', dir: 'back', hairStyle: 2, accessory: 'none' }, 2), 10, 600),
  tall('drink-sit', one({ act: 'drink', dir: 'back', seated: true, hairStyle: 1 }, 0), 10, 600),
  tall('smoke-sd', one({ act: 'smoke', dir: 'side', hairStyle: 0, accessory: 'none' }, 2), 12, 700),
  tall('smoke-fr', one({ act: 'smoke', dir: 'front', hairStyle: 5, accessory: 'none' }, 0), 12, 700),
  tall('smoke-bk', one({ act: 'smoke', dir: 'back', hairStyle: 6, accessory: 'none' }, 1), 12, 700),
  tall('chat-fr', one({ act: 'chat', dir: 'front', hairStyle: 1, accessory: 'none' }, 1), 8, 190),
  tall('chat-sd', one({ act: 'chat', dir: 'side', hairStyle: 3, accessory: 'none' }, 0), 8, 190),
  tall('chat-bk', one({ act: 'chat', dir: 'back', hairStyle: 4, accessory: 'none' }, 2), 8, 190),
  tall('chat-sit', one({ act: 'chat', dir: 'front', seated: true, hairStyle: 0 }, 1), 8, 190),
  // Two of them facing each other, which is how the room will actually use it. The mouths and the
  // hands must not land on the same beat.
  {
    name: 'chat-pair',
    w: TW * 2,
    h: TH,
    frames: 8,
    frameMs: 190,
    bg: PAL.flr,
    draw: (c, t) => {
      drawChar(c, TW / 2, YF, {
        act: 'chat',
        dir: 'side',
        look: DEMO[0],
        t,
        seed: 4,
        hairStyle: 2,
        accessory: 'none',
      });
      drawChar(c, TW + TW / 2, YF, {
        act: 'chat',
        dir: 'side',
        look: DEMO[1],
        t,
        seed: 19,
        hairStyle: 6,
        accessory: 'none',
        flip: true,
      });
    },
  },
  // Seeded head carriage, with everything else pinned. Three postures, no art.
  tall(
    'carriage',
    lineup(6, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'side',
      seed: i,
      hairStyle: 0,
      height: 24,
      accessory: 'none',
    })),
    1,
    120,
    6,
  ),

  // --- the tool-shaped postures --------------------------------------------
  // Read runs at half a second a frame so a page turn actually falls inside the strip.
  tall('read-bk', one({ act: 'read', dir: 'back', hairStyle: 1, accessory: 'none' }, 0), 8, 500),
  tall('read-fr', one({ act: 'read', dir: 'front', hairStyle: 4, accessory: 'none' }, 1), 8, 500),
  tall('read-sd', one({ act: 'read', dir: 'side', hairStyle: 0, accessory: 'none' }, 2), 8, 500),
  tall('gaze-fr', one({ act: 'gaze', dir: 'front', hairStyle: 6, accessory: 'none' }, 1)),
  tall('gaze-sd', one({ act: 'gaze', dir: 'side', hairStyle: 0, accessory: 'none' }, 0)),
  tall('gaze-bk', one({ act: 'gaze', dir: 'back', hairStyle: 2, accessory: 'none' }, 2)),
  tall('hand-sd', one({ act: 'handoff', dir: 'side', hairStyle: 0, accessory: 'none' }, 0)),
  tall('hand-fr', one({ act: 'handoff', dir: 'front', hairStyle: 5, accessory: 'none' }, 1)),
  tall('hand-bk', one({ act: 'handoff', dir: 'back', hairStyle: 3, accessory: 'none' }, 2)),
  tall('wait-bk', one({ act: 'wait', dir: 'back', hairStyle: 0, accessory: 'none' }, 0)),
  tall('wait-fr', one({ act: 'wait', dir: 'front', hairStyle: 3, accessory: 'none' }, 1)),
  tall('cheer-sit', one({ act: 'cheer', dir: 'back', seated: true, hairStyle: 1 }, 0), 3, 130),
  tall('cheer-fr', one({ act: 'cheer', dir: 'front', hairStyle: 0, accessory: 'none' }, 2), 3, 130),
  tall('slump-sit', one({ act: 'slump', dir: 'front', seated: true, hairStyle: 6 }, 1)),
  tall('slump-bk', one({ act: 'slump', dir: 'back', seated: true, hairStyle: 0 }, 0)),

  // --- the five idle micro-actions -----------------------------------------
  tall('mic-stretch', one({ act: 'idle', dir: 'front', idle: 'stretch', accessory: 'none' }, 0), 8, 120),
  tall('mic-sip', one({ act: 'idle', dir: 'front', idle: 'sip', accessory: 'none' }, 1), 8, 120),
  tall('mic-sip-sd', one({ act: 'idle', dir: 'side', idle: 'sip', accessory: 'none' }, 2), 8, 120),
  tall('mic-scratch', one({ act: 'idle', dir: 'front', idle: 'scratch', accessory: 'none' }, 0), 8, 120),
  tall('mic-lean', one({ act: 'sit', dir: 'back', idle: 'lean', accessory: 'none' }, 1), 8, 120),
  tall('mic-spin', one({ act: 'sit', dir: 'back', idle: 'spin', accessory: 'none' }, 2), 8, 120),

  // --- bodies ---------------------------------------------------------------
  tall(
    'heights',
    lineup(4, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'front',
      height: 24 - i,
      hairStyle: i,
      accessory: 'none',
      build: 0,
    })),
    1,
    120,
    4,
  ),
  tall(
    'builds',
    lineup(4, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: i < 2 ? 'front' : 'back',
      build: (i % 2) as 0 | 1,
      height: 24,
      hairStyle: 0,
      accessory: 'none',
    })),
    1,
    120,
    4,
  ),
  // Accessories over a short crop, then over style 7 — bald with a beard, the one most likely to
  // fight a hat.
  tall(
    'acc-hair0',
    lineup(4, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'front',
      hairStyle: 0,
      height: 24,
      accessory: (['glasses', 'headphones', 'lanyard', 'beanie'] as const)[i],
    })),
    1,
    120,
    4,
  ),
  tall(
    'acc-hair7',
    lineup(4, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'front',
      hairStyle: 7,
      height: 24,
      accessory: (['glasses', 'headphones', 'lanyard', 'beanie'] as const)[i],
    })),
    1,
    120,
    4,
  ),
  tall(
    'acc-back',
    lineup(4, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'back',
      hairStyle: 2,
      height: 24,
      accessory: (['glasses', 'headphones', 'lanyard', 'beanie'] as const)[i],
    })),
    1,
    120,
    4,
  ),
  tall(
    'acc-side',
    lineup(4, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'side',
      hairStyle: 6,
      height: 24,
      accessory: (['glasses', 'headphones', 'lanyard', 'beanie'] as const)[i],
    })),
    1,
    120,
    4,
  ),
  // Three heads looking left, ahead and right, with the bodies square to the camera.
  tall(
    'glance',
    lineup(3, (i) => ({
      act: 'idle',
      idle: 'rest',
      dir: 'front',
      glance: (i - 1) as -1 | 0 | 1,
      hairStyle: 0,
      height: 24,
      accessory: 'none',
    })),
    1,
    120,
    3,
  ),
  // The weight shift, sampled every 900ms so the transition falls inside the strip.
  tall('sway', one({ act: 'idle', dir: 'front', accessory: 'none' }, 0), 6, 900),

  ...HAIR.map((_, s) => cell(`hair${s}`, stand('idle', 'front', s % 3, { hairStyle: s, accessory: 'none', idle: 'rest' }))),
  ...HAIR.map((_, s) => cell(`hairbk${s}`, stand('idle', 'back', s % 3, { hairStyle: s, accessory: 'none', idle: 'rest' }))),
  {
    name: 'ghosts',
    w: GHOST.w * 4 + 4,
    h: GHOST.h + 2,
    bg: PAL.out,
    draw: (c, t) => {
      for (let i = 0; i < 4; i++) {
        drawGhost(c, 2 + i * GHOST.w + GHOST.w / 2, GHOST.h + 1, DEMO[i % 3], t, i * 13);
      }
    },
    frames: 2,
    frameMs: 700,
  },
  {
    name: 'shadow',
    w: 20,
    h: 8,
    bg: PAL.flr,
    draw: (c) => drawShadow(c, 10, 7, 14, 0.4),
  },
];
