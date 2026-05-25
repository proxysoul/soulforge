import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { logBackgroundError } from "../../../../stores/errors.js";
import { IS_WIN, killTree as platformKillTree } from "../../../platform/index.js";
import { trackProcess } from "../../../process-tracker.js";
import { trackLspPid, untrackLspPid } from "./pid-tracker.js";
import {
  decode,
  encode,
  filePathToUri,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type LspCallHierarchyItem,
  type LspCodeAction,
  type LspDiagnostic,
  type LspDocumentSymbol,
  type LspFileRename,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspSymbolInformation,
  type LspTextEdit,
  type LspTypeHierarchyItem,
  type LspWorkspaceEdit,
} from "./protocol.js";
import type { LspServerConfig } from "./server-registry.js";

const LANGUAGE_ID_MAP: Partial<Record<string, string>> = {
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  kotlin: "kotlin",
  scala: "scala",
  csharp: "csharp",
  swift: "swift",
  dart: "dart",
  elixir: "elixir",
  ocaml: "ocaml",
  lua: "lua",
  c: "c",
  cpp: "cpp",
  ruby: "ruby",
  php: "php",
  zig: "zig",
  bash: "shellscript",
  css: "css",
  html: "html",
  json: "json",
  toml: "toml",
  yaml: "yaml",
  dockerfile: "dockerfile",
  vue: "vue",
};

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

type LspDefinitionResult = LspLocation | LspLocation[] | LspLocationLink[] | null;

export class StandaloneLspClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private static readonly MAX_OPEN_DOCUMENTS = 50;
  private openDocuments = new Map<string, { version: number; content: string }>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private initialized = false;
  private rootUri: string;
  private serverSupportsWillRename = false;
  private startedAt = 0;

  constructor(
    private config: LspServerConfig,
    private cwd: string,
  ) {
    this.rootUri = filePathToUri(cwd);
  }

  /** Spawn the server process and perform the initialize handshake */
  async start(): Promise<void> {
    // Spawn with detached: true so the child becomes its own process group leader.
    // This lets us kill the entire process tree via negative PID, which is critical
    // for LSP wrappers (e.g. biome's Mason shim) that use spawnSync to launch
    // a native binary grandchild — without this, SIGTERM only hits the wrapper
    // and the grandchild becomes an orphan.
    this.process = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      detached: true,
    });
    trackProcess(this.process);
    if (this.process.pid) trackLspPid(this.process.pid);

    this.process.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.on("exit", (code, signal) => {
      if (this.process?.pid) untrackLspPid(this.process.pid);
      this.process = null;
      if (code != null && code !== 0) {
        logBackgroundError(`LSP:${this.config.command}`, `exited with code ${code}`);
      } else if (signal) {
        logBackgroundError(`LSP:${this.config.command}`, `killed by ${signal}`);
      }
      for (const [, pending] of this.pending) {
        pending.reject(new Error("LSP server exited"));
      }
      this.pending.clear();
    });

    // Initialize handshake
    const initResult = (await this.request("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          rename: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          codeAction: { dynamicRegistration: false },
          formatting: { dynamicRegistration: false },
          rangeFormatting: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
          typeHierarchy: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
          fileOperations: {
            dynamicRegistration: false,
            willRename: true,
            didRename: true,
          },
        },
      },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
    })) as { capabilities?: { workspace?: { fileOperations?: { willRename?: unknown } } } } | null;

    // Check if server advertises willRename support
    this.serverSupportsWillRename =
      !!initResult?.capabilities?.workspace?.fileOperations?.willRename;

    this.notify("initialized", {});
    this.initialized = true;
    this.startedAt = Date.now();
  }

  /** Send a request and wait for the response */
  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.process?.stdin) throw new Error("LSP server not running");

    const id = this.nextId++;
    const msg = encode(method, params, id);
    this.process.stdin.write(msg);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30_000);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Send a notification (no response expected) */
  notify(method: string, params: unknown): void {
    if (!this.process?.stdin) return;
    const msg = encode(method, params);
    this.process.stdin.write(msg);
  }

  /** Process incoming data from stdout */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]) as Buffer<ArrayBuffer>;
    const { messages, remainder } = decode(this.buffer);
    this.buffer = remainder as Buffer<ArrayBuffer>;

    for (const msg of messages) {
      if (isResponse(msg)) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (isNotification(msg) && msg.method === "textDocument/publishDiagnostics") {
        const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
        this.diagnostics.set(params.uri, params.diagnostics);
        // Snapshot and clear waiters before invoking to avoid splice-during-iteration (#8)
        const waiters = this.diagnosticWaiters.get(params.uri);
        if (waiters) {
          const snapshot = [...waiters];
          this.diagnosticWaiters.delete(params.uri);
          for (const waiter of snapshot) waiter();
        }
      }
    }
  }

  /** Ensure a document is open in the server */
  async ensureDocumentOpen(filePath: string): Promise<void> {
    const uri = filePathToUri(filePath);

    let text: string;
    try {
      text = await readFile(filePath, "utf-8");
    } catch {
      return;
    }

    const existing = this.openDocuments.get(uri);
    if (existing) {
      // Document already open — send didChange if content differs
      if (existing.content !== text) {
        existing.version++;
        existing.content = text;
        this.notify("textDocument/didChange", {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text }],
        });
      }
      return;
    }

    const languageId = LANGUAGE_ID_MAP[this.config.language] ?? this.config.language;

    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openDocuments.set(uri, { version: 1, content: text });
    this.evictOldDocuments();
  }

  private evictOldDocuments(): void {
    while (this.openDocuments.size > StandaloneLspClient.MAX_OPEN_DOCUMENTS) {
      const oldest = this.openDocuments.keys().next().value;
      if (!oldest) break;
      this.openDocuments.delete(oldest);
      this.diagnostics.delete(oldest);
      const waiters = this.diagnosticWaiters.get(oldest);
      if (waiters) {
        for (const w of waiters) w();
        this.diagnosticWaiters.delete(oldest);
      }
      this.notify("textDocument/didClose", { textDocument: { uri: oldest } });
    }
  }

  /** Get definition locations */
  async textDocumentDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/definition", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspDefinitionResult;
    return normalizeLocations(result);
  }

  /** Get references */
  async textDocumentReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/references", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
      context: { includeDeclaration: true },
    })) as LspLocation[] | null;
    return result ?? [];
  }

  /** Get document symbols */
  async textDocumentDocumentSymbol(
    filePath: string,
  ): Promise<Array<LspDocumentSymbol | LspSymbolInformation>> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/documentSymbol", {
      textDocument: { uri: filePathToUri(filePath) },
    })) as Array<LspDocumentSymbol | LspSymbolInformation> | null;
    return result ?? [];
  }

  /** Get hover info */
  async textDocumentHover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspHover | null> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/hover", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspHover | null;
    return result;
  }

  /** Rename a symbol */
  async textDocumentRename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspWorkspaceEdit | null> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/rename", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
      newName,
    })) as LspWorkspaceEdit | null;
    return result;
  }

  /** Get diagnostics for a file, waiting up to 2s for them to arrive */
  async getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    await this.ensureDocumentOpen(filePath);
    const uri = filePathToUri(filePath);

    // Check if we already have diagnostics
    const existing = this.diagnostics.get(uri);
    if (existing) return existing;

    // Wait up to 2s for diagnostics to arrive
    return new Promise<LspDiagnostic[]>((resolve) => {
      const timeout = setTimeout(() => {
        // Remove waiter and return whatever we have (or empty)
        const waiters = this.diagnosticWaiters.get(uri);
        if (waiters) {
          const idx = waiters.indexOf(waiterFn);
          if (idx >= 0) waiters.splice(idx, 1);
          if (waiters.length === 0) this.diagnosticWaiters.delete(uri);
        }
        resolve(this.diagnostics.get(uri) ?? []);
      }, 2000);

      const waiterFn = () => {
        clearTimeout(timeout);
        resolve(this.diagnostics.get(uri) ?? []);
      };

      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(waiterFn);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  /** Get code actions */
  async textDocumentCodeAction(
    filePath: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
    only?: string[],
  ): Promise<LspCodeAction[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/codeAction", {
      textDocument: { uri: filePathToUri(filePath) },
      range: {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
      },
      context: { diagnostics: [], ...(only ? { only } : {}) },
    })) as LspCodeAction[] | null;
    return result ?? [];
  }

  /** Search workspace symbols */
  async workspaceSymbol(query: string): Promise<LspSymbolInformation[]> {
    const result = (await this.request("workspace/symbol", {
      query,
    })) as LspSymbolInformation[] | null;
    return result ?? [];
  }

  /** Format a document */
  async textDocumentFormatting(filePath: string): Promise<LspTextEdit[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/formatting", {
      textDocument: { uri: filePathToUri(filePath) },
      options: { tabSize: 2, insertSpaces: true },
    })) as LspTextEdit[] | null;
    return result ?? [];
  }

  /** Format a range */
  async textDocumentRangeFormatting(
    filePath: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<LspTextEdit[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/rangeFormatting", {
      textDocument: { uri: filePathToUri(filePath) },
      range: {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
      },
      options: { tabSize: 2, insertSpaces: true },
    })) as LspTextEdit[] | null;
    return result ?? [];
  }

  /** Find implementations */
  async textDocumentImplementation(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/implementation", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspDefinitionResult;
    return normalizeLocations(result);
  }

  /** Prepare call hierarchy */
  async prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspCallHierarchyItem[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspCallHierarchyItem[] | null;
    return result ?? [];
  }

  /** Get incoming calls */
  async callHierarchyIncomingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyItem[]> {
    const result = (await this.request("callHierarchy/incomingCalls", {
      item,
    })) as Array<{ from: LspCallHierarchyItem }> | null;
    return result?.map((r) => r.from) ?? [];
  }

  /** Get outgoing calls */
  async callHierarchyOutgoingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyItem[]> {
    const result = (await this.request("callHierarchy/outgoingCalls", {
      item,
    })) as Array<{ to: LspCallHierarchyItem }> | null;
    return result?.map((r) => r.to) ?? [];
  }

  /** Prepare type hierarchy */
  async prepareTypeHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspTypeHierarchyItem[]> {
    await this.ensureDocumentOpen(filePath);
    const result = (await this.request("textDocument/prepareTypeHierarchy", {
      textDocument: { uri: filePathToUri(filePath) },
      position: { line, character },
    })) as LspTypeHierarchyItem[] | null;
    return result ?? [];
  }

  /** Get supertypes */
  async typeHierarchySupertypes(item: LspTypeHierarchyItem): Promise<LspTypeHierarchyItem[]> {
    const result = (await this.request("typeHierarchy/supertypes", {
      item,
    })) as LspTypeHierarchyItem[] | null;
    return result ?? [];
  }

  /** Get subtypes */
  async typeHierarchySubtypes(item: LspTypeHierarchyItem): Promise<LspTypeHierarchyItem[]> {
    const result = (await this.request("typeHierarchy/subtypes", {
      item,
    })) as LspTypeHierarchyItem[] | null;
    return result ?? [];
  }

  /** Request import edits for file renames (workspace/willRenameFiles) */
  async willRenameFiles(files: LspFileRename[]): Promise<LspWorkspaceEdit | null> {
    if (!this.serverSupportsWillRename) return null;
    try {
      const result = (await this.request("workspace/willRenameFiles", {
        files,
      })) as LspWorkspaceEdit | null;
      return result;
    } catch {
      return null;
    }
  }

  /** Notify the server that files were renamed (workspace/didRenameFiles) */
  didRenameFiles(files: LspFileRename[]): void {
    this.notify("workspace/didRenameFiles", { files });
  }

  /** Close a document in the server (for rename: close old URI before opening new) */
  closeDocument(filePath: string): void {
    const uri = filePathToUri(filePath);
    const doc = this.openDocuments.get(uri);
    if (!doc) return;
    this.notify("textDocument/didClose", { textDocument: { uri } });
    this.openDocuments.delete(uri);
  }

  /** Whether the server supports workspace/willRenameFiles */
  get supportsFileRename(): boolean {
    return this.serverSupportsWillRename;
  }

  /** Check if the client has been initialized */
  get isReady(): boolean {
    return this.initialized && this.process !== null;
  }

  /** Whether the server started recently and may still be indexing */
  get isWarmingUp(): boolean {
    return this.startedAt > 0 && Date.now() - this.startedAt < 30_000;
  }

  /** The language this server is configured for */
  get language(): string {
    return this.config.language;
  }

  /** The server command name (e.g. "typescript-language-server") */
  get serverCommand(): string {
    return this.config.command;
  }

  /** PID of the spawned server process, or null if not running */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /** Workspace root this client is attached to */
  get workspaceRoot(): string {
    return this.rootUri.replace("file://", "");
  }

  /** Number of documents currently open in this client */
  get openDocumentCount(): number {
    return this.openDocuments.size;
  }

  /** Total diagnostics across all open files */
  get diagnosticCount(): number {
    let count = 0;
    for (const diags of this.diagnostics.values()) count += diags.length;
    return count;
  }

  /** Recent diagnostics (errors/warnings) for display */
  getRecentDiagnostics(limit = 20): Array<{ file: string; message: string; severity: number }> {
    const results: Array<{ file: string; message: string; severity: number }> = [];
    for (const [uri, diags] of this.diagnostics) {
      const file = uri.replace("file://", "");
      for (const d of diags) {
        if (results.length >= limit) return results;
        results.push({ file, message: d.message, severity: d.severity ?? 1 });
      }
    }
    return results;
  }

  /** Server args */
  get serverArgs(): string[] {
    return this.config.args;
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    if (!this.process) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      // Best effort
    }
    // Kill the entire process tree (not just the direct child).
    // Some LSP wrappers (e.g. biome's Mason shim) use spawnSync to launch
    // a native binary as a grandchild. SIGTERM to the wrapper doesn't propagate
    // to the grandchild, leaving orphaned processes. Killing by negative PID
    // targets the entire process group.
    const proc = this.process;
    const pid = proc?.pid;
    if (pid) {
      if (IS_WIN) {
        try {
          platformKillTree(pid, "SIGTERM");
        } catch {}
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            proc.kill("SIGTERM");
          } catch {}
        }
      }
      // SIGKILL after 2s as fallback — but also schedule an immediate
      // SIGKILL if the process is still alive after a short grace period.
      // The setTimeout may not fire during process.exit(), so killSync()
      // and the PID tracker act as the real safety net.
      setTimeout(() => {
        if (IS_WIN) {
          try {
            platformKillTree(pid, "SIGKILL");
          } catch {}
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }
        }
      }, 2000);
      untrackLspPid(pid);
    }
    this.process = null;
    this.initialized = false;
    this.openDocuments.clear();
    this.diagnostics.clear();
    this.pending.clear();
  }
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

function isNotification(
  msg: JsonRpcMessage,
): msg is { jsonrpc: "2.0"; method: string; params?: unknown } {
  return "method" in msg && !("id" in msg);
}

function normalizeLocations(result: LspDefinitionResult): LspLocation[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.map((item) => {
      if ("targetUri" in item) {
        const link = item as LspLocationLink;
        return { uri: link.targetUri, range: link.targetRange };
      }
      return item as LspLocation;
    });
  }
  return [result];
}
