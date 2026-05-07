import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { CommandPickerConfig } from "../components/modals/CommandPicker.js";
import type { InfoPopupConfig } from "../components/modals/InfoPopup.js";
import type { ChatStyle, TaskRouter } from "../types/index.js";

export type ModalName =
  | "llmSelector"
  | "skillSearch"
  | "gitCommit"
  | "sessionPicker"
  | "helpPopup"
  | "errorLog"
  | "gitMenu"
  | "editorSettings"
  | "routerSettings"
  | "providerSettings"
  | "commandPicker"
  | "commandPalette"
  | "infoPopup"
  | "repoMapStatus"
  | "setup"
  | "webSearchSettings"
  | "apiKeySettings"
  | "lspStatus"
  | "lspInstall"
  | "compactionLog"
  | "diagnosePopup"
  | "statusDashboard"
  | "toolsPopup"
  | "firstRunWizard"
  | "floatingTerminal"
  | "updateModal"
  | "mcpSettings"
  | "hearthSettings"
  | "tabNamePopup"
  | "uiDemo";

type Modals = Record<ModalName, boolean>;

const INITIAL_MODALS: Modals = {
  llmSelector: false,
  skillSearch: false,
  gitCommit: false,
  sessionPicker: false,
  helpPopup: false,
  errorLog: false,
  gitMenu: false,
  editorSettings: false,
  routerSettings: false,
  providerSettings: false,
  commandPicker: false,
  commandPalette: false,
  infoPopup: false,
  repoMapStatus: false,
  setup: false,
  webSearchSettings: false,
  apiKeySettings: false,
  lspStatus: false,
  lspInstall: false,
  compactionLog: false,
  diagnosePopup: false,
  statusDashboard: false,
  toolsPopup: false,
  firstRunWizard: false,
  floatingTerminal: false,
  updateModal: false,
  mcpSettings: false,
  hearthSettings: false,
  tabNamePopup: false,
  uiDemo: false,
};

interface UIState {
  modals: Modals;
  routerSlotPicking: keyof TaskRouter | null;
  commandPickerConfig: CommandPickerConfig | null;
  infoPopupConfig: InfoPopupConfig | null;
  statusDashboardTab: "Context" | "System" | "Dispatch";

  codeExpanded: Record<string, boolean>;
  changesExpanded: boolean;
  terminalsExpanded: boolean;
  chatStyle: ChatStyle;
  showReasoning: boolean;
  reasoningExpanded: Record<string, boolean>;
  suspended: boolean;
  editorSplit: number;
  lockIn: boolean;

  openModal: (name: ModalName) => void;
  closeModal: (name: ModalName) => void;
  toggleModal: (name: ModalName) => void;

  setRouterSlotPicking: (slot: keyof TaskRouter | null) => void;

  openCommandPicker: (config: CommandPickerConfig) => void;
  updatePickerOptions: (options: CommandPickerConfig["options"], currentValue?: string) => void;
  openInfoPopup: (config: InfoPopupConfig) => void;
  closeInfoPopup: () => void;

  toggleCodeExpanded: (tabId: string) => void;
  setCodeExpanded: (tabId: string, v: boolean) => void;
  toggleChangesExpanded: () => void;
  setChangesExpanded: (v: boolean) => void;
  toggleTerminalsExpanded: () => void;
  setTerminalsExpanded: (v: boolean) => void;
  setChatStyle: (style: ChatStyle) => void;
  setShowReasoning: (v: boolean) => void;
  toggleShowReasoning: () => void;
  toggleReasoningExpanded: (tabId: string) => void;
  toggleAllExpanded: (tabId: string) => void;
  setSuspended: (v: boolean) => void;
  cycleEditorSplit: () => void;
  setLockIn: (v: boolean) => void;
  toggleLockIn: () => void;
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set) => ({
    modals: { ...INITIAL_MODALS },
    routerSlotPicking: null,
    commandPickerConfig: null,
    infoPopupConfig: null,
    statusDashboardTab: "Context" as const as "Context" | "System" | "Dispatch",

    codeExpanded: {},
    changesExpanded: false,
    terminalsExpanded: false,
    chatStyle: "accent",
    showReasoning: true,
    reasoningExpanded: {},
    suspended: false,
    editorSplit: 60,
    lockIn: true,

    openModal: (name) => set(() => ({ modals: { ...INITIAL_MODALS, [name]: true } })),
    closeModal: (name) => set((s) => ({ modals: { ...s.modals, [name]: false } })),
    toggleModal: (name) =>
      set((s) => ({
        modals: s.modals[name]
          ? { ...s.modals, [name]: false }
          : { ...INITIAL_MODALS, [name]: true },
      })),

    setRouterSlotPicking: (slot) => set({ routerSlotPicking: slot }),

    openCommandPicker: (config) =>
      set(() => ({
        commandPickerConfig: config,
        modals: { ...INITIAL_MODALS, commandPicker: true },
      })),
    updatePickerOptions: (options, currentValue) =>
      set((s) => ({
        commandPickerConfig: s.commandPickerConfig
          ? {
              ...s.commandPickerConfig,
              options,
              ...(currentValue !== undefined && { currentValue }),
            }
          : null,
      })),
    openInfoPopup: (config) =>
      set((s) => ({
        infoPopupConfig: config,
        modals: { ...s.modals, infoPopup: true },
      })),
    closeInfoPopup: () =>
      set((s) => ({
        infoPopupConfig: null,
        modals: { ...s.modals, infoPopup: false },
      })),

    toggleCodeExpanded: (tabId) =>
      set((s) => ({ codeExpanded: { ...s.codeExpanded, [tabId]: !s.codeExpanded[tabId] } })),
    setCodeExpanded: (tabId, v) =>
      set((s) => ({ codeExpanded: { ...s.codeExpanded, [tabId]: v } })),
    toggleChangesExpanded: () => set((s) => ({ changesExpanded: !s.changesExpanded })),
    setChangesExpanded: (v) => set({ changesExpanded: v }),
    toggleTerminalsExpanded: () => set((s) => ({ terminalsExpanded: !s.terminalsExpanded })),
    setTerminalsExpanded: (v) => set({ terminalsExpanded: v }),
    setChatStyle: (style) => set({ chatStyle: style }),
    setShowReasoning: (v) => set({ showReasoning: v }),
    toggleShowReasoning: () => set((s) => ({ showReasoning: !s.showReasoning })),
    toggleReasoningExpanded: (tabId) =>
      set((s) => ({
        reasoningExpanded: { ...s.reasoningExpanded, [tabId]: !s.reasoningExpanded[tabId] },
      })),
    toggleAllExpanded: (tabId) =>
      set((s) => {
        const anyExpanded = !!s.codeExpanded[tabId] || !!s.reasoningExpanded[tabId];
        return {
          codeExpanded: { ...s.codeExpanded, [tabId]: !anyExpanded },
          reasoningExpanded: { ...s.reasoningExpanded, [tabId]: !anyExpanded },
        };
      }),
    setSuspended: (v) => set({ suspended: v }),
    setLockIn: (v) => set({ lockIn: v }),
    toggleLockIn: () => set((s) => ({ lockIn: !s.lockIn })),
    cycleEditorSplit: () =>
      set((s) => {
        const splits = [40, 50, 60, 70];
        const idx = splits.indexOf(s.editorSplit);
        return { editorSplit: splits[(idx + 1) % splits.length] ?? 60 };
      }),
  })),
);

export const selectIsAnyModalOpen = (s: UIState): boolean => Object.values(s.modals).some(Boolean);

export function resetUIStore(): void {
  useUIStore.setState({
    modals: { ...INITIAL_MODALS },
    routerSlotPicking: null,
    commandPickerConfig: null,
    infoPopupConfig: null,
    statusDashboardTab: "Context",
    codeExpanded: {},
    changesExpanded: false,
    terminalsExpanded: false,
    chatStyle: "accent",
    showReasoning: true,
    reasoningExpanded: {},
    suspended: false,
    lockIn: true,
  });
}
