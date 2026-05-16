import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useTheme } from "../../../core/theme/index.js";
import { useDialogStore } from "../../../stores/dialog.js";
import { PremiumPopup } from "../PremiumPopup.js";

interface Props {
  width: number;
  title: string;
  message: string;
  danger?: boolean;
  onClose: () => void;
}

/**
 * Yes/no confirm dialog.
 *
 * The dialog stack itself owns dismissal — this just collects an answer and
 * stores it on the entry's resolved promise (via `useConfirm` helper below).
 * Keep all decisions ephemeral: Enter = confirm, Esc/n = cancel.
 */
export function ConfirmDialog({ width, title, message, danger, onClose }: Props) {
  const t = useTheme();
  const [selection, setSelection] = useState<"yes" | "no">(danger ? "no" : "yes");

  useKeyboard((evt) => {
    if (evt.name === "left" || evt.name === "right" || evt.name === "tab") {
      setSelection((s) => (s === "yes" ? "no" : "yes"));
      evt.preventDefault();
      return;
    }
    if (evt.name === "y") {
      _answer(true);
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "n" || evt.name === "escape") {
      _answer(false);
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      _answer(selection === "yes");
      onClose();
      evt.preventDefault();
      return;
    }
    // Swallow every other key while the confirm owns the screen so the
    // host (SessionPicker, GitMenu, /stash, ...) never sees Enter/letters.
    evt.preventDefault();
  });

  return (
    <PremiumPopup
      visible
      width={Math.max(40, width)}
      height={10}
      title={title}
      titleIcon={danger ? "warning" : "info"}
      borderColor={danger ? t.error : t.brandAlt}
      footerHints={[
        { key: "Y/Enter", label: danger ? "delete" : "confirm" },
        { key: "N/Esc", label: "cancel" },
        { key: "←→", label: "switch" },
      ]}
    >
      <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
        <text fg={t.textPrimary}>{message}</text>
        <box flexDirection="row" gap={2}>
          <text
            fg={selection === "yes" ? (danger ? t.error : t.success) : t.textMuted}
            attributes={selection === "yes" ? 1 : undefined}
          >
            {selection === "yes" ? "▸ " : "  "}
            {danger ? "Yes, delete" : "Yes"}
          </text>
          <text
            fg={selection === "no" ? t.textPrimary : t.textMuted}
            attributes={selection === "no" ? 1 : undefined}
          >
            {selection === "no" ? "▸ " : "  "}
            No
          </text>
        </box>
      </box>
    </PremiumPopup>
  );
}

// ── Answer-capture helper ─────────────────────────────────────────────────
//
// Confirms are async: callers `await confirm(...)`. The dialog writes to a
// module-level slot keyed by the entry id; the helper resolves the promise
// on close. Keeps the dialog stateless about *who* asked.

const PENDING = new Map<string, (yes: boolean) => void>();
let _activeId: string | null = null;

function _answer(yes: boolean): void {
  const id = _activeId;
  if (!id) return;
  const cb = PENDING.get(id);
  if (cb) {
    PENDING.delete(id);
    cb(yes);
  }
}

/**
 * Imperative helper — opens a confirm dialog and resolves with the user's
 * choice. Resolves to `false` on Escape/close-without-decision.
 */
export function confirm(opts: {
  title: string;
  message: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const store = useDialogStore.getState();
    const id = store.push({
      size: "compact",
      payload: { kind: "confirm", ...opts },
      onClose: () => {
        if (PENDING.has(id)) {
          PENDING.delete(id);
          resolve(false);
        }
      },
    });
    _activeId = id;
    PENDING.set(id, (yes) => {
      _activeId = null;
      resolve(yes);
    });
  });
}
