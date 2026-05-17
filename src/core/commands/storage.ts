import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "../../components/ui/dialogs/index.js";
import { icon } from "../icons.js";
import { SessionManager } from "../sessions/manager.js";
import { getThemeTokens } from "../theme/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { computeStorageSizes, fileSize, formatBytes, sysMsg } from "./utils.js";

function openStorageMenu(ctx: CommandContext): void {
  const show = () => {
    const s = computeStorageSizes(ctx.cwd);
    const sm = new SessionManager(ctx.cwd);
    const sessionCount = sm.sessionCount();
    const memMgr = ctx.contextManager.getMemoryManager();
    const projectMemCount = memMgr.listByScope("project").length;
    const globalMemCount = memMgr.listByScope("global").length;

    const pad = (label: string, size: string, width = 28) => {
      const gap = Math.max(1, width - label.length - size.length);
      return `${label}${" ".repeat(gap)}${size}`;
    };

    ctx.openCommandPicker({
      title: `Storage — ${formatBytes(s.projectTotal + s.globalTotal)}`,
      icon: icon("storage"),
      maxWidth: 64,
      options: [
        {
          value: "_h_project",
          label: `Project ${formatBytes(s.projectTotal)}`,
          color: getThemeTokens().brand,
          disabled: true,
        },
        {
          value: "clear-repomap",
          label: pad("Soul Map", formatBytes(s.repoMap)),
          description: s.repoMap > 0 ? `${icon("delete_all")} clear` : undefined,
        },
        {
          value: "clear-sessions",
          label: pad("Sessions", formatBytes(s.sessions)),
          description:
            sessionCount > 0
              ? `${String(sessionCount)} saved · ${icon("delete_all")} clear`
              : undefined,
        },
        {
          value: "_pmem",
          label: pad(
            "Memory",
            `${formatBytes(s.projectMemory)}  ${String(projectMemCount)} entries`,
          ),
          disabled: true,
        },
        {
          value: "clear-plans",
          label: pad("Plans", formatBytes(s.plans)),
          description: s.plans > 0 ? `${icon("delete_all")} clear` : undefined,
        },
        {
          value: "_pconfig",
          label: pad("Config", formatBytes(s.projectConfig)),
          disabled: true,
        },
        {
          value: "_h_global",
          label: `Global ${formatBytes(s.globalTotal)}`,
          color: getThemeTokens().info,
          disabled: true,
        },
        {
          value: "clear-history",
          label: pad("History", formatBytes(s.history)),
          description: s.history > 0 ? `${icon("delete_all")} clear` : undefined,
        },
        {
          value: "_gmem",
          label: pad("Memory", `${formatBytes(s.globalMemory)}  ${String(globalMemCount)} entries`),
          disabled: true,
        },
        {
          value: "_gconfig",
          label: pad("Config", formatBytes(s.globalConfig)),
          disabled: true,
        },
        {
          value: "_bins",
          label: pad("Binaries", formatBytes(s.bins)),
          disabled: true,
        },
        {
          value: "_fonts",
          label: pad("Fonts", formatBytes(s.fonts)),
          disabled: true,
        },
        {
          value: "vacuum",
          label: "Vacuum Databases",
          description: "reclaim space from deleted rows",
        },
      ],
      onSelect: (value) => {
        void (async () => {
          if (value === "clear-repomap") {
            if (s.repoMap === 0) return;
            const ok = await confirm({
              title: "Clear Soul Map?",
              message: `${formatBytes(s.repoMap)} of cached repo-map data will be deleted. Next index pass will rebuild it.`,
              danger: true,
            });
            if (!ok) return;
            ctx.contextManager.clearRepoMap();
            sysMsg(ctx, `Cleared soul map (freed ~${formatBytes(s.repoMap)}).`);
          } else if (value === "clear-sessions") {
            if (sessionCount === 0) return;
            const ok = await confirm({
              title: "Clear all sessions?",
              message: `${String(sessionCount)} saved sessions (${formatBytes(s.sessions)}) will be deleted from this project. This cannot be undone.`,
              danger: true,
            });
            if (!ok) return;
            const cleared = sm.clearAllSessions();
            sysMsg(ctx, `Cleared ${String(cleared)} sessions (freed ~${formatBytes(s.sessions)}).`);
          } else if (value === "clear-history") {
            const historyPath = join(s.globalDir, "history.db");
            if (existsSync(historyPath) && s.history > 0) {
              const ok = await confirm({
                title: "Clear search history?",
                message: `Prompt history and stash entries (${formatBytes(s.history)}) will be deleted globally. This cannot be undone.`,
                danger: true,
              });
              if (!ok) return;
              try {
                const db = new Database(historyPath);
                db.run("DELETE FROM history");
                db.run("VACUUM");
                db.close();
                sysMsg(ctx, `Cleared search history (freed ~${formatBytes(s.history)}).`);
              } catch {
                sysMsg(ctx, "Failed to clear history database.");
              }
            }
          } else if (value === "clear-plans") {
            const plansDir = join(s.projectDir, "plans");
            if (existsSync(plansDir) && s.plans > 0) {
              const ok = await confirm({
                title: "Clear plans?",
                message: `All saved plans (${formatBytes(s.plans)}) for this project will be deleted. This cannot be undone.`,
                danger: true,
              });
              if (!ok) return;
              rmSync(plansDir, { recursive: true });
              sysMsg(ctx, `Cleared plans (freed ~${formatBytes(s.plans)}).`);
            }
          } else if (value === "vacuum") {
            let freed = 0;
            const dbs = [
              join(s.projectDir, "repomap.db"),
              join(s.projectDir, "memory.db"),
              join(s.globalDir, "history.db"),
              join(s.globalDir, "memory.db"),
            ];
            for (const dbPath of dbs) {
              if (!existsSync(dbPath)) continue;
              try {
                const before = fileSize(dbPath);
                const db = new Database(dbPath);
                db.run("VACUUM");
                db.close();
                freed += Math.max(0, before - fileSize(dbPath));
              } catch {
                // skip
              }
            }
            sysMsg(
              ctx,
              freed > 0
                ? `Vacuumed databases (reclaimed ~${formatBytes(freed)}).`
                : "Vacuumed databases (no space to reclaim).",
            );
          }
          setTimeout(show, 50);
        })();
      },
    });
  };
  show();
}

function handleStorage(_input: string, ctx: CommandContext): void {
  openStorageMenu(ctx);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/storage", handleStorage);
}
