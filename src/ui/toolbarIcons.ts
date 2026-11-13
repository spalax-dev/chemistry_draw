/**
 * Inline styling for the document commands in Ketcher's top toolbar.
 *
 * Ketcher renders `customButtons[].imageLink` as `<img src alt={title}>`, and an
 * `<img>` cannot inherit `currentColor`. So `imageLink` carries a fully
 * transparent SVG (it only reserves the box) and the visible glyph is painted
 * by a CSS mask on top of `background-color: currentColor`. That way the button
 * colour drives the glyph through default, hover and active states
 * (`docs/conventions.md` §6.5.1, `docs/architecture.md` §5.7).
 *
 * The mask uses the alpha channel, so only the ink matters. The glyphs are
 * outline drawings on Ketcher's 24 px grid: 1.5-unit strokes, round caps and
 * joins, ink confined to a 15x15 live area inset 4.5 units. That matches the
 * optical size and weight of the neighbouring native icons; solid fills are not
 * used, and a literal colour here is a bug.
 */

/** An empty SVG: a valid `<img>` source that draws nothing. */
export const TRANSPARENT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'/%3E";

/**
 * Ketcher's outline geometry: a 24 unit box with 1.5 unit strokes, so the ink
 * of a centreline at 5.25 lands on 4.5 and fills the 15x15 live area.
 */
const GLYPH_SVG_OPEN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' " +
  "fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' " +
  "stroke-linejoin='round'%3E";

/** One outline glyph: absolute path commands only, all inside 5.25-18.75. */
const outline = (...paths: string[]): string =>
  GLYPH_SVG_OPEN + paths.map((d) => `%3Cpath d='${d}'/%3E`).join("") + "%3C/svg%3E";

/**
 * A tray with an arrow going down into it: write the document. The arrow, not a
 * floppy, keeps it distinct from Ketcher's native Save As.
 */
const SAVE_GLYPH = outline(
  "M5.25 12.75V18.75H18.75V12.75",
  "M12 5.25V13",
  "M8.5 9.5L12 13L15.5 9.5",
);

/** A page with a folded corner and a plus: start an empty document. */
const NEW_GLYPH = outline(
  "M5.25 18.75V5.25H15L18.75 9V18.75H5.25",
  "M15 5.25V9H18.75",
  "M9.5 12H14.5",
  "M12 9.5V14.5",
);

/** An open tray with an arrow leaving it: write a separate file. */
const EXPORT_GLYPH = outline(
  "M5.25 14.5V18.75H18.75V14.5",
  "M12 15.5V5.25",
  "M8.25 9.25L12 5.25L15.75 9.25",
);

/** One `.Ketcher-root` rule that masks the transparent `<img>` into a glyph. */
const iconRule = (alt: string, glyph: string): string => {
  const mask = `url("${glyph}")`;

  return [
    `.Ketcher-root img[alt="${alt}"] {`,
    "  background-color: currentColor;",
    `  -webkit-mask-image: ${mask};`,
    "  -webkit-mask-position: center;",
    "  -webkit-mask-repeat: no-repeat;",
    "  -webkit-mask-size: contain;",
    `  mask-image: ${mask};`,
    "  mask-position: center;",
    "  mask-repeat: no-repeat;",
    "  mask-size: contain;",
    "}",
  ].join("\n");
};

/** Runtime stylesheet: rendered once by the app, scoped to Ketcher's root. */
export const TOOLBAR_ICON_STYLES = [
  iconRule("Save", SAVE_GLYPH),
  iconRule("New", NEW_GLYPH),
  iconRule("Export", EXPORT_GLYPH),
].join("\n");

/** Document commands, rendered by Ketcher's own top toolbar (`§5.7`). */
export const CUSTOM_BUTTONS = [
  { id: "chemistry-draw:save", imageLink: TRANSPARENT_ICON, title: "Save" },
  { id: "chemistry-draw:new", imageLink: TRANSPARENT_ICON, title: "New" },
  { id: "chemistry-draw:export", imageLink: TRANSPARENT_ICON, title: "Export" },
];
