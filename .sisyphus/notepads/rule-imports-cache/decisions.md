# Decisions — rule-imports-cache

## 2026-09-05 Session start (atlas)
- Interpretation locked for ambiguous plan wording: empty/whitespace-only pattern strings inside import arrays are VALIDATION ERRORS (reject whole request). Rationale: plan forbids "silent skipping"; storing empty regex is dangerous (matches everything). Empty COLLECTIONS (`groups: []`, `patterns: []`, `rules: []`) remain valid = intentional replace-with-empty.
- Effective rules version = existing content-digest approach in `getRulesVersion()`; no version counter table, no migration.
- Cache-hit response contract (T4 → T5 dependency): `RulePayload` gains optional `cacheHit?: boolean`. When server version === client version AND valid negotiation pair → respond `{ userId, rulesVersion, cacheHit: true }` with NO blockRules/highlightGroups fields. Otherwise full payload WITHOUT cacheHit (or cacheHit absent/false).
- Valid negotiation pair = client provides non-empty `rulesVersion` AND `rulesCache=1`. Any partial/malformed negotiation ⇒ full payload.
- T2/T3 run sequentially despite plan's "parallel" flag: both edit `src/index.ts`; same-file parallel edits risk clobbering.
