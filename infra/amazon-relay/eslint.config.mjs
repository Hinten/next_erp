import base, { prettier, typeAware } from '@delfrance/config-eslint';

// The library shape (base + type-aware rules scoped to the tsconfig `include`
// + prettier last). `cdk.out/` is a synth output the owner's CLI writes here at
// W2a; it is gitignored and never linted.
export default [
  { ignores: ['cdk.out/**'] },
  ...base,
  ...typeAware(import.meta.dirname, {
    files: ['bin/**/*.{ts,mts}', 'lib/**/*.{ts,mts}', 'test/**/*.{ts,mts}'],
  }),
  prettier,
];
