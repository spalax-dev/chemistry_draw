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
import { describeError, errorMessage, isModelUnavailable } from "./recognizeErrors";
import { applyKetcherAppOptions, findKetcherRoot } from "./ketcherOptions";
import {
  cancelModelDownload,
  fetchModelsStatus,
  modelInstallHealthy,
  modelsControlVisible,
  setupView,
  startModelDownload,
  verifyModels,
  type ModelsStatus,
  type VerifyReport,
} from "./modelSetup";
import { CloseGuardDialog, ErrorDialog, ExportDialog, RecoveryDialog } from "./ui/DocumentDialogs";
import { ModelSetupDialog } from "./ui/ModelSetupDialog";
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
  const [apiBase, setApiBase] = useState<string | null>(null);

  const ketcherRef = useRef<Ketcher | null>(null);
  const [doc, setDocState] = useState<DocumentState>(newDocument);
  const docRef = useRef(doc);

  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelsStatus | null>(null);
  const [modelVerify, setModelVerify] = useState<VerifyReport | null>(null);
  const [modelAttention, setModelAttention] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);

  const apiBaseRef = useRef<string | null>(null);
  const modelsOpenRef = useRef(false);
  const modelsAutoOpenedRef = useRef(false);
  const modelsAutoOpenPendingRef = useRef(false);
  const modelsStartupRef = useRef(false);
  const modelAbortRef = useRef<AbortController | null>(null);
  const modelBusyRef = useRef(false);
  // True while a download-style run was accepted but has not yet been observed
  // healthy: only a later status read may treat that run's completion as proof.
  const modelHealthProofRef = useRef(false);
  const imagoVersionsRef = useRef<string[] | null>(null);

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

  /**
   * Copies the sidecar's advertised `imago_versions` into Ketcher's option
   * store. The store update does not remount the editor or call
   * `setMolecule`, so the canvas, selection and undo history survive; the
   * no-op action inside the adapter refreshes the Recognize control state.
   */
  const applyImagoVersions = useCallback((versions: string[]) => {
    const ketcher = ketcherRef.current;
    if (!ketcher) return;

    const previous = imagoVersionsRef.current;
    if (
      previous !== null &&
      previous.length === versions.length &&
      previous.every((value, index) => value === versions[index])
    ) {
      return;
    }

    const container = findKetcherRoot(ketcher);
    if (!applyKetcherAppOptions(container, { server: true, imagoVersions: versions })) {
      console.warn(
        "[chemistry-draw] could not update the Ketcher option store; " +
          "the Recognize control may need a restart.",
      );
      return;
    }

    imagoVersionsRef.current = [...versions];
  }, []);

  /** Reads `GET /v2/info` and applies the capability list in place. */
  const syncImagoVersions = useCallback(
    async (base: string) => {
      try {
        const infoUrl = `${base.endsWith("/") ? base : `${base}/`}info`;
        const response = await fetchWithTimeout(infoUrl, 3_000);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body: unknown = await response.json();
        const raw =
          typeof body === "object" && body !== null && "imago_versions" in body
            ? (body as { imago_versions?: unknown }).imago_versions
            : undefined;
        const versions = Array.isArray(raw)
          ? raw.filter((value): value is string => typeof value === "string")
          : [];
        applyImagoVersions(versions);
      } catch (error) {
        console.warn("[chemistry-draw] could not refresh the recognition capability:", error);
      }
    },
    [applyImagoVersions],
  );

  /**
   * Reads `GET /v2/models`. Only one request is in flight: a new read aborts
   * the previous one, and a response that arrives after close is discarded.
   */
  const refreshModels = useCallback(
    async (
      options: { silent?: boolean; requireOpen?: boolean } = {},
    ): Promise<ModelsStatus | null> => {
      const base = apiBaseRef.current;
      if (base === null) return null;

      modelAbortRef.current?.abort();
      const controller = new AbortController();
      modelAbortRef.current = controller;
      try {
        const next = await fetchModelsStatus(
          base,
          (input, init) => fetch(input, init),
          controller.signal,
        );
        if (controller.signal.aborted) return null;
        if (options.requireOpen && !modelsOpenRef.current) return null;

        setModelStatus(next);
        setModelError(null);
        // A completed download-style run is proof of health only when a status
        // read observes the result. An ordinary read with no accepted run in
        // flight never clears the recognition-attention override.
        if (modelHealthProofRef.current && modelInstallHealthy(next)) {
          modelHealthProofRef.current = false;
          setModelAttention(false);
        }
        return next;
      } catch (error) {
        if (controller.signal.aborted) return null;
        if (options.requireOpen && !modelsOpenRef.current) return null;
        if (options.silent) {
          console.warn("[chemistry-draw] could not read the model status:", error);
        } else {
          setModelError(errorMessage(error));
        }
        return null;
      } finally {
        if (modelAbortRef.current === controller) modelAbortRef.current = null;
      }
    },
    [],
  );

  const openModels = useCallback(() => {
    modelsOpenRef.current = true;
    setModelsOpen(true);
    setModelError(null);
    void refreshModels({ requireOpen: true });
  }, [refreshModels]);

  const closeModels = useCallback(() => {
    modelsOpenRef.current = false;
    setModelsOpen(false);
    modelAbortRef.current?.abort();
  }, []);

  /**
   * Runs a status-returning action and re-fetches after a failure (e.g. 409).
   *
   * A download-style action clears the last verify report when it starts and
   * when it succeeds: the report is stale from that point on, and keeping it
   * would leave `setupView` on `repair`/Repair after a successful Repair.
   */
  const runModelAction = useCallback(
    async (
      action: (base: string) => Promise<ModelsStatus>,
      options: { clearVerify?: boolean } = {},
    ) => {
      const base = apiBaseRef.current;
      if (base === null || modelBusyRef.current) return;

      modelBusyRef.current = true;
      modelAbortRef.current?.abort();
      setModelBusy(true);
      setModelError(null);
      if (options.clearVerify) setModelVerify(null);
      try {
        const next = await action(base);
        setModelStatus(next);
        if (options.clearVerify) {
          setModelVerify(null);
          // An accepted start (202) is not proof of health: the worker may
          // still fail before or during the run. Keep the attention override
          // and let a status read of the completed, healthy install clear it.
          // A response that is already healthy (a 200 no-op re-hash) is proof,
          // so clear the override immediately.
          if (modelInstallHealthy(next)) {
            modelHealthProofRef.current = false;
            setModelAttention(false);
          } else {
            modelHealthProofRef.current = true;
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        setModelError(message);
        await refreshModels({ silent: true, requireOpen: true });
        // The re-fetch must not wipe the action's own note.
        setModelError(message);
      } finally {
        modelBusyRef.current = false;
        setModelBusy(false);
      }
    },
    [refreshModels],
  );

  const downloadModels = useCallback(() => {
    void runModelAction((base) => startModelDownload(base), { clearVerify: true });
  }, [runModelAction]);

  const cancelModels = useCallback(() => {
    void runModelAction((base) => cancelModelDownload(base));
  }, [runModelAction]);

  const verifyModelFiles = useCallback(async () => {
    const base = apiBaseRef.current;
    if (base === null || modelBusyRef.current) return;

    modelBusyRef.current = true;
    modelAbortRef.current?.abort();
    setModelBusy(true);
    setModelError(null);
    try {
      const report = await verifyModels(base);
      setModelVerify(report);
      if (report.ok) {
        modelHealthProofRef.current = false;
        setModelAttention(false);
      }
      await refreshModels({ silent: true, requireOpen: true });
    } catch (error) {
      const message = errorMessage(error);
      setModelError(message);
      await refreshModels({ silent: true, requireOpen: true });
      setModelError(message);
    } finally {
      modelBusyRef.current = false;
      setModelBusy(false);
    }
  }, [refreshModels]);

  const handleModelPrimary = useCallback(() => {
    if (modelStatus === null) {
      void refreshModels({ requireOpen: true });
      return;
    }

    const view = setupView(modelStatus, modelVerify);
    if (view.primary === "verify") void verifyModelFiles();
    else if (view.primary === "download") downloadModels();
  }, [downloadModels, modelStatus, modelVerify, refreshModels, verifyModelFiles]);

  const refreshModelStatus = useCallback(() => {
    void refreshModels({ requireOpen: true });
  }, [refreshModels]);

  const modelDownloadState = modelStatus?.download.state ?? null;
  const modelReady = modelStatus?.ready ?? null;
  const modelsVisible = modelsControlVisible(modelStatus, modelVerify, modelAttention);

  // One status read after the editor is ready and the API base resolved.
  useEffect(() => {
    if (!ready || apiBase === null || modelsStartupRef.current) return;
    modelsStartupRef.current = true;
    void refreshModels({ silent: true }).then((status) => {
      if (status !== null && !status.ready) modelsAutoOpenPendingRef.current = true;
    });
  }, [ready, apiBase, refreshModels]);

  // Auto-open exactly once, after a recovery prompt (or error dialog) is gone.
  // Deferred one tick so the editor paints first and the open is not a
  // synchronous cascading render from the effect body.
  useEffect(() => {
    if (!modelsAutoOpenPendingRef.current || modelsAutoOpenedRef.current) return;
    if (recovery !== null || error !== null) return;

    const timer = setTimeout(() => {
      if (modelsAutoOpenedRef.current || !modelsAutoOpenPendingRef.current) return;
      modelsAutoOpenedRef.current = true;
      modelsAutoOpenPendingRef.current = false;
      openModels();
    }, 0);
    return () => clearTimeout(timer);
  }, [modelStatus, recovery, error, openModels]);

  // Poll while the dialog is open and a run is active; closing stops the timer.
  useEffect(() => {
    if (!modelsOpen) return;
    if (modelDownloadState !== "downloading" && modelDownloadState !== "verifying") return;

    const timer = setInterval(() => {
      // An action request owns the status while it runs; a poll that started
      // then could overwrite its result with an older snapshot.
      if (!modelBusyRef.current) void refreshModels({ requireOpen: true });
    }, 500);
    return () => clearInterval(timer);
  }, [modelsOpen, modelDownloadState, refreshModels]);

  // The Models control is a conditional toolbar entry: Ketcher renders each
  // `customButtons` entry as `<img alt={title}>` inside its own `<button>`, and
  // React owns that toolbar. Hiding the wrapper button in place keeps the
  // registered button and its `CUSTOM_BUTTON_PRESSED` event intact while the
  // install is healthy. The toolbar can paint a tick after `onInit`, so a short
  // bounded retry waits for the node; a missing node is logged, never fatal.
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

  // Ready flips the Recognize capability without remounting the editor; a
  // non-ready status clears it. Opening the dialog on a ready install retries a
  // transient `/v2/info` failure.
  useEffect(() => {
    if (!ready || apiBase === null || modelReady === null) return;
    if (!modelReady) {
      applyImagoVersions([]);
      return;
    }
    void syncImagoVersions(apiBase);
  }, [ready, apiBase, modelReady, modelsOpen, applyImagoVersions, syncImagoVersions]);

  useEffect(() => () => modelAbortRef.current?.abort(), []);

  // Keep the keydown handler aware of the dialogs without re-subscribing.
  const dialogsOpen =
    recovery !== null || exportOpen || closePrompt || error !== null || modelsOpen;
  useEffect(() => {
    dialogOpenRef.current = dialogsOpen;
  }, [dialogsOpen]);

  useEffect(() => {
    let cancelled = false;
    resolveApiBase().then((base) => {
      if (cancelled) return;
      console.info("[chemistry-draw] Indigo API:", base);
      apiBaseRef.current = base;
      setApiBase(base);
      setProvider(new StaleSafeStructServiceProvider(base));
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
      // A corrupt-but-present artifact keeps `ready: true` (a status read never
      // hashes), so recognition is the only signal that the install needs a
      // repair. Force the Models control until health is proven.
      if (isModelUnavailable(raw)) {
        // Invalidate a proof armed by an earlier run *before* the silent read:
        // that run may have completed while the dialog was closed, so a healthy
        // status now cannot clear the failure observed here.
        modelHealthProofRef.current = false;
        setModelAttention(true);
        void refreshModels({ silent: true });
      }
    },
    [refreshModels, showError],
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
  }, [ready, saveDocument, startNewDocument, openModels]);

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
