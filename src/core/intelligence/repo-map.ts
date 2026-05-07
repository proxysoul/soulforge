import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { stat as statAsync } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { ensureSoulforgeDir } from "../utils/ensure-soulforge-dir.js";
import {
  computeFragmentHashes,
  computeMinHash,
  jaccardSimilarity,
  tokenize,
} from "./clone-detection.js";
import { IDENTIFIER_KEYWORDS } from "./repo-map-constants.js";
import {
  barrelToDir,
  collectFiles,
  DEFAULT_TOKEN_BUDGET,
  DIRTY_DEBOUNCE_MS,
  estimateTokens,
  extractDocComment,
  extractSignature,
  GIT_LOG_COMMITS,
  generateSyntheticSummary,
  getDirGroup,
  IMPORT_TRACKABLE_LANGUAGES,
  INDEXABLE_EXTENSIONS,
  kindTag,
  MAX_COCHANGE_FILES_PER_COMMIT,
  MAX_INDEXED_FILES,
  MAX_REFS_PER_FILE,
  MAX_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET,
  NON_CODE_LANGUAGES,
  PAGERANK_DAMPING,
  PAGERANK_ITERATIONS,
} from "./repo-map-utils.js";
import type { Language, SymbolKind } from "./types.js";

interface FileRow {
  id: number;
  path: string;
  mtime_ms: number;
  language: string;
  line_count: number;
  symbol_count: number;
  pagerank: number;
}

interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  line: number;
  end_line: number;
  is_exported: number;
  signature: string | null;
}

interface EdgeRow {
  source_file_id: number;
  target_file_id: number;
  weight: number;
}

export interface RepoMapOptions {
  tokenBudget?: number;
  mentionedFiles?: string[];
  editedFiles?: string[];
  editorFile?: string | null;
  conversationTokens?: number;
}

export interface SymbolForSummary {
  name: string;
  kind: string;
  signature: string | null;
  code: string;
  filePath: string;
  dependents?: number;
  lineSpan?: number;
}

type SummaryGenerator = (
  batch: SymbolForSummary[],
  batchTotal?: number,
) => Promise<Array<{ name: string; summary: string }>>;

export class RepoMap {
  /** SQL WHERE fragment: true when path column is a test file. */
  private static testFileMatch(alias = "f"): string {
    const a = alias;
    return `(${a}.path LIKE 'tests/%' OR ${a}.path LIKE 'test/%' OR ${a}.path LIKE 'spec/%' OR ${a}.path LIKE 'src/test/%' OR ${a}.path LIKE '%.test.%' OR ${a}.path LIKE '%.spec.%' OR ${a}.path LIKE '%_test.%' OR ${a}.path LIKE '%_spec.%' OR ${a}.path LIKE '%/test_%' OR ${a}.path LIKE '%/__tests__/%')`;
  }

  /** SQL WHERE fragment: true when path column is NOT a test file. */
  private static notTestFile(alias = "f"): string {
    const a = alias;
    return `${a}.path NOT LIKE 'tests/%' AND ${a}.path NOT LIKE 'test/%' AND ${a}.path NOT LIKE 'spec/%' AND ${a}.path NOT LIKE 'src/test/%' AND ${a}.path NOT LIKE '%.test.%' AND ${a}.path NOT LIKE '%.spec.%' AND ${a}.path NOT LIKE '%_test.%' AND ${a}.path NOT LIKE '%_spec.%' AND ${a}.path NOT LIKE '%/test_%' AND ${a}.path NOT LIKE '%/__tests__/%'`;
  }

  private db: Database;
  private cwd: string;
  private scanPromise: Promise<void> | null = null;
  private treeSitter:
    | typeof import("./backends/tree-sitter.js").TreeSitterBackend.prototype
    | null = null;
  private ready = false;
  private dirty = false;
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReindex = new Map<string, { relPath: string; language: Language }>();
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;
  private hasGit: boolean | null = null;

  private entryPointsCache: string[] | null = null;
  private semanticMode: "off" | "ast" | "synthetic" | "llm" | "full" | "on" = "synthetic";
  private summaryGenerator: SummaryGenerator | null = null;
  private regenTimer: ReturnType<typeof setTimeout> | null = null;
  maxFiles: number = MAX_INDEXED_FILES;
  onProgress: ((indexed: number, total: number) => void) | null = null;
  onScanComplete: ((success: boolean) => void) | null = null;
  onStaleSymbols: ((count: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private indexErrors = 0;
  /** File paths included in the last render() output — used by ContextManager for diff detection. */
  lastRenderedPaths: string[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
    const dbDir = ensureSoulforgeDir(cwd);

    const dbPath = join(dbDir, "repomap.db");
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA foreign_keys = ON");
    // Recover stale WAL from previous crash — checkpoint flushes WAL to main DB
    // and releases any leftover -shm locks from dead processes
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(dbPath + suffix, 0o600);
      } catch {}
    }
    this.initSchema();
  }

  getCwd(): string {
    return this.cwd;
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        mtime_ms REAL NOT NULL,
        language TEXT NOT NULL,
        line_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        pagerank REAL NOT NULL DEFAULT 0.0
      );
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_pagerank ON files(pagerank DESC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        is_exported INTEGER NOT NULL DEFAULT 0,
        signature TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    `);

    // Migration: add signature column if missing
    try {
      this.db.run("ALTER TABLE symbols ADD COLUMN signature TEXT");
    } catch {
      // Column already exists
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS edges (
        source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        target_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (source_file_id, target_file_id)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS refs (
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        source_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        import_source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
      CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
      CREATE INDEX IF NOT EXISTS idx_refs_source ON refs(source_file_id);
      CREATE INDEX IF NOT EXISTS idx_refs_import ON refs(import_source);
    `);

    // Migration: add source_file_id and import_source columns if missing
    try {
      this.db.run(
        "ALTER TABLE refs ADD COLUMN source_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE",
      );
    } catch {
      // Column already exists
    }
    try {
      this.db.run("ALTER TABLE refs ADD COLUMN import_source TEXT");
    } catch {
      // Column already exists
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cochanges (
        file_id_a INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        file_id_b INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (file_id_a, file_id_b)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS external_imports (
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        package TEXT NOT NULL,
        specifiers TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (file_id, package)
      );
      CREATE INDEX IF NOT EXISTS idx_ext_imports_pkg ON external_imports(package);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS semantic_summaries (
        symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'llm',
        summary TEXT NOT NULL,
        file_mtime REAL NOT NULL,
        PRIMARY KEY (symbol_id, source)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS shape_hashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        shape_hash TEXT NOT NULL,
        node_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shape_hashes_file ON shape_hashes(file_id);
      CREATE INDEX IF NOT EXISTS idx_shape_hashes_hash ON shape_hashes(shape_hash);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS token_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        minhash BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_sig_file ON token_signatures(file_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS token_fragments (
        hash TEXT NOT NULL,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        line INTEGER NOT NULL,
        token_offset INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fragments_hash ON token_fragments(hash);
      CREATE INDEX IF NOT EXISTS idx_fragments_file ON token_fragments(file_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS calls (
        caller_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        callee_name TEXT NOT NULL,
        callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
        callee_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_calls_callee_file ON calls(callee_file_id);
    `);

    this.migrateSemanticSource();
    this.migrateSemanticNoCascade();
    this.backfillSummaryPaths();
    this.cleanOrphanedSummaries();

    // Migration: add qualified_name to symbols
    try {
      this.db.run("ALTER TABLE symbols ADD COLUMN qualified_name TEXT");
    } catch {}
    try {
      this.db.run("CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qualified_name)");
    } catch {}

    // Migration: add is_barrel flag to files
    try {
      this.db.run("ALTER TABLE files ADD COLUMN is_barrel INTEGER NOT NULL DEFAULT 0");
    } catch {}

    // Migration: add confidence tier to edges
    try {
      this.db.run("ALTER TABLE edges ADD COLUMN confidence INTEGER NOT NULL DEFAULT 1");
    } catch {}

    this.rebuildFts();
  }

  private migrateSemanticSource(): void {
    try {
      const cols = this.db
        .query<{ name: string }, []>("PRAGMA table_info(semantic_summaries)")
        .all();
      if (cols.length > 0 && !cols.some((c) => c.name === "source")) {
        this.db.run("DROP TABLE semantic_summaries");
        this.db.run(`
          CREATE TABLE semantic_summaries (
            symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
            source TEXT NOT NULL DEFAULT 'llm',
            summary TEXT NOT NULL,
            file_mtime REAL NOT NULL,
            PRIMARY KEY (symbol_id, source)
          );
        `);
      }
    } catch {
      // fresh db or already migrated
    }
  }

  private migrateSemanticNoCascade(): void {
    // Migration: remove ON DELETE CASCADE from semantic_summaries so LLM summaries
    // survive symbol re-indexing. Add file_path + symbol_name for standalone lookup.
    try {
      const sql = this.db
        .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
        .get("semantic_summaries");
      if (!sql?.sql?.includes("ON DELETE CASCADE")) return;

      // Stash all existing data
      const rows = this.db
        .query<{ symbol_id: number; source: string; summary: string; file_mtime: number }, []>(
          "SELECT symbol_id, source, summary, file_mtime FROM semantic_summaries",
        )
        .all();

      // Build name+path lookup from current symbols
      const symbolInfo = new Map<number, { name: string; path: string }>();
      for (const s of this.db
        .query<{ id: number; name: string; path: string }, []>(
          "SELECT s.id, s.name, f.path FROM symbols s JOIN files f ON f.id = s.file_id",
        )
        .all()) {
        symbolInfo.set(s.id, { name: s.name, path: s.path });
      }

      this.db.run("DROP TABLE semantic_summaries");
      this.db.run(`
        CREATE TABLE semantic_summaries (
          symbol_id INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'llm',
          summary TEXT NOT NULL,
          file_mtime REAL NOT NULL,
          file_path TEXT NOT NULL DEFAULT '',
          symbol_name TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (symbol_id, source)
        );
      `);
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_semantic_file_name ON semantic_summaries(file_path, symbol_name)",
      );

      // Restore data with file_path + symbol_name populated
      if (rows.length > 0) {
        const ins = this.db.prepare(
          "INSERT OR IGNORE INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const tx = this.db.transaction(() => {
          for (const r of rows) {
            const info = symbolInfo.get(r.symbol_id);
            ins.run(
              r.symbol_id,
              r.source,
              r.summary,
              r.file_mtime,
              info?.path ?? "",
              info?.name ?? "",
            );
          }
        });
        tx();
      }
    } catch {
      // fresh db or already migrated
    }
  }

  private backfillSummaryPaths(): void {
    try {
      const stale =
        this.db
          .query<{ c: number }, []>(
            "SELECT count(*) as c FROM semantic_summaries WHERE file_path = '' AND symbol_id IN (SELECT id FROM symbols)",
          )
          .get()?.c ?? 0;
      if (stale === 0) return;
      this.db.run(
        `UPDATE semantic_summaries SET
           file_path = COALESCE((SELECT f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = semantic_summaries.symbol_id), ''),
           symbol_name = COALESCE((SELECT s.name FROM symbols s WHERE s.id = semantic_summaries.symbol_id), '')
         WHERE file_path = '' AND symbol_id IN (SELECT id FROM symbols)`,
      );
    } catch (e) {
      console.error("[repo-map] backfillSummaryPaths failed:", e instanceof Error ? e.message : String(e));
    }
  }

  private cleanOrphanedSummaries(): void {
    try {
      // Only delete orphaned non-LLM summaries (ast/synthetic are cheap to regenerate).
      // LLM summaries with file_path+symbol_name survive symbol ID changes across rescans
      // and get matched by (file_path, symbol_name) in generateSemanticSummaries.
      this.db.run(
        "DELETE FROM semantic_summaries WHERE symbol_id NOT IN (SELECT id FROM symbols) AND (source != 'llm' OR file_path = '')",
      );
    } catch (e) {
      console.error("[repo-map] cleanOrphanedSummaries failed:", e instanceof Error ? e.message : String(e));
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  async scan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.doScan();
    return this.scanPromise;
  }

  private async doScan(): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    this.indexErrors = 0;
    try {
      const collected = await collectFiles(this.cwd);
      if (collected.warning) this.onError?.(collected.warning);
      const allFiles = collected.files;
      let files: typeof allFiles;
      if (this.maxFiles > 0 && allFiles.length > this.maxFiles) {
        this.onError?.(
          `Repository has ${String(allFiles.length)} indexable files — indexing top ${String(this.maxFiles)} by recent activity`,
        );
        files = await this.applyFileCap(allFiles);
      } else {
        files = allFiles;
      }

      const existingFiles = new Map<string, { id: number; mtime_ms: number }>();
      for (const row of this.db
        .query<{ id: number; path: string; mtime_ms: number }, []>(
          "SELECT id, path, mtime_ms FROM files",
        )
        .all()) {
        existingFiles.set(row.path, { id: row.id, mtime_ms: row.mtime_ms });
      }

      const currentPaths = new Set<string>();
      const toIndex: { absPath: string; relPath: string; mtime: number; language: Language }[] = [];

      for (const file of files) {
        const relPath = relative(this.cwd, file.path);
        currentPaths.add(relPath);

        const existing = existingFiles.get(relPath);
        if (existing && existing.mtime_ms === file.mtimeMs) continue;
        const ext = extname(file.path).toLowerCase();
        const language = INDEXABLE_EXTENSIONS[ext] ?? "unknown";
        toIndex.push({ absPath: file.path, relPath, mtime: file.mtimeMs, language });
      }

      const stale = [...existingFiles.keys()].filter((p) => !currentPaths.has(p));
      // Safety: if >80% of files would be deleted, something went wrong with
      // file collection (git hiccup, timeout, etc.) — skip deletion to avoid
      // nuking a good index. A full clear can be done explicitly via /repo-map.
      const staleRatio = existingFiles.size > 0 ? stale.length / existingFiles.size : 0;
      if (stale.length > 0 && staleRatio < 0.8) {
        const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
        const tx = this.db.transaction(() => {
          for (const p of stale) deleteFile.run(p);
        });
        tx();
      } else if (stale.length > 0) {
        this.onError?.(
          `Skipped removing ${String(stale.length)} files — looks like a file listing error (${String(Math.round(staleRatio * 100))}% stale). Use /repo-map → [X] clear to force.`,
        );
      }

      if (toIndex.length > 0) {
        this.onProgress?.(0, toIndex.length);
        await this.ensureTreeSitter();
        for (let i = 0; i < toIndex.length; i++) {
          const file = toIndex[i];
          if (file) {
            try {
              await this.indexFile(file.absPath, file.relPath, file.mtime, file.language);
            } catch (err) {
              this.indexErrors++;
              if (this.indexErrors <= 5) {
                this.onError?.(
                  `Failed to index ${file.relPath}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
          if (i % 5 === 0) {
            this.onProgress?.(i + 1, toIndex.length);
            await tick();
          }
        }
        this.onProgress?.(toIndex.length, toIndex.length);
      }

      // Re-run post-indexing if previous scan failed mid-way (files exist but 0 edges)
      const edgeCount =
        this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM edges").get()?.c ?? 0;
      const fileCount =
        this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM files").get()?.c ?? 0;
      const needsPostIndexing =
        toIndex.length > 0 || stale.length > 0 || (fileCount > 0 && edgeCount === 0);

      if (needsPostIndexing) {
        this.onProgress?.(-1, -1); // resolving refs
        await tick();
        await this.resolveUnresolvedRefs();
        this.onProgress?.(-1, -1);
        await tick();
        await this.resolveIdentifierRefs();
        this.onProgress?.(-2, -2); // call graph
        await tick();
        await this.buildCallGraph();
        this.onProgress?.(-3, -3); // edges
        await tick();
        await this.buildEdges();
        this.onProgress?.(-4, -4); // test linking + orphans
        this.linkTestFiles();
        this.rescueOrphans();
        this.onProgress?.(-4, -4);
        await tick();
        await this.computePageRank();
        await tick();
      }

      this.onProgress?.(-5, -5); // cochanges
      await tick();
      await this.buildCoChanges();

      await tick();
      this.compactIfNeeded();
      this.ready = true;
      this.onScanComplete?.(true);
    } catch (err) {
      this.onScanComplete?.(false);
      throw err;
    } finally {
      this.scanPromise = null;
    }
  }

  private async applyFileCap(
    files: Array<{ path: string; mtimeMs: number }>,
  ): Promise<Array<{ path: string; mtimeMs: number }>> {
    const gitRecency = new Map<string, number>();
    if (this.detectGit()) {
      try {
        const { execFile } = await import("node:child_process");
        const output = await new Promise<string>((resolve) => {
          execFile(
            "git",
            ["log", "--all", "--name-only", "--format=", "-n", "1000"],
            { cwd: this.cwd, timeout: 10_000, maxBuffer: 5_000_000 },
            (err, stdout) => resolve(err ? "" : stdout),
          );
        });
        let rank = 0;
        for (const line of output.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !gitRecency.has(trimmed)) {
            gitRecency.set(trimmed, rank++);
          }
        }
      } catch {
        // git unavailable — fall back to mtime-only sorting
      }
    }

    const sorted = files
      .map((f) => ({
        path: f.path,
        mtimeMs: f.mtimeMs,
        gitRank: gitRecency.get(relative(this.cwd, f.path)),
      }))
      .sort((a, b) => {
        const aGit = a.gitRank !== undefined;
        const bGit = b.gitRank !== undefined;
        if (aGit !== bGit) return aGit ? -1 : 1;
        if (aGit && bGit) return (a.gitRank as number) - (b.gitRank as number);
        return b.mtimeMs - a.mtimeMs;
      });

    return sorted.slice(0, this.maxFiles);
  }

  private async ensureTreeSitter(): Promise<void> {
    if (this.treeSitter) return;
    try {
      const { TreeSitterBackend } = await import("./backends/tree-sitter.js");
      const backend = new TreeSitterBackend();
      await Promise.race([
        backend.initialize(this.cwd),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("tree-sitter init timeout")), 15_000),
        ),
      ]);
      this.treeSitter = backend;
    } catch (err) {
      this.onError?.(
        `Tree-sitter init failed: ${err instanceof Error ? err.message : String(err)} — indexing without AST symbols`,
      );
    }
  }

  private async indexFile(
    absPath: string,
    relPath: string,
    mtime: number,
    language: Language,
  ): Promise<void> {
    const existing = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);

    if (existing) {
      this.db.transaction(() => {
        this.db.query("DELETE FROM calls WHERE callee_file_id = ?").run(existing.id);
        this.db
          .query(
            "DELETE FROM semantic_summaries WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?) AND source != 'llm'",
          )
          .run(existing.id);
        this.db.query("DELETE FROM symbols WHERE file_id = ?").run(existing.id);
        this.db.query("DELETE FROM refs WHERE file_id = ?").run(existing.id);
        this.db.query("DELETE FROM external_imports WHERE file_id = ?").run(existing.id);
        this.db.query("DELETE FROM shape_hashes WHERE file_id = ?").run(existing.id);
        this.db.query("DELETE FROM token_signatures WHERE file_id = ?").run(existing.id);
        this.db.query("DELETE FROM token_fragments WHERE file_id = ?").run(existing.id);
        this.db
          .query("DELETE FROM edges WHERE source_file_id = ? OR target_file_id = ?")
          .run(existing.id, existing.id);
      })();
    }

    let lineCount = 0;
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
      lineCount = content.split("\n").length;
    } catch {
      return;
    }

    let outline: import("./types.js").FileOutline | null = null;
    if (this.treeSitter) {
      try {
        const parsed = await Promise.race([
          this.treeSitter.getFileOutline(absPath),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
        ]);
        if (parsed === "timeout") {
          this.onError?.(`Tree-sitter parse timeout (5s): ${relPath}`);
        } else {
          outline = parsed ?? null;
        }
      } catch (err) {
        this.onError?.(
          `Tree-sitter parse error on ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const symbolCount = outline?.symbols.length ?? 0;

    if (existing) {
      this.db
        .query(
          "UPDATE files SET mtime_ms = ?, language = ?, line_count = ?, symbol_count = ? WHERE id = ?",
        )
        .run(mtime, language, lineCount, symbolCount, existing.id);
    } else {
      this.db
        .query(
          "INSERT INTO files (path, mtime_ms, language, line_count, symbol_count) VALUES (?, ?, ?, ?, ?)",
        )
        .run(relPath, mtime, language, lineCount, symbolCount);
    }

    const fileId =
      existing?.id ??
      (this.db.query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?").get(relPath)
        ?.id as number);

    if (outline) {
      const insertSym = this.db.prepare(
        "INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const exportedNames = new Set(outline.exports.map((e) => e.name));
      const seen = new Set<string>();
      const lines = content.split("\n");

      const MAX_SYMBOLS_PER_FILE = 10_000;
      const tx = this.db.transaction(() => {
        let symbolCount = 0;
        for (const sym of outline.symbols) {
          if (symbolCount >= MAX_SYMBOLS_PER_FILE) break;
          const key = `${sym.name}:${String(sym.location.line)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Filter local variables: only index top-level symbols.
          // Variables/constants inside function bodies add noise (9k+ symbols).
          // Keep: exported, non-variable kinds, or top-level (indentation ≤ 2 spaces).
          if (sym.kind === "variable" || sym.kind === "constant") {
            if (!exportedNames.has(sym.name)) {
              const srcLine = lines[sym.location.line - 1] ?? "";
              const indent = srcLine.length - srcLine.trimStart().length;
              if (indent > 2) continue; // local variable — skip
            }
          }

          const sig = extractSignature(lines, sym.location.line - 1, sym.kind);
          insertSym.run(
            fileId,
            sym.name,
            sym.kind,
            sym.location.line,
            sym.location.endLine ?? sym.location.line,
            exportedNames.has(sym.name) ? 1 : 0,
            sig,
          );
          symbolCount++;
        }
      });
      tx();

      // Compute scope-qualified names from line-range containment
      // e.g. AgentBus.dispatch, DependencyFailedError (top-level stays unqualified)
      {
        const CONTAINER_KINDS = new Set(["class", "interface", "module", "namespace", "enum"]);
        const fileSyms = this.db
          .query<
            { id: number; name: string; kind: string; line: number; end_line: number },
            [number]
          >(
            "SELECT id, name, kind, line, end_line FROM symbols WHERE file_id = ? ORDER BY line ASC",
          )
          .all(fileId);
        const containers = fileSyms.filter(
          (s) => CONTAINER_KINDS.has(s.kind) && s.end_line > s.line,
        );
        if (containers.length > 0) {
          // Sort containers by span size (smallest first) so the first match
          // enclosing a symbol is the tightest container — O(n×m) worst case
          // but early-exit on first match makes it O(n) for typical code.
          const sorted = [...containers].sort(
            (a, b) => a.end_line - a.line - (b.end_line - b.line),
          );
          const updateQname = this.db.prepare("UPDATE symbols SET qualified_name = ? WHERE id = ?");
          const qTx = this.db.transaction(() => {
            for (const sym of fileSyms) {
              for (const c of sorted) {
                if (c.id === sym.id) continue;
                if (c.line <= sym.line && c.end_line >= sym.end_line) {
                  updateQname.run(`${c.name}.${sym.name}`, sym.id);
                  break; // smallest span first → first match is tightest
                }
              }
            }
          });
          qTx();
        }
      }

      // Detect barrel files structurally:
      // A barrel file re-exports from other files with no/minimal original definitions.
      // Key signal: imported specifiers that also appear in the file's exports.
      {
        const BARREL_RE = /\/(index\.(ts|js|tsx|mts|mjs)|__init__\.py|mod\.rs|lib\.rs)$/;
        const hasBarrelName = BARREL_RE.test(relPath);

        // Count re-exports: imports whose specifiers are also in the export list
        let reexportCount = 0;
        for (const imp of outline.imports) {
          if (!imp.source.startsWith(".")) continue;
          if (imp.specifiers.some((s) => s === "*")) {
            reexportCount++;
            continue;
          }
          for (const s of imp.specifiers) {
            if (exportedNames.has(s)) reexportCount++;
          }
        }

        // Original definitions: non-trivial symbols defined in this file
        const originalDefs = outline.symbols.filter(
          (s) => s.kind !== "variable" && s.kind !== "constant",
        ).length;

        let isBarrel = false;
        if (hasBarrelName && originalDefs <= 2) isBarrel = true;
        else if (reexportCount >= 3 && originalDefs / (reexportCount + originalDefs + 1) < 0.2)
          isBarrel = true;

        this.db.query("UPDATE files SET is_barrel = ? WHERE id = ?").run(isBarrel ? 1 : 0, fileId);
      }

      // Re-link orphaned LLM summaries to new symbol IDs (by file_path + symbol_name)
      this.db
        .query(
          `UPDATE semantic_summaries SET symbol_id = (
             SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
             WHERE f.path = semantic_summaries.file_path AND s.name = semantic_summaries.symbol_name
             LIMIT 1
           )
           WHERE source = 'llm' AND file_path = ?
             AND EXISTS (
               SELECT 1 FROM symbols s JOIN files f ON f.id = s.file_id
               WHERE f.path = semantic_summaries.file_path AND s.name = semantic_summaries.symbol_name
             )`,
        )
        .run(relPath);
      // Clean up LLM summaries for symbols that were renamed/deleted from this file
      // Only delete rows with populated file_path (backfilled rows) — never delete rows with empty file_path
      this.db
        .query(
          `DELETE FROM semantic_summaries WHERE source = 'llm' AND file_path = ? AND file_path <> ''
           AND NOT EXISTS (SELECT 1 FROM symbols WHERE id = semantic_summaries.symbol_id)`,
        )
        .run(relPath);

      if (this.semanticMode === "ast" || this.semanticMode === "on") {
        this.extractAstSummaries(fileId, relPath, outline.symbols, exportedNames, lines, mtime);
      }

      if (this.treeSitter) {
        try {
          const hashes = await this.treeSitter.getShapeHashes(absPath);
          if (hashes && hashes.length > 0) {
            const insertHash = this.db.prepare(
              "INSERT INTO shape_hashes (file_id, name, kind, line, end_line, shape_hash, node_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
            );
            const hashTx = this.db.transaction(() => {
              for (const h of hashes) {
                insertHash.run(fileId, h.name, h.kind, h.line, h.endLine, h.shapeHash, h.nodeCount);
              }
            });
            hashTx();
          }
        } catch {
          // skip shape hashing on parse error
        }
      }

      this.extractTokenSignatures(fileId, outline.symbols, content);
    }

    // Refs with resolved source_file_id (from import statements)
    const resolvedRefs: Array<{
      name: string;
      sourceFileId: number | null;
      importSource: string | null;
    }> = [];
    const allRefNames = new Set<string>();

    if (outline && outline.imports.length > 0) {
      const extImports = new Map<string, Set<string>>();
      for (const imp of outline.imports) {
        const sourceFileId = this.resolveImportSource(imp.source, absPath);
        // Store import_source for any import we might resolve (relative, crate, Go module, tsconfig alias)
        const isResolvable =
          imp.source.startsWith(".") ||
          imp.source.startsWith("crate::") ||
          imp.source.startsWith("super::") ||
          imp.source.includes("\\") || // PHP namespaces
          (imp.source.includes(".") &&
            !imp.source.startsWith(".") &&
            /^[a-zA-Z]/.test(imp.source)) || // Java/Kotlin packages
          (this.getGoModulePrefix() && imp.source.startsWith(`${this.getGoModulePrefix()}/`)) ||
          (this.getTsconfigPaths() &&
            [...(this.getTsconfigPaths()?.keys() ?? [])].some((p) => imp.source.startsWith(p)));
        const importSource = isResolvable ? imp.source : null;
        for (const s of imp.specifiers) {
          allRefNames.add(s);
          resolvedRefs.push({ name: s, sourceFileId, importSource });
        }

        if (
          imp.source.startsWith(".") ||
          imp.source.startsWith("/") ||
          imp.source.startsWith("node:") ||
          imp.source.startsWith("bun:")
        )
          continue;
        const pkg = imp.source.startsWith("@")
          ? imp.source.split("/").slice(0, 2).join("/")
          : (imp.source.split("/")[0] ?? imp.source);
        let specs = extImports.get(pkg);
        if (!specs) {
          specs = new Set();
          extImports.set(pkg, specs);
        }
        for (const s of imp.specifiers) specs.add(s);
      }
      if (extImports.size > 0) {
        const insertExt = this.db.prepare(
          "INSERT OR REPLACE INTO external_imports (file_id, package, specifiers) VALUES (?, ?, ?)",
        );
        const tx = this.db.transaction(() => {
          for (const [pkg, specs] of extImports) {
            insertExt.run(fileId, pkg, [...specs].join(","));
          }
        });
        tx();
      }
    }

    // Only extract identifiers from code files — non-code files (JSON, YAML, MD, etc.)
    // produce noise refs ("name", "version", "scripts") that create bogus edges.
    if (!NON_CODE_LANGUAGES.has(language)) {
      const identifiers = this.extractIdentifiers(content, language);
      for (const id of identifiers) {
        if (allRefNames.size >= MAX_REFS_PER_FILE) break;
        if (!allRefNames.has(id)) {
          allRefNames.add(id);
          resolvedRefs.push({ name: id, sourceFileId: null, importSource: null });
        }
      }
    }

    if (resolvedRefs.length > 0) {
      const insertRef = this.db.prepare(
        "INSERT INTO refs (file_id, name, source_file_id, import_source) VALUES (?, ?, ?, ?)",
      );
      const tx = this.db.transaction(() => {
        for (const ref of resolvedRefs) {
          insertRef.run(fileId, ref.name, ref.sourceFileId, ref.importSource);
        }
      });
      tx();
    }
  }

  private extractIdentifiers(content: string, language: Language): Set<string> {
    const ids = new Set<string>();
    const patterns: RegExp[] = [];

    switch (language) {
      // camelCase + PascalCase
      case "typescript":
      case "javascript":
      case "go":
      case "rust":
      case "java":
      case "kotlin":
      case "swift":
      case "csharp":
      case "dart":
      case "scala":
      case "objc":
      case "solidity":
        patterns.push(/\b([A-Z][a-zA-Z0-9_]*)\b/g);
        patterns.push(/\b([a-z][a-zA-Z0-9_]{2,})\b/g);
        break;
      // snake_case + PascalCase
      case "python":
      case "ruby":
      case "elixir":
      case "php":
        patterns.push(/\b([A-Z][a-zA-Z0-9_]*)\b/g);
        patterns.push(/\b([a-z][a-z0-9_]{2,})\b/g);
        break;
      // Primarily snake_case/lowercase
      case "c":
      case "cpp":
      case "zig":
      case "lua":
      case "bash":
      case "ocaml":
      case "rescript":
        patterns.push(/\b([A-Z][a-zA-Z0-9_]*)\b/g);
        patterns.push(/\b([a-z][a-z0-9_]{2,})\b/g);
        break;
      // Lisp-family (hyphenated identifiers)
      case "elisp":
        patterns.push(/\b([A-Z][a-zA-Z0-9_-]*)\b/g);
        patterns.push(/\b([a-z][a-zA-Z0-9_-]{2,})\b/g);
        break;
      // TLA+, Vue, HTML, CSS, config — PascalCase at minimum
      default:
        patterns.push(/\b([A-Z][a-zA-Z0-9_]*)\b/g);
        patterns.push(/\b([a-z][a-zA-Z0-9_]{2,})\b/g);
        break;
    }

    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const id = match[1];
        if (id && id.length > 3 && id.length < 60 && !IDENTIFIER_KEYWORDS.has(id)) {
          ids.add(id);
        }
      }
    }

    return ids;
  }

  /**
   * Resolve an import source path to a file_id in the files table.
   * Works for relative imports (./foo, ../bar) across all languages.
   * Returns null for package/external imports or unresolvable paths.
   */
  private goModulePrefix: string | null | undefined = undefined;
  private tsconfigPaths: Map<string, string> | null | undefined = undefined;

  private getGoModulePrefix(): string | null {
    if (this.goModulePrefix !== undefined) return this.goModulePrefix;
    try {
      const goMod = readFileSync(join(this.cwd, "go.mod"), "utf-8");
      const match = goMod.match(/^module\s+(\S+)/m);
      this.goModulePrefix = match?.[1] ?? null;
    } catch {
      this.goModulePrefix = null;
    }
    return this.goModulePrefix;
  }

  private getTsconfigPaths(): Map<string, string> | null {
    if (this.tsconfigPaths !== undefined) return this.tsconfigPaths;
    this.tsconfigPaths = null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      try {
        const raw = readFileSync(join(this.cwd, name), "utf-8");
        const config = JSON.parse(raw);
        const paths = config?.compilerOptions?.paths;
        if (paths && typeof paths === "object") {
          const map = new Map<string, string>();
          for (const [pattern, targets] of Object.entries(paths)) {
            const target = Array.isArray(targets) ? targets[0] : undefined;
            if (typeof target !== "string") continue;
            // Convert glob patterns: "@/*" → "@/", "src/*" → "src/"
            const prefix = pattern.replace(/\*$/, "");
            const replacement = target.replace(/\*$/, "");
            map.set(prefix, replacement);
          }
          if (map.size > 0) this.tsconfigPaths = map;
          break;
        }
      } catch {
        // No tsconfig or invalid JSON
      }
    }
    return this.tsconfigPaths;
  }

  private resolveImportSource(importSource: string, importerAbsPath: string): number | null {
    const importerDir = dirname(importerAbsPath);
    let normalized: string | null = null;

    if (importSource.startsWith("./") || importSource.startsWith("../")) {
      // Direct relative import — strip .js/.mjs/.cjs extensions that map to .ts files
      normalized = importSource.replace(/\.(m?js|cjs|jsx)$/, "");
    } else if (
      importSource.startsWith(".") &&
      !importSource.startsWith("./") &&
      !importSource.startsWith("../")
    ) {
      // Python relative imports: ".utils" → "./utils", "..models.user" → "../models/user"
      const dotMatch = importSource.match(/^(\.+)(.*)/);
      if (dotMatch) {
        const dots = dotMatch[1] ?? "";
        const rest = dotMatch[2]?.replace(/\./g, "/") ?? "";
        const levels = dots.length - 1;
        const prefix = levels === 0 ? "./" : "../".repeat(levels);
        normalized = prefix + rest;
      }
    } else if (importSource.startsWith("crate::")) {
      // Rust crate-relative: "crate::utils::foo" → "./utils/foo" (from src/)
      normalized = `./${importSource.slice(7).replace(/::/g, "/")}`;
    } else if (importSource.startsWith("super::")) {
      // Rust super-relative
      normalized = `../${importSource.slice(7).replace(/::/g, "/")}`;
    } else if (importSource.includes(".") && !importSource.startsWith(".")) {
      // Java/Kotlin/Scala package import: "com.example.utils.Parser" → "com/example/utils/Parser"
      // Also handles: "java.util.List" which won't resolve (returns null safely)
      const asPath = importSource.replace(/\./g, "/");
      const result = this.resolveRelPath(asPath);
      if (result !== null) return result;
      // Try stripping the last segment (class name) and looking for the package dir
      const lastDot = asPath.lastIndexOf("/");
      if (lastDot > 0) {
        const packagePath = asPath.slice(0, lastDot);
        const r = this.resolveRelPath(packagePath);
        if (r !== null) return r;
      }
      // Fall through to other resolvers
    } else if (importSource.includes("\\")) {
      // PHP namespace: "App\Models\User" → "App/Models/User"
      const asPath = importSource.replace(/\\/g, "/");
      const result = this.resolveRelPath(asPath);
      if (result !== null) return result;
      // Try common PHP conventions: src/, app/, lib/
      for (const prefix of ["src/", "app/", "lib/"]) {
        const r = this.resolveRelPath(prefix + asPath);
        if (r !== null) return r;
      }
    }

    // If one of the branches above set `normalized`, resolve it now
    if (normalized) {
      const base = resolve(importerDir, normalized);
      const relBase = relative(this.cwd, base);
      if (relBase.startsWith("..")) return null;
      return this.resolveRelPath(relBase);
    }

    // Try Go module prefix: "mymodule/pkg/utils" → "pkg/utils"
    const goPrefix = this.getGoModulePrefix();
    if (goPrefix && importSource.startsWith(`${goPrefix}/`)) {
      const relImport = importSource.slice(goPrefix.length + 1);
      return this.resolveRelPath(relImport);
    }

    // Try TypeScript path aliases: "@/utils" → "src/utils"
    const paths = this.getTsconfigPaths();
    if (paths) {
      for (const [prefix, replacement] of paths) {
        if (importSource.startsWith(prefix)) {
          const aliasResolved = replacement + importSource.slice(prefix.length);
          return this.resolveRelPath(aliasResolved);
        }
      }
    }

    // Ruby: "utils/parser" or "parser" — try with lib/ prefix
    if (!importSource.includes(":") && !importSource.includes("@")) {
      for (const prefix of ["lib/", ""]) {
        const r = this.resolveRelPath(prefix + importSource);
        if (r !== null) return r;
      }
    }

    return null;
  }

  private resolveRelPath(relBase: string): number | null {
    // Strip .js/.mjs/.cjs extensions that map to .ts in the files table
    const stripped = relBase.replace(/\.(m?js|cjs|jsx)$/, "");
    const base = join(this.cwd, stripped);
    const candidates = [base];
    // Also try the original path if it had an extension we stripped
    if (stripped !== relBase) candidates.push(join(this.cwd, relBase));
    const ext = extname(stripped);
    if (!ext) {
      for (const tryExt of Object.keys(INDEXABLE_EXTENSIONS)) {
        candidates.push(base + tryExt);
      }
      for (const tryExt of [".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".php"]) {
        candidates.push(join(base, `index${tryExt}`));
      }
      candidates.push(join(base, "__init__.py"));
      candidates.push(join(base, "mod.rs"));
      candidates.push(join(base, "lib.rs"));
      // Go: package directory resolves to any .go file in the dir
      // We just check if the dir matches a known file prefix
      candidates.push(`${base}.go`);
    }

    for (const candidate of candidates) {
      const relPath = relative(this.cwd, candidate);
      if (relPath.startsWith("..")) continue;
      const row = this.db
        .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
        .get(relPath);
      if (row) return row.id;
    }
    return null;
  }

  /**
   * Resolve identifier-only refs (no import_source) by matching against uniquely-exported symbols.
   * Only resolves when the ref's file already has an import-traced edge to the target file,
   * preventing false positives like matching local variable `formatDate` to an unrelated export.
   */
  private async resolveIdentifierRefs(): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    // Step 1: Build a map of symbol name → file_id for symbols exported from exactly one file
    const uniqueExports = this.db
      .query<{ name: string; file_id: number }, []>(
        `SELECT s.name, s.file_id
         FROM symbols s
         WHERE s.is_exported = 1
         GROUP BY s.name
         HAVING COUNT(DISTINCT s.file_id) = 1`,
      )
      .all();
    if (uniqueExports.length === 0) return;

    const exportMap = new Map<string, number>();
    for (const row of uniqueExports) {
      exportMap.set(row.name, row.file_id);
    }

    // Step 2: Build set of (file_id, symbol_name) for locally-defined symbols.
    // If a file defines a symbol with the same name (even non-exported),
    // the identifier ref is likely referencing the local definition, not the export.
    const localSymbols = new Set<string>();
    const allSymbols = this.db
      .query<{ file_id: number; name: string }, []>("SELECT file_id, name FROM symbols")
      .all();
    for (const row of allSymbols) {
      localSymbols.add(`${row.file_id}:${row.name}`);
    }

    // Step 3: Resolve identifier refs to unique exports directly.
    // Safe because there's only one possible target file.
    // Skip if: same file (self-ref) or file has a local symbol with the same name (shadow).
    const update = this.db.prepare("UPDATE refs SET source_file_id = ? WHERE rowid = ?");
    const unresolvedIds = this.db
      .query<{ rowid: number; file_id: number; name: string }, []>(
        `SELECT rowid, file_id, name FROM refs
         WHERE source_file_id IS NULL AND import_source IS NULL`,
      )
      .all();

    const BATCH = 200;
    for (let i = 0; i < unresolvedIds.length; i += BATCH) {
      const batch = unresolvedIds.slice(i, i + BATCH);
      const tx = this.db.transaction(() => {
        for (const ref of batch) {
          const targetFileId = exportMap.get(ref.name);
          if (targetFileId === undefined) continue;
          if (targetFileId === ref.file_id) continue; // self-ref
          if (localSymbols.has(`${ref.file_id}:${ref.name}`)) continue;
          update.run(targetFileId, ref.rowid);
        }
      });
      tx();
      if (i % 2000 === 0) this.onProgress?.(-1, -1); // heartbeat
      if (i + BATCH < unresolvedIds.length) await tick();
    }
  }

  /**
   * Second-pass resolution: resolve refs that have import_source stored but
   * source_file_id = NULL (because the target file hadn't been indexed yet).
   */
  private async resolveUnresolvedRefs(): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const unresolved = this.db
      .query<{ rowid: number; file_id: number; import_source: string }, []>(
        "SELECT rowid, file_id, import_source FROM refs WHERE source_file_id IS NULL AND import_source IS NOT NULL",
      )
      .all();
    if (unresolved.length === 0) return;

    const getFilePath = this.db.prepare<{ path: string }, [number]>(
      "SELECT path FROM files WHERE id = ?",
    );
    const update = this.db.prepare("UPDATE refs SET source_file_id = ? WHERE rowid = ?");

    // Resolve import sources in batches
    const BATCH = 100;
    for (let i = 0; i < unresolved.length; i += BATCH) {
      const batch = unresolved.slice(i, i + BATCH);
      const tx = this.db.transaction(() => {
        for (const ref of batch) {
          const fileRow = getFilePath.get(ref.file_id);
          if (!fileRow) continue;
          const absPath = join(this.cwd, fileRow.path);
          const resolved = this.resolveImportSource(ref.import_source, absPath);
          if (resolved !== null) {
            update.run(resolved, ref.rowid);
          }
        }
      });
      tx();
      if (i % 1000 === 0) this.onProgress?.(-1, -1); // heartbeat
      if (i + BATCH < unresolved.length) await tick();
    }

    // Expand export * refs: copy exported symbols from target to re-exporting file
    // Multi-pass: handles deep chains (A→B→C) and prevents circular duplication
    const insertRef = this.db.prepare(
      "INSERT INTO refs (file_id, name, source_file_id, import_source) VALUES (?, ?, ?, ?)",
    );
    const insertSymbol = this.db.prepare(
      "INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported, signature) VALUES (?, ?, ?, 1, 1, 1, NULL)",
    );
    const expanded = new Set<string>();
    const starStart = Date.now();
    for (let pass = 0; pass < 10; pass++) {
      if (Date.now() - starStart > 10_000) break; // 10s safety cap
      const starRefs = this.db
        .query<{ file_id: number; source_file_id: number }, []>(
          "SELECT file_id, source_file_id FROM refs WHERE name = '*' AND source_file_id IS NOT NULL",
        )
        .all();
      let changed = false;
      const tx = this.db.transaction(() => {
        for (const star of starRefs) {
          const key = `${String(star.file_id)}:${String(star.source_file_id)}`;
          if (expanded.has(key)) continue;
          expanded.add(key);
          const targetSymbols = this.db
            .query<{ name: string; kind: string }, [number]>(
              "SELECT name, kind FROM symbols WHERE file_id = ? AND is_exported = 1",
            )
            .all(star.source_file_id);
          for (const sym of targetSymbols) {
            const existing = this.db
              .query<{ id: number }, [number, string]>(
                "SELECT id FROM symbols WHERE file_id = ? AND name = ?",
              )
              .get(star.file_id, sym.name);
            if (!existing) {
              insertSymbol.run(star.file_id, sym.name, sym.kind);
              changed = true;
            }
            const existingRef = this.db
              .query<{ rowid: number }, [number, string, number]>(
                "SELECT rowid FROM refs WHERE file_id = ? AND name = ? AND source_file_id = ?",
              )
              .get(star.file_id, sym.name, star.source_file_id);
            if (!existingRef) {
              insertRef.run(star.file_id, sym.name, star.source_file_id, null);
            }
          }
        }
      });
      tx();
      if (!changed) break;
      await tick();
    }
  }

  private async buildEdges(): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    this.db.run("DELETE FROM edges");

    const totalFiles =
      this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM files").get()?.c ?? 1;
    const logTotal = Math.log(totalFiles);

    const edgeMap = new Map<string, { weight: number; confidence: number }>();

    const addEdge = (src: number, tgt: number, w: number, conf: number) => {
      const key = `${String(src)}:${String(tgt)}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += w;
        if (conf > existing.confidence) existing.confidence = conf;
      } else {
        edgeMap.set(key, { weight: w, confidence: conf });
      }
    };

    // Phase 1a: Import-proven edges (confidence=3)
    // Refs with import_source set are from actual import/export statements.
    const trueImportRows = this.db
      .query<
        { source_file_id: number; target_file_id: number; name: string; ref_count: number },
        []
      >(
        `SELECT r.file_id AS source_file_id, r.source_file_id AS target_file_id,
                r.name, COUNT(*) AS ref_count
         FROM refs r
         WHERE r.source_file_id IS NOT NULL
           AND r.import_source IS NOT NULL
           AND r.file_id != r.source_file_id
           AND r.name != '*'
         GROUP BY r.file_id, r.source_file_id, r.name`,
      )
      .all();

    for (let i = 0; i < trueImportRows.length; i++) {
      const row = trueImportRows[i] as (typeof trueImportRows)[number];
      addEdge(row.source_file_id, row.target_file_id, Math.sqrt(row.ref_count) * 3, 3);
      if (i % 500 === 499) await tick();
      if (i % 2000 === 0) this.onProgress?.(-3, -3);
    }

    // Pre-compute ref document frequency for IDF (used in Phase 1b and Phase 2)
    // Count ALL refs per name (not just unresolved) to catch identifiers like "install"
    // that resolveIdentifierRefs() resolved but are actually generic words.
    const refDfMap = new Map<string, number>();
    const dfRows = this.db
      .query<{ name: string; ref_df: number }, []>(
        "SELECT name, COUNT(DISTINCT file_id) AS ref_df FROM refs GROUP BY name",
      )
      .all();
    for (const row of dfRows) refDfMap.set(row.name, row.ref_df);

    // Phase 1b: Identifier-resolved edges (confidence=1)
    // Refs resolved by resolveIdentifierRefs() — source_file_id set but no import_source.
    // These include star-export expansions (legitimate) and identifier matching (noisy).
    // Apply IDF dampening to prevent false positives like "install" → soulforge.rb.
    const identResolvedRows = this.db
      .query<
        { source_file_id: number; target_file_id: number; name: string; ref_count: number },
        []
      >(
        `SELECT r.file_id AS source_file_id, r.source_file_id AS target_file_id,
                r.name, COUNT(*) AS ref_count
         FROM refs r
         WHERE r.source_file_id IS NOT NULL
           AND r.import_source IS NULL
           AND r.file_id != r.source_file_id
           AND r.name != '*'
         GROUP BY r.file_id, r.source_file_id, r.name`,
      )
      .all();

    for (let i = 0; i < identResolvedRows.length; i++) {
      const row = identResolvedRows[i] as (typeof identResolvedRows)[number];
      const refDf = refDfMap.get(row.name) ?? 1;
      // Skip identifiers referenced in >5% of files — too generic for cross-file inference
      if (refDf > totalFiles * 0.05) continue;
      const idf = Math.log((totalFiles - refDf + 0.5) / (refDf + 0.5));
      if (idf <= 0) continue;
      let w = Math.sqrt(row.ref_count) * Math.max(0.1, idf / logTotal);
      // Single-word non-compound identifiers are likely generic (install, parse, render)
      const isCompound = /[a-z][A-Z]/.test(row.name) || row.name.includes("_");
      if (!isCompound && row.name.length < 10) w *= 0.1;
      if (row.name.startsWith("_")) w *= 0.1;
      addEdge(row.source_file_id, row.target_file_id, w, 1);
      if (i % 500 === 499) await tick();
      if (i % 2000 === 0) this.onProgress?.(-3, -3);
    }

    // Phase 2: Inferred edges (confidence=1) — unique exports only + BM25 IDF
    this.onProgress?.(-3, -3);
    await tick();

    // Pre-compute export uniqueness to avoid correlated subquery in the main JOIN
    const uniqueExportNames = new Set<string>();
    const exportNameCounts = this.db
      .query<{ name: string; fc: number }, []>(
        "SELECT name, COUNT(DISTINCT file_id) as fc FROM symbols WHERE is_exported = 1 GROUP BY name HAVING fc = 1",
      )
      .all();
    for (const row of exportNameCounts) uniqueExportNames.add(row.name);

    const inferredRows = this.db
      .query<
        {
          source_file_id: number;
          target_file_id: number;
          name: string;
          ref_count: number;
        },
        []
      >(
        `SELECT r.file_id AS source_file_id, s.file_id AS target_file_id,
                r.name, COUNT(*) AS ref_count
         FROM refs r
         JOIN symbols s ON r.name = s.name AND s.is_exported = 1
         WHERE r.source_file_id IS NULL AND r.import_source IS NULL
           AND r.file_id != s.file_id
         GROUP BY r.file_id, s.file_id, r.name`,
      )
      .all();

    for (let i = 0; i < inferredRows.length; i++) {
      const row = inferredRows[i] as (typeof inferredRows)[number];
      if (!uniqueExportNames.has(row.name)) continue; // skip non-unique exports
      const refDf = refDfMap.get(row.name) ?? 1;
      // BM25-style IDF: negative = appears in >50% of files, skip
      const idf = Math.log((totalFiles - refDf + 0.5) / (refDf + 0.5));
      if (idf <= 0) continue;

      let w = Math.sqrt(row.ref_count) * Math.max(0.1, idf / logTotal);
      const isCamelOrSnake = /[a-z][A-Z]/.test(row.name) || row.name.includes("_");
      if (isCamelOrSnake && row.name.length >= 8) w *= 2;
      if (row.name.startsWith("_")) w *= 0.1;

      addEdge(row.source_file_id, row.target_file_id, w, 1);
      if (i % 500 === 499) await tick();
      if (i % 2000 === 0) this.onProgress?.(-3, -3);
    }

    // Phase 3: Co-change edges (confidence=2) — only where no import edge exists
    const cochangeRows = this.db
      .query<{ file_id_a: number; file_id_b: number; count: number }, []>(
        "SELECT file_id_a, file_id_b, count FROM cochanges WHERE count >= 3",
      )
      .all();

    for (const row of cochangeRows) {
      const w = Math.log(row.count);
      for (const [src, tgt] of [
        [row.file_id_a, row.file_id_b],
        [row.file_id_b, row.file_id_a],
      ] as const) {
        const key = `${String(src)}:${String(tgt)}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { weight: w, confidence: 2 });
        }
      }
    }

    await tick();

    // Barrel passthrough: resolve edges through barrel files to actual sources
    const barrelIds = new Set(
      this.db
        .query<{ id: number }, []>("SELECT id FROM files WHERE is_barrel = 1")
        .all()
        .map((r) => r.id),
    );
    if (barrelIds.size > 0) {
      const barrelSources = new Map<number, Array<{ source_file_id: number; cnt: number }>>();
      for (const bid of barrelIds) {
        const sources = this.db
          .query<{ source_file_id: number; cnt: number }, [number]>(
            `SELECT r.source_file_id, COUNT(*) as cnt FROM refs r
             WHERE r.file_id = ? AND r.source_file_id IS NOT NULL AND r.source_file_id != r.file_id
             GROUP BY r.source_file_id`,
          )
          .all(bid);
        if (sources.length > 0) barrelSources.set(bid, sources);
      }

      const additions: [number, number, number, number][] = [];
      for (const [key, edge] of edgeMap) {
        const [src, tgt] = key.split(":").map(Number) as [number, number];
        const sources = barrelSources.get(tgt);
        if (!sources) continue;
        for (const s of sources) {
          if (s.source_file_id === src) continue;
          additions.push([src, s.source_file_id, edge.weight * 0.8, edge.confidence]);
        }
        edge.weight *= 0.3;
      }
      for (const [src, tgt, w, conf] of additions) {
        addEdge(src, tgt, w, conf);
      }
    }

    // Insert all edges
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO edges (source_file_id, target_file_id, weight, confidence) VALUES (?, ?, ?, ?)",
    );
    const entries = [...edgeMap.entries()];
    const BATCH = 200;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const tx = this.db.transaction(() => {
        for (const [key, edge] of batch) {
          const [src, tgt] = key.split(":");
          insert.run(Number(src), Number(tgt), edge.weight, edge.confidence);
        }
      });
      try {
        tx();
      } catch {
        // database locked — edges will be rebuilt on next flush
      }
      if (i % 2000 === 0) this.onProgress?.(-3, -3);
      if (i + BATCH < entries.length) await tick();
    }
  }

  async enrichWithLsp(maxFiles = 50): Promise<number> {
    if (!this.ready) return 0;
    const { documentSymbols } = await import("./backends/lsp/nvim-bridge.js");

    // Target top files by PageRank — these benefit most from disambiguation
    const files = this.db
      .query<{ id: number; path: string }, [number]>(
        "SELECT id, path FROM files WHERE language IN ('typescript','javascript','python','rust','go','java','kotlin') ORDER BY pagerank DESC LIMIT ?",
      )
      .all(maxFiles);

    const update = this.db.prepare("UPDATE symbols SET qualified_name = ? WHERE id = ?");
    let enriched = 0;

    for (const file of files) {
      const absPath = join(this.cwd, file.path);
      let raw: unknown[] | null;
      try {
        raw = await documentSymbols(absPath);
      } catch {
        continue;
      }
      if (!raw || raw.length === 0) continue;

      // Extract containerName from LSP document symbols (walk tree structure)
      const containerMap = new Map<string, string>(); // "name:line" → containerName
      const walk = (symbols: unknown[], container?: string): void => {
        for (const sym of symbols) {
          const s = sym as Record<string, unknown>;
          const name = s.name as string;
          if (!name) continue;

          let line: number | undefined;
          if (s.range) {
            const r = s.range as { start: { line: number } };
            line = r.start.line + 1; // LSP is 0-indexed
          } else if (s.location) {
            const l = s.location as { range: { start: { line: number } } };
            line = l.range.start.line + 1;
          }

          if (line !== undefined && container) {
            containerMap.set(`${name}:${String(line)}`, container);
          }

          // Recurse into children (DocumentSymbol tree)
          if (s.children && Array.isArray(s.children)) {
            walk(s.children as unknown[], name);
          }

          // SymbolInformation has containerName directly
          if (s.containerName && typeof s.containerName === "string" && line !== undefined) {
            containerMap.set(`${name}:${String(line)}`, s.containerName as string);
          }
        }
      };
      walk(raw);

      if (containerMap.size === 0) continue;

      // Match LSP container info to DB symbols by name+line
      const dbSymbols = this.db
        .query<{ id: number; name: string; line: number }, [number]>(
          "SELECT id, name, line FROM symbols WHERE file_id = ?",
        )
        .all(file.id);

      const tx = this.db.transaction(() => {
        for (const sym of dbSymbols) {
          const container = containerMap.get(`${sym.name}:${String(sym.line)}`);
          if (container) {
            update.run(`${container}.${sym.name}`, sym.id);
            enriched++;
          }
        }
      });
      tx();
    }

    return enriched;
  }

  private linkTestFiles(): void {
    const testFiles = this.db
      .query<{ id: number; path: string }, []>(
        `SELECT f.id, f.path FROM files f
         WHERE ${RepoMap.testFileMatch()}
           AND NOT EXISTS (SELECT 1 FROM edges WHERE source_file_id = f.id)`,
      )
      .all();

    if (testFiles.length === 0) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO edges (source_file_id, target_file_id, weight, confidence) VALUES (?, ?, 1.0, 1)",
    );

    const tx = this.db.transaction(() => {
      for (const t of testFiles) {
        const subject = this.findSubjectFile(t.path);
        if (!subject) continue;
        const row = this.db
          .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
          .get(subject);
        if (row) insert.run(t.id, row.id);
      }
    });
    tx();
  }

  private findSubjectFile(testPath: string): string | null {
    // foo.test.ts → foo.ts, foo_test.go → foo.go, test_foo.py → foo.py
    const stripped = testPath
      .replace(/\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs|java|kt)$/, ".$2")
      .replace(/_test\.(go|py|rb)$/, ".$1")
      .replace(/_spec\.(rb)$/, ".$1")
      .replace(/^test_(.+\.py)$/, "$1");
    if (stripped !== testPath) {
      if (this.db.query("SELECT 1 FROM files WHERE path = ?").get(stripped)) return stripped;
    }
    // tests/foo.test.ts → src/foo.ts
    const mirrors: [RegExp, string][] = [
      [/^tests\//, "src/"],
      [/^test\//, "src/"],
      [/\/__tests__\//, "/"],
    ];
    for (const [pat, rep] of mirrors) {
      const candidate = stripped.replace(pat, rep);
      if (candidate !== stripped) {
        if (this.db.query("SELECT 1 FROM files WHERE path = ?").get(candidate)) return candidate;
      }
    }
    // Last resort: basename match
    const base = stripped.split("/").pop();
    if (base) {
      const row = this.db
        .query<{ path: string }, [string]>(
          "SELECT path FROM files WHERE path LIKE ? AND path NOT LIKE '%.test.%' AND path NOT LIKE '%.spec.%' LIMIT 1",
        )
        .get(`%/${base}`);
      if (row) return row.path;
    }
    return null;
  }

  private rescueOrphans(): void {
    const orphans = this.db
      .query<{ id: number; path: string }, []>(
        `SELECT f.id, f.path FROM files f
         WHERE f.line_count > 0
           AND f.language NOT IN ('unknown','css','html')
           AND NOT EXISTS (SELECT 1 FROM edges WHERE source_file_id = f.id OR target_file_id = f.id)`,
      )
      .all();

    if (orphans.length === 0) return;
    const insertEdge = this.db.prepare(
      "INSERT OR IGNORE INTO edges (source_file_id, target_file_id, weight, confidence) VALUES (?, ?, ?, ?)",
    );

    const tx = this.db.transaction(() => {
      for (const o of orphans) {
        // Try co-change partner
        const partner = this.db
          .query<{ pid: number; count: number }, [number, number, number]>(
            `SELECT CASE WHEN file_id_a = ? THEN file_id_b ELSE file_id_a END AS pid, count
             FROM cochanges WHERE (file_id_a = ? OR file_id_b = ?) ORDER BY count DESC LIMIT 1`,
          )
          .get(o.id, o.id, o.id);
        if (partner && partner.count >= 2) {
          insertEdge.run(o.id, partner.pid, Math.log(partner.count), 2);
          continue;
        }
        // Directory sibling fallback
        const dir = o.path.substring(0, o.path.lastIndexOf("/"));
        if (!dir) continue;
        const sibling = this.db
          .query<{ id: number }, [string, number, string]>(
            `SELECT id FROM files WHERE path LIKE ? || '/%' AND id != ?
             AND path NOT LIKE ? || '/%/%' ORDER BY pagerank DESC LIMIT 1`,
          )
          .get(dir, o.id, dir);
        if (sibling) {
          insertEdge.run(o.id, sibling.id, 0.5, 1);
        }
      }
    });
    tx();
  }

  private async computePageRank(personalization?: Map<number, number>): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const files = this.db.query<{ id: number }, []>("SELECT id FROM files").all();
    if (files.length === 0) return;

    const n = files.length;
    const idToIdx = new Map<number, number>();
    const ids: number[] = [];
    for (const file of files) {
      idToIdx.set(file.id, ids.length);
      ids.push(file.id);
    }

    const outWeight: number[] = new Array(n).fill(0);
    const adj: Array<{ from: number; to: number; weight: number }> = [];

    const edges = this.db
      .query<EdgeRow, []>("SELECT source_file_id, target_file_id, weight FROM edges")
      .all();

    for (const edge of edges) {
      const src = idToIdx.get(edge.source_file_id);
      const tgt = idToIdx.get(edge.target_file_id);
      if (src !== undefined && tgt !== undefined) {
        const w = edge.weight || 1;
        adj.push({ from: src, to: tgt, weight: w });
        outWeight[src] = (outWeight[src] ?? 0) + w;
      }
    }

    // Build personalization vector (teleport distribution)
    // Blend: 70% uniform baseline + 30% context boost for balanced ranking
    const pv = new Float64Array(n);
    const uniform = 1 / n;
    if (personalization && personalization.size > 0) {
      let boostSum = 0;
      for (const [fileId, boost] of personalization) {
        const idx = idToIdx.get(fileId);
        if (idx !== undefined) {
          pv[idx] = boost;
          boostSum += boost;
        }
      }
      if (boostSum > 0) {
        for (let i = 0; i < n; i++) {
          pv[i] = 0.7 * uniform + 0.3 * ((pv[i] ?? 0) / boostSum);
        }
      } else {
        pv.fill(uniform);
      }
    } else {
      pv.fill(uniform);
    }

    let rank = new Float64Array(n).fill(1 / n);
    let next = new Float64Array(n);

    for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
      // Teleport to personalization distribution instead of uniform
      for (let j = 0; j < n; j++) next[j] = (1 - PAGERANK_DAMPING) * (pv[j] ?? 0);

      let danglingSum = 0;
      for (let i = 0; i < n; i++) {
        if ((outWeight[i] ?? 0) === 0) danglingSum += rank[i] ?? 0;
      }
      // Dangling nodes distribute to personalization vector
      for (let j = 0; j < n; j++) {
        next[j] = (next[j] ?? 0) + PAGERANK_DAMPING * danglingSum * (pv[j] ?? 0);
      }

      for (const { from, to, weight } of adj) {
        const contribution =
          (PAGERANK_DAMPING * (rank[from] ?? 0) * weight) / (outWeight[from] ?? 1);
        next[to] = (next[to] ?? 0) + contribution;
      }
      [rank, next] = [next, rank];
      // Yield every 5 iterations to let UI breathe
      if (iter % 5 === 4) await tick();
    }

    const update = this.db.prepare("UPDATE files SET pagerank = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        update.run(rank[i] ?? 0, ids[i] ?? 0);
      }
    });
    try {
      tx();
    } catch {
      // database locked — stale pagerank values are acceptable
    }
  }

  /** Sync version for render-time personalized PageRank (small, bounded workload) */
  private computePageRankSync(personalization?: Map<number, number>): void {
    const files = this.db.query<{ id: number }, []>("SELECT id FROM files").all();
    if (files.length === 0) return;

    const n = files.length;
    const idToIdx = new Map<number, number>();
    const ids: number[] = [];
    for (const file of files) {
      idToIdx.set(file.id, ids.length);
      ids.push(file.id);
    }

    const outWeight: number[] = new Array(n).fill(0);
    const adj: Array<{ from: number; to: number; weight: number }> = [];

    const edges = this.db
      .query<EdgeRow, []>("SELECT source_file_id, target_file_id, weight FROM edges")
      .all();

    for (const edge of edges) {
      const src = idToIdx.get(edge.source_file_id);
      const tgt = idToIdx.get(edge.target_file_id);
      if (src !== undefined && tgt !== undefined) {
        const w = edge.weight || 1;
        adj.push({ from: src, to: tgt, weight: w });
        outWeight[src] = (outWeight[src] ?? 0) + w;
      }
    }

    const pv = new Float64Array(n);
    const uniform = 1 / n;
    if (personalization && personalization.size > 0) {
      let boostSum = 0;
      for (const [fileId, boost] of personalization) {
        const idx = idToIdx.get(fileId);
        if (idx !== undefined) {
          pv[idx] = boost;
          boostSum += boost;
        }
      }
      if (boostSum > 0) {
        for (let i = 0; i < n; i++) {
          pv[i] = 0.7 * uniform + 0.3 * ((pv[i] ?? 0) / boostSum);
        }
      } else {
        pv.fill(uniform);
      }
    } else {
      pv.fill(uniform);
    }

    let rank = new Float64Array(n).fill(1 / n);
    let next = new Float64Array(n);

    for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
      for (let j = 0; j < n; j++) next[j] = (1 - PAGERANK_DAMPING) * (pv[j] ?? 0);

      let danglingSum = 0;
      for (let i = 0; i < n; i++) {
        if ((outWeight[i] ?? 0) === 0) danglingSum += rank[i] ?? 0;
      }
      for (let j = 0; j < n; j++) {
        next[j] = (next[j] ?? 0) + PAGERANK_DAMPING * danglingSum * (pv[j] ?? 0);
      }

      for (const { from, to, weight } of adj) {
        const contribution =
          (PAGERANK_DAMPING * (rank[from] ?? 0) * weight) / (outWeight[from] ?? 1);
        next[to] = (next[to] ?? 0) + contribution;
      }
      [rank, next] = [next, rank];
    }

    const update = this.db.prepare("UPDATE files SET pagerank = ? WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        update.run(rank[i] ?? 0, ids[i] ?? 0);
      }
    });
    try {
      tx();
    } catch {
      // database locked — stale pagerank values are acceptable
    }
  }

  private detectGit(): boolean {
    if (this.hasGit !== null) return this.hasGit;
    try {
      execSync("git rev-parse --git-dir", { cwd: this.cwd, stdio: "pipe", timeout: 3000 });
      this.hasGit = true;
    } catch {
      this.hasGit = false;
    }
    return this.hasGit;
  }

  private async buildCoChanges(): Promise<void> {
    if (!this.detectGit()) return;

    this.db.run("DELETE FROM cochanges");

    let logOutput: string;
    try {
      const { execFile } = await import("node:child_process");
      logOutput = await new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["log", "--pretty=format:---COMMIT---", "--name-only", "-n", String(GIT_LOG_COMMITS)],
          { cwd: this.cwd, timeout: 10_000, maxBuffer: 5_000_000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      });
    } catch {
      return;
    }

    const pathToId = new Map<string, number>();
    for (const row of this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all()) {
      pathToId.set(row.path, row.id);
    }

    const pairCounts = new Map<string, number>();
    const commits = logOutput.split("---COMMIT---").filter((s) => s.trim());

    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    for (let ci = 0; ci < commits.length; ci++) {
      const commit = commits[ci] as string;
      const files = commit
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && pathToId.has(l));

      if (files.length < 2 || files.length > MAX_COCHANGE_FILES_PER_COMMIT) continue;

      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const a = files[i] as string;
          const b = files[j] as string;
          const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
      if (ci % 50 === 0) {
        this.onProgress?.(-5, -5);
        await tick(); // yield so heartbeat can be delivered
      }
    }

    if (pairCounts.size === 0) return;

    this.onProgress?.(-5, -5); // heartbeat before DB insert
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO cochanges (file_id_a, file_id_b, count) VALUES (?, ?, ?)",
    );
    const BATCH = 5000;
    const entries = [...pairCounts.entries()].filter(([, count]) => count >= 2);
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const tx = this.db.transaction(() => {
        for (const [key, count] of batch) {
          const [a, b] = key.split("\0") as [string, string];
          const idA = pathToId.get(a);
          const idB = pathToId.get(b);
          if (idA !== undefined && idB !== undefined) {
            insert.run(idA, idB, count);
          }
        }
      });
      tx();
      if (i % 10000 === 0) this.onProgress?.(-5, -5); // heartbeat
    }
  }

  private getCoChangePartners(fileIds: Set<number>): Map<number, number> {
    if (fileIds.size === 0) return new Map();

    const partners = new Map<number, number>();
    const arr = [...fileIds];
    const placeholders = arr.map(() => "?").join(",");

    const rows = this.db
      .query<{ partner_id: number; total: number }, number[]>(
        `SELECT file_id_b AS partner_id, SUM(count) AS total FROM cochanges
         WHERE file_id_a IN (${placeholders})
         GROUP BY file_id_b
         UNION ALL
         SELECT file_id_a AS partner_id, SUM(count) AS total FROM cochanges
         WHERE file_id_b IN (${placeholders})
         GROUP BY file_id_a`,
      )
      .all(...arr, ...arr);

    for (const row of rows) {
      if (!fileIds.has(row.partner_id)) {
        partners.set(row.partner_id, (partners.get(row.partner_id) ?? 0) + row.total);
      }
    }
    return partners;
  }

  private getBlastRadius(fileIds: number[]): Map<number, number> {
    if (fileIds.length === 0) return new Map();
    const placeholders = fileIds.map(() => "?").join(",");
    const rows = this.db
      .query<{ target_file_id: number; dependents: number }, number[]>(
        `SELECT target_file_id, COUNT(DISTINCT source_file_id) AS dependents
         FROM edges WHERE target_file_id IN (${placeholders})
         GROUP BY target_file_id`,
      )
      .all(...fileIds);

    const result = new Map<number, number>();
    for (const row of rows) result.set(row.target_file_id, row.dependents);
    return result;
  }

  private getEntryPoints(): string[] {
    if (this.entryPointsCache !== null) return this.entryPointsCache;
    this.entryPointsCache = [];
    try {
      const pkgPath = join(this.cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      for (const field of ["module", "main", "source"]) {
        if (typeof pkg[field] === "string") {
          this.entryPointsCache.push(pkg[field].replace(/^\.\//, ""));
        }
      }
      if (typeof pkg.bin === "string") {
        this.entryPointsCache.push(pkg.bin.replace(/^\.\//, ""));
      } else if (pkg.bin && typeof pkg.bin === "object") {
        for (const v of Object.values(pkg.bin)) {
          if (typeof v === "string") this.entryPointsCache.push(v.replace(/^\.\//, ""));
        }
      }
    } catch {}
    const commonEntryPoints = [
      // Rust
      "src/main.rs",
      "src/lib.rs",
      // Go
      "main.go",
      "cmd/main.go",
      // Python
      "main.py",
      "__main__.py",
      "app.py",
      "manage.py",
      // Java/Kotlin
      "src/main/java/Main.java",
      "src/main/kotlin/Main.kt",
      // Swift
      "Sources/main.swift",
      "Sources/App.swift",
      // C/C++
      "src/main.c",
      "src/main.cpp",
      // Dart/Flutter
      "lib/main.dart",
      // Elixir
      "lib/application.ex",
      // Ruby
      "app.rb",
      "config.ru",
    ];
    for (const p of commonEntryPoints) {
      if (existsSync(join(this.cwd, p))) this.entryPointsCache.push(p);
    }
    return this.entryPointsCache;
  }

  private getExternalDepsSummary(): string | null {
    const deps = this.db
      .query<{ package: string; file_count: number; all_specs: string | null }, []>(
        `SELECT package, COUNT(DISTINCT file_id) AS file_count,
                GROUP_CONCAT(specifiers) AS all_specs
         FROM external_imports
         GROUP BY package
         HAVING file_count >= 3
         ORDER BY file_count DESC
         LIMIT 8`,
      )
      .all();
    if (deps.length === 0) return null;

    const depLines: string[] = ["Key dependencies:"];
    for (const dep of deps) {
      const allSpecs = new Set<string>();
      if (dep.all_specs) {
        for (const s of dep.all_specs.split(",")) {
          if (s.trim()) allSpecs.add(s.trim());
        }
      }
      const topSpecs = [...allSpecs].slice(0, 5);
      const specStr =
        topSpecs.length > 0 ? ` (${topSpecs.join(", ")}${allSpecs.size > 5 ? ", …" : ""})` : "";
      depLines.push(`  ${dep.package}: ${String(dep.file_count)} files${specStr}`);
    }
    return depLines.join("\n");
  }

  setSemanticMode(mode: "off" | "ast" | "synthetic" | "llm" | "full" | "on"): void {
    this.semanticMode = mode;
  }

  getSemanticMode(): "off" | "ast" | "synthetic" | "llm" | "full" | "on" {
    return this.semanticMode;
  }

  isSemanticEnabled(): boolean {
    return this.semanticMode !== "off";
  }

  detectPersistedSemanticMode(): "off" | "ast" | "synthetic" | "llm" | "full" | "on" {
    const llm =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = 'llm'",
        )
        .get()?.c ?? 0;
    const ast =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = 'ast'",
        )
        .get()?.c ?? 0;
    const synthetic =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = 'synthetic'",
        )
        .get()?.c ?? 0;
    if (llm > 0 && synthetic > 0) return "full";
    if (llm > 0 && ast > 0) return "llm";
    if (llm > 0) return "llm";
    if (synthetic > 0) return "synthetic";
    if (ast > 0) return "ast";
    return "off";
  }

  setSummaryGenerator(generator: SummaryGenerator | null): void {
    this.summaryGenerator = generator;
  }

  generateAstSummaries(): number {
    if (!this.ready) return 0;
    const rows = this.db
      .query<
        {
          id: number;
          file_id: number;
          name: string;
          kind: string;
          line: number;
          path: string;
          mtime_ms: number;
        },
        []
      >(
        `SELECT s.id, s.file_id, s.name, s.kind, s.line, f.path, f.mtime_ms
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
           AND s.kind IN ('function','method','class','interface','type')
         ORDER BY f.pagerank DESC LIMIT 500`,
      )
      .all();

    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name) VALUES (?, 'ast', ?, ?, ?, ?)`,
    );
    let count = 0;
    const fileCache = new Map<string, string[]>();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        let lines = fileCache.get(row.path);
        if (!lines) {
          try {
            const content = readFileSync(join(this.cwd, row.path), "utf-8");
            lines = content.split("\n");
            fileCache.set(row.path, lines);
          } catch {
            continue;
          }
        }
        const doc = extractDocComment(lines, row.line - 1);
        if (doc) {
          upsert.run(row.id, doc, row.mtime_ms, row.path, row.name);
          count++;
        }
      }
    });
    tx();
    return count;
  }

  generateSyntheticSummaries(limit = 1000): number {
    if (!this.ready) return 0;
    const rows = this.db
      .query<{ id: number; name: string; kind: string; path: string; mtime_ms: number }, [number]>(
        `SELECT s.id, s.name, s.kind, f.path, f.mtime_ms
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
           AND s.kind IN ('function','method','class','interface','type')
           AND NOT EXISTS (
             SELECT 1 FROM semantic_summaries ss WHERE ss.symbol_id = s.id
           )
         ORDER BY f.pagerank DESC LIMIT ?`,
      )
      .all(limit);

    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name) VALUES (?, 'synthetic', ?, ?, ?, ?)`,
    );
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const summary = generateSyntheticSummary(row.name, row.kind, row.path);
        upsert.run(row.id, summary, row.mtime_ms, row.path, row.name);
        count++;
      }
    });
    tx();
    return count;
  }

  clearFreeSummaries(): void {
    this.db.run("DELETE FROM semantic_summaries WHERE source != 'llm'");
  }

  clearSemanticSummaries(): void {
    this.db.run("DELETE FROM semantic_summaries");
  }

  getStaleSummaryCount(): number {
    if (!this.ready) return 0;
    // Can't filter by line span in SQL (end_line often equals line for name-only nodes).
    // Count all function/method/class symbols missing fresh LLM summaries as potential stale.
    return (
      this.db
        .query<{ c: number }, []>(
          `SELECT COUNT(*) AS c FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE s.is_exported = 1
             AND s.kind IN ('function', 'method', 'class')
             AND NOT EXISTS (
               SELECT 1 FROM semantic_summaries ss
               WHERE ss.symbol_id = s.id AND ss.source = 'llm' AND ss.file_mtime = f.mtime_ms
             )`,
        )
        .get()?.c ?? 0
    );
  }

  async generateSemanticSummaries(maxSymbols = 500): Promise<number> {
    if (!this.summaryGenerator || !this.ready) return 0;

    // Smart targeting: skip self-documenting symbols (types, interfaces, enums, type aliases).
    // Prioritize: functions/methods/classes with actual logic.
    // Note: end_line often equals line (tree-sitter stores name node only),
    // so we can't filter by line span in SQL — body expansion happens in JS below.
    const topSymbols = this.db
      .query<
        {
          sym_id: number;
          name: string;
          kind: string;
          signature: string | null;
          line: number;
          end_line: number;
          file_path: string;
          file_id: number;
          file_mtime: number;
        },
        [number]
      >(
        `SELECT s.id AS sym_id, s.name, s.kind, s.signature, s.line, s.end_line,
                f.path AS file_path, f.id AS file_id, f.mtime_ms AS file_mtime
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
           AND s.kind IN ('function', 'method', 'class')
         ORDER BY f.pagerank DESC, s.line ASC
         LIMIT ?`,
      )
      .all(maxSymbols);

    // Filter to symbols that need (re)generation.
    // Key by (file_path, symbol_name) so summaries survive symbol ID changes across rescans.
    const existingById = new Map<number, number>();
    const existingByKey = new Map<string, number>();
    for (const row of this.db
      .query<{ symbol_id: number; file_mtime: number; file_path: string; symbol_name: string }, []>(
        "SELECT symbol_id, file_mtime, file_path, symbol_name FROM semantic_summaries WHERE source = 'llm'",
      )
      .all()) {
      existingById.set(row.symbol_id, row.file_mtime);
      if (row.file_path && row.symbol_name) {
        existingByKey.set(`${row.file_path}\0${row.symbol_name}`, row.file_mtime);
      }
    }

    const needed: Array<{
      symId: number;
      name: string;
      kind: string;
      signature: string | null;
      code: string;
      filePath: string;
      fileMtime: number;
      dependents: number;
      lineSpan: number;
    }> = [];

    for (const sym of topSymbols) {
      const cachedMtime =
        existingById.get(sym.sym_id) ?? existingByKey.get(`${sym.file_path}\0${sym.name}`);
      if (cachedMtime === sym.file_mtime) continue;

      const absPath = join(this.cwd, sym.file_path);
      let code = "";
      let lineSpan = sym.end_line - sym.line;
      try {
        const content = readFileSync(absPath, "utf-8");
        const lines = content.split("\n");
        const startLine = Math.max(0, sym.line - 1);
        let endLine = sym.end_line;
        if (endLine <= sym.line) {
          const limit = Math.min(startLine + 80, lines.length);
          let depth = 0;
          for (let k = startLine; k < limit; k++) {
            const l = lines[k] ?? "";
            for (const ch of l) {
              if (ch === "{" || ch === "(") depth++;
              else if (ch === "}" || ch === ")") depth--;
            }
            if (depth <= 0 && k > startLine) {
              endLine = k + 1;
              break;
            }
          }
          if (endLine <= sym.line) endLine = Math.min(startLine + 20, lines.length);
        }
        endLine = Math.min(lines.length, endLine);
        lineSpan = endLine - startLine;
        // Skip trivial functions (one-liners, simple getters)
        if (lineSpan < 5) continue;
        const snippet = lines.slice(startLine, endLine).join("\n");
        code = snippet.length > 2000 ? `${snippet.slice(0, 2000)}...` : snippet;
      } catch {
        continue;
      }

      const dependents = this.getFileBlastRadius(sym.file_path);

      needed.push({
        symId: sym.sym_id,
        name: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        code,
        filePath: sym.file_path,
        fileMtime: sym.file_mtime,
        dependents,
        lineSpan,
      });
    }

    if (needed.length === 0) return 0;

    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name)
       VALUES (?, 'llm', ?, ?, ?, ?)`,
    );
    const symExists = this.db.prepare("SELECT 1 FROM symbols WHERE id = ?");
    let count = 0;

    const SAVE_CHUNK = 10;
    for (let ci = 0; ci < needed.length; ci += SAVE_CHUNK) {
      const chunk = needed.slice(ci, ci + SAVE_CHUNK);
      const batch: SymbolForSummary[] = chunk.map((s) => ({
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        code: s.code,
        filePath: s.filePath,
        dependents: s.dependents,
        lineSpan: s.lineSpan,
      }));

      const results = await this.summaryGenerator(batch, needed.length);
      if (results.length === 0) break;

      const summaryMap = new Map<string, string>();
      const summaryMapLower = new Map<string, string>();
      for (const r of results) {
        summaryMap.set(r.name, r.summary);
        summaryMapLower.set(r.name.toLowerCase(), r.summary);
      }

      const tx = this.db.transaction(() => {
        for (const sym of chunk) {
          const summary = summaryMap.get(sym.name) ?? summaryMapLower.get(sym.name.toLowerCase());
          if (summary && symExists.get(sym.symId)) {
            upsert.run(sym.symId, summary, sym.fileMtime, sym.filePath, sym.name);
            count++;
          }
        }
      });
      tx();
    }

    if (count > 0) {
      try {
        this.db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch {}
    }

    return count;
  }

  private extractAstSummaries(
    fileId: number,
    filePath: string,
    symbols: import("./types.js").SymbolInfo[],
    exportedNames: Set<string>,
    lines: string[],
    mtime: number,
  ): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO semantic_summaries (symbol_id, source, summary, file_mtime, file_path, symbol_name) VALUES (?, 'ast', ?, ?, ?, ?)`,
    );
    const symLookup = this.db.prepare<{ id: number }, [number, string, number]>(
      "SELECT id FROM symbols WHERE file_id = ? AND name = ? AND line = ?",
    );

    const summaryKinds = new Set(["function", "method", "class", "interface", "type"]);
    const tx = this.db.transaction(() => {
      for (const sym of symbols) {
        if (!exportedNames.has(sym.name)) continue;
        if (!summaryKinds.has(sym.kind)) continue;

        const doc = extractDocComment(lines, sym.location.line - 1);
        if (!doc) continue;

        const row = symLookup.get(fileId, sym.name, sym.location.line);
        if (row) upsert.run(row.id, doc, mtime, filePath, sym.name);
      }
    });
    tx();
  }

  private getSemanticSummaries(symbolIds: number[]): Map<number, string> {
    if (!this.isSemanticEnabled() || symbolIds.length === 0) return new Map();
    const placeholders = symbolIds.map(() => "?").join(",");
    const result = new Map<number, string>();

    if (this.semanticMode === "on" || this.semanticMode === "full") {
      // Merged: load both, AST wins on conflict (it's from actual documentation)
      const rows = this.db
        .query<{ symbol_id: number; summary: string; source: string }, number[]>(
          `SELECT symbol_id, summary, source FROM semantic_summaries WHERE symbol_id IN (${placeholders}) ORDER BY source ASC`,
        )
        .all(...symbolIds);
      for (const row of rows) {
        // AST sorts before LLM — first write wins, so AST takes priority
        if (!result.has(row.symbol_id)) result.set(row.symbol_id, row.summary);
      }
    } else {
      const rows = this.db
        .query<{ symbol_id: number; summary: string }, [...number[], string]>(
          `SELECT symbol_id, summary FROM semantic_summaries WHERE symbol_id IN (${placeholders}) AND source = ?`,
        )
        .all(...symbolIds, this.semanticMode);
      for (const row of rows) result.set(row.symbol_id, row.summary);
    }
    return result;
  }

  onFileChanged(absPath: string): void {
    const relPath = relative(this.cwd, absPath);

    if (relPath === "package.json" || relPath === "Cargo.toml" || relPath === "go.mod") {
      this.entryPointsCache = null;
    }

    const ext = extname(absPath).toLowerCase();
    const language = INDEXABLE_EXTENSIONS[ext];
    if (!language) return;

    // Config/data files (json, yaml, md, etc.) produce zero symbols, imports,
    // or call edges — reindexing them on every edit is pure cost and a major
    // contributor to heap bloat during doc-rewrite sessions.
    if (language === "unknown") return;

    this.pendingReindex.set(absPath, { relPath, language });
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
    this.reindexTimer = setTimeout(() => this.flushReindex(), 150);
  }

  private flushReindex(): void {
    this.reindexTimer = null;
    const batch = new Map(this.pendingReindex);
    this.pendingReindex.clear();

    const process = async () => {
      await this.ensureTreeSitter();
      for (const [absPath, { relPath, language }] of batch) {
        try {
          const st = await statAsync(absPath);
          this.indexFile(absPath, relPath, st.mtimeMs, language);
        } catch (e) {
          this.onError?.(`reindex failed for ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.markDirty();
    };

    process().catch((e) => { console.error("[repo-map] flushReindex failed:", e instanceof Error ? e.message : String(e)); });
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
    }, DIRTY_DEBOUNCE_MS);
  }

  recheckModifiedFiles(): void {
    if (!this.ready) return;
    const files = this.db
      .query<{ path: string; mtime_ms: number }, []>("SELECT path, mtime_ms FROM files")
      .all();
    for (const f of files) {
      const absPath = join(this.cwd, f.path);
      try {
        const st = statSync(absPath);
        if (st.mtimeMs !== f.mtime_ms) {
          this.onFileChanged(absPath);
        }
      } catch {
        // file deleted — will be caught on next full scan
      }
    }
  }

  /**
   * Build function-level call graph by cross-referencing imported names with function body content.
   * Language-agnostic: uses symbol line ranges from the DB and import specifiers.
   * For each function, checks which imported names appear within its body lines.
   */
  private async buildCallGraph(): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const regexCache = new Map<string, RegExp>();
    this.db.run("DELETE FROM calls");

    const filesWithImports = this.db
      .query<{ id: number; path: string }, []>(
        `SELECT DISTINCT f.id, f.path FROM files f
         WHERE EXISTS (SELECT 1 FROM symbols s WHERE s.file_id = f.id AND s.kind IN ('function', 'method'))
           AND EXISTS (SELECT 1 FROM refs r WHERE r.file_id = f.id AND r.source_file_id IS NOT NULL)`,
      )
      .all();

    if (filesWithImports.length === 0) return;

    // Pre-read all files OUTSIDE the transaction to avoid holding DB lock during file I/O
    // Yield every 20 files to prevent UI blocking during large repos
    const fileContents = new Map<number, string[]>();
    for (let i = 0; i < filesWithImports.length; i++) {
      const file = filesWithImports[i] as (typeof filesWithImports)[number];
      try {
        const content = readFileSync(join(this.cwd, file.path), "utf-8");
        fileContents.set(file.id, content.split("\n"));
      } catch (e) {
        console.error(`[repo-map] failed to read ${file.path} for call graph:`, e instanceof Error ? e.message : String(e));
      }
      if (i % 20 === 19) await tick();
    }

    const getImports = this.db.prepare<{ name: string; source_file_id: number }, [number]>(
      `SELECT DISTINCT r.name, r.source_file_id FROM refs r
       WHERE r.file_id = ? AND r.source_file_id IS NOT NULL AND r.name != '*'`,
    );

    const getFunctions = this.db.prepare<
      { id: number; name: string; line: number; end_line: number },
      [number]
    >(
      `SELECT id, name, line, end_line FROM symbols
       WHERE file_id = ? AND kind IN ('function', 'method') AND end_line > line`,
    );

    const resolveCallee = this.db.prepare<{ id: number }, [number, string]>(
      `SELECT id FROM symbols WHERE file_id = ? AND name = ? AND is_exported = 1 LIMIT 1`,
    );

    const insertCall = this.db.prepare(
      `INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line)
       VALUES (?, ?, ?, ?, ?)`,
    );

    // Process files in batches to avoid blocking the event loop during regex matching
    const BATCH_SIZE = 15;
    for (let batchStart = 0; batchStart < filesWithImports.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, filesWithImports.length);
      const batch = filesWithImports.slice(batchStart, batchEnd);

      const tx = this.db.transaction(() => {
        for (const file of batch) {
          const lines = fileContents.get(file.id);
          if (!lines) continue;

          const imports = getImports.all(file.id);
          if (imports.length === 0) continue;

          const functions = getFunctions.all(file.id);
          if (functions.length === 0) continue;

          const importPatterns = imports.map((imp) => {
            const escaped = imp.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            let re = regexCache.get(imp.name);
            if (!re) {
              re = new RegExp(`\\b${escaped}\\b`);
              regexCache.set(imp.name, re);
            }
            return { name: imp.name, sourceFileId: imp.source_file_id, re };
          });

          for (const func of functions) {
            const bodyStart = func.line;
            const bodyEnd = Math.min(func.end_line, lines.length);
            const bodyText = lines.slice(bodyStart - 1, bodyEnd).join("\n");

            for (const imp of importPatterns) {
              if (imp.name === func.name) continue;

              if (imp.re.test(bodyText)) {
                let callLine = func.line;
                for (let i = bodyStart - 1; i < bodyEnd; i++) {
                  const ln = lines[i];
                  if (ln !== undefined && imp.re.test(ln)) {
                    callLine = i + 1;
                    break;
                  }
                }

                const calleeRow = resolveCallee.get(imp.sourceFileId, imp.name);
                insertCall.run(
                  func.id,
                  imp.name,
                  calleeRow?.id ?? null,
                  imp.sourceFileId,
                  callLine,
                );
              }
            }
          }
        }
      });
      tx();
      if (batchStart % (BATCH_SIZE * 10) === 0) this.onProgress?.(-2, -2); // heartbeat
      if (batchStart + BATCH_SIZE < filesWithImports.length) await tick();
    }
  }

  private flushPromise: Promise<void> | null = null;

  private flushIfDirty(): void {
    if (!this.dirty || this.dirtyTimer || this.flushPromise) return;
    this.dirty = false;
    this.flushPromise = this.flushAsync();
  }

  private async flushAsync(): Promise<void> {
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    try {
      await this.buildCallGraph();
      await tick();
      await this.buildEdges();
      this.linkTestFiles();
      this.rescueOrphans();
      await tick();
      await this.computePageRank();
    } catch {
      // DB closed during shutdown or locked — next flush will retry
    } finally {
      this.flushPromise = null;
    }
  }

  render(opts: RepoMapOptions = {}): string {
    this.flushIfDirty();

    // Recompute PageRank with personalization when we have conversation context
    const pv = this.buildPersonalization(opts);
    if (pv.size > 0) this.computePageRankSync(pv);

    const budget = opts.tokenBudget ?? this.computeBudget(opts.conversationTokens);
    const ranked = this.rankFiles(opts);
    if (ranked.length === 0) return "";

    const candidateCount = Math.min(ranked.length, Math.max(100, Math.ceil(budget / 40)));
    const candidateIds = ranked.slice(0, candidateCount).map((f) => f.id);
    const placeholders = candidateIds.map(() => "?").join(",");
    const allSymbols = this.db
      .query<SymbolRow, number[]>(
        `SELECT id, file_id, name, kind, line, end_line, is_exported, signature FROM symbols WHERE file_id IN (${placeholders}) AND is_exported = 1 AND kind != 'variable' AND kind != 'constant' ORDER BY file_id, line`,
      )
      .all(...candidateIds);

    const symbolsByFile = new Map<number, SymbolRow[]>();
    for (const sym of allSymbols) {
      let arr = symbolsByFile.get(sym.file_id);
      if (!arr) {
        arr = [];
        symbolsByFile.set(sym.file_id, arr);
      }
      arr.push(sym);
    }

    // Fallback for constant-only files (e.g. headless/constants.ts): include exported
    // variables/constants for files that would otherwise render with zero symbols.
    const emptyFileIds = candidateIds.filter((id) => !symbolsByFile.has(id));
    if (emptyFileIds.length > 0) {
      const ph2 = emptyFileIds.map(() => "?").join(",");
      const constSymbols = this.db
        .query<SymbolRow, number[]>(
          `SELECT id, file_id, name, kind, line, end_line, is_exported, signature FROM symbols WHERE file_id IN (${ph2}) AND is_exported = 1 AND (kind = 'variable' OR kind = 'constant') ORDER BY file_id, line`,
        )
        .all(...emptyFileIds);
      for (const sym of constSymbols) {
        let arr = symbolsByFile.get(sym.file_id);
        if (!arr) {
          arr = [];
          symbolsByFile.set(sym.file_id, arr);
        }
        arr.push(sym);
      }
    }

    // Blast radius: how many files depend on each candidate
    const blastRadius = this.getBlastRadius(candidateIds);

    // Semantic summaries: collect all symbol IDs (including constant fallback) before lookup
    const allSymbolIds: number[] = [];
    for (const syms of symbolsByFile.values()) {
      for (const s of syms) allSymbolIds.push(s.id);
    }
    const semanticMap = this.getSemanticSummaries(allSymbolIds);

    // Caller counts: collect all symbol names for badge lookup
    const allSymbolNames: string[] = [];
    for (const syms of symbolsByFile.values()) {
      for (const s of syms) allSymbolNames.push(s.name);
    }
    const callerDetails = this.getCallerDetails(allSymbolNames);

    // [NEW] marks files modified within the last 48h — recency signal, not session memory
    const recentCutoff = Date.now() - 48 * 60 * 60 * 1000;

    // Re-export detection: only structural is_barrel files show ← arrows
    const reexportSources = new Map<number, Map<string, number>>(); // file_id → source_path → count
    const barrelIdSet = new Set<number>();
    {
      const barrelFileIds = this.db
        .query<{ id: number }, []>("SELECT id FROM files WHERE is_barrel = 1")
        .all()
        .map((r) => r.id);
      for (const id of barrelFileIds) barrelIdSet.add(id);
      if (barrelFileIds.length > 0) {
        const ph = barrelFileIds.map(() => "?").join(",");
        const rows = this.db
          .query<{ file_id: number; source_path: string; cnt: number }, number[]>(
            `SELECT r.file_id, f2.path AS source_path, COUNT(*) AS cnt
             FROM refs r
             JOIN files f2 ON f2.id = r.source_file_id
             WHERE r.file_id IN (${ph}) AND r.source_file_id IS NOT NULL
             GROUP BY r.file_id, r.source_file_id`,
          )
          .all(...barrelFileIds);
        for (const row of rows) {
          let m = reexportSources.get(row.file_id);
          if (!m) {
            m = new Map();
            reexportSources.set(row.file_id, m);
          }
          m.set(row.source_path, row.cnt);
        }
      }
    }

    // Symbol cap: prioritize functions > classes > types > variables
    const KIND_PRIORITY: Record<string, number> = {
      function: 0,
      method: 0,
      class: 1,
      enum: 2,
      interface: 3,
      type: 3,
      variable: 4,
      constant: 4,
    };
    const MAX_SYMBOLS_PER_FILE = 12;

    // Pre-compute all file blocks for binary search
    const blocks: Array<{ path: string; fileLine: string; symbolLines: string; tokens: number }> =
      [];
    for (const file of ranked) {
      const radius = blastRadius.get(file.id);
      const radiusTag = radius && radius >= 2 ? ` (→${String(radius)})` : "";
      const newTag = file.mtime_ms >= recentCutoff ? " [NEW]" : "";
      const fileLine = `${file.path}:${radiusTag}${newTag}`;
      const symbols = symbolsByFile.get(file.id) ?? [];
      const sources = reexportSources.get(file.id);
      const isBarrel = barrelIdSet.has(file.id);
      let symbolLines = "";

      // Barrel files: show only ← arrows, skip individual symbols
      if (isBarrel && sources && sources.size > 0) {
        const parts: string[] = [];
        for (const [srcPath, cnt] of [...sources.entries()].sort((a, b) => b[1] - a[1])) {
          parts.push(`${srcPath} (${String(cnt)})`);
        }
        symbolLines += `  ← ${parts.join(", ")}\n`;
      } else {
        // Filter out line-1 synthetic re-exports (created by star-export expansion)
        const filtered = symbols.filter((s) => !(s.line === 1 && s.is_exported && s.end_line <= 1));

        // Sort by kind priority (functions first), then line number, and cap
        const sorted = [...filtered].sort((a, b) => {
          const pa = KIND_PRIORITY[a.kind] ?? 5;
          const pb = KIND_PRIORITY[b.kind] ?? 5;
          return pa !== pb ? pa - pb : a.line - b.line;
        });
        const capped = sorted.slice(0, MAX_SYMBOLS_PER_FILE);
        const overflow = filtered.length - capped.length;

        for (const sym of capped) {
          const exported = sym.is_exported ? "+" : " ";
          const semantic = semanticMap.get(sym.id);
          const rawSig = sym.signature
            ? sym.kind === "variable" || sym.kind === "constant"
              ? sym.signature.replace(/^export\s+(const|let|var)\s+/, "")
              : sym.signature
            : null;

          // Skip trivial synthetic summaries that just restate the identifier name
          let display: string;
          if (semantic) {
            const colonIdx = semantic.indexOf(": ");
            if (colonIdx !== -1) {
              const afterColon = semantic.slice(colonIdx + 2).trim();
              const nameWords = sym.name
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/_/g, " ")
                .toLowerCase();
              if (afterColon === nameWords) {
                display = rawSig ?? `${kindTag(sym.kind as SymbolKind)}${sym.name}`;
              } else {
                display = `${sym.name} — ${semantic}`;
              }
            } else {
              display = `${sym.name} — ${semantic}`;
            }
          } else {
            display = rawSig ?? `${kindTag(sym.kind as SymbolKind)}${sym.name}`;
          }

          const callerInfo = callerDetails.get(sym.name);
          let callerBadge = "";
          if (callerInfo) {
            const names = callerInfo.topCallers.join(", ");
            const remaining = callerInfo.count - callerInfo.topCallers.length;
            callerBadge = remaining > 0 ? ` [${names}, +${String(remaining)}↑]` : ` [${names}]`;
          }
          symbolLines += `  ${exported}${display} :${String(sym.line)}${callerBadge}\n`;
        }
        if (overflow > 0) {
          symbolLines += `  ... +${String(overflow)} more exports\n`;
        }
      }
      const blockTokens = estimateTokens(fileLine) + estimateTokens(symbolLines);
      blocks.push({ path: file.path, fileLine, symbolLines, tokens: blockTokens });
    }

    // Binary search: find the max number of blocks that fit within budget
    let lo = 1;
    let hi = Math.min(blocks.length, Math.ceil(budget / 5));
    let bestCount = 1;
    let bestTokens = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      let total = 0;
      for (let i = 0; i < mid; i++) total += blocks[i]?.tokens ?? 0;
      if (total <= budget) {
        bestCount = mid;
        bestTokens = total;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Try to squeeze in one more block if we have remaining budget
    if (bestCount < blocks.length) {
      const nextBlock = blocks[bestCount];
      if (nextBlock && bestTokens + nextBlock.tokens <= budget * 1.05) {
        bestCount++;
      }
    }

    // Directory coverage: ensure major directories aren't invisible
    const coverageBlocks: typeof blocks = [];
    {
      const representedDirs = new Set<string>();
      for (let i = 0; i < bestCount; i++) {
        const dir = getDirGroup(blocks[i]?.path ?? "");
        if (dir) representedDirs.add(dir);
      }
      const dirCounts = new Map<string, number>();
      for (const b of blocks) {
        const dir = getDirGroup(b.path);
        if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }
      let usedTokens = 0;
      for (let i = 0; i < bestCount; i++) usedTokens += blocks[i]?.tokens ?? 0;
      const reserve = budget * 0.1;
      for (let i = bestCount; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b) continue;
        const dir = getDirGroup(b.path);
        if (!dir || representedDirs.has(dir) || (dirCounts.get(dir) ?? 0) < 3) continue;
        if (usedTokens + b.tokens > budget + reserve) continue;
        coverageBlocks.push(b);
        usedTokens += b.tokens;
        representedDirs.add(dir);
      }
    }

    const lines: string[] = [];
    const depsSummary = this.getExternalDepsSummary();
    if (depsSummary) lines.push(depsSummary, "");
    if (semanticMap.size > 0) {
      const tagMap: Record<string, string> = {
        ast: "[AST]",
        synthetic: "[AST+SYN]",
        llm: "[LLM]",
        full: "[AST+LLM+SYN]",
        on: "[AST+LLM]",
        off: "",
      };
      const tag = tagMap[this.semanticMode] ?? "";
      lines.push(`Summaries: ${tag} ${String(semanticMap.size)} symbols`, "");
    }

    const currentPaths: string[] = [];
    for (let i = 0; i < bestCount; i++) {
      const block = blocks[i];
      if (!block) break;
      lines.push(block.fileLine);
      if (block.symbolLines) lines.push(block.symbolLines.trimEnd());
      currentPaths.push(block.path);
    }
    for (const block of coverageBlocks) {
      lines.push(block.fileLine);
      if (block.symbolLines) lines.push(block.symbolLines.trimEnd());
      currentPaths.push(block.path);
    }

    // Lazy regen: after render, check for stale LLM summaries and notify
    if (
      (this.semanticMode === "llm" || this.semanticMode === "on") &&
      this.summaryGenerator &&
      this.onStaleSymbols
    ) {
      if (this.regenTimer) clearTimeout(this.regenTimer);
      this.regenTimer = setTimeout(() => {
        this.regenTimer = null;
        const stale = this.getStaleSummaryCount();
        if (stale > 0) this.onStaleSymbols?.(stale);
      }, 2000);
    }

    this.lastRenderedPaths = currentPaths;
    return lines.join("\n");
  }

  private buildPersonalization(opts: RepoMapOptions): Map<number, number> {
    const pv = new Map<number, number>();
    const mentionedSet = new Set((opts.mentionedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editedSet = new Set((opts.editedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editorRel = opts.editorFile ? relative(this.cwd, opts.editorFile) : null;
    const entryPoints = new Set(this.getEntryPoints());

    if (mentionedSet.size === 0 && editedSet.size === 0 && !editorRel && entryPoints.size === 0)
      return pv;

    const allFiles = this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all();

    const contextFileIds = new Set<number>();
    const base = 100 / Math.max(allFiles.length, 1);
    for (const f of allFiles) {
      let boost = base;
      if (editedSet.has(f.path)) {
        boost += base * 5;
        contextFileIds.add(f.id);
      }
      if (mentionedSet.has(f.path)) {
        boost += base * 3;
        contextFileIds.add(f.id);
      }
      if (f.path === editorRel) {
        boost += base * 2;
        contextFileIds.add(f.id);
      }
      if (entryPoints.has(f.path)) {
        boost += base * 4;
        contextFileIds.add(f.id);
      }
      if (boost > base) pv.set(f.id, boost);
    }

    // Co-change partners get a lighter boost in personalization
    const coPartners = this.getCoChangePartners(contextFileIds);
    for (const [fileId, count] of coPartners) {
      if (!pv.has(fileId)) {
        pv.set(fileId, base + base * Math.min(count / 3, 2));
      }
    }

    return pv;
  }

  private computeBudget(conversationTokens?: number): number {
    if (!conversationTokens || conversationTokens < 1000) return DEFAULT_TOKEN_BUDGET;
    // Gentle decay — keeps 80% of budget even at 100k tokens.
    // Deep conversations need MORE context, not less.
    const scale = Math.max(0.6, 1 - (conversationTokens / 100_000) * 0.4);
    return Math.round(MIN_TOKEN_BUDGET + (MAX_TOKEN_BUDGET - MIN_TOKEN_BUDGET) * scale);
  }

  private rankFiles(opts: RepoMapOptions): FileRow[] {
    const allFiles = this.db
      .query<FileRow, []>(
        "SELECT id, path, mtime_ms, language, line_count, symbol_count, pagerank FROM files ORDER BY pagerank DESC",
      )
      .all();

    // Neighbor boosting (files connected to context files via edges)
    const mentionedSet = new Set((opts.mentionedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editedSet = new Set((opts.editedFiles ?? []).map((f) => relative(this.cwd, f)));
    const editorRel = opts.editorFile ? relative(this.cwd, opts.editorFile) : null;

    const neighborFiles = new Set<number>();
    const boostFileIds = new Set<number>();
    for (const f of allFiles) {
      if (mentionedSet.has(f.path) || editedSet.has(f.path) || f.path === editorRel) {
        boostFileIds.add(f.id);
      }
    }
    if (boostFileIds.size > 0) {
      const boostArr = [...boostFileIds];
      const placeholders = boostArr.map(() => "?").join(",");
      const params = [...boostArr, ...boostArr];
      const neighbors = this.db
        .query<{ target_file_id: number }, number[]>(
          `SELECT DISTINCT target_file_id FROM edges WHERE source_file_id IN (${placeholders})
           UNION
           SELECT DISTINCT source_file_id FROM edges WHERE target_file_id IN (${placeholders})`,
        )
        .all(...params);
      for (const row of neighbors) neighborFiles.add(row.target_file_id);
    }

    // Co-change partners: files that historically change together with context files
    const coChangePartners = this.getCoChangePartners(boostFileIds);

    // PageRank already incorporates mentioned/edited/editor boosts via personalization.
    // Post-hoc: add FTS, neighbor, and co-change signals that PageRank can't capture.
    const contextFileIds = new Set([...boostFileIds, ...neighborFiles]);
    const scored = allFiles
      .filter((f) => {
        // Skip config/data files with no symbols unless they're in the conversation context
        if (f.symbol_count === 0 && !contextFileIds.has(f.id)) return false;
        return true;
      })
      .map((f) => {
        let score = f.pagerank * 1000;
        if (neighborFiles.has(f.id)) score += 1;
        const cochangeCount = coChangePartners.get(f.id);
        if (cochangeCount) score += Math.min(cochangeCount / 5, 3);
        return { ...f, score };
      });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /** Find symbol matches by name (case-insensitive). Returns ranked results with mtime validation. */
  findSymbols(
    name: string,
  ): Array<{ path: string; kind: string; isExported: boolean; pagerank: number }> {
    const rows = this.db
      .query<
        { path: string; kind: string; is_exported: number; pagerank: number; mtime_ms: number },
        [string, string]
      >(
        `SELECT f.path, s.kind, s.is_exported, f.pagerank, f.mtime_ms
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE (s.name = ? OR LOWER(s.name) = LOWER(?))
           AND s.kind IN ('interface','type','class','function','enum','variable','method')
         ORDER BY s.is_exported DESC, f.pagerank DESC
         LIMIT 10`,
      )
      .all(name, name);

    const results: Array<{ path: string; kind: string; isExported: boolean; pagerank: number }> =
      [];
    const seenPaths = new Set<string>();
    for (const row of rows) {
      const absPath = join(this.cwd, row.path);

      // Deduplicate by path
      if (seenPaths.has(absPath)) continue;
      seenPaths.add(absPath);

      // Mtime check — skip stale entries
      try {
        const stat = statSync(absPath);
        if (Math.abs(stat.mtimeMs - row.mtime_ms) > 1000) continue;
      } catch {
        continue; // file no longer exists
      }

      results.push({
        path: absPath,
        kind: row.kind,
        isExported: row.is_exported === 1,
        pagerank: row.pagerank,
      });
    }

    // Deprioritize .d.ts files when non-.d.ts matches exist
    const hasSource = results.some((r) => !r.path.endsWith(".d.ts"));
    if (hasSource) {
      return results.filter((r) => !r.path.endsWith(".d.ts"));
    }
    return results;
  }

  getFileSymbols(
    relPath: string,
  ): Array<{ name: string; kind: string; isExported: boolean; line: number; endLine: number }> {
    return this.db
      .query<
        { name: string; kind: string; is_exported: number; line: number; end_line: number },
        [string]
      >(
        `SELECT s.name, s.kind, s.is_exported, s.line, s.end_line
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ?
           AND s.kind IN ('interface','type','class','function','enum','method','constant')
           AND s.is_exported = 1
         ORDER BY s.line
         LIMIT 15`,
      )
      .all(relPath)
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        isExported: r.is_exported === 1,
        line: r.line,
        endLine: r.end_line,
      }));
  }

  /** Get a compact diff block for a file: exported symbols with signatures + blast radius. */
  getFileDiffBlock(relPath: string): {
    blastRadius: number;
    symbols: Array<{ name: string; kind: string; signature: string | null; line: number }>;
  } {
    const fileRow = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);
    if (!fileRow) return { blastRadius: 0, symbols: [] };

    const blastRadius =
      this.db
        .query<{ c: number }, [number]>(
          "SELECT COUNT(DISTINCT source_file_id) AS c FROM edges WHERE target_file_id = ?",
        )
        .get(fileRow.id)?.c ?? 0;

    const symbols = this.db
      .query<{ name: string; kind: string; signature: string | null; line: number }, [number]>(
        `SELECT s.name, s.kind, s.signature, s.line
         FROM symbols s
         WHERE s.file_id = ?
           AND s.is_exported = 1
           AND s.kind IN ('interface','type','class','function','enum','method')
         ORDER BY s.line
         LIMIT 10`,
      )
      .all(fileRow.id);

    return { blastRadius, symbols };
  }

  getFileSymbolRanges(relPath: string): Array<{
    name: string;
    qualifiedName: string | null;
    kind: string;
    line: number;
    endLine: number | null;
  }> {
    return this.db
      .query<
        {
          name: string;
          qualified_name: string | null;
          kind: string;
          line: number;
          end_line: number | null;
        },
        [string]
      >(
        `SELECT s.name, s.qualified_name, s.kind, s.line, s.end_line
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ?
           AND s.kind IN ('interface','type','class','function','enum','method','constant')
           AND s.is_exported = 1
         ORDER BY s.line
         LIMIT 20`,
      )
      .all(relPath)
      .map((r) => ({
        name: r.name,
        qualifiedName: r.qualified_name,
        kind: r.kind,
        line: r.line,
        endLine: r.end_line,
      }));
  }

  /** Legacy single-result lookup. Returns the best match absolute path or null. */
  findSymbol(name: string): string | null {
    const matches = this.findSymbols(name);
    return matches.length > 0 ? (matches[0] as { path: string }).path : null;
  }

  /** Substring search on symbol names — finds symbols containing the query (e.g. "provider" → "createOpenAIProvider") */
  searchSymbolsSubstring(
    query: string,
    limit = 15,
  ): Array<{ name: string; path: string; kind: string; isExported: boolean; pagerank: number }> {
    const safe = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const like = `%${safe}%`;
    const rows = this.db
      .query<
        {
          name: string;
          path: string;
          kind: string;
          is_exported: number;
          pagerank: number;
          mtime_ms: number;
        },
        [string, number]
      >(
        `SELECT s.name, f.path, s.kind, s.is_exported, f.pagerank, f.mtime_ms
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE LOWER(s.name) LIKE LOWER(?) ESCAPE '\\'
           AND s.kind IN ('interface','type','class','function','enum','variable','method')
         ORDER BY s.is_exported DESC, f.pagerank DESC
         LIMIT ?`,
      )
      .all(like, limit);

    const results: Array<{
      name: string;
      path: string;
      kind: string;
      isExported: boolean;
      pagerank: number;
    }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.name}@${row.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const absPath = join(this.cwd, row.path);
      try {
        const stat = statSync(absPath);
        if (Math.abs(stat.mtimeMs - row.mtime_ms) > 1000) continue;
      } catch {
        continue;
      }
      results.push({
        name: row.name,
        path: absPath,
        kind: row.kind,
        isExported: row.is_exported === 1,
        pagerank: row.pagerank,
      });
    }
    return results;
  }

  /** FTS prefix/token search on symbol names (e.g. "build*", "detect*") */
  searchSymbolsFts(
    query: string,
    limit = 20,
  ): Array<{
    name: string;
    path: string;
    kind: string;
    line: number;
    isExported: boolean;
    pagerank: number;
  }> {
    if (!this.ready) return [];
    // Sanitize: strip FTS special chars except * for prefix
    const safe = query.replace(/[^a-zA-Z0-9_*]/g, "");
    if (!safe || safe === "*") return [];
    const rows = this.db
      .query<
        {
          name: string;
          path: string;
          kind: string;
          line: number;
          is_exported: number;
          pagerank: number;
        },
        [string, number]
      >(
        `SELECT s.name, f.path, s.kind, s.line, s.is_exported, f.pagerank
           FROM symbols_fts fts
           JOIN symbols s ON s.rowid = fts.rowid
           JOIN files f ON f.id = s.file_id
           WHERE symbols_fts MATCH ?
             AND s.kind IN ('interface','type','class','function','enum','variable','method')
           ORDER BY s.is_exported DESC, f.pagerank DESC
           LIMIT ?`,
      )
      .all(safe, limit);

    const seen = new Set<string>();
    const results: Array<{
      name: string;
      path: string;
      kind: string;
      line: number;
      isExported: boolean;
      pagerank: number;
    }> = [];
    for (const row of rows) {
      const key = `${row.name}@${row.path}:${row.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        name: row.name,
        path: row.path,
        kind: row.kind,
        line: row.line,
        isExported: row.is_exported === 1,
        pagerank: row.pagerank,
      });
    }
    return results;
  }

  /** Match indexed files by SQL LIKE pattern (e.g. "%/providers/%" or "%.ts") */
  matchFiles(likePattern: string, limit = 20): string[] {
    const rows = this.db
      .query<{ path: string; mtime_ms: number }, [string, number]>(
        "SELECT path, mtime_ms FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY pagerank DESC LIMIT ?",
      )
      .all(likePattern, limit);
    const results: string[] = [];
    for (const row of rows) {
      const absPath = join(this.cwd, row.path);
      try {
        const stat = statSync(absPath);
        if (Math.abs(stat.mtimeMs - row.mtime_ms) > 1000) continue;
      } catch {
        continue;
      }
      results.push(absPath);
    }
    return results;
  }

  private queryEdges(
    relPath: string,
    direction: "dependents" | "dependencies",
  ): Array<{ path: string; weight: number }> {
    if (!this.ready) return [];
    const fileRow = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);
    if (!fileRow) return [];
    const [joinCol, whereCol] =
      direction === "dependents"
        ? ["source_file_id", "target_file_id"]
        : ["target_file_id", "source_file_id"];
    return this.db
      .query<{ path: string; weight: number }, [number]>(
        `SELECT f.path, e.weight FROM edges e
         JOIN files f ON f.id = e.${joinCol}
         WHERE e.${whereCol} = ?
         ORDER BY e.weight DESC LIMIT 30`,
      )
      .all(fileRow.id);
  }

  getFileDependents(relPath: string): Array<{ path: string; weight: number }> {
    return this.queryEdges(relPath, "dependents");
  }

  getFileDependencies(relPath: string): Array<{ path: string; weight: number }> {
    return this.queryEdges(relPath, "dependencies");
  }

  getFileCoChanges(relPath: string): Array<{ path: string; count: number }> {
    if (!this.ready) return [];
    const fileRow = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);
    if (!fileRow) return [];
    const rows = this.db
      .query<{ path: string; total: number }, [number, number]>(
        `SELECT f.path, sub.total FROM (
           SELECT file_id_b AS partner_id, SUM(count) AS total FROM cochanges WHERE file_id_a = ?
           UNION ALL
           SELECT file_id_a AS partner_id, SUM(count) AS total FROM cochanges WHERE file_id_b = ?
         ) sub
         JOIN files f ON f.id = sub.partner_id
         ORDER BY sub.total DESC LIMIT 20`,
      )
      .all(fileRow.id, fileRow.id);
    return rows.map((r) => ({ path: r.path, count: r.total }));
  }

  getIdentifierFrequency(limit = 25): Array<{ name: string; fileCount: number }> {
    if (!this.ready) return [];
    return this.db
      .query<{ name: string; fileCount: number }, [number]>(
        `SELECT name, COUNT(DISTINCT file_id) AS fileCount FROM refs
         GROUP BY name ORDER BY fileCount DESC LIMIT ?`,
      )
      .all(limit);
  }

  getUnusedExports(limit = 500): Array<{
    name: string;
    path: string;
    kind: string;
    line: number;
    endLine: number;
    lineCount: number;
    usedInternally: boolean;
  }> {
    if (!this.ready) return [];
    const rows = this.db
      .query<
        {
          name: string;
          path: string;
          kind: string;
          line: number;
          end_line: number;
          line_count: number;
        },
        [number]
      >(
        `SELECT s.name, f.path, s.kind, s.line, s.end_line, f.line_count FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
         AND NOT EXISTS (
           SELECT 1 FROM refs r WHERE r.name = s.name AND r.file_id != s.file_id
           AND (
             r.source_file_id = s.file_id
             OR (r.source_file_id IS NULL AND (
               SELECT COUNT(*) FROM symbols s2
               WHERE s2.name = s.name AND s2.is_exported = 1
             ) = 1)
           )
         )
         ORDER BY f.pagerank DESC
         LIMIT ?`,
      )
      .all(limit);

    // Filter out files in languages where we can't track imports --
    // we can't determine if they're truly unused via import graph analysis.
    const trackable = rows.filter((row) => {
      const ext = extname(row.path).toLowerCase();
      const lang = INDEXABLE_EXTENSIONS[ext];
      return lang != null && IMPORT_TRACKABLE_LANGUAGES.has(lang);
    });

    const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return trackable.map((row) => {
      let usedInternally = false;
      try {
        const raw = readFileSync(join(this.cwd, row.path), "utf-8");
        const content = raw
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, "")
          .replace(/^\s*export\s+(type\s+)?\{[^}]*\}/gm, "");
        const re = new RegExp(`\\b${escaped(row.name)}\\b`, "g");
        const matches = content.match(re);
        usedInternally = (matches?.length ?? 0) > 1;
      } catch {
        // file unreadable — assume not used internally
      }
      return {
        name: row.name,
        path: row.path,
        kind: row.kind,
        line: row.line,
        endLine: row.end_line,
        lineCount: row.line_count,
        usedInternally,
      };
    });
  }

  getTestOnlyExports(): Array<{
    name: string;
    path: string;
    kind: string;
    line: number;
    endLine: number;
  }> {
    if (!this.ready) return [];
    return this.db
      .query<{ name: string; path: string; kind: string; line: number; end_line: number }, []>(
        `SELECT s.name, f.path, s.kind, s.line, s.end_line FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.is_exported = 1
         AND EXISTS (
           SELECT 1 FROM refs r
           JOIN files rf ON rf.id = r.file_id
           WHERE r.name = s.name AND r.file_id != s.file_id
           AND (
             r.source_file_id = s.file_id
             OR (r.source_file_id IS NULL AND (
               SELECT COUNT(*) FROM symbols s2
               WHERE s2.name = s.name AND s2.is_exported = 1
             ) = 1)
           )
           AND ${RepoMap.testFileMatch("rf")}
         )
         AND NOT EXISTS (
           SELECT 1 FROM refs r
           JOIN files rf ON rf.id = r.file_id
           WHERE r.name = s.name AND r.file_id != s.file_id
           AND (
             r.source_file_id = s.file_id
             OR (r.source_file_id IS NULL AND (
               SELECT COUNT(*) FROM symbols s2
               WHERE s2.name = s.name AND s2.is_exported = 1
             ) = 1)
           )
           AND ${RepoMap.notTestFile("rf")}
         )
         ORDER BY f.path`,
      )
      .all()
      .map((r) => ({
        name: r.name,
        path: r.path,
        kind: r.kind,
        line: r.line,
        endLine: r.end_line,
      }));
  }

  getDeadBarrels(): Array<{ path: string; lineCount: number; language: string }> {
    if (!this.ready) return [];

    // Barrel patterns by language ecosystem:
    // JS/TS: index.ts, index.js, index.tsx, index.mts, index.mjs
    // Python: __init__.py
    // Rust: mod.rs, lib.rs
    // Dart: barrel .dart files that only re-export
    // C/C++: umbrella headers detected by edge analysis
    // Ruby: lib/foo.rb for lib/foo/ directory (detected by edge analysis)
    const barrels = this.db
      .query<{ id: number; path: string; line_count: number; language: string }, []>(
        `SELECT f.id, f.path, f.line_count, f.language FROM files f
         WHERE f.path LIKE '%/index.ts'
         OR f.path LIKE '%/index.js'
         OR f.path LIKE '%/index.tsx'
         OR f.path LIKE '%/index.mts'
         OR f.path LIKE '%/index.mjs'
         OR f.path LIKE '%/__init__.py'
         OR f.path LIKE '%/mod.rs'`,
      )
      .all();
    if (barrels.length === 0) return [];

    const barrelDirMap = new Map<string, (typeof barrels)[0]>();
    for (const b of barrels) {
      barrelDirMap.set(barrelToDir(b.path), b);
    }

    // Check import_source refs for liveness
    const allRefs = this.db
      .query<{ file_path: string; import_source: string }, []>(
        `SELECT DISTINCT f.path AS file_path, r.import_source FROM refs r
         JOIN files f ON f.id = r.file_id
         WHERE r.import_source IS NOT NULL AND r.import_source != ''`,
      )
      .all();

    // Build basename → dir lookup for non-relative imports (Python packages, Rust crate::)
    const barrelBasenames = new Map<string, string>();
    for (const dir of barrelDirMap.keys()) {
      const base = dir.substring(dir.lastIndexOf("/") + 1);
      barrelBasenames.set(base, dir);
    }

    const liveDirs = new Set<string>();
    for (const ref of allRefs) {
      const importerDir = ref.file_path.substring(0, ref.file_path.lastIndexOf("/")) || ".";
      let resolved = ref.import_source;
      if (resolved.startsWith(".")) {
        resolved = join(importerDir, resolved).replace(/\\/g, "/");
      } else {
        // Non-relative: Python `from pkg import X`, Rust `crate::mod::X`
        // Extract the first meaningful segment and match against barrel directory basenames
        const segments = resolved.replace(/^crate::/, "").split(/[:./]/);
        for (const seg of segments) {
          if (seg && barrelBasenames.has(seg)) {
            const dir = barrelBasenames.get(seg);
            if (dir) liveDirs.add(dir);
          }
        }
      }
      // Strip extensions for matching
      resolved = resolved.replace(/\.(ts|js|tsx|mts|mjs|py|rs)$/, "");
      if (barrelDirMap.has(resolved)) liveDirs.add(resolved);
      // ./index, ./mod, ./__init__ patterns
      const stripped = resolved.replace(/\/(index|mod|__init__)$/, "");
      if (barrelDirMap.has(stripped)) liveDirs.add(stripped);
    }

    // Also check edges — if any file *outside* the barrel's directory imports it.
    // Edges from sibling files (e.g. core.py → __init__.py) are internal package
    // references and don't count as external consumers.
    const liveByEdge = this.db
      .query<{ path: string; source_path: string }, []>(
        `SELECT f.path, src.path AS source_path FROM files f
           JOIN edges e ON e.target_file_id = f.id
         JOIN files src ON src.id = e.source_file_id
           WHERE (f.path LIKE '%/index.ts' OR f.path LIKE '%/index.js' OR f.path LIKE '%/index.tsx'
             OR f.path LIKE '%/index.mts' OR f.path LIKE '%/index.mjs'
             OR f.path LIKE '%/__init__.py' OR f.path LIKE '%/mod.rs')`,
      )
      .all();
    for (const f of liveByEdge) {
      const barrelDir = barrelToDir(f.path);
      const sourceDir = f.source_path.substring(0, f.source_path.lastIndexOf("/")) || ".";
      // Only count as live if the edge comes from outside the barrel's directory
      if (sourceDir !== barrelDir) {
        liveDirs.add(barrelDir);
      }
    }

    // Fallback: non-relative imports (Python packages, Rust crate::) don't store
    // import_source or edges. Check if any external file has a ref whose name
    // matches the barrel's directory basename (e.g., "live_pkg", "live_mod").
    // Exclude refs from files inside the barrel's own directory (sibling modules).
    for (const [dir] of barrelDirMap) {
      if (liveDirs.has(dir)) continue;
      const basename = dir.substring(dir.lastIndexOf("/") + 1);
      if (!basename) continue;
      const dirPrefix = `${dir}/`;
      const hasExternalRef = this.db
        .query<{ c: number }, [string, string]>(
          `SELECT COUNT(*) AS c FROM refs r
             JOIN files f ON f.id = r.file_id
             WHERE r.name = ? AND f.path NOT LIKE ?`,
        )
        .get(basename, `${dirPrefix}%`);
      if ((hasExternalRef?.c ?? 0) > 0) liveDirs.add(dir);
    }

    return barrels
      .filter((b) => !liveDirs.has(barrelToDir(b.path)))
      .map((b) => ({ path: b.path, lineCount: b.line_count, language: b.language }));
  }

  getFileExportCount(relPath: string): number {
    if (!this.ready) return 0;
    return (
      this.db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.is_exported = 1 AND f.path = ?",
        )
        .get(relPath)?.c ?? 0
    );
  }

  getFileBlastRadius(relPath: string): number {
    if (!this.ready) return 0;
    const fileRow = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);
    if (!fileRow) return 0;
    return (
      this.db
        .query<{ c: number }, [number]>(
          "SELECT COUNT(DISTINCT source_file_id) AS c FROM edges WHERE target_file_id = ?",
        )
        .get(fileRow.id)?.c ?? 0
    );
  }

  private extractTokenSignatures(
    fileId: number,
    symbols: Array<{ name: string; kind: string; location: { line: number; endLine?: number } }>,
    content: string,
  ): void {
    const lines = content.split("\n");
    const insertSig = this.db.prepare(
      "INSERT INTO token_signatures (file_id, name, line, end_line, minhash) VALUES (?, ?, ?, ?, ?)",
    );
    const insertFrag = this.db.prepare(
      "INSERT INTO token_fragments (hash, file_id, name, line, token_offset) VALUES (?, ?, ?, ?, ?)",
    );

    const MAX_FRAGMENTS_PER_FILE = 500;
    const MAX_TOKENS_FOR_FRAGMENTS = 300;

    const tx = this.db.transaction(() => {
      let fragCount = 0;
      for (const sym of symbols) {
        const endLine = sym.location.endLine ?? sym.location.line;
        if (endLine - sym.location.line < 5) continue;

        const body = lines.slice(sym.location.line - 1, endLine).join("\n");
        const tokens = tokenize(body);
        if (tokens.length < 8) continue;

        const sig = computeMinHash(tokens);
        if (sig) {
          insertSig.run(fileId, sym.name, sym.location.line, endLine, Buffer.from(sig.buffer));
        }

        if (fragCount < MAX_FRAGMENTS_PER_FILE && tokens.length <= MAX_TOKENS_FOR_FRAGMENTS) {
          const fragments = computeFragmentHashes(tokens);
          for (const frag of fragments) {
            insertFrag.run(frag.hash, fileId, sym.name, sym.location.line, frag.tokenOffset);
            fragCount++;
          }
        }
      }
    });
    tx();
  }

  getNearDuplicates(
    threshold = 0.8,
    limit = 20,
  ): Array<{
    similarity: number;
    a: { name: string; path: string; line: number; endLine: number };
    b: { name: string; path: string; line: number; endLine: number };
  }> {
    if (!this.ready) return [];

    const rows = this.db
      .query<
        {
          name: string;
          kind: string;
          sig: string | null;
          path: string;
          line: number;
          end_line: number;
          minhash: Buffer;
        },
        []
      >(
        `SELECT ts.name, COALESCE(s.kind, '') as kind, s.signature as sig, f.path, ts.line, ts.end_line, ts.minhash
         FROM token_signatures ts
         JOIN files f ON f.id = ts.file_id
         LEFT JOIN symbols s ON s.file_id = ts.file_id AND s.name = ts.name AND s.line = ts.line
         WHERE ${RepoMap.notTestFile()}
         ORDER BY f.pagerank DESC
         LIMIT 500`,
      )
      .all();

    const pairs: Array<{
      similarity: number;
      a: { name: string; path: string; line: number; endLine: number };
      b: { name: string; path: string; line: number; endLine: number };
    }> = [];

    const toSig = (buf: Buffer): Uint32Array => {
      if (buf.byteOffset % 4 === 0) {
        return new Uint32Array(buf.buffer, buf.byteOffset, 128);
      }
      const copy = new Uint32Array(128);
      new Uint8Array(copy.buffer).set(new Uint8Array(buf.buffer, buf.byteOffset, 512));
      return copy;
    };

    const TYPE_KINDS = new Set(["interface", "type", "enum"]);

    for (let i = 0; i < rows.length; i++) {
      const a = rows[i] as (typeof rows)[0];
      const sigA = toSig(a.minhash);

      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j] as (typeof rows)[0];
        if (a.path === b.path && a.line === b.line) continue;

        // Filter: skip parent-contains-child (intra-function matching)
        if (a.path === b.path) {
          if (a.line <= b.line && a.end_line >= b.end_line) continue;
          if (b.line <= a.line && b.end_line >= a.end_line) continue;
        }

        // Filter: skip pairs where both are type declarations (similar AST shape ≠ duplication)
        if (TYPE_KINDS.has(a.kind) && TYPE_KINDS.has(b.kind)) continue;

        // Filter: skip pairs where both are short variables (<10 lines) — config/literal duplication is noise
        if (
          a.kind === "variable" &&
          b.kind === "variable" &&
          a.end_line - a.line < 10 &&
          b.end_line - b.line < 10
        )
          continue;

        const sigB = toSig(b.minhash);
        const sim = jaccardSimilarity(sigA, sigB);

        if (sim >= threshold && sim < 1.0) {
          // For sub-95% matches: if both have signatures, check they're similar
          // Different signatures = different intent despite similar structure
          if (sim < 0.95 && a.sig && b.sig) {
            const tokA = new Set(
              a.sig
                .toLowerCase()
                .split(/[\s,(){}:;|&=<>]+/)
                .filter(Boolean),
            );
            const tokB = new Set(
              b.sig
                .toLowerCase()
                .split(/[\s,(){}:;|&=<>]+/)
                .filter(Boolean),
            );
            let shared = 0;
            for (const t of tokA) if (tokB.has(t)) shared++;
            const sigSim = shared / Math.max(tokA.size, tokB.size);
            if (sigSim < 0.3) continue; // signatures too different — skip
          }

          pairs.push({
            similarity: sim,
            a: { name: a.name, path: a.path, line: a.line, endLine: a.end_line },
            b: { name: b.name, path: b.path, line: b.line, endLine: b.end_line },
          });
        }
      }
    }

    pairs.sort((x, y) => y.similarity - x.similarity);
    return pairs.slice(0, limit);
  }

  getRepeatedFragments(limit = 20): Array<{
    count: number;
    locations: Array<{ name: string; path: string; line: number }>;
  }> {
    if (!this.ready) return [];

    const clusters = this.db
      .query<{ hash: string; cnt: number }, [number]>(
        `SELECT hash, COUNT(*) as cnt
         FROM token_fragments
         GROUP BY hash
         HAVING cnt > 2 AND cnt < 50
         ORDER BY cnt DESC
         LIMIT ?`,
      )
      .all(limit);

    const results: Array<{
      count: number;
      locations: Array<{ name: string; path: string; line: number }>;
    }> = [];

    for (const cluster of clusters) {
      const locs = this.db
        .query<{ name: string; path: string; line: number }, [string]>(
          `SELECT DISTINCT tf.name, f.path, tf.line
           FROM token_fragments tf
           JOIN files f ON f.id = tf.file_id
           WHERE tf.hash = ?
               AND ${RepoMap.notTestFile()}
           ORDER BY f.path, tf.line
             LIMIT 20`,
        )
        .all(cluster.hash);

      const uniqueFiles = new Set(locs.map((l) => `${l.path}:${l.name}`));
      if (uniqueFiles.size < 2) continue;

      results.push({
        count: cluster.cnt,
        locations: locs.map((l) => ({ name: l.name, path: l.path, line: l.line })),
      });
    }

    return results;
  }

  getDuplicateStructures(limit = 20): Array<{
    shapeHash: string;
    kind: string;
    nodeCount: number;
    members: Array<{ name: string; path: string; line: number; endLine: number }>;
  }> {
    if (!this.ready) return [];

    const clusters = this.db
      .query<
        { shape_hash: string; kind: string; node_count: number; cnt: number },
        [number, number]
      >(
        `SELECT sh.shape_hash, sh.kind, sh.node_count, COUNT(*) as cnt
         FROM shape_hashes sh
         JOIN files f ON f.id = sh.file_id
         WHERE sh.node_count >= ?
             AND ${RepoMap.notTestFile()}
         GROUP BY sh.shape_hash
         HAVING cnt > 1
           ORDER BY sh.node_count * cnt DESC
           LIMIT ?`,
      )
      .all(20, limit);

    const results: Array<{
      shapeHash: string;
      kind: string;
      nodeCount: number;
      members: Array<{ name: string; path: string; line: number; endLine: number }>;
    }> = [];

    for (const cluster of clusters) {
      const members = this.db
        .query<{ name: string; path: string; line: number; end_line: number }, [string]>(
          `SELECT sh.name, f.path, sh.line, sh.end_line
           FROM shape_hashes sh
           JOIN files f ON f.id = sh.file_id
           WHERE sh.shape_hash = ?
           ORDER BY f.pagerank DESC`,
        )
        .all(cluster.shape_hash);

      results.push({
        shapeHash: cluster.shape_hash,
        kind: cluster.kind,
        nodeCount: cluster.node_count,
        members: members.map((m) => ({
          name: m.name,
          path: m.path,
          line: m.line,
          endLine: m.end_line,
        })),
      });
    }

    return results;
  }

  getFileDuplicates(relPath: string): Array<{
    name: string;
    line: number;
    similarity: number;
    clones: Array<{ name: string; path: string; line: number }>;
  }> {
    if (!this.ready) return [];

    const fileRow = this.db
      .query<{ id: number }, [string]>("SELECT id FROM files WHERE path = ?")
      .get(relPath);
    if (!fileRow) return [];

    // Use minhash token similarity instead of exact shape hash — much higher signal
    const rawSigs = this.db
      .query<{ name: string; line: number; end_line: number; minhash: Buffer }, [number]>(
        "SELECT name, line, end_line, minhash FROM token_signatures WHERE file_id = ?",
      )
      .all(fileRow.id);

    // Deduplicate by name+line (reindex can leave stale rows)
    const seen = new Set<string>();
    const sigs = rawSigs.filter((s) => {
      const key = `${s.name}:${String(s.line)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (sigs.length === 0) return [];

    // Get candidate matches from other non-test files
    const candidates = this.db
      .query<
        {
          name: string;
          path: string;
          line: number;
          end_line: number;
          minhash: Buffer;
          sig: string | null;
          file_id: number;
        },
        [number]
      >(
        `SELECT ts.name, f.path, ts.line, ts.end_line, ts.minhash, s.signature as sig, ts.file_id
           FROM token_signatures ts
           JOIN files f ON f.id = ts.file_id
         LEFT JOIN symbols s ON s.file_id = ts.file_id AND s.name = ts.name AND s.line = ts.line
         WHERE ts.file_id != ?
           AND ${RepoMap.notTestFile()}`,
      )
      .all(fileRow.id);

    const toSig = (buf: Buffer): Uint32Array => {
      if (buf.byteOffset % 4 === 0) {
        return new Uint32Array(buf.buffer, buf.byteOffset, 128);
      }
      const copy = new Uint32Array(128);
      new Uint8Array(copy.buffer).set(new Uint8Array(buf.buffer, buf.byteOffset, 512));
      return copy;
    };

    const results: Array<{
      name: string;
      line: number;
      similarity: number;
      clones: Array<{ name: string; path: string; line: number }>;
    }> = [];

    for (const s of sigs) {
      const sigA = toSig(s.minhash);
      const clones: Array<{ name: string; path: string; line: number }> = [];
      let bestSim = 0;

      for (const c of candidates) {
        // Skip parent-contains-child within same file
        if (c.path === relPath) {
          if (s.line <= c.line && s.end_line >= c.end_line) continue;
          if (c.line <= s.line && c.end_line >= s.end_line) continue;
        }

        const sigB = toSig(c.minhash);
        let matches = 0;
        for (let i = 0; i < 128; i++) {
          if (sigA[i] === sigB[i]) matches++;
        }
        const sim = matches / 128;

        if (sim < 0.8 || sim >= 1.0) continue;

        // Signature similarity gate — different signatures = different intent
        if (sim < 0.95 && c.sig) {
          // Get this file's symbol signature
          const aSig = this.db
            .query<{ signature: string | null }, [number, string, number]>(
              "SELECT signature FROM symbols WHERE file_id = ? AND name = ? AND line = ? LIMIT 1",
            )
            .get(fileRow.id, s.name, s.line);
          if (aSig?.signature) {
            const tokA = new Set(
              aSig.signature
                .toLowerCase()
                .split(/[\s,(){}:;|&=<>]+/)
                .filter(Boolean),
            );
            const tokB = new Set(
              c.sig
                .toLowerCase()
                .split(/[\s,(){}:;|&=<>]+/)
                .filter(Boolean),
            );
            let shared = 0;
            for (const t of tokA) if (tokB.has(t)) shared++;
            const sigSim = shared / Math.max(tokA.size, tokB.size);
            if (sigSim < 0.3) continue;
          }
        }

        clones.push({ name: c.name, path: c.path, line: c.line });
        if (sim > bestSim) bestSim = sim;
      }

      if (clones.length > 0) {
        results.push({
          name: s.name,
          line: s.line,
          similarity: bestSim,
          clones: clones.slice(0, 5),
        });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);
    return results;
  }

  getTopFiles(
    limit = 20,
  ): Array<{ path: string; pagerank: number; lines: number; symbols: number; language: string }> {
    if (!this.ready) return [];
    return this.db
      .query<
        {
          path: string;
          pagerank: number;
          line_count: number;
          symbol_count: number;
          language: string;
        },
        [number]
      >(
        `SELECT path, pagerank, line_count, symbol_count, language
         FROM files
         ORDER BY pagerank DESC
         LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({
        path: r.path,
        pagerank: r.pagerank,
        lines: r.line_count,
        symbols: r.symbol_count,
        language: r.language,
      }));
  }

  getExternalPackages(
    limit = 20,
  ): Array<{ package: string; fileCount: number; specifiers: string[] }> {
    if (!this.ready) return [];
    return this.db
      .query<{ package: string; file_count: number; all_specs: string | null }, [number]>(
        `SELECT package, COUNT(DISTINCT file_id) AS file_count,
                GROUP_CONCAT(specifiers) AS all_specs
         FROM external_imports
         GROUP BY package
         ORDER BY file_count DESC
         LIMIT ?`,
      )
      .all(limit)
      .map((r) => {
        const specs = r.all_specs
          ? [...new Set(r.all_specs.split(",").filter(Boolean))].slice(0, 10)
          : [];
        return { package: r.package, fileCount: r.file_count, specifiers: specs };
      });
  }

  getSymbolsByKind(
    kind: string,
    limit = 30,
  ): Array<{ name: string; path: string; signature: string | null; line: number }> {
    if (!this.ready) return [];
    return this.db
      .query<
        { name: string; path: string; signature: string | null; line: number },
        [string, number]
      >(
        `SELECT s.name, f.path, s.signature, s.line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.kind = ? AND s.is_exported = 1
         ORDER BY f.pagerank DESC
         LIMIT ?`,
      )
      .all(kind, limit);
  }

  getSymbolSignature(
    name: string,
  ): Array<{ path: string; kind: string; signature: string | null; line: number }> {
    if (!this.ready) return [];
    return this.db
      .query<{ path: string; kind: string; signature: string | null; line: number }, [string]>(
        `SELECT f.path, s.kind, s.signature, s.line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.name = ?
         ORDER BY s.is_exported DESC, f.pagerank DESC
         LIMIT 10`,
      )
      .all(name);
  }

  getFilesByPackage(pkg: string): Array<{ path: string; specifiers: string }> {
    if (!this.ready) return [];
    return this.db
      .query<{ path: string; specifiers: string }, [string]>(
        `SELECT f.path, ei.specifiers
         FROM external_imports ei
         JOIN files f ON f.id = ei.file_id
         WHERE ei.package = ?
         ORDER BY f.pagerank DESC`,
      )
      .all(pkg);
  }

  /** Get all functions that call a given symbol */
  getCallers(
    symbolName: string,
    filePath?: string,
  ): Array<{
    callerName: string;
    callerPath: string;
    callerLine: number;
    callLine: number;
  }> {
    const query = filePath
      ? this.db
          .query<
            { caller_name: string; caller_path: string; caller_line: number; call_line: number },
            [string, string]
          >(
            `SELECT s.name as caller_name, f.path as caller_path, s.line as caller_line, c.line as call_line
           FROM calls c
           JOIN symbols s ON c.caller_symbol_id = s.id
           JOIN files f ON s.file_id = f.id
           WHERE c.callee_name = ?
             AND c.callee_file_id = (SELECT id FROM files WHERE path = ?)
           ORDER BY f.path, c.line`,
          )
          .all(symbolName, filePath)
      : this.db
          .query<
            { caller_name: string; caller_path: string; caller_line: number; call_line: number },
            [string]
          >(
            `SELECT s.name as caller_name, f.path as caller_path, s.line as caller_line, c.line as call_line
           FROM calls c
           JOIN symbols s ON c.caller_symbol_id = s.id
           JOIN files f ON s.file_id = f.id
           WHERE c.callee_name = ?
           ORDER BY f.path, c.line`,
          )
          .all(symbolName);
    return query.map((r) => ({
      callerName: r.caller_name,
      callerPath: r.caller_path,
      callerLine: r.caller_line,
      callLine: r.call_line,
    }));
  }

  /** Get all imported symbols that a function calls */
  getCallees(symbolId: number): Array<{
    calleeName: string;
    calleeFile: string;
    calleeLine: number;
    callLine: number;
  }> {
    const rows = this.db
      .query<
        { callee_name: string; callee_path: string; callee_line: number; call_line: number },
        [number]
      >(
        `SELECT c.callee_name, f.path as callee_path,
              COALESCE(s2.line, 0) as callee_line, c.line as call_line
       FROM calls c
       LEFT JOIN symbols s2 ON c.callee_symbol_id = s2.id
       JOIN files f ON c.callee_file_id = f.id
       WHERE c.caller_symbol_id = ?
       ORDER BY c.line`,
      )
      .all(symbolId);
    return rows.map((r) => ({
      calleeName: r.callee_name,
      calleeFile: r.callee_path,
      calleeLine: r.callee_line,
      callLine: r.call_line,
    }));
  }

  /** Get callees for a symbol by name + file path (resolves symbol ID internally) */
  getCalleesForSymbol(relPath: string, symbolName: string): Array<{ calleeName: string }> {
    const rows = this.db
      .query<{ callee_name: string }, [string, string]>(
        `SELECT DISTINCT c.callee_name
         FROM calls c
         JOIN symbols s ON s.id = c.caller_symbol_id
         JOIN files f ON f.id = s.file_id
         WHERE s.name = ? AND f.path = ?
         ORDER BY c.line`,
      )
      .all(symbolName, relPath);
    return rows.map((r) => ({ calleeName: r.callee_name }));
  }

  /** Get class/object methods via qualified_name */
  getClassMembers(className: string): Array<{
    name: string;
    kind: string;
    line: number;
    endLine: number;
    signature: string | null;
    isExported: boolean;
  }> {
    const rows = this.db
      .query<
        {
          name: string;
          kind: string;
          line: number;
          end_line: number;
          signature: string | null;
          is_exported: number;
          qualified_name: string;
        },
        [string]
      >(
        `SELECT s.name, s.kind, s.line, s.end_line, s.signature, s.is_exported, s.qualified_name
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE s.qualified_name LIKE ? || '.%'
           ORDER BY s.line`,
      )
      .all(className);
    return rows.map((r) => ({
      name: r.qualified_name?.split(".").pop() ?? r.name,
      kind: r.kind,
      line: r.line,
      endLine: r.end_line,
      signature: r.signature,
      isExported: r.is_exported === 1,
    }));
  }

  /** Get semantic summaries for a file or symbol */
  getSymbolSummaries(
    file?: string,
    name?: string,
  ): Array<{
    symbolName: string;
    filePath: string;
    summary: string;
    source: string;
  }> {
    if (file) {
      return this.db
        .query<
          { symbol_name: string; file_path: string; summary: string; source: string },
          [string]
        >(
          `SELECT symbol_name, file_path, summary, source
             FROM semantic_summaries
             WHERE file_path = ?
             ORDER BY source ASC, symbol_name`,
        )
        .all(file)
        .map((r) => ({
          symbolName: r.symbol_name,
          filePath: r.file_path,
          summary: r.summary,
          source: r.source,
        }));
    }
    if (name) {
      return this.db
        .query<
          { symbol_name: string; file_path: string; summary: string; source: string },
          [string]
        >(
          `SELECT symbol_name, file_path, summary, source
             FROM semantic_summaries
             WHERE symbol_name = ?
             ORDER BY source ASC`,
        )
        .all(name)
        .map((r) => ({
          symbolName: r.symbol_name,
          filePath: r.file_path,
          summary: r.summary,
          source: r.source,
        }));
    }
    return [];
  }

  /** Bulk-query caller counts for symbol names (for render badges) */
  getCallerCounts(symbolNames: string[]): Map<string, number> {
    if (symbolNames.length === 0) return new Map();
    const placeholders = symbolNames.map(() => "?").join(",");
    const rows = this.db
      .query<{ callee_name: string; cnt: number }, string[]>(
        `SELECT callee_name, COUNT(*) as cnt
           FROM calls
           WHERE callee_name IN (${placeholders})
           GROUP BY callee_name
           HAVING cnt >= 5`,
      )
      .all(...symbolNames);
    const result = new Map<string, number>();
    for (const r of rows) result.set(r.callee_name, r.cnt);
    return result;
  }

  /** Get caller counts + top 3 caller names for symbols with ≥5 callers */
  getCallerDetails(symbolNames: string[]): Map<string, { count: number; topCallers: string[] }> {
    if (symbolNames.length === 0) return new Map();
    const placeholders = symbolNames.map(() => "?").join(",");
    const rows = this.db
      .query<{ callee_name: string; caller_name: string; cnt: number }, string[]>(
        `SELECT c.callee_name, s.name as caller_name, COUNT(*) as cnt
         FROM calls c
         JOIN symbols s ON s.id = c.caller_symbol_id
         WHERE c.callee_name IN (${placeholders})
         GROUP BY c.callee_name, s.name
         ORDER BY c.callee_name, cnt DESC`,
      )
      .all(...symbolNames);

    const grouped = new Map<string, { count: number; callers: string[] }>();
    for (const r of rows) {
      let entry = grouped.get(r.callee_name);
      if (!entry) {
        entry = { count: 0, callers: [] };
        grouped.set(r.callee_name, entry);
      }
      entry.count += r.cnt;
      if (entry.callers.length < 3) entry.callers.push(r.caller_name);
    }

    const result = new Map<string, { count: number; topCallers: string[] }>();
    for (const [name, entry] of grouped) {
      if (entry.count >= 5) {
        result.set(name, { count: entry.count, topCallers: entry.callers });
      }
    }
    return result;
  }

  getStats(): { files: number; symbols: number; edges: number; summaries: number; calls: number } {
    const files = this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM files").get()?.c ?? 0;
    const symbols =
      this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM symbols").get()?.c ?? 0;
    const edges = this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM edges").get()?.c ?? 0;
    const calls = this.db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM calls").get()?.c ?? 0;
    let summaries = 0;
    if (this.semanticMode === "off") {
      summaries =
        this.db
          .query<{ c: number }, []>("SELECT COUNT(DISTINCT symbol_id) as c FROM semantic_summaries")
          .get()?.c ?? 0;
    } else if (this.semanticMode === "ast") {
      summaries =
        this.db
          .query<{ c: number }, []>(
            "SELECT COUNT(*) as c FROM semantic_summaries WHERE source = 'ast'",
          )
          .get()?.c ?? 0;
    } else {
      // synthetic, llm, full, on — count across all sources (deduplicated)
      summaries =
        this.db
          .query<{ c: number }, []>("SELECT COUNT(DISTINCT symbol_id) as c FROM semantic_summaries")
          .get()?.c ?? 0;
    }
    return { files, symbols, edges, summaries, calls };
  }

  getSummaryBreakdown(): {
    ast: number;
    llm: number;
    synthetic: number;
    lsp: number;
    total: number;
    eligible: number;
  } {
    const ast =
      this.db
        .query<{ c: number }, []>("SELECT COUNT(*) as c FROM semantic_summaries WHERE source='ast'")
        .get()?.c ?? 0;
    const llm =
      this.db
        .query<{ c: number }, []>("SELECT COUNT(*) as c FROM semantic_summaries WHERE source='llm'")
        .get()?.c ?? 0;
    const synthetic =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM semantic_summaries WHERE source='synthetic'",
        )
        .get()?.c ?? 0;
    const lsp =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM symbols WHERE qualified_name IS NOT NULL",
        )
        .get()?.c ?? 0;
    const total =
      this.db
        .query<{ c: number }, []>("SELECT COUNT(DISTINCT symbol_id) as c FROM semantic_summaries")
        .get()?.c ?? 0;
    const eligible =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) as c FROM symbols WHERE is_exported=1 AND kind IN ('function','method','class','interface','type')",
        )
        .get()?.c ?? 0;
    return { ast, llm, synthetic, lsp, total, eligible };
  }

  /**
   * List immediate children of a directory from the indexed files table.
   * Returns files with metadata (language, lines, symbols, pagerank).
   * Also detects subdirectories by looking for paths with deeper segments.
   */
  listDirectory(dirPath: string): Array<{
    name: string;
    type: "file" | "dir";
    language?: string;
    lines?: number;
    symbols?: number;
    importance?: number;
  }> | null {
    if (!this.ready) return null;

    // Normalize: ensure trailing slash for prefix matching, handle root
    const prefix = dirPath === "." || dirPath === "" ? "" : `${dirPath.replace(/\/$/, "")}/`;

    // Query files directly in this directory (no deeper nesting)
    const files = this.db
      .query<
        {
          path: string;
          language: string;
          line_count: number;
          symbol_count: number;
          pagerank: number;
        },
        [string, string]
      >(
        `SELECT path, language, line_count, symbol_count, pagerank
           FROM files
           WHERE path LIKE ? AND path NOT LIKE ?
           ORDER BY pagerank DESC`,
      )
      .all(`${prefix}%`, `${prefix}%/%`);

    // Also detect subdirectories by finding distinct first-level segments
    const dirSegments = new Set<string>();
    const deepRows = this.db
      .query<{ path: string }, [string]>(`SELECT DISTINCT path FROM files WHERE path LIKE ?`)
      .all(`${prefix}%`);

    for (const row of deepRows) {
      const rest = row.path.slice(prefix.length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx > 0) {
        dirSegments.add(rest.slice(0, slashIdx));
      }
    }

    // Remove dirs that also appear as files (shouldn't happen, but defensive)
    const fileNames = new Set(files.map((f) => f.path.slice(prefix.length)));
    for (const name of fileNames) {
      dirSegments.delete(name);
    }

    const result: Array<{
      name: string;
      type: "file" | "dir";
      language?: string;
      lines?: number;
      symbols?: number;
      importance?: number;
    }> = [];

    // Directories first
    for (const dir of [...dirSegments].sort()) {
      result.push({ name: dir, type: "dir" });
    }

    // Then files
    for (const f of files) {
      result.push({
        name: f.path.slice(prefix.length),
        type: "file",
        language: f.language,
        lines: f.line_count,
        symbols: f.symbol_count,
        importance: Math.round(f.pagerank * 1000) / 1000,
      });
    }

    return result;
  }

  clear(): void {
    this.db.run("DROP TRIGGER IF EXISTS symbols_ai");
    this.db.run("DROP TRIGGER IF EXISTS symbols_ad");
    // Preserve LLM summaries (paid) — they'll be re-linked on next scan via file_path+symbol_name
    this.db.run("DELETE FROM semantic_summaries WHERE source != 'llm'");
    this.db.run("DELETE FROM external_imports");
    this.db.run("DELETE FROM cochanges");
    this.db.run("DELETE FROM edges");
    this.db.run("DELETE FROM refs");
    this.db.run("DELETE FROM symbols");
    this.db.run("DELETE FROM files");
    this.rebuildFts();
    this.ready = false;
    this.scanPromise = null;
  }

  private rebuildFts(): void {
    this.db.run("DROP TRIGGER IF EXISTS symbols_ai");
    this.db.run("DROP TRIGGER IF EXISTS symbols_ad");
    this.db.run("DROP TABLE IF EXISTS symbols_fts");
    this.db.run("CREATE VIRTUAL TABLE symbols_fts USING fts5(name, kind)");
    this.db.run(`CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
      INSERT INTO symbols_fts(rowid, name, kind) VALUES (new.id, new.name, new.kind);
    END`);
    this.db.run(`CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
      DELETE FROM symbols_fts WHERE rowid = old.id;
    END`);
    this.db.run("INSERT INTO symbols_fts(rowid, name, kind) SELECT id, name, kind FROM symbols");
  }

  private compactIfNeeded(): void {
    // WAL checkpoint only — VACUUM is a synchronous blocking operation that
    // can hang for 30+ seconds on large DBs, freezing the worker thread.
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // compaction is best-effort
    }
  }

  dbSizeBytes(): number {
    try {
      const row = this.db
        .query<{ s: number }, []>(
          "SELECT page_count * page_size AS s FROM pragma_page_count(), pragma_page_size()",
        )
        .get();
      return row?.s ?? 0;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    this.ready = false;
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer);
      this.dirtyTimer = null;
    }
    if (this.regenTimer) {
      clearTimeout(this.regenTimer);
      this.regenTimer = null;
    }
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch (e) {
        console.error("[repo-map] error awaiting pending flush during close:", e instanceof Error ? e.message : String(e));
      }
    }
    this.db.close();
  }
}
