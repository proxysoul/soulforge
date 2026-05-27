#!/usr/bin/env bash
set -euo pipefail

# SoulForge Bundle Script
# Creates a self-contained distributable with all native dependencies.
# Usage: ./scripts/bundle.sh [arch] [platform]
#   arch:     arm64 (default), x64, or x64-baseline (no AVX — for older CPUs)
#   platform: darwin (default) or linux

ARCH="${1:-arm64}"
PLATFORM="${2:-darwin}"

# x64-baseline: same native deps as x64, but Bun binary targets SSE2-only (no AVX).
# Needed for pre-Sandy Bridge CPUs (Westmere, Nehalem, Core 2, etc.).
BASE_ARCH="${ARCH}"
[[ "$ARCH" == "x64-baseline" ]] && BASE_ARCH="x64"

VERSION="$(bun -e "console.log(require('./package.json').version)")"
BUNDLE_NAME="soulforge-${VERSION}-${PLATFORM}-${ARCH}"
STAGE_DIR="dist/bundle/${BUNDLE_NAME}"
DEPS_DIR="${STAGE_DIR}/deps"

RG_VERSION="14.1.1"
FD_VERSION="10.2.0"
LAZYGIT_VERSION="0.44.1"
# Neovim + CLIProxyAPI are NOT bundled — they're opt-in addons fetched at
# runtime via `soulforge addon install <name>`.

# ── Platform / arch matrix ──
if [[ "$PLATFORM" == "darwin" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    RG_TRIPLET="aarch64-apple-darwin"
    FD_TRIPLET="aarch64-apple-darwin"
    LAZYGIT_SUFFIX="Darwin_arm64"
    BUN_TARGET="bun-darwin-aarch64"
  elif [[ "$ARCH" == "x64" ]]; then
    RG_TRIPLET="x86_64-apple-darwin"
    FD_TRIPLET="x86_64-apple-darwin"
    LAZYGIT_SUFFIX="Darwin_x86_64"
    BUN_TARGET="bun-darwin-x64"
  else
    echo "Unknown arch: ${ARCH} (use arm64 or x64)"
    exit 1
  fi
elif [[ "$PLATFORM" == "linux" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    RG_TRIPLET="aarch64-unknown-linux-gnu"
    FD_TRIPLET="aarch64-unknown-linux-gnu"
    LAZYGIT_SUFFIX="Linux_arm64"
    BUN_TARGET="bun-linux-aarch64"
  elif [[ "$BASE_ARCH" == "x64" ]]; then
    RG_TRIPLET="x86_64-unknown-linux-musl"
    FD_TRIPLET="x86_64-unknown-linux-musl"
    LAZYGIT_SUFFIX="Linux_x86_64"
    if [[ "$ARCH" == "x64-baseline" ]]; then
        BUN_TARGET="bun-linux-x64-baseline"
    else
        BUN_TARGET="bun-linux-x64"
    fi
    else
    echo "Unknown arch: ${ARCH} (use arm64, x64, or x64-baseline)"
    exit 1
  fi
else
  echo "Unknown platform: ${PLATFORM} (use darwin or linux)"
  exit 1
fi

echo "==> Bundling SoulForge ${VERSION} for ${PLATFORM}/${ARCH}"

rm -rf "${STAGE_DIR}"
mkdir -p "${DEPS_DIR}"

# ── 1. Compile SoulForge ──
echo "==> Compiling binary..."
bun scripts/build.ts --compile --outfile="${STAGE_DIR}/soulforge" --target="${BUN_TARGET}"
echo "    ✓ soulforge binary"

# ── 2. Download native dependencies ──
download() {
  local url="$1" dest="$2" label="$3"
  if [[ -f "$dest" ]]; then
    echo "    ✓ ${label} (cached)"
    return
  fi
  echo "    ↓ ${label}..."
  curl -fSL --retry 3 "$url" -o "$dest"
}

CACHE_DIR="dist/bundle/.cache"
mkdir -p "$CACHE_DIR"

# Neovim: NOT bundled. Users opt in via `soulforge addon install neovim`.

# ripgrep
RG_ASSET="ripgrep-${RG_VERSION}-${RG_TRIPLET}.tar.gz"
RG_URL="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_ASSET}"
download "$RG_URL" "${CACHE_DIR}/rg-${PLATFORM}-${BASE_ARCH}.tar.gz" "ripgrep ${RG_VERSION}"
mkdir -p "${DEPS_DIR}/rg-tmp"
tar xzf "${CACHE_DIR}/rg-${PLATFORM}-${BASE_ARCH}.tar.gz" -C "${DEPS_DIR}/rg-tmp" --strip-components=1
cp "${DEPS_DIR}/rg-tmp/rg" "${DEPS_DIR}/rg"
rm -rf "${DEPS_DIR}/rg-tmp"

# fd
FD_ASSET="fd-v${FD_VERSION}-${FD_TRIPLET}.tar.gz"
FD_URL="https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${FD_ASSET}"
download "$FD_URL" "${CACHE_DIR}/fd-${PLATFORM}-${BASE_ARCH}.tar.gz" "fd ${FD_VERSION}"
mkdir -p "${DEPS_DIR}/fd-tmp"
tar xzf "${CACHE_DIR}/fd-${PLATFORM}-${BASE_ARCH}.tar.gz" -C "${DEPS_DIR}/fd-tmp" --strip-components=1
cp "${DEPS_DIR}/fd-tmp/fd" "${DEPS_DIR}/fd"
rm -rf "${DEPS_DIR}/fd-tmp"

# lazygit
LAZYGIT_ASSET="lazygit_${LAZYGIT_VERSION}_${LAZYGIT_SUFFIX}.tar.gz"
LAZYGIT_URL="https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/${LAZYGIT_ASSET}"
download "$LAZYGIT_URL" "${CACHE_DIR}/lazygit-${PLATFORM}-${BASE_ARCH}.tar.gz" "lazygit ${LAZYGIT_VERSION}"
mkdir -p "${DEPS_DIR}/lazygit-tmp"
tar xzf "${CACHE_DIR}/lazygit-${PLATFORM}-${BASE_ARCH}.tar.gz" -C "${DEPS_DIR}/lazygit-tmp"
cp "${DEPS_DIR}/lazygit-tmp/lazygit" "${DEPS_DIR}/lazygit"
rm -rf "${DEPS_DIR}/lazygit-tmp"

# cli-proxy-api: NOT bundled. Users opt in via `soulforge addon install proxy`.

chmod +x "${DEPS_DIR}/rg" "${DEPS_DIR}/fd" "${DEPS_DIR}/lazygit"

# Native addons — can't be embedded in compiled binaries
echo "    Bundling native addons..."
NATIVE_DIR="${DEPS_DIR}/native/${PLATFORM}-${BASE_ARCH}"
mkdir -p "${NATIVE_DIR}"
if [[ "$PLATFORM" == "darwin" ]]; then
  NATIVE_PLATFORM="darwin"
else
  NATIVE_PLATFORM="linux"
fi
GHOSTTY_NODE="node_modules/ghostty-opentui/dist/${NATIVE_PLATFORM}-${BASE_ARCH}/ghostty-opentui.node"
if [[ -f "$GHOSTTY_NODE" ]]; then
  cp "$GHOSTTY_NODE" "${NATIVE_DIR}/ghostty-opentui.node"
  echo "    ✓ ghostty-opentui.node"
else
  echo "    ⚠ ghostty-opentui.node not found for ${PLATFORM}-${ARCH} (floating terminal disabled)"
fi

# OpenTUI native lib
if [[ "$PLATFORM" == "darwin" ]]; then
  OPENTUI_LIB="node_modules/@opentui/core-${NATIVE_PLATFORM}-${BASE_ARCH}/libopentui.dylib"
else
  OPENTUI_LIB="node_modules/@opentui/core-${NATIVE_PLATFORM}-${BASE_ARCH}/libopentui.so"
fi
if [[ -f "$OPENTUI_LIB" ]]; then
  cp "$OPENTUI_LIB" "${NATIVE_DIR}/"
  echo "    ✓ $(basename "$OPENTUI_LIB")"
else
  echo "    ✘ OpenTUI native lib not found: ${OPENTUI_LIB}"
  echo "      Run: bun install on a ${PLATFORM}-${ARCH} machine first"
  exit 1
fi

# Worker scripts — pre-bundled for compiled binary.
# Use --outdir + --entry-naming because Bun may emit multiple chunks for
# the intelligence worker (code-splitting via dynamic imports of ts-morph,
# tree-sitter, etc.). --outfile only accepts a single output file.
#
# --external marks native + binary assets that Bun would otherwise inline as
# hash-named chunks. Two reasons:
#   1. Homebrew's keg_relocate walks the keg looking for Mach-O dylibs to
#      patch install names on. The hash-named .node files in deps/workers/
#      have no header pad and fail relinking → broken brew install.
#   2. shiki transitively pulls @opentui/core + ghostty-opentui for terminal
#      rendering, but worker code paths never invoke that surface — only the
#      pure-JS highlighter. Keep the native bits out.
# Tree-sitter wasm grammars are resolved at runtime from ~/.soulforge/wasm.
echo "    Bundling worker scripts..."
mkdir -p "${DEPS_DIR}/workers"
WORKER_EXTERNALS=(
  --external "ghostty-opentui"
  --external "ghostty-opentui/*"
  --external "@opentui/core"
  --external "@opentui/core/*"
  --external "tree-sitter-wasms"
  --external "tree-sitter-wasms/*"
  --external "*.node"
  --external "*.wasm"
  --external "*.scm"
)
bun build src/core/workers/intelligence.worker.ts \
  --outdir "${DEPS_DIR}/workers" \
  --entry-naming "[name].[ext]" \
  --target=bun \
  "${WORKER_EXTERNALS[@]}"
bun build src/core/workers/io.worker.ts \
  --outdir "${DEPS_DIR}/workers" \
  --entry-naming "[name].[ext]" \
  --target=bun \
  "${WORKER_EXTERNALS[@]}"

# Tree-sitter WASM runtime + grammars + OpenTUI syntax assets
echo "    Bundling tree-sitter assets..."
mkdir -p "${DEPS_DIR}/wasm"
# web-tree-sitter ≤0.25.x ships tree-sitter.wasm; ≥0.26.x renamed to web-tree-sitter.wasm
cp node_modules/web-tree-sitter/tree-sitter.wasm "${DEPS_DIR}/wasm/" 2>/dev/null \
  || cp node_modules/web-tree-sitter/web-tree-sitter.wasm "${DEPS_DIR}/wasm/tree-sitter.wasm"
cp node_modules/tree-sitter-wasms/out/*.wasm "${DEPS_DIR}/wasm/"
cp -r node_modules/@opentui/core/assets "${DEPS_DIR}/opentui-assets"
# Pre-bundle the worker with all deps (web-tree-sitter) into a single file
bun build node_modules/@opentui/core/parser.worker.js --outdir "${DEPS_DIR}/opentui-assets" --target=bun --asset-naming="[name].[ext]"
# Patch the worker to resolve tree-sitter.wasm from ~/.soulforge/wasm/ (absolute path)
# instead of ./tree-sitter.wasm (relative to CWD which is the user's project)
# Patch bare require() calls to use __require (bun's ESM-compatible CJS shim)
# Use sed -i.bak + rm for GNU/BSD portability
sed -i.bak 's|module2.exports = "./tree-sitter.wasm"|module2.exports = (__require("os").homedir() + "/.soulforge/wasm/tree-sitter.wasm")|' "${DEPS_DIR}/opentui-assets/parser.worker.js"
sed -i.bak 's|var fs = require("fs")|var fs = __require("fs")|g' "${DEPS_DIR}/opentui-assets/parser.worker.js"
sed -i.bak 's|var nodePath = require("path")|var nodePath = __require("path")|g' "${DEPS_DIR}/opentui-assets/parser.worker.js"
sed -i.bak 's|require("url")|__require("url")|g' "${DEPS_DIR}/opentui-assets/parser.worker.js"
rm -f "${DEPS_DIR}/opentui-assets/parser.worker.js.bak"
cp src/core/editor/init.lua "${DEPS_DIR}/init.lua"

# Nerd Font Symbols Only — enables icons without requiring a full Nerd Font
NERD_FONTS_VERSION="v3.4.0"
NERD_FONTS_BASE="https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONTS_VERSION}"

if [[ ! -f "${CACHE_DIR}/NerdFontsSymbolsOnly.zip" ]]; then
  echo "    ↓ Nerd Font Symbols Only..."
  curl -fSL --retry 3 "${NERD_FONTS_BASE}/NerdFontsSymbolsOnly.zip" -o "${CACHE_DIR}/NerdFontsSymbolsOnly.zip"
else
  echo "    ✓ Nerd Font Symbols Only (cached)"
fi
mkdir -p "${DEPS_DIR}/nerd-fonts"
unzip -qo "${CACHE_DIR}/NerdFontsSymbolsOnly.zip" "*.ttf" -d "${DEPS_DIR}/nerd-fonts" 2>/dev/null || true

echo "==> Dependencies ready"

# ── 3. Create install script ──
cat > "${STAGE_DIR}/install.sh" << 'INSTALL_EOF'
#!/usr/bin/env bash
# Re-exec under bash if invoked via sh/dash (dash lacks pipefail)
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

SOULFORGE_DIR="${HOME}/.soulforge"
BIN_DIR="${SOULFORGE_DIR}/bin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QUIET="${SOULFORGE_QUIET:-}"

# --quiet flag for non-interactive installs (Homebrew, CI)
for arg in "$@"; do
  [[ "$arg" == "--quiet" ]] && QUIET=1
done

P='\033[38;2;155;48;255m'
R='\033[38;2;255;0;64m'
D='\033[2m'
M='\033[38;2;85;85;85m'
G='\033[38;2;74;167;74m'
W='\033[38;2;170;170;170m'
Y='\033[38;2;230;180;60m'
B='\033[1m'
RST='\033[0m'
SPINNER=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

spin() {
  local msg="$1" pid="$2" i=0
  if [[ -n "$QUIET" ]]; then
    wait "$pid" 2>/dev/null
    echo "  ✓ $msg"
    return
  fi
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${P}${SPINNER[$((i % 10))]}${RST} ${M}%s${RST}  " "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pid" 2>/dev/null
  printf "\r  ${G}✓${RST} ${W}%s${RST}  \n" "$msg"
}

step() {
  if [[ -n "$QUIET" ]]; then echo "  ✓ $1"; else printf "  ${G}✓${RST} ${W}%s${RST}\n" "$1"; fi
}
dim() {
  if [[ -n "$QUIET" ]]; then echo "  $1"; else printf "  ${M}%s${RST}\n" "$1"; fi
}

if [[ -z "$QUIET" ]]; then
  clear
  printf "\033[?25l"
  sleep 0.1

  printf "\n"
  printf "  ${P}${B}░${RST}\n"
  sleep 0.04
  printf "\033[1A\r  ${P}${B}▒${RST}\n"
  sleep 0.04
  printf "\033[1A\r  ${P}${B}▓${RST}\n"
  sleep 0.04
  printf "\033[1A\r  ${P}${B}◆${RST}\n"
  sleep 0.08

  printf "  ${D}${P}~∿~${RST}\n"

  WORDMARK_1="┌─┐┌─┐┬ ┬┬  ┌─┐┌─┐┬─┐┌─┐┌─┐"
  WORDMARK_2="└─┐│ ││ ││  ├┤ │ │├┬┘│ ┬├┤ "
  WORDMARK_3="└─┘└─┘└─┘┴─┘└  └─┘┴└─└─┘└─┘"

  GLITCH="░▒▓█▄▀▐▌┤├┼─│┌┐└┘"
  garble() {
    local text="$1" out="" i ch
    for ((i=0; i<${#text}; i++)); do
      ch="${text:$i:1}"
      if [[ "$ch" == " " ]]; then out+=" "; else out+="${GLITCH:$((RANDOM % ${#GLITCH})):1}"; fi
    done
    printf "%s" "$out"
  }

  printf "\n"
  printf "  ${M}$(garble "$WORDMARK_1")${RST}\n"
  sleep 0.02
  printf "\033[1A\r  ${P}${B}${WORDMARK_1}${RST}\n"
  printf "  ${M}$(garble "$WORDMARK_2")${RST}\n"
  sleep 0.02
  printf "\033[1A\r  ${P}${B}${WORDMARK_2}${RST}\n"
  printf "  ${M}$(garble "$WORDMARK_3")${RST}\n"
  sleep 0.02
  printf "\033[1A\r  ${P}${B}${WORDMARK_3}${RST}\n"

  printf "\n"
  printf "  ${M}── ${D}Graph-Powered Code Intelligence${RST}${M} ──${RST}\n"

  BRAND="by "
  printf "\n  "
  for ((i=0; i<${#BRAND}; i++)); do printf "${M}${BRAND:$i:1}${RST}"; sleep 0.015; done
  PROXY="Proxy"
  for ((i=0; i<${#PROXY}; i++)); do printf "${P}${PROXY:$i:1}${RST}"; sleep 0.015; done
  SOUL="Soul"
  for ((i=0; i<${#SOUL}; i++)); do printf "${R}${SOUL:$i:1}${RST}"; sleep 0.015; done
  printf "${M}.com${RST}"

  printf "\n\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "  ${P}${B}INSTALLING${RST}  ${M}→ ~/.soulforge/${RST}\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "\n"
else
  echo "Installing SoulForge to ~/.soulforge/ ..."
fi

# Clean previous install (preserve config + sessions)
if [[ -d "$SOULFORGE_DIR" ]]; then
  rm -rf "${SOULFORGE_DIR}/bin" "${SOULFORGE_DIR}/installs" "${SOULFORGE_DIR}/wasm" "${SOULFORGE_DIR}/workers" "${SOULFORGE_DIR}/native" "${SOULFORGE_DIR}/opentui-assets" "${SOULFORGE_DIR}/init.lua" 2>/dev/null
  dim "Cleaned previous install (config & sessions preserved)"
fi

mkdir -p "$BIN_DIR"

if [[ -n "$QUIET" ]]; then
  # Synchronous install — no background jobs (Homebrew kills orphaned bg processes)
  cp "${SCRIPT_DIR}/soulforge" "${BIN_DIR}/soulforge" && chmod +x "${BIN_DIR}/soulforge" && ln -sf "${BIN_DIR}/soulforge" "${BIN_DIR}/sf"
  step "Forging the soul binary"

  for bin in rg fd lazygit; do
    cp "${SCRIPT_DIR}/deps/${bin}" "${BIN_DIR}/${bin}"
    chmod +x "${BIN_DIR}/${bin}"
  done
  step "Sharpening the search blades"

  mkdir -p "${SOULFORGE_DIR}/wasm" "${SOULFORGE_DIR}/workers"
  cp "${SCRIPT_DIR}/deps/wasm/"*.wasm "${SOULFORGE_DIR}/wasm/"
  cp "${SCRIPT_DIR}/deps/workers/"*.js "${SOULFORGE_DIR}/workers/"
  if [[ -d "${SCRIPT_DIR}/deps/native" ]]; then
    cp -r "${SCRIPT_DIR}/deps/native" "${SOULFORGE_DIR}/native"
  fi
  rm -rf "${SOULFORGE_DIR}/opentui-assets"
  cp -r "${SCRIPT_DIR}/deps/opentui-assets" "${SOULFORGE_DIR}/opentui-assets"
  cp "${SCRIPT_DIR}/deps/init.lua" "${SOULFORGE_DIR}/init.lua"
  step "Inscribing the tree-sitter runes"

  if [[ "$(uname)" == "Darwin" ]]; then
    FONT_DIR="${HOME}/Library/Fonts"
  else
    FONT_DIR="${HOME}/.local/share/fonts"
  fi
  mkdir -p "$FONT_DIR"
  cp "${SCRIPT_DIR}/deps/nerd-fonts/"*.ttf "$FONT_DIR/" 2>/dev/null || true
  if [[ "$(uname)" != "Darwin" ]]; then
    fc-cache -f "$FONT_DIR" 2>/dev/null || true
  fi
  step "Etching the sacred glyphs"

  if [[ "$(uname)" == "Darwin" ]]; then
    xattr -cr "${SOULFORGE_DIR}" 2>/dev/null || true
    step "Warding off Gatekeeper curses"
  fi
else
  # Interactive install — background jobs with spinners
  (cp "${SCRIPT_DIR}/soulforge" "${BIN_DIR}/soulforge" && chmod +x "${BIN_DIR}/soulforge" && ln -sf "${BIN_DIR}/soulforge" "${BIN_DIR}/sf") &
  spin "Forging the soul binary" $!

  (for bin in rg fd lazygit; do
    cp "${SCRIPT_DIR}/deps/${bin}" "${BIN_DIR}/${bin}"
    chmod +x "${BIN_DIR}/${bin}"
  done) &
  spin "Sharpening the search blades" $!

  (mkdir -p "${SOULFORGE_DIR}/wasm" "${SOULFORGE_DIR}/workers"
  cp "${SCRIPT_DIR}/deps/wasm/"*.wasm "${SOULFORGE_DIR}/wasm/"
  cp "${SCRIPT_DIR}/deps/workers/"*.js "${SOULFORGE_DIR}/workers/"
  if [[ -d "${SCRIPT_DIR}/deps/native" ]]; then
    cp -r "${SCRIPT_DIR}/deps/native" "${SOULFORGE_DIR}/native"
  fi
  rm -rf "${SOULFORGE_DIR}/opentui-assets"
  cp -r "${SCRIPT_DIR}/deps/opentui-assets" "${SOULFORGE_DIR}/opentui-assets"
  cp "${SCRIPT_DIR}/deps/init.lua" "${SOULFORGE_DIR}/init.lua") &
  spin "Inscribing the tree-sitter runes" $!

  (if [[ "$(uname)" == "Darwin" ]]; then
    FONT_DIR="${HOME}/Library/Fonts"
  else
    FONT_DIR="${HOME}/.local/share/fonts"
  fi
  mkdir -p "$FONT_DIR"
  cp "${SCRIPT_DIR}/deps/nerd-fonts/"*.ttf "$FONT_DIR/" 2>/dev/null || true
  if [[ "$(uname)" != "Darwin" ]]; then
    fc-cache -f "$FONT_DIR" 2>/dev/null || true
  fi) &
  spin "Etching the sacred glyphs" $!

  if [[ "$(uname)" == "Darwin" ]]; then
    (xattr -cr "${SOULFORGE_DIR}" 2>/dev/null || true) &
    spin "Warding off Gatekeeper curses" $!
  fi
fi

# ── Verify critical runtime artifacts (issue #66) ────────────────────
# Detect platform-arch for native lib triplet (matches process.platform/arch in JS).
case "$(uname -s)" in
  Darwin) NATIVE_PLATFORM="darwin"; LIB_EXT="dylib" ;;
  Linux)  NATIVE_PLATFORM="linux";  LIB_EXT="so"    ;;
  *)      NATIVE_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"; LIB_EXT="so" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) NATIVE_ARCH="x64" ;;
  aarch64|arm64) NATIVE_ARCH="arm64" ;;
  *)             NATIVE_ARCH="$(uname -m)" ;;
esac
NATIVE_TRIPLET="${NATIVE_PLATFORM}-${NATIVE_ARCH}"
NATIVE_LIB="${SOULFORGE_DIR}/native/${NATIVE_TRIPLET}/libopentui.${LIB_EXT}"

REQUIRED_FILES=(
  "${BIN_DIR}/soulforge"
  "${SOULFORGE_DIR}/wasm/tree-sitter.wasm"
  "${SOULFORGE_DIR}/init.lua"
  "${NATIVE_LIB}"
)
MISSING=()
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "$f" ]] || MISSING+=("$f")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "" >&2
  echo "ERROR: SoulForge install incomplete — missing files:" >&2
  for f in "${MISSING[@]}"; do echo "  - $f" >&2; done
  echo "" >&2
  echo "  source: ${SCRIPT_DIR}" >&2
  echo "  triplet: ${NATIVE_TRIPLET}" >&2
  if [[ ! -d "${SCRIPT_DIR}/deps/native/${NATIVE_TRIPLET}" ]]; then
    echo "  cause: bundled tarball does not contain native libs for ${NATIVE_TRIPLET}" >&2
    echo "         this build was packaged for a different platform." >&2
  else
    echo "  cause: copy from ${SCRIPT_DIR}/deps/ failed (permissions / disk full / sandbox)" >&2
  fi
  echo "" >&2
  echo "  fix: re-download the matching release tarball from" >&2
  echo "       https://github.com/proxysoul/soulforge/releases" >&2
  echo "       or run: brew reinstall soulforge" >&2
  echo "" >&2
  exit 1
fi
step "Verified runtime artifacts"

# Enable nerd font icons (Symbols Only font is always installed)
CONFIG_FILE="${SOULFORGE_DIR}/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo '{"nerdFont":true}' > "$CONFIG_FILE"
elif ! grep -q '"nerdFont"' "$CONFIG_FILE" 2>/dev/null; then
  sed -i.bak 's/^{/{"nerdFont":true,/' "$CONFIG_FILE" 2>/dev/null || true
  rm -f "${CONFIG_FILE}.bak"
fi

# Skip shell RC modification in quiet mode (Homebrew manages PATH via symlinks)
if [[ -z "$QUIET" ]]; then
  # Detect shell RC file based on user's actual shell
  SHELL_RC=""
  USER_SHELL="$(basename "${SHELL:-/bin/bash}")"
  case "$USER_SHELL" in
    zsh)  SHELL_RC="${HOME}/.zshrc" ;;
    bash)
      # macOS uses .bash_profile for login shells, Linux uses .bashrc
      if [[ -f "${HOME}/.bashrc" ]]; then
        SHELL_RC="${HOME}/.bashrc"
      elif [[ -f "${HOME}/.bash_profile" ]]; then
        SHELL_RC="${HOME}/.bash_profile"
      else
        SHELL_RC="${HOME}/.bashrc"
      fi
      ;;
    fish) SHELL_RC="${HOME}/.config/fish/config.fish" ;;
    ksh)  SHELL_RC="${HOME}/.kshrc" ;;
    *)
      # Fallback: check common files
      for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile"; do
        if [[ -f "$rc" ]]; then SHELL_RC="$rc"; break; fi
      done
      ;;
  esac

  if [[ -n "$SHELL_RC" ]]; then
    if ! grep -q '.soulforge/bin' "$SHELL_RC" 2>/dev/null; then
      mkdir -p "$(dirname "$SHELL_RC")"
      echo '' >> "$SHELL_RC"
      echo '# SoulForge' >> "$SHELL_RC"
      if [[ "$USER_SHELL" == "fish" ]]; then
        echo 'set -gx PATH $HOME/.soulforge/bin $PATH' >> "$SHELL_RC"
      else
        echo 'export PATH="$HOME/.soulforge/bin:$PATH"' >> "$SHELL_RC"
      fi
      step "Added to PATH in $(basename "$SHELL_RC")"
    else
      step "PATH already configured"
    fi
  else
    dim "Could not detect shell config — add ~/.soulforge/bin to your PATH manually"
  fi

  printf "\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "  ${G}${B}◆ INSTALLED${RST}\n"
  printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
  printf "\n"
  printf "  ${W}Commands:${RST}  ${P}soulforge${RST}  ${M}or${RST}  ${P}sf${RST}\n"
  printf "  ${W}Location:${RST}  ${M}~/.soulforge/bin/${RST}\n"
  printf "\n"
  printf "  ${M}Optional addons (download on demand):${RST}\n"
  printf "    ${P}soulforge addon install proxy${RST}    ${M}# CLIProxyAPI gateway${RST}\n"
  printf "    ${P}soulforge addon install neovim${RST}   ${M}# editor integration${RST}\n"
  printf "\n"
  printf "  ${Y}→${RST} ${W}Run${RST} ${P}source ${SHELL_RC:-~/.zshrc}${RST} ${W}then${RST} ${P}soulforge${RST}\n"
  printf "\n"
  printf "\033[?25h"
else
  echo "Done. SoulForge installed to ~/.soulforge/"
fi
INSTALL_EOF
chmod +x "${STAGE_DIR}/install.sh"

# ── 4. Create uninstall script ──
cat > "${STAGE_DIR}/uninstall.sh" << 'UNINSTALL_EOF'
#!/usr/bin/env bash
# Re-exec under bash if invoked via sh/dash (dash lacks pipefail)
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -euo pipefail

SOULFORGE_DIR="${HOME}/.soulforge"

P='\033[38;2;155;48;255m'
R='\033[38;2;255;0;64m'
D='\033[2m'
M='\033[38;2;85;85;85m'
G='\033[38;2;74;167;74m'
W='\033[38;2;170;170;170m'
B='\033[1m'
RST='\033[0m'
SPINNER=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

spin() {
  local msg="$1" pid="$2" i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${R}${SPINNER[$((i % 10))]}${RST} ${M}%s${RST}  " "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  wait "$pid" 2>/dev/null
  printf "\r  ${G}✓${RST} ${W}%s${RST}  \n" "$msg"
}

clear
printf "\033[?25l"
printf "\n"
printf "  ${P}${B}◆${RST}\n"
printf "  ${D}${P}∿·∿${RST}\n"
printf "\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "  ${R}${B}UNINSTALLING${RST}  ${M}← ~/.soulforge/${RST}\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "\n"

if [[ -d "$SOULFORGE_DIR" ]]; then
  (rm -rf "${SOULFORGE_DIR}/bin") &
  spin "Extinguishing the forge" $!

  (rm -rf "${SOULFORGE_DIR}/installs") &
  spin "Removing addons (proxy, neovim)" $!

  (rm -rf "${SOULFORGE_DIR}/fonts" "${SOULFORGE_DIR}/wasm" "${SOULFORGE_DIR}/workers" "${SOULFORGE_DIR}/native" "${SOULFORGE_DIR}/opentui-assets" "${SOULFORGE_DIR}/init.lua") &
  spin "Dissolving the runes" $!

  (rm -rf "${SOULFORGE_DIR}/sessions" "${SOULFORGE_DIR}/memories") &
  spin "Erasing the memories" $!

  (rm -f "${SOULFORGE_DIR}/config.json"
  rmdir "$SOULFORGE_DIR" 2>/dev/null || rm -rf "$SOULFORGE_DIR") &
  spin "Scattering the ashes" $!

  (rm -rf "${HOME}/.local/share/soulforge" "${HOME}/.local/state/soulforge" "${HOME}/.cache/soulforge" "${HOME}/.config/soulforge") &
  spin "Purging the spirit realm" $!
else
  printf "  ${M}Nothing to remove at ${SOULFORGE_DIR}${RST}\n"
fi

for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile" "${HOME}/.kshrc" "${HOME}/.config/fish/config.fish"; do
  if [[ -f "$rc" ]] && grep -q '.soulforge/bin' "$rc" 2>/dev/null; then
    sed -i.bak '/# SoulForge/d' "$rc"
    sed -i.bak '/\.soulforge\/bin/d' "$rc"
    rm -f "${rc}.bak"
    printf "  ${G}✓${RST} ${W}Removed PATH from $(basename "$rc")${RST}\n"
  fi
done

printf "\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "  ${R}${B}◆ UNINSTALLED${RST}\n"
printf "  ${M}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}\n"
printf "\n"
printf "  ${W}Restart your terminal or run:${RST}\n"
printf "    ${P}source ~/.zshrc${RST}\n"
printf "\n"
printf "\033[?25h"
UNINSTALL_EOF
chmod +x "${STAGE_DIR}/uninstall.sh"

# ── 5. Create tarball ──
echo "==> Creating tarball..."
cd dist/bundle
tar czf "${BUNDLE_NAME}.tar.gz" "${BUNDLE_NAME}/"
cd ../..

SIZE=$(du -sh "dist/bundle/${BUNDLE_NAME}.tar.gz" | cut -f1)
echo ""
echo "==> Done! dist/bundle/${BUNDLE_NAME}.tar.gz (${SIZE})"
echo "    Install:"
echo "    tar xzf ${BUNDLE_NAME}.tar.gz && cd ${BUNDLE_NAME} && ./install.sh"
