# Git tracking contract

> What belongs in git and what stays local. This is part of the harness
> contract: a clean repository is a gate, not a preference.

---

## Track

| Path / kind                                                                           | Why                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `BACKLOG.md`                                                                          | User stories; the product's memory                            |
| `.harness/state.json`                                                                 | The stage is a project decision, shared by every clone        |
| `docs/planning/**`                                                                    | Overview, architecture, stack, contracts, C4, sequences, ADRs |
| `docs/harness/**`                                                                     | How verification and the harness work                         |
| `AGENTS.md`                                                                           | The agent entry point                                         |
| `.opencode/agent/*.md`                                                                | Orchestrator and executor roles                               |
| `.opencode/plugins/harness-guard.js`                                                  | Protocol enforcement                                          |
| `opencode.json` (if used)                                                             | Shared safety and permission config                           |
| `scripts/harness.mjs`, `harness-lib.mjs`, `harness-lib.spec.mjs`, `build_harness.mjs` | The executable harness                                        |
| Source code and tests                                                                 | The product                                                   |
| Package manifests and **one** lockfile (`pnpm-lock.yaml`, `Cargo.lock`)               | Reproducible installs                                         |
| Formatter/linter/type/test config                                                     | The gates depend on them                                      |
| `.gitignore`, `.prettierignore`, `.eslintignore`                                      | The ignore policy                                             |
| `progress/history.md`                                                                 | Durable session record                                        |
| `progress/explore/.gitkeep`                                                           | Keeps the research folder                                     |
| `.env.example` (no secrets)                                                           | Documents required configuration                              |
| `vendor/**` (only if the project ever vendors dependencies)                           | Deliberately **not** ignored                                  |

The repository has two lines: `main` for 0.x support and `develop` for 1.x.
They are branches in the main checkout; no worktree directories are created or
tracked.

---

## Do not track (local only)

| Path / kind                                                 | Why                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `activities.json`                                           | Execution state of one story; regenerated per story             |
| `.harness/schedule.json`                                    | Computed on every `--schedule`                                  |
| `.harness/claims/**`                                        | Live executor claims                                            |
| `.harness/approvals.json`                                   | Local approval cache; durable proof is in `progress/history.md` |
| `progress/current.md`                                       | Live session state                                              |
| Generated documentation (`docs/generated/`, `target/doc/`)  | Build output; regenerate it                                     |
| `node_modules/`, `.pnpm-store/`                             | Reproducible from the lockfile                                  |
| `build/`, `dist/`, `target/`                                | Generated artifacts and build output                            |
| `src-tauri/lib/**`, `models/`, `.ort/`                      | Generated native libs, downloaded models, fetched runtime       |
| `*.AppImage`, `test_*.png`, `*_result.mol`                  | Local packaging and test output                                 |
| Framework/test caches (`coverage/`, `.cache/`, etc.)        | Regenerable                                                     |
| `*.log`, `*.tmp`, `.DS_Store`                               | Local noise                                                     |
| `.env`, `.env.*` (except `.env.example`), keys, credentials | Secrets never enter git                                         |

Native Indigo is generated by `task libs` (Docker); ONNX Runtime is fetched by
`scripts/fetch-onnxruntime.sh` and the Windows script; model weights are
downloaded at runtime. Committing any of them is a release blocker.

---

## The stage record is tracked on purpose

`activities.json` and `progress/current.md` are local because they change
constantly and belong to one working session. `.harness/state.json` is
different: `planning → development` is a decision the whole project shares.
Tracking it means a fresh clone knows it cannot re-enter planning. Do not ignore
it.

---

## Verify the policy

```bash
git status --short
git status --ignored --short | head -40
git check-ignore -v activities.json progress/current.md .harness/schedule.json
git ls-files .harness/ docs/planning/ docs/harness/ progress/
```

Expected: `.harness/state.json`, `BACKLOG.md`, `docs/planning/**`,
`docs/harness/**` and `progress/history.md` are tracked; `activities.json`, the
schedule, claims, approvals and `current.md` are ignored; no secrets in
`git status`.

---

## Rules

1. Never commit a secret, token, private key or credential file.
2. Never commit generated documentation or build output.
3. Commit one lockfile; do not commit multiple package-manager locks.
4. `progress/history.md` is append-only.
5. A story closes only with the user's approval recorded in `history.md`.
6. If the tracking policy changes, update this file and `.gitignore` together.
