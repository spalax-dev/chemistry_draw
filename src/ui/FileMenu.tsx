/**
 * The File button and its popup at the left of the document tab strip
 * (`docs/architecture.md` §5.9, `docs/conventions.md` §6.5).
 *
 * Presentational only: it renders `FILE_MENU_ITEMS` and the recent list and
 * reports the chosen id or path; `App` owns the actions.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { FILE_MENU_ITEMS, RECENT_SECTION_LABEL, type FileMenuId } from "../fileMenu";
import { recentName } from "../recent";
import { tokens } from "./tokens";

/** Props of the File button and its popup. */
export interface FileMenuProps {
  /** Absolute `.ket` paths, newest first. */
  recent: string[];
  /** Runs a command from `FILE_MENU_ITEMS`. */
  onAction: (id: FileMenuId) => void;
  /** Opens a remembered document. */
  onOpenRecent: (path: string) => void;
  disabled?: boolean;
  /** Controlled open state; omit to let the component own it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const WRAPPER: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "center",
  flex: "0 0 auto",
};

const TRIGGER: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  height: 28,
  padding: "0 10px",
  boxSizing: "border-box",
  border: "none",
  borderRadius: tokens.radius,
  background: "transparent",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  lineHeight: 1,
  cursor: "pointer",
  outlineColor: tokens.color.accent,
  outlineOffset: "2px",
};

/** The trigger icon never shrinks; it inherits the button colour. */
const TRIGGER_ICON: CSSProperties = {
  flex: "0 0 auto",
  display: "block",
};

/** Minimum popup width; the trigger is narrower than a menu row needs. */
const POPUP_MIN_WIDTH = 220;

/** Gap between the File button's bottom edge and the popup. */
const POPUP_GAP = 4;

/** Keeps the popup inside the window on every edge. */
const VIEWPORT_MARGIN = 8;

interface PopupPosition {
  top: number;
  left: number;
}

const POPUP: CSSProperties = {
  // The strip clips vertically (`overflowY: hidden`), so the popup cannot be an
  // absolutely positioned child: it is fixed and placed from the button's
  // viewport rect (`docs/conventions.md` §6.5).
  position: "fixed",
  minWidth: POPUP_MIN_WIDTH,
  padding: "6px 0",
  boxSizing: "border-box",
  background: tokens.color.surface,
  border: `${tokens.borderWidth} solid ${tokens.color.border}`,
  borderRadius: tokens.dialog.radius,
  boxShadow: tokens.shadow,
  zIndex: tokens.zIndex.overlay,
  textAlign: "left",
};

const ITEM: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "7px 12px",
  boxSizing: "border-box",
  border: "none",
  background: "transparent",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  lineHeight: 1.4,
  color: tokens.color.text,
  textAlign: "left",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "pointer",
  outlineColor: tokens.color.accent,
  outlineOffset: "-2px",
};

const SEPARATOR: CSSProperties = {
  height: 0,
  margin: "6px 0",
  borderTop: `${tokens.borderWidth} solid ${tokens.color.border}`,
};

const HEADING: CSSProperties = {
  padding: "6px 12px 4px",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  fontWeight: 600,
  lineHeight: 1.4,
  color: tokens.color.muted,
};

const EMPTY: CSSProperties = {
  padding: "4px 12px",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.fontSize.body,
  lineHeight: 1.4,
  color: tokens.color.muted,
  fontStyle: "italic",
};

/** A File button that opens the command menu below itself. */
/**
 * The File button and popup. It renders `FILE_MENU_ITEMS` and the recent list
 * and reports the chosen id or path; it never runs a document command itself.
 */
export function FileMenu({
  recent,
  onAction,
  onOpenRecent,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: FileMenuProps) {
  const menuId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<"first" | "last" | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const [triggerHovered, setTriggerHovered] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // Controlled by `App` so a keyboard shortcut can dismiss the menu; standalone
  // use keeps the internal state.
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  /** Places the popup under the button, clamped inside the viewport. */
  const placePopup = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const maxLeft = window.innerWidth - POPUP_MIN_WIDTH - VIEWPORT_MARGIN;
    setPosition({
      top: rect.bottom + POPUP_GAP,
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
    });
  }, []);

  const changeOpen = useCallback(
    (next: boolean) => {
      if (next) placePopup();
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange, placePopup],
  );

  /** Focusable menu entries, skipping the disabled empty hint. */
  function menuItems(): HTMLElement[] {
    const menu = menuRef.current;
    if (!menu) return [];
    return Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
    );
  }

  function moveFocus(delta: number): void {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

  function focusEdge(edge: "first" | "last"): void {
    const items = menuItems();
    const target = edge === "first" ? items[0] : items[items.length - 1];
    target?.focus();
  }

  // A controlled open (e.g. a parent toggling it) still needs a position.
  useEffect(() => {
    if (open && position === null) placePopup();
  }, [open, position, placePopup]);

  // Runs after the first render that mounts the popup, so keyboard opening can
  // land on the requested edge.
  useEffect(() => {
    if (!open) return;
    const edge = pendingFocus.current;
    pendingFocus.current = null;
    if (!edge) return;

    const menu = menuRef.current;
    const items = menu
      ? Array.from(
          menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
        )
      : [];
    const target = edge === "first" ? items[0] : items[items.length - 1];
    target?.focus();
  }, [open]);

  // A pointer press outside the trigger and its popup closes the menu. The
  // popup is not a DOM descendant of the wrapper (it is fixed), so both are
  // checked.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Node)) return;
      const insideTrigger = wrapperRef.current?.contains(event.target) ?? false;
      const insidePopup = menuRef.current?.contains(event.target) ?? false;
      if (insideTrigger || insidePopup) return;
      changeOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open, changeOpen]);

  // A resize moves the button, so the fixed popup follows it.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", placePopup);
    return () => window.removeEventListener("resize", placePopup);
  }, [open, placePopup]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) return;

    // Enter/Space are the native button activation keys: open the menu and land
    // on the first item (`docs/conventions.md` §6.5.1). `preventDefault` stops
    // the synthetic click that would otherwise toggle the menu shut again.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        changeOpen(false);
      } else {
        pendingFocus.current = "first";
        changeOpen(true);
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const edge = event.key === "ArrowDown" ? "first" : "last";
      if (!open) {
        pendingFocus.current = edge;
        changeOpen(true);
      } else {
        focusEdge(edge);
      }
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      changeOpen(false);
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        changeOpen(false);
        buttonRef.current?.focus();
        break;
      case "Tab":
        // Tab leaves the menu instead of cycling inside it.
        changeOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        focusEdge("first");
        break;
      case "End":
        event.preventDefault();
        focusEdge("last");
        break;
      default:
        break;
    }
  }

  function select(closeAndRun: () => void): void {
    closeAndRun();
    changeOpen(false);
  }

  return (
    <div ref={wrapperRef} style={WRAPPER}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => changeOpen(!open)}
        onKeyDown={handleTriggerKeyDown}
        onMouseEnter={() => setTriggerHovered(true)}
        onMouseLeave={() => setTriggerHovered(false)}
        style={{
          ...TRIGGER,
          color: triggerHovered && !disabled ? tokens.color.accentHover : tokens.color.text,
          ...(disabled ? { opacity: 0.55, cursor: "not-allowed" } : null),
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
          style={TRIGGER_ICON}
        >
          <path d="M4 1.5h5L12.5 5v9.5H4z" />
          <path d="M9 1.5V5h3.5" />
        </svg>
        File
      </button>

      {open && position ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="File"
          onKeyDown={handleMenuKeyDown}
          style={{
            ...POPUP,
            top: position.top,
            left: position.left,
            // A long list or a short window must scroll, never run off-screen.
            maxHeight: `calc(100vh - ${position.top}px - ${VIEWPORT_MARGIN}px)`,
            overflowY: "auto",
          }}
        >
          {FILE_MENU_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => select(() => onAction(item.id))}
              onMouseEnter={() => setHoveredKey(item.id)}
              onMouseLeave={() => setHoveredKey(null)}
              style={{
                ...ITEM,
                ...(hoveredKey === item.id ? { background: tokens.color.surfaceSubtle } : null),
              }}
            >
              {item.label}
            </button>
          ))}

          <div role="separator" style={SEPARATOR} />

          <div role="presentation" style={HEADING}>
            {RECENT_SECTION_LABEL}
          </div>

          {recent.length === 0 ? (
            <div role="menuitem" aria-disabled="true" style={EMPTY}>
              No recent documents
            </div>
          ) : (
            recent.map((path) => {
              const name = recentName(path);
              return (
                <button
                  key={path}
                  type="button"
                  role="menuitem"
                  aria-label={`${RECENT_SECTION_LABEL}: ${name}`}
                  title={path}
                  onClick={() => select(() => onOpenRecent(path))}
                  onMouseEnter={() => setHoveredKey(path)}
                  onMouseLeave={() => setHoveredKey(null)}
                  style={{
                    ...ITEM,
                    ...(hoveredKey === path ? { background: tokens.color.surfaceSubtle } : null),
                  }}
                >
                  {name}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
