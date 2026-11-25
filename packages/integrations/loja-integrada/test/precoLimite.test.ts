import type * as Schemas from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { criarClienteLeituraLi } from '../src/client';
import { LiConfigError } from '../src/errors';
import { lerPrecosPorIdLi, MAX_IDS_SET_PRECO_LI } from '../src/preco';
import { json, mockFetch, requisicao, TOKEN, verificarSoGet } from './_helpers/mockFetch';

/**
 * The by-id read reads its bound from `@delfrance/schemas`' binding, never from
 * a copy: with the schemas module's `MAX_IDS_SET_PRECO_LI` replaced by 3 for
 * this file alone (`vi.mock` is file-scoped), the reader sends 3 ids and
 * refuses 4. A local `100` in `preco.ts` would send the 4.
 */
vi.mock('@delfrance/schemas', async (original) => ({
  ...(await original<typeof Schemas>()),
  MAX_IDS_SET_PRECO_LI: 3,
}));

const fetchGlobal = vi.fn(() => {
  throw new Error('fetch global chamado num teste do limite do preço');
});

beforeEach(() => {
  fetchGlobal.mockClear();
  vi.stubGlobal('fetch', fetchGlobal);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchGlobal).not.toHaveBeenCalled();
  verificarSoGet();
});

function linha(produtoId: number) {
  return {
    cheio: '160.0000',
    custo: null,
    id: produtoId + 6000,
    produto: `/api/v1/produto/${String(produtoId)}`,
    promocional: null,
    resource_uri: `/api/v1/produto_preco/${String(produtoId)}`,
    sob_consulta: false,
  };
}

function cliente(fetch: typeof globalThis.fetch) {
  return criarClienteLeituraLi({
    obterCredencial: () => ({ token: TOKEN, ref: 'ref-A' }),
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 0,
  });
}

describe('the bound is the schemas binding', () => {
  it('the re-export IS the mocked binding', () => {
    expect(MAX_IDS_SET_PRECO_LI).toBe(3);
  });

  it('3 ids are sent', async () => {
    const f = mockFetch(() => json({ objects: [linha(1001), linha(1002), linha(1003)] }));
    const r = await lerPrecosPorIdLi(cliente(f), [1001, 1002, 1003]);
    expect(requisicao(f).url.pathname).toBe('/v1/produto_preco/set/1001;1002;1003');
    expect(r.dados.contabilizados).toBe(3);
  });

  it('4 ids are refused with "ids", nothing fetched', async () => {
    const f = mockFetch(() => json({ objects: [] }));
    await expect(lerPrecosPorIdLi(cliente(f), [1001, 1002, 1003, 1004])).rejects.toSatisfy(
      (e: unknown) => e instanceof LiConfigError && e.motivo === 'ids',
    );
    expect(f).not.toHaveBeenCalled();
  });
});
