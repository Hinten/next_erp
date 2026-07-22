// Library-side ESLint config. `@delfrance/config-eslint`'s base array is now
// composable — the react-hooks rules moved to the opt-in `./react` subpath, so
// a non-React package like this one can spread the base directly instead of
// hand-wiring its own rule set. The three `delfrance/*` rules
// (default-query-needs-index, no-ad-hoc-money-rounding,
// no-optional-without-nullable) are already at `error` in the base — this
// package doesn't need its own plugin block for them.
import base, { prettier, typeAware } from '@delfrance/config-eslint';

export default [...base, ...typeAware(import.meta.dirname, { files: ['src/**/*.ts'] }), prettier];
