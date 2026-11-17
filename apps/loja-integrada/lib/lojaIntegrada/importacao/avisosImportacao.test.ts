/**
 * The product import's three avisos (`avisosImportacao.ts`), through the REAL `escreverAviso` /
 * `resolverAviso` against the fake: Simular touches nothing; the summary aviso is resolved ONLY by
 * a clean `alvo: todos` job, never by a narrower one; an older job cannot reopen a newer job's
 * row; the category rows close when the category is linked or gone, and only this conta's.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALVO_IMPORTACAO_LI,
  type AlvoImportacaoLi,
  MODO_IMPORTACAO_LI,
  MOTIVO_CATEGORIA_SEM_VINCULO_LI,
  STATUS_IMPORTACAO_LI,
  type StatusImportacaoLi,
  TIPO_AVISO,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  chaveDeAviso,
} from '@delfrance/schemas';

import {
  chaveImportacaoComPendenciasLi,
  chaveRevisaoFiscalLi,
  relogioDaImportacaoUs,
} from '../avisos/avisos';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso } from '../testing/fixtures';
import {
  type FimDoJobLi,
  MOTIVO_RESOLUCAO_IMPORTACAO_LI,
  RESULTADO_AVISO_IMPORTACAO_LI,
  avisarCategoriaSemVinculoLi,
  chaveCategoriaSemVinculoLi,
  resolverCategoriasSemVinculoLi,
  sincronizarAvisoDePendenciasLi,
  sincronizarAvisoDeRevisaoFiscalLi,
} from './avisosImportacao';

const CONTA = 'conta-li-avisos-imp';
const OUTRA = 'conta-li-avisos-imp-2';
const deps = { increment, nowMs: AGORA_MS };

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('avisosImportacao.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fim(over: Partial<FimDoJobLi> = {}): FimDoJobLi {
  return {
    jobId: 'job-1',
    integracaoId: CONTA,
    lojaNome: 'Loja',
    modo: MODO_IMPORTACAO_LI.aplicar,
    alvo: ALVO_IMPORTACAO_LI.todos,
    status: STATUS_IMPORTACAO_LI.concluido,
    fimMs: AGORA_MS,
    ...over,
  };
}

const COM_PENDENCIAS = { total: 3, porCodigo: { 'sem-sku': 2, 'vinculo-ambiguo': 1 } };
const LIMPO = { total: 0, porCodigo: {} };

const resumo = (db: FakeDb, conta = CONTA) =>
  db.ler(caminhoAviso(chaveImportacaoComPendenciasLi(conta)));

/* --------------------------------- Simular -------------------------------- */

describe('Simular raises and resolves NOTHING — not even a read', () => {
  it('every function returns simulacao before touching Firestore', async () => {
    const db = new FakeDb();
    const simular = { ...fim(), modo: MODO_IMPORTACAO_LI.simular };
    expect(await sincronizarAvisoDePendenciasLi(asDb(db), simular, COM_PENDENCIAS, deps)).toBe(
      RESULTADO_AVISO_IMPORTACAO_LI.simulacao,
    );
    expect(await sincronizarAvisoDePendenciasLi(asDb(db), simular, LIMPO, deps)).toBe(
      RESULTADO_AVISO_IMPORTACAO_LI.simulacao,
    );
    expect(
      await avisarCategoriaSemVinculoLi(
        asDb(db),
        simular,
        {
          categoriaLiId: 7,
          caminho: [7],
          produtos: 1,
          motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
        },
        deps,
      ),
    ).toBe(RESULTADO_AVISO_IMPORTACAO_LI.simulacao);
    expect(await resolverCategoriasSemVinculoLi(asDb(db), simular, [], deps)).toBe(
      RESULTADO_AVISO_IMPORTACAO_LI.simulacao,
    );
    expect(
      await sincronizarAvisoDeRevisaoFiscalLi(asDb(db), { ...simular, abertos: 4 }, deps),
    ).toBe(RESULTADO_AVISO_IMPORTACAO_LI.simulacao);
    expect(db.escritas).toEqual([]);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
  });
});

/* -------------------------------- the summary ------------------------------ */

describe('sincronizarAvisoDePendenciasLi — the summary aviso', () => {
  it("an actionable pendência ⇒ raised, clocked by the job's end, one count per code", async () => {
    const db = new FakeDb();
    expect(await sincronizarAvisoDePendenciasLi(asDb(db), fim(), COM_PENDENCIAS, deps)).toBe(
      RESULTADO_AVISO_IMPORTACAO_LI.avisado,
    );
    expect(resumo(db)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
      severidade: 'atencao',
      canal: 'lojaIntegrada',
      resolvidoEm: null,
      relogioEvento: relogioDaImportacaoUs(AGORA_MS),
      params: { loja: 'Loja', acionaveis: 3, job: 'job-1', 'sem-sku': 2, 'vinculo-ambiguo': 1 },
    });
  });

  it('an alvo: todos job ending concluido with only informational codes ⇒ RESOLVED', async () => {
    const db = new FakeDb();
    await sincronizarAvisoDePendenciasLi(asDb(db), fim(), COM_PENDENCIAS, deps);
    const depois = fim({ jobId: 'job-2', fimMs: AGORA_MS + 1_000 });
    expect(await sincronizarAvisoDePendenciasLi(asDb(db), depois, LIMPO, deps)).toBe(
      RESULTADO_AVISO_IMPORTACAO_LI.resolvido,
    );
    expect(resumo(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_IMPORTACAO_LI.semPendencias,
      relogioEvento: relogioDaImportacaoUs(AGORA_MS + 1_000),
    });
    expect(resumo(db)?.resolvidoEm).not.toBeNull();
  });

  it.each<[AlvoImportacaoLi, StatusImportacaoLi]>([
    [ALVO_IMPORTACAO_LI.selecionados, STATUS_IMPORTACAO_LI.concluido],
    [ALVO_IMPORTACAO_LI.naoNoErp, STATUS_IMPORTACAO_LI.concluido],
    [ALVO_IMPORTACAO_LI.jaNoErp, STATUS_IMPORTACAO_LI.concluido],
    [ALVO_IMPORTACAO_LI.todos, STATUS_IMPORTACAO_LI.falhou],
    [ALVO_IMPORTACAO_LI.todos, STATUS_IMPORTACAO_LI.cancelado],
  ])('near-miss: a clean %s job ending %s does NOT resolve it', async (alvo, status) => {
    const db = new FakeDb();
    await sincronizarAvisoDePendenciasLi(asDb(db), fim(), COM_PENDENCIAS, deps);
    const depois = fim({ jobId: 'job-2', fimMs: AGORA_MS + 1_000, alvo, status });
    expect(await sincronizarAvisoDePendenciasLi(asDb(db), depois, LIMPO, deps)).toBe(
      RESULTADO_AVISO_IMPORTACAO_LI.mantido,
    );
    expect(resumo(db)?.resolvidoEm).toBeNull();
    expect(db.escritas.filter((e) => e.verbo !== 'create')).toEqual([]);
  });

  it('a later job with actionable codes keeps it open, re-raised with its own counts', async () => {
    const db = new FakeDb();
    await sincronizarAvisoDePendenciasLi(asDb(db), fim(), COM_PENDENCIAS, deps);
    await sincronizarAvisoDePendenciasLi(
      asDb(db),
      fim({ jobId: 'job-2', fimMs: AGORA_MS + 1_000, alvo: ALVO_IMPORTACAO_LI.selecionados }),
      { total: 1, porCodigo: { 'forma-diferente': 1 } },
      deps,
    );
    expect(resumo(db)).toMatchObject({ resolvidoEm: null, ocorrencias: 2 });
    expect(resumo(db)?.params).toEqual({
      loja: 'Loja',
      acionaveis: 1,
      job: 'job-2',
      'forma-diferente': 1,
    });
  });

  it("an OLDER job's raise arriving after a newer job resolved it is dropped", async () => {
    const db = new FakeDb();
    await sincronizarAvisoDePendenciasLi(asDb(db), fim({ fimMs: AGORA_MS + 5_000 }), LIMPO, deps);
    await sincronizarAvisoDePendenciasLi(asDb(db), fim({ fimMs: AGORA_MS }), COM_PENDENCIAS, deps);
    expect(resumo(db)?.resolvidoEm).not.toBeNull();
  });

  it("the row is per conta: another conta's job never touches it", async () => {
    const db = new FakeDb();
    await sincronizarAvisoDePendenciasLi(asDb(db), fim(), COM_PENDENCIAS, deps);
    await sincronizarAvisoDePendenciasLi(
      asDb(db),
      fim({ integracaoId: OUTRA, fimMs: AGORA_MS + 1_000 }),
      LIMPO,
      deps,
    );
    expect(resumo(db)?.resolvidoEm).toBeNull();
  });
});

/* ------------------------------- the categories ---------------------------- */

describe('the category aviso', () => {
  const categoria = (id: number) => ({
    categoriaLiId: id,
    caminho: [1, id],
    produtos: 2,
    motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
  });

  it('its key is (tipo, conta, store category id); the params carry the path as store ids', async () => {
    const db = new FakeDb();
    await avisarCategoriaSemVinculoLi(asDb(db), fim(), categoria(7), deps);
    const chave = chaveCategoriaSemVinculoLi(CONTA, 7);
    expect(chave).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
        conta: CONTA,
        entidade: '7',
      }),
    );
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Loja', caminho: '1 > 7', produtos: 2, motivo: 'sem-vinculo' },
      relogioEvento: relogioDaImportacaoUs(AGORA_MS),
    });
    expect(chaveCategoriaSemVinculoLi(CONTA, 7)).not.toBe(chaveCategoriaSemVinculoLi(CONTA, 70));
  });

  it('a later job closes the rows of linked and GONE categories, keeps the still-unlinked one', async () => {
    const db = new FakeDb();
    for (const id of [7, 8, 9])
      await avisarCategoriaSemVinculoLi(asDb(db), fim(), categoria(id), deps);
    // Another conta's row of the same category id is never this conta's to close.
    await avisarCategoriaSemVinculoLi(
      asDb(db),
      { ...fim(), integracaoId: OUTRA },
      categoria(7),
      deps,
    );

    const r = await resolverCategoriasSemVinculoLi(
      asDb(db),
      fim(),
      [
        { id: 7, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada },
        { id: 8, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo },
        // 9 is gone from the store's list.
      ],
      deps,
    );
    expect(r).toMatchObject({ resolvidos: 2, truncado: false });
    const ler = (conta: string, id: number) =>
      db.ler(caminhoAviso(chaveCategoriaSemVinculoLi(conta, id)));
    expect(ler(CONTA, 7)).toMatchObject({ resolucaoMotivo: 'categoria-vinculada' });
    expect(ler(CONTA, 8)?.resolvidoEm).toBeNull();
    expect(ler(CONTA, 9)).toMatchObject({ resolucaoMotivo: 'categoria-fora-da-loja' });
    expect(ler(OUTRA, 7)?.resolvidoEm).toBeNull();
  });

  it('the resolve is clockless: the same row raised again by a LATER job reopens it', async () => {
    const db = new FakeDb();
    await avisarCategoriaSemVinculoLi(asDb(db), fim(), categoria(7), deps);
    await resolverCategoriasSemVinculoLi(
      asDb(db),
      fim(),
      [{ id: 7, vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.vinculada }],
      deps,
    );
    await avisarCategoriaSemVinculoLi(
      asDb(db),
      fim({ fimMs: AGORA_MS + 1_000 }),
      categoria(7),
      deps,
    );
    expect(db.ler(caminhoAviso(chaveCategoriaSemVinculoLi(CONTA, 7)))?.resolvidoEm).toBeNull();
  });

  it('the read is the open-avisos query on its declared index, nothing else', async () => {
    const db = new FakeDb();
    await resolverCategoriasSemVinculoLi(asDb(db), fim(), [], deps);
    expect(db.consultas).toEqual([
      {
        colecao: 'avisos',
        filtros: [['resolvidoEm', '==', null]],
        ordens: [['criadoEm', 'desc']],
        limite: 200,
        apos: null,
      },
    ]);
  });
});

/* ------------------------------ the tax review ----------------------------- */

describe('sincronizarAvisoDeRevisaoFiscalLi', () => {
  const revisao = (abertos: number, fimMs = AGORA_MS) => ({ ...fim({ fimMs }), abertos });
  const ler = (db: FakeDb) => db.ler(caminhoAviso(chaveRevisaoFiscalLi(CONTA)));

  it('entries on the list ⇒ raised with the open count and the newest job', async () => {
    const db = new FakeDb();
    expect(await sincronizarAvisoDeRevisaoFiscalLi(asDb(db), revisao(4), deps)).toBe('avisado');
    expect(ler(db)).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Loja', abertos: 4, job: 'job-1' },
    });
  });

  it('an empty list ⇒ resolved; near-miss: one entry left keeps it open', async () => {
    const db = new FakeDb();
    await sincronizarAvisoDeRevisaoFiscalLi(asDb(db), revisao(4), deps);
    await sincronizarAvisoDeRevisaoFiscalLi(asDb(db), revisao(1, AGORA_MS + 1), deps);
    expect(ler(db)?.resolvidoEm).toBeNull();
    expect(await sincronizarAvisoDeRevisaoFiscalLi(asDb(db), revisao(0, AGORA_MS + 2), deps)).toBe(
      'resolvido',
    );
    expect(ler(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_IMPORTACAO_LI.revisaoConcluida,
    });
  });
});
