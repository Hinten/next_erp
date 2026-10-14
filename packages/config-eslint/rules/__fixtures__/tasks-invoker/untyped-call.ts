// Fixture for tasks-invoker-inventory.test.js — never imported, built or deployed.
// The shape every real task function in the repo uses today: no type argument. The
// control case — the tolerant matcher must still find it.
export const untypedCall = onTaskDispatched({ ...tasksInvokerOptions() }, async (req) => {
  void req.data;
});
