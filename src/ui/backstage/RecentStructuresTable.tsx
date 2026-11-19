/**
 * Welcome → **Recent structures** table (`docs/architecture.md` §5.11,
 * `docs/conventions.md` §6.8).
 *
 * A compact, presentational table over the rows `App` built with
 * `loadRecentStructures`: thumbnail + name, format, size, the Indigo validation
 * badge, last modified and one **Open** action. Every value is a label the
 * loader already produced, so a row never invents a size, date, status or
 * preview. The table only renders the rows it is given (the App caps them to the
 * recent list), shows one muted loading row while the loader runs and one muted
 * `No recent structures` row for an empty list.
 */

import { useState, type CSSProperties } from "react";

import type { RecentRow } from "../../recentStructures";
import type { ValidationStatus } from "../../recentDetails";
import { tokens } from "../tokens";

export interface RecentStructuresTableProps {
  /** Rows in recent order, already capped by `App`. */
  rows: RecentRow[];
  /** True while `App` is loading the rows; shows the single loading row. */
  loading: boolean;
  /** Opens a row's document through the App's recent-open handler. */
  onOpen: (path: string) => void;
}

const TABLE: CSSProperties = {
  width: "100%",
  maxWidth: 720,
  borderCollapse: "collapse",
  borderSpacing: 0,
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  color: tokens.color.text,
};

const HEADER_CELL: CSSProperties = {
  padding: "6px 8px",
  borderBottom: `${tokens.borderWidth} solid ${tokens.color.border}`,
  background: tokens.color.surfaceSubtle,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.08em",
  lineHeight: 1.4,
  textTransform: "uppercase",
  textAlign: "left",
  whiteSpace: "nowrap",
  color: tokens.color.muted,
};

const CELL: CSSProperties = {
  padding: "4px 8px",
  height: 40,
  boxSizing: "border-box",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
};

const ROW_DIVIDER: CSSProperties = {
  borderBottom: `${tokens.borderWidth} solid ${tokens.color.border}`,
};

const META_CELL: CSSProperties = { ...CELL, color: tokens.color.textSecondary };

const THUMBNAIL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  width: 40,
  height: 32,
  boxSizing: "border-box",
  border: `${tokens.borderWidth} solid ${tokens.color.border}`,
  borderRadius: tokens.radius,
  background: tokens.color.surface,
  overflow: "hidden",
};

const THUMBNAIL_IMAGE: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain",
};

const THUMBNAIL_PLACEHOLDER: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  color: tokens.color.muted,
};

const NAME_CELL: CSSProperties = {
  ...CELL,
  minWidth: 0,
  maxWidth: 320,
};

const NAME_CONTENT: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const NAME_TEXT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const NAME: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const NAME_SUBTITLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.3,
  color: tokens.color.muted,
};

const BADGE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 6px",
  borderRadius: tokens.radius,
  fontSize: 10,
  fontWeight: 500,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
};

const BADGE_DOT: CSSProperties = {
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: "50%",
};

const OPEN_BUTTON: CSSProperties = {
  padding: "4px 6px",
  border: "none",
  borderRadius: tokens.radius,
  background: "transparent",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  fontWeight: 500,
  lineHeight: 1.4,
  color: tokens.color.accent,
  cursor: "pointer",
  outlineColor: tokens.color.accent,
  outlineOffset: 2,
};

/** Badge label and palette per status; the view never invents one. */
const BADGES: Record<ValidationStatus, { label: string; color: string; wash: string }> = {
  valid: { label: "Valid", color: tokens.color.success, wash: tokens.color.successWash },
  warnings: { label: "Warnings", color: tokens.color.warning, wash: tokens.color.warningWash },
  invalid: { label: "Invalid", color: tokens.color.error, wash: tokens.color.errorWash },
  unknown: { label: "—", color: tokens.color.muted, wash: tokens.color.surfaceSubtle },
};

/** The muted cell used for the loading and empty-list rows. */
const MESSAGE_CELL: CSSProperties = {
  padding: "12px 8px",
  fontSize: tokens.fontSize.body,
  color: tokens.color.muted,
};

const COLUMNS = 6;

/** One body row; hover paints `surfaceSubtle` across the whole row. */
function RecentStructureRow({
  row,
  last,
  onOpen,
}: {
  row: RecentRow;
  last: boolean;
  onOpen: (path: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const badge = BADGES[row.status];
  const rowStyle: CSSProperties = {
    ...(last ? null : ROW_DIVIDER),
    ...(hovered ? { background: tokens.color.surfaceSubtle } : null),
  };
  const openStyle: CSSProperties = {
    ...OPEN_BUTTON,
    ...(hovered ? { color: tokens.color.accentHover, textDecoration: "underline" } : null),
  };

  return (
    <tr
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={rowStyle}
    >
      <td style={NAME_CELL}>
        <span style={NAME_CONTENT}>
          <span aria-hidden="true" style={THUMBNAIL}>
            {row.preview === null ? (
              <span style={THUMBNAIL_PLACEHOLDER}>—</span>
            ) : (
              <img src={row.preview} alt="" style={THUMBNAIL_IMAGE} />
            )}
          </span>
          <span style={NAME_TEXT}>
            <span style={NAME} title={row.path}>
              {row.name}
            </span>
            <span style={NAME_SUBTITLE}>Ketcher document</span>
          </span>
        </span>
      </td>
      <td style={META_CELL}>{row.format}</td>
      <td style={META_CELL}>{row.sizeLabel}</td>
      <td style={CELL}>
        <span style={{ ...BADGE, color: badge.color, background: badge.wash }}>
          <span aria-hidden="true" style={{ ...BADGE_DOT, background: badge.color }} />
          {badge.label}
        </span>
      </td>
      <td style={META_CELL}>{row.modifiedLabel}</td>
      <td style={CELL}>
        <button
          type="button"
          aria-label={`Open ${row.name}`}
          onClick={() => onOpen(row.path)}
          style={openStyle}
        >
          Open
        </button>
      </td>
    </tr>
  );
}

export function RecentStructuresTable({ rows, loading, onOpen }: RecentStructuresTableProps) {
  return (
    <table aria-label="Recent structures" style={TABLE}>
      <thead>
        <tr>
          <th scope="col" style={HEADER_CELL}>
            Structure Name
          </th>
          <th scope="col" style={HEADER_CELL}>
            Format
          </th>
          <th scope="col" style={HEADER_CELL}>
            Size
          </th>
          <th scope="col" style={HEADER_CELL}>
            Indigo Validation
          </th>
          <th scope="col" style={HEADER_CELL}>
            Last Modified
          </th>
          <th scope="col" style={HEADER_CELL}>
            Actions
          </th>
        </tr>
      </thead>
      <tbody>
        {loading ? (
          <tr>
            <td colSpan={COLUMNS} style={MESSAGE_CELL}>
              Loading recent structures…
            </td>
          </tr>
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={COLUMNS} style={MESSAGE_CELL}>
              No recent structures
            </td>
          </tr>
        ) : (
          rows.map((row, index) => (
            <RecentStructureRow
              key={row.path}
              row={row}
              last={index === rows.length - 1}
              onOpen={onOpen}
            />
          ))
        )}
      </tbody>
    </table>
  );
}
