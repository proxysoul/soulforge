interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspHover {
  contents: LspMarkupContent | string | Array<string | LspMarkedString>;
  range?: LspRange;
}

export interface LspMarkupContent {
  kind: string;
  value: string;
}

interface LspMarkedString {
  language: string;
  value: string;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: LspTextDocumentEdit[];
}

export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
}

/** LSP File Rename (workspace/willRenameFiles) */
export interface LspFileRename {
  oldUri: string;
  newUri: string;
}

/** LSP Code Action */
export interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  isPreferred?: boolean;
  edit?: LspWorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
}

/** LSP Call Hierarchy Item */
export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

/** LSP Type Hierarchy Item */
export interface LspTypeHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function encode(method: string, params: unknown, id?: number): Buffer {
  const msg: JsonRpcRequest | JsonRpcNotification =
    id !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params };
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header), Buffer.from(body)]);
}

export function decode(buffer: Buffer): { messages: JsonRpcMessage[]; remainder: Buffer } {
  const messages: JsonRpcMessage[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    // Find header end
    const headerEnd = buffer.indexOf("\r\n\r\n", offset);
    if (headerEnd === -1) break;

    // Parse Content-Length from header
    const headerStr = buffer.subarray(offset, headerEnd).toString();
    const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
    if (!match?.[1]) break;

    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (bodyEnd > buffer.length) break; // Incomplete message

    const body = buffer.subarray(bodyStart, bodyEnd).toString();
    try {
      messages.push(JSON.parse(body) as JsonRpcMessage);
    } catch {
      // Skip malformed messages
    }

    offset = bodyEnd;
  }

  return { messages, remainder: buffer.subarray(offset) };
}

import { windowsPath } from "../../../platform/index.js";
import type { SymbolKind } from "../../types.js";

const LSP_SYMBOL_KIND_MAP: Record<number, SymbolKind> = {
  1: "module", // File
  2: "module", // Module
  3: "namespace", // Namespace
  5: "class", // Class
  6: "method", // Method
  8: "property", // Field
  9: "function", // Constructor
  10: "enum", // Enum
  11: "interface", // Interface
  12: "function", // Function
  13: "variable", // Variable
  14: "constant", // Constant
  23: "type", // Struct
  26: "type", // TypeParameter
};

export function lspSymbolKindToSymbolKind(kind: number): SymbolKind {
  return LSP_SYMBOL_KIND_MAP[kind] ?? "unknown";
}

const LSP_SEVERITY_MAP: Record<number, "error" | "warning" | "info" | "hint"> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function lspSeverityToSeverity(
  severity: number | undefined,
): "error" | "warning" | "info" | "hint" {
  if (severity !== undefined && LSP_SEVERITY_MAP[severity]) {
    return LSP_SEVERITY_MAP[severity];
  }
  return "info";
}

// Characters valid in file URI path segments per RFC 3986 pchar.
// encodeURIComponent is too aggressive — avoid it for file URIs.
const FILE_URI_SAFE_RE = /[^A-Za-z0-9\-._~!$&'()*+,;=:@]/g;
function encodePathSegment(seg: string): string {
  return seg.replace(FILE_URI_SAFE_RE, (c) => {
    const code = c.charCodeAt(0);
    return `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

export function filePathToUri(path: string): string {
  // Normalise unix-flavoured drive prefixes (`/c/Users/...`, `/cygdrive/c/...`,
  // `/mnt/c/...`) emitted by Git Bash / Cygwin / WSL git.exe back to native
  // `C:/Users/...`, then fold `\` → `/` so file:// segments don't carry %5C
  // escapes from native Windows paths. No-op on POSIX.
  const native = windowsPath(path).replaceAll("\\", "/");
  const encoded = native.split("/").map(encodePathSegment).join("/");
  return `file://${encoded}`;
}

export function uriToFilePath(uri: string): string {
  if (uri.startsWith("file://")) {
    return windowsPath(decodeURIComponent(uri.slice(7)));
  }
  return windowsPath(uri);
}
