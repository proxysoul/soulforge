/**
 * Inline memory hints — surface relevant memory references on tool results.
 *
 * State is keyed per-tab (TabHintState in `_tabs`). Tabs share the same Node
 * process, so without this each tab would dedup against the others and
 * silence valid hints. tabId flows in via memoryHintComposite({tabId}).
 * Subagents get their own AsyncLocalStorage scope (runInSubagentScope)
 * that inherits the parent's tabId + surfaced IDs.
 *
 * Design principles:
 *   1. Any candidate that survives recall is surfaced (no quality gate).
 *      Memories are precious; users curate them. Treat them as relevant.
 *   2. Imperative wording per tool context — "review before editing",
 *      "review before commit". Bare volume hints suggest memory(search).
 *   3. Per-turn dedup + 10-turn cooldown so the agent never sees the same
 *      hint twice in a row.
 *   4. Suppression after the agent has acted (called memory(search|get|list))
 *      — already in memory-aware mode, no need to nag.
 *   5. Subagent scope: parent's surfaced IDs seed the dedup set so the
 *      subagent never re-surfaces what the parent already saw. Independent
 *      budget (SUBAGENT_BUDGET).
 *   6. Per-tab session budget — once SESSION_BUDGET hints fire, only
 *      gotcha/pinned slip through. Memory debt does not compound.
 *
 * All helpers swallow errors via reportHintError and never throw — a memory
 * failure can never crash a tool result.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logBackgroundError } from "../../stores/errors.js";
import type { MemoryManager } from "./manager.js";
import type { MemoryCategory } from "./types.js";

let _manager: MemoryManager | null = null;

/**
 * Per-tab hint state. Tabs share the same Node process; without this each
 * tab would dedup against the others and silence valid hints. tabId is
 * passed via memoryHintComposite({tabId}). Callers without a tabId fall
 * into the GLOBAL_TAB bucket (e.g. headless mode, tests).
 */
interface TabHintState {
  surfacedThisTurn: Set<string>;
  surfacedRecently: Map<string, number>;
  turnCounter: number;
  sessionBudgetUsed: number;
  agentActedThisTurn: boolean;
}
const GLOBAL_TAB = "__global__";
const _tabs = new Map<string, TabHintState>();

function getTabState(tabId: string): TabHintState {
  let s = _tabs.get(tabId);
  if (!s) {
    s = {
      surfacedThisTurn: new Set<string>(),
      surfacedRecently: new Map<string, number>(),
      turnCounter: 0,
      sessionBudgetUsed: 0,
      agentActedThisTurn: false,
    };
    _tabs.set(tabId, s);
  }
  return s;
}

/**
 * Per-subagent state lives in AsyncLocalStorage so concurrent agents can't
 * race on a module-level flag. When set, this fully replaces tab state
 * for the duration of the agent's run. tabId stored so any nested call
 * still resolves to the right parent tab if scope is exited.
 */
interface SubagentHintScope {
  tabId: string;
  surfaced: Set<string>;
  acted: boolean;
  budgetUsed: number;
}
const _scope = new AsyncLocalStorage<SubagentHintScope>();

const SUMMARY_MAX = 60;
const COOLDOWN_TURNS = 10;
const SESSION_BUDGET = 60;
const SUBAGENT_BUDGET = 10;

export function setMemoryHintProvider(manager: MemoryManager | null): void {
  _manager = manager;
}

/** Called on /clear, compaction, session restore — flushes per-turn dedup state. */
export function resetSurfacedHints(tabId: string = GLOBAL_TAB): void {
  const t = getTabState(tabId);
  t.surfacedThisTurn.clear();
  t.agentActedThisTurn = false;
  t.turnCounter++;
  for (const [id, turn] of t.surfacedRecently) {
    if (t.turnCounter - turn > COOLDOWN_TURNS) t.surfacedRecently.delete(id);
  }
}

/** Hard reset — call on session restore or compaction full reset. */
export function resetSurfacedHintsHard(tabId?: string): void {
  if (tabId) {
    _tabs.delete(tabId);
    return;
  }
  _tabs.clear();
}

/** Mark that the agent ran a memory action this turn — suppress further hints. */
export function markMemoryAction(tabId: string = GLOBAL_TAB): void {
  const s = _scope.getStore();
  if (s) {
    s.acted = true;
    return;
  }
  getTabState(tabId).agentActedThisTurn = true;
}

/**
 * Record that the agent acted on a specific memory id this session — bumps
 * surface_acted_count so we can demote chronically-ignored hints later.
 * Called from memory(get) handler with the resolved id.
 */
export function recordMemoryAction(id: string): void {
  if (!_manager) return;
  try {
    _manager.getDbForScope("project").recordSurface(id, true);
    _manager.getDbForScope("global").recordSurface(id, true);
  } catch (err) {
    reportHintError("record-action", err);
  }
}

/** Snapshot IDs surfaced so far — for passing to subagents. */
export function getSurfacedHintIds(tabId: string = GLOBAL_TAB): string[] {
  const s = _scope.getStore();
  if (s) return [...s.surfaced];
  const t = getTabState(tabId);
  return [...new Set([...t.surfacedThisTurn, ...t.surfacedRecently.keys()])];
}

/**
 * Run `fn` inside a subagent-scoped hint context. Concurrent agents each get
 * their own scope — no module-level race. Parent IDs seed the dedup set so
 * the subagent never re-surfaces what the parent already saw. Budget is
 * SUBAGENT_BUDGET per agent, independent of the parent tab budget.
 */
export function runInSubagentScope<T>(
  parentSurfacedIds: readonly string[],
  fn: () => T,
  tabId: string = GLOBAL_TAB,
): T {
  const scope: SubagentHintScope = {
    tabId,
    surfaced: new Set(parentSurfacedIds),
    acted: false,
    budgetUsed: 0,
  };
  return _scope.run(scope, fn);
}

/** True while running inside runInSubagentScope. */
function inSubagentScope(): boolean {
  return _scope.getStore() != null;
}

/** Mutable accessors that respect the active scope (subagent or parent tab). */
function getSurfacedSet(tabId: string): Set<string> {
  return _scope.getStore()?.surfaced ?? getTabState(tabId).surfacedThisTurn;
}
function getActed(tabId: string): boolean {
  const s = _scope.getStore();
  if (s) return s.acted;
  return getTabState(tabId).agentActedThisTurn;
}
function bumpBudget(tabId: string): void {
  const s = _scope.getStore();
  if (s) {
    s.budgetUsed++;
    return;
  }
  getTabState(tabId).sessionBudgetUsed++;
}
function budgetUsed(tabId: string): number {
  return _scope.getStore()?.budgetUsed ?? getTabState(tabId).sessionBudgetUsed;
}
function budgetLimit(): number {
  return _scope.getStore() ? SUBAGENT_BUDGET : SESSION_BUDGET;
}

function reportHintError(scope: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    logBackgroundError(`memory-hint:${scope}`, msg);
  } catch {
    // never throw from hint path
  }
}

function truncateSummary(s: string): string {
  if (s.length <= SUMMARY_MAX) return s;
  return `${s.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

/**
 * Hint context — which tool surfaced this hint. Determines the imperative.
 *   read/grep        → "review before editing"
 *   git_status/diff  → "review before commit"
 *   git_commit       → suppressed (too late)
 *   edit_file/write  → suppressed (too late)
 *   default          → no imperative (volume hints still pass)
 */
export type HintContext =
  | "read"
  | "grep"
  | "edit"
  | "git_status"
  | "git_diff"
  | "git_commit"
  | "git_other"
  | "default";

function imperativeFor(ctx: HintContext): string {
  switch (ctx) {
    case "read":
    case "grep":
      return " — review before editing";
    case "git_status":
    case "git_diff":
      return " — review before commit";
    case "edit":
    case "git_commit":
      return "";
    default:
      return "";
  }
}

/** Suppress hints emitted after the agent already edited or committed. */
function isLateContext(ctx: HintContext): boolean {
  return ctx === "edit" || ctx === "git_commit";
}

interface TopCandidate {
  id: string;
  summary: string;
  pinned: boolean;
  category: MemoryCategory | null;
  hasPathMatch: boolean;
}

/**
 * Subagent gate — looser than before. Memories are relevant by definition
 * if the recall query matched (paths/topics/query). Surface any hit so the
 * subagent gets the same signal the parent would. Budget still applies.
 */
function passesSubagentGate(top: TopCandidate | null): boolean {
  return top != null;
}

/** Budget gate — past budget, only gotcha/pinned slip through. */
function passesBudgetGate(top: TopCandidate | null, tabId: string): boolean {
  if (budgetUsed(tabId) < budgetLimit()) return true;
  if (!top) return false;
  return top.pinned || top.category === "gotcha";
}

/**
 * Build the hint line. Shape:
 *   gotcha:  · gotcha "JWT expiry uses container clock" [a97ae3be] — review before commit
 *   pinned:  · pinned pref "Be terse, fragments over sentences" [1d6d9516]
 *   volume:  · 3 memories — memory(search) recommended
 *   single:  · "Commit shape" [a97ae3be] — review before commit
 * Returns "" when nothing should surface.
 */
function buildHintLine(
  top: TopCandidate | null,
  total: number,
  ctx: HintContext,
  tabId: string,
): string {
  if (total <= 0) return "";
  if (isLateContext(ctx)) return "";
  if (getActed(tabId)) return "";
  if (inSubagentScope() && !passesSubagentGate(top)) return "";
  if (!passesBudgetGate(top, tabId)) return "";

  const surfaced = getSurfacedSet(tabId);
  const tabState = inSubagentScope() ? null : getTabState(tabId);

  // Top already shown — collapse to a volume hint only if multi-match.
  if (top && (surfaced.has(top.id) || (tabState && tabState.surfacedRecently.has(top.id)))) {
    if (total < 3) return "";
    return `\n· ${String(total)} memories — memory(search) recommended`;
  }

  if (!top) {
    return `\n· ${String(total)} memories — memory(search) recommended`;
  }

  surfaced.add(top.id);
  if (tabState) tabState.surfacedRecently.set(top.id, tabState.turnCounter);
  bumpBudget(tabId);
  // Telemetry — surface_count++. Acted is recorded later by recordMemoryAction.
  if (_manager) {
    try {
      _manager.getDbForScope("project").recordSurface(top.id, false);
      _manager.getDbForScope("global").recordSurface(top.id, false);
    } catch {}
  }

  const id8 = top.id.slice(0, 8);
  const summary = truncateSummary(top.summary);
  const imp = imperativeFor(ctx);

  // Label: prioritize category for gotcha, then pinned.
  let label: string;
  if (top.category === "gotcha") {
    label = top.pinned ? "pinned gotcha" : "gotcha";
  } else if (top.pinned) {
    label = top.category ? `pinned ${top.category}` : "pinned";
  } else if (top.category && top.category !== "context") {
    label = top.category;
  } else {
    label = "";
  }

  const labelPart = label ? `${label} ` : "";
  const rest = total - 1;
  const more = rest > 0 ? ` +${String(rest)}` : "";
  return `\n· ${labelPart}"${summary}" [${id8}]${more}${imp}`;
}

/**
 * Count memories whose file_refs intersect the given relative paths.
 * Returns 0 if no manager wired, or the paths array is empty.
 * Safe to call from any tool — never throws.
 */
export function countMemoriesForPaths(paths: string[]): number {
  if (!_manager || paths.length === 0) return 0;
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");
    const ids = new Set<string>();
    for (const id of projectDb.findByPaths(paths, 100)) ids.add(id);
    for (const id of globalDb.findByPaths(paths, 100)) ids.add(id);
    return ids.size;
  } catch (err) {
    reportHintError("paths", err);
    return 0;
  }
}

/**
 * Count memories whose `topics` json array intersects any of the given tags.
 * Useful for cross-cutting prefs without natural file paths (e.g. "git",
 * "commit", "lint", "style"). Never throws.
 */
export function countMemoriesForTopics(topics: string[]): number {
  if (!_manager || topics.length === 0) return 0;
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");
    const ids = new Set<string>();
    for (const id of projectDb.findByTopics(topics, 100)) ids.add(id);
    for (const id of globalDb.findByTopics(topics, 100)) ids.add(id);
    return ids.size;
  } catch (err) {
    reportHintError("topics", err);
    return 0;
  }
}

/**
 * Count memories matching a free-form query via FTS (unicode + trigram).
 * Returns the deduped count across both scopes. Never throws.
 */
export function countMemoriesForQuery(query: string): number {
  if (!_manager || !query || query.trim().length === 0) return 0;
  try {
    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");
    const ids = new Set<string>();
    for (const hit of projectDb.searchUnicode(query, 25)) ids.add(hit.id);
    for (const hit of projectDb.searchTrigram(query, 25)) ids.add(hit.id);
    for (const hit of globalDb.searchUnicode(query, 25)) ids.add(hit.id);
    for (const hit of globalDb.searchTrigram(query, 25)) ids.add(hit.id);
    return ids.size;
  } catch (err) {
    reportHintError("query", err);
    return 0;
  }
}

/**
 * Format a one-line hint. Returns empty string when count === 0 so callers
 * can unconditionally concatenate. Kept for back-compat — prefer
 * memoryHintComposite which applies the quality gate.
 */
export function formatMemoryHint(count: number): string {
  if (count <= 0) return "";
  if (count < 3) return ""; // bare counts below volume threshold are noise
  return `\n· ${String(count)} memories — memory(search) recommended`;
}

/**
 * Convenience helpers — route through memoryHintComposite so they get the
 * full quality gate, dedup, budget, and subagent rules.
 */
export function memoryHintForPaths(
  paths: string[],
  context: HintContext = "read",
  tabId?: string,
): string {
  return memoryHintComposite({ paths, context, tabId });
}

export function memoryHintForTopics(
  topics: string[],
  context: HintContext = "default",
  tabId?: string,
): string {
  return memoryHintComposite({ topics, context, tabId });
}

export function memoryHintForQuery(
  query: string,
  context: HintContext = "default",
  tabId?: string,
): string {
  return memoryHintComposite({ query, context, tabId });
}

/**
 * Composite hint — dedup across paths + topics + query, ranks the best
 * memory (pinned > gotcha > pref > decision), applies all gates and emits
 * an imperative tail line. Returns "" when nothing should surface.
 */
export function memoryHintComposite(opts: {
  paths?: string[];
  topics?: string[];
  query?: string;
  context?: HintContext;
  tabId?: string;
}): string {
  if (!_manager) return "";
  const tabId = opts.tabId ?? _scope.getStore()?.tabId ?? GLOBAL_TAB;
  if (getActed(tabId)) return "";
  try {
    const ctx: HintContext = opts.context ?? "default";
    if (isLateContext(ctx)) return "";

    const projectDb = _manager.getDbForScope("project");
    const globalDb = _manager.getDbForScope("global");

    // Combine candidate IDs across both scopes.
    const ids = new Set<string>();
    if (opts.paths && opts.paths.length > 0) {
      for (const id of projectDb.findByPaths(opts.paths, 100)) ids.add(id);
      for (const id of globalDb.findByPaths(opts.paths, 100)) ids.add(id);
    }
    if (opts.topics && opts.topics.length > 0) {
      for (const id of projectDb.findByTopics(opts.topics, 100)) ids.add(id);
      for (const id of globalDb.findByTopics(opts.topics, 100)) ids.add(id);
    }
    if (opts.query && opts.query.trim().length > 0) {
      for (const hit of projectDb.searchUnicode(opts.query, 25)) ids.add(hit.id);
      for (const hit of projectDb.searchTrigram(opts.query, 25)) ids.add(hit.id);
      for (const hit of globalDb.searchUnicode(opts.query, 25)) ids.add(hit.id);
      for (const hit of globalDb.searchTrigram(opts.query, 25)) ids.add(hit.id);
    }

    const total = ids.size;
    if (total === 0) return "";

    // Rank: query both scopes for top candidate, pick the loudest signal.
    const projectTop = projectDb.topRecallFor(opts, 1);
    const globalTop = globalDb.topRecallFor(opts, 1);
    let top: TopCandidate | null = null;
    const candidates = [...projectTop, ...globalTop];
    for (const c of candidates) {
      if (!top) {
        top = c;
        continue;
      }
      // Loudest wins: pinned > gotcha > existing.
      if (c.pinned && !top.pinned) top = c;
      else if (c.category === "gotcha" && top.category !== "gotcha" && !top.pinned) top = c;
    }

    return buildHintLine(top, total, ctx, tabId);
  } catch (err) {
    reportHintError("composite", err);
    return "";
  }
}
