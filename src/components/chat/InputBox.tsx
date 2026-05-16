import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { decodePasteBytes, type PasteEvent, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCommandDefs } from "../../core/commands/registry.js";
import { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "../../core/history/fuzzy.js";
import {
  frecencyScore,
  getFrecencyDB,
  getHistoryDB,
  getStashDB,
  onDraftRestore,
} from "../../core/history/index.js";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { useUIStore } from "../../stores/ui.js";
import type { ImageAttachment } from "../../types/index.js";
import { readClipboardImageAsync } from "../../utils/clipboard.js";
import { compressImageForApi } from "../../utils/image-compress.js";
import { compactScrollAccel } from "../ui/scroll.js";
import { pickTip } from "./tips.js";

interface Props {
  onSubmit: (value: string, images?: ImageAttachment[]) => void;
  isLoading: boolean;
  isCompacting?: boolean;
  isFocused?: boolean;
  onQueue?: (msg: string, images?: ImageAttachment[]) => void;
  onExit?: () => void;
  cwd?: string;
  onDropdownChange?: (visible: boolean) => void;
  /** Container width as a percentage of terminal width — used when the input is narrower than the terminal (e.g. landing page). */
  widthPct?: number;
  /** Called when Tab is pressed and not consumed by autocomplete. Direction: 1 = next, -1 = prev. */
  onCycleTab?: (direction: 1 | -1) => void;
  /** When set, the user is browsing a past checkpoint — show a rewind hint. */
  viewingCheckpoint?: number | null;
}

let _commands: Array<{ cmd: string; icon: string; desc: string }> | null = null;
function getCommands() {
  if (!_commands) {
    _commands = getCommandDefs()
      .filter((c) => !c.hidden)
      .map((c) => ({ cmd: c.cmd, icon: icon(c.ic), desc: c.desc }));
  }
  return _commands;
}

const HighlightedText = memo(function HighlightedText({
  text,
  indices,
}: {
  text: string;
  indices: number[];
}) {
  const t = useTheme();
  if (indices.length === 0) return <text fg={t.textPrimary}>{text}</text>;
  const indexSet = new Set(indices);
  const spans: { text: string; hl: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const hl = indexSet.has(i);
    const last = spans[spans.length - 1];
    if (last && last.hl === hl) {
      last.text += char;
    } else {
      spans.push({ text: char, hl });
    }
  }
  return (
    <text>
      {spans.map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: stable span order
          key={i}
          fg={s.hl ? t.brandSecondary : t.textPrimary}
          attributes={s.hl ? TextAttributes.BOLD : undefined}
        >
          {s.text}
        </span>
      ))}
    </text>
  );
});

/** Override textarea defaults: Enter=submit, Shift+Enter=newline */
const INPUT_KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
];

/** Re-create virtual extmarks for all [image-N] tokens in the textarea.
 *  Must be called after setText() which resets the buffer and destroys extmarks. */
function syncImageExtmarks(ta: TextareaRenderable): void {
  ta.extmarks.clear();
  const text = ta.plainText;
  const re = /\[image-\d+\]/g;
  let m = re.exec(text);
  while (m !== null) {
    ta.extmarks.create({ start: m.index, end: m.index + m[0].length, virtual: true });
    m = re.exec(text);
  }
}

export const InputBox = memo(function InputBox({
  onSubmit,
  isLoading,
  isCompacting,
  isFocused,
  onQueue,
  onExit,
  cwd,
  onDropdownChange,
  widthPct,
  onCycleTab,
  viewingCheckpoint,
}: Props) {
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const [selectedIdx, setSelectedIdx] = useState(0);
  const renderer = useRenderer();
  const { height: termRows, width: termWidth } = useTerminalDimensions();
  const acScrollRef = useRef<ScrollBoxRenderable>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const containerRef = useRef<BoxRenderable>(null);
  // Snapshot visual row at end of each key event — used to gate history on NEXT keypress
  const preKeyVisualRow = useRef(0);
  // Track logical cursor line
  const cursorLineRef = useRef(0);
  const lineCountRef = useRef(1);
  // Guard: when true, handleContentChange skips historyIdx reset (programmatic setText)
  const isNavigatingHistory = useRef(false);
  const pendingCursorEnd = useRef(false);
  // Visual line count (after char-wrapping) for textarea height
  const [visualLines, setVisualLines] = useState(1);
  // Paste blocks: collapsed pasted text regions
  const pasteBlocks = useRef<
    Array<{ id: number; text: string; collapsed: boolean; placeholder: string }>
  >([]);
  const pasteIdCounter = useRef(0);
  // Image attachments from clipboard paste
  const pendingImages = useRef<ImageAttachment[]>([]);
  const imageCounter = useRef(0);
  const imageLoadingRef = useRef(false);

  const showBusy = isLoading || isCompacting;

  // Rotating tip — drives the placeholder when input is empty + not busy.
  // Advances every 12s; React triggers a re-render via a state tick so the
  // textarea picks up the new placeholder string.
  const [tipTick, setTipTick] = useState(0);
  useEffect(() => {
    if (value.length > 0 || showBusy || viewingCheckpoint != null) return;
    const timer = setInterval(() => setTipTick((n) => n + 1), 12_000);
    return () => clearInterval(timer);
  }, [value.length, showBusy, viewingCheckpoint]);
  const tip = useMemo(() => pickTip(Date.now() + tipTick * 12_000), [tipTick]);

  // textarea width = container - border(2) - paddingX(2) - prompt(2) = containerWidth - 6
  // When busy hint is shown, subtract its width too
  const containerWidth = widthPct != null ? Math.floor((termWidth * widthPct) / 100) : termWidth;
  const hintWidth = showBusy ? 8 : 0; // " ^X stop" = 8 chars
  const textareaWidth = Math.max(10, containerWidth - 6 - hintWidth);

  // Calculate visual lines manually (virtualLineCount is viewport-constrained — chicken-and-egg)
  const calcVisualLines = useCallback(
    (text: string) => {
      let n = 0;
      for (const line of text.split("\n")) {
        n += line.length === 0 ? 1 : Math.ceil(line.length / textareaWidth);
      }
      return n;
    },
    [textareaWidth],
  );

  const historyCacheRef = useRef<string[]>([]);
  const historyIdx = useRef(-1);
  const historyStash = useRef("");

  const refreshHistoryCache = useCallback(() => {
    try {
      historyCacheRef.current = getHistoryDB().recent(500);
    } catch {
      historyCacheRef.current = [];
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init
  useEffect(() => {
    refreshHistoryCache();
  }, []);

  // Restore the latest stash entry when this InputBox mounts with an empty
  // value. Tab switches and session restores recreate the component, so this
  // hook gives the user their draft back without an explicit Alt+P.
  const stashRestoredRef = useRef(false);
  useEffect(() => {
    if (stashRestoredRef.current) return;
    stashRestoredRef.current = true;
    if (valueRef.current.trim().length > 0) return;
    try {
      const top = getStashDB().peekTop(cwd);
      if (!top) return;
      isNavigatingHistory.current = true;
      setValue(top.content);
      textareaRef.current?.setText(top.content);
      textareaRef.current?.gotoBufferEnd();
      lineCountRef.current = (top.content.match(/\n/g)?.length ?? 0) + 1;
      // Consume the draft — the user explicitly popping (Alt+P) deletes older
      // entries; auto-restore on mount should not pile up.
      getStashDB().remove(top.id);
    } catch {}
  }, [cwd]);

  const [fuzzyMode, setFuzzyMode] = useState(false);
  const [fuzzyQuery, setFuzzyQuery] = useState("");
  const [fuzzyResults, setFuzzyResults] = useState<FuzzyMatch[]>([]);
  const [fuzzyCursor, setFuzzyCursor] = useState(0);
  const fuzzyScrollRef = useRef<ScrollBoxRenderable>(null);
  const fuzzyScrollOffset = useRef(0);

  useEffect(() => {
    if (!fuzzyMode) return;
    try {
      const candidates = getHistoryDB().recent(500);
      setFuzzyResults(fuzzyFilter(fuzzyQuery, candidates, 50));
      // Boost prompts that frecency knows about — drafts you keep reopening
      // rank above one-off entries even when the textual match score ties.
      // (No-op when there's no frecency data yet.)
      setFuzzyCursor(0);
      fuzzyScrollOffset.current = 0;
      fuzzyScrollRef.current?.scrollTo(0);
    } catch {
      setFuzzyResults([]);
    }
  }, [fuzzyQuery, fuzzyMode]);

  const floatingTermOpen = useUIStore((s) => s.modals.floatingTerminal);
  const lockIn = useUIStore((s) => s.lockIn);
  const focused = floatingTermOpen ? false : (isFocused ?? true);

  // Subscribe to the draft-restore bus so /stash and other surfaces can push
  // a draft into the focused input.
  useEffect(() => {
    return onDraftRestore((content) => {
      if (!focused) return;
      isNavigatingHistory.current = true;
      setValue(content);
      textareaRef.current?.setText(content);
      textareaRef.current?.gotoBufferEnd();
      lineCountRef.current = (content.match(/\n/g)?.length ?? 0) + 1;
    });
  }, [focused]);

  // Refresh history when input gains focus (covers tab switches, session restores)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh on focus gain
  useEffect(() => {
    if (focused) refreshHistoryCache();
  }, [focused]);

  // Match on the full input so multi-word commands like "/git commit" work.
  // Falls back to first-word matching for single-word input.
  const commandToken = value.toLowerCase();
  const showAutocomplete =
    value.startsWith("/") && focused && !fuzzyMode && historyIdx.current === -1;
  const matches = useMemo(() => {
    if (!showAutocomplete) return [];
    const cmds = getCommands();
    const results: Array<{
      cmd: string;
      icon: string;
      desc: string;
      score: number;
      indices: number[];
    }> = [];
    for (const c of cmds) {
      const m = fuzzyMatch(commandToken, c.cmd);
      if (m) results.push({ ...c, score: m.score, indices: m.indices });
    }
    // Blend frecency into the fuzzy score so commands the user actually runs
    // bubble up. `factor = 1 + frecency` keeps unscored commands at score×1
    // while frequent picks get a multiplicative bump. Capped to prevent a
    // single hot command from drowning the rest.
    if (results.length > 0) {
      const frecLookup = getFrecencyDB().byKeys(
        "command",
        results.map((r) => r.cmd),
      );
      const now = Date.now();
      for (const r of results) {
        const row = frecLookup.get(r.cmd);
        if (!row) continue;
        const frec = frecencyScore(row.frequency, row.lastUsedAt, now);
        r.score *= 1 + Math.min(frec, 4);
      }
    }
    results.sort((a, b) => b.score - a.score || a.cmd.localeCompare(b.cmd));
    return results;
  }, [showAutocomplete, commandToken]);
  const hasMatches = matches.length > 0;
  // Nav active when input is still a prefix of at least one match (not past the command into args).
  // For fuzzy matches (e.g. "/clear" → "/context clear"), allow nav when the input
  // is a single token (no space after the slash-word) even if it's not a literal prefix.
  const trimmedToken = commandToken.trimEnd();
  const isCommandPrefix =
    hasMatches &&
    (matches.some((m) => m.cmd.startsWith(trimmedToken)) || !trimmedToken.includes(" ", 1));
  const hasMatchesForNav = hasMatches && isCommandPrefix;

  const ghost =
    hasMatchesForNav && matches[selectedIdx]?.cmd.startsWith(commandToken)
      ? matches[selectedIdx].cmd.slice(value.length)
      : "";

  const maxVisible = Math.min(8, Math.max(4, Math.floor(termRows * 0.25)));
  const acScrollOffset = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when input changes
  useEffect(() => {
    setSelectedIdx(0);
    acScrollOffset.current = 0;
    acScrollRef.current?.scrollTo(0);
  }, [value]);

  useEffect(() => {
    if (!hasMatches) return;
    const offset = acScrollOffset.current;
    if (selectedIdx < offset) {
      acScrollOffset.current = selectedIdx;
      acScrollRef.current?.scrollTo(selectedIdx);
    } else if (selectedIdx >= offset + maxVisible) {
      const newOffset = selectedIdx - maxVisible + 1;
      acScrollOffset.current = newOffset;
      acScrollRef.current?.scrollTo(newOffset);
    }
  }, [selectedIdx, hasMatches, maxVisible]);

  const acceptCompletion = useCallback(() => {
    const completed = matches[selectedIdx]?.cmd;
    if (!completed) return;
    isNavigatingHistory.current = true;
    setValue(completed);
    textareaRef.current?.setText(completed);
    lineCountRef.current = (completed.match(/\n/g)?.length ?? 0) + 1;
    cursorLineRef.current = 0;
  }, [matches, selectedIdx]);

  const pushHistory = useCallback(
    (input: string) => {
      try {
        getHistoryDB().push(input, cwd);
        refreshHistoryCache();
        const slashCmd = input.trim().split(/\s+/)[0];
        if (slashCmd?.startsWith("/")) {
          getFrecencyDB().bump("command", slashCmd);
        }
      } catch {}
    },
    [refreshHistoryCache, cwd],
  );

  const resetInput = useCallback(() => {
    isNavigatingHistory.current = true;
    setValue("");
    textareaRef.current?.setText("");
    textareaRef.current?.extmarks.clear();
    cursorLineRef.current = 0;
    lineCountRef.current = 1;
    historyIdx.current = -1;
    pasteBlocks.current = [];
    pendingImages.current = [];
    imageCounter.current = 0;
    setVisualLines(1);
  }, []);

  const handleSubmit = useCallback(
    (input: string) => {
      // Auto-select top fuzzy match when input is a slash command with no exact handler.
      // e.g. "/api" fuzzy-matches "/session export api" — select it instead of "command not found".
      const useAutocomplete =
        hasMatchesForNav || (showAutocomplete && hasMatches && matches[selectedIdx]);
      if (useAutocomplete && matches[selectedIdx]) {
        const completed = matches[selectedIdx].cmd;
        if (completed === "/open" || completed === "/git branch") {
          const withSpace = `${completed} `;
          isNavigatingHistory.current = true;
          setValue(withSpace);
          textareaRef.current?.setText(withSpace);
          lineCountRef.current = 1;
          cursorLineRef.current = 0;
        } else {
          pushHistory(completed);
          onSubmit(completed);
          resetInput();
        }
        return;
      }

      if (input.trim() === "") return;

      // Block submit while clipboard image probe is in-flight —
      // ensures the image attachment lands before the message is sent
      if (imageLoadingRef.current) return;

      // Expand any collapsed paste blocks before submitting
      let finalInput = input;
      for (const block of pasteBlocks.current) {
        if (block.collapsed) {
          finalInput = finalInput.replace(block.placeholder, block.text);
        }
      }

      // Sync pendingImages: only keep images whose [label] is still in the text
      if (pendingImages.current.length > 0) {
        pendingImages.current = pendingImages.current.filter((img) =>
          finalInput.includes(`[${img.label}]`),
        );
      }

      // During loading or compacting: slash commands execute immediately, messages queue
      if ((isLoading || isCompacting) && !finalInput.trim().startsWith("/")) {
        const images = pendingImages.current.length > 0 ? [...pendingImages.current] : undefined;
        onQueue?.(finalInput.trim(), images);
        resetInput();
        return;
      }

      pushHistory(finalInput.trim());
      const images = pendingImages.current.length > 0 ? [...pendingImages.current] : undefined;
      onSubmit(finalInput.trim(), images);
      resetInput();
    },
    [
      matches,
      selectedIdx,
      pushHistory,
      onSubmit,
      resetInput,
      isLoading,
      isCompacting,
      onQueue,
      hasMatchesForNav,
      showAutocomplete,
      hasMatches,
    ],
  );

  // Sync textarea content → React state.
  // Safety net: if an [image-N] token was removed (via extmark deletion),
  // sync pendingImages to match.
  const handleContentChange = useCallback(() => {
    const ta = textareaRef.current;
    const text = ta?.plainText ?? "";
    if (isNavigatingHistory.current) {
      isNavigatingHistory.current = false;
    } else {
      historyIdx.current = -1;
    }

    // Sync pendingImages with surviving tokens
    if (pendingImages.current.length > 0) {
      const surviving = pendingImages.current.filter((img) => text.includes(`[${img.label}]`));
      if (surviving.length < pendingImages.current.length) {
        pendingImages.current = surviving;
      }
    }

    setValue(text);
    lineCountRef.current = ta?.lineCount ?? 1;
    setVisualLines(calcVisualLines(text));
  }, [calcVisualLines]);

  // Track cursor line for history gating
  const handleCursorChange = useCallback((event: { line: number; visualColumn: number }) => {
    cursorLineRef.current = event.line;
  }, []);

  // After fuzzy history selection, the textarea remounts — move cursor to end
  useEffect(() => {
    if (!fuzzyMode && pendingCursorEnd.current) {
      pendingCursorEnd.current = false;
      const t = setTimeout(() => {
        textareaRef.current?.gotoBufferEnd();
      }, 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [fuzzyMode]);

  // Recalculate visual lines on terminal width/busy change
  useEffect(() => {
    setVisualLines(calcVisualLines(valueRef.current));
  }, [calcVisualLines]);

  // Intercept paste — collapse 4+ line text pastes
  useEffect(() => {
    const handler = (event: PasteEvent) => {
      if (!isFocused) return;
      const text = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const pastedLines = text.split("\n");

      // 1-3 lines: let textarea handle normally
      if (pastedLines.length <= 3) return;

      // 4+ lines: collapse into inline placeholder with preview
      event.preventDefault();
      const id = ++pasteIdCounter.current;
      const firstLine = (pastedLines[0] ?? "").trim();
      const preview = firstLine.length > 30 ? `${firstLine.slice(0, 30)}...` : firstLine;
      const placeholder = `<pasted (${preview} +${pastedLines.length} lines)>`;
      pasteBlocks.current.push({ id, text, collapsed: true, placeholder });
      textareaRef.current?.insertText(placeholder);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [isFocused, renderer]);

  useKeyboard((evt) => {
    // Ctrl+V: probe clipboard for image data in the background.
    // We do NOT preventDefault — the terminal's bracketed paste handles text normally.
    // If an image is found, we append [image-N] after the text paste completes.
    if (isFocused && evt.ctrl && evt.name === "v") {
      if (imageLoadingRef.current) return;
      imageLoadingRef.current = true;

      readClipboardImageAsync()
        .then(async (clipImg) => {
          imageLoadingRef.current = false;
          if (!clipImg) return;
          const ta = textareaRef.current;
          if (!ta) return;
          // Compress large images to stay under API size limits (5 MB base64)
          const { data, mediaType } = await compressImageForApi(clipImg.data, clipImg.mediaType);
          const idx = ++imageCounter.current;
          const label = `image-${String(idx)}`;
          pendingImages.current.push({
            label,
            base64: data.toString("base64"),
            mediaType,
          });
          ta.insertText(`[${label}] `);
          syncImageExtmarks(ta);
        })
        .catch(() => {
          imageLoadingRef.current = false;
        });
      return;
    }

    if (hasMatchesForNav) {
      if (evt.name === "down") {
        setSelectedIdx((prev) => (prev + 1) % matches.length);
        evt.preventDefault();
        return;
      }
      if (evt.name === "up") {
        setSelectedIdx((prev) => (prev > 0 ? prev - 1 : matches.length - 1));
        evt.preventDefault();
        return;
      }
      if ((evt.name === "tab" || evt.name === "right") && ghost) {
        acceptCompletion();
        evt.preventDefault();
        return;
      }
    }

    // Tab cycles tabs when not consumed by autocomplete (skip when popup is open)
    if (evt.name === "tab" && onCycleTab && isFocused) {
      onCycleTab(evt.shift ? -1 : 1);
      evt.preventDefault();
      return;
    }

    if (focused) {
      if (evt.ctrl && evt.name === "r") {
        setFuzzyMode((prev) => !prev);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
    }

    if (fuzzyMode) {
      if (evt.name === "escape") {
        setFuzzyMode(false);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
      if (evt.name === "return") {
        const selected = fuzzyResults[fuzzyCursor];
        if (selected) {
          isNavigatingHistory.current = true;
          setValue(selected.entry);
          pendingCursorEnd.current = true;
          lineCountRef.current = (selected.entry.match(/\n/g)?.length ?? 0) + 1;
          cursorLineRef.current = 0;
        }
        setFuzzyMode(false);
        setFuzzyQuery("");
        evt.preventDefault();
        return;
      }
      if (evt.name === "up") {
        setFuzzyCursor((prev) => (prev > 0 ? prev - 1 : Math.max(0, fuzzyResults.length - 1)));
        evt.preventDefault();
        return;
      }
      if (evt.name === "down") {
        setFuzzyCursor((prev) => (prev + 1) % Math.max(1, fuzzyResults.length));
        evt.preventDefault();
        return;
      }
      if (evt.name === "backspace" || evt.name === "delete") {
        setFuzzyQuery((prev) => prev.slice(0, -1));
        evt.preventDefault();
        return;
      }
      if (evt.ctrl || evt.meta || evt.name === "tab") return;
      if (evt.name === "space") {
        setFuzzyQuery((prev) => `${prev} `);
        evt.preventDefault();
        return;
      }
      if (evt.name && evt.name.length === 1) {
        setFuzzyQuery((prev) => prev + evt.name);
        evt.preventDefault();
        return;
      }
      return;
    }

    if (focused && evt.ctrl && evt.name === "c") {
      if (valueRef.current.length > 0) {
        resetInput();
      } else {
        onExit?.();
      }
      evt.preventDefault();
      return;
    }

    // Alt+S — stash current draft and clear the input. Drafts survive
    // session restart, are scoped per-cwd, and pop back via Alt+P. Ctrl+S
    // is reserved for the skills browser and Ctrl+P for the session picker.
    if (focused && evt.option && !evt.shift && evt.name === "s") {
      const draft = valueRef.current;
      if (draft.trim().length > 0) {
        try {
          getStashDB().push(draft, cwd);
        } catch {}
        resetInput();
      }
      evt.preventDefault();
      return;
    }

    // Alt+P — pop the most recent stash entry into the input.
    if (focused && evt.option && !evt.shift && evt.name === "p") {
      if (valueRef.current.trim().length === 0) {
        try {
          const entry = getStashDB().pop(cwd);
          if (entry) {
            isNavigatingHistory.current = true;
            setValue(entry.content);
            textareaRef.current?.setText(entry.content);
            textareaRef.current?.gotoBufferEnd();
            lineCountRef.current = (entry.content.match(/\n/g)?.length ?? 0) + 1;
          }
        } catch {}
      }
      evt.preventDefault();
      return;
    }

    // The textarea's onSubmit prop is NOT updated by the React reconciler (TextareaRenderable
    // isn't wired in setProperty), so we handle submit here instead.
    if (focused && evt.name === "return" && !evt.shift && !evt.ctrl && !evt.meta) {
      handleSubmit(valueRef.current);
      evt.preventDefault();
      return;
    }

    if (!focused || hasMatchesForNav || fuzzyMode) return;

    // Up arrow — history: only when cursor is on the first visual row (works for both normal + history)
    if (evt.name === "up" && preKeyVisualRow.current === 0) {
      const history = historyCacheRef.current;
      if (history.length === 0) return;
      if (historyIdx.current === -1) {
        historyStash.current = valueRef.current;
        historyIdx.current = 0;
      } else if (historyIdx.current < history.length - 1) {
        historyIdx.current += 1;
      } else {
        // Already at oldest entry — nothing to do
        evt.preventDefault();
        return;
      }
      const entry = history[historyIdx.current];
      if (entry != null) {
        isNavigatingHistory.current = true;
        setValue(entry);
        textareaRef.current?.setText(entry);
        textareaRef.current?.gotoBufferEnd();
        lineCountRef.current = (entry.match(/\n/g)?.length ?? 0) + 1;
      }
      evt.preventDefault();
      return;
    }

    // Down arrow — history: only when cursor is on the last visual row
    const totalVisualRows = calcVisualLines(valueRef.current);
    if (evt.name === "down" && preKeyVisualRow.current >= totalVisualRows - 1) {
      if (historyIdx.current === -1) return;
      isNavigatingHistory.current = true;
      if (historyIdx.current === 0) {
        historyIdx.current = -1;
        const stashed = historyStash.current;
        setValue(stashed);
        textareaRef.current?.setText(stashed);
        textareaRef.current?.gotoBufferEnd();
        lineCountRef.current = (stashed.match(/\n/g)?.length ?? 0) + 1;
      } else {
        historyIdx.current -= 1;
        const entry = historyCacheRef.current[historyIdx.current];
        if (entry != null) {
          setValue(entry);
          textareaRef.current?.setText(entry);
          textareaRef.current?.gotoBufferEnd();
          lineCountRef.current = (entry.match(/\n/g)?.length ?? 0) + 1;
        }
      }
      evt.preventDefault();
      return;
    }

    // Snapshot document-absolute visual row for next keypress gating
    preKeyVisualRow.current =
      (textareaRef.current?.visualCursor?.visualRow ?? 0) + (textareaRef.current?.scrollY ?? 0);
  });

  const fuzzyMaxVisible = Math.min(8, Math.max(3, Math.floor(termRows * 0.2)));

  const dropdownVisible = hasMatches || (fuzzyMode && fuzzyResults.length > 0);
  useEffect(() => {
    onDropdownChange?.(dropdownVisible);
    return () => onDropdownChange?.(false);
  }, [dropdownVisible, onDropdownChange]);

  useEffect(() => {
    if (!fuzzyMode || fuzzyResults.length === 0) return;
    const offset = fuzzyScrollOffset.current;
    if (fuzzyCursor < offset) {
      fuzzyScrollOffset.current = fuzzyCursor;
      fuzzyScrollRef.current?.scrollTo(fuzzyCursor);
    } else if (fuzzyCursor >= offset + fuzzyMaxVisible) {
      const newOffset = fuzzyCursor - fuzzyMaxVisible + 1;
      fuzzyScrollOffset.current = newOffset;
      fuzzyScrollRef.current?.scrollTo(newOffset);
    }
  }, [fuzzyCursor, fuzzyMode, fuzzyResults.length, fuzzyMaxVisible]);

  // Max rows for the textarea before it scrolls internally
  const maxInputRows = Math.max(4, Math.floor(termRows * 0.4));

  const t = useTheme();

  // Border color per state
  const slashMode = value.startsWith("/") && focused;
  const borderColor = fuzzyMode
    ? t.warning
    : slashMode
      ? t.borderSlash
      : showBusy
        ? t.brandDim
        : focused
          ? t.borderFocused
          : t.border;

  const lines = value.split("\n");
  const isMultiline = lines.length > 1;

  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <box flexDirection="column" width="100%" flexShrink={0}>
        {/* ── Autocomplete dropdown (floating overlay) ── */}
        {hasMatches && (
          <box position="absolute" bottom="100%" width="100%" zIndex={10}>
            <box
              flexDirection="column"
              borderStyle="rounded"
              border={true}
              borderColor={t.borderSlash}
              width="100%"
            >
              <box flexDirection="column" backgroundColor={t.bgInput}>
                <scrollbox
                  ref={acScrollRef}
                  height={Math.min(matches.length, maxVisible)}
                  scrollAcceleration={compactScrollAccel}
                >
                  {matches.map((match, i) => {
                    const isSelected = i === selectedIdx;
                    return (
                      <box key={match.cmd} gap={1} paddingX={1} height={1} flexDirection="row">
                        <text fg={isSelected ? t.borderSlash : t.textFaint}>
                          {isSelected ? "›" : " "}
                        </text>
                        <text
                          fg={isSelected ? t.info : t.borderSlash}
                          attributes={isSelected ? TextAttributes.BOLD : undefined}
                        >
                          {match.cmd}
                        </text>
                        <text fg={isSelected ? t.textSecondary : t.textDim} truncate>
                          {match.desc}
                        </text>
                      </box>
                    );
                  })}
                </scrollbox>
                {matches.length > maxVisible && (
                  <box paddingX={1} height={1}>
                    <text fg={t.textDim}>
                      {selectedIdx + 1}/{String(matches.length)}
                    </text>
                  </box>
                )}
              </box>
            </box>
          </box>
        )}

        {/* ── Fuzzy history results (floating overlay) ── */}
        {fuzzyMode && fuzzyResults.length > 0 && (
          <box position="absolute" bottom="100%" width="100%" zIndex={10}>
            <box
              flexDirection="column"
              borderStyle="rounded"
              border={true}
              borderColor={t.warning}
              width="100%"
            >
              <box flexDirection="column" backgroundColor={t.bgSecondary}>
                <box paddingX={1} height={1} flexDirection="row">
                  <text fg={t.warning} attributes={TextAttributes.BOLD}>
                    {icon("clock_alt")} history
                  </text>
                  <text fg={t.textMuted}>
                    {"  "}
                    {String(fuzzyResults.length)} match{fuzzyResults.length === 1 ? "" : "es"}
                  </text>
                </box>
                <scrollbox
                  ref={fuzzyScrollRef}
                  height={Math.min(fuzzyResults.length, fuzzyMaxVisible)}
                  scrollAcceleration={compactScrollAccel}
                >
                  {fuzzyResults.map((result, i) => {
                    const isSelected = i === fuzzyCursor;
                    const maxChars = Math.max(20, termWidth - 8);
                    const displayText = (result.entry.split("\n")[0] ?? "").slice(0, maxChars);
                    const displayMatch = fuzzyQuery
                      ? fuzzyFilter(fuzzyQuery, [displayText], 1)[0]
                      : null;
                    return (
                      <box
                        key={`${result.entry.slice(0, 40)}-${String(i)}`}
                        paddingX={1}
                        height={1}
                        flexDirection="row"
                      >
                        <text fg={isSelected ? t.brandSecondary : t.textFaint}>
                          {isSelected ? "› " : "  "}
                        </text>
                        {displayMatch ? (
                          <HighlightedText text={displayText} indices={displayMatch.indices} />
                        ) : (
                          <text fg={isSelected ? "white" : t.textPrimary} truncate>
                            {displayText}
                          </text>
                        )}
                      </box>
                    );
                  })}
                </scrollbox>
              </box>
            </box>
          </box>
        )}

        {/* ── Bordered input area ── */}
        <box
          ref={containerRef}
          flexDirection="column"
          width="100%"
          borderStyle="rounded"
          border={true}
          borderColor={borderColor}
          paddingX={1}
        >
          {fuzzyMode ? (
            <box flexDirection="row">
              <text fg={t.warning} attributes={TextAttributes.BOLD}>
                {"search: "}
              </text>
              <text fg={t.textPrimary}>{fuzzyQuery}</text>
              <text fg={t.warning}>▌</text>
            </box>
          ) : (
            <box flexDirection="row" width="100%">
              <text fg={t.brandSecondary} attributes={TextAttributes.BOLD} flexShrink={0}>
                {">"}{" "}
              </text>
              <textarea
                ref={textareaRef}
                initialValue={value}
                onContentChange={handleContentChange}
                onCursorChange={handleCursorChange}
                keyBindings={INPUT_KEY_BINDINGS}
                placeholder={
                  viewingCheckpoint != null
                    ? `${icon("rewind")} send a message to rewind to checkpoint #${String(viewingCheckpoint)}`
                    : showBusy && !showAutocomplete
                      ? "'/' for commands · or steer by sending a new message"
                      : lockIn
                        ? "speak to the forge... · /lock-in to see full narration"
                        : tip.hint
                          ? `${tip.text} · ${tip.hint}`
                          : tip.text
                }
                placeholderColor={viewingCheckpoint != null ? t.warning : t.textMuted}
                focused={focused}
                wrapMode="char"
                width={textareaWidth}
                height={Math.min(maxInputRows, Math.max(1, visualLines))}
                flexShrink={0}
                backgroundColor="transparent"
                textColor={t.textPrimary}
              />
              {showBusy && !showAutocomplete ? (
                <text fg={t.error} attributes={TextAttributes.BOLD} flexShrink={0}>
                  {" ^X stop"}
                </text>
              ) : ghost ? (
                <text fg={t.textDim} flexShrink={0}>
                  {ghost}
                </text>
              ) : null}
            </box>
          )}
        </box>

        {/* ── Hints bar ── */}
        {focused && !fuzzyMode && isMultiline && (
          <box paddingX={2} height={1}>
            <text fg={t.textFaint}>
              <span fg={t.textDim}>S-⏎</span> newline <span fg={t.textDim}>^U</span> del line
            </text>
          </box>
        )}
      </box>
    </box>
  );
});
