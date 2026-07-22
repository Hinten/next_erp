import base, { prettier, typeAware } from '@delfrance/config-eslint';
import react from '@delfrance/config-eslint/react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  ...base,
  { plugins: { 'react-hooks': reactHooks } },
  ...react,
  ...typeAware(import.meta.dirname, { files: ['src/**/*.{ts,tsx}'] }),
  prettier,
];
