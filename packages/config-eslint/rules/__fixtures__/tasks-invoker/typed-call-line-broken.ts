// Fixture for tasks-invoker-inventory.test.js — never imported, built or deployed.
// A NESTED type argument long enough that prettier breaks it across lines. `git
// grep` is LINE-oriented, so no grep regex can see the opening angle bracket and
// the closing one with its paren together here — this is why the call shape is
// matched in JS over the whole file. The nesting also pins that the type argument
// closes at the right bracket: a `[^>]*` body stops at the inner one.
export const typedCallLineBroken = onTaskDispatched<
  Record<'pedidoId' | 'integracaoId' | 'tentativa', string | number | null | undefined>
>({ ...tasksInvokerOptions() }, async (req) => {
  void req.data;
});
