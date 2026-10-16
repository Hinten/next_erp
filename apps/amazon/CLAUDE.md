# apps/amazon

API-only App Hosting backend for the Amazon (SP-API) marketplace channel, port 3011.

- Step 1 of the master plan is only the scaffold: `GET /api/health`. No route
  under `/api/marketplace` yet (its CORS `proxy.ts` arrives with the first one),
  no Firestore access, no environment variable.
- The platform is called only through `@delfrance/integrations-amazon-sp-api`,
  never with a raw `fetch` here. The package is not a dependency yet; the step
  that first imports it adds it, with `transpilePackages`.
- Mock only before the cutover (D11): no code here calls Amazon until the
  window, and then behind valves and canaries. Tests run against fixtures.
- The LWA authorization belongs to this integration alone, its own, never the
  legacy app's (D10). Never put a token or the client secret in a URL, a log or
  a response.
- `vitest.config.ts` excludes `*.firestore.test.ts` and `*.tasks.test.ts`
  (emulator suites need their own lane — **none exists yet**, so the step that
  adds the first such suite must add its lane in the same change, or it runs
  nowhere while every check stays green); `eslint.config.mjs` still lints them
  and only lets them build raw Firestore refs. Both already cover the nested
  `functions/` codebase, so adding those later needs no edit to either.
- `next` is an exact literal in `package.json`, never `catalog:` or a range.

See `.master_plans/amazon/amazon-marketplace-integration.md` (master plan, step 1 = #1925, tracker #1923).
