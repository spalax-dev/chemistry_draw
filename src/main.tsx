import ReactDOM from "react-dom/client";
import App from "./App";
import { initLogging } from "./logging";

// Install before rendering so every console call and startup error is logged.
initLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
