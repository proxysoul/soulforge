/**
 * HelpPopup — keyboard reference + forge modes guide.
 * Thin wrapper around InfoLine (shared primitive).
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import { InfoLine, type InfoLineData, PremiumPopup, Section } from "../ui/index.js";
import { listScrollAccel } from "../ui/scroll.js";

interface Props {
  visible: boolean;
  onClose: () => void;
}

function buildHelpLines(t: ReturnType<typeof useTheme>): InfoLineData[] {
  return [
    { type: "text", label: "Ctrl+K — open command palette (search all commands)" },
    { type: "text", label: "/settings — all settings in one place" },
    { type: "spacer" },
    { type: "separator" },

    { type: "header", label: "Keybindings" },
    { type: "text", label: "General" },
    { type: "entry", label: "Ctrl+X", desc: "stop/abort generation" },
    { type: "entry", label: "Ctrl+C", desc: "copy selection / exit" },
    { type: "entry", label: "Ctrl+D", desc: "cycle forge mode" },
    { type: "entry", label: "Ctrl+K", desc: "command palette" },
    { type: "entry", label: "Ctrl+O", desc: "expand/collapse all (code, reasoning)" },
    { type: "spacer" },
    { type: "text", label: "Panels" },
    { type: "entry", label: "Ctrl+L", desc: "switch LLM model" },
    { type: "entry", label: "Ctrl+S", desc: "browse skills" },
    { type: "entry", label: "Ctrl+P", desc: "browse sessions" },
    { type: "entry", label: "Alt+S", desc: "stash current draft" },
    { type: "entry", label: "Alt+P", desc: "pop last stashed draft" },
    { type: "entry", label: "Alt+R", desc: "error log" },
    { type: "entry", label: "Ctrl+G", desc: "git menu" },
    { type: "spacer" },
    { type: "text", label: "Editor" },
    { type: "entry", label: "Ctrl+E", desc: "open/close editor" },
    { type: "spacer" },
    { type: "text", label: "Tabs" },
    { type: "entry", label: "Ctrl+T", desc: "new tab" },
    { type: "entry", label: "Ctrl+W", desc: "close tab" },
    { type: "entry", label: "Ctrl+1-9", desc: "switch to tab N" },
    { type: "entry", label: "Ctrl+[ / Ctrl+]", desc: "prev / next tab" },
    { type: "spacer" },
    { type: "text", label: "Scroll" },
    { type: "entry", label: "Page Up / Down", desc: "scroll chat" },

    { type: "spacer" },
    { type: "separator" },

    { type: "header", label: "Forge Modes" },
    { type: "text", label: "Switch with /mode <name> or Ctrl+D to cycle." },
    { type: "spacer" },
    {
      type: "entry",
      label: "default",
      desc: "standard assistant — implements directly",
      color: t.textMuted,
    },
    {
      type: "entry",
      label: "architect",
      desc: "design only — outlines, tradeoffs, no code",
      color: t.brand,
    },
    {
      type: "entry",
      label: "socratic",
      desc: "asks probing questions before implementing",
      color: t.warning,
    },
    {
      type: "entry",
      label: "challenge",
      desc: "devil's advocate — challenges every assumption",
      color: t.brandSecondary,
    },
    {
      type: "entry",
      label: "plan",
      desc: "research & plan only — no file edits or shell",
      color: t.info,
    },
  ];
}

export function HelpPopup({ visible, onClose }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const lines = useMemo(() => buildHelpLines(t), [t]);

  useEffect(() => {
    if (visible) {
      setCursor(0);
      scrollRef.current?.scrollTo(0);
    }
  }, [visible]);

  const popupW = Math.min(88, Math.max(64, Math.floor(tw * 0.72)));
  const popupH = Math.min(32, Math.max(18, th - 4));
  const contentW = popupW - 4;
  const viewportRows = Math.max(8, popupH - 9);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    const maxOffset = Math.max(0, lines.length - viewportRows);
    if (evt.name === "up" || evt.name === "k") {
      const n = Math.max(0, cursor - 1);
      setCursor(n);
      scrollRef.current?.scrollTo(n);
      evt.preventDefault();
      return;
    }
    if (evt.name === "down" || evt.name === "j") {
      const n = Math.min(maxOffset, cursor + 1);
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
      const n = Math.min(maxOffset, cursor + viewportRows);
      setCursor(n);
      scrollRef.current?.scrollTo(n);
      evt.preventDefault();
      return;
    }
    // Swallow any other key while the popup owns the screen so chat/input
    // never see arrow/letter keys.
    evt.preventDefault();
  });

  if (!visible) return null;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="SoulForge Help"
      titleIcon="info"
      blurb="Keyboard shortcuts · forge modes"
      footerHints={[
        { key: "↑↓", label: "scroll" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        <scrollbox ref={scrollRef} height={viewportRows} scrollAcceleration={listScrollAccel}>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static list
            <InfoLine key={`h-${i}`} line={line} width={contentW} />
          ))}
        </scrollbox>
      </Section>
    </PremiumPopup>
  );
}
