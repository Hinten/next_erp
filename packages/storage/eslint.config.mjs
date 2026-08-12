import base, { prettier, typeAware } from '@delfrance/config-eslint';

export default [
  ...base,
  // The base bans the raw `firebase/storage` operations to funnel every
  // consumer through this package's helpers — this package IS that
  // implementation, so the ban is off here (and only here).
  {
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  ...typeAware(import.meta.dirname, { files: ['src/**/*.{ts,mts}'] }),
  prettier,
];
