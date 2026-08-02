export type RawLine = {
  type: string;
  uuid?: string;
  agentId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
};

export function parseLine(raw: string): RawLine | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.type !== 'string') return null;
    return o as unknown as RawLine;
  } catch {
    return null;
  }
}
