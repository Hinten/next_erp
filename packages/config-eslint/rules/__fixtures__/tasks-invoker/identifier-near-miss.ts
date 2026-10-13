// Fixture for tasks-invoker-inventory.test.js — never imported, built or deployed.
// Identifiers that CONTAIN the name but are not it. Neither is a Cloud Tasks
// function, so neither may be discovered — the tolerance added for type arguments
// must not widen into "anything that starts or ends with onTaskDispatched".
export const suffixed = onTaskDispatchedX({}, async () => {});
export const prefixed = myonTaskDispatched<unknown>({}, async () => {});
