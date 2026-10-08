/**
 * `reavaliarAvisoDeReceitaKit` (`@delfrance/data/admin/avisos`, passo 19, #1527)
 * dirigido pela função REAL sobre o `FakeDb` deste app (S3F-08).
 *
 * Mora aqui, e não em `packages/data`, porque é aqui que existe um double com
 * consulta, transação e `updateTime` por documento: o fake de
 * `escreverAviso.test.ts` não tem nenhum dos três, e `packages/data` não pode
 * importar `apps/shopee`. A suíte da Shopee roda em toda mudança de
 * `packages/data` (`--roots @delfrance/shopee-app`).
 *
 * As linhas `variashopee` são semeadas pelo construtor de schemas
 * `linhaVariacaoDeKit` — o MESMO que os braços de kit usam para escrevê-las —
 * para que o formato lido aqui seja o formato escrito lá.
 *
 * O relógio: o `FakeDb` carimba cada escrita com `seq` crescente, e
 * `CarimboFake` expõe `seconds = seq` e `nanoseconds = 0`, então o relógio em µs
 * de um documento é exatamente `seq · 1e6`. Cada teste que fala de relógio
 * compara contra o carimbo REAL do documento, nunca contra um número escrito à mão.
 */
import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  TIPO_AVISO,
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  linhaVariacaoDeKit,
  toOuterRef,
} from '@delfrance/schemas';
import {
  avisoCollection,
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import { deferred } from '@delfrance/data/testing';

import { FakeDb, asDb, increment } from '../testing/fakeDb';

/* ---------------------------------- fixtures ------------------------------ */

const INTEGRACAO = 'int-1';
const OUTRA_CONTA = 'int-2';
const KIT = 'kit-k';
const FILHO_A = 'filho-a';
const FILHO_B = 'filho-b';
/** O kit nativo vivo (papel D1: kit 2500139870 / modelo 2000458820). */
const ITEM_KIT = 2500139870;
/** O segundo kit — o novo de uma recriação (papel 2500139873). */
const ITEM_KIT_NOVO = 2500139873;
const MODELO_A = 2000458820;
const MODELO_B = 2000458822;
const AGORA_US = 1_760_000_000_000_000;

const REF_CONTA = toOuterRef(`integracao/${INTEGRACAO}`);
const REF_OUTRA_CONTA = toOuterRef(`integracao/${OUTRA_CONTA}`);
const CHAVE_AVISO = chaveAvisoReceitaKitShopee(INTEGRACAO, KIT);
const CAMINHO_AVISO = avisoCollection.docPath({}, CHAVE_AVISO);

/** Duas receitas do ERP: a que a Shopee tem (R1) e a editada depois (R2). */
const R1 = { 'comp-1': { quantidade: 2, limitarEstoque: true } };
const R2 = { 'comp-1': { quantidade: 3, limitarEstoque: true } };

function caminhoLink(linkId: string): string {
  return produtoShopeeLinkCollection.docPath({ produtoId: KIT }, linkId);
}
function caminhoFilho(filho: string): string {
  return produtoCollection.docPath({}, filho);
}
function caminhoLinha(filho: string, linhaId: string): string {
  return variacaoShopeeLinkCollection.docPath({ produtoId: filho }, linhaId);
}

function deps(): { agoraUs: number; increment: (by: number) => unknown } {
  return { agoraUs: AGORA_US, increment };
}

function semearLink(db: FakeDb, linkId: string, parcial: Record<string, unknown> = {}): void {
  db.seed(caminhoLink(linkId), {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_KIT,
    kitNativo: true,
    estadoAnuncio: 'ativo',
    substituidoPorLinkDocId: null,
    substituidoEm: null,
    ...parcial,
  });
}

function semearFilho(db: FakeDb, filho: string, receita: Record<string, unknown> | null): void {
  db.seed(caminhoFilho(filho), { paiId: KIT, ehKit: true, componentesKit: receita });
}

function semearLinha(
  db: FakeDb,
  filho: string,
  linhaId: string,
  a: {
    readonly linkId: string;
    readonly carimbo: string | null;
    readonly modelo?: number;
    readonly contaRef?: string;
    /** O caminho do vínculo como gravado — canônico por padrão. */
    readonly linkPath?: string;
  },
): void {
  db.seed(
    caminhoLinha(filho, linhaId),
    linhaVariacaoDeKit({
      contaRef: a.contaRef ?? REF_CONTA,
      linkPath: a.linkPath ?? toOuterRef(caminhoLink(a.linkId)),
      modelId: a.modelo ?? MODELO_A,
      tierIndex: [0],
      modelStatus: 'NORMAL',
      receitaKitConferida: a.carimbo,
    }),
  );
}

/** Uma gravação de produto pelo operador: um `update`, que AVANÇA o `updateTime`. */
async function salvarFilho(db: FakeDb, filho: string, receita: Record<string, unknown>) {
  await produtoCollection.docRef(asDb(db), {}, filho).update({ componentesKit: receita });
}

/** Um recarimbo do lado da Shopee: só a linha `variashopee`, nenhum produto. */
async function recarimbar(db: FakeDb, filho: string, linhaId: string, carimbo: string) {
  await variacaoShopeeLinkCollection
    .docRef(asDb(db), { produtoId: filho }, linhaId)
    .update({ receitaKitConferida: carimbo });
}

async function atualizarLink(db: FakeDb, linkId: string, patch: Record<string, unknown>) {
  await produtoShopeeLinkCollection.docRef(asDb(db), { produtoId: KIT }, linkId).update(patch);
}

function aviso(db: FakeDb): Record<string, unknown> | undefined {
  return db.store[CAMINHO_AVISO]?.data;
}

/** µs de um documento guardado, pela MESMA regra que a função aplica. */
function relogioDe(db: FakeDb, caminho: string): number {
  const stored = db.store[caminho];
  if (!stored) throw new Error(`sem documento em ${caminho}`);
  return stored.updateTime.seconds * 1_000_000 + Math.floor(stored.updateTime.nanoseconds / 1_000);
}

/**
 * O `db` com a TRANSAÇÃO de uma chamada segurada DEPOIS de terminar: a decisão
 * já foi lida (snapshot fechado), a escrita do aviso ainda não aconteceu. É a
 * janela em que uma observação antiga e uma nova se cruzam. (Segurar no
 * `occ.beforeCommit` não serviria: o motor re-executaria a leitura e ela sairia
 * FRESCA — ver o cabeçalho do `FakeDb`.)
 */
function comPortao(db: FakeDb): {
  readonly db: Firestore;
  readonly leu: Promise<void>;
  readonly soltar: () => void;
} {
  const leu = deferred();
  const portao = deferred();
  const proxy = new Proxy(db, {
    get(alvo, prop, receptor) {
      if (prop === 'runTransaction') {
        return async (
          fn: Parameters<FakeDb['runTransaction']>[0],
          opcoes?: Readonly<Record<string, unknown>>,
        ) => {
          const r: unknown = await alvo.runTransaction(fn, opcoes);
          leu.resolve();
          await portao.promise;
          return r;
        };
      }
      const v: unknown = Reflect.get(alvo, prop, receptor);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
    },
  });
  return { db: proxy as unknown as Firestore, leu: leu.promise, soltar: () => portao.resolve() };
}

/** Um kit de 2 filhos, vinculado e conferido com R1 — o estado depois de uma criação. */
function kitConferido(db: FakeDb, linkId = 'L1'): void {
  semearLink(db, linkId);
  semearFilho(db, FILHO_A, R1);
  semearFilho(db, FILHO_B, R1);
  semearLinha(db, FILHO_A, 'va', { linkId, carimbo: chaveReceitaKitErp(R1), modelo: MODELO_A });
  semearLinha(db, FILHO_B, 'vb', { linkId, carimbo: chaveReceitaKitErp(R1), modelo: MODELO_B });
}

/* ---------------------------------- abrir --------------------------------- */

describe('reavaliarAvisoDeReceitaKit — abrir', () => {
  it('uma receita editada depois da conferência ABRE o aviso, com o relógio = o carimbo mais novo lido (M163)', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await salvarFilho(db, FILHO_A, R2);

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(r).toBe('aberto');
    // UMA linha por (conta, K): a chave é a identidade — nenhum outro aviso nasceu.
    expect(db.idsEm('avisos')).toEqual([CHAVE_AVISO]);
    const linha = aviso(db);
    expect(linha).toMatchObject({
      tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
      severidade: 'atencao',
      canal: 'shopee',
      resolvidoEm: null,
      params: { kit: KIT, anuncio: String(ITEM_KIT), vinculo: 'L1', variacoes: FILHO_A },
      urlInterna: { campo: 'componentesKit' },
    });
    // M163: um número FINITO em µs, igual ao `updateTime` mais novo de tudo que a
    // decisão leu — aqui o filho salvo por último.
    expect(Number.isFinite(linha?.relogioEvento)).toBe(true);
    expect(linha?.relogioEvento).toBe(relogioDe(db, caminhoFilho(FILHO_A)));
    expect(linha?.relogioEvento).toBeGreaterThan(relogioDe(db, caminhoLinha(FILHO_A, 'va')));
  });

  it('um carimbo NULL é divergente — uma linha nova que não dobrou igual abre', async () => {
    const db = new FakeDb();
    semearLink(db, 'L1');
    semearFilho(db, FILHO_A, R1);
    semearLinha(db, FILHO_A, 'va', { linkId: 'L1', carimbo: null });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.importado,
      deps(),
    );

    expect(r).toBe('aberto');
    expect(aviso(db)?.resolvidoEm).toBeNull();
  });

  it('M54: um salvamento do filho ENTRE o recarimbo e a reavaliação mantém o aviso ABERTO — ela relê a receita', async () => {
    const db = new FakeDb();
    kitConferido(db);
    // O aviso já está aberto: a receita foi para R2 e a Shopee ainda tem R1.
    await salvarFilho(db, FILHO_A, R2);
    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    expect(aviso(db)?.resolvidoEm).toBeNull();

    // Uma republicação conferiu R2 e recarimbou a linha…
    await recarimbar(db, FILHO_A, 'va', chaveReceitaKitErp(R2));
    // …e, antes de ela reavaliar, o operador voltou a editar o filho.
    const R3 = { 'comp-1': { quantidade: 4, limitarEstoque: true } };
    await salvarFilho(db, FILHO_A, R3);

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.republicadoIgual,
      deps(),
    );

    expect(r).toBe('aberto');
    expect(aviso(db)?.resolvidoEm).toBeNull();
    // ⛔ NEAR-MISS: sem a edição intercalada, o MESMO recarimbo resolve.
    const db2 = new FakeDb();
    kitConferido(db2);
    await salvarFilho(db2, FILHO_A, R2);
    await reavaliarAvisoDeReceitaKit(
      asDb(db2),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    await recarimbar(db2, FILHO_A, 'va', chaveReceitaKitErp(R2));
    const r2 = await reavaliarAvisoDeReceitaKit(
      asDb(db2),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.republicadoIgual,
      deps(),
    );
    expect(r2).toBe('resolvido');
    expect(aviso(db2)).toMatchObject({ resolucaoMotivo: 'republicado-igual' });
  });
});

/* ------------------------------ M56 — o vínculo ----------------------------- */

describe('reavaliarAvisoDeReceitaKit — que linhas contam', () => {
  it('M56: liga a linha pelo ID do vínculo — as DUAS grafias gravadas (canônica e nua) contam', async () => {
    const db = new FakeDb();
    semearLink(db, 'L1');
    semearFilho(db, FILHO_A, R2);
    semearFilho(db, FILHO_B, R2);
    semearLinha(db, FILHO_A, 'va', { linkId: 'L1', carimbo: chaveReceitaKitErp(R1) });
    // A grafia legada, sem `documents/`.
    semearLinha(db, FILHO_B, 'vb', {
      linkId: 'L1',
      carimbo: chaveReceitaKitErp(R1),
      modelo: MODELO_B,
      linkPath: caminhoLink('L1'),
    });

    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(aviso(db)?.params).toMatchObject({ variacoes: `${FILHO_A}, ${FILHO_B}` });
  });

  it('⛔ NEAR-MISS: a linha de OUTRA listagem, de OUTRA conta ou de um vínculo COMUM não conta', async () => {
    const db = new FakeDb();
    semearLink(db, 'L1');
    // Uma listagem comum (kit antigo) do mesmo produto e conta.
    semearLink(db, 'L-comum', { kitNativo: false, item_id: 2500139861 });
    semearFilho(db, FILHO_A, R2);
    // A linha do kit nativo está conferida com a receita ATUAL…
    semearLinha(db, FILHO_A, 'va', { linkId: 'L1', carimbo: chaveReceitaKitErp(R2) });
    // …e três linhas velhas que NÃO são deste kit nesta conta:
    semearLinha(db, FILHO_A, 'v-comum', { linkId: 'L-comum', carimbo: null, modelo: 2000458802 });
    semearLinha(db, FILHO_A, 'v-outra-conta', {
      linkId: 'L1',
      carimbo: null,
      modelo: MODELO_B,
      contaRef: REF_OUTRA_CONTA,
    });
    semearLinha(db, FILHO_A, 'v-outro-kit', {
      linkId: 'L-de-outro-produto',
      carimbo: null,
      modelo: 2000458821,
      linkPath: toOuterRef('produtos/outro/prodshopee/L-de-outro-produto'),
    });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(r).toBe('resolvido');
  });

  it('o vínculo de OUTRA conta não vende por esta: nenhuma linha conta ⇒ `nada`, e nada é escrito', async () => {
    const db = new FakeDb();
    semearLink(db, 'L-outra', { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'va', {
      linkId: 'L-outra',
      carimbo: null,
      contaRef: REF_OUTRA_CONTA,
    });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(r).toBe('nada');
    expect(db.writes).toEqual([]);
  });
});

/* ----------------------------- M55 / M57 — relógio ------------------------- */

describe('reavaliarAvisoDeReceitaKit — o relógio', () => {
  it('M55: uma resolução observada ANTES de uma abertura, e que chega DEPOIS dela, é descartada', async () => {
    const db = new FakeDb();
    kitConferido(db);

    // A: lê o estado conferido (⇒ resolver) e fica segurada antes de escrever.
    const a = comPortao(db);
    const resolucao = reavaliarAvisoDeReceitaKit(
      a.db,
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.republicadoIgual,
      deps(),
    );
    await a.leu;

    // B: o operador edita, e o gatilho abre o aviso com um relógio mais novo.
    await salvarFilho(db, FILHO_A, R2);
    const abertura = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    expect(abertura).toBe('aberto');
    const relogioDaAbertura = aviso(db)?.relogioEvento;

    a.soltar();
    expect(await resolucao).toBe('resolvido');

    // A resolução velha chegou por último e NÃO fechou a edição nova.
    expect(aviso(db)).toMatchObject({ resolvidoEm: null, relogioEvento: relogioDaAbertura });
  });

  it('M57: o relógio inclui as LINHAS — um recarimbo sem salvar produto algum resolve', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await salvarFilho(db, FILHO_A, R2);
    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    expect(aviso(db)?.resolvidoEm).toBeNull();

    // A Shopee passou a ter R2 (uma republicação conferida): SÓ a linha muda.
    await recarimbar(db, FILHO_A, 'va', chaveReceitaKitErp(R2));
    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.republicadoIgual,
      deps(),
    );

    expect(r).toBe('resolvido');
    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: 'republicado-igual',
      relogioEvento: relogioDe(db, caminhoLinha(FILHO_A, 'va')),
    });
  });

  it('M57: o relógio inclui os VÍNCULOS — o kit antigo removido fecha o aviso que só ele mantinha aberto', async () => {
    const db = new FakeDb();
    // O kit antigo vende a receita velha; o novo foi criado e conferido com R2.
    semearLink(db, 'L-antigo');
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'v-antigo', { linkId: 'L-antigo', carimbo: chaveReceitaKitErp(R1) });
    semearLink(db, 'L-novo', { item_id: ITEM_KIT_NOVO });
    semearLinha(db, FILHO_A, 'v-novo', {
      linkId: 'L-novo',
      carimbo: chaveReceitaKitErp(R2),
      modelo: MODELO_B,
    });
    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );
    expect(aviso(db)?.resolvidoEm).toBeNull();

    // A exclusão do antigo é lida (reverificação): SÓ o vínculo muda.
    await atualizarLink(db, 'L-antigo', { estadoAnuncio: 'removido' });
    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('resolvido');
    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: 'kit-recriado',
      relogioEvento: relogioDe(db, caminhoLink('L-antigo')),
    });
  });
});

/* --------------------------------- M58 — nada ------------------------------ */

describe("reavaliarAvisoDeReceitaKit — 'nada'", () => {
  it('M58: aviso ABERTO e nenhum kit que ainda venda ⇒ resolvido `sem-kit-ativo`, seja qual for o motivo pedido', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await salvarFilho(db, FILHO_A, R2);
    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    await atualizarLink(db, 'L1', { estadoAnuncio: 'removido' });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('nada');
    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.semKitAtivo,
      resolvidoEm: AGORA_US,
    });
  });

  it('M58: sem aviso e um K SEM vínculo nativo (kit antigo) ⇒ ZERO escritas', async () => {
    const db = new FakeDb();
    semearLink(db, 'L-comum', { kitNativo: false, item_id: 2500139861 });
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'va', { linkId: 'L-comum', carimbo: null, modelo: 2000458802 });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(r).toBe('nada');
    expect(db.writes).toEqual([]);
    // Nenhuma linha podia ligar, então nenhuma `variashopee` foi lida — só os
    // vínculos, os filhos e a linha do aviso.
    expect(db.leiturasEmTransacao).toEqual([
      produtoShopeeLinkCollection.resolvePath({ produtoId: KIT }),
      produtoCollection.resolvePath({}),
      CAMINHO_AVISO,
    ]);
  });

  it('M58: sem aviso e um vínculo nativo REMOVIDO ⇒ UMA linha resolvida `sem-kit-ativo` (a marca d’água)', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await atualizarLink(db, 'L1', { estadoAnuncio: 'removido' });
    const escritasAntes = db.writes.length;

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('nada');
    expect(db.writes.slice(escritasAntes).map((w) => w.path)).toEqual([CAMINHO_AVISO]);
    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.semKitAtivo,
      resolvidoEm: AGORA_US,
      relogioEvento: relogioDe(db, caminhoLink('L1')),
    });
  });

  it('⛔ NEAR-MISS: sem vínculo nativo nenhum mas com o aviso ABERTO, ele é lido no MESMO snapshot e resolvido', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await salvarFilho(db, FILHO_A, R2);
    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    // O documento do vínculo SUMIU (não marcado — apagado), e depois o filho foi salvo.
    await produtoShopeeLinkCollection.docRef(asDb(db), { produtoId: KIT }, 'L1').delete();
    await salvarFilho(db, FILHO_A, R1);
    db.leiturasEmTransacao.length = 0;

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(r).toBe('nada');
    expect(db.leiturasEmTransacao).toContain(CAMINHO_AVISO);
    expect(aviso(db)).toMatchObject({ resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.semKitAtivo });
  });

  it('M64: a marca d’água do `nada` DERRUBA uma abertura antiga que chega depois dela', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await salvarFilho(db, FILHO_A, R2);

    // A: com o kit vivo, decide ABRIR e fica segurada antes de escrever.
    const a = comPortao(db);
    const abertura = reavaliarAvisoDeReceitaKit(
      a.db,
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );
    await a.leu;

    // B: o kit foi excluído na Shopee e a reverificação o lê `removido`.
    await atualizarLink(db, 'L1', { estadoAnuncio: 'removido' });
    const nada = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );
    expect(nada).toBe('nada');

    a.soltar();
    expect(await abertura).toBe('aberto');

    // A abertura velha chegou depois e foi descartada: a linha segue RESOLVIDA.
    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.semKitAtivo,
      relogioEvento: relogioDe(db, caminhoLink('L1')),
    });
    expect(aviso(db)?.resolvidoEm).not.toBeNull();
  });
});

/* -------------------------- resolver + o snapshot (M61) --------------------- */

describe('reavaliarAvisoDeReceitaKit — resolver e o snapshot', () => {
  it('tudo conferido e sem aviso ⇒ resolvido, gravando a marca d’água com o motivo pedido', async () => {
    const db = new FakeDb();
    kitConferido(db);

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('resolvido');
    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: 'kit-recriado',
      params: { anuncio: String(ITEM_KIT), vinculo: 'L1' },
    });
  });

  it('M61: UMA transação readOnly, toda leitura por ela, e a escrita do aviso DEPOIS dela', async () => {
    const db = new FakeDb();
    kitConferido(db);
    await salvarFilho(db, FILHO_A, R2);
    db.opLog.length = 0;
    let escritasAoFecharATransacao: number | null = null;
    db.occ.beforeCommit = () => {
      escritasAoFecharATransacao = db.writes.length;
    };
    const escritasAntes = db.writes.length;

    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(db.opcoesDeTransacao).toEqual([{ readOnly: true }]);
    expect(db.occ.txLog.filter((e) => e.phase === 'begin')).toHaveLength(1);
    // 1 (vínculos) + 1 (filhos) + n (as linhas de cada filho, n = 2).
    expect(db.leiturasEmTransacao).toEqual([
      produtoShopeeLinkCollection.resolvePath({ produtoId: KIT }),
      produtoCollection.resolvePath({}),
      variacaoShopeeLinkCollection.resolvePath({ produtoId: FILHO_A }),
      variacaoShopeeLinkCollection.resolvePath({ produtoId: FILHO_B }),
    ]);
    // Toda leitura fora de `avisos/` passou pela transação.
    const leiturasDeDecisao = db.opLog
      .filter((o) => o.op === 'get' && !o.path.startsWith('avisos'))
      .map((o) => o.path);
    expect(leiturasDeDecisao.length).toBeGreaterThan(0);
    for (const caminho of leiturasDeDecisao) expect(db.leiturasEmTransacao).toContain(caminho);
    // A escrita do aviso aconteceu DEPOIS: ao fechar a transação ela não existia.
    expect(escritasAoFecharATransacao).toBe(escritasAntes);
    expect(db.writes.length).toBeGreaterThan(escritasAntes);
  });
});

/* ------------------------------ M182 — qual vínculo ------------------------- */

describe('reavaliarAvisoDeReceitaKit — o vínculo que o aviso nomeia', () => {
  it('M182: o kit ANTIGO substituído que vende a receita velha é o nomeado — nunca o ativo só por ser ativo', async () => {
    const db = new FakeDb();
    // Os ids ordenam o ATIVO primeiro, de propósito.
    semearLink(db, 'zz-antigo', {
      item_id: ITEM_KIT,
      substituidoPorLinkDocId: 'aa-novo',
      substituidoEm: 1_757_000_000_000,
    });
    semearLink(db, 'aa-novo', { item_id: ITEM_KIT_NOVO });
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'v-antigo', { linkId: 'zz-antigo', carimbo: chaveReceitaKitErp(R1) });
    semearLinha(db, FILHO_A, 'v-novo', {
      linkId: 'aa-novo',
      carimbo: chaveReceitaKitErp(R2),
      modelo: MODELO_B,
    });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('aberto');
    expect(aviso(db)?.params).toMatchObject({
      vinculo: 'zz-antigo',
      anuncio: String(ITEM_KIT),
      variacoes: FILHO_A,
    });
  });

  it('⛔ NEAR-MISS: com os DOIS divergentes, o substituído ainda vem antes do ativo', async () => {
    const db = new FakeDb();
    semearLink(db, 'zz-antigo', { substituidoPorLinkDocId: 'aa-novo' });
    semearLink(db, 'aa-novo', { item_id: ITEM_KIT_NOVO });
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'v-antigo', { linkId: 'zz-antigo', carimbo: null });
    semearLinha(db, FILHO_A, 'v-novo', { linkId: 'aa-novo', carimbo: null, modelo: MODELO_B });

    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(aviso(db)?.params).toMatchObject({ vinculo: 'zz-antigo', anuncio: String(ITEM_KIT) });
  });

  it('⛔ NEAR-MISS: um único kit ATIVO divergente é o nomeado, como sempre', async () => {
    const db = new FakeDb();
    semearLink(db, 'L1', { item_id: ITEM_KIT_NOVO });
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'va', { linkId: 'L1', carimbo: chaveReceitaKitErp(R1) });

    await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      deps(),
    );

    expect(aviso(db)?.params).toMatchObject({ vinculo: 'L1', anuncio: String(ITEM_KIT_NOVO) });
  });

  it('⛔ NEAR-MISS: um kit substituído BANIDO não vende — suas linhas velhas não abrem nada', async () => {
    const db = new FakeDb();
    semearLink(db, 'zz-antigo', { substituidoPorLinkDocId: 'aa-novo', estadoAnuncio: 'banido' });
    semearLink(db, 'aa-novo', { item_id: ITEM_KIT_NOVO });
    semearFilho(db, FILHO_A, R2);
    semearLinha(db, FILHO_A, 'v-antigo', { linkId: 'zz-antigo', carimbo: chaveReceitaKitErp(R1) });
    semearLinha(db, FILHO_A, 'v-novo', {
      linkId: 'aa-novo',
      carimbo: chaveReceitaKitErp(R2),
      modelo: MODELO_B,
    });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('resolvido');
    expect(aviso(db)?.params).toMatchObject({ vinculo: 'aa-novo' });
  });

  it('(R6-M12) a linha RESOLVIDA criada nomeia o kit ATIVO antes do substituído — mesmo com o substituído vendendo e ordenando primeiro', async () => {
    // Mutant DC5: without the active-first tier the created row would name
    // `aa-antigo` — the kit a recriar is about to delete.
    const db = new FakeDb();
    semearLink(db, 'aa-antigo', {
      item_id: ITEM_KIT,
      substituidoPorLinkDocId: 'bb-novo',
      substituidoEm: 1_757_000_000_000,
    });
    semearLink(db, 'bb-novo', { item_id: ITEM_KIT_NOVO });
    semearFilho(db, FILHO_A, R1);
    semearLinha(db, FILHO_A, 'v-antigo', { linkId: 'aa-antigo', carimbo: chaveReceitaKitErp(R1) });
    semearLinha(db, FILHO_A, 'v-novo', {
      linkId: 'bb-novo',
      carimbo: chaveReceitaKitErp(R1),
      modelo: MODELO_B,
    });
    expect(aviso(db)).toBeUndefined();

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('resolvido');
    expect(aviso(db)?.params).toMatchObject({ vinculo: 'bb-novo', anuncio: String(ITEM_KIT_NOVO) });
  });

  it('⛔ NEAR-MISS (R6-M12): sem kit ATIVO, o substituído que ainda vende é o nomeado', async () => {
    const db = new FakeDb();
    semearLink(db, 'aa-antigo', {
      item_id: ITEM_KIT,
      substituidoPorLinkDocId: 'bb-novo',
      substituidoEm: 1_757_000_000_000,
    });
    semearFilho(db, FILHO_A, R1);
    semearLinha(db, FILHO_A, 'v-antigo', { linkId: 'aa-antigo', carimbo: chaveReceitaKitErp(R1) });

    const r = await reavaliarAvisoDeReceitaKit(
      asDb(db),
      { integracaoId: INTEGRACAO, kitProdutoId: KIT },
      MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado,
      deps(),
    );

    expect(r).toBe('resolvido');
    expect(aviso(db)?.params).toMatchObject({ vinculo: 'aa-antigo', anuncio: String(ITEM_KIT) });
  });
});
