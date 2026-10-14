// Ambient stand-ins for the fixtures in this directory, so that together with the
// tsconfig.json beside them they form a real, type-correct program (`tsc -p` on
// this directory passes) rather than loose `.ts` text outside every program, which
// unused-vars-enabled.test.js refuses. Nothing imports any of it:
// tasks-invoker-inventory.test.js reads these files as TEXT.
//
// ⚠️ Declared as `const` with a type annotation, never as a generic function
// declaration: that spelling IS the call shape the matcher looks for, and would
// make this file a discovered "task function".
type TaskFunction = <T>(opts: object, handler: (req: { data: T }) => Promise<void>) => unknown;

declare const onTaskDispatched: TaskFunction;
declare const onTaskDispatchedX: TaskFunction;
declare const myonTaskDispatched: TaskFunction;
declare function tasksInvokerOptions(): { invoker?: string[] };
