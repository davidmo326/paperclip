# Agent review — paperclip (pacc fork) — 2026-09-30

Branch `agent/2026-09-30-review`, cut from `origin/pacc/T-floor` @ `7ac9c6cc`.
`origin/master` is the untouched upstream fork point from March 2026. All pacc work lives on `pacc/T-floor`, 102 commits ahead, so that is the base reviewed here.
Scope: the fork's own delta over upstream, i.e. `packages/plugins/examples/plugin-pacc`, the server changes (plugin-loader, cron/plugin-job-scheduler, control-plane routes/service, board-auth) and the dependency tree. Upstream Paperclip code was only checked where pacc depends on it (bridge authz, board-mutation guard).

A parallel session was committing to `pacc/T-floor` during this review. Its last-6h files were left untouched: steward/*, lines/*, work-items, worker.ts, cron.ts and plugin-job-scheduler.ts. It also had uncommitted work in `lines.ts`, `worker.ts` and a new `backlog.ts`.

## Build health

| Step | Command | Result |
|---|---|---|
| Install | `MISE_NODE_VERSION=26.7.0 pnpm install --frozen-lockfile --ignore-scripts` | OK (18 s). The `pnpm` shim only exists under node 26.7.0; the default mise node 26.8.2 has no pnpm. |
| Typecheck (before) | `pnpm -r typecheck` | **FAIL**: `server/src/services/plugin-loader.ts:1741/1743`, TS2322 + TS1230 on the PACC env filter predicate |
| Typecheck (after fix) | `pnpm -r --workspace-concurrency=1 typecheck` | **PASS**, whole workspace. Parallel `-r` also races on the shared `plugin-sdk`/`shared` builds. |
| Lint | — | No lint script in the repo |
| pacc tests | `cd packages/plugins/examples/plugin-pacc && npx vitest run` | 765 passed, 2 skipped |
| server tests | `cd server && npx vitest run` | 491 passed, 1 flaky (`opencode-local-adapter-environment` passes in isolation; upstream code the fork doesn't touch), 16 skipped |
| Dep audit | `pnpm audit --prod` | 2 critical, 56 high, 53 moderate, 17 low. See below. |

## Findings (ranked)

| # | Sev | Where | Issue | Status |
|---|---|---|---|---|
| 1 | High | `server/src/services/plugin-loader.ts:1735` (pre-fix) | `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` (the z.ai key) and every `PACC_*` var were passed into **every** plugin worker's env, not just pacc. The comment said "nothing else leaks", but any other installed plugin (founder-control-plane, examples, any future npm plugin) received the model token. The server also didn't typecheck. | **Fixed** `053cc75c`: new `plugin-host-env.ts` scopes the pass-through to plugin key `paperclip-pacc`, with a test |
| 2 | High (deps) | `server` → `better-auth@1.4.18` | 1 critical + 7 high advisories: OAuth refresh-token replay, account takeover via auto-link or magic link, stored XSS. The instance runs `local_trusted` on 127.0.0.1, so better-auth flows are mostly unused and exposure is low today. It becomes real if the deployment moves to `authenticated`/tailnet. | Report. Fix by syncing upstream (fork is 6 months behind), not a local bump. |
| 3 | Medium | `plugin-pacc/src/worker.ts` ~995–1200 (`record-grant`, `record-decision`, `update-line`, `create/update-work-item`, `import-lines`) | The curation split rests on a caller-supplied `actor`/`grantedBy` string: principal edits coarse fields, CoS only fine fields with sourceRefs, runtime only into needs-you, grants are principal-only. A missing `actor` **defaults to `"principal"`** (fail-open). The host bridge is board-only (`assertBoard`). But in `local_trusted` mode any local process is the board, including dispatched hands running with skip-permissions. So a hand can `curl 127.0.0.1:3100/api/plugins/.../bridge/action` and self-grant authority or rewrite a line's coarse layer. | Report. Worker.ts is being edited by the active session. Suggested fix: require an explicit actor (no default), and have the cockpit stamp `principal` only on principal-UI calls. |
| 4 | Medium | `server/src/services/cron.ts:414` `nextCronTickInZone` | Walks minute by minute with `Intl.formatToParts`, capped at 366 days. (a) A schedule whose next tick is more than 366 days away returns `null` and never runs; verified with `0 0 29 2 *`, where UTC gives 2028-02-29. (b) That miss costs about **2.5 s of synchronous event-loop blocking** per evaluation. Current pacc jobs are daily or weekly, so this is latent. | Report (cron.ts touched by the active branch). Fix: walk day by day and only scan minutes inside matching days, or fall back to `nextCronTick` plus an offset. Added regression tests for the working paths: `60bda8d7`. |
| 5 | Low | `plugin-pacc/src/worker.ts:1278` `index-vault` | `vaultRoot` comes from the caller, so any board caller can index an arbitrary directory (e.g. `/`) into plugin state. That is a DoS or scope leak, not an escalation, since a local board caller can already read files. | Report. Pin it to `PACC_OBSIDIAN_DIR` or drop the param. |
| 6 | Low | `plugin-pacc/src/lib/briefer/model-claude-cli.ts:143` | CLI stdout/stderr are buffered without a cap. | Report |
| 7 | Low | `plugin-pacc/src/lib/heartbeat.ts:103` `getViaIpv4` | The IPv4 fallback drops `parsed.port` and forces https. A heartbeat URL with a custom port or plain http would hit the wrong endpoint. | Report |
| 8 | Low | `plugin-pacc` `record-run-result` → steward context | Hand output (untrusted, and possibly web-derived for C) flows into item results that later feed the CoS prompt, which is a prompt-injection path. Mitigated because the CoS only proposes and promotion is capacity-gated. | Report / design note |
| 9 | Info | `docker-compose.vm.yml`, `.env.example` | Stale ubuntu-VM paths (`/home/ubuntu/llm_shared/...`). `.env.example` still documents the old default `PACC_BRIEFER_MODEL_TIMEOUT_MS=120000` (the steward default is now 10 min). | Report |
| 10 | Info | node toolchain | mise default node 26.8.2 has no pnpm, so `pnpm` fails outside `MISE_NODE_VERSION=26.7.0`. | Report (agent-fabric toolchain pins) |

Checked and found OK:
- The CLI spawn is argv-only, with no shell.
- The M1b vault write mediator does realpath containment and a case-insensitive protected-path check.
- The brief writer has a no-clobber guard.
- Control-plane routes call `assertCompanyAccess`.
- The bridge routes call `assertBoard`.
- The board-mutation guard, combined with a JSON-only body parser, blocks cross-site POSTs.

## Secrets scan

- `git log -p origin/master..HEAD` and the working tree were scanned for API-key, token, private-key and Telegram-token patterns: **no secrets in the paperclip fork**. The only hits are doc placeholders (`sk-ant-...`).
- Still open, owned by David, and outside this repo (from the ControlPlane PHASE_LOG):
  - `BETTER_AUTH_SECRET` in ControlPlane git history (`scripts/pacc-paperclip.service`)
  - the z.ai token in plaintext in the laptop unit file
  - the LUKS recovery key in the synced vault

## Dependency audit (high/critical, prod)

All of these are inherited from the March upstream base:
- **Auth:** better-auth (1 critical + 7 high).
- **Injection:**
  - drizzle-orm 0.38.4: SQL identifier escaping.
  - kysely 0.28.11: JSON-path injection.
  - defu: prototype pollution.
- **Denial of service:**
  - multer 2.0.2: 6 DoS advisories.
  - path-to-regexp.
  - js-yaml.
- **URL parsing:** fast-uri: SSRF/host confusion via ajv.
- **UI:**
  - react-router 7.13.0: XSS, DoS, CSRF in RSC mode, which Paperclip doesn't use.
  - lodash-es.
- **Image handling:** sharp: libvips CVEs.
- **Transitive (vitest/jsdom via better-auth):** vitest, vite, undici, nanoid, rollup, postcss, picomatch.

The single lever is an **upstream sync** of `pacc/T-floor` onto current `upstream/master`. It is a sizeable merge (and the fork's own `0046/0047` migrations need renumbering against upstream's), so it is David's call, not an agent's.

## PRD / PHASE_LOG status

The source of truth is `~/Work/ControlPlane/PHASE_LOG.md`. The vault `10_Builds/Personal AI Control Plane/PHASE_LOG.md` is a pointer that says "do not log here", and this repo has no PHASE_LOG. **No PHASE_LOG was appended**: the vault stub forbids it, and ControlPlane is another repo with an active session.

Latest entry (2026-09-30 b): the control plane lives on omarchy-desktop and the CoS runs on the principal's subscription.

**Executed now:** none (feature work). This branch carries only the security fix and the tests.

**Blocked:**
- *Desktop Claude `/login`* and *`migrate-finish.sh`*: need David (credentials, sudo, cockpit token).
- *Fixing the CoS "model schema violation" fallback*: needs the next live run's logged reason. It also touches `steward/*`, which the active `pacc/T-floor` session is editing.
- *Deferred list*:
  - score→work calibration
  - permissions from the floor
  - J beyond capacity
  - T
  - floor-based §0.5 clock
  - auto-push of `snapshot:` commits
  - extract-from-Paperclip, where D-44 conflicts with Q1(b) and David has to decide

  All of these are either David decisions or sit in `lines/*`/`work-items`/`worker.ts`, which have in-flight uncommitted edits (`backlog.ts`).

## Recommended next smallest increment

1. Cherry-pick `053cc75c` (and `60bda8d7`) onto `pacc/T-floor`. It is independent of the active session's files and restores a clean server typecheck.
2. Then make `actor` required on the pacc bridge actions (finding 3). It's a single edit in `worker.ts` once the active session has committed.
