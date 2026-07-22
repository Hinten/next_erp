import base, { prettier, typeAware } from '@delfrance/config-eslint';
import react from '@delfrance/config-eslint/react';
import next from 'eslint-config-next';

const config = [
  ...base,
  ...react,
  ...next,
  // registerPlugin: false — eslint-config-next already registers @typescript-eslint.
  ...typeAware(import.meta.dirname, { registerPlugin: false }),
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  // eslint-config-prettier LAST — disables stylistic rules that conflict with
  // Prettier (formatting is owned by `prettier.config.mjs` / `pnpm format`).
  prettier,
];

export default config;
