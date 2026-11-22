import "ketcher-react/dist/index.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "ketcher-react";
import {
  FunctionalGroupsProvider,
  KetSerializer,
  RemoteStructServiceProvider,
  SaltsAndSolventsProvider,
  type CheckTypes,
  type Ketcher,
  type Struct,
} from "ketcher-core";
import { message } from "@tauri-apps/plugin-dialog";
import { invoke, isTauri } from "@tauri-apps/api/core";
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
import { fetchWithTimeout } from "./fetchWithTimeout";
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
import { CloseGuardDialog, ErrorDialog, ExportDialog, NoticeDialog } from "./ui/DocumentDialogs";
import { Backstage } from "./ui/Backstage";
import { EDITOR_BUTTONS } from "./ui/editorButtons";
import { FileMenu } from "./ui/FileMenu";
import { TabStrip } from "./ui/TabStrip";
import { addRecent, loadRecent, removeRecent, saveRecent } from "./recent";
import { loadRecentStructures, type RecentRow } from "./recentStructures";
import {
  buildLibraryTemplates,
  previewKetWithoutSgroups,
  type LibraryTemplate,
  type TemplateSource,
} from "./templateLibrary";
import { applyKetcherAppOptions, cancelActiveTool, openStructureLibrary } from "./ketcherOptions";
import type { FileMenuId } from "./fileMenu";

/** The Save / Export helpers work on a document view of the active tab. */
function documentView(tab: TabState): DocumentState & { name: string | null } {
  return { path: tab.path, name: tab.name, format: "ket", dirty: tab.dirty };
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

/** Check types the Recent structures validation asks Indigo for (§5.11). */
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

/** Versions and the real port read from `GET /v2/info`; never assumed values. */
interface IndigoInfo {
  version: string | null;
  port: number | null;
}

interface ResolvedApi {
  apiBase: string;
  info: IndigoInfo;
}

/** Reads `indigo_version` and the port in `api_path`, tolerating a bad body. */
function parseIndigoInfo(body: unknown, fallbackPort: number): IndigoInfo {
  if (typeof body !== "object" || body === null) {
    return { version: null, port: fallbackPort };
  }

  const record = body as Record<string, unknown>;
  const version =
    typeof record.indigo_version === "string" && record.indigo_version.length > 0
      ? record.indigo_version
      : null;

  let port = fallbackPort;
  if (typeof record.api_path === "string") {
    try {
      const parsed = new URL(record.api_path);
      if (parsed.port !== "") port = Number(parsed.port);
    } catch {
      // Keep the port the host reported.
    }
  }

  return { version, port };
}

/**
 * Resolve the Indigo API base URL and the real sidecar info.
 *
 * The sidecar reports the port it actually bound to, which may not be the
 * preferred one if that port was already in use. It also starts asynchronously,
 * so we poll until /v2/info answers.
 */
async function resolveApiBase(): Promise<ResolvedApi> {
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
      if (res.ok) {
        let info: IndigoInfo = { version: null, port };
        try {
          info = parseIndigoInfo(await res.json(), port);
        } catch {
          // The endpoint answered but not with JSON; keep the fallback.
        }
        return { apiBase: `http://127.0.0.1:${port}/v2/`, info };
      }
    } catch {
      // Sidecar not ready yet.
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Give up and let Ketcher surface the connection error.
  return { apiBase: `http://127.0.0.1:${port}/v2/`, info: { version: null, port } };
}

/**
 * Reads Ketcher's real Structure Library (§5.11). Ketcher appends salts and
 * solvents to the functional-groups list, so the salts are classified first
 * and their names are skipped when mapping groups. Every entry keeps its own
 * KET, the only structure a card previews or inserts.
 */
function readLibraryTemplates(): LibraryTemplate[] {
  const salts = SaltsAndSolventsProvider.getInstance().getSaltsAndSolventsList();
  const groups = FunctionalGroupsProvider.getInstance().getFunctionalGroupsList();
  const serializer = new KetSerializer();

  const nameOf = (struct: Struct): string => (struct.abbreviation || struct.name).trim();
  const saltNames = new Set(salts.map((struct) => nameOf(struct).toLowerCase()));
  const entries: TemplateSource[] = [];

  // A struct the serializer cannot handle is skipped: one bad library entry
  // must not empty or crash the whole Welcome grid (§5.11).
  const serialize = (struct: Struct): string | null => {
    try {
      return serializer.serializeMicromolecules(struct);
    } catch {
      return null;
    }
  };

  for (const struct of groups) {
    const name = nameOf(struct);
    if (saltNames.has(name.toLowerCase())) continue;
    const ket = serialize(struct);
    if (ket === null) continue;
    entries.push({ name, group: "functional-group", ket });
  }
  for (const struct of salts) {
    const ket = serialize(struct);
    if (ket === null) continue;
    entries.push({ name: nameOf(struct), group: "salt-solvent", ket });
  }

  return buildLibraryTemplates(entries);
}

/**
 * The shared Structure Library build (§5.11). Building it serializes every
 * entry, so it runs after the first paint and its result is reused by every
 * later backstage open; the in-flight promise keeps two openers from reading
 * the providers twice.
 */
let libraryCache: LibraryTemplate[] | null = null;
let libraryBuild: Promise<LibraryTemplate[]> | null = null;

/** Defers `run` to the next idle slot, falling back to a macrotask. */
function afterPaint(run: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    idle(run, { timeout: 1_000 });
    return;
  }
  setTimeout(run, 0);
}

/** Resolves the cached library, scheduling one deferred build when absent. */
function loadLibraryTemplates(): Promise<LibraryTemplate[]> {
  if (libraryCache !== null) return Promise.resolve(libraryCache);
  if (libraryBuild !== null) return libraryBuild;

  libraryBuild = new Promise<LibraryTemplate[]>((resolve) => {
    afterPaint(() => {
      let entries: LibraryTemplate[];
      try {
        entries = readLibraryTemplates();
        // An empty read is not cached: the providers may not be populated yet,
        // so a later backstage open gets to try again (§5.11).
        if (entries.length > 0) libraryCache = entries;
      } catch (error) {
        // Not cached, so a later open retries once the providers are usable.
        console.warn("[chemistry-draw] could not read the structure library:", error);
        entries = [];
      }
      libraryBuild = null;
      resolve(entries);
    });
  });
  return libraryBuild;
}

function App() {
  const lastError = useRef<{ msg: string; at: number }>({ msg: "", at: 0 });
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<RemoteStructServiceProvider | null>(null);
  /** The backstage is the start surface, so every launch begins here. */
  const [backstageOpen, setBackstageOpen] = useState(true);
  const [indigoInfo, setIndigoInfo] = useState<IndigoInfo>({ version: null, port: null });
  /** The resolved sidecar base (`http://127.0.0.1:<port>/v2/`), null until ready. */
  const [apiBase, setApiBase] = useState<string | null>(null);

  const ketcherRef = useRef<Ketcher | null>(null);
  /**
   * The real Structure Library entries, `null` until the deferred build lands
   * (§5.11). Welcome paints skeletons meanwhile and later opens reuse the cache.
   */
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(null);
  /** Mirrors `templates` so the retry effect reads it without a dependency. */
  const templatesRef = useRef<LibraryTemplate[] | null>(null);

  // The library is read once the editor reports ready, after paint.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void loadLibraryTemplates().then((entries) => {
      if (cancelled) return;
      templatesRef.current = entries;
      setTemplates(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  // A later backstage open retries an empty library build. The effect is keyed
  // on the open flag and readiness, never on `templates`, so an again-empty
  // read cannot loop; `libraryBuild` makes a concurrent retry a no-op and
  // `templates` returns to `null` so the skeletons stay while the retry runs.
  useEffect(() => {
    if (!backstageOpen || !ready) return;
    if (libraryBuild !== null) return;
    const current = templatesRef.current;
    if (current === null || current.length > 0) return;

    templatesRef.current = null;
    setTemplates(null);
    void loadLibraryTemplates().then((entries) => {
      templatesRef.current = entries;
      setTemplates(entries);
    });
  }, [backstageOpen, ready]);
  const [tabSet, setTabSetState] = useState<TabSet>(() => emptyTabSet("tab-1"));
  const tabsRef = useRef(tabSet);
  const nextTabIdRef = useRef(1);
  /** Started before the editor initializes, resolved once it is ready. */
  const [restorePromise] = useState(() => readTabSet());

  /** Remembered `.ket` paths, newest first (`docs/architecture.md` §5.9). */
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const recentRef = useRef<string[]>(recent);
  /** Welcome's Recent structures rows and their in-flight flag (§5.11). */
  const [recentRows, setRecentRows] = useState<RecentRow[]>([]);
  const [recentRowsLoading, setRecentRowsLoading] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);
  const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  /** Already-open notice (§5.10); the caller supplies title and message. */
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

  /** Updates both the rendered state and the value event handlers read. */
  const setTabs = useCallback((next: TabSet) => {
    tabsRef.current = next;
    setTabSetState(next);
  }, []);

  const showError = useCallback((text: string) => setErrorText(text), []);

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

  // Keep the keydown handler aware of the dialogs without re-subscribing.
  const dialogsOpen =
    backstageOpen || exportOpen || closePrompt !== null || errorText !== null || notice !== null;
  useEffect(() => {
    dialogOpenRef.current = dialogsOpen;
  }, [dialogsOpen]);

  useEffect(() => {
    let cancelled = false;
    resolveApiBase().then(({ apiBase, info }) => {
      if (cancelled) return;
      console.info("[chemistry-draw] Indigo API:", apiBase);
      setApiBase(apiBase);
      setProvider(new RemoteStructServiceProvider(apiBase));
      setIndigoInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInit = useCallback((ketcher: Ketcher) => {
    ketcherRef.current = ketcher;
    // Ketcher 3.21 narrowed `editor.options()` to render options: `app` is
    // Redux store state, read by the server-backed toolbar controls. Enable
    // server mode through the option-store adapter instead of rebuilding the
    // render; the canvas, selection and undo history are left untouched.
    if (!applyKetcherAppOptions(ketcher, { server: true })) {
      console.warn(
        "[chemistry-draw] could not enable Ketcher server mode; server-backed controls stay disabled.",
      );
    }
    setReady(true);
  }, []);

  /**
   * Builds the Welcome Recent structures rows (§5.11) once the backstage is
   * open: it stats and reads each recent `.ket`, validates the derived molfile
   * through the mounted editor's struct service and resolves a cached Indigo
   * preview. The run is skipped outside Tauri or before the editor and the
   * sidecar base are ready, restarts when the recent list changes while the
   * backstage stays open, and a cancelled run never repaints.
   */
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

  /**
   * Renders one library entry's KET to a preview object URL through Ketcher.
   * Only the copy drops its SGroups: the card still inserts the original KET.
   */
  const renderTemplatePreview = useCallback(async (ket: string): Promise<string> => {
    const ketcher = ketcherRef.current;
    if (!ketcher) throw new Error("The editor is not ready to render a template preview.");
    const previewKet = previewKetWithoutSgroups(ket);
    const image = await ketcher.generateImage(previewKet, { outputFormat: "svg" });
    return URL.createObjectURL(image);
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

      // An armed template tool must not follow the pointer onto the tab that is
      // about to be loaded (§5.11, "Tool reset").
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
        const view = documentView(tab);
        const request = saveRequest(view, view.name);
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

        // A path owned by another tab is refused before the write; the active
        // tab's own path still saves (§5.10).
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
          `Could not save the document: ${describeError(error)}. Check that the folder is writable and try again.`,
        );
        return "failed";
      } finally {
        busyRef.current = false;
      }
    },
    [setTabs, showError, updateRecent],
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

  /**
   * New reuses an untouched empty active tab, so an empty canvas is never
   * stacked on top of itself; any document or edit opens a new tab. The
   * decision is made before `getKet`, so the reuse branch never commits or
   * flushes the outgoing tab (the canvas may hold a stale structure after a
   * commit, which the semantic empty check catches).
   */
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
      showError(`Could not start a new document: ${describeError(error)}`);
    } finally {
      busyRef.current = false;
    }
  }, [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError]);

  /**
   * Shared Open plumbing: commit and flush the outgoing tab, reuse an untouched
   * empty tab (else allocate one), load the file behind the loading flag, then
   * record the target tab, its snapshot and the new index. A dirty tab is never
   * replaced and Open never prompts.
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
        const target = build(targetId, text);

        await loadTabIntoEditor(target);

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
        showError(`Could not open ${chosen}: ${describeError(error)}`);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError],
  );

  /**
   * A `.ket` file becomes the tab's document: it owns the path and stays clean.
   * A path already held by a tab is not opened again: that tab is activated and
   * the notice shows, before any file read (§5.10). The guard returns `true`
   * because the request is satisfied — a recent entry must not be pruned.
   */
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
      // A remembered entry moves to the front when reopened (§5.9).
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
      showError(`Could not open the file: ${describeError(error)}`);
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
      showError(`Could not import the file: ${describeError(error)}`);
    }
  }, [importStructure, showError]);

  /** A recent entry opens through Open; a missing file is pruned (§5.9). */
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
    // over the backstage (§5.11, "Tool reset").
    cancelActiveTool(ketcherRef.current);
    setBackstageOpen(true);
  }, []);
  const closeBackstage = useCallback(() => setBackstageOpen(false), []);

  /**
   * Backstage commands reuse the File menu handlers. New/Open/Import and a tab
   * switch close the overlay first; Save, Save As and Export keep it open so
   * their dialogs render above it.
   */
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

  /**
   * **More templates** closes the overlay first, then opens Ketcher's real
   * Structure Library, so its dialog is not trapped under the backstage. The
   * store lookup is deferred one frame to let the overlay unmount.
   */
  const handleMoreTemplates = useCallback(() => {
    setBackstageOpen(false);
    requestAnimationFrame(() => {
      if (!openStructureLibrary(ketcherRef.current)) {
        showError("Could not open the structure library.");
      }
    });
  }, [showError]);

  /**
   * A template card always opens a new tab. The outgoing tab is flushed first,
   * then the descriptor is loaded behind the loading flag (so the programmatic
   * `setMolecule` never dirties an incoming tab), serialized with `getKet` and
   * committed as an unsaved document named after the template. The backstage
   * closes only on success; an error shows in-app and leaves it open.
   */
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
        showError(`Could not insert ${template.name}: ${describeError(error)}`);
      } finally {
        busyRef.current = false;
      }
    },
    [allocateTabId, loadTabIntoEditor, restartScheduler, setTabs, showError],
  );

  /** Dispatches a File menu item id to the command it runs (§5.9). */
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
        const view = documentView(tab);
        const { request } = applyExport(view, format);
        const name = exportFileName(view.path, request.extension, view.name);

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
