/**
 * Pure helpers and HTTP adapters for the model setup dialog
 * (`docs/architecture.md` "Model setup UI (B3)", `docs/testing.md` §6.2).
 *
 * Nothing here imports Tauri or React: the module runs under Vitest and in a
 * plain browser. `App.tsx` owns the fetch/poll/action loop; the helpers validate
 * a `GET /v2/models` body, format byte counts, map the status to the dialog
 * phase and primary action, and own the `/v2/models` HTTP adapters (each takes
 * an injectable `FetchLike` for the tests).
 */

/** State machine reported by `GET /v2/models`. */
export type DownloadState = "idle" | "downloading" | "verifying" | "ready" | "cancelled" | "failed";

/** One model family in the status payload. */
export interface ModelsStatusModel {
  key: string;
  id: string;
  version: string;
  license: string;
  total_bytes: number;
  installed_bytes: number;
  installed: boolean;
  /** Catalog-relative artifact paths that are absent from the model root. */
  missing: string[];
}

/** The `GET /v2/models` body. */
export interface ModelsStatus {
  catalog_version: number;
  installed_catalog_version: number | null;
  update_available: boolean;
  ready: boolean;
  manifest_present: boolean;
  total_bytes: number;
  installed_bytes: number;
  models: ModelsStatusModel[];
  download: {
    state: DownloadState;
    downloaded_bytes: number;
    total_bytes: number;
    current_file: string | null;
    error: string | null;
  };
}

/** One artifact in a `POST /v2/models/verify` report. */
export interface VerifyArtifact {
  path: string;
  status: "ok" | "missing" | "corrupt";
  expected_sha256?: string;
  actual_sha256?: string;
}

/** The `POST /v2/models/verify` body. */
export interface VerifyReport {
  ok: boolean;
  catalog_version: number;
  checked_bytes: number;
  artifacts: VerifyArtifact[];
  repair: string | null;
}

/** Dialog phase derived from the status and the last verify report. */
export type SetupPhase =
  | "not-installed"
  | "downloading"
  | "verifying"
  | "paused"
  | "failed"
  | "ready"
  | "update"
  | "repair";

export interface SetupView {
  phase: SetupPhase;
  primary: "download" | "cancel" | "verify" | null;
  primaryLabel: "Download" | "Resume" | "Retry" | "Update" | "Repair" | "Verify" | null;
  canCancel: boolean;
  canVerify: boolean;
}

/** A fetch function; the default wraps the global `fetch` safely. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Unbound global `fetch` can throw in some webviews; keep the call bound. */
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const DOWNLOAD_STATES: readonly DownloadState[] = [
  "idle",
  "downloading",
  "verifying",
  "ready",
  "cancelled",
  "failed",
];

const VERIFY_STATUSES: readonly VerifyArtifact["status"][] = ["ok", "missing", "corrupt"];

const UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Formats a byte count with binary units and one decimal above bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < UNITS.length - 1);

  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** Integer percent, floored and clamped to `0..100`. */
export function progressPercent(downloaded: number, total: number): number {
  if (!Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) return 0;
  const percent = Math.floor((downloaded / total) * 100);
  return Math.min(100, Math.max(0, percent));
}

/**
 * Validates a `GET /v2/models` body without coercion.
 *
 * Unknown fields are ignored; a missing or mistyped known field, an unknown
 * download state or a negative/non-finite byte count rejects the payload.
 */
export function parseModelsStatus(value: unknown): ModelsStatus | null {
  if (!isObject(value)) return null;

  const catalogVersion = value.catalog_version;
  const installedVersion = value.installed_catalog_version;
  if (!isCount(catalogVersion)) return null;
  if (installedVersion !== null && !isCount(installedVersion)) return null;
  if (!isBoolean(value.update_available)) return null;
  if (!isBoolean(value.ready)) return null;
  if (!isBoolean(value.manifest_present)) return null;
  if (!isByteCount(value.total_bytes)) return null;
  if (!isByteCount(value.installed_bytes)) return null;
  if (!Array.isArray(value.models)) return null;

  const models: ModelsStatusModel[] = [];
  for (const entry of value.models) {
    if (!isObject(entry)) return null;
    if (
      !isString(entry.key) ||
      !isString(entry.id) ||
      !isString(entry.version) ||
      !isString(entry.license)
    ) {
      return null;
    }
    if (!isByteCount(entry.total_bytes) || !isByteCount(entry.installed_bytes)) return null;
    if (!isBoolean(entry.installed)) return null;
    if (!Array.isArray(entry.missing) || !entry.missing.every(isString)) return null;

    models.push({
      key: entry.key,
      id: entry.id,
      version: entry.version,
      license: entry.license,
      total_bytes: entry.total_bytes,
      installed_bytes: entry.installed_bytes,
      installed: entry.installed,
      missing: [...entry.missing],
    });
  }

  if (!isObject(value.download)) return null;
  const download = value.download;
  if (!isString(download.state) || !DOWNLOAD_STATES.includes(download.state as DownloadState)) {
    return null;
  }
  if (!isByteCount(download.downloaded_bytes) || !isByteCount(download.total_bytes)) return null;
  if (download.current_file !== null && !isString(download.current_file)) return null;
  if (download.error !== null && !isString(download.error)) return null;

  return {
    catalog_version: catalogVersion,
    installed_catalog_version: installedVersion,
    update_available: value.update_available,
    ready: value.ready,
    manifest_present: value.manifest_present,
    total_bytes: value.total_bytes,
    installed_bytes: value.installed_bytes,
    models,
    download: {
      state: download.state as DownloadState,
      downloaded_bytes: download.downloaded_bytes,
      total_bytes: download.total_bytes,
      current_file: download.current_file,
      error: download.error,
    },
  };
}

/**
 * Maps the status plus an optional verify report to the dialog phase.
 *
 * Precedence: active run, failed, cancelled, ready install (repair > update >
 * ready), then not installed. `Later` is always rendered by the dialog, so it
 * is not part of the view.
 */
export function setupView(status: ModelsStatus, verify: VerifyReport | null = null): SetupView {
  const { state } = status.download;

  if (state === "downloading") {
    return {
      phase: "downloading",
      primary: null,
      primaryLabel: null,
      canCancel: true,
      canVerify: false,
    };
  }

  if (state === "verifying") {
    return {
      phase: "verifying",
      primary: null,
      primaryLabel: null,
      canCancel: false,
      canVerify: false,
    };
  }

  if (state === "failed") {
    return {
      phase: "failed",
      primary: "download",
      primaryLabel: "Retry",
      canCancel: false,
      canVerify: false,
    };
  }

  if (state === "cancelled") {
    return {
      phase: "paused",
      primary: "download",
      primaryLabel: "Resume",
      canCancel: false,
      canVerify: false,
    };
  }

  if (status.ready) {
    if (verify !== null && !verify.ok) {
      return {
        phase: "repair",
        primary: "download",
        primaryLabel: "Repair",
        canCancel: false,
        canVerify: true,
      };
    }

    if (status.update_available) {
      return {
        phase: "update",
        primary: "download",
        primaryLabel: "Update",
        canCancel: false,
        canVerify: true,
      };
    }

    return {
      phase: "ready",
      primary: "verify",
      primaryLabel: "Verify",
      canCancel: false,
      canVerify: true,
    };
  }

  return {
    phase: "not-installed",
    primary: "download",
    primaryLabel: "Download",
    canCancel: false,
    canVerify: false,
  };
}

/**
 * Whether the install reads healthy: ready, no active run and no catalog
 * update.
 *
 * This is the single health predicate: `modelsControlVisible` uses it after
 * the attention override, and `App.tsx` uses it to decide when a completed
 * download-style run is proof of health. A `null` (unknown) status is not
 * healthy.
 */
export function modelInstallHealthy(status: ModelsStatus | null): boolean {
  return (
    status !== null &&
    status.ready &&
    (status.download.state === "idle" || status.download.state === "ready") &&
    !status.update_available
  );
}

/**
 * Whether the `Models` toolbar control must be shown.
 *
 * The control is hidden only on a healthy ready install: installed, an
 * `idle`/`ready` download state, no catalog update, no verify report that
 * needs a repair and no recognition-attention override. An unknown status, a
 * not-ready install, an available update, and any run that is `downloading`,
 * `verifying`, `cancelled` or `failed` keep the control visible even when
 * `ready: true`: a failed Repair must keep its own Retry reachable, a cancelled
 * repair or update must keep Resume reachable, and an active run must keep its
 * progress, Cancel and eventual error reachable instead of hiding the only path
 * to its status. An `ok: false` report also keeps it visible. `attention` is
 * the recognition-failure override: a recognition failure that reports the
 * models unavailable forces the control until a successful verify or a
 * completed download-style run whose status is healthy proves health, because a
 * corrupt-but-present artifact leaves `ready: true` (`docs/architecture.md`
 * "Model setup UI").
 */
export function modelsControlVisible(
  status: ModelsStatus | null,
  verify: VerifyReport | null = null,
  attention = false,
): boolean {
  if (attention) return true;
  if (!modelInstallHealthy(status)) return true;
  return verify !== null && !verify.ok;
}

/**
 * Whether the dialog's muted attention note is rendered.
 *
 * The note points at **Verify**, so it is shown only while the attention
 * override is armed on a ready install whose dialog can actually run Verify:
 * not during an active, paused or failed run and not on a not-ready install
 * (`setupView(...).canVerify` is false), and not while the verify report
 * already needs Repair (that action says it). `App.tsx` owns the override;
 * `ModelSetupDialog` renders this predicate.
 */
export function modelAttentionNoticeVisible(
  status: ModelsStatus | null,
  verify: VerifyReport | null,
  attention = false,
): boolean {
  if (!attention || status === null) return false;
  return setupView(status, verify).canVerify && (verify === null || verify.ok);
}

/** Parses a `POST /v2/models/verify` body; throws on a malformed report. */
function parseVerifyReport(value: unknown): VerifyReport | null {
  if (!isObject(value)) return null;
  if (!isBoolean(value.ok)) return null;
  if (!isCount(value.catalog_version)) return null;
  if (!isByteCount(value.checked_bytes)) return null;
  if (!Array.isArray(value.artifacts)) return null;

  const artifacts: VerifyArtifact[] = [];
  for (const entry of value.artifacts) {
    if (!isObject(entry)) return null;
    if (!isString(entry.path)) return null;
    if (
      !isString(entry.status) ||
      !VERIFY_STATUSES.includes(entry.status as VerifyArtifact["status"])
    ) {
      return null;
    }
    if (entry.expected_sha256 !== undefined && !isString(entry.expected_sha256)) return null;
    if (entry.actual_sha256 !== undefined && !isString(entry.actual_sha256)) return null;

    artifacts.push({
      path: entry.path,
      status: entry.status as VerifyArtifact["status"],
      ...(entry.expected_sha256 === undefined ? {} : { expected_sha256: entry.expected_sha256 }),
      ...(entry.actual_sha256 === undefined ? {} : { actual_sha256: entry.actual_sha256 }),
    });
  }

  if (value.repair !== null && !isString(value.repair)) return null;

  return {
    ok: value.ok,
    catalog_version: value.catalog_version,
    checked_bytes: value.checked_bytes,
    artifacts,
    repair: value.repair,
  };
}

/** Joins `apiBase` (normally `http://127.0.0.1:<port>/v2/`) with a route. */
function endpoint(apiBase: string, route: string): string {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
  return `${base}${route}`;
}

/** Reads the sidecar's `{ "error": ... }` envelope, or the plain-text body. */
async function readError(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text) {
      try {
        const body: unknown = JSON.parse(text);
        if (isObject(body) && isString(body.error) && body.error.trim()) return body.error.trim();
      } catch {
        // Not JSON: use the body verbatim.
      }
      return text;
    }
  } catch {
    // Ignore an unreadable body and fall back to the status text.
  }

  return response.statusText || `HTTP ${response.status}`;
}

function failure(context: string, status: number, detail: string): Error {
  return new Error(`${context} (HTTP ${status}): ${detail}`);
}

function networkFailure(apiBase: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not reach the local model service at ${apiBase}. ` +
      `Check that the app's sidecar is running and try again. (${detail})`,
  );
}

async function readStatusResponse(context: string, response: Response): Promise<ModelsStatus> {
  if (!response.ok) throw failure(context, response.status, await readError(response));

  const body: unknown = await response.json().catch(() => null);
  const status = parseModelsStatus(body);
  if (status === null) {
    throw new Error(`${context}: the response was not a valid model status.`);
  }
  return status;
}

async function postStatus(
  apiBase: string,
  route: string,
  context: string,
  fetchImpl: FetchLike,
): Promise<ModelsStatus> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint(apiBase, route), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw networkFailure(apiBase, error);
  }

  return readStatusResponse(context, response);
}

/** Reads `GET /v2/models`. */
export async function fetchModelsStatus(
  apiBase: string,
  fetchImpl: FetchLike = defaultFetch,
  signal?: AbortSignal,
): Promise<ModelsStatus> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint(apiBase, "models"), {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    throw networkFailure(apiBase, error);
  }

  return readStatusResponse("Could not read the model status", response);
}

/** Starts or resumes `POST /v2/models/download`; returns the new status. */
export async function startModelDownload(
  apiBase: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ModelsStatus> {
  return postStatus(apiBase, "models/download", "Could not start the model download", fetchImpl);
}

/** Requests `POST /v2/models/download/cancel`; returns the new status. */
export async function cancelModelDownload(
  apiBase: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ModelsStatus> {
  return postStatus(
    apiBase,
    "models/download/cancel",
    "Could not cancel the model download",
    fetchImpl,
  );
}

/** Reads `POST /v2/models/verify` and validates its report. */
export async function verifyModels(
  apiBase: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<VerifyReport> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint(apiBase, "models/verify"), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw networkFailure(apiBase, error);
  }

  if (!response.ok) {
    throw failure("Could not verify the models", response.status, await readError(response));
  }

  const body: unknown = await response.json().catch(() => null);
  const report = parseVerifyReport(body);
  if (report === null) {
    throw new Error("Could not verify the models: the response was not a valid verify report.");
  }
  return report;
}
