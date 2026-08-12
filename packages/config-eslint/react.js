// React Compiler-aware rules from eslint-plugin-react-hooks v7. The project
// doesn't enable React Compiler yet; keep these as advisory warnings instead
// of errors so existing patterns don't block CI.
//
// Unscoped and registers no plugin: every consumer already has the
// `react-hooks` plugin instance registered before spreading this block (apps
// via `eslint-config-next`, packages/ui via its own explicit registration),
// and flat config forbids registering the same plugin name twice ("Cannot
// redefine plugin").
export default [
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
];
