import base, { prettier } from '@delfrance/config-eslint';
import next from 'eslint-config-next';

const config = [
  ...base,
  ...next,
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
