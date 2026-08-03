/**
 * Model identity: a short name to print, and the numbers behind the cost estimate.
 *
 * The observer reads transcripts, and a transcript records the model string and the token counts
 * but never a price. Everything here is therefore a local, editable assumption — which is exactly
 * why it lives in one table with the rates written out in full rather than scattered through the
 * UI as magic numbers. The figure the HUD shows is labelled an estimate wherever it appears, and
 * an unknown model contributes tokens but no dollars rather than being silently priced as Opus.
 */
import { type TokenUse } from './events';

/** USD per million tokens, by billing bucket. */
export type Rates = {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
};

export type ModelInfo = {
  /** What the HUD prints instead of `claude-haiku-4-5-20251001`. */
  short: string;
  /** Capability tier, used only to colour the roster. */
  tier: 'opus' | 'sonnet' | 'haiku' | 'other';
  /** `undefined` when this build has no rate card for the model — then no cost is claimed. */
  rates?: Rates;
};

/**
 * Published list prices, recorded 2026-08. Edit here if they move; nothing else reads a rate.
 * The Mythos-class models bill at the Opus card.
 */
const OPUS: Rates = { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 };
const SONNET: Rates = { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 };
const HAIKU: Rates = { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 };

/**
 * Billed at nothing, and said so out loud.
 *
 * `<synthetic>` is not a model. It is the marker the CLI puts on assistant lines it wrote itself —
 * API-error notices, interrupt markers, "no response requested" — and every one of the 30
 * occurrences in a 250-transcript sample carries a usage object with all four fields at zero.
 *
 * An *explicit* zero rather than no card at all, because the two are not the same claim. A model
 * with no card contributes tokens but no dollars and sets `costPartial`, which flips the whole HUD
 * to `≥` and tells the viewer the estimate is a floor with something missing from it. Nothing is
 * missing: these lines cost nothing, and the figure beside them is exact.
 */
const FREE: Rates = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Matched by prefix, longest first, because the wire carries dated ids
 * (`claude-haiku-4-5-20251001`) while a `meta.json` carries the bare alias (`haiku`).
 */
const TABLE: readonly (readonly [string, ModelInfo])[] = [
  ['<synthetic>', { short: 'synthetic', tier: 'other', rates: FREE }],
  ['claude-fable-5', { short: 'fable 5', tier: 'opus', rates: OPUS }],
  ['claude-mythos-5', { short: 'mythos 5', tier: 'opus', rates: OPUS }],
  ['claude-opus-5', { short: 'opus 5', tier: 'opus', rates: OPUS }],
  ['claude-opus', { short: 'opus', tier: 'opus', rates: OPUS }],
  ['claude-sonnet-5', { short: 'sonnet 5', tier: 'sonnet', rates: SONNET }],
  ['claude-sonnet', { short: 'sonnet', tier: 'sonnet', rates: SONNET }],
  ['claude-haiku-4-5', { short: 'haiku 4.5', tier: 'haiku', rates: HAIKU }],
  ['claude-haiku', { short: 'haiku', tier: 'haiku', rates: HAIKU }],
  ['fable', { short: 'fable', tier: 'opus', rates: OPUS }],
  ['mythos', { short: 'mythos', tier: 'opus', rates: OPUS }],
  ['opus', { short: 'opus', tier: 'opus', rates: OPUS }],
  ['sonnet', { short: 'sonnet', tier: 'sonnet', rates: SONNET }],
  ['haiku', { short: 'haiku', tier: 'haiku', rates: HAIKU }],
];

const UNKNOWN: ModelInfo = { short: 'unknown', tier: 'other' };

export function modelInfo(model: string | undefined): ModelInfo {
  if (!model) return UNKNOWN;
  const id = model.toLowerCase();
  for (const [prefix, info] of TABLE) {
    if (id.startsWith(prefix)) return info;
  }
  // Not in the table: print whatever the transcript said rather than "unknown", but claim no price.
  return { short: model, tier: 'other' };
}

const PER_MILLION = 1_000_000;

/**
 * The estimated dollar cost of one usage total, or `undefined` when the model has no rate card.
 * `undefined` and `0` mean different things here — "we will not guess" versus "free" — so the two
 * are kept apart all the way to the HUD, which prints a dash for the first and `$0.00` for the
 * second.
 */
export function estimateCost(model: string | undefined, use: TokenUse): number | undefined {
  const rates = modelInfo(model).rates;
  if (!rates) return undefined;
  return (
    (use.in * rates.in + use.out * rates.out + use.cacheWrite * rates.cacheWrite + use.cacheRead * rates.cacheRead) /
    PER_MILLION
  );
}
