import { useState, type ButtonHTMLAttributes, type CSSProperties } from "react";

import { tokens } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight; `danger` is reserved for destructive choices. */
  variant?: ButtonVariant;
}

const BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "28px",
  padding: "4px 12px",
  borderStyle: "solid",
  borderWidth: tokens.borderWidth,
  borderRadius: tokens.radius,
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  fontWeight: 500,
  lineHeight: 1.4,
  cursor: "pointer",
  outlineColor: tokens.color.accent,
  outlineOffset: "2px",
};

const VARIANTS: Record<ButtonVariant, { idle: CSSProperties; hover: CSSProperties }> = {
  primary: {
    idle: {
      backgroundColor: tokens.color.accent,
      borderColor: tokens.color.accent,
      color: tokens.color.surface,
    },
    hover: {
      backgroundColor: tokens.color.accentHover,
      borderColor: tokens.color.accentHover,
    },
  },
  secondary: {
    idle: {
      backgroundColor: tokens.color.surface,
      borderColor: tokens.color.border,
      color: tokens.color.textSecondary,
    },
    hover: {
      backgroundColor: tokens.color.surfaceSubtle,
      borderColor: tokens.color.border,
    },
  },
  danger: {
    idle: {
      backgroundColor: tokens.color.surface,
      borderColor: tokens.color.error,
      color: tokens.color.error,
    },
    hover: {
      backgroundColor: tokens.color.errorWash,
      borderColor: tokens.color.error,
    },
  },
};

/** An in-app button; always a real `<button type="button">` with a label. */
export function Button({ variant = "secondary", disabled, style, ...rest }: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const palette = VARIANTS[variant];
  const active = hovered && !disabled;

  return (
    <button
      {...rest}
      type="button"
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        ...BASE,
        ...palette.idle,
        ...(active ? palette.hover : null),
        // Pressed state: Ketcher's `--color-accent-active`.
        ...(active && pressed && variant === "primary"
          ? {
              backgroundColor: tokens.color.accentActive,
              borderColor: tokens.color.accentActive,
            }
          : null),
        ...(disabled ? { opacity: 0.55, cursor: "not-allowed" } : null),
        ...style,
      }}
    />
  );
}
