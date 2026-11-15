/**
 * Contract for `src/modelSetup.ts`, the pure helpers behind the models setup
 * dialog (docs/architecture.md "Model setup UI (B3)", docs/testing.md §6.1-6.2).
 *
 * ```ts
 * export interface ModelsStatus {
 *   catalog_version: number;
 *   installed_catalog_version: number | null;
 *   update_available: boolean;
 *   ready: boolean;
 *   manifest_present: boolean;
 *   total_bytes: number;
 *   installed_bytes: number;
 *   models: Array<{
 *     key: string;
 *     id: string;
 *     version: string;
 *     license: string;
 *     total_bytes: number;
 *     installed_bytes: number;
 *     installed: boolean;
 *     missing: string[];
 *   }>;
 *   download: {
 *     state: "idle" | "downloading" | "verifying" | "ready" | "cancelled" | "failed";
 *     downloaded_bytes: number;
 *     total_bytes: number;
 *     current_file: string | null;
 *     error: string | null;
 *   };
 * }
 *
 * export interface VerifyReport {
 *   ok: boolean;
 *   catalog_version: number;
 *   checked_bytes: number;
 *   artifacts: Array<{
 *     path: string;
 *     status: "ok" | "missing" | "corrupt";
 *     expected_sha256?: string;
 *     actual_sha256?: string;
 *   }>;
 *   repair: string | null;
 * }
 *
 * export type SetupPhase =
 *   | "not-installed"
 *   | "downloading"
 *   | "verifying"
 *   | "paused"
 *   | "failed"
 *   | "ready"
 *   | "update"
 *   | "repair";
 *
 * export function formatBytes(bytes: number): string;
 * export function progressPercent(downloaded: number, total: number): number;
 * export function parseModelsStatus(value: unknown): ModelsStatus | null;
 * export function setupView(
 *   status: ModelsStatus,
 *   verify?: VerifyReport | null,
 * ): {
 *   phase: SetupPhase;
 *   primary: "download" | "cancel" | "verify" | null;
 *   primaryLabel: "Download" | "Resume" | "Retry" | "Update" | "Repair" | "Verify" | null;
 *   canCancel: boolean;
 *   canVerify: boolean;
 * };
 * export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
 * export function fetchModelsStatus(
 *   apiBase: string,
 *   fetchImpl?: FetchLike,
 *   signal?: AbortSignal,
 * ): Promise<ModelsStatus>;
 * export function startModelDownload(apiBase: string, fetchImpl?: FetchLike): Promise<ModelsStatus>;
 * export function cancelModelDownload(apiBase: string, fetchImpl?: FetchLike): Promise<ModelsStatus>;
 * export function verifyModels(apiBase: string, fetchImpl?: FetchLike): Promise<VerifyReport>;
 * ```
 *
 * `formatBytes` uses binary units with one decimal above bytes and returns
 * `0 B` for a negative, `NaN` or infinite count. `progressPercent` floors and
 * clamps to `0..100`, and returns `0` when the total is not positive.
 * `parseModelsStatus` validates a `GET /v2/models` body without coercion and
 * returns `null` for anything malformed. `setupView` maps the status plus an
 * optional verify report to the dialog phase and primary action; the precedence
 * is active run -> failed -> cancelled -> ready (repair > update > ready) -> not
 * installed. Later is always rendered by the dialog, so it is not part of the
 * view. The adapters join `apiBase` with or without a trailing slash, surface
 * the sidecar's `{ "error": … }` envelope (then the plain body, then the status
 * text), throw on a malformed status/verify body and turn a rejected fetch into
 * the actionable unreachable-service message.
 */
import { describe, expect, it } from "vitest";

import {
  cancelModelDownload,
  fetchModelsStatus,
  formatBytes,
  parseModelsStatus,
  progressPercent,
  setupView,
  startModelDownload,
  verifyModels,
  type FetchLike,
  type ModelsStatus,
  type SetupPhase,
  type VerifyReport,
} from "./modelSetup";

const TOTAL_BYTES = 323_987_190;
const CLASSIFIER_BYTES = 8_162_917;
const OCSR_BYTES = 315_824_273;

/** The documented `GET /v2/models` body for a clean install. */
const DOCUMENTED_STATUS: ModelsStatus = {
  catalog_version: 1,
  installed_catalog_version: null,
  update_available: false,
  ready: false,
  manifest_present: false,
  total_bytes: TOTAL_BYTES,
  installed_bytes: 0,
  models: [
    {
      key: "image-classifier",
      id: "image-classifier@Iagea/d21f4cb",
      version: "Iagea/d21f4cb",
      license: "MIT",
      total_bytes: CLASSIFIER_BYTES,
      installed_bytes: 0,
      installed: false,
      missing: ["image-classifier-fp16/classifier.fp16.onnx"],
    },
    {
      key: "ocsr-handdrawn",
      id: "ocsr-handdrawn@zenodo:10781330",
      version: "zenodo:10781330",
      license: "CC-BY-4.0",
      total_bytes: OCSR_BYTES,
      installed_bytes: 0,
      installed: false,
      missing: [
        "ocsr-handdrawn-fp32/encoder.onnx",
        "ocsr-handdrawn-fp32/decoder_step.onnx",
        "ocsr-handdrawn-fp32/vocab.json",
      ],
    },
  ],
  download: {
    state: "idle",
    downloaded_bytes: 0,
    total_bytes: TOTAL_BYTES,
    current_file: null,
    error: null,
  },
};

const VERIFY_OK: VerifyReport = {
  ok: true,
  catalog_version: 1,
  checked_bytes: TOTAL_BYTES,
  artifacts: [
    { path: "image-classifier-fp16/classifier.fp16.onnx", status: "ok" },
    { path: "ocsr-handdrawn-fp32/encoder.onnx", status: "ok" },
    { path: "ocsr-handdrawn-fp32/decoder_step.onnx", status: "ok" },
    { path: "ocsr-handdrawn-fp32/vocab.json", status: "ok" },
  ],
  repair: null,
};

const VERIFY_CORRUPT: VerifyReport = {
  ok: false,
  catalog_version: 1,
  checked_bytes: 216_964_594,
  artifacts: [
    { path: "image-classifier-fp16/classifier.fp16.onnx", status: "ok" },
    {
      path: "ocsr-handdrawn-fp32/encoder.onnx",
      status: "corrupt",
      expected_sha256: "996727a2c9a432a0491d6d81c0c5d5b35afb7b2f58f7405950352c0c78193f52",
      actual_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    { path: "ocsr-handdrawn-fp32/decoder_step.onnx", status: "missing" },
  ],
  repair: "POST /v2/models/download",
};

function status(
  download: Partial<ModelsStatus["download"]> = {},
  overrides: Partial<ModelsStatus> = {},
): ModelsStatus {
  return {
    ...DOCUMENTED_STATUS,
    ...overrides,
    download: { ...DOCUMENTED_STATUS.download, ...download },
  };
}

function readyStatus(
  download: Partial<ModelsStatus["download"]> = {},
  overrides: Partial<ModelsStatus> = {},
): ModelsStatus {
  return status(
    {
      state: "ready",
      downloaded_bytes: TOTAL_BYTES,
      current_file: null,
      error: null,
      ...download,
    },
    { ready: true, manifest_present: true, installed_bytes: TOTAL_BYTES, ...overrides },
  );
}

function invalidStatus(overrides: Record<string, unknown>): unknown {
  return { ...structuredClone(DOCUMENTED_STATUS), ...overrides };
}

function invalidDownload(overrides: Record<string, unknown>): unknown {
  const value = structuredClone(DOCUMENTED_STATUS);
  return { ...value, download: { ...value.download, ...overrides } };
}

function invalidModel(index: number, overrides: Record<string, unknown>): unknown {
  const value = structuredClone(DOCUMENTED_STATUS);
  return {
    ...value,
    models: value.models.map((model, position) =>
      position === index ? { ...model, ...overrides } : model,
    ),
  };
}

function withoutDownload(): unknown {
  const value: Partial<ModelsStatus> = structuredClone(DOCUMENTED_STATUS);
  delete value.download;
  return value;
}

function withoutInstalledCatalogVersion(): unknown {
  const value = structuredClone(DOCUMENTED_STATUS) as unknown as Record<string, unknown>;
  delete value.installed_catalog_version;
  return value;
}

function withoutDownloadField(field: "current_file" | "error"): unknown {
  const value = structuredClone(DOCUMENTED_STATUS);
  delete (value.download as unknown as Record<string, unknown>)[field];
  return value;
}

/** A fetch stub that records every call and mints a fresh response. */
function fetchStub(
  make: () => Response,
  calls: Array<{ input: string; init?: RequestInit }> = [],
): FetchLike {
  return async (input, init) => {
    calls.push({ input, init });
    return make();
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("formatBytes", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [CLASSIFIER_BYTES, "7.8 MiB"],
    [OCSR_BYTES, "301.2 MiB"],
    [TOTAL_BYTES, "309.0 MiB"],
    [1_073_741_824, "1.0 GiB"],
  ];

  for (const [bytes, expected] of cases) {
    it(`formats ${bytes} bytes as ${expected}`, () => {
      expect(formatBytes(bytes)).toBe(expected);
    });
  }

  const invalid: number[] = [
    -1,
    -1024,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  for (const bytes of invalid) {
    it(`returns 0 B for ${String(bytes)}`, () => {
      expect(formatBytes(bytes)).toBe("0 B");
    });
  }
});

describe("progressPercent", () => {
  const cases: Array<[number, number, number]> = [
    [0, 0, 0],
    [0, 100, 0],
    [50, 100, 50],
    [1, 3, 33],
    [100, 100, 100],
    [150, 100, 100],
    [-1, 100, 0],
    [50, 0, 0],
    [50, -100, 0],
  ];

  for (const [downloaded, total, expected] of cases) {
    it(`reports ${downloaded}/${total} as ${expected}%`, () => {
      expect(progressPercent(downloaded, total)).toBe(expected);
    });
  }

  const nonFinite: Array<[number, number]> = [
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    [50, Number.NaN],
    [50, Number.POSITIVE_INFINITY],
  ];

  for (const [downloaded, total] of nonFinite) {
    it(`returns 0 for the non-finite pair ${String(downloaded)}/${String(total)}`, () => {
      expect(progressPercent(downloaded, total)).toBe(0);
    });
  }
});

describe("parseModelsStatus", () => {
  it("returns the documented status payload", () => {
    expect(parseModelsStatus(DOCUMENTED_STATUS)).toEqual(DOCUMENTED_STATUS);
  });

  it("accepts unknown extra fields", () => {
    const extra = {
      ...structuredClone(DOCUMENTED_STATUS),
      extra: true,
      models: DOCUMENTED_STATUS.models.map((model) => ({ ...model, extra: "x" })),
      download: { ...DOCUMENTED_STATUS.download, extra: "x" },
    };

    const parsed = parseModelsStatus(extra);

    expect(parsed).not.toBeNull();
    expect(parsed?.catalog_version).toBe(1);
    expect(parsed?.models).toHaveLength(2);
  });

  const nonObjects: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "models"],
    ["a number", 42],
    ["a boolean", true],
    ["an array", []],
  ];

  for (const [label, value] of nonObjects) {
    it(`returns null for ${label}`, () => {
      expect(parseModelsStatus(value)).toBeNull();
    });
  }

  it("returns null when download is missing", () => {
    expect(parseModelsStatus(withoutDownload())).toBeNull();
  });

  it("returns null when download is null", () => {
    expect(parseModelsStatus(invalidStatus({ download: null }))).toBeNull();
  });

  it("returns null for an unknown download state", () => {
    expect(parseModelsStatus(invalidDownload({ state: "paused" }))).toBeNull();
  });

  it("returns null when models is not an array", () => {
    expect(parseModelsStatus(invalidStatus({ models: "none" }))).toBeNull();
    expect(parseModelsStatus(invalidStatus({ models: {} }))).toBeNull();
  });

  it("returns null when a model's missing list is not a string array", () => {
    expect(parseModelsStatus(invalidModel(0, { missing: "classifier.fp16.onnx" }))).toBeNull();
    expect(parseModelsStatus(invalidModel(1, { missing: ["encoder.onnx", 7] }))).toBeNull();
  });

  it("returns null when ready is not a boolean", () => {
    expect(parseModelsStatus(invalidStatus({ ready: "yes" }))).toBeNull();
  });

  it("returns null when update_available is not a boolean", () => {
    expect(parseModelsStatus(invalidStatus({ update_available: 1 }))).toBeNull();
  });

  it("returns null when a model's installed flag is not a boolean", () => {
    expect(parseModelsStatus(invalidModel(0, { installed: 0 }))).toBeNull();
  });

  const badBytes: Array<[string, unknown]> = [
    ["a negative total", invalidStatus({ total_bytes: -1 })],
    ["a negative installed total", invalidStatus({ installed_bytes: -1 })],
    ["a non-finite total", invalidStatus({ total_bytes: Number.NaN })],
    ["a non-finite download total", invalidDownload({ total_bytes: Number.POSITIVE_INFINITY })],
    ["a negative downloaded count", invalidDownload({ downloaded_bytes: -1 })],
    ["a non-finite downloaded count", invalidDownload({ downloaded_bytes: Number.NaN })],
    ["a negative model total", invalidModel(0, { total_bytes: -1 })],
    [
      "a non-finite model installed count",
      invalidModel(1, { installed_bytes: Number.POSITIVE_INFINITY }),
    ],
  ];

  for (const [label, value] of badBytes) {
    it(`returns null for ${label}`, () => {
      expect(parseModelsStatus(value)).toBeNull();
    });
  }

  const badVersions: Array<[string, unknown]> = [
    ["a string catalog_version", invalidStatus({ catalog_version: "1" })],
    ["a fractional catalog_version", invalidStatus({ catalog_version: 1.5 })],
    ["a negative catalog_version", invalidStatus({ catalog_version: -1 })],
    ["a string installed_catalog_version", invalidStatus({ installed_catalog_version: "1" })],
    ["a fractional installed_catalog_version", invalidStatus({ installed_catalog_version: 1.5 })],
    ["a negative installed_catalog_version", invalidStatus({ installed_catalog_version: -1 })],
    ["a missing installed_catalog_version", withoutInstalledCatalogVersion()],
  ];

  for (const [label, value] of badVersions) {
    it(`returns null for ${label}`, () => {
      expect(parseModelsStatus(value)).toBeNull();
    });
  }

  const badModelStrings: Array<[string, unknown]> = [
    ["a numeric model key", invalidModel(0, { key: 7 })],
    ["a null model id", invalidModel(0, { id: null })],
    ["a numeric model version", invalidModel(1, { version: 1 })],
    ["a null model license", invalidModel(0, { license: null })],
    ["an undefined model license", invalidModel(0, { license: undefined })],
  ];

  for (const [label, value] of badModelStrings) {
    it(`returns null for ${label}`, () => {
      expect(parseModelsStatus(value)).toBeNull();
    });
  }

  const badDownloadFields: Array<[string, unknown]> = [
    ["a numeric download state", invalidDownload({ state: 3 })],
    ["a numeric current_file", invalidDownload({ current_file: 7 })],
    ["an object current_file", invalidDownload({ current_file: {} })],
    ["a missing current_file", withoutDownloadField("current_file")],
    ["a numeric download error", invalidDownload({ error: 7 })],
    ["a boolean download error", invalidDownload({ error: false })],
    ["a missing download error", withoutDownloadField("error")],
  ];

  for (const [label, value] of badDownloadFields) {
    it(`returns null for ${label}`, () => {
      expect(parseModelsStatus(value)).toBeNull();
    });
  }
});

type View = {
  phase: SetupPhase;
  primary: "download" | "cancel" | "verify" | null;
  primaryLabel: "Download" | "Resume" | "Retry" | "Update" | "Repair" | "Verify" | null;
  canCancel: boolean;
  canVerify: boolean;
};

function expectView(
  value: ModelsStatus,
  verify: VerifyReport | null | undefined,
  expected: View,
): void {
  expect(setupView(value, verify)).toEqual(expected);
}

describe("setupView", () => {
  it("shows Download when the models are not installed", () => {
    expectView(status(), undefined, {
      phase: "not-installed",
      primary: "download",
      primaryLabel: "Download",
      canCancel: false,
      canVerify: false,
    });
  });

  it("shows progress and Cancel while downloading", () => {
    expectView(
      status({
        state: "downloading",
        downloaded_bytes: 51_234_567,
        current_file: "ocsr-handdrawn-fp32/encoder.onnx",
      }),
      undefined,
      {
        phase: "downloading",
        primary: null,
        primaryLabel: null,
        canCancel: true,
        canVerify: false,
      },
    );
  });

  it("offers no Cancel while verifying", () => {
    expectView(status({ state: "verifying" }), undefined, {
      phase: "verifying",
      primary: null,
      primaryLabel: null,
      canCancel: false,
      canVerify: false,
    });
  });

  it("shows Resume after a cancelled run", () => {
    expectView(status({ state: "cancelled" }), undefined, {
      phase: "paused",
      primary: "download",
      primaryLabel: "Resume",
      canCancel: false,
      canVerify: false,
    });
  });

  it("shows Retry after a failed run", () => {
    expectView(status({ state: "failed", error: "Check the network and try again." }), undefined, {
      phase: "failed",
      primary: "download",
      primaryLabel: "Retry",
      canCancel: false,
      canVerify: false,
    });
  });

  it("shows Verify on a ready install", () => {
    expectView(readyStatus(), undefined, {
      phase: "ready",
      primary: "verify",
      primaryLabel: "Verify",
      canCancel: false,
      canVerify: true,
    });
  });

  it("keeps Verify when the verify report is ok", () => {
    expectView(readyStatus(), VERIFY_OK, {
      phase: "ready",
      primary: "verify",
      primaryLabel: "Verify",
      canCancel: false,
      canVerify: true,
    });
  });

  it("shows Update when the installed catalog is older", () => {
    expectView(readyStatus({}, { update_available: true }), VERIFY_OK, {
      phase: "update",
      primary: "download",
      primaryLabel: "Update",
      canCancel: false,
      canVerify: true,
    });
  });

  it("shows Repair when the verify report lists a problem", () => {
    expectView(readyStatus(), VERIFY_CORRUPT, {
      phase: "repair",
      primary: "download",
      primaryLabel: "Repair",
      canCancel: false,
      canVerify: true,
    });
  });

  it("keeps Retry when a repair run fails on a ready install", () => {
    expectView(
      readyStatus({ state: "failed", downloaded_bytes: 0, error: "The download failed." }),
      undefined,
      {
        phase: "failed",
        primary: "download",
        primaryLabel: "Retry",
        canCancel: false,
        canVerify: false,
      },
    );
  });

  it("prefers the verify failure over an available update", () => {
    expectView(readyStatus({}, { update_available: true }), VERIFY_CORRUPT, {
      phase: "repair",
      primary: "download",
      primaryLabel: "Repair",
      canCancel: false,
      canVerify: true,
    });
  });

  it("lets an active run win over a ready install", () => {
    expectView(readyStatus({ state: "downloading" }), undefined, {
      phase: "downloading",
      primary: null,
      primaryLabel: null,
      canCancel: true,
      canVerify: false,
    });
  });

  const canVerifyCases: Array<[string, ModelsStatus, VerifyReport | null, boolean]> = [
    ["a clean install", status(), null, false],
    ["a downloading run", status({ state: "downloading" }), null, false],
    ["a verifying run", status({ state: "verifying" }), null, false],
    ["a cancelled run", status({ state: "cancelled" }), null, false],
    ["a failed run", status({ state: "failed" }), null, false],
    ["a ready install", readyStatus(), null, true],
    ["a ready install with an update", readyStatus({}, { update_available: true }), null, true],
    ["a ready install with a verify failure", readyStatus(), VERIFY_CORRUPT, true],
  ];

  for (const [label, value, verify, expected] of canVerifyCases) {
    it(`sets canVerify to ${expected} for ${label}`, () => {
      expect(setupView(value, verify).canVerify).toBe(expected);
    });
  }
});

const API = "http://127.0.0.1:9321/v2";

type FetchCall = { input: string; init?: RequestInit };

describe("model HTTP adapters", () => {
  it("reads the status from a base with and without a trailing slash", async () => {
    for (const base of [API, `${API}/`]) {
      const calls: FetchCall[] = [];
      const fetchImpl = fetchStub(() => jsonResponse(DOCUMENTED_STATUS), calls);

      const status = await fetchModelsStatus(base, fetchImpl);

      expect(status).toEqual(DOCUMENTED_STATUS);
      expect(calls).toHaveLength(1);
      expect(calls[0].input).toBe(`${API}/models`);
      expect(calls[0].init?.method).toBeUndefined();
    }
  });

  it("surfaces the error envelope of a failed status read", async () => {
    const fetchImpl = fetchStub(() =>
      jsonResponse({ error: "the sidecar exploded" }, { status: 500 }),
    );

    await expect(fetchModelsStatus(API, fetchImpl)).rejects.toThrow(
      "Could not read the model status (HTTP 500): the sidecar exploded",
    );
  });

  it("uses a plain-text error body verbatim", async () => {
    const fetchImpl = fetchStub(() => new Response("no models here", { status: 503 }));

    await expect(fetchModelsStatus(API, fetchImpl)).rejects.toThrow(
      "Could not read the model status (HTTP 503): no models here",
    );
  });

  it("falls back to the status text when the body is empty", async () => {
    const fetchImpl = fetchStub(() => new Response("", { status: 502, statusText: "Bad Gateway" }));

    await expect(fetchModelsStatus(API, fetchImpl)).rejects.toThrow(
      "Could not read the model status (HTTP 502): Bad Gateway",
    );
  });

  it("keeps a JSON body that has no error string as the detail", async () => {
    const fetchImpl = fetchStub(() => jsonResponse({ message: "nope" }, { status: 400 }));

    await expect(fetchModelsStatus(API, fetchImpl)).rejects.toThrow('{"message":"nope"}');
  });

  it("rejects a status body that does not validate", async () => {
    const fetchImpl = fetchStub(() => jsonResponse({ ...DOCUMENTED_STATUS, ready: "yes" }));

    await expect(fetchModelsStatus(API, fetchImpl)).rejects.toThrow(
      "the response was not a valid model status",
    );
  });

  it("posts the action routes to the documented endpoints", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchStub(() => jsonResponse(readyStatus(), { status: 202 }), calls);

    await startModelDownload(API, fetchImpl);
    await cancelModelDownload(API, fetchImpl);

    expect(calls.map((call) => [call.input, call.init?.method])).toEqual([
      [`${API}/models/download`, "POST"],
      [`${API}/models/download/cancel`, "POST"],
    ]);
  });

  it("surfaces a 409 while a download action is refused", async () => {
    const fetchImpl = fetchStub(() =>
      jsonResponse({ error: "a model run is already active" }, { status: 409 }),
    );

    await expect(startModelDownload(API, fetchImpl)).rejects.toThrow(
      "Could not start the model download (HTTP 409): a model run is already active",
    );
  });

  it("surfaces a 409 while a cancel is refused", async () => {
    const fetchImpl = fetchStub(() =>
      jsonResponse({ error: "the download is verifying" }, { status: 409 }),
    );

    await expect(cancelModelDownload(API, fetchImpl)).rejects.toThrow(
      "Could not cancel the model download (HTTP 409): the download is verifying",
    );
  });

  it("returns the parsed verify report", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = fetchStub(() => jsonResponse(VERIFY_OK), calls);

    const report = await verifyModels(`${API}/`, fetchImpl);

    expect(report).toEqual(VERIFY_OK);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(`${API}/models/verify`);
    expect(calls[0].init?.method).toBe("POST");
  });

  it("surfaces a failed verify request", async () => {
    const fetchImpl = fetchStub(() =>
      jsonResponse({ error: "verification is unavailable" }, { status: 409 }),
    );

    await expect(verifyModels(API, fetchImpl)).rejects.toThrow(
      "Could not verify the models (HTTP 409): verification is unavailable",
    );
  });

  it("rejects a verify body that does not validate", async () => {
    const fetchImpl = fetchStub(() => jsonResponse({ ok: true, catalog_version: 1 }));

    await expect(verifyModels(API, fetchImpl)).rejects.toThrow(
      "the response was not a valid verify report",
    );
  });

  it("maps an unreachable service to the actionable message", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    await expect(fetchModelsStatus(API, fetchImpl)).rejects.toThrow(
      `Could not reach the local model service at ${API}.`,
    );
  });

  it("maps an unreachable verify request the same way", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    await expect(verifyModels(API, fetchImpl)).rejects.toThrow(
      `Could not reach the local model service at ${API}.`,
    );
  });
});
