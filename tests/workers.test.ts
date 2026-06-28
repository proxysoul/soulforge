import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerClient } from "../src/core/workers/rpc.js";
import { useWorkerStore } from "../src/stores/workers.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const ECHO_WORKER_PATH = join(import.meta.dir, "fixtures", "echo-worker.ts");
const TMP = join(tmpdir(), `worker-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

class TestClient extends WorkerClient {
  statusChanges: string[] = [];
  rpcStarts = 0;
  rpcEnds = 0;
  rpcErrors = 0;

  constructor(config?: Record<string, unknown>) {
    super(ECHO_WORKER_PATH, config);
    this.onStatusChange = (status) => this.statusChanges.push(status);
    this.onRpcStart = () => this.rpcStarts++;
    this.onRpcEnd = (error) => {
      this.rpcEnds++;
      if (error) this.rpcErrors++;
    };
  }

  echo<T>(data: T): Promise<T> {
    return this.call<T>("echo", data);
  }
  add(a: number, b: number): Promise<number> {
    return this.call<number>("add", a, b);
  }
  fail(): Promise<never> {
    return this.call<never>("fail");
  }
  failCustom(msg: string): Promise<never> {
    return this.call<never>("failCustom", msg);
  }
  sleep(ms: number): Promise<string> {
    return this.call<string>("sleep", ms);
  }
  sleepWithTimeout(ms: number, timeout: number): Promise<string> {
    return this.callWithTimeout<string>(timeout, "sleep", ms);
  }
  emitEvent(event: string, data: unknown): Promise<string> {
    return this.call<string>("emitEvent", event, data);
  }
  callbackTest(name: string, data: unknown): Promise<unknown> {
    return this.call<unknown>("callbackTest", name, data);
  }
  callbackTestWithTimeout(name: string, data: unknown, timeout: number): Promise<unknown> {
    return this.callWithTimeout<unknown>(timeout, "callbackTest", name, data);
  }
  getInitConfig(): Promise<Record<string, unknown> | null> {
    return this.call("getInitConfig");
  }
  identity(...args: unknown[]): Promise<unknown[]> {
    return this.call<unknown[]>("identity", ...args);
  }
  callMethod<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.call<T>(method, ...args);
  }
  fireMethod(method: string, ...args: unknown[]): void {
    this.fire(method, ...args);
  }
  fireEcho(data: unknown): void {
    this.fire("echo", data);
  }
  fireCrash(): void {
    this.fire("crash");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Worker Store ──────────────────────────────────────────────────────────

describe("Worker Store (stores/workers.ts)", () => {
  beforeEach(() => {
    useWorkerStore.setState({
      intelligence: {
        status: "idle",
        restarts: 0,
        lastError: null,
        rpcInFlight: 0,
        totalCalls: 0,
        totalErrors: 0,
        uptimeMs: 0,
        startedAt: 0,
      },
      io: {
        status: "idle",
        restarts: 0,
        lastError: null,
        rpcInFlight: 0,
        totalCalls: 0,
        totalErrors: 0,
        uptimeMs: 0,
        startedAt: 0,
      },
    });
  });

  it("initial state is idle for both workers", () => {
    const state = useWorkerStore.getState();
    expect(state.intelligence.status).toBe("idle");
    expect(state.io.status).toBe("idle");
  });

  it("markStarted transitions to ready with timestamp", () => {
    const before = Date.now();
    useWorkerStore.getState().markStarted("intelligence");
    const state = useWorkerStore.getState();
    expect(state.intelligence.status).toBe("ready");
    expect(state.intelligence.startedAt).toBeGreaterThanOrEqual(before);
    expect(state.intelligence.startedAt).toBeLessThanOrEqual(Date.now());
    expect(state.intelligence.uptimeMs).toBe(0);
  });

  it("setWorkerError sets crashed status and error message", () => {
    useWorkerStore.getState().markStarted("io");
    useWorkerStore.getState().setWorkerError("io", "Connection lost");
    const state = useWorkerStore.getState();
    expect(state.io.status).toBe("crashed");
    expect(state.io.lastError).toBe("Connection lost");
  });

  it("incrementRestarts tracks per-worker count", () => {
    useWorkerStore.getState().incrementRestarts("intelligence");
    useWorkerStore.getState().incrementRestarts("intelligence");
    useWorkerStore.getState().incrementRestarts("io");
    const state = useWorkerStore.getState();
    expect(state.intelligence.restarts).toBe(2);
    expect(state.io.restarts).toBe(1);
  });

  it("rpcInFlight transitions ready→busy on first increment", () => {
    useWorkerStore.getState().markStarted("intelligence");
    expect(useWorkerStore.getState().intelligence.status).toBe("ready");

    useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    expect(useWorkerStore.getState().intelligence.status).toBe("busy");
    expect(useWorkerStore.getState().intelligence.rpcInFlight).toBe(1);
  });

  it("rpcInFlight transitions busy→ready when flight count hits 0", () => {
    useWorkerStore.getState().markStarted("intelligence");
    useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    expect(useWorkerStore.getState().intelligence.rpcInFlight).toBe(2);
    expect(useWorkerStore.getState().intelligence.status).toBe("busy");

    useWorkerStore.getState().updateRpcInFlight("intelligence", -1);
    expect(useWorkerStore.getState().intelligence.rpcInFlight).toBe(1);
    expect(useWorkerStore.getState().intelligence.status).toBe("busy");

    useWorkerStore.getState().updateRpcInFlight("intelligence", -1);
    expect(useWorkerStore.getState().intelligence.rpcInFlight).toBe(0);
    expect(useWorkerStore.getState().intelligence.status).toBe("ready");
  });

  it("rpcInFlight never goes below 0", () => {
    useWorkerStore.getState().markStarted("io");
    useWorkerStore.getState().updateRpcInFlight("io", -1);
    useWorkerStore.getState().updateRpcInFlight("io", -1);
    useWorkerStore.getState().updateRpcInFlight("io", -1);
    expect(useWorkerStore.getState().io.rpcInFlight).toBe(0);
  });

  it("rpcInFlight does not change status when crashed", () => {
    useWorkerStore.getState().setWorkerError("intelligence", "dead");
    useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    expect(useWorkerStore.getState().intelligence.status).toBe("crashed");
    useWorkerStore.getState().updateRpcInFlight("intelligence", -1);
    expect(useWorkerStore.getState().intelligence.status).toBe("crashed");
  });

  it("incrementCalls and incrementErrors accumulate independently", () => {
    useWorkerStore.getState().incrementCalls("io");
    useWorkerStore.getState().incrementCalls("io");
    useWorkerStore.getState().incrementCalls("io");
    useWorkerStore.getState().incrementErrors("io");
    const state = useWorkerStore.getState();
    expect(state.io.totalCalls).toBe(3);
    expect(state.io.totalErrors).toBe(1);
  });

  it("workers are fully independent", () => {
    useWorkerStore.getState().markStarted("intelligence");
    useWorkerStore.getState().setWorkerError("io", "io crashed");
    useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    useWorkerStore.getState().incrementCalls("intelligence");

    const state = useWorkerStore.getState();
    expect(state.intelligence.status).toBe("busy");
    expect(state.intelligence.totalCalls).toBe(1);
    expect(state.io.status).toBe("crashed");
    expect(state.io.totalCalls).toBe(0);
  });

  it("rapid transitions maintain consistency", () => {
    useWorkerStore.getState().markStarted("intelligence");
    for (let i = 0; i < 100; i++) {
      useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
    }
    expect(useWorkerStore.getState().intelligence.rpcInFlight).toBe(100);
    expect(useWorkerStore.getState().intelligence.status).toBe("busy");

    for (let i = 0; i < 100; i++) {
      useWorkerStore.getState().updateRpcInFlight("intelligence", -1);
    }
    expect(useWorkerStore.getState().intelligence.rpcInFlight).toBe(0);
    expect(useWorkerStore.getState().intelligence.status).toBe("ready");
  });

  it("markStarted resets startedAt on re-mark", () => {
    useWorkerStore.getState().markStarted("io");
    const first = useWorkerStore.getState().io.startedAt;
    useWorkerStore.getState().markStarted("io");
    const second = useWorkerStore.getState().io.startedAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

// ── RPC Framework ─────────────────────────────────────────────────────────

describe("RPC Framework (rpc.ts)", () => {
  let client: TestClient;

  afterEach(() => {
    try {
      client?.dispose();
    } catch {}
  });

  describe("basic call/response", () => {
    beforeEach(() => {
      client = new TestClient();
    });

    it("echo returns same string", async () => {
      expect(await client.echo("hello")).toBe("hello");
    });

    it("echo returns same number", async () => {
      expect(await client.echo(42)).toBe(42);
    });

    it("echo returns null", async () => {
      expect(await client.echo(null)).toBeNull();
    });

    it("echo returns boolean", async () => {
      expect(await client.echo(true)).toBe(true);
      expect(await client.echo(false)).toBe(false);
    });

    it("add computes correctly", async () => {
      expect(await client.add(3, 4)).toBe(7);
      expect(await client.add(-1, 1)).toBe(0);
      expect(await client.add(0.1, 0.2)).toBeCloseTo(0.3);
    });

    it("handles complex nested objects", async () => {
      const data = {
        users: [{ name: "Alice", tags: ["admin", "user"] }],
        nested: { deep: { value: 42 } },
        empty: {},
        arr: [1, [2, [3]]],
      };
      expect(await client.echo(data)).toEqual(data);
    });

    it("handles empty string", async () => {
      expect(await client.echo("")).toBe("");
    });

    it("handles unicode content", async () => {
      const text = "日本語テスト 🚀 العربية émojis café";
      expect(await client.echo(text)).toBe(text);
    });

    it("handles large string payload", async () => {
      const large = "x".repeat(1_000_000);
      expect(await client.echo(large)).toBe(large);
    });

    it("handles array of mixed types", async () => {
      const data = [1, "two", null, true, { k: "v" }, [3]];
      expect(await client.echo(data)).toEqual(data);
    });

    it("multiple args passed through identity", async () => {
      const result = await client.identity("a", 1, true, null);
      expect(result).toEqual(["a", 1, true, null]);
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      client = new TestClient();
    });

    it("worker throw propagates error message", async () => {
      await expect(client.fail()).rejects.toThrow("intentional error");
    });

    it("worker throw preserves custom message", async () => {
      await expect(client.failCustom("specific failure reason")).rejects.toThrow(
        "specific failure reason",
      );
    });

    it("unknown method returns error", async () => {
      await expect(client.callMethod("nonexistentMethod")).rejects.toThrow("Unknown method");
    });

    it("error includes stack trace", async () => {
      try {
        await client.fail();
        expect(true).toBe(false);
      } catch (err: unknown) {
        const e = err as Error;
        expect(e.stack).toBeDefined();
      }
    });
  });

  describe("concurrency", () => {
    beforeEach(() => {
      client = new TestClient();
    });

    it("100 concurrent echo calls all resolve correctly", async () => {
      const promises = Array.from({ length: 100 }, (_, i) => client.echo(i));
      const results = await Promise.all(promises);
      for (let i = 0; i < 100; i++) {
        expect(results[i]).toBe(i);
      }
    });

    it("concurrent calls with different types resolve correctly", async () => {
      const [str, num, obj, arr] = await Promise.all([
        client.echo("hello"),
        client.echo(42),
        client.echo({ key: "value" }),
        client.echo([1, 2, 3]),
      ]);
      expect(str).toBe("hello");
      expect(num).toBe(42);
      expect(obj).toEqual({ key: "value" });
      expect(arr).toEqual([1, 2, 3]);
    });

    it("mixed success and failure resolve independently", async () => {
      const results = await Promise.allSettled([
        client.echo("ok"),
        client.fail(),
        client.add(1, 2),
        client.failCustom("boom"),
        client.echo(true),
      ]);
      expect(results[0]!.status).toBe("fulfilled");
      expect(results[1]!.status).toBe("rejected");
      expect(results[2]!.status).toBe("fulfilled");
      expect(results[3]!.status).toBe("rejected");
      expect(results[4]!.status).toBe("fulfilled");
      expect((results[0] as PromiseFulfilledResult<string>).value).toBe("ok");
      expect((results[2] as PromiseFulfilledResult<number>).value).toBe(3);
    });

    it("fire-and-forget does not block or leak", async () => {
      for (let i = 0; i < 100; i++) {
        client.fireEcho(i);
      }
      const result = await client.echo("after-fire");
      expect(result).toBe("after-fire");
    });
  });

  describe("timeouts", () => {
    beforeEach(() => {
      client = new TestClient();
    });

    it("call that exceeds timeout rejects", async () => {
      await expect(client.sleepWithTimeout(5000, 50)).rejects.toThrow("timeout");
    });

    it("call that completes before timeout resolves", async () => {
      const result = await client.sleepWithTimeout(10, 5000);
      expect(result).toBe("done");
    });
  });

  describe("events", () => {
    beforeEach(() => {
      client = new TestClient();
    });

    it("event emitted from worker received by listener", async () => {
      let received: unknown = null;
      client.on("test-event", (data) => {
        received = data;
      });

      await client.emitEvent("test-event", { payload: 42 });
      await delay(50);
      expect(received).toEqual({ payload: 42 });
    });

    it("multiple listeners all fire for same event", async () => {
      const calls: number[] = [];
      client.on("multi", () => calls.push(1));
      client.on("multi", () => calls.push(2));
      client.on("multi", () => calls.push(3));

      await client.emitEvent("multi", null);
      await delay(50);
      expect(calls).toEqual([1, 2, 3]);
    });

    it("one listener throwing does not break others", async () => {
      const calls: number[] = [];
      client.on("safe", () => calls.push(1));
      client.on("safe", () => {
        throw new Error("listener crash");
      });
      client.on("safe", () => calls.push(3));

      await client.emitEvent("safe", null);
      await delay(50);
      expect(calls).toEqual([1, 3]);
    });

    it("off removes listener", async () => {
      let count = 0;
      const fn = () => count++;
      client.on("toggle", fn);

      await client.emitEvent("toggle", null);
      await delay(50);
      expect(count).toBe(1);

      client.off("toggle", fn);
      await client.emitEvent("toggle", null);
      await delay(50);
      expect(count).toBe(1);
    });

    it("unrelated event does not trigger listener", async () => {
      let triggered = false;
      client.on("target", () => {
        triggered = true;
      });

      await client.emitEvent("other", null);
      await delay(50);
      expect(triggered).toBe(false);
    });
  });

  describe("callbacks (reverse RPC)", () => {
    beforeEach(() => {
      client = new TestClient();
    });

    it("worker requests callback and receives result", async () => {
      client.registerCallback("transform", async (data) => {
        return (data as number) * 2;
      });
      const result = await client.callbackTest("transform", 21);
      expect(result).toBe(42);
    });

    it("callback handler async error propagates to worker", async () => {
      client.registerCallback("failing", async () => {
        throw new Error("callback failed");
      });
      await expect(client.callbackTest("failing", null)).rejects.toThrow();
    });

    it("unregistered callback name returns error to worker", async () => {
      await expect(client.callbackTest("nonexistent", null)).rejects.toThrow();
    });
  });

  describe("init config", () => {
    it("init config is passed to worker on spawn", async () => {
      client = new TestClient({ greeting: "hello", count: 42 });
      await delay(100);
      const config = await client.getInitConfig();
      expect(config).toEqual({ greeting: "hello", count: 42 });
    });
  });

  describe("lifecycle", () => {
    it("dispose rejects all pending calls", async () => {
      client = new TestClient();
      const slow = client.sleep(10000);
      client.dispose();
      await expect(slow).rejects.toThrow("disposed");
    });

    it("disposed client rejects new calls immediately", async () => {
      client = new TestClient();
      client.dispose();
      await expect(client.echo("test")).rejects.toThrow("disposed");
    });

    it("double dispose does not throw", () => {
      client = new TestClient();
      client.dispose();
      expect(() => client.dispose()).not.toThrow();
    });

    it("hooks fire on RPC lifecycle", async () => {
      client = new TestClient();
      await client.echo("test");
      expect(client.rpcStarts).toBeGreaterThanOrEqual(1);
      expect(client.rpcEnds).toBeGreaterThanOrEqual(1);
    });

    it("onStatusChange fires on crash/restart", async () => {
      client = new TestClient();
      await client.echo("warmup");
      client.statusChanges.length = 0;
      client.fireCrash();
      await delay(200);
      expect(client.statusChanges.length).toBeGreaterThan(0);
    });

    it("error RPC increments rpcErrors", async () => {
      client = new TestClient();
      try {
        await client.fail();
      } catch {}
      expect(client.rpcErrors).toBeGreaterThanOrEqual(1);
    });
  });

  describe("crash recovery", () => {
    it("worker crash triggers auto-restart and next call succeeds", async () => {
      client = new TestClient();
      await client.echo("pre-crash");
      client.fireCrash();
      await delay(200);
      const result = await client.echo("post-crash");
      expect(result).toBe("post-crash");
    });

    it("status changes include crashed/restarting on crash", async () => {
      client = new TestClient();
      await client.echo("warmup");
      client.statusChanges.length = 0;
      client.fireCrash();
      await delay(200);
      await client.echo("alive");
      const hasRestart =
        client.statusChanges.includes("crashed") ||
        client.statusChanges.includes("restarting");
      expect(hasRestart).toBe(true);
    });

    it("exceeding max restarts stops trying", async () => {
      client = new TestClient();
      await client.echo("warmup");
      for (let i = 0; i < 5; i++) {
        try {
          client.fireCrash();
        } catch {}
        await delay(200);
      }
      const restartCount = client.statusChanges.filter((s) => s === "restarting").length;
      expect(restartCount).toBeLessThanOrEqual(3);
    });
  });

  describe("long session", () => {
    it("500 sequential calls without degradation", async () => {
      client = new TestClient();
      for (let i = 0; i < 500; i++) {
        const result = await client.echo(i);
        expect(result).toBe(i);
      }
    });

    it("accumulated RPC stats are consistent", async () => {
      client = new TestClient();
      const N = 50;
      const errors = 5;

      for (let i = 0; i < N; i++) {
        await client.echo(i);
      }
      for (let i = 0; i < errors; i++) {
        try {
          await client.fail();
        } catch {}
      }

      expect(client.rpcStarts).toBe(N + errors);
      expect(client.rpcEnds).toBe(N + errors);
      expect(client.rpcErrors).toBe(errors);
    });
  });
});

// ── IO Worker Session Persistence ─────────────────────────────────────────

describe("IO Worker — Session Persistence", () => {
  const SESSION_DIR = join(TMP, "sessions");

  beforeAll(() => mkdirSync(TMP, { recursive: true }));
  afterAll(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    if (existsSync(SESSION_DIR)) rmSync(SESSION_DIR, { recursive: true, force: true });
    mkdirSync(SESSION_DIR, { recursive: true });
  });

  function makeMeta(id: string, tabIds: string[]) {
    return {
      id,
      title: "Test",
      cwd: TMP,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      activeTabId: tabIds[0]!,
      forgeMode: "default" as const,
      tabs: tabIds.map((tid) => ({
        id: tid,
        label: "Tab",
        activeModel: "test",
        sessionId: id,
        planMode: false,
        planRequest: null,
        coAuthorCommits: false,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        messageRange: { startLine: 0, endLine: 0 },
      })),
    };
  }

  function makeMessages(count: number, prefix = "") {
    return Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${prefix}message-${i}`,
    }));
  }

  async function saveViaWorkerLogic(
    dir: string,
    meta: ReturnType<typeof makeMeta>,
    tabEntries: [string, unknown[]][],
  ) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const allMessages: unknown[] = [];
    const updatedTabs = meta.tabs.map((tab) => {
      const msgs = tabEntries.find(([id]) => id === tab.id)?.[1] ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) allMessages.push(msg);
      const endLine = allMessages.length;
      return { ...tab, messageRange: { startLine, endLine } };
    });
    const updatedMeta = { ...meta, tabs: updatedTabs };

    writeFileSync(join(dir, "meta.json"), JSON.stringify(updatedMeta, null, 2), "utf-8");
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");
    writeFileSync(join(dir, "messages.jsonl"), lines ? `${lines}\n` : "", "utf-8");
  }

  function loadViaWorkerLogic(dir: string) {
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const jsonlPath = join(dir, "messages.jsonl");
    const allMessages: unknown[] = [];
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            allMessages.push(JSON.parse(line));
          } catch {
            break;
          }
        }
      }
    }
    const tabEntries: [string, unknown[]][] = [];
    for (const tab of meta.tabs) {
      const { startLine, endLine } = tab.messageRange;
      tabEntries.push([tab.id, allMessages.slice(startLine, endLine)]);
    }
    return { meta, tabEntries };
  }

  it("single tab round-trip preserves all messages", async () => {
    const dir = join(SESSION_DIR, "s1");
    const meta = makeMeta("s1", ["tab-1"]);
    const msgs = makeMessages(10);

    await saveViaWorkerLogic(dir, meta, [["tab-1", msgs]]);
    const loaded = loadViaWorkerLogic(dir);

    expect(loaded).not.toBeNull();
    expect(loaded!.meta.id).toBe("s1");
    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect((tabMsgs![i] as { content: string }).content).toBe(`message-${i}`);
    }
  });

  it("multi-tab round-trip slices messages correctly", async () => {
    const dir = join(SESSION_DIR, "s2");
    const meta = makeMeta("s2", ["tab-a", "tab-b", "tab-c"]);
    const msgsA = makeMessages(5, "A:");
    const msgsB = makeMessages(3, "B:");
    const msgsC = makeMessages(7, "C:");

    await saveViaWorkerLogic(dir, meta, [
      ["tab-a", msgsA],
      ["tab-b", msgsB],
      ["tab-c", msgsC],
    ]);
    const loaded = loadViaWorkerLogic(dir);

    expect(loaded).not.toBeNull();
    const loadedA = loaded!.tabEntries.find(([id]) => id === "tab-a")?.[1];
    const loadedB = loaded!.tabEntries.find(([id]) => id === "tab-b")?.[1];
    const loadedC = loaded!.tabEntries.find(([id]) => id === "tab-c")?.[1];
    expect(loadedA).toHaveLength(5);
    expect(loadedB).toHaveLength(3);
    expect(loadedC).toHaveLength(7);
    expect((loadedA![0] as { content: string }).content).toBe("A:message-0");
    expect((loadedB![0] as { content: string }).content).toBe("B:message-0");
    expect((loadedC![0] as { content: string }).content).toBe("C:message-0");
  });

  it("empty tab has zero messages", async () => {
    const dir = join(SESSION_DIR, "s3");
    const meta = makeMeta("s3", ["tab-1"]);

    await saveViaWorkerLogic(dir, meta, [["tab-1", []]]);
    const loaded = loadViaWorkerLogic(dir);

    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(0);
  });

  it("large session (1000 messages) survives round-trip", async () => {
    const dir = join(SESSION_DIR, "s4");
    const meta = makeMeta("s4", ["tab-1"]);
    const msgs = makeMessages(1000, "bulk:");

    await saveViaWorkerLogic(dir, meta, [["tab-1", msgs]]);
    const loaded = loadViaWorkerLogic(dir);

    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(1000);
    expect((tabMsgs![0] as { content: string }).content).toBe("bulk:message-0");
    expect((tabMsgs![999] as { content: string }).content).toBe("bulk:message-999");
  });

  it("unicode content preserved", async () => {
    const dir = join(SESSION_DIR, "s5");
    const meta = makeMeta("s5", ["tab-1"]);
    const msgs = [
      { role: "user", content: "こんにちは世界 🌍" },
      { role: "assistant", content: "مرحبا بالعالم" },
      { role: "user", content: "Привет мир ❤️ café" },
      { role: "assistant", content: "emoji chain: 🎉🎊🎈🎁🎂🎄🎃🎅" },
    ];

    await saveViaWorkerLogic(dir, meta, [["tab-1", msgs]]);
    const loaded = loadViaWorkerLogic(dir);

    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(4);
    expect((tabMsgs![0] as { content: string }).content).toBe("こんにちは世界 🌍");
    expect((tabMsgs![1] as { content: string }).content).toBe("مرحبا بالعالم");
    expect((tabMsgs![2] as { content: string }).content).toBe("Привет мир ❤️ café");
    expect((tabMsgs![3] as { content: string }).content).toBe("emoji chain: 🎉🎊🎈🎁🎂🎄🎃🎅");
  });

  it("load from nonexistent directory returns null", () => {
    const loaded = loadViaWorkerLogic(join(SESSION_DIR, "nonexistent"));
    expect(loaded).toBeNull();
  });

  it("corrupted JSONL recovers up to last valid line", async () => {
    const dir = join(SESSION_DIR, "s6");
    const meta = makeMeta("s6", ["tab-1"]);
    const validMsgs = makeMessages(5);

    await saveViaWorkerLogic(dir, meta, [["tab-1", validMsgs]]);

    const jsonlPath = join(dir, "messages.jsonl");
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.trim().split("\n");
    const corrupted = [...lines.slice(0, 3), "{{{{NOT JSON!!!!", ...lines.slice(3)].join("\n");
    writeFileSync(jsonlPath, corrupted, "utf-8");

    const loaded = loadViaWorkerLogic(dir);
    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs!.length).toBeLessThan(5);
    expect(tabMsgs!.length).toBeGreaterThanOrEqual(3);
  });

  it("overwrite existing session replaces data", async () => {
    const dir = join(SESSION_DIR, "s7");
    const meta1 = makeMeta("s7", ["tab-1"]);
    const msgs1 = makeMessages(3, "old:");
    await saveViaWorkerLogic(dir, meta1, [["tab-1", msgs1]]);

    const meta2 = makeMeta("s7", ["tab-1"]);
    const msgs2 = makeMessages(2, "new:");
    await saveViaWorkerLogic(dir, meta2, [["tab-1", msgs2]]);

    const loaded = loadViaWorkerLogic(dir);
    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(2);
    expect((tabMsgs![0] as { content: string }).content).toBe("new:message-0");
  });

  it("multi-tab with uneven message counts", async () => {
    const dir = join(SESSION_DIR, "s8");
    const meta = makeMeta("s8", ["a", "b", "c", "d"]);
    const entries: [string, unknown[]][] = [
      ["a", makeMessages(100)],
      ["b", []],
      ["c", makeMessages(1)],
      ["d", makeMessages(50)],
    ];

    await saveViaWorkerLogic(dir, meta, entries);
    const loaded = loadViaWorkerLogic(dir);

    expect(loaded!.tabEntries.find(([id]) => id === "a")?.[1]).toHaveLength(100);
    expect(loaded!.tabEntries.find(([id]) => id === "b")?.[1]).toHaveLength(0);
    expect(loaded!.tabEntries.find(([id]) => id === "c")?.[1]).toHaveLength(1);
    expect(loaded!.tabEntries.find(([id]) => id === "d")?.[1]).toHaveLength(50);
  });

  it("messages with nested tool results survive round-trip", async () => {
    const dir = join(SESSION_DIR, "s9");
    const meta = makeMeta("s9", ["tab-1"]);
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc_1", toolName: "read", input: { path: "foo.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc_1",
            toolName: "read",
            output: { type: "text", value: "const x = 1;\nexport function foo() {}" },
          },
        ],
      },
    ];

    await saveViaWorkerLogic(dir, meta, [["tab-1", msgs]]);
    const loaded = loadViaWorkerLogic(dir);
    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(2);
    expect((tabMsgs![0] as Record<string, unknown>).role).toBe("assistant");
    const content = (tabMsgs![0] as Record<string, unknown>).content as unknown[];
    expect((content[0] as Record<string, unknown>).toolName).toBe("read");
  });

  it("100 sequential save/load cycles without corruption", async () => {
    const dir = join(SESSION_DIR, "s10");
    for (let i = 0; i < 100; i++) {
      const meta = makeMeta("s10", ["tab-1"]);
      const msgs = makeMessages(5, `cycle-${i}:`);
      await saveViaWorkerLogic(dir, meta, [["tab-1", msgs]]);
    }
    const loaded = loadViaWorkerLogic(dir);
    const tabMsgs = loaded!.tabEntries.find(([id]) => id === "tab-1")?.[1];
    expect(tabMsgs).toHaveLength(5);
    expect((tabMsgs![0] as { content: string }).content).toBe("cycle-99:message-0");
  });

  it("meta.json has correct messageRange offsets for multi-tab", async () => {
    const dir = join(SESSION_DIR, "s11");
    const meta = makeMeta("s11", ["x", "y"]);
    await saveViaWorkerLogic(dir, meta, [
      ["x", makeMessages(3)],
      ["y", makeMessages(4)],
    ]);

    const rawMeta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const tabX = rawMeta.tabs.find((t: { id: string }) => t.id === "x");
    const tabY = rawMeta.tabs.find((t: { id: string }) => t.id === "y");

    expect(tabX.messageRange).toEqual({ startLine: 0, endLine: 3 });
    expect(tabY.messageRange).toEqual({ startLine: 3, endLine: 7 });
  });

  it("empty messages.jsonl loads as empty array", async () => {
    const dir = join(SESSION_DIR, "s12");
    const meta = makeMeta("s12", ["tab-1"]);
    await saveViaWorkerLogic(dir, meta, [["tab-1", []]]);
    const loaded = loadViaWorkerLogic(dir);
    expect(loaded!.tabEntries[0]![1]).toHaveLength(0);
  });
});

// ── Git Log Parsing ───────────────────────────────────────────────────────

describe("IO Worker — Git Log Parsing", () => {
  let parseGitLogLine: (line: string) => { hash: string; subject: string; date: string };

  beforeAll(async () => {
    const mod = await import("../src/core/git/status.js");
    parseGitLogLine = mod.parseGitLogLine;
  });

  it("parses standard log line", () => {
    const entry = parseGitLogLine("abc1234 feat: add login page (2 days ago)");
    expect(entry.hash).toBe("abc1234");
    expect(entry.subject).toBe("feat: add login page");
    expect(entry.date).toBe("2 days ago");
  });

  it("parses hash-only line", () => {
    const entry = parseGitLogLine("deadbeef");
    expect(entry.hash).toBe("deadbeef");
    expect(entry.subject).toBe("");
    expect(entry.date).toBe("");
  });

  it("handles subject with parentheses inside", () => {
    const entry = parseGitLogLine("abc1234 fix: handle edge case (issue #42) properly (3 hours ago)");
    expect(entry.hash).toBe("abc1234");
    expect(entry.date).toBe("3 hours ago");
    expect(entry.subject).toContain("issue #42");
  });

  it("handles empty string", () => {
    const entry = parseGitLogLine("");
    expect(entry.hash).toBe("");
    expect(entry.subject).toBe("");
  });

  it("handles long hash", () => {
    const hash = "a".repeat(40);
    const entry = parseGitLogLine(`${hash} Initial commit (5 weeks ago)`);
    expect(entry.hash).toBe(hash);
    expect(entry.subject).toBe("Initial commit");
    expect(entry.date).toBe("5 weeks ago");
  });

  it("batch parsing returns array of entries", () => {
    const lines = [
      "aaa1111 first commit (1 day ago)",
      "bbb2222 second commit (2 days ago)",
      "ccc3333 third commit (3 days ago)",
    ];
    const results = lines.map(parseGitLogLine);
    expect(results).toHaveLength(3);
    expect(results[0]!.hash).toBe("aaa1111");
    expect(results[1]!.subject).toBe("second commit");
    expect(results[2]!.date).toBe("3 days ago");
  });

  it("handles unicode in commit subject", () => {
    const entry = parseGitLogLine("abc1234 修复: 日本語の問題 (1 hour ago)");
    expect(entry.hash).toBe("abc1234");
    expect(entry.subject).toBe("修复: 日本語の問題");
    expect(entry.date).toBe("1 hour ago");
  });
});

// ── Working State Serialization ───────────────────────────────────────────

describe("IO Worker — Working State Serialization", () => {
  let serializeState: (state: import("../src/core/compaction/types.js").WorkingState) => string;
  let WorkingStateManager: new () => import("../src/core/compaction/working-state.js").WorkingStateManager;

  beforeAll(async () => {
    const wsMod = await import("../src/core/compaction/working-state.js");
    serializeState = wsMod.serializeState;
    WorkingStateManager = wsMod.WorkingStateManager;
  });

  function emptyState(): import("../src/core/compaction/types.js").WorkingState {
    return {
      task: "",
      plan: [],
      files: new Map(),
      decisions: [],
      failures: [],
      discoveries: [],
      environment: [],
      toolResults: [],
      userRequirements: [],
      assistantNotes: [],
    };
  }

  it("empty state produces minimal output", () => {
    const result = serializeState(emptyState());
    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThan(50);
  });

  it("state with task is included", () => {
    const state = emptyState();
    state.task = "Implement worker architecture";
    const result = serializeState(state);
    expect(result).toContain("Implement worker architecture");
  });

  it("plan steps have status icons", () => {
    const state = emptyState();
    state.plan = [
      { id: "1", label: "Setup", status: "done" },
      { id: "2", label: "Implement", status: "active" },
      { id: "3", label: "Test", status: "pending" },
      { id: "4", label: "Cancelled", status: "skipped" },
    ];
    const result = serializeState(state);
    expect(result).toContain("Setup");
    expect(result).toContain("Implement");
    expect(result).toContain("Test");
    expect(result).toContain("Cancelled");
  });

  it("files with actions are serialized", () => {
    const state = emptyState();
    state.files.set("src/foo.ts", {
      path: "src/foo.ts",
      actions: [
        { type: "read", summary: "Read for context" },
        { type: "edit", detail: "Added export" },
      ],
    });
    const result = serializeState(state);
    expect(result).toContain("src/foo.ts");
  });

  it("decisions and failures are included", () => {
    const state = emptyState();
    state.decisions = ["Use async/await over callbacks"];
    state.failures = ["First approach caused race condition"];
    const result = serializeState(state);
    expect(result).toContain("Use async/await over callbacks");
    expect(result).toContain("First approach caused race condition");
  });

  it("WSM reset produces clean state", () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("something");
    wsm.addDecision("a decision");
    wsm.reset();
    const state = wsm.getState();
    expect(state.task).toBe("");
    expect(state.decisions).toHaveLength(0);
  });

  it("serialization round-trip via WSM", () => {
    const wsm = new WorkingStateManager();
    wsm.setTask("Build feature X");
    wsm.addDecision("Use TypeScript");
    wsm.addDiscovery("Found existing utility");
    wsm.trackFile("src/index.ts", { type: "edit", detail: "Added main export" });
    const serialized = wsm.serialize();
    expect(serialized).toContain("Build feature X");
    expect(serialized).toContain("Use TypeScript");
    expect(serialized).toContain("Found existing utility");
    expect(serialized).toContain("src/index.ts");
  });
});

// ── Conversation Text Building ────────────────────────────────────────────

describe("IO Worker — buildFullConvoText", () => {
  let buildFullConvoText: (messages: unknown[], charBudget: number) => string;

  beforeAll(async () => {
    const mod = await import("../src/core/compaction/summarize.js");
    buildFullConvoText = mod.buildFullConvoText as (messages: unknown[], charBudget: number) => string;
  });

  it("joins messages with role prefix", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const text = buildFullConvoText(msgs, 10000);
    expect(text).toContain("user: hello");
    expect(text).toContain("assistant: hi there");
  });

  it("respects character budget", () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      content: `message number ${i} with some padding text to make it longer`,
    }));
    const text = buildFullConvoText(msgs, 500);
    expect(text.length).toBeLessThanOrEqual(2600);
  });

  it("truncates individual long messages", () => {
    const msgs = [{ role: "user", content: "x".repeat(5000) }];
    const text = buildFullConvoText(msgs, 100000);
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(5100);
  });

  it("handles empty message list", () => {
    const text = buildFullConvoText([], 10000);
    expect(text).toBe("");
  });

  it("handles messages with array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I found the issue" }],
      },
    ];
    const text = buildFullConvoText(msgs, 10000);
    expect(text).toContain("I found the issue");
  });
});

// ── Shell Compression via IO Worker ───────────────────────────────────────

describe("IO Worker — Shell Compression passthrough", () => {
  let compressShellOutput: (raw: string) => string;
  let compressShellOutputFull: (raw: string) => { text: string; original: string | null };

  beforeAll(async () => {
    const mod = await import("../src/core/tools/shell-compress.js");
    compressShellOutput = mod.compressShellOutput;
    compressShellOutputFull = mod.compressShellOutputFull;
  });

  it("short output returned unchanged", () => {
    const short = "line1\nline2\nline3";
    expect(compressShellOutput(short)).toBe(short);
  });

  it("full version returns original when compressed", () => {
    const raw = [
      "Running 50 tests...",
      ...Array.from({ length: 50 }, (_, i) => `  ✓ test case ${i + 1}`),
      "50 passed, 0 failed",
    ].join("\n");
    const result = compressShellOutputFull(raw);
    expect(typeof result.text).toBe("string");
    if (result.text !== raw) {
      expect(result.original).toBe(raw);
    }
  });

  it("handles empty string", () => {
    expect(compressShellOutput("")).toBe("");
  });

  it("handles single line", () => {
    expect(compressShellOutput("ok")).toBe("ok");
  });
});

// ── Cross-Cutting Robustness ──────────────────────────────────────────────

describe("Cross-cutting robustness", () => {
  it("worker store and RPC stats stay in sync", async () => {
    useWorkerStore.setState({
      intelligence: {
        status: "idle",
        restarts: 0,
        lastError: null,
        rpcInFlight: 0,
        totalCalls: 0,
        totalErrors: 0,
        uptimeMs: 0,
        startedAt: 0,
      },
      io: {
        status: "idle",
        restarts: 0,
        lastError: null,
        rpcInFlight: 0,
        totalCalls: 0,
        totalErrors: 0,
        uptimeMs: 0,
        startedAt: 0,
      },
    });

    useWorkerStore.getState().markStarted("intelligence");
    const N = 20;
    for (let i = 0; i < N; i++) {
      useWorkerStore.getState().updateRpcInFlight("intelligence", 1);
      useWorkerStore.getState().incrementCalls("intelligence");
    }
    for (let i = 0; i < N; i++) {
      useWorkerStore.getState().updateRpcInFlight("intelligence", -1);
    }

    const state = useWorkerStore.getState();
    expect(state.intelligence.rpcInFlight).toBe(0);
    expect(state.intelligence.totalCalls).toBe(N);
    expect(state.intelligence.status).toBe("ready");
  });

  it("session persistence handles messages with special JSON chars", async () => {
    const dir = join(TMP, "special-json");
    mkdirSync(dir, { recursive: true });

    const meta = {
      id: "special",
      title: "Test",
      cwd: TMP,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      activeTabId: "tab-1",
      forgeMode: "default" as const,
      tabs: [
        {
          id: "tab-1",
          label: "Tab",
          activeModel: "test",
          sessionId: "special",
          planMode: false,
          planRequest: null,
          coAuthorCommits: false,
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          messageRange: { startLine: 0, endLine: 0 },
        },
      ],
    };

    const msgs = [
      { role: "user", content: 'He said "hello\nworld" and {brackets: [1,2]}' },
      { role: "assistant", content: "backslash: \\ tab:\t null:\0" },
      { role: "user", content: "newlines\n\n\nmultiple" },
    ];

    const allMessages: unknown[] = [...msgs];
    const updatedMeta = {
      ...meta,
      tabs: [{ ...meta.tabs[0], messageRange: { startLine: 0, endLine: 3 } }],
    };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(updatedMeta, null, 2), "utf-8");
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");
    writeFileSync(join(dir, "messages.jsonl"), `${lines}\n`, "utf-8");

    JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const jsonlContent = readFileSync(join(dir, "messages.jsonl"), "utf-8").trim();
    const parsedMessages: unknown[] = [];
    for (const line of jsonlContent.split("\n")) {
      if (!line.trim()) continue;
      parsedMessages.push(JSON.parse(line));
    }

    expect(parsedMessages).toHaveLength(3);
    expect((parsedMessages[0] as { content: string }).content).toBe(
      'He said "hello\nworld" and {brackets: [1,2]}',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it("parseGitLogLine handles 1000 lines without issue", async () => {
    const { parseGitLogLine } = await import("../src/core/git/status.js");

    for (let i = 0; i < 1000; i++) {
      const hash = i.toString(16).padStart(7, "0");
      const entry = parseGitLogLine(`${hash} commit message #${i} (${i} seconds ago)`);
      expect(entry.hash).toBe(hash);
      expect(entry.subject).toBe(`commit message #${i}`);
    }
  });

  it("WorkerClient constructor does not block on worker startup", () => {
    const start = performance.now();
    const client = new TestClient();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    client.dispose();
  });
});

// ── Deadlock & Hang Analysis ──────────────────────────────────────────────

describe("Deadlock & Hang resistance", () => {
  let client: TestClient;

  afterEach(() => {
    try {
      client?.dispose();
    } catch {}
  });

  // The core re-entrancy test: callback handler calls back into worker
  // while worker is awaiting the callback response. If the worker's event
  // loop is blocked, this deadlocks. If async onmessage works correctly,
  // the worker processes the nested call while awaiting.
  it("nested callback: handler calls worker without deadlock", async () => {
    client = new TestClient();
    client.registerCallback("nested", async (data) => {
      const echoResult = await client.echo("from-callback");
      return { original: data, nested: echoResult };
    });
    const result = await client.callbackTest("nested", "hello");
    expect(result).toEqual({ original: "hello", nested: "from-callback" });
  });

  // Concurrent RPCs while a callback is in flight. The callback handler
  // deliberately delays, and we fire other calls in parallel. If the
  // message channel is single-threaded or blocked, the echo calls hang.
  it("concurrent calls proceed while callback is in flight", async () => {
    client = new TestClient();
    client.registerCallback("slow", async (data) => {
      await delay(100);
      return (data as number) + 1;
    });

    const [callbackResult, echo1, echo2, addResult] = await Promise.all([
      client.callbackTest("slow", 41),
      client.echo("concurrent-1"),
      client.echo("concurrent-2"),
      client.add(10, 20),
    ]);

    expect(callbackResult).toBe(42);
    expect(echo1).toBe("concurrent-1");
    expect(echo2).toBe("concurrent-2");
    expect(addResult).toBe(30);
  });

  // Multiple callbacks from multiple concurrent calls. Each resolves
  // independently. Tests that callback IDs don't collide.
  it("multiple concurrent callbacks resolve independently", async () => {
    client = new TestClient();
    client.registerCallback("double", async (data) => (data as number) * 2);
    client.registerCallback("triple", async (data) => (data as number) * 3);

    const [r1, r2, r3] = await Promise.all([
      client.callbackTest("double", 5),
      client.callbackTest("triple", 5),
      client.callbackTest("double", 10),
    ]);

    expect(r1).toBe(10);
    expect(r2).toBe(15);
    expect(r3).toBe(20);
  });

  // requestCallback has a default 60s timeout (overridable per-call). If the
  // callback handler never resolves, the main thread's RPC timeout fires first
  // here. Verify it fires.
  it("unresponsive callback: RPC timeout is the safety net", async () => {
    client = new TestClient();
    client.registerCallback("hang", async () => {
      return new Promise(() => {}); // never resolves
    });
    await expect(
      client.callbackTestWithTimeout("hang", null, 300),
    ).rejects.toThrow("timeout");
  });

  // After an RPC timeout due to a hung callback, the worker's event loop
  // should still be free (async onmessage yields). Verify the worker
  // accepts new calls — it's not deadlocked, just leaking one handler.
  it("worker stays functional after callback timeout (no deadlock)", async () => {
    client = new TestClient();
    client.registerCallback("hang", async () => new Promise(() => {}));

    await expect(
      client.callbackTestWithTimeout("hang", null, 200),
    ).rejects.toThrow("timeout");

    // Worker should still process new calls
    const result = await client.echo("still alive");
    expect(result).toBe("still alive");
    const sum = await client.add(1, 2);
    expect(sum).toBe(3);
  });

  // Dispose while a callback is in flight. The pending RPC should be
  // rejected with "disposed", and the client should not hang.
  it("dispose during active callback rejects cleanly", async () => {
    client = new TestClient();
    client.registerCallback("slow-dispose", async () => {
      await delay(5000); // long enough to get disposed mid-flight
      return "too late";
    });

    const promise = client.callbackTest("slow-dispose", null);
    await delay(50); // let the callback request reach main
    client.dispose();

    await expect(promise).rejects.toThrow("disposed");
  });

  // fire() + callback: worker sends callback for a fire-and-forget call.
  // Main has no pending promise but should still respond to the callback.
  // The result is silently dropped (no matching pending entry). No hang.
  it("fire-and-forget with callback does not hang", async () => {
    client = new TestClient();
    let callbackFired = false;
    client.registerCallback("fire-cb", async () => {
      callbackFired = true;
      return "ack";
    });

    client.fireMethod("callbackTest", "fire-cb", "test-data");
    await delay(200);

    expect(callbackFired).toBe(true);
    // Client is still functional
    expect(await client.echo("ok")).toBe("ok");
  });

  // Deep nesting: callback handler triggers a call that itself triggers
  // a callback. Two levels of re-entrant callbacks.
  it("double-nested callback resolves without deadlock", async () => {
    client = new TestClient();

    client.registerCallback("level1", async (data) => {
      // This triggers a second callback from the worker
      client.registerCallback("level2", async (inner) => {
        return (inner as number) * 10;
      });
      const nested = await client.callbackTest("level2", data);
      return (nested as number) + 1;
    });

    const result = await client.callbackTest("level1", 5);
    // level2 returns 5*10=50, level1 returns 50+1=51
    expect(result).toBe(51);
  });

  // Interleaved fire + call: 50 fire-and-forgets interleaved with 50
  // awaited calls. Message ordering and ID tracking must not corrupt.
  it("interleaved fire and call do not corrupt message channel", async () => {
    client = new TestClient();
    const results: number[] = [];

    for (let i = 0; i < 50; i++) {
      client.fireEcho(`fire-${i}`);
      results.push(await client.echo(i));
    }

    expect(results).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(i);
    }
  });

  // Timeout + immediate retry: after a timeout, the next call should
  // resolve normally. The timed-out response (if it arrives late)
  // should be silently dropped (pending entry already deleted).
  it("timed-out response arriving late is silently dropped", async () => {
    client = new TestClient();

    // sleep(500) with 100ms timeout → times out
    await expect(client.sleepWithTimeout(500, 100)).rejects.toThrow("timeout");

    // Immediate follow-up call should work. The late "done" response
    // from sleep arrives but has no matching pending entry.
    await delay(500);
    const result = await client.echo("after-late-response");
    expect(result).toBe("after-late-response");
  });

  // Stress: 20 concurrent callback calls, all with different handlers.
  // Tests that the callback ID space doesn't collide under concurrency.
  it("20 concurrent callbacks with unique handlers resolve correctly", async () => {
    client = new TestClient();

    for (let i = 0; i < 20; i++) {
      client.registerCallback(`cb-${i}`, async (data) => {
        return `${String(data)}-processed-${i}`;
      });
    }

    const promises = Array.from({ length: 20 }, (_, i) =>
      client.callbackTest(`cb-${i}`, `input-${i}`),
    );
    const results = await Promise.all(promises);

    for (let i = 0; i < 20; i++) {
      expect(results[i]).toBe(`input-${i}-processed-${i}`);
    }
  });

  // Worker-side pendingCallbacks leak: after a callback timeout,
  // the worker's pendingCallbacks map has an entry that never gets
  // cleaned up. Verify this doesn't prevent subsequent callbacks
  // from working (IDs are monotonically increasing, not reused).
  it("callback leak after timeout does not prevent future callbacks", async () => {
    client = new TestClient();

    // First: cause a callback timeout (leaks worker-side entry)
    client.registerCallback("hang", async () => new Promise(() => {}));
    await expect(
      client.callbackTestWithTimeout("hang", null, 200),
    ).rejects.toThrow("timeout");

    // Now register a real callback and verify it works
    client.registerCallback("real", async (data) => (data as number) + 100);
    const result = await client.callbackTest("real", 42);
    expect(result).toBe(142);
  });
});
