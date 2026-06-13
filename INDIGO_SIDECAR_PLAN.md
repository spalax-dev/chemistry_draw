# Sidecar Rust: Indigo HTTP Service para Tauri v2 + Ketcher

## Arquitectura

```
Ketcher (JS) ←→ Tauri v2 Shell ←→ sidecar (Rust/axum) ←FFI→ libindigo.so
                                    ↑
                                localhost:9321
```

Ketcher configura `apiPath: "http://localhost:9321/v2"`. Tauri v2 spawn el sidecar como proceso hijo al arrancar via `tauri-plugin-shell`.

---

## 1. Estructura del proyecto

```
chemistry-draw/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json
├── sidecar/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs          ← servidor HTTP (axum)
│   │   ├── indigo.rs        ← FFI declarations
│   │   ├── handlers.rs      ← route handlers
│   │   └── models.rs        ← request/response types
│   └── build.rs
├── lib/                      ← .so compilados de Indigo
│   └── linux-x86_64/
│       ├── libindigo.so
│       ├── libindigo-renderer.so
│       └── libindigo-inchi.so
└── ...
```

---

## 2. Dependencias del sidecar (`sidecar/Cargo.toml`)

```toml
[package]
name = "indigo-server"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tower-http = { version = "0.5", features = ["cors"] }
base64 = "0.22"
libc = "0.2"
anyhow = "1"
```

**Nota:** `anyhow` agregado — se usa en `indigo.rs` para errores.

---

## 3. FFI declarations (`sidecar/src/indigo.rs`)

Sin cambios del plan original. El contenido es exactamente el mismo:

```rust
use std::ffi::{CStr, CString};
use std::sync::Mutex;
use libc::c_char;

thread_local! {
    static INDIGO_SESSION: Mutex<i32> = const { Mutex::new(0) };
}

extern "C" {
    // -- Sesiones --
    fn indigoAllocSessionId() -> i32;
    fn indigoSetSessionId(sid: i32);
    fn indigoReleaseSessionId(sid: i32);

    // -- Moléculas --
    fn indigoLoadMoleculeFromString(str: *const c_char) -> i32;
    fn indigoLoadQueryMoleculeFromString(str: *const c_char) -> i32;
    fn indigoLoadReactionFromString(str: *const c_char) -> i32;

    // -- Buffer I/O (usado por render y serialize) --
    fn indigoWriteBuffer() -> i32;
    fn indigoReadBuffer(buf: *const c_char) -> i32;

    // -- Operaciones --
    fn indigoAromatize(handle: i32) -> i32;
    fn indigoDearomatize(handle: i32) -> i32;
    fn indigoLayout(handle: i32);
    fn indigoClean2d(handle: i32);

    // -- Serialización --
    fn indigoSerialize(handle: i32) -> *const c_char;
    fn indigoToString(handle: i32) -> *const c_char;

    // -- Propiedades --
    fn indigoMolecularWeight(handle: i32) -> f32;
    fn indigoMostAbundantMass(handle: i32) -> f32;
    fn indigoMonoisotopicMass(handle: i32) -> f32;
    fn indigoGrossFormula(handle: i32) -> *const c_char;
    fn indigoMassComposition(handle: i32) -> *const c_char;

    // -- Validación --
    fn indigoCheckObj(handle: i32, properties: *const c_char) -> *const c_char;

    // -- Substructure --
    fn indigoSubstructureMatcher(target: i32, query: i32) -> i32;
    fn indigoMatch(matcher: i32) -> *const c_char;
    fn indigoCountMatches(matcher: i32) -> i32;

    // -- Automap --
    fn indigoAutomap(handle: i32, mode: *const c_char);

    // -- Render (requiere libindigo-renderer.so cargada) --
    // Uso: buf = indigoWriteBuffer() → indigoRender(handle, buf) → indigoToString(buf)
    fn indigoRender(handle: i32, output: i32);

    // -- Version --
    fn indigoVersion() -> *const c_char;
    fn indigoVersionInfo() -> *const c_char;

    // -- Options --
    fn indigoSetOptionString(name: *const c_char, value: *const c_char);
    fn indigoSetOptionInt(name: *const c_char, value: i32);
    fn indigoSetOptionBool(name: *const c_char, value: i32);
    fn indigoGetOption(name: *const c_char) -> *const c_char;

    // -- Limpieza --
    fn indigoFree(handle: i32);
}

// ─── Wrappers seguros ───

pub fn init_session() -> anyhow::Result<i32> {
    let sid = unsafe { indigoAllocSessionId() };
    unsafe { indigoSetSessionId(sid) };
    INDIGO_SESSION.with(|s| *s.lock().unwrap() = sid);
    unsafe {
        indigoSetOptionBool(CString::new("ignore-stereochemistry-errors\0").unwrap().as_ptr(), 1);
        indigoSetOptionBool(CString::new("smart-layout\0").unwrap().as_ptr(), 1);
        indigoSetOptionBool(CString::new("gross-formula-add-rsites\0").unwrap().as_ptr(), 1);
    }
    Ok(sid)
}

pub fn release_session(sid: i32) {
    unsafe { indigoReleaseSessionId(sid) };
}

pub fn load_structure(s: &str) -> anyhow::Result<i32> {
    let c_str = CString::new(s)?;
    let handle = unsafe { indigoLoadMoleculeFromString(c_str.as_ptr()) };
    if handle < 0 {
        return Err(anyhow::anyhow!("Indigo load error: {}", last_error()));
    }
    Ok(handle)
}

pub fn load_reaction(s: &str) -> anyhow::Result<i32> {
    let c_str = CString::new(s)?;
    let handle = unsafe { indigoLoadReactionFromString(c_str.as_ptr()) };
    if handle < 0 {
        return Err(anyhow::anyhow!("Indigo load reaction error"));
    }
    Ok(handle)
}

pub fn convert(handle: i32, output_format: &str) -> anyhow::Result<String> {
    unsafe {
        indigoSetOptionString(
            CString::new("output-format\0").unwrap().as_ptr(),
            CString::new(output_format).unwrap().as_ptr(),
        );
    }
    let ptr = unsafe { indigoToString(handle) };
    if ptr.is_null() {
        return Err(anyhow::anyhow!("indigoToString returned null"));
    }
    let s = unsafe { CStr::from_ptr(ptr) }.to_str()?.to_owned();
    unsafe { indigoFree(handle) };
    Ok(s)
}

pub fn aromatize(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoAromatize(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("aromatize failed"));
    }
    Ok(res)
}

pub fn dearomatize(handle: i32) -> anyhow::Result<i32> {
    let res = unsafe { indigoDearomatize(handle) };
    if res < 0 {
        return Err(anyhow::anyhow!("dearomatize failed"));
    }
    Ok(res)
}

pub fn layout(handle: i32) {
    unsafe { indigoLayout(handle) };
}

pub fn clean2d(handle: i32) {
    unsafe { indigoClean2d(handle) };
}

pub fn calculate_mw(handle: i32) -> f32 {
    unsafe { indigoMolecularWeight(handle) }
}

pub fn calculate_gross(handle: i32) -> String {
    let ptr = unsafe { indigoGrossFormula(handle) };
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }.to_str().unwrap_or("").to_owned()
}

pub fn check_structure(s: &str, types: &str) -> anyhow::Result<String> {
    let handle = load_structure(s)?;
    let c_types = CString::new(types)?;
    let ptr = unsafe { indigoCheckObj(handle, c_types.as_ptr()) };
    unsafe { indigoFree(handle) };
    if ptr.is_null() {
        return Ok("[]".to_owned());
    }
    Ok(unsafe { CStr::from_ptr(ptr) }.to_str()?.to_owned())
}

pub fn render_to_buffer(handle: i32, fmt: &str) -> anyhow::Result<Vec<u8>> {
    unsafe {
        indigoSetOptionString(
            CString::new("render-output-format\0").unwrap().as_ptr(),
            CString::new(fmt).unwrap().as_ptr(),
        );
    }
    let buf = unsafe { indigoWriteBuffer() };
    unsafe { indigoRender(handle, buf) };
    let ptr = unsafe { indigoToString(buf) };
    if ptr.is_null() {
        unsafe { indigoFree(buf) };
        return Err(anyhow::anyhow!("render failed"));
    }
    let result = unsafe { CStr::from_ptr(ptr) }.to_bytes().to_vec();
    unsafe { indigoFree(buf) };
    Ok(result)
}

pub fn version() -> String {
    let ptr = unsafe { indigoVersion() };
    if ptr.is_null() {
        return "unknown".into();
    }
    unsafe { CStr::from_ptr(ptr) }.to_str().unwrap_or("unknown").to_owned()
}

pub fn version_info() -> String {
    let ptr = unsafe { indigoVersionInfo() };
    if ptr.is_null() {
        return "{}".into();
    }
    unsafe { CStr::from_ptr(ptr) }.to_str().unwrap_or("{}").to_owned()
}

fn last_error() -> String {
    let ptr = unsafe { indigoGetOption(CString::new("error\0").unwrap().as_ptr()) };
    if ptr.is_null() {
        return "unknown error".into();
    }
    unsafe { CStr::from_ptr(ptr) }.to_str().unwrap_or("unknown").to_owned()
}
```

---

## 4. Modelos (`sidecar/src/models.rs`)

Sin cambios. El código es idéntico al plan original.

---

## 5. HTTP Handlers (`sidecar/src/handlers.rs`)

Sin cambios en la lógica de handlers. El código es idéntico al plan original.

---

## 6. Main del sidecar (`sidecar/src/main.rs`)

Sin cambios en el servidor axum. El código es idéntico al plan original.

---

## 7. Tauri v2: agregar plugin shell al proyecto

### 7a. Agregar `tauri-plugin-shell` a `src-tauri/Cargo.toml`

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-shell = "2"          # ← NUEVO
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 7b. Agregar `@tauri-apps/plugin-shell` al frontend

```bash
pnpm add @tauri-apps/plugin-shell
```

---

## 8. Tauri v2: configurar sidecar en `tauri.conf.json`

```json
{
  "bundle": {
    "externalBin": [
      "sidecar/target/release/indigo-server"
    ],
    "resources": {
      "../lib/**/*": "lib/"
    }
  }
}
```

**Nota:** En Tauri v2 `resources` puede ser objeto `{ source: destination }` o array. Las `.so` se copian a `lib/` dentro del bundle.

No hay `allowlist` en Tauri v2. Los permisos van en capabilities.

---

## 9. Tauri v2: permisos de shell en capabilities

Editar `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for chemistry-draw",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "fs:default",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:allow-read-file",
    "fs:allow-write-file",
    {
      "identifier": "fs:scope",
      "allow": [{ "path": "**" }]
    },
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "indigo-server",
          "sidecar": true,
          "args": true
        }
      ]
    },
    {
      "identifier": "shell:allow-spawn",
      "allow": [
        {
          "name": "indigo-server",
          "sidecar": true,
          "args": true
        }
      ]
    },
    "shell:allow-kill",
    "shell:allow-stdin-write"
  ]
}
```

---

## 10. Tauri v2: spawn del sidecar desde Rust

Reemplazar `src-tauri/src/lib.rs`:

```rust
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())       // ← NUEVO
        .setup(|app| {
            // Spawn sidecar indigo-server al arrancar
            let port: u16 = std::env::var("INDIGO_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(9321);

            // Pasar env vars al sidecar
            // NOTA: Tauri v2 no hereda env automáticamente.
            let sidecar_cmd = app.shell()
                .sidecar("indigo-server")
                .expect("Failed to create sidecar command")
                .env("INDIGO_PORT", port.to_string())
                // LD_LIBRARY_PATH para encontrar libindigo.so
                .env("LD_LIBRARY_PATH",
                     format!("{}/lib/linux-x86_64",
                             app.path().resource_dir()
                                 .unwrap_or_default()
                                 .to_string_lossy()));

            // Spawn como proceso long-running
            tauri::async_runtime::spawn(async move {
                let (mut rx, _child) = sidecar_cmd
                    .spawn()
                    .expect("Failed to spawn indigo-server sidecar");

                while let Some(event) = rx.recv().await {
                    use tauri_plugin_shell::process::CommandEvent;
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[indigo-server] {}",
                                     String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[indigo-server:err] {}",
                                      String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[indigo-server] exited with {:?}",
                                      payload.code);
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Diferencias clave con Tauri v1:**
- `app.shell().sidecar("name")` en vez de `Command::new_sidecar("name")`
- `tauri_plugin_shell::ShellExt` trait necesario
- No hay `tauri::api::process::CommandEvent`; usar `tauri_plugin_shell::process::CommandEvent`
- Env vars se pasan con `.env("KEY", "val")` — no heredan automáticamente
- `.spawn()` retorna `(Receiver<CommandEvent>, Child)` igual que v1

---

## 11. Frontend: cambiar Ketcher a RemoteStructServiceProvider

En `src/App.tsx`, reemplazar `StandaloneStructServiceProvider` por `RemoteStructServiceProvider`:

```tsx
import 'ketcher-react/dist/index.css';

import { Editor } from 'ketcher-react';
import { RemoteStructServiceProvider } from 'ketcher-standalone';

const structServiceProvider = new RemoteStructServiceProvider({
  apiPath: 'http://localhost:9321/v2',
});

function App() {
  return (
    <Editor
      staticResourcesUrl={"/public"}
      structServiceProvider={structServiceProvider}
      errorHandler={(message) => {
        console.error('Ketcher error:', message);
      }}
    />
  );
}

export default App;
```

---

## 12. Compilar Indigo

Sin cambios:

```bash
cmake -B build_minimal \
  -DBUILD_STANDALONE=ON \
  -DBUILD_INDIGO=ON \
  -DBUILD_INDIGO_WRAPPERS=OFF \
  -DBUILD_INDIGO_UTILS=OFF \
  -DBUILD_BINGO=OFF \
  -DBUILD_BINGO_ELASTIC=OFF \
  -DENABLE_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build_minimal -j$(nproc)
```

Los `.so` quedan en `build_minimal/bin/`. Cópialos a `lib/linux-x86_64/`.

---

## 13. Compilar sidecar

```bash
cd sidecar/
export LD_LIBRARY_PATH=$PWD/../lib/linux-x86_64:$LD_LIBRARY_PATH
cargo build --release
```

### `sidecar/build.rs` (sin cambios)

```rust
fn main() {
    println!("cargo:rustc-link-search=../lib/linux-x86_64");
    println!("cargo:rustc-link-lib=dylib=indigo");
    println!("cargo:rustc-link-lib=dylib=indigo-renderer");
}
```

En runtime las `.so` se buscan via `LD_LIBRARY_PATH` seteado al spawnear el sidecar desde Rust (ver sección 10).

---

## 14. Endpoints finales

| Method | Path | Status |
|--------|------|--------|
| GET | `/v2/info` | ✅ |
| GET | `/v2/indigo/info` | ✅ |
| POST | `/v2/indigo/convert` | ✅ |
| POST | `/v2/indigo/aromatize` | ✅ |
| POST | `/v2/indigo/dearomatize` | ✅ |
| POST | `/v2/indigo/layout` | ✅ |
| POST | `/v2/indigo/clean` | ✅ |
| POST | `/v2/indigo/render` | ✅ |
| POST | `/v2/indigo/calculate` | ✅ |
| POST | `/v2/indigo/check` | ✅ |
| POST | `/v2/indigo/calculate_cip` | ⬜ TODO |
| POST | `/v2/indigo/automap` | ⬜ TODO |
| POST | `/v2/indigo/expand` | ⬜ TODO |
| POST | `/v2/indigo/calculateMacroProperties` | ⬜ TODO |

---

## 15. Notas importantes

- **Tauri v2 vs v1:** La API cambió significativamente. `tauri::api::process::Command` no existe en v2. Todo proceso externo se maneja via `tauri-plugin-shell`.
- **Env vars no se heredan:** En Tauri v2, el sidecar NO hereda variables de entorno del padre. Debes pasar `LD_LIBRARY_PATH` y `INDIGO_PORT` explícitamente con `.env()`.
- **Thread-safety:** Indigo usa sesiones thread-local. Cada request HTTP crea su propia sesión con `indigoAllocSessionId()`. No hay estado compartido.
- **Render:** `libindigo-renderer.so` debe estar disponible. Usa Cairo internamente (vendredo en BUILD_STANDALONE).
- **Macromoléculas:** Si Ketcher necesita secuencias/FASTA/HELM, hay que agregar `indigoLoadSequence`, `indigoLoadFasta`, `indigoLoadHelm` al FFI.
- **Tamaño:** sidecar release ~5MB. libindigo.so ~2MB. libindigo-renderer.so ~1MB. Total ~8MB.
