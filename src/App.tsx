import "ketcher-react/dist/index.css";
import "./overrides.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "ketcher-react";
import { type CheckTypes, type Ketcher } from "ketcher-core";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

import packageJson from "../package.json";
import {
  applyExport,
  closeAfterSave,
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
  ALREADY_OPEN_MESSAGE,
  canSaveToPath,
  closeTab,
  commitEditor,
  createTab,
  decideTabsCloseGuard,
  dirtyTabs,
  emptyTabSet,
  EMPTY_KET,
  importedTab,
  isEmptyCanvasKet,
  isUntouchedTab,
  newDocumentTarget,
  pathBaseName,
  resolveOpenTarget,
  tabDisplayName,
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
import { describeError, errorMessage, isModelUnavailable } from "./recognizeErrors";
import {
  cancelActiveTool,
  openStructureLibrary,
  resolveApiBase,
  StaleSafeStructServiceProvider,
  useLibraryTemplates,
  type IndigoInfo,
} from "./ketcherOptions";
import { CloseGuardDialog, ErrorDialog, ExportDialog, NoticeDialog } from "./ui/DocumentDialogs";
import { ModelSetupDialog, useModelSetup } from "./ui/ModelSetupDialog";
import { Backstage } from "./ui/Backstage";
import { FileMenu } from "./ui/FileMenu";
import { TabStrip } from "./ui/TabStrip";
import { EDITOR_BUTTONS } from "./ui/editorButtons";
import { CUSTOM_BUTTONS, TOOLBAR_ICON_STYLES } from "./ui/toolbarIcons";
import { addRecent, loadRecent, removeRecent, saveRecent } from "./recent";
import { loadRecentStructures, type RecentRow } from "./recentStructures";
import { previewKetWithoutSgroups, type LibraryTemplate } from "./templateLibrary";
import type { FileMenuId } from "./fileMenu";

/** The Save / Export helpers work on a document view of the active tab. */
function documentView(tab: TabState): DocumentState {
  return { path: tab.path, format: "ket", dirty: tab.dirty };
}

/** Default Save As name: the current path, the imported source name, else `untitled`. */
function saveDefaultPath(tab: TabState, extension: string): string {
  return tab.path ?? `${tab.name ?? "untitled"}${extension}`;
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

/** Check types the Recent structures validation asks Indigo for. */
const RECENT_CHECK_TYPES: CheckTypes[] = [
  "valence",
  "radicals",
  "pseudoatoms",
  "stereo",
  "query",
  "overlapping_atoms",
  "overlapping_bonds",
  "rgroups",
  "chiral",
  "3d",
];

function App() {
  const lastError = useRef<{ msg: string; at: number }>({ msg: "", at: 0 });
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<StaleSafeStructServiceProvider | null>(null);
  /** The backstage is the start surface, so every launch begins here. */
  const [backstageOpen, setBackstageOpen] = useState(true);
  const [indigoInfo, setIndigoInfo] = useState<IndigoInfo>({ version: null, port: null });
  /** The resolved sidecar base (`http://127.0.0.1:<port>/v2/`), null until ready. */
  const [apiBase, setApiBase] = useState<string | null>(null);

  const ketcherRef = useRef<Ketcher | null>(null);

  const [tabSet, setTabSetState] = useState<TabSet>(() => emptyTabSet("tab-1"));
  const tabsRef = useRef(tabSet);
  const nextTabIdRef = useRef(1);
  /** Started before the editor initializes, resolved once it is ready. */
  const [restorePromise] = useState(() => readTabSet());

  /** Remembered `.ket` paths, newest first. */
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const recentRef = useRef<string[]>(recent);
  /** Welcome's Recent structures rows and their in-flight flag. */
  const [recentRows, setRecentRows] = useState<RecentRow[]>([]);
  const [recentRowsLoading, setRecentRowsLoading] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  /** Already-open notice; the caller supplies title and message. */
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

  const closeChoiceRef = useRef<((choice: CloseChoice) => void) | null>(null);
  const dialogOpenRef = useRef(false);
  const busyRef = useRef(false);
  const closingRef = useRef(false);
  /** The File popup is open; keyboard shortcuts close it like a dialog. */
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuOpenRef = useRef(false);
  /** True while a programmatic `setMolecule` runs; change events are ignored. */
  const loadingRef = useRef(false);
  const schedulerRef = useRef<AutosaveScheduler | null>(null);

  const apiBaseRef = useRef<string | null>(null);

  // Model setup is owned by its controller hook so the dialog, its fetch/poll
  // loop and the Recognize capability sync stay together. The backstage Models
  // rail and the toolbar entry both call `openModels`.
  const {
    modelsOpen,
    modelStatus,
    modelVerify,
    modelAttention,
    modelError,
    modelBusy,
    modelsVisible,
    openModels,
    closeModels,
    refreshModelStatus,
    handleModelPrimary,
    cancelModels,
    verifyModelFiles,
    reportModelUnavailable,
  } = useModelSetup({
    ready,
    apiBase,
    apiBaseRef,
    ketcherRef,
    errorOpen: error !== null,
  });

  // The real Structure Library load is deferred until Ketcher is ready and
  // retried when an empty build coincides with a later backstage open.
  const { templates } = useLibraryTemplates(ready, backstageOpen);

  /** Updates both the rendered state and the value event handlers read. */
  const setTabs = useCallback((next: TabSet) => {
    tabsRef.current = next;
    setTabSetState(next);
  }, []);

  const showError = useCallback(
    (text: string, title = "Error") => setError({ title, message: text }),
    [],
  );

  /** Applies a recent-list change, persists it, and repaints the menu. */
  const updateRecent = useCallback((transform: (list: string[]) => string[]) => {
    const next = transform(recentRef.current);
    recentRef.current = next;
    saveRecent(next);
    setRecent(next);
  }, []);

  const allocateTabId = useCallback(() => `tab-${nextTabIdRef.current++}`, []);

  /** Keeps the rendered File menu and the shortcut handler in sync. */
  const handleFileMenuOpenChange = useCallback((open: boolean) => {
    fileMenuOpenRef.current = open;
    setFileMenuOpen(open);
  }, []);

  // The backstage counts as a dialog: a document shortcut never fires behind it.
  const dialogsOpen =
    backstageOpen ||
    modelsOpen ||
    exportOpen ||
    closePrompt !== null ||
    error !== null ||
    notice !== null;
  useEffect(() => {
    dialogOpenRef.current = dialogsOpen;
  }, [dialogsOpen]);

  useEffect(() => {
    let cancelled = false;
    resolveApiBase().then(({ apiBase: base, info }) => {
      if (cancelled) return;
      console.info("[chemistry-draw] Indigo API:", base);
      apiBaseRef.current = base;
      setApiBase(base);
      setProvider(new StaleSafeStructServiceProvider(base));
      setIndigoInfo(info);
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

  // Hide the Models toolbar wrapper in place (keeping its event intact) on a
  // healthy install; a short bounded retry covers the post-init paint.
  useEffect(() => {
    if (!ready) return;

    const apply = (): boolean => {
      const image = document.querySelector('.Ketcher-root img[alt="Models"]');
      const button = image?.closest("button");
      if (!(button instanceof HTMLElement)) return false;
      button.style.display = modelsVisible ? "" : "none";
      return true;
    };

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryApply = () => {
      if (apply()) return;
      attempts += 1;
      if (attempts > 20) {
        console.warn(
          "[chemistry-draw] could not find the Models toolbar control; " +
            "leaving it as Ketcher rendered it.",
        );
        return;
      }
      timer = setTimeout(tryApply, 50);
    };

    tryApply();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [ready, modelsVisible]);

  /** Builds Welcome's Recent structures rows while the backstage is open. */
  useEffect(() => {
    if (!backstageOpen) return;

    const ketcher = ketcherRef.current;
    if (!isTauri() || !ready || apiBase === null || !ketcher) {
      setRecentRows([]);
      setRecentRowsLoading(false);
      return;
    }

    let cancelled = false;
    setRecentRowsLoading(true);

    void loadRecentStructures(recent, {
      apiBase,
      check: (molfile) =>
        ketcher.structService.check({ struct: molfile, types: RECENT_CHECK_TYPES }),
    })
      .then((rows) => {
        if (!cancelled) setRecentRows(rows);
      })
      .catch((error) => {
        console.warn("[chemistry-draw] could not load the recent structures:", error);
        if (!cancelled) setRecentRows([]);
      })
      .finally(() => {
        if (!cancelled) setRecentRowsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [backstageOpen, recent, ready, apiBase]);

  /** Renders one entry's SGroup-free copy to a preview URL; insertion keeps the original. */
  const renderTemplatePreview = useCallback(async (ket: string): Promise<string> => {
    const ketcher = ketcherRef.current;
    if (!ketcher) throw new Error("The editor is not ready to render a template preview.");
    const previewKet = previewKetWithoutSgroups(ket);
    const image = await ketcher.generateImage(previewKet, { outputFormat: "svg" });
    return URL.createObjectURL(image);
  }, []);

  const handleError = useCallback(
    (raw: unknown) => {
      const msg = typeof raw === "string" ? raw : String(raw);
      console.error("Ketcher error:", msg);
      const now = Date.now();
      if (msg === lastError.current.msg && now - lastError.current.at < 5000) return;
      lastError.current = { msg, at: now };
      const described = describeError(raw);
      showError(described.message, described.title);
      // A corrupt-but-present artifact keeps `ready: true` (a status read never
      // hashes), so recognition is the only signal that the install needs a
      // repair. Force the Models control until health is proven.
      if (isModelUnavailable(raw)) reportModelUnavailable();
    },
    [reportModelUnavailable, showError],
  );

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

  /** Writes the active tab's snapshot unless a command or load owns the editor. */
  const flushActiveTab = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    // A prompt, save/switch or load owns the editor; a debounce must not write.
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

  /** Serializes, flushes and activates another tab; a load never dirties it. */
  const activateTabById = useCallback(
    async (id: string) => {
      const ketcher = ketcherRef.current;
      if (!ketcher || busyRef.current) return;
      if (tabsRef.current.activeId === id) return;

      const target = tabsRef.current.tabs.find((tab) => tab.id === id);
      if (!target) return;

      // An armed template tool must not follow the pointer onto the tab that is
      // about to be loaded.
      cancelActiveTool(ketcher);

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
        showError(`Could not switch document: ${errorMessage(error)}`);
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
            defaultPath: saveDefaultPath(tab, request.extension),
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

        // A path owned by another tab is refused before the write; the active
        // tab's own path still saves.
        if (!canSaveToPath(tabsRef.current, path, tab.id)) {
          setNotice({ title: "Already open", message: ALREADY_OPEN_MESSAGE });
          return "cancelled";
        }

        await writeTextFileAt(path, ket);
        updateRecent((list) => addRecent(list, path));

        const next = updateTab(tabsRef.current, tab.id, { path, ket, dirty: false });
        setTabs(next);
        const saved = next.tabs.find((entry) => entry.id === tab.id);
        if (saved) await writeTabSnapshot(saved, Date.now());
        return "saved";
      } catch (error) {
        showError(
          `Could not save the document: ${errorMessage(error)}. Check that the folder is writable and try again.`,
        );
        return "failed";
      } finally {
        busyRef.current = false;
      }
    },
    [setTabs, showError, updateRecent],
  );

  /** Routes a Ketcher save blob: `.ket` writes the tab, anything else exports. */
  const saveRoutedBlob = useCallback(
    async (blob: Blob, filename: string): Promise<void> => {
      const tab = activeTab(tabsRef.current);
      const route = routeSavedBlob(filename, documentView(tab), {
        desktop: isTauri(),
        hasHandler: hasFileSaverHandler(),
      });

      switch (route.kind) {
        case "document-save": {
          // Dormant while native Save As is hidden: the app's Save path
          // enforces `canSaveToPath`, and this branch only runs when Ketcher's
          // own save handler is reachable.
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
          updateRecent((list) => addRecent(list, path));

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
    [setTabs, updateRecent],
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

  /** New reuses an untouched empty tab; any document or edit opens a new one. */
  const startNewDocument = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher || busyRef.current) return;

    busyRef.current = true;
    try {
      const outgoing = activeTab(tabsRef.current);
      const target = newDocumentTarget(tabsRef.current);

      if (target.kind === "reuse") {
        // The reused tab is empty by definition; reload only if the canvas
        // still carries a structure, behind the loading flag.
        if (!isEmptyCanvasKet(await ketcher.getKet())) {
          loadingRef.current = true;
          try {
            await ketcher.setMolecule(EMPTY_KET);
          } finally {
            loadingRef.current = false;
          }
        }

        const next = updateTab(tabsRef.current, target.tabId, {
          path: null,
          name: null,
          dirty: false,
          ket: EMPTY_KET,
        });
        setTabs(next);

        const reused = next.tabs.find((tab) => tab.id === target.tabId);
        if (reused) await writeTabSnapshot(reused, Date.now());
        await writeTabIndex(
          next.tabs.map((entry) => entry.id),
          next.activeId,
        );
        restartScheduler();
        return;
      }

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
      showError(`Could not start a new document: ${errorMessage(error)}`);
    } finally {
      busyRef.current = false;
    }
  }, [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError]);

  /**
   * Shared Open plumbing: flush the outgoing tab, reuse an untouched tab or add
   * one, load cleanly and snapshot. Imports are serialized to KET to restore.
   */
  const openFileIntoTab = useCallback(
    async (chosen: string, build: (id: string, text: string) => TabState): Promise<boolean> => {
      const ketcher = ketcherRef.current;
      if (!ketcher || busyRef.current) return false;

      busyRef.current = true;
      try {
        const outgoing = activeTab(tabsRef.current);
        const outgoingKet = await ketcher.getKet();
        const committed = updateTab(tabsRef.current, outgoing.id, { ket: outgoingKet });
        setTabs(committed);

        const outgoingTab = committed.tabs.find((tab) => tab.id === outgoing.id);
        if (outgoingTab) await writeTabSnapshot(outgoingTab, Date.now());

        const text = await readTextFile(chosen);
        const reuse = outgoingTab !== undefined && isUntouchedTab(outgoingTab);
        const targetId = reuse ? outgoing.id : allocateTabId();
        let target = build(targetId, text);

        await loadTabIntoEditor(target);
        if (target.path === null) {
          // Ketcher may normalize the imported format; keep the canonical KET
          // so the snapshot validator accepts it on the next launch. The
          // loading flag stays up through serialization so a late change event
          // cannot dirty the outgoing tab.
          loadingRef.current = true;
          try {
            target = { ...target, ket: await ketcher.getKet() };
          } finally {
            loadingRef.current = false;
          }
        }

        const next = reuse
          ? updateTab(tabsRef.current, targetId, {
              path: target.path,
              name: target.name,
              ket: target.ket,
              dirty: target.dirty,
            })
          : addTab(tabsRef.current, target);
        setTabs(next);

        const opened = next.tabs.find((tab) => tab.id === targetId);
        if (opened) await writeTabSnapshot(opened, Date.now());
        await writeTabIndex(
          next.tabs.map((entry) => entry.id),
          next.activeId,
        );
        restartScheduler();
        return true;
      } catch (error) {
        loadingRef.current = false;
        showError(`Could not open ${chosen}: ${errorMessage(error)}`);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError],
  );

  /** Opens a `.ket` project; an already-open path activates its tab and notices. */
  const openProject = useCallback(
    async (path: string): Promise<boolean> => {
      const found = resolveOpenTarget(tabsRef.current, path);
      if (found.kind === "activate") {
        if (tabsRef.current.activeId !== found.tabId) await activateTabById(found.tabId);
        setNotice({ title: "Already open", message: ALREADY_OPEN_MESSAGE });
        return true;
      }

      const opened = await openFileIntoTab(path, (id, text) =>
        createTab(id, {
          path,
          name: pathBaseName(path),
          ket: text,
          dirty: false,
        }),
      );
      // A remembered entry moves to the front when reopened.
      if (opened) updateRecent((list) => addRecent(list, path));
      return opened;
    },
    [activateTabById, openFileIntoTab, updateRecent],
  );

  /**
   * Any other structure is imported clean: its content equals the source file,
   * so no `.ket` path backs it until the first Save As.
   */
  const importStructure = useCallback(
    (path: string) =>
      openFileIntoTab(path, (id, text) => importedTab(id, text, pathBaseName(path))),
    [openFileIntoTab],
  );

  /** File → Open…: `.ket` files only, routed through `openProject`. */
  const openKetFile = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher || busyRef.current) return;

    try {
      const chosen = await openDialog({
        title: "Open",
        multiple: false,
        filters: [{ name: "Ketcher files", extensions: ["ket"] }],
      });
      if (typeof chosen !== "string") return;

      await openProject(chosen);
    } catch (error) {
      showError(`Could not open the file: ${errorMessage(error)}`);
    }
  }, [openProject, showError]);

  /** File → Import…: structure formats, routed through `importStructure`. */
  const importStructureFile = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher || busyRef.current) return;

    try {
      const chosen = await openDialog({
        title: "Import",
        multiple: false,
        filters: [{ name: "Structures", extensions: ["mol", "smi", "inchi", "sdf", "rxn"] }],
      });
      if (typeof chosen !== "string") return;

      await importStructure(chosen);
    } catch (error) {
      showError(`Could not import the file: ${errorMessage(error)}`);
    }
  }, [importStructure, showError]);

  /** A recent entry opens through Open; a missing file is pruned. */
  const openRecentDocument = useCallback(
    async (path: string) => {
      if (busyRef.current) return;
      const opened = await openProject(path);
      if (!opened) updateRecent((list) => removeRecent(list, path));
    },
    [openProject, updateRecent],
  );

  const openBackstage = useCallback(() => {
    // A template armed in the Structure Library must not follow the pointer
    // over the backstage.
    cancelActiveTool(ketcherRef.current);
    setBackstageOpen(true);
  }, []);
  const closeBackstage = useCallback(() => setBackstageOpen(false), []);

  /** Backstage commands reuse the File menu handlers and close the overlay first. */
  const handleBackstageNew = useCallback(() => {
    setBackstageOpen(false);
    void startNewDocument();
  }, [startNewDocument]);

  const handleBackstageOpen = useCallback(() => {
    setBackstageOpen(false);
    void openKetFile();
  }, [openKetFile]);

  const handleBackstageImport = useCallback(() => {
    setBackstageOpen(false);
    void importStructureFile();
  }, [importStructureFile]);

  const handleBackstageOpenRecent = useCallback(
    (path: string) => {
      setBackstageOpen(false);
      void openRecentDocument(path);
    },
    [openRecentDocument],
  );

  const handleBackstageRemoveRecent = useCallback(
    (path: string) => updateRecent((list) => removeRecent(list, path)),
    [updateRecent],
  );

  const handleBackstageSwitchTab = useCallback(
    (id: string) => {
      setBackstageOpen(false);
      void activateTabById(id);
    },
    [activateTabById],
  );

  /** Closes the overlay, then opens Ketcher's real Structure Library. */
  const handleMoreTemplates = useCallback(() => {
    setBackstageOpen(false);
    requestAnimationFrame(() => {
      if (!openStructureLibrary(ketcherRef.current)) {
        showError("Could not open the structure library.");
      }
    });
  }, [showError]);

  /** Inserts a template into a new dirty tab; the backstage closes on success. */
  const insertTemplate = useCallback(
    async (template: LibraryTemplate) => {
      const ketcher = ketcherRef.current;
      if (!ketcher || busyRef.current) return;

      busyRef.current = true;
      let editorReplaced = false;
      try {
        const outgoing = activeTab(tabsRef.current);
        const outgoingKet = await ketcher.getKet();
        const committed = updateTab(tabsRef.current, outgoing.id, { ket: outgoingKet });
        setTabs(committed);

        const outgoingTab = committed.tabs.find((tab) => tab.id === outgoing.id);
        if (outgoingTab) await writeTabSnapshot(outgoingTab, Date.now());

        const id = allocateTabId();
        let ket: string;
        loadingRef.current = true;
        try {
          // From here the canvas no longer shows the active tab, so a failure
          // (even one thrown by `setMolecule` itself) must restore it.
          editorReplaced = true;
          await ketcher.setMolecule(template.ket);
          ket = await ketcher.getKet();
        } finally {
          loadingRef.current = false;
        }

        const tab = createTab(id, {
          ket,
          path: null,
          name: template.name,
          dirty: true,
        });
        const next = addTab(tabsRef.current, tab);
        setTabs(next);

        await writeTabSnapshot(tab, Date.now());
        await writeTabIndex(
          next.tabs.map((entry) => entry.id),
          next.activeId,
        );
        restartScheduler();
        setBackstageOpen(false);
      } catch (error) {
        loadingRef.current = false;
        // The canvas may already hold the template while `tabs` still points at
        // the previous document: put the active tab back before reporting.
        if (editorReplaced) {
          try {
            await loadTabIntoEditor(activeTab(tabsRef.current));
          } catch (restoreError) {
            console.error("[chemistry-draw] could not restore the editor:", restoreError);
          }
        }
        showError(`Could not insert ${template.name}: ${errorMessage(error)}`);
      } finally {
        busyRef.current = false;
      }
    },
    [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError],
  );

  /** Dispatches a File menu item id to the command it runs. */
  const handleFileAction = useCallback(
    (id: FileMenuId) => {
      if (dialogOpenRef.current || busyRef.current) return;

      switch (id) {
        case "new":
          void startNewDocument();
          return;
        case "open":
          void openKetFile();
          return;
        case "import":
          void importStructureFile();
          return;
        case "save":
          void saveActiveTab("save");
          return;
        case "save-as":
          void saveActiveTab("save-as");
          return;
        case "export":
          setExportOpen(true);
          return;
      }
    },
    [importStructureFile, openKetFile, saveActiveTab, startNewDocument],
  );

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
        const name =
          tab.path !== null
            ? exportFileName(tab.path, request.extension)
            : `${tab.name ?? "untitled"}${request.extension}`;

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
          `Could not export ${format.toUpperCase()}: ${errorMessage(error)}. Try another format or another destination.`,
        );
      }
    },
    [showError],
  );

  const destroyWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy();
    } catch (error) {
      showError(`Could not close the window: ${errorMessage(error)}`);
    }
  }, [showError]);

  /** The window close matrix: Save only for one active dirty tab, else Discard/Cancel. */
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
          documentName: tabDisplayName(named),
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
          documentName: tabDisplayName(tab),
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
        showError(`Could not close the document: ${errorMessage(error)}`);
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
          `Could not save the file: ${errorMessage(error)}. Check that the folder is writable and try again.`,
        ),
    });

    return () => resetFileSaver();
  }, [ready, saveRoutedBlob, showError]);

  // Ketcher's top-toolbar buttons emit `CUSTOM_BUTTON_PRESSED` with the button
  // id; this listener is the single dispatcher for them. The document commands
  // are the same tab-aware commands as the File menu, and Models stays the real
  // model-setup entry.
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
        case "chemistry-draw:models":
          openModels();
          return;
        default:
          return;
      }
    };

    ketcher.eventBus.on("CUSTOM_BUTTON_PRESSED", onCustomButton);
    return () => {
      ketcher.eventBus.off("CUSTOM_BUTTON_PRESSED", onCustomButton);
    };
  }, [ready, saveActiveTab, startNewDocument, openModels]);

  // Capture phase beats Ketcher's bubble-phase hotkeys: a matched combination is
  // always swallowed, and its command is skipped while a dialog or save owns us.
  useEffect(() => {
    if (!ready) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      const key = event.key.toLowerCase();

      // The File popup behaves like a dialog for the shortcut guard: a matched
      // combination closes it and is consumed without running its command.
      const dismissFileMenu = (): boolean => {
        if (!fileMenuOpenRef.current) return false;
        fileMenuOpenRef.current = false;
        setFileMenuOpen(false);
        return true;
      };

      // Tab shortcuts never close the window while a dialog is open, but a
      // matched combination is consumed first so Ketcher cannot see it.
      if (key === "w" || key === "t") {
        event.preventDefault();
        event.stopPropagation();
        if (dismissFileMenu() || dialogOpenRef.current || busyRef.current) return;

        if (key === "w") void closeTabById(tabsRef.current.activeId);
        else void startNewDocument();
        return;
      }

      if (key === "tab") {
        event.preventDefault();
        event.stopPropagation();
        if (dismissFileMenu() || dialogOpenRef.current || busyRef.current) return;

        cycleTabs(event.shiftKey ? -1 : 1);
        return;
      }

      if (key !== "s" && key !== "o" && key !== "n") return;
      // Only Save As accepts Shift.
      if (event.shiftKey && key !== "s") return;

      event.preventDefault();
      event.stopPropagation();

      if (dismissFileMenu() || dialogOpenRef.current || busyRef.current) return;

      if (key === "s") void saveActiveTab(event.shiftKey ? "save-as" : "save");
      else if (key === "o") void openKetFile();
      else void startNewDocument();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [ready, saveActiveTab, openKetFile, startNewDocument, closeTabById, cycleTabs]);

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
          onOpenBackstage={openBackstage}
          leading={
            <FileMenu
              recent={recent}
              open={fileMenuOpen}
              onOpenChange={handleFileMenuOpenChange}
              onAction={handleFileAction}
              onOpenRecent={(path) => void openRecentDocument(path)}
            />
          }
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
      {backstageOpen && (
        <Backstage
          onClose={closeBackstage}
          onNew={handleBackstageNew}
          onImport={handleBackstageImport}
          onOpen={handleBackstageOpen}
          onTemplate={(template) => void insertTemplate(template)}
          onMoreTemplates={handleMoreTemplates}
          onOpenModels={openModels}
          templates={templates ?? []}
          templatesLoading={templates === null}
          renderPreview={renderTemplatePreview}
          editorReady={ready}
          recentStructures={recentRows}
          recentStructuresLoading={recentRowsLoading}
          onOpenRecent={handleBackstageOpenRecent}
          onRemoveRecent={handleBackstageRemoveRecent}
          tabs={tabSet}
          onSwitchTab={handleBackstageSwitchTab}
          indigoVersion={indigoInfo.version}
          indigoPort={indigoInfo.port}
          appVersion={packageJson.version}
        />
      )}
      {modelsOpen && (
        <ModelSetupDialog
          status={modelStatus}
          verify={modelVerify}
          attention={modelAttention}
          error={modelError}
          busy={modelBusy}
          onRefresh={refreshModelStatus}
          onPrimary={handleModelPrimary}
          onCancelDownload={cancelModels}
          onVerify={() => void verifyModelFiles()}
          onLater={closeModels}
        />
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
      {error !== null && (
        <ErrorDialog title={error.title} message={error.message} onClose={() => setError(null)} />
      )}
      {notice !== null && (
        <NoticeDialog
          title={notice.title}
          message={notice.message}
          onClose={() => setNotice(null)}
        />
      )}
    </>
  );
}

export default App;
