# Browser acceptance suites

Phase 01: `pnpm test:e2e:auth` runs actual Chromium, independent contexts/tabs, API/worker/Vite, Mongo/Redis/Mailpit and unique isolated test DB cleanup. Build first; install matching Chromium with `PLAYWRIGHT_BROWSERS_PATH` set to workspace `.cache/ms-playwright`. Ports 3000/3002/5173 must be free. Tests do not reuse your running dev server. Evidence: docs/phase-01-evidence.md. Conversation/offline/attachment/call/a11y suites remain planned in their owning phases.
