/**
 * The monthly link audit (#1200) against a REAL Firestore (the emulator lane).
 *
 * `auditoriaNaoEnumerados.test.ts` pins every decision through injected seams and
 * a FakeDb that agrees with its author by construction. What only a real
 * Firestore can show is that the pieces the audit is BUILT from behave the way
 * those decisions assume:
 *
 *  - the shared walk pages a real COLLECTION GROUP across real keyset cursors
 *    (`pageLimit: 2`, so every test crosses several pages) and drains;
 *  - the tier-1 heal really adds the conta inside a real transaction, KEEPING the
 *    array's other entries — and really refuses when the only link closed after
 *    the walk read it;
 *  - `escreverAviso` really creates the row and `resolverAviso` really resolves it;
 *  - the avisos KEY RANGE is half-open on real document ids: a row whose id is
 *    exactly the range end (`<tipo>:<conta>;`) is not this conta's, and a conta
 *    whose id merely STARTS with this one's (`X` vs `X2`) is never touched;
 *  - the pre-resolve re-read sees a link created after the walk drained;
 *  - the key range really projects `canal`, so the inactive-conta pass closes an
 *    ML row and leaves another channel's row of the same tipo open.
 *
 * Every query on this path is CLASSIC (the walk, the re-read, the key range), so
 * all of it runs in the emulator — no pipeline anywhere.
 *
 * ⚠️ The conta enumeration is COLLECTION-WIDE (`tipo` + `ativo`), so a fresh
 * random id buys no isolation there: `beforeEach` purges `integracao` (the
 * `notificacao.firestore.test.ts` precedent) and this tipo's avisos (the
 * inactive-conta pass reads the whole tipo). ⚠️ `db` comes from the production
 * accessor, and every test carries a POSITIVE existence assertion — in the
 * emulator a mis-targeted database silently auto-creates, so "not found"
 * assertions alone would pass against the wrong one.
 */
import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escreverAviso } from '@delfrance/data/admin/avisos';
import {
  avisoCollection,
  integracaoCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  CANAL_AVISO,
  INTEGRACAO_TIPO,
  SEVERIDADE_AVISO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { contaRefForms } from '../anuncios/integracoesComProduto';
import {
  type FetchLinksNaoEnumeradosPage,
  fetchLinksNaoEnumeradosPage,
} from '../anuncios/linksNaoEnumerados';
import { STOCK_SYNC_FLAG_ENV } from './bulkEstoquePlan';
import {
  RESOLUCAO_AUDITORIA,
  chaveDoAviso,
  listarAvisosDaConta,
  planoDoAviso,
  runAuditoriaNaoEnumerados,
} from './auditoriaNaoEnumerados';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const TIPO = TIPO_AVISO.anuncioForaDaSincronizacao;

function db(): Firestore {
  return getAdminFirestore();
}

async function purge(): Promise<void> {
  const contas = await integracaoCollection.ref(db(), {}).listDocuments();
  await Promise.all(contas.map((r) => r.delete()));
  const avisos = await avisoCollection.ref(db(), {}).listDocuments();
  await Promise.all(avisos.filter((r) => r.id.startsWith(TIPO)).map((r) => r.delete()));
}

async function conta(id: string): Promise<void> {
  await integracaoCollection
    .docRef(db(), {}, id)
    .set({ tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true, nome: id });
}

async function produto(id: string, data: { paiId: string | null; contas: string[] }) {
  await produtoCollection
    .docRef(db(), {}, id)
    .set({ nome: id, paiId: data.paiId, integracoesComProduto: data.contas });
}

/** A link on `produtoId`, using ref form `forma` (0 = `documents/…`, 1 = bare). */
async function link(
  produtoId: string,
  linkId: string,
  data: { conta: string; itemId: string; estado: string; forma?: 0 | 1 },
): Promise<void> {
  await produtoMercadoLivreLinkCollection.docRef(db(), { produtoId }, linkId).set({
    id: data.itemId,
    estado: data.estado,
    contaOuterRef: contaRefForms(data.conta)[data.forma ?? 0],
  });
}

/** An open row exactly as the audit itself would have raised it last month. */
async function avisoAberto(
  integracaoId: string,
  produtoId: string,
  itemIds: string[],
): Promise<void> {
  await escreverAviso(
    db(),
    planoDoAviso(
      integracaoId,
      produtoId,
      SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
      new Set(itemIds),
    ),
    { increment: (by) => FieldValue.increment(by), agoraUs: 1_000_000 },
  );
}

async function lerAviso(chave: string) {
  const snap = await avisoCollection.docRef(db(), {}, chave).get();
  return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
}

async function lerContas(produtoId: string): Promise<unknown> {
  const snap = await produtoCollection.docRef(db(), {}, produtoId).get();
  return (snap.data() as Record<string, unknown> | undefined)?.integracoesComProduto;
}

/** The real walk, plus a hook that runs once, right after conta `alvo` drains. */
function walkComGancho(alvo: string, gancho: () => Promise<void>): FetchLinksNaoEnumeradosPage {
  let disparado = false;
  return async (firestore, args) => {
    const page = await fetchLinksNaoEnumeradosPage(firestore, args);
    if (args.integracaoId === alvo && page.nextAfterLinkPath == null && !disparado) {
      disparado = true;
      await gancho();
    }
    return page;
  };
}

beforeEach(async () => {
  process.env[STOCK_SYNC_FLAG_ENV] = '1';
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  if (EMULATED) await purge();
});

afterEach(() => {
  delete process.env[STOCK_SYNC_FLAG_ENV];
  vi.restoreAllMocks();
});

describe.skipIf(!EMULATED)('the monthly link audit (Firestore emulator)', () => {
  it('⭐ walks real pages, heals class 2 keeping the array, raises, resolves — and touches nothing outside the range', async () => {
    const u = randomUUID().replace(/-/g, '');
    const X = `aud${u}`;
    // Shares X's whole id as a PREFIX: `<tipo>:X2:…` sorts inside `[<tipo>:X, <tipo>:X;)`
    // and only the `:` in the range START keeps it out of X's rows.
    const X2 = `${X}2`;
    await conta(X);
    await conta(X2);
    const p = (s: string) => `p${u}${s}`;

    // Class 2: an anchor carrying ANOTHER conta but not X → healed, entry kept.
    await produto(p('A'), { paiId: null, contas: ['outra-conta'] });
    await link(p('A'), 'l1', { conta: X, itemId: 'MLB-A', estado: 'a', forma: 0 });
    await link(p('A'), 'l2', { conta: X, itemId: 'MLB-A-velho', estado: 'c', forma: 1 });
    // Class 3: a live link on a variation child → a NEW aviso.
    await produto(p('B'), { paiId: `pai${u}`, contas: [] });
    await link(p('B'), 'l1', { conta: X, itemId: 'MLB-B', estado: 'a', forma: 1 });
    // Closed history on a child: the noise guard, never a finding.
    await produto(p('C'), { paiId: `pai${u}`, contas: [] });
    await link(p('C'), 'l1', { conta: X, itemId: 'MLB-C', estado: 'c' });
    // Open last month, fixed since: resolved.
    await avisoAberto(X, p('D'), ['MLB-D']);
    // Open last month, its child link created AFTER this walk drained (below):
    // the re-read sees it, so it must stay open.
    await produto(p('E'), { paiId: `pai${u}`, contas: [] });
    await avisoAberto(X, p('E'), ['MLB-E']);
    // A row whose id is EXACTLY X's range end — not one of X's rows.
    const fimDaFaixa = `${chaveDeAviso({ tipo: TIPO, conta: X })};`;
    await avisoCollection.docRef(db(), {}, fimDaFaixa).set(
      avisoCollection.parse({
        tipo: TIPO,
        severidade: SEVERIDADE_AVISO.atencao,
        criadoEm: 1_000_000,
        atualizadoEm: 1_000_000,
      }),
    );
    // X2's own still-current finding and its row, raised last month.
    await produto(p('G'), { paiId: `pai${u}`, contas: [] });
    await link(p('G'), 'l1', { conta: X2, itemId: 'MLB-G', estado: 'a' });
    await avisoAberto(X2, p('G'), ['MLB-G']);
    const x2Antes = await lerAviso(chaveDoAviso(X2, p('G')));

    const result = await runAuditoriaNaoEnumerados(db(), {
      agora: () => Date.now(),
      pageLimit: 2,
      fetchPage: walkComGancho(X, () =>
        link(p('E'), 'l1', { conta: X, itemId: 'MLB-E', estado: 'a' }),
      ),
    });

    expect(result.enabled).toBe(true);
    const rx = result.contas.find((c) => c.integracaoId === X)!;
    // 4 links of X at pageLimit 2: two FULL pages, then an empty one that drains.
    expect(rx).toMatchObject({
      truncada: null,
      error: null,
      paginas: 3,
      linksLidos: 4,
      curados: 1,
      curasSemEfeito: 0,
      resolvidos: 1,
      mantidos: 1,
      avisos: { criado: 1, repetido: 0, reaberto: 0, ignorado: 0 },
    });

    // The heal: X added, the other conta's entry kept.
    expect(await lerContas(p('A'))).toEqual(['outra-conta', X]);

    // The new aviso, created for real.
    const b = await lerAviso(chaveDoAviso(X, p('B')));
    expect(b.exists).toBe(true);
    expect(b.data).toMatchObject({
      tipo: TIPO,
      severidade: 'atencao',
      canal: 'mercadoLivre',
      params: { situacao: 'link-em-variacao', anuncio: 'MLB-B', anuncios: 1 },
      motivo: 'link-em-variacao',
      urlInterna: { rota: `/produtos/${p('B')}` },
      resolvidoEm: null,
      ocorrencias: 1,
    });
    expect(b.data!.relogioEvento).toBeNull();
    // No aviso for the healed produto, nor for closed history.
    expect((await lerAviso(chaveDoAviso(X, p('A')))).exists).toBe(false);
    expect((await lerAviso(chaveDoAviso(X, p('C')))).exists).toBe(false);

    // Resolved for real, with the producer's motivo.
    const d = await lerAviso(chaveDoAviso(X, p('D')));
    expect(d.data).toMatchObject({ resolucaoMotivo: RESOLUCAO_AUDITORIA.naoEncontrado });
    expect(typeof d.data!.resolvidoEm).toBe('number');
    // Re-read found the late link: still open.
    expect((await lerAviso(chaveDoAviso(X, p('E')))).data).toMatchObject({ resolvidoEm: null });
    // The range end and the prefix-sharing conta: byte-for-byte untouched.
    expect((await lerAviso(fimDaFaixa)).data).toMatchObject({ resolvidoEm: null, ocorrencias: 1 });
    expect(await lerAviso(chaveDoAviso(X2, p('G')))).toEqual(x2Antes);
    expect(result.inativasResolvidas).toBe(0);
  });

  it('the key range on real ids: one conta’s rows, never the range end, the bare key or `X2`', async () => {
    const u = randomUUID().replace(/-/g, '');
    const X = `aud${u}`;
    await avisoAberto(X, 'p1', ['MLB1']);
    await avisoAberto(X, 'p2', ['MLB2']);
    await avisoAberto(`${X}2`, 'p3', ['MLB3']);
    await avisoAberto(`${X}0`, 'p4', ['MLB4']);
    const prefixo = chaveDeAviso({ tipo: TIPO, conta: X });
    for (const id of [prefixo, `${prefixo};`]) {
      await avisoCollection.docRef(db(), {}, id).set(
        avisoCollection.parse({
          tipo: TIPO,
          severidade: SEVERIDADE_AVISO.atencao,
          criadoEm: 1,
          atualizadoEm: 1,
        }),
      );
    }

    const linhas = await listarAvisosDaConta(db(), X);

    expect(linhas.map((l) => l.chave)).toEqual([chaveDoAviso(X, 'p1'), chaveDoAviso(X, 'p2')]);
    expect(linhas.every((l) => l.aberto)).toBe(true);
    expect(linhas[0]!.params).toEqual({
      situacao: 'link-em-variacao',
      anuncio: 'MLB1',
      anuncios: 1,
    });
  });

  it('the tier-1 guard on a real transaction: a link closed after the walk read it is NOT healed', async () => {
    const u = randomUUID().replace(/-/g, '');
    const X = `aud${u}`;
    await conta(X);
    const pA = `p${u}A`;
    await produto(pA, { paiId: null, contas: ['outra-conta'] });
    await link(pA, 'l1', { conta: X, itemId: 'MLB-A', estado: 'a' });

    const result = await runAuditoriaNaoEnumerados(db(), {
      agora: () => Date.now(),
      pageLimit: 2,
      // The listing closes between the walk's read and the heal.
      fetchPage: walkComGancho(X, () => link(pA, 'l1', { conta: X, itemId: 'MLB-A', estado: 'c' })),
    });

    expect(result.contas.find((c) => c.integracaoId === X)).toMatchObject({
      curados: 0,
      curasSemEfeito: 1,
    });
    expect(await lerContas(pA)).toEqual(['outra-conta']);
  });

  it('closes the rows of a conta that is no longer an active integração — never another channel’s', async () => {
    const u = randomUUID().replace(/-/g, '');
    const ativa = `aud${u}`;
    const inativa = `aud${u}off`;
    const lojaShopee = `aud${u}shp`;
    await conta(ativa);
    await integracaoCollection
      .docRef(db(), {}, inativa)
      .set({ tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false, nome: inativa });
    await avisoAberto(inativa, 'p1', ['MLB1']);
    // The same channel-neutral tipo raised by ANOTHER channel: its conta is never
    // an ML integração, and only the stored `canal` — projected by the real key
    // range — keeps this pass off it.
    await escreverAviso(
      db(),
      {
        ...planoDoAviso(
          lojaShopee,
          'p2',
          SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
          new Set(['SHP1']),
        ),
        canal: CANAL_AVISO.shopee,
      },
      { increment: (by) => FieldValue.increment(by), agoraUs: 1_000_000 },
    );

    const result = await runAuditoriaNaoEnumerados(db(), { agora: () => Date.now(), pageLimit: 2 });

    expect(result.inativasResolvidas).toBe(1);
    const row = await lerAviso(chaveDoAviso(inativa, 'p1'));
    expect(row.exists).toBe(true);
    expect(row.data).toMatchObject({ resolucaoMotivo: RESOLUCAO_AUDITORIA.contaInativa });
    const outroCanal = await lerAviso(chaveDoAviso(lojaShopee, 'p2'));
    expect(outroCanal.exists).toBe(true);
    expect(outroCanal.data).toMatchObject({ canal: 'shopee', resolvidoEm: null });
  });
});
