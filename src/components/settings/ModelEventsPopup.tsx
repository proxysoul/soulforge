/**
 * ModelEventsPopup — opt-in debug view for per-call LLM telemetry.
 *
 * Tabs:
 *   - Models   per-model aggregate (calls, avg/last latency, tokens, errors)
 *   - Recent   last N call events (latest first)
 *   - Errors   only error events
 *
 * Disabled by default for performance. Toggle enables recording; the
 * sidecar store (`useModelEventsStore`) is observed by every LLM call
 * site (main loop + subagents) and stays a no-op while off.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import {
  aggregateModelEvents,
  type ModelCallEvent,
  modelErrorEvents,
  useModelEventsStore,
} from "../../stores/model-events.js";
import {
  PremiumPopup,
  Section,
  type SidebarTab,
  Table,
  type TableColumn,
  Toggle,
} from "../ui/index.js";

const BOLD = 1;
const TABS = ["Models", "Recent", "Errors"] as const;
type Tab = (typeof TABS)[number];

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTok(n: number): string {
  if (n <= 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtAge(now: number, at: number): string {
  const d = Math.max(0, now - at);
  if (d < 1000) return "now";
  if (d < 60_000) return `${String(Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `${String(Math.round(d / 60_000))}m`;
  return `${String(Math.round(d / 3_600_000))}h`;
}

function shortModel(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ModelEventsPopup({ visible, onClose }: Props) {
  const t = useTheme();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const popupW = Math.min(110, Math.max(80, Math.floor(termCols * 0.85)));
  const popupH = Math.min(Math.max(20, Math.floor(termRows * 0.82)), termRows - 2);
  const contentW = popupW - 4;

  const enabled = useModelEventsStore((s) => s.enabled);
  const events = useModelEventsStore((s) => s.events);
  const setEnabled = useModelEventsStore((s) => s.setEnabled);
  const clear = useModelEventsStore((s) => s.clear);

  const [tab, setTab] = useState<Tab>("Models");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!visible) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [visible]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape" || evt.name === "q") {
      onClose();
      return;
    }
    if (evt.name === "tab" || evt.name === "right" || evt.name === "l") {
      setTab((cur) => TABS[(TABS.indexOf(cur) + 1) % TABS.length] ?? "Models");
      return;
    }
    if (evt.name === "left" || evt.name === "h") {
      setTab((cur) => TABS[(TABS.indexOf(cur) - 1 + TABS.length) % TABS.length] ?? "Models");
      return;
    }
    if (evt.name === "e") {
      setEnabled(!enabled);
      return;
    }
    if (evt.name === "c") {
      clear();
      return;
    }
  });

  const aggregates = useMemo(() => aggregateModelEvents(events), [events]);
  const errors = useMemo(() => modelErrorEvents(events), [events]);
  const recent = useMemo(() => [...events].reverse().slice(0, 200), [events]);

  if (!visible) return null;

  const sidebarTabs: SidebarTab<Tab>[] = TABS.map((id) => ({
    id,
    label: id,
    icon: id === "Models" ? "model" : id === "Recent" ? "clock" : "error",
    status: id === "Errors" && errors.length > 0 ? "error" : undefined,
  }));

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Model Events"
      titleIcon={icon("info")}
      tabs={sidebarTabs}
      activeTab={tab}
      sidebarWidth={16}
      footerHints={[
        { key: "e", label: enabled ? "Disable" : "Enable" },
        { key: "c", label: "Clear" },
        { key: "tab", label: "Switch tab" },
        { key: "esc", label: "Close" },
      ]}
    >
      <box flexDirection="column" backgroundColor={t.bgPopup} paddingX={2} paddingY={1}>
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          <Toggle
            label="Record model events"
            description={
              enabled
                ? "Capturing per-call latency, tokens, and errors."
                : "Off by default — press 'e' to enable. Clears on disable."
            }
            on={enabled}
          />
          <box flexGrow={1} backgroundColor={t.bgPopup} />
          <text bg={t.bgPopup} fg={t.textFaint}>
            {String(events.length)} events
          </text>
        </box>
      </box>

      {tab === "Models" ? (
        <Section title="Per-model aggregates" bg={t.bgPopup}>
          {aggregates.length === 0 ? (
            <text bg={t.bgPopup} fg={t.textFaint}>
              {enabled ? "No model events recorded yet." : "Enable recording to see model usage."}
            </text>
          ) : (
            <Table
              width={contentW}
              columns={
                [
                  { key: "Model", width: 24, render: (r) => shortModel(r.modelId) },
                  { key: "Calls", width: 7, align: "right", render: (r) => String(r.calls) },
                  {
                    key: "Errors",
                    width: 7,
                    align: "right",
                    render: (r) => (r.errors > 0 ? String(r.errors) : "—"),
                  },
                  { key: "Avg", width: 8, align: "right", render: (r) => fmtMs(r.avgMs) },
                  { key: "Last", width: 8, align: "right", render: (r) => fmtMs(r.lastMs) },
                  { key: "In", width: 8, align: "right", render: (r) => fmtTok(r.input) },
                  { key: "Out", width: 8, align: "right", render: (r) => fmtTok(r.output) },
                  { key: "Cache", width: 8, align: "right", render: (r) => fmtTok(r.cacheRead) },
                ] as TableColumn<(typeof aggregates)[number]>[]
              }
              rows={aggregates}
              maxRows={Math.max(4, popupH - 12)}
            />
          )}
        </Section>
      ) : tab === "Recent" ? (
        <Section title="Recent calls" bg={t.bgPopup}>
          {recent.length === 0 ? (
            <text bg={t.bgPopup} fg={t.textFaint}>
              {enabled ? "No recent calls." : "Enable recording first."}
            </text>
          ) : (
            <Table
              width={contentW}
              columns={
                [
                  { key: "When", width: 6, render: (r) => fmtAge(now, r.startedAt) },
                  { key: "Source", width: 8, render: (r) => r.source },
                  { key: "Model", width: 22, render: (r) => shortModel(r.modelId) },
                  {
                    key: "Status",
                    width: 8,
                    render: (r) => (r.state === "error" ? "error" : "ok"),
                  },
                  { key: "Time", width: 8, align: "right", render: (r) => fmtMs(r.durationMs) },
                  { key: "In", width: 7, align: "right", render: (r) => fmtTok(r.input ?? 0) },
                  { key: "Out", width: 7, align: "right", render: (r) => fmtTok(r.output ?? 0) },
                ] as TableColumn<ModelCallEvent>[]
              }
              rows={recent}
              maxRows={Math.max(4, popupH - 12)}
            />
          )}
        </Section>
      ) : (
        <Section title="Errors" bg={t.bgPopup}>
          {errors.length === 0 ? (
            <text bg={t.bgPopup} fg={t.textFaint}>
              No errors recorded.
            </text>
          ) : (
            <box flexDirection="column" backgroundColor={t.bgPopup}>
              {errors
                .slice(-Math.max(4, popupH - 12))
                .reverse()
                .map((ev) => (
                  <box key={ev.id} flexDirection="column" backgroundColor={t.bgPopup}>
                    <box flexDirection="row" backgroundColor={t.bgPopup}>
                      <text bg={t.bgPopup} fg={t.error} attributes={BOLD}>
                        {shortModel(ev.modelId)}
                      </text>
                      <text bg={t.bgPopup} fg={t.textFaint}>
                        {"  "}
                        {ev.source} · {fmtAge(now, ev.startedAt)} · {fmtMs(ev.durationMs)}
                      </text>
                    </box>
                    <text bg={t.bgPopup} fg={t.textPrimary}>
                      {"  "}
                      {(ev.errorMessage ?? "").slice(0, contentW - 4)}
                    </text>
                  </box>
                ))}
            </box>
          )}
        </Section>
      )}
    </PremiumPopup>
  );
}
