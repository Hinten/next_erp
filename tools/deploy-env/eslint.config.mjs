import base, { prettier } from '@delfrance/config-eslint';

// No `typeAware(...)`: this package is plain ESM with no TypeScript and therefore
// no tsconfig for the type-aware rules to attach to. Base + prettier is the whole
// contract — see the root CLAUDE.md ("libraries spread base + typeAware(scoped) +
// prettier"; the typeAware half is what a TS library adds, not a requirement).
export default [...base, prettier];
