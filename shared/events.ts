export type AgentRef = { sessionId: string; agentId: string | 'main' };

export type Ev =
  | { kind: 'sessionSeen'; sessionId: string; cwd: string; live: boolean; ts: number; seq: number }
  | { kind: 'agentSeen'; ref: AgentRef; model?: string; label?: string; ts: number; seq: number }
  | { kind: 'userMessage'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'agentText'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'thinking'; ref: AgentRef; text: string; ts: number; seq: number }
  | { kind: 'toolStart'; ref: AgentRef; tool: string; target?: string; toolUseId: string; ts: number; seq: number }
  | { kind: 'toolResult'; ref: AgentRef; toolUseId: string; ok: boolean; ts: number; seq: number }
  | { kind: 'fileEdit'; ref: AgentRef; path: string; ts: number; seq: number }
  | { kind: 'agentSpawn'; ref: AgentRef; childAgentId: string; prompt: string; ts: number; seq: number }
  | { kind: 'usage'; ref: AgentRef; inTok: number; outTok: number; ts: number; seq: number };

export const isEv = (x: unknown): x is Ev =>
  !!x && typeof x === 'object' && 'kind' in (x as object) && 'seq' in (x as object);
