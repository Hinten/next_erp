/**
 * The product import's detail reads (`detalhes.ts`) on the fake Firestore, through the REAL context
 * loader, client and produto detail read.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file, and
 * the context's client calls a scripted store (`testing/produtosLi.ts`) whose every request is
 * recorded — the call counts below are exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { LiThrottleError } from '@delfrance/integrations-loja-integrada';
import { MAX_DESCRICAO_LI, detalheProdutoLiSchema } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { type ChamadaCatalogoLi, type RespostaCatalogoLi, ok } from '../testing/catalogoLi';
import { FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, gravadorDeLog, seedConta, seedCredencial } from '../testing/fixtures';
import { caminhoJobLi } from '../testing/importacaoLi';
import {
  contextoDeTesteLi,
  detalheLi,
  filhoLi,
  paiLi,
  respostasDaLojaLi,
} from '../testing/produtosLi';
import {
  type DetalhesDeps,
  detalheLidoLi,
  lerDetalheParaOJobLi,
  lerDetalhesGravadosLi,
} from './detalhes';

const CONTA = 'conta-li-detalhes';
const JOB = 'job-detalhes';

let db: FakeDb;
let fetchGlobal: ReturnType<typeof vi.fn>;
let gravador: ReturnType<typeof gravadorDeLog>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  fetchGlobal = vi.fn(() => {
    throw new Error('detalhes.test: só o fetch roteirizado do contexto pode ser chamado');
  });
  vi.stubGlobal('fetch', fetchGlobal);
  db = new FakeDb();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  gravador = gravadorDeLog();
});
afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

async function deps(
  responder: (c: ChamadaCatalogoLi) => RespostaCatalogoLi,
): Promise<{ d: DetalhesDeps; chamadas: ChamadaCatalogoLi[] }> {
  const { contexto, chamadas } = await contextoDeTesteLi(
    asDb(db),
    CONTA,
    responder,
    gravador.escrever,
  );
  return {
    d: { db: asDb(db), cliente: contexto.cliente, jobId: JOB, agoraMs: () => AGORA_MS },
    chamadas,
  };
}

const caminhoDetalhe = (id: number): string => `${caminhoJobLi(JOB)}/detalhes/${String(id)}`;

describe('one detail read', () => {
  it('GETs the plain detail path (no query) and stores the detail VIEW — never a price, a stock flag or the store URL', async () => {
    const corpo = detalheLi(filhoLi(11), 10, { descricao_completa: '<p>curta</p>' });
    const { d, chamadas } = await deps(
      respostasDaLojaLi({ ativos: [], detalhes: new Map([[11, corpo]]) }),
    );
    const resultado = await lerDetalheParaOJobLi(d, 11);

    expect(chamadas).toEqual([{ caminho: '/v1/produto/11/', query: [] }]);
    expect(resultado.tipo).toBe('lido');
    const gravado = detalheProdutoLiSchema.parse(db.ler(caminhoDetalhe(11)));
    expect(gravado).toMatchObject({ liId: 11, estado: 'lido', lidoEmMs: AGORA_MS });
    expect(gravado.detalhe).toMatchObject({
      id: 11,
      tipo: 'atributo_opcao',
      paiId: 10,
      pesoKg: 0.2,
      alturaCm: 10,
      descricao: '<p>curta</p>',
      descricaoLonga: false,
    });
    const texto = JSON.stringify(db.ler(caminhoDetalhe(11)));
    for (const proibido of ['preco', 'estoque', 'loja.invalid', 'seo']) {
      expect(texto).not.toContain(proibido);
    }
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.sobrescrita])).toEqual([
      ['set', caminhoDetalhe(11), true],
    ]);
  });

  it('a 50 KB description is stored as its LENGTH only, and the document stays small', async () => {
    const longa = `<p>${'x'.repeat(50_000)}</p>`;
    const corpo = detalheLi(paiLi(10, [11]), null, { descricao_completa: longa });
    const { d } = await deps(respostasDaLojaLi({ ativos: [], detalhes: new Map([[10, corpo]]) }));
    await lerDetalheParaOJobLi(d, 10);

    const gravado = detalheProdutoLiSchema.parse(db.ler(caminhoDetalhe(10)));
    expect(gravado.detalhe).toMatchObject({
      descricao: null,
      descricaoLonga: true,
      descricaoTamanho: longa.length,
    });
    expect(longa.length).toBeGreaterThan(MAX_DESCRICAO_LI);
    expect(JSON.stringify(db.ler(caminhoDetalhe(10))).length).toBeLessThan(2_000);
  });

  it('a 404 is `inexistente`: stored with no detail, so the decision is kept', async () => {
    const { d } = await deps(respostasDaLojaLi({ ativos: [] }));
    expect(await lerDetalheParaOJobLi(d, 77)).toEqual({ tipo: 'inexistente' });
    expect(detalheProdutoLiSchema.parse(db.ler(caminhoDetalhe(77)))).toEqual({
      liId: 77,
      estado: 'inexistente',
      detalhe: null,
      lidoEmMs: AGORA_MS,
    });
  });

  it('⚠️ an answer for ANOTHER product is `divergente`, and NOTHING is stored', async () => {
    const { d } = await deps(() => ok(detalheLi(filhoLi(12), 10)));
    const resultado = await lerDetalheParaOJobLi(d, 11);
    expect(resultado.tipo).toBe('divergente');
    expect(db.ler(caminhoDetalhe(11))).toBeUndefined();
    expect(db.escritas).toEqual([]);
  });

  it('every other failure propagates unchanged, and nothing is stored', async () => {
    const { d } = await deps(() => ({ status: 429, corpo: {} }));
    await expect(lerDetalheParaOJobLi(d, 11)).rejects.toBeInstanceOf(LiThrottleError);
    expect(db.escritas).toEqual([]);
  });

  it('a trashed product’s detail is stored as read: what removido means is the caller’s call', async () => {
    const corpo = detalheLi(filhoLi(11, { removido: true }), 10);
    const { d } = await deps(respostasDaLojaLi({ ativos: [], detalhes: new Map([[11, corpo]]) }));
    const resultado = await lerDetalheParaOJobLi(d, 11);
    expect(resultado.tipo === 'lido' && resultado.detalhe.removido).toBe(true);
  });
});

describe('the stored details, read back', () => {
  it('reads each asked id BY ID — never a query — and leaves an id with no document out', async () => {
    const corpo = detalheLi(filhoLi(11), 10);
    const { d } = await deps(respostasDaLojaLi({ ativos: [], detalhes: new Map([[11, corpo]]) }));
    await lerDetalheParaOJobLi(d, 11);
    await lerDetalheParaOJobLi(d, 12);
    const consultasAntes = db.consultas.length;

    const detalhes = await lerDetalhesGravadosLi(asDb(db), JOB, [11, 12, 13, 11]);
    expect([...detalhes.keys()]).toEqual([11, 12]);
    expect(db.consultas).toHaveLength(consultasAntes);
    expect(db.leituras.filter((p) => p.includes('/detalhes/'))).toEqual([
      caminhoDetalhe(11),
      caminhoDetalhe(12),
      caminhoDetalhe(13),
    ]);
    expect(detalheLidoLi(detalhes, 11)?.paiId).toBe(10);
    // A 404 and an absent document both carry no detail view.
    expect(detalheLidoLi(detalhes, 12)).toBeNull();
    expect(detalheLidoLi(detalhes, 13)).toBeNull();
  });
});
