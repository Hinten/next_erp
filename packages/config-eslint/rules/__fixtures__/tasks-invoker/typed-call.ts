// Fixture for tasks-invoker-inventory.test.js — never imported, built or deployed.
// A task function written with a TYPE ARGUMENT, invoker spread present: it must be
// discovered and must pass. The old literal grep never saw it.
interface Payload {
  id: string;
}

export const typedCall = onTaskDispatched<Payload>(
  { ...tasksInvokerOptions(), retryConfig: { maxAttempts: 3 } },
  async (req) => {
    void req.data.id;
  },
);
