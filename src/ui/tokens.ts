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
    /** Ketcher's `--color-background-overlay`; translucent so the editor stays visible. */
    overlay: "rgba(94,94,94,0.8)",
  },
  radius: "3px",
  borderWidth: "1px",
  shadow: "0 1px 1px rgba(202, 211, 221, 0.7)",
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
