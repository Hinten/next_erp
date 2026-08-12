// Library-side ESLint config. `@delfrance/config-eslint`'s base array is now
// composable — the react-hooks rules moved to the opt-in `./react` subpath, so
// a non-React package like this one can spread the base directly instead of
// hand-wiring its own rule set.
//
// The base registers the `delfrance` plugin and configures every non-type-aware
// rule in it, so this package needs no plugin block of its own: at `error`,
// default-query-needs-index, no-ad-hoc-money-rounding, no-optional-without-nullable
// and no-client-estado-history-write; at `warn`, no-inline-admin-collection and
// no-error-as-sole-instanceof. The seventh, `prefer-schema-enum`, is type-aware
// and therefore lives inside `typeAware(...)` — spread below, which is what turns
// it on here.
//
// Two of those matter most in this package: no-optional-without-nullable
// self-scopes by path and only ever fires on `packages/schemas`, and
// default-query-needs-index reads every `meta.defaultQuery` declared here
// against firestore.indexes.json.
import base, { prettier, typeAware } from '@delfrance/config-eslint';

export default [...base, ...typeAware(import.meta.dirname, { files: ['src/**/*.ts'] }), prettier];
