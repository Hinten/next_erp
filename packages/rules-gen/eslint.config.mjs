import base, { prettier, typeAware } from '@delfrance/config-eslint';

export default [
  ...base,
  ...typeAware(import.meta.dirname, {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
  }),
  prettier,
];
