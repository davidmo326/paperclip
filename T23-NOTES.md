# T-2.3 — Note-to-project association: real-vault stats

Command: `PACC_REAL_VAULT_SCAN=1 pnpm vitest run src/__tests__/note-association-real-vault.test.ts`
(run from `packages/plugins/examples/plugin-pacc`). Read-only against the
live vault + real `portfolio-seed.json`; in-memory store; never wrote
`_pacc_overrides.json` or touched the live DB.

```
totalNotes=1509
unassociated=838 (55.5%)
byProject={"ndis":36,"co-reader":8,"accounting":12,"book-energy-cycles":9,
  "business-model-analysis":15,"circlo":558,"dao":5,"hometrics":8,
  "misson-control-explainer":13,"smb-assistant":2,"tax-manager":3,
  "ai-governance":1,"storycrafter":1}
byMethod={"none":838,"wikilink-hub":43,"path-prefix":623,"title-fuzzy":5}
projects=13 (portfolio-seed.json has 13 entries, not the 12 the PLAN
  amendment states — ai-governance appears to have been added after)
overridesLoaded=0 (_pacc_overrides.json does not exist yet)
```

**55.5% unassociated — above the PLAN's <30% target. Reporting honestly per
the acceptance clause's second branch, not forcing it down.**

Why: of 646 `.md` files actually under `10_Builds/`, path-prefix correctly
matches 623 (the other 23 are in `10_Builds/Personal AI Control Plane/`,
which has no `portfolio-seed.json` entry). The rest of the unassociated
bucket is vault content genuinely outside any project folder:
`20_Knowledge/` (271), `Daily/` (194), `99_Archive/` (107), `raw/` (82),
`Books/` (57), `00_Inbox/` (32). None of the four spec'd heuristics should
be expected to claim these — this isn't a bug, it's the vault's actual
shape. Full detail + remediation options in
`ControlPlane/docs/note-association.md`'s "Real-vault association run"
section.

Per-project sanity check (files actually on disk under each seeded
`10_Builds/<folder>`, vs. path-prefix matches): Circlo 551, NDIS 29,
Misson-control explainer 13, Hometrics 6, DAO 5, Co-reader 5, Business Model
Analysis 5, tax-manager 3, Accounting 3, Book - Energy Cycles 2,
SMB_assistant 1 — sums to 623, matching `byMethod["path-prefix"]` exactly.
Every seeded `10_Builds/` project's primary notes associate at confidence
0.85 via this rule (acceptance item 1, met).
