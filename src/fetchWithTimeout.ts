/**
 * Fetch a URL with a hard timeout backed by the platform timeout signal.
 *
 * `AbortSignal.timeout(ms)` is Baseline 2024: it exists since Chrome 103,
 * Firefox 100 and Safari 16, but Chrome 103–123 abort with `AbortError`
 * instead of `TimeoutError`. The Tauri WebView (WebKitGTK 2.40+, the engine
 * behind webkit2gtk 4.1) and the browser dev server have full support, so the
 * timeout rejects with `TimeoutError`. The caller already treats every fetch
 * error as "not ready yet", so no AbortError-specific handling is needed.
 */
export async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}
