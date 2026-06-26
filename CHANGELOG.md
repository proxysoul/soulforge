# Changelog

All notable changes to SoulForge are documented here.

## [2.20.20] — 2026-06-26

### Bug Fixes

- **fuzzy**: rank prefix matches above scattered subsequence matches
- **provider-settings**: clamp info/section rows to one line so options stay visible
- **ui**: improve fuzzy matching in command picker and setup wizard
### Features

- **providers**: add dedicated LLM Gateway options tab
- **proxy**: recover Claude tool calls leaked as text over the proxy
## [2.20.19] — 2026-06-23

### Bug Fixes

- **command-picker**: marquee-scroll long option descriptions instead of cutting
- **lsp**: support .luau files — map to lua and register luau-lsp server
## [2.20.18] — 2026-06-23

### Bug Fixes

- **tui**: redundant terminal resize detection for dropped-SIGWINCH transports (#112)
- **wizard**: scroll provider list to fit terminal, truncate rows to one line
## [2.20.17] — 2026-06-23

### Bug Fixes

- **build**: gate jsx parser plugin to .tsx in build.ts inline react-compiler
## [2.20.16] — 2026-06-23

### Bug Fixes

- **build**: parse .ts without jsx plugin to fix babel 8 generic-arrow crash
- **models**: defer provider fetch to avoid Windows native segfault
### Features

- **memory**: surface active embedder, expand docs
## [2.20.15] — 2026-06-12

### Bug Fixes

- **tui**: suppress biome control-char lint on mode 2048 resize regex
- **tui**: poll terminal size to catch resizes when SIGWINCH is dropped
### Features

- **tui**: in-band resize notifications (mode 2048) with watchdog fallback
## [2.20.14] — 2026-06-12

### Bug Fixes

- **clipboard**: 100% copy/paste coverage across platforms, terminals, SSH and WSL
- **opencode-go**: drop unsupported qwen3.7-max from fallback models
- **statusbar**: replace vmmap with /usr/bin/footprint for macOS memory sampling
## [2.20.13] — 2026-06-11

### Bug Fixes

- **build**: resolve @opentui/core 0.4.x platform imports in compile phase
### Miscellaneous

- compile gate on every push + PR to catch dep-bump build breaks
## [2.20.12] — 2026-06-11

### Features

- **llm**: send per-chat session id to providers for sticky routing
- **minimax**: add MiniMax M3 model
## [2.20.11] — 2026-06-09

## [2.20.10] — 2026-06-09

### Bug Fixes

- **statusbar**: stop vmmap freezing the TUI every 2s on macOS
### Features

- Claude 5-gen model support + reliable proxy login detection
### Miscellaneous

- sync provider pricing to June 2026
## [2.20.9] — 2026-06-09

### Bug Fixes

- **chat**: stop selection clearing on release + duplicate streaming lines
### Documentation

- **prompts**: frame Soul Map as ranked index, not ground truth
### Features

- **telemetry**: add mode, terminal, runtime, repomap fields
- **telemetry**: report all public models via shape gate
### Testing

- **prompts**: match navigate() assertion in soul map usage text
## [2.20.8] — 2026-06-08

### Bug Fixes

- **proxy**: sync /proxy login providers with CLIProxyAPI v7
## [2.20.7] — 2026-06-08

### Bug Fixes

- **clipboard**: repair text copy across platforms and terminals
- **clipboard**: fix image paste on Windows (#89)
## [2.20.6] — 2026-06-04

### Bug Fixes

- **chat**: stop leading text re-streaming over tool rail
- **chat**: render reasoning in live streaming view
- **clipboard**: repair Windows image paste
- **llm**: skip inline-reasoning extractor for native-reasoning models
- **repomap**: clear stuck "waiting for soul map" semantic stub
## [2.20.5] — 2026-06-04

### Bug Fixes

- **chat**: snappier streaming + no bare assistant header
### Features

- **llm**: extract inline reasoning tags into reasoning parts
## [2.20.4] — 2026-06-04

### Bug Fixes

- **memory**: bump last_used_at on every recall/get/search
- **providers**: trim opencode zen/go to live-API-driven model lists
## [2.20.3] — 2026-06-03

### Bug Fixes

- **clipboard**: always emit OSC-52 and native copy
## [2.20.2] — 2026-06-03

### Features

- **llm**: per-model reasoning effort with real enums
- **telemetry**: anonymous usage beacon
## [2.20.1] — 2026-06-03

### Bug Fixes

- **llm**: pass reasoning effort through llmgateway for non-Claude models
## [2.20.0] — 2026-06-02

### Bug Fixes

- **hearth**: wire remote callbacks into Discord surface
- **hearth**: cancel pending remote callbacks on abort/close
- **hearth**: route ask_user/plan-review/approvals through the bridge
- **post-edit-fix**: use 1-indexed lines for format edit offsets
- **search**: guard rg pattern with -- separator
- **tabs**: persist tab close immediately so it survives restart
### Documentation

- **soul-map**: unify terminology — Soul Map (artifact) vs repo-map engine
### Features

- **cwd**: wire --cwd through one global holder
- **headless**: wire full agent capabilities into setupAgent
### Miscellaneous

- **deps**: upgrade @opentui to 0.3.1
- **hearth**: sort imports in tab-loop
- **lint**: use optional chaining for nullable guards
## [2.19.0] — 2026-05-31

### Bug Fixes

- **forge**: mode inject latches on mode name + frozen turn-mode
- **llm**: set correct app identity headers for OpenRouter and LLM Gateway
- **soulmap**: trigram search falls back to full scan on un-populated index
### Documentation

- **soulmap**: teach agents when/why to use soul_query
### Features

- **forge**: inject mode as cache-stable message, not cached prefix
- **forge**: mode-gate tools at execution, keep schema cache-stable
- **soulmap**: stable symbol monikers + polyglot structural_edit tool
- **soulmap**: trigram search, gitignore, soul_query pipeline, hash CAS, scan gating
- **structural-edit**: vendor ast-grep so it's always available in prod
### Testing

- **forge**: cover mode tool gating — cache-stable schema + execution deny
## [2.18.6] — 2026-05-30

### Bug Fixes

- **providers**: pin gpt-5.5 context to 272k for codex/proxy
- **stream**: match orphan tool-results against all prior assistants
- **stream**: drop orphaned tool-result blocks from provider-executed tool-calls
- **useChat,dispatch**: inline stall-retry backoff + return DispatchOutput on single-agent failure
- incremental context compression — correct token tracking, add ea… (#78)
### Miscellaneous

- **context**: drop redundant `= undefined` init on lastInstructionsSize
- **useChat**: rewrite stale stall-retry comment after inline-backoff rewrite
## [2.18.5] — 2026-05-30

### Bug Fixes

- **chat**: restore single rail + gated narration in live auto view
- **chat**: stable segment-positional render for live auto view
- **config**: exit with clear error on invalid config.json instead of silently using defaults
- **llm**: Opus 4.8 support — adaptive-only thinking, correct headers, pricing verified
### Documentation

- **sponsors**: add @nerminba to backers
### Features

- **providers**: add NVIDIA NIM provider
## [2.18.4] — 2026-05-27

### Bug Fixes

- **launcher**: detach child process group to preserve exit banner
- **presets**: apply overlay against seeded defaults, validate via zod
### Features

- **providers**: expand context-length field mapping for custom providers
- **providers**: auto-discover models for custom OpenAI-compatible providers
## [2.18.3] — 2026-05-27

### Bug Fixes

- skip neovim-not-found system banner
## [2.18.2] — 2026-05-27

### Bug Fixes

- **shell**: JS-enforced timeout + killTree to prevent infinite hangs
- **tools**: timeout tee + io-worker calls; drop stale tests
- harden workers, tools, and abort path
## [2.18.1] — 2026-05-27

### Bug Fixes

- **brew**: widen gzip glob to deps/**/*.{node,dylib,so}
- **build**: externalize native + asset deps from main dist bundle
- **bundle**: externalize native + asset deps from worker bundles
## [2.18.0] — 2026-05-27

### Bug Fixes

- **addons**: surface install/uninstall flows + clean Windows user data
- **addons**: accept --list/-l/--help/-h flags + clearer unknown-verb error
- **addons**: accept --addon flag form + surface addon help in top-level usage
- **addons**: honour system PATH binaries, guard reinstall, wipe stale state
- **agents**: drop orphan provider-executed tool blocks before replay
- **brew**: clean ~/.soulforge on uninstall + version-stamp upgrade
- **bundle**: use --outdir for worker builds (Bun multi-chunk output)
- **ci**: bump @opentui/core-win32-x64 pin to 0.2.15
- **deps**: bump @opentui/core native dylibs to 0.2.15
- **llm**: hide addon-gated providers from Ctrl+L when addon missing
- **setup**: split addon wizard into sequential yes/no prompts
- **soul_vision**: stabilize Kitty image rendering across rail transitions
- **soul_vision**: render image inline in streaming tool rail
- **soul_vision**: open image by default, ctrl+o collapses
- **ui**: correct Ctrl+B/F label — browse checkpoints, not undo/redo
### Documentation

- escape literal $ in prose so Mintlify stops eating it as math
- sweep windows install — fix bogus URLs, fold into installation
- sweep mintlify docs against code, add addons + presets pages
- add Discord community link
### Features

- **addons**: gate UI surfaces on addon presence (headless, footer, help)
- **addons**: hide proxy/neovim commands and editor tool when addon missing
- **addons**: first-run wizard prompts for proxy + neovim via clack
- **addons**: make proxy + neovim opt-in via `soulforge addon install`
- **release**: add pre-flight lint/typecheck/test gate
- **windows**: native Windows x64 support (#74)
### Miscellaneous

- **LockInStreamView**: sort imports
- **build**: harden compile pipeline (opencode-inspired)
- **scripts**: drop fake soulforge.dev URLs from installer comments
- **tests**: drop stale LockInStreamView terminology in dispatch test
### Performance

- **input**: unblock submit path for large pasted text
### Refactor

- **modals**: use shared SPINNER_FRAMES in Diagnose/UpdateModal
- **tool**: rename set_lockin → final_response + fix boundary race
- minor cleanups
## [2.17.0] — 2026-05-22

### Bug Fixes

- **exit**: print banner on Ctrl+C in installed binary
- **router**: full provider/model id + dedicated Tools section
- **sessions**: UI must be superset of model view — guard against messages.jsonl truncation
- **sessions**: stop restore loop, cap tabs, preserve progress
### Documentation

- **prompt**: enforce strict lockin ordering before final answer
- **prompt**: document soul_map_update delta channel
### Features

- **context**: session header only when foreign or post-compaction
- **context**: entry points in snapshot + session header in delta
- **context**: surface memory category next to delta files
- **context**: delta provenance — modified-since-new + recent failures
- **context**: freeze per-tab soul-map snapshot with explicit refresh boundary
- **repo-map**: expand entry points to PHP, Zig, Haskell, Scala, C#, Elm
- **repo-map**: rank delta file symbols by inbound call count
- **tools**: expose web_search + fetch_page to ember explore agents
### Miscellaneous

- **useChat**: formatter touch-ups on dependency arrays
### Performance

- **repo-map**: warm-start PageRank with prior vector + L1 early-stop
- **sqlite**: index edges by target + PRAGMA optimize on close
### Refactor

- **context**: provider-aware soul-map snapshot with idle TTL
- **repo-map**: index bare filenames + dotfiles via detectLanguageFromPath
- **repo-map**: consolidate language detection, skip non-code from pagerank
## [2.16.5] — 2026-05-21

### Bug Fixes

- **assets**: widen llmg svg viewBox to prevent text clipping
- **context**: drive pending semantic mode through onScanComplete
- **memory**: per-tab hint state — tabs no longer silence each other
- **presets**: skip malformed specs at boot instead of failing each load
- **sessions**: single app-level session id + per-tab slice writes
- **sessions**: serialize saves per session to prevent restore corruption
- **ui**: keep thinking spinner up until final text streams
### Documentation

- **sponsors**: clarify GitHub Sponsors supports one-time, fix dark-mode logo, reorder nav
- **sponsors**: self-host LLM Gateway logo + add mintlify sponsors page
### Features

- **memory**: hint surface telemetry — schema v2→v3, non-breaking
- **memory**: per-subagent hint scope via AsyncLocalStorage
- **memory**: strip hint footers on compaction + teach agent the new shape
- **memory**: actionable inline hints — category, imperatives, dedup, gates
- **repo-map**: scale type-edge weight in PageRank propagation
- **repo-map**: demote type-only and barrel files in ranking
### Miscellaneous

- **biome**: add github + json reporters with artifact upload
### Performance

- **repo-map**: cache cochanges by HEAD sha and persist rendered map
### Refactor

- **memory**: loud/quiet hint shape — prefs are loudest, pinned/pref bypass cooldown
- **memory**: relax hint gate — surface relevant decisions, not just gotcha/pinned
## [2.16.4] — 2026-05-21

### Features

- **memory**: rich hint tails with per-turn dedup
- **theme**: default to proxysoul-coffee
### Miscellaneous

- **theme**: sort imports in store
### Refactor

- **forge**: group set_lockin with flow-control tools
## [2.16.3] — 2026-05-20

### Bug Fixes

- **chat**: preserve chronological order in tools rail
- **chat**: drop inline <think> parser — reasoning only from native stream parts
- **compaction**: allow user-configured per-model context window override
- **memory**: annotate buildMemoryIndex locals with MemoryIndex type
- **memory**: survive concurrent sf SQLite I/O errors
### Documentation

- **changelog**: add sponsors shoutout to 2.16.2
- **prompts**: rewrite commit-boundary rule to clarify set_lockin timing
### Features

- **presets**: load shareable config bundles by name, URL, or path
### Miscellaneous

- update readme
- update readme
- update readme
- update readme
### Refactor

- **prompts**: positive framing + naturalize memory
- **prompts**: per-family tuning + tighter answer voice
## [2.16.2] — 2026-05-20

### 💜 Sponsors

A huge thank you to our first backer:

- **[LLM Gateway](https://llmgateway.io/dashboard?ref=6tjJR2H3X4E9RmVQiQwK)** ([@theopenco](https://github.com/theopenco)) — one API for OpenAI, Anthropic, Google, and 30+ providers. Up to 30% off frontier models, real-time analytics, BYOK. Now wired into SoulForge as the `llmgateway` provider. Thanks for keeping the forge lit. 🔥

Want to back SoulForge? → [github.com/sponsors/proxysoul](https://github.com/sponsors/proxysoul)

### Bug Fixes

- **lockin**: invalidate commit when tools land after set_lockin
- **read-highlight**: render unknown-lang files plain in multi-file reads
### Documentation

- **sponsors**: add BACKERS.md + README sponsor wall with LLM Gateway
## [2.16.1] — 2026-05-20

### Features

- configurable Anthropic cache TTL + fix lockin nudge tracking
### Performance

- reseed soul-map diff state after 5min idle on Anthropic cache
## [2.16.0] — 2026-05-20

### Bug Fixes

- **chat**: surface premature stop when agent ends without final message
- **commands**: sync forgeMode when toggling plan via /plan
- **dialogs**: gate DialogSelect when another dialog is layered above
- **dialogs**: gate host pickers when a dialog is on the stack
- **dialogs**: swallow keyboard events on dialog primitives
- **input**: move stash bindings to alt+s/alt+p to avoid skills/sessions collision
- **modals**: swallow keyboard events so popup scroll doesn't bleed to chat
- **prompts**: tell agent shell runs in cwd
- **settings**: stop keyboard propagation across settings + plan popups
### Documentation

- **installation**: add OpenRouter key tab
- **providers**: drop literal anchor syntax from headings
- **providers**: add LLM Gateway and OpenRouter anchors
### Features

- **chat**: click tool row to expand full result inline
- **chat**: click reasoning fold and tool rows to expand/collapse
- **chat**: tips catalog for input placeholder rotator
- **commands**: gate /clear and /storage cleanups behind confirm()
- **commands**: suggested + aliases metadata on CommandDef
- **history**: prompt stash + frecency store
- **input**: stash hotkeys, frecency-ranked autocomplete, rotating tips
- **llm**: rank model picker by frecency within each provider
- **lockin**: auto mode + model-controlled set_lockin tool
- **palette**: surface suggested commands at the top of empty-query view
- **rail**: show "Thinking…" trailing row while agent narrates
- **rail**: hover, single-click expand, syntax-highlighted read results
- **renderer**: enable mouse motion tracking for hover states
- **renderer**: passthrough output, fps cap, terminal title sync
- **safety**: central confirm() dialog for destructive git + session actions
- **stash**: /stash browser command + draft-restore event bus
- **ui**: hover state on user messages, tool rows, and reasoning fold
- **ui**: border primitives + reasoning disclosure glyphs
- **ui**: dialog stack store + confirm/alert/select primitives
### Performance

- **intelligence**: stream semantic summary generation to bound heap
- **messages**: custom equality on StaticMessage so historical rows skip rerender
- **tool-row**: memoize StaticToolRow with prop-shape equality
- **ui**: scroll acceleration on every scrollbox
- cache & dedup hot paths in forge prepareStep
### Refactor

- **chat**: consolidate RAIL_BORDER on the ui/borders primitive
- **lockin**: per-tab verbose + commit-boundary rail render
## [2.15.7] — 2026-05-14

### Bug Fixes

- **cache**: default pruningTarget to none, force-off for sparks
- **keys**: pass secret via -w argv to avoid TTY prompt leak
- **keys**: stop keychain prompt leak and UI freeze in /keys
- **router**: fallback row layout + docs page
- **telemetry**: live toggle, key routing, table widths + docs
- **tools**: isolate subprocess stdin/tty to prevent UI hangs
### Documentation

- fix model-events icon to valid FA name
### Features

- **retry**: per-model fallback chains + split transient/stall budgets (#58)
- **telemetry**: opt-in per-call model events sidecar
- **tools**: actionable truncation hints + sharper edit guidelines
- **ui**: subdued grouped-list rows + indent remove key action
### Performance

- **prompts**: trim system prompt 5.2k→2k tokens, relocate refs to tools
### Testing

- **prompts**: update assertions for system prompt trim
## [2.15.6] — 2026-05-14

### Bug Fixes

- **agents**: propagate max_tokens cap to dispatched subagents
- **agents**: surface abnormal finish + auto-continue on length truncation
### Features

- **providers**: refresh model lists & opencode-go fetchModels
### Miscellaneous

- **theme**: default to proxysoul-main
## [2.15.5] — 2026-05-14

### Bug Fixes

- **build**: stub react-devtools-core initialize to prevent TUI crash
## [2.15.4] — 2026-05-13

### Bug Fixes

- **terminal**: hand TTY to child via renderer.suspend
- **wizard**: paste + cursor in setup api key input
### Miscellaneous

- bump bun engine, make nvim optional
## [2.15.3] — 2026-05-11

### Features

- **timeouts**: configurable watchdog timeouts with /timeouts picker (#61)
## [2.15.2] — 2026-05-11

### Bug Fixes

- **lock-in**: live dispatch updates
- **router**: make concurrency picker navigable
### Documentation

- **memory**: add user-facing memory page
- **prompts**: strengthen memory write/search habits
### Features

- **hearth**: expose provider settings as remote slash commands
- **provider-settings**: clarify tabs with info banners
- **reasoning**: wire thinking knobs for all providers
### Refactor

- **provider-settings**: group rows into sections, compact to one line
## [2.15.1] — 2026-05-11

### Bug Fixes

- **memory-browser**: tighten content width padding
## [2.15.0] — 2026-05-11

### Bug Fixes

- **clipboard**: surface backend-missing + update prerequisite for Wayland
- **clipboard**: wayland support + ctrl+shift+c no-exit + empty-export guard
- **memory**: declare new_id in supersede tool schema
- **memory**: rebalance recall scoring
- **memory**: better near-duplicate detection on write
- **memory**: rewrite breakage tests to new API + harden write/FTS
- **memory**: few memory fixes
### Documentation

- **memory**: rewrite prompt with value framing + capability-first ordering
- **memory**: rewrite prompt guidance — triggers, supersede, conflict protocol
- **memory**: stronger tool guidance + per-action display
- **prompts**: instruct proactive memory.search when convention matters
### Features

- **memory**: stub-mode auto-recall — details on demand via memory(get)
- **memory**: provider-aware embedder resolution + live refresh on model switch
- **memory**: surface recall signals in injected memories block
- **memory**: co-change recall boost via Soul Map git history
- **memory**: wire provider embeddings via config.memory.embeddingModel
- **memory**: provider embeddings + cleanup hint in statusbar
- **memory**: supersede action + 3x summary weight + boot backfill
- **memory**: hashbag-v2 embedder with paraphrase-grade recall
- **memory**: unified popup with Settings tab + UI toggle for auto-extraction
- **memory**: id prefix resolution + phase 6 auto-trigger hook
- **memory**: phase 6 — post-turn extraction primitives (opt-in)
- **memory**: phase 5 — contradiction hints on fresh writes
- **memory**: phase 4 — embeddings, semantic recall, memory_edges, Deep cleanup
- **memory**: premium popup browser — sidebar tabs + table + cleanup
- **memory**: phase 3 — cleanup primitives, interactive /memory, hint banner
- **memory**: phase 2 — multi-signal recall, passive inject, compaction-safe
- **memory**: phase 1 — schema rewrite, dedup, dual FTS, file refs
### Miscellaneous

- governance, build hardening, mintlify sweep
### Other

- **memory**: drop phase 6 auto-extraction
### Testing

- **memory**: adversarial sweep + 3 real bug fixes
- **step-utils**: await prepareStep — now async
## [2.14.11] — 2026-05-10

### Bug Fixes

- **soulforge**: use find -exec + to avoid heredoc backslash stripping
## [2.14.10] — 2026-05-10

### Bug Fixes

- **ci**: use Hardware::CPU.flags for AVX check in generated formula
## [2.14.9] — 2026-05-09

### Bug Fixes

- **plan-mode**: always register plan tools and sync mode on resume
### Miscellaneous

- remove test_scaffold tool
## [2.14.8] — 2026-05-08

### Bug Fixes

- **install**: self-heal missing libopentui + verify install integrity
## [2.14.7] — 2026-05-07

### Bug Fixes

- **proxy**: self-heal version file and reuse bounceProxy on restart
## [2.14.6] — 2026-05-07

### Bug Fixes

- **agents**: set max output tokens and surface abnormal finish reasons
- **dispatch**: passthrough agent text, fix cache prefix, per-agent stats
- **errors**: route silent catches through surface-aware sinks
- **useChat**: classify stream errors via cause chain (#63)
### Documentation

- document key storage, keyPriority, and Windows/WSL
### Features

- **commands**: add /exit to autocomplete
### Other

- router visual improvements
## [2.14.5] — 2026-05-04

### Bug Fixes

- **bundle**: authenticate proxy version lookup, bump fallback
## [2.14.4] — 2026-05-04

### Bug Fixes

- **bundle**: use aarch64 suffix for CLIProxyAPI assets
- **proxy**: match upstream aarch64 asset rename, fallback to legacy arm64
## [2.14.3] — 2026-05-04

### Bug Fixes

- **chat**: pick last text segment after tools, skipping trailing reasoning
- **chat**: snap drip cuts to grapheme/ANSI boundaries
- **compaction**: bill cache-read tokens at cache rate, not full input
- **deepseek**: use openai-compatible provider to preserve reasoning_content
- **pricing**: sync provider rates to 2026-04-30 official docs
- **prompts**: mandate final answer on every turn
- **ui**: rebuild update modal on PremiumPopup primitives
- retry logic for stall watchdog and transient streaming errors (#55)
### Features

- **footer**: expand hints with hearth, checkpoints, tabs, hooks, mcp
### Miscellaneous

- **useTextDrip**: rename reassigned param to local cut
### Performance

- **stream**: kill render churn in lock-in and long autonomous loops
### Testing

- **pricing**: align deepseek expectations with v4-flash rates
## [2.14.2] — 2026-04-29

### Bug Fixes

- **agents**: guard normalizePath against non-string + Windows separators
### Documentation

- note Windows is not natively supported, link #57
## [2.14.1] — 2026-04-28

### Bug Fixes

- **copilot**: route all models through /chat/completions, surface clear errors
- **lock-in**: include ast_edit in edit-tool set
- **lockin**: keep rail border constant across tool count changes
- **tools**: shorten ast_edit description to fit popup row
- prefer project instructions over global defaults (#56)
### Features

- **lock-in**: enable by default and hint toggle in input
### Miscellaneous

- bump deps and ignore app build artifacts
## [2.14.0] — 2026-04-24

### Bug Fixes

- **approvals**: prompt locally when Hearth is offline
- **approvals**: prompt locally when Hearth is offline
- **ast-edit**: harden replace_in_body + surgical ops
- **hearth**: hoist redact import in tui-host log sink
- **hearth**: production hardening sweep (H1-H9, M1-M8)
- **hearth**: rebuild all surfaces on config reload
- **hearth**: guard bridge lock against pid reuse
- **hearth**: tee TuiHost logs to hearth.log for Recent log visibility
- **hearth**: log imessage inbound + binding miss for debuggability
- **hearth**: write daemon log to disk; hide token row for iMessage
- **hearth**: cap attachments at 10 MB, scrub filenames
- **hearth**: stamp [via <origin>] on remote-surface messages
- **hearth**: redact bot token in URL-path form
- **hearth/discord**: intent minimization, fatal-close lockout, 429 retry, allowlist
- **hearth/imessage**: parameterized SQL, TCC probe, exact approval prefix, rate limit
- **hearth/telegram**: spoof detection, 429 retry, callback allowlist, rate limit
- **intelligence**: cap ts-morph SourceFiles and tie LSP diagnostics to doc eviction
- **intelligence**: stop biome/LSP zombie process leak; report true memory footprint
- **subagent-tools**: preserve full dispatch result body in aggregate summary
- **ui**: tighter popup layouts
- **useChat**: add tabId to unmount effect deps
- **wizard**: drop fabricated content, correct URL and web-search providers
### Documentation

- **ast-edit**: add user-facing docs, README feature, pills pill
- **hearth**: mark as experimental across UI and docs
- **hearth**: drop iMessage from README and Mintlify
- overhaul
- remove legacy /docs (migrated to mintlify-docs)
### Features

- **ast-edit**: smart-resolve, anchors, arrow targets, robust errors
- **hearth**: TUI-aware stop and Discord snowflake validation
- **hearth**: /hearth status reports TUI host as alive
- **hearth**: TUI steals bridge from daemon and auto-binds on /pair
- **hearth**: socket peer-auth via SO_PEERCRED / getpeereid
- **hearth**: persistent daemon service — launchd/systemd unit install
- **hearth**: remote control surface layer with TUI + daemon hosts
- **proxy**: dynamic version, self-heal on connection errors, undici fetch
- **tools**: add ast_edit — surgical ts-morph AST editing for TS/JS
- **ui**: introduce popup design system primitives
### Miscellaneous

- **hearth**: use optional chain in telegram handleUpdate
- **logs**: route boot-path stderr writes through logBackgroundError
- formatting + minor cleanups
### Other

- Load instruction files from the home directory (#49)

## Summary
This fixes a gap in instruction loading: `instructionFiles` could be
enabled globally, but the loader still only looked in the repo root.

This change:
- loads enabled instruction sources from both the project directory and
the user's home directory
- keeps both project and global instructions in the prompt and makes
global precedence explicit when both exist
- adds targeted loader tests and updates the docs for prompt assembly,
config, and headless behavior

## Testing
- `bun test tests/instructions-loader.test.ts tests/shiki-marked.test.ts
tests/prompt-builder.test.ts`
- `bunx biome check src/core/instructions.ts
tests/instructions-loader.test.ts`
### Performance

- **intelligence**: fix 20+ GB worker heap balloon on long sessions
### Refactor

- **chat,landing**: ast_edit row label + KeyCaps migration + NewFlameLogo
- **checkpoints**: redo stack stores dropped messages per entry
- **context**: make cross-tab coordination block passive FYI
- **hearth**: remove iMessage surface
- **popups**: drop POPUP_BG/POPUP_HL module exports
- **popups**: migrate all modals/settings to PremiumPopup + primitives
- **prompts**: dedupe workflow, XML-structure tool guidance, add ast_edit examples
- **prompts**: dedupe shared rules, single-source CORE_RULES
- **prompts**: rewrite identity + output-discipline grammar rules
- **tool-formatters**: restrict outside-cwd scan to path args
- **tools**: prefer ast_edit for TS/JS + forge usage telemetry
- **tools-popup**: drop redundant keyHint checkmark
- **ui**: VirtualList primitive replaces usePopupScroll
- **useChat**: consolidate web + fetch approval prompts into permission helper
- **wizard**: drop dead Feat and SectionLabel primitives
- **wizard**: rebuild onboarding around docs feature surface
- **wizard**: migrate onboarding to new UI primitives
### Testing

- test

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
## [2.13.2] — 2026-04-18

### Bug Fixes

- **retry**: honor retry.maxAttempts in SDK + cover connection errors
## [2.13.1] — 2026-04-18

### Bug Fixes

- honor user retry config for both transient and stall retries
- model picker always background-refreshes on open
## [2.13.0] — 2026-04-18

### Bug Fixes

- validate restored core messages and preserve tool prototype chains
### Documentation

- **prompts**: drop outdated absolute-paths rule
### Features

- **landing**: stronger tint, flame stays alive at breath trough
- **landing**: wordmark breath pulse, deeper flame lighting
- **landing**: animated flame+wordmark logo
- **proxy**: add Opus 4.7 support, auto-upgrade stale proxy binary
- **splash**: hand-drawn ASCII wordmark with animated boot/shutdown
## [2.12.3] — 2026-04-16

### Features

- configurable retry for transient provider errors
### Miscellaneous

- **useChat**: sort imports
### Refactor

- **prompts**: tighten output discipline with curse persona and grammar rules
- **tool-display**: compact tool call rendering
## [2.12.2] — 2026-04-16

### Bug Fixes

- guard cost computation against NaN/undefined usage fields
- avoid matching date suffixes as minor version in supportsTemperature
- prevent tab name popup from opening when at max tabs
### Features

- log final Anthropic provider options to .soulforge/effort.json
- add xhigh effort level and per-model effort clamping
- inline checkpoint legend with tabs bar
### Other

- remove .soulforge/effort.json debug logging
- group Clear Thinking under thinking section, disable when thinking off, clarify label
## [2.12.1] — 2026-04-16

### Bug Fixes

- use install @latest instead of update for upgrade commands
## [2.12.0] — 2026-04-16

### Bug Fixes

- **soul-vision**: yt-dlp retry without size cap when first attempt fails
- **soul-vision**: direct video URLs, auto-resize oversized images
- stop auto-labeling tabs from first user message
- don't auto-start proxy for new users
- prevent orphaned LSP processes via PID file tracking
- remove unnecessary checkpoints.length dependency from rail scroll effect
- checkpoint scroll lands on user message consistently
- latest checkpoint keeps diamond shape while browsing
- ^B skips current checkpoint and goes directly to previous
- eagerly sync coreMessagesRef on setCoreMessages
- end-to-end checkpoint undo/redo file restoration
- robust checkpoint rail and deterministic scroll positioning
- align checkpoint legend to right side
- checkpoint bugs, race conditions, and rail UI overhaul
- eliminate stale file reads from dispatch cache
- per-model endpoint routing for copilot provider
- use responses API instead of chat completions for copilot and github-models providers
- bypass proxy+Claude system prompt cloaking
- kill LSP process groups to prevent orphaned grandchildren
- surface clone hints on file creation, not just edits
- clone detection missed low-pagerank files and produced duplicate results
- default semantic summaries to "ast" instead of "synthetic"
- stop spamming /errors on normal completions, log actual failures
- stop spamming /errors on normal agent completions
- re-raise signals instead of process.exit(128+N) on Ctrl+C
- detect multi_edit and dispatch changes in hasChangedFiles
### Features

- configurable max concurrent agents in /router
- LSP server version tracking and updates
- add tab name popup for new tab creation
- context bar uses warning style with ~ prefix when browsing checkpoints
- context bar shows estimated tokens for viewed checkpoint
- show rewind hint in input placeholder when viewing checkpoint
- git-backed checkpoints with undo/redo, visual rail, and session persistence
- add global toolTimeout config with /timeouts command
- replace hand-rolled JSON repair with jsonrepair library
- auto-compress large images before API submission
- surface clone detection hints after edit_file and multi_edit
### Miscellaneous

- remove harbor agent adapter
- update README and replace header with logo assets
### Other

- restore .chat() for copilot and github-models providers
### Performance

- improve clone detection quality — reduce noise, add semantic filtering
### Refactor

- centralize test file SQL filter in RepoMap
- deduplicate edit/multi-edit diagnostics, blast-radius, and occurrence counting
- dedup inferModelGroup, fallbackTracked, and ZERO_USAGE
## [2.11.0] — 2026-04-12

### Bug Fixes

- speed up model selector modal open path (#32)
- disable stall watchdog by default, add /watchdog toggle
### Features

- scroll long command descriptions in command palette (#25)
- add opencode go and opencode zen provider support. (#28)
- custom thinking/reasoning params for OpenAI-compatible providers (#33)
- add Codex account management commands (#24)
### Miscellaneous

- update models context & missing models (#30)
### Other

- Fix blank assistant messages being marked complete (#29)

## Summary
- stop finalizing assistant messages when the only collected output is a
non-renderable segment
- extract shared assistant-content and assistant-message helpers so the
final completion and partial-save paths use the same rules
- add regression tests that prove blank orphan tool segments do not
create a completed assistant message

Closes #26.

## Testing
- `bun test tests/usechat-content.test.ts tests/codex-provider.test.ts
tests/provider-status.test.ts`
- `bun run typecheck`
- `bunx @biomejs/biome check src/hooks/useChat.ts
src/hooks/useChat-content.ts tests/usechat-content.test.ts`
- manually validated against the original issue scenario
### Refactor

- replace auto-restart with manual restart prompt in /update
## [2.10.0] — 2026-04-10

### Bug Fixes

- **multi-edit**: fall through to string match on line-range mismatch
- **post-edit**: make error reporting more prominent to force immediate fixes
- forward execution context in hook tool wrapper
- remove redundant ^X stop hint from loading status
- remove non-null assertions in useNeovim poll handler
- remove microtask batching — feed PTY data directly
- edit wrong inline count
- cast ghostty-opentui renderable to avoid duplicate @opentui/core type mismatch
### Documentation

- **prompts**: add tool result error-checking rules to shared prompt
- unify and update all documentation to reflect codebase
- strengthen multi_edit rule — explain why sequential edit_file fails
### Features

- **sessions**: persist core messages directly instead of rebuilding from chat history
- add /hooks command with per-event toggle
- add disableAllHooks, once:true, and if conditional to hooks
- wire remaining hook events across agent lifecycle
- add Claude Code-compatible hooks system
- add OpenCode Zen provider + fix reasoning_content stripping in custom providers
- auto-add .soulforge to .gitignore in git repos
- session rename — /session rename, ^R in picker, persistent custom titles
- replace NvimScreen grid renderer with native PTY + ghostty rendering
### Miscellaneous

- fix import ordering (biome auto-format)
### Performance

- consolidate 4 RPC polls into single executeLua call
- batch PTY data chunks per microtask to prevent torn frames
### Refactor

- strip redundant editor chrome — neovim statusline is enough
### Testing

- add hook test configs for .claude and .soulforge
## [2.9.5] — 2026-04-08

### Miscellaneous

- cast type ghostty
- deps upgrade
## [2.9.4] — 2026-04-08

### Bug Fixes

- revert npm build to 2.8.0 approach — no patching, no native lib copying
## [2.9.3] — 2026-04-08

### Bug Fixes

- use ESM-compatible path resolution in npm build patch
## [2.9.2] — 2026-04-08

### Bug Fixes

- early termination
## [2.9.1] — 2026-04-08

### Bug Fixes

- blank screen on npm/bun install and LSP process leaks
## [2.9.0] — 2026-04-08

### Bug Fixes

- connect tree rails through multi-file read expansions during streaming
- correct stop shortcut hint from ^+X to ^X
- lock-in view hides left border for single tool calls
- correct GLM model context window sizes
- inline Spinner imperative update uses children not content
- context percentage fallback when API tokens unavailable
- prevent stale soul map entries and LSP zombie processes
- restart compiled installs without bunfs entrypoint (#22)
- centralized Anthropic tool version selection per model capability
- detect kitty version, fall back to chafa for ≥0.38
### Documentation

- strengthen output discipline — no narration between tool calls
- add mempalace integration guide
- improve soul_impact tool guidance in agent prompts
### Features

- nested file tree display for multi-file reads and batch tool calls
- Tab/Shift+Tab to cycle between tabs from input box
- InputBox widthPct prop for landing transition
- smooth opacity fade for streaming text drip
- register text-table renderable for JSX usage
- landing page redesign with animated transition to chat
- redesign boot splash with rune spinner and glitch-decode wordmark
- migrate 15 popups to reusable Popup compound component
### Miscellaneous

- remove brackets from stop hint in LoadingStatus
- remove ForgeSpinner3D and three.js type stubs
- bump AI SDK providers and dependencies
### Other

- Add Codex as a first-class provider (#20)

## Summary
- add Codex as a first-class provider in SoulForge
- use the official Codex app-server for browser login and live model
discovery, so ChatGPT/Codex subscriptions work directly in the app
- add `/codex login`, Codex-aware model picker login UX, and live
provider status refresh after login

## Testing
- `bun test tests/provider-status.test.ts tests/codex-provider.test.ts
tests/new-providers.test.ts tests/local-providers.test.ts
tests/custom-providers.test.ts`
- `bun run typecheck`
- `bun run dev -- --headless --model codex/gpt-5.2-codex --max-steps 3
--quiet \"Reply with exactly PONG.\"`
### Performance

- offload model fetching and session listing to IO worker
### Refactor

- remove unused queueCount prop from LoadingStatus and InputBox
- improve tool call display — tree borders, multi_edit diffs, flat standalone lists
- tab bar back to bracket style with active background
- cleaner tab bar design without brackets
- popup polish — deferred rendering, import order, cleanup
- oscillating rune wheel spinner and unified Spinner component
## [2.8.0] — 2026-04-07

### Documentation

- replace intro video with looping GIF in README
- fix video embed to bare URL and remove intro.mov
- add compressed intro.mp4 and fix video embed in README
- replace main-1 screenshot with intro video in README
### Features

- rich soul map diffs + navigate annotations from DB
- MemPalace integration via MCP
- add Harbor Terminal-Bench agent adapter
### Miscellaneous

- fix import ordering and add missing cwd dependency
## [2.7.0] — 2026-04-07

### Bug Fixes

- sanitize MCP tool names to match API pattern ^[a-zA-Z0-9_-]{1,128}$
- restore session after crash — synchronous emergency save (#18)
### Documentation

- fix task router slots — replace legacy fields with spark/ember (#17)
### Features

- add MCP servers support
## [2.6.5] — 2026-04-06

### Miscellaneous

- match git repo link
## [2.6.4] — 2026-04-06

### Miscellaneous

- *sigh* npm pls x2
## [2.6.3] — 2026-04-06

### Miscellaneous

- *sigh* npm pls
## [2.6.2] — 2026-04-06

### Miscellaneous

- fix npm publish
## [2.6.1] — 2026-04-06

### Miscellaneous

- upgrade npm in ci
## [2.6.0] — 2026-04-05

### Bug Fixes

- use HTML formatting inside sub tag in README image table
### Features

- clipboard image paste support (#3)
### Miscellaneous

- update workflow
## [2.5.0] — 2026-04-05

### Bug Fixes

- warn agent when auto-format changes line count after edit
- complete async migration and bug fixes for soul_vision
- smart video fallback — animated GIF for Kitty, static frame for others
- remove Konsole from Kitty Unicode placeholder support
- render reasoning blocks with Markdown component
### Features

- auto mode bypasses all permission prompts, use hardRestart for updates
- cap soul_vision image height, retry flaky video-to-GIF, update README
- async video pipeline with live progress UI
- restore Kitty images on session resume
- restore Kitty images on session resume
- soul_vision tool for inline image display
### Refactor

- clean up soul_vision for performance and reusability
### Testing

- add image rendering and terminal detection tests
## [2.4.0] — 2026-04-05

### Bug Fixes

- custom providers not showing in Ctrl+L model picker
- eliminate unsafe casts on LLM data, add Zod validation for plan output
### Documentation

- fix features SVG — drop animations, use static opacity for GitHub compatibility
- fix features SVG visibility, remove prompt caching and sandboxed execution
- expand features SVG with 16 pills, fix header spacing
- update README and assets
### Miscellaneous

- readme overhaul
## [2.3.0] — 2026-04-04

### Features

- add LM Studio provider; fix non-nerd-font icons for ollama, lmstudio, and custom providers
## [2.2.1] — 2026-04-04

### Bug Fixes

- add Java/JVM LSP support and fix health check hangs (#8)
## [2.2.0] — 2026-04-04

### Bug Fixes

- resolve stream stall watchdog deadlock and surface retry messages
- show FREE tag in model picker, drop sub-group rearrangement
- accurate OpenRouter cost reporting and free model detection
- improve Ctrl+L model selector performance and fix handleNewSession hoisting
- track and kill all child processes on exit
- handle SIGHUP to clean up child processes on terminal close
- correct free Qwen model ID in Headless Forge workflow
### Features

- add /session new command to start fresh session
- add Groq, DeepSeek, Mistral, Bedrock, and Fireworks providers
### Miscellaneous

- remove stale tea_test file
- update gitignore
- update README badges and rename workflow
- bump all actions to latest (checkout v6, artifact v7, setup-node v6)
- bump actions to v5 for Node.js 24 compatibility
- add Headless Forge workflow for end-to-end testing
## [2.1.1] — 2026-04-04

### Bug Fixes

- x64-baseline bundle uses wrong native addon paths
## [2.1.0] — 2026-04-04

### Bug Fixes

- make headless test TTY-independent
- detect brew install when ~/.soulforge/bin shadows PATH\n\nBrew's post-install copies the binary to ~/.soulforge/bin/, which\nshadows the brew symlink at $HOMEBREW_PREFIX/bin/soulforge in PATH.\nThis caused detectInstallMethod() to fall through to \"binary\".\n\nFix: directly check if $HOMEBREW_PREFIX/bin/soulforge exists as a\nsymlink — the one artifact only brew creates.
- accordion behavior in model selector — expanding a provider collapses others
- update prompt-content test to match shell guidance heading
- apply default transparent theme on first launch
- strip mismatched provider options from subagents
- git commit messages with literal \n instead of real newlines
- remove Copilot auto-detect, require manual OAuth token
- prevent interactive prompts from freezing the TUI
- add x64-baseline build for pre-AVX CPUs
- call GREEN() in headless --list-providers output
- show clean error in headless when model API key is missing
- detect package manager from monorepo root lockfile
- handle web-tree-sitter WASM rename and broken grammar resilience
### Documentation

- add Copilot provider guide, update README and mintlify for 12 providers
- fix theme token reference and add PayPal badge
- merge redundant README sections into single feature table
### Features

- detect GitHub CLI and surface availability in system prompt
- add MiniMax provider with M2/M2.1 models
- inject working directory into system prompt and add conventional commits rule
- add Copilot auto-detect toggle in /keys and fix footer text
- add GitHub Copilot and GitHub Models as LLM providers
### Miscellaneous

- move Fuel the Forge badge to top of README
### Refactor

- derive secrets, icons, and API key UI from provider registry
## [2.0.0] — 2026-04-03

### Bug Fixes

- resolve all lint errors and warnings across 7 files
- show proper labels in lock-in tool rail instead of raw tool names
- child context managers now defer to parent for repo map readiness
### Documentation

- refresh for spark/ember architecture + screenshot update
### Miscellaneous

- fix changelog generation — include non-conventional commits
### Other

- skip bus coordination tools for desloppify/verifier

Solo post-processing agents dont need report_finding,
check_findings, or check_edit_conflicts — no peers to
coordinate with. skipBusTools flag on agent creators,
set automatically for desloppify/verifier agentIds.
Bus cache (wrapWithBusCache) still active for file reads.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- hide task text for desloppify/verifier in dispatch display

The agentId + tier label (cleanup/verify) already identifies them.
No need to show the raw prompt text which starts with RULES block.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- drop hallucinated files, coerce weak model read args
- agent lifecycle: unified result handling, display fixes, soul map UX

Result handling:
- extractFinalText: last step text, not concatenated result.text
- calledDone → succeeded: derived from agent text + edits, not ghost done tool
- removed extractDoneResult (done tool never existed)
- desloppify/verifier routed through runAgentTask (no duplicate code)

Display:
- agent role label from info.role not tier (explore ember no longer shows [code])
- succeeded drives checkmark (✓) vs warning (!)
- hideOther prop on PendingQuestion for single-option prompts

Soul Map wait UX:
- interactive prompt with live progress (files, symbols, phase)
- "Proceed without Soul Map" button, auto-dismiss on ready
- scan errors shown in prompt text
- child contexts defer to parent isRepoMapReady (was files>0 bug)
- Ctrl+X aborts cleanly via AbortSignal

Timer:
- loadingStartedAt set after Soul Map wait, not on submit
- headless startTime after setupAgent

Step limits: 12 explore / 18 code, nudge at 8/12
Nudges: action-oriented ("stop and report") not budget-aware ("step 8/12")

Headless: waitForRepoMap with 30s timeout and progress message

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- start counting after Soul Map wait, not on submit
- use waitForRepoMap with 30s timeout and progress
- soul map wait: show scan errors in prompt, cleaner progress

- scan failure shown in question text (user decides to proceed)
- removed stall auto-skip (user should decide, not timeout)
- progress shows file/symbol counts from repo map store

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- hide "Other" option via explicit hideOther prop on PendingQuestion

Added hideOther?: boolean to PendingQuestion interface.
QuestionPrompt checks it to show/hide the free-text option.
Soul Map wait prompt sets hideOther: true.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- soul map wait: interactive prompt with live progress

When Soul Map is not ready on message submit:
- shows a PendingQuestion with live progress (files, symbols, phase)
- progress updates every 500ms from the repo map store
- user can click "Proceed without Soul Map" to skip (with warning)
- auto-dismisses when Soul Map finishes (200ms poll)
- respects Ctrl+X abort
- warns about reduced capabilities if proceeding without

waitForRepoMap: accepts AbortSignal for clean cancellation

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- soul map wait: abort-aware, clearer messaging

- waitForRepoMap accepts AbortSignal — Ctrl+X during indexing cancels
  the wait cleanly instead of hanging until timeout
- wait message simplified: "Soul Map indexing… will proceed when ready."
- timeout warning is now a system message with reduced-capabilities note

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- add dispatch testing notes

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- app layout fixes, icons, skills lockfile update
- plan tool: JSON array coercion + schema refinements

- coerceJsonArray preprocessor for array fields (handles stringified JSON)
- refined plan file/step schemas for clarity

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- router settings: spark/ember labels + proxy perf defaults

RouterSettings: renamed slots to match spark/ember terminology
- "Code Agent" → "Explore", "Exploration" → "Code"
- added icons to slot labels
- simplified section subtitles

Proxy lifecycle: auto-inject performance defaults into proxy config
- retry, keepalive, streaming settings for reliability
- versioned marker block (replaced on version bump)
- skips injection if user already has conflicting keys

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- /context panel: scope-aware tabs, token fixes, display cleanup

StatusDashboard redesign:
- scope selector (←→ arrows) to view per-tab or aggregate token usage
- single tab: no scope selector, identical to before
- multi-tab: Tab 1 / Tab 2 / All — each shows full breakdown
- "All" scope: aggregated tokens + per-tab summary table
  (Input / Output / Cache% / Cost columns)
- context window/compaction/system prompt shown for all tab scopes
  (hidden only in "All" aggregate view)

Token reporting fixes:
- compaction preserves cacheRead/cacheWrite/subagentInput/subagentOutput
  (was zeroed by ...ZERO_USAGE spread)
- BarRow/EntryRow right padding (values no longer touch border)
- BarRow descW param for aligned bars across rows

ToolCallDisplay cleanup:
- removed compact prop (always show last running step only)
- fresh agent shows thinking spinner (removed doneCount>0 gate)
- removed dead `true` in memo comparator

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- spark/ember architecture with clean classification and lean prompts
### Testing

- update agent-results budget cap expectations
## [1.9.0] — 2026-04-03

### Bug Fixes

- fix loading timer persistence across lock-in toggle

Share loadingStartedAt timestamp from parent TabInstance so the
elapsed timer survives toggling between lock-in and default view
instead of resetting to 0.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- detect brew install method for homebrew-wrapped binary
### Features

- prompt engineering overhaul + soul_grep dep fix + soul_find ranking
- programmatic tool calling (smithy) + code execution UI nesting
- token-efficient prompt + tab layout fix + disable unused tools
### Other

- project tool: expose "check" action in input schema

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- project tool: add "check" action — runs typecheck+lint+test in parallel

Move runCommand above the null guard and handle "check" with an early
return so TypeScript correctly narrows command to non-null for the
remaining single-action path.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- read tool: show callees and qualified names in symbol output

Add getCalleesForSymbol to repo-map and wire through intelligence worker
so the read tool can show what a symbol calls (top 10 callees). Also
propagate qualifiedName through getFileSymbolRanges so bus-cache and
read-file display Class.method instead of just method.

Symbol outline now shows "Calls: foo, bar, baz" when reading a function,
giving the agent immediate understanding of a symbol's dependencies.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- duplication detection: reduce false positives with smarter filtering

- Skip parent-contains-child matches (intra-function nesting)
- Skip pairs where both are type declarations (similar AST ≠ duplication)
- Skip pairs of short variables (<10 lines) — config literals are noise
- For sub-95% matches, compare signature tokens and skip when signatures
  diverge (sigSim < 0.3) — different intent despite similar structure
- Join symbols table to get kind + signature for filtering context

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- soul map: show top caller names in symbol badges instead of just counts

Replace getCallerCounts with getCallerDetails that returns top 3 caller
names per symbol. Badges now show e.g. [useChat, renderMessage, +5↑]
instead of [7↑], giving the agent immediate context about who uses each
symbol without needing navigate(references).

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- update tests for read_file → read rename

Mechanical update of all test files to use the new `read` tool name
in test fixtures, assertions, and descriptions.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- strip programmatic tool calling for Haiku subagents

Add supportsProgrammaticToolCalling() check — Claude 4+ non-Haiku only.
Subagent tool wrapper strips providerOptions (allowedCallers) from tools
when the model doesn't support it, preventing API errors with Haiku.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- improve architect, socratic, and auto mode prompts

- Architect: add "Critical Files" list requirement, recommend next mode
- Socratic: add web_search guidance, structured option presentation,
  progress from broad to specific investigation
- Auto: add safety rails (destructive action confirmation, no secret
  exfiltration), error recovery strategy (3 attempts then pivot),
  verify after each logical unit

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- add rotating hint system to footer with glitch transitions

Periodically swap keyboard shortcuts with contextual tips about
SoulForge features (modes, LSP, tabs, themes, headless, etc.).

- 30+ hints covering modes, intelligence, tabs, router, git, skills,
  themes, headless CLI, and discovery features
- Elimination-random bag: each hint shows once before any repeats
- Garble glitch transition animation between shortcuts and hints
- Highlighted segments for commands/keywords in brand color
- Auto-truncation for narrow terminals

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- enhance error display with flavor text, codes, and stream errors

Richer error categorization in chat messages:
- Extract HTTP status codes and error type codes from raw messages
- Add forge-themed flavor text per error category
- Add stream error category (INTERNAL_ERROR, api_error)
- Show error code badge [429] and flavor text in header
- Use accentUser/accentAssistant for user/assistant message borders
- Fix error text color (was t.error, now t.textSecondary for readability)

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- update all read_file references to read

Mechanical rename of read_file → read across agents, tools, prompts,
and documentation. Updates tool hints, error messages, descriptions,
and intercept suggestions to use the new read(files=[...]) syntax.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- track symbol endLine across intelligence stack

Propagate endLine from all intelligence backends (LSP, tree-sitter,
ts-morph) through repo map SQL queries and intelligence client types.

- LSP: add endLine/endColumn from symbol location ranges
- Tree-sitter: add endLine from node.endPosition across all symbol queries
- ts-morph: add endLine from getEndLineNumber() for imports and exports
- Repo map: return line/endLine from getFileSymbols, getUnusedExports,
  getTestOnlyExports SQL queries
- Intelligence client: update type signatures and cache types
- Navigate: show line ranges (start-end) in formatSymbol output
- Soul analyze: display :line-endLine in unused exports report
- Soul find: show line ranges in symbol details and "also:" hints
- Bus cache: include endLine in symbol hints for cached reads
- Step utils: include line ranges in pruned symbol hints

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- rename read_file → read with batch files API

Replace the single-file read_file tool with a batch-capable `read` tool.
New schema: files=[{path, ranges?, target?, name?}] supporting
multiple files and multiple ranges per file in a single call.

- Rewrite execute to handle array/single file specs with parallel reads
- Add smart truncation at 200 lines with symbol outline from repo map
- Add symbol outline for truncated AST extractions (>200 lines)
- Update error messages to reference new ranges syntax
- Update tool formatters for batch read display (file count, range count)
- Update tool grouping, display labels, icons, categories
- Update dispatch cache wrapper to handle new schema

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- overhaul setup wizard: inline model picker with provider-scoped fetch

Replace the old flow (set key → open separate LlmSelector) with an
integrated experience:
- Provider selection → key input → fetch models → pick model, all inline
- Add fetching phase with spinner, error phase with retry
- Fuzzy search within fetched model list
- onSelectModel now accepts modelId directly, App.tsx handles save
- Remove memo wrappers from wizard primitives (Gap, Hr, StepHeader, etc.)
- Remove memo from FirstRunWizard itself

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- track and display response duration on assistant messages

- Add durationMs to ChatMessage type
- Record responseStartedAt in useChat, set durationMs on completion
- Show "✓ Completed in Xm Ys" after assistant messages in MessageList
- Use formatElapsed in LockInStreamView for consistent time formatting

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- export soul-find/soul-grep internals for testing, add ranking + dep tests

- Export fileTypePenalty from soul-find for direct testing
- Export DepResolution, resolveDepSearch, annotateDepNoMatch from soul-grep
- Format long regex patterns (line length lint)
- Add soul-find-ranking.test.ts: file type penalty scoring
- Add soul-grep-dep.test.ts: dependency resolution logic

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- reorder tool definitions: soul tools first for model preference bias

Models prefer tools earlier in the list. Reorder from soul tools (TIER-1,
cheapest) → LSP → core read/edit → search fallbacks → shell → compound ops.
This reinforces the decision flow in the system prompt without adding tokens.

Stable ordering defined in STABLE_ORDER array, unknown tools appended at end.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- slim down system prompt: remove cwd, projectInfo, forbidden, memory from builder

Move dynamic context (forbidden gates, memory index, project info) out of
the system prompt. Forbidden rules enforce at tool level, memory/project
info are injected via context messages instead. This reduces system prompt
size and improves prefix cache hit rates.

- Remove cwd, projectInfo, forbiddenContext, memoryContext from PromptBuilderOptions
- Simplify ContextManager.buildSystemPrompt() to only pass projectInstructions
- Trim projectInfo to just toolchain label (no file content)
- Update tests to match new prompt structure

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
### Refactor

- refactor settings panels and QuestionPrompt: extract row components, polish UI

ApiKeySettings:
- Extract ProviderKeyRow, RemoveKeyRow, PriorityRow components
- Add provider icons, fixed-width input field, typed flash messages
- Use cursor character ▎ instead of underscore

LspInstallSearch:
- Extract ServerRow, ScopeRow components
- Remove memo wrapper, consistent popup color usage

SkillSearch:
- Extract SearchSkillRow, InstalledSkillRow, ActiveSkillRow, ScopeRow
- Remove memo wrapper, use usePopupColors consistently

QuestionPrompt:
- Extract OptionRow component
- Use brand color instead of warning for question styling
- Add padding and bgInput for text input mode

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- refactor modal components: extract row components, remove unnecessary memos

CommandPalette, CommandPicker, LlmSelector, SessionPicker:
- Extract inline render logic into focused row components (HeaderRow,
  CommandRow, SessionRow, ModelRow, etc.)
- Remove useMemo/useCallback wrappers that added complexity without benefit
- Add search result counts in search bars
- Use Unicode escapes for special characters (arrows, dashes, dots)
- Consistent search bar styling with bgPopupHighlight
- Add fuzzy match highlighting in CommandPalette
- Improve confirm-clear UX with red background in SessionPicker

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
## [1.8.3] — 2026-04-02

### Bug Fixes

- stall watchdog uses first-content detection, not first stream event
## [1.8.2] — 2026-04-02

### Bug Fixes

- compaction model context window uses authoritative API value
## [1.8.1] — 2026-04-02

### Bug Fixes

- context bar re-renders on window change, status dashboard uses fresh model
## [1.8.0] — 2026-04-02

### Bug Fixes

- context window propagation — authoritative source wins
- improve model context window resolution
- overhaul context window fallback tables across all providers
- lock-in elapsed timer uses loadingStartedAt for accuracy
- stall watchdog uses generous timeout between API steps
- cache-friendly Anthropic context edits
- improve tool formatters for soul_grep, soul_find, soul_impact, dispatch
- improve tool descriptions and navigate auto-resolve
- fuzzy clear cmd & prompt improvements
### Features

- **update**: rich changelog from GitHub releases, brew detection fix
- lock-in UI polish — elapsed timer, color tweaks, minimal loading bar
- wire flags param through git tool actions
- phase-specific spinners and animated dots for lock-in mode
- stream stall watchdog with auto-retry + sanitize empty assistant content
- lock-in mode — hide narration, show tools + final answer
### Performance

- pre-warm OpenRouter + LLM Gateway model caches at boot
### Refactor

- improve system prompts — claude rewrite, shared rules, tool guidance
## [1.7.6] — 2026-04-01

### Bug Fixes

- make getModelContextWindow async for accurate context sizes
## [1.7.4] — 2026-04-01

### Features

- **agents**: share forge tool definitions with miniforges for cache prefix hits
- Anthropic native tools, tool streaming toggle, prompt refinements, and UI polish
## [1.7.3] — 2026-03-31

### Features

- tree continuation lines through expanded tool content
### Other

- v1.7.3
## [1.7.2] — 2026-03-31

### Bug Fixes

- landing page wordmark style, status checkmark, model label accuracy
### Other

- v1.7.2
## [1.7.1] — 2026-03-31

### Features

- redesign landing page with glitch-decode animation & forge personality
## [1.7.0] — 2026-03-31

### Features

- large repo support — React (6.5k files, 36k symbols) scans fully
## [1.6.3] — 2026-03-31

### Bug Fixes

- buildCoChanges stalls on repos with large git history
## [1.6.2] — 2026-03-31

### Bug Fixes

- heartbeat progress events in all post-indexing phases
## [1.6.1] — 2026-03-31

### Bug Fixes

- scan RPC used 30s default timeout instead of activity-based idle timeout
## [1.6.0] — 2026-03-31

### Features

- robust repo map scanning for large repos and edge cases
## [1.5.3] — 2026-03-31

### Bug Fixes

- support large repos — activity-based scan timeout, git ls-files safety
## [1.5.2] — 2026-03-31

### Bug Fixes

- deep symlink resolution, pin Bun in CI, robust brew wrapper
- robust brew wrapper template with auto-gunzip and error recovery
## [1.5.1] — 2026-03-31

### Bug Fixes

- resolve symlinks in bin.sh for bun/pnpm global installs
## [1.5.0] — 2026-03-31

### Bug Fixes

- brew wrapper detects upgrades via mtime comparison
### Features

- revamp wizard steps, add image art display, improve shell/edit robustness
### Other

- v1.5.0
## [1.4.0] — 2026-03-30

### Bug Fixes

- brew formula template uses first-run wrapper, not post_install
### Other

- v1.4.0
- improve edit tools UX and clean up skill search

- edit-file/multi-edit: clarify that lineStart is recommended (not required),
  improve error messages to emphasize atomic rollback behavior
- multi-edit: remove unused warnings array
- SkillSearch: remove agentSkillsEnabled toggle prop and UI
- instance: preserve recentToolWrites entry for repeated fresh reads

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
## [1.3.8] — 2026-03-30

### Bug Fixes

- inline package.json version at build time for all install methods
- brew post_install uses bash -c instead of Ruby file ops
## [1.3.7] — 2026-03-30

### Features

- bun runtime requirement, shell wrapper, inline brew install, version check
## [1.3.6] — 2026-03-30

### Refactor

- remove lsp_status editor action, improve implementation diagnostics
## [1.3.5] — 2026-03-30

### Bug Fixes

- use original OpenTUI parser worker from node_modules for npm installs
## [1.3.4] — 2026-03-30

### Bug Fixes

- bundle parser worker + tree-sitter WASM for npm, gzip Mach-O for brew
## [1.3.3] — 2026-03-30

### Bug Fixes

- markdown rendering in npm/brew, dylib relinking, wrapper script escaping
## [1.3.2] — 2026-03-30

### Bug Fixes

- robust resource resolution for brew, npm, and binary installs
## [1.3.1] — 2026-03-30

### Bug Fixes

- resolve worker crashes on npm install and brew sandbox issues
### Other

- v1.3.1
## [1.3.0] — 2026-03-30

### Bug Fixes

- improve tree connectors, clamp popup scroll, and re-render on tab bar changes
- multi-step undo with tab filtering + stale detection hardening
- wizard index and theme step improvements
- use wrapper scripts instead of symlinks in Homebrew formula
### Documentation

- replace dark-forge screenshot with main-1 and main-2 in mintlify docs
- replace dark-forge screenshot with main-1 and main-2 in README
### Features

- adaptive footer layout with tier-based label fitting
- merge consecutive tool segments, add theme wizard options, skip cold diagnostics
### Other

- v1.3.0
### Performance

- route intelligence operations through worker thread
- offload file reads to worker thread, reduce main-thread blocking
### Refactor

- tighten exports, improve edit robustness, and add past-tense tool labels
- unify tool management, remove dead code, improve multi-edit
### Testing

- skip auto-format in edit tests via setFormatCache helper
## [1.2.0] — 2026-03-29

### Bug Fixes

- dynamic parser discovery for bundled binary, fallback bun path for LSP installer
## [1.1.1] — 2026-03-29

### Bug Fixes

- run install steps synchronously in quiet mode (fixes Homebrew killing bg jobs)
## [1.1.0] — 2026-03-29

### Bug Fixes

- detect user shell for PATH config, support fish/ksh/bash/zsh
- add --quiet flag to install.sh for Homebrew, skip shell RC and animations
- show subcommands in /font help description
- wizard UI improvements and bundle script updates
## [1.0.0] — 2026-03-29

### Documentation

- correct tool/theme/command counts, fix agent roles in diagrams
## [1.0.3] — 2026-03-29

### Bug Fixes

- **analytics**: fix sales report bugs, add date filtering, add API routes
- wire agent-managed tools, rename DEFERRED_TOOL_CATALOG, fix npm publish docs
- correct neovim linux arm64 asset name
- npm pack tar extraction on macOS, tolerate published versions
- use npm pack for cross-platform native deps, retry uploads
- patch dynamic platform import in bundled JS before compile
- cross-platform bundle — stub native libs for compiled binaries
- use available CI runners for all platforms
- npm registry, publish workflow, and build plugin fixes
- dead barrel detection for Python packages\n\n- isForbidden() returned truthy when uninitialized, causing collectFiles()\n  to skip all files and break repo map indexing in tests\n- Dead barrel edge check now excludes sibling files within the same\n  package directory (e.g. core.py → __init__.py is internal, not external)\n- Fallback ref check also excludes refs from files inside the barrel dir
- worker thread missing initForbidden — scan found 0 files
- wait-for-repomap UX + timeout increase
- sync symbol cache on IntelligenceClient for buildSymbolLookup
- shell guard no longer blocks code strings in node -e / python -c
- token-budget-only pruning for forge, z.preprocess coercion for numeric tool params
- enable pruning
- TabBar mode label reads stale registry on Ctrl+D cycle
- project format action uses dedicated formatter instead of lint+fix
- StatusDashboard bar alignment and popup width
- StatusDashboard data matches topbar, bar style improved
- remove misleading ^K hint from InputBox
- remove deprecated baseUrl, fix web-search agent callback types
- remove non-null assertions in intelligence router
- move Soul Map from message pair to system block, memoize LlmSelector rows
- add compaction to NESTED_KEYS, replace last scattered keepRecent default
- seed compaction defaults in DEFAULT_CONFIG
- centralize compaction defaults, LlmSelector fetch timeout
- await flushPromise on close, .aiignore hot reload, soul tool warnings, first-run hint, headless model fallback logging
- LSP race dedup, failedServer cooldown, shell env filtering, config hardening, UX guards
- reindexTimer cleanup, dynamic tool guidance, config dir hardening, agent-bus tests
- add action descriptions to soul_impact and subagent soul_analyze/soul_impact
- final claim sweep — correct all stale numbers across README and docs
- claim verification — correct all README/docs numbers, wire OpenRouter provider
- contested file edit stops agent, faster claim release, lock icon cleanup
- tool registration audit — remove invalid entries, add missing tools
- reduce dispatch token waste — scarier description, strip rejected attempts
- reject single-task dispatch, disable desloppify/verify by default, fix /changes per-tab
- secure auth system in little_backend
- close audit gaps — subagent shell claims, compound pre-checks, test coverage
- cross-tab coordination hardening — git blocking, cache staleness, agent sweep
- smoother text streaming, forge mode per-tab, edit tool cleanup
- tab bar lock icon formatting, add trailing newline
- deduplicate multi_edit result display, fix completed time not showing
- lint — replace non-null assertion with guard clause
- tab numbering in context popup, planning effort level, enriched API error messages
- prevent CI timeout on read-file outline test
- lint errors and add tabId to subagent explore tools type
- prevent steering message bar from wrapping to two lines
- scope tasks to owning tab, add attention indicator for pending input
- robust parent agent re-read blocking with full invalidation
- extract human-readable output from edit tool results in message history
- bump subagent step limits +3 to compensate for forced final step
- prevent NoObjectGeneratedError on subagent final step
- increase timeout for read-file outline tests to prevent CI flakiness
- add explicit return in useEffect to satisfy strict typecheck
- increase timeout for read-file outline tests to prevent CI flakiness
- show edit results inline in tool call displays
- async session saves, agent improvements, reasoning block & UI fixes
- report directory creation in edit_file output
- auto-create parent directories when edit_file creates new files
- relax circuit breaker threshold for dispatch agents
- wire checkAndClaim into buildTools edit_file/multi_edit (was missing)
- add leading slash to claims command registrations
- remove duplicate plan message injection in useChat
- downgrade zod for structured outputs consistency
- update paste handlers to use PasteEvent.bytes API
- fix tabs: ctrl-based shortcuts, event propagation, bulletproof close cleanup

- Rebind all tab operations from Meta (unreachable in terminals) to Ctrl:
  Ctrl+T new tab, Ctrl+W close tab, Ctrl+[/] prev/next, Ctrl+1-9 switch
- Add consume() helper — stopPropagation + preventDefault on every global
  shortcut so child components never see them (fixes Ctrl+T toggling
  collapsed plans)
- Ctrl+O now toggles all expand/collapse (code + reasoning + plans) via
  new toggleAllExpanded() store action
- Bulletproof tab close: abort() no longer short-circuits on compaction,
  resolves pending plan review promises, useChat unmount effect kills
  streaming/compaction/agents, TabInstance unmount clears forbidden
  patterns and plan files on disk, useTabs calls abort() unconditionally
- Update HelpPopup, command registry, README, GETTING_STARTED docs
- Deps bump, agent runner/results improvements, project tool linter
  coverage, loading status split rendering, tab bar styling, license
  tightening

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- deep re-export chains, FTS rebuild, pruning input mutation
- edit_file rich errors with lineStart, editor auto-open and file navigation
- two-pass ref resolution, Python normalization bug, buildEdges precision
- LLM semantic summaries UI consistency
- repo map live updates for neovim user saves and shell commands
- remove ghost recall tool refs, fix token ratio consistency, WSM cap
- salvage partial results from failed dispatch agents
- repo map import specifier extraction, refs priority, steering render bug
- improve dispatch agent collaboration — context-aware desloppify/verifier, file overlap warnings
- reduce flush interval 150ms→50ms, remove 100ms throttle — real-time UI updates
- remove startTransition from streaming flush — was deferring UI updates indefinitely causing frozen display
- tasks always resolve — complete on success, reset on error/abort, taskId for per-agent updates
- auto-complete in-progress tasks when agent finishes streaming
- Ctrl+X abort preserves partial chat content instead of clearing it\n\nSnapshot liveToolCallsBuffer and streamSegmentsBuffer before abort()\nclears them, so the catch block can reconstruct in-flight tool calls\nand partial assistant messages. Previously the buffers were empty by\nthe time the catch block ran, causing content to vanish on cancel.
- alphabetize /help and autocomplete commands, add 7 missing entries to help
- dispatch UI freeze — mark toolCallsDirty on agent stats + multi-agent events so streaming display updates during dispatch
- steering flush includes in-progress tool calls — shows progress before steering message
- StatusIcon shows warning for failed tool results
- dedupe installed skills by name, prefer project-scoped over global
- project tool reports lint warnings as failures — agent sees issues and can auto-fix
- SystemBanner useMemo exhaustive deps
- SystemBanner hooks after early return, rename icon to bannerIcon
- lint — move biome-ignore comments to correct lines
- wrap all raw numbers in String() for OpenTUI text compatibility
- wrap hiddenCount in String() — OpenTUI rejects raw numbers as text children
- nudge-aware tokenStop eliminates race condition where a single step could jump past both nudge threshold and stopWhen budget
- UI stability — stop scroll leaks, timer blink, reasoning duplication, picker cursor drift
- update step-utils tests for cache-aware pruning + done removal
- dispatch cache bugs + subagent fallback + forge pruning revert
- dispatch cache bugs + subagent fallback + forge pruning revert
- flush token display on finish-step, rename dispatch agents label
- async plugin bootstrap on first editor launch
- update Mason registry URL — moved from raw content to release artifacts
- prevent UI freeze during repo map indexing
- ContextBar content preserved across re-renders via ref
- git commit modal background, update /commit description
- complete modal stacking fix for toggleModal and openCommandPicker
- modal stacking, transient renders, keyboard early returns, scan throttle
- show dark red border on input during loading/compaction instead of invisible gray
- ContextBar token reset on modal open, repo-map picker live updates, scan progress labels
- health check readSymbol probe picks valid identifier name
- tree-sitter grammar for ALL typescript/tsx files — no tree-sitter-typescript.wasm exists
- tree-sitter tsx grammar lookup in findImports/findExports/getFileOutline + wider diagnose popup
- tree-sitter tsx grammar mismatch + smarter health check readSymbol probe
- improve steering message injection — drain all queued messages at once, stronger framing
- ASCII fallback icons for all providers, remove hardcoded Nerd Font glyph
- teach subagents to use startLine/endLine when task provides line ranges\n\nAdds WORKFLOW hint to explore and code agent prompts: when the dispatch\ntask includes line numbers, use read_file with startLine/endLine to\nbypass the 500-line truncation cap and get exact content.\n\nAlso removes fixresearch.md — all fixes verified as implemented.
- dispatch UI — late agent seeding, broken tree connectors, render storms
- strip contextManagement from subagent provider options
- steering race conditions — abort gate, ref sync, postAction queue drain
- add missing @openrouter/ai-sdk-provider dependency
- SQLite "database is locked" crash on concurrent repo map access
- SSRF protection hardening, rename-symbol comment awareness, shell path parsing
- shell timeout tests — fallback resolve after SIGKILL, bump test timeout
- CI test failures — git default branch, clone dirs, spawn timeout
- lint issues and add test step to CI
### Documentation

- add theme attribution credits
- audit and polish Mintlify documentation
- add Mintlify documentation site
- add Mintlify documentation site
- expand README comparison table with full intelligence stack
- full license compliance audit
- update third-party licenses for LazyVim migration
- add cross-tab coordination doc, fix commands-reference
- fix help popup — add missing commands, remove mislabeled entry
- fix wrong claims, update counts, add missing features
- update README with new headless CLI flags
- update README and repo-map docs for universal language support
- roadmap — SoulForge intelligence as library, MCP server, headless CLI
- command reference (60 commands), expanded security, docs index
- update contact email and website in license files
- fix Vercel Gateway and Proxy provider info + links
- fix ECC link, remove false Claude Code inspiration claim
- fix provider table — links, correct env vars, LLM Gateway description
- add inspirations section — Aider, Claude Code, ECC, AI SDK, Neovim
- honest comparison table against Claude Code, Copilot CLI, Aider
- sharpen differentiators, add hero screenshot, roadmap
- fix architecture diagrams, add hero screenshot, deep-dive links
- comprehensive README with logo, mermaid diagrams, feature deep-dives
- update readme and relevant docs
- slim README to highlights with deep dive links
- comprehensive documentation overhaul and architecture deep dives
### Features

- **little_backend**: add search, enrich products, fix notifications
- add X-Source header to LLM Gateway requests
- floating terminals, 22 builtin themes, install script, edit-stack API fix
- terminals panel, worker bundling, dispatch role transitions, headless fixes
- add floating terminal, ghostty integration, command restructuring & theme fixes
- theme system, UI rebrand, docs refresh, and headless color updates
- add ASCII visualization guidance to plan & architect modes\n\n- Architect mode now instructs use of dependency graphs, comparison\n  tables, box diagrams, and flow charts for design analysis\n- Plan mode (both full and light) presents visual file change summaries\n  and dependency diagrams before calling the plan tool
- tab bar UX improvements and subagent fix\n\n- Hide model label in tab when it matches the default model\n- Restyle tab model labels with brackets and move after edit count\n- Fix explore subagent provider options not being stripped for mini-forge
- extended git tools, mini-forge dispatch display, tab UX improvements
- first-run wizard, UI polish, and toolchain improvements
- per-model cost breakdown with accurate multi-provider pricing
- /lsp now opens full management popup with disable/enable support
- max file cap for repo map — 10k file limit with git recency prioritization
- worker architecture — intelligence & IO workers, async FS migration, RPC framework
- cache-safe architecture, accurate cost tracking, tools management
- repo map toggle, shared tool schemas, zod 4 + biome bump
- distinct UI for code execution (node -e, bun -e, python -c, etc.)
- token optimization — two-layer pruning, subagent context management, slim dispatch output
- parallel tool display, multi-edit line tracking, cache breakpoints, scan animation + fixes
- editing model routing, tool-loop detection, scan animation, pruning toggle + bug fixes
- release infrastructure, changelog config, and skills lock update
- release infrastructure, install docs overhaul, OpenRouter support, and UX improvements
- redesign /changes sidebar with tree connectors and git status
- command palette, popup consolidation, and UX overhaul
- modular per-family prompt system, Soul Map as user message, streaming fixes
- dispatch overhaul, token optimization, LSP-first tiers, key priority
- agent editor access control, /export all diagnostic, text drip streaming, repo map always-on
- LazyVim editor, multi-lang LSP warmup, headless markdown rendering, UI unification
- integrate shiki + marked for syntax highlighting and markdown rendering
- semantic summaries, multi-lang LSP warmup, repo map UX overhaul
- model picker refresh, binary detection, tool & UI improvements
- cross-platform bundle, version sync, lint fixes
- LazyVim editor, async repo map, multi-provider proxy, tool grouping
- add project format action — explicit alternative to lint --fix
- cross-tab coordination hardening — shell guards, prompt guidance, dispatch gates, memory safety
- dispatch reliability — auto-split oversized tasks + complexity warnings
- mechanical re-read blocking for parent agent read_file
- export clipboard, per-tab expand state, reasoning context, input history fix
- subagent step limits, coordinator hardening, and test improvements
- post-edit formatter integration — authoritative indent fix
- WorkspaceCoordinator cross-tab file coordination (Tier 2 Soft Claims)
- add disablePruning option and "disabled" compaction strategy
- headless --chat multi-turn mode, session resume, SIGINT cleanup
- modular headless CLI, undo stack for all edit tools
- instruction files system, headless events/mode/timeout, InputBox history improvements
- custom providers, InputBox paste/history improvements, headless provider support
- read_file outline mode for large code files, InputBox history fixes
- merge read_code into read_file, soul_grep dep search, textarea input, headless CLI, mtime cache invalidation\n\n- Merge read_code tool into read_file via target/name params (delete read-code.ts)\n- Update all references across agents, prompts, intercepts, tool display (~15 files)\n- soul_grep: add dep param to search node_modules/vendor dirs with --no-ignore\n- InputBox: replace <input> + InputEditor with native <textarea> from @opentui/core\n  - Paste collapse (4+ lines → placeholder, ^E toggle)\n  - History navigation with isNavigatingHistory guard\n  - Proper visual line tracking for char-wrap height\n- Headless CLI mode: --headless, --list-providers, --list-models, --set-key\n- Read tracker: mtime-based cache invalidation (re-read if file changed on disk)\n- Docs: CLI flags in README/CLAUDE.md, headless.md documentation
- add call graph, fix ref resolution, filter non-code refs
- semantic summaries — merged AST+LLM mode, smart targeting, lazy regen, token tracking
- comprehensive unused_exports with dead files, barrels, clusters, test-only detection
- CommonJS exports, export * wildcards, Go modules, tsconfig paths
- source-resolved refs for precise unused export detection
- expose repo map data — top files, packages, symbol signatures, symbol-by-kind queries
- universal language support for repo map, dead code accuracy improvements
- ReadTracker, skill injection, dispatch returnFormat
- link tasks to dispatch agents via taskId — auto-updates on agent start/done/error
- add /keys command — manage LLM provider API keys from UI
- steering flush + LSP fixes + forge improvements
- project tool — raw mode skips preset flags, failure hints suggest raw: true for version issues
- legacy flag fallback for lint fix — auto-retries with older syntax on unknown-flag errors
- extend project lint fix support — oxlint, dart, swiftlint, hlint, gofmt, clippy allow-dirty
- fix subagent budget, skills loading, task UI, context drop, stop logging
- expand LSP server registry — 30+ servers, auto-discovered from PATH/Mason
- context-aware subagent limits — no step caps, proportional token thresholds
- remove done tool — output schema is the sole structured result mechanism
- Output schema for guaranteed structured subagent results
- cap 5 files per explore agent — auto-split large tasks for done reliability
- guaranteed done results — auto-synthesize DoneToolResult when agents exhaust steps
- question-driven tool routing + grep→navigate code hint
- prohibition-style prompts — FORBIDDEN enforcement + turnover discipline
- strip markdown formatting from system prompt — save tokens
- cache-aware pruning — skip tool result compaction when context is low
- token efficiency overhaul — dispatch contract, done-call fixes, system prompt split, outline filtering
- token optimization — forge-level pruning, escalating read nudges, richer summaries
- verification specialist, auto mode, dispatch quality, compaction UX
- dispatch validation gates + destructive action approval + compaction fix
- nerd font auto-detection, UI polish, chat export, bundle improvements
- project toolchain hardening, pre-commit checks, monorepo discovery, v2 compaction improvements
- co-author shell injection, LSP uninstall UI, biome lint fixes
- add uninstall for soulforge-installed LSP servers
- LSP backend — implement findImports, findExports, getFileOutline, readSymbol
- intelligence health check — /diagnose command probes all backends
- LSP installer with Mason registry, refactor name-based extraction, context bar improvements
- quickfix list, terminal output capture, editor event wiring
- neovim deep integration, pane splitting, git improvements, UI polish
- new editor tools, fix co-author email, update readiness doc
- new neovim editor tools + few subtle fixes
- extract editor layout module, improve editor panel UX and performance
- auto-install fd + lazygit, add licenses, extract UI components
- add concrete read_file hint in edit error output
- auto-enrich dispatch tasks with symbol line ranges from repo map
- user steering, abort cleanup, shell abort signals, task reset, breakage tests
- production hardening, outside-CWD security, open-source readiness
- tool consolidation, clone detection, system prompt scaling, UI cleanup
- UI refinements — blue user accent, message padding, queued message display
- title-only memory, boot spinner, splash polish, safety fixes, 1M context windows
- token optimization — slim subagent prompts, tighter pruning, progressive dispatch UI
- UI polish — bordered input, user msg backgrounds, collapsible errors/plans, history fixes
- ECC-enforced dispatch improvements, scoped model selection, UI rendering fixes
- llmgateway provider, site link extraction, shell read-redirect, plan mode polish
- unified web access approval gate for fetch_page + EventTarget listener fix
- rolling tool result pruning with repo-map symbol enrichment
- isolated tabs, smooth streaming, borderless input, icon centralization
- responsive UI, popup overlays, /lsp command, boot granularity, web search fixes, dispatch thresholds
- v2 compaction, git branch/stash ops, SSRF protection, agent bus hardening, and comprehensive test suite
- context compaction, plan view overhaul, persistent system messages, and broad refinements
- repo map intelligence, compound tools, web scraper, and Ink → OpenTUI migration
- multi-tab chat, parallel agent dispatch, and provider config system
### Miscellaneous

- add SHA256SUMS.txt checksum generation to release workflow
- untrack .agents/skills, remove stale homebrew/ copy
- wrap tab bar indicators in brackets\n\n- Edited file count, unread dot, and error markers now use bracket styling\n- Consistent visual language across all tab bar indicators
- upgrade deps
- remove completed/obsolete improvement docs
- add HTML coverage report script
- add test coverage reporting + lcov artifact upload
- biome formatting — normalize imports, indentation, line wrapping
- fix lint formatting across refactored files
- fix lint errors from dead code removal (trailing blank lines, let→const)
- delete PlanView.tsx (dead file), remove dead exports from splash.ts and types/index.ts
- remove 43 dead exports, delete highlight.ts (fully dead file)
- remove 10 dead files (780 lines)
- fix biome formatting across 5 files
- remove JetBrains Mono from bundle, keep Symbols Only
- biome format fixes
### Other

- pre-cost-breakdown checkpoint + misc improvements
- worker architecture (phases 0-3) into main
- Revert "chore: remove completed/obsolete improvement docs"

This reverts commit f9643524c3aeea760905e2a055ba8fe71f15eb42.
- rename abbreviated types and fields in little_backend/

Types: Usr→User, Prod→Product, Ord→Order, Sess→Session
Fields: nm→name, pr→price, stk→stock, tok→token, uid→userId,
        pid→productId, tot→total, st→status
Functions: getUsr→getUser, mkUsr→createUser, getProd→getProduct,
           mkProd→createProduct, updStk→updateStock, mkOrd→createOrder,
           getOrd→getOrder, usrOrds→getUserOrders, chkAdmin→checkAdmin,
           listProds→listProducts, sendTxt→sendText,
           validateUsr→validateUser, validateProd→validateProduct,
           validateOrd→validateOrder

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- wire dead code (validate/middleware) and fix bugs

- Import and use validateUser/validateProduct from validate.ts in god.ts
- Import and use authMiddleware/adminMiddleware from middleware.ts in god.ts
- Wire rateLimit into processRequest in index.ts
- Fix login: use local users Map instead of globalThis
- Fix doCheckout race condition: single-loop with rollback on stock failure
- Fix p.stk → p.stock and tot → total to match types
- Move logRequest after handle() call (skip logging rate-limited requests)

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- reset little_backend: god object, bad names, buried bugs (round 3)
- reset little_backend test arena to clean buggy state (round 3)
- reset little_backend test arena to clean buggy state
- add Forge label to assistant message header
- tab-scoped tasks, cache hardening, agent retry, prompt tightening
- move skills injection before tool guidance for better positional attention

Skills are user-chosen behavioral directives that were previously appended
at the very bottom of the system prompt — the attention dead zone between
mode instructions and the Soul Map data dump. Now they inject right after
identity + project info, before the tool guidance wall, where they compete
for attention with core behavioral rules.

Matches ECC/Claude Code finding on positional weight in system prompts.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- compaction v2 default, new tab label, soul_find guidance, agent retry improvements

- Make compaction v2 the default strategy across App, useChat, statusbar, types
- Update /compaction command descriptions to reflect new default
- Show "New tab" label for freshly created tabs instead of empty string
- Improve soul_find tool description to discourage generic queries
- Add soul_find guidance in context manager for specific identifier usage
- Pass abortSignal to isRetryable to skip retries on user-initiated abort
- Treat "aborted" errors as retryable network failures
- Increase agent step timeout from 180s to 300s
- Fix biome formatting in tools/index.ts

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- enable prompt caching for tool schemas

Mark the last tool in the tools object with cache_control ephemeral
so the Anthropic API caches the entire tools array as part of the
stable prefix (system prompt + tools). Verified the full chain:

  tool.providerOptions → AI SDK prepareToolsAndToolChoice (passes through)
  → @ai-sdk/anthropic prepareTools → validator.getCacheControl
  → cache_control field on AnthropicTool → API request

With 26+ tools at ~500 bytes each, this saves re-processing ~12k tokens
of tool schemas on every step after the first. Uses 1 of the 2 remaining
cache breakpoints (Anthropic allows 4, we use 2 for system+messages).
- compaction v2: make default, skip gap-fill when state is rich, add tests

- Default strategy v1 → v2: 75% cheaper per compaction (2k tokens vs 8k),
  better data visibility (sees full tool results before pruning)
- Skip LLM gap-fill when WSM has ≥15 slots — incremental extraction
  already captured the context, gap-fill usually returns "COMPLETE"
- 32 tests covering WSM state tracking, extraction pipeline (tool calls,
  tool results, user messages, assistant messages), serialization,
  buildV2Summary, and full integration cycle
- cap omitted findings file list, add agent-results tests

- Limit omitted findings file list to 10 names (prevents unbounded
  growth when agent has many findings)
- 51 tests for agent-results: formatDoneResult, synthesizeDoneFromResults,
  extractDoneResult, buildFallbackResult
- tighten dispatch synthesis: max 5 findings displayed, halve synthesis budget

- MAX_FINDINGS_DISPLAY = 5: cap findings shown in formatDoneResult,
  omitted findings listed as file paths only
- SYNTHESIS_BUDGET 8000 → 4000: less raw file content dumped when
  agent doesn't call done (common case)
- Worst case per agent now: 5 × 500 + 500 summary ≈ 3k chars
- 4-agent dispatch: ~12k typical (was 30-40k before all changes)
- reduce dispatch content echo: cap finding detail + truncate task text

- Cap per-finding detail to 500 chars in formatDoneResult (was unlimited
  from agent done calls, 2000 from synthesis). Main agent can read_file
  for full content. Saves ~1-4k per agent result.
- Truncate task text to first line (200 chars) in multi-agent sections.
  Main agent already knows what it dispatched — the enriched prompt with
  file outlines, peer findings, and dependency results was pure echo.
- Combined with existing 24KB toModelOutput cap, dispatch results are
  now bounded at: 4 agents × (500 summary + 500/finding × ~5 findings)
  ≈ 12-16k chars typical, vs 30-40k before.
- cap individual file size at 512KB
- shell compress: tee original on significant compression for agent recovery

- Export saveTee from tee.ts for direct use
- compressShellOutputFull returns {text, original} — original set when
  compression removed significant content (>10% reduction)
- Shell tool: saves original to tee file, appends [full output: path]
  so agent can cat the file if it needs uncompressed details
- Project tool: same tee-on-compress behavior
- Follows RTK pattern: zero inline tokens for noise, full recovery via disk
- token optimization: strip dispatch skill echo, compress shell output, cap dispatch size

- Strip "--- Relevant skill: ---" blocks from dispatch toModelOutput (main
  agent already has skills in system prompt, echoing saves 30-40k/dispatch)
- Cap dispatch output at 24KB with clean truncation
- Replace misleading "All file content included below" with read_file hint
- Add language-agnostic shell output compressor (shell-compress.ts):
  - Collapses passing test lines (jest/pytest/go/rust/TAP)
  - Truncates stack traces to 5 frames (JS/Python/Java/Rust/Ruby/C#/Go)
  - Suppresses progress bars and download noise
  - Collapses repeated similar lines (lint warnings, build output)
  - 60-80% reduction on typical test/build output
- Wire compressor into shell + project tools (runs before truncation)
- 21 tests covering all major language ecosystems
- add output truncation, max-columns, and source map exclusions
- UI polish: fix loading counter flicker, horizontal prompts, adaptive streaming, tab UX

LoadingStatus: fix elapsed counter and ghost icon flashing during streaming
by preserving imperative ref state across re-renders (elapsedSecRef, ghostTickRef)

QuestionPrompt & PlanReviewPrompt: horizontal button bar layout with left/right
navigation, remove verbose vertical option lists

TabBar: bracket-style tab indicators [1] with colored states for loading/error/unread

Streaming: adaptive chunking (line-based in code fences, word-based in prose),
coalesce rapid flush intervals (MIN_FLUSH_INTERVAL_MS = 30)

Tab management: confirm before closing busy tabs (Ctrl+W and /close),
proper activity state via useState, abort in-flight chats on session restore

Sessions: sync listSessions/totalSizeBytes (remove unnecessary async),
simplified sessionDirSize

Misc: collapse diffs by default (Ctrl+O toggles), remove 'Forge' label from
assistant messages, prefer direct action over plans in system prompt,
fix session builder tab matching, simplify permission prompt options

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- auto-dismiss task progress after all tasks complete

TaskProgress now hides after a 3s linger when all tasks are
done/blocked, instead of persisting indefinitely.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- add missing tool display entries (multi_edit, undo_edit, list_dir, rename_file)

Previously these tools had no category, icon, label, or formatArgs entry,
so they'd show as bare tool names with no file path in the UI.

Now multi_edit/undo_edit/list_dir show [file] badge + file path,
and rename_file shows [code] badge + from → to path.

Also includes steering message truncation in MessageList.

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- harden agent bus, async repo-map scan, remove dead code

agent-bus.ts:
- Wrap all waiter notifications in try/catch via notifyWaiters()
- Wrap onCacheEvent/onToolCacheEvent callbacks in try/catch
- Add 300s timeout to file and tool result waiters to prevent hangs
- Skip self-waits when same agent re-reads a file it's already reading

repo-map:
- Convert collectFiles to async (fs/promises readdir/stat)
- Yield to event loop every 50 files during collection
- Yield more frequently during indexing (every 5 files vs 10)
- Add tick() calls between resolve/build/compute phases
- Pre-read file contents outside DB transaction in buildCallGraph
- Use imported readFileSync instead of require("node:fs")

context/manager.ts:
- Remove redundant repoMap.clear() before scan (scan handles it)

dead code removal:
- Remove unused exports: BASE_DELAY_MS, MAX_RETRIES,
  RETURN_FORMAT_INSTRUCTIONS, isRetryable (agent-runner.ts)
- Remove unused exports: DESLOPPIFY_PROMPT, VERIFY_PROMPT
  (agent-verification.ts)
- Remove dead functions: toolOk, catchToolError (tool-utils.ts)

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- improve repo map cross-language quality and reduce ref noise

Repo map improvements:
- Add COMMON_LOCAL_NAMES filter (~120 ubiquitous variable names like
  name, path, file, text, content, result, key, args) that are never
  meaningful cross-file references — eliminates ~18% of ref noise
- Raise min identifier length from 3→4 chars (3-char ids are noise)
- Expand IDENTIFIER_KEYWORDS with comprehensive builtins for Python,
  Rust, Go, Java, C/C++, PHP, Ruby, Elixir, Lua, Zig, Solidity, Dart
  and English stopwords that leak from comments
- Add import resolution for Java/Kotlin packages (com.foo.Bar → path),
  PHP namespaces (App\Models → path), Ruby lib/ prefix convention
- Expand isResolvable to flag Java/Kotlin/PHP imports for deferred
  resolution
- Add more resolveRelPath candidates: lib.rs, .go, index.php
- Relax resolveIdentifierRefs: resolve unique exports directly without
  requiring an existing import edge (use local symbol shadow check
  instead to prevent false positives)

Results (this codebase):
- Total refs: 37,710 → 30,944 (-18%)
- Call resolution: 97.9% → 100%
- Noise refs eliminated: ~6,800 common local names filtered
- Top unresolved are now project-specific (types, react, opentui)
  instead of generic words (name, path, file, text)

Other changes in this commit:
- LSP: multi-server support per language (e.g. biome + tsserver)
- LSP: findServersForLanguage returns all available servers
- LSP: diagnostics merge from all servers with dedup
- Subagent: handle NoObjectGeneratedError from AI SDK v6
- Memory: tighten tool description to write-only-when-asked

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- bundled distribution, investigate agents, dispatch UI overhaul
- fix AGPL references across codebase to BSL 1.1
- switch from AGPL-3.0 to Business Source License 1.1
- Add proxy provider, code intelligence tools, and UI refinements

Proxy provider:
- Add CLIProxyAPI as a grouped LLM provider with auto-install/start lifecycle
- Add /proxy, /proxy login, /proxy install commands
- Generalize gateway-only model selector to support any grouped provider
- Replace useGatewayModels with useGroupedModels hook

Code intelligence:
- Add intelligence router with ts-morph, tree-sitter, regex, and LSP backends
- Add navigate, read_code, refactor, and analyze tools for static analysis
- Add post-edit diagnostics to edit_file tool
- Add tree-sitter-wasms, ts-morph, web-tree-sitter dependencies

UI:
- Redesign ReasoningBlock with rail styling and braille spinner
- Simplify HealthCheck from table to inline layout
- Add GhostLogo component
- Add noAltScreen option for suspend (OAuth login flow)

Streaming:
- Handle error parts in stream to surface API failures
- Fall back gracefully on NoOutputGeneratedError
- Save full tool call history in sessions instead of text-only
- Fix table overflow in chat — constrain columns to terminal width

Tables now measure available width and shrink columns proportionally
when they would overflow. Cell text is truncated with ellipsis instead
of pushing other columns off screen.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- Update README and Getting Started guide

README now links to GETTING_STARTED.md. Getting Started rewritten
with current features, accurate config, Nerd Font setup, privacy
commands, plan mode, and updated troubleshooting.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- Add CI workflow for lint and typecheck

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- v2.0.0 — open-source refactor

- AGPL-3.0-only license
- Provider registry: adding an LLM provider is now 1 file + 2 lines
- Shared UI: deduplicated Spinner, PopupRow, tool display across 11+ components
- App.tsx decomposition: extracted commands, StreamSegmentList, RightSidebar (2349 → 1535 lines)
- Barrel exports for core/, hooks/, components/
- Rewrote README and CONTRIBUTING for open-source contributors
- Fixed all lint warnings (no any, exhaustive deps, template literals)
- Fixed GitCommitModal coAuthor prop

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- v1 - initial commit
### Performance

- audit fixes — granular modal selectors, store selectors, concurrency guard, listener cleanup
- audit fixes — smoothStream factory, unmount cleanup, abort-aware retry, error handling, memo & memoization
- comprehensive React performance audit — 21 fixes across 25+ files
### Refactor

- prompt updates, async DiffView, compaction return type, cost breakdown improvements
- UI polish, context bar simplification, repo map token budget, worker memory tracking, lint fixes & test updates
- collapse re-export symbols in repo map render
- remove shell search redirect gate\n\nRemove checkSearchAntiPattern and the blocking redirect layer that\nprevented shell from running grep/cat/find commands. This gate was\noverly aggressive and incorrectly blocked legitimate git and shell\noperations. The softer post-success hints in shell.ts are retained.
- clean up stream options, subagent tools, tab instance, and context manager\n\nCo-Authored-By: SoulForge <soulforge@proxysoul.com>
- fix dumb tests, reduce plan eagerness, clean up truncation messages
- production-grade codebase cleanup — remove noise, deduplicate, tighten exports
- production-grade codebase restructure
- production-grade codebase restructure
- remove ReadTracker (re-read prevention at tool execution time)
- ReadTracker replaces RecallStore, remove dead code, cleanup agent wiring
- centralize language detection — single EXT_TO_LANGUAGE map in types.ts
### Testing

- test

Co-Authored-By: SoulForge <soulforge@proxysoul.com>
- comprehensive tests for format detection across 18 ecosystems
- comprehensive tests for WorkspaceCoordinator and tool-wrapper
- comprehensive edge cases for custom providers
- comprehensive edge case tests for unused export detection
- update .vue extension test — now correctly detected as 'vue' via centralized map

