import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { trackProcess } from "../../../process-tracker.js";
import type { ProviderModelInfo } from "../types.js";

export interface CodexLoginStatus {
  installed: boolean;
  loggedIn: boolean;
  authMode: "chatgpt" | "api-key" | null;
  message: string;
}

export interface CodexAppServerClient {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  waitForNotification<T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  close(): void;
}

export function parseCodexLoginStatus(status: number | null, output: string): CodexLoginStatus {
  const message = output.trim() || (status === 0 ? "Logged in" : "Not logged in");
  if (message.includes("Logged in using ChatGPT")) {
    return { installed: true, loggedIn: true, authMode: "chatgpt", message };
  }
  if (message.includes("Logged in using an API key")) {
    return { installed: true, loggedIn: true, authMode: "api-key", message };
  }
  if (message.includes("Not logged in")) {
    return { installed: true, loggedIn: false, authMode: null, message };
  }
  return {
    installed: true,
    loggedIn: status === 0,
    authMode: status === 0 ? "chatgpt" : null,
    message,
  };
}

export function parseCodexModelListResult(result: unknown): ProviderModelInfo[] {
  const data =
    result && typeof result === "object" && "data" in result
      ? (result as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as {
      id?: unknown;
      model?: unknown;
      displayName?: unknown;
      hidden?: unknown;
    };
    if (item.hidden === true) return [];
    const id =
      typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : null;
    if (!id) return [];
    const name =
      typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : id;
    return [{ id, name }];
  });
}

export function isCodexInstalled(): boolean {
  try {
    return (
      spawnSync("codex", ["--version"], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      }).status === 0
    );
  } catch {
    return false;
  }
}

export function getCodexLoginStatus(): CodexLoginStatus {
  try {
    const result = spawnSync("codex", ["login", "status"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      return {
        installed: false,
        loggedIn: false,
        authMode: null,
        message: result.error.message,
      };
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return parseCodexLoginStatus(result.status, output);
  } catch (error) {
    return {
      installed: false,
      loggedIn: false,
      authMode: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CodexLogoutResult {
  ok: boolean;
  message: string;
}

export function logoutCodex(): CodexLogoutResult {
  try {
    const result = spawnSync("codex", ["logout"], {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.error) {
      return { ok: false, message: result.error.message };
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      return { ok: true, message: output || "Logged out of Codex." };
    }

    return { ok: false, message: output || "Failed to log out of Codex." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function assertCodexReady(): void {
  const status = getCodexLoginStatus();
  if (!status.installed) {
    throw new Error("Codex CLI is not installed. Install Codex, then run `codex login`.");
  }
  if (!status.loggedIn) {
    throw new Error("Codex is not logged in. Run `codex login` and try again.");
  }
}

export async function startCodexAppServerSession(): Promise<CodexAppServerClient> {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  trackProcess(child);

  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to start Codex app-server");
  }

  const stderrChunks: Buffer[] = [];
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify(message)}\n`);

  let closed = false;
  let nextRequestId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const listeners = new Set<(method: string, params: unknown) => void>();

  const shutdown = () => {
    if (closed) return;
    closed = true;
    rl.close();
    child.removeAllListeners();
    for (const waiter of pending.values()) {
      waiter.reject(new Error("Codex app-server connection closed"));
    }
    pending.clear();
    listeners.clear();
    try {
      if (!child.killed) child.kill();
    } catch {}
  };

  child.once("error", (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const waiter of pending.values()) {
      waiter.reject(err);
    }
    pending.clear();
  });

  child.once("exit", (code, signal) => {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    const err = new Error(
      stderr
        ? `Codex app-server exited with ${detail}: ${stderr}`
        : `Codex app-server exited with ${detail}`,
    );
    for (const waiter of pending.values()) {
      waiter.reject(err);
    }
    pending.clear();
  });

  rl.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = typeof message.id === "number" ? message.id : null;
    if (id != null && pending.has(id)) {
      const waiter = pending.get(id);
      pending.delete(id);
      if (!waiter) return;
      if (message.error) {
        waiter.reject(
          new Error(
            typeof message.error === "object"
              ? JSON.stringify(message.error)
              : String(message.error),
          ),
        );
        return;
      }
      waiter.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of listeners) listener(message.method, message.params);
    }
  });

  const request = (method: string, params: Record<string, unknown>, timeoutMs = 30_000) => {
    if (closed) return Promise.reject(new Error("Codex app-server connection closed"));
    const id = nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  };

  const waitForNotification = <T>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs = 300_000,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Codex app-server notification ${method} timed out`));
      }, timeoutMs);

      const listener = (nextMethod: string, rawParams: unknown) => {
        if (nextMethod !== method) return;
        const params = rawParams as T;
        if (!predicate(params)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(params);
      };

      listeners.add(listener);
    });

  try {
    await request("initialize", {
      clientInfo: { name: "soulforge", title: "SoulForge", version: "0.0.0" },
    });
    send({ method: "initialized", params: {} });
    return { request, waitForNotification, close: shutdown };
  } catch (error) {
    shutdown();
    throw error;
  }
}

async function requestCodexAppServer(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const session = await startCodexAppServerSession();
  try {
    return await session.request(method, params);
  } finally {
    session.close();
  }
}

export async function fetchCodexModelsFromAppServer(): Promise<ProviderModelInfo[]> {
  const result = await requestCodexAppServer("model/list", {});
  return parseCodexModelListResult(result);
}
