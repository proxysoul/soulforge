import { getAllProviders } from "../core/llm/providers/index.js";
import type { ForgeMode } from "../types/index.js";
import { BOLD, EXIT_ERROR, EXIT_OK, RED, RST, VALID_MODES } from "./constants.js";
import type { HeadlessAction } from "./types.js";

const USAGE = `${BOLD}SoulForge${RST} — Graph-Powered Code Intelligence (headless mode)

${BOLD}Usage:${RST}
  soulforge --headless <prompt>                          Run a prompt
  soulforge --headless --json <prompt>                   JSON output
  soulforge --headless --events <prompt>                 JSONL event stream
  soulforge --headless --model <provider/model> <prompt> Override model
  soulforge --headless --mode <mode> <prompt>            Set mode (default/architect/plan/auto)
  soulforge --headless --max-steps <n> <prompt>          Limit agent steps
  soulforge --headless --timeout <ms> <prompt>           Abort after timeout
  soulforge --headless --quiet <prompt>                  Suppress header/footer
  soulforge --headless --cwd <dir> <prompt>              Set working directory
  soulforge --headless --system "instructions" <prompt>  Inject system prompt
  soulforge --headless --include <file> <prompt>         Pre-load file into context
  soulforge --headless --no-repomap <prompt>             Skip repo map scan
  soulforge --headless --diff <prompt>                   Show files changed after run
  soulforge --headless --session <id> <prompt>           Resume a previous session
  soulforge --headless --save-session <prompt>           Save session after completion
  soulforge --headless --chat                            Interactive multi-turn chat
  echo "prompt" | soulforge --headless                   Pipe from stdin

${BOLD}Management:${RST}
  soulforge --list-providers                             Show providers + status
  soulforge --list-models [provider]                     Show available models
  soulforge --set-key <provider> <key>                   Save an API key
  soulforge --version                                    Show version

${BOLD}Addons${RST} (opt-in: proxy gateway, bundled Neovim):
  soulforge addon list                                   Show addon state
  soulforge addon install <proxy|neovim>                 Download + activate
  soulforge addon remove <proxy|neovim>                  Uninstall
  soulforge addon update <proxy|neovim>                  Reinstall latest
  soulforge addon --help                                 Addon-specific help

${BOLD}Exit codes:${RST} 0=success, 1=error, 2=timeout, 130=abort
`;

export async function parseHeadlessArgs(argv: string[]): Promise<HeadlessAction | null> {
  if (argv.includes("--version") || argv.includes("-v")) return { type: "version" };
  if (argv.includes("--list-providers")) return { type: "list-providers" };

  if (argv.includes("--list-models")) {
    const idx = argv.indexOf("--list-models");
    const next = argv[idx + 1];
    const provider = next && !next.startsWith("--") ? next : undefined;
    return { type: "list-models", provider };
  }

  if (argv.includes("--set-key")) {
    const idx = argv.indexOf("--set-key");
    const provider = argv[idx + 1];
    const key = argv[idx + 2];
    if (!provider || !key) {
      process.stderr.write(`${RED()}Error:${RST} --set-key requires <provider> <key>\n`);
      process.stderr.write(
        `Providers: ${getAllProviders()
          .map((p) => p.id)
          .join(", ")}\n`,
      );
      process.exit(EXIT_ERROR);
    }
    return { type: "set-key", provider, key };
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(USAGE);
    process.exit(EXIT_OK);
  }

  if (!argv.includes("--headless")) return null;

  let modelId: string | undefined;
  let mode: ForgeMode | undefined;
  let json = false;
  let events = false;
  let quiet = false;
  let chat = false;
  let maxSteps: number | undefined;
  let timeout: number | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let saveSession = false;
  let system: string | undefined;
  let noRepomap = false;
  let diff = false;
  let render = process.stdout.isTTY ?? false;
  const include: string[] = [];
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headless") continue;
    if (arg === "--model" && argv[i + 1]) {
      modelId = argv[++i];
    } else if (arg?.startsWith("--model=")) {
      modelId = arg.slice("--model=".length);
    } else if (arg === "--mode" && argv[i + 1]) {
      const m = argv[++i] as ForgeMode;
      if (!VALID_MODES.includes(m)) {
        process.stderr.write(`${RED()}Error:${RST} Unknown mode "${m}"\n`);
        process.stderr.write(`Valid: ${VALID_MODES.join(", ")}\n`);
        process.exit(EXIT_ERROR);
      }
      mode = m;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--events") {
      events = true;
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg === "--max-steps" && argv[i + 1]) {
      maxSteps = Number.parseInt(argv[++i] ?? "0", 10);
    } else if (arg === "--timeout" && argv[i + 1]) {
      timeout = Number.parseInt(argv[++i] ?? "0", 10);
    } else if (arg === "--cwd" && argv[i + 1]) {
      cwd = argv[++i];
    } else if ((arg === "--session" || arg === "--resume" || arg === "-s") && argv[i + 1]) {
      sessionId = argv[++i];
    } else if (arg?.startsWith("--session=")) {
      sessionId = arg.slice("--session=".length);
    } else if (arg?.startsWith("--resume=")) {
      sessionId = arg.slice("--resume=".length);
    } else if (arg === "--save-session") {
      saveSession = true;
    } else if (arg === "--system" && argv[i + 1]) {
      system = argv[++i];
    } else if (arg === "--no-repomap") {
      noRepomap = true;
    } else if (arg === "--include" && argv[i + 1]) {
      include.push(argv[++i] as string);
    } else if (arg === "--diff") {
      diff = true;
    } else if (arg === "--render") {
      render = true;
    } else if (arg === "--no-render") {
      render = false;
    } else if (arg === "--chat") {
      chat = true;
    } else if (arg && !arg.startsWith("--")) {
      promptParts.push(arg);
    }
  }

  if (chat) {
    return {
      type: "chat",
      opts: {
        modelId,
        mode,
        json,
        events,
        quiet,
        maxSteps,
        timeout,
        cwd,
        sessionId,
        system,
        noRepomap,
      },
    };
  }

  let prompt = promptParts.join(" ");

  if (!prompt && !process.stdin.isTTY) {
    prompt = await Bun.stdin.text();
    prompt = prompt.trim();
  }

  if (!prompt) {
    process.stderr.write(USAGE);
    process.exit(EXIT_ERROR);
  }

  return {
    type: "run",
    opts: {
      prompt,
      modelId,
      mode,
      json,
      events,
      quiet,
      maxSteps,
      timeout,
      cwd,
      sessionId,
      saveSession,
      system,
      noRepomap,
      include: include.length > 0 ? include : undefined,
      diff,
      render,
    },
  };
}
