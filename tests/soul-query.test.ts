import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMap } from "../src/core/intelligence/repo-map.js";
import { soulQueryTool } from "../src/core/tools/soul-query.js";
import { setCwd } from "../src/core/cwd.js";

const TMP = join(tmpdir(), `soul-query-${Date.now()}`);
const ORIG_CWD = process.cwd();
let repoMap: RepoMap;

beforeAll(async () => {
  mkdirSync(join(TMP, "src"), { recursive: true });
  writeFileSync(
    join(TMP, "src", "service.ts"),
    "export function widgetHandler() { return rareTokenABC(1); }\nexport class WidgetStore {}\n",
  );
  writeFileSync(join(TMP, "src", "other.ts"), "export function unrelated() { return 2; }\n");
  writeFileSync(join(TMP, "src", "notes.md"), "# rareTokenABC docs\n");
  // setCwd keeps the global cwd holder + process.cwd() in lockstep so the
  // tool's getCwd()-relative resolution matches the fixture
  setCwd(TMP);
  repoMap = new RepoMap(TMP);
  await repoMap.scan();
});

afterAll(() => {
  setCwd(ORIG_CWD);
  repoMap?.close();
  rmSync(TMP, { recursive: true, force: true });
});

function makeExec() {
  // Cast: tool accepts the IntelligenceClient interface; RepoMap satisfies the used subset.
  return soulQueryTool.createExecute(repoMap as unknown as Parameters<typeof soulQueryTool.createExecute>[0]);
}

test("search → filter narrows to matching code files", async () => {
  const exec = makeExec();
  const r = await exec({
    pipeline: [
      { op: "search", pattern: "rareTokenABC" },
      { op: "filter", ext: ".ts" },
    ],
  });
  expect(r.success).toBe(true);
  expect(r.output).toContain("src/service.ts");
  expect(r.output).not.toContain("src/notes.md"); // filtered by ext
  expect(r.output).not.toContain("src/other.ts"); // didn't match search
});

test("search → outline emits enclosing symbols", async () => {
  const exec = makeExec();
  const r = await exec({
    pipeline: [
      { op: "search", pattern: "rareTokenABC" },
      { op: "filter", ext: ".ts" },
      { op: "outline" },
    ],
  });
  expect(r.success).toBe(true);
  expect(r.output).toContain("widgetHandler");
});

test("limit caps the working set", async () => {
  const exec = makeExec();
  const r = await exec({
    pipeline: [{ op: "search", pattern: "export" }, { op: "limit", n: 1 }],
  });
  expect(r.success).toBe(true);
  // trace line shows the stage narrowed to 1 file
  expect(r.output).toMatch(/limit 1 → 1 files/);
});

test("empty pipeline errors", async () => {
  const exec = makeExec();
  const r = await exec({ pipeline: [] });
  expect(r.success).toBe(false);
});
