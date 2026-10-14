// Fixture for tasks-invoker-inventory.test.js — never imported, built or deployed.
// Prose mentions, in the shapes the repo's own docblocks actually use (the queue
// helpers, the payload modules, `options.ts`). None is a call, so this file must
// not be discovered.

/**
 * Enqueues onto the Firebase Functions task queue (`onTaskDispatched`), the same
 * transport the notification pipeline uses. The queue's rate limit feeds
 * `onTaskDispatched.rateLimits` at deploy time, and the deployed `onTaskDispatched`
 * function name is also its queue name.
 */
export const QUEUE_NAME = 'fixtureQueue';
