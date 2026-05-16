import { useKeyboard } from "@opentui/react";
import { useTheme } from "../../../core/theme/index.js";
import type { ThemeTokens } from "../../../core/theme/tokens.js";
import { PremiumPopup } from "../PremiumPopup.js";

interface Props {
  width: number;
  title: string;
  message: string;
  variant?: "info" | "warning" | "error";
  onClose: () => void;
}

const ICON_BY_VARIANT: Record<NonNullable<Props["variant"]>, string> = {
  info: "info",
  warning: "warning",
  error: "fail",
};

const BORDER_BY_VARIANT: Record<NonNullable<Props["variant"]>, keyof ThemeTokens> = {
  info: "info",
  warning: "warning",
  error: "error",
};

/** Single-button informational dialog. Enter/Esc both close. */
export function AlertDialog({ width, title, message, variant = "info", onClose }: Props) {
  const t = useTheme();

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    // Swallow other keys while the alert is up.
    evt.preventDefault();
  });

  return (
    <PremiumPopup
      visible
      width={Math.max(40, width)}
      height={9}
      title={title}
      titleIcon={ICON_BY_VARIANT[variant]}
      borderColor={t[BORDER_BY_VARIANT[variant]]}
      footerHints={[{ key: "Enter/Esc", label: "close" }]}
    >
      <box paddingX={2} paddingY={1}>
        <text fg={t.textPrimary}>{message}</text>
      </box>
    </PremiumPopup>
  );
}
/**
 * Imperative helper — opens an alert and resolves when the user dismisses.
 * Use for non-blocking notices that still demand acknowledgement.
 */
export function alert(opts: {
  title: string;
  message: string;
  variant?: "info" | "warning" | "error";
}): Promise<void> {
  return new Promise((resolve) => {
    const { useDialogStore } =
      require("../../../stores/dialog.js") as typeof import("../../../stores/dialog.js");
    const store = useDialogStore.getState();
    store.push({
      size: "compact",
      payload: { kind: "alert", ...opts },
      onClose: () => resolve(),
    });
  });
}
