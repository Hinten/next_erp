/**
 * Thrown from `ObjectView`'s `onAfterSave` to mean: **the record itself saved,
 * but a sibling step needs the operator before we leave this page.**
 *
 * `onAfterSave` runs after the main document is already persisted, so a
 * rejection there is never "the save failed" — it is "there is more to do".
 * The two outcomes must not be conflated:
 *
 *  - a genuine failure (`FirebaseError`, `ZodError`) shows in the form alert;
 *  - anything unrecognised is a bug and is rethrown loudly;
 *  - **this** error is neither. It means the flow deliberately stopped, and the
 *    operator has something in front of them — a write conflict to review, a
 *    confirmation to answer. `onSaved` must NOT run, because on the edit pages
 *    it navigates away (`router.replace('/produtos')`) and would take the
 *    operator off the very screen holding the thing they must resolve.
 *
 * Without this the two available options are both wrong: rethrowing turns a
 * deliberate pause into an unhandled rejection, and returning normally
 * navigates away from it.
 */
export class AfterSaveBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AfterSaveBlockedError';
  }
}
