import base, { prettier, typeAware } from '@delfrance/config-eslint';
import react from '@delfrance/config-eslint/react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...base,
  { plugins: { 'react-hooks': reactHooks } },
  ...react,
  // ⚠️ The two CLASSIC react-hooks rules, which this package was not getting.
  // It registers the plugin above (so `...react`'s two React Compiler warns
  // resolve), but `rules-of-hooks` and `exhaustive-deps` reach the rest of the
  // repo only through `eslint-config-next` — which a library does not spread.
  // So the components every CRUD screen in the ERP is built from, `TableView`
  // and `ObjectView`, were the one React surface with no hook linting at all.
  //
  // Severities match what the 8 Next apps already get from next, deliberately:
  //
  //  - `rules-of-hooks` as ERROR is free — ZERO violations here. A conditional
  //    or nested hook call is never stylistic; it desynchronises the hook order
  //    and produces wrong state rather than a crash.
  //  - `exhaustive-deps` as WARN, over a measured population of 21. That is the
  //    repo's ratchet convention (see the `delfrance/*` warns in the base
  //    config): `.lintstagedrc.mjs` runs `--max-warnings 0`, so touching one of
  //    those 21 files means fixing it, while CI does not fail on the backlog.
  {
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  ...typeAware(import.meta.dirname, { files: ['src/**/*.{ts,tsx}'] }),
  prettier,
];
