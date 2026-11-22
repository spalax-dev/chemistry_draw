# Toolchain and version policy

> Supported versions, intentional pins and the audit gates for the **0.x `main`
> line**. Read this before bumping a tool, adding a dependency or changing CI.

This policy describes the line users run today (`main`, 0.x). The 1.x
integration line (`develop`) adopts these pins at launch but also carries the
ONNX/OCSR stack; see §5.

---

## 1. Supported toolchain

| Component        | Supported version                                 | Where it is declared                                        |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Node.js          | **24 LTS** (`>=24.14.1 <25`)                      | `.nvmrc` (`24`) and `engines` in `package.json`             |
| pnpm             | **12.21.0** (exact)                               | `packageManager` in `package.json`, enabled by Corepack     |
| Rust             | **stable**                                        | CI (`dtolnay/rust-toolchain@stable`) and the Docker builder |
| Linux build base | **Debian 12** (glibc **2.36**)                    | packaging scripts and the builder image                     |
| Builder Node     | `node:24-bookworm-slim` when a Node stage is used | builder image                                               |
| Linux runtime    | GTK3 + **webkit2gtk 4.1**                         | Tauri v2 requires it; Debian 12 is the floor                |
| Windows          | **x64**, WebView2, MSVC toolchain                 | Windows CI job and `scripts/fetch-windows-libs.ps1`         |

- Node is installed locally from `.nvmrc` (`24`). The floor is **`>=24.14.1
<25`**, the `engines.node` range declared by Ketcher 3.18 (`ketcher-core` and
  `ketcher-react` both require `>=24.14.1`). `.nvmrc` `24` resolves to a patch
  that satisfies it. Nothing in the repo supports Node 20 (end of life) or
  Node 22.
- **Local baseline:** Node 24.13.1 is **below** the floor and is not a
  supported development runtime; upgrade to 24.14.1 or later (`nvm install 24`
  picks a satisfying patch).
- `.nvmrc`, `engines` and `packageManager` do not exist yet: they land with the
  Node/pnpm activity, so `nvm use` is not a working instruction on this branch
  until then. The supported versions above are the target those declarations
  will encode.
- pnpm is the **only** package manager: `npm install`, `npm ci`, `npx` and
  `yarn` are not supported and must not appear in docs, scripts or CI.
  `corepack enable` installs the pinned pnpm; `packageManager` is the single
  source of truth.
- Rust has no `rust-toolchain.toml`: CI and Docker track stable. The local
  baseline used to validate this policy is **rustc 1.99.1**. A pinned Rust
  version would be a separate decision, because it changes the CI/Docker
  contract.
- The Linux packages keep the Debian 12 floor (`glibc 2.36`); a Node stage used
  for the frontend build must stay on a bookworm base (`node:24-bookworm-slim`),
  never a newer distro, or the produced binaries stop matching the shipped
  floor.

---

## 2. Version policy

### 2.1 Runtime dependencies follow Ketcher's peer ranges

The editor is Ketcher; its peer ranges bound the app's runtime majors.

| Package                          | 0.x version | Ketcher 3.18 peer range | Rule                                                         |
| -------------------------------- | ----------- | ----------------------- | ------------------------------------------------------------ |
| React                            | **18.3.1**  | `^18.2.0 \|\| ^19.0.0`  | Stay on React 18; React 19 needs a Ketcher/E1 decision first |
| React DOM                        | **18.3.1**  | same as React           | Must match React exactly                                     |
| `ketcher-core` / `ketcher-react` | **3.18.x**  | —                       | Ketcher 3.18 on 0.x until E1                                 |

- Ketcher **3.21** belongs to **E1 / US-07** and must not be pulled into `main`.
  A Ketcher bump is an activity of its own (patches, peer ranges, golden tests),
  not a dependency refresh.
- Ketcher 3.18's peer range also allows React 19, but the app's patches, hooks
  and golden tests are validated on 18.3.1. Do not jump to React 19 without a
  Ketcher/E1 decision recorded in the activity.

### 2.2 Intentional pins

These are deliberate, not stale. Each one has a reason and a trigger for
revisiting it.

| Pin                        | Value                 | Reason                                                                      | Revisit when                        |
| -------------------------- | --------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| Debian / glibc floor       | Debian 12, glibc 2.36 | Indigo/Imago and the Tauri app build against it; packages must not raise it | Linux support policy changes        |
| Tauri                      | 2.x                   | The host, capabilities and packaging target Tauri v2                        | A Tauri 3 migration activity exists |
| Indigo / Imago             | 0.x line versions     | Sidecar FFI, patches and Windows DLL pins are validated against them        | Native-lib upgrade activity         |
| Windows Indigo             | **1.46**              | Prebuilt DLLs pinned by SHA-256 in `scripts/fetch-windows-libs.ps1`         | Windows native-lib activity         |
| ONNX / models / OCSR stack | **1.x only**          | Not part of the 0.x product; `main` must stay Imago-based                   | Never on `main` — see §5            |

### 2.3 Outdated-but-supported majors are recorded, not blindly upgraded

These majors are behind the newest release but supported and pinned by the
0.x contract. Record them here; upgrade them only through their own activity
with a RED test and a review.

| Dependency | 0.x version | Note                                                               |
| ---------- | ----------- | ------------------------------------------------------------------ |
| React      | 18          | Ketcher peer range allows 19, but 18.3.1 is the validated baseline |
| TypeScript | 5.9         | Activity 3 target; the minor bump is planned, not yet applied      |
| Vite       | 6.4         | Build/dev contract; a major bump is a separate decision            |
| Vitest     | 4.1         | Test runtime; pairs with the Vite major                            |
| axum       | 0.7         | Sidecar transport; handler signatures change across majors         |
| tower-http | 0.5         | Follows axum                                                       |
| thiserror  | 1           | Error derive; major changes the error contract                     |
| base64     | 0.22        | API surface changed at 0.21/0.22; stable here                      |

Rules:

- A patch/minor refresh inside the recorded major is fine when the lockfile and
  the harness stay green.
- A **major** jump (React 19, TypeScript 6, Vite 7, axum 0.8, …) is a separate
  activity with its own docs, failing test and review. Do not bundle it into an
  unrelated change.
- "Newer is available" is never by itself a reason to move a pin in this table.

---

## 3. Security and deprecation policy

### 3.1 Gates that must be clean

| Gate                                   | Requirement                                         |
| -------------------------------------- | --------------------------------------------------- |
| `pnpm audit --audit-level=high`        | No **high** or **critical** findings (dev included) |
| `pnpm audit --prod --audit-level=high` | No **high** or **critical** runtime findings        |
| `cargo audit`                          | No **vulnerabilities** reported by RustSec          |

- Any high or critical advisory fails the change and is fixed — by upgrading,
  patching through `pnpm`'s `patchedDependencies`, or replacing the dependency.
  It is **never** allowlisted.
- `cargo audit` unmaintained/unsound warnings that have **no available fix** do
  not fail the build, but they are reported in the activity and tracked here
  (or in the activity record) until a fixed release exists. A vulnerability
  (RUSTSEC advisory with a patched version) is not in that exemption.
- `npm audit` is not used: it reports against `package-lock.json` and ignores
  the pnpm graph. Use the pnpm commands above.

### 3.2 Dated allowlist

Dev-only or build-only, low/moderate findings with no compatible in-range fix
may be allowlisted until the expiry date below. The table records package,
severity, scope and expiry; each entry's bullet gives the reason and what
unblocks it.

| Package              | Severity | Scope                               | Expires    |
| -------------------- | -------- | ----------------------------------- | ---------- |
| `elliptic`           | low      | dev                                 | 2027-06-30 |
| `glob` / `minimatch` | moderate | prod graph, build-only, not shipped | 2027-06-30 |

- **`elliptic` (low, dev).** Dev-only transitive chain with no patched release;
  it is not shipped.
- **`glob` / `minimatch` (moderate, prod graph, build-only, not shipped).**
  They reach the production graph through `ketcher-react → dpdm` but are
  build-time only and absent from `dist/`, so they cannot run in the app. The
  only fixes are cross-major (`glob >=14.0.2`, `minimatch >=11.0.1`), which
  would break `dpdm`/ESLint, so there is no compatible in-range fix. The
  high/critical gate is unaffected; this is the documented build-only
  allowlist, not a dev dependency.

Rules:

- Every allowlist entry has an **expiry date**; `2027-06-30` is the current
  review date for the entries above. An entry past its expiry fails review.
- Only **dev or build-only** findings of **low/moderate** severity may be
  allowlisted. High/critical is always a fix, never an allowlist line.
- "Build-only" means the package is not present in the shipped `dist/` bundle and
  cannot run in the app; an allowlist entry states that evidence.
- When a compatible override is viable, use `pnpm.overrides` instead of an
  allowlist entry; allowlisting is the fallback, not the default.
- At each expiry, re-run the gates: upgrade or extend the entry with a new date
  and a written reason. A silently expired entry is a review finding.

### 3.3 Deprecated and end-of-life inputs

- **No EOL runtimes.** Node 20 is out of support and must not be used in
  `.nvmrc`, CI, Docker or docs. Node 22 is not the supported 0.x version either;
  pin Node 24 LTS.
- **No deprecated GitHub Actions majors.** Keep the actions on a supported
  major; a deprecation warning from GitHub is a finding. Target majors:
  `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`,
  `pnpm/action-setup@v6`, `docker/setup-buildx-action@v4`,
  `docker/build-push-action@v7`, `actions/cache@v6`,
  `googleapis/release-please-action@v5`, `softprops/action-gh-release@v3`,
  `Swatinem/rust-cache@v2`, `dtolnay/rust-toolchain@stable`.
- Deprecated package APIs are removed when their replacement exists, not
  silenced.

---

## 4. Commands

```bash
# Toolchain
corepack enable                 # installs the pnpm version pinned by packageManager
pnpm install --frozen-lockfile  # reproducible install; fails on lockfile drift

# Audit gates
pnpm audit --audit-level=high
pnpm audit --prod --audit-level=high
cargo install cargo-audit --locked   # one-time; provides the cargo audit command
cargo audit

# Verification gate
node scripts/harness.mjs        # full run: required before a change is ready
node scripts/harness.mjs --fast  # iteration: skips frontend build, uses cargo check, skips sidecar tests
```

- `--frozen-lockfile` is the documented install. Do not update the lockfile as a
  side effect of an unrelated change.
- `node scripts/harness.mjs --fast` is for local iteration only; the full run is
  required before review.

---

## 5. 0.x versus 1.x

- **`main` (0.x)** is the support line users run today. This document is its
  toolchain policy: Node 24, pnpm 12, Rust stable, React 18 with Ketcher 3.18,
  Debian 12/glibc 2.36, Indigo/Imago.
- **`develop` (1.x)** carries the ONNX/models/OCSR stack, NuGet and the Imago
  removal. It adopts these pins at launch; it is not the 0.x support line and
  its extra dependencies are not part of this policy.
- Do not cross-merge `main` and `develop`. Port an individual fix with a
  cherry-pick and keep each line's content intact.
