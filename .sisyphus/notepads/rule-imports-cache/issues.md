# Issues — rule-imports-cache

## 2026-09-05 Session start (atlas)
- (none yet)

## 2026-09-05 T1 completion (sisyphus-junior)
- Early QA noise (ProtocolViolationException, empty-body 401s) was PS 5.1 tooling (Secure cookie not replayed; Cookie header dropped), NOT a server defect - verified by raw curl sequence returning correct JSON 401s and correct exports.
- 'wrangler d1 execute --local -c wrangler.local-qa.jsonc' found no qa_t1_ users: CLI state-dir mapping differs from the running dev server's D1. Worked around by using the HTTP export endpoints for verification (sufficient and user-scoped); no local DB files were reset.
- Plan's 'temporary prepare counter' instrumentation deemed unnecessary: parse+validation provably run before the first D1 statement, and SHA-256 before/after export fingerprints prove rejected requests issue no writes. Documented in task-1-rejections.json.writePreventionMethod.
- Plan QA examples say email for register/login; actual auth fields are username/password (corrected in QA script).
- B5 (exactly-1-MiB body) passes; 1 MiB+1 (413) covered in R2. No environmental limitations to record.
## 2026-09-05 T4 completion (sisyphus-junior)
- Authenticated HTTP negotiation cases were not exercised because no session-backed local D1 fixture was available without modifying unrelated QA state; source contract and anonymous bounded probe were verified instead.
## 2026-09-05 T3 completion (sisyphus-junior)
- Authenticated subscription replacement and injected batch failure were not exercised over HTTP because no session-backed local D1 fixture was available; source-level statement ordering, field preservation, validation-before-write behavior, and D1 rollback semantics were verified instead.
## 2026-09-05 T5 completion (sisyphus-junior)
- Browser QA was not possible: the Playwright MCP requires Google Chrome (system install failed: insufficient privileges) and browser/package installation is forbidden in this execution context. DOM-level behaviors (visual block/highlight rendering, real navigation) were therefore not exercised in a real browser; instead the exact served client functions (loadRules/repairRulesCache/pager click handler) were executed in a Node harness and the SSR negotiation matrix was verified over real HTTP against an isolated wrangler dev with a seeded mock RSS feed. Recorded as `limitation` in task-5-client-logic.json.
- The plan-mandated PNGs (task-5-pagination-cache.png / task-5-cache-recovery.png) were NOT created because no browser tooling was available; task-5-http-contract.json + task-5-client-logic.json are the bounded replacements, per the "document honestly, no fake screenshots" constraint.
