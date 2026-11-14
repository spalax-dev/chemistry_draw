/**
 * The document tab strip: the only app-rendered chrome above Ketcher
 * (`docs/conventions.md` §6.6). It manages tabs only — it never mounts a second
 * editor and never runs a document command.
 *
 * Labels come from `tabTitle` without its `*`: the strip shows a dirty dot
 * instead, while the window title and dialog copy keep the asterisk.
 */

import { useRef, useState, type CSSProperties } from "react";

import { tabTitle, type TabSet, type TabState } from "../tabs";
import { tokens } from "./tokens";

export interface TabStripProps {
  tabSet: TabSet;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

const STRIP: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 0,
  flex: "0 0 auto",
  height: 36,
  boxSizing: "border-box",
  padding: "4px 6px 0",
  background: tokens.tab.content,
  boxShadow: `inset 0 -1px 0 ${tokens.tab.border}`,
  overflowX: "auto",
  overflowY: "hidden",
  flexWrap: "nowrap",
  whiteSpace: "nowrap",
  fontFamily: tokens.fontFamily,
  fontSize: tokens.tab.fontSize,
};

const LABEL: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const DOT: CSSProperties = {
  display: "inline-block",
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: tokens.tab.radius,
  background: tokens.tab.dirty,
};

/** The visible title: `tabTitle` minus its dirty asterisk. */
function stripLabel(tab: TabState): string {
  return tabTitle(tab).replace(/\*$/, "");
}

interface TabItemProps {
  tab: TabState;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  /** ArrowLeft/ArrowRight move the roving focus to the neighbouring tab. */
  onNavigate: (direction: 1 | -1) => void;
  register: (node: HTMLDivElement | null) => void;
}

function TabItem({ tab, active, onActivate, onClose, onNavigate, register }: TabItemProps) {
  const [hovered, setHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const label = stripLabel(tab);
  const closeVisible = active || hovered || closeHovered;

  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    position: "relative",
    flex: "0 0 auto",
    maxWidth: 220,
    minWidth: 0,
    height: "100%",
    padding: "0 6px 0 10px",
    boxSizing: "border-box",
    borderTop: `${tokens.borderWidth} solid ${tokens.tab.border}`,
    borderLeft: `${tokens.borderWidth} solid ${tokens.tab.border}`,
    borderRight: `${tokens.borderWidth} solid ${tokens.tab.border}`,
    // Inactive tabs draw the separator under their own width; the active tab is
    // the white workspace and must leave the line open (`docs/conventions.md` §6.6).
    borderBottom: active ? "none" : `${tokens.borderWidth} solid ${tokens.tab.border}`,
    borderTopLeftRadius: tokens.tab.radius,
    borderTopRightRadius: tokens.tab.radius,
    background: active ? tokens.tab.active : tokens.tab.regular,
    color: hovered && !active ? tokens.tab.hover : tokens.tab.text,
    fontWeight: active ? 500 : 400,
    cursor: "pointer",
    userSelect: "none",
  };

  return (
    <div
      ref={register}
      role="tab"
      aria-selected={active}
      aria-label={tab.dirty ? `${label}, unsaved changes` : label}
      tabIndex={active ? 0 : -1}
      title={tab.dirty ? `${label} — unsaved changes` : label}
      style={style}
      onClick={onActivate}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          onNavigate(event.key === "ArrowRight" ? 1 : -1);
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onActivate();
      }}
    >
      <span style={LABEL}>{label}</span>
      {tab.dirty ? <span aria-hidden="true" style={DOT} /> : null}
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        onMouseEnter={() => setCloseHovered(true)}
        onMouseLeave={() => setCloseHovered(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
          width: 16,
          height: 16,
          padding: 0,
          border: "none",
          background: "transparent",
          borderRadius: tokens.tab.radius,
          color: closeHovered ? tokens.tab.hover : tokens.tab.text,
          fontSize: 14,
          lineHeight: 1,
          cursor: "pointer",
          opacity: closeVisible ? 1 : 0,
          pointerEvents: closeVisible ? "auto" : "none",
        }}
      >
        ×
      </button>
    </div>
  );
}

function NewTabButton({ onNew }: { onNew: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      aria-label="New tab"
      title="New tab"
      onClick={onNew}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: "0 0 auto",
        alignSelf: "center",
        width: 28,
        height: 26,
        marginLeft: 4,
        padding: 0,
        border: "none",
        background: "transparent",
        borderRadius: tokens.tab.radius,
        color: hovered ? tokens.tab.hover : tokens.tab.text,
        fontSize: 18,
        lineHeight: 1,
        cursor: "pointer",
      }}
    >
      +
    </button>
  );
}

/** Top-of-window tab strip; the editor keeps the remaining height. */
export function TabStrip({ tabSet, onActivate, onClose, onNew }: TabStripProps) {
  const nodes = useRef(new Map<string, HTMLDivElement>());

  /** Roving tabindex: focus and activate the neighbour, wrapping at the ends. */
  const navigate = (id: string, direction: 1 | -1) => {
    const index = tabSet.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const next = tabSet.tabs[(index + direction + tabSet.tabs.length) % tabSet.tabs.length];
    nodes.current.get(next.id)?.focus();
    onActivate(next.id);
  };

  return (
    <div role="tablist" aria-label="Documents" style={STRIP}>
      {tabSet.tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          active={tab.id === tabSet.activeId}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
          onNavigate={(direction) => navigate(tab.id, direction)}
          register={(node) => {
            if (node === null) nodes.current.delete(tab.id);
            else nodes.current.set(tab.id, node);
          }}
        />
      ))}
      <NewTabButton onNew={onNew} />
    </div>
  );
}
