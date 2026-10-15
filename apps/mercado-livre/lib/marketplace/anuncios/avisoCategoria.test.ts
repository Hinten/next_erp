import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { CANAL_AVISO, SEVERIDADE_AVISO, TIPO_AVISO, chaveDeAviso } from '@delfrance/schemas';

// The shared writer has its own suite (`escreverAviso.test.ts`, create/repeat/
// reopen/precondition). What THIS module owns is the plano it hands over — the
// key, the params and what it deliberately leaves out — so that is the seam.
const avisos = vi.hoisted(() => ({
  // Typed with their real arity so `mock.calls[0]` destructures without casts.
  escreverAviso: vi.fn(async (_db: unknown, _plano: unknown, _deps: unknown) => ({
    chave: 'k',
    resultado: 'criado' as const,
  })),
  resolverAviso: vi.fn(
    async (_db: unknown, _chave: string, _motivo: string, _deps: unknown, _opts?: unknown) => true,
  ),
}));
vi.mock('@delfrance/data/admin/avisos', () => avisos);

const {
  MOTIVO_RESOLUCAO_CATEGORIA,
  MOTIVOS_SEM_REVISAO,
  avisarCategoriaAlterada,
  chaveAnuncioCategoriaAlterada,
  registrarMesmaComissao,
  resolverAvisoCategoria,
} = await import('./avisoCategoria');

const db = { __fake: 'db' } as unknown as Firestore;
const ALVO = { integracaoId: 'conta-A', produtoId: 'prod-1', linkDocId: 'link-1' };
const NOW_MS = 1_760_000_000_000;
const deps = { increment: (by: number) => ({ __inc: by }), nowMs: NOW_MS };

/** The producer's plano — the SAME literal `apps/web/lib/avisos/mensagens.test.ts` renders. */
const EVENTO = {
  ...ALVO,
  anuncio: 'MLB4567',
  categoriaErpId: 'MLB1',
  categoriaErpNome: 'Roupas > Camisetas',
  categoriaMlId: 'MLB2',
  categoriaMlNome: 'Roupas > Camisetas e Regatas',
  comissoes: { erpPct: 16, mlPct: 11.5 },
};

beforeEach(() => vi.clearAllMocks());

describe('chaveAnuncioCategoriaAlterada — one row per LISTING LINK', () => {
  it('is the shared key builder over (tipo, conta, produto, link)', () => {
    expect(chaveAnuncioCategoriaAlterada(ALVO)).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.anuncioCategoriaAlterada,
        conta: 'conta-A',
        entidade: 'prod-1',
        janela: 'link-1',
      }),
    );
  });

  it('must stay DISTINCT: two listings of one produto on one conta are two rows', () => {
    expect(chaveAnuncioCategoriaAlterada(ALVO)).not.toBe(
      chaveAnuncioCategoriaAlterada({ ...ALVO, linkDocId: 'link-2' }),
    );
  });

  it('must stay DISTINCT: the link id cannot bleed across the produto boundary', () => {
    // Concatenated into one segment, `a_b` + `c` and `a` + `b_c` would collide
    // after the segment fold; separate segments keep them apart.
    expect(
      chaveAnuncioCategoriaAlterada({ integracaoId: 'c', produtoId: 'a_b', linkDocId: 'x' }),
    ).not.toBe(
      chaveAnuncioCategoriaAlterada({ integracaoId: 'c', produtoId: 'a', linkDocId: 'b_x' }),
    );
  });
});

describe('avisarCategoriaAlterada — the plano', () => {
  it('writes exactly the documented shape, converting now to µs at the seam', async () => {
    await avisarCategoriaAlterada(db, EVENTO, deps);

    expect(avisos.escreverAviso).toHaveBeenCalledTimes(1);
    const [onde, plano, escrita] = avisos.escreverAviso.mock.calls[0]!;
    expect(onde).toBe(db);
    expect(plano).toEqual({
      tipo: TIPO_AVISO.anuncioCategoriaAlterada,
      conta: 'conta-A',
      entidade: 'prod-1',
      janela: 'link-1',
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.mercadoLivre,
      params: {
        anuncio: 'MLB4567',
        categoriaErpId: 'MLB1',
        categoriaMlId: 'MLB2',
        categoriaErpNome: 'Roupas > Camisetas',
        categoriaMlNome: 'Roupas > Camisetas e Regatas',
        comissaoCategoriaErpPct: 16,
        comissaoCategoriaMlPct: 11.5,
      },
      urlInterna: { rota: '/produtos/prod-1', campo: null },
    });
    // ⚠️ No event clock: ML sends none for a recategorization, and passing one
    // anyway would arm a watermark nothing could ever advance correctly.
    expect(plano).not.toHaveProperty('relogioEvento');
    expect(escrita).toMatchObject({ agoraUs: NOW_MS * 1000 });
  });

  it('ids only: absent names and fees are OMITTED, never written as null/undefined', async () => {
    await avisarCategoriaAlterada(
      db,
      { ...EVENTO, categoriaErpNome: null, categoriaMlNome: null, comissoes: null },
      deps,
    );

    const [, plano] = avisos.escreverAviso.mock.calls[0]!;
    expect((plano as { params: object }).params).toEqual({
      anuncio: 'MLB4567',
      categoriaErpId: 'MLB1',
      categoriaMlId: 'MLB2',
    });
  });
});

describe('registrarMesmaComissao — recorded closed, never forgotten (#1843 review)', () => {
  it('seeds/closes the SAME row with the full plano, so the next move can read what it tracked', async () => {
    const mesmas = { ...EVENTO, comissoes: { erpPct: 16, mlPct: 16 } };
    await registrarMesmaComissao(db, mesmas, { nowMs: NOW_MS });

    expect(avisos.escreverAviso).not.toHaveBeenCalled();
    const [onde, chave, motivo, escrita, opts] = avisos.resolverAviso.mock.calls[0]!;
    expect(onde).toBe(db);
    expect(chave).toBe(chaveAnuncioCategoriaAlterada(ALVO));
    expect(motivo).toBe('mesma-comissao');
    expect(escrita).toEqual({ agoraUs: NOW_MS * 1000 });
    // The shared resolver seeds a MISSING row only with metadata AND a clock.
    // The clock is our own observation time (ms); `params.categoriaErpId` is
    // the memory the next move reads.
    expect(opts).toMatchObject({
      relogioEvento: NOW_MS,
      params: expect.objectContaining({
        categoriaErpId: 'MLB1',
        comissaoCategoriaErpPct: 16,
        comissaoCategoriaMlPct: 16,
      }),
    });
    // `resolverAviso` refuses metadata whose dedup key differs from `chave`.
    expect(chaveDeAviso(opts as Parameters<typeof chaveDeAviso>[0])).toBe(chave);
  });

  it('only the closes that involved NO review keep tracking', () => {
    expect([...MOTIVOS_SEM_REVISAO].sort()).toEqual([
      'anuncio-desvinculado',
      'anuncio-encerrado',
      'mesma-comissao',
    ]);
  });
});

describe('resolverAvisoCategoria', () => {
  it('resolves the SAME key the producer wrote, with the motivo and µs now', async () => {
    await resolverAvisoCategoria(db, ALVO, MOTIVO_RESOLUCAO_CATEGORIA.alinhada, { nowMs: NOW_MS });

    expect(avisos.resolverAviso).toHaveBeenCalledWith(
      db,
      chaveAnuncioCategoriaAlterada(ALVO),
      'categoria-erp-alinhada',
      { agoraUs: NOW_MS * 1000 },
    );
  });

  it('the persisted motivos are stable strings', () => {
    expect(MOTIVO_RESOLUCAO_CATEGORIA).toEqual({
      alinhada: 'categoria-erp-alinhada',
      erpAlterada: 'categoria-erp-alterada',
      mesmaComissao: 'mesma-comissao',
      encerrado: 'anuncio-encerrado',
      desvinculado: 'anuncio-desvinculado',
    });
  });
});
