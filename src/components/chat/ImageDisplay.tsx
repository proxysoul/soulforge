/**
 * Renders an inline image in chat.
 *
 * For Kitty images: renders U+10EEEE placeholder characters directly via
 * React <text>+<span> elements. Kitty maps these to the transmitted image
 * pixels using the fg-color-encoded image ID and row/column diacritics.
 * This bypasses ghostty-terminal which can't handle supplementary plane PUA chars.
 *
 * For non-Kitty (half-block art): uses ghostty-terminal to render ANSI art.
 */

import { basename } from "node:path";
import { useEffect } from "react";
import { icon } from "../../core/icons.js";
import { ghosttyDisabled } from "../../core/platform/index.js";
import { type ImageArt, rearmKittyPlacement } from "../../core/terminal/image.js";
import { useTheme } from "../../core/theme/index.js";

/** Kitty Unicode placeholder character (Private Use Area Supplementary B). */
const PLACEHOLDER = "\u{10EEEE}";

/**
 * Kitty row/column diacritics lookup table.
 * Derived from Unicode 6.0.0 combining chars with combining class 230.
 * See: https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
 * Source: rowcolumn-diacritics.txt
 */
// prettier-ignore
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
  0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
  0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
  0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
  0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743,
  0x0745, 0x0747, 0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3,
  0x0816, 0x0817, 0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954,
  0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76,
  0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71,
  0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
  0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5,
  0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1,
  0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7,
  0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2,
  0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee,
  0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa,
  0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed,
  0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1,
  0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186,
  0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
]; // 297 entries

/**
 * Build a single row of Kitty placeholder text.
 * Each cell: U+10EEEE + ROW_DIACRITIC + COL_DIACRITIC
 * The same diacritics table is used for both row and column indices.
 */
function buildPlaceholderRow(cols: number, row: number): string {
  const rowDia = String.fromCodePoint(DIACRITICS[row] ?? 0x0305);
  let result = "";
  for (let col = 0; col < cols; col++) {
    const colDia = String.fromCodePoint(DIACRITICS[col] ?? 0x0305);
    result += PLACEHOLDER + rowDia + colDia;
  }
  return result;
}

function ImageHeader({ img }: { img: ImageArt }) {
  const t = useTheme();
  const filename = basename(img.name);
  const res = img.width && img.height ? `${String(img.width)}×${String(img.height)}` : null;

  return (
    <box height={1} flexShrink={0}>
      <text truncate>
        <span fg={t.textDim}>{icon("image")} </span>
        <span fg={t.textSecondary}>{filename}</span>
        {res ? <span fg={t.textDim}> {res}</span> : null}
      </text>
    </box>
  );
}

function KittyPlaceholder({
  imageId,
  cols,
  rows,
}: {
  imageId: number;
  cols: number;
  rows: number;
}) {
  const r = (imageId >> 16) & 0xff;
  const g = (imageId >> 8) & 0xff;
  const b = imageId & 0xff;
  const fg = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

  // Re-arm the virtual placement on mount AND on a short repeating tick.
  //
  // Why mount alone is insufficient: when the live tool rail (LockInLiveAutoView)
  // unmounts and the static rail (AssistantMessage) mounts in its place, React
  // tears down the old <KittyPlaceholder> subtree and mounts a new one. The
  // useEffect runs after React commits, but opentui's renderer flushes its own
  // frame on a separate clock — the re-arm command can race ahead of the new
  // placeholder cells reaching the terminal, leaving Kitty with no cells to
  // bind the placement to. Result: blank rect where the image was.
  //
  // Why a tick is needed: any parent repaint (scroll, hover, sibling state)
  // can dirty the placeholder cells. Re-arming periodically (cheap: ~30 bytes
  // per write) reliably rebinds the placement to whatever cells are currently
  // showing the U+10EEEE glyphs.
  useEffect(() => {
    // Initial fire: mount.
    rearmKittyPlacement(imageId, cols, rows);
    // Delayed fire: after opentui's next paint cycle reaches the terminal.
    const t1 = setTimeout(() => rearmKittyPlacement(imageId, cols, rows), 50);
    const t2 = setTimeout(() => rearmKittyPlacement(imageId, cols, rows), 200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [imageId, cols, rows]);

  return (
    <box flexDirection="column" height={rows} flexShrink={0}>
      {Array.from({ length: rows }, (_, row) => (
        <box key={`r${String(row)}`} height={1} flexShrink={0}>
          <text>
            <span fg={fg}>{buildPlaceholderRow(cols, row)}</span>
          </text>
        </box>
      ))}
    </box>
  );
}

export function ImageDisplay({ img }: { img: ImageArt }) {
  if (img.kittyImageId && img.kittyCols && img.kittyRows) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <ImageHeader img={img} />
        <KittyPlaceholder imageId={img.kittyImageId} cols={img.kittyCols} rows={img.kittyRows} />
      </box>
    );
  }

  // Fallback: chafa / half-block ANSI art via ghostty-terminal.
  // On Windows the ghostty-opentui native addon is skipped, so the
  // <ghostty-terminal> renderable isn't registered — render the ANSI
  // lines as plain <text> rows instead so images still show (with
  // raw escape sequences for the terminal to interpret).
  const vtCols = Math.max(80, img.lines.length > 0 ? (img.lines[0]?.length ?? 120) : 120);
  if (ghosttyDisabled()) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <ImageHeader img={img} />
        {img.lines.map((line, i) => (
          <box key={`L${String(i)}`} height={1} flexShrink={0}>
            <text>{line}</text>
          </box>
        ))}
      </box>
    );
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <ImageHeader img={img} />
      <ghostty-terminal ansi={img.lines.join("\n")} cols={vtCols} rows={img.lines.length} trimEnd />
    </box>
  );
}
