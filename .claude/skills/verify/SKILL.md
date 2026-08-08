---
name: verify
description: Run typecheck and the full test suite before considering work in this repo done. Use when finishing a task, before committing, or when the user asks to verify changes.
---

Run, in order:

```bash
npm run typecheck
npm run lint
npm test
```

This repo has no CI workflow, so these commands are the only regression check before a commit — don't skip any of them.

`npm test` includes integration tests that boot a real Playwright browser against a local fixture site, so it takes noticeably longer than `npm run test:unit` alone. If you only need fast feedback on non-browser logic while iterating, run `npm run test:unit` first, but always finish with the full `npm test` before reporting success.

If either command fails, find the root cause and fix it, then re-run both from the top before declaring the work done.
