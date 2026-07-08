import { useState, useRef, useEffect, useMemo, useCallback } from 'react';


import { AtSign, SquareChartGantt, Upload, ChevronDown, ArrowUp, Unplug, Square, Zap, Pencil, Trash2 } from 'lucide-react';
import { useTranslation, getLocale } from '@forgeax/interface/i18n';
import { workbenchAgentsUrl } from '@forgeax/interface/lib/workbench-lang';
import { useAppStore } from '@forgeax/interface/store';
import { emitDeepLink } from '@forgeax/interface/lib/deep-link-bus';
import { useChatStore, useActiveStreaming } from '../../session-store';
import { useModelLabel } from '@forgeax/interface/lib/model';
import { resolveNaming } from '@forgeax/interface/lib/agent-name';
import { listBusPlugins, pickLang, type BusPluginInfo } from '@forgeax/interface/lib/bus-api';
import { RichInput, type RichInputHandle } from '../Composer/RichInput';
import { buildAssetPill, requestComposerInsert, useComposerPendingInsert, clearComposerPendingInsert } from '@forgeax/interface/lib/composer-bridge';
import {
  getAgentModel,
  listModels,
  setAgentModels,
  type AgentModelState,
} from '@forgeax/interface/lib/model-config';
import { ModelPicker } from '@forgeax/interface/components/ModelPicker';
import ContextRing from './ContextRing';
import { usePendingPermission } from '@forgeax/interface/lib/permission-stream';
interface CliProviderInfo {
  id: string;
  displayName: string;
  health: { ok: boolean; detail?: string };
}

// 2026-05-20 — `cb-mbsel`（模型选择按钮）从「kind=model-binding 插件预览 +
// BusAdmin deep-link」改造成真正的模型选择器：label 来自当前 agent.json::models.model
// 的 selected（用 commands.get_agent_model 读盘），下拉列出 `~/.forgeax/key/models.json`
// 的全量 catalog（用 commands.list_models 拿）；点击切换走 commands.set_agent_models
// 真实写回 agent.json，server 端自动 controlAgent("restart") 让已 running 的 agent
// 重读盘。2026-06-02 起 claude-code 桥也消费 agent.json::models.model（chat 桥把它
// 解析进 req.options.model，provider 转成 `claude --model <id>`）。2026-07 ADR-0020
// 落地 rented CLI 的 driver-scoped catalog：CLI provider 同样写 agent.json，但
// picker 请求 `list_models <providerId>`，只展示该 CLI 自己的模型目录。
//
// 2026-05-17 — ComposerToolRow + .cb-tl-strip 删除。tool 插件入口由 Bus
// admin 承载,Composer 上方常驻一条 orange chip 是冗余。

// P3.45 — flattened row for the Sparkles ("/") menu. Each bus skill plugin
// can declare multiple skills[], so a single plugin may yield multiple rows.
// Until P3.45 the Sparkles button was a permanent 即将上线 placeholder; now
// it surfaces real bus skill triggers and lets the player insert them at the
// textarea cursor without typing the full slash path.
interface BusSkillRow {
  pluginId: string;
  displayName: string;
  descZh: string;
  skillId: string;
  trigger: string;
}

// P3.46 — agent mention row for the @ menu. Mirrors the P3.45 Sparkles popover
// pattern but pulls agents (marketplace + bus, deduped by id) so the player
// can drop `@agent ` tokens into the prompt without remembering exact ids.
// The @ button was the 2nd remaining 即将上线 placeholder in composer-bar;
// this turns it into a working insertion source.
interface AgentMentionRow {
  id: string;
  name: string;
  naming?: { title: string; sub: string };
  role: string;
  avatar: string;
  isMain: boolean;
  inBus: boolean;
  // P3.48 — bus plugin id (e.g. `@forgeax-plugin/agent-cc-coder`) when inBus,
  // enabling per-row Bus admin deep-link via pendingBusExpandId pipeline.
  busPluginId?: string;
}

// P2.7d — bus cli-provider ids follow `@forgeax-plugin/cli-{providerId}` (see
// packages/marketplace/plugins/cli-*/forgeax-plugin.json). Strip the prefix so
// we can cross-reference with the runtime /api/cli-providers id list.
const BUS_CLI_ID_PREFIX = '@forgeax-plugin/cli-';

// P2.7g — entry in the bus cli-provider map. Holds enough of the plugin
// manifest to render a description mini-strip under each dropdown row. We
// keep the full BusPluginInfo so future extensions (manifest version /
// experimental flag etc.) don't need another refetch.
interface BusCliEntry {
  full: BusPluginInfo;
  descZh: string;
}

// Hard-coded fallback display names so a persisted providerOverride doesn't
// flash its bare id ("claude-code") for one frame after reload before
// /api/cli-providers populates the real list. Keep keys in sync with the
// known provider ids in server/src/cli-providers/.
const PROVIDER_DISPLAY_FALLBACK: Record<string, string> = {
  'forgeax': 'ForgeaX CLI',
  'claude-code': 'the reference agent CLI',
  'codex': 'OpenAI Codex',
  'cursor-agent': 'Cursor',
  'codebuddy': 'a peer agent CLI',
};

// Concise one-line description per provider/kernel id → i18n key. Every dropdown
// row shows a short description (the verbose bus-manifest `description.zh` is too
// long for a picker). forgeax/forgeax-core share one (they are the same thing —
// the standalone 'forgeax-core' kernel row is hidden, see fetchProviders filter).
const PROVIDER_DESC_I18N: Record<string, string> = {
  'forgeax': 'composer.cliDescForgeax',
  'forgeax-core': 'composer.cliDescForgeax',
  'claude-code': 'composer.cliDescClaudeCode',
  'codex': 'composer.cliDescCodex',
  'cursor-agent': 'composer.cliDescCursor',
  'codebuddy': 'composer.cliDescCodebuddy',
};

// iter-107: enumerate the placeholder-button hint ids. Centralizes the
// strings so typos become compile errors instead of silently breaking the
// `hintFor === 'at'` checks, and makes "where can a future button slot in"
// obvious. Keep these short — they only flow through component-local state.
const CB_HINT = { AT: 'at', SLASH: 'slash', IMG: 'img' } as const;
type CbHintId = typeof CB_HINT[keyof typeof CB_HINT];

function compactModelLabel(label: string): string {
  const trimmed = label.trim();
  const slugOpus = trimmed.match(/claude[-_\s]+opus[-_\s]+([\d.]+)(?:[-_\s]+(\d))?/i);
  if (slugOpus) return `Opus ${slugOpus[1]}${slugOpus[2] ? `.${slugOpus[2]}` : ''}`;
  return trimmed
    .replace(/^claude[-_\s]+/i, '')
    .replace(/\bclaude\b\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactProviderLabel(label: string, providerId: string | null): string {
  if (!providerId || providerId === 'forgeax' || /^forgeax\b/i.test(label)) return 'FX';
  if (/claude/i.test(label) || /claude/i.test(providerId)) return 'Claude';
  if (/codex|openai/i.test(label) || /codex|openai/i.test(providerId)) return 'Codex';
  if (/cursor/i.test(label) || /cursor/i.test(providerId)) return 'Cursor';
  return label.replace(/\b(code|cli|agent)\b/gi, '').trim() || providerId;
}

export function Composer() {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState('');
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const isStreaming = useActiveStreaming();
  // Message queue (Cursor-style): while streaming, sends land here and flush
  // one-per-turn on hook:turnEnd. Keyed by `${sid}::${agentId}` in the store.
  const enqueueMessage = useChatStore((s) => s.enqueueMessage);
  const dequeueMessage = useChatStore((s) => s.dequeueMessage);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const queuedMessages = useChatStore((s) => s.queuedMessages);
  const providerOverride = useAppStore((s) => s.providerOverride);
  const setProviderOverride = useAppStore((s) => s.setProviderOverride);
  // Derive from active tab's agent binding (first-class key, post-PR #9).
  // null when the active tab hasn't been pinned yet (fresh tab pre-
  // AgentSwitcher fetch).
  const activeAgent = useAppStore(
    (s) => s.tabs.find((t) => t.sid === s.activeSid)?.agentId ?? null,
  );
  const activeSid = useAppStore((s) => s.activeSid);
  // P8 — while a claude-code permission card is up the turn is *blocked waiting
  // on the user*, not idle. Sending now would cancel that turn (SIGTERM →
  // `claude exited 143`) yet leave the card answering a dead turn. So we gate
  // send/queue/interrupt on "no pending permission for this session" and nudge
  // the user to resolve the card first. Stop (cancelStream) stays available.
  const pendingPermission = usePendingPermission(activeSid);
  const [permFlash, setPermFlash] = useState(false);
  useEffect(() => {
    if (!permFlash) return;
    const id = setTimeout(() => setPermFlash(false), 2600);
    return () => clearTimeout(id);
  }, [permFlash]);
  // Card resolved → drop any stale "处理授权" nudge.
  useEffect(() => {
    if (!pendingPermission) setPermFlash(false);
  }, [pendingPermission]);
  // P3.36 deep-link slot — cli dropdown row's bus pill into Bus admin.
  // Reuses the pendingBusExpandId pipeline (P2.7f Sidebar / P3.32 AgentsPanel /
  // P3.34 ChatPanel agent bar). Set BEFORE switching mode so BusAdminPanel's
  // mount-time consumer reads non-null on first render.
  const openOverlay = useAppStore((s) => s.openOverlay);
  // 2026-05-20 — cb-mbsel deep-link 到 BusAdmin kind=model-binding 的入口
  // 删除（mb popover 现在是真模型选择器，不再混 bus 数据源）。R5/P2 起深链走
  // bus（emitDeepLink('bus:filter-kind'|'bus:expand-plugin')），不再占 store slot。
  const modelLabel = useModelLabel();
  const ref = useRef<RichInputHandle>(null);

  // Provider list — fetched once on mount; refetched on every dropdown open
  // so health-pill state stays fresh (codex might just have been installed).
  const [providers, setProviders] = useState<CliProviderInfo[]>([]);
  // P2.7d — map of provider ids that are ALSO exposed by bus as cli-provider
  // plugins. Drives the small "bus" pill on each dropdown row, signalling
  // "this CLI backend is reachable via two surfaces". Refetched on dropdown
  // open in case a new plugin was hot-loaded.
  // P2.7g — upgraded from Set<string> to Map<id, BusCliEntry> so each row can
  // also surface the bus manifest description.zh as a permanent mini-strip
  // (previously the description was hidden inside `title=` hover-tooltip on
  // the bus pill — invisible on a default scan).
  const [busCliMap, setBusCliMap] = useState<Map<string, BusCliEntry>>(new Map());
  // 当前 activeAgent 在 agent.json 里的 model 状态（get_agent_model 读盘）。
  // null = 还没拉到 / 拉失败 / 当前不走 forgeax 渠道（cli 桥不读 agent.json）。
  // ModelPicker 内部自己拉 list_models catalog（useModelCatalog hook,会跨
  // Composer / TopBar / ModelLab 共享 cache）—— 这里只持 agent 当前选择。
  const [agentModel, setAgentModel] = useState<AgentModelState | null>(null);
  // 2026-05-20 重做后 sid 真值住 store.activeSid —— 不再单独本地 state。
  // 旧 ensureForgeaXSid 单例已删，所有需要 sid 的调用直接用 activeSid。
  const forgeaxSid = activeSid;
  // P3.45 — bus skill rows (flattened across all kind=skill plugins). Null
  // until the first fetch resolves so the Sparkles button stays in legacy
  // cb-soon mode until we know there's at least one trigger to offer.
  const [busSkills, setBusSkills] = useState<BusSkillRow[] | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  // P3.46 — agent rows merged from /api/workbench/agents `.agents` (marketplace,
  // 7) and `.agents_from_bus` (bus, 1). Null = unfetched / failed → the @ button
  // stays in legacy cb-soon mode. The endpoint already returns both arrays so
  // we don't need a second bus call.
  const [agentMentions, setAgentMentions] = useState<AgentMentionRow[] | null>(null);
  const [atOpen, setAtOpen] = useState(false);
  // P3.49 — keyboard navigation for the slash / at popovers. -1 = no row focused
  // (idle / mouse mode), 0..N-1 = the corresponding popover row. Refs feed the
  // window keydown closure (which only re-registers on *Open toggle) so it can
  // read fresh idx/length without re-binding per keystroke.
  // Note: model-picker keyboard nav lives inside <ModelPicker> itself.
  const [slashFocused, setSlashFocused] = useState(-1);
  const [atFocused, setAtFocused] = useState(-1);
  const slashFocusedRef = useRef(-1);
  const atFocusedRef = useRef(-1);
  const busSkillsRef = useRef<BusSkillRow[] | null>(null);
  const agentMentionsRef = useRef<AgentMentionRow[] | null>(null);
  useEffect(() => { slashFocusedRef.current = slashFocused; }, [slashFocused]);
  useEffect(() => { atFocusedRef.current = atFocused; }, [atFocused]);
  useEffect(() => { busSkillsRef.current = busSkills; }, [busSkills]);
  useEffect(() => { agentMentionsRef.current = agentMentions; }, [agentMentions]);
  const [cliOpen, setCliOpen] = useState(false);
  // Keyboard navigation: -1 means no focused item, 0 = 'forgeax' default row, 1..N = providers list.
  const [cliFocused, setCliFocused] = useState(-1);
  // Refs mirror current cliFocused + providers so the window keydown closure (which
  // attaches once per cliOpen toggle) can read fresh values without re-registering.
  const cliFocusedRef = useRef(-1);
  const providersRef = useRef<CliProviderInfo[]>([]);
  useEffect(() => { cliFocusedRef.current = cliFocused; }, [cliFocused]);
  useEffect(() => { providersRef.current = providers; }, [providers]);
  const fetchProviders = async () => {
    try {
      const { fetchCliProviders } = await import('@forgeax/interface/lib/cli-providers');
      const { providers: raw } = await fetchCliProviders();
      // forgeax === forgeax-core: hide the standalone 'forgeax-core' kernel row;
      // the special 'forgeax' default row (below) already represents it.
      const list = raw.filter((p) => p.id !== 'forgeax-core');
      setProviders(list);
      // Self-heal a stale persisted override: if localStorage points at a
      // provider that the server no longer registers (provider removed,
      // typo'd at write-time, etc.), reset to auto. Without this the user
      // would see an "unknown providerOverride" error on every turn and
      // have to manually fix it via the dropdown.
      const persisted = useAppStore.getState().providerOverride;
      if (persisted && list.length > 0 && !list.some((p) => p.id === persisted)) {
        console.warn(`[composer] cleared stale providerOverride="${persisted}" (not in registered providers: ${list.map((p) => p.id).join(',')})`);
        setProviderOverride(null);
      }
    } catch { /* ignore */ }
  };
  // P2.7d/g — independent of /api/cli-providers. Failure here just hides the
  // bus pill + description mini-strip; the dropdown still works.
  const fetchBusCliInfo = async () => {
    try {
      const resp = await listBusPlugins('cli-provider');
      const next = new Map<string, BusCliEntry>();
      for (const item of resp.items) {
        if (!item.id.startsWith(BUS_CLI_ID_PREFIX)) continue;
        const providerId = item.id.slice(BUS_CLI_ID_PREFIX.length);
        next.set(providerId, {
          full: item,
          descZh: pickLang(item.description, getLocale(), ''),
        });
      }
      setBusCliMap(next);
    } catch { /* ignore — pill + strip simply absent */ }
  };
  // 2026-05-20 — 拉 activeAgent 在 agent.json::models.model 里的当前选择。仅在
  // forgeax 渠道（providerOverride === null/'forgeax'）+ 有 activeAgent + 有 sid
  // 时才发请求；第三方 cli 桥不读 agent.json，强行 get 会拿错语义。失败兜底
  // null，UI 用 useModelLabel() 字符串占位。
  const fetchAgentModel = async (sid: string, agentPath: string) => {
    try {
      const m = await getAgentModel(sid, agentPath);
      // race 兜底：fetch 期间 activeAgent / sid 已经切走，不更新 stale 数据。
      const cur = useAppStore.getState();
      const tab = cur.tabs.find((t) => t.sid === cur.activeSid);
      if (tab?.agentId === agentPath && cur.activeSid === sid) {
        setAgentModel(m);
      }
    } catch (err) {
      console.warn('[composer] get_agent_model failed', { sid, agentPath, err });
      setAgentModel(null);
    }
  };
  // P3.45 — fetch all kind=skill plugins, flatten each plugin's skills[] into
  // single rows. Failure / empty → null, which collapses the Sparkles button
  // back to its legacy 即将上线 hint behaviour.
  const fetchBusSkills = async () => {
    try {
      const resp = await listBusPlugins('skill');
      const rows: BusSkillRow[] = [];
      for (const item of resp.items) {
        const skills = item.skills ?? [];
        for (const s of skills) {
          if (!s.trigger) continue;
          rows.push({
            pluginId: item.id,
            displayName: pickLang(item.displayName, getLocale(), item.id),
            descZh: pickLang(item.description, getLocale(), ''),
            skillId: s.id,
            trigger: s.trigger,
          });
        }
      }
      // Merge server commands (e.g. /compact) into the slash popover alongside bus skills.
      try {
        const cmdResp = await fetch('/api/commands');
        if (cmdResp.ok) {
          const { commands } = (await cmdResp.json()) as { commands?: Array<{ name: string; description: string; hasExecute: boolean }> };
          for (const cmd of commands ?? []) {
            if (!cmd.hasExecute) continue;
            if (cmd.name.startsWith('_error:')) continue;
            rows.push({
              pluginId: 'server',
              displayName: cmd.name,
              descZh: cmd.description,
              skillId: cmd.name,
              trigger: `/${cmd.name}`,
            });
          }
        }
      } catch { /* server commands unavailable — still show bus skills */ }
      setBusSkills(rows);
    } catch { setBusSkills(null); }
  };
  // P3.46 — pull /api/workbench/agents once, merge marketplace + bus by id.
  // Bus agents (`agents_from_bus[]`) currently overlap with marketplace
  // cc-coder, so the merge yields 7 unique rows with cc-coder flagged inBus.
  // Order: marketplace order first (player already sees this order in Sidebar
  // AGENTS list and AgentSwitcher), then bus-only agents appended.
  const fetchAgentMentions = async () => {
    try {
      const res = await fetch(workbenchAgentsUrl());
      if (!res.ok) throw new Error(`GET /api/workbench/agents → ${res.status}`);
      const data = (await res.json()) as {
        agents?: Array<{ id: string; name: string; naming?: { title: string; sub: string }; role: string; avatar: string; isMain: boolean }>;
        agents_from_bus?: Array<{ id: string; name: string; naming?: { title: string; sub: string }; role: string; avatar: string; pluginId?: string }>;
      };
      const busPluginIds = new Map<string, string>();
      for (const a of data.agents_from_bus ?? []) {
        if (a.pluginId) busPluginIds.set(a.id, a.pluginId);
      }
      const rows: AgentMentionRow[] = [];
      const seen = new Set<string>();
      for (const a of data.agents ?? []) {
        rows.push({
          id: a.id,
          name: a.name,
          naming: a.naming,
          role: a.role,
          avatar: a.avatar,
          isMain: !!a.isMain,
          inBus: busPluginIds.has(a.id),
          busPluginId: busPluginIds.get(a.id),
        });
        seen.add(a.id);
      }
      for (const a of data.agents_from_bus ?? []) {
        if (seen.has(a.id)) continue;
        rows.push({
          id: a.id,
          name: a.name,
          naming: a.naming,
          role: a.role,
          avatar: a.avatar,
          isMain: false,
          inBus: true,
          busPluginId: a.pluginId,
        });
      }
      setAgentMentions(rows);
    } catch { setAgentMentions(null); }
  };
  useEffect(() => {
    void fetchProviders();
    void fetchBusCliInfo();
    void fetchBusSkills();
    void fetchAgentMentions();
  }, [i18n.language]);
  useEffect(() => {
    if (cliOpen) {
      void fetchProviders();
      void fetchBusCliInfo();
      setCliFocused(-1);  // reset focus when reopening
    }
  }, [cliOpen]);

  // 2026-05-20 — forgeax 渠道 + 有 activeAgent + 有 sid 时拉 agent.json 当前
  // model。任意条件变化都重拉。其余情况清空 agentModel（cb-mbsel 降级用
  // useModelLabel）。
  const isForgeaXNative = providerOverride === null || providerOverride === 'forgeax';
  // 2026-06-02 — claude-code 现在也读 agent.json::models.model（chat 桥把它解析进
  // req.options.model，provider 转成 `claude --model`）。2026-07 — rented CLI 都走
  // driver-scoped catalog，选中模型经 TurnRequest.model 传给各自 `--model`。
  const canSwitchModel =
    isForgeaXNative || providerOverride === 'claude-code' || providerOverride === 'codex' || providerOverride === 'cursor-agent' || providerOverride === 'codebuddy';
  const modelCatalogProviderId =
    providerOverride === 'claude-code' || providerOverride === 'codex' || providerOverride === 'cursor-agent' || providerOverride === 'codebuddy'
      ? providerOverride
      : null;
  const catalogProviderFor = useCallback((nextProvider: string | null): string | null => (
    nextProvider === 'claude-code' || nextProvider === 'codex' || nextProvider === 'cursor-agent' || nextProvider === 'codebuddy'
      ? nextProvider
      : null
  ), []);
  const switchProviderWithDefaultModel = useCallback((nextProvider: string | null) => {
    if (providerOverride === nextProvider) {
      setCliOpen(false);
      return;
    }
    setProviderOverride(nextProvider);
    setCliOpen(false);

    if (!activeAgent || !forgeaxSid) return;
    void (async () => {
      try {
        const catalog = await listModels(catalogProviderFor(nextProvider));
        const nextModel = catalog.find((m) => !m.hidden)?.id ?? catalog[0]?.id;
        if (!nextModel) return;
        const res = await setAgentModels(forgeaxSid, activeAgent, [nextModel]);
        const selected = res.selected ?? nextModel;
        setAgentModel({ sid: forgeaxSid, agentPath: activeAgent, selected, chain: [selected], raw: [selected] });
      } catch (err) {
        console.warn('[composer] switch provider default model failed', { provider: nextProvider, sid: forgeaxSid, agent: activeAgent, err });
      }
    })();
  }, [activeAgent, catalogProviderFor, forgeaxSid, providerOverride, setProviderOverride]);
  useEffect(() => {
    if (!canSwitchModel || !activeAgent || !forgeaxSid) {
      setAgentModel(null);
      return;
    }
    void fetchAgentModel(forgeaxSid, activeAgent);
  }, [canSwitchModel, activeAgent, forgeaxSid]);

  // Auto-close the dropdown if a stream starts while it's open. The override
  // wouldn't apply to the in-flight turn anyway, so showing a clickable list
  // while the result is already streaming is misleading.
  useEffect(() => {
    if (isStreaming && cliOpen) setCliOpen(false);
  }, [isStreaming, cliOpen]);
  // Close dropdown on outside click or Esc.
  useEffect(() => {
    if (!cliOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.cb-cli')) setCliOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCliOpen(false);
        return;
      }
      // ↑/↓ cycle through items; Enter commits the focused one.
      // Item indices: 0 = 'forgeax' (default row), 1..N = providers[i-1].
      // Read via refs so the closure sees current values (effect re-runs only on cliOpen).
      const list = providersRef.current;
      const total = list.length + 1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCliFocused((i) => (i + 1 + total) % total);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCliFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        const focused = cliFocusedRef.current;
        if (focused < 0) return;
        e.preventDefault();
        if (focused === 0) {
          switchProviderWithDefaultModel(null);
        } else {
          const p = list[focused - 1];
          // Only commit + close on a healthy pick. Enter on a DOWN row used to
          // silently close the dropdown, which felt like a swallowed keystroke
          // (mouse click on disabled row is already blocked by `disabled=`).
          // Keep the menu open so the user can pick another row instead.
          if (p && p.health.ok) {
            switchProviderWithDefaultModel(p.id);
          }
        }
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [cliOpen, switchProviderWithDefaultModel]);
  // R3 (2026-05-20)：默认行（providerOverride === null）的语义从「auto · 用
  // agent 自己 declared 的 backend」变成「forgeax 原生 · 直发 Session/EventBus」。
  // 三方 CLI 桥（claude-code 等）继续作为下面的可选条目。等 commands.attach_script_agent
  // 把 ScriptAgent 接进 Session 之后，下面这些 CLI 行整片下线。
  const currentLabel = providerOverride
    ? providers.find((p) => p.id === providerOverride)?.displayName
        ?? PROVIDER_DISPLAY_FALLBACK[providerOverride]
        ?? providerOverride
    : 'ForgeaX';
  // Detect "override is set but its provider is currently 不可用". The probe
  // row exists (claude-code/codex registered) but health.ok=false. We can't
  // clear the persisted override (user picked it deliberately), but we can
  // warn in the button tooltip + apply a cb-cli-warning class so the user
  // knows turns will error before they hit send.
  const overrideRow = providerOverride
    ? providers.find((p) => p.id === providerOverride)
    : undefined;
  const overrideDown = !!overrideRow && !overrideRow.health.ok;
  const cliButtonTitle = isStreaming
    ? 'Streaming — provider locked for this turn (Esc/Stop to cancel)'
    : overrideDown
      ? t('composer.cliButtonOverrideDown', { provider: providerOverride ?? '' })
      : providerOverride
        ? `All turns route via ${providerOverride}. Pick 'forgeax' for the native EventBus path.`
        : t('composer.cliButtonForgeaxNative');
  // @ / slash / image icons are placeholders for upcoming features. Title-tooltip
  // alone is hover-only + touch-unfriendly. Same click-hint pattern as iter-55
  // AgentSwitcher: aria-disabled lets clicks reach the handler, a brand-yellow
  // pill flashes "即将上线" for 2s.
  const [hintFor, setHintFor] = useState<CbHintId | null>(null);
  useEffect(() => {
    if (!hintFor) return;
    const id = setTimeout(() => setHintFor(null), 2000);
    return () => clearTimeout(id);
  }, [hintFor]);

  // ── 多模态:暂存待发送的图片(file picker / 粘贴)。发送时随 sendMessage 的
  //   attachments 传给 forgeax-core 内核;发送后清空。data 用 base64(无 dataUrl 前缀)。
  const [images, setImages] = useState<Array<{ id: string; name: string; data: string; mediaType: string }>>([]);
  const imgInputRef = useRef<HTMLInputElement | null>(null);
  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const res = typeof reader.result === 'string' ? reader.result : '';
        const comma = res.indexOf(',');
        const data = comma >= 0 ? res.slice(comma + 1) : res; // 剥 dataUrl 前缀,只留 base64
        setImages((prev) => [
          ...prev,
          { id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, data, mediaType: f.type || 'image/png' },
        ]);
      };
      reader.readAsDataURL(f);
    }
  };
  const removeImage = (id: string) => setImages((prev) => prev.filter((i) => i.id !== id));
  /** 把暂存图片转成 sendMessage 的 attachments(kind:'image')。 */
  const takeAttachments = (): Array<Record<string, unknown>> | undefined => {
    if (images.length === 0) return undefined;
    const atts = images.map((i) => ({ kind: 'image', mediaType: i.mediaType, data: i.data }));
    setImages([]);
    return atts;
  };

  // P3.45 — close slash popover on outside-click or Escape. Mirrors the cliOpen
  // dismissal contract so two popovers in the same composer-bar behave the
  // same way to the player.
  useEffect(() => {
    if (!slashOpen) {
      setSlashFocused(-1);
      return;
    }
    setSlashFocused(0);
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.cb-slash')) setSlashOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
      const list = filteredSkillsRef.current;
      const total = list.length;
      if (total === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashFocused((i) => (i < 0 ? 0 : (i + 1) % total));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        const idx = slashFocusedRef.current;
        if (idx < 0 || idx >= total) return;
        e.preventDefault();
        insertSkillTrigger(list[idx].trigger);
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [slashOpen]);

  // P3.45 — insert the trigger at the current cursor position (or end if no
  // selection). Appends a trailing space so the user can immediately type
  // arguments without hitting space first. Refocus the textarea + move caret
  // after the inserted text so the inserted trigger feels like a single
  // typed-out token rather than a paste.
  const insertSkillTrigger = (trigger: string) => {
    const insertion = `${trigger} `;
    setSlashOpen(false);
    const r = ref.current;
    // If user was typing a prefix (e.g. "/c"), replace the entire text with the
    // selected trigger + trailing space. Otherwise insert at cursor (button mode).
    if (slashPrefixMatch) {
      if (r) {
        r.setValue(insertion);
        r.focus();
      } else {
        setText(insertion);
      }
    } else {
      if (r) {
        r.focus();
        r.insertText(insertion);
      } else {
        setText((t) => `${t}${insertion}`);
      }
    }
  };

  const slashHasSkills = !!(busSkills && busSkills.length > 0);

  // Text-driven slash popover: auto-open when text is just a command prefix
  // (e.g. "/", "/c", "/compact") and auto-close otherwise.
  const slashPrefixMatch = text.match(/^\/([a-z0-9_-]*)$/i);
  const slashPrefix = slashPrefixMatch ? slashPrefixMatch[1] : null;
  useEffect(() => {
    if (slashPrefix !== null && slashHasSkills) {
      setSlashOpen(true);
    } else if (slashPrefix === null) {
      setSlashOpen(false);
    }
  }, [slashPrefix, slashHasSkills]);

  // Filtered skills for the popover — full list when opened by button with no
  // prefix, or narrowed when the user is typing a prefix like "/c".
  const filteredSkills = useMemo(() => {
    if (!busSkills) return [];
    if (slashPrefix === null || slashPrefix === '') return busSkills;
    return busSkills.filter((s) =>
      s.trigger.toLowerCase().startsWith(`/${slashPrefix.toLowerCase()}`),
    );
  }, [busSkills, slashPrefix]);
  const filteredSkillsRef = useRef<BusSkillRow[]>([]);
  useEffect(() => {
    filteredSkillsRef.current = filteredSkills;
    if (filteredSkills.length > 0) setSlashFocused(0);
    else setSlashFocused(-1);
  }, [filteredSkills]);

  // P3.46 — outside-click / Esc dismissal for the @ popover. Same shape as the
  // slash popover (P3.45) and cli dropdown — players learn one popover language.
  useEffect(() => {
    if (!atOpen) {
      setAtFocused(-1);
      return;
    }
    setAtFocused(0);
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.cb-at')) setAtOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtOpen(false);
        return;
      }
      const list = agentMentionsRef.current ?? [];
      const total = list.length;
      if (total === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtFocused((i) => (i < 0 ? 0 : (i + 1) % total));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtFocused((i) => (i <= 0 ? total - 1 : i - 1));
      } else if (e.key === 'Enter') {
        const idx = atFocusedRef.current;
        if (idx < 0 || idx >= total) return;
        e.preventDefault();
        insertAgentMention(list[idx].id);
      }
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [atOpen]);

  // P3.46 — insert `@<id> ` at the textarea cursor. Mirrors insertSkillTrigger
  // (P3.45) so both popovers feel identical when used.
  const insertAgentMention = (agentId: string) => {
    const insertion = `@${agentId} `;
    setAtOpen(false);
    const r = ref.current;
    if (r) {
      r.focus();
      r.insertText(insertion);
    } else {
      setText((t) => `${t}${insertion}`);
    }
  };

  const atHasMentions = !!(agentMentions && agentMentions.length > 0);

  // P3.48 — open Bus admin and expand the given plugin row. Reuses the
  // pendingBusExpandId pipeline (P2.7f) shared with cb-mbsel-arrow / wb-* tab
  // placeholder / AgentsPanel bus pill / cli dropdown so popover deep-links
  // feel identical across all surfaces.
  const openInBusAdmin = (pluginId: string) => {
    emitDeepLink('bus:expand-plugin', pluginId);
    openOverlay('settings', 'plugins');
    setAtOpen(false);
    setSlashOpen(false);
  };
  const onArrowKey = (e: React.KeyboardEvent<HTMLSpanElement>, pluginId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openInBusAdmin(pluginId);
    }
  };

  // 2026-05-21 — cb-mbsel popover keyboard nav / outside-click / pickModel 写盘
  // 全部下放到 <ModelPicker mode="single" writeToAgent={...}/>。Composer 这边只
  // 负责拿到当前 selected 显示在按钮上，并把 onChange 同步到本地 agentModel state
  // 兜底（picker 内部已经写过盘）。
  const cliButtonLabel = compactProviderLabel(currentLabel, providerOverride);
  useEffect(() => {
    if (!isStreaming) ref.current?.focus();
  }, [isStreaming]);

  // Pending pill insertion bridge — any surface (right-click → "引用到 Chat") can
  // call requestComposerInsert(pill); we consume it here, drop the chip at the
  // current caret, then clear the slot.
  //
  // We defer one rAF so the Radix DropdownMenu has fully closed and browser focus
  // has returned to the contenteditable before we try to insert at the caret.
  // Without the defer, window.getSelection() may still point at the menu overlay,
  // causing insertNodeAtCaret to fall back to end-of-content or silently skip.
  const composerPendingInsert = useComposerPendingInsert();
  useEffect(() => {
    if (!composerPendingInsert) return;
    const id = requestAnimationFrame(() => {
      const r = ref.current;
      if (!r) {
        // Composer not mounted yet (ChatPanel closed) — leave the pending pill in
        // the store; it will be picked up on the next mount of this component.
        return;
      }
      r.focus();
      r.insertPill(composerPendingInsert);
      clearComposerPendingInsert();
    });
    return () => cancelAnimationFrame(id);
  }, [composerPendingInsert, clearComposerPendingInsert]);

  // Queued messages for the active (sid, agentId) slot.
  const queueKey = activeSid && activeAgent ? `${activeSid}::${activeAgent}` : null;
  const queued = queueKey ? (queuedMessages[queueKey] ?? []) : [];
  // Interrupt-send is a forgeax-native primitive (EventQueue steer); the CLI
  // bridge has no equivalent, so only offer it on the native path.
  const canInterrupt = isStreaming && (providerOverride === null || providerOverride === 'forgeax');

  const onSubmit = async () => {
    const t = text.trim();
    // 允许"只发图无文字"——但内核 user 文本不能为空,给个占位提示。
    if (!t && images.length === 0) return;
    if (isStreaming) {
      // Agent is mid-turn — queue client-side. It flushes as its own turn when
      // the current turn ends (sequential, one turn per queued message).
      // 注:排队消息暂不带图(图随当前输入即时发);有图时直接发不入队。
      if (images.length === 0) {
        enqueueMessage(t);
        setText('');
        return;
      }
    }
    const attachments = takeAttachments();
    setText('');
    await sendMessage(t || '(see attached image)', attachments ? { attachments } : undefined);
  };

  // Interrupt the running turn and send `text` immediately (handoff: steer).
  const onInterrupt = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void sendMessage(t, { handoff: 'steer' });
  };

  // Per-chip "send now" (↑): pull this queued message out of the queue and send
  // it immediately, jumping ahead of the rest. Mid-turn → steer-interrupt the
  // running turn; idle → plain send. The remaining queued items keep their
  // order and flush after this one's turn ends.
  const onQueuedSendNow = (q: { id: string; text: string }) => {
    dequeueMessage(q.id);
    void sendMessage(q.text, isStreaming && canInterrupt ? { handoff: 'steer' } : undefined);
  };

  // Per-chip "edit" (✎): pull the queued text back into the composer input for
  // editing and drop it from the queue. The user re-sends (or re-queues) it.
  const onQueuedEdit = (q: { id: string; text: string }) => {
    dequeueMessage(q.id);
    const r = ref.current;
    if (r) { r.setValue(q.text); r.focus(); } else { setText(q.text); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Shift/Ctrl/Meta+Enter: let RichInput insert a <br> at the caret (it
    // handles linebreaks for us once we leave defaultPrevented unset).
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    // If a popover is open with a focused row, let the window keydown listener
    // handle Enter (select the item) — don't submit.
    if ((slashOpen && slashFocused >= 0) || (atOpen && atFocused >= 0)) {
      e.preventDefault();
      return;
    }
    // Plain Enter: submit. preventDefault stops RichInput from inserting a
    // linebreak after us.
    e.preventDefault();
    void onSubmit();
  };

  // ── Asset drag-drop: accept assets dragged from Content Browser (iframe) ──
  // Cross-iframe dataTransfer is blocked by browser security, so the iframe
  // sends the asset ref via postMessage and we cache it for the drop event.
  const pendingDragAsset = useRef<{
    type: string; guid: string; kind?: string; name?: string;
    path?: string; payload?: Record<string, unknown>;
  } | null>(null);
  const [assetDragOver, setAssetDragOver] = useState(false);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; ref?: unknown } | null;
      if (d?.type === 'FORGEAX_DRAG_ASSET_START' && d.ref) {
        pendingDragAsset.current = d.ref as typeof pendingDragAsset.current;
      } else if (d?.type === 'FORGEAX_DRAG_ASSET_END') {
        pendingDragAsset.current = null;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const handleComposerDragOver = (e: React.DragEvent) => {
    if (pendingDragAsset.current) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setAssetDragOver(true);
    }
  };
  const handleComposerDragLeave = () => setAssetDragOver(false);
  const handleComposerDrop = (e: React.DragEvent) => {
    setAssetDragOver(false);
    const ref = pendingDragAsset.current;
    if (!ref) return;
    e.preventDefault();
    e.stopPropagation();
    pendingDragAsset.current = null;
    const insert = requestComposerInsert;
    insert(buildAssetPill({
      guid: ref.guid,
      name: ref.name,
      assetKind: ref.kind,
      packPath: ref.path,
      payload: ref.payload,
    }));
  };

  return (
    <div
      className={`composer${assetDragOver ? ' composer--asset-drop' : ''}`}
      onDragOver={handleComposerDragOver}
      onDragLeave={handleComposerDragLeave}
      onDrop={handleComposerDrop}
    >
      <div className="composer-card">
        {queued.length > 0 && (
          <div className="composer-queue" role="list" aria-label="Queued messages">
            <div className="composer-queue-head">
              <span className="composer-queue-tag">{t('composer.queuedCount', { count: queued.length })}</span>
              <span className="composer-queue-sub">{t('composer.queueSub')}</span>
              <button
                type="button"
                className="composer-queue-clear"
                title={t('composer.clearQueueTitle')}
                onClick={() => clearQueue()}
              >{t('composer.clearQueue')}</button>
            </div>
            {queued.map((q, i) => (
              <div key={q.id} className="composer-queue-chip" role="listitem" title={q.text}>
                <span className="composer-queue-idx">{i + 1}</span>
                <span className="composer-queue-text">{q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text}</span>
                <button
                  type="button"
                  className="composer-queue-act"
                  aria-label={t('composer.queueEditAria')}
                  title={t('composer.queueEditTitle')}
                  onClick={() => onQueuedEdit(q)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  className="composer-queue-act composer-queue-now"
                  aria-label={t('composer.queueSendNowAria')}
                  title={isStreaming ? t('composer.queueSendNowStreamingTitle') : t('composer.queueSendNowTitle')}
                  onClick={() => onQueuedSendNow(q)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="composer-queue-act composer-queue-x"
                  aria-label={t('composer.queueRemoveAria')}
                  title={t('composer.queueRemoveTitle')}
                  onClick={() => dequeueMessage(q.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <RichInput
        ref={ref}
        className="composer-input"
        placeholder={
          isStreaming
            ? t('composer.placeholderStreaming') + (canInterrupt ? t('composer.placeholderStreamingInterrupt') : '')
            : providerOverride
              ? `Type your game idea... [Enter] to send · [Ctrl/Shift+Enter] newline  →  via ${currentLabel}${overrideDown ? t('composer.placeholderOverrideDownSuffix') : ''}`
              : 'Type your game idea... [Enter] to send · [Ctrl/Shift+Enter] for a new line.'
        }
        value={text}
        onChange={setText}
        onKeyDown={onKeyDown}
        onPasteFiles={addFiles}
      />
      {images.length > 0 && (
        <div className="cb-img-strip" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 8px' }}>
          {images.map((img) => (
            <div key={img.id} style={{ position: 'relative', width: 56, height: 56, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--color-border, #444)' }}>
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <button
                type="button"
                aria-label="remove image"
                onClick={() => removeImage(img.id)}
                style={{
                  position: 'absolute', top: 1, right: 1, width: 16, height: 16, lineHeight: '14px',
                  borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 11,
                  background: 'rgba(0,0,0,0.6)', color: '#fff',
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />
      <div className="composer-bar">
        <div className="cb-left-group">
          <button className="cb-btn" title={t('composer.imageUpload')} type="button" onClick={() => imgInputRef.current?.click()}>
            <Upload size={16} />
          </button>
          <div className="cb-at">
            <button
              className={`cb-btn ${atHasMentions ? 'cb-at-btn' : 'cb-soon'}${atOpen ? ' is-open' : ''}`}
              title={
                atHasMentions
                  ? t('composer.mentionAgentTitle', { count: agentMentions!.length })
                  : t('composer.mentionSoon')
              }
              aria-disabled={atHasMentions ? undefined : true}
              aria-expanded={atHasMentions ? atOpen : undefined}
              aria-haspopup={atHasMentions ? 'menu' : undefined}
              type="button"
              onClick={() => {
                if (atHasMentions) setAtOpen((v) => !v);
                else setHintFor(CB_HINT.AT);
              }}
            >
              <AtSign size={16} />
              {!atHasMentions && hintFor === CB_HINT.AT && <span className="cb-hint" role="status">{t('composer.comingSoon')}</span>}
            </button>
            {atOpen && atHasMentions && (
              <div className="cb-at-menu" role="menu" aria-label="Agent mentions">
                <div className="cb-at-menu-head">
                  <span className="cb-at-menu-head-tag">AGENTS</span>
                  <span className="cb-at-menu-head-n">{agentMentions!.length}</span>
                  <span className="cb-at-menu-head-sub">marketplace + bus</span>
                </div>
                {agentMentions!.map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    role="menuitem"
                    className={`cb-at-item${a.isMain ? ' is-main' : ''}${atFocused === i ? ' is-active' : ''}`}
                    onMouseEnter={() => setAtFocused(i)}
                    title={
                      a.inBus
                        ? t('composer.agentItemInBusTitle', { name: a.name, role: a.role, id: a.id })
                        : t('composer.agentItemTitle', { name: a.name, role: a.role, id: a.id })
                    }
                    onClick={() => insertAgentMention(a.id)}
                  >
                    <span className={`cb-at-avatar cb-at-role-${a.role}`} aria-hidden="true">{a.avatar}</span>
                    <span className="cb-at-id">@{a.id}</span>
                    <span className="cb-at-name">{resolveNaming(a).title}</span>
                    <span className="cb-at-role">{resolveNaming(a).sub || a.role}</span>
                    {a.inBus && <span className="cb-at-bus-pill" aria-label="bus host">bus</span>}
                    {a.inBus && a.busPluginId && (
                      <span
                        className="cb-at-arrow"
                        role="button"
                        tabIndex={0}
                        aria-label={t('composer.viewInBusAria', { plugin: a.busPluginId })}
                        title={t('composer.viewInBusTitle', { plugin: a.busPluginId })}
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); openInBusAdmin(a.busPluginId!); }}
                        onKeyDown={(e) => onArrowKey(e, a.busPluginId!)}
                      >→</span>
                    )}
                  </button>
                ))}
                <div className="cb-at-foot">{t('composer.atFoot')}</div>
              </div>
            )}
          </div>
          <div className="cb-slash">
            <button
              className={`cb-btn ${slashHasSkills ? 'cb-slash-btn' : 'cb-soon'}${slashOpen ? ' is-open' : ''}`}
              title={
                slashHasSkills
                  ? t('composer.busSkillsTitle', { count: busSkills!.length })
                  : t('composer.slashSoon')
              }
              aria-disabled={slashHasSkills ? undefined : true}
              aria-expanded={slashHasSkills ? slashOpen : undefined}
              aria-haspopup={slashHasSkills ? 'menu' : undefined}
              type="button"
              onClick={() => {
                if (slashHasSkills) setSlashOpen((v) => !v);
                else setHintFor(CB_HINT.SLASH);
              }}
            >
              <SquareChartGantt size={16} />
              {!slashHasSkills && hintFor === CB_HINT.SLASH && <span className="cb-hint" role="status">{t('composer.comingSoon')}</span>}
            </button>
            {slashOpen && slashHasSkills && filteredSkills.length > 0 && (
              <div className="cb-slash-menu" role="menu" aria-label="Bus skills">
                <div className="cb-slash-menu-head">
                  <span className="cb-slash-menu-head-tag">COMMANDS</span>
                  <span className="cb-slash-menu-head-n">{filteredSkills.length}</span>
                  <span className="cb-slash-menu-head-sub">{slashPrefix ? `matching /${slashPrefix}` : 'all'}</span>
                </div>
                {filteredSkills.map((s, i) => (
                  <button
                    key={`${s.pluginId}:${s.skillId}`}
                    type="button"
                    role="menuitem"
                    className={`cb-slash-item${slashFocused === i ? ' is-active' : ''}`}
                    onMouseEnter={() => setSlashFocused(i)}
                    title={
                      s.descZh
                        ? t('composer.slashItemDescTitle', { name: s.displayName, plugin: s.pluginId, desc: s.descZh, trigger: s.trigger })
                        : t('composer.slashItemTitle', { name: s.displayName, plugin: s.pluginId, trigger: s.trigger })
                    }
                    onClick={() => insertSkillTrigger(s.trigger)}
                  >
                    <span className="cb-slash-trigger">{s.trigger}</span>
                    <span className="cb-slash-name">{s.displayName}</span>
                    {s.descZh && (
                      <span className="cb-slash-desc">
                        {s.descZh.length > 60 ? `${s.descZh.slice(0, 60)}…` : s.descZh}
                      </span>
                    )}
                    <span
                      className="cb-slash-arrow"
                      role="button"
                      tabIndex={0}
                      aria-label={t('composer.viewInBusAria', { plugin: s.pluginId })}
                      title={t('composer.viewInBusTitle', { plugin: s.pluginId })}
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); openInBusAdmin(s.pluginId); }}
                      onKeyDown={(e) => onArrowKey(e, s.pluginId)}
                    >→</span>
                  </button>
                ))}
                <div className="cb-slash-foot">{t('composer.slashFoot')}</div>
              </div>
            )}
          </div>
          {/* Model picker follows the selected runtime. Gateway/native runtimes use
              list_models; rented CLIs use their driver-scoped catalogs. */}
          {canSwitchModel && (
          <ModelPicker
            className="cb-mbsel"
            mode="single"
            variant="button"
            providerId={modelCatalogProviderId}
            displayLabel={compactModelLabel(agentModel?.selected ?? modelLabel)}
            value={agentModel?.selected ?? null}
            onChange={(next) => {
              if (typeof next !== 'string') return;
              // ModelPicker 已经替我们写过 agent.json（writeToAgent 传了 sid+agentPath）。
              // 这里只把 selected 同步到本地 agentModel state,避免按钮 label 闪回旧值。
              setAgentModel((prev) =>
                prev
                  ? { ...prev, selected: next, chain: [next], raw: [next] }
                  : forgeaxSid && activeAgent
                    ? { sid: forgeaxSid, agentPath: activeAgent, selected: next, chain: [next], raw: [next] }
                    : prev,
              );
            }}
            writeToAgent={
              canSwitchModel && activeAgent && forgeaxSid
                ? { sid: forgeaxSid, agentPath: activeAgent }
                : null
            }
            fallbackLabel={modelLabel}
            disabled={!canSwitchModel || !activeAgent || !forgeaxSid}
            disabledReason={
              !canSwitchModel
                ? t('composer.modelDisabledProvider', { provider: providerOverride })
                : !activeAgent
                  ? t('composer.modelDisabledNoAgent')
                  : !forgeaxSid
                    ? t('composer.modelDisabledBooting')
                    : undefined
            }
            triggerTitle={
              activeAgent
                ? t('composer.modelTriggerTitle', { agent: activeAgent })
                : 'Model selector'
            }
          />
          )}
        </div>
        <div className="cb-right-group">
          <ContextRing />
          <div className="cb-cli">
            <button
              type="button"
              className={`cb-cli-btn ${providerOverride ? 'cb-cli-active' : ''} ${overrideDown ? 'cb-cli-warning' : ''}`}
              onClick={() => setCliOpen((v) => !v)}
              disabled={isStreaming}
              title={cliButtonTitle}
            >
              <Unplug size={16} />
              <span className="cb-cli-label">{cliButtonLabel}</span>
            </button>
            {cliOpen && (
              <div className="cb-cli-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={`cb-cli-item ${!providerOverride ? 'is-current' : ''} ${cliFocused === 0 ? 'is-focused' : ''}`}
                  onClick={() => switchProviderWithDefaultModel(null)}
                  onMouseEnter={() => setCliFocused(0)}
                  title={t('composer.cliDescForgeax')}
                >
                  <span className="cb-cli-row">
                    <span className="cb-cli-id">forgeax</span>
                    {activeAgent && <span className="cb-cli-name" style={{ opacity: 0.6 }}>({activeAgent})</span>}
                    <span className="cb-cli-pill ok">✓</span>
                  </span>
                  <span className="cb-cli-desc">{t('composer.cliDescForgeax')}</span>
                </button>
                {providers.map((p, idx) => {
                  const busEntry = busCliMap.get(p.id);
                  // Concise per-provider description (every row gets one); fall back
                  // to the bus-manifest description only if no curated one exists.
                  const descKey = PROVIDER_DESC_I18N[p.id];
                  const desc = descKey ? t(descKey) : (busEntry?.descZh ?? '');
                  return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    className={`cb-cli-item ${providerOverride === p.id ? 'is-current' : ''} ${!p.health.ok ? 'is-down' : ''} ${cliFocused === idx + 1 ? 'is-focused' : ''}`}
                    onClick={() => switchProviderWithDefaultModel(p.id)}
                    onMouseEnter={() => setCliFocused(idx + 1)}
                    title={p.health.detail ?? ''}
                  >
                    <span className="cb-cli-row">
                      <span className="cb-cli-id">{p.id}</span>
                      <span className="cb-cli-name">
                        {p.displayName}
                        {!p.health.ok && p.health.detail && (
                          <span className="cb-cli-reason"> · {p.health.detail.slice(0, 100)}{p.health.detail.length > 100 ? '…' : ''}</span>
                        )}
                      </span>
                      {busEntry && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="cb-cli-bus-pill is-link"
                          title={t('composer.cliBusPillTitle', { plugin: `${BUS_CLI_ID_PREFIX}${p.id}` })}
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            emitDeepLink('bus:expand-plugin', `${BUS_CLI_ID_PREFIX}${p.id}`);
                            openOverlay('settings', 'plugins');
                            setCliOpen(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.stopPropagation();
                            e.preventDefault();
                            emitDeepLink('bus:expand-plugin', `${BUS_CLI_ID_PREFIX}${p.id}`);
                            openOverlay('settings', 'plugins');
                            setCliOpen(false);
                          }}
                        >
                          bus →
                        </span>
                      )}
                      <span className={p.health.ok ? 'cb-cli-pill ok' : 'cb-cli-pill down'}>
                        {p.health.ok ? '✓' : 'DOWN'}
                      </span>
                    </span>
                    {desc && (
                      <span className="cb-cli-desc" title={desc}>
                        {desc}
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>
            )}
          </div>
          {isStreaming ? (
            <>
              {text.trim() && canInterrupt && (
                <button
                  className="cb-send cb-interrupt"
                  title={t('composer.interruptTitle')}
                  type="button"
                  onClick={onInterrupt}
                >
                  <Zap size={14} />
                </button>
              )}
              {text.trim() && (
                <button
                  className="cb-send cb-queue"
                  title={t('composer.queueSendTitle')}
                  type="button"
                  onClick={() => void onSubmit()}
                >
                  <ArrowUp size={16} />
                </button>
              )}
              <button
                className="cb-send cb-stop"
                title={t('composer.stopTitle')}
                type="button"
                onClick={() => cancelStream()}
              >
                <Square size={12} />
              </button>
            </>
          ) : (
            <button
              className="cb-send"
              title={
                !activeSid
                  ? t('composer.sendNoSession')
                  : !activeAgent
                  ? t('composer.sendNoAgent')
                  : t('composer.send')
              }
              type="button"
              disabled={(!text.trim() && images.length === 0) || !activeAgent || !activeSid}
              onClick={() => void onSubmit()}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
