// Fixture for tasks-invoker-inventory.test.js — never imported, built or deployed.
// The shape that actually escaped while the Loja Integrada functions codebase was
// being built (#1891/#1892): a typed call with NO invoker spread. It must be
// discovered AND flagged — this is the file that would deploy without `invoker`
// while every assertion stayed green.
export const typedCallNoInvoker = onTaskDispatched<unknown>(
  { retryConfig: { maxAttempts: 3 } },
  async (req) => {
    void req.data;
  },
);
