import { logBackgroundError } from "../../stores/errors.js";
import { CORE_RULES } from "../prompts/families/shared-rules.js";
import { projectTool } from "../tools/project.js";
import type { AgentBus, AgentTask } from "./agent-bus.js";
import { runAgentTask } from "./agent-runner.js";
import type { SubagentModels } from "./subagent-tools.js";

// ── De-sloppify ─────────────────────────────────────────────────────────
// Step 1: deterministic lint --fix (zero tokens)
// Step 2: LLM reviews for slop patterns the linter can't catch

const DESLOPPIFY_PROMPT = `${CORE_RULES}

ROLE: cleanup agent. Lint --fix already ran. Review for slop the linter missed. Report under 200 words — list files changed and what was removed. If clean, report done immediately without reading.

REMOVE:
- Tests that verify language/framework behavior rather than business logic.
- Redundant type assertions the type system already enforces.
- Over-defensive error handling for impossible states.
- console.log/debug/print statements not part of the feature.
- Dead code: unused vars, unreachable branches, empty catch blocks.

KEEP:
- TODO/FIXME/SECTION/placeholder comments.
- Business logic, meaningful error handling, type annotations.
- Comments explaining non-obvious decisions.

WORKFLOW: read files with ranges around edited sections → multi_edit → done.`;

export async function runDesloppify(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (models.agentFeatures?.desloppify !== true) return null;
  if (tasks.filter((t) => t.role === "code").length === 0) return null;
  if (!models.desloppifyModel) return null;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;
  const editedPaths = [...editedFiles.keys()];

  // Step 1: deterministic lint --fix (zero tokens, instant)
  let lintResult = "";
  try {
    const lint = await projectTool.execute({ action: "lint", fix: true, timeout: 30_000 });
    if (!lint.success && lint.output) {
      const relevant = lint.output
        .split("\n")
        .filter((l: string) => editedPaths.some((p) => l.includes(p)));
      if (relevant.length > 0) lintResult = `\nLint issues after fix:\n${relevant.join("\n")}`;
    }
  } catch {}

  // Invalidate bus cache — code agents wrote new content
  for (const p of editedPaths) {
    bus.invalidateFile(p, "desloppify");
  }

  // Step 2: LLM cleanup via runAgentTask (same flow as any code agent)
  const desloppifyTask: AgentTask = {
    agentId: "desloppify",
    role: "code",
    tier: "ember",
    task: `${DESLOPPIFY_PROMPT}${lintResult}\n\nFiles to review:\n${editedPaths.map((p) => `- ${p}`).join("\n")}`,
    targetFiles: editedPaths,
  };
  bus.registerTasks([desloppifyTask]);

  try {
    const { resultText } = await runAgentTask(
      desloppifyTask,
      { ...models, emberModel: models.desloppifyModel, parentMessagesRef: undefined },
      bus,
      parentToolCallId,
      tasks.length + 1,
      abortSignal,
    );
    return resultText.length > 20 ? `\n\n### De-sloppify pass\n${resultText}` : null;
  } catch (err) {
    logBackgroundError("desloppify", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Verifier ────────────────────────────────────────────────────────────
// Step 1: deterministic typecheck + test (zero tokens)
// Step 2: LLM checks logic correctness against the original task

const VERIFY_PROMPT = `${CORE_RULES}

ROLE: verification agent. Fresh eyes — you did NOT write this code. Read edited files with ranges around changed sections, not full files.

PROCESS:
1. Check typecheck/test results below — errors are automatic FAIL.
2. Read each edited file (ranges around changes) and verify:
   - Does the implementation match what the task asked for?
   - Missing edge cases? Incorrect imports? Signature mismatches?
3. If exports changed signatures, \`navigate(references)\` on one caller.

SKIP: formatting/style (de-sloppify handles it), typecheck/tests (results below).

OUTPUT — end with exactly one of:
  VERDICT: PASS — [one-line summary]
  VERDICT: FAIL — [file:line, what's wrong]
  VERDICT: PARTIAL — [what couldn't be verified]`;

export async function runVerifier(
  bus: AgentBus,
  tasks: AgentTask[],
  models: SubagentModels,
  parentToolCallId: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (models.agentFeatures?.verifyEdits !== true) return null;
  if (tasks.filter((t) => t.role === "code").length === 0) return null;

  const editedFiles = bus.getEditedFiles();
  if (editedFiles.size === 0) return null;
  const editedPaths = [...editedFiles.keys()];

  // Step 1: deterministic typecheck + test (zero tokens)
  const checkResults: string[] = [];
  try {
    const tc = await projectTool.execute({ action: "typecheck", timeout: 30_000 });
    if (!tc.success && tc.output) {
      const relevant = tc.output
        .split("\n")
        .filter((l: string) => editedPaths.some((p) => l.includes(p)));
      checkResults.push(
        relevant.length > 0
          ? `TYPECHECK FAILED:\n${relevant.join("\n")}`
          : "Typecheck: passed (no errors in edited files)",
      );
    } else {
      checkResults.push("Typecheck: passed");
    }
  } catch {
    checkResults.push("Typecheck: unavailable");
  }
  try {
    const test = await projectTool.execute({ action: "test", timeout: 60_000 });
    if (!test.success && test.output) {
      checkResults.push(`TESTS FAILED:\n${test.output.slice(-500)}`);
    } else if (test.success) {
      checkResults.push("Tests: passed");
    }
  } catch {
    checkResults.push("Tests: unavailable");
  }

  // Step 2: LLM verification via runAgentTask
  const taskContext = tasks
    .map((t) => {
      const r = bus.getResult(t.agentId);
      return r?.result ? `[${t.agentId}] task: ${t.task.split("\n")[0]?.slice(0, 200)}` : null;
    })
    .filter(Boolean)
    .join("\n");

  const verifyPrompt = [
    VERIFY_PROMPT,
    "",
    "--- Automated check results ---",
    checkResults.join("\n"),
    "",
    "--- Files edited ---",
    editedPaths.map((p) => `- ${p}`).join("\n"),
    "",
    "--- What was requested ---",
    taskContext,
  ].join("\n");

  const reviewModel = models.verifyModel ?? models.defaultModel;
  const verifyTask: AgentTask = {
    agentId: "verifier",
    role: "explore",
    task: verifyPrompt,
    targetFiles: editedPaths,
  };
  bus.registerTasks([verifyTask]);

  try {
    // Verifier must NOT inherit parentMessagesRef — doppelganger mode would
    // replay the parent forge's full chat history as the prefix, which Anthropic
    // cannot cache (different breakpoint position vs the parent's last call).
    // Without parentMessagesRef, verifier runs as a regular spark: same forge
    // instructions + tools as parent → prefix cache hits the parent's prior prefix.
    const { resultText } = await runAgentTask(
      verifyTask,
      { ...models, sparkModel: reviewModel, parentMessagesRef: undefined },
      bus,
      parentToolCallId,
      tasks.length + 1,
      abortSignal,
    );
    return `\n\n### Verification\n${resultText}`;
  } catch (err) {
    logBackgroundError("verifier", err instanceof Error ? err.message : String(err));
    return null;
  }
}
