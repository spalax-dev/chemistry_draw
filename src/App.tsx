import 'ketcher-react/dist/index.css';

import { useCallback, useRef } from 'react';
import { Editor } from 'ketcher-react';
import { RemoteStructServiceProvider } from 'ketcher-core';
import { message } from '@tauri-apps/plugin-dialog';

const structServiceProvider = new RemoteStructServiceProvider('http://localhost:9321/v2');

const SIMPLE_ERRORS: Record<string, string> = {
  'already have edge between vertices':
    'The structure contains duplicate bonds. Please remove overlapping bonds and try again.',
  'Indigo load error':
    'Cannot read the structure. The data may be corrupted or in an unsupported format.',
  'Load failed':
    'The chemistry server is not responding. Restart the app or check the connection.',
};

function friendly(msg: string): string {
  for (const [key, hint] of Object.entries(SIMPLE_ERRORS)) {
    if (msg.includes(key)) return hint;
  }
  return '';
}

function App() {
  const lastError = useRef<{ msg: string; at: number }>({ msg: '', at: 0 });

  const handleInit = useCallback((ketcher: any) => {
    const currentOptions = ketcher.editor.options();
    ketcher.editor.options({
      ...currentOptions,
      app: { ...currentOptions.app, server: true },
    });
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
    <Editor
      staticResourcesUrl={"."}
      structServiceProvider={structServiceProvider}
      errorHandler={handleError}
      onInit={handleInit}
    />
  );
}

export default App;
