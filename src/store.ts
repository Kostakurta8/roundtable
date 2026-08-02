/**
 * Client store: the pure fold from the hub's event stream to what the UI draws.
 *
 * `reduce` never mutates the state it is handed and never touches the DOM, the clock or
 * the network — the same events in the same order always produce the same state, which is
 * what lets the reducer be tested against fixture transcripts with no browser in sight.
 */
import type { Ev } from '../shared/events';

export type RtAgent = { id: string; model?: string; label?: string; status: string; tokens: number };

export type RtMsg = {
  id: number;
  /** An agent id, or one of the two pseudo-authors: the human (`user`) and the feed itself (`system`). */
  agentId: string | 'main' | 'user' | 'system';
  text: string;
  /** The thinking block this message was written with, if the agent published one. */
  thinking?: string;
  chips: string[];
  verdict?: 'ok' | 'err';
  ts: number;
};

/**
 * Reducer bookkeeping. The three fields above it — `agents`, `msgs`, `totalTok` — are what
 * the UI renders; this is the state a fold needs to keep between events, held here rather
 * than in a module variable so `reduce` stays pure and independently testable.
 */
export type RtPending = {
  /** Per agent: a thinking block that has not been attached to a message yet. */
  thinking: Record<string, string>;
  /** Per agent: chips for tools it started before it had said anything. */
  chips: Record<string, string[]>;
  nextId: number;
};

export type RtState = {
  agents: Record<string, RtAgent>;
  msgs: RtMsg[];
  totalTok: number;
  pending: RtPending;
};

export const MAIN = 'main';
export const USER = 'user';
export const SYSTEM = 'system';

export const initialState: RtState = {
  agents: {},
  msgs: [],
  totalTok: 0,
  pending: { thinking: {}, chips: {}, nextId: 1 },
};

/** Status strings land in a fixed-width HUD column, so a long file path cannot be allowed to fill it. */
const STATUS_MAX = 48;
const PROMPT_MAX = 90;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A prompt squeezed onto one system line: whitespace collapsed, then clipped. */
const oneLine = (s: string): string => clip(s.trim().replace(/\s+/g, ' '), PROMPT_MAX);

/**
 * Verdicts are the uppercase markers agents write when they confirm or refute a claim.
 * Matching is case-sensitive on purpose: prose like "confirmed the fix" is not a verdict.
 * A message that mentions both is a refutation — the negative result is the one that matters.
 */
const verdictOf = (text: string): 'ok' | 'err' | undefined =>
  text.includes('REFUTED') ? 'err' : text.includes('CONFIRMED') ? 'ok' : undefined;

/** Keeps `msgs` ascending by ts. Equal timestamps keep arrival order (stable insert). */
function insertByTs(msgs: readonly RtMsg[], msg: RtMsg): RtMsg[] {
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].ts > msg.ts) i--;
  const out = msgs.slice();
  out.splice(i, 0, msg);
  return out;
}

/**
 * Upserts an agent. `patch` must not carry `undefined` values: a second `agentSeen` that
 * arrives without a model must not erase the model an earlier one already established.
 */
function withAgent(
  agents: Readonly<Record<string, RtAgent>>,
  id: string,
  patch: Partial<RtAgent> = {},
): Record<string, RtAgent> {
  const prev: RtAgent | undefined = agents[id];
  const base: RtAgent = prev ?? { id, status: 'idle', tokens: 0 };
  return { ...agents, [id]: { ...base, ...patch, id } };
}

/** Registers the agent if this is the first event seen from it (a truncated backlog can drop `agentSeen`). */
function ensureAgent(state: RtState, id: string): RtState {
  return state.agents[id] ? state : { ...state, agents: withAgent(state.agents, id) };
}

type MsgDraft = {
  agentId: string;
  text: string;
  ts: number;
  thinking?: string;
  chips?: string[];
  verdict?: 'ok' | 'err';
};

function addMsg(state: RtState, draft: MsgDraft): RtState {
  const msg: RtMsg = {
    id: state.pending.nextId,
    agentId: draft.agentId,
    text: draft.text,
    ts: draft.ts,
    chips: draft.chips ?? [],
    ...(draft.thinking ? { thinking: draft.thinking } : {}),
    ...(draft.verdict ? { verdict: draft.verdict } : {}),
  };
  return {
    ...state,
    msgs: insertByTs(state.msgs, msg),
    pending: { ...state.pending, nextId: state.pending.nextId + 1 },
  };
}

/**
 * Appends a chip to the agent's current message — the last one it wrote — because a tool call
 * belongs to the turn that announced it. An agent that has not spoken yet holds its chips until
 * its next message, so nothing is lost and no chip lands on someone else's card.
 */
function attachChip(state: RtState, agentId: string, chip: string): RtState {
  for (let i = state.msgs.length - 1; i >= 0; i--) {
    const msg = state.msgs[i];
    if (msg.agentId !== agentId) continue;
    const msgs = state.msgs.slice();
    msgs[i] = { ...msg, chips: [...msg.chips, chip] };
    return { ...state, msgs };
  }
  const held = state.pending.chips[agentId] ?? [];
  return {
    ...state,
    pending: { ...state.pending, chips: { ...state.pending.chips, [agentId]: [...held, chip] } },
  };
}

/** Drops a key from a record without touching the original. */
function without<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in rec)) return rec as Record<string, T>;
  const out = { ...rec };
  delete out[key];
  return out;
}

export function reduce(state: RtState, ev: Ev): RtState {
  switch (ev.kind) {
    case 'agentSeen': {
      const patch: Partial<RtAgent> = {};
      if (ev.model !== undefined) patch.model = ev.model;
      if (ev.label !== undefined) patch.label = ev.label;
      return { ...state, agents: withAgent(state.agents, ev.ref.agentId, patch) };
    }

    case 'userMessage': {
      // A user turn in the main transcript is the human speaking. The same line in a subagent
      // transcript is the prompt its parent handed down — showing that as the human's own words
      // would put text in their mouth, so it goes to the system lane instead.
      const id = ev.ref.agentId;
      const s = ensureAgent(state, id);
      if (id === MAIN) return addMsg(s, { agentId: USER, text: ev.text, ts: ev.ts });
      return addMsg(s, { agentId: SYSTEM, text: `prompt to ${id} · ${oneLine(ev.text)}`, ts: ev.ts });
    }

    case 'thinking': {
      // Only the latest unattached block survives: an agent that thinks twice before speaking
      // shows the thought it actually acted on.
      const id = ev.ref.agentId;
      const s = ensureAgent(state, id);
      return {
        ...s,
        agents: withAgent(s.agents, id, { status: 'thinking…' }),
        pending: { ...s.pending, thinking: { ...s.pending.thinking, [id]: ev.text } },
      };
    }

    case 'agentText': {
      const id = ev.ref.agentId;
      const s = ensureAgent(state, id);
      const thinking = s.pending.thinking[id];
      const chips = s.pending.chips[id];
      const consumed: RtState = {
        ...s,
        agents: withAgent(s.agents, id, { status: 'talking' }),
        pending: {
          ...s.pending,
          thinking: without(s.pending.thinking, id),
          chips: without(s.pending.chips, id),
        },
      };
      // Only an agent can reach a verdict; the human's own words are never marked as one.
      return addMsg(consumed, {
        agentId: id,
        text: ev.text,
        ts: ev.ts,
        thinking,
        chips,
        verdict: verdictOf(ev.text),
      });
    }

    case 'toolStart': {
      const id = ev.ref.agentId;
      const label = `${ev.tool} ${ev.target ?? ''}`.trim();
      const s = ensureAgent(state, id);
      return attachChip({ ...s, agents: withAgent(s.agents, id, { status: clip(label, STATUS_MAX) }) }, id, label);
    }

    case 'fileEdit': {
      const id = ev.ref.agentId;
      const label = `Edit ${ev.path}`;
      const s = ensureAgent(state, id);
      return attachChip({ ...s, agents: withAgent(s.agents, id, { status: clip(label, STATUS_MAX) }) }, id, label);
    }

    case 'toolResult': {
      const id = ev.ref.agentId;
      const s = ensureAgent(state, id);
      return { ...s, agents: withAgent(s.agents, id, { status: 'idle' }) };
    }

    case 'agentSpawn': {
      // Its own line in the feed rather than a chip: a spawn is an event of the room, not
      // something the parent said, and the office view reads the same message to seat the child.
      const s = ensureAgent(state, ev.ref.agentId);
      // The id is only known once the child writes its own transcript, so a spawn announced by
      // the parent says `subagent` — the child's own opening line names it a moment later.
      const who = ev.childAgentId && ev.childAgentId !== 'pending' ? ev.childAgentId : 'subagent';
      return addMsg(s, { agentId: SYSTEM, text: `spawned ${who} · ${oneLine(ev.prompt)}`, ts: ev.ts });
    }

    case 'usage': {
      const id = ev.ref.agentId;
      const spent = ev.inTok + ev.outTok;
      const s = ensureAgent(state, id);
      return {
        ...s,
        agents: withAgent(s.agents, id, { tokens: (s.agents[id]?.tokens ?? 0) + spent }),
        totalTok: s.totalTok + spent,
      };
    }

    // `sessionSeen` carries nothing the chat feed shows, and anything the server learns to
    // send that this client does not know yet must leave the state exactly as it was.
    default:
      return state;
  }
}

// ---------------------------------------------------------------- appearances

/** The look of one agent: torso tint, name colour, and the two tones of its mini-head. */
export type AgentLook = { tint: string; color: string; skin: string; hair: string };

/**
 * The mockup's five natural-office looks. Muted on purpose — the only saturated colour in the
 * UI is a verdict. Index 0 is the controller's charcoal; the rest are handed out by id hash.
 */
const LOOKS: readonly AgentLook[] = [
  { tint: '#4A4E56', color: '#3A3E44', skin: '#E2A87C', hair: '#2E2A26' }, // charcoal
  { tint: '#3E9AA8', color: '#1E7280', skin: '#B97C50', hair: '#1F1C19' }, // teal
  { tint: '#7E68C8', color: '#5A44B0', skin: '#F0C29E', hair: '#C8A45C' }, // violet
  { tint: '#D89440', color: '#A06A18', skin: '#8E5A38', hair: '#14110E' }, // amber
  { tint: '#D06E88', color: '#B04462', skin: '#F2CBA8', hair: '#8C4A33' }, // rose
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
  if (agentId === 'main') return LOOKS[0];
  return LOOKS[1 + (hash(agentId) % (LOOKS.length - 1))];
}
