<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/SOULFORGE_LOGO.png" />
  <source media="(prefers-color-scheme: light)" srcset="assets/SOULFORGE_LOGO_LIGHT.png" />
  <img alt="SoulForge" src="assets/SOULFORGE_LOGO.png" width="560" />
</picture>

<p><strong>The AI coding agent that edits symbols, not strings.</strong></p>

<p>
  <a href="https://www.npmjs.com/package/@proxysoul/soulforge"><img alt="npm" src="https://img.shields.io/npm/v/@proxysoul/soulforge?label=npm&color=7844f0&style=flat-square" /></a>
  <a href="https://github.com/ProxySoul/soulforge/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/ProxySoul/soulforge/ci.yml?label=ci&style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BSL%201.1-blue.svg?style=flat-square" /></a>
  <a href="https://soulforge.proxysoul.com"><img alt="Docs" src="https://img.shields.io/badge/docs-soulforge.proxysoul.com-555.svg?style=flat-square" /></a>
</p>

</div>

## Install

```bash
brew tap proxysoul/tap && brew install soulforge
```

```bash
# alternatives
bun install -g @proxysoul/soulforge
# or download a prebuilt binary from https://github.com/ProxySoul/soulforge/releases/latest
```

macOS, Linux, and Windows 10 1809+ / Windows 11.

```powershell
# Windows
powershell -c "irm https://soulforge.dev/install.ps1 | iex"
```

Or grab `soulforge-setup-<version>-x64.exe` from the [latest release](https://github.com/proxysoul/soulforge/releases/latest). ARM64 not yet supported (tracked upstream).

## Quick start

```bash
soulforge --set-key anthropic sk-ant-...
cd your-project
soulforge
```

Other providers and OpenAI-compatible endpoints: [docs/providers](https://soulforge.proxysoul.com/providers).

## Benchmarks

Same model (Claude Opus 4.6), same codebase, same prompt.

**Bug fix**

| | SoulForge | OpenCode |
|---|---|---|
| Time | **6m 22s** | 11m 18s |
| Cost | **$1.70** | $3.52 |
| Result | Correct | Correct |

**Audit task** (*"verify cost reporting is wired correctly"*)

| | SoulForge | OpenCode |
|---|---|---|
| Time | **2m 00s** | 5m 56s |
| Cost | **$0.84** | $2.61 |
| Accuracy | **7/7 (100%)** | 4/7 (57%) |
| False alarms | **0** | 3 |
| Wrong claims | **0** | 1 |

> Same bug. Same model. Same repo. Half the time. Half the cost.

<sub>Sources: [recording 1](https://x.com/BniWael/status/2040172009666015641/video/1) · [recording 2](https://x.com/BniWael/status/2042364421373121018/video/1) · [recording 3](https://x.com/BniWael/status/2044826445382373759/video/1)</sub>

## Features

| Feature | What it does |
|---|---|
| **AST editing** | TS/JS edits via ts-morph, 65+ ops, atomic batches. [docs](https://soulforge.proxysoul.com/tools/ast-edit) |
| **Live Soul Map** | SQLite graph, PageRank + git co-change, blast-radius tags. [docs](https://soulforge.proxysoul.com/concepts/repo-map) |
| **LSP + Mason** | 576+ servers installable from the TUI |
| **33 languages** | symbol-level reads, not file dumps |
| **Compound tools** | `rename_symbol`, `move_symbol`, `refactor`, `project` (23 toolchains) |
| **Task router** | route each slot (spark / ember / compact / verify / web / semantic) to a different model per tab. Haiku for exploration, Sonnet for code, Flash for compaction. `/router`. [docs](https://soulforge.proxysoul.com/recipes/task-router) |
| **V2 compaction** | usually 0 LLM tokens. [docs](https://soulforge.proxysoul.com/context/compaction) |
| **Parallel agents** | Spark + Ember with shared I/O cache |
| **Embedded Neovim** | real nvim in a PTY, your config |
| **5 tabs** | per-tab model, session, checkpoints, file claims |
| **Time machine** | every prompt is a checkpoint with a git tag. `Ctrl+B` / `Ctrl+F` rewinds and redoes both conversation and files on disk. `/checkpoint undo <N>`, `/checkpoint save`, per-tab |
| **Sessions** | auto-saved JSONL, crash-resilient, resumable by short-id prefix. Export to markdown / JSON / clipboard. `Ctrl+P` browser, multi-tab. [docs](https://soulforge.proxysoul.com/tools/sessions) |
| **Memory** | cross-session SQLite store of prefs, decisions, gotchas, context. Auto-recalled per turn from prompt + edited files. Project + global scopes, browser at `/memory`. [docs](https://soulforge.proxysoul.com/tools/memory) |
| **21 providers** | Anthropic, OpenAI, Google, Groq, DeepSeek, Bedrock, Ollama, LM Studio, ... + any OpenAI-compatible |
| **Cost tracking** | per-model + per-subagent USD, cache-aware |
| **MCP + hooks** | any MCP server, 13 events, drop-in `.claude/settings.json` |
| **Headless mode** | run from CI, scripts, pipelines. JSON / event stream, resumable sessions. [docs](https://soulforge.proxysoul.com/recipes/headless) |
| **Hearth** *(exp)* | remote control via Telegram or Discord, your host only |
| **36 themes** | hot-reloaded JSON, Kitty inline images |

## License

[BSL 1.1](LICENSE). Free for personal and internal use. Commercial use: [commercial license](COMMERCIAL_LICENSE.md). Converts to Apache 2.0 on March 15, 2030.

## Sponsors

<div align="center">

<sub><b>Backed by</b></sub>

<a href="https://llmgateway.io/dashboard?ref=6tjJR2H3X4E9RmVQiQwK" title="LLM Gateway">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/llmg-white.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/llmg-dark.svg" />
    <img alt="LLM Gateway" src="assets/llmg-dark.svg" height="56" />
  </picture>
</a>

<p><sub><i>One API, 200+ models, up to 30% off frontier. Wired into SoulForge as the <code>llmgateway</code> provider.</i></sub></p>

<a href="https://llmgateway.io/dashboard?ref=6tjJR2H3X4E9RmVQiQwK"><img src="https://img.shields.io/badge/Get_an_LLM_Gateway_key-7C3AED.svg?style=for-the-badge&labelColor=0a0818" alt="Get an LLM Gateway key" /></a>

<br/>

<sub><a href="https://github.com/sponsors/proxysoul">Sponsor on GitHub</a> (monthly or one-time) · <a href="https://paypal.me/waeru">PayPal</a> (one-time) · <a href="BACKERS.md">All backers</a></sub>

</div>

