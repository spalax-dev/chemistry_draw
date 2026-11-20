/**
 * One Welcome template card (`docs/architecture.md` §5.11,
 * `docs/conventions.md` §6.8).
 *
 * The whole card is a real `<button type="button">`; its accessible name is the
 * template's library name. The preview is drawn by Ketcher itself from the
 * entry's KET and arrives as an object URL, so the card only shows the three
 * preview states: ready image, muted "Rendering…" placeholder, or a neutral
 * "No preview". Presentational only: the click handler and the render call are
 * owned by `App`/`WelcomeSection`.
 */

import { useState, type CSSProperties } from "react";

import type { LibraryTemplate, TemplateGroup } from "../../templateLibrary";
import type { TemplatePreviewState } from "./useTemplatePreview";
import { tokens } from "../tokens";

const CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  width: "100%",
  minWidth: 0,
  padding: 0,
  borderStyle: "solid",
  borderWidth: tokens.borderWidth,
  borderRadius: tokens.dialog.radius,
  background: tokens.color.surface,
  fontFamily: tokens.fontFamily,
  textAlign: "left",
  cursor: "pointer",
  overflow: "hidden",
  outlineColor: tokens.color.accent,
  outlineOffset: 2,
};

const PREVIEW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 96,
  padding: "0 8px",
  boxSizing: "border-box",
  background: tokens.color.surfacePreview,
  borderBottom: `${tokens.borderWidth} solid ${tokens.color.border}`,
  color: tokens.color.textSecondary,
};

const PREVIEW_IMAGE: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
};

const PREVIEW_PLACEHOLDER: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: tokens.color.textSecondary,
};

const PREVIEW_LOADING: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: tokens.color.textSecondary,
};

const BODY: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 10,
};

const NAME: CSSProperties = {
  fontSize: tokens.fontSize.body,
  fontWeight: 600,
  lineHeight: 1.3,
  color: tokens.color.text,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginTop: 2,
};

const GROUP: CSSProperties = {
  padding: "1px 6px",
  borderRadius: tokens.radius,
  background: tokens.color.surfaceSubtle,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: "0.04em",
  lineHeight: 1.4,
  textTransform: "uppercase",
  color: tokens.color.textSecondary,
};

const GROUP_LABELS: Record<TemplateGroup, string> = {
  "functional-group": "Functional group",
  "salt-solvent": "Salt or solvent",
};

/** The preview area: the rendered SVG, a loading hint or the neutral error line. */
function TemplatePreviewArea({ preview }: { preview?: TemplatePreviewState }) {
  if (preview?.status === "ready" && preview.url !== undefined) {
    return (
      <span style={PREVIEW}>
        <img src={preview.url} alt="" draggable={false} style={PREVIEW_IMAGE} />
      </span>
    );
  }

  const label = preview?.status === "error" ? "No preview" : "Rendering…";

  return (
    <span style={PREVIEW}>
      {preview?.status === "error" ? (
        <span style={PREVIEW_PLACEHOLDER}>{label}</span>
      ) : (
        <span style={PREVIEW_LOADING}>
          <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="42 15"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 12 12"
                to="360 12 12"
                dur="0.9s"
                repeatCount="indefinite"
              />
            </circle>
          </svg>
          <span style={PREVIEW_PLACEHOLDER}>{label}</span>
        </span>
      )}
    </span>
  );
}

export interface TemplateCardProps {
  /** The real library entry the card stands for. */
  template: LibraryTemplate;
  /** The Ketcher-rendered preview; absent while it is still being requested. */
  preview?: TemplatePreviewState;
  onTemplate: (template: LibraryTemplate) => void;
  /** True until the editor reports ready: the card cannot load a structure. */
  disabled?: boolean;
}

export function TemplateCard({
  template,
  preview,
  onTemplate,
  disabled = false,
}: TemplateCardProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      aria-label={template.name}
      aria-disabled={disabled}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (disabled) return;
        onTemplate(template);
      }}
      style={{
        ...CARD,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        borderColor: hovered && !disabled ? tokens.color.accentHover : tokens.color.border,
      }}
    >
      <TemplatePreviewArea preview={preview} />
      <span style={BODY}>
        <span style={NAME}>{template.name}</span>
        <span style={FOOTER}>
          <span style={GROUP}>{GROUP_LABELS[template.group]}</span>
        </span>
      </span>
    </button>
  );
}
