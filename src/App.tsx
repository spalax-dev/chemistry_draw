import 'ketcher-react/dist/index.css';

import { useCallback } from 'react';
import { Editor } from 'ketcher-react';
import { RemoteStructServiceProvider } from 'ketcher-core';

const structServiceProvider = new RemoteStructServiceProvider('http://localhost:9321/v2');

function App() {
  const handleInit = useCallback((ketcher: any) => {
    const currentOptions = ketcher.editor.options();
    ketcher.editor.options({
      ...currentOptions,
      app: { ...currentOptions.app, server: true },
    });
  }, []);

  return (
    <Editor
      staticResourcesUrl={"/public"}
      structServiceProvider={structServiceProvider}
      errorHandler={(message) => {
        console.error('Ketcher error:', message);
      }}
      onInit={handleInit}
    />
  );
}

export default App;
