import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { icon } from "../../core/icons.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import {
  type ChangelogCommit,
  type ChangelogRelease,
  dismissVersion,
  getUpgradeCommand,
  performUpgrade,
} from "../../core/version.js";
import { useVersionStore } from "../../stores/version.js";
import { SPINNER_FRAMES } from "../layout/shared.js";
import { Divider, PremiumPopup, Section, VSpacer } from "../ui/index.js";

type Phase = "info" | "upgrading" | "success" | "failed";

const UPGRADE_QUIPS = [
  "Heating the forge…",
  "Melting down the old version…",
  "Pouring molten code into the mold…",
  "Hammering out the bugs…",
  "Quenching in liquid nitrogen…",
  "Polishing the new blade…",
  "Enchanting with fresh runes…",
  "Consulting the package spirits…",
  "Negotiating with the registry gods…",
  "Bribing the dependency elves…",
  "Aligning the semantic versions…",
  "Reticulating splines…",
  "Convincing npm to cooperate…",
  "Performing arcane rituals…",
  "Almost there, forgemaster…",
];

const LATEST_QUIPS = [
  "The forge burns bright — you're on the cutting edge.",
  "No updates. The blade is already sharp.",
  "You're running the latest. The gods are pleased.",
  "Peak version achieved. Nothing to see here.",
  "Already forged to perfection.",
  "The scrolls confirm: you're up to date.",
  "No new runes to inscribe today.",
  "Your version is so fresh it's still warm.",
];

const CHANGELOG_ERROR_QUIPS = [
  "The scroll courier didn't make it — changelog unavailable",
  "The raven carrying the changelog was lost to the void",
  "The archive gates are sealed — try again later",
  "The changelog runes could not be summoned",
  "The forge's scrying pool is clouded — no changelog today",
  "The record keeper is away from the anvil",
  "The changelog embers have gone cold — GitHub unreachable",
];

const MAX_LOG = 50;
const BOLD = TextAttributes.BOLD;
const ITALIC = TextAttributes.ITALIC;
const DIM = TextAttributes.DIM;

// ── Helpers ────────────────────────────────────────────────────────

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const TYPE_BADGE: Record<
  ChangelogCommit["type"],
  {
    label: string;
    color: keyof ThemeTokens;
  }
> = {
  feat: { label: "feat", color: "success" },
  fix: { label: "fix", color: "brandSecondary" },
  perf: { label: "perf", color: "brandAlt" },
  refactor: { label: "refac", color: "textSecondary" },
  docs: { label: "docs", color: "textMuted" },
  other: { label: "misc", color: "textMuted" },
};

function ChangelogSection({
  releases,
  maxLines,
  iw,
  bg,
  t,
}: {
  releases: ChangelogRelease[];
  maxLines: number;
  iw: number;
  bg: string;
  t: ThemeTokens;
}) {
  // Flatten all commits across releases into renderable rows
  const rows: Array<
    { type: "header"; version: string; date?: string } | { type: "commit"; commit: ChangelogCommit }
  > = [];
  for (const rel of releases) {
    rows.push({ type: "header", version: rel.version, date: rel.date });
    for (const c of rel.commits) {
      rows.push({ type: "commit", commit: c });
    }
  }

  const visible = rows.slice(0, maxLines);
  const remaining = rows.length - visible.length;

  return (
    <>
      <box flexDirection="column" height={Math.min(rows.length, maxLines)} overflow="hidden">
        {visible.map((row, i) => {
          if (row.type === "header") {
            return (
              <box key={String(i)} flexDirection="row" backgroundColor={bg}>
                <text bg={bg}>
                  <span fg={t.brand} attributes={BOLD}>
                    {"  "}v{row.version}
                  </span>
                  {row.date && (
                    <span fg={t.textFaint} attributes={DIM}>
                      {" "}
                      {row.date}
                    </span>
                  )}
                </text>
              </box>
            );
          }
          const badge = TYPE_BADGE[row.commit.type] ?? TYPE_BADGE.other;
          const scope = row.commit.scope ? `(${row.commit.scope}) ` : "";
          const breakingMark = row.commit.breaking ? " !!" : "";
          return (
            <box key={String(i)} flexDirection="row" backgroundColor={bg}>
              <text bg={bg}>
                <span fg={t[badge.color] ?? t.textMuted}>
                  {"    "}
                  {badge.label.padEnd(5)}
                </span>
                <span fg={t.textFaint}>{" │ "}</span>
                {row.commit.breaking ? (
                  <span fg={t.brandSecondary} attributes={BOLD}>
                    {trunc(`${scope}${row.commit.message}${breakingMark}`, iw - 16)}
                  </span>
                ) : (
                  <span fg={t.textSecondary}>
                    {trunc(`${scope}${row.commit.message}`, iw - 16)}
                  </span>
                )}
              </text>
            </box>
          );
        })}
      </box>
      {remaining > 0 && (
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg} fg={t.textFaint} attributes={DIM}>
            {"      "}… and {remaining} more
          </text>
        </box>
      )}
    </>
  );
}

// ── Component ──────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function UpdateModal({ visible, onClose }: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const {
    current,
    latest,
    changelog,
    currentRelease,
    changelogError,
    installMethod,
    updateAvailable,
  } = useVersionStore();
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<Phase>("info");
  const [quipIdx, setQuipIdx] = useState(0);
  const [spinIdx, setSpinIdx] = useState(0);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const upgrading = useRef(false);

  useEffect(() => {
    if (visible) setPhase("info");
  }, [visible]);

  const pw = Math.min(80, Math.max(60, Math.floor(termCols * 0.78)));
  const popupH = Math.min(30, Math.max(18, termRows - 4));
  const iw = pw - 4;
  const maxChangelog = Math.max(6, popupH - 14);
  const logH = Math.max(3, Math.min(6, popupH - 12));
  const bg = t.bgPopup;

  // Animate spinner + cycle quips during upgrade
  useEffect(() => {
    if (phase !== "upgrading") return;
    const s = setInterval(() => setSpinIdx((i) => i + 1), 80);
    const q = setInterval(() => setQuipIdx((i) => (i + 1) % UPGRADE_QUIPS.length), 2500);
    return () => {
      clearInterval(s);
      clearInterval(q);
    };
  }, [phase]);

  const doUpgrade = useCallback(async () => {
    if (upgrading.current) return;
    upgrading.current = true;
    setPhase("upgrading");
    setLogLines([]);
    setErrorMsg("");
    setQuipIdx(0);

    const result = await performUpgrade(installMethod, (msg) => {
      setLogLines((prev) => {
        const next = [...prev, msg];
        return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
      });
    });

    if (result.ok) {
      setPhase("success");
    } else {
      setPhase("failed");
      setErrorMsg(result.error ?? "Unknown error");
    }
    upgrading.current = false;
  }, [installMethod]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (phase === "upgrading") {
      evt.preventDefault();
      return;
    }

    if (phase === "success") {
      if (evt.name === "escape" || evt.name === "return") {
        setPhase("info");
        onClose();
      }
      evt.preventDefault();
      return;
    }

    if (phase === "failed") {
      if (evt.name === "escape" || evt.name === "return") {
        setPhase("info");
      }
      evt.preventDefault();
      return;
    }

    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "u" && updateAvailable && installMethod !== "binary") {
      doUpgrade();
      evt.preventDefault();
      return;
    }
    if (evt.name === "d") {
      if (latest) dismissVersion(latest);
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "c") {
      try {
        const b64 = Buffer.from(getUpgradeCommand(installMethod)).toString("base64");
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
      evt.preventDefault();
      return;
    }
    if (evt.name === "g") {
      const tag = updateAvailable ? latest : current;
      const url = tag
        ? `https://github.com/ProxySoul/soulforge/releases/tag/v${tag}`
        : "https://github.com/ProxySoul/soulforge/releases";
      try {
        const cmd = process.platform === "darwin" ? "open" : "xdg-open";
        Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {}
      evt.preventDefault();
      return;
    }
    evt.preventDefault();
  });

  if (!visible) return null;

  const upgradeCmd = getUpgradeCommand(installMethod);
  const canAuto = installMethod !== "binary" && installMethod !== "unknown" && updateAvailable;
  const isBinary = installMethod === "binary" || installMethod === "unknown";
  const releaseUrl = latest
    ? `https://github.com/ProxySoul/soulforge/releases/tag/v${latest}`
    : "https://github.com/ProxySoul/soulforge/releases";
  const arrowIc = icon("arrow_right");

  // ── Success ─────────────────────────────────────────────────────────────
  if (phase === "success") {
    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(16, termRows - 2)}
        borderColor={t.success}
        title="Upgrade Complete"
        titleIcon="check"
        blurb="The forge has been retempered"
        status="online"
        footerHints={[
          { key: "Esc", label: "close" },
          { key: "↵", label: "close" },
        ]}
      >
        <Section>
          <text bg={bg}>
            <span fg={t.textPrimary}>Successfully upgraded to </span>
            <span fg={t.success} attributes={BOLD}>
              v{latest}
            </span>
          </text>
          <VSpacer rows={1} bg={bg} />
          <text bg={bg} fg={t.brandAlt}>
            Please close and restart SoulForge to use the new version.
          </text>
        </Section>
      </PremiumPopup>
    );
  }

  // ── Upgrading ───────────────────────────────────────────────────────────
  if (phase === "upgrading") {
    const spin = SPINNER_FRAMES[spinIdx % SPINNER_FRAMES.length];
    const quip = UPGRADE_QUIPS[quipIdx % UPGRADE_QUIPS.length] ?? "";
    const visibleLog = logLines.slice(-logH);

    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(20, termRows - 2)}
        borderColor={t.brand}
        title="Upgrading"
        titleIcon="sparkle"
        blurb="Forging a fresh build"
      >
        <Section>
          <text bg={bg}>
            <span fg={t.brand} attributes={BOLD}>
              {spin}
            </span>
            <span fg={t.brandAlt} attributes={ITALIC}>
              {"  "}
              {trunc(quip, iw - 4)}
            </span>
          </text>
          <VSpacer rows={1} bg={bg} />
          <Divider width={iw} bg={bg} />
          <box flexDirection="column" height={logH} overflow="hidden">
            {visibleLog.length === 0 ? (
              <text bg={bg} fg={t.textFaint}>
                Waiting for output…
              </text>
            ) : (
              visibleLog.map((line, i) => (
                <text
                  key={String(i)}
                  bg={bg}
                  fg={i === visibleLog.length - 1 ? t.textSecondary : t.textFaint}
                >
                  {trunc(line, iw - 2)}
                </text>
              ))
            )}
          </box>
        </Section>
      </PremiumPopup>
    );
  }

  // ── Failed ──────────────────────────────────────────────────────────────
  if (phase === "failed") {
    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={Math.min(18, termRows - 2)}
        borderColor={t.brandSecondary}
        title="Upgrade Failed"
        titleIcon="error"
        blurb="The forge sputtered"
        status="error"
        footerHints={[{ key: "Esc", label: "back" }]}
      >
        <Section>
          <text bg={bg} fg={t.brandSecondary}>
            {trunc(errorMsg, iw - 2)}
          </text>
          <VSpacer rows={1} bg={bg} />
          <text bg={bg} fg={t.textMuted} attributes={ITALIC}>
            Try a manual upgrade:
          </text>
          <VSpacer rows={1} bg={bg} />
          <text bg={bg}>
            <span fg={t.textFaint}>
              {arrowIc}
              {"  "}
            </span>
            <span fg={t.brand} attributes={BOLD}>
              {trunc(upgradeCmd, iw - 4)}
            </span>
          </text>
        </Section>
      </PremiumPopup>
    );
  }

  // ── Info: no update available ───────────────────────────────────────────
  if (!updateAvailable) {
    const quip = LATEST_QUIPS[Math.floor(Date.now() / 60000) % LATEST_QUIPS.length] ?? "";
    const clErrorQuip =
      CHANGELOG_ERROR_QUIPS[Math.floor(Date.now() / 60000) % CHANGELOG_ERROR_QUIPS.length] ?? "";

    return (
      <PremiumPopup
        visible={visible}
        width={pw}
        height={popupH}
        borderColor={t.brand}
        title="Up to Date"
        titleIcon="check"
        blurb={`v${current} · latest`}
        status="online"
        footerHints={[
          { key: "G", label: "open on GitHub" },
          { key: "Esc", label: "close" },
        ]}
      >
        <Section>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.textMuted}>{icon("check")} Version </span>
              <span fg={t.success} attributes={BOLD}>
                v{current}
              </span>
              <span fg={t.textFaint}> — latest</span>
            </text>
          </box>
          <box flexDirection="row" backgroundColor={bg}>
            <text bg={bg}>
              <span fg={t.textMuted}>{icon("wrench")} Via </span>
              <span fg={t.textSecondary}>{installMethod}</span>
            </text>
          </box>

          {currentRelease && currentRelease.commits.length > 0 ? (
            <>
              <VSpacer rows={1} bg={bg} />
              <Divider width={iw} bg={bg} />
              <VSpacer rows={1} bg={bg} />
              <text bg={bg} fg={t.brandAlt} attributes={BOLD}>
                What's in this version
              </text>
              <VSpacer rows={1} bg={bg} />
              <ChangelogSection
                releases={[currentRelease]}
                maxLines={maxChangelog}
                iw={iw}
                bg={bg}
                t={t}
              />
            </>
          ) : changelogError ? (
            <>
              <VSpacer rows={1} bg={bg} />
              <Divider width={iw} bg={bg} />
              <VSpacer rows={1} bg={bg} />
              <text bg={bg} fg={t.error} attributes={ITALIC}>
                {icon("warning")} {clErrorQuip}
              </text>
            </>
          ) : (
            <>
              <VSpacer rows={1} bg={bg} />
              <Divider width={iw} bg={bg} />
              <VSpacer rows={1} bg={bg} />
              <text bg={bg} fg={t.brandAlt} attributes={ITALIC}>
                {quip}
              </text>
            </>
          )}
        </Section>
      </PremiumPopup>
    );
  }

  // ── Info: update available ──────────────────────────────────────────────
  const hints: { key: string; label: string }[] = [];
  if (canAuto) hints.push({ key: "U", label: "upgrade" });
  if (!isBinary) hints.push({ key: "C", label: copied ? "copied ✓" : "copy" });
  hints.push({ key: "D", label: "dismiss" });
  hints.push({ key: "G", label: "GitHub" });
  hints.push({ key: "Esc", label: "close" });

  return (
    <PremiumPopup
      visible={visible}
      width={pw}
      height={popupH}
      borderColor={t.success}
      title="Update Available"
      titleIcon="sparkle"
      blurb={`v${current} → v${latest}`}
      status="warning"
      footerHints={hints}
      flash={copied ? { kind: "ok", message: "Command copied to clipboard" } : null}
    >
      <Section>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.textMuted}>{icon("clock")} Current </span>
            <span fg={t.textPrimary}>v{current}</span>
          </text>
        </box>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.textMuted}>{icon("sparkle")} Latest </span>
            <span fg={t.success} attributes={BOLD}>
              v{latest ?? current}
            </span>
          </text>
        </box>
        <box flexDirection="row" backgroundColor={bg}>
          <text bg={bg}>
            <span fg={t.textMuted}>{icon("wrench")} Via </span>
            <span fg={t.textSecondary}>{installMethod}</span>
          </text>
        </box>

        {changelog.length > 0 ? (
          <>
            <VSpacer rows={1} bg={bg} />
            <Divider width={iw} bg={bg} />
            <VSpacer rows={1} bg={bg} />
            <text bg={bg} fg={t.brandAlt} attributes={BOLD}>
              What's new
            </text>
            <VSpacer rows={1} bg={bg} />
            <ChangelogSection releases={changelog} maxLines={maxChangelog} iw={iw} bg={bg} t={t} />
          </>
        ) : changelogError ? (
          <>
            <VSpacer rows={1} bg={bg} />
            <Divider width={iw} bg={bg} />
            <VSpacer rows={1} bg={bg} />
            <text bg={bg} fg={t.error} attributes={ITALIC}>
              {icon("warning")}{" "}
              {CHANGELOG_ERROR_QUIPS[Math.floor(Date.now() / 60000) % CHANGELOG_ERROR_QUIPS.length]}
            </text>
          </>
        ) : null}

        <VSpacer rows={1} bg={bg} />
        <Divider width={iw} bg={bg} />
        <VSpacer rows={1} bg={bg} />
        {isBinary ? (
          <>
            <text bg={bg} fg={t.textMuted}>
              {icon("globe")} Download from GitHub
            </text>
            <text bg={bg}>
              <span fg={t.textFaint}>
                {arrowIc}
                {"  "}
              </span>
              <span fg={t.brand} attributes={BOLD}>
                {trunc(releaseUrl, iw - 4)}
              </span>
            </text>
          </>
        ) : (
          <>
            <text bg={bg} fg={t.textMuted}>
              {icon("terminal")} Upgrade command
            </text>
            <text bg={bg}>
              <span fg={t.textFaint}>
                {arrowIc}
                {"  "}
              </span>
              <span fg={t.brand} attributes={BOLD}>
                {trunc(upgradeCmd, iw - 4)}
              </span>
            </text>
          </>
        )}
      </Section>
    </PremiumPopup>
  );
}
