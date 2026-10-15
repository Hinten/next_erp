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
  // Severities match what the 10 Next apps already get from next, deliberately:
  //
  //  - `rules-of-hooks` as ERROR is free — ZERO violations here. A conditional
  //    or nested hook call is never stylistic; it desynchronises the hook order
  //    and produces wrong state rather than a crash.
  //  - `exhaustive-deps` as WARN. It was a ratchet over a backlog that is now
  //    ZERO (#1704) — but the backlog had grown to 27, not the 21 once
  //    measured, because the `--max-warnings 0` pre-commit gate this relied on
  //    never actually ran until #1709. Every remaining omission is a scoped
  //    `eslint-disable-next-line … -- <reason>`: the memos key on value
  //    SERIALS (`filtersSerial`, …) rather than on object identities that
  //    change every render, which for `TableView` would re-execute a billed
  //    query per render. Adding a dependency is never a mechanical edit here.
  {
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  ...typeAware(import.meta.dirname, { files: ['src/**/*.{ts,tsx}'] }),
  prettier,
];
