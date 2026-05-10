import { fg as fgStyle, StyledText, type TextRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef } from "react";
import type { ContextManager } from "../../core/context/manager.js";
import { icon } from "../../core/icons.js";
import { getThemeTokens } from "../../core/theme/index.js";
import { useStatusBarStore } from "../../stores/statusbar.js";
import { useWorkerStore, type WorkerStatus } from "../../stores/workers.js";

const BAR_WIDTH = 8;
const CHARS_PER_TOKEN = 4;
const STEP_MS = 50;
const EASE = 0.35;

function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * EASE;
  return Math.abs(next - target) < 1 ? target : Math.round(next);
}

function getBarColor(pct: number): string {
  const tk = getThemeTokens();
  if (pct < 50) return tk.success;
  if (pct < 70) return tk.warning;
  if (pct < 85) return tk.warning;
  return tk.error;
}

function getPctColor(pct: number): string {
  const tk = getThemeTokens();
  if (pct < 50) return tk.success;
  if (pct < 70) return tk.warning;
  if (pct < 85) return tk.warning;
  return tk.error;
}

function getFlashColor(pct: number): string {
  const tk = getThemeTokens();
  if (pct < 50) return tk.success;
  if (pct < 70) return tk.warning;
  if (pct < 85) return tk.warning;
  return tk.error;
}

const COMPACT_FRAMES = ["◐", "◓", "◑", "◒"];

function humanizeTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

interface BarTarget {
  pct: number;
  live: boolean;
  flash: boolean;
  usedTokens: number;
  windowTokens: number;
}

interface WorkerIndicator {
  intel: WorkerStatus;
  io: WorkerStatus;
}

function buildContent(
  pct: number,
  live: boolean,
  flash: boolean,
  usedTokens: number,
  windowTokens: number,
  compacting?: { active: boolean; frame: number },
  workers?: WorkerIndicator,
  browsing?: boolean,
  memoryHint?: { stale: number } | null,
): StyledText {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const barColor = getBarColor(pct);
  const pulse = pct > 80;

  const pctColor = flash ? getFlashColor(pct) : getPctColor(pct);
  const t = getThemeTokens();
  const tokenLabel =
    usedTokens > 0 ? ` ~${humanizeTokens(usedTokens)}/${humanizeTokens(windowTokens)}` : "";
  // When browsing a past checkpoint, render everything in warning/muted tones
  if (browsing) {
    const chunks = [
      fgStyle(t.warning)("◀ "),
      fgStyle(t.textFaint)("["),
      fgStyle(t.warning)("▰".repeat(filled)),
      fgStyle(t.textSubtle)("▱".repeat(empty)),
      fgStyle(t.textFaint)("]"),
      fgStyle(t.warning)(`~${String(pct)}%`),
      fgStyle(t.textDim)(tokenLabel),
    ];
    return new StyledText(chunks);
  }
  const chunks = [
    fgStyle(live ? t.success : t.textDim)("● "),
    fgStyle(t.textFaint)("["),
    fgStyle(pulse ? t.error : barColor)("▰".repeat(filled)),
    fgStyle(t.textSubtle)("▱".repeat(empty)),
    fgStyle(t.textFaint)("]"),
    fgStyle(pctColor)(live ? `${String(pct)}%` : `~${String(pct)}%`),
    fgStyle(t.textDim)(tokenLabel),
  ];
  if (compacting?.active) {
    const spinner = COMPACT_FRAMES[compacting.frame % COMPACT_FRAMES.length] ?? "◐";
    chunks.push(fgStyle(t.info)(` ${spinner} compacting`));
  }
  if (workers) {
    const worst =
      workers.intel === "crashed" || workers.io === "crashed"
        ? "crashed"
        : workers.intel === "restarting" || workers.io === "restarting"
          ? "restarting"
          : null;
    if (worst) {
      const wColor = worst === "crashed" ? t.error : t.warning;
      const wGlyph = worst === "crashed" ? icon("worker_crash") : icon("worker_restart");
      chunks.push(fgStyle(wColor)(` ${wGlyph}`));
    }
  }
  if (memoryHint && memoryHint.stale > 0) {
    chunks.push(
      fgStyle(t.warning)(
        ` ${icon("cleanup")} ${String(memoryHint.stale)} stale memor${memoryHint.stale === 1 ? "y" : "ies"} — /memory cleanup`,
      ),
    );
  }
  return new StyledText(chunks);
}

interface Props {
  contextManager: ContextManager;
  modelId: string;
  suppressCompacting?: boolean;
}

export function ContextBar({ contextManager, suppressCompacting }: Props) {
  const textRef = useRef<TextRenderable>(null);

  const targetRef = useRef<BarTarget>({
    pct: 0,
    live: false,
    flash: false,
    usedTokens: 0,
    windowTokens: 200_000,
  });
  const prevTotalRef = useRef(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPctRef = useRef(0);
  const compactFrameRef = useRef(0);
  const wasCompactingRef = useRef(false);
  const prevWindowRef = useRef(0);
  const workerRef = useRef<WorkerIndicator>({ intel: "idle", io: "idle" });
  const browsingRef = useRef(false);
  const suppressCompactingRef = useRef(suppressCompacting);
  suppressCompactingRef.current = suppressCompacting;
  // Cleanup-hint state — polled lazily inside the render tick (every 30s)
  // so we don't recompute it on every frame. Cheap query: counts only.
  const memoryHintRef = useRef<{ stale: number } | null>(null);
  const memoryHintLastCheckRef = useRef(0);
  const renderedContentRef = useRef(buildContent(0, false, false, 0, 200_000));

  const computeTarget = useCallback(
    (state: {
      contextTokens: number;
      contextWindow: number;
      chatChars: number;
      chatCharsAtSnapshot: number;
      subagentChars: number;
    }) => {
      const ctxWindow = state.contextWindow || 200_000;
      const isApi = state.contextTokens > 0;
      const breakdown = contextManager.getContextBreakdown();
      const systemChars = breakdown.reduce((sum, s) => sum + s.chars, 0);
      const charEstimate = (systemChars + state.chatChars + state.subagentChars) / CHARS_PER_TOKEN;
      const chatCharsDelta = Math.max(0, state.chatChars - state.chatCharsAtSnapshot);
      const totalTokens = isApi
        ? state.contextTokens + (chatCharsDelta + state.subagentChars) / CHARS_PER_TOKEN
        : charEstimate;
      const rawPct = (totalTokens / ctxWindow) * 100;
      const pct = totalTokens > 0 ? Math.min(100, Math.max(1, Math.round(rawPct))) : 0;

      let flash = targetRef.current.flash;
      if (totalTokens > prevTotalRef.current + 50) {
        flash = true;
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          targetRef.current = { ...targetRef.current, flash: false };
        }, 500);
      }
      prevTotalRef.current = totalTokens;
      targetRef.current = {
        pct,
        live: isApi,
        flash,
        usedTokens: totalTokens,
        windowTokens: ctxWindow,
      };
    },
    [contextManager],
  );

  useEffect(() => {
    const state = useStatusBarStore.getState();
    computeTarget(state);
    currentPctRef.current = targetRef.current.pct;
    return useStatusBarStore.subscribe(computeTarget);
  }, [computeTarget]);

  useEffect(() => {
    return useWorkerStore.subscribe((state) => {
      workerRef.current = { intel: state.intelligence.status, io: state.io.status };
    });
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const target = targetRef.current;
      const store = useStatusBarStore.getState();
      const isCompacting = suppressCompactingRef.current ? false : store.compacting;
      if (isCompacting) compactFrameRef.current++;
      const wasCompacting = wasCompactingRef.current;
      wasCompactingRef.current = isCompacting;
      const pct = approach(currentPctRef.current, target.pct);
      const wk = workerRef.current;
      const wkChanged =
        wk.intel === "crashed" ||
        wk.intel === "restarting" ||
        wk.io === "crashed" ||
        wk.io === "restarting";
      const compactChanged = isCompacting !== wasCompacting;
      const windowChanged = target.windowTokens !== prevWindowRef.current;
      if (windowChanged) prevWindowRef.current = target.windowTokens;
      const browsing = store.browsingCheckpoint;
      const browsingChanged = browsing !== browsingRef.current;
      browsingRef.current = browsing;

      // Poll cleanup hint every 30s — cheap (count + threshold check), but
      // not zero. We don't need higher frequency: hint is a banner, not a
      // live metric.
      const now = Date.now();
      let memoryHintChanged = false;
      if (now - memoryHintLastCheckRef.current >= 30_000) {
        memoryHintLastCheckRef.current = now;
        try {
          const next = contextManager.getMemoryManager().cleanupHint();
          const nextSimple = next ? { stale: next.stale } : null;
          const prev = memoryHintRef.current;
          const same =
            (prev === null && nextSimple === null) ||
            (prev !== null && nextSimple !== null && prev.stale === nextSimple.stale);
          if (!same) {
            memoryHintRef.current = nextSimple;
            memoryHintChanged = true;
          }
        } catch {}
      }

      if (
        pct === currentPctRef.current &&
        !target.flash &&
        !isCompacting &&
        !compactChanged &&
        !wkChanged &&
        !windowChanged &&
        !browsingChanged &&
        !memoryHintChanged
      )
        return;
      currentPctRef.current = pct;
      try {
        const content = buildContent(
          pct,
          target.live,
          target.flash,
          target.usedTokens,
          target.windowTokens,
          isCompacting ? { active: true, frame: compactFrameRef.current } : undefined,
          wk,
          browsing,
          memoryHintRef.current,
        );
        renderedContentRef.current = content;
        if (textRef.current) {
          textRef.current.content = content;
        }
      } catch {}
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [contextManager]);

  return <text ref={textRef} truncate content={renderedContentRef.current} />;
}
