/**
 * Client store: the pure fold from the hub's event stream to what the UI draws.
 *
 * `reduce` never mutates the state it is handed and never touches the DOM, the clock or the
 * network — the same events in the same order always produce the same state, which is what lets
 * the reducer be tested against fixture transcripts with no browser in sight.
 */
import {
  addUse,
  useTotal,
  verdictOf,
  ZERO_USE,
  type Ev,
  type TokenUse,
  type UserSource,
} from '../shared/events';
import { estimateCost, modelInfo } from '../shared/models';

/** What an agent is doing right now, as the roster and the office both read it. */
export type AgentPhase = 'idle' | 'thinking' | 'working' | 'talking' | 'done';

export type RtAgent = {
  id: string;
  model?: string;
  /** The caller's own sentence for the task, from the agent's sidecar. */
  label?: string;
  agentType?: string;
  /** The parent's `Task` tool id; resolved to `parentId` once that spawn is seen. */
  parentToolUseId?: string;
  parentId?: string;
  spawnDepth?: number;
  workflowId?: string;
  /** Free text for the HUD: the current tool line, or a phase word. */
  status: string;
  phase: AgentPhase;
  use: TokenUse;
  /**
   * The same tokens, split by the model that billed them.
   *
   * 9% of real transcripts carry more than one model — a `/model` switch, or an overload fallback
   * — and an agent's whole total priced at whichever model spoke first is wrong by the ratio
   * between two rate cards, which between Opus and Haiku is fifteen. The empty-string key holds
   * tokens billed before any model was known; it is merged into the real one as soon as a name
   * arrives.
   */
  useByModel: Record<string, TokenUse>;
  /** `useTotal(use)`, kept alongside so the hot paths do not re-add four numbers per render. */
  tokens: number;
  /** Estimated USD across the models that have a rate card; `undefined` when none of them do. */
  cost?: number;
  /** True when some of this agent's tokens were billed by a model with no rate card. */
  costPartial: boolean;
  /** Tool calls started but not yet resolved. Status only clears when this reaches zero. */
  activeTools: number;
  /** How many times each tool has been called, for the per-agent histogram. */
  toolCounts: Record<string, number>;
  /** Tool calls that came back `is_error`. */
  errors: number;
  /** Messages this agent has contributed to the feed. */
  says: number;
  firstTs: number;
  lastTs: number;
};

/** One tool call as the feed and the tools panel show it. */
export type RtTool = {
  id: string;
  agentId: string;
  tool: string;
  target?: string;
  label: string;
  ts: number;
  /** `undefined` while the call is still running. */
  ok?: boolean;
  /** Milliseconds from start to result; `undefined` while running. */
  ms?: number;
  /**
   * What the failure said, when it failed and said anything.
   *
   * Kept on the call rather than on the agent because that is where a reader looks for it: the red
   * row is the question, and this is the answer to it. `ok === false` with no `error` is a real
   * state — a failure whose `tool_result` carried no text — and the panel says so out loud rather
   * than rendering an empty box.
   */
  error?: string;
  /**
   * Lines this call added to a file and removed from it, when it changed one.
   *
   * They live on the call rather than in a list of their own because the call is what every
   * surface already draws — the tools stream, the chip on the message that announced it, the
   * inspector's recent calls — so "what did this agent do to my code" is answered in the place the
   * question is asked, with no fourth panel to go and find.
   *
   * Absent is not zero. `undefined` means the tool call did not carry enough to count (a
   * `NotebookEdit`, or a vintage that shapes its input differently); `0` means the change really
   * was empty. Rendering the first as the second would state a measurement nobody made.
   */
  added?: number;
  removed?: number;
};

export type RtMsg = {
  id: number;
  /** An agent id, or one of the two pseudo-authors: the human (`user`) and the feed itself (`system`). */
  agentId: string | 'main' | 'user' | 'system';
  text: string;
  /** The thinking block this message was written with, if the agent published one. */
  thinking?: string;
  tools: RtTool[];
  verdict?: 'ok' | 'err';
  /** For a `user` message: who actually wrote it. Absent for agent and system lines. */
  source?: UserSource;
  ts: number;
};

/**
 * A one-second slice of activity, for the timeline strip. Buckets rather than raw events: a busy
 * session produces tens of thousands of events, and the strip is 600 pixels wide.
 */
export type RtBucket = {
  /** Epoch ms, floored to the bucket size. */
  t: number;
  says: number;
  tools: number;
  thinks: number;
  errors: number;
};

export type RtPending = {
  /** Per agent: a thinking block that has not been attached to a message yet. */
  thinking: Record<string, string>;
  /** Per agent: tools it started before it had said anything. */
  tools: Record<string, RtTool[]>;
  /** Tool id → the call, so a `toolResult` can find what it is resolving. */
  open: Record<string, RtTool>;
  /**
   * Per agent: the message its current turn is writing into.
   *
   * Tool calls belong to the turn that announced them, and a turn that *opens* with a tool call
   * has no message yet — so the call has to wait rather than land on whatever the agent last
   * said. Walking backwards through `msgs` for the agent's most recent card looked equivalent and
   * was not: after a new user prompt it hung the new turn's tools on the previous turn's card,
   * across the prompt that separated them. Cleared whenever a user turn opens a new exchange.
   */
  card: Record<string, number>;
  nextId: number;
};

export type RtState = {
  agents: Record<string, RtAgent>;
  /** Roster order: the order agents were first seen, which is the order the office seats them. */
  order: string[];
  msgs: RtMsg[];
  /** The most recent tool calls across all agents, newest last. */
  tools: RtTool[];
  buckets: RtBucket[];
  /**
   * The session's opening human prompt, captured once.
   *
   * Derived in the shell it used to be read from `msgs.find(first user turn)`, which is only the
   * opening prompt until the cap trims it — after that the whiteboard and the feed's title
   * silently re-pointed at whatever the oldest surviving prompt happened to be, with nothing on
   * screen to say the task had changed.
   */
  task?: string;
  /** How many of the oldest messages the cap has dropped, so the feed can say so out loud. */
  trimmed: number;
  use: TokenUse;
  totalTok: number;
  /** Estimated USD across every agent with a known rate card. */
  cost: number;
  /** True when at least one agent's model has no rate card, so the figure is a floor. */
  costPartial: boolean;
  /** The highest `seq` folded so far. Anything at or below it is a replay and is ignored. */
  lastSeq: number;
  firstTs: number;
  lastTs: number;
  /** `Task` tool id → the child it spawned, so a spawn line can name the agent it created. */
  spawns: Record<string, string>;
  pending: RtPending;
  /**
   * Which session this state is a fold of, and what the hub knows about it.
   *
   * Only meaningful once `sessionSeen` has arrived. It exists because the client now holds one of
   * these per session rather than one at a time: a state that could not name itself would be
   * indistinguishable from any other in the map it lives in.
   */
  sessionId?: string;
  /** The working directory the session runs in, from the CLI's own registry. */
  cwd?: string;
  /** Whether the CLI still had this session registered when the hub last looked. */
  sessionLive?: boolean;
};

export const MAIN = 'main';
export const USER = 'user';
export const SYSTEM = 'system';

/**
 * The longest the feed is allowed to get. A day-long session produces tens of thousands of
 * turns, and every one of them is an array entry the panel re-renders and a DOM node the browser
 * keeps alive — unbounded, that is a leak with a scrollbar. What falls off the top is counted,
 * not hidden.
 */
export const MSG_CAP = 1000;
/** The tool strip is a live view, not a log; older calls stay on their message cards. */
export const TOOL_CAP = 400;
export const BUCKET_MS = 1000;
/** Twenty minutes of one-second buckets — past that the strip coarsens by dropping the head. */
export const BUCKET_CAP = 1200;

export const initialState: RtState = {
  agents: {},
  order: [],
  msgs: [],
  tools: [],
  buckets: [],
  trimmed: 0,
  use: ZERO_USE,
  totalTok: 0,
  cost: 0,
  costPartial: false,
  lastSeq: 0,
  firstTs: 0,
  lastTs: 0,
  spawns: {},
  pending: { thinking: {}, tools: {}, open: {}, card: {}, nextId: 1 },
};

/** Status strings land in a fixed-width HUD column, so a long file path cannot be allowed to fill it. */
const STATUS_MAX = 48;
const PROMPT_MAX = 90;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A prompt squeezed onto one system line: whitespace collapsed, then clipped. */
const oneLine = (s: string): string => clip(s.trim().replace(/\s+/g, ' '), PROMPT_MAX);

/** Keeps `msgs` ascending by ts. Equal timestamps keep arrival order (stable insert). */
function insertByTs(msgs: readonly RtMsg[], msg: RtMsg): RtMsg[] {
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].ts > msg.ts) i--;
  const out = msgs.slice();
  out.splice(i, 0, msg);
  return out;
}

const capTail = <T>(xs: readonly T[], cap: number): T[] =>
  xs.length > cap ? xs.slice(xs.length - cap) : (xs as T[]);

/**
 * Upserts an agent. `patch` must not carry `undefined` values: a second `agentSeen` that
 * arrives without a model must not erase the model an earlier one already established.
 */
function withAgent(state: RtState, id: string, patch: Partial<RtAgent> = {}): RtState {
  const prev = state.agents[id];
  const base: RtAgent = prev ?? {
    id,
    status: '',
    phase: 'idle',
    use: ZERO_USE,
    useByModel: {},
    tokens: 0,
    costPartial: false,
    activeTools: 0,
    toolCounts: {},
    errors: 0,
    says: 0,
    firstTs: 0,
    lastTs: 0,
  };
  const next: RtAgent = { ...base, ...patch, id };
  return {
    ...state,
    agents: { ...state.agents, [id]: next },
    order: prev ? state.order : [...state.order, id],
  };
}

/** Registers the agent if this is the first event seen from it (a truncated backlog can drop `agentSeen`). */
const ensureAgent = (state: RtState, id: string): RtState =>
  state.agents[id] ? state : withAgent(state, id);

type MsgDraft = {
  agentId: string;
  text: string;
  ts: number;
  thinking?: string;
  tools?: RtTool[];
  verdict?: 'ok' | 'err';
  source?: UserSource;
};

function addMsg(state: RtState, draft: MsgDraft): RtState {
  const msg: RtMsg = {
    id: state.pending.nextId,
    agentId: draft.agentId,
    text: draft.text,
    ts: draft.ts,
    tools: draft.tools ?? [],
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(draft.verdict ? { verdict: draft.verdict } : {}),
    ...(draft.source ? { source: draft.source } : {}),
  };
  // The one place a message enters the feed, and so the one place the cap has to hold. Trimming
  // from the head keeps both invariants the rest of the store leans on: what is left is still
  // ascending by ts, and no id is ever reused or renumbered.
  const grown = insertByTs(state.msgs, msg);
  const over = Math.max(0, grown.length - MSG_CAP);
  // An agent's own card becomes the one its next tool calls hang on; the human and system lanes
  // never collect tools, so they leave the pointer alone.
  const isAgent = draft.agentId !== USER && draft.agentId !== SYSTEM;
  return {
    ...state,
    msgs: over > 0 ? grown.slice(over) : grown,
    trimmed: state.trimmed + over,
    pending: {
      ...state.pending,
      nextId: state.pending.nextId + 1,
      ...(isAgent ? { card: { ...state.pending.card, [draft.agentId]: msg.id } } : {}),
    },
  };
}

/**
 * Appends a tool call to the agent's current message — the last one it wrote — because a tool
 * call belongs to the turn that announced it. An agent that has not spoken yet holds its calls
 * until its next message, so nothing is lost and no chip lands on someone else's card.
 */
function attachTool(state: RtState, agentId: string, tool: RtTool): RtState {
  const cardId = state.pending.card[agentId];
  if (cardId !== undefined) {
    const i = state.msgs.findIndex((m) => m.id === cardId);
    if (i !== -1) {
      const msgs = state.msgs.slice();
      msgs[i] = { ...msgs[i], tools: [...msgs[i].tools, tool] };
      return { ...state, msgs };
    }
  }
  const held = state.pending.tools[agentId] ?? [];
  return {
    ...state,
    pending: { ...state.pending, tools: { ...state.pending.tools, [agentId]: [...held, tool] } },
  };
}

/**
 * Rewrites one tool call in place wherever it ended up — on a message card, in the live strip,
 * still held as pending, and in the open-call table. A result can arrive long after its call, and
 * after the card it belongs to has scrolled past a thousand others, so every home is checked.
 *
 * The open-call table is one of them, which it did not used to be. `resolveTool` rebuilt the
 * finished row from the copy parked there at `toolStart`, so anything written on to a call between
 * its start and its result was discarded the moment it came back — silently, and for every edit
 * that took longer than nothing.
 *
 * A patch, not a replacement, and one pass per home: a list with no matching call keeps its
 * identity, so the memoised feed does not re-diff a thousand cards over a call that is not on any
 * of them.
 */
function patchTool(state: RtState, id: string, agentId: string, patch: Partial<RtTool>): RtState {
  /** The list with the call patched, or `null` when the call is not in it. */
  const patched = (list: readonly RtTool[]): RtTool[] | null => {
    let out: RtTool[] | null = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      if (out === null) out = list.slice();
      out[i] = { ...list[i], ...patch };
    }
    return out;
  };

  let msgs = state.msgs;
  for (let i = 0; i < msgs.length; i++) {
    const tools = patched(msgs[i].tools);
    if (tools === null) continue;
    if (msgs === state.msgs) msgs = msgs.slice();
    msgs[i] = { ...msgs[i], tools };
  }

  const tools = patched(state.tools) ?? state.tools;

  const heldFor = state.pending.tools[agentId];
  const heldPatched = heldFor ? patched(heldFor) : null;
  const held = heldPatched ? { ...state.pending.tools, [agentId]: heldPatched } : state.pending.tools;

  const openCall = state.pending.open[id];
  const open = openCall ? { ...state.pending.open, [id]: { ...openCall, ...patch } } : state.pending.open;

  return { ...state, msgs, tools, pending: { ...state.pending, tools: held, open } };
}

/** Marks a call finished wherever it lives, and stops waiting on it. */
function resolveTool(state: RtState, id: string, ok: boolean, ts: number, error?: string): RtState {
  const open = state.pending.open[id];
  if (!open) return state;
  const s = patchTool(state, id, open.agentId, {
    ok,
    ms: Math.max(0, ts - open.ts),
    ...(error === undefined ? {} : { error }),
  });
  return { ...s, pending: { ...s.pending, open: without(s.pending.open, id) } };
}

/**
 * The agent's most recent tool call, but only while it is still open.
 *
 * `fileEdit` carries no `tool_use` id of its own, so this is the join: the normalizer derives it
 * from a `tool_use` it has just published as `toolStart`, and nothing of that agent's can have
 * landed in between. Refusing a call that has already reported back is what keeps a stray edit —
 * from a backlog that lost the `toolStart` — off whatever the agent happened to do last.
 */
function lastOpenCallOf(state: RtState, agentId: string): RtTool | undefined {
  for (let i = state.tools.length - 1; i >= 0; i--) {
    const t = state.tools[i];
    if (t.agentId !== agentId) continue;
    return t.ok === undefined ? t : undefined;
  }
  return undefined;
}

/**
 * That agent's call with this `tool_use` id, whether or not it has already reported back.
 *
 * Scanned from the end because the call being looked for is almost always the most recent one, and
 * scoped to the agent because a `tool_use` id is only unique within the process that minted it.
 * Unlike `lastOpenCallOf` this does not refuse a call that has returned: an id is proof of which
 * call the edit belongs to, so a result that happened to land first is no reason to drop the
 * counts on the floor.
 */
function callById(state: RtState, toolUseId: string, agentId: string): RtTool | undefined {
  for (let i = state.tools.length - 1; i >= 0; i--) {
    const t = state.tools[i];
    if (t.id === toolUseId && t.agentId === agentId) return t;
  }
  return undefined;
}

/** Drops a key from a record without touching the original. */
function without<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in rec)) return rec as Record<string, T>;
  const out = { ...rec };
  delete out[key];
  return out;
}

/** Folds one event into the activity buckets the timeline strip draws. */
function bump(state: RtState, ts: number, field: keyof Omit<RtBucket, 't'>): RtBucket[] {
  const t = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
  const last = state.buckets[state.buckets.length - 1];
  if (last && last.t === t) {
    const out = state.buckets.slice();
    out[out.length - 1] = { ...last, [field]: last[field] + 1 };
    return out;
  }
  // Out-of-order timestamps land in whichever bucket already covers them; anything older than the
  // whole strip is dropped rather than prepended, so the strip stays sorted without a re-sort.
  if (last && t < last.t) {
    const i = state.buckets.findIndex((b) => b.t === t);
    if (i === -1) return state.buckets;
    const out = state.buckets.slice();
    out[i] = { ...out[i], [field]: out[i][field] + 1 };
    return out;
  }
  return capTail([...state.buckets, { t, says: 0, tools: 0, thinks: 0, errors: 0, [field]: 1 }], BUCKET_CAP);
}

/** The `useByModel` key for tokens counted before any model had been named. */
const UNPRICED = '';

/**
 * What one agent's tokens cost, model by model.
 *
 * `cost` is `undefined` only when *nothing* could be priced, which is the distinction the HUD
 * needs between "we will not guess" and "free". `partial` says some tokens were billed by a model
 * this build has no rate card for — that is what turns the estimate into a floor, and it is now
 * possible for both to be true of the same agent, which is exactly why the two are separate.
 */
function priceOf(useByModel: Readonly<Record<string, TokenUse>>): { cost?: number; partial: boolean } {
  let cost = 0;
  let priced = false;
  let partial = false;
  for (const [model, use] of Object.entries(useByModel)) {
    const usd = estimateCost(model, use);
    if (usd === undefined) {
      if (useTotal(use) > 0) partial = true;
    } else {
      priced = true;
      cost += usd;
    }
  }
  return priced ? { cost, partial } : { partial };
}

/** Recomputes the roll-up an agent's own numbers feed into. */
function retotal(state: RtState): RtState {
  let use = ZERO_USE;
  let cost = 0;
  let partial = false;
  for (const id of state.order) {
    const a = state.agents[id];
    if (!a) continue;
    use = addUse(use, a.use);
    if (a.costPartial) partial = true;
    if (a.cost === undefined) {
      if (useTotal(a.use) > 0) partial = true;
    } else {
      cost += a.cost;
    }
  }
  return { ...state, use, totalTok: useTotal(use), cost, costPartial: partial };
}

/** Every fold advances the session clock, so "how long has this been running" needs no wall clock. */
function stamp(state: RtState, ts: number): RtState {
  if (!Number.isFinite(ts)) return state;
  return {
    ...state,
    firstTs: state.firstTs === 0 ? ts : Math.min(state.firstTs, ts),
    lastTs: Math.max(state.lastTs, ts),
  };
}

function touch(state: RtState, id: string, ts: number, patch: Partial<RtAgent> = {}): RtState {
  const prev = state.agents[id];
  return withAgent(state, id, {
    ...patch,
    firstTs: prev?.firstTs ? prev.firstTs : ts,
    lastTs: ts,
  });
}

export function reduce(state: RtState, ev: Ev): RtState {
  // Idempotence, and the reason every frame carries a monotonic `seq`. The hub replays a
  // session's whole backlog to every new follower and re-reads a file whenever the watcher says
  // it changed, so the same event genuinely can arrive twice — and folding it twice used to
  // double an agent's token count and print its message a second time.
  if (ev.seq <= state.lastSeq) return state;
  const s0: RtState = stamp({ ...state, lastSeq: ev.seq }, ev.ts);

  switch (ev.kind) {
    case 'agentSeen': {
      const id = ev.ref.agentId;
      const patch: Partial<RtAgent> = {};
      if (ev.model !== undefined) patch.model = ev.model;
      if (ev.label !== undefined) patch.label = ev.label;
      if (ev.agentType !== undefined) patch.agentType = ev.agentType;
      if (ev.spawnDepth !== undefined) patch.spawnDepth = ev.spawnDepth;
      if (ev.workflowId !== undefined) patch.workflowId = ev.workflowId;
      if (ev.parentToolUseId !== undefined) {
        patch.parentToolUseId = ev.parentToolUseId;
        // The spawn line may have arrived first, in which case the parent is already known.
        const parent = state.spawns[ev.parentToolUseId];
        if (parent) patch.parentId = parent;
      }
      // A model can arrive after usage has already been counted — an opening user turn names none
      // — so the estimate is recomputed from the buckets rather than accumulated per event, and
      // whatever was billed before the name arrived is handed to the name that did.
      const s1 = touch(s0, id, ev.ts, patch);
      const a = s1.agents[id];
      const orphan = a.useByModel[UNPRICED];
      const useByModel =
        a.model && orphan
          ? {
              ...without(a.useByModel, UNPRICED),
              [a.model]: addUse(a.useByModel[a.model] ?? ZERO_USE, orphan),
            }
          : a.useByModel;
      const priced = priceOf(useByModel);
      return retotal(withAgent(s1, id, { useByModel, cost: priced.cost, costPartial: priced.partial }));
    }

    case 'userMessage': {
      // A user turn in the main transcript is the human speaking. The same line in a subagent
      // transcript is the prompt its parent handed down — showing that as the human's own words
      // would put text in their mouth, so it goes to the system lane instead.
      const id = ev.ref.agentId;
      // A new turn is opening for this agent, so its previous card stops collecting tool calls.
      const touched = touch(s0, id, ev.ts);
      const s: RtState = { ...touched, pending: { ...touched.pending, card: without(touched.pending.card, id) } };
      if (id !== MAIN) {
        return addMsg(s, { agentId: SYSTEM, text: `prompt to ${id} · ${oneLine(ev.text)}`, ts: ev.ts });
      }
      const source = ev.source ?? 'human';
      // The task is the first thing a human actually typed — not a slash-command echo, and not
      // whatever prompt survives once the cap has eaten the opening of a long session.
      const withTask: RtState =
        s.task === undefined && source === 'human' ? { ...s, task: oneLine(ev.text) } : s;
      return addMsg(withTask, { agentId: USER, text: ev.text, ts: ev.ts, source });
    }

    case 'thinking': {
      // Only the latest unattached block survives: an agent that thinks twice before speaking
      // shows the thought it actually acted on.
      const id = ev.ref.agentId;
      const s = touch(s0, id, ev.ts, { phase: 'thinking', status: 'thinking…' });
      return {
        ...s,
        buckets: bump(s, ev.ts, 'thinks'),
        pending: { ...s.pending, thinking: { ...s.pending.thinking, [id]: ev.text } },
      };
    }

    case 'agentText': {
      const id = ev.ref.agentId;
      const prev = s0.agents[id];
      const s = touch(s0, id, ev.ts, { phase: 'talking', status: 'talking', says: (prev?.says ?? 0) + 1 });
      const thinking = s.pending.thinking[id];
      const tools = s.pending.tools[id];
      const consumed: RtState = {
        ...s,
        buckets: bump(s, ev.ts, 'says'),
        pending: {
          ...s.pending,
          thinking: without(s.pending.thinking, id),
          tools: without(s.pending.tools, id),
        },
      };
      // Only an agent can reach a verdict; the human's own words are never marked as one.
      return addMsg(consumed, {
        agentId: id,
        text: ev.text,
        ts: ev.ts,
        thinking,
        tools,
        verdict: verdictOf(ev.text),
      });
    }

    case 'toolStart': {
      const id = ev.ref.agentId;
      const label = `${ev.tool} ${ev.target ?? ''}`.trim();
      const call: RtTool = {
        id: ev.toolUseId,
        agentId: id,
        tool: ev.tool,
        target: ev.target,
        label,
        ts: ev.ts,
      };
      const prev = s0.agents[id];
      const s = touch(s0, id, ev.ts, {
        phase: 'working',
        status: clip(label, STATUS_MAX),
        activeTools: (prev?.activeTools ?? 0) + 1,
        toolCounts: { ...(prev?.toolCounts ?? {}), [ev.tool]: (prev?.toolCounts?.[ev.tool] ?? 0) + 1 },
      });
      return attachTool(
        {
          ...s,
          tools: capTail([...s.tools, call], TOOL_CAP),
          buckets: bump(s, ev.ts, 'tools'),
          pending: { ...s.pending, open: { ...s.pending.open, [ev.toolUseId]: call } },
        },
        id,
        call,
      );
    }

    case 'fileEdit': {
      // Derived from a tool_use the normalizer already reported as `toolStart`, never a separate
      // action — so the chip for it exists by the time this arrives. Adding a second one printed
      // every edit twice, and for Write printed one action under two names ("Write x", "Edit x").
      // The status is still set here: it is the signal that survives if a truncated backlog ate
      // the toolStart, and it is what the office view reads to know a file is being changed.
      const id = ev.ref.agentId;
      const s = touch(s0, id, ev.ts, { phase: 'working', status: clip(`Edit ${ev.path}`, STATUS_MAX) });
      // What the edit *did*, folded on to the call that did it. Absent counts are left absent
      // rather than written as zero: "the input did not say" and "nothing changed" are two facts
      // and only one of them is worth printing.
      if (ev.added === undefined && ev.removed === undefined) return s;
      // The id when the hub sends one, the heuristic when it does not. A hub of an older vintage
      // omits it, and losing the counts outright would be a worse answer than the positional
      // guess that was right for every case before the id existed.
      const call = ev.toolUseId === undefined ? lastOpenCallOf(s, id) : callById(s, ev.toolUseId, id);
      if (!call) return s;
      return patchTool(s, call.id, id, {
        ...(ev.added === undefined ? {} : { added: ev.added }),
        ...(ev.removed === undefined ? {} : { removed: ev.removed }),
      });
    }

    case 'toolResult': {
      const id = ev.ref.agentId;
      const prev = s0.agents[id];
      // One result does not mean the agent is free: tools are called in parallel, and clearing
      // the status on the first return used to blank the HUD while three more were still running.
      const active = Math.max(0, (prev?.activeTools ?? 0) - 1);
      const errors = (prev?.errors ?? 0) + (ev.ok ? 0 : 1);
      const s = touch(s0, id, ev.ts, {
        activeTools: active,
        errors,
        ...(active === 0 ? { phase: 'idle' as const, status: '' } : {}),
      });
      const resolved = resolveTool(s, ev.toolUseId, ev.ok, ev.ts, ev.error);
      return ev.ok ? resolved : { ...resolved, buckets: bump(resolved, ev.ts, 'errors') };
    }

    case 'agentSpawn': {
      // Its own line in the feed rather than a chip: a spawn is an event of the room, not
      // something the parent said, and the office view reads the same message to seat the child.
      const parent = ev.ref.agentId;
      const s = touch(s0, parent, ev.ts);
      // The child's id is only known once its sidecar lands, so remember which `Task` call this
      // was; `agentSeen` carries the same id back and the two halves are joined then.
      const spawns = ev.toolUseId ? { ...s.spawns, [ev.toolUseId]: parent } : s.spawns;
      // The join has to work from both directions. A child's sidecar is read by its own timer,
      // independent of the main transcript's pump, so `agentSeen` genuinely can be folded before
      // the spawn line that explains it — and the `agentSeen` case can only look the parent up in
      // a `spawns` map that does not have it yet. Handled only there, the edge was lost for good:
      // the child rendered as a root of the tree rather than under its parent, and the Inspector's
      // PARENT row was simply absent.
      const orphan = ev.toolUseId
        ? s.order.find((aid) => s.agents[aid]?.parentToolUseId === ev.toolUseId && !s.agents[aid]?.parentId)
        : undefined;
      const joined = orphan ? withAgent(s, orphan, { parentId: parent }) : s;
      const known = ev.childAgentId && ev.childAgentId !== 'pending' ? ev.childAgentId : undefined;
      const who = known ?? 'a subagent';
      return addMsg(
        { ...joined, spawns },
        { agentId: SYSTEM, text: `spawned ${who} · ${oneLine(ev.prompt)}`, ts: ev.ts },
      );
    }

    case 'agentDone': {
      const id = ev.ref.agentId;
      const s1 = touch(s0, id, ev.ts, { phase: 'done', status: ev.ok ? 'done' : 'failed', activeTools: 0 });
      // Its open calls are never going to be answered — the agent that would have written those
      // results has stopped. Zeroing `activeTools` without settling them left the tools panel
      // counting a finished agent's calls as RUNNING and its chips spinning for the rest of the
      // session: the app waiting for something that will never arrive, with nothing on screen
      // saying so. They are closed as unsuccessful, because from here that is exactly what they
      // are — with the reason spelled out rather than a cause invented for them.
      const s = Object.entries(s1.pending.open)
        .filter(([, t]) => t.agentId === id)
        .reduce(
          (acc, [toolUseId]) =>
            resolveTool(acc, toolUseId, false, ev.ts, 'the agent finished before this call reported back'),
          s1,
        );
      const a = s.agents[id];
      return addMsg(s, {
        agentId: SYSTEM,
        text: `${a.label ?? id} finished${ev.ok ? '' : ' with an error'}`,
        ts: ev.ts,
      });
    }

    case 'usage': {
      const id = ev.ref.agentId;
      const delta: TokenUse = {
        in: ev.inTok,
        out: ev.outTok,
        cacheRead: ev.cacheRead ?? 0,
        cacheWrite: ev.cacheWrite ?? 0,
      };
      const prev = s0.agents[id];
      // The event names the model that billed these tokens. When the line carried none, the best
      // attribution available is whatever this agent is currently known to be running; when even
      // that is unknown the tokens wait in the unpriced bucket for a name.
      const model = ev.model ?? prev?.model ?? UNPRICED;
      const useByModel = {
        ...(prev?.useByModel ?? {}),
        [model]: addUse(prev?.useByModel?.[model] ?? ZERO_USE, delta),
      };
      const use = addUse(prev?.use ?? ZERO_USE, delta);
      const priced = priceOf(useByModel);
      const s = touch(s0, id, ev.ts, {
        use,
        useByModel,
        tokens: useTotal(use),
        cost: priced.cost,
        costPartial: priced.partial,
      });
      return retotal(s);
    }

    case 'workflowPhase': {
      // One settled line in the feed, in the past tense, and deliberately nothing else.
      //
      // The temptation is a phase bar, and it would be a lie: the only artifact on disk describing
      // phases is written once, when the run *terminates*, so this event cannot arrive while there
      // is anything left to show progress about. Drawn as a live tracker it would sit at 0% for the
      // twenty-six minutes a real run takes and then jump straight to finished — an indicator that
      // is wrong for the entire period anybody would look at it.
      //
      // So it is a record, and it reads as one. `order` rather than `index` decides the sequence:
      // `index` is a registration number and the first agent queued on a real run carries a higher
      // one than the eighty-eight after it.
      const phases = [...ev.phases].sort((a, b) => a.order - b.order);
      const named = ev.workflowName ? `workflow ${ev.workflowName}` : 'workflow';
      const agents = phases.reduce((n, p) => n + p.agents.length, 0);
      // Where it was standing when it stopped, which is only interesting when it stopped early.
      const cut = phases.find((p) => p.order === ev.activePhase);
      const route = phases.map((p) => p.title).join(' → ');
      return addMsg(s0, {
        agentId: SYSTEM,
        text:
          `${named} ${ev.status} · ${phases.length} phase${phases.length === 1 ? '' : 's'}, ` +
          `${agents} agent${agents === 1 ? '' : 's'}` +
          (cut ? ` · stopped in ${cut.title}` : '') +
          (route ? ` · ${route}` : ''),
        ts: ev.ts,
      });
    }

    case 'sessionSeen':
      // The hub sends this the moment it starts streaming a session, ahead of anything read off
      // disk. It is the only event that arrives for a session that is running and has written
      // nothing since — which is precisely the session the tab strip would otherwise never hear
      // about, because every other event is about an agent and there is not yet an agent.
      return { ...s0, sessionId: ev.sessionId, cwd: ev.cwd, sessionLive: ev.live };

    // Anything the server learns to send that this client does not know yet must leave the state
    // exactly as it was.
    default:
      return s0;
  }
}

// ------------------------------------------------------------------ derived

/**
 * How many turns this session has had — not how many rows the feed is holding.
 *
 * The two were the same number until the cap bit, and then they parted for ever: `msgs.length`
 * stops at `MSG_CAP` and stays there, so a session that had been running for an hour reported
 * exactly a thousand turns for the rest of its life. It froze at the moment it became interesting,
 * and it froze on a number that had been true earlier, which is the kind of wrong that is never
 * noticed. `trimmed` is the rest of the answer.
 *
 * Anything asking "how many cards am I about to render" wants `msgs.length` and should keep it.
 */
export const turnCount = (state: RtState): number => state.msgs.length + state.trimmed;

/** The roster in office order, which is the order agents were first seen. */
export const roster = (state: RtState): RtAgent[] =>
  state.order.map((id) => state.agents[id]).filter((a): a is RtAgent => a !== undefined);

/**
 * How long an agent that is not holding an open tool call may be silent and still count as
 * working. Matches the hub's own liveness window, so "this session is running" and "somebody in
 * it is working" are not measured on two different clocks.
 */
export const WORKING_WINDOW_MS = 90_000;

/**
 * How long an agent holding an *unresolved* tool call counts as working while silent.
 *
 * A `Bash` that compiles a project, a `WebFetch` on a slow host, a subagent that has been thinking
 * for four minutes: all of them are working and none of them writes a line while they do it, so
 * the 90-second window alone would call them finished. The grace is bounded rather than infinite
 * because an open call is not always real — a `tool_result` carried on a line over 1 MiB is
 * dropped unparsed, and that call would otherwise stay open for the rest of the session and keep
 * a dead session's tab on screen for ever.
 */
export const OPEN_TOOL_GRACE_MS = 15 * 60_000;

/**
 * The agents of one session that are working *now*.
 *
 * This is the definition the tab strip turns on, so it is worth being explicit about what it
 * deliberately does not count.
 *
 * - **`main` never counts.** It is the session, not a participant in it. A window sitting at an
 *   idle prompt has a `main` and nothing else, and it must not raise a tab — "more than one
 *   session has agents working" would otherwise be true of any two open terminals.
 * - **The hub's roster `live` flag is not enough on its own.** It means the session was
 *   *registered and touched* within 90 seconds, which a session says about itself simply by
 *   existing. It is a necessary condition and the caller applies it; it is not this one.
 * - **An agent that has finished does not count**, even if its closing report is still arriving.
 *
 * What is left is an agent that is not `main`, has not finished, and has either shown activity
 * inside the window or is holding a tool call open.
 */
export function workingAgents(state: RtState, now: number): RtAgent[] {
  const out: RtAgent[] = [];
  for (const id of state.order) {
    const a = state.agents[id];
    if (!a || id === MAIN || a.phase === 'done') continue;
    const quiet = now - a.lastTs;
    if (quiet < (a.activeTools > 0 ? OPEN_TOOL_GRACE_MS : WORKING_WINDOW_MS)) out.push(a);
  }
  return out;
}

/** Display name: the sidecar's sentence if there is one, else the bare id. */
export const agentName = (a: RtAgent | undefined, id: string): string => a?.label ?? id;

/** The short model name the HUD prints, e.g. `haiku 4.5`. */
export const agentModel = (a: RtAgent | undefined): string | undefined =>
  a?.model ? modelInfo(a.model).short : undefined;

// ---------------------------------------------------------------- appearances

/** The look of one agent: torso tint, name colour, and the two tones of its mini-head. */
export type AgentLook = { tint: string; color: string; skin: string; hair: string };

/**
 * Natural-office looks, muted on purpose — the only saturated colour in the UI is a verdict.
 * Index 0 is the controller's charcoal; the rest are handed out by id hash. Eight rather than the
 * mockup's five, because a workflow fans out more agents than that and two identical shirts at
 * neighbouring desks read as one person who teleported.
 */
const LOOKS: readonly AgentLook[] = [
  { tint: '#4A4E56', color: '#3A3E44', skin: '#E2A87C', hair: '#2E2A26' }, // charcoal
  { tint: '#3E9AA8', color: '#1E7280', skin: '#B97C50', hair: '#1F1C19' }, // teal
  { tint: '#7E68C8', color: '#5A44B0', skin: '#F0C29E', hair: '#C8A45C' }, // violet
  { tint: '#D89440', color: '#A06A18', skin: '#8E5A38', hair: '#14110E' }, // amber
  { tint: '#D06E88', color: '#B04462', skin: '#F2CBA8', hair: '#8C4A33' }, // rose
  { tint: '#5E8C6A', color: '#3C6B48', skin: '#D89A72', hair: '#3A2E24' }, // moss
  { tint: '#8A7A5C', color: '#6A5A3C', skin: '#EFC3A0', hair: '#5A4432' }, // clay
  { tint: '#6E7FA8', color: '#4A5C88', skin: '#C08E64', hair: '#241F1A' }, // slate blue
];

/** FNV-1a — small, dependency-free, and spreads short ids evenly enough for a palette pick. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Stable per agent id, so an agent keeps the same face for the whole session — and across
 * reloads, since nothing here depends on arrival order. The controller is always charcoal.
 */
export function agentLook(agentId: string): AgentLook {
  if (agentId === MAIN) return LOOKS[0];
  return LOOKS[1 + (hash(agentId) % (LOOKS.length - 1))];
}
