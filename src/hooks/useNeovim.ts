import { useCallback, useEffect, useRef, useState } from "react";
import { setNvimInstance } from "../core/editor/instance.js";
import { getEditorDimensions } from "../core/editor/layout.js";
import {
  launchNeovim,
  type NvimInstance,
  openFile as nvimOpenFile,
  shutdownNeovim,
} from "../core/editor/neovim.js";
import { onFileEdited } from "../core/tools/file-events.js";
import type { NvimConfigMode } from "../types/index.js";

export interface UseNeovimReturn {
  ready: boolean;
  ptyWrite: (data: string) => void;
  ptyOnData: (cb: (data: Uint8Array) => void) => () => void;
  ptyResize: (cols: number, rows: number) => void;
  nvimCols: number;
  nvimRows: number;
  modeName: string;
  fileName: string | null;
  cursorLine: number;
  cursorCol: number;
  visualSelection: string | null;
  clearSelection: () => void;
  openFile: (path: string) => Promise<void>;
  sendKeys: (keys: string) => Promise<void>;
  sendMouse: (button: string, action: string, row: number, col: number) => Promise<void>;
  error: string | null;
}

const noop = () => {};
const noopUnsub = () => noop;

/** Map nvim_get_mode short codes to the full names used by mode_change redraw events. */
function mapNvimMode(raw: string): string {
  switch (raw) {
    case "n":
      return "normal";
    case "i":
      return "insert";
    case "v":
      return "visual";
    case "V":
      return "visual line";
    case "\x16":
      return "visual block"; // Ctrl-V
    case "c":
      return "cmdline_normal";
    case "R":
      return "replace";
    case "r":
      return "replace";
    case "t":
      return "terminal";
    case "s":
      return "visual"; // select mode → treat as visual
    case "S":
      return "visual line";
    default:
      return raw;
  }
}

export function useNeovim(
  active: boolean,
  nvimPath?: string,
  nvimConfig?: NvimConfigMode,
  onExit?: () => void,
  hasTabBar = true,
  splitPct = 60,
  termWidth = 120,
  termHeight = 40,
): UseNeovimReturn {
  const nvimRef = useRef<NvimInstance | null>(null);
  const mountedRef = useRef(true);
  const launchingRef = useRef(false);
  const closeHandlerRef = useRef<(() => void) | null>(null);

  const [ready, setReady] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [modeName, setModeName] = useState("normal");
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(0);
  const [visualSelection, setVisualSelection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launchGeneration, setLaunchGeneration] = useState(0);
  const [nvimDims, setNvimDims] = useState({ cols: 80, rows: 24 });

  // Stable ref for onExit so it doesn't re-trigger the launch effect
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // PTY function refs — updated when nvim launches
  const ptyWriteRef = useRef<(data: string) => void>(noop);
  const ptyOnDataRef = useRef<(cb: (data: Uint8Array) => void) => () => void>(noopUnsub);
  const ptyResizeRef = useRef<(cols: number, rows: number) => void>(noop);

  // Launch neovim on first active=true (launchGeneration triggers re-launch after close)
  useEffect(() => {
    void launchGeneration;
    if (!active || nvimRef.current || launchingRef.current) return;

    launchingRef.current = true;

    if (!nvimPath) {
      setError("neovim-not-found");
      launchingRef.current = false;
      return;
    }

    const dims = getEditorDimensions(termWidth, termHeight, hasTabBar, splitPct);

    launchNeovim(nvimPath ?? "nvim", dims.cols, dims.rows, nvimConfig)
      .then((nvim) => {
        if (!mountedRef.current) {
          shutdownNeovim(nvim).catch(() => {});
          return;
        }
        nvimRef.current = nvim;
        setNvimInstance(nvim);

        // Expose PTY functions
        ptyWriteRef.current = nvim.pty.write;
        ptyOnDataRef.current = nvim.pty.onData;
        ptyResizeRef.current = nvim.pty.resize;
        setNvimDims({ cols: dims.cols, rows: dims.rows });

        setReady(true);
        setError(null);

        // Detect when neovim exits (user runs :q, :qa, etc.)
        const handleClose = () => {
          nvimRef.current = null;
          setNvimInstance(null);
          ptyWriteRef.current = noop;
          ptyOnDataRef.current = noopUnsub;
          ptyResizeRef.current = noop;
          if (!mountedRef.current) return;
          setReady(false);
          setLaunchGeneration((g) => g + 1);
          onExitRef.current?.();
        };
        closeHandlerRef.current = handleClose;
        nvim.pty.proc.exited.then(handleClose);
      })
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        launchingRef.current = false;
      });
  }, [active, nvimPath, nvimConfig, hasTabBar, splitPct, launchGeneration, termWidth, termHeight]);

  // Keep the nvim PTY sized to the editor pane. termWidth/termHeight come from
  // useTerminalDimensions(), which OpenTUI updates from its own (debounced)
  // resize pipeline — so this fires once per settled resize with authoritative
  // dimensions, never racing the renderer.
  useEffect(() => {
    if (!ready || !active) return;
    const nvim = nvimRef.current;
    if (!nvim || !mountedRef.current) return;
    const d = getEditorDimensions(termWidth, termHeight, hasTabBar, splitPct);
    nvim.pty.resize(d.cols, d.rows);
    setNvimDims({ cols: d.cols, rows: d.rows });
  }, [ready, active, hasTabBar, splitPct, termWidth, termHeight]);

  // Poll buffer name, cursor position, and visual selection when ready
  useEffect(() => {
    if (!ready || !active) return;

    const poll = () => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;

      // Single RPC call to get all editor state — avoids 4 separate round-trips
      // that would serialize on neovim's single thread and compete with PTY I/O.
      nvim.api
        .executeLua(
          `
          local r = {}
        r.name = vim.api.nvim_buf_get_name(0)
          local pos = vim.api.nvim_win_get_cursor(0)
          r.line = pos[1]
          r.col = pos[2]
          r.mode = vim.api.nvim_get_mode().mode
          local m = vim.fn.mode()
          if m == 'v' or m == 'V' or m == '\\22' then
            local vs = vim.fn.getpos('v')
          local ve = vim.fn.getpos('.')
          local sr, sc = vs[2], vs[3]
            local er, ec = ve[2], ve[3]
            if sr > er or (sr == er and sc > ec) then
              sr, sc, er, ec = er, ec, sr, sc
            end
            local lines = vim.api.nvim_buf_get_lines(0, sr - 1, er, false)
          if #lines > 0 then
            if m == 'V' then
              r.sel = table.concat(lines, '\\n')
            elseif #lines == 1 then
              r.sel = lines[1]:sub(sc, ec)
            else
              lines[1] = lines[1]:sub(sc)
              lines[#lines] = lines[#lines]:sub(1, ec)
              r.sel = table.concat(lines, '\\n')
            end
          end
        end
        return r
        `,
          [],
        )
        .then((result: unknown) => {
          if (!mountedRef.current) return;
          const r = result as {
            name?: string;
            line?: number;
            col?: number;
            mode?: string;
            sel?: string;
          };
          if (r.name) {
            const name = r.name;
            setFileName((prev) => (prev === name ? prev : name));
          }
          if (r.line != null) {
            const line = r.line;
            setCursorLine((prev) => (prev === line ? prev : line));
          }
          if (r.col != null) {
            const col = r.col;
            setCursorCol((prev) => (prev === col ? prev : col));
          }
          setVisualSelection((prev) => {
            if (r.sel) return r.sel;
            return prev;
          });
          if (typeof r.mode === "string") {
            const mapped = mapNvimMode(r.mode);
            setModeName((prev) => (prev === mapped ? prev : mapped));
          }
        })
        .catch(() => {});
    };

    poll();
    const interval = setInterval(poll, 500);
    return () => clearInterval(interval);
  }, [ready, active]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const nvim = nvimRef.current;
      if (nvim) {
        setNvimInstance(null);
        shutdownNeovim(nvim).catch(() => {});
        nvimRef.current = null;
      }
    };
  }, []);

  // Auto-reload buffers when AI edits files
  useEffect(() => {
    if (!ready || !active) return;
    return onFileEdited(() => {
      const nvim = nvimRef.current;
      if (nvim) nvim.api.command("checktime").catch(() => {});
    });
  }, [ready, active]);

  const openFile = useCallback(async (path: string) => {
    const nvim = nvimRef.current;
    if (!nvim || !mountedRef.current) return;
    try {
      await nvimOpenFile(nvim, path);
      if (mountedRef.current) {
        setFileName(path);
      }
    } catch (err: unknown) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const sendKeys = useCallback(async (keys: string) => {
    const nvim = nvimRef.current;
    if (!nvim || !mountedRef.current) return;
    try {
      await nvim.api.input(keys);
    } catch {}
  }, []);

  const clearSelection = useCallback(() => {
    setVisualSelection(null);
  }, []);

  const sendMouse = useCallback(
    async (button: string, action: string, row: number, col: number) => {
      const nvim = nvimRef.current;
      if (!nvim || !mountedRef.current) return;
      try {
        await nvim.api.request("nvim_input_mouse", [button, action, "", 0, row, col]);
      } catch {}
    },
    [],
  );

  return {
    ready,
    ptyWrite: ptyWriteRef.current,
    ptyOnData: ptyOnDataRef.current,
    ptyResize: ptyResizeRef.current,
    nvimCols: nvimDims.cols,
    nvimRows: nvimDims.rows,
    modeName,
    fileName,
    cursorLine,
    cursorCol,
    visualSelection,
    clearSelection,
    openFile,
    sendKeys,
    sendMouse,
    error,
  };
}
