// A second file inside the fake schemas package, used only as the `filename`
// for the "declarations inside packages/schemas are exempt" case. It is kept
// separate from `enums.ts` on purpose: RuleTester swaps the linted file's
// content inside the shared TS program, so testing that case against `enums.ts`
// would erase the enum declarations every later case depends on.
export {};
