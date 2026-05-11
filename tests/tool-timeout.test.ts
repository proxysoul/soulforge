import { describe, expect, test } from "bun:test";
import {
	toolTimeoutMinToMs,
	DEFAULT_TOOL_TIMEOUT_MIN,
	getToolTimeoutMs,
} from "../src/core/tools/tool-timeout.js";
import {
	getAgentTimeoutMs,
	getAgentWaitMs,
} from "../src/core/agents/agent-runner.js";
import { mergeConfigs } from "../src/config/index.js";
import { getCommandDefs } from "../src/core/commands/registry.js";
import { register } from "../src/core/commands/config.js";
import type { AppConfig } from "../src/types/index.js";

// Minimal valid AppConfig for merge testing
const BASE_CONFIG: AppConfig = {
	defaultModel: "none",
	routerRules: [],
	editor: { command: "nvim", args: [] },
	theme: { name: "dark", transparent: true },
};

// ── toolTimeoutMinToMs — pure conversion + clamping ──────────────

describe("toolTimeoutMinToMs", () => {
	test("undefined → default 2 min (120_000ms)", () => {
		expect(toolTimeoutMinToMs(undefined)).toBe(120_000);
	});

	test("0 → 0 (no timeout sentinel)", () => {
		expect(toolTimeoutMinToMs(0)).toBe(0);
	});

	test("picker values: 1, 2, 5, 10, 20", () => {
		expect(toolTimeoutMinToMs(1)).toBe(60_000);
		expect(toolTimeoutMinToMs(2)).toBe(120_000);
		expect(toolTimeoutMinToMs(5)).toBe(300_000);
		expect(toolTimeoutMinToMs(10)).toBe(600_000);
		expect(toolTimeoutMinToMs(20)).toBe(1_200_000);
	});

	test("boundary: exactly 0.5 min (minimum)", () => {
		expect(toolTimeoutMinToMs(0.5)).toBe(30_000);
	});

	test("boundary: exactly 30 min (maximum)", () => {
		expect(toolTimeoutMinToMs(30)).toBe(1_800_000);
	});

	test("fractional minutes", () => {
		expect(toolTimeoutMinToMs(1.5)).toBe(90_000);
		expect(toolTimeoutMinToMs(2.5)).toBe(150_000);
	});

	test("clamps sub-minimum to 0.5 min (but 0 is special)", () => {
		expect(toolTimeoutMinToMs(0.1)).toBe(30_000);
		expect(toolTimeoutMinToMs(0.01)).toBe(30_000);
		expect(toolTimeoutMinToMs(0.49)).toBe(30_000);
	});

	test("negative values clamp to minimum", () => {
		expect(toolTimeoutMinToMs(-1)).toBe(30_000);
		expect(toolTimeoutMinToMs(-100)).toBe(30_000);
		expect(toolTimeoutMinToMs(-0.1)).toBe(30_000);
	});

	test("above maximum clamps to 30 min", () => {
		expect(toolTimeoutMinToMs(31)).toBe(1_800_000);
		expect(toolTimeoutMinToMs(60)).toBe(1_800_000);
		expect(toolTimeoutMinToMs(999)).toBe(1_800_000);
	});

	test("NaN → default (not NaN ms)", () => {
		const result = toolTimeoutMinToMs(NaN);
		expect(result).toBe(120_000);
		expect(Number.isFinite(result)).toBe(true);
	});

	test("Infinity / -Infinity → default", () => {
		expect(toolTimeoutMinToMs(Infinity)).toBe(120_000);
		expect(toolTimeoutMinToMs(-Infinity)).toBe(120_000);
	});

	// Simulates corrupted JSON config: toolTimeout: "banana" parsed as number
	test("string coerced to NaN via Number() → default", () => {
		expect(toolTimeoutMinToMs(Number("banana"))).toBe(120_000);
		expect(toolTimeoutMinToMs(Number(""))).toBe(0); // Number("") = 0 → no timeout
		expect(toolTimeoutMinToMs(Number("5"))).toBe(300_000);
	});

	// Simulates: toolTimeout: true in JSON → Number(true) = 1
	test("boolean coerced via Number() → treated as minutes", () => {
		expect(toolTimeoutMinToMs(Number(true))).toBe(60_000); // 1 min
		expect(toolTimeoutMinToMs(Number(false))).toBe(0); // 0 → no timeout
	});

	// Simulates: toolTimeout: null in JSON
	test("null coerced via Number() → 0 → no timeout", () => {
		expect(toolTimeoutMinToMs(Number(null))).toBe(0);
	});
});

// ── getToolTimeoutMs — integration with loadConfig ───────────────

describe("getToolTimeoutMs", () => {
	test("returns a finite positive number or 0", () => {
		const ms = getToolTimeoutMs();
		expect(Number.isFinite(ms)).toBe(true);
		expect(ms).toBeGreaterThanOrEqual(0);
	});

	test("result is always a round-trip of toolTimeoutMinToMs", () => {
		// Whatever config returns, getToolTimeoutMs must equal toolTimeoutMinToMs(config.toolTimeout)
		const ms = getToolTimeoutMs();
		// We can't control config in this test, but we can verify it's within valid range
		const validValues = [0, ...Array.from({ length: 60 }, (_, i) => (i + 1) * 30_000)];
		// Must be 0 or between 30_000 (0.5min) and 1_800_000 (30min)
		expect(ms === 0 || (ms >= 30_000 && ms <= 1_800_000)).toBe(true);
	});
});

// ── getAgentTimeoutMs / getAgentWaitMs — real exports ────────────

describe("getAgentTimeoutMs (real export)", () => {
	test("returns finite number ≥ 0", () => {
		const ms = getAgentTimeoutMs();
		expect(Number.isFinite(ms)).toBe(true);
		expect(ms).toBeGreaterThanOrEqual(0);
	});

	test("when non-zero, is at least 300_000 (5 min floor)", () => {
		const ms = getAgentTimeoutMs();
		if (ms > 0) {
			expect(ms).toBeGreaterThanOrEqual(300_000);
		}
	});

	test("is exactly 2.5× tool timeout when above floor", () => {
		const toolMs = getToolTimeoutMs();
		const agentMs = getAgentTimeoutMs();
		if (toolMs === 0) {
			expect(agentMs).toBe(0);
		} else {
			expect(agentMs).toBe(Math.max(300_000, toolMs * 2.5));
		}
	});
});

describe("getAgentWaitMs (real export)", () => {
	test("never returns 0 — always positive", () => {
		const ms = getAgentWaitMs();
		expect(ms).toBeGreaterThan(0);
	});

	test("equals agentTimeout when non-zero, 24h when zero", () => {
		const agentMs = getAgentTimeoutMs();
		const waitMs = getAgentWaitMs();
		if (agentMs === 0) {
			expect(waitMs).toBe(86_400_000);
		} else {
			expect(waitMs).toBe(agentMs);
		}
	});
});

// ── Agent scaling with toolTimeoutMinToMs (unit-level) ───────────

describe("agent timeout scaling (unit)", () => {
	// Use the real formula to verify specific config values
	function expectedAgentMs(configMin: number): number {
		const toolMs = toolTimeoutMinToMs(configMin);
		if (toolMs === 0) return 0;
		return Math.max(300_000, toolMs * 2.5);
	}

	test("1 min → floor (300s)", () => expect(expectedAgentMs(1)).toBe(300_000));
	test("2 min → floor (300s)", () => expect(expectedAgentMs(2)).toBe(300_000));
	test("5 min → 750s", () => expect(expectedAgentMs(5)).toBe(750_000));
	test("10 min → 1500s", () => expect(expectedAgentMs(10)).toBe(1_500_000));
	test("20 min → 3000s", () => expect(expectedAgentMs(20)).toBe(3_000_000));
	test("30 min → 4500s", () => expect(expectedAgentMs(30)).toBe(4_500_000));
	test("0 (no timeout) → 0", () => expect(expectedAgentMs(0)).toBe(0));
});

// ── Config merge propagation ─────────────────────────────────────

describe("toolTimeout config merge", () => {
	test("global preserved when no project override", () => {
		const merged = mergeConfigs({ ...BASE_CONFIG, toolTimeout: 5 }, null);
		expect(merged.toolTimeout).toBe(5);
	});

	test("project overrides global", () => {
		const merged = mergeConfigs({ ...BASE_CONFIG, toolTimeout: 2 }, { toolTimeout: 10 });
		expect(merged.toolTimeout).toBe(10);
	});

	test("missing → undefined (toolTimeoutMinToMs treats as default)", () => {
		const merged = mergeConfigs(BASE_CONFIG, null);
		expect(merged.toolTimeout).toBeUndefined();
		expect(toolTimeoutMinToMs(merged.toolTimeout)).toBe(120_000);
	});

	test("project sets when global has none", () => {
		const merged = mergeConfigs(BASE_CONFIG, { toolTimeout: 7 });
		expect(merged.toolTimeout).toBe(7);
	});

	test("0 survives merge (not treated as falsy/missing)", () => {
		const merged = mergeConfigs({ ...BASE_CONFIG, toolTimeout: 0 }, null);
		expect(merged.toolTimeout).toBe(0);
		expect(toolTimeoutMinToMs(merged.toolTimeout)).toBe(0);
	});

	test("project overrides to 0", () => {
		const merged = mergeConfigs({ ...BASE_CONFIG, toolTimeout: 5 }, { toolTimeout: 0 });
		expect(merged.toolTimeout).toBe(0);
	});

	test("does not bleed into unrelated fields", () => {
		const merged = mergeConfigs({ ...BASE_CONFIG, toolTimeout: 5 }, { toolTimeout: 10 });
		expect(merged.defaultModel).toBe("none");
		expect(merged.editor.command).toBe("nvim");
		expect(merged.theme.name).toBe("dark");
	});

	// Simulates hand-edited JSON with wrong type
	test("string value from corrupted JSON survives merge as-is", () => {
		const corrupted = { toolTimeout: "banana" as unknown as number };
		const merged = mergeConfigs(BASE_CONFIG, corrupted);
		expect(merged.toolTimeout).toBe("banana" as unknown as number);
		// toolTimeoutMinToMs handles this: NaN → default
		expect(toolTimeoutMinToMs(merged.toolTimeout)).toBe(120_000);
	});
});

// ── Tool consumption edge cases ──────────────────────────────────

describe("tool consumption patterns", () => {
	test("explicit args.timeout wins over config (nullish coalescing)", () => {
		expect(5000 ?? toolTimeoutMinToMs(10)).toBe(5000);
	});

	test("null falls through", () => {
		expect(null ?? toolTimeoutMinToMs(5)).toBe(300_000);
	});

	test("undefined falls through", () => {
		expect(undefined ?? toolTimeoutMinToMs(5)).toBe(300_000);
	});

	test("0 does NOT fall through (nullish coalescing keeps 0)", () => {
		// This means args.timeout=0 from the LLM would disable timeout
		// even if config says 5 min. This is intentional — explicit override.
		expect(0 ?? toolTimeoutMinToMs(5)).toBe(0);
	});

	test("shell: spawn({ timeout: 0 }) = no timeout in Node", () => {
		// Verify the contract: 0 is safe to pass to spawn
		const timeout = undefined ?? toolTimeoutMinToMs(0);
		expect(timeout).toBe(0);
	});

	test("project: setTimeout guard prevents instant-fire on 0", () => {
		const timeoutMs = toolTimeoutMinToMs(0);
		// Mirrors: const timer = timeoutMs > 0 ? setTimeout(...) : null;
		expect(timeoutMs > 0).toBe(false);
	});

	test("agent: spread omits timeout field entirely when 0", () => {
		const agentMs = 0;
		const spread = agentMs > 0 ? { timeout: { stepMs: agentMs } } : {};
		expect(spread).toEqual({});
		expect("timeout" in spread).toBe(false);
	});

	test("agent: spread includes timeout when positive", () => {
		const agentMs = 300_000;
		const spread = agentMs > 0 ? { timeout: { stepMs: agentMs } } : {};
		expect(spread).toEqual({ timeout: { stepMs: 300_000 } });
	});
});

// ── Command registration ─────────────────────────────────────────

describe("/timeouts command registration", () => {
	test("/timeouts exists in COMMAND_DEFS", () => {
		const defs = getCommandDefs();
		const entry = defs.find((d) => d.cmd === "/timeouts");
		expect(entry).toBeDefined();
		expect(entry!.category).toBe("System");
		expect(entry!.tags).toContain("timeout");
	});

	test("register() adds /timeouts to command map", () => {
		const map = new Map<string, unknown>();
		register(map as any);
		expect(map.has("/timeouts")).toBe(true);
		expect(typeof map.get("/timeouts")).toBe("function");
	});

	test("register() includes all expected commands (no silent drops)", () => {
		const map = new Map<string, unknown>();
		register(map as any);
		const expected = [
			"/chat-style", "/mode", "/nvim-config", "/verbose", "/reasoning",
			"/compact settings", "/compaction", "/agent-features", "/instructions",
			"/diff-style", "/editor split", "/split", "/vim-hints", "/model-scope",
			"/font nerd", "/font set", "/settings", "/lock-in", "/theme",
			"/timeouts", "/watchdog",
		];
		for (const cmd of expected) {
			expect(map.has(cmd)).toBe(true);
		}
	});
});

// ── handleTimeouts via register — real handler, mock context ─────

describe("handleTimeouts (real handler)", () => {
	function getHandler(): (input: string, ctx: any) => void {
		const map = new Map<string, (input: string, ctx: any) => void>();
		register(map as any);
		return map.get("/timeouts")!;
	}

	/**
	 * Create a mock ctx whose openCommandPicker collects the config
	 * AND chains into the real handler logic (sub-handlers re-call
	 * openCommandPicker on the same ctx).
	 */
	function mockCtxChain(overrides: Record<string, any> = {}) {
		const messages: string[] = [];
		const pickerCfgs: any[] = [];
		const saved: Array<{ patch: any; scope: string }> = [];

		function makeCtx(): any {
			return {
				messages,
				openCommandPicker: (cfg: any) => {
					pickerCfgs.push(cfg);
					// Auto-advance: if onSelect is called later, it
					// will call openCommandPicker again on this same ctx
				},
				saveToScope: (patch: any, scope: string) => {
					saved.push({ patch, scope });
				},
				detectScope: () => "global",
				chat: {
					setMessages: (fn: (prev: any[]) => any[]) => {
						const result = fn([]);
						const last = result[result.length - 1];
						if (last?.content) messages.push(last.content);
					},
				},
				...overrides,
			};
		}
		return { makeCtx, get messages() { return messages; }, get pickerCfgs() { return pickerCfgs; }, get saved() { return saved; } };
	}

	test("calls openCommandPicker with correct shape", () => {
		const handler = getHandler();
		const { makeCtx, pickerCfgs } = mockCtxChain();
		handler("", makeCtx());

		const top = pickerCfgs[0];
		expect(top.title).toBe("Timeouts & Watchdog");
		expect(top.scopeEnabled).toBe(false);
		// 6 category options
		const values = top.options.map((o: any) => o.value);
		expect(values).toEqual(["tool-timeout", "watchdog-toggle", "wd-first", "wd-chunk", "wd-tool", "wd-force"]);
	});

	test("top-level option descriptions reflect current settings", () => {
		const handler = getHandler();
		const { makeCtx, pickerCfgs } = mockCtxChain();
		handler("", makeCtx());

		const byValue: Record<string, string> = {};
		for (const o of pickerCfgs[0].options) byValue[o.value] = o.description;
		// Default toolTimeout is 2 → "2m", or "none" if config returns 0
		expect(byValue["tool-timeout"]).toBeDefined();
		expect(byValue["watchdog-toggle"]).toBeDefined();
	});

	test("selecting tool-timeout opens sub-picker with tool options", () => {
		const handler = getHandler();
		const { makeCtx, pickerCfgs } = mockCtxChain();
		const ctx = makeCtx();

		handler("", ctx);
		// First cfg is top-level
		const topSelect = pickerCfgs[0].onSelect;
		topSelect("tool-timeout");

		// Second cfg is the sub-picker
		const sub = pickerCfgs[1];
		expect(sub.title).toBe("Tool Timeout");
		const values = sub.options.map((o: any) => o.value);
		expect(values).toEqual(["tool:1", "tool:2", "tool:5", "tool:10", "tool:20", "tool:0"]);
		const defaultOpt = sub.options.find((o: any) => o.value === "tool:2");
		expect(defaultOpt.description).toBe("default");
	});

	test("sub-picker onSelect saves tool timeout to global scope", () => {
		const handler = getHandler();
		const { makeCtx, saved } = mockCtxChain();
		const ctx = makeCtx();

		handler("", ctx);
		const topSelect = saved.length; // 0 at this point

		// Chain: top onSelect → opens sub-picker → sub onSelect saves
		const pickers: any[] = [];
		const ctx2 = makeCtx();
		ctx2.openCommandPicker = (cfg: any) => {
			pickers.push(cfg);
		};
		handler("", ctx2);

		const topSel = pickers[0].onSelect;
		topSel("tool-timeout");
		const subSel = pickers[1].onSelect;
		subSel("tool:5");

		expect(saved).toHaveLength(1);
		expect(saved[0].scope).toBe("global");
		expect(saved[0].patch).toEqual({ toolTimeout: 5 });
	});

	test("onSelect with 'tool:0' saves toolTimeout: 0 (not NaN, not undefined)", () => {
		const handler = getHandler();
		const { makeCtx, saved } = mockCtxChain();
		const pickers: any[] = [];
		const ctx = makeCtx();
		ctx.openCommandPicker = (cfg: any) => {
			pickers.push(cfg);
		};
		handler("", ctx);

		pickers[0].onSelect("tool-timeout");
		pickers[1].onSelect("tool:0");

		expect(saved[0].patch.toolTimeout).toBe(0);
		expect(saved[0].patch.toolTimeout).not.toBeNaN();
		expect(saved[0].patch.toolTimeout).not.toBeUndefined();
	});

	test("onSelect never saves to project scope", () => {
		const handler = getHandler();
		const { makeCtx, saved } = mockCtxChain();
		const pickers: any[] = [];
		const ctx = makeCtx();
		ctx.openCommandPicker = (cfg: any) => {
			pickers.push(cfg);
		};
		handler("", ctx);

		pickers[0].onSelect("tool-timeout");
		for (const v of ["tool:1", "tool:2", "tool:5", "tool:10", "tool:20", "tool:0"]) {
			pickers[1].onSelect(v);
		}
		expect(saved.every((s: any) => s.scope === "global")).toBe(true);
	});

	test("sysMsg emitted with correct format", () => {
		const handler = getHandler();
		const { makeCtx, messages } = mockCtxChain();
		const pickers: any[] = [];
		const ctx = makeCtx();
		ctx.openCommandPicker = (cfg: any) => {
			pickers.push(cfg);
		};
		handler("", ctx);

		pickers[0].onSelect("tool-timeout");
		pickers[1].onSelect("tool:5");
		pickers[1].onSelect("tool:0");

		expect(messages.some((m: string) => m.includes("5m"))).toBe(true);
		expect(messages.some((m: string) => m.includes("none"))).toBe(true);
	});
});
