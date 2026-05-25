/**
 * Cross-platform credential storage.
 *
 * macOS  → `security` keychain (handled in src/core/secrets.ts directly)
 * Linux  → `secret-tool` libsecret (handled in src/core/secrets.ts directly)
 * Win32  → DPAPI-encrypted blob in %APPDATA%\SoulForge\secrets.dat
 *
 * Why DPAPI and not cmdkey?
 *   `cmdkey /add` stores credentials in Windows Credential Manager but
 *   `cmdkey /list` returns metadata only — there is NO supported CLI path to
 *   retrieve the password. Retrieval requires the CredRead Win32 API. Rather
 *   than ship the entire CredRead/CredFree FFI surface for a CLI mirror that
 *   adds no security value, we use DPAPI directly:
 *
 *     CryptProtectData(secret, entropy=null, scope=CRYPTPROTECT_LOCAL_MACHINE=0)
 *
 *   DPAPI keys are derived from the user's Windows login password, scoped to
 *   the user account, and cannot be exfiltrated by other local users. The
 *   ciphertext lives at %APPDATA%\SoulForge\secrets.dat which is already
 *   user-only by NTFS ACL inheritance.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, IS_WIN } from "./index.js";

/** Path to the win32 DPAPI-encrypted secrets file. */
export function windowsSecretsFile(): string {
  return join(configDir(), "secrets.dat");
}

interface DpapiBindings {
  protect: (plaintext: Buffer) => Buffer | null;
  unprotect: (ciphertext: Buffer) => Buffer | null;
}

let _dpapi: DpapiBindings | null | undefined;

/**
 * Lazily load DPAPI bindings via bun:ffi → crypt32.dll.
 * Returns null on non-Windows or if FFI fails (kernel32 missing, etc.).
 *
 * Win32 reference:
 *   BOOL CryptProtectData(
 *     DATA_BLOB *pDataIn, LPCWSTR szDataDescr, DATA_BLOB *pOptionalEntropy,
 *     PVOID pvReserved, CRYPTPROTECT_PROMPTSTRUCT *pPromptStruct,
 *     DWORD dwFlags, DATA_BLOB *pDataOut);
 *
 *   typedef struct _CRYPTOAPI_BLOB { DWORD cbData; BYTE *pbData; } DATA_BLOB;
 */
function loadDpapi(): DpapiBindings | null {
  if (_dpapi !== undefined) return _dpapi;
  _dpapi = null;
  if (!IS_WIN) return null;
  try {
    // bun:ffi is only available under Bun runtime; require to avoid TS resolution
    // errors when this module is parsed under a Node-only context.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { dlopen, FFIType, ptr, toArrayBuffer } = ffi;

    const crypt32 = dlopen("crypt32.dll", {
      CryptProtectData: {
        // pDataIn, szDataDescr, pOptionalEntropy, pvReserved, pPromptStruct, dwFlags, pDataOut
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      CryptUnprotectData: {
        // pDataIn, ppszDataDescr, pOptionalEntropy, pvReserved, pPromptStruct, dwFlags, pDataOut
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
    });

    const kernel32 = dlopen("kernel32.dll", {
      LocalFree: {
        args: [FFIType.ptr],
        returns: FFIType.ptr,
      },
    });

    // DATA_BLOB is 16 bytes on x64: u32 cbData (+4 padding) + u64 pbData pointer.
    // On x64 Windows, struct alignment makes it { u32; u32 padding; u64 pbData; } = 16 bytes.
    const BLOB_SIZE = 16;

    function makeBlobIn(buf: Buffer): { struct: Buffer; pin: Buffer } {
      const blob = Buffer.alloc(BLOB_SIZE);
      blob.writeUInt32LE(buf.length, 0);
      // 4 bytes padding
      const pinned = Buffer.from(buf); // own copy keeps memory stable across FFI call
      const addr = ptr(pinned);
      // BigInt64 little-endian write at offset 8
      blob.writeBigUInt64LE(BigInt(addr), 8);
      return { struct: blob, pin: pinned };
    }

    function readBlobOut(out: Buffer): Buffer | null {
      const size = out.readUInt32LE(0);
      const addr = out.readBigUInt64LE(8);
      if (size === 0 || addr === 0n) return null;
      // Read `size` bytes from `addr` and copy into a JS-owned Buffer
      const pointer = Number(addr) as unknown as import("bun:ffi").Pointer;
      const raw = new Uint8Array(toArrayBuffer(pointer, 0, size));
      const copy = Buffer.from(raw);
      try {
        // Free DPAPI-allocated memory
        kernel32.symbols.LocalFree(pointer);
      } catch {}
      return copy;
    }

    function protect(plaintext: Buffer): Buffer | null {
      const { struct: inBlob } = makeBlobIn(plaintext);
      const outBlob = Buffer.alloc(BLOB_SIZE);
      const ok = crypt32.symbols.CryptProtectData(
        ptr(inBlob),
        null,
        null,
        null,
        null,
        0,
        ptr(outBlob),
      );
      if (!ok) return null;
      return readBlobOut(outBlob);
    }

    function unprotect(ciphertext: Buffer): Buffer | null {
      const { struct: inBlob } = makeBlobIn(ciphertext);
      const outBlob = Buffer.alloc(BLOB_SIZE);
      const ok = crypt32.symbols.CryptUnprotectData(
        ptr(inBlob),
        null,
        null,
        null,
        null,
        0,
        ptr(outBlob),
      );
      if (!ok) return null;
      return readBlobOut(outBlob);
    }

    _dpapi = { protect, unprotect };
    return _dpapi;
  } catch {
    return null;
  }
}

/** True on win32 when DPAPI bindings loaded successfully. */
export function windowsKeychainAvailable(): boolean {
  if (!IS_WIN) return false;
  return loadDpapi() !== null;
}

type ReadResult =
  | { ok: true; store: Record<string, string> }
  | { ok: false; reason: "missing" | "unreadable" };

function readEncryptedStore(): ReadResult {
  const file = windowsSecretsFile();
  if (!existsSync(file)) return { ok: true, store: {} };
  try {
    const dpapi = loadDpapi();
    if (!dpapi) return { ok: false, reason: "unreadable" };
    const ciphertext = readFileSync(file);
    if (ciphertext.length === 0) return { ok: true, store: {} };
    const plain = dpapi.unprotect(ciphertext);
    if (!plain) return { ok: false, reason: "unreadable" };
    return { ok: true, store: JSON.parse(plain.toString("utf-8")) as Record<string, string> };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function writeEncryptedStore(store: Record<string, string>): boolean {
  try {
    const dpapi = loadDpapi();
    if (!dpapi) return false;
    const json = Buffer.from(JSON.stringify(store), "utf-8");
    const cipher = dpapi.protect(json);
    if (!cipher) return false;
    const file = windowsSecretsFile();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, cipher);
    return true;
  } catch {
    return false;
  }
}

export function windowsKeychainGet(key: string): string | null {
  if (!IS_WIN) return null;
  const r = readEncryptedStore();
  if (!r.ok) return null;
  return r.store[key] ?? null;
}

export function windowsKeychainSet(key: string, value: string): boolean {
  if (!IS_WIN) return false;
  const r = readEncryptedStore();
  // Refuse to write when we can't read the existing store — otherwise a
  // transient DPAPI/IO failure overwrites every previously stored secret
  // with the synthesized empty object.
  if (!r.ok) return false;
  r.store[key] = value;
  return writeEncryptedStore(r.store);
}

export function windowsKeychainDelete(key: string): boolean {
  if (!IS_WIN) return false;
  const r = readEncryptedStore();
  if (!r.ok) return false;
  if (!(key in r.store)) return true;
  delete r.store[key];
  return writeEncryptedStore(r.store);
}
