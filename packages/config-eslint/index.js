// Flat config base. Apps and packages extend this and add framework-specific
// rules (e.g., apps/web extends with eslint-config-next).
export default [
  {
    ignores: ['**/.next/**', '**/dist/**', '**/out/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
];
