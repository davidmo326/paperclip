# T-2.1 — real-vault initial-scan measurement

For folding into `ControlPlane/docs/paperclip-dev-loop.md` (per T-2.1 acceptance:
"Initial scan latency on the principal's actual vault … actual time recorded in
paperclip-dev-loop.md").

- **Date:** 2026-07-10
- **Vault:** `/home/ubuntu/llm_shared/Obsidian` (read-only; live principal vault)
- **Method:** `runInitialScan()` from
  `plugin-pacc/src/lib/obsidian-watcher-deps.ts` — walks every `.md` file via the
  T-2.4 vault walker (dot-dirs skipped), reads + sha256-hashes each, stats mtime,
  emits one `source.note.changed` per file with M1a/M1b tier from the value-anchor
  registry. Run via `tsx` on the NUC.
- **Result:** **1505 markdown files scanned, 1505 events emitted, 1178 ms wall-clock (~1.2 s)**
  — far inside the 120 s acceptance budget.
- **Note:** `find Obsidian -iname '*.md' | wc -l` reports 1511; the delta (6) is
  files under ignored dot-directories (`.obsidian/`, `.trash/`, `.git/`), which the
  scan intentionally skips.
- **Watcher startup:** chokidar is started with `ignoreInitial: false`, so the same
  per-file `add` pass happens automatically at plugin startup — it warms the rename
  correlation cache and doubles as the T-2.2 cold-start index feed.
