import 'ketcher-react/dist/index.css';

import { Editor } from 'ketcher-react';
import { StandaloneStructServiceProvider } from 'ketcher-standalone';


const structServiceProvider = new StandaloneStructServiceProvider();

function App() {
  return (
    <Editor
      staticResourcesUrl={"/public"}
      structServiceProvider={structServiceProvider}
      errorHandler={(message) => {
        console.error('Ketcher error:', message);
        // Aquí puedes mostrar un toast, notificación, etc.
      }}
    />
  )}

export default App;
