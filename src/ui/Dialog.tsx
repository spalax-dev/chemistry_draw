import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { tokens } from "./tokens";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface DialogProps {
  /** Visible title; also labels the dialog for assistive technology. */
  title: string;
  children?: ReactNode;
  /** Action row content, normally `Button` elements. */
  actions?: ReactNode;
  /** Called on Escape; the caller applies its least-destructive choice. */
  onCancel: () => void;
  width?: number | string;
}

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: tokens.zIndex.overlay,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  boxSizing: "border-box",
  backgroundImage: `url("${tokens.dialog.backdropPattern}")`,
  backgroundRepeat: tokens.dialog.backdropRepeat,
  backgroundSize: tokens.dialog.backdropSize,
  transition: tokens.dialog.transition,
};

/**
 * A modal in-app dialog rendered above the editor (Ketcher stays mounted).
 * Focus moves in on open, cycles inside it while open and returns to the
 * previously focused element on close.
 */
export function Dialog({ title, children, actions, onCancel, width = 420 }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  /** Starts at Ketcher's hidden wash and fades in after the first paint. */
  const [overlayVisible, setOverlayVisible] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setOverlayVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      const initial =
        panel.querySelector<HTMLElement>('[data-autofocus="true"]') ??
        panel.querySelector<HTMLElement>(FOCUSABLE) ??
        panel;
      initial.focus();
    }
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function focusableElements(): HTMLElement[] {
    const panel = panelRef.current;
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }

    if (event.key !== "Tab") return;

    const items = focusableElements();
    const panel = panelRef.current;
    if (items.length === 0) {
      event.preventDefault();
      panel?.focus();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    const inside = panel !== null && current !== null && panel.contains(current);

    if (event.shiftKey && (!inside || current === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!inside || current === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      style={{
        ...OVERLAY,
        backgroundColor: overlayVisible ? tokens.color.overlay : tokens.color.overlayHidden,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{
          width,
          maxWidth: "100%",
          boxSizing: "border-box",
          backgroundColor: tokens.color.surface,
          border: tokens.dialog.border,
          borderRadius: tokens.dialog.radius,
          boxShadow: tokens.dialog.shadow,
          fontFamily: tokens.fontFamily,
          color: tokens.color.text,
        }}
      >
        <div style={{ padding: "20px 20px 0" }}>
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: tokens.fontSize.title,
              fontWeight: 500,
              color: tokens.color.text,
            }}
          >
            {title}
          </h2>
          {children ? (
            <div style={{ marginTop: "8px", fontSize: tokens.fontSize.body, lineHeight: 1.5 }}>
              {children}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              marginTop: "16px",
              padding: "12px 20px",
              backgroundColor: tokens.color.surfaceSubtle,
              borderTop: `${tokens.borderWidth} solid ${tokens.color.border}`,
              borderBottomLeftRadius: tokens.dialog.radius,
              borderBottomRightRadius: tokens.dialog.radius,
            }}
          >
            {actions}
          </div>
        ) : (
          <div style={{ height: "20px" }} />
        )}
      </div>
    </div>
  );
}
