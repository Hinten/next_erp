/**
 * The order import (master plan steps 5 and 6, PR 5-c) against the REAL
 * Firestore of `ci-loja-integrada.yml`, in THIS process — the
 * `pedidos/pollPedidos.tasks.test.ts` shape: the read switch ON only as a
 * PARAMETER (`AMBIENTE_LIGADO`), the platform a scripted `fetch` handed to the
 * real context (`testing/pedidosLi.ts`), so nothing reaches Loja Integrada
 * (D17) and the setup's kill-switch stands behind it.
 *
 * What runs for real here: the context, the package client, the mappers, the
 * SKU rungs, the link-doc collection-group query, the conta's Loja Integrada
 * `int_frete` lookup and step 20's `mapa` helper (its union under
 * `lastUpdateTime`), the read of a mapped target by id and the freight aviso
 * clocked by it, the real `findOrCreateCliente` (the multi-document
 * read-and-write API the offline fake does not model) and `ensureEndereco`, the
 * ONE `WriteBatch` of the pedido and its pagamentos with its per-write
 * preconditions, the avisos and the incidentes.
 *
 * What it proves that the offline suite cannot:
 *  - the batch is atomic on the server: one commit time for the pedido and its
 *    pagamento, and a lost pedido precondition writes NO pagamento;
 *  - two importers interleaved past their reads converge on the newer stamp
 *    (contending on the `mapa` row too);
 *  - an operator's write between the read and the batch survives: the batch
 *    decided from the older snapshot would have overwritten it;
 *  - a crash before the batch — the `mapa` row, the cliente and the endereço
 *    already written, the batch not — and one after it each converge on the
 *    retry;
 *  - the freight routing: an unmapped key registered in the `mapa`, a mapped
 *    active target routed with its service id, an inactive one raising the
 *    aviso at the target read's time — and an order without an endereço
 *    taking its freight amount but no carrier route until a later import
 *    brings the endereço and fills it;
 *  - a stored endereço of ANOTHER cliente on a pedido without one: the real
 *    `findOrCreateCliente` resolves the buyer, and the import still fills no
 *    cliente beside it, routes nothing to it and raises the incidente — while
 *    the same endereço moved under the buyer's own cliente takes both; and a
 *    STORED cliente whose delivery endereço (read from the real nested map) is
 *    another cliente's takes no route until it is its own;
 *  - the code a batch answers for a document removed since its read under
 *    `lastUpdateTime`; that the CARRIER's precondition holds on a stale
 *    snapshot although its own write would change nothing; and what the carrier
 *    does to the pedido's update time — for a watermark that round-trips and
 *    for one stored as a double (both pinned as the emulator answers them);
 *  - the link lookup finds both stored ref forms through the real query;
 *  - the step-7 loop moves only the clocks;
 *  - a cancellation on a pedido whose `freteInicial.printLabelId` was written
 *    the way the Melhor Envio purchase writes it (a DOT PATH into the nested
 *    block) raises the reversal-after-the-label aviso (owner decision);
 *  - a PAID order without an address through the REAL notification pipeline's
 *    hot sweep (owner decision): the shared store's real mark keeps the row
 *    `failed` below the cap and PARKS it at the cap, and only then the
 *    exhaustion signal logs its ERROR line and raises the real aviso — with
 *    nothing of the pedido or a cliente written; a later import with a CEP
 *    the builder cannot read imports the pedido with no endereço and leaves
 *    the aviso OPEN (owner decision, 2026-10-20), and the next one that
 *    finds the address stores the endereço and closes it.
 *
 * ⚠️ The conta is seeded ONCE (an `integracao` write fires the conta trigger in
 * the functions emulator): no filial and no `dataCadastro`, so the core plans it
 * `incompleto` and only reads; its `int_frete` doc, seeded in every
 * `beforeEach`, mirrors the conta (tipo, `ativo`, the canonical back-ref, the
 * `nome`), so a trigger run finds nothing to patch. Its id is no other suite's.
 * Each `beforeEach` deletes what this file reads; `afterAll` removes the freight
 * docs BEFORE the conta, so the delete trigger finds nothing to deactivate.
 */
import { env } from 'node:process';
import {
  type DocumentData,
  type DocumentReference,
  FieldValue,
  type Firestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ViaCepClient } from '@delfrance/core/cep';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  INTEGRACAO_TIPO,
  MODALIDADE_FRETE,
  ORIGEM_NOTIFICACAO_LI,
  STATUS_PAGAMENTO,
  TIPO_AVISO,
  TIPO_TAREFA_LI,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { loadLojaIntegradaContext } from '../core/contexto';
import {
  MAX_TENTATIVAS,
  docIdNotificacaoLi,
  reprocessarNotificacoesLi,
  type DepsImportadorLi,
  type DepsTarefaLi,
  type PayloadNotificacaoLi,
} from '../notificacoes/notificacao';
import { AMBIENTE_LIGADO, credencialDoc, gravadorDeLog, ritmoFalso } from '../testing/fixtures';
import {
  CHAVE_FORMA_ENVIO_LI,
  CPF_VALIDO_LI,
  ID_ITEM_LI,
  ID_PAGAMENTO_LI,
  ID_PRODUTO_LI,
  NUMERO_LI,
  carimboLi,
  historicoPagoLi,
  linhaHistoricoLi,
  pedidoLiBruto,
  plataformaLi,
  type RespostaRoteirizadaLi,
} from '../testing/pedidosLi';
import { relogioDoDocumentoUs } from '../avisos/avisos';
import { chaveDoAvisoDeFreteLi, chaveDoAvisoDoPedidoLi } from './avisosPedidoLi';
import { dataLiParaMicros } from './dataLi';
import { __limparRegistrosUnicosParaTestes, importarPedidoLi } from './importarPedido';
import { ID_INCIDENTE_LI, idIncidenteLinhaLi } from './incidentesPedidoLi';
import { idPagamentoLi, idPedidoLi } from './orderIdsLi';

const EMULATED = Boolean(env.FIRESTORE_EMULATOR_HOST);

/** An obviously fake conta id, distinct from every other emulator suite's. */
const CONTA = 'conta-li-importador-ci';
const PEDIDO_ID = idPedidoLi(CONTA, NUMERO_LI);
const PAGAMENTO_ID = idPagamentoLi(CONTA, ID_PAGAMENTO_LI);
const INT_FRETE_LI = `lojaIntegrada-${CONTA}`;
/** The conta's `nome`: the seeded `int_frete` mirrors it (header). */
const NOME_CONTA = 'Loja de teste do importador';
/** A Melhor Envio target the `mapa` row can name, no other suite's. */
const ALVO_ME = 'me-alvo-importador-ci';
/** 2027-01-15T15:00:00Z. */
const AGORA_MS = Date.UTC(2027, 0, 15, 15, 0, 0);
/** A buyer with a check-digit-valid document: a cliente, and the endereço a route needs. */
const COMPRADOR_COM_CPF = { id: 1, nome: 'Comprador de Teste', cpf: CPF_VALIDO_LI };

function db(): Firestore {
  return getAdminFirestore();
}

/** The reads queue's failures-only store: the paid-without-address case seeds and sweeps one row of it. */
const NOTIFICACOES = 'notificacoesLojaIntegrada';

const refPedido = (): DocumentReference => db().collection('pedidos').doc(PEDIDO_ID);
const refPagamento = (): DocumentReference =>
  refPedido().collection('pagamentos').doc(PAGAMENTO_ID);
const refConta = (): DocumentReference => db().collection('integracao').doc(CONTA);

function payload(): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: CONTA,
    numero: String(NUMERO_LI),
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi: null,
  };
}

const viaCep: ViaCepClient = {
  buscarCep: () => Promise.reject(new Error('teste: nenhuma consulta de CEP esperada aqui')),
};

interface Cena {
  detalhe: DocumentData;
  historico: DocumentData[];
  produtos: Map<string, () => RespostaRoteirizadaLi>;
  antesDoProduto?: (id: string) => Promise<void> | void;
}

function cena(over: DocumentData = {}): Cena {
  return { detalhe: pedidoLiBruto(over), historico: historicoPagoLi(), produtos: new Map() };
}

/** A line that makes the import call Loja Integrada AFTER it read the pedido (the `id_externo` GET). */
function linhaComIdExterno(): DocumentData {
  const [linha] = pedidoLiBruto().itens as DocumentData[];
  return { ...linha, produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null };
}

async function importar(
  c: Cena,
  over: Partial<DepsImportadorLi> = {},
  banco: Firestore = db(),
): Promise<Awaited<ReturnType<typeof importarPedidoLi>>> {
  const { fetch } = plataformaLi({
    pedidos: new Map([[NUMERO_LI, () => c.detalhe]]),
    historicos: new Map([[NUMERO_LI, () => c.historico]]),
    produtosPorIdExterno: c.produtos,
    antesDoProduto: (id) => c.antesDoProduto?.(id),
  });
  const contexto = await loadLojaIntegradaContext(db(), CONTA, {
    ambiente: AMBIENTE_LIGADO,
    ritmo: ritmoFalso().ritmo,
    fetch,
    registro: { escrever: gravadorDeLog().escrever },
  });
  return importarPedidoLi(banco, contexto, payload(), {
    agoraMs: () => AGORA_MS,
    arrayUnion: (...e: unknown[]) => FieldValue.arrayUnion(...e),
    increment: (by: number) => FieldValue.increment(by),
    logger: { warn: () => undefined, info: () => undefined },
    viaCep,
    tentativa: 0,
    ...over,
  });
}

/** Each caller waits until `n` of them arrived: every one is then past its pedido read. */
function barreira(n: number): () => Promise<void> {
  let chegadas = 0;
  let liberar: () => void = () => undefined;
  const aberta = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return () => {
    chegadas += 1;
    if (chegadas === n) liberar();
    return aberta;
  };
}

function updateTimeDe(snap: { readonly updateTime?: Timestamp }): Timestamp {
  if (snap.updateTime === undefined) throw new Error('teste: documento ausente');
  return snap.updateTime;
}

const refFrete = (): DocumentReference => db().collection('int_frete').doc(INT_FRETE_LI);

async function limpar(): Promise<void> {
  for (const colecao of [
    'pedidos',
    'produtos',
    'avisos',
    'clientes',
    'clienteIdentidades',
    NOTIFICACOES,
  ]) {
    await db().recursiveDelete(db().collection(colecao));
  }
  await refFrete().delete();
  await db().collection('int_frete').doc(ALVO_ME).delete();
}

/** The conta's Loja Integrada `int_frete`, mirroring the conta (header), its `mapa` as given. */
async function semearIntFrete(mapa: DocumentData[] = []): Promise<void> {
  await refFrete().set({
    tipo: 'lojaIntegrada',
    nome: NOME_CONTA,
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: `documents/integracao/${CONTA}`,
    mapa,
    horarioDeCorte: null,
  });
}

/** A `mapa` row mapping the synthetic shipping method to the Melhor Envio target. */
function linhaMapeada(): DocumentData {
  return {
    nomeOriginal: 'Gateway de teste - Transportadora',
    idOriginal: CHAVE_FORMA_ENVIO_LI,
    observacao: 'Origem: Pedido 1',
    nomeTarget: null,
    targetData: { id: 2 },
    integracaoUid: ALVO_ME,
    targetTipoIntegracao: 'melhorEnvios',
  };
}

/**
 * The real Firestore, except that its NEXT batch commit rejects with `erro` —
 * the process dying right before the batch lands, after every earlier write.
 * Every other member is the real one, bound to it.
 */
function comLoteQueCai(real: Firestore, erro: Error): Firestore {
  let caiu = false;
  const ligado = (alvo: object, prop: string | symbol): unknown => {
    const valor: unknown = Reflect.get(alvo, prop, alvo);
    return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
  };
  return new Proxy(real, {
    get(alvo, prop) {
      if (prop !== 'batch') return ligado(alvo, prop);
      return () => {
        const lote = alvo.batch();
        if (caiu) return lote;
        caiu = true;
        return new Proxy(lote, {
          get(l, p) {
            return p === 'commit' ? () => Promise.reject(erro) : ligado(l, p);
          },
        });
      };
    },
  });
}

describe.skipIf(!EMULATED)('the Loja Integrada order import on real Firestore', () => {
  beforeAll(async () => {
    await limpar();
    await refConta().set({
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: NOME_CONTA,
      ativo: true,
      operacaoOuterRef: 'documents/operacoes/op-1',
      modalidadeFreteImportacao: null,
    });
    await refConta().collection('credenciaisLojaIntegrada').doc('current').set(credencialDoc());
  });

  beforeEach(async () => {
    __resetAllReadCaches();
    __limparRegistrosUnicosParaTestes();
    await limpar();
    await semearIntFrete();
  });

  afterEach(() => {
    __resetAllReadCaches();
  });

  afterAll(async () => {
    await limpar();
    await db().recursiveDelete(refConta());
  });

  it('create, then update: one commit time for the pedido and its pagamento, each time', async () => {
    const c = cena({
      situacao: { codigo: 'aguardando_pagamento', id: 2 },
      data_modificacao: carimboLi(1),
    });
    c.historico = [
      linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado'),
    ];
    expect(await importar(c)).toEqual({ kind: 'importado' });
    let pedido = await refPedido().get();
    let pagamento = await refPagamento().get();
    expect(pedido.exists).toBe(true);
    expect(pedido.data()).toMatchObject({
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      lastMarketplaceUpdate: dataLiParaMicros(carimboLi(1)),
    });
    expect(pagamento.data()).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.pendente,
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
    });
    // ONE commit: both documents carry the same update time.
    expect(updateTimeDe(pedido).isEqual(updateTimeDe(pagamento))).toBe(true);

    c.detalhe = pedidoLiBruto();
    c.historico = historicoPagoLi();
    expect(await importar(c)).toEqual({ kind: 'importado' });
    pedido = await refPedido().get();
    pagamento = await refPagamento().get();
    expect(pedido.data()).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: dataLiParaMicros(carimboLi(2)),
    });
    expect(pagamento.data()).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      lastProviderUpdate: dataLiParaMicros(carimboLi(2)),
    });
    expect(updateTimeDe(pedido).isEqual(updateTimeDe(pagamento))).toBe(true);
  });

  it('two importers, both past their reads before either commits, converge on the NEWER stamp', async () => {
    const chegar = barreira(2);
    const velho = cena({
      situacao: { codigo: 'aguardando_pagamento', id: 2 },
      data_modificacao: carimboLi(1),
      itens: [linhaComIdExterno()],
    });
    velho.historico = [
      linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado'),
    ];
    const novo = cena({ data_modificacao: carimboLi(5), itens: [linhaComIdExterno()] });
    velho.antesDoProduto = chegar;
    novo.antesDoProduto = chegar;

    const resultados = await Promise.all([importar(velho), importar(novo)]);
    expect(resultados.map((r) => r.kind)).toContain('importado');
    const pedido = (await refPedido().get()).data();
    expect(pedido).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: dataLiParaMicros(carimboLi(5)),
    });
    expect((await refPagamento().get()).data()).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      lastProviderUpdate: dataLiParaMicros(carimboLi(5)),
    });
  });

  it('an operator’s write between the read and the batch survives: the batch re-derives from it (frozen money kept)', async () => {
    const c = cena();
    await importar(c);
    // New Loja Integrada money: a batch decided from the OLD snapshot would write `valorCobrado`
    // over the operator's edit; only the abort and the re-derive from the frozen S′ keep it.
    c.detalhe = pedidoLiBruto({
      data_modificacao: carimboLi(5),
      valor_total: '120.00',
      itens: [linhaComIdExterno()],
    });
    let editou = false;
    c.antesDoProduto = async () => {
      if (editou) return;
      editou = true;
      await refPedido().update({ hasUserInteraction: true, valorCobrado: 99.9 });
    };
    expect(await importar(c)).toEqual({ kind: 'importado' });
    expect(editou).toBe(true);
    expect((await refPedido().get()).data()).toMatchObject({
      hasUserInteraction: true,
      valorCobrado: 99.9,
      lastMarketplaceUpdate: dataLiParaMicros(carimboLi(5)),
    });
  });

  it('a lost pedido precondition writes NO pagamento: a refund decided from the stale snapshot never lands', async () => {
    const c = cena();
    await importar(c);
    c.detalhe = pedidoLiBruto({
      situacao: { codigo: 'pagamento_devolvido_sem_retorno', id: 1020 },
      data_modificacao: carimboLi(5),
      itens: [linhaComIdExterno()],
    });
    c.historico = [
      ...historicoPagoLi(),
      linhaHistoricoLi(3, carimboLi(4), 'pagamento_devolvido_sem_retorno', 'pedido_pago'),
    ];
    let sincronizou = false;
    c.antesDoProduto = async () => {
      if (sincronizou) return;
      sincronizou = true;
      // The stock sync applies the removal between our read and our batch.
      await refPedido().update({
        estoqueAplicado: { depositoId: 'd1', ehSaida: true, removido: { 'p-x': 2 } },
      });
    };
    expect(await importar(c)).toEqual({ kind: 'importado' });
    // Had the stale batch landed in part, the payment would read `estornado`.
    expect((await refPagamento().get()).data()?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect((await refPedido().get()).data()?.estado).toBe(ESTADO_PEDIDO.pago);
    const aviso = await db()
      .collection('avisos')
      .doc(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoContestado, CONTA, PEDIDO_ID))
      .get();
    expect(aviso.data()).toMatchObject({ resolvidoEm: null, motivo: 'devolvido-sem-retorno' });
  });

  it('a crash BEFORE the batch (the network fails mid-import) writes neither; the retry converges', async () => {
    const c = cena({ itens: [linhaComIdExterno()] });
    c.produtos.set('321', () => {
      throw new TypeError('fetch failed');
    });
    await expect(importar(c)).rejects.toThrow();
    expect((await refPedido().get()).exists).toBe(false);
    expect((await refPagamento().get()).exists).toBe(false);

    c.produtos.set('321', () => ({ status: 404, corpo: { erro: 'nao encontrado' } }));
    expect(await importar(c)).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).exists).toBe(true);
    expect((await refPagamento().get()).exists).toBe(true);
  });

  it('a crash RIGHT BEFORE the batch — the mapa row, the cliente and the endereço already written — converges on the retry, with no twin', async () => {
    const c = cena({ cliente: { id: 1, nome: 'Comprador de Teste', cpf: CPF_VALIDO_LI } });
    const caiu = new Error('teste: o processo caiu antes do lote');
    await expect(importar(c, {}, comLoteQueCai(db(), caiu))).rejects.toBe(caiu);
    // Every write of steps 6 and 7 landed; the batch did not.
    expect((await refPedido().get()).exists).toBe(false);
    expect((await refPagamento().get()).exists).toBe(false);
    const mapa = (await refFrete().get()).data()?.mapa as DocumentData[];
    expect(mapa.map((l) => l.idOriginal)).toEqual([CHAVE_FORMA_ENVIO_LI]);
    const clientes = await db().collection('clientes').get();
    expect(clientes.size).toBe(1);
    const clienteDoc = clientes.docs[0]!;
    const enderecos = await clienteDoc.ref.collection('enderecos').get();
    expect(enderecos.size).toBe(1);

    __resetAllReadCaches();
    expect(await importar(c)).toEqual({ kind: 'importado' });
    const pedido = (await refPedido().get()).data()!;
    expect((await refPagamento().get()).exists).toBe(true);
    // The SAME cliente and endereço, and the mapa row once: each earlier write was idempotent.
    expect(pedido.clientePedidoOuterRef).toBe(`documents/clientes/${clienteDoc.id}`);
    expect(pedido.enderecoFiscalOuterRef).toBe(
      `documents/clientes/${clienteDoc.id}/enderecos/${enderecos.docs[0]!.id}`,
    );
    expect((await db().collection('clientes').get()).size).toBe(1);
    expect((await clienteDoc.ref.collection('enderecos').get()).size).toBe(1);
    expect(((await refFrete().get()).data()?.mapa as DocumentData[]).length).toBe(1);
  });

  it('a crash AFTER the batch (before the avisos) is healed: the retry is sem-mudanca and writes them', async () => {
    // The first WARNING of a run comes right after the batch: a FOB conta overridden to CIF.
    await refConta().update({ modalidadeFreteImportacao: MODALIDADE_FRETE.fob });
    __resetAllReadCaches();
    try {
      const c = cena();
      const morrerNoAviso: DepsImportadorLi['logger'] = {
        warn: (msg) => {
          if (msg.includes('CIF')) throw new Error('teste: o processo caiu depois do lote');
        },
      };
      await expect(importar(c, { logger: morrerNoAviso })).rejects.toThrow(/caiu depois do lote/);
      expect((await refPedido().get()).exists).toBe(true);
      expect((await refPagamento().get()).exists).toBe(true);
      const avisoHub = db()
        .collection('avisos')
        .doc(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoHub, CONTA, PEDIDO_ID));
      expect((await avisoHub.get()).exists).toBe(false);
      const incidentes = refPedido().collection('incidentes');
      expect((await incidentes.get()).empty).toBe(true);

      expect(await importar(c)).toEqual({ kind: 'sem-mudanca' });
      expect((await avisoHub.get()).data()?.resolvidoEm).not.toBeNull();
      expect((await incidentes.get()).docs.map((d) => d.id).sort()).toEqual(
        [ID_INCIDENTE_LI.clienteSemIdentidade, idIncidenteLinhaLi(String(ID_ITEM_LI))].sort(),
      );
      expect(((await refPedido().get()).data()?.freteInicial as DocumentData).modalidade).toBe(
        MODALIDADE_FRETE.cif,
      );
    } finally {
      await refConta().update({ modalidadeFreteImportacao: null });
    }
  });

  it('PIN: a batch whose update names a document removed since its read (lastUpdateTime) fails WHOLE — the code the emulator answers', async () => {
    const a = db().collection('pedidos').doc('pino-removido');
    const b = db().collection('pedidos').doc('pino-irmao');
    await a.create({ x: 1 });
    const lido = await a.get();
    await a.delete();
    const lote = db().batch();
    lote.update(a, { x: 2 }, { lastUpdateTime: updateTimeDe(lido) });
    lote.create(b, { y: 1 });
    const err: unknown = await lote.commit().catch((e: unknown) => e);
    expect(isGrpcStatusError(err)).toBe(true);
    // FAILED_PRECONDITION, as for a single update: the stamp replaces `exists`.
    expect((err as { code: number }).code).toBe(9);
    expect((await a.get()).exists).toBe(false);
    expect((await b.get()).exists).toBe(false);

    // And a create on an EXISTING document: ALREADY_EXISTS, the sibling not written.
    await b.create({ y: 0 });
    const outro = db().batch();
    outro.create(db().collection('pedidos').doc('pino-novo'), { z: 1 });
    outro.create(b, { y: 2 });
    const err2: unknown = await outro.commit().catch((e: unknown) => e);
    expect((err2 as { code: number }).code).toBe(6);
    expect((await db().collection('pedidos').doc('pino-novo').get()).exists).toBe(false);
  });

  it('PIN: the CARRIER keeps the pedido’s update time when its watermark round-trips; a watermark stored as a DOUBLE comes back re-typed', async () => {
    const c = cena();
    await importar(c);
    const watermark = dataLiParaMicros(carimboLi(2))!;

    // (1) An integer watermark: the carrier re-writes it unchanged.
    await refPagamento().delete();
    const antes = updateTimeDe(await refPedido().get());
    expect(await importar(c)).toEqual({ kind: 'importado' });
    const depois = await refPedido().get();
    expect(depois.data()?.lastMarketplaceUpdate).toBe(watermark);
    expect((await refPagamento().get()).exists).toBe(true);
    const intMantem = updateTimeDe(depois).isEqual(antes);

    // (2) The same instant stored as a DOUBLE (an integer plus two half increments).
    await refPedido().update({ lastMarketplaceUpdate: watermark - 1 });
    await refPedido().update({ lastMarketplaceUpdate: FieldValue.increment(0.5) });
    await refPedido().update({ lastMarketplaceUpdate: FieldValue.increment(0.5) });
    expect((await refPedido().get()).data()?.lastMarketplaceUpdate).toBe(watermark);
    await refPagamento().delete();
    const antesDouble = updateTimeDe(await refPedido().get());
    expect(await importar(c)).toEqual({ kind: 'importado' });
    const depoisDouble = updateTimeDe(await refPedido().get());
    const doubleMantem = depoisDouble.isEqual(antesDouble);

    // What the emulator answers, pinned. Nothing in the import relies on either.
    expect({ intMantem, doubleMantem }).toEqual({ intMantem: true, doubleMantem: false });
  });

  it('PIN: the CARRIER’s precondition holds on a STALE snapshot although its own write changes nothing — 9, and the pagamento it carries is not written', async () => {
    const c = cena();
    await importar(c);
    await refPagamento().delete();
    const lido = await refPedido().get();
    // Another writer changes the pedido after our read.
    await refPedido().update({ outroEscritor: 1 });
    const lote = db().batch();
    lote.update(
      refPedido(),
      { lastMarketplaceUpdate: lido.data()?.lastMarketplaceUpdate as number },
      { lastUpdateTime: updateTimeDe(lido) },
    );
    lote.create(refPagamento(), { valor: 1 });
    const err: unknown = await lote.commit().catch((e: unknown) => e);
    expect(isGrpcStatusError(err)).toBe(true);
    expect((err as { code: number }).code).toBe(9);
    expect((await refPagamento().get()).exists).toBe(false);
  });

  it('the freight routing: an unmapped key registered in the mapa, resolved at the int_frete read — no endereço, no route; the endereço later fills it; a mapped active target routed with its service id', async () => {
    const avisoFrete = db()
      .collection('avisos')
      .doc(chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI));
    // (1) Unmapped, and a buyer with no document (no cliente, no endereço): the union lands
    // and the aviso is decided, but the pedido gets its freight amount and NO carrier route.
    expect(await importar(cena())).toEqual({ kind: 'importado' });
    const mapa = (await refFrete().get()).data()?.mapa as DocumentData[];
    expect(mapa.map((l) => l.idOriginal)).toEqual([CHAVE_FORMA_ENVIO_LI]);
    expect((await refPedido().get()).data()?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: null,
      externalOptionId: null,
      externalOptionIntegracao: null,
      externalOptionData: null,
      enderecoFreteOuterReference: null,
      valorCobrado: 14.8,
      modalidade: MODALIDADE_FRETE.cif,
    });
    const resolvido = (await avisoFrete.get()).data();
    expect(resolvido?.resolvidoEm).not.toBeNull();
    expect(typeof resolvido?.relogioEvento).toBe('number');

    // (1b) The same order later, with the buyer's document: the endereço lands, and the
    // EMPTY route fills — the pedido now rides the conta's own Loja Integrada doc.
    __resetAllReadCaches();
    expect(
      await importar(cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) })),
    ).toEqual({ kind: 'importado' });
    const comEndereco = (await refPedido().get()).data()!;
    expect(comEndereco.enderecoFiscalOuterRef).toMatch(/^documents\/clientes\/[^/]+\/enderecos\//);
    expect(comEndereco.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/${INT_FRETE_LI}`,
      enderecoFreteOuterReference: comEndereco.enderecoFiscalOuterRef,
    });

    // (2) Mapped to an ACTIVE Melhor Envio target: routed, the service id beside it.
    await limpar();
    await semearIntFrete([linhaMapeada()]);
    const alvo = db().collection('int_frete').doc(ALVO_ME);
    await alvo.set({ tipo: 'melhorEnvios', ativo: true });
    const escritoEm = relogioDoDocumentoUs(updateTimeDe(await alvo.get()));
    __resetAllReadCaches();
    expect(await importar(cena({ cliente: COMPRADOR_COM_CPF }))).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).data()?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/${ALVO_ME}`,
      externalOptionId: '2',
    });
    const aviso = (await avisoFrete.get()).data();
    expect(aviso?.resolvidoEm).not.toBeNull();
    // Clocked by the TARGET read: never before the target's own last write.
    expect(aviso?.relogioEvento as number).toBeGreaterThanOrEqual(escritoEm);
  });

  it('the freight routing: a mapped INACTIVE target ⇒ the conta’s own doc, and the aviso RAISED at the target read', async () => {
    await semearIntFrete([linhaMapeada()]);
    const alvo = db().collection('int_frete').doc(ALVO_ME);
    await alvo.set({ tipo: 'melhorEnvios', ativo: false });
    const escritoEm = relogioDoDocumentoUs(updateTimeDe(await alvo.get()));
    expect(await importar(cena({ cliente: COMPRADOR_COM_CPF }))).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).data()?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/${INT_FRETE_LI}`,
      externalOptionId: null,
    });
    const aviso = (
      await db().collection('avisos').doc(chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)).get()
    ).data();
    expect(aviso).toMatchObject({ resolvidoEm: null, motivo: 'alvo-inativo' });
    expect(aviso?.relogioEvento as number).toBeGreaterThanOrEqual(escritoEm);
  });

  it('the real findOrCreateCliente and ensureEndereco: the buyer’s cliente, the recipient’s name on the endereço', async () => {
    const c = cena({
      cliente: {
        id: 1,
        nome: 'Comprador de Teste',
        cpf: CPF_VALIDO_LI,
        email: 'comprador@example.com',
      },
    });
    expect(await importar(c)).toEqual({ kind: 'importado' });
    const pedido = (await refPedido().get()).data()!;
    const clienteRef = pedido.clientePedidoOuterRef as string;
    expect(clienteRef).toMatch(/^documents\/clientes\/[^/]+$/);
    const cliente = await db().doc(clienteRef.slice('documents/'.length)).get();
    expect(cliente.data()).toMatchObject({ cpf_cnpj: '52998224725', nome: 'Comprador de Teste' });
    const enderecoRef = pedido.enderecoFiscalOuterRef as string;
    expect(enderecoRef.startsWith(`${clienteRef}/enderecos/`)).toBe(true);
    const endereco = await db().doc(enderecoRef.slice('documents/'.length)).get();
    expect(endereco.data()).toMatchObject({ nome: 'Recebedor de Teste', cpf_cnpj: null });
    expect((pedido.freteInicial as DocumentData).enderecoFreteOuterReference).toBe(enderecoRef);

    // A second order of the same buyer links the SAME cliente.
    __resetAllReadCaches();
    const outro = cena({
      numero: NUMERO_LI,
      cliente: { id: 1, nome: 'Comprador de Teste', cpf: CPF_VALIDO_LI },
      data_modificacao: carimboLi(3),
    });
    await refPedido().update({ clientePedidoOuterRef: null, enderecoFiscalOuterRef: null });
    await importar(outro);
    expect((await refPedido().get()).data()?.clientePedidoOuterRef).toBe(clienteRef);
  });

  it('never a cliente beside another cliente’s endereço: a stored endereço of ANOTHER owner keeps the pedido without cliente and route, plus the incidente; one under the buyer’s own cliente takes both', async () => {
    // An identity-less first import: no refs, no route.
    expect(await importar(cena())).toEqual({ kind: 'importado' });
    // Another writer stores an endereço under ANOTHER cliente; the pedido still has none.
    const deOutro = 'documents/clientes/cliente-de-outra-pessoa-ci/enderecos/end-a';
    await refPedido().update({ enderecoFiscalOuterRef: deOutro });

    // (1) The buyer now has a document: the real findOrCreateCliente resolves it — to
    // another cliente than the endereço's owner, so nothing is paired.
    __resetAllReadCaches();
    expect(
      await importar(cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) })),
    ).toEqual({ kind: 'importado' });
    let pedido = (await refPedido().get()).data()!;
    expect(pedido.clientePedidoOuterRef).toBeNull();
    expect(pedido.enderecoFiscalOuterRef).toBe(deOutro);
    expect(pedido.freteInicial).toMatchObject({
      integracaoFreteOuterRef: null,
      externalOptionId: null,
      externalOptionData: null,
      enderecoFreteOuterReference: null,
      valorCobrado: 14.8,
      modalidade: MODALIDADE_FRETE.cif,
    });
    const incidente = await refPedido()
      .collection('incidentes')
      .doc(ID_INCIDENTE_LI.enderecoDeOutroCliente)
      .get();
    expect(incidente.data()).toMatchObject({
      subtipo: 'li-endereco-de-outro-cliente',
      resolucao: null,
    });
    // The buyer's cliente exists (the step ran for real), with no endereço stored under it.
    const clientes = await db().collection('clientes').get();
    expect(clientes.docs.map((d) => d.data().cpf_cnpj)).toEqual(['52998224725']);
    const comprador = clientes.docs[0]!;
    expect((await comprador.ref.collection('enderecos').get()).empty).toBe(true);

    // (2) The endereço is moved under the BUYER's own cliente: the next import fills the
    // cliente beside it and routes the freight to it.
    const doComprador = `documents/clientes/${comprador.id}/enderecos/end-b`;
    await refPedido().update({ enderecoFiscalOuterRef: doComprador });
    __resetAllReadCaches();
    expect(
      await importar(cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(4) })),
    ).toEqual({ kind: 'importado' });
    pedido = (await refPedido().get()).data()!;
    expect(pedido.clientePedidoOuterRef).toBe(`documents/clientes/${comprador.id}`);
    expect(pedido.enderecoFiscalOuterRef).toBe(doComprador);
    expect(pedido.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/${INT_FRETE_LI}`,
      enderecoFreteOuterReference: doComprador,
    });
  });

  it('a STORED cliente beside its own fiscal endereço and a DELIVERY endereço of another cliente (read from the real nested map) ⇒ no route, both kept, the incidente; the delivery moved under the cliente ⇒ routed', async () => {
    expect(await importar(cena())).toEqual({ kind: 'importado' });
    const cliente = 'documents/clientes/cliente-ligado-ci';
    const fiscal = `${cliente}/enderecos/end-fiscal`;
    const deOutro = 'documents/clientes/cliente-de-outra-pessoa-ci/enderecos/end-entrega';
    await refPedido().update({
      clientePedidoOuterRef: cliente,
      enderecoFiscalOuterRef: fiscal,
      'freteInicial.enderecoFreteOuterReference': deOutro,
    });

    __resetAllReadCaches();
    expect(
      await importar(cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) })),
    ).toEqual({ kind: 'importado' });
    let pedido = (await refPedido().get()).data()!;
    expect(pedido.clientePedidoOuterRef).toBe(cliente);
    expect(pedido.enderecoFiscalOuterRef).toBe(fiscal);
    expect(pedido.freteInicial).toMatchObject({
      integracaoFreteOuterRef: null,
      externalOptionId: null,
      externalOptionData: null,
      enderecoFreteOuterReference: deOutro,
      valorCobrado: 14.8,
    });
    const incidente = await refPedido()
      .collection('incidentes')
      .doc(ID_INCIDENTE_LI.enderecoDeOutroCliente)
      .get();
    expect(incidente.data()?.motivoDoIncidente).toContain(
      'o endereço de entrega é de outro cliente, e não do cliente do pedido',
    );
    // The stored cliente: no cliente step ran, so no buyer cliente was created.
    expect((await db().collection('clientes').get()).empty).toBe(true);

    // The delivery endereço moved under the pedido's own cliente: the empty route fills.
    await refPedido().update({
      'freteInicial.enderecoFreteOuterReference': `${cliente}/enderecos/end-entrega`,
    });
    __resetAllReadCaches();
    expect(
      await importar(cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(4) })),
    ).toEqual({ kind: 'importado' });
    pedido = (await refPedido().get()).data()!;
    expect(pedido.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/${INT_FRETE_LI}`,
      enderecoFreteOuterReference: `${cliente}/enderecos/end-entrega`,
    });
  });

  it('the link lookup finds BOTH stored forms of the conta ref through the real collection-group query', async () => {
    const produtos = db().collection('produtos');
    await produtos.doc('p-canonico').set({ sku: 'sku-a', paiId: 'pai-x' });
    await produtos.doc('p-nu').set({ sku: 'sku-b', paiId: 'pai-x' });
    await produtos
      .doc('p-canonico')
      .collection('produtolojaintegrada')
      .doc('l1')
      .set({
        contaLojaIntegrada: `documents/integracao/${CONTA}`,
        id: ID_PRODUTO_LI,
        sku: 'sku-a',
      });
    await produtos
      .doc('p-nu')
      .collection('produtolojaintegrada')
      .doc('l2')
      .set({
        contaLojaIntegrada: `integracao/${CONTA}`,
        id: ID_PRODUTO_LI + 1,
        sku: 'sku-b',
      });
    const [linha] = pedidoLiBruto().itens as DocumentData[];
    const c = cena({
      itens: [
        {
          ...linha,
          id: 501,
          produto: `/api/v1/produto/${String(ID_PRODUTO_LI)}`,
          produto_pai: null,
        },
        {
          ...linha,
          id: 502,
          linha: 2,
          produto: `/api/v1/produto/${String(ID_PRODUTO_LI + 1)}`,
          produto_pai: null,
        },
      ],
      valor_subtotal: '200.00',
      valor_total: '214.80',
    });
    c.detalhe.pagamentos = [
      { ...(pedidoLiBruto().pagamentos as DocumentData[])[0], valor: '214.80' },
    ];
    await importar(c);
    const itens = (await refPedido().get()).data()?.itens as Record<string, DocumentData[]>;
    expect(Object.keys(itens).sort()).toEqual(['p-canonico', 'p-nu']);
  });

  it('the step-7 loop: a newer stamp with LI shipped and the same code moves only the clocks', async () => {
    const comCodigo = (horas: number) =>
      pedidoLiBruto({
        situacao: { codigo: 'pedido_enviado', id: 11 },
        data_modificacao: carimboLi(horas),
        envios: [{ ...(pedidoLiBruto().envios as DocumentData[])[0], objeto: 'AA000000000BR' }],
      });
    const c = cena();
    c.detalhe = comCodigo(2);
    c.historico = [
      ...historicoPagoLi(),
      linhaHistoricoLi(3, carimboLi(1, 500), 'pedido_enviado', 'pedido_pago'),
    ];
    await importar(c);
    const freteAntes = (await refPedido().get()).data()?.freteInicial as DocumentData;
    await refPedido().update({ freteInicial: { ...freteAntes, estado: ESTADO_FRETE.postado } });
    const antes = (await refPedido().get()).data()!;
    const pagamentoAntes = (await refPagamento().get()).data()!;

    c.detalhe = comCodigo(8);
    expect(await importar(c)).toEqual({ kind: 'importado' });
    const depois = (await refPedido().get()).data()!;
    const pagamentoDepois = (await refPagamento().get()).data()!;
    const semRelogios = (d: DocumentData, campos: string[]) =>
      Object.fromEntries(Object.entries(d).filter(([k]) => !campos.includes(k)));
    expect(semRelogios(depois, ['lastMarketplaceUpdate', 'ultimaModificacao'])).toEqual(
      semRelogios(antes, ['lastMarketplaceUpdate', 'ultimaModificacao']),
    );
    expect(depois.lastMarketplaceUpdate).toBe(dataLiParaMicros(carimboLi(8)));
    expect(semRelogios(pagamentoDepois, ['lastProviderUpdate', 'ultimaModificacao'])).toEqual(
      semRelogios(pagamentoAntes, ['lastProviderUpdate', 'ultimaModificacao']),
    );
    expect(pagamentoDepois.lastProviderUpdate).toBe(dataLiParaMicros(carimboLi(8)));
  });

  it('a cancellation landing after the Melhor Envio purchase’s own DOT-PATH write of printLabelId ⇒ the reversal and the open aviso; the same without a label raises none', async () => {
    const avisoReversao = db()
      .collection('avisos')
      .doc(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaReversaoComEtiqueta, CONTA, PEDIDO_ID));
    const cancelado = (): Cena => ({
      ...cena({ situacao: { codigo: 'pedido_cancelado', id: 8 }, data_modificacao: carimboLi(5) }),
      historico: [
        ...historicoPagoLi(),
        linhaHistoricoLi(3, carimboLi(4), 'pedido_cancelado', 'pedido_pago'),
      ],
    });

    // Without a label: the reversal, and no open row.
    expect(await importar(cena())).toEqual({ kind: 'importado' });
    __resetAllReadCaches();
    expect(await importar(cancelado())).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).data()?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    const semEtiqueta = (await avisoReversao.get()).data();
    expect(semEtiqueta === undefined || semEtiqueta.resolvidoEm !== null).toBe(true);

    // With a label, written the way the purchase writes it (a dot path into the block).
    await limpar();
    await semearIntFrete();
    __resetAllReadCaches();
    expect(await importar(cena())).toEqual({ kind: 'importado' });
    await refPedido().update({ 'freteInicial.printLabelId': 'etiqueta-ci-1' });
    __resetAllReadCaches();
    expect(await importar(cancelado())).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).data()?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect((await avisoReversao.get()).data()).toMatchObject({
      motivo: 'cancelado',
      params: { loja: NOME_CONTA, pedido: String(NUMERO_LI), motivo: 'cancelado' },
      relogioEvento: dataLiParaMicros(carimboLi(5)),
      resolvidoEm: null,
    });
  });

  it('on the REAL pipeline, a paid order without an address swept to the cap — the real row PARKED, the ERROR line, the open aviso, nothing of the pedido; an invalid CEP later imports and keeps it OPEN, and the address then resolves it', async () => {
    const p = payload();
    const linha = db().collection(NOTIFICACOES).doc(docIdNotificacaoLi(p));
    const avisoPago = db()
      .collection('avisos')
      .doc(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco, CONTA, PEDIDO_ID));
    const erros: unknown[][] = [];
    const semEndereco = cena({ cliente: COMPRADOR_COM_CPF, endereco_entrega: null });
    const { fetch } = plataformaLi({
      pedidos: new Map([[NUMERO_LI, () => semEndereco.detalhe]]),
      historicos: new Map([[NUMERO_LI, () => semEndereco.historico]]),
    });
    const deps: DepsTarefaLi = {
      ambiente: AMBIENTE_LIGADO,
      importador: importarPedidoLi,
      increment: (by: number) => FieldValue.increment(by),
      arrayUnion: (...e: unknown[]) => FieldValue.arrayUnion(...e),
      viaCep,
      agoraMs: () => AGORA_MS,
      esperar: () => Promise.resolve(),
      logger: {
        warn: () => undefined,
        info: () => undefined,
        error: (msg, meta) => {
          erros.push([msg, meta]);
        },
      },
      registro: {
        fluxo: 'intake',
        tentativa: null,
        idTarefa: null,
        escrever: gravadorDeLog().escrever,
      },
      fetch,
    };
    // As the queue's last attempt leaves it, one hot sweep short of the cap.
    await linha.set({
      ...p,
      status: 'failed',
      tentativas: MAX_TENTATIVAS - 2,
      erro: 'a última tentativa da fila',
      processedAt: 0,
    });

    // Below the cap: the real mark keeps it failed, and nothing is signalled.
    await reprocessarNotificacoesLi(db(), {}, deps);
    expect((await linha.get()).data()).toMatchObject({
      status: 'failed',
      tentativas: MAX_TENTATIVAS - 1,
    });
    expect(erros).toEqual([]);
    expect((await avisoPago.get()).exists).toBe(false);

    // The cap: parked by the shared store, THEN the signal — the line and the aviso.
    __resetAllReadCaches();
    await linha.update({ processedAt: 0 });
    const varredura = await reprocessarNotificacoesLi(db(), {}, deps);
    expect(varredura.errors.map((e) => e.docId)).toEqual([linha.id]);
    expect((await linha.get()).data()).toMatchObject({
      status: 'parked',
      tentativas: MAX_TENTATIVAS,
    });
    expect((await linha.get()).data()?.erro).toContain(String(NUMERO_LI));
    expect(erros).toHaveLength(1);
    expect(erros[0]![1]).toEqual({
      integracaoId: CONTA,
      numero: String(NUMERO_LI),
      pedidoId: PEDIDO_ID,
    });
    expect((await avisoPago.get()).data()).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
      severidade: 'critico',
      params: { loja: NOME_CONTA, pedido: String(NUMERO_LI) },
      relogioEvento: dataLiParaMicros(carimboLi(2)),
      resolvidoEm: null,
    });
    // Nothing of the order: no pedido, no cliente; the mapa row is the one write.
    expect((await refPedido().get()).exists).toBe(false);
    expect((await db().collection('clientes').get()).size).toBe(0);
    const mapa = (await refFrete().get()).data()?.mapa as DocumentData[];
    expect(mapa.map((l) => l.idOriginal)).toEqual([CHAVE_FORMA_ENVIO_LI]);

    // A CEP the builder cannot read: the pedido imports with no endereço and no route, and
    // the aviso stays OPEN — the winning snapshot holds no endereço (owner decision, 2026-10-20).
    __resetAllReadCaches();
    const invalido = { ...(pedidoLiBruto().endereco_entrega as DocumentData), cep: '0131010' };
    expect(
      await importar(
        cena({
          cliente: COMPRADOR_COM_CPF,
          endereco_entrega: invalido,
          data_modificacao: carimboLi(3),
        }),
      ),
    ).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).data()).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      enderecoFiscalOuterRef: null,
    });
    expect((await avisoPago.get()).data()).toMatchObject({
      relogioEvento: dataLiParaMicros(carimboLi(2)),
      resolvidoEm: null,
    });

    // The address is fixed in the painel: a newer change stores the endereço, and closes the row.
    __resetAllReadCaches();
    expect(
      await importar(cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(4) })),
    ).toEqual({ kind: 'importado' });
    expect((await refPedido().get()).data()?.estado).toBe(ESTADO_PEDIDO.pago);
    expect((await refPedido().get()).data()?.enderecoFiscalOuterRef).toMatch(
      /^documents\/clientes\//,
    );
    expect((await avisoPago.get()).data()).toMatchObject({
      relogioEvento: dataLiParaMicros(carimboLi(4)),
    });
    expect((await avisoPago.get()).data()?.resolvidoEm).not.toBeNull();
  });
});
