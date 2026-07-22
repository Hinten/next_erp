// Library-side ESLint config. `@delfrance/config-eslint`'s base array is now
// composable — the react-hooks rules moved to the opt-in `./react` subpath, so
// a non-React package like this one can spread the base directly instead of
// hand-wiring its own type-aware block. The "no generic catch" convention
// (CLAUDE.md rule 6) ships in the base and is enforced here too.
import base, { prettier, typeAware } from '@delfrance/config-eslint';

export default [
  ...base,
  ...typeAware(import.meta.dirname, { files: ['src/**/*.{ts,mts}', 'test/**/*.{ts,mts}'] }),
  prettier,
];
