# Conventions

> Style rules, naming, and structure. Follow exactly.

---

## 0. Tooling

One formatter and one linter per language, all enforced by
`node scripts/harness.mjs`:

| Language               | Formatter                    | Linter                                                     |
| ---------------------- | ---------------------------- | ---------------------------------------------------------- |
| Rust                   | `cargo fmt --all` (rustfmt)  | `cargo clippy -- -D warnings`                              |
| TypeScript / TSX / CSS | `pnpm run format` (Prettier) | `pnpm run lint` (ESLint + typescript-eslint + react-hooks) |
| JSON / YAML / Markdown | `pnpm run format` (Prettier) | —                                                          |
| Shell                  | — (no shfmt requirement)     | `shellcheck --severity=warning`                            |

- `pnpm run check` = typecheck + ESLint + Prettier for the frontend.
- Never hand-format code to satisfy a linter; run the tool.
- Prettier config: `.prettierrc.json` (100 columns, double quotes, semicolons,
  trailing commas). Ignored paths: `.prettierignore`.
- ESLint flat config: `eslint.config.js`.
- Rust formatting is rustfmt defaults; do not add a `rustfmt.toml` without a
  reason.

---

## 1. Delivery order: docs → test → implement → review

Every activity task declares `phase` in `activities.json`:

| Phase       | Purpose                                       | Agent         |
| ----------- | --------------------------------------------- | ------------- |
| `docs`      | Update README/docs describing the contract    | `implementer` |
| `test`      | Add the failing test; confirm RED             | `implementer` |
| `implement` | Minimal code to pass; confirm GREEN; refactor | `implementer` |
| `review`    | Verify docs, test, code and green harness     | `reviewer`    |

Rules:

- Phases are non-decreasing in task order:
  `docs` (0) → `test` (1) → `implement` (2) → `review` (3). Several
  `implement` tasks may follow each other, but a phase may not move backwards.
- Non-`docs` activities must contain **all four** phases.
- Docs-only activities (`type: "docs"`) contain `docs` → `review` and no
  `test`/`implement` tasks.
- `review` tasks use the `reviewer` agent; every other phase uses
  `implementer`.
- `done` activities have only `done` tasks; `in_progress` activities have
  exactly one `in_progress` task.
- A task may be `in_progress` or `done` only when every earlier task in the
  activity is `done` (sequential status, not just phase order).
- `node scripts/harness.mjs` runs `scripts/lib/activity-policy.mjs` and its
  tests; any violation fails the harness.

---

## 2. Rust style

- Edition 2021, formatted with `rustfmt` defaults (`cargo fmt --all`).
- `cargo clippy --workspace --all-targets` should stay clean; do not add new
  warnings.
- **Module docs** (`//!`) at the top of every module, explaining its role.
- **Public items** (`pub fn`, `pub struct`, `pub enum`) get a `///` doc comment
  saying what they do, not how.
- Errors:
  - HTTP-facing code returns `Result<_, AppError>` (`sidecar/src/error.rs`).
  - Service/FFI internals use `anyhow::Result` and `.context(...)`.
- Logging: `tracing::info!/warn!/error!` in the sidecar, `log::info!/...` in the
  host. **No `println!`/`eprintln!`** except startup lines the host parses
  (`INDIGO_PORT=`) and the immediate panic hook.
- Do not `.unwrap()` on request data or filesystem input; return an error.
  Lock poisoning may use `unwrap_or_else(|e| e.into_inner())` as elsewhere.
- Keep `unsafe` confined to `src-tauri/sidecar/src/ffi/`.
- No TODOs without a reason and an owner.

---

## 3. TypeScript style

- TypeScript `strict` is on; `noUnusedLocals`/`noUnusedParameters` are errors.
- 2-space indentation, double quotes, semicolons (as in `src/App.tsx`).
- React function components only; no class components.
- Keep the Ketcher boundary thin: `App.tsx` owns the provider, `logging.ts` owns
  log forwarding.
- No Node-only APIs in `src/` (the webview is not Node). The `file-saver` shim
  is the sanctioned exception (§6.5).
- Do not log sensitive data; `console.*` is now persisted.

---

## 4. Naming

| Element      | Convention         | Example                            |
| ------------ | ------------------ | ---------------------------------- |
| Rust module  | `snake_case`       | `imago_ops.rs`, `indigo_ops.rs`    |
| Rust type    | `PascalCase`       | `AppState`, `ImagoJobStore`        |
| Rust fn      | `snake_case`       | `post_upload`, `get_health`        |
| TS component | `PascalCase`       | `App`                              |
| TS function  | `camelCase`        | `resolveApiBase`, `initLogging`    |
| Constant     | `UPPER_SNAKE_CASE` | `PORT_SCAN_RANGE`, `SIMPLE_ERRORS` |
| Script       | `kebab-case.sh`    | `build-appimage.sh`                |

**Document tabs.** A tab is identified by the base name of the file it was
opened or imported from (`benzene` from `benzene.mol`), never by a generic
label: no `Untitled` for a file that has a name. An import (`mol`, `smi`,
`inchi`, `sdf`, `rxn`) is **clean** — it equals its source file — and becomes a
document only when saved as `.ket`; until then its `path` is `null` and its
first Save is a Save As that prefills `<name>.ket`. `Untitled` is reserved for a
tab with neither a path nor a name (`docs/architecture.md` §5.1, §5.4).

---

## 5. Project layout

```text
src/                     React + Ketcher integration, logging
src-tauri/src/           Tauri host: lifecycle, commands
src-tauri/sidecar/src/   indigo-server crate
  transport/             axum handlers
  service/               orchestration
  ffi/                   native bindings
  job/                   Imago job store
  tests/                 sidecar integration tests
scripts/                 harness, packaging, libs
docs/                    architecture, conventions, testing, verification
progress/                session state (harness)
```

Rules:

- New endpoint → `transport/<domain>.rs` + route in `lib.rs`; logic in
  `service/`.
- New native call → `ffi/` only.
- New packaging behaviour → a script under `scripts/`, never inline in CI YAML.
- Do not commit `src-tauri/lib/`, `target/`, `dist/`, `dist-packages/`.

---

## 6. In-app dialogs and document UI

Every dialog this app adds — window close guard, single-tab close prompt,
save/export errors — is an **in-app HTML component**, never a Tauri native
`message` / `confirm` / `ask`. The native error dialogs already in `App.tsx` may
stay; new work must not add more. The same ban applies to browser
`alert()` / `confirm()`.

### 6.1 Primitives

| Module              | Export   | Responsibility                          |
| ------------------- | -------- | --------------------------------------- |
| `src/ui/Dialog.tsx` | `Dialog` | overlay, panel, title, action row       |
| `src/ui/Button.tsx` | `Button` | `primary`, `secondary`, `danger` styles |
| `src/ui/tokens.ts`  | `tokens` | the palette below, as typed constants   |

- The caller owns open/close state; one dialog per decision.
- Buttons are real `<button type="button">` elements with visible labels.
- Dialogs render above the editor without unmounting Ketcher.
- Use `danger` only for destructive choices (Discard), never for the default.

### 6.2 Ketcher design tokens

| Token          | Value                                                                                                                                                                       | Use                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Accent         | `#167782`                                                                                                                                                                   | primary buttons, focus ring     |
| Accent hover   | `#00838f`                                                                                                                                                                   | primary button hover            |
| Accent active  | `#005662`                                                                                                                                                                   | primary button pressed, links   |
| Error          | `#ff4a4a`                                                                                                                                                                   | destructive actions, error text |
| Error wash     | `rgba(255,74,74,0.08)`                                                                                                                                                      | danger button hover             |
| Success        | `#167782`                                                                                                                                                                   | `Valid` validation badge        |
| Success wash   | `rgba(22,119,130,0.08)`                                                                                                                                                     | `Valid` badge background        |
| Warning        | `#b26b00`                                                                                                                                                                   | `Warnings` validation badge     |
| Warning wash   | `rgba(178,107,0,0.08)`                                                                                                                                                      | `Warnings` badge background     |
| Text           | `#333`                                                                                                                                                                      | body copy                       |
| Secondary text | `#585858`                                                                                                                                                                   | labels, secondary actions       |
| Muted          | `#7c7c7f`                                                                                                                                                                   | hints, disabled controls        |
| Border         | `#cad3dd`                                                                                                                                                                   | 1px dividers and control edges  |
| Subtle surface | `#eff2f5`                                                                                                                                                                   | action row / footer             |
| Page           | `#f5f5f5`                                                                                                                                                                   | page background                 |
| Overlay        | `rgba(94,94,94,0.2)` wash + 10×10 diagonal hatch (`#555`, width 2, opacity 0.02), `background-repeat: repeat`, `background-size: 10px 10px`, fade `background-color` `0.3s` | dialog backdrop                 |
| Surface        | `#ffffff`                                                                                                                                                                   | dialog panel                    |
| Radius         | `3px`                                                                                                                                                                       | buttons, inputs, inner controls |
| Dialog radius  | `8px`                                                                                                                                                                       | dialog panel corners            |
| Border width   | `1px`                                                                                                                                                                       | everywhere a divider is drawn   |
| Dialog border  | `none`                                                                                                                                                                      | dialog panel edge               |
| Font           | Roboto                                                                                                                                                                      | 14px titles, 12px body          |
| Dialog shadow  | `none`                                                                                                                                                                      | dialog panel elevation          |

No gradients, no second shadow, no colours outside this palette.

**Raw token values, CSS functions in components.** A token stores the raw value
only: a plain colour (`rgba(94,94,94,0.2)`), a plain length (`10px 10px`) or the
bare data URI of the hatch (`tokens.dialog.backdropPattern`, starting
`data:image/svg+xml`). The component owns the CSS function and wraps the token at
the point of use, e.g. `Dialog` sets
`` backgroundImage: `url("${tokens.dialog.backdropPattern}")` ``. Never pre-wrap
the value in the token and never inline the URI string in a component — the token
stays the single source of truth. A bare data URI assigned to `background-image`
is not a valid CSS value, so the declaration is dropped **silently**: no image,
no error in the console, and the backdrop falls back to a flat 20 % wash with no
hatch. Ketcher's own overlay uses `background-image: url("data:…")` for the same
reason.

**Native parity.** The overlay and panel values mirror Ketcher's own modals: the
overlay tint is the editor's `--color-background-overlay` (`rgba(94,94,94,0.2)`)
with the same `10px 10px` diagonal hatch Ketcher paints over it, and it fades in
over `0.3s` from the pre-fade wash `rgba(94,94,94,0.01)`
(`tokens.color.overlayHidden`, `tokens.dialog.transition`), and the panel frame
is a white, borderless, shadowless `8px`-radius box with no padding of its own —
the header, body and action row inside it own the spacing, as in Ketcher. Every
in-app dialog (Export, close guard, recovery, errors) inherits these values from
`tokens` and `Dialog`; per-dialog overrides are not allowed.

**Intentional divergence.** Parity covers the overlay tint, its `10px 10px`
diagonal hatch and its `0.3s` fade, plus the panel frame only. The panel does not
reproduce Ketcher's transform/opacity entrance animation. The overlay is also
`position: fixed` above the whole app (`tokens.zIndex.overlay`) rather than
`absolute` with `z-index: 40` inside the editor, because the app's dialogs
outlive the canvas.

### 6.3 Accessibility

- Container: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing
  at the dialog title.
- Focus moves into the dialog on open (the safe primary action) and is trapped:
  `Tab` / `Shift+Tab` cycle inside it. Focus returns to the trigger on close.
- `Escape` takes the least-destructive explicit choice: **Cancel** in the window
  close guard and in the single-tab close prompt. It never triggers Save.
- Every control has a visible label; icon-only controls need an `aria-label`.
- The focus ring uses the accent token and stays visible against every surface.

### 6.4 Pure helpers

Decision logic lives in pure functions that import neither Tauri nor the DOM,
so Vitest can exercise them (`docs/testing.md` §5):

- state, title and dirty formatting (`src/document.ts`);
- the tab model and guard decisions (`src/tabs.ts`);
- save vs export format mapping and the close-guard decision;
- saved-blob routing by extension and document state (`src/saveRoute.ts`);
- autosave scheduling and the recovery decision (`src/autosave.ts`);
- recent-document list operations (`src/recent.ts`) and the File menu item
  model (`src/fileMenu.ts`);
- the backstage section list, status-strip formatting and declared-version
  helper (`src/backstage.ts`);
- settings descriptors and value formatting (`src/settingsModel.ts`).

React components and Tauri calls stay thin adapters around those helpers; do
not put decisions inline in JSX or in an event handler.

### 6.5 File menu

- **Placement.** The File button is the first element of the document tab strip,
  left of the first tab, sharing the strip height and its Ketcher tokens (§6.6).
  It is document chrome, not a toolbar: the app renders no toolbar, dock or
  floating control group, and registers no Ketcher `customButtons`. File
  commands live in this menu and nowhere else. The button is a sibling of the
  `role="tablist"`, never a child: the tablist owns tabs only.
- **Trigger icon.** The File button keeps its `File` label and gains a
  Ketcher-style line icon before it: 16 px box, document glyph stroked with
  `currentColor` at `1.5` stroke width, round joins and caps, and a `6px` gap
  between icon and label. The icon is inline SVG with `aria-hidden="true"` and
  fixed 16 px `width`/`height`; it uses no colour literal — it inherits the
  button's text colour in rest, hover, focus and open states, so a theme change
  needs no icon edit. Do not add a second icon or an icon-only trigger.
- **Popup surface.** The menu opens directly below the File button, above the
  editor, as a white surface (`tokens.color.surface`) with a 1 px
  `tokens.color.border` edge, `tokens.radius` corners and `tokens.shadow`
  elevation. Item text uses `tokens.fontFamily`/`tokens.fontSize.body`; hover
  uses `tokens.color.surfaceSubtle`; there is no selected/active item state. No
  gradient, no colour outside the token palette and no per-item inline colour.
  The popup is capped at the remaining viewport height and scrolls its list, so
  a long recent list never runs off-screen.
- **Item model.** One exported, ordered list drives rendering: New, Open…,
  Import…, Save, Save As…, Export…, a separator, then Recent documents. Labels
  are sentence case and include the ellipsis only for commands that open another
  dialog. The recent section always renders; while the list is empty it shows a
  muted, non-interactive `No recent documents` hint.
- **Open is `.ket` only.** Open… filters `.ket` and routes through
  `openProject`: the tab adopts the file path and name. **Import…** lists
  `mol`, `smi`, `inchi`, `sdf` and `rxn` and routes through `importStructure`:
  the tab adopts the source base name with `path: null` and is saved as `.ket`
  later. The two commands never share a dialog or a filter group
  (`docs/architecture.md` §5.4, §5.9).
- **Hiding native commands.** Ketcher's native **Save As** is hidden through the
  `Editor` `buttons` config in `src/ui/editorButtons.ts`
  (`buttons.save.hidden`), never through CSS, a DOM query or a Ketcher source
  edit. Cast to `ButtonsConfig` only where Ketcher's `ButtonName` union is
  incomplete, and justify the cast in a comment.
- **Native Open is the exception.** Ketcher's native Open stays **visible** and is
  not hidden by the `buttons` config: it is a different flow from File → Open… —
  it loads a structure into the current canvas and leaves the tab's name and path
  alone (its edit is a normal change, so the tab turns dirty), while File → Open…
  opens a `.ket` project and adopts name and path. Native Open must not create a
  tab, adopt a path, rename a tab or record a recent document. Do not merge the
  two entries or route one through the other; `recognize` stays hidden in the
  same config.

#### 6.5.1 Menu accessibility

- The trigger is a real `<button type="button">` labelled `File`, with
  `aria-haspopup="menu"`, `aria-expanded` reflecting the popup and
  `aria-controls` pointing at it.
- The popup is `role="menu"` and every entry is `role="menuitem"`; a separator
  is `role="separator"`. Recent entries are menu items whose label is the file
  base name and whose `title` shows the full path.
- Keyboard: Enter/Space/ArrowDown open the menu and focus the first item,
  ArrowUp opens and focuses the last; ArrowDown/ArrowUp move focus, Home/End
  jump to the ends, Enter/Space run the focused item, Escape closes the menu and
  returns focus to the File button, and Tab closes it. Opening an item's dialog
  closes the menu first. A document keyboard shortcut closes the menu and is
  consumed like it would be while a dialog is open.
- Pointer: clicking outside the menu and its trigger closes it without running
  an item. The popup never traps focus and never covers the File button.
- Every entry has a visible label; the recent items' `aria-label` includes
  "Recent" so they are distinguishable from the main commands.

### 6.6 Document tab strip

The tab strip is the only app-rendered chrome above the editor. It sits at the
top of the window, above Ketcher's toolbar, with the File button at its left
(§6.5); the strip manages tabs and hosts that button. Save, New, Open, Import
and Export live in the File menu (§6.5), not in the strip itself.

- **One editor.** The strip never mounts a second `<Editor>`, a second canvas or
  a per-tab toolbar/dock. Selecting a tab runs the one-editor switching protocol
  in `docs/architecture.md` §5.2; Ketcher is never unmounted.
- **Ketcher tab tokens only.** The strip uses Ketcher's tab tokens, not new
  colours:

  | Token                 | Value     | Use                                             |
  | --------------------- | --------- | ----------------------------------------------- |
  | `--color-tab-active`  | `#fff`    | active tab surface: the white workspace itself  |
  | `--color-tab-regular` | `#fff`    | background of inactive tabs at rest             |
  | `--color-tab-hover`   | `#00838f` | hovered tab's label and close control           |
  | `--color-tab-content` | `#eff2f5` | strip/content surface behind and below the tabs |

  No token outside this table, no gradient and no per-tab inline colour. The
  strip overrides Ketcher's `--color-tab-active` grey (`#e1e5ea`); no grey tab
  fill remains.

- **One separator, two layers.** The strip draws the same 1 px `#cad3dd` line
  in two layers so it is continuous without a seam or a double line:
  1. The strip draws the free-area line as an inset box shadow,
     `boxShadow: "inset 0 -1px 0"` with `tokens.tab.border`; it runs the strip's
     full width through the left padding, the gaps and past the last tab.
  2. Every **inactive** tab draws its own `borderBottom` of
     `tokens.borderWidth solid tokens.tab.border` (`1px solid #cad3dd`), at the
     same y as the inset shadow, so the line continues under the tabs.
     The tabs sit flush (`gap: 0`) and every tab draws top/left/right edges.
- **The active tab paints over the line.** Its `borderBottom` is `none` and its
  white workspace background is opaque, so the active tab is the only tab with
  no line under it; it reads as part of the editor. Inactive tabs keep their
  bottom edge and no tab may draw a 2 px edge or add a second separator.
- **Inactive tabs stay quiet.** White at rest; hovering colours the label and
  the close control with `#00838f`, never the tab background. The dirty dot is
  unchanged.

- **Dirty state is a dot.** A dirty tab shows a small filled dot next to its
  title; the title never contains `*`. Saved tabs show no dot.
- **Close control.** Every tab has a close control (`×`) with an `aria-label`,
  and a middle click closes the tab too. Closing is per tab and follows
  `docs/architecture.md` §5.7. The `+` button at the end of the strip opens a
  new empty tab.
- **Titles.** Base name of the tab's path, otherwise its `name`, otherwise
  `Untitled`; an opened or imported file always shows its own base name,
  truncated with an ellipsis rather than wrapping, so the strip stays one row.
- **Accessibility.** The tab bar (the inner container, a sibling of the File
  button) is `role="tablist"` and each tab is
  `role="tab"` with `aria-selected`; the active tab is the only one with
  `tabIndex={0}` (roving tabindex). ArrowLeft/ArrowRight move focus and
  activation to the neighbouring tab, wrapping at the ends; Enter/Space
  activate. The close control is a real `<button>` and every icon-only control
  has an `aria-label`.

### 6.7 Dialog copy

- Ask one confirmation question that matches the actions offered:
  `Are you sure you want to discard them?` for a Discard / Cancel dialog,
  `Do you want to save them before closing?` when Save is offered too.
- State the situation in one sentence: the document name or dirty count plus
  "has/have unsaved changes". No second explanatory paragraph.
- Never explain implementation limits or what the app cannot do. Dialog copy
  must not contain "not possible", "on screen", "one editor" or
  "saving them all": the dialog asks for a decision, it does not justify the
  code behind it.
- Titles are sentence case: `Unsaved changes` when only Discard / Cancel is
  offered, `Save changes?` when Save is offered.
- **Already open** notice: title `Already open`, one sentence
  `This document is already open.`, a single **OK** action. It states the
  situation without a question, a second paragraph or an implementation
  explanation.
- **One path, one tab.** A `.ket` path belongs to at most one tab
  (`docs/architecture.md` §5.10): opening a path that is already open activates
  that tab and shows the notice, and Save As to a path owned by another tab is
  refused with the same notice.

### 6.8 Backstage

The backstage is the app's start surface (`docs/architecture.md` §5.11). It is an
in-app overlay above the tab strip and Ketcher, never a route, a second window,
a second editor or a Tauri native dialog.

- **Only real capabilities.** Every row, card and button maps to a function the
  app already has: New/Open/Import, the recent list, the template structures,
  Ketcher settings and real version sources. Do not add a control, badge,
  counter, chip or link that has no implementation behind it, and do not
  reproduce Stitch mock content that has no backing capability ("Open from
  Indigo sidecar", coordinate-grid note, molecular-weight chips, "Browse all
  fragments", models counter). The Recent structures validation badge and
  thumbnail are backed by the real Indigo check and render, so they are not mock
  content.
- **Rail sections.** In order: Welcome, Open, Models, Settings, About (ids
  `welcome`, `open`, `models`, `settings`, `about`; default `welcome`), with the
  **Exit Backstage** button at the bottom of the rail. Each section
  button renders a 16 px `currentColor` line icon before the label — home,
  folder-open, cube, sliders, info — stroked with `strokeWidth` 1.5 and no
  colour literal, so it inherits the button's text colour in every state.
  **Models** is reserved for OCSR model management and ships as an empty
  placeholder: a heading plus a muted, non-interactive note, with no list and no
  actions. Reserved sections never invent data — no fake models, versions or
  download counters — and are not disabled copies of a future picker.
- **Layout and tokens.** Top bar, 260 px `surfaceSubtle` (`#eff2f5`) rail,
  white `surface` content pane, 24 px content padding.
  Surfaces use the `8px` radius, controls the `3px` radius, edges the 1 px
  `tokens.color.border` (`#cad3dd`), the accent is `tokens.color.accent`
  (`#167782`) and text is Roboto 12/14 px. No gradient and no colour, radius,
  border or shadow outside `src/ui/tokens.ts` (§6.2).
- **Welcome.** The pane is titled `Welcome`, subtitled
  `Start from a blank canvas or a template.` With an existing document it starts
  with the primary **Back to editor — `<active tab>`** action and **Blank
  canvas** second; with no document, Back to editor is absent and **Blank
  canvas** is the primary action. **Import structure…** and **Open project…**
  follow. The actions are a **horizontal wrapping row** (`flexDirection: "row"`,
  `flexWrap: "wrap"`, 8 px gap, centred items, 720 px max width), never a
  vertical column, and never more than those four. Buttons are content-sized
  (`minHeight: 36`, no `width: 100%` and no stretch) so a narrow pane wraps
  instead of stacking into a full-width list. A 10 px uppercase `TEMPLATES`
  heading comes next, with **More templates** aligned to its right, then the
  four-card grid. A document means at
  least one tab fails `isUntouchedTab` (`name`, `path`, dirty or non-empty
  content), not merely that a tab exists: the restored untouched tab of a first
  run does not count. **Blank canvas** runs the New command: it reuses the
  active tab while `isUntouchedTab` holds (no path, not dirty, empty KET) and
  opens a new tab only once the active one holds a document, so a first run
  keeps its single empty tab.
- **Back to editor.** The action is rendered only when a document exists, first
  and primary, and labelled with `tabTitle(active)`, so it carries the active
  tab's name and the `*` dirty marker (e.g. `Back to editor — Boc*`). Without a
  document it is not rendered at all rather than disabled, and **Blank canvas**
  takes the primary style. It only closes the overlay: no tab activation, save,
  reload or `setMolecule`. The rail's **Exit Backstage** stays; the top bar has
  no exit control.
- **Templates come from the real library.** The Welcome grid is built only from
  the entries of Ketcher's real **Structure Library**, read after `onInit`:
  `src/templateLibrary.ts` takes `FunctionalGroupsProvider` and
  `SaltsAndSolventsProvider` (`Struct[]`, ketcher-core), maps each struct to an
  entry (slug `id`, `name`, `abbreviation`, source `group`, KET through
  `KetSerializer.serializeMicromolecules`) and dedupes by the case-insensitive
  name + abbreviation pair, keeping provider order. Never render a curated
  hand-written card, a fake fragment or a placeholder structure; the legacy
  `src/templates.ts` pool is not used for cards at all, even when the library is
  empty.
- **Four random cards.** The Welcome grid always renders exactly four
  **distinct** library entries, whatever the viewport width: `TEMPLATE_CARD_COUNT`
  in `src/templateLibrary.ts` is `4`, there is no width rule and no resize
  listener, and the grid wraps rather than dropping cards on a narrow pane.
  `sampleTemplates` returns that many entries in library order from an injected
  RNG; it never duplicates a card, never exceeds the library (a smaller library
  shows all of it) and never invents data. The subset is re-drawn each time the
  section mounts — the backstage unmounts on close, so every open
  re-randomizes.
- **Empty state.** Once the editor is initialized and both providers yield no
  entries, the grid is replaced by a muted, non-interactive
  `No templates available` line. No card, curated substitute or fake gallery
  appears, and **More templates** stays available.
- **More templates.** A disabled-until-ready button beside the `TEMPLATES`
  heading closes the backstage first, then opens Ketcher's real **Structure
  Library** through `src/ketcherOptions.ts`: `openStructureLibrary` dispatches
  `MODAL_OPEN` with `{ name: "templates", prop: { tab: null } }`, the same action
  as Ketcher's `template-lib`. Selecting a library template activates the
  template tool and closes the dialog. Never render a hand-made gallery, a fake
  fragment list or a disabled placeholder in its place.
- **Tool reset.** Opening the backstage and switching tabs must clear an armed
  template tool: `openBackstage()` and `activateTabById()` call
  `cancelActiveTool(ketcher)` first, which dispatches one bubbling, cancelable
  Escape `keydown` event to the Ketcher root
  (`document.querySelector(".Ketcher-root")`). Never click a DOM toolbar button,
  inject a Redux action or reset the editor. Without it, a structure armed in the
  Structure Library keeps following the cursor over the backstage or the newly
  activated tab.
- **Default section.** `DEFAULT_BACKSTAGE_SECTION` is `welcome`, held in
  `useState(DEFAULT_BACKSTAGE_SECTION)` and unmounted with the overlay, so every
  open shows Welcome again. Never persist the section or default it to a removed
  id (`new`), which produced the blank pane after editing. **An unknown or stale
  section id falls back to Welcome**: `renderSection` has a `default` branch that
  renders the Welcome pane and `normalizeSection` maps any id outside the section
  list to `welcome`. No id, including one left by hot reload, renders an empty
  pane.
- **Template cards.** Each card is one real `<button type="button">` with an
  `aria-label` naming its template. Anatomy, top to bottom: an SVG **preview**
  area (fixed height, `surfacePreview` wash — `#fafbfc`, `tokens.color.border`
  bottom edge), the template **name** at `fontSize.body`, a one-line
  **abbreviation** at 11 px in `tokens.color.textSecondary` (the entry's
  abbreviation when it has one, otherwise its group), and a small uppercase
  **group chip** (10 px, `radius` 3 px, `surfaceSubtle` fill, no border) reading
  `Functional group` or `Salt or solvent`. The card surface is
  `tokens.color.surface` with a 1 px border and the `8px` surface radius; hover
  paints the accent border only. Cards carry no molecular-weight chip. Until the
  editor reports ready the cards are `disabled` (and `aria-disabled`): the button
  ignores clicks, so `onTemplate` never runs against a canvas that cannot load a
  structure.
- **Previews are rendered by Ketcher.** Each preview comes from the entry's own
  KET through `ketcher.generateImage(entry.ket, { outputFormat: "svg" })`, so
  the native Indigo renderer draws exactly what the card inserts. The result is
  cached per entry id for the session (reshuffles and reopenings do not
  re-render), shows a muted loading placeholder while it renders and a neutral
  `Preview unavailable` placeholder when the render fails. Never hand-author the
  structure as inline SVG, never use `<image>`, an icon font, a raster asset or
  a preview copied from `src/templates.ts`.
- **Clicking a card** cancels any armed tool, inserts the entry's `ket` through
  `setMolecule` behind the loading flag into a **new** tab and then closes the
  backstage; it always allocates a tab, and that tab is **dirty**, named after
  the library entry (e.g. `Benzene*`) with `path: null`, so the first Save opens
  Save As. A failure after `setMolecule` restores the active tab's content into
  the editor so the canvas and the tab state agree, and the backstage stays open.
- **Open has no previews.** Recent rows and open-tab rows show text (base name,
  path title) only: no thumbnail, preview or image is rendered until one is
  validated. The Welcome Recent structures table is the one place with a
  thumbnail, and only after its preview cache resolves; a row whose render
  failed keeps a neutral placeholder.
- **Recent structures table.** Welcome renders a compact table below the
  template grid under a 10 px uppercase `RECENT STRUCTURES` heading, copied from
  Stitch: 10 px uppercase header on `surfaceSubtle`, 12 px body rows of 40 px
  height, 1 px `tokens.color.border` rules between rows, row hover on
  `surfaceSubtle` and no vertical borders. Columns in order: **Structure Name**
  (a 40 × 32 px white thumbnail cell plus the base name, full path as `title`,
  and a muted `Ketcher document` line), **Format**, **Size**, **Indigo
  Validation**, **Last Modified**, **Actions** (a teal `Open` text button). Only
  the rows `App` provides are rendered (the loader caps them at five), so the
  table never lists an entry the recent list does not hold. While the rows load
  it shows one muted `Loading recent structures…` row; an empty list shows one
  muted `No recent structures` row. The header is informational only — no
  sorting, filtering or column control that the app does not implement.
- **Validation badges.** The badge text is exactly `Valid`, `Warnings`, `Invalid`
  or `—` for an unknown status, from `validationStatus` (never a status invented
  by the view): green `tokens.color.success` for Valid, amber
  `tokens.color.warning` for Warnings, red `tokens.color.error` for Invalid and
  muted `tokens.color.muted` for the unknown `—`, each on a low-emphasis wash of
  the same token. Badges carry a 6 px status dot, use the 3 px `radius`, 10 px
  text and no border. A missing file is unknown (`—`), never `Invalid`; when the
  source cannot answer, the row shows `—` rather than guessing.
- **Real table data.** Name and format come from the path, size and Last
  Modified from `stat`, validation from the struct-service check and the
  thumbnail from the sidecar render cache (`docs/architecture.md` §5.11). A
  missing or unreadable file keeps its row with `—` size/date and the muted `—`
  badge for `unknown` status; a row never shows a placeholder size, date or
  status. The table
  never writes a `.ket` and never stores a preview inside one.
- **Accessibility.** The overlay is `role="dialog"` with `aria-modal="true"` and
  `aria-labelledby` pointing at its title; focus moves in on open, is trapped
  and returns to the trigger (the home button) on close. `Escape` and the rail's
  **Exit Backstage** action close it; the top bar carries no exit control. The
  rail is a `nav` of real
  `<button type="button">` elements — not a `tablist` — with roving `tabIndex`,
  ArrowUp/ArrowDown/Home/End movement and `aria-current="page"` on the active
  section. Every control has a visible label; icon-only controls need an
  `aria-label`.
- **Home button.** A real button with a 16 px `currentColor` house line icon and
  `aria-label="Backstage"` is the first control of the tab strip, before the
  File button and outside the `role="tablist"`. It only toggles the overlay: it
  never activates a tab, saves, reloads or changes the canvas.
- **Startup.** The backstage replaces the loading splash on every launch and
  stays until dismissed; it never auto-closes when Ketcher becomes ready. It
  must not block or delay the silent tab restore, and dismissing it must not
  wait for that restore.
- **Settings.** Bind only to `ketcher.settingsService` (`getSettings`,
  `updateSettings`, `subscribe`, `resetToDefaults`, `loadPreset`). Use the
  curated keys in `docs/architecture.md` §5.11.1 with their real unit keys,
  options and the documented bounds; apply each change live, show the ACS preset
  and Reset to defaults. Never invent an option Ketcher does not have, never keep a second
  settings object and never persist settings in `.ket` or a tab snapshot.
- **About.** Show only values with a real source (app, Ketcher and React
  versions, `/v2/info` Indigo version and port, webview platform, runtime,
  license links). No fake build SHA, commit, date, IUPAC version or model count;
  an unavailable source shows `Unavailable`, not a placeholder number.
- **Commands.** Reuse the File menu handlers. New/Open/Import and a template card
  close the backstage as they run. Save, Save As and Export live in the File
  menu only, not in the backstage. The backstage never closes a tab or discards
  work.

---

## 7. Commits and releases

- **Conventional Commits** are mandatory. See
  **[commit-policy.md](commit-policy.md)** for the full rule.
- Use `feat`/`fix` (and breaking markers) **only for product changes** that
  affect Chemistry Draw users and belong in the changelog. CI, Actions, release
  config, agent harness, templates, and internal tooling use `chore(ci)`,
  `build`, `docs`, `refactor`, etc.
- release-please is configured to drive releases from `feat`/`fix` (and breaking
  changes), not from `chore`/`docs`/`refactor`/`perf`.
- One logical change per commit; the message explains _why_.
- Do not hand-edit `CHANGELOG.md` (release-please owns it).
- Update `docs/` in the same commit when behaviour changes.

---

## 8. Sidecar contracts

- Every handler logs its route at `info`.
- Status codes: 400 invalid input, 404 unknown id, 500 backend failure.
- `/v2/info` must report the **actual bound port** in `api_path`.
- Imago jobs are in-memory only; restarting the sidecar loses them.
- Keep the sidecar stateless except for the job store.

---

## 9. Native libraries and packaging

- Never vendor `.so` files. `task libs` / the Docker builder generate them.
- Never ship `libstdc++` or `libgcc_s`.
- Test packaging changes with `task packages` before declaring done.
- The AppImage is assembled by `scripts/make-appimage.sh`; do not reintroduce
  Tauri's linuxdeploy AppImage path.

---

## 10. Tauri capabilities and filesystem scope

- `src-tauri/capabilities/default.json` is the single source of truth for what
  the webview may do. Never widen access from Rust, and never bypass
  `plugin-fs` with a host command.
- Every capability or scope change is justified in `docs/architecture.md`
  section 5.6.1 and guarded by the capability contract test
  (`docs/testing.md` section 4.1). An unjustified scope change is a review
  finding.
- Scope entries are absolute paths or `$VAR` roots (`$APPDATA/**`,
  `$HOME/**`). A bare `**` does not match absolute paths and is never an
  acceptable entry.
- Programmatic paths — autosave, recovery, restored documents — never pass
  through a dialog, so each needs an explicit static scope. Only dialog-picked
  paths get the plugin's runtime grant; do not rely on it for app-written
  files.
- Grant no permission the app does not call. Keep the fs command list in sync
  with the `@tauri-apps/plugin-fs` functions used in `src/`.

---

## 11. Vendored Ketcher patches

Ketcher is consumed as published `dist/` bundles; a bug we cannot fix in `src/`
is patched through `pnpm`'s `patchedDependencies` mechanism.

- **One patch file per package version**: `patches/<package>@<version>.patch`,
  registered in `pnpm-workspace.yaml` under `patchedDependencies`. A new
  Ketcher version gets a new file; never rename or widen an existing one.
- **Never edit `node_modules/`.** The patch file is the only source of the
  change, and `pnpm install` must reapply it from a clean store.
- **Every hunk cites its origin** in the patch context: the upstream
  issue/PR and the exact `dist/` file the hunk touches. A hunk without an
  upstream reference or a removal plan is a review finding.
- **Mirror every hunk for both bundles**: `dist/**/*.js` and
  `dist/**/*.modern.js`. The app may resolve either build, so a guard in only
  one of them is unpatched behaviour.
- **Add a regression test** with the patch: a patch-contract test asserts the
  patch file and the installed `dist/` carry the guard
  (`docs/testing.md` §4.3). The manual reproduction stays in
  `docs/verification.md`.
- **Remove the hunk when the upstream release lands.** Bump to the release that
  contains the fix, delete the hunk (and the patch file when it becomes empty),
  drop the `patchedDependencies` entry if unused, then run `pnpm install` and
  the patch-contract test. The removal plan lives beside the upstream reference
  in `docs/architecture.md` §10 and, for `parametrizeUrl`, in
  `docs/KETCHER-BUG-parametrizeUrl.md#removing-the-patch`. An applied hunk whose
  upstream fix has shipped is a review finding.
