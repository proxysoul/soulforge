import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SkillSearchResult {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface InstalledSkill {
  name: string;
  path: string;
  scope: "project" | "global";
}

interface SearchResponse {
  skills: SkillSearchResult[];
  count: number;
}

const INSTALL_TIMEOUT = 30_000;
const OUTPUT_CAP = 500;

/** Search skills.sh for available skills */
export async function searchSkills(query: string): Promise<SkillSearchResult[]> {
  const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Skills search failed: ${res.status}`);
  const data = (await res.json()) as SearchResponse;
  return data.skills;
}

/** Fetch popular/trending skills (broad query sorted by installs) */
export async function listPopularSkills(): Promise<SkillSearchResult[]> {
  return searchSkills("ai");
}

/** Detect whether bunx is available, falling back to npx */
async function detectRunner(): Promise<string> {
  try {
    const proc = Bun.spawn(["bunx", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const code = await proc.exited;
    if (code === 0) return "bunx";
  } catch {
    // bunx not found
  }
  return "npx";
}

/** Install a skill via bunx (or npx fallback). Returns the on-disk skill name if found. */
export async function installSkill(
  source: string,
  skillId: string,
  global = false,
): Promise<{ installed: boolean; name?: string; error?: string }> {
  const runner = await detectRunner();
  const args = [runner, "skills", "add", source, "--skill", skillId, "-y"];
  if (global) args.push("-g");

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  // Read streams concurrently with proc.exited to avoid pipe-buffer deadlock.
  // Without concurrent reads, if the child writes enough to fill the OS pipe buffer (~64KB),
  // it blocks waiting for the parent to drain — while the parent blocks on proc.exited. Deadlock.
  let installTimeout: ReturnType<typeof setTimeout> | undefined;
  const [exitCode, stderr, stdout] = await Promise.race([
    Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]).finally(() => clearTimeout(installTimeout)),
    new Promise<never>((_, reject) => {
      installTimeout = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        reject(new Error(`Skill install timed out after ${INSTALL_TIMEOUT / 1000}s`));
      }, INSTALL_TIMEOUT);
    }),
  ]);

  if (exitCode !== 0) {
    // Extract useful error, cap output
    const msg = (stderr || stdout).trim();
    const clean =
      msg.length > OUTPUT_CAP
        ? `${msg.slice(0, OUTPUT_CAP)}...`
        : msg || `exit code ${String(exitCode)}`;
    return { installed: false, error: clean };
  }

  // Verify skill actually exists on disk — bunx may "succeed" (exit 0) but not install a SKILL.md
  const installed = listInstalledSkills();
  const lastSegment = skillId.split("/").pop() ?? skillId;
  const match =
    installed.find((s) => s.name === skillId) ??
    installed.find((s) => s.name === lastSegment) ??
    installed.find((s) => s.name.includes(lastSegment) || lastSegment.includes(s.name));

  if (match) {
    return { installed: true, name: match.name };
  }

  // Exit 0 but no skill found — common with packages that resolve deps but have no SKILL.md
  const hint = stdout.includes("Resolving dependencies")
    ? "Package resolved but no SKILL.md found in it."
    : (stdout || stderr).trim().slice(0, OUTPUT_CAP) || "No SKILL.md found after install.";
  return { installed: false, error: hint };
}

/** Scan known directories for installed SKILL.md files */
export function listInstalledSkills(): InstalledSkill[] {
  const byName = new Map<string, InstalledSkill>();
  const seenPaths = new Set<string>();

  // Skill scan dirs are fixed per guidelines: ~/.soulforge/skills,
  // ~/.agents/skills, ~/.claude/skills + project-local equivalents.
  // Do not broaden scope.
  const dirs: Array<{ path: string; scope: "global" | "project" }> = [
    { path: join(homedir(), ".soulforge", "skills"), scope: "global" },
    { path: join(homedir(), ".agents", "skills"), scope: "global" },
    { path: join(homedir(), ".claude", "skills"), scope: "global" },
    { path: join(process.cwd(), ".soulforge", "skills"), scope: "project" },
    { path: join(process.cwd(), ".agents", "skills"), scope: "project" },
    { path: join(process.cwd(), ".claude", "skills"), scope: "project" },
  ];

  for (const dir of dirs) {
    try {
      scanSkillDir(dir.path, dir.scope, byName, seenPaths);
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return [...byName.values()];
}

function scanSkillDir(
  dir: string,
  scope: "global" | "project",
  byName: Map<string, InstalledSkill>,
  seenPaths: Set<string>,
): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);

    // Follow symlinks — check if the resolved path is a directory
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectorySafe(full));
    if (isDir) {
      try {
        const skillPath = join(full, "SKILL.md");
        const resolved = realpathSync(skillPath);
        if (seenPaths.has(resolved)) continue;
        readFileSync(skillPath, "utf-8"); // test existence
        seenPaths.add(resolved);
        // Overwrite by name — later scopes (project) take priority over earlier (global)
        byName.set(entry.name, { name: entry.name, path: skillPath, scope });
      } catch {
        // No SKILL.md in this subdirectory
      }
    } else if (entry.name === "SKILL.md") {
      const resolved = realpathSync(full);
      if (seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const parentName = dir.split("/").pop() ?? "skill";
      byName.set(parentName, { name: parentName, path: full, scope });
    }
  }
}

function isDirectorySafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Read a SKILL.md file and return its content */
export function loadSkill(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Remove an installed skill from disk */
export function removeInstalledSkill(skill: InstalledSkill): boolean {
  try {
    const dir = dirname(skill.path);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
      return true;
    }
  } catch {}
  return false;
}
