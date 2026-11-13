import "ketcher-react/dist/index.css";
import "./overrides.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "ketcher-react";
import {
  RemoteStructServiceProvider,
  type Ketcher,
  type StructService,
  type StructServiceOptions,
} from "ketcher-core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  applyExport,
  applySaved,
  closeAfterSave,
  decideCloseGuard,
  documentName,
  documentTitle,
  exportFileName,
  markDirty,
  newDocument,
  openDocument,
  saveAsTarget,
  saveRequest,
  type CloseChoice,
  type DocumentState,
  type ExportFormat,
  type SaveOutcome,
} from "./document";
import { createAutosaveScheduler, shouldOfferRecovery } from "./autosave";
import {
  clearSnapshot,
  inspectOriginal,
  readSnapshot,
  writeSnapshot,
  type Snapshot,
} from "./autosaveStore";
import {
  hasFileSaverHandler,
  registerFileSaver,
  resetFileSaver,
  saveBlobAs,
  writeTextFileAt,
} from "./fileSaver";
import { routeSavedBlob } from "./saveRoute";
import { describeError, errorMessage } from "./recognizeErrors";
import { CloseGuardDialog, ErrorDialog, ExportDialog, RecoveryDialog } from "./ui/DocumentDialogs";
import { EDITOR_BUTTONS } from "./ui/editorButtons";
import { tokens } from "./ui/tokens";
import { CUSTOM_BUTTONS, TOOLBAR_ICON_STYLES } from "./ui/toolbarIcons";

/** Minimal valid `.ket` document: an empty canvas. */
const EMPTY_STRUCTURE = '{"root":{"nodes":[]}}';

/** What a dirty-document prompt is protecting. */
type PromptIntent = "close" | "replace";

/** Result of asking the user about unsaved changes. */
type GuardVerdict = "clean" | "saved" | "discard" | "abort";

interface RecoveryOffer {
  snapshot: Snapshot;
  /** Extra dialog copy, e.g. when the original file disappeared. */
  note: string | null;
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

/**
 * Struct service provider that discards stale recognition results.
 *
 * Ketcher's Recognize dialog dispatches `setStruct` from every `recognize`
 * promise it starts. Changing the image while a recognition is still running
 * lets the older promise resolve after the newer one, overwriting the fresh
 * preview (or clearing it with an outdated error). Each call takes a monotonic
 * token and only the latest token may settle; stale promises stay pending
 * forever so the Ketcher thunk never dispatches an outdated result. The result
 * also gets a unique molfile title so Ketcher's title-keyed preview cache does
 * not replay an earlier structure.
 */
class StaleSafeStructServiceProvider extends RemoteStructServiceProvider {
  private recognizeToken = 0;

  override createStructService(options: StructServiceOptions): StructService {
    const service = super.createStructService(options);
    const recognize = service.recognize.bind(service);

    service.recognize = (blob: Blob, version: string) => {
      const token = ++this.recognizeToken;
      return recognize(blob, version).then(
        (result) => {
          if (token !== this.recognizeToken) return new Promise<never>(() => {});
          // Ketcher's StructRender caches rendered SVG by the molfile title.
          // The sidecar writes an empty title for every structure, so a second
          // recognition of a different molecule would replay the first cached
          // preview. A unique title keeps the cache key distinct; the title is
          // cosmetic and does not change the atoms or bonds.
          const title = `Recognized structure ${token}`;
          return { ...result, struct: result.struct.replace(/^[^\n]*/, title) };
        },
        (error: unknown) =>
          token === this.recognizeToken ? Promise.reject(error) : new Promise<never>(() => {}),
      );
    };

    return service;
  }
}

function App() {
  const lastError = useRef<{ msg: string; at: number }>({ msg: "", at: 0 });
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<RemoteStructServiceProvider | null>(null);

  const ketcherRef = useRef<Ketcher | null>(null);
  const [doc, setDocState] = useState<DocumentState>(newDocument);
  const docRef = useRef(doc);

  const [recovery, setRecovery] = useState<RecoveryOffer | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [promptIntent, setPromptIntent] = useState<PromptIntent>("close");
  const [error, setError] = useState<{ title: string; message: string } | null>(null);

  const closeChoiceRef = useRef<((choice: CloseChoice) => void) | null>(null);
  const dialogOpenRef = useRef(false);
  const busyRef = useRef(false);
  const closingRef = useRef(false);

  /** Updates both the rendered state and the value event handlers read. */
  const setDoc = useCallback((next: DocumentState) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const showError = useCallback(
    (text: string, title = "Error") => setError({ title, message: text }),
    [],
  );

  // Keep the keydown handler aware of the dialogs without re-subscribing.
  const dialogsOpen = recovery !== null || exportOpen || closePrompt || error !== null;
  useEffect(() => {
    dialogOpenRef.current = dialogsOpen;
  }, [dialogsOpen]);

  useEffect(() => {
    let cancelled = false;
    resolveApiBase().then((apiBase) => {
      if (cancelled) return;
      console.info("[chemistry-draw] Indigo API:", apiBase);
      setProvider(new StaleSafeStructServiceProvider(apiBase));
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

  const handleError = useCallback(
    (raw: unknown) => {
      const msg = typeof raw === "string" ? raw : String(raw);
      console.error("Ketcher error:", msg);
      const now = Date.now();
      if (msg === lastError.current.msg && now - lastError.current.at < 5000) return;
      lastError.current = { msg, at: now };
      const { title, message } = describeError(raw);
      showError(message, title);
    },
    [showError],
  );

  // Window title mirrors the document name plus the dirty marker.
  useEffect(() => {
    if (!isTauri()) return;
    getCurrentWindow()
      .setTitle(documentTitle(doc))
      .catch((error) => console.warn("[chemistry-draw] could not set the window title:", error));
  }, [doc]);

  /** Snapshot cleanup must never fail the command that already succeeded. */
  const clearSnapshotSafely = useCallback(async () => {
    try {
      await clearSnapshot();
    } catch (error) {
      console.warn("[chemistry-draw] could not delete the recovery snapshot:", error);
    }
  }, []);

  /**
   * Routes a blob Ketcher asked to save through the aliased `file-saver`.
   * `.ket` writes the document (asking for a destination only when it has no
   * path); every other format is an export that leaves the document untouched.
   */
  const saveRoutedBlob = useCallback(
    async (blob: Blob, filename: string): Promise<void> => {
      const route = routeSavedBlob(filename, docRef.current, {
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

          await writeTextFileAt(path, await blob.text());
          setDoc(applySaved(docRef.current, path));
          await clearSnapshotSafely();
          return;
        }
        case "export-save":
        case "download":
          await saveBlobAs(blob, route.defaultName);
          return;
      }
    },
    [clearSnapshotSafely, setDoc],
  );

  const saveDocument = useCallback(
    async (mode: "save" | "save-as"): Promise<SaveOutcome> => {
      const ketcher = ketcherRef.current;
      if (!ketcher || busyRef.current) return "cancelled";

      busyRef.current = true;
      try {
        const request = saveRequest(docRef.current);
        const ket = await ketcher.getKet();

        if (!isTauri()) {
          // Browser fallback: download, and a download has no writable path.
          await saveBlobAs(new Blob([ket], { type: "application/json" }), request.path);
          setDoc({ ...docRef.current, dirty: false });
          return "saved";
        }

        let path = docRef.current.path;
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
        setDoc(applySaved(docRef.current, path));
        await clearSnapshotSafely();
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
    [clearSnapshotSafely, setDoc, showError],
  );

  const askCloseChoice = useCallback(
    (intent: PromptIntent): Promise<CloseChoice> =>
      new Promise((resolve) => {
        closeChoiceRef.current = resolve;
        setPromptIntent(intent);
        setClosePrompt(true);
      }),
    [],
  );

  const answerCloseChoice = useCallback((choice: CloseChoice) => {
    setClosePrompt(false);
    const resolve = closeChoiceRef.current;
    closeChoiceRef.current = null;
    resolve?.(choice);
  }, []);

  /**
   * The single Save / Discard / Cancel state machine. Every command that would
   * drop unsaved edits (close, New, Open) goes through it; none re-implements
   * the decision.
   */
  const confirmDirty = useCallback(
    async (intent: PromptIntent): Promise<GuardVerdict> => {
      if (!docRef.current.dirty) return "clean";

      const choice = await askCloseChoice(intent);
      const decision = decideCloseGuard(docRef.current, choice);

      if (decision.action === "stay") return "abort";
      if (decision.action === "discard") return "discard";

      const outcome = await saveDocument(decision.action === "save" ? "save" : "save-as");
      return closeAfterSave(outcome) === "close" ? "saved" : "abort";
    },
    [askCloseChoice, saveDocument],
  );

  /** Asks before replacing the current document; `false` aborts the command. */
  const confirmReplace = useCallback(
    async (): Promise<boolean> => (await confirmDirty("replace")) !== "abort",
    [confirmDirty],
  );

  const startNewDocument = useCallback(async () => {
    const ketcher = ketcherRef.current;
    if (!ketcher || busyRef.current) return;
    if (!(await confirmReplace())) return;

    try {
      await ketcher.setMolecule(EMPTY_STRUCTURE);
      setDoc(newDocument());
      await clearSnapshotSafely();
    } catch (error) {
      showError(`Could not start a new document: ${errorMessage(error)}`);
    }
  }, [clearSnapshotSafely, confirmReplace, setDoc, showError]);

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
      if (!(await confirmReplace())) return;

      const text = await readTextFile(chosen);
      await ketcher.setMolecule(text);

      if (/\.ket$/i.test(chosen)) {
        setDoc(openDocument(chosen));
      } else {
        // Other formats are imported through Ketcher: no `.ket` file backs them.
        setDoc(markDirty(newDocument()));
      }
      await clearSnapshotSafely();
    } catch (error) {
      showError(`Could not open the file: ${errorMessage(error)}`);
    }
  }, [clearSnapshotSafely, confirmReplace, setDoc, showError]);

  const exportDocument = useCallback(
    async (format: ExportFormat) => {
      setExportOpen(false);
      const ketcher = ketcherRef.current;
      if (!ketcher) return;

      try {
        // Export is a separate file: the document path, format and dirty flag
        // are unchanged.
        const { state, request } = applyExport(docRef.current, format);
        setDoc(state);
        const name = exportFileName(state.path, request.extension);

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
    [setDoc, showError],
  );

  const offerRecovery = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const snapshot = await readSnapshot();
      if (snapshot === null) return;

      const original = await inspectOriginal(snapshot.meta.path);
      if (!shouldOfferRecovery(snapshot.meta, original.mtime)) return;

      const note =
        original.missing && snapshot.meta.path !== null
          ? `The original file (${snapshot.meta.path}) is no longer on disk. Restore keeps that path, so Save recreates it.`
          : null;
      setRecovery({ snapshot, note });
    } catch (error) {
      console.warn("[chemistry-draw] could not read the autosave snapshot:", error);
    }
  }, []);

  const restoreSnapshot = useCallback(async () => {
    const offer = recovery;
    setRecovery(null);
    const ketcher = ketcherRef.current;
    if (offer === null || !ketcher) return;

    const { snapshot } = offer;
    try {
      await ketcher.setMolecule(snapshot.ket);
      const base = snapshot.meta.path === null ? newDocument() : openDocument(snapshot.meta.path);
      // Recovered work is unsaved: keep it dirty so Save persists it.
      setDoc(markDirty(base));
    } catch (error) {
      showError(`Could not restore the recovered structure: ${errorMessage(error)}`);
    }
  }, [recovery, setDoc, showError]);

  const discardSnapshot = useCallback(async () => {
    setRecovery(null);
    await clearSnapshotSafely();
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    try {
      await ketcher.setMolecule(EMPTY_STRUCTURE);
      setDoc(newDocument());
    } catch (error) {
      showError(`Could not reset the editor: ${errorMessage(error)}`);
    }
  }, [clearSnapshotSafely, setDoc, showError]);

  const destroyWindow = useCallback(async () => {
    try {
      await getCurrentWindow().destroy();
    } catch (error) {
      showError(`Could not close the window: ${errorMessage(error)}`);
    }
  }, [showError]);

  const handleCloseRequest = useCallback(
    async (event: { preventDefault: () => void }) => {
      if (!docRef.current.dirty) return;

      event.preventDefault();
      // A second close request while the prompt or a save is running is ignored.
      if (closingRef.current || busyRef.current) return;

      closingRef.current = true;
      try {
        const verdict = await confirmDirty("close");
        if (verdict === "abort") return;
        if (verdict === "discard") await clearSnapshotSafely();
        await destroyWindow();
      } finally {
        closingRef.current = false;
      }
    },
    [clearSnapshotSafely, confirmDirty, destroyWindow],
  );

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

  // Editor wiring: dirty tracking, autosave, recovery and the close guard.
  useEffect(() => {
    if (!ready) return;
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    const desktop = isTauri();
    const scheduler = desktop
      ? createAutosaveScheduler({
          isDirty: () => docRef.current.dirty,
          write: () => {
            const editor = ketcherRef.current;
            if (!editor) return;
            const { path } = docRef.current;
            void editor
              .getKet()
              .then((ket) => writeSnapshot({ ket, path, savedAt: Date.now() }))
              .catch((error) => console.warn("[chemistry-draw] autosave failed:", error));
          },
        })
      : null;

    const onChange = () => {
      scheduler?.notifyChange();
      if (!docRef.current.dirty) setDoc(markDirty(docRef.current));
    };

    ketcher.changeEvent.add(onChange);
    scheduler?.start();

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    if (desktop) {
      void getCurrentWindow()
        .onCloseRequested(handleCloseRequest)
        .then((stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        })
        .catch((error) => console.warn("[chemistry-draw] close guard unavailable:", error));
      // Deferred so the prompt appears after the editor has painted.
      recoveryTimer = setTimeout(() => void offerRecovery(), 0);
    }

    return () => {
      cancelled = true;
      if (recoveryTimer !== null) clearTimeout(recoveryTimer);
      scheduler?.stop();
      ketcher.changeEvent.remove(onChange);
      unlisten?.();
    };
  }, [ready, handleCloseRequest, offerRecovery, setDoc]);

  // Ketcher's top-toolbar buttons emit `CUSTOM_BUTTON_PRESSED` with the button
  // id; this listener is the single dispatcher for them (§5.7).
  useEffect(() => {
    if (!ready) return;
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    const onCustomButton = (id: unknown) => {
      if (typeof id !== "string") return;
      if (dialogOpenRef.current || busyRef.current) return;

      switch (id) {
        case "chemistry-draw:save":
          void saveDocument("save");
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
  }, [ready, saveDocument, startNewDocument]);

  // Document shortcuts. Ketcher binds its hotkeys on the editor container in the
  // bubble phase (`initKeydownListener`, `ketcher-react/dist/index.js`), so this
  // listener runs in the capture phase and stops the event before Ketcher sees
  // it: `preventDefault()` alone would leave its native Save As dialog opening
  // (§5.7). A matched combination is always swallowed, even while a dialog is
  // open or a save is running, so a repeated shortcut never falls through to
  // Ketcher. Only the command itself is skipped then.
  useEffect(() => {
    if (!ready) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key !== "s" && key !== "o" && key !== "n") return;
      // Only Save As accepts Shift.
      if (event.shiftKey && key !== "s") return;

      event.preventDefault();
      event.stopPropagation();

      if (dialogOpenRef.current || busyRef.current) return;

      if (key === "s") void saveDocument(event.shiftKey ? "save-as" : "save");
      else if (key === "o") void openDocumentFromDisk();
      else void startNewDocument();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [ready, saveDocument, openDocumentFromDisk, startNewDocument]);

  return (
    <>
      <style>{TOOLBAR_ICON_STYLES}</style>
      {(!provider || !ready) && (
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
      {exportOpen && (
        <ExportDialog
          onExport={(format) => void exportDocument(format)}
          onCancel={() => setExportOpen(false)}
        />
      )}
      {recovery !== null && (
        <RecoveryDialog
          documentName={documentName(recovery.snapshot.meta.path)}
          note={recovery.note}
          onRestore={() => void restoreSnapshot()}
          onDiscard={() => void discardSnapshot()}
        />
      )}
      {closePrompt && (
        <CloseGuardDialog
          documentName={documentName(doc.path)}
          intent={promptIntent}
          onChoice={answerCloseChoice}
        />
      )}
      {error !== null && (
        <ErrorDialog title={error.title} message={error.message} onClose={() => setError(null)} />
      )}
    </>
  );
}

export default App;
