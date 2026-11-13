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
import { message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/**
 * Substring → friendly copy for errors surfaced by Ketcher or the sidecar.
 *
 * Recognize Molecule failures arrive as the stringified `FAILURE` body
 * (`{"state":"FAILURE","error":"…"}`), so these keys are substrings of the
 * documented sidecar messages, not whole strings. The copy is UI-owned: it
 * must never echo the raw JSON.
 */
const SIMPLE_ERRORS: Record<string, string> = {
  "No molecule was detected in this image.":
    "No chemical structure was detected in this image. Try a clear image of one drawn molecule, or draw the structure in the editor.",
  "The structure could not be read confidently.":
    "The structure could not be read confidently. Try a sharper or larger image of one molecule.",
  "Recognition models are not available.":
    "Molecule recognition is not set up. Check that the image-classifier and OCSR models are installed (see CHEMISTRY_MODELS_DIR) and restart the app.",
  "The recognized structure could not be prepared for the editor.":
    "The structure was recognized but could not be prepared for the editor. Please try again.",
  "Unsupported image. Use a PNG, JPEG or WebP file.":
    "This image cannot be used. Choose a PNG, JPEG or WebP file.",
  "unsupported image content type":
    "This image format is not supported. Choose a PNG, JPEG or WebP file.",
  "Recognition timed out. Try again.": "Recognition took too long. Please try again.",
  "unknown recognition job":
    "The recognition result expired before it reached the editor. Please try again.",
  // An over-cap upload is `413` with a plain-text body (axum's body limit, not
  // `{ "error": … }`), so Ketcher's `response.json()` throws a parse error.
  "Unexpected token": "The server could not process the image. It may be too large.",
  "is not valid JSON": "The server could not process the image. It may be too large.",
  "JSON Parse error": "The server could not process the image. It may be too large.",
  "Failed to buffer the request body":
    "The server could not process the image. It may be too large.",
  "already have edge between vertices":
    "The structure contains duplicate bonds. Please remove overlapping bonds and try again.",
  "Indigo load error":
    "Cannot read the structure. The data may be corrupted or in an unsupported format.",
  "Load failed": "The chemistry server is not responding. Restart the app or check the connection.",
  "Connection terminated unexpectedly":
    "The chemistry server stopped unexpectedly. Restart the app.",
};

const GENERIC_FAILURE = "Recognition failed. Please try again.";

/**
 * Unwraps Ketcher's stringified error body.
 *
 * `RemoteStructService` throws `new Error(JSON.stringify(response))` for a
 * `FAILURE` job, and the editor either reports `error.message` or the error
 * object (whose `String()` is `Error: {…}`). Returns the inner
 * `error`/`message` text and whether the input carried a JSON body.
 *
 * A JSON object without a usable `error`/`message` still counts as JSON: the
 * structured protocol failed, so the caller shows the generic failure instead
 * of echoing raw JSON. Only non-JSON text falls back to the plain message.
 */
function unwrapError(msg: string): { detail: string; json: boolean } {
  const trimmed = msg.trim().replace(/^Error:\s*/, "");
  if (!trimmed.startsWith("{")) return { detail: msg, json: false };

  try {
    const body: unknown = JSON.parse(trimmed);
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const detail = record.error ?? record.message;
      return { detail: typeof detail === "string" ? detail : "", json: true };
    }
  } catch {
    // Not JSON: fall back to the plain message.
  }

  return { detail: msg, json: false };
}

/** Returns friendly copy for an already-unwrapped message, or `""`. */
function friendly(detail: string): string {
  for (const [key, hint] of Object.entries(SIMPLE_ERRORS)) {
    if (detail.includes(key)) return hint;
  }
  return "";
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
    const { detail, json } = unwrapError(msg);
    const hint = friendly(detail);
    // A stringified failure gets friendly copy even when its message is unknown.
    const known = hint !== "" || json;
    const text = hint || (known ? GENERIC_FAILURE : msg);
    const title = known ? "Structure problem" : "Error";
    message(text, { title, kind: "error" }).catch(() => {
      alert(`${title}: ${text}`);
    });
  }, []);

  return (
    <>
      {(!provider || !ready) && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "sans-serif",
            color: "#888",
            fontSize: "1.2em",
            background: "#fff",
          }}
        >
          Loading chemistry editor...
        </div>
      )}
      {provider && (
        <Editor
          staticResourcesUrl={"."}
          structServiceProvider={provider}
          errorHandler={handleError}
          onInit={handleInit}
        />
      )}
    </>
  );
}

export default App;
