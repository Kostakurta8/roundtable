/** @vitest-environment jsdom */

/**
 * The DOM layer laid over the painted room.
 *
 * The office is a canvas, so every clickable, hoverable, focusable, screen-readable thing in it is
 * an invisible DOM mark positioned over the sprite it stands for. That positioning is the whole
 * accessibility story, and until now it was asserted in exactly one place: a Playwright test that
 * fires `document.elementFromPoint` at an actor's centre. That test is real and it passes — but the
 * e2e job is manual-only in CI (it needs two ports and a browser download), so on every push and
 * every pull request this layer is covered by nothing at all.
 *
 * These run in jsdom in the ordinary unit suite, in milliseconds, on all three platforms.
 */
import { describe, expect, it } from 'vitest';
import { place, setBubble, wroteOf } from '../src/office/PixelOffice';
import { blitOf, toBuffer, type Blit, type Cam } from '../src/office/pixel/stage';

const el = (): HTMLElement => document.createElement('div');

const blit = (cam: Partial<Cam> = {}, geo = { w: 1600, h: 900, dpr: 1, insetLeft: 0 }): Blit =>
  blitOf({ x: 240, y: 135, z: 1, ...cam }, geo);

/** The `translate(Xpx, Ypx)` a `place` wrote, back as numbers. */
const posOf = (node: HTMLElement): { x: number; y: number } => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node.style.transform);
  if (!m) throw new Error(`no transform written: ${JSON.stringify(node.style.transform)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
};

describe('place — a mark lands over the pixels it labels', () => {
  /**
   * The invariant everything else leans on: `place` writes a position and `toBuffer` inverts it.
   * They are two expressions of one piece of arithmetic in one file, and the file's own header
   * claims "there is no second copy of that arithmetic to drift". This is what makes that true.
   */
  it('round-trips through toBuffer at every zoom, device ratio and rail inset', () => {
    const box = { x: 120, y: 88, w: 18, h: 26 };

    for (const z of [1, 1.5, 2, 3]) {
      for (const dpr of [1, 2]) {
        for (const insetLeft of [0, 264]) {
          const b = blitOf({ x: 240, y: 135, z }, { w: 1600, h: 900, dpr, insetLeft });
          const node = el();
          place(node, box, b);
          const back = toBuffer(b, posOf(node).x, posOf(node).y);

          // `place` rounds to whole CSS pixels, so the inverse cannot be exact — but it must be
          // within one buffer pixel, or a mark is over its neighbour's sprite.
          expect(Math.abs(back.x - box.x), `x @ z${z} dpr${dpr} inset${insetLeft}`).toBeLessThan(1);
          expect(Math.abs(back.y - box.y), `y @ z${z} dpr${dpr} inset${insetLeft}`).toBeLessThan(1);
        }
      }
    }
  });

  it('never collapses a mark to nothing, however small the box or the zoom', () => {
    // A zero-width mark is unclickable and unfocusable — the actor is a zero-size point in the
    // engine, and a mark that inherited that would be a person nobody can reach.
    const node = el();
    place(node, { x: 10, y: 10, w: 0, h: 0 }, blit({ z: 1 }));
    expect(Number.parseFloat(node.style.width)).toBeGreaterThanOrEqual(1);
    expect(Number.parseFloat(node.style.height)).toBeGreaterThanOrEqual(1);
  });

  it('writes nothing the second time when nothing moved', () => {
    // The frame loop calls this for every mark sixty times a second. The memo is the reason that
    // is affordable, and a memo nothing tests is a memo that silently stops working.
    const node = el();
    const b = blit();
    place(node, { x: 40, y: 40, w: 10, h: 10 }, b);

    let writes = 0;
    const raw = node.style;
    const spy = new Proxy(raw, {
      set(t, k, v) {
        writes++;
        return Reflect.set(t, k, v);
      },
    });
    Object.defineProperty(node, 'style', { value: spy, configurable: true });

    place(node, { x: 40, y: 40, w: 10, h: 10 }, b);
    expect(writes).toBe(0);

    place(node, { x: 41, y: 40, w: 10, h: 10 }, b);
    expect(writes).toBeGreaterThan(0);
  });
});

describe('setBubble', () => {
  const withBubbles = () => {
    const node = el();
    const say = el();
    const think = el();
    const w = wroteOf(node);
    w.bubbles = { say, think };
    return { w, say, think };
  };

  it('turns a bubble on with its text and off again when the text goes away', () => {
    const { w, say } = withBubbles();

    setBubble(w, 'say', 'the tailer stops on a 4 MB line');
    expect(say.textContent).toBe('the tailer stops on a 4 MB line');
    expect(say.classList.contains('on')).toBe(true);

    setBubble(w, 'say', undefined);
    expect(say.classList.contains('on')).toBe(false);
    // The text stays put on purpose — it is the fade-out's content, and blanking it mid-transition
    // shows an empty bubble shrinking.
    expect(say.textContent).toBe('the tailer stops on a 4 MB line');
  });

  it('keeps the two bubbles independent', () => {
    // They are separate elements placed side by side precisely so a variable-height speech bubble
    // cannot shove a thought cloud off its own anchor. Writing one must not touch the other.
    const { w, say, think } = withBubbles();
    setBubble(w, 'think', 'is the tail even complete');
    expect(think.classList.contains('on')).toBe(true);
    expect(say.classList.contains('on')).toBe(false);
    expect(say.textContent).toBe('');
  });

  it('does nothing at all when the mark has no bubble elements', () => {
    // Ghosts in the off-site strip have a mark and no bubbles; the frame loop calls this for them
    // anyway rather than branching per actor.
    const node = el();
    expect(() => setBubble(wroteOf(node), 'say', 'x')).not.toThrow();
  });
});
