# T-2.2 — Real-vault initial scan measurement

- **Date:** 2026-07-10
- **Vault:** `/home/ubuntu/llm_shared/Obsidian` (read-only; storage in-memory — live DB untouched)
- **Command:** `PACC_REAL_VAULT_SCAN=1 pnpm vitest run src/__tests__/source-index-real-vault.test.ts` (in `packages/plugins/examples/plugin-pacc`)

## Result

| Metric | Value |
|---|---|
| Markdown files found (dot-dirs excluded) | **1508** |
| Files indexed | 1508 |
| Files failed | 0 |
| Wall clock | **2.865 s** (2865 ms) |
| Acceptance budget (PRD § 9.2) | 120 s — passed with ~40x headroom |

## Notes

- The scan is checkpointed per file (`source-index-scan.v1` plugin_state row);
  at ~530 files/s an interrupt loses at most one file of progress.
- Numbers are from the NUC's local disk (no network mount), matching the
  T-2.1 v3 amendment's environment note.
- Re-running the gated test reproduces the measurement; it is skipped unless
  `PACC_REAL_VAULT_SCAN=1`, so CI and the normal suite never touch the live vault.
