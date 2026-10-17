# Config Folder Sync

An **Obsidian desktop plugin** that mirror-syncs a vault's `.obsidian` config folder — settings, themes, CSS snippets, the plugins themselves — to **Dropbox**, keeps timestamped **zip snapshots**, and offers a deliberately cautious restore path.

It exists because Obsidian's own ecosystem barely covers this folder: sync plugins skip the config directory by default, and git-based setups usually stop at the local machine.

**中文文档：[README.zh-CN.md](README.zh-CN.md)**

> **Desktop only** (`isDesktopOnly: true`). It reads and writes the real `.obsidian` directory on disk, which mobile cannot do.

> **Verified, not assumed** (2026-10-17, real machine + real Dropbox): first run uploaded **1584 files / 327.1 MiB with 0 errors**; `npm test` runs **154 tests, all green**; a real-Dropbox smoke test passes **12 checks** (non-ASCII filenames, 9 MB chunked upload session, recursive pagination, byte-exact download, idempotent delete). Details in [§14](#14-implementation-status).

---

## Table of contents

- [0. Hard constraints](#0-hard-constraints)
- [1. What gets backed up](#1-what-gets-backed-up)
- [2. Installation](#2-installation)
- [3. Dropbox App Console setup (exact steps)](#3-dropbox-app-console-setup-exact-steps)
- [4. Authorizing](#4-authorizing)
- [5. Settings reference](#5-settings-reference)
- [6. Daily use](#6-daily-use)
- [7. Restore (cautious by design)](#7-restore-cautious-by-design)
- [8. Exclude pattern syntax](#8-exclude-pattern-syntax)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Where everything lives](#10-where-everything-lives)
- [11. Coexisting with obsidian-git](#11-coexisting-with-obsidian-git)
- [12. Known limitations](#12-known-limitations)
- [13. Development](#13-development)
- [14. Implementation status](#14-implementation-status)

---

## 0. Hard constraints

| Constraint | Reality |
|---|---|
| Cloud provider | **Dropbox only.** Writes through the Dropbox HTTP API v2 — **the Dropbox desktop client is not required** (the reference machine never had it installed). |
| Authorization | **OAuth 2.0 + PKCE (public client).** You create a Dropbox app yourself and paste its **App key** into the plugin settings. No App secret is needed. |
| Account quota | Reference account: **18 GiB** total, **6.83 GiB** used, **~11.2 GiB** free after the first full backup. |
| Payload | Config body **327.1 MiB** (plugins 228.7 + snippets 89.1 + themes 9.2 + JSON 0.2). |
| Relationship to git | **Coexists with obsidian-git, no interference.** The plugin never reads or writes obsidian-git's settings or repository, and `.git/` is excluded from the sync scope. |
| Restore | **Cautious variant only**: preview the diff → confirmation dialog → automatic safety zip → then write. Writes by default, **does not delete** by default. |
| Encryption | **No end-to-end encryption.** What lands in Dropbox is your plaintext config (including plugin `data.json` files that may contain API keys — see [§12](#12-known-limitations)). |

---

## 1. What gets backed up

The whole `.obsidian` directory, minus the exclusion rules. The defaults were derived from measured sizes, not guesswork.

**Included** (the include list is empty by default, i.e. "everything")

| Content | Size (measured) |
|---|---|
| `plugins/**` — plugin code and settings | 228.7 MiB |
| `snippets/**` — CSS snippets | 89.1 MiB |
| `themes/**` | 9.2 MiB |
| `*.json` config (`app.json`, `appearance.json`, `core-plugins.json`, `community-plugins.json`, `hotkeys.json`, …) | 0.2 MiB |
| **Total** | **327.1 MiB** |

**Excluded by default** (`DEFAULT_EXCLUDES` — every entry has a reason)

| Pattern | Size | Why |
|---|---|---|
| `.git/` | 214 MB | obsidian-git's repository. Not configuration, and it already backs itself up. |
| `icons/` | 91 MB | Icon cache/pack — regenerable. |
| `plugins/插件备份*/`, `plugins/*/插件备份*/` | 144 MB | Hand-made plugin backup folders. Syncing them just burns quota. |
| `workspace.json`, `workspace*.json`, `workspace-mobile.json` | small | Session state. Changes on every window open — pure noise. |
| `graph.json` | small | Same (graph view state). |
| `plugins/focus-time/data/`, `*-time/data.json`, `plugins/update-time-on-edit/data.json`, `plugins/obsidian-git/*.json` | small | High-churn plugin runtime data, matching the vault root `.gitignore` convention. |
| `**/.DS_Store`, `**/Thumbs.db`, `**/*.tmp`, `**/*.crswap` | small | OS/editor garbage. |
| `**/.obsidian-safety-snapshots/` | varies | Restore safety-zip directory (belt and braces). |

**Excluded by the plugin itself** (hardcoded in the matcher, not in settings): `sync-index.json` (the sync index — restoring it would claim files are synced when they are not) and `*.tmp` inside the plugin's own directory.

> To change the scope, edit the two lists (include / exclude) in the settings panel. Syntax in [§8](#8-exclude-pattern-syntax).

---

## 2. Installation

### 2.1 Install via BRAT (easiest)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. In BRAT: **Add beta plugin** → `User-ZWW/obsidian-config-sync`
3. Enable **Config Folder Sync** in Settings → Community plugins

BRAT pulls `manifest.json` / `main.js` / `styles.css` from the release assets, so future updates arrive via its "check for updates" action.

### 2.2 Build from source (for development, or to pin your own build)

```bash
cd /path/to/obsidian-config-sync
npm install          # devDependencies only: typescript / esbuild / obsidian types
npm run build        # tsc --noEmit + esbuild → main.js
npm run deploy       # copies main.js / manifest.json / styles.css into the vault
```

`npm run deploy` writes to the `DEFAULT_VAULT` defined in `scripts/deploy.mjs`. Point it elsewhere with an argument or an env var:

```bash
node scripts/deploy.mjs "D:/path/to/YourVault"
# or
VAULT_ROOT="D:/path/to/YourVault" npm run deploy
```

It only copies `main.js` / `manifest.json` / `styles.css` into `<vault>/.obsidian/plugins/obsidian-config-sync/` — never sources or `node_modules`.

### 2.3 Enable it in Obsidian

1. Settings → Community plugins → turn off **Restricted mode** if it is on
2. Find **Config Folder Sync** under Installed plugins → toggle it on
3. Requires Obsidian **≥ 1.5.0** (`minAppVersion`)
4. The command palette (`Ctrl+P`) should then list:
   - Back up `.obsidian` to Dropbox now
   - Preview diff (writes nothing)
   - Create a snapshot zip now
   - Connect Dropbox / Disconnect Dropbox
   - Restore: preview remote vs local diff / Restore: pull `.obsidian` from Dropbox (cautious)
   - Open settings

(There is also a cloud icon in the ribbon = back up now.)

---

## 3. Dropbox App Console setup (exact steps)

This is the only manual part — about three minutes. **Do not skip step 8** (Submit).

1. Sign in to the Dropbox account you want to back up into → open **https://www.dropbox.com/developers/apps**
2. Click **Create app**
3. **Choose an API** → **Scoped access**
4. **Choose the type of access you need** → **Full Dropbox**
   - Why: the plugin writes to `/Obsidian-Config-Backup/`, a custom folder at the account root.
   - If you pick **App folder**, Dropbox only allows access under `/Apps/<your app name>/` and you must change the plugin's **remote base directory** to `/Apps/<your app name>`, or every request returns 409.
5. **Name your app** → a globally unique name, accept the terms
6. Click **Create app**
7. Open the **Permissions** tab and tick these **four** (missing one → `does not have the required scope` at runtime):

   | Scope | Needed for |
   |---|---|
   | `files.metadata.read` | Recursive listing (`files/list_folder` + `/continue`) — without it the plugin cannot see what is on the remote side |
   | `files.content.read` | Downloads (`files/download`): snapshot fetch, restore |
   | `files.content.write` | Upload/overwrite (`files/upload`, `upload_session/*`), folder creation (`create_folder_v2`), delete (`delete_v2`) |
   | `account_info.read` | `users/get_current_account`, `users/get_space_usage` — the connection test and quota display |

8. **Scroll to the very bottom of the Permissions page and click `Submit`.** Without Submit, ticking is a no-op. This is the single most common failure mode.
9. Back on **Settings**, copy the **App key** (a short alphanumeric string).
   - **No App secret needed** — the plugin is a PKCE public client and sends only `client_id` + `code_verifier`.
   - Exception: if Dropbox returns `missing client_secret`, fill the optional **App secret** field and the plugin will send it.
10. **Redirect URIs** (optional, depends on your auth mode) — under **Settings → OAuth 2 → Redirect URIs**:
    - **Loopback callback (default, recommended)**: add `http://localhost:53682/` → **Add**.
      - Must match the plugin's **callback port** (default 53682). Change the port in both places.
      - Dropbox requires HTTPS except for `localhost`, and the registered string must match the `redirect_uri` the plugin sends **exactly** — trailing `/` included.
    - **Manual code paste**: leave this empty. Dropbox allows omitting `redirect_uri` in the code flow and will display the code for you to copy (zero-configuration fallback).

11. **Confirm `Allow public clients (Implicit Grant & PKCE)` is set to `Allow`** — same Settings page, the line right under `Redirect URIs`.

    - The plugin is a **PKCE public client** (no App secret). If this is `Disallow`, authorization fails outright.
    - The failure is obscure: the authorize page may not open, or the token exchange returns `missing client_secret` / `invalid_client`, without pointing at this switch.
    - Recent consoles default to `Allow`; check anyway on older apps or ones you edited by hand.

> **The access type is not visible anywhere in the console UI** (a Dropbox console shortcoming). Two ways to tell:
> 1. Whatever you chose at creation is what you have — only **Full Dropbox** can write to the account root.
> 2. Empirically: if uploads to `/Obsidian-Config-Backup/` all return `409 not_found` while `users/get_space_usage` works, the app is **App folder** type. Change the remote base directory to `/Apps/<your app name>`.

> Added a scope later? **You must re-authorize.** Dropbox never retroactively grants a new scope to an existing access/refresh token. Disconnect in the plugin, then Connect again.

---

## 4. Authorizing

1. Settings panel → paste the **App key** (optionally the App secret)
2. Choose the auth mode:
   - **Loopback callback (default)**: click Connect → the browser opens the Dropbox consent page → click **Allow** → the page shows a success message and Obsidian picks up the code automatically.
   - **Manual code paste**: click Connect → consent page → after Allow, Dropbox **displays a code**; copy it into the dialog that appears in Obsidian.
3. The plugin exchanges `code + code_verifier` at `https://api.dropboxapi.com/oauth2/token` (the authorize URL carries `token_access_type=offline`) and receives:
   - `access_token` — ~4 hours, refreshed automatically
   - `refresh_token` — long-lived, used for background sync
4. **Test connection** should show the account name and email plus current quota usage.

Credentials live in the plugin's own `data.json` (see [§10](#10-where-everything-lives)). **Note [§12](#12-known-limitations) item 2**: that file is inside the sync scope by default.

---

## 5. Settings reference

| Setting | Default | Notes |
|---|---|---|
| Dropbox App key | empty | From step 3 |
| App secret (optional) | empty | Not needed for PKCE; only if Dropbox demands `client_secret` |
| Remote base directory | `/Obsidian-Config-Backup` | Actual target is `<base>/<vault name>/…`. With an App-folder app it must become `/Apps/<app name>` |
| Callback port | `53682` | Loopback listener on 127.0.0.1; must equal the port in the registered Redirect URI |
| Auth mode | `callback` | `callback` = loopback; `manual` = paste the code |
| Include patterns | empty (= all) | Allowlist; only matches are synced. Syntax in [§8](#8-exclude-pattern-syntax) |
| Exclude patterns | see [§1](#1-what-gets-backed-up) | Denylist; excluding a directory excludes its children. **First run: consider turning mirror-delete off.** |
| Exact comparison (hash) | off | On = sha256 per file (slow, most accurate); off = size + mtime |
| Upload concurrency | 3 | Don't push it — Dropbox rate-limits (429) |
| Max file size | 150 MB | Files above this are skipped (Dropbox's single-request upload cap is 150 MB; larger files use a chunked session) |
| Sync on file change | on | Watches `.obsidian` and runs a debounced sync |
| Change debounce | 60 s | |
| Interval sync | 0 (off) | Minutes; 0 = manual + on-change + on-startup only |
| Startup delay | 45 s | Wait after Obsidian starts, to avoid the startup storm |
| Snapshots | on | Timestamped zip uploaded to `<base>/<vault>/_snapshots/` |
| Snapshot mode | `daily` | `daily` = one per day; `every-run` = one per sync (burns quota fast) |
| Snapshots to keep | 7 | Older ones are deleted automatically |
| Safety-zip directory | empty | Empty = `<vault root>/.obsidian-safety-snapshots`. **Recommended: move it outside the vault** ([§12](#12-known-limitations) item 3) |
| Delete local extras on restore | **off** | Off = only write missing files back, keep local-only files. On = also delete local-only files (dangerous) |
| Confirm before restore | on | Off = the settings-panel restore skips the dialog; the command-palette restore **always** confirms, and the safety zip is created regardless |
| Log level | `info` | `quiet` / `info` / `debug` |

---

## 6. Daily use

- **Manual backup**: command palette → "Back up `.obsidian` to Dropbox now", or the ribbon cloud icon.
- **Look before you leap**: "Preview diff (writes nothing)" computes the plan without touching either side.
- **Automatic**: on file change (60 s debounce) + optional interval (off by default) + 45 s after startup. All require an authorized account.
- **Snapshots**: one per day by default, keep 7, older deleted.
- **Status bar**: last result summary (uploaded / deleted / errors); turns red on failure. Live log in the settings panel.
- **First full run**: ~327 MiB across 1500+ files (including a >8 MB chunked upload). It takes a while — **don't close Obsidian** during it. Everything after that is incremental.

---

## 7. Restore (cautious by design)

Design principle: **restore is a destructive operation, so every step is put in front of you, and nothing is deleted by default.**

1. **Preview (read-only)** — command palette or the settings panel's **Preview restore** button. No download, no write, no delete; it only produces a plan:
   - files to write back (present remotely, missing or size-different locally)
   - local-only files (present locally, absent remotely) — **listed but not deleted**
   - unchanged count
   - total bytes to download
2. **Confirmation dialog** — source, file count, MB to download, **whether local files will be deleted this time**, and where the safety zip goes. **Cancel = not a single byte changes.**
3. **Automatic safety zip** — after you confirm, the entire current `.obsidian` (within scope) is zipped to `obsidian-config-safety-YYYY-MM-DDThh-mm-ss-mmm.zip` in the safety directory. **If that zip fails, the restore does not happen**: creation failure, the zip not actually landing on disk, or an empty zip while deletions were requested — all three abort with zero files touched.
4. **Write** — one download per file. A single failure (network blip) does not abort the run; failures are collected in the result and the log.
5. **Restart Obsidian** — config-level files (themes, plugin settings) only take full effect after a restart.

Safety constraints, enforced in code rather than promised in prose:

- Local-only files are **not** deleted unless you explicitly enable "Delete local extras on restore" (off by default). The command-palette restore is hardcoded to not delete.
- Before writing/deleting, the sync-scope matcher and path validation run again: `../`, absolute paths and drive-letter paths from the remote side are **rejected**, so nothing can be written or deleted outside `.obsidian`.
- Snapshot archives under the remote `_snapshots/` are **never** restored as configuration files.
- If the remote side is empty while hundreds of local files exist, the plan carries a warning telling you to check the remote directory and authorization before continuing.

### Restoring from a specific snapshot zip

The core layer implements it (download the zip → extract through the plan's allow-list → same confirmation and safety zip) and it is test-covered, **but there is no UI entry point yet** — only the mirror restore is wired up (see [§14](#14-implementation-status)).

---

## 8. Exclude pattern syntax

A subset of gitignore. **No `!` negation** — if you need something back, add it to the include list instead.

| Pattern | Meaning |
|---|---|
| `*` | Any characters within one path segment (does not cross `/`) |
| `**` | Any depth, including zero — e.g. `**/*.tmp` |
| `?` | A single character |
| trailing `/` | Matches directories only |
| no `/` | Matches the same name at any depth (e.g. `workspace.json`) |
| contains `/` | Anchored at the root (e.g. `plugins/插件备份*`) |

Include patterns are checked first (empty = everything passes); matches are then vetoed by exclude patterns. Excluding a directory excludes everything beneath it.

Common tweaks:

- Payload too big? Keep the defaults — they already drop the 442 MB of fat.
- Want `.git` backed up too (not recommended)? Remove `.git/` from the excludes; costs 214 MB of quota.
- Don't want `data.json` (which holds Dropbox credentials) in the cloud? Add `plugins/obsidian-config-sync/data.json` to the excludes. Cost: re-entering the App key and re-authorizing on a new machine.
- Only want config + themes + snippets, no plugin code? Set the include list to `*.json`, `themes/**`, `snippets/**` (note this changes what "remote == local mirror" means — be careful with mirror-delete on).

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `does not have the required scope 'files.metadata.read'` (or another scope) | The scope is unticked, or ticked **without clicking Submit**. After fixing, **disconnect and re-authorize** — old tokens never gain scopes retroactively. |
| `invalid_request: redirect_uri` / `redirect_uri mismatch` | The registered URI differs from what the plugin sends (port, trailing `/`, http vs https). Or the reverse: a URI is registered but you use manual mode (no `redirect_uri`) — both sides must agree. |
| Consent page allows, then nothing happens | Port 53682 is taken, or the browser never called back to `localhost`. Change the port in both places, or switch to manual code paste. |
| `409 not_found` on every upload after connecting | The app is **App folder** type but the remote base directory is still `/Obsidian-Config-Backup`. Change it to `/Apps/<app name>`. |
| 401 token expired | Normal; the plugin refreshes automatically. If refresh also fails (`invalid_grant`), the grant was revoked or scopes changed — re-authorize. |
| 429 / 503 | Rate limiting. The plugin retries with exponential backoff honoring `Retry-After`; if it persists, drop upload concurrency from 3 to 1–2. |
| Remote file count differs from local | Run "Preview diff" and check the exclude rules (e.g. `icons/` is never uploaded by design). |
| Out of quota | Turn off `every-run` snapshots, lower the snapshot retention, clean old safety zips; Dropbox also keeps old versions of overwritten files. |
| Restore seems to have done nothing | Config files need an Obsidian restart. Also, the preview compares **size only**, so same-size-different-content files are not rewritten ([§12](#12-known-limitations) item 1). |

---

## 10. Where everything lives

| Thing | Location |
|---|---|
| The plugin | `<vault>/.obsidian/plugins/obsidian-config-sync/` (`main.js` / `manifest.json` / `styles.css`) |
| Settings + Dropbox credentials | `<vault>/.obsidian/plugins/obsidian-config-sync/data.json` |
| Sync index | `<vault>/.obsidian/plugins/obsidian-config-sync/sync-index.json` (outside the sync scope) |
| Remote mirror | `<your base directory>/<vault name>/…` (default `/Obsidian-Config-Backup/<vault>/…`) |
| Remote snapshots | `<that directory>/_snapshots/*.zip` |
| Restore safety zips | `<vault root>/.obsidian-safety-snapshots/obsidian-config-safety-*.zip` (configurable) |

Note the remote layout: the mirror root **is** the `.obsidian` directory, so remote paths are `app.json`, `plugins/…`, `themes/…` — there is no extra `.obsidian` level in the remote path.

---

## 11. Coexisting with obsidian-git

- The two are independent: this plugin never reads, writes or modifies obsidian-git's settings or repository, and never runs `git commit`.
- `.git/` is excluded, so the mirror never pushes the 214 MB repository.
- Both backups consume their own space: git on local disk, Dropbox on cloud quota. They are separate off-site copies, not duplicated work.
- One caveat: if obsidian-git also backs up `.obsidian`, then "plugin writes config → git commit" and "config changed → this plugin syncs" fire at the same time. The 60 s debounce normally keeps them apart; if you see a storm of auto-commits, turn off "Sync on file change" and rely on interval or manual only.

---

## 12. Known limitations

1. **The restore preview compares "relative path + byte size" only**, never content. Dropbox's `content_hash` is not SHA-256 and cannot be compared to a local sha256; content-level comparison would mean downloading 327 MiB during preview, which is unreasonable. **Consequence**: a file edited locally whose **size happens to be unchanged** (say, `true` → `false`) is judged "unchanged" and not overwritten. To force such a file back, delete it first, then restore.
2. **No end-to-end encryption.** The remote side is plaintext config. The plugin's own `data.json` (containing the `refresh_token`) **is inside the sync scope by default** — a trade-off so a new machine can restore authorization too. If you disagree, add `plugins/obsidian-config-sync/data.json` to the excludes; the cost is re-authorizing.
3. **The safety zip defaults to the vault root** (`<vault>/.obsidian-safety-snapshots/`), so it shows up in Obsidian's file list and is **never cleaned up automatically** (one per restore, roughly the size of the config). Two suggestions: point the safety directory outside the vault, and delete old zips periodically.
4. **Dropbox version history also consumes quota.** Mirror sync overwrites remote files constantly, and Dropbox retains the previous versions according to your plan. Long-term usage will therefore be **higher** than 327 MiB. Check the quota readout in the settings panel occasionally.
5. **Quota math (measured, not estimated)**: mirror 327.1 MiB + one snapshot zip 114.5 MiB; with `daily` + `keep 7` the steady-state ceiling is about **1.1 GiB**. With ~11.2 GiB free that is comfortable — but don't crank the retention up, and avoid `every-run` (one zip per sync exhausts quota quickly).
6. **No conflict merging.** Mirror sync overwrites the remote with the local state; restore overwrites local with the remote state. There is no automatic merge when both sides changed, and no multi-machine locking. If you use several machines, stagger their sync times.
7. **Verified only on Windows 11 + Obsidian 1.14.4.** macOS/Linux are untested (paths go through `node:path`, so it should be portable, but that is a theory, not a test result).
8. **Write-only by default, delete only on request.** The settings-panel toggle "Delete local extras on restore" is off by default, and the command-palette restore never deletes. Local extra files usually survive a restore; deciding what to remove stays your call.

---

## 13. Development

```bash
cd /path/to/obsidian-config-sync
npm install
npm run build        # tsc --noEmit && esbuild → main.js
npm run typecheck    # type-check only
npm test             # builds first, then runs test/**/*.test.mjs (154 tests)
npm run test:only    # same, without rebuilding
npm run test:load    # only the "does the bundle actually load" suite
npm run deploy       # copy into the Obsidian plugin directory
```

The architecture is split in two layers. The core layer deliberately does not depend on the `obsidian` module, so it can be tested directly with `node --test` and Node 24's native type stripping:

- Shell layer (the only place `import "obsidian"` is allowed): `src/main.ts`, `src/ui/**`, `src/http/obsidian.ts`
- Core layer (node builtins + injected HTTP client / zip implementation): `src/scan/**`, `src/sync/**`, `src/snapshot/**`, `src/restore.ts`, `src/dropbox/**`

Runtime dependencies are just `yazl` / `yauzl` (bundled into `main.js`); everything else is Node builtins.

Three tiers of tests, each guarding something different:

| Command | What it covers | How |
|---|---|---|
| `node --test test/dropbox.test.mjs` etc. | Pure logic and edge cases per module | Real temp files + a faithful local mock server |
| `node --test test/e2e.integration.test.mjs` | Whether the **default injected implementations** work together | Real `DropboxClient` + real `scanDir` + real `yazl`/`yauzl` + real sockets (server still mocked) |
| `npm run test:load` | Whether the **bundle loads inside Obsidian** | Compiles `main.js` as CJS, substitutes `obsidian` with `test/helpers/obsidian-stub.cjs`, really runs `onload` / settings tab `display()` / status-bar click / `onunload`, and verifies that touching a config file walks the debounce and triggers a sync |

> `test:load` is not ceremony: it caught a fatal bug that neither `npm run build` nor the unit tests could see — the early `onload()` constructed the sync engine eagerly, and constructing it requires Dropbox credentials, so **a fresh install could not load at all**. The fix was lazy construction (`get engine()`).

The mock in `test/e2e.integration.test.mjs` (`test/helpers/mock-dropbox-server.mjs`) is deliberately stricter than the real service: three entries per page to force pagination, `cursor.offset` validation on `upload_session`, no implicit parent creation in `create_folder_v2`, and a 409 for deleting a missing path. It escapes non-ASCII in the `Dropbox-API-Result` header exactly like Dropbox does — without that escaping, a Chinese filename makes Node's HTTP layer throw `ERR_INVALID_CHAR`.

### Smoke test against real Dropbox

```bash
DROPBOX_APP_KEY=xxx DROPBOX_REFRESH_TOKEN=yyy NODE_USE_ENV_PROXY=1 \
  node scripts/smoke-dropbox.mjs
```

It only touches `/Obsidian-Config-Backup/_selftest-<timestamp>/` and deletes it afterwards — **never the live backup path**. It verifies real server semantics: token refresh, non-ASCII upload, 9 MB through a chunked upload session, recursive listing, byte-exact download, idempotent delete.

`NODE_USE_ENV_PROXY=1` is required when a system proxy is configured: Node's `node:http` ignores `http_proxy`/`https_proxy`, so the script uses the built-in `fetch`-based HttpClient (`scripts/fetch-http-client.mjs`). **The plugin itself has no such problem** — it uses Obsidian's `requestUrl`, which rides Electron's network stack and inherits the system proxy.

---

## 14. Implementation status

As of 2026-10-17, the whole flow has been exercised on a real machine against real Dropbox.

| Capability | Status | Evidence |
|---|---|---|
| Sync core (scan / exclude rules / diff plan / chunked upload / mirror delete / index-based dedupe) | Done | Unit tests + `test/e2e.integration.test.mjs` |
| Snapshots (zip, upload, keep-N rotation) | Done | E2E test asserts only N remain remotely and that entries and uncompressed sizes match |
| Dropbox client + OAuth PKCE (callback / manual) | Done | Real authorization succeeded (loopback mode, `127.0.0.1:53682`) |
| Restore (mirror + snapshot, with confirmation, safety zip, path traversal defence) | Done | 23 cases in `test/restore.test.mjs`; default implementations executed for real by the E2E test |
| Plugin wiring (commands, ribbon, status bar, settings panel, restore entry points) | Done | `test/plugin-load.test.mjs` really loads `main.js` and runs onload / display / click / onunload |
| Real-Dropbox end-to-end smoke (upload/download/delete/rotation in a sandbox) | **Passing** | `scripts/smoke-dropbox.mjs`, 12 checks, sandbox deleted afterwards |
| Deployed to a vault and running in Obsidian | **Passing** | First run: **1584 files / 327.1 MiB**, 0 errors; plus one 114.5 MiB snapshot zip, 441.6 MiB in total remotely |
| UI entry point for restoring **from a snapshot zip** | **Not wired** | Core logic is implemented and tested, but the UI only offers mirror restore; snapshot restore is code-only for now |

154 tests total (`npm test`):

- Per-module: Dropbox client 29, scan 13, sync core 36, watcher/scheduler/formatting 24, restore 23
- `test/e2e.integration.test.mjs`: 13 cases — real client + real scanner + real `yazl`/`yauzl`, only the Dropbox server mocked
- `test/plugin-load.test.mjs`: 12 cases — compiles the bundle as CJS and exercises load, settings panel, status-bar click and watcher triggering

> Anything marked Done / Passing above has a test or a measurement behind it. Two known rough edges: snapshot restore has no UI entry, and snapshot filenames use second-resolution timestamps, so two "create snapshot" clicks within the same second overwrite each other (identical content, nothing is lost).

---

Author: User-ZWW · Version 0.1.0 · Desktop only · Chinese version: [README.zh-CN.md](README.zh-CN.md)
