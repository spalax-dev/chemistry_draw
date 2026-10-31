import 'ketcher-react/dist/index.css';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor } from 'ketcher-react';
import { RemoteStructServiceProvider } from 'ketcher-core';
import { message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const SIMPLE_ERRORS: Record<string, string> = {
  'already have edge between vertices':
    'The structure contains duplicate bonds. Please remove overlapping bonds and try again.',
  'Indigo load error':
    'Cannot read the structure. The data may be corrupted or in an unsupported format.',
  'Load failed':
    'The chemistry server is not responding. Restart the app or check the connection.',
  'Connection terminated unexpectedly':
    'The chemistry server stopped unexpectedly. Restart the app.',
};

function friendly(msg: string): string {
  for (const [key, hint] of Object.entries(SIMPLE_ERRORS)) {
    if (msg.includes(key)) return hint;
  }
  return '';
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
      port = await invoke<number>('indigo_port');
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

function App() {
  const lastError = useRef<{ msg: string; at: number }>({ msg: '', at: 0 });
  const [ready, setReady] = useState(false);
  const [provider, setProvider] = useState<RemoteStructServiceProvider | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveApiBase().then((apiBase) => {
      if (cancelled) return;
      console.info('[chemistry-draw] Indigo API:', apiBase);
      setProvider(new RemoteStructServiceProvider(apiBase));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInit = useCallback((ketcher: any) => {
    const currentOptions = ketcher.editor.options();
    ketcher.editor.options({
      ...currentOptions,
      app: { ...currentOptions.app, server: true },
    });
    setReady(true);
  }, []);

  const handleError = useCallback((raw: unknown) => {
    const msg = typeof raw === 'string' ? raw : String(raw);
    console.error('Ketcher error:', msg);
    const now = Date.now();
    if (msg === lastError.current.msg && now - lastError.current.at < 5000) return;
    lastError.current = { msg, at: now };
    const hint = friendly(msg);
    const text = hint || msg;
    const title = hint ? 'Structure problem' : 'Error';
    message(text, { title, kind: 'error' }).catch(() => {
      alert(`${title}: ${text}`);
    });
  }, []);

  return (
    <>
      {(!provider || !ready) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'sans-serif', color: '#888', fontSize: '1.2em',
          background: '#fff',
        }}>
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
