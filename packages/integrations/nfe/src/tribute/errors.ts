/**
 * The tribute engine's operator-fixable build-time error.
 *
 * Lives in its own dependency-free module so every tribute builder can throw
 * it without importing another builder: `rtc.ts` must not import `imposto.ts`
 * (which already imports `rtc.ts`), yet an incomplete `configuracaoIBSCBS` is
 * the same class of defect as a partial ICMSSN900 group — a stored config the
 * operator fixes and re-emits. `imposto.ts` re-exports it under the same name,
 * so the barrels and every existing import are unchanged.
 */
export class NFeTributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeTributeError';
  }
}
