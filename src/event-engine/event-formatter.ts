/**
 * Event formatter — converts StoredEvent records into RendererMessage objects.
 * Uses a registry pattern instead of a monolithic switch-case.
 *
 * Ported from forgeax-cli's `src/channels/ink-renderer/lib/event-formatter.ts`
 * with the following web-platform adaptations:
 *
 *  - Stripped `node:fs` / `node:path` / `node:crypto` deps + the entire
 *    `resolveMediaPart` media-cache machinery. The web UI doesn't need a
 *    local content-hash cache — `media_attachment` events with `path` or
 *    `data` fields are rendered as a simple system message; downstream
 *    components decide whether to materialize images / files via `<img>` /
 *    `<a>` tags from the path / data URL directly.
 *  - Inlined a minimal `LLMMessage` shape + `extractMessageBodyText` helper
 *    instead of importing from framework's `src/llm/`. The shape is what we
 *    actually observe on wire (role / content / thinking).
 */

import type {
  StoredEvent,
  RendererMessage,
  ToolResultMessage,
} from './types';
import { registerSubagentFormatters } from './subagent-events';
import { t } from '@/i18n';

// ── Minimal LLMMessage shape (matches wire format from forgeax-server) ──

interface LLMMessage {
  role: string;
  content: unknown;
  thinking?: string;
  [key: string]: unknown;
}

/** Extract plain text body from a multi-part LLMMessage. Mirrors framework's
 *  src/llm/thinking.ts extractMessageBodyText — joins text parts, drops
 *  thinking/tool blocks. */
function extractMessageBodyText(msg: LLMMessage): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return (c as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

// ── Registry ──

type Formatter = (event: StoredEvent) => RendererMessage | null;

const registry = new Map<string, Formatter>();

export function registerFormatter(type: string, fn: Formatter): void {
  registry.set(type, fn);
}

registerSubagentFormatters(registerFormatter);

// ── Helpers ──

function displayContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .map((p) => {
      if (p.type === 'text' && p.text) return p.text as string;
      if (p.type === 'file' || p.type === 'text_file') return t('eventFormatter.filePart', { path: String(p.path) });
      if (p.type === 'image_file') return t('eventFormatter.imagePart', { path: String(p.path) });
      if (p.type === 'image') return t('eventFormatter.imageGeneric');
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function extractLLMMessage(p: Record<string, unknown>): LLMMessage | null {
  // Hook.AssistantMessage payload carries the message under either `llmMessage`
  // (kernel-turn / conscious-agent native path) OR `msg` (cli-provider bridge /
  // CliEventBridge path). Both are declared on the payload type — accept either,
  // else bridge-persisted turns replay with an empty assistant bubble (history
  // appears to vanish on refresh).
  const raw = p.llmMessage ?? p.msg;
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) return (raw[0] as LLMMessage) ?? null;
  return raw as LLMMessage;
}

function ts(event: StoredEvent): number {
  return (event.ts as number) ?? Date.now();
}

function systemMsg(
  event: StoredEvent,
  textOverride?: string,
  level?: 'info' | 'warning' | 'error',
): RendererMessage | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const vis = p.visual_display ? String(p.visual_display) : undefined;
  const text =
    textOverride ??
    vis ??
    (p.summary as string) ??
    (p.text as string) ??
    displayContent(p.content) ??
    '';
  if (!text) return null;
  return {
    kind: 'system',
    source: event.source ?? '',
    text,
    visualDisplay: vis,
    level,
    agent: event.emitterId ?? '',
    timestamp: ts(event),
  };
}

// Direction: `to === viewerId` → incoming, else outgoing. Same event lives in
// both sender's and receiver's ledgers, so viewer is required to resolve.

type Direction = 'incoming' | 'outgoing';

function classifyDirection(
  event: StoredEvent,
  viewerId?: string,
): { dir: Direction; from?: string; to?: string } {
  const toRaw = (event as { to?: unknown }).to;
  const to = typeof toRaw === 'string' && toRaw.length > 0 ? toRaw : undefined;
  const from = typeof event.emitterId === 'string' ? event.emitterId : undefined;
  if (to && viewerId && to === viewerId) return { dir: 'incoming', from, to };
  return { dir: 'outgoing', from, to };
}

/** Generic fallback: extract the most likely "primary" arg value for a short summary. */
function fallbackArgsSummary(args: Record<string, unknown>): string {
  if (args.description && typeof args.description === 'string') {
    const d = args.description;
    return d.length > 80 ? d.slice(0, 77) + '...' : d;
  }
  const primary =
    args.path ??
    args.file_path ??
    args.query ??
    args.command ??
    args.cmd ??
    args.pattern ??
    args.url ??
    args.search_term ??
    args.name;
  if (primary != null) {
    const s = String(primary);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  }
  const s = JSON.stringify(args);
  if (s === '{}' || s === 'null') return '';
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

// ── Formatters ──

registerFormatter('user_input', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const d = p.display as Record<string, unknown> | undefined;
  const text = (p.visual_display as string) ?? (d?.text as string) ?? displayContent(p.content);
  if (!text) return null;
  const handoff = (p.handoff ?? event.handoff) as string | undefined;
  return {
    kind: 'user_input',
    text,
    isSteer: handoff === 'steer',
    source: event.source ?? 'user',
    agent: event.emitterId ?? '',
    timestamp: ts(event),
    // checkpoint 回退点的稳定外键(server api/sessions.ts 注入;旧事件无)。
    msgId: typeof p.msgId === 'string' ? p.msgId : undefined,
  };
});

// agent_command is a local meta event (issuer-side dispatch record), intentionally
// no direction — not inter-agent traffic.
registerFormatter('agent_command', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const vis = p.visual_display ? String(p.visual_display) : undefined;
  const toolName = (p.toolName ?? p.tool ?? '') as string;
  const agent = (p.agentId ?? p.agent ?? event.emitterId ?? '') as string;
  return systemMsg(event, vis ?? `/${toolName} → ${agent}`);
});

registerFormatter('hook:assistantMessage', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const msg = extractLLMMessage(p);
  if (!msg) return null;
  const text = extractMessageBodyText(msg).trim();
  const thinking = msg.thinking?.trim() ?? '';
  if (!text && !thinking) return null;
  return {
    kind: 'assistant_complete',
    text,
    thinking,
    agent: event.emitterId ?? '',
    timestamp: ts(event),
  };
});

registerFormatter('hook:toolCall', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = (p.name ?? '') as string;
  if (name === 'subagent') return null;
  const args = p.args ?? {};
  const tc = p.toolCall as { id?: string } | undefined;
  const callId = (p.callId ?? p.toolCallId ?? tc?.id ?? p.id ?? `${name}-${ts(event)}`) as string;
  let visualDisplay: string | undefined;
  if (p.visual_display) {
    visualDisplay = String(p.visual_display);
  } else if (name === 'send_media') {
    const atts = (args as Record<string, unknown>).attachments as Array<{ type?: string }> | undefined;
    if (atts?.length) {
      const types = atts.map((a) => a.type ?? 'file');
      visualDisplay = types.length === 1 ? types[0] : `${types.length} attachments`;
    }
  } else if (name === 'subagent') {
    const a = args as Record<string, unknown>;
    const task = String(a.task ?? '');
    const type = String(a.type ?? '');
    const mode = String(a.mode ?? 'foreground');
    visualDisplay = `${type}, ${mode}: ${task.slice(0, 80)}`;
  } else if (name === 'shell') {
    const a = args as Record<string, unknown>;
    const desc = a.description ? String(a.description) : undefined;
    const cmd = String(a.command ?? '');
    const cmdShort = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
    visualDisplay = desc ?? cmdShort;
  } else {
    visualDisplay = fallbackArgsSummary(args as Record<string, unknown>);
  }
  return {
    kind: 'tool_call',
    id: callId,
    name,
    status: 'running' as const,
    visualDisplay,
    args,
    agent: event.emitterId ?? '',
    timestamp: ts(event),
  };
});

registerFormatter('hook:toolResult', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = (p.name ?? '') as string;
  const durationMs = (p.durationMs ?? 0) as number;
  const errorText = p.error ? String(p.error) : '';

  if (name === 'send_media') {
    return {
      kind: 'tool_result',
      callId: (p.callId ?? p.toolCallId ?? p.id ?? `${name}-${ts(event)}`) as string,
      name,
      durationMs,
      isError: !!errorText,
      agent: event.emitterId ?? '',
      timestamp: ts(event),
    } as ToolResultMessage;
  }
  if (name === 'subagent') return null;

  let visualDisplay: string | undefined;
  let fullContent = '';

  if (p.visual_display) {
    visualDisplay = String(p.visual_display);
  }

  if (!visualDisplay && !fullContent) {
    if (errorText) {
      fullContent = errorText;
    } else {
      const msg = extractLLMMessage(p);
      let raw = msg ? displayContent(msg.content) : '';
      if (raw && raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          let text = String(obj.result ?? obj.error ?? obj.question ?? '');
          if (text.startsWith('[{')) {
            try {
              const arr = JSON.parse(text) as Array<{ type: string; text?: string }>;
              text = arr.filter((part) => part.type === 'text' && part.text).map((part) => part.text).join('\n');
            } catch {
              /* use as-is */
            }
          }
          if (text) raw = text;
        } catch {
          /* use raw as-is */
        }
      }
      fullContent = raw;
    }
  }

  const truncatedContent = fullContent.length > 2000 ? fullContent.slice(0, 2000) + '\n…' : fullContent;

  return {
    kind: 'tool_result',
    callId: (p.callId ?? p.toolCallId ?? p.id ?? `${name}-${ts(event)}`) as string,
    name,
    visualDisplay,
    content: truncatedContent,
    fullContent: fullContent.length > 2000 ? fullContent : undefined,
    durationMs,
    isError: !!errorText,
    agent: event.emitterId ?? '',
    timestamp: ts(event),
  };
});

// hook:* events are universally dropped by the fallback (below). `stream:llm`
// doesn't share that prefix so it must be explicitly dropped here.
registerFormatter('stream:llm', () => null);

// media_attachment: web-adapted version. The framework's ink renderer wrote
// inline base64 to a content-hash cache dir and returned a local path for ink
// to render via terminal escapes; the web UI just emits a system message with
// the file label / path so downstream React components can decide whether to
// render as <img> / <a> / preview. No fs / crypto needed.
registerFormatter('media_attachment', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const content = p.content as Array<Record<string, unknown>> | undefined;
  if (!content?.length) return null;

  const labels: string[] = [];
  for (const part of content) {
    const path = part.path as string | undefined;
    const name = part.name as string | undefined;
    if (name) labels.push(name);
    else if (path) labels.push(path.split('/').pop() ?? path);
    else if (part.mimeType) labels.push(`<${part.mimeType}>`);
  }
  if (!labels.length) return null;

  const label = labels.length === 1 ? '📎 ' : `📎 ${labels.length} files:\n`;
  return {
    kind: 'system',
    source: event.source ?? '',
    text: label + labels.join('\n'),
    agent: event.emitterId ?? '',
    timestamp: ts(event),
  };
});

// inbound_message: routed snapshot already rendered by user_input /
// assistantMessage / other inbound formatters — the model has seen this exact
// content. Drop to avoid showing the user (and the model on next replay) the
// same message twice.
registerFormatter('inbound_message', () => null);

registerFormatter('tick', (event) => {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const msg = extractLLMMessage(p);
  if (msg) return null;
  return systemMsg(event);
});

// ── Main entry ──

export function formatEvent(event: StoredEvent, viewerId?: string): RendererMessage | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;

  if (p.error && event.type !== 'hook:toolResult') {
    return systemMsg(event, p.visual_display ? String(p.visual_display) : String(p.error), 'error');
  }
  if (p.warning) {
    return systemMsg(event, p.visual_display ? String(p.visual_display) : String(p.warning), 'warning');
  }

  // Inter-agent user_input: source='agent' + emitterId + to → render as a
  // direction-aware SystemMessage instead of a plain user-bubble. Otherwise
  // the user can't distinguish their own prompt to Forge from Forge's
  // delegated prompt to mochi (both look identical as user-bubbles). Real
  // user input keeps source='user' and falls through to the registered
  // user_input formatter.
  if (
    event.type === 'user_input' &&
    event.source === 'agent' &&
    typeof event.emitterId === 'string' && event.emitterId.length > 0 &&
    typeof (event as { to?: unknown }).to === 'string' && ((event as { to?: string }).to as string).length > 0
  ) {
    const to = (event as { to: string }).to;
    const text = (p.visual_display as string) ?? displayContent(p.content);
    if (!text) return null;
    const direction: 'incoming' | 'outgoing' =
      viewerId && to === viewerId ? 'incoming' : 'outgoing';
    return {
      kind: 'system',
      source: `${event.emitterId}(user_input)`,
      text,
      direction,
      from: event.emitterId,
      to,
      agent: event.emitterId,
      timestamp: ts(event),
    };
  }

  const formatter = registry.get(event.type);
  if (formatter) return formatter(event);

  if (event.type.startsWith('hook:') || event.type.startsWith('_')) return null;

  // `agent_log` is a diagnostic/log channel (thinking mirror, plan narration,
  // provider errors, …). It must NOT render as a chat bubble — logs don't belong
  // in the conversation thread. Reasoning still shows in the collapsible THOUGHT
  // area (live `stream:llm` thinking chunk → m.thinking); the agent_log entries
  // stay in the WAL ledger + dashboard/observatory for diagnostics. Drop them all
  // from the chat formatter.
  if (event.type === 'agent_log') return null;

  const vis = p.visual_display ? String(p.visual_display) : undefined;
  const text = vis ?? displayContent(p.content);
  if (!text) return null;

  // Fallback for unrecognized non-hook events: emit structured direction /
  // from / to so the UI can render an icon / color of its choice.
  const dir = classifyDirection(event, viewerId);
  const isSelfEmit = !!viewerId && event.emitterId === viewerId;
  const source = event.source ?? '';
  // Outgoing (self-emit): show only event type. Incoming: source(type).
  const tag = isSelfEmit ? event.type : source ? `${source}(${event.type})` : event.type;
  return {
    kind: 'system',
    source: tag,
    text,
    visualDisplay: vis,
    direction: dir.dir,
    from: dir.from,
    to: dir.to,
    agent: event.emitterId ?? '',
    timestamp: ts(event),
  };
}
