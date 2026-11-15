/**
 * In-app model setup panel (B3).
 *
 * Presentational only: App.tsx owns the status, the fetch/poll/action loop and
 * the dialog open state. The panel renders the same Ketcher `Dialog` / `Button`
 * primitives as the document workflow and never calls Tauri or a native alert
 * (`docs/conventions.md` §6, `docs/architecture.md` "Model setup UI").
 */

import {
  formatBytes,
  progressPercent,
  setupView,
  type ModelsStatus,
  type ModelsStatusModel,
  type SetupPhase,
  type VerifyReport,
} from "../modelSetup";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { tokens } from "./tokens";

/** Public source repository; the catalog pins the per-artifact URLs. */
const SOURCE_URL = "https://huggingface.co/spalax-dev/chemistry-draw-ocsr";

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
 * Modal model setup panel: families, totals, progress, errors and attribution.
 * Download is opt-in; Later closes without cancelling.
 */
export function ModelSetupDialog({
  status,
  verify,
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

      <div style={SECTION}>
        <h3 style={SECTION_TITLE}>Licenses and source</h3>
        <p style={{ ...PARAGRAPH, ...MUTED }}>
          Models are downloaded from Hugging Face: <span style={CODE}>{SOURCE_URL}</span>
        </p>
        <p style={{ ...PARAGRAPH, ...MUTED }}>
          Image classifier: MIT (DECIMER Image Classifier). Structure recognition: CC-BY-4.0
          (DECIMER v2 hand-drawn export). Full attributions are in NOTICE.
        </p>
      </div>
    </Dialog>
  );
}
