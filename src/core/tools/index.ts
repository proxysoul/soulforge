import { resolve } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { logBackgroundError } from "../../stores/errors.js";
import type { EditorIntegration } from "../../types/index.js";
import {
  checkAndClaim,
  claimAfterCompoundEdit,
  prependWarning,
} from "../coordination/tool-wrapper.js";
import { getWorkspaceCoordinator } from "../coordination/WorkspaceCoordinator.js";
import { hasToolHooks, runHooks } from "../hooks/index.js";
import { MemoryManager } from "../memory/manager.js";
import {
  describeDestructiveCommand,
  isDestructiveCommand,
  isSensitiveFile,
} from "../security/approval-gates.js";
import { needsOutsideConfirm } from "../security/outside-cwd.js";
import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { analyzeTool } from "./analyze.js";
import { astEditTool } from "./ast-edit.js";
import { CORE_TOOL_NAMES, TOOL_CATALOG, truncateBytes, truncateLines } from "./constants.js";
import { discoverPatternTool } from "./discover-pattern.js";
import { editFileTool } from "./edit-file";
import { undoEditTool } from "./edit-stack.js";
import { editorTool } from "./editor";
import { fetchPageTool } from "./fetch-page.js";
import { onCacheReset, onFileEdited } from "./file-events.js";
import { gitTool, resetDiffCache } from "./git.js";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { listDirTool } from "./list-dir.js";
import { createMemoryTool } from "./memory.js";
import { moveSymbolTool } from "./move-symbol.js";
import { multiEditTool } from "./multi-edit.js";
import { navigateTool } from "./navigate.js";
import { projectTool } from "./project.js";
import { readFileTool } from "./read-file";
import { refactorTool } from "./refactor.js";
import { renameFileTool } from "./rename-file.js";
import { renameSymbolTool } from "./rename-symbol.js";
import {
  tryInterceptDiscoverPattern,
  tryInterceptGlob,
  tryInterceptGrep,
  tryInterceptNavigate,
} from "./repo-map-intercept.js";
import { createSetLockinTool } from "./set-lockin.js";
import { shellTool } from "./shell";
import { showImage } from "./show-image.js";
import { createSkillsTool } from "./skills.js";
import { soulAnalyzeTool } from "./soul-analyze.js";
import { soulFindTool } from "./soul-find.js";
import { soulGrepTool } from "./soul-grep.js";
import { soulImpactTool } from "./soul-impact.js";
import { taskListTool } from "./task-list.js";
import { buildWebSearchTool } from "./web-search";

export { wrapWithBusCache } from "./bus-cache.js";
export {
  CORE_TOOL_NAMES,
  PLAN_EXECUTION_TOOL_NAMES,
  planFileName,
  RESTRICTED_TOOL_NAMES,
  TOOL_CATALOG,
  truncateBytes,
  truncateLines,
} from "./constants.js";
export { buildInteractiveTools } from "./interactive.js";

let _soulToolWarningEmitted = false;

/**
 * Yield to the event loop before tool execution so the UI can render
 * the "running" spinner before synchronous operations block the thread.
 */
function deferExecute<T, R>(fn: (args: T) => Promise<R>): (args: T) => Promise<R> {
  return async (args: T) => {
    await new Promise<void>((r) => setTimeout(r, 0));
    return fn(args);
  };
}

const coerceInt = (v: unknown) => (typeof v === "string" ? Number(v) : v);
export const coerceBoolean = (v: unknown) => {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return v;
};
export const coerceJsonArray = (v: unknown) => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed[0] === "[" || trimmed[0] === "{") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
};

const nullToUndef = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
const optStr = () => z.string().nullable().optional().transform(nullToUndef);
const optBool = () => z.boolean().nullable().optional().transform(nullToUndef);
const optArray = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).nullable().optional().transform(nullToUndef);
const freshField = () => optBool().describe("Set true to bypass cache and re-execute");

/** Send tool results as plain text to the model instead of JSON.stringify'd objects.
 *  Without this, the AI SDK wraps `{success,output}` in JSON, escaping all newlines
 *  and quotes — adding 3-8% token overhead per tool result that compounds across steps. */
/** Enrich a successful edit result with blast radius + cochanges from the repo map. */
async function enrichWithBlastRadius(
  result: { success: boolean; output: string; error?: string },
  filePath: string,
  cwd: string,
  repoMap?: IntelligenceClient,
): Promise<void> {
  if (!result.success || !repoMap?.isReady) return;
  const rel = filePath.startsWith("/") ? filePath.slice(cwd.length + 1) : filePath;
  const blast = await repoMap.getFileBlastRadius(rel);
  const cochanges = await repoMap.getFileCoChanges(rel);
  if (blast > 0 || cochanges.length > 0) {
    const parts: string[] = [];
    if (blast > 0) parts.push(`${String(blast)} files depend on this`);
    if (cochanges.length > 0)
      parts.push(
        `cochanges: ${cochanges
          .slice(0, 3)
          .map((c: { path: string; count: number }) => c.path)
          .join(", ")}${cochanges.length > 3 ? ` +${String(cochanges.length - 3)}` : ""}`,
      );
    result.output += `\n[impact: ${parts.join(" · ")}]`;
  }
}

const TEXT_OUTPUT = {
  toModelOutput({ output }: { output: unknown }) {
    if (typeof output === "string") return { type: "text" as const, value: output };
    const r = output as { success?: boolean; output?: string; error?: string } | null;
    const text = r?.output ?? r?.error ?? JSON.stringify(output);
    return { type: "text" as const, value: text };
  },
};

export const PROGRAMMATIC_PROVIDER_OPTS: import("@ai-sdk/provider-utils").ProviderOptions = {
  anthropic: { allowedCallers: ["direct", "code_execution_20260120"] },
};
const forceField = () =>
  optBool().describe(
    "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
  );

const readFileSpec = z.object({
  path: z.string().describe("File path"),
  ranges: optArray(
    z.object({
      start: z.number().describe("Start line (1-indexed)"),
      end: z.number().describe("End line (1-indexed)"),
    }),
  ).describe("Line ranges to read. Omit for full file."),
  target: optStr().describe("Symbol type to extract (AST-based). Omit for raw read."),
  name: optStr().describe("Symbol name (required when target is set, except scope)"),
});

/** Coerce common weak-model mistakes for the `files` param:
 *  - bare string  → [{path: str}]
 *  - array of strings → [{path: s} for s]
 */
const coerceFileSpecs = (v: unknown): unknown => {
  if (typeof v === "string") return [{ path: v }];
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v.map((s) => (typeof s === "string" ? { path: s } : s));
  }
  return v;
};

export const SCHEMAS = {
  readFile: z.object({
    files: z
      .preprocess(
        (v) => coerceFileSpecs(coerceJsonArray(v)),
        z.union([z.array(readFileSpec), readFileSpec]),
      )
      .describe("Files to read. Array of {path, ranges?, target?, name?}. One item or many."),
    fresh: optBool().describe("Set true to bypass cache and re-execute"),
  }),
  grep: z.object({
    pattern: z.string().describe("Regex search pattern"),
    path: optStr().describe("Directory to search"),
    glob: optStr().describe("File glob filter"),
    force: forceField(),
  }),
  glob: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: optStr().describe("Base directory"),
    force: forceField(),
  }),
  soulGrep: z.object({
    pattern: z.string().describe("Regex or literal search pattern"),
    path: optStr().describe("Directory to search"),
    glob: optStr().describe("File glob filter (e.g. '*.ts')"),
    count: optBool().describe(
      "Aggregate count mode — returns per-file match counts and total. " +
        "Use for frequency analysis, variable counting, pattern prevalence.",
    ),
    wordBoundary: optBool().describe(
      "Whole-word matching (\\bpattern\\b). Prevents substring false positives. " +
        "Essential for counting variable/identifier occurrences.",
    ),
    dep: optStr().describe(
      "Search dependency/vendor directories (bypasses .gitignore). " +
        "Pass package name (e.g. 'react') to auto-locate, or 'true' to search all with --no-ignore.",
    ),
  }),
  soulFind: z.object({
    query: z.string().describe("Fuzzy search query"),
    type: optStr().describe("File type filter"),
    limit: z
      .preprocess(coerceInt, z.number())
      .nullable()
      .optional()
      .transform(nullToUndef)
      .describe("Max results (default 20)"),
  }),
} as const;

/** @internal — exported for testing only */
const GIT_MUTATING_ACTIONS = /\b(commit|stash|restore|switch|merge|rebase|cherry-pick|reset)\b/;
const GIT_CHECKOUT_DASHDASH = /\bcheckout\s+--/;

/** @internal — exported for testing only */
export function isGitMutatingShellCommand(command: string): boolean {
  const stripped = command
    .replace(/^(?:env\s+\S+=\S+\s+)*/, "")
    .replace(/^(?:command|builtin)\s+/, "");
  const gitIdx = stripped.search(/\bgit\b/);
  if (gitIdx === -1) return false;
  const afterGit = stripped.slice(gitIdx + 3).replace(/^\s+(-\S+\s+\S+\s+)*/, "");
  return GIT_MUTATING_ACTIONS.test(afterGit) || GIT_CHECKOUT_DASHDASH.test(afterGit);
}

/** Detect shell commands that write to specific files (sed -i, cp, mv, tee, etc.) */
const FILE_WRITE_SHELL_PATTERNS: Array<{
  re: RegExp;
  extractor: (m: RegExpMatchArray) => string[];
}> = [
  // sed -i / sed --in-place — file is the LAST argument
  {
    re: /\bsed\s+(?:-[^\s]*i[^\s]*|--in-place)\s+(.+)/,
    extractor: (m) => {
      const rest = (m[1] ?? "").trim();
      // Split on whitespace, skip quoted expressions and flags
      const tokens = rest.match(/(?:'[^']*'|"[^"]*"|[^\s]+)/g) ?? [];
      // File is the last non-flag, non-quoted-expression token
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (!t || t.startsWith("-") || t.startsWith("'") || t.startsWith('"')) continue;
        if (/^s[/|#]/.test(t)) continue; // skip s/pattern/repl/ without quotes
        return [t];
      }
      return [];
    },
  },
  // perl -i / perl -pi -e
  {
    re: /\bperl\s+(?:-[^\s]*i[^\s]*)\s+.*?([^\s'"|;&>]+\.\w+)/,
    extractor: (m) => (m[1] ? [m[1]] : []),
  },
  // cp/mv target (last arg)
  {
    re: /\b(cp|mv)\s+(?:-[^\s]+\s+)*(.+)/,
    extractor: (m) => {
      const args = (m[2] ?? "")
        .trim()
        .split(/\s+/)
        .filter((a) => !a.startsWith("-"));
      const last = args[args.length - 1];
      return args.length >= 2 && last ? [last] : [];
    },
  },
  // tee file
  {
    re: /\btee\s+(?:-[^\s]+\s+)*([^\s|;&>]+)/,
    extractor: (m) => (m[1] ? [m[1]] : []),
  },
  // echo/printf > file or >> file
  {
    re: />{1,2}\s*([^\s|;&]+)/,
    extractor: (m) => (m[1] ? [m[1]] : []),
  },
];

/** Build a warning string showing other tabs' file claims for destructive command approval */
function buildCrossTabDestructiveWarning(tabId?: string): string | null {
  if (!tabId) return null;
  const wc = getWorkspaceCoordinator();
  const editors = wc.getActiveEditors();
  const lines: string[] = [];
  for (const [tid] of editors) {
    if (tid === tabId) continue;
    const tabClaims = wc.getClaimsForTab(tid);
    if (tabClaims.size === 0) continue;
    let label = "Unknown";
    const paths: string[] = [];
    for (const [p, claim] of tabClaims) {
      label = claim.tabLabel;
      paths.push(p);
    }
    const shown = paths.slice(0, 5);
    const extra = paths.length > 5 ? ` (+${String(paths.length - 5)} more)` : "";
    lines.push(`  Tab "${label}": ${shown.join(", ")}${extra}`);
  }
  if (lines.length === 0) return null;
  return `⚠️ Other tabs are editing files:\n${lines.join("\n")}`;
}

/** @internal — exported for testing only */
export function extractWrittenFiles(command: string): string[] {
  const files: string[] = [];
  for (const { re, extractor } of FILE_WRITE_SHELL_PATTERNS) {
    const m = command.match(re);
    if (m) {
      for (const f of extractor(m)) {
        if (f && !f.startsWith("-") && !f.startsWith("/dev/")) {
          files.push(f);
        }
      }
    }
  }
  return files;
}

/**
 * Build Vercel AI SDK tool definitions.
 * AI SDK v6 uses `inputSchema` instead of `parameters`.
 *
 * @param onApproveWebSearch - If provided, called before every web_search with the query.
 *   Resolves to true = allow, false = deny. When omitted, web_search executes unguarded.
 */
export function buildTools(
  cwd?: string,
  _editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    codeExecution?: boolean;
    computerUse?: boolean;
    anthropicTextEditor?: boolean;
    /** Override Anthropic tool versions per model capability.
     *  When set, buildTools uses the specified versions instead of hardcoded defaults. */
    toolVersions?: {
      computerUse?: "20251124" | "20250124";
      textEditor?: "20250728" | "20250124";
      programmaticToolCalling?: boolean;
    };
    memoryManager?: MemoryManager;
    contextManager?: import("../context/manager.js").ContextManager;
    agentSkills?: boolean;
    webSearchModel?: import("ai").LanguageModel;
    repoMap?: IntelligenceClient;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
    onApproveOutsideCwd?: (toolName: string, path: string) => Promise<boolean>;
    onApproveDestructive?: (description: string) => Promise<boolean>;
    tabId?: string;
    tabLabel?: string;
    activeDeferredTools?: Set<string>;
  },
) {
  const effectiveCwd = cwd ?? process.cwd();
  const mm = opts?.memoryManager ?? new MemoryManager(effectiveCwd);
  const memoryTool = createMemoryTool({
    manager: mm,
    intelligence: opts?.repoMap ?? null,
    tabId: opts?.tabId,
  });
  const skillsEnabled = opts?.agentSkills === true;
  const skillsTool =
    skillsEnabled && opts?.contextManager
      ? createSkillsTool(opts.contextManager, opts?.onApproveDestructive)
      : null;

  // Programmatic tool calling: when code execution is enabled AND the model supports it,
  // read/search tools get allowedCallers so Claude can batch them in Python code.
  // Tool results from programmatic calls don't count as input/output tokens — only stdout does.
  const canUseProgrammatic =
    opts?.codeExecution && (opts?.toolVersions?.programmaticToolCalling ?? true);
  const progProviderOpts = canUseProgrammatic ? PROGRAMMATIC_PROVIDER_OPTS : undefined;

  // Read nudges disabled — tool-result injection causes conversational responses
  // ("You're right, let me stop reading") and interrupts legitimate investigation.
  // Steering handled by system prompt ("max 3 exploration rounds") + step-utils.
  let _sequentialReads = 0;
  let sequentialReadFiles = new Set<string>();
  const resetReadCounter = () => {
    _sequentialReads = 0;
    sequentialReadFiles = new Set();
  };

  // Mechanical re-read blocking — returns stub if agent already has full content in context
  const fullReadCache = new Set<string>();
  const readCountPerFile = new Map<string, number>();
  const MAX_READS_PER_FILE = 3;
  onFileEdited((absPath) => {
    fullReadCache.delete(absPath);
    readCountPerFile.delete(absPath);
    resetDiffCache();
  });
  onCacheReset(() => {
    fullReadCache.clear();
    readCountPerFile.clear();
    resetDiffCache();
  });
  const resetReadCache = () => {
    fullReadCache.clear();
    readCountPerFile.clear();
    resetDiffCache();
  };

  async function gateOutsideCwd(
    toolName: string,
    filePath: string,
  ): Promise<
    | { blocked: true; result: { success: false; output: string; error: string } }
    | { blocked: false }
  > {
    if (!needsOutsideConfirm(toolName, filePath, effectiveCwd)) return { blocked: false };
    if (!opts?.onApproveOutsideCwd) return { blocked: false };
    const approved = await opts.onApproveOutsideCwd(toolName, filePath);
    if (approved) return { blocked: false };
    const msg = `Denied: ${toolName} outside project directory → ${filePath}`;
    return { blocked: true, result: { success: false, output: msg, error: msg } };
  }

  const tools = {
    read: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: readFileTool.description,
      inputSchema: SCHEMAS.readFile,
      execute: deferExecute(async (args) => {
        // Normalize input: detect old format, single object, or proper array
        let warn = "";
        type FileSpec = {
          path: string;
          ranges?: Array<{ start: number; end: number }>;
          target?: string;
          name?: string;
        };
        let fileSpecs: FileSpec[];

        if (Array.isArray(args.files)) {
          fileSpecs = args.files;
        } else if (args.files) {
          warn = "[⚠ files should be an array — wrap in [] next time]\n\n";
          fileSpecs = [args.files];
        } else {
          return {
            success: false,
            output: "Missing files parameter. Use files=[{path:'file.ts'}].",
          };
        }

        const outputs: string[] = [];
        if (warn) outputs.push(warn.trim());

        const batchResults = await Promise.all(
          fileSpecs.map(async (spec) => {
            const fp = spec.path;
            const normPath = resolve(fp);
            const hasRanges = spec.ranges && spec.ranges.length > 0;
            const isFullRead = !hasRanges && !spec.target;

            // Cache: skip re-reads
            if (!args.fresh && fullReadCache.has(normPath)) {
              if (isFullRead) {
                return {
                  path: fp,
                  results: [
                    {
                      success: true as const,
                      output: `[Already read — "${fp}" content is in your context above. Pass fresh=true to re-read.]`,
                    },
                  ],
                };
              }
            }

            // Excessive read protection
            if (!args.fresh && !isFullRead) {
              const count = readCountPerFile.get(normPath) ?? 0;
              if (count >= MAX_READS_PER_FILE) {
                return {
                  path: fp,
                  results: [
                    {
                      success: true as const,
                      output: `[Read ${String(count)} times — "${fp}" is already in your context.]`,
                    },
                  ],
                };
              }
            }

            if (hasRanges && spec.ranges) {
              const rangeResults = await Promise.all(
                spec.ranges.map((r) =>
                  readFileTool.execute({
                    path: fp,
                    startLine: r.start,
                    endLine: r.end,
                    tabId: opts?.tabId,
                  }),
                ),
              );
              readCountPerFile.set(
                normPath,
                (readCountPerFile.get(normPath) ?? 0) + rangeResults.length,
              );
              return { path: fp, results: rangeResults };
            }

            if (isFullRead && !args.fresh) fullReadCache.add(normPath);
            const result = await readFileTool.execute({
              path: fp,
              ...(spec.target ? { target: spec.target, name: spec.name } : {}),
              tabId: opts?.tabId,
            });
            if (!result.success && isFullRead) fullReadCache.delete(normPath);
            if (result.success && !isFullRead) {
              readCountPerFile.set(normPath, (readCountPerFile.get(normPath) ?? 0) + 1);
            }
            return { path: fp, results: [result] };
          }),
        );

        const multiFile = batchResults.length > 1;
        for (const { path: fp, results } of batchResults) {
          sequentialReadFiles.add(resolve(fp));
          if (multiFile) outputs.push(`── ${fp} ──`);
          for (const r of results) {
            outputs.push(r.output);
          }
        }

        _sequentialReads += fileSpecs.length;
        return { success: true, output: outputs.join("\n\n") };
      }),
    }),

    edit_file: tool({
      ...TEXT_OUTPUT,
      description: editFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        oldString: z.string().describe("Content to replace (empty = create new file)"),
        newString: z.string().describe("Replacement content"),
        lineStart: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "1-indexed start line from your last read output. " +
              "The range is derived from oldString line count — lineStart anchors where to look.",
          ),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("edit_file", resolve(args.path));
        if (gate.blocked) return gate.result;
        if (opts?.onApproveDestructive && isSensitiveFile(args.path)) {
          const approved = await opts.onApproveDestructive(`Edit sensitive file: \`${args.path}\``);
          if (!approved) {
            const msg = `Denied: edit to sensitive file ${args.path}`;
            return { success: false, output: msg, error: msg };
          }
        }
        const warning = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.path));
        const result = await editFileTool.execute({ ...args, tabId: opts?.tabId });
        if (!result.success && result.error === "old_string not found" && warning) {
          return {
            success: false,
            output: `CONTENTION: File ${args.path} was modified by another tab. Your edit is based on stale content. Inform the user this file is contested.`,
            error: "contested",
          };
        }
        await enrichWithBlastRadius(result, args.path, effectiveCwd, opts?.repoMap);
        return result;
      }),
    }),

    undo_edit: tool({
      ...TEXT_OUTPUT,
      description: undoEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to undo"),
        steps: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Number of edits to undo (default 1, max 20)"),
      }),
      execute: deferExecute((args) => undoEditTool.execute({ ...args, tabId: opts?.tabId })),
    }),

    multi_edit: tool({
      ...TEXT_OUTPUT,
      description: multiEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        edits: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                oldString: z.string().describe("Content to replace"),
                newString: z.string().describe("Replacement content"),
                lineStart: z
                  .preprocess(coerceInt, z.number())
                  .nullable()
                  .optional()
                  .transform(nullToUndef)
                  .describe(
                    "1-indexed start line from read output. Range derived from oldString line count.",
                  ),
              }),
            ),
          )
          .describe("Array of edits to apply atomically"),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("multi_edit", resolve(args.path));
        if (gate.blocked) return gate.result;
        if (opts?.onApproveDestructive && isSensitiveFile(args.path)) {
          const approved = await opts.onApproveDestructive(`Edit sensitive file: \`${args.path}\``);
          if (!approved) {
            const msg = `Denied: edit to sensitive file ${args.path}`;
            return { success: false, output: msg, error: msg };
          }
        }
        const warning = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.path));
        const result = await multiEditTool.execute({ ...args, tabId: opts?.tabId });
        if (!result.success && result.error?.includes("not found") && warning) {
          return {
            success: false,
            output: `CONTENTION: File ${args.path} was modified by another tab. Your edit is based on stale content. Inform the user this file is contested.`,
            error: "contested",
          };
        }
        await enrichWithBlastRadius(result, args.path, effectiveCwd, opts?.repoMap);
        return result;
      }),
    }),

    ast_edit: tool({
      ...TEXT_OUTPUT,
      description: astEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit (.ts, .tsx, .js, .jsx)"),
        action: optStr().describe(
          "Surgical action. " +
            "Tier 1 (micro, 1-10 tokens): set_type, set_return_type, set_initializer, remove_initializer, set_value, " +
            "set_async, set_generator, set_export, set_default_export, set_abstract, set_static, set_readonly, " +
            "set_scope, set_optional, set_overrides, set_ambient, set_const_enum, " +
            "rename (declaration-only — safe default, won't touch references), " +
            "rename_global (project-wide rename — use only when you actually want references updated), " +
            "remove, add_parameter, remove_parameter, set_declaration_kind. " +
            "Tier 2 (body, 10-100 tokens): set_body, add_statement, insert_statement, remove_statement, " +
            "add_property, remove_property, add_method, remove_method, add_member, remove_member, " +
            "add_constructor, add_getter, add_setter, add_decorator, remove_decorator, add_overload, " +
            "set_extends, remove_extends, add_implements, remove_implements, add_extends, " +
            "add_type_parameter, add_jsdoc, remove_jsdoc, unwrap, set_structure, extract_interface. " +
            "Tier 3 (full): replace, " +
            "replace_in_body (AST-anchored string replace — scoped to a symbol's text: value=unique substring, newCode=replacement; fails on ambiguous match). " +
            "File-level: create_file (pass newCode as the full file content — file must not yet exist), " +
            "add_import, remove_import, add_named_import, remove_named_import, set_module_specifier, " +
            'add_export_declaration, add_named_reexport (idempotent — merges into existing `export { … } from "./x"`), ' +
            "add_namespace, organize_imports, fix_missing_imports, fix_unused, " +
            "add_function, add_class, add_interface, add_type_alias, add_enum, add_variable, " +
            'insert_text (REQUIRES anchor: index=0 top, index=-1 bottom, value="after-imports"|"before-exports", or numeric slot).',
        ),
        target: z
          .enum([
            "function",
            "class",
            "interface",
            "type",
            "enum",
            "variable",
            "constant",
            "method",
            "property",
            "constructor",
            "arrow_function",
          ])
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Symbol kind to target. Use 'method' for class methods (name as 'ClassName.methodName' or just 'methodName'). " +
              "Use 'property' for class/interface properties (same dot notation). add_property also accepts dotted 'Owner.prop' and auto-resolves the container. " +
              "Use 'constructor' with name=ClassName to modify an existing class constructor's body. " +
              "Use 'arrow_function' for `const fn = async (…) => {…}` — targets the initializer (supports set_return_type, set_async, set_body, etc.). " +
              "'function' also finds class methods as fallback. " +
              "CANNOT TARGET: anonymous callbacks (inline arrows, IIFEs, object-literal methods without names), union members of a type alias (use `replace` on the whole type). For these, use `replace_in_body` on the enclosing named symbol, or fall back to multi_edit.",
          ),
        name: optStr().describe(
          "Symbol name. For methods/properties use 'ClassName.memberName' or just 'memberName' to search all classes.",
        ),
        value: optStr().describe(
          "Short value for surgical ops (type string, new name, boolean as string, etc.)",
        ),
        newCode: optStr().describe(
          "Code body for set_body/replace/add_statement/add_method/add_property etc.",
        ),
        index: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Statement index for insert_statement/remove_statement"),
        operations: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                action: z.string().describe("Surgical action"),
                target: optStr().describe("Symbol kind"),
                name: optStr().describe("Symbol name"),
                value: optStr().describe("Short value"),
                newCode: optStr().describe("Code body"),
                index: z
                  .preprocess(coerceInt, z.number())
                  .nullable()
                  .optional()
                  .transform(nullToUndef)
                  .describe("Statement index"),
              }),
            ),
          )
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Atomic multi-operation mode: array of {action, target?, name?, value?, newCode?, index?}. All-or-nothing.",
          ),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("ast_edit", resolve(args.path));
        if (gate.blocked) return gate.result;
        if (opts?.onApproveDestructive && isSensitiveFile(args.path)) {
          const approved = await opts.onApproveDestructive(`Edit sensitive file: \`${args.path}\``);
          if (!approved) {
            const msg = `Denied: edit to sensitive file ${args.path}`;
            return { success: false, output: msg, error: msg };
          }
        }
        const result = await astEditTool.execute({ ...args, tabId: opts?.tabId });
        await enrichWithBlastRadius(result, args.path, effectiveCwd, opts?.repoMap);
        return result;
      }),
    }),

    task_list: tool({
      ...TEXT_OUTPUT,
      description: taskListTool.description,
      inputSchema: z.object({
        action: z.enum(["add", "update", "remove", "list", "clear"]).describe("Task action"),
        title: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Single task title (for add/update)"),
        titles: z
          .preprocess(coerceJsonArray, z.array(z.string()))
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Batch add — multiple task titles at once"),
        id: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Task ID (for update/remove)"),
        status: z
          .enum(["pending", "in-progress", "done", "blocked"])
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Task status (for add/update)"),
      }),
      execute: deferExecute((args) => taskListTool.execute({ ...args, tabId: opts?.tabId })),
    }),

    list_dir: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: listDirTool.description,
      inputSchema: z.object({
        path: z
          .preprocess(coerceJsonArray, z.union([z.string(), z.array(z.string())]))
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Directory path or array of paths (defaults to cwd). Pass multiple paths to list several directories in one call.",
          ),
        depth: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Recursion depth (1=immediate children, max 5). Default 1."),
      }),
      execute: deferExecute((args) => listDirTool.execute(args, opts?.repoMap)),
    }),

    soul_grep: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description:
        soulGrepTool.description +
        " Use dep to search inside dependency/vendor directories (bypasses .gitignore).",
      inputSchema: SCHEMAS.soulGrep.extend({ fresh: freshField() }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulGrepTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_find: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: soulFindTool.description,
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Fuzzy search query — use specific symbol/file names (e.g. 'RepoMap', 'useTabs'), not generic words like 'index', 'utils', 'config' that match dozens of files",
          ),
        type: z
          .enum(["test", "component", "config", "types", "style"])
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Filter by file category"),
        limit: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Max results (default 20)"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulFindTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_analyze: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: soulAnalyzeTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "identifier_frequency",
            "unused_exports",
            "file_profile",
            "duplication",
            "top_files",
            "packages",
            "symbols_by_kind",
            "call_graph",
            "class_members",
            "summaries",
            "search_symbols",
          ])
          .describe(
            "identifier_frequency=most referenced symbols, unused_exports=dead code report, " +
              "file_profile=deps/dependents/blast/cochanges/symbols, duplication=clone detection, " +
              "top_files=PageRank ranking, packages=external deps, symbols_by_kind=by type (function/class/etc), " +
              "call_graph=callers/callees for a symbol, class_members=methods of a class, summaries=semantic summaries, " +
              "search_symbols=FTS prefix search on symbol names (e.g. name='build*')",
          ),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File path (required for file_profile)"),
        name: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Identifier/package name (for identifier_frequency, packages, symbols_by_kind)",
          ),
        kind: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Symbol kind (for symbols_by_kind: interface, class, function, type, enum, trait, struct)",
          ),
        limit: z.number().nullable().optional().transform(nullToUndef).describe("Max results"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulAnalyzeTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_impact: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: soulImpactTool.description,
      inputSchema: z.object({
        action: z
          .enum(["dependents", "dependencies", "cochanges", "blast_radius"])
          .describe(
            "dependents=files importing this, dependencies=what this imports, " +
              "cochanges=files edited together in git, blast_radius=total affected scope",
          ),
        file: z.string().describe("File path to analyze"),
      }),
      execute: deferExecute((args) => {
        resetReadCounter();
        return soulImpactTool.createExecute(opts?.repoMap)(args);
      }),
    }),

    soul_vision: tool({
      description:
        "Display an image or video inline in the chat. " +
        "Supported formats: PNG, JPG/JPEG, WebP, GIF, BMP, TIFF (images); MP4, MKV, WebM, AVI, MOV and other common video formats (converted to animated GIF). " +
        "Accepts a local file path or a URL (https://...). Max file size: 10 MB. " +
        "Videos require ffmpeg; video URLs also need yt-dlp. " +
        "The image is rendered as real pixels in Kitty or half-block art in other terminals.",
      inputSchema: z.object({
        path: z.string().describe("Path to the image/video file or URL (https://...)"),
        cols: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Display width in terminal columns (default: 120, max: 200)"),
      }),
      execute: async (args, { toolCallId, abortSignal }) => {
        return showImage(args, effectiveCwd, toolCallId, abortSignal);
      },
    }),

    shell: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: shellTool.description,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().nullable().optional().transform(nullToUndef).describe("Working directory"),
        timeout: z.number().nullable().optional().transform(nullToUndef).describe("Timeout in ms"),
      }),
      execute: async (args, { abortSignal }) => {
        await new Promise<void>((r) => setTimeout(r, 0));
        resetReadCounter();
        resetReadCache(); // Shell commands can modify any file
        if (args.cwd) {
          const gate = await gateOutsideCwd("shell", resolve(args.cwd));
          if (gate.blocked) return gate.result;
        }
        // Block git-mutating commands during active dispatch (same guard as git tool)
        if (opts?.tabId && isGitMutatingShellCommand(args.command)) {
          const wc = getWorkspaceCoordinator();
          const activeTabs = wc.getTabsWithActiveAgents(opts.tabId);
          if (activeTabs.length > 0) {
            const tabNames = activeTabs.map((t: string) => `"${t}"`).join(", ");
            return {
              success: false,
              output: `BLOCKED: Tab ${tabNames} has dispatch agents actively editing files. Your edits are saved to disk. Inform the user the git command is pending — do not attempt again.`,
              error: "active dispatch",
            };
          }
        }
        if (opts?.onApproveDestructive && isDestructiveCommand(args.command)) {
          const desc = describeDestructiveCommand(args.command);
          const crossTabWarning = buildCrossTabDestructiveWarning(opts.tabId);
          const prompt = crossTabWarning
            ? `Shell: ${desc}\n\n\`${args.command}\`\n\n${crossTabWarning}`
            : `Shell: ${desc}\n\n\`${args.command}\``;
          const approved = await opts.onApproveDestructive(prompt);
          if (!approved) {
            const msg = `Denied: ${desc}`;
            return { success: false, output: msg, error: msg };
          }
        }
        const result = await shellTool.execute(args, abortSignal);
        if (result.success && opts?.repoMap?.isReady) {
          opts.repoMap.recheckModifiedFiles();
        }
        // Post-hoc claim files written by shell commands (sed -i, cp, mv, tee, >)
        if (result.success && opts?.tabId && opts?.tabLabel) {
          const written = extractWrittenFiles(args.command);
          if (written.length > 0) {
            claimAfterCompoundEdit(opts.tabId, opts.tabLabel, written);
          }
        }
        return result;
      },
    }),

    grep: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: grepTool.description,
      inputSchema: SCHEMAS.grep.extend({ fresh: freshField() }),
      execute: deferExecute(async (args) => {
        resetReadCounter();
        if (!args.force) {
          const hit = await tryInterceptGrep(args, opts?.repoMap, effectiveCwd);
          if (hit) return hit;
        }
        return grepTool.execute(args);
      }),
    }),

    glob: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: globTool.description,
      inputSchema: SCHEMAS.glob.extend({ fresh: freshField() }),
      execute: deferExecute(async (args) => {
        resetReadCounter();
        if (!args.force) {
          const hit = await tryInterceptGlob(args, opts?.repoMap, effectiveCwd);
          if (hit) return hit;
        }
        return globTool.execute(args);
      }),
    }),

    web_search: buildWebSearchTool({
      webSearchModel: opts?.webSearchModel,
      onApprove: onApproveWebSearch,
      onApproveFetchPage: opts?.onApproveFetchPage,
    }),

    fetch_page: tool({
      ...TEXT_OUTPUT,
      description: fetchPageTool.description,
      inputSchema: z.object({
        url: z.string().describe("URL to fetch and read"),
      }),
      execute: deferExecute(async (args) => {
        if (opts?.onApproveFetchPage) {
          let approved: boolean;
          try {
            approved = await opts.onApproveFetchPage(args.url);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              output: `Page fetch approval cancelled: ${msg}`,
              error: "Approval cancelled.",
            };
          }
          if (!approved) {
            return {
              success: false,
              output: "Page fetch was denied by the user.",
              error: "Fetch denied.",
            };
          }
        }
        return fetchPageTool.execute(args);
      }),
    }),

    memory: memoryTool,
    ...(skillsTool ? { skills: skillsTool } : {}),
    set_lockin: createSetLockinTool(),

    editor: tool({
      ...TEXT_OUTPUT,
      description: editorTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "read",
            "edit",
            "navigate",
            "diagnostics",
            "symbols",
            "hover",
            "references",
            "definition",
            "actions",
            "rename",

            "format",
            "select",
            "goto_cursor",
            "yank",
            "highlight",
            "cursor_context",
            "buffers",
            "quickfix",
            "terminal_output",
          ])
          .describe(
            "read=buffer content, edit=replace lines, navigate=open file/jump, " +
              "diagnostics/symbols/hover/references/definition=buffer-level (use navigate tool for LSP), " +
              "actions=code actions, rename=buffer rename, format=format, buffers=list open, terminal_output=read terminal",
          ),
        startLine: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For read/edit/format/select/highlight: start line (1-indexed)"),
        endLine: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For read/edit/format/select/highlight: end line (1-indexed)"),
        replacement: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For edit: new content"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For read/edit/navigate: file path (switches buffer)"),
        line: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For navigate/hover/references/definition/actions/rename/goto_cursor: line"),
        col: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For navigate/hover/references/definition/actions/rename/goto_cursor: column"),
        search: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For navigate: search pattern"),
        newName: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For rename: new symbol name"),
        apply: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For actions: 0-indexed action to apply"),
        jump: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For definition: jump to first result"),
        text: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For yank: text to put in register"),
        register: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe('For yank: neovim register (default: "+", system clipboard)'),
        count: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For terminal_output: max lines to read (default: 100)"),
      }),
      execute: deferExecute((args) => {
        const access = _editorSettings?.agentAccess ?? "on";
        if (access === "off") {
          return Promise.resolve({
            success: false,
            output: "Editor tool is disabled. Change in /editor-config → Agent editor access.",
            error: "editor access disabled",
          });
        }
        if (access === "when-open" && opts?.contextManager && !opts.contextManager.isEditorOpen()) {
          return Promise.resolve({
            success: false,
            output:
              "Editor tool requires the editor panel to be open (agent access = when-open). Use edit_file instead, or open the editor panel.",
            error: "editor not open",
          });
        }
        return editorTool.execute(args);
      }),
    }),

    navigate: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: navigateTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "definition",
            "references",
            "symbols",
            "imports",
            "exports",
            "workspace_symbols",
            "call_hierarchy",
            "implementation",
            "type_hierarchy",
            "search_symbols",
          ])
          .describe(
            "definition=returns file:line of definition, references=returns all file:line usages, " +
              "call_hierarchy=returns callers/callees with file:line, implementation=returns concrete implementors, " +
              "type_hierarchy=returns super/subtypes, symbols/imports/exports=returns file contents, " +
              "workspace_symbols/search_symbols=returns matching symbols across all files",
          ),
        symbol: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Symbol name to look up"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File path (auto-resolved from symbol if omitted)"),
        scope: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Filter symbols by name pattern"),
        query: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Search query for workspace_symbols/search_symbols"),
        force: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute(async (args) => {
        resetReadCounter();
        if (!args.force) {
          const hit = await tryInterceptNavigate(args, opts?.repoMap, effectiveCwd);
          if (hit) return hit;
        }
        return navigateTool.execute(args, opts?.repoMap);
      }),
    }),

    rename_symbol: tool({
      ...TEXT_OUTPUT,
      description: renameSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Current name of the symbol to rename"),
        newName: z.string().describe("New name for the symbol"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "File where the symbol is defined (optional — auto-detected via workspace search)",
          ),
      }),
      execute: deferExecute(async (args) => {
        if (args.file) {
          const gate = await gateOutsideCwd("rename_symbol", resolve(args.file));
          if (gate.blocked) return gate.result;
        }
        const warning = args.file
          ? checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.file))
          : null;
        const result = await renameSymbolTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success && args.file) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.file]);
        }
        return prependWarning(result, warning);
      }),
    }),

    move_symbol: tool({
      ...TEXT_OUTPUT,
      description: moveSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Name of the symbol to move"),
        from: z.string().describe("Source file path"),
        to: z.string().describe("Target file path (created if it doesn't exist)"),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("move_symbol", resolve(args.to));
        if (gate.blocked) return gate.result;
        const fromWarn = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.from));
        const toWarn = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.to));
        const result = await moveSymbolTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.from, args.to]);
        }
        return prependWarning(prependWarning(result, toWarn), fromWarn);
      }),
    }),

    rename_file: tool({
      ...TEXT_OUTPUT,
      description: renameFileTool.description,
      inputSchema: z.object({
        from: z.string().describe("Current file path"),
        to: z.string().describe("New file path"),
      }),
      execute: deferExecute(async (args) => {
        const gate = await gateOutsideCwd("rename_file", resolve(args.to));
        if (gate.blocked) return gate.result;
        const warning = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.from));
        const result = await renameFileTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.from, args.to]);
        }
        return prependWarning(result, warning);
      }),
    }),

    refactor: tool({
      ...TEXT_OUTPUT,
      description: refactorTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "extract_function",
            "extract_variable",
            "format",
            "format_range",
            "organize_imports",
          ])
          .describe(
            "extract_function=lines→new function, extract_variable=expression→variable, " +
              "organize_imports=sort/dedupe, format=whole file, format_range=line range",
          ),
        file: z.string().nullable().optional().transform(nullToUndef).describe("Target file"),
        newName: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("New name for extracted symbol"),
        startLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Start line for extraction or range formatting"),
        endLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("End line for extraction or range formatting"),
        name: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Symbol name to extract (auto-resolves line range — use instead of startLine/endLine)",
          ),
        apply: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Apply changes to disk (default true)"),
      }),
      execute: deferExecute(async (args) => {
        if (args.file) {
          const gate = await gateOutsideCwd("refactor", resolve(args.file));
          if (gate.blocked) return gate.result;
        }
        const warning = args.file
          ? checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.file))
          : null;
        const result = await refactorTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success && args.file) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.file]);
        }
        return prependWarning(result, warning);
      }),
    }),

    analyze: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: analyzeTool.description,
      inputSchema: z.object({
        action: z
          .enum(["diagnostics", "type_info", "outline", "code_actions", "unused", "symbol_diff"])
          .describe(
            "diagnostics=type errors/warnings, type_info=type signature+docs, " +
              "outline=compact symbol list, code_actions=quick fixes, unused=unused symbols in file, symbol_diff=before/after exports",
          ),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File path to analyze"),
        symbol: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Symbol for type_info"),
        line: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Line number for type_info"),
        column: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Column number for type_info"),
        startLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Start line for code_actions range"),
        endLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("End line for code_actions range"),
        oldContent: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Old file content for symbol_diff (or uses git HEAD)"),
      }),
      execute: deferExecute((args) => analyzeTool.execute(args)),
    }),

    discover_pattern: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: discoverPatternTool.description,
      inputSchema: z.object({
        query: z.string().describe("Concept to discover (e.g. 'provider', 'router', 'auth')"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File to scope the search to"),
        force: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute(async (args) => {
        if (!args.force) {
          const hit = await tryInterceptDiscoverPattern(args, opts?.repoMap, effectiveCwd);
          if (hit) return hit;
        }
        return discoverPatternTool.execute(args);
      }),
    }),

    project: tool({
      ...TEXT_OUTPUT,
      providerOptions: progProviderOpts,
      description: projectTool.description,
      inputSchema: z.object({
        action: z
          .enum(["check", "test", "build", "lint", "format", "typecheck", "run", "list"])
          .describe(
            "Project action. format = auto-fix lint/style issues. list discovers monorepo packages.",
          ),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Target file (for test/lint)"),
        fix: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Auto-fix lint issues"),
        script: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Named script to run (for run action)"),
        flags: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Extra flags appended to the command (e.g. '--features async', '-k test_name')",
          ),
        raw: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Skip preset fix flags — use only the flags you provide"),
        env: z
          .preprocess(coerceJsonArray, z.record(z.string(), z.string()))
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Environment variables (e.g. { NODE_ENV: 'test', DEBUG: '1' })"),
        cwd: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Working directory relative to project root (for monorepos)"),
        timeout: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Timeout in ms (default 120000)"),
      }),
      execute: deferExecute((args) =>
        projectTool.execute(args as Parameters<typeof projectTool.execute>[0]),
      ),
    }),

    git: tool({
      ...TEXT_OUTPUT,
      description: gitTool.description,
      inputSchema: z.object({
        action: z.enum([
          "status",
          "diff",
          "log",
          "commit",
          "push",
          "pull",
          "stash",
          "branch",
          "show",
          "unstage",
          "restore",
          "stage",
          "tag",
          "cherry_pick",
          "rebase",
          "reset",
          "blame",
        ]),
        staged: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For diff: staged changes"),
        count: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For log: number of commits"),
        message: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For commit: subject line. For stash/tag: message"),
        body: z
          .preprocess(coerceJsonArray, z.union([z.string(), z.array(z.string())]))
          .nullable()
          .optional()
          .transform((v) => {
            if (v == null) return undefined;
            return Array.isArray(v) ? v.join("\n") : v;
          })
          .describe('For commit: extended description. Prefer ["line1", "line2"] for multi-line.'),
        footer: z
          .preprocess(coerceJsonArray, z.union([z.string(), z.array(z.string())]))
          .nullable()
          .optional()
          .transform((v) => {
            if (v == null) return undefined;
            return Array.isArray(v) ? v.join("\n") : v;
          })
          .describe(
            'For commit: trailers (Fixes, BREAKING CHANGE). Prefer ["line1", "line2"] for multi-line.',
          ),
        files: z
          .preprocess(coerceJsonArray, z.array(z.string()))
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "For commit/unstage/restore/stage/reset: files. Stage with no files stages all (-A).",
          ),
        sub_action: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "For stash: push|pop|list|show|drop. For branch: list|create|switch|delete. For tag: list|create|delete. For rebase: start|abort|continue|skip",
          ),
        name: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For branch/tag: name"),
        index: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For stash: stash index"),
        amend: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For commit: amend the last commit"),
        ref: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "For show/cherry_pick/rebase/reset/tag: commit hash, branch, or ref (default: HEAD)",
          ),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For blame: file path"),
        mode: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For reset: soft|mixed|hard (default: mixed)"),
        startLine: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For blame: start line"),
        endLine: z
          .number()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("For blame: end line"),
        flags: z
          .preprocess(coerceJsonArray, z.array(z.string()))
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Extra flags appended to the git command (e.g. ['--stat', 'main..HEAD'] for diff, ['--graph', '--all'] for log, ['--force-with-lease'] for push, ['-p'] for show). Works with: diff, log, show, push, pull, branch, cherry_pick, rebase.",
          ),
      }),
      execute: deferExecute(async (args) => {
        const mutating = [
          "pull",
          "stash",
          "restore",
          "branch",
          "reset",
          "cherry_pick",
          "rebase",
        ].includes(args.action);
        if (mutating) resetReadCache();
        return gitTool.execute(args, opts?.tabId);
      }),
    }),

    request_tools: tool({
      ...TEXT_OUTPUT,
      description:
        "Load additional tools by name. Available tools:\n" +
        Object.entries(TOOL_CATALOG)
          .map(([name, desc]) => `  ${name} — ${desc}`)
          .join("\n"),
      inputSchema: z.object({
        tools: z
          .preprocess(coerceJsonArray, z.array(z.string()))
          .describe("Tool names to activate"),
      }),
      execute: async (args) => {
        const deferred = opts?.activeDeferredTools;
        if (!deferred) return { success: true, output: "On-demand tools not enabled" };
        const catalog = TOOL_CATALOG;
        const coreNames = new Set(CORE_TOOL_NAMES);
        const activated: string[] = [];
        const unknown: string[] = [];
        const alreadyActive: string[] = [];
        for (const name of args.tools) {
          if (coreNames.has(name)) {
            alreadyActive.push(`${name} (core)`);
          } else if (!catalog[name]) {
            unknown.push(name);
          } else if (deferred.has(name)) {
            alreadyActive.push(name);
          } else {
            deferred.add(name);
            activated.push(name);
          }
        }
        const parts: string[] = [];
        if (activated.length > 0) parts.push(`Activated: ${activated.join(", ")}`);
        if (alreadyActive.length > 0) parts.push(`Already active: ${alreadyActive.join(", ")}`);
        if (unknown.length > 0)
          parts.push(`Unknown: ${unknown.join(", ")} — check available tools list`);
        parts.push("Tools will be available on your next step.");
        return { success: true, output: parts.join("\n") };
      },
    }),

    release_tools: tool({
      ...TEXT_OUTPUT,
      description: "Deactivate tools you no longer need to reduce context size.",
      inputSchema: z.object({
        tools: z
          .preprocess(coerceJsonArray, z.array(z.string()))
          .describe("Tool names to deactivate"),
      }),
      execute: async (args) => {
        const deferred = opts?.activeDeferredTools;
        if (!deferred) return { success: true, output: "On-demand tools not enabled" };
        const released: string[] = [];
        const notActive: string[] = [];
        const coreSet = new Set(CORE_TOOL_NAMES);
        for (const name of args.tools) {
          if (coreSet.has(name)) {
            notActive.push(`${name} (core — cannot release)`);
          } else if (deferred.has(name)) {
            deferred.delete(name);
            released.push(name);
          } else {
            notActive.push(name);
          }
        }
        const parts: string[] = [];
        if (released.length > 0) parts.push(`Released: ${released.join(", ")}`);
        if (notActive.length > 0) parts.push(`Not active: ${notActive.join(", ")}`);
        parts.push("Tools will be removed on your next step.");
        return { success: true, output: parts.join("\n") };
      },
    }),

    ...(opts?.codeExecution
      ? {
          code_execution: createAnthropic().tools.codeExecution_20260120(),
          // Including web_fetch makes code execution compute free (no per-hour charge)
          web_fetch: createAnthropic().tools.webFetch_20260209(),
        }
      : {}),

    ...(opts?.computerUse
      ? (() => {
          const ver = opts?.toolVersions?.computerUse ?? "20251124";
          const anthropic = createAnthropic();
          const computerOpts = {
            displayWidthPx: 1920,
            displayHeightPx: 1080,
            execute: async ({
              action,
              coordinate,
              text,
            }: {
              action: string;
              coordinate?: number[];
              text?: string;
            }) => {
              return `Computer use action: ${action}${coordinate ? ` at (${coordinate.join(",")})` : ""}${text ? ` text: ${text}` : ""}`;
            },
          };
          return {
            computer:
              ver === "20251124"
                ? anthropic.tools.computer_20251124(computerOpts)
                : anthropic.tools.computer_20250124(computerOpts),
          };
        })()
      : {}),

    ...(opts?.anthropicTextEditor
      ? (() => {
          const ver = opts?.toolVersions?.textEditor ?? "20250728";
          const anthropic = createAnthropic();
          const editorExecute = async ({
            command,
            path,
            old_str,
            new_str,
            insert_text,
            file_text,
            view_range,
          }: {
            command: string;
            path: string;
            old_str?: string;
            new_str?: string;
            insert_text?: string;
            file_text?: string;
            view_range?: number[];
          }) => {
            // Delegate to our own file operations
            const fs = await import("node:fs");
            const absPath = path.startsWith("/") ? path : resolve(effectiveCwd, path);
            switch (command) {
              case "view": {
                if (!fs.existsSync(absPath)) return `File not found: ${path}`;
                const content = fs.readFileSync(absPath, "utf-8");
                const lines = content.split("\n");
                if (view_range && view_range.length >= 2) {
                  const start = view_range[0] ?? 1;
                  const end = view_range[1] ?? lines.length;
                  return lines
                    .slice(start - 1, end)
                    .map((l, i) => `${start + i}\t${l}`)
                    .join("\n");
                }
                return lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
              }
              case "create": {
                fs.mkdirSync(resolve(absPath, ".."), { recursive: true });
                fs.writeFileSync(absPath, file_text ?? "", "utf-8");
                return `Created ${path}`;
              }
              case "str_replace": {
                if (!fs.existsSync(absPath)) return `File not found: ${path}`;
                const src = fs.readFileSync(absPath, "utf-8");
                if (!old_str || !src.includes(old_str)) return `old_str not found in ${path}`;
                fs.writeFileSync(absPath, src.replace(old_str, new_str ?? ""), "utf-8");
                return `Applied replacement in ${path}`;
              }
              case "insert": {
                if (!fs.existsSync(absPath)) return `File not found: ${path}`;
                const orig = fs.readFileSync(absPath, "utf-8");
                const origLines = orig.split("\n");
                const insertLine = view_range?.[0] ?? origLines.length;
                origLines.splice(insertLine, 0, insert_text ?? "");
                fs.writeFileSync(absPath, origLines.join("\n"), "utf-8");
                return `Inserted text at line ${insertLine} in ${path}`;
              }
              default:
                return `Unknown command: ${command}`;
            }
          };
          return {
            str_replace_based_edit_tool:
              ver === "20250728"
                ? anthropic.tools.textEditor_20250728({ execute: editorExecute })
                : anthropic.tools.textEditor_20250124({ execute: editorExecute }),
          };
        })()
      : {}),
  };

  // ── Hook wrapping ──────────────────────────────────────────────────
  // When PreToolUse/PostToolUse hooks are configured, wrap each tool's
  // execute to run hooks before/after. Zero overhead when no hooks exist.
  //
  // Uses Object.create + defineProperty to preserve the AI SDK tool
  // object's prototype chain and non-enumerable properties (frozen/sealed
  // objects, internal SDK metadata). Only the execute property is shadowed.
  if (hasToolHooks(effectiveCwd)) {
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const def = toolDef as {
        execute?: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
      };
      if (typeof def.execute !== "function") continue;
      const originalExecute = def.execute;
      // Shadow execute on a prototype-linked clone — all other properties
      // (description, inputSchema, providerOptions, toModelOutput) are
      // inherited from the original via the prototype chain.
      const proxy = Object.create(def) as typeof def;
      Object.defineProperty(proxy, "execute", {
        value: async (args: Record<string, unknown>, execContext?: unknown) => {
          // PreToolUse — lazily reads config so mid-session changes apply
          const preResult = await runHooks({
            event: "PreToolUse",
            toolName,
            toolInput: args,
            cwd: effectiveCwd,
          });
          if (preResult.blocked) {
            const reason = preResult.reason ?? "Blocked by hook";
            return { success: false, output: `[Hook blocked] ${reason}`, error: reason };
          }
          const effectiveInput = preResult.updatedInput
            ? { ...args, ...preResult.updatedInput }
            : args;
          let result: unknown;
          try {
            result = await originalExecute(effectiveInput, execContext);
          } catch (err) {
            // PostToolUseFailure — tool threw an exception
            runHooks({
              event: "PostToolUseFailure",
              toolName,
              toolInput: effectiveInput,
              cwd: effectiveCwd,
            }).catch(() => {});
            throw err;
          }
          // PostToolUse — fire-and-forget, never blocks the agent
          runHooks({
            event: "PostToolUse",
            toolName,
            toolInput: effectiveInput,
            toolResponse: result,
            cwd: effectiveCwd,
          }).catch(() => {});
          // Return new object with context appended — never mutate the original
          if (preResult.additionalContext && result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            return {
              ...r,
              output: `${String(r.output ?? "")}\n[Hook context: ${preResult.additionalContext}]`,
            };
          }
          return result;
        },
        writable: true,
        configurable: true,
        enumerable: true,
      });
      (tools as Record<string, unknown>)[toolName] = proxy;
    }
  }

  return tools;
}

/** Read-only tools for explore subagent */
export function buildReadOnlyTools(
  editorSettings?: EditorIntegration,
  onApproveWebSearch?: (query: string) => Promise<boolean>,
  opts?: {
    memoryManager?: MemoryManager;
    webSearchModel?: import("ai").LanguageModel;
    onApproveFetchPage?: (url: string) => Promise<boolean>;
  },
) {
  const all = buildTools(undefined, editorSettings, onApproveWebSearch, opts);
  return {
    read: all.read,
    grep: all.grep,
    glob: all.glob,
    web_search: all.web_search,
    fetch_page: all.fetch_page,
    editor: all.editor,
    navigate: all.navigate,
    analyze: all.analyze,
    discover_pattern: all.discover_pattern,
    memory: all.memory,
    ...(all.soul_grep ? { soul_grep: all.soul_grep } : {}),
    ...(all.soul_find ? { soul_find: all.soul_find } : {}),
    ...(all.soul_analyze ? { soul_analyze: all.soul_analyze } : {}),
    ...(all.soul_impact ? { soul_impact: all.soul_impact } : {}),
  };
}

/** Lean read-only tools for explore subagents — no editor, memory, git.
 *  When webSearchModel is provided, includes an agent-powered web_search tool. */
export function buildSubagentExploreTools(opts?: {
  webSearchModel?: import("ai").LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: IntelligenceClient;
  tabId?: string;
}) {
  const subagentCwd = process.cwd();
  return {
    read: tool({
      ...TEXT_OUTPUT,
      description: `${readFileTool.description} Output capped at 750 lines.`,
      inputSchema: SCHEMAS.readFile,
      execute: deferExecute(async (args) => {
        const specs = Array.isArray(args.files) ? args.files : [args.files];
        const outputs: string[] = [];
        const multiFile = specs.length > 1;
        for (const spec of specs) {
          if (multiFile) outputs.push(`── ${spec.path} ──`);
          if (spec.ranges && spec.ranges.length > 0) {
            for (const r of spec.ranges) {
              const result = await readFileTool.execute({
                path: spec.path,
                startLine: r.start,
                endLine: r.end,
                tabId: opts?.tabId,
              });
              outputs.push(result.success ? truncateLines(result.output) : result.output);
            }
          } else {
            const result = await readFileTool.execute({
              path: spec.path,
              ...(spec.target ? { target: spec.target, name: spec.name } : {}),
              tabId: opts?.tabId,
            });
            if (!result.success) {
              outputs.push(result.output);
              continue;
            }
            outputs.push(
              spec.target || (result as { outlineOnly?: boolean }).outlineOnly
                ? result.output
                : truncateLines(result.output),
            );
          }
        }
        return { success: true, output: outputs.join("\n\n") };
      }),
    }),

    grep: tool({
      ...TEXT_OUTPUT,
      description: grepTool.description,
      inputSchema: SCHEMAS.grep,
      execute: deferExecute(async (args) => {
        if (!args.force) {
          const hit = await tryInterceptGrep(args, opts?.repoMap, subagentCwd);
          if (hit) return hit;
        }
        const result = await grepTool.execute({ ...args, maxCount: 10 });
        if (!result.success) return result;
        return { ...result, output: truncateBytes(result.output) };
      }),
    }),

    glob: tool({
      ...TEXT_OUTPUT,
      description: globTool.description,
      inputSchema: SCHEMAS.glob,
      execute: deferExecute(async (args) => {
        if (!args.force) {
          const hit = await tryInterceptGlob(args, opts?.repoMap, subagentCwd);
          if (hit) return hit;
        }
        return globTool.execute(args);
      }),
    }),

    navigate: tool({
      ...TEXT_OUTPUT,
      description: navigateTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "definition",
            "references",
            "symbols",
            "imports",
            "exports",
            "workspace_symbols",
            "call_hierarchy",
            "implementation",
            "type_hierarchy",
            "search_symbols",
          ])
          .describe(
            "definition=returns file:line of definition, references=returns all file:line usages, " +
              "call_hierarchy=returns callers/callees with file:line, implementation=returns concrete implementors, " +
              "type_hierarchy=returns super/subtypes, symbols/imports/exports=returns file contents, " +
              "workspace_symbols/search_symbols=returns matching symbols across all files",
          ),
        symbol: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Symbol name to look up"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File path (auto-resolved from symbol if omitted)"),
        scope: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Filter symbols by name pattern"),
        query: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Search query for workspace_symbols/search_symbols"),
        force: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute(async (args) => {
        if (!args.force) {
          const hit = await tryInterceptNavigate(args, opts?.repoMap, subagentCwd);
          if (hit) return hit;
        }
        return navigateTool.execute(args, opts?.repoMap);
      }),
    }),

    analyze: tool({
      ...TEXT_OUTPUT,
      description: analyzeTool.description,
      inputSchema: z.object({
        action: z
          .enum(["diagnostics", "type_info", "outline", "code_actions", "unused", "symbol_diff"])
          .describe(
            "diagnostics=type errors/warnings, type_info=type signature+docs, " +
              "outline=compact symbol list, code_actions=quick fixes, symbol_diff=before/after exports",
          ),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File path to analyze"),
        symbol: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Symbol for type_info"),
        line: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Line number for type_info"),
        column: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Column number for type_info"),
        startLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Start line for code_actions range"),
        endLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("End line for code_actions range"),
        oldContent: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Old file content for symbol_diff (or uses git HEAD)"),
      }),
      execute: deferExecute((args) => analyzeTool.execute(args)),
    }),

    discover_pattern: tool({
      ...TEXT_OUTPUT,
      description: discoverPatternTool.description,
      inputSchema: z.object({
        query: z.string().describe("Concept to discover (e.g. 'provider', 'router', 'auth')"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File to scope the search to"),
        force: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Skip soul map fast-path. Only use after confirming the soul map result was incomplete or stale.",
          ),
      }),
      execute: deferExecute(async (args) => {
        if (!args.force) {
          const hit = await tryInterceptDiscoverPattern(args, opts?.repoMap, subagentCwd);
          if (hit) return hit;
        }
        return discoverPatternTool.execute(args);
      }),
    }),

    web_search: buildWebSearchTool({
      webSearchModel: opts?.webSearchModel,
      onApprove: opts?.onApproveWebSearch,
      onApproveFetchPage: opts?.onApproveFetchPage,
    }),

    fetch_page: tool({
      ...TEXT_OUTPUT,
      description: fetchPageTool.description,
      inputSchema: z.object({
        url: z.string().describe("URL to fetch and read"),
      }),
      execute: deferExecute(async (args) => {
        if (opts?.onApproveFetchPage) {
          let approved: boolean;
          try {
            approved = await opts.onApproveFetchPage(args.url);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              success: false,
              output: `Page fetch approval cancelled: ${msg}`,
              error: "Approval cancelled.",
            };
          }
          if (!approved) {
            return {
              success: false,
              output: "Page fetch was denied by the user.",
              error: "Fetch denied.",
            };
          }
        }
        return fetchPageTool.execute(args);
      }),
    }),

    // task_list omitted from subagents — session-scoped, subagents are ephemeral

    list_dir: tool({
      ...TEXT_OUTPUT,
      description: listDirTool.description,
      inputSchema: z.object({
        path: z
          .union([z.string(), z.array(z.string())])
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "Directory path or array of paths (defaults to cwd). Pass multiple paths to list several directories in one call.",
          ),
        depth: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Recursion depth (1=immediate children, max 5). Default 1."),
      }),
      execute: deferExecute((args) => listDirTool.execute(args, opts?.repoMap)),
    }),

    ...(!opts?.repoMap && !_soulToolWarningEmitted
      ? (() => {
          _soulToolWarningEmitted = true;
          logBackgroundError(
            "soulforge",
            "Soul tools (soul_grep, soul_find, soul_analyze, soul_impact) unavailable — repo map not ready",
          );
          return {};
        })()
      : {}),
    ...(opts?.repoMap
      ? {
          soul_grep: tool({
            ...TEXT_OUTPUT,
            description: soulGrepTool.description,
            inputSchema: SCHEMAS.soulGrep,
            execute: deferExecute((args) => {
              const exec = soulGrepTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
          soul_find: tool({
            ...TEXT_OUTPUT,
            description: soulFindTool.description,
            inputSchema: SCHEMAS.soulFind,
            execute: deferExecute((args) => {
              const exec = soulFindTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
          soul_analyze: tool({
            ...TEXT_OUTPUT,
            description: soulAnalyzeTool.description,
            inputSchema: z.object({
              action: z
                .enum([
                  "identifier_frequency",
                  "unused_exports",
                  "file_profile",
                  "duplication",
                  "top_files",
                  "packages",
                  "symbols_by_kind",
                  "call_graph",
                  "class_members",
                  "summaries",
                  "search_symbols",
                ])
                .describe(
                  "identifier_frequency=most referenced symbols, unused_exports=dead code report, " +
                    "file_profile=deps/dependents/blast/cochanges/symbols, duplication=clone detection, " +
                    "top_files=PageRank ranking, packages=external deps, symbols_by_kind=by type (function/class/etc), " +
                    "call_graph=callers/callees for a symbol, class_members=methods of a class, summaries=semantic summaries, " +
                    "search_symbols=FTS prefix search on symbol names (e.g. name='build*')",
                ),
              file: z
                .string()
                .nullable()
                .optional()
                .transform(nullToUndef)
                .describe("File path (for file_profile)"),
              name: z
                .string()
                .nullable()
                .optional()
                .transform(nullToUndef)
                .describe("Identifier/package name"),
              kind: z
                .string()
                .nullable()
                .optional()
                .transform(nullToUndef)
                .describe("Symbol kind (for symbols_by_kind)"),
              limit: z
                .number()
                .nullable()
                .optional()
                .transform(nullToUndef)
                .describe("Max results"),
            }),
            execute: deferExecute((args) => {
              const exec = soulAnalyzeTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
          soul_impact: tool({
            ...TEXT_OUTPUT,
            description: soulImpactTool.description,
            inputSchema: z.object({
              action: z
                .enum(["dependents", "dependencies", "cochanges", "blast_radius"])
                .describe(
                  "dependents=files importing this, dependencies=what this imports, " +
                    "cochanges=files edited together in git, blast_radius=total affected scope",
                ),
              file: z.string().describe("File path to analyze"),
              limit: z
                .number()
                .nullable()
                .optional()
                .transform(nullToUndef)
                .describe("Max results"),
            }),
            execute: deferExecute((args) => {
              const exec = soulImpactTool.createExecute(opts.repoMap);
              return exec(args).then((r) => ({ ...r, output: truncateBytes(r.output) }));
            }),
          }),
        }
      : {}),

    project: tool({
      ...TEXT_OUTPUT,
      description: `${projectTool.description} Read-only: test, build, lint, typecheck (no format/run).`,
      inputSchema: z.object({
        action: z.enum(["test", "build", "lint", "typecheck"]).describe("Read-only project action"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Target file or directory"),
        timeout: z.number().nullable().optional().transform(nullToUndef).describe("Timeout in ms"),
      }),
      execute: deferExecute((args) =>
        projectTool.execute(args as Parameters<typeof projectTool.execute>[0]),
      ),
    }),
  };
}

/** Minimal tools for ember explore agents — read-only intelligence tools only.
 *  Used when exploration model differs from parent (no cache sharing, minimize tool schema tokens).
 *  The forge pre-digests tasks with Soul Map data, so these agents do targeted reads + analysis. */
export function buildEmberExploreTools(opts?: { repoMap?: IntelligenceClient; tabId?: string }) {
  const all = buildSubagentExploreTools(opts);
  const { read, navigate, soul_grep, soul_find, soul_analyze, soul_impact } = all as Record<
    string,
    unknown
  >;
  return {
    ...(read ? { read } : {}),
    ...(navigate ? { navigate } : {}),
    ...(soul_grep ? { soul_grep } : {}),
    ...(soul_find ? { soul_find } : {}),
    ...(soul_analyze ? { soul_analyze } : {}),
    ...(soul_impact ? { soul_impact } : {}),
  };
}

/** Lean tools for code subagents — core read/edit tools only (no investigation tools) */
export function buildSubagentCodeTools(opts?: {
  webSearchModel?: import("ai").LanguageModel;
  onApproveWebSearch?: (query: string) => Promise<boolean>;
  onApproveFetchPage?: (url: string) => Promise<boolean>;
  repoMap?: IntelligenceClient;
  tabId?: string;
  tabLabel?: string;
}) {
  const explore = buildSubagentExploreTools(opts);
  // Code agents have exact targets — drop investigation/discovery tools they never use
  const {
    soul_analyze: _sa,
    soul_impact: _si,
    soul_find: _sf,
    analyze: _an,
    web_search: _ws,
    fetch_page: _fp,
    discover_pattern: _dp,
    task_list: _tl,
    list_dir: _ld,
    ...coreExploreTools
  } = explore as Record<string, unknown>;
  return {
    ...coreExploreTools,

    edit_file: tool({
      ...TEXT_OUTPUT,
      description: editFileTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        oldString: z.string().describe("Content to replace (empty = create new file)"),
        newString: z.string().describe("Replacement content"),
        lineStart: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe(
            "1-indexed start line from your last read output. " +
              "The range is derived from oldString line count — lineStart anchors where to look.",
          ),
      }),
      execute: deferExecute(async (args) => {
        const warning = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.path));
        const result = await editFileTool.execute({ ...args, tabId: opts?.tabId });
        if (!result.success && result.error === "old_string not found" && warning) {
          return {
            success: false,
            output: `CONTENTION: File ${args.path} was modified by another tab. Your edit is based on stale content. Inform the user this file is contested.`,
            error: "contested",
          };
        }
        return prependWarning(result, warning);
      }),
    }),

    multi_edit: tool({
      ...TEXT_OUTPUT,
      description: multiEditTool.description,
      inputSchema: z.object({
        path: z.string().describe("File path to edit"),
        edits: z
          .preprocess(
            coerceJsonArray,
            z.array(
              z.object({
                oldString: z.string().describe("Content to replace"),
                newString: z.string().describe("Replacement content"),
                lineStart: z
                  .preprocess(coerceInt, z.number())
                  .nullable()
                  .optional()
                  .transform(nullToUndef)
                  .describe(
                    "1-indexed start line from read output. Range derived from oldString line count.",
                  ),
              }),
            ),
          )
          .describe("Array of edits to apply atomically"),
      }),
      execute: deferExecute(async (args) => {
        const warning = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.path));
        const result = await multiEditTool.execute({ ...args, tabId: opts?.tabId });
        return prependWarning(result, warning);
      }),
    }),

    rename_symbol: tool({
      ...TEXT_OUTPUT,
      description: renameSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Current name of the symbol to rename"),
        newName: z.string().describe("New name for the symbol"),
        file: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("File where the symbol is defined (optional)"),
      }),
      execute: deferExecute(async (args) => {
        const warning = args.file
          ? checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.file))
          : null;
        const result = await renameSymbolTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success && args.file) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.file]);
        }
        return prependWarning(result, warning);
      }),
    }),

    move_symbol: tool({
      ...TEXT_OUTPUT,
      description: moveSymbolTool.description,
      inputSchema: z.object({
        symbol: z.string().describe("Name of the symbol to move"),
        from: z.string().describe("Source file path"),
        to: z.string().describe("Target file path"),
      }),
      execute: deferExecute(async (args) => {
        const fromWarn = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.from));
        const toWarn = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.to));
        const result = await moveSymbolTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.from, args.to]);
        }
        return prependWarning(prependWarning(result, toWarn), fromWarn);
      }),
    }),

    rename_file: tool({
      ...TEXT_OUTPUT,
      description: renameFileTool.description,
      inputSchema: z.object({
        from: z.string().describe("Current file path"),
        to: z.string().describe("New file path"),
      }),
      execute: deferExecute(async (args) => {
        const warning = checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.from));
        const result = await renameFileTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.from, args.to]);
        }
        return prependWarning(result, warning);
      }),
    }),

    refactor: tool({
      ...TEXT_OUTPUT,
      description: refactorTool.description,
      inputSchema: z.object({
        action: z
          .enum([
            "extract_function",
            "extract_variable",
            "format",
            "format_range",
            "organize_imports",
          ])
          .describe(
            "extract_function=lines→new function, extract_variable=expression→variable, " +
              "organize_imports=sort/dedupe, format=whole file, format_range=line range",
          ),
        file: z.string().nullable().optional().transform(nullToUndef).describe("Target file"),
        newName: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("New name for extracted symbol"),
        startLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Start line"),
        endLine: z
          .preprocess(coerceInt, z.number())
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("End line"),
        name: z
          .string()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Symbol name to extract"),
        apply: z
          .boolean()
          .nullable()
          .optional()
          .transform(nullToUndef)
          .describe("Apply changes to disk (default true)"),
      }),
      execute: deferExecute(async (args) => {
        const warning = args.file
          ? checkAndClaim(opts?.tabId, opts?.tabLabel, resolve(args.file))
          : null;
        const result = await refactorTool.execute({ ...args, tabId: opts?.tabId });
        if (result.success && args.file) {
          claimAfterCompoundEdit(opts?.tabId, opts?.tabLabel, [args.file]);
        }
        return prependWarning(result, warning);
      }),
    }),

    shell: tool({
      ...TEXT_OUTPUT,
      description: shellTool.description,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        cwd: z.string().nullable().optional().transform(nullToUndef).describe("Working directory"),
        timeout: z.number().nullable().optional().transform(nullToUndef).describe("Timeout in ms"),
      }),
      execute: async (args, { abortSignal }) => {
        await new Promise<void>((r) => setTimeout(r, 0));
        const result = await shellTool.execute(args, abortSignal);
        if (result.success && opts?.repoMap?.isReady) {
          opts.repoMap.recheckModifiedFiles();
        }
        if (result.success && opts?.tabId && opts?.tabLabel) {
          const written = extractWrittenFiles(args.command);
          if (written.length > 0) {
            claimAfterCompoundEdit(opts.tabId, opts.tabLabel, written);
          }
        }
        if (!result.success) return result;
        return { ...result, output: truncateBytes(result.output) };
      },
    }),
  };
}
