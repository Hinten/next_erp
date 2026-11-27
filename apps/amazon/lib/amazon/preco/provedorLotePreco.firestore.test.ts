/**
 * The PRICE feed provider on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 13, PR 13-f). The offline
 * suite drives every branch against `testing/fakeDb.ts`; this file proves what
 * only holds if the server behaves as the fake says:
 *
 *  - ★ the send-time re-reads are projected BY THE SERVER: a unit read under
 *    the price masks answers the conta's two `precos.<tabela>` entries and no
 *    third one, a link doc answers its three fields and never its product
 *    payload; and the build prices from those reads (a tabela edit since the
 *    page is in the message, a link moved to another conta is dropped);
 *  - ★ the run's LEDGER is written once, on the read's precondition: a
 *    concurrent `update` between the provider's read and its write fails it
 *    on the server, and the provider re-reads and still records the end once;
 *  - ★ the re-raise of `feed-preco-falhou` over a resolved aviso is clocked by
 *    the run read, which the server orders after the resolve;
 *  - ★ the report's write-back changes `envioPrecoAmazon` ALONE on the link
 *    doc (the stock outcome and the product payload byte-equal).
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * here is under ids no other suite seeds (`e2e-preco-provedor-…`); the conta is
 * INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only reads;
 * nothing is enqueued (every producer of the root refuses). The run's
 * concurrent writer is injected by spying on the database's own `getAll`.
 * Every case wipes what it reads first, and the file leaves nothing behind.
 * PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FASE_EXECUCAO_PRECO_AMAZON,
  INTEGRACAO_TIPO,
  type ItemDivergenciaPrecoAmazon,
  MOTIVO_CONTA_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  execucaoPrecoAmazonSchema,
  idRegistroFeedAmazon,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import {
  ACAO_AVISO_CONTA_LISTINGS_AMAZON,
  chaveContaPrecisaAtencao,
  sincronizarAvisoContaListingsAmazon,
} from '../avisos/avisos';
import type { ContextoAmazon } from '../core/contexto';
import type { RaizLoteAmazon } from '../feeds/destinosLote';
import { type ContextoLoteAmazon, FIM_SEM_ENVIO_LOTE } from '../feeds/provedorLote';
import {
  type TarefaEnviarFeedAmazon,
  execucaoIdDoLoteBlocosFeed,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import { SPID_A, loggerEspiao } from '../testing/fixtures';
import { gravarParteDivergenciaPrecoAmazon } from './divergenciasPrecoFirestore';
import {
  CAMPOS_VINCULO_LOTE_PRECO_AMAZON,
  criarProvedorLotePrecoAmazon,
} from './provedorLotePreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-provedor-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const EXEC = `${P}exec`;
const NORMAL = `${P}tab-normal`;
const PROMO = `${P}tab-promo`;
/** A third tabela the conta does not name: its entry must never come back. */
const OUTRA = `${P}tab-outra`;
const SKU_A = `${P}SKU-A`;
const SKU_B = `${P}SKU-B`;
const produto = (sku: string) => `${P}prod-${sku.slice(P.length)}`;
const caminhoLink = (sku: string) => `produtos/${produto(sku)}/prodAmazon/l1`;
const RUN = `precosAmazon/${CONTA}`;
const CONTA_DOC = `integracao/${CONTA}`;
const AGORA = 1_800_000_000_000;
const HORA = 3_600_000;
const FEED = '50009876543';
const REGISTRO = `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`;

/** A stock outcome already on the link doc: the price write-back must leave it byte-equal. */
const ESTOQUE_GUARDADO = {
  via: 'patch',
  emMs: 1_700_000_000_000,
  quantidade: 3,
  resultado: 'aceito',
  submissionId: 'sub-estoque-1',
  feedId: null,
  problemas: [],
};

const AVISOS = motivoContaAmazonSchema.options.map(
  (m) => `avisos/${chaveContaPrecisaAtencao(CONTA, m)}`,
);
const AVISO_FEED = `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.feedPrecoFalhou)}`;

function db(): Firestore {
  return getAdminFirestore();
}

/** Everything this file writes, deleted (subcollections included). */
async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(RUN));
  for (const sku of [SKU_A, SKU_B])
    await db().recursiveDelete(db().doc(`produtos/${produto(sku)}`));
  await Promise.all([CONTA_DOC, REGISTRO, ...AVISOS].map((c) => db().doc(c).delete()));
}

const log = loggerEspiao();
let relogio = AGORA;

/** The root: the producers refuse (nothing is enqueued here); the aviso counter is real. */
function raiz(): RaizLoteAmazon {
  const recusa = (nome: string) => () => {
    throw new Error(`teste: ${nome} não é usado aqui`);
  };
  return {
    agendadorLotes: recusa('agendadorLotes'),
    produtorEstoque: recusa('produtorEstoque'),
    produtorPreco: recusa('produtorPreco'),
    esperar: () => Promise.reject(new Error('teste: nenhuma espera aqui')),
    increment: (by) => FieldValue.increment(by),
    gerarExecucaoId: recusa('gerarExecucaoId'),
    ambiente: () => ({}),
  };
}

function ctx(): ContextoLoteAmazon {
  return {
    contexto: { integracaoId: CONTA } as unknown as ContextoAmazon,
    db: db(),
    logger: log.logger,
    agora: () => relogio,
    sellerId: SPID_A,
    relogioVez: null,
    vez: null,
  };
}

function membro(sku: string, base: number): ItemDivergenciaPrecoAmazon {
  return {
    sku,
    vinculo: caminhoLink(sku),
    unidadeId: produto(sku),
    oferta: { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: 50, minimo: 50, maximo: 50 },
    faixa: { base, minimo: base, maximo: base },
    tipoProduto: 'LUGGAGE',
    lidoEmMs: AGORA - HORA,
  };
}

function lote(k = 0): TarefaEnviarFeedAmazon & { readonly fluxo: 'preco' } {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'preco',
    contaId: CONTA,
    execucaoId: execucaoIdDoLoteBlocosFeed(CONTA, EXEC, k),
    origem: 'execucao',
    lote: {
      tipo: 'blocos',
      execucaoIdRun: EXEC,
      parteInicial: k,
      partes: 1,
      esperaAteMs: AGORA + 48 * HORA,
    },
  }) as TarefaEnviarFeedAmazon & { readonly fluxo: 'preco' };
}

async function semearRun(lotes = 1): Promise<void> {
  await db()
    .doc(RUN)
    .set(
      execucaoPrecoAmazonSchema.parse({
        execucaoId: EXEC,
        fase: FASE_EXECUCAO_PRECO_AMAZON.concluida,
        baixarPreco: false,
        solicitadaPor: `${P}uid`,
        iniciadaEmMs: AGORA - 2 * HORA,
        lotes: Object.fromEntries(
          Array.from({ length: lotes }, (_v, k) => [
            String(k),
            {
              execucaoIdLote: execucaoIdDoLoteBlocosFeed(CONTA, EXEC, k),
              parteInicial: k,
              partes: 1,
              itens: 1,
              desfecho: null,
              motivoSemEnvio: null,
            },
          ]),
        ),
      }),
    );
}

/** The INCOMPLETE conta (no filial, no `dataCadastro`): the conta trigger only reads it. */
async function semearConta(): Promise<void> {
  await db()
    .doc(CONTA_DOC)
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta e2e do provedor de preço',
      ativo: true,
      tabelaNormalOuterRef: `documents/listaDePrecos/${NORMAL}`,
      tabelaPromocionalOuterRef: `documents/listaDePrecos/${PROMO}`,
    });
}

async function semearErp(sku: string, normal: number, contaRef = `documents/integracao/${CONTA}`) {
  await db()
    .doc(`produtos/${produto(sku)}`)
    .set({
      nome: `Produto ${sku}`,
      precos: { [NORMAL]: { valor: normal }, [OUTRA]: { valor: 1 } },
    });
  await db()
    .doc(caminhoLink(sku))
    .set({
      contaAmazonOuterRef: contaRef,
      sku,
      productDataJson: { pesado: 'x'.repeat(256) },
      envioEstoqueAmazon: ESTOQUE_GUARDADO,
    });
}

/** Every snapshot the database's own `getAll` answers, by path, as data. */
function espiarLeituras(): Map<string, Record<string, unknown>> {
  const original = db().getAll.bind(db());
  const vistos = new Map<string, Record<string, unknown>>();
  vi.spyOn(db(), 'getAll').mockImplementation(async (...args) => {
    const snaps = await original(...args);
    for (const s of snaps) vistos.set(s.ref.path, s.data() ?? {});
    return snaps;
  });
  return vistos;
}

describe.skipIf(!EMULATED)('the price feed provider on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
    relogio = AGORA;
    log.linhas.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the send-time re-reads are projected by the SERVER, and the build prices from them', async () => {
    await semearConta();
    await semearRun();
    await gravarParteDivergenciaPrecoAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      parte: 0,
      itens: [membro(SKU_A, 60), membro(SKU_B, 60)],
      agoraMs: AGORA - HORA,
    });
    // The page saw 60; the tabela moved to 70 since. SKU_B's link moved to another conta.
    await semearErp(SKU_A, 70);
    await semearErp(SKU_B, 70, `documents/integracao/${P}outra-conta`);
    const provedor = criarProvedorLotePrecoAmazon(raiz());
    const m = await provedor.membros(ctx(), lote());
    if ('abortado' in m) throw new Error('teste: membros abortou');
    expect(m.skus).toEqual([SKU_A, SKU_B]);
    const vistos = espiarLeituras();
    const montagem = await provedor.montar(ctx(), lote(), m.skus, m.dados);
    if ('abortado' in montagem) throw new Error('teste: montar abortou');
    expect(montagem.mensagens.map((x) => x.sku)).toEqual([SKU_A]);
    expect(montagem.diff).toMatchObject({ 'vinculo-mudou': 1, mensagens: 1, sobe: 1 });
    const elemento = (montagem.mensagens[0]?.patches[0]?.value ?? [])[0] as Record<string, unknown>;
    expect(elemento.our_price).toEqual([{ schedule: [{ value_with_tax: 70 }] }]);
    expect(montagem.mensagens[0]?.productType).toBe('LUGGAGE');
    // The server projected each read.
    expect(Object.keys(vistos.get(caminhoLink(SKU_A)) ?? {}).sort()).toEqual(
      [...CAMPOS_VINCULO_LOTE_PRECO_AMAZON].filter((c) => c !== 'envioPrecoAmazon').sort(),
    );
    expect(vistos.get(`produtos/${produto(SKU_A)}`)).toEqual({
      precos: { [NORMAL]: { valor: 70 } },
    });
    expect(Object.keys(vistos.get(CONTA_DOC) ?? {}).sort()).toEqual([
      'tabelaNormalOuterRef',
      'tabelaPromocionalOuterRef',
    ]);
  });

  it('★ the ledger is written once, on the read’s precondition: a concurrent update between the read and the write is re-read, and the end still recorded once', async () => {
    await semearRun();
    const original = db().getAll.bind(db());
    let competiu = false;
    vi.spyOn(db(), 'getAll').mockImplementation(async (...args) => {
      const snaps = await original(...args);
      if (!competiu && snaps.some((s) => s.ref.path === RUN)) {
        competiu = true;
        await db().doc(RUN).update({ progressoEmMs: AGORA });
      }
      return snaps;
    });
    const provedor = criarProvedorLotePrecoAmazon(raiz());
    await provedor.aoFimSemEnvio?.(ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado);
    expect(competiu).toBe(true);
    const lido = (await db().doc(RUN).get()).data() ?? {};
    expect(lido.progressoEmMs).toBe(AGORA);
    expect(lido.lotes).toMatchObject({
      '0': { desfecho: 'sem-envio', motivoSemEnvio: 'simulado' },
    });
    // A second end of the same batch writes nothing.
    vi.restoreAllMocks();
    const antes = (await db().doc(RUN).get()).updateTime as Timestamp;
    await provedor.aoFimSemEnvio?.(ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
    const depois = (await db().doc(RUN).get()).updateTime as Timestamp;
    expect(depois.isEqual(antes)).toBe(true);
  });

  it('★ the re-raise over a resolved aviso is clocked by the run read, which the server orders after the resolve', async () => {
    await semearRun(2);
    const provedor = criarProvedorLotePrecoAmazon(raiz());
    await provedor.aoFimSemEnvio?.(ctx(), lote(0), FIM_SEM_ENVIO_LOTE.abortado);
    // The tail of batch 1 resolves the aviso (a clean concluido), clocked by its own read.
    const resolve = (await db().doc(CONTA_DOC).get()).readTime;
    await sincronizarAvisoContaListingsAmazon(
      db(),
      { increment: (by) => FieldValue.increment(by), nowMs: relogio, logger: log.logger },
      {
        fluxo: FLUXO_LISTING_AMAZON.preco,
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
        acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.resolver,
        relogio: resolve,
      },
    );
    expect((await db().doc(AVISO_FEED).get()).data()?.resolvidoEm).not.toBeNull();
    // Batch 1's feed record names the batch that sent it.
    await db()
      .doc(REGISTRO)
      .set({ execucaoId: execucaoIdDoLoteBlocosFeed(CONTA, EXEC, 1), fluxo: 'preco' });
    await provedor.recuperar(ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: AGORA - HORA,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });
    const reerguido = (await db().doc(AVISO_FEED).get()).data() ?? {};
    expect(reerguido.resolvidoEm).toBeNull();
    const lido = (await db().doc(RUN).get()).data() ?? {};
    expect(lido.lotes).toMatchObject({
      '0': { desfecho: 'sem-envio', motivoSemEnvio: 'abortado' },
      '1': { desfecho: 'concluido', motivoSemEnvio: null },
    });
  });

  it('★ the report’s write-back changes envioPrecoAmazon ALONE on the link doc', async () => {
    await semearErp(SKU_A, 60);
    const antes = (await db().doc(caminhoLink(SKU_A)).get()).data() ?? {};
    const provedor = criarProvedorLotePrecoAmazon(raiz());
    await provedor.gravarResultado(ctx(), {
      problemas: new Map(),
      issuesDosItens: new Map([
        [
          SKU_A,
          [
            {
              code: '19037',
              message: 'abaixo do mínimo',
              severity: 'ERROR',
              attributeNames: null,
              categories: ['INVALID_PRICE'],
            },
          ],
        ],
      ]),
      emMs: AGORA - HORA,
      feedId: '50001234567',
      relogio: (await db().doc(caminhoLink(SKU_A)).get()).readTime,
    });
    const depois = (await db().doc(caminhoLink(SKU_A)).get()).data() ?? {};
    const { envioPrecoAmazon, ...resto } = depois;
    expect(resto).toEqual(antes);
    expect(envioPrecoAmazon).toMatchObject({
      via: 'feed',
      oferta: null,
      resultado: 'aceito-com-avisos',
      feedId: '50001234567',
    });
    const aviso = await db()
      .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon)}`)
      .get();
    expect(aviso.data()?.resolvidoEm).toBeNull();
  });
});
