/** @vitest-environment jsdom */

/**
 * The Share dialog, rendered for real in jsdom with a worker that answers on cue.
 *
 * The renderer is pinned elsewhere (`clipcore.test.ts`, `clip.test.ts`); what is pinned here is the
 * part a person touches: that a render starts by itself and can be stopped, that the file offered is
 * the file that was rendered and is named for the session, that the text in the clip is named before
 * the Download button is, that the keyboard can do everything and cannot escape — and that nothing
 * in the dialog points anywhere but at the bytes it just made.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ev } from '../shared/events';
import type { ClipInfo, ClipReply, ClipRequest } from '../src/clip/worker';
import { Help } from '../src/ui/Help';
import { CAPTION, ShareDialog, type ClipWorker, type ShareDialogProps } from '../src/ui/ShareDialog';
import { TopBar, type TopBarProps } from '../src/ui/TopBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWorker implements ClipWorker {
  onmessage: ((e: MessageEvent<ClipReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: ClipRequest[] = [];
  terminated = false;
  postMessage(req: ClipRequest): void {
    this.posted.push(req);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: ClipReply): void {
    act(() => this.onmessage?.(new MessageEvent('message', { data: msg })));
  }
}

const SESSION = 'abcdef0123456789-0000';
const EVS: Ev[] = [
  { kind: 'sessionSeen', sessionId: SESSION, cwd: '/w', live: true, ts: 1000, seq: 1 },
  { kind: 'agentText', ref: { sessionId: SESSION, agentId: 'main' }, text: 'hello', ts: 2000, seq: 2 },
];

const INFO: ClipInfo = {
  frames: 262,
  width: 960,
  height: 562,
  agents: 3,
  tokens: 120_000,
  realMs: 9 * 60_000,
  clipMs: 21_000,
  speed: 4.2,
  shownFrom: 1000,
  shownTo: 541_000,
  windowed: false,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let workers: FakeWorker[] = [];
let made: string[] = [];
let revoked: string[] = [];
let closed = 0;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
  workers = [];
  made = [];
  revoked = [];
  closed = 0;
  // jsdom has no object URLs; these stand in for the browser's, and keep count.
  URL.createObjectURL = () => {
    const url = `blob:test/${made.length}`;
    made.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  Reflect.deleteProperty(navigator, 'clipboard');
});

const spawn = (): FakeWorker => {
  const w = new FakeWorker();
  workers.push(w);
  return w;
};

const mount = (node: React.ReactNode): HTMLDivElement => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};

const dialog = (over: Partial<ShareDialogProps> = {}): HTMLDivElement =>
  mount(
    <ShareDialog
      sessionId={SESSION}
      sessionName="dev-c8"
      events={() => EVS}
      missing={0}
      onClose={() => closed++}
      spawn={spawn}
      {...over}
    />,
  );

const byText = (el: HTMLElement, sel: string, text: string): HTMLElement => {
  const hit = Array.from(el.querySelectorAll<HTMLElement>(sel)).find((n) => n.textContent?.includes(text));
  if (!hit) throw new Error(`no ${sel} containing "${text}"`);
  return hit;
};
const radio = (el: HTMLElement, text: string): HTMLInputElement =>
  byText(el, 'label', text).querySelector('input') as HTMLInputElement;
const checkbox = (el: HTMLElement): HTMLInputElement =>
  el.querySelector('input[type="checkbox"]') as HTMLInputElement;
const key = (target: Element, k: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

describe('the render', () => {
  it('starts on open, in a worker, with the clip `--gif` makes by default', () => {
    const el = dialog();
    expect(workers).toHaveLength(1);
    const req = workers[0].posted[0];
    expect(req.evs).toEqual(EVS);
    expect(req.opts).toEqual({ seconds: 20, fps: 12.5, scale: 2, bare: false, full: false });
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
    // Nothing to download yet, and the control says so rather than being absent.
    const dl = byText(el, 'button', 'Download GIF') as HTMLButtonElement;
    expect(dl.disabled).toBe(true);
  });

  it('moves the bar as the worker reports, and says which loop it is in', () => {
    const el = dialog();
    const bar = (): string | null => el.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow');
    workers[0].reply({ kind: 'progress', phase: 'draw', done: 131, total: 262 });
    expect(bar()).toBe('23');
    expect(el.textContent).toContain('drawing frame 131 of 262');
    workers[0].reply({ kind: 'progress', phase: 'draw', done: 262, total: 262 });
    expect(el.textContent).toContain('cutting the palette');
    workers[0].reply({ kind: 'progress', phase: 'encode', done: 131, total: 262 });
    expect(bar()).toBe('75');
    expect(el.textContent).toContain('encoding frame 131 of 262');
  });

  it('shows the GIF it made and offers exactly that file, named for the session', () => {
    const el = dialog();
    (byText(el, 'button', 'Cancel') as HTMLButtonElement).focus();
    workers[0].reply({ kind: 'done', gif: new ArrayBuffer(3 * 1024 * 1024), info: INFO });

    expect(workers[0].terminated).toBe(true);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:test/0');
    expect(img.getAttribute('alt')).toMatch(/office/);
    const meta = el.querySelector('figcaption')!.textContent!;
    expect(meta).toContain('960×562');
    expect(meta).toContain('3.0 MB');
    expect(meta).toContain('21.0 s loop');
    expect(meta).toContain('3 agents');
    expect(meta).toContain('9m 00s of session at 4.2×');

    const dl = byText(el, 'a', 'Download GIF') as HTMLAnchorElement;
    expect(dl.getAttribute('href')).toBe('blob:test/0');
    expect(dl.getAttribute('download')).toBe('roundtable-abcdef01.gif');
    // The Cancel button went away under the keyboard; focus went to what the dialog is now for.
    expect(document.activeElement).toBe(dl);
  });

  it('can be cancelled, keeps nothing, and can be started again', () => {
    const el = dialog();
    const cancel = byText(el, 'button', 'Cancel');
    cancel.focus();
    act(() => cancel.click());
    expect(workers[0].terminated).toBe(true);
    expect(el.textContent).toContain('Cancelled');
    expect(made).toEqual([]);
    const again = byText(el, 'button', 'Render again');
    expect(document.activeElement).toBe(again);
    act(() => again.click());
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].opts).toEqual(workers[0].posted[0].opts);
  });

  it('abandons a render the moment an option changes, and ignores anything it says afterwards', () => {
    const el = dialog();
    act(() => checkbox(el).click());
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].posted[0].opts.bare).toBe(true);

    act(() => radio(el, '40 s').click());
    expect(workers[2].posted[0].opts).toMatchObject({ seconds: 40, bare: true, full: false });

    act(() => radio(el, 'whole session').click());
    expect(workers[3].posted[0].opts).toMatchObject({ seconds: 40, bare: true, full: true });

    workers[0].reply({ kind: 'done', gif: new ArrayBuffer(8), info: INFO });
    expect(el.querySelector('img')).toBeNull();
    expect(made).toEqual([]);
  });

  it('says what went wrong when the renderer fails, and offers another go', () => {
    const el = dialog();
    workers[0].reply({ kind: 'error', message: 'out of memory' });
    expect(el.textContent).toContain('out of memory');
    act(() => byText(el, 'button', 'Try again').click());
    expect(workers).toHaveLength(2);
  });

  it('starts no worker for a session with nothing in it', () => {
    const el = dialog({ events: () => [] });
    expect(workers).toHaveLength(0);
    expect(el.textContent).toContain('Nothing to render yet');
  });

  it('lets go of each finished GIF when it is replaced and when the dialog closes', () => {
    const el = dialog();
    workers[0].reply({ kind: 'done', gif: new ArrayBuffer(8), info: INFO });
    act(() => radio(el, '10 s').click());
    expect(revoked).toEqual(['blob:test/0']);
    workers[1].reply({ kind: 'done', gif: new ArrayBuffer(8), info: INFO });
    act(() => root?.unmount());
    root = null;
    expect(revoked).toEqual(['blob:test/0', 'blob:test/1']);
  });
});

describe('what is in the clip', () => {
  it('names the transcript text before anything is downloaded, and says what hiding it removes', () => {
    const el = dialog();
    const box = checkbox(el);
    const what = document.getElementById(box.getAttribute('aria-describedby')!)!;
    expect(what.textContent).toBe('no task, names or speech from your transcripts — people and desks only');
    expect(byText(el, 'label', 'Hide transcript text')).toContain(box);

    const privacy = document.getElementById(el.querySelector('[role="dialog"]')!.getAttribute('aria-describedby')!)!;
    expect(privacy.textContent).toContain('Look at it before you post it.');
    act(() => box.click());
    expect(privacy.textContent).toContain('Text hidden');
    expect(privacy.textContent).not.toContain('Look at it');
  });

  it('says so when the page does not hold the whole session', () => {
    expect(dialog().textContent).not.toContain('partway');
    act(() => root?.unmount());
    const el = dialog({ missing: 600 });
    expect(el.textContent).toContain('starts partway through');
    expect(el.textContent).toContain('roundtable --gif');
  });

  it('links nowhere but the GIF it made — no share intents, nothing outbound', () => {
    const el = dialog();
    workers[0].reply({ kind: 'done', gif: new ArrayBuffer(8), info: INFO });
    const hrefs = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['blob:test/0']);
    expect(el.querySelectorAll('form, iframe')).toHaveLength(0);
  });
});

describe('the caption', () => {
  it('is the line to post, and the command that makes one', () => {
    expect(CAPTION).toContain('rendered with Roundtable');
    expect(CAPTION).toContain('npx https://github.com/Kostakurta8/roundtable/releases/latest/download/roundtable.tgz --gif');
    const el = dialog();
    expect((el.querySelector('input.share-caption') as HTMLInputElement).value).toBe(CAPTION);
  });

  it('goes to the clipboard when the browser allows it', async () => {
    const wrote: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void wrote.push(t) },
    });
    const el = dialog();
    await act(async () => byText(el, 'button', 'Copy caption').click());
    expect(wrote).toEqual([CAPTION]);
    expect(el.textContent).toContain('Caption copied');
  });

  it('says so, and points at the line itself, when the browser refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('denied', 'NotAllowedError');
        },
      },
    });
    const el = dialog();
    await act(async () => byText(el, 'button', 'Copy caption').click());
    expect(el.textContent).toContain('refused the clipboard');
  });

  it('survives a page with no clipboard at all', async () => {
    const el = dialog(); // jsdom, like an insecure context, has no `navigator.clipboard`
    await act(async () => byText(el, 'button', 'Copy caption').click());
    expect(el.textContent).toContain('refused the clipboard');
  });
});

describe('the keyboard', () => {
  it('takes focus on open and gives it back on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const el = dialog();
    expect(el.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on Escape, and keeps that press — and every other — from the shell behind it', () => {
    const el = dialog();
    const heard: string[] = [];
    const listen = (e: KeyboardEvent): void => void heard.push(e.key);
    document.addEventListener('keydown', listen);
    try {
      key(document.activeElement!, 't'); // the theme shortcut, pressed at a modal
      key(document.activeElement!, 'Escape');
    } finally {
      document.removeEventListener('keydown', listen);
    }
    expect(closed).toBe(1);
    expect(heard).toEqual([]);
    void el;
  });

  it('holds Tab inside, with each radio group one stop', () => {
    const el = dialog();
    const box = el.querySelector('[role="dialog"]')!;
    const first = document.activeElement!;
    const stops: Element[] = [first];
    for (let i = 0; i < 12; i++) {
      key(document.activeElement!, 'Tab');
      if (document.activeElement === first) break;
      stops.push(document.activeElement!);
    }
    expect(document.activeElement).toBe(first); // it wrapped
    expect(stops.every((s) => box.contains(s))).toBe(true);
    const radios = stops.filter((s): s is HTMLInputElement => s instanceof HTMLInputElement && s.type === 'radio');
    expect(radios.map((r) => r.value)).toEqual(['20', 'busiest']);
    key(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(stops[stops.length - 1]);
  });
});

describe('the Share button', () => {
  const noop = (): void => {};
  const bar = (over: Partial<TopBarProps>): HTMLDivElement =>
    mount(
      <TopBar
        sessions={[]}
        sessionId={null}
        onPick={noop}
        connected
        replaying={false}
        totalTok={0}
        cost={0}
        costPartial={false}
        agents={0}
        theme={{ choice: 'auto', resolved: 'light', set: noop, cycle: noop }}
        dockOpen
        onToggleDock={noop}
        onOpenPalette={noop}
        onOpenHelp={noop}
        seekTs={null}
        onResumeLive={noop}
        onRescan={noop}
        {...over}
      />,
    );

  it('is off until there is something to share, and says why to the mouse and the keyboard alike', () => {
    let opened = 0;
    const el = bar({ onShare: () => opened++, shareWhyNot: 'pick a session first' });
    const btn = el.querySelector<HTMLButtonElement>('.share-open')!;
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.disabled).toBe(false); // still focusable, so the reason can be reached
    expect(btn.title).toContain('pick a session first');
    expect(btn.getAttribute('aria-label')).toContain('pick a session first');
    act(() => btn.click());
    expect(opened).toBe(0);
  });

  it('opens the dialog when there is', () => {
    let opened = 0;
    const el = bar({ onShare: () => opened++, shareWhyNot: null });
    const btn = el.querySelector<HTMLButtonElement>('.share-open')!;
    expect(btn.hasAttribute('aria-disabled')).toBe(false);
    expect(btn.title).toContain('(G)');
    act(() => btn.click());
    expect(opened).toBe(1);
  });

  it('is listed with its key in the help sheet', () => {
    const el = mount(<Help onClose={noop} />);
    const row = byText(el, '.help-row', 'share this session as a GIF');
    expect(row.querySelector('kbd')?.textContent).toBe('G');
  });
});
