/**
 * SoulForge anonymous usage beacon.
 *
 * Write-only sink. A client sends GET /b?v=...&os=...&ar=...&sf=...&e=...&id=...
 * and we record one Analytics Engine data point, then return 204.
 *
 * No KV / D1 / R2, no secrets, nothing readable back out — so there is
 * nothing here to corrupt, leak, or exfiltrate. Defense in depth:
 *   (a) hard validation + allow-lists coerce every field (no arbitrary blobs),
 *   (b) per-IP rate limiting via CF's native binding (IP is used as a limiter
 *       key only — never stored in the dataset),
 *   (c) a User-Agent gate drops drive-by/browser noise,
 *   (d) dedup on the random client id at query time absorbs any residual spam.
 */

interface Env {
  USAGE: AnalyticsEngineDataset;
  // CF native rate limiter (configured in wrangler.toml). Free, edge-local.
  BEACON_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

// Allow-lists. Anything outside these is coerced to "other" so a hostile
// client cannot pollute the dataset with arbitrary high-cardinality blobs.
const SURFACES = new Set(["tui", "headless", "hearth"]);
const EVENTS = new Set(["session_start", "session_end"]);
const OSES = new Set(["darwin", "linux", "win32"]);
const ARCHES = new Set(["arm64", "x64", "other"]);
const INSTALLS = new Set(["npm", "pnpm", "yarn", "bun", "brew", "binary", "unknown"]);
const MODES = new Set(["default", "architect", "socratic", "challenge", "plan", "auto"]);
const TERMINALS = new Set(["kitty", "ghostty", "iterm", "vscode", "wezterm", "warp", "tmux", "other"]);
const REPOMAP = new Set(["on", "skipped"]);
// Model family is bucketed client-side (detectModelFamily). The worker enforces
// a SHAPE only — not a fixed allow-list — so a new provider family surfaces
// automatically instead of being dropped into a blank/other bucket.
const FAMILY_RE = /^[a-z][a-z0-9-]{0,19}$/;

// Shape validators — a real client always satisfies these, so rejecting on
// failure has zero false negatives but drops malformed/spoofed junk so it is
// never recorded (vs. silently coercing it into a countable row).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[\w.]{1,16})?$/;
// provider/model are already sanitized + bucketed client-side (unknown
// provider → "custom", unknown model → "other"); the worker enforces a strict
// SHAPE (lowercase, bounded charset/length) as defense in depth.
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{0,47}$/;
// runtime: bun-1 / node-22 — engine name + major version only.
const RUNTIME_RE = /^(?:bun|node|other)(?:-\d{1,3})?$/;

/** Must be exactly one of the allow-listed values — no coercion. */
function inSet(v: string | null, set: Set<string>): v is string {
  return v != null && set.has(v);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname !== "/b") {
      return new Response("ok", { status: 200 });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    // UA gate — the real client sends a known marker; browsers/scanners don't.
    // Cheap drive-by filter, not a security boundary (UAs are spoofable; the
    // allow-lists + rate limiter are the real defense).
    const ua = req.headers.get("user-agent") ?? "";
    if (!ua.includes("soulforge")) {
      return new Response(null, { status: 204 });
    }

    // Per-IP rate limit. The IP is the limiter KEY only — never written to the
    // dataset. Caps a single source so it can't inflate counts at scale.
    const ip = req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
    const { success } = await env.BEACON_LIMIT.limit({ key: ip });
    if (!success) {
      return new Response(null, { status: 429 });
    }

    const q = url.searchParams;
    const os = q.get("os");
    const arch = q.get("ar");
    const surface = q.get("sf");
    const event = q.get("e");
    const version = q.get("v");
    const id = q.get("id");
    const install = q.get("im");
    const family = q.get("mf"); // model family only, never the model/key
    const provider = q.get("pv"); // provider id or "custom" — never a URL
    const model = q.get("md"); // public base model name or "other"
    const mode = q.get("mo"); // agent mode: default/architect/plan/auto
    const terminal = q.get("tm"); // coarse terminal bucket
    const runtime = q.get("rt"); // bun-N / node-N
    const repomap = q.get("rm"); // "on" | "skipped"

    // Reject (don't record) anything malformed. A real client always passes;
    // junk/spoofed pings are dropped so they never inflate counts. install,
    // family, provider, model are optional but, when present, must match.
    const valid =
      inSet(os, OSES) &&
      inSet(arch, ARCHES) &&
      inSet(surface, SURFACES) &&
      inSet(event, EVENTS) &&
      version != null &&
      SEMVER_RE.test(version) &&
      id != null &&
      UUID_RE.test(id) &&
      (install == null || INSTALLS.has(install)) &&
      (family == null || FAMILY_RE.test(family)) &&
      (provider == null || PROVIDER_RE.test(provider)) &&
      (model == null || MODEL_RE.test(model)) &&
      (mode == null || MODES.has(mode)) &&
      (terminal == null || TERMINALS.has(terminal)) &&
      (runtime == null || RUNTIME_RE.test(runtime)) &&
      (repomap == null || REPOMAP.has(repomap));

    if (!valid) {
      // 204 (not 400) so we leak nothing about what was wrong.
      return new Response(null, { status: 204 });
    }

    // Country comes free from Cloudflare's edge — coarse, non-identifying,
    // and we never store the client IP.
    const country = (req.cf?.country as string | undefined) ?? "ZZ";

    env.USAGE.writeDataPoint({
      // blobs: low-cost string dimensions. All values are validated above.
      // blob1..10: event,surface,os,arch,version,install,family,country,provider,model
      // blob11..14: mode,terminal,runtime,repomap
      blobs: [
        event,
        surface,
        os,
        arch,
        version,
        install ?? "unknown",
        family ?? "",
        country,
        provider ?? "",
        model ?? "",
        mode ?? "",
        terminal ?? "",
        runtime ?? "",
        repomap ?? "",
      ],
      // indexes: the dedup key — distinct ids per window = active users
      indexes: [id],
      doubles: [1],
    });

    return new Response(null, { status: 204 });
  },
};
