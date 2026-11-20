/**
 * Shared inline styles for the backstage section panes. Values come from
 * `tokens` only; the components never carry their own palette
 * (`docs/conventions.md` §6.2, §6.8).
 */

import type { CSSProperties } from "react";

import { tokens } from "../tokens";

export const SECTION_TITLE: CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.title,
  fontWeight: 500,
  color: tokens.color.text,
};

export const SECTION_LEAD: CSSProperties = {
  margin: "4px 0 16px",
  fontSize: tokens.fontSize.body,
  lineHeight: 1.5,
  color: tokens.color.muted,
};

export const SUBHEADING: CSSProperties = {
  margin: "20px 0 8px",
  fontSize: tokens.fontSize.title,
  fontWeight: 500,
  color: tokens.color.text,
};

/** A bordered 8 px card holding a list of rows. */
export const CARD: CSSProperties = {
  margin: "0 0 16px",
  padding: 0,
  listStyle: "none",
  border: `${tokens.borderWidth} solid ${tokens.color.border}`,
  borderRadius: tokens.dialog.radius,
  background: tokens.color.surface,
  overflow: "hidden",
};

export const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: 48,
  padding: "8px 12px",
  boxSizing: "border-box",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  color: tokens.color.text,
};

/** The 1 px divider between the rows of a card. */
export const ROW_DIVIDER = `${tokens.borderWidth} solid ${tokens.color.border}`;

export const ROW_TEXT: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

export const ROW_NAME: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const ROW_META: CSSProperties = {
  ...ROW_NAME,
  color: tokens.color.muted,
};

export const EMPTY_HINT: CSSProperties = {
  margin: "0 0 16px",
  padding: "12px 0",
  fontSize: tokens.fontSize.body,
  color: tokens.color.muted,
};

/** The Welcome actions: one horizontal row that wraps inside the 720 px pane. */
export const ACTION_LIST: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  maxWidth: 720,
};

/** A content-sized 36 px action; the row never stretches it to the pane. */
export const ACTION_BUTTON: CSSProperties = {
  justifyContent: "center",
  minHeight: 36,
};
