/**
 * Forward the frontend's console and uncaught errors to the Tauri log file.
 *
 * The log plugin writes to the platform log directory with rotation, so a
 * user reporting a problem can just send us the files (see `log_dir`).
 *
 * This is deliberately transparent: `console.*` keeps working as usual and
 * every call is mirrored into the log. Outside Tauri (plain `pnpm dev` in a
 * browser) it is a no-op.
 */
import { debug, info, warn, error } from "@tauri-apps/plugin-log";

type Level = "debug" | "info" | "warn" | "error";

const inTauri = "__TAURI_INTERNALS__" in window;

const sink: Record<Level, (message: string) => Promise<void>> = {
  debug,
  info,
  warn,
  error,
};

/** Never let logging break the app (the IPC may not be ready yet). */
function emit(level: Level, message: string): void {
  if (!inTauri) return;
  void sink[level](message).catch(() => {});
}

/** Render arbitrary console arguments as a single readable line. */
function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

let installed = false;

export function initLogging(): void {
  if (!inTauri || installed) return;
  installed = true;

  const levels: Level[] = ["debug", "info", "warn", "error"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      emit(level, format(args));
    };
  }

  window.addEventListener("error", (event) => {
    const where = event.filename
      ? ` (${event.filename}:${event.lineno}:${event.colno})`
      : "";
    emit("error", `uncaught error: ${event.message}${where}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    emit("error", `unhandled rejection: ${format([event.reason])}`);
  });

  // Enough context to tell one report from another.
  emit(
    "info",
    `[frontend] session start: ${navigator.userAgent} | ` +
      `lang=${navigator.language} | ` +
      `screen=${window.screen.width}x${window.screen.height}@${window.devicePixelRatio}x`,
  );
}
