import base, { prettier, typeAware } from '@delfrance/config-eslint';
import react from '@delfrance/config-eslint/react';
import next from 'eslint-config-next';

const config = [
  ...base,
  ...react,
  ...next,
  ...typeAware(import.meta.dirname, { registerPlugin: false }),
  prettier,
];

export default config;
