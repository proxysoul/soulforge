import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackendProbeResult, HealthCheckResult } from "../../core/intelligence/router.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { SPINNER_FRAMES, useSpinnerFrameRef } from "../layout/shared.js";
import { InfoLine, type InfoLineData, PremiumPopup, Section } from "../ui/index.js";
import { listScrollAccel } from "../ui/scroll.js";

interface Props {
  visible: boolean;
  onClose: () => void;
  runHealthCheck: (
    onProgress: (partial: HealthCheckResult) => void,
  ) => Promise<HealthCheckResult | null>;
}

function statusBadge(
  br: BackendProbeResult,
  running: boolean,
  spinnerCh: string,
  t: ThemeTokens,
): { ch: string; color: string } {
  if (!br.supports) return { ch: "○", color: t.textMuted };
  if (br.initError) return { ch: "✗", color: t.error };
  if (br.probes.length === 0 && running) return { ch: spinnerCh, color: t.amber };
  const allPass =
    br.probes.length > 0 &&
    br.probes.every((p) => p.status === "pass" || p.status === "unsupported");
  if (allPass) return { ch: "●", color: t.success };
  if (br.probes.some((p) => p.status === "pass")) return { ch: "◐", color: t.warning };
  if (br.probes.length === 0) return { ch: "◌", color: t.amber };
  return { ch: "✗", color: t.error };
}

function buildLines(
  result: HealthCheckResult,
  running: boolean,
  spinnerCh: string,
  t: ThemeTokens,
): InfoLineData[] {
  const lines: InfoLineData[] = [];

  for (let bi = 0; bi < result.backends.length; bi++) {
    const br = result.backends[bi];
    if (!br) continue;
    const s = statusBadge(br, running, spinnerCh, t);

    if (bi > 0) lines.push({ type: "spacer" });
    lines.push({
      type: "header",
      label: `${s.ch} ${br.backend} (tier ${br.tier})`,
      color: s.color,
    });

    if (!br.supports) {
      lines.push({ type: "text", label: "  does not support this language", color: t.textMuted });
    } else if (br.initError) {
      lines.push({
        type: "text",
        label: `  init failed: ${br.initError.slice(0, 50)}`,
        color: t.error,
      });
    } else if (br.probes.length === 0) {
      lines.push({ type: "text", label: "  waiting…", color: t.textMuted });
    } else {
      for (const probe of br.probes) {
        const pIcon =
          probe.status === "pass"
            ? "✓"
            : probe.status === "empty"
              ? "○"
              : probe.status === "unsupported"
                ? "—"
                : probe.status === "timeout"
                  ? "⏱"
                  : "✗";
        const pColor =
          probe.status === "pass"
            ? t.success
            : probe.status === "empty"
              ? t.warning
              : probe.status === "unsupported"
                ? t.textMuted
                : t.error;
        const timing = probe.ms !== undefined ? ` ${probe.ms}ms` : "";
        const desc =
          probe.status === "error"
            ? `${pIcon} ${(probe.error ?? "").slice(0, 30)}`
            : `${pIcon} ${probe.status}${timing}`;
        lines.push({
          type: "entry",
          label: `  ${probe.operation}`,
          desc,
          color: t.textSecondary,
          descColor: pColor,
        });
      }
    }
  }

  return lines;
}

export function DiagnosePopup({ visible, onClose, runHealthCheck }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [result, setResult] = useState<HealthCheckResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const spinnerRef = useSpinnerFrameRef();
  const spinnerCh = SPINNER_FRAMES[spinnerRef.current % SPINNER_FRAMES.length] ?? "⠋";

  const popupW = Math.min(80, Math.max(56, Math.floor(tw * 0.65)));
  const popupH = Math.min(30, Math.max(16, th - 4));
  const contentW = popupW - 4;
  const viewportRows = Math.max(6, popupH - 9);

  const lines = useMemo(
    () => (result ? buildLines(result, running, spinnerCh, t) : []),
    [result, running, spinnerCh, t],
  );

  const run = useCallback(() => {
    setRunning(true);
    setErr(null);
    setResult(null);
    setCursor(0);
    scrollRef.current?.scrollTo(0);

    const timeout = setTimeout(() => {
      setRunning(false);
      setErr("Health check timed out");
    }, 90_000);

    runHealthCheck((partial) => setResult({ ...partial }))
      .then((final) => {
        clearTimeout(timeout);
        setRunning(false);
        if (final) setResult(final);
        else setErr((e) => e ?? "Intelligence router not initialized");
      })
      .catch((ex) => {
        clearTimeout(timeout);
        setRunning(false);
        setErr(ex instanceof Error ? ex.message : String(ex));
      });
  }, [runHealthCheck]);

  useEffect(() => {
    if (visible) run();
  }, [visible, run]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "r") {
      run();
      evt.preventDefault();
      return;
    }
    const maxOff = Math.max(0, lines.length - viewportRows);
    if (evt.name === "up" || evt.name === "k") {
      const n = Math.max(0, cursor - 1);
      setCursor(n);
      scrollRef.current?.scrollTo(n);
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      const n = Math.min(maxOff, cursor + 1);
      setCursor(n);
      scrollRef.current?.scrollTo(n);
      evt.preventDefault();
      return;
    }
    if (evt.name === "pageup") {
      const n = Math.max(0, cursor - viewportRows);
      setCursor(n);
      scrollRef.current?.scrollTo(n);
      evt.preventDefault();
      return;
    }
    if (evt.name === "pagedown") {
      const n = Math.min(maxOff, cursor + viewportRows);
      setCursor(n);
      scrollRef.current?.scrollTo(n);
      evt.preventDefault();
      return;
    }
    evt.preventDefault();
  });

  if (!visible) return null;

  const blurb = result
    ? `${result.language} · ${result.probeFile.split("/").pop()}`
    : running
      ? "Running probes…"
      : (err ?? "Initializing…");

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Health Check"
      titleIcon="brain"
      blurb={blurb}
      footerHints={[
        { key: "↑↓", label: "scroll" },
        { key: "r", label: "re-run" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        {lines.length > 0 ? (
          <scrollbox ref={scrollRef} height={viewportRows} scrollAcceleration={listScrollAccel}>
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <InfoLine key={`d-${i}`} line={line} width={contentW} labelWidth={28} />
            ))}
          </scrollbox>
        ) : (
          <box flexDirection="row" paddingX={2} paddingY={1} backgroundColor={t.bgPopup}>
            <text bg={t.bgPopup} fg={err ? t.error : t.amber}>
              {err ?? `${spinnerCh} initializing…`}
            </text>
          </box>
        )}
      </Section>
    </PremiumPopup>
  );
}
