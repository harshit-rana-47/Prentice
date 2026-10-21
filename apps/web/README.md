# Prentice web

The Next.js application has the public landing page and the signed-in Home/workspace. Repository work stays in the local connector. Supabase provides Prentice identity; provider authentication is separate.

Run the complete local stack from the repository root with `npm run dev`. The website binds to `127.0.0.1:3000`; the connector uses `127.0.0.1:4731`. The loopback cloud starts only when Supabase configuration is present. See the root README for setup and the local Supabase integration-test workflow.

`npm run typecheck -w @prentice/web` generates Next route/layout types before running TypeScript, including on a clean checkout. `npm run build -w @prentice/web` builds production assets. Browser relay regressions use `npm run test -w @prentice/web`.

The root ProductShell shows the public landing until sign-in, then manages Prentice sign-in, pairing, device selection, Home, and the workspace. Before a connector is paired, it can show the account's limited cloud overview from `/v1/overview`: project names and dates, recent outcome/count summaries, and concept labels. A connected workspace uses `/v1/home` through its authenticated local connector or relay session. Full conversations, search, detailed activity, learning and Debug records come from that account's local database; project/conversation pins and the Home visit timestamp are local settings. A checkout must be linked explicitly before a synced project can be used on another computer. The legacy `/tasks/[id]` route has been removed. Provider Disconnect disables a provider only in Prentice. Prentice Sign Out invalidates Prentice sessions and keeps the connector and vendor logins intact.
