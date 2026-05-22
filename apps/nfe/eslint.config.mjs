import base from '@delfrance/config-eslint';
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
];

export default config;
