import "ketcher-react/dist/index.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "ketcher-react";
import { RemoteStructServiceProvider, type Ketcher } from "ketcher-core";
import { message } from "@tauri-apps/plugin-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  applyExport,
  closeAfterSave,
  documentName,
  exportFileName,
  saveAsTarget,
  saveRequest,
  type CloseChoice,
  type DocumentState,
  type ExportFormat,
  type SaveOutcome,
} from "./document";
import { createAutosaveScheduler, type AutosaveScheduler } from "./autosave";
import {
  activateTab,
  activeTab,
  addTab,
  closeTab,
  commitEditor,
  createTab,
  decideTabsCloseGuard,
  dirtyTabs,
  emptyTabSet,
  EMPTY_KET,
  importedTab,
  isUntouchedTab,
  tabTitle,
  updateTab,
  type TabSet,
  type TabState,
} from "./tabs";
import {
  clearDirtyTabSnapshots,
  clearTabSnapshot,
  readTabSet,
  writeTabIndex,
  writeTabSnapshot,
} from "./tabStore";
import {
  hasFileSaverHandler,
  registerFileSaver,
  resetFileSaver,
  saveBlobAs,
  writeTextFileAt,
} from "./fileSaver";
import { routeSavedBlob } from "./saveRoute";
import { CloseGuardDialog, ErrorDialog, ExportDialog } from "./ui/DocumentDialogs";
import { EDITOR_BUTTONS } from "./ui/editorButtons";
import { TabStrip } from "./ui/TabStrip";
import { tokens } from "./ui/tokens";
import { CUSTOM_BUTTONS, TOOLBAR_ICON_STYLES } from "./ui/toolbarIcons";

/** The Save / Export helpers work on a document view of the active tab. */
function documentView(tab: TabState): DocumentState {
  return { path: tab.path, format: "ket", dirty: tab.dirty };
}

interface WindowClosePrompt {
  kind: "window";
  documentName: string;
  dirtyCount: number;
  allowSave: boolean;
}

interface TabClosePrompt {
  kind: "tab";
  documentName: string;
}

type ClosePrompt = WindowClosePrompt | TabClosePrompt;

const SIMPLE_ERRORS: Record<string, string> = {
  "already have edge between vertices":
    "The structure contains duplicate bonds. Please remove overlapping bonds and try again.",
  "Indigo load error":
    "Cannot read the structure. The data may be corrupted or in an unsupported format.",
  "Load failed": "The chemistry server is not responding. Restart the app or check the connection.",
  "Connection terminated unexpectedly":
    "The chemistry server stopped unexpectedly. Restart the app.",
};

function friendly(msg: string): string {
  for (const [key, hint] of Object.entries(SIMPLE_ERRORS)) {
    if (msg.includes(key)) return hint;
  }
  return "";
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : "unknown error";
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the Indigo API base URL.
 *
 * The sidecar reports the port it actually bound to, which may not be the
 * preferred one if that port was already in use. It also starts asynchronously,
 * so we poll until /v2/info answers.
 */
async function resolveApiBase(): Promise<string> {
  const deadline = Date.now() + 20_000;
  let port = 9321;

  while (Date.now() < deadline) {
    try {
      port = await invoke<number>("indigo_port");
    } catch {
      // Not running under Tauri (plain browser): keep the default.
    }

    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/v2/info`, 1_000);
      if (res.ok) return `http://127.0.0.1:${port}/v2/`;
    } catch {
      // Sidecar not ready yet.
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Give up and let Ketcher surface the connection error.
  return `http://127.0.0.1:${port}/v2/`;
}

function App() {
  const lastError = useRef<{ msg: string; at: number }>({ msg: "", at: 0 });
  const [ready, setReady] = useState(false);
  /** True until the silent tab restore finishes; the loading overlay stays up. */
  const [restoring, setRestoring] = useState(true);
  const [provider, setProvider] = useState<RemoteStructServiceProvider | null>(null);

  const ketcherRef = useRef<Ketcher | null>(null);
  const [tabSet, setTabSetState] = useState<TabSet>(() => emptyTabSet("tab-1"));
  const tabsRef = useRef(tabSet);
  const nextTabIdRef = useRef(1);
  /** Started before the editor initializes, resolved once it is ready. */
  const [restorePromise] = useState(() => readTabSet());

  const [exportOpen, setExportOpen] = useState(false);
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const closeChoiceRef = useRef<((choice: CloseChoice) => void) | null>(null);
  const dialogOpenRef = useRef(false);
  const busyRef = useRef(false);
  const closingRef = useRef(false);
  /** True while a programmatic `setMolecule` runs; change events are ignored. */
  const loadingRef = useRef(false);
  const schedulerRef = useRef<AutosaveScheduler | null>(null);

  /** Updates both the rendered state and the value event handlers read. */
  const setTabs = useCallback((next: TabSet) => {
    tabsRef.current = next;
    setTabSetState(next);
  }, []);

  const showError = useCallback((text: string) => setErrorText(text), []);

  const allocateTabId = useCallback(() => `tab-${nextTabIdRef.current++}`, []);

  // Keep the keydown handler aware of the dialogs without re-subscribing.
  const dialogsOpen = exportOpen || closePrompt !== null || errorText !== null;
  useEffect(() => {
    dialogOpenRef.current = dialogsOpen;
  }, [dialogsOpen]);

  useEffect(() => {
    let cancelled = false;
    resolveApiBase().then((apiBase) => {
      if (cancelled) return;
      console.info("[chemistry-draw] Indigo API:", apiBase);
      setProvider(new RemoteStructServiceProvider(apiBase));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInit = useCallback((ketcher: Ketcher) => {
    ketcherRef.current = ketcher;
    const currentOptions = ketcher.editor.options();
    ketcher.editor.options({
      ...currentOptions,
      app: { ...currentOptions.app, server: true },
    });
    setReady(true);
  }, []);

  const handleError = useCallback((raw: unknown) => {
    const msg = typeof raw === "string" ? raw : String(raw);
    console.error("Ketcher error:", msg);
    const now = Date.now();
    if (msg === lastError.current.msg && now - lastError.current.at < 5000) return;
    lastError.current = { msg, at: now };
    const hint = friendly(msg);
    const text = hint || msg;
    const title = hint ? "Structure problem" : "Error";
    message(text, { title, kind: "error" }).catch(() => {
      alert(`${title}: ${text}`);
    });
  }, []);

  // Window title mirrors the active tab and keeps `tabTitle`'s dirty marker.
  useEffect(() => {
    if (!isTauri()) return;
    getCurrentWindow()
      .setTitle(tabTitle(activeTab(tabSet)))
      .catch((error) => console.warn("[chemistry-draw] could not set the window title:", error));
  }, [tabSet]);

  /** Loads a tab's content into the one editor without marking it dirty. */
  const loadTabIntoEditor = useCallback(async (tab: TabState) => {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    loadingRef.current = true;
    try {
      await ketcher.setMolecule(tab.ket.trim().length > 0 ? tab.ket : EMPTY_KET);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const restartScheduler = useCallback(() => {
    const scheduler = schedulerRef.current;
    if (scheduler === null) return;
    scheduler.stop();
    scheduler.start();
  }, []);

  /**
   * Writes the active tab's snapshot. The tab id is captured before the
   * `getKet` await: if the active tab changes meanwhile the content belongs to
   * the new tab and is discarded instead of written into the old one.
   */
  const flushActiveTab = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    // A close prompt, a Save/switch or a programmatic load owns the editor:
    // a debounce firing now must not write a snapshot the caller is about to
    // clear or replace.
    if (closingRef.current || busyRef.current || loadingRef.current) return;

    const outgoing = activeTab(tabsRef.current);
    if (!outgoing.dirty) return;

    try {
      const ket = await ketcher.getKet();
      // The guard is re-checked after every await: a close may have started
      // while the editor serialized.
      if (closingRef.current || busyRef.current || loadingRef.current) return;
      if (tabsRef.current.activeId !== outgoing.id) return;

      // A Save may have completed while the editor serialized: that tab is
      // clean now and the pending autosave must not dirty it again.
      const current = tabsRef.current.tabs.find((tab) => tab.id === outgoing.id);
      if (!current || !current.dirty) return;

      const next = commitEditor(tabsRef.current, outgoing.id, ket);
      setTabs(next);

      const written = next.tabs.find((tab) => tab.id === outgoing.id);
      if (!written) return;
      await writeTabSnapshot(written, Date.now());
      // Do not let a flush that started before a Discard republish the index
      // after the survivors were fixed.
      if (closingRef.current || busyRef.current || loadingRef.current) return;
      await writeTabIndex(
        next.tabs.map((tab) => tab.id),
        next.activeId,
      );
    } catch (error) {
      console.warn("[chemistry-draw] autosave failed:", error);
    }
  }, [setTabs]);

  /**
   * Switches the single editor to another tab: serialize the outgoing tab,
   * flush it, load the target behind the loading flag, then activate it. The
   * outgoing dirty flag is left as-is; a programmatic load never dirties the
   * incoming tab.
   */
  const activateTabById = useCallback(
    async (id: string) => {
      const ketcher = ketcherRef.current;
      if (!ketcher || busyRef.current) return;
      if (tabsRef.current.activeId === id) return;

      const target = tabsRef.current.tabs.find((tab) => tab.id === id);
      if (!target) return;

      busyRef.current = true;
      try {
        const outgoing = activeTab(tabsRef.current);
        const ket = await ketcher.getKet();

        const committed = updateTab(tabsRef.current, outgoing.id, { ket });
        setTabs(committed);

        const outgoingTab = committed.tabs.find((tab) => tab.id === outgoing.id);
        if (outgoingTab) await writeTabSnapshot(outgoingTab, Date.now());

        await loadTabIntoEditor(target);

        const next = activateTab(tabsRef.current, id);
        setTabs(next);
        await writeTabIndex(
          next.tabs.map((tab) => tab.id),
          next.activeId,
        );
        restartScheduler();
      } catch (error) {
        loadingRef.current = false;
        showError(`Could not switch document: ${describeError(error)}`);
      } finally {
        busyRef.current = false;
      }
    },
    [loadTabIntoEditor, restartScheduler, setTabs, showError],
  );

  /** Saves the active tab; Save As asks for a destination. */
  const saveActiveTab = useCallback(
    async (mode: "save" | "save-as"): Promise<SaveOutcome> => {
      const ketcher = ketcherRef.current;
      if (!ketcher || busyRef.current) return "cancelled";

      busyRef.current = true;
      try {
        const tab = activeTab(tabsRef.current);
        const request = saveRequest(documentView(tab));
        const ket = await ketcher.getKet();

        if (!isTauri()) {
          // Browser fallback: download, and a download has no writable path.
          await saveBlobAs(new Blob([ket], { type: "application/json" }), request.path);
          setTabs(updateTab(tabsRef.current, tab.id, { ket, dirty: false }));
          return "saved";
        }

        let path = tab.path;
        if (mode === "save-as" || path === null) {
          const chosen = await saveDialog({
            title: mode === "save-as" ? "Save structure as" : "Save structure",
            defaultPath: request.path,
            filters: [
              {
                name: "Ketcher files",
                extensions: [request.extension.replace(/^\./, "")],
              },
            ],
          });
          if (chosen === null) return "cancelled";
          path = saveAsTarget(chosen);
        }

        await writeTextFileAt(path, ket);

        const next = updateTab(tabsRef.current, tab.id, { path, ket, dirty: false });
        setTabs(next);
        const saved = next.tabs.find((entry) => entry.id === tab.id);
        if (saved) await writeTabSnapshot(saved, Date.now());
        return "saved";
      } catch (error) {
        showError(
          `Could not save the document: ${describeError(error)}. Check that the folder is writable and try again.`,
        );
        return "failed";
      } finally {
        busyRef.current = false;
      }
    },
    [setTabs, showError],
  );

  /**
   * Routes a blob Ketcher asked to save through the aliased `file-saver`.
   * `.ket` writes the active tab; every other format is an export.
   */
  const saveRoutedBlob = useCallback(
    async (blob: Blob, filename: string): Promise<void> => {
      const tab = activeTab(tabsRef.current);
      const route = routeSavedBlob(filename, documentView(tab), {
        desktop: isTauri(),
        hasHandler: hasFileSaverHandler(),
      });

      switch (route.kind) {
        case "document-save": {
          let path = route.path;
          if (path === null) {
            const chosen = await saveDialog({
              title: "Save structure",
              defaultPath: route.defaultName,
              filters: [{ name: "Ketcher files", extensions: ["ket"] }],
            });
            if (chosen === null) return;
            path = saveAsTarget(chosen);
          }

          const text = await blob.text();
          await writeTextFileAt(path, text);

          const next = updateTab(tabsRef.current, tab.id, { path, ket: text, dirty: false });
          setTabs(next);
          const saved = next.tabs.find((entry) => entry.id === tab.id);
          if (saved) await writeTabSnapshot(saved, Date.now());
          return;
        }
        case "export-save":
        case "download":
          await saveBlobAs(blob, route.defaultName);
          return;
      }
    },
    [setTabs],
  );

  const askCloseChoice = useCallback(
    (prompt: ClosePrompt): Promise<CloseChoice> =>
      new Promise((resolve) => {
        closeChoiceRef.current = resolve;
        setClosePrompt(prompt);
      }),
    [],
  );

  const answerCloseChoice = useCallback((choice: CloseChoice) => {
    setClosePrompt(null);
    const resolve = closeChoiceRef.current;
    closeChoiceRef.current = null;
    resolve?.(choice);
  }, []);

  /** New always opens an empty tab; the outgoing tab is preserved, not saved. */
  const startNewDocument = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher || busyRef.current) return;

    busyRef.current = true;
    try {
      const outgoing = activeTab(tabsRef.current);
      const ket = await ketcher.getKet();
      const committed = updateTab(tabsRef.current, outgoing.id, { ket });
      setTabs(committed);

      const outgoingTab = committed.tabs.find((tab) => tab.id === outgoing.id);
      if (outgoingTab) await writeTabSnapshot(outgoingTab, Date.now());

      const tab = createTab(allocateTabId());
      await loadTabIntoEditor(tab);
      const next = addTab(tabsRef.current, tab);
      setTabs(next);

      await writeTabSnapshot(tab, Date.now());
      await writeTabIndex(
        next.tabs.map((entry) => entry.id),
        next.activeId,
      );
      restartScheduler();
    } catch (error) {
      loadingRef.current = false;
      showError(`Could not start a new document: ${describeError(error)}`);
    } finally {
      busyRef.current = false;
    }
  }, [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError]);

  /**
   * Open reuses an untouched empty tab, otherwise it opens a new one. A dirty
   * tab is never replaced and never prompts.
   */
  const openDocumentFromDisk = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher || busyRef.current) return;

    try {
      const chosen = await openDialog({
        title: "Open structure",
        multiple: false,
        filters: [
          { name: "Ketcher files", extensions: ["ket"] },
          { name: "Structures", extensions: ["mol", "smi", "inchi", "sdf", "rxn"] },
        ],
      });
      if (typeof chosen !== "string") return;

      busyRef.current = true;
      try {
        const outgoing = activeTab(tabsRef.current);
        const outgoingKet = await ketcher.getKet();
        const committed = updateTab(tabsRef.current, outgoing.id, { ket: outgoingKet });
        setTabs(committed);

        const outgoingTab = committed.tabs.find((tab) => tab.id === outgoing.id);
        if (outgoingTab) await writeTabSnapshot(outgoingTab, Date.now());

        const text = await readTextFile(chosen);
        const isKet = /\.ket$/i.test(chosen);
        const reuse = outgoingTab !== undefined && isUntouchedTab(outgoingTab);
        const targetId = reuse ? outgoing.id : allocateTabId();

        await loadTabIntoEditor({ ...createTab(targetId), ket: text });

        const next = reuse
          ? updateTab(
              tabsRef.current,
              targetId,
              isKet
                ? { path: chosen, ket: text, dirty: false }
                : { path: null, ket: text, dirty: true },
            )
          : addTab(
              tabsRef.current,
              isKet
                ? createTab(targetId, { path: chosen, ket: text })
                : importedTab(targetId, text),
            );
        setTabs(next);

        const opened = next.tabs.find((tab) => tab.id === targetId);
        if (opened) await writeTabSnapshot(opened, Date.now());
        await writeTabIndex(
          next.tabs.map((entry) => entry.id),
          next.activeId,
        );
        restartScheduler();
      } finally {
        busyRef.current = false;
      }
    } catch (error) {
      loadingRef.current = false;
      busyRef.current = false;
      showError(`Could not open the file: ${describeError(error)}`);
    }
  }, [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError]);

  const exportDocument = useCallback(
    async (format: ExportFormat) => {
      setExportOpen(false);
      const ketcher = ketcherRef.current;
      if (!ketcher) return;

      try {
        // Export is a separate file: the tab's path, format and dirty flag are
        // unchanged.
        const tab = activeTab(tabsRef.current);
        const { request } = applyExport(documentView(tab), format);
        const name = exportFileName(tab.path, request.extension);

        switch (request.source) {
          case "getMolfile": {
            const argument = request.argument === "v3000" ? "v3000" : "v2000";
            const text = await ketcher.getMolfile(argument);
            await saveBlobAs(new Blob([text], { type: "chemical/x-mdl-molfile" }), name);
            break;
          }
          case "getSmiles": {
            const text = await ketcher.getSmiles();
            await saveBlobAs(new Blob([text], { type: "chemical/x-daylight-smiles" }), name);
            break;
          }
          case "getInchi": {
            const text = await ketcher.getInchi();
            await saveBlobAs(new Blob([text], { type: "chemical/x-inchi" }), name);
            break;
          }
          case "generateImage": {
            // Render through Indigo so the blob goes to the saver; `exportImage`
            // downloads directly and only supports SVG in Ketcher 3.18.
            const outputFormat = request.argument === "svg" ? "svg" : "png";
            const ket = await ketcher.getKet();
            const image = await ketcher.generateImage(ket, { outputFormat });
            await saveBlobAs(image, name);
            break;
          }
        }
      } catch (error) {
        showError(
          `Could not export ${format.toUpperCase()}: ${describeError(error)}. Try another format or another destination.`,
        );
      }
    },
    [showError],
  );

  const destroyWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy();
    } catch (error) {
      showError(`Could not close the window: ${describeError(error)}`);
    }
  }, [showError]);

  const handleCloseRequest = useCallback(
    async (event: { preventDefault: () => void }) => {
      const set = tabsRef.current;
      const dirty = dirtyTabs(set);
      if (dirty.length === 0) return;

      event.preventDefault();
      // A second close request while the prompt or a save is running is ignored.
      if (closingRef.current || busyRef.current) return;

      closingRef.current = true;
      let stoppedScheduler = false;
      try {
        const allowSave = dirty.length === 1 && dirty[0].id === set.activeId;
        const named = allowSave ? activeTab(set) : dirty[0];
        const choice = await askCloseChoice({
          kind: "window",
          documentName: documentName(named.path),
          dirtyCount: dirty.length,
          allowSave,
        });

        const decision = decideTabsCloseGuard(tabsRef.current, choice);
        if (decision.action === "stay") return;
        if (decision.action === "discard") {
          // Freeze autosave before the cleanup: the scheduler is stopped and
          // `busyRef` turns every later flush away, so nothing re-writes the
          // snapshots and index that Discard is about to remove.
          busyRef.current = true;
          schedulerRef.current?.stop();
          stoppedScheduler = true;

          // Discard drops only the dirty documents: their snapshots go and the
          // index keeps the clean tabs, which still restore on next launch.
          const discarded = dirtyTabs(tabsRef.current).map((tab) => tab.id);
          const survivors = tabsRef.current.tabs.filter((tab) => !tab.dirty);
          await clearDirtyTabSnapshots(
            discarded,
            survivors.map((tab) => tab.id),
            tabsRef.current.activeId,
          );
          await destroyWindow();
          return;
        }
        if (decision.action === "save") {
          const outcome = await saveActiveTab("save");
          if (closeAfterSave(outcome) === "close") await destroyWindow();
        }
      } finally {
        closingRef.current = false;
        // The window normally dies after a success; if it survives (destroy
        // failed) or the close was cancelled before Discard, autosave resumes.
        if (stoppedScheduler) {
          busyRef.current = false;
          schedulerRef.current?.start();
        }
      }
    },
    [askCloseChoice, destroyWindow, saveActiveTab],
  );

  /** Closes one tab, prompting for that tab when it is dirty. */
  const closeTabById = useCallback(
    async (id: string) => {
      const tab = tabsRef.current.tabs.find((entry) => entry.id === id);
      if (!tab || busyRef.current) return;

      if (tab.dirty) {
        if (tabsRef.current.activeId !== id) await activateTabById(id);
        if (tabsRef.current.activeId !== id) return;

        const choice = await askCloseChoice({
          kind: "tab",
          documentName: documentName(tab.path),
        });
        if (choice === "cancel") return;
        if (choice === "save") {
          const outcome = await saveActiveTab("save");
          if (closeAfterSave(outcome) !== "close") return;
        }
      }

      busyRef.current = true;
      try {
        const wasActive = tabsRef.current.activeId === id;
        const next = closeTab(tabsRef.current, id, allocateTabId());
        setTabs(next);

        await clearTabSnapshot(id);
        await writeTabIndex(
          next.tabs.map((entry) => entry.id),
          next.activeId,
        );

        if (wasActive) await loadTabIntoEditor(activeTab(next));
        restartScheduler();
      } catch (error) {
        loadingRef.current = false;
        showError(`Could not close the document: ${describeError(error)}`);
      } finally {
        busyRef.current = false;
      }
    },
    [
      activateTabById,
      allocateTabId,
      askCloseChoice,
      loadTabIntoEditor,
      restartScheduler,
      saveActiveTab,
      setTabs,
      showError,
    ],
  );

  /** Cycles to the next (or previous) tab in strip order. */
  const cycleTabs = useCallback(
    (direction: 1 | -1) => {
      const set = tabsRef.current;
      if (set.tabs.length < 2) return;

      const index = set.tabs.findIndex((tab) => tab.id === set.activeId);
      const next = set.tabs[(index + direction + set.tabs.length) % set.tabs.length];
      void activateTabById(next.id);
    },
    [activateTabById],
  );

  // Restore the tab set silently once the editor exists, then show its content.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    // Also swallow any change event the editor emits while it settles, so a
    // fresh empty tab is not dirtied before the restore lands.
    loadingRef.current = true;

    void (async () => {
      try {
        const restored = await restorePromise.catch(() => null);
        if (cancelled) return;

        const set: TabSet = restored ?? emptyTabSet(allocateTabId());

        let highest = nextTabIdRef.current - 1;
        for (const tab of set.tabs) {
          const match = /^tab-(\d+)$/.exec(tab.id);
          if (match) highest = Math.max(highest, Number(match[1]));
        }
        nextTabIdRef.current = highest + 1;

        setTabs(set);

        // A snapshot can pass the validator and still fail to load (a `.ket`
        // dialog, a structure the server rejects). Drop that tab and keep the
        // app usable with the remaining tabs, or one empty tab.
        try {
          await loadTabIntoEditor(activeTab(set));
        } catch (error) {
          console.warn("[chemistry-draw] could not restore the active tab:", error);
          if (cancelled) return;

          const droppedId = set.activeId;
          const fallback = closeTab(set, droppedId, allocateTabId());
          setTabs(fallback);
          try {
            await loadTabIntoEditor(activeTab(fallback));
          } catch (inner) {
            console.warn("[chemistry-draw] could not load the fallback tab:", inner);
          }
          await clearTabSnapshot(droppedId).catch(() => undefined);
          setTabs(tabsRef.current);
        }

        await writeTabIndex(
          tabsRef.current.tabs.map((tab) => tab.id),
          tabsRef.current.activeId,
        ).catch((error) => console.warn("[chemistry-draw] could not write the tab index:", error));
      } finally {
        if (!cancelled) {
          loadingRef.current = false;
          setRestoring(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [ready, restorePromise, allocateTabId, loadTabIntoEditor, setTabs]);

  // Editor wiring: dirty tracking, per-tab autosave and the close guard.
  useEffect(() => {
    if (!ready) return;
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    const desktop = isTauri();
    const scheduler = desktop
      ? createAutosaveScheduler({
          isDirty: () => activeTab(tabsRef.current).dirty,
          write: () => void flushActiveTab(),
        })
      : null;
    schedulerRef.current = scheduler;

    const onChange = () => {
      // A programmatic load is not a user edit: never dirty the incoming tab.
      if (loadingRef.current) return;
      scheduler?.notifyChange();

      const tab = activeTab(tabsRef.current);
      if (!tab.dirty) setTabs(updateTab(tabsRef.current, tab.id, { dirty: true }));
    };

    ketcher.changeEvent.add(onChange);
    scheduler?.start();

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    if (desktop) {
      void getCurrentWindow()
        .onCloseRequested(handleCloseRequest)
        .then((stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        })
        .catch((error) => console.warn("[chemistry-draw] close guard unavailable:", error));
    }

    return () => {
      cancelled = true;
      scheduler?.stop();
      schedulerRef.current = null;
      ketcher.changeEvent.remove(onChange);
      unlisten?.();
    };
  }, [ready, handleCloseRequest, flushActiveTab, setTabs]);

  // Ketcher's native Save As and image save call the aliased `file-saver`;
  // this handler routes the blob once the editor is ready.
  useEffect(() => {
    if (!ready) return;

    registerFileSaver({
      handle: saveRoutedBlob,
      onError: (error) =>
        showError(
          `Could not save the file: ${describeError(error)}. Check that the folder is writable and try again.`,
        ),
    });

    return () => resetFileSaver();
  }, [ready, saveRoutedBlob, showError]);

  // Ketcher's top-toolbar buttons emit `CUSTOM_BUTTON_PRESSED` with the button
  // id; this listener is the single dispatcher for them (§5.9).
  useEffect(() => {
    if (!ready) return;
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    const onCustomButton = (id: unknown) => {
      if (typeof id !== "string") return;
      if (dialogOpenRef.current || busyRef.current) return;

      switch (id) {
        case "chemistry-draw:save":
          void saveActiveTab("save");
          return;
        case "chemistry-draw:new":
          void startNewDocument();
          return;
        case "chemistry-draw:export":
          setExportOpen(true);
          return;
        default:
          return;
      }
    };

    ketcher.eventBus.on("CUSTOM_BUTTON_PRESSED", onCustomButton);
    return () => {
      ketcher.eventBus.off("CUSTOM_BUTTON_PRESSED", onCustomButton);
    };
  }, [ready, saveActiveTab, startNewDocument]);

  // Document shortcuts. Ketcher binds its hotkeys on the editor container in the
  // bubble phase (`initKeydownListener`, `ketcher-react/dist/index.js`), so this
  // listener runs in the capture phase and stops the event before Ketcher sees
  // it: `preventDefault()` alone would leave its native Save As dialog opening
  // (§5.9). A matched combination is always swallowed, even while a dialog is
  // open or a save is running, so a repeated shortcut never falls through to
  // Ketcher. Only the command itself is skipped then.
  useEffect(() => {
    if (!ready) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      const key = event.key.toLowerCase();

      // Tab shortcuts never close the window while a dialog is open, but a
      // matched combination is consumed first so Ketcher cannot see it.
      if (key === "w" || key === "t") {
        event.preventDefault();
        event.stopPropagation();
        if (dialogOpenRef.current || busyRef.current) return;

        if (key === "w") void closeTabById(tabsRef.current.activeId);
        else void startNewDocument();
        return;
      }

      if (key === "tab") {
        event.preventDefault();
        event.stopPropagation();
        if (dialogOpenRef.current || busyRef.current) return;

        cycleTabs(event.shiftKey ? -1 : 1);
        return;
      }

      if (key !== "s" && key !== "o" && key !== "n") return;
      // Only Save As accepts Shift.
      if (event.shiftKey && key !== "s") return;

      event.preventDefault();
      event.stopPropagation();

      if (dialogOpenRef.current || busyRef.current) return;

      if (key === "s") void saveActiveTab(event.shiftKey ? "save-as" : "save");
      else if (key === "o") void openDocumentFromDisk();
      else void startNewDocument();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [ready, saveActiveTab, openDocumentFromDisk, startNewDocument, closeTabById, cycleTabs]);

  return (
    <>
      <style>{TOOLBAR_ICON_STYLES}</style>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          overflow: "hidden",
        }}
      >
        <TabStrip
          tabSet={tabSet}
          onActivate={(id) => void activateTabById(id)}
          onClose={(id) => void closeTabById(id)}
          onNew={() => void startNewDocument()}
        />
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {provider && (
            <Editor
              staticResourcesUrl={"."}
              structServiceProvider={provider}
              buttons={EDITOR_BUTTONS}
              errorHandler={handleError}
              onInit={handleInit}
              customButtons={CUSTOM_BUTTONS}
            />
          )}
        </div>
      </div>
      {(!provider || !ready || restoring) && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: tokens.zIndex.loading,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: tokens.fontFamily,
            color: tokens.color.muted,
            fontSize: "14px",
            background: tokens.color.surface,
          }}
        >
          Loading chemistry editor...
        </div>
      )}
      {exportOpen && (
        <ExportDialog
          onExport={(format) => void exportDocument(format)}
          onCancel={() => setExportOpen(false)}
        />
      )}
      {closePrompt !== null && (
        <CloseGuardDialog
          documentName={closePrompt.documentName}
          dirtyCount={closePrompt.kind === "window" ? closePrompt.dirtyCount : 1}
          allowSave={closePrompt.kind === "window" ? closePrompt.allowSave : true}
          onChoice={answerCloseChoice}
        />
      )}
      {errorText !== null && <ErrorDialog message={errorText} onClose={() => setErrorText(null)} />}
    </>
  );
}

export default App;
