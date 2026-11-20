/**
 * Renders one template's KET to a preview object URL (`docs/architecture.md`
 * §5.11).
 *
 * Ketcher draws the preview itself (`generateImage(ket, { outputFormat: "svg" })`),
 * so the card shows exactly the structure it inserts. The result is cached per
 * KET in a module-level map for the whole session: reshuffles and reopening the
 * backstage reuse the same object URL and never re-render. Nothing is revoked
 * during the session; the cache dies with the page.
 */

import { useEffect, useState } from "react";

export interface TemplatePreviewState {
  status: "loading" | "ready" | "error";
  /** The object URL when `status` is `ready`. */
  url?: string;
}

/** `ket` → object URL, for the lifetime of the session. */
const previewCache = new Map<string, string>();

/** In-flight renders, so two cards for the same KET share one render. */
const pendingRenders = new Map<string, Promise<string>>();

function renderPreview(ket: string, render: (ket: string) => Promise<string>): Promise<string> {
  const cached = previewCache.get(ket);
  if (cached !== undefined) return Promise.resolve(cached);

  const pending = pendingRenders.get(ket);
  if (pending !== undefined) return pending;

  const request = render(ket)
    .then((url) => {
      previewCache.set(ket, url);
      return url;
    })
    .finally(() => {
      pendingRenders.delete(ket);
    });

  pendingRenders.set(ket, request);
  return request;
}

/** The settled result of one render, tagged with the KET it belongs to. */
interface RenderResult {
  ket: string;
  url?: string;
}

/**
 * Resolves the preview for `ket` through `render` and returns its state. A
 * cached preview is available on the first render; a failing render settles as
 * `error` and is never retried in a loop.
 */
export function useTemplatePreview(
  ket: string,
  render: (ket: string) => Promise<string>,
): TemplatePreviewState {
  const [result, setResult] = useState<RenderResult | null>(null);

  useEffect(() => {
    if (previewCache.has(ket)) return;

    let cancelled = false;
    renderPreview(ket, render).then(
      (url) => {
        if (!cancelled) setResult({ ket, url });
      },
      () => {
        if (!cancelled) setResult({ ket });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [ket, render]);

  const cached = previewCache.get(ket);
  if (cached !== undefined) return { status: "ready", url: cached };

  if (result !== null && result.ket === ket) {
    return result.url === undefined ? { status: "error" } : { status: "ready", url: result.url };
  }

  return { status: "loading" };
}
