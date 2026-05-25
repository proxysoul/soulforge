import type { InfoPopupLine } from "../../../../components/modals/InfoPopup.js";
import { useUIStore } from "../../../../stores/ui.js";
import { providerIcon } from "../../../icons.js";
import { getThemeTokens } from "../../../theme/index.js";
import { openPath } from "../../../utils/open-path.js";
import { checkProviders } from "../../provider.js";
import {
  type CodexAppServerClient,
  getCodexLoginStatus,
  startCodexAppServerSession,
} from "./client.js";

interface CodexLoginStartResponse {
  type?: string;
  loginId?: string;
  authUrl?: string;
}

interface CodexLoginCompletedNotification {
  loginId?: string | null;
  success?: boolean;
  error?: string | null;
}

export async function performCodexBrowserLogin(
  client: CodexAppServerClient,
  openUrl: (url: string) => boolean | Promise<boolean>,
  onEvent?: (message: string) => void,
): Promise<void> {
  onEvent?.("Starting Codex browser login...");

  const response = (await client.request("account/login/start", {
    type: "chatgpt",
  })) as CodexLoginStartResponse;

  if (response.type !== "chatgpt" || !response.loginId || !response.authUrl) {
    throw new Error("Codex returned an unexpected browser login response");
  }

  onEvent?.("Opening browser for Codex login...");
  const opened = await openUrl(response.authUrl);
  if (opened) {
    onEvent?.("Browser opened. Complete the login in ChatGPT.");
  } else {
    onEvent?.(`Could not open browser automatically. Open this URL manually: ${response.authUrl}`);
  }

  const completed = await client.waitForNotification<CodexLoginCompletedNotification>(
    "account/login/completed",
    (params) => params.loginId === response.loginId,
  );

  if (!completed.success) {
    throw new Error(completed.error ?? "Codex authentication failed.");
  }

  onEvent?.("Codex authentication complete.");
}

function openUrlInBrowser(url: string): boolean {
  return openPath(url);
}

export function runCodexBrowserLogin(onEvent?: (message: string) => void): {
  promise: Promise<void>;
  abort: () => void;
} {
  let session: CodexAppServerClient | null = null;
  let aborted = false;

  const promise = (async () => {
    const status = getCodexLoginStatus();
    if (!status.installed) {
      throw new Error("Codex CLI is not installed. Install Codex first.");
    }
    if (status.loggedIn) {
      onEvent?.("Codex is already logged in.");
      return;
    }

    session = await startCodexAppServerSession();
    if (aborted) {
      session.close();
      throw new Error("Codex login cancelled.");
    }

    try {
      await performCodexBrowserLogin(session, openUrlInBrowser, onEvent);
    } finally {
      session.close();
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
      session?.close();
    },
  };
}

export async function requestCodexAuth(): Promise<void> {
  const theme = getThemeTokens();
  const lines: InfoPopupLine[] = [
    {
      type: "text",
      label: "Starting Codex login...",
      color: theme.textSecondary,
    },
  ];

  let handle: ReturnType<typeof runCodexBrowserLogin> | null = null;
  const updatePopup = () => {
    useUIStore.getState().openInfoPopup({
      title: "Codex Login",
      icon: providerIcon("codex"),
      lines: [...lines],
      onClose: () => handle?.abort(),
    });
  };

  updatePopup();
  handle = runCodexBrowserLogin((message) => {
    lines.push({ type: "text", label: message, color: theme.textPrimary });
    updatePopup();
  });

  try {
    await handle.promise;
    await checkProviders().catch(() => {});
    lines.push({
      type: "text",
      label: "Select a Codex model with Ctrl+L or /models.",
      color: theme.success,
    });
    updatePopup();
    useUIStore.getState().openModal("llmSelector");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push({
      type: "text",
      label: `Error: ${message}`,
      color: theme.brandSecondary,
    });
    updatePopup();
  }
}
