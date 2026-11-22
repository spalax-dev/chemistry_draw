/**
 * In-app model setup panel (B3) and its controller hook.
 *
 * The component is presentational: it renders the same Ketcher `Dialog` /
 * `Button` primitives as the document workflow and never calls Tauri or a
 * native alert (`docs/conventions.md` §6, `docs/architecture.md` "Model setup
 * UI"). `useModelSetup` owns the status, the fetch/poll/action loop and the
 * dialog open state for `App.tsx`, so the hook and the surface stay together.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Ketcher } from "ketcher-core";

import { applyKetcherAppOptions, findKetcherRoot } from "../ketcherOptions";
import {
  cancelModelDownload,
  fetchModelsStatus,
  formatBytes,
  modelAttentionNoticeVisible,
  modelInstallHealthy,
  modelsControlVisible,
  progressPercent,
  setupView,
  startModelDownload,
  verifyModels,
  type ModelsStatus,
  type ModelsStatusModel,
  type SetupPhase,
  type VerifyReport,
} from "../modelSetup";
import { errorMessage } from "../recognizeErrors";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { tokens } from "./tokens";

const PARAGRAPH = { margin: "0 0 8px" } as const;
const SECTION = {
  borderTop: `${tokens.borderWidth} solid ${tokens.color.border}`,
  marginTop: "12px",
  paddingTop: "12px",
} as const;
const SECTION_TITLE = {
  margin: "0 0 6px",
  fontSize: tokens.fontSize.body,
  fontWeight: 600,
  color: tokens.color.text,
} as const;
const MUTED = {
  color: tokens.color.muted,
  fontSize: tokens.fontSize.body,
} as const;
const CODE = {
  fontFamily: "monospace",
  fontSize: tokens.fontSize.body,
  color: tokens.color.textSecondary,
  overflowWrap: "anywhere" as const,
};

const FAMILY_LABELS: Record<string, string> = {
  "image-classifier": "Image classifier",
  "ocsr-handdrawn": "Structure recognition",
};

const PHASE_LABELS: Record<SetupPhase, string> = {
  "not-installed": "Not installed",
  downloading: "Downloading",
  verifying: "Verifying",
  paused: "Paused",
  failed: "Download failed",
  ready: "Models ready",
  update: "Update available",
  repair: "Repair needed",
};

export interface ModelSetupDialogProps {
  /** Last known `GET /v2/models` body; `null` before the first successful read. */
  status: ModelsStatus | null;
  /** Last `POST /v2/models/verify` report, or `null`. */
  verify: VerifyReport | null;
  /**
   * Recognition-unavailable override. On a ready install whose dialog can run
   * Verify and has no Repair to show, the dialog explains that Verify checks
   * the installed files.
   */
  attention?: boolean;
  /** Connection/action error kept inside the dialog. */
  error: string | null;
  /** True while an action request is in flight; disables double actions. */
  busy: boolean;
  /** Refreshes the status with no action (also used by the Retry on error). */
  onRefresh: () => void;
  /** Download/Resume/Retry/Update/Repair. */
  onPrimary: () => void;
  /** Cancel the active download. */
  onCancelDownload: () => void;
  /** Read-only verify report. */
  onVerify: () => void;
  /** Closes the dialog only; it never cancels a run. */
  onLater: () => void;
}

function familyLabel(model: ModelsStatusModel): string {
  return FAMILY_LABELS[model.key] ?? model.key;
}

function familyState(model: ModelsStatusModel): string {
  if (model.installed) return "Installed";
  if (model.installed_bytes > 0) return `Partially installed (${model.missing.length} missing)`;
  return "Not installed";
}

function statusText(status: ModelsStatus, verify: VerifyReport | null): string {
  return PHASE_LABELS[setupView(status, verify).phase];
}

function downloadStateText(status: ModelsStatus): string {
  switch (status.download.state) {
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying the downloaded files";
    case "cancelled":
      return "Download paused";
    case "ready":
      return "Download complete";
    case "failed":
      return "Download failed";
    default:
      return "No download running";
  }
}

/** One catalog family row with license, sizes and install state. */
function FamilyRow({ model }: { model: ModelsStatusModel }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        border: `${tokens.borderWidth} solid ${tokens.color.border}`,
        borderRadius: tokens.radius,
        backgroundColor: tokens.color.surfaceSubtle,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
        <strong>{familyLabel(model)}</strong>
        <span style={MUTED}>{familyState(model)}</span>
      </div>
      <div style={{ ...MUTED, marginTop: "2px" }}>{model.id}</div>
      <div style={{ ...MUTED, marginTop: "2px" }}>
        {model.license} · {model.total_bytes.toLocaleString("en-US")} B (
        {formatBytes(model.total_bytes)})
      </div>
      <div style={{ ...MUTED, marginTop: "2px" }}>
        Installed: {formatBytes(model.installed_bytes)}
      </div>
      {model.missing.length > 0 ? (
        <div style={{ ...CODE, marginTop: "4px" }}>Missing: {model.missing.join(", ")}</div>
      ) : null}
    </div>
  );
}

/**
 * Modal model setup panel: families, totals, progress and errors.
 * Download is opt-in; Later closes without cancelling.
 */
export function ModelSetupDialog({
  status,
  verify,
  attention = false,
  error,
  busy,
  onRefresh,
  onPrimary,
  onCancelDownload,
  onVerify,
  onLater,
}: ModelSetupDialogProps) {
  const view = status === null ? null : setupView(status, verify);
  const downloadFailure =
    status?.download.state === "failed"
      ? (status.download.error ?? "The download failed. Check the network and try again.")
      : null;
  const alert = error ?? downloadFailure;
  // A recognition failure left the override armed, but the install reads ready
  // and there is no Repair to show: point at Verify instead of a bare "Models
  // ready". Only while the dialog can actually run Verify; during a run (or on
  // a paused/failed run) there is no Verify action, and once Repair is shown
  // the note would only repeat it.
  const attentionNotice = modelAttentionNoticeVisible(status, verify, attention);
  const active =
    status !== null &&
    (status.download.state === "downloading" || status.download.state === "verifying");
  const percent =
    status === null
      ? 0
      : progressPercent(status.download.downloaded_bytes, status.download.total_bytes);
  const installedPercent =
    status === null ? 0 : progressPercent(status.installed_bytes, status.total_bytes);
  // Exactly one control autofocuses: Retry when no status was read, the primary
  // action when there is one, and Later when neither exists.
  const retryWithoutStatus = view === null && error !== null;
  const laterAutofocus = !retryWithoutStatus && (view === null || view.primary === null);

  return (
    <Dialog
      title="Models"
      width={520}
      onCancel={onLater}
      actions={
        <>
          <Button data-autofocus={laterAutofocus ? "true" : undefined} onClick={onLater}>
            Later
          </Button>
          {view?.canCancel ? (
            <Button disabled={busy} onClick={onCancelDownload}>
              Cancel
            </Button>
          ) : null}
          {view?.canVerify && view.primary !== "verify" ? (
            <Button disabled={busy} onClick={onVerify}>
              Verify
            </Button>
          ) : null}
          {error !== null && view !== null && view.primaryLabel !== "Retry" ? (
            <Button disabled={busy} onClick={onRefresh}>
              Retry
            </Button>
          ) : null}
          {view?.primary === "download" ? (
            <Button variant="primary" disabled={busy} data-autofocus="true" onClick={onPrimary}>
              {view.primaryLabel}
            </Button>
          ) : null}
          {view?.primary === "verify" ? (
            <Button variant="primary" disabled={busy} data-autofocus="true" onClick={onVerify}>
              Verify
            </Button>
          ) : null}
          {view === null && error !== null ? (
            <Button variant="primary" disabled={busy} data-autofocus="true" onClick={onRefresh}>
              Retry
            </Button>
          ) : null}
        </>
      }
    >
      <p style={PARAGRAPH}>
        Image recognition models let Chemistry Draw turn a picture into a structure. The download is
        optional and only starts when you choose it. Images, documents and drawings never leave this
        machine.
      </p>

      {attentionNotice ? (
        <p style={{ ...PARAGRAPH, ...MUTED }}>
          A recognition attempt reported the models unavailable. Run Verify to check the installed
          files.
        </p>
      ) : null}

      {alert ? (
        <div
          role="alert"
          style={{
            margin: "8px 0",
            padding: "8px 10px",
            border: `${tokens.borderWidth} solid ${tokens.color.error}`,
            borderRadius: tokens.radius,
            color: tokens.color.error,
            backgroundColor: tokens.color.errorWash,
          }}
        >
          {error !== null ? "Model setup problem. " : "The model download failed. "}
          {alert}
        </div>
      ) : null}

      {status === null ? (
        <p style={PARAGRAPH}>
          {error === null ? "Reading model status..." : "Model status is unavailable."}
        </p>
      ) : (
        <>
          <div style={SECTION}>
            <h3 style={SECTION_TITLE}>Families</h3>
            <div style={{ display: "grid", gap: "8px" }}>
              {status.models.map((model) => (
                <FamilyRow key={model.key} model={model} />
              ))}
            </div>
          </div>

          <div style={SECTION}>
            <h3 style={SECTION_TITLE}>Totals</h3>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
              <span>
                Installed {formatBytes(status.installed_bytes)} of{" "}
                {status.total_bytes.toLocaleString("en-US")} B ({formatBytes(status.total_bytes)}),{" "}
                {installedPercent}%
              </span>
              <strong>{statusText(status, verify)}</strong>
            </div>
            <div style={{ ...MUTED, marginTop: "2px" }}>
              Catalog version {status.catalog_version}
              {status.installed_catalog_version !== null
                ? ` · installed ${status.installed_catalog_version}`
                : ""}
            </div>
            {status.update_available ? (
              <div style={{ ...MUTED, marginTop: "2px" }}>
                A newer catalog is available; Update re-verifies the installed files without
                fetching them again.
              </div>
            ) : null}
          </div>

          <div style={SECTION}>
            <h3 style={SECTION_TITLE}>Download</h3>
            <div>{downloadStateText(status)}</div>
            {active ? (
              <>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label="Model download progress"
                  style={{
                    height: "8px",
                    marginTop: "6px",
                    borderRadius: tokens.radius,
                    backgroundColor: tokens.color.border,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${percent}%`,
                      height: "100%",
                      backgroundColor: tokens.color.accent,
                    }}
                  />
                </div>
                <div style={{ ...MUTED, marginTop: "4px" }}>
                  {formatBytes(status.download.downloaded_bytes)} of{" "}
                  {formatBytes(status.download.total_bytes)} ({percent}%)
                </div>
                {status.download.current_file !== null ? (
                  <div style={{ ...CODE, marginTop: "2px" }}>
                    Current file: {status.download.current_file}
                  </div>
                ) : null}
              </>
            ) : null}
            {status.download.state === "ready" ? (
              <div style={{ ...MUTED, marginTop: "2px" }}>
                Installed models are used by the built-in Recognize control.
              </div>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Inputs the model controller reads from `App.tsx`. */
export interface ModelSetupControllerOptions {
  /** Whether Ketcher has initialized. */
  ready: boolean;
  /** The resolved sidecar base, or `null` while it is still being found. */
  apiBase: string | null;
  /** Live mirror of `apiBase` for callbacks that must not re-subscribe. */
  apiBaseRef: MutableRefObject<string | null>;
  /** The mounted editor, read lazily for the Recognize capability sync. */
  ketcherRef: MutableRefObject<Ketcher | null>;
  /** Whether App's error dialog is open; the one-time auto-open waits for it. */
  errorOpen: boolean;
}

/** State and commands the model setup surface consumes. */
export interface ModelSetupController {
  /** Whether `ModelSetupDialog` is mounted. */
  modelsOpen: boolean;
  /** Last `GET /v2/models` body, or `null` before the first read. */
  modelStatus: ModelsStatus | null;
  /** Last verify report, or `null`. */
  modelVerify: VerifyReport | null;
  /** Recognition-unavailable override. */
  modelAttention: boolean;
  /** Connection/action error shown inside the dialog. */
  modelError: string | null;
  /** True while an action is in flight. */
  modelBusy: boolean;
  /** Whether the Models toolbar control must be shown. */
  modelsVisible: boolean;
  /** Opens the dialog and reads the status. */
  openModels: () => void;
  /** Closes the dialog only; it never cancels a run. */
  closeModels: () => void;
  /** Re-reads the status with no action. */
  refreshModelStatus: () => void;
  /** Runs Download / Resume / Repair / Verify according to `setupView`. */
  handleModelPrimary: () => void;
  /** Cancels the active download. */
  cancelModels: () => void;
  /** Runs the read-only verify and re-reads the status. */
  verifyModelFiles: () => Promise<void>;
  /**
   * Forces the Models control until health is proven after a recognition
   * failure reported the models unavailable.
   */
  reportModelUnavailable: () => void;
}

/**
 * Owns the model setup lifecycle for `App.tsx`: the `/v2/models` reads, the
 * download/verify/repair actions, the in-place Recognize capability sync and
 * the one-time auto-open on a clean install.
 *
 * Only one status request is in flight at a time (a new read aborts the
 * previous one), and a response that arrives after the dialog closes is
 * discarded. A completed download-style run counts as proof of health only
 * when a later status read observes the healthy result.
 */
export function useModelSetup({
  ready,
  apiBase,
  apiBaseRef,
  ketcherRef,
  errorOpen,
}: ModelSetupControllerOptions): ModelSetupController {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelsStatus | null>(null);
  const [modelVerify, setModelVerify] = useState<VerifyReport | null>(null);
  const [modelAttention, setModelAttention] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);

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

  /**
   * Copies the sidecar's advertised `imago_versions` into Ketcher's option
   * store. The store update does not remount the editor or call
   * `setMolecule`, so the canvas, selection and undo history survive; the
   * no-op action inside the adapter refreshes the Recognize control state.
   */
  const applyImagoVersions = useCallback(
    (versions: string[]) => {
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
    },
    [ketcherRef],
  );

  /** Reads `GET /v2/info` and applies the capability list in place. */
  const syncImagoVersions = useCallback(
    async (base: string) => {
      try {
        const infoUrl = `${base.endsWith("/") ? base : `${base}/`}info`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        let response: Response;
        try {
          response = await fetch(infoUrl, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
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
    [apiBaseRef],
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
    [apiBaseRef, refreshModels],
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
  }, [apiBaseRef, refreshModels]);

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

  const reportModelUnavailable = useCallback(() => {
    // Invalidate a proof armed by an earlier run *before* the silent read: that
    // run may have completed while the dialog was closed, so a healthy status
    // now cannot clear the failure observed here.
    modelHealthProofRef.current = false;
    setModelAttention(true);
    void refreshModels({ silent: true });
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

  // Auto-open exactly once, after an error dialog is gone. Deferred one tick so
  // the editor paints first and the open is not a synchronous cascading render.
  // The backstage stays behind the dialog: model setup is a document surface,
  // not a replacement for Welcome.
  useEffect(() => {
    if (!modelsAutoOpenPendingRef.current || modelsAutoOpenedRef.current) return;
    if (errorOpen) return;

    const timer = setTimeout(() => {
      if (modelsAutoOpenedRef.current || !modelsAutoOpenPendingRef.current) return;
      modelsAutoOpenedRef.current = true;
      modelsAutoOpenPendingRef.current = false;
      openModels();
    }, 0);
    return () => clearTimeout(timer);
  }, [modelStatus, errorOpen, openModels]);

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

  return {
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
  };
}
