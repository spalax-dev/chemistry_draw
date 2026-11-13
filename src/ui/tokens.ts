/**
 * Ketcher design tokens for the in-app dialogs. This is the only palette the
 * document UI may use; see `docs/conventions.md` §6.2.
 */
export const tokens = {
  color: {
    accent: "#167782",
    accentHover: "#00838f",
    accentActive: "#005662",
    error: "#ff4a4a",
    /** Wash under a hovered danger button. */
    errorWash: "rgba(255,74,74,0.08)",
    text: "#333",
    textSecondary: "#585858",
    muted: "#7c7c7f",
    border: "#cad3dd",
    surface: "#ffffff",
    surfaceSubtle: "#eff2f5",
    page: "#f5f5f5",
    /** Ketcher's `.Modal-module_modalOverlay`; translucent so the editor stays visible. */
    overlay: "rgba(94,94,94,0.2)",
    /** Ketcher's `.Modal-module_hide`; the pre-fade state the overlay mounts at. */
    overlayHidden: "rgba(94,94,94,0.01)",
  },
  /** Generic surfaces (buttons); dialogs use the `dialog` tokens below. */
  radius: "3px",
  borderWidth: "1px",
  shadow: "0 1px 1px rgba(202, 211, 221, 0.7)",
  /** Ketcher's `.Dialog-module_dialog` surface and `.Modal-module_animate` fade. */
  dialog: {
    radius: "8px",
    border: "none",
    shadow: "none",
    transition: "background-color 0.3s",
    /**
     * Ketcher's `.Modal-module_modalOverlay` in ketcher-react: a 10×10 SVG tile of
     * diagonal hairlines at 2% opacity, URI-escaped exactly as Ketcher ships it.
     */
    backdropPattern:
      "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Cpath d='M0 10 10 0zm12-2-4 4zM-2 2l4-4z' stroke='%23555' stroke-width='2' stroke-opacity='.02'/%3E%3C/svg%3E",
    backdropRepeat: "repeat",
    backdropSize: "10px 10px",
  },
  fontFamily: "Roboto, Helvetica, Arial, sans-serif",
  fontSize: {
    title: "14px",
    body: "12px",
  },
  zIndex: {
    overlay: 1000,
    loading: 9999,
  },
} as const;

export type Tokens = typeof tokens;
