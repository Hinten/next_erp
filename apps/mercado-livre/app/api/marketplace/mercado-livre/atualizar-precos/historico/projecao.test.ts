/**
 * The query-level projection and the response must agree, and the projected key
 * set must survive `envioPrecoMercadoLivreSchema`.
 *
 * Why this is its own file: `.select()` moves a mistake from "extra bytes" to
 * "wrong data". Drop a field with no schema default and EVERY parse throws;
 * drop one that has a default and the route answers that default forever —
 * `naoEnumerados: 0` on a job that found twelve, with nothing failing anywhere.
 * The reviewer who suggested `.select()` checked this by hand; this is that
 * check made permanent.
 */
import { describe, expect, it } from 'vitest';
import { envioPrecoMercadoLivreSchema } from '@delfrance/schemas';

import { CAMPOS_PROJETADOS } from './route';

/** A stored job reduced to exactly what `.select()` returns. */
const DOC_PROJETADO: Record<string, unknown> = {
  integracaoId: 'int-1',
  status: 'completed',
  baixarPreco: true,
  planejados: 40,
  enviados: 12,
  pulados: 20,
  naoEnumerados: 3,
  falhas: 1,
  pausas: 2,
  skips: [{ itemId: 'MLB9', produtoId: 'p1', code: 'PRECO_ANTIGO_IGUAL' }],
  failures: [{ itemId: 'MLB8', produtoId: 'p2', code: 'UPDATE_PRECO_ERROR', error: 'boom' }],
  startedAt: 1000,
  updatedAt: 2000,
  finishedAt: 3000,
  erro: null,
};

describe('the historico projection', () => {
  it('parses a document carrying ONLY the projected fields', () => {
    // The four fields with no default (`integracaoId`, `status`, `startedAt`,
    // `updatedAt`) must all be in the projection, or this throws.
    const parsed = envioPrecoMercadoLivreSchema.parse(DOC_PROJETADO);

    expect(parsed.integracaoId).toBe('int-1');
    expect(parsed.naoEnumerados).toBe(3);
    // Everything unprojected fills from its default rather than failing.
    expect(parsed.fila).toEqual([]);
    expect(parsed.afterAnchorId).toBeNull();
    expect(parsed.startedBy).toBeNull();
  });

  it('⚠️ the fixture is not simply schema-shaped — a missing REQUIRED field throws', () => {
    // The control. Without it, a projection that dropped `startedAt` would look
    // fine here because the case above would still be testing a full document.
    const { startedAt: _drop, ...semStartedAt } = DOC_PROJETADO;

    expect(() => envioPrecoMercadoLivreSchema.parse(semStartedAt)).toThrow();
  });

  it('projects exactly the fields the response body reads', () => {
    // The two lists are the same contract in two places. A field added to the
    // response but not to the projection reads as its schema DEFAULT — silently
    // correct-looking, which is the whole hazard of `.select()`.
    expect([...CAMPOS_PROJETADOS].sort()).toEqual(Object.keys(DOC_PROJETADO).sort());
  });

  it('names every field the schema has no default for', () => {
    const semDefault = ['integracaoId', 'status', 'startedAt', 'updatedAt'];

    for (const campo of semDefault) {
      expect(CAMPOS_PROJETADOS).toContain(campo);
    }
  });
});
