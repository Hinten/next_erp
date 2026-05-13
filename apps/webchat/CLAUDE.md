# apps/webchat — CLAUDE.md

Embeddable chat widget. **Static export** to Firebase Hosting (CDN). No SSR runtime.

## Rules

1. **No Mantine, no `packages/ui`**. Bundle target: ≤ 60KB gzip.
2. **Vanilla CSS or inline styles** only. No CSS-in-JS frameworks.
3. **Static export** (`output: 'export'` in `next.config.ts`). Builds to `out/` deployed via `firebase deploy --only hosting:webchat`.
4. **Loader script** in `public/loader.js` is the embed entry point — versioned and cached aggressively. Phase 4 wires up the real iframe + postMessage protocol.

## Dev

```bash
pnpm --filter @delfrance/webchat dev   # http://localhost:3002
pnpm --filter @delfrance/webchat build && pnpm --filter @delfrance/webchat exec next export
```
