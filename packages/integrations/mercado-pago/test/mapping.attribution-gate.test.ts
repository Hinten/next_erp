import { describe, expect, it, vi } from 'vitest';
import { pagamentoSchema } from '@delfrance/schemas';
import { mpPaymentSchema } from '../src/types';
import { mpPaymentToPagamento } from '../src/mapping/payment';

/**
 * The mapper's FINAL gate on the two attribution keys (#367).
 *
 * `mapping.test.ts` proves that the real `linkPagamentoIdSchema` and the real
 * `extrairPrimeiroNome` never hand the mapper something unwritable — so on its
 * own it can NEVER tell whether the gate exists: with the gate deleted, every
 * assertion in that file still passes, because nothing upstream lets a bad value
 * through. This file makes the upstream permissive on purpose (the two sources
 * are replaced by fakes that accept anything string-shaped) and asserts the
 * mapper still drops what `pagamentoSchema`'s own fields refuse.
 *
 * Why the gate matters: `reconcilePedidoFromPagamento` re-parses the mapper's
 * output strictly INSIDE the pedido transaction. A value `pagamentoSchema`
 * rejects would throw there, read as transient to the notification pipeline, and
 * be retried until a REAL payment parks (the #1087 class). Losing the
 * attribution is the cheap outcome.
 *
 * `pagamentoSchema` itself is left REAL — it imports its own copy of the link-id
 * schema, so the fake below does not weaken the gate under test.
 */
vi.mock('@delfrance/schemas', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Imported inside the factory: `vi.mock` is hoisted above this file's imports.
  const { z } = await import('zod');
  return {
    ...actual,
    // Accepts ANY string — a 'a/b' or a 21-char id now survives the first check.
    linkPagamentoIdSchema: z.string(),
    // The first string source, verbatim: no title-casing, no length cap.
    extrairPrimeiroNome: (...fontes: ReadonlyArray<unknown>): string | null =>
      fontes.find((fonte): fonte is string => typeof fonte === 'string') ?? null,
  };
});

const OUTER_REF = 'documents/metodo_pgto/acc-1';
const NOW_MICROS = 1_700_000_000_000_000;
const LINK_ID = 'aB3dE5gH7jK9mN1pQ3rS';

function map(raw: Record<string, unknown>) {
  return mpPaymentToPagamento(mpPaymentSchema.parse({ id: 987654321, ...raw }), {
    metodoOuterRef: OUTER_REF,
    nowMicros: NOW_MICROS,
  });
}

describe('mapper final gate — linkPagamentoId', () => {
  it('control: a well-formed id passes the permissive first check AND the gate', () => {
    const { pagamento } = map({ metadata: { link_id: LINK_ID } });
    expect(pagamento.linkPagamentoId).toBe(LINK_ID);
  });

  it.each([
    ['a slash', 'a/b'],
    ['21 chars', `${LINK_ID}x`],
    ['19 chars', LINK_ID.slice(1)],
    ['a space', 'aB3dE5gH7jK9mN1pQ3 S'],
    ['empty', ''],
  ])('%s: passes the fake first check, is dropped by pagamentoSchema', (_label, linkId) => {
    const { pagamento } = map({ metadata: { link_id: linkId } });
    expect('linkPagamentoId' in pagamento).toBe(false);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });
});

describe('mapper final gate — primeiroNomePagador', () => {
  it('control: a short name passes the permissive extractor AND the gate', () => {
    const { pagamento } = map({ payer: { first_name: 'Maria' } });
    expect(pagamento.primeiroNomePagador).toBe('Maria');
  });

  it('20 chars is the boundary that still passes', () => {
    const vinte = 'M'.repeat(20);
    const { pagamento } = map({ payer: { first_name: vinte } });
    expect(pagamento.primeiroNomePagador).toBe(vinte);
  });

  it.each([
    ['21 chars', 'M'.repeat(21)],
    ['empty', ''],
  ])('%s: passes the fake extractor, is dropped by pagamentoSchema', (_label, nome) => {
    const { pagamento } = map({ payer: { first_name: nome } });
    expect('primeiroNomePagador' in pagamento).toBe(false);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });
});
