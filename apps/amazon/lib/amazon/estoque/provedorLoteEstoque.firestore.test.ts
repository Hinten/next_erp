/**
 * The stock feed provider on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 12, PR 12-f). The offline suite
 * drives every rule against `testing/fakeDb.ts`; this file runs the provider
 * IN-PROCESS on the real server and proves what only holds if the server
 * behaves as the fake says:
 *
 *  - ★ a BLOCK batch on the server: the run's drift blocks read by id (a
 *    missing part an empty block), the units read with a field MASK, a gone
 *    unit and a unit with variations dropped, a kit root's own sole member
 *    kept, a converged SKU dropped, and the quantity the ERP's now;
 *  - ★ the feed's write-back on real link documents: `recusado` with no
 *    quantity under each document's own precondition, and ONE aviso clocked by
 *    a stored Firestore `Timestamp`;
 *  - ★ a block batch's failure recovered: ONE guarded automatic request on the
 *    real request document (the run claimed, its first page enqueued), and a
 *    second failure the same day refused with the feed aviso raised.
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the reads'
 * SHAPE and results, never their cost — the index pins are the cost guard.
 *
 * ⚠️ D11. No case here reaches Amazon: the block snapshot reads no listing, the
 * write-back and the recovery make no Amazon call, and the context's `fetch`
 * REFUSES every request (the credential is far from expiry, so no LWA exchange
 * either). The read switch is on only in the object literal handed to the
 * context. Both producers are the REAL ones over RECORDING queues: nothing is
 * enqueued onto a queue the lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id, the conta and the depósito start with `e2e-estoque-provedor-`, which no
 * other suite seeds; the conta is INCOMPLETE (no filial, no `dataCadastro`),
 * so the conta trigger only reads; no `nfev4` is written. Every case wipes
 * what it seeds first, and the file leaves nothing behind.
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import { FieldValue, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  makeEstoqueUid,
  motivoContaAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { loadAmazonContext } from '../core/contexto';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import type { RaizLoteAmazon } from '../feeds/destinosLote';
import type { ContextoLoteAmazon } from '../feeds/provedorLote';
import {
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoConta,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
} from '../testing/fixtures';
import { gravarBlocoDivergenciaEstoqueAmazon } from './divergenciasFirestore';
import { criarProdutorEstoqueAmazon } from './produtorEstoque';
import { criarProvedorLoteEstoqueAmazon } from './provedorLoteEstoque';
import type { TarefaEstoqueAmazon } from './tarefaEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-provedor-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const DEP = `${P}dep`;
const REF_DEP = `documents/depositos/${DEP}`;
const RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const PEDIDO = `pedidoReconciliacaoEstoqueAmazon/${CONTA}`;
const EXEC = `${P}run-1`;
const FEED = '50003333333';

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE: AmbienteAmazon = Object.freeze({ ...AMBIENTE_LIGADO, AMAZON_CHAMADAS: 'on' });

function db(): Firestore {
  return getAdminFirestore();
}

const AVISOS = motivoContaAmazonSchema.options.map(
  (m) => `avisos/${chaveContaPrecisaAtencao(CONTA, m)}`,
);
const PRODUTOS = [
  'u-difere',
  'u-convergiu',
  'u-pai',
  'u-pai-filho',
  'u-kit',
  'u-kit-membro',
  'p-link',
].map((id) => `${P}${id}`);

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${id}`));
  await db().recursiveDelete(db().doc(RUN));
  await Promise.all(
    [PEDIDO, caminhoConta(CONTA), caminhoCredencial(CONTA), ...AVISOS].map((c) =>
      db().doc(c).delete(),
    ),
  );
}

async function semearConta(): Promise<void> {
  await db().doc(caminhoConta(CONTA)).set({
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste do provedor de estoque',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: REF_DEP,
  });
  await db()
    .doc(caminhoCredencial(CONTA))
    .set(credencialDoc({ expirationDate: Date.now() + 30 * DIA_MS }));
}

async function produto(id: string, dados: Record<string, unknown> = {}): Promise<void> {
  await db()
    .doc(`produtos/${P}${id}`)
    .set({ nome: `Produto ${id}`, ...dados });
}

async function linha(id: string, quantidade: number): Promise<void> {
  await db()
    .doc(`produtos/${P}${id}/estoques/${makeEstoqueUid(`${P}${id}`, DEP)}`)
    .set({ depositoOuterRef: REF_DEP, parentId: `${P}${id}`, quantidade, quantidadeReservada: 1 });
}

/** Recording queues: task ids held like Cloud Tasks holds them. */
let tarefasEstoque: TarefaEstoqueAmazon[] = [];
let tarefasLote: TarefaLoteAmazon[] = [];

function raiz(): RaizLoteAmazon {
  const idsEstoque = new Set<string>();
  const idsLote = new Set<string>();
  let execucoes = 0;
  return {
    agendadorLotes: () =>
      criarAgendadorLotesAmazon({
        desligado: false,
        fila: (): FilaLotesAmazon => ({
          enqueue: (tarefa, opcoes) => {
            const id = opcoes?.id;
            if (id !== undefined && idsLote.has(id)) {
              return Promise.reject(falhaDeTarefaJaExistente(id));
            }
            if (id !== undefined) idsLote.add(id);
            tarefasLote.push(tarefa);
            return Promise.resolve();
          },
        }),
      }),
    produtorEstoque: () =>
      criarProdutorEstoqueAmazon({
        desligado: false,
        fila: () => ({
          enqueue: (tarefa, extras) => {
            const id = extras?.id;
            if (id !== undefined && idsEstoque.has(id)) {
              return Promise.reject(falhaDeTarefaJaExistente(id));
            }
            if (id !== undefined) idsEstoque.add(id);
            tarefasEstoque.push(tarefa);
            return Promise.resolve();
          },
        }),
      }),
    esperar: () => Promise.reject(new Error('teste: nenhuma espera de Amazon aqui')),
    increment: (by) => FieldValue.increment(by),
    gerarExecucaoId: () => {
      execucoes += 1;
      return `${P}nova-${String(execucoes)}`;
    },
    // A recovery reads the stock valve first: `on` here, `*` (a feed's form).
    ambiente: () => ({
      ...AMBIENTE,
      [VALVULA_ENV_AMAZON.estoque]: 'on',
      [CANARIO_ENV_AMAZON.estoque]: '*',
    }),
  };
}

async function contexto(): Promise<ContextoLoteAmazon> {
  const log = loggerEspiao();
  const ctx = await loadAmazonContext(db(), CONTA, {
    ambiente: AMBIENTE,
    agora: () => Date.now(),
    logger: log.logger,
    fetch: () => Promise.reject(new Error('teste: nenhuma rede aqui')),
    gerarCorrelationId: () => 'corr-provedor-emulador',
  });
  return {
    contexto: ctx,
    db: db(),
    logger: log.logger,
    agora: () => Date.now(),
    sellerId: SPID_A,
    relogioVez: null,
    vez: null,
  };
}

function blocos(partes: number): TarefaEnviarFeedAmazon & { readonly fluxo: 'estoque' } {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'estoque',
    contaId: CONTA,
    execucaoId: EXEC,
    origem: 'reconciliacao',
    lote: { tipo: 'blocos', partes, esperaAteMs: Date.now() + 6 * 3_600_000 },
  }) as TarefaEnviarFeedAmazon & { readonly fluxo: 'estoque' };
}

beforeEach(async () => {
  if (!EMULATED) return;
  __resetAllReadCaches();
  tarefasEstoque = [];
  tarefasLote = [];
  await limpar();
  await semearConta();
});

afterAll(async () => {
  if (EMULATED) await limpar();
});

describe.skipIf(!EMULATED)('the stock feed provider on the emulator', () => {
  it('★ a BLOCK batch on the server: blocks by id, masked units, a gone unit and one with variations dropped, a kit root’s own member kept, a converged SKU dropped, the ERP’s quantity NOW', async () => {
    expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
    await produto('u-difere');
    await linha('u-difere', 10);
    await produto('u-convergiu');
    await linha('u-convergiu', 5);
    await produto('u-pai');
    await linha('u-pai', 3);
    await produto('u-pai-filho', { paiId: `${P}u-pai` });
    await produto('u-kit', { ehKit: true, filhoUnicoId: `${P}u-kit-membro` });
    await linha('u-kit', 6);
    await produto('u-kit-membro', { paiId: `${P}u-kit` });
    const item = (sku: string, unidade: string, quantidadeAmazon: number | null) => ({
      sku: `${P}${sku}`,
      unidadeId: `${P}${unidade}`,
      quantidadeAmazon,
      quantidadeErp: 1,
    });
    await gravarBlocoDivergenciaEstoqueAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      pagina: 0,
      depositoId: DEP,
      itens: [item('SKU-DIFERE', 'u-difere', 2), item('SKU-CONVERGIU', 'u-convergiu', 4)],
      agoraMs: Date.now(),
    });
    // Part 1 is missing (an empty block); part 2 holds the rest.
    await gravarBlocoDivergenciaEstoqueAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      pagina: 2,
      depositoId: DEP,
      itens: [
        item('SKU-SUMIU', 'u-sumiu', 2),
        item('SKU-PAI', 'u-pai', 1),
        item('SKU-KIT', 'u-kit', null),
      ],
      agoraMs: Date.now(),
    });
    const provedor = criarProvedorLoteEstoqueAmazon(raiz());
    const ctx = await contexto();
    const t = blocos(3);

    const membros = await provedor.membros(ctx, t);
    if ('abortado' in membros) throw new Error('membros abortados');
    expect(membros.skus).toEqual(
      ['SKU-CONVERGIU', 'SKU-DIFERE', 'SKU-KIT', 'SKU-PAI', 'SKU-SUMIU'].map((s) => `${P}${s}`),
    );
    const r = await provedor.montar(ctx, t, membros.skus, membros.dados);

    if ('abortado' in r) throw new Error(`abortada: ${r.abortado}`);
    expect(r.mensagens.map((x) => x.sku)).toEqual([`${P}SKU-DIFERE`, `${P}SKU-KIT`]);
    // The canonical row, quantity less its reservation: 10 − 1.
    expect(r.mensagens[0]?.patches[0]?.value?.[0]).toMatchObject({ quantity: 9 });
    expect(r.diff).toMatchObject({
      membros: 5,
      convergidos: 1,
      unidadesAusentes: 1,
      unidadesComVariacoes: 1,
    });
  });

  it('★ the feed’s write-back on real link documents: recusado with no quantity, under each document’s precondition; ONE aviso clocked by the write-back’s own link-doc read (a real Timestamp, after the stored outcome clock, before the writes)', async () => {
    await produto('p-link');
    for (const id of ['l1', 'l2']) {
      await db()
        .doc(`produtos/${P}p-link/prodAmazon/${id}`)
        .set({ contaAmazonOuterRef: REF_CONTA, sku: `${P}SKU-ERRO`, productDataJson: '{}' });
    }
    const relogio: Timestamp = (await db().doc(caminhoConta(CONTA)).get()).readTime;
    const provedor = criarProvedorLoteEstoqueAmazon(raiz());
    const emMs = Date.now() - 60_000;

    await provedor.gravarResultado(await contexto(), {
      problemas: new Map([
        [
          `${P}SKU-ERRO`,
          [
            {
              code: '90220',
              message: 'x',
              severity: 'ERROR',
              attributeNames: null,
              categories: null,
            },
          ],
        ],
      ]),
      emMs,
      feedId: FEED,
      relogio,
    });

    for (const id of ['l1', 'l2']) {
      const envio = (await db().doc(`produtos/${P}p-link/prodAmazon/${id}`).get()).data()
        ?.envioEstoqueAmazon as Record<string, unknown> | undefined;
      expect(envio).toMatchObject({
        via: 'feed',
        resultado: 'recusado',
        quantidade: null,
        emMs,
        feedId: FEED,
      });
    }
    const aviso = (
      await db()
        .doc(
          `avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon)}`,
        )
        .get()
    ).data();
    expect(aviso).toMatchObject({ resolvidoEm: null });
    const escritas = await Promise.all(
      ['l1', 'l2'].map(async (id) => {
        const t = (await db().doc(`produtos/${P}p-link/prodAmazon/${id}`).get()).updateTime;
        if (t === undefined) throw new Error('teste: o vínculo não existe');
        return relogioDoDocumentoUs(t);
      }),
    );
    const evento = aviso?.relogioEvento as number;
    expect(evento).toBeGreaterThan(relogioDoDocumentoUs(relogio));
    expect(evento).toBeLessThan(Math.min(...escritas));
  });

  it('★ a block batch’s failure recovered: ONE guarded automatic request (the run claimed, its first page enqueued); a second failure the same day refused, the feed aviso raised', async () => {
    const provedor = criarProvedorLoteEstoqueAmazon(raiz());
    const falha = {
      desfecho: 'falhou',
      snapshotEmMs: Date.now() - 60_000,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    } as const;

    expect(await provedor.recuperar(await contexto(), falha)).toEqual({
      repassado: 'reconciliacao',
    });
    const pedido = (await db().doc(PEDIDO).get()).data();
    expect(pedido).toMatchObject({ pendente: false, reexecucaoAutomaticaEmMs: expect.any(Number) });
    expect((await db().doc(RUN).get()).data()).toMatchObject({ execucaoId: `${P}nova-1` });
    expect(tarefasLote.map((x) => x.tipo)).toEqual(['reconciliacao']);

    await provedor.recuperar(await contexto(), { ...falha, referencia: '50003333334' });

    expect((await db().doc(PEDIDO).get()).data()?.reexecucaoAutomaticaEmMs).toBe(
      pedido?.reexecucaoAutomaticaEmMs,
    );
    expect(tarefasLote.map((x) => x.tipo)).toEqual(['reconciliacao']);
    const aviso = (
      await db()
        .doc(`avisos/${chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.feedEstoqueFalhou)}`)
        .get()
    ).data();
    expect(aviso).toMatchObject({ resolvidoEm: null });
    expect(tarefasEstoque).toEqual([]);
  });
});
