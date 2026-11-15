/**
 * The home button that opens the backstage. It is the first control of the tab
 * strip, before the File menu and outside the `role="tablist"`
 * (`docs/architecture.md` §5.11, `docs/conventions.md` §6.8).
 *
 * It only toggles the overlay: it never activates a tab, saves or reloads.
 */

import { useState, type CSSProperties } from "react";

import { tokens } from "./tokens";

export interface HomeButtonProps {
  onClick: () => void;
}

const BUTTON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  alignSelf: "center",
  width: 28,
  height: 26,
  padding: 0,
  border: "none",
  borderRadius: tokens.radius,
  background: "transparent",
  color: tokens.color.text,
  cursor: "pointer",
  outlineColor: tokens.color.accent,
  outlineOffset: "2px",
};

const ICON: CSSProperties = {
  flex: "0 0 auto",
  display: "block",
};

export function HomeButton({ onClick }: HomeButtonProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      aria-label="Backstage"
      title="Backstage"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...BUTTON,
        color: hovered ? tokens.color.accentHover : tokens.color.text,
      }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        width={16}
        height={16}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={ICON}
      >
        <path d="M2 7.5 8 2l6 5.5" />
        <path d="M3.5 6.5V14h9V6.5" />
        <path d="M6.5 14v-4h3v4" />
      </svg>
    </button>
  );
}
