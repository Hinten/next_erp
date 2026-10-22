/**
 * The order import (master plan steps 5 and 6, PR 5-c) against
 * `testing/fakeDb.ts`, end to end in-process: the REAL context
 * (`loadLojaIntegradaContext`, switch on as a PARAMETER), the real package
 * client over a scripted platform (`testing/pedidosLi.ts`, never the network:
 * D17), the real mappers, the real SKU rungs, `mapa` registration, endereço
 * store, avisos and incidentes. One seam is mocked: `findOrCreateCliente`, which
 * runs the multi-document read-and-write API this fake does not model (and this
 * app never names); the emulator suite runs the real one.
 *
 * Every rule-7 case is here: a lost precondition re-derives the WHOLE batch (and
 * three give up), `obsoleto` writes nothing of any kind, a refusal comes before
 * any pedido or pagamento write, and a crash between the batch and the avisos
 * is healed by the retry.
 *
 * The last block runs the import as the step-3 pipeline WIRES it (PR 5-d): the
 * seam the roots read, the run's attempt reaching the history mode, the
 * classifier and the disposition — not the importer called by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ViaCepClient } from '@delfrance/core/cep';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  incidenteCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  ClienteSemIdentidadeForteError,
  findOrCreateCliente,
  type FindOrCreateClienteResult,
} from '@delfrance/data/admin/clientes';
import {
  LiHttpError,
  LiNotFoundError,
  LiSchemaError,
} from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  INTEGRACAO_FRETE,
  INTEGRACAO_TIPO,
  MODALIDADE_FRETE,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  MOTIVO_REVERSAO_COM_ETIQUETA_LI,
  ORIGEM_NOTIFICACAO_LI,
  STATUS_PAGAMENTO,
  TIPO_AVISO,
  TIPO_TAREFA_LI,
  chaveDeAviso,
  pedidoSchema,
  pagamentoSchema,
} from '@delfrance/schemas';

import { loadLojaIntegradaContext } from '../core/contexto';
import {
  MAX_TENTATIVAS,
  TASK_MAX_ATTEMPTS,
  docIdNotificacaoLi,
  importadorPedidoLi,
  reprocessarNotificacoesLi,
  tratarTarefaLeituraLi,
  type DepsImportadorLi,
  type DepsTarefaLi,
  type PayloadNotificacaoLi,
} from '../notificacoes/notificacao';
import { FakeDb, arrayUnion, asDb, grpc, increment, type DocData } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  caminhoConta,
  gravadorDeLog,
  loggerEspiao,
  ritmoFalso,
  seedCredencial,
} from '../testing/fixtures';
import { COLECAO_NOTIFICACOES_LI, seedNotificacaoLi } from '../testing/notificacoes';
import {
  CHAVE_FORMA_ENVIO_LI,
  CPF_VALIDO_LI,
  FORMA_ENVIO_LI,
  ID_ITEM_LI,
  ID_PAGAMENTO_LI,
  ID_PRODUTO_LI,
  ID_PRODUTO_PAI_LI,
  NUMERO_LI,
  SKU_LI,
  carimboLi,
  historicoPagoLi,
  linhaHistoricoLi,
  pedidoLiBruto,
  plataformaLi,
  type RespostaRoteirizadaLi,
  type RoteiroLi,
} from '../testing/pedidosLi';
import {
  MOTIVO_RESOLUCAO_PEDIDO_LI,
  avisarPedidoPagoSemEnderecoLi,
  chaveDoAvisoDeFreteLi,
  chaveDoAvisoDoPedidoLi,
} from './avisosPedidoLi';
import { enderecoDoPedidoLi, type EnderecoEntregaLi } from './clienteMapeamento';
import { dataLiParaMicros } from './dataLi';
import { LiPedidoEmConflitoError, MAX_TENTATIVAS_ESCRITA_PEDIDO_LI } from './escritaPedido';
import {
  LiHistoricoIncompletoError,
  __limparRegistrosUnicosParaTestes,
  clienteCanonicoLi,
  clienteDoEnderecoLi,
  ehPedidoDeHubLi,
  importarPedidoLi,
  vendaEncerradaLi,
} from './importarPedido';
import { ID_INCIDENTE_LI, SUBTIPO_INCIDENTE_LI, idIncidenteLinhaLi } from './incidentesPedidoLi';
import { idPagamentoLi, idPedidoLi } from './orderIdsLi';
import { LiPedidoPagoSemEnderecoError } from './pedidoPagoSemEndereco';

vi.mock('@delfrance/data/admin/clientes', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/data/admin/clientes')>();
  return { ...real, findOrCreateCliente: vi.fn() };
});

const CONTA = 'conta-li-importador';
const PEDIDO_ID = idPedidoLi(CONTA, NUMERO_LI);
const PAGAMENTO_ID = idPagamentoLi(CONTA, ID_PAGAMENTO_LI);
const CAMINHO_PEDIDO = `pedidos/${PEDIDO_ID}`;
const CAMINHO_PAGAMENTO = `${CAMINHO_PEDIDO}/pagamentos/${PAGAMENTO_ID}`;
const CAMINHO_INT_FRETE = `int_frete/lojaIntegrada-${CONTA}`;
const CLIENTE_ID = 'cliente-li-1';

const WATERMARK_2H = dataLiParaMicros(carimboLi(2))!;

/** A buyer with a check-digit-valid document: a cliente, and the endereço under it. */
const COMPRADOR_COM_CPF = { id: 1, nome: 'Comprador de Teste', cpf: CPF_VALIDO_LI };

function caminhoIncidente(id: string): string {
  return `${CAMINHO_PEDIDO}/incidentes/${id}`;
}

function caminhoAvisoDoPedido(
  tipo:
    | typeof TIPO_AVISO.lojaIntegradaSituacaoDesconhecida
    | typeof TIPO_AVISO.lojaIntegradaPedidoContestado
    | typeof TIPO_AVISO.lojaIntegradaPedidoHub,
): string {
  return `avisos/${chaveDoAvisoDoPedidoLi(tipo, CONTA, PEDIDO_ID)}`;
}

/* -------------------------------------------------------------------------- */
/*                                 the harness                                 */
/* -------------------------------------------------------------------------- */

function seedContaCompleta(db: FakeDb, over: DocData = {}): void {
  db.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja de teste',
    ativo: true,
    operacaoOuterRef: 'documents/operacoes/op-1',
    modalidadeFreteImportacao: null,
    ...over,
  });
  seedCredencial(db, CONTA);
}

function seedIntFrete(db: FakeDb, over: DocData = {}): void {
  db.seed(CAMINHO_INT_FRETE, {
    tipo: 'lojaIntegrada',
    nome: 'Loja de teste',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: `documents/integracao/${CONTA}`,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
    dataCadastro: 1,
    ultimaModificacao: 1,
    mapa: [],
    horarioDeCorte: null,
    ...over,
  });
}

/** A mapped `mapa` row for the synthetic shipping method. */
function linhaMapeada(alvoId: string, targetData: DocData | null = { id: 2 }): DocData {
  return {
    nomeOriginal: 'Gateway de teste - Transportadora',
    idOriginal: CHAVE_FORMA_ENVIO_LI,
    observacao: 'Origem: Pedido 1',
    nomeTarget: null,
    targetData,
    integracaoUid: alvoId,
    targetTipoIntegracao: 'melhorEnvios',
  };
}

function payload(over: Partial<PayloadNotificacaoLi> = {}): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: CONTA,
    numero: String(NUMERO_LI),
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi: carimboLi(2),
    ...over,
  };
}

/** Mutable script: a test edits `detalhe` / `historico` between imports. */
interface Cena {
  detalhe: DocData | RespostaRoteirizadaLi;
  historico: DocData[];
  produtos: Map<string, () => RespostaRoteirizadaLi>;
  antesDoProduto?: RoteiroLi['antesDoProduto'];
}

function cena(over: DocData = {}): Cena {
  return { detalhe: pedidoLiBruto(over), historico: historicoPagoLi(), produtos: new Map() };
}

function roteiroDe(c: Cena): RoteiroLi {
  return {
    pedidos: new Map([[NUMERO_LI, () => c.detalhe]]),
    historicos: new Map([[NUMERO_LI, () => c.historico]]),
    produtosPorIdExterno: c.produtos,
    antesDoProduto: (id) => c.antesDoProduto?.(id),
  };
}

const viaCepChamadas: string[] = [];
const viaCepFalso: ViaCepClient = {
  buscarCep: (cep) => {
    viaCepChamadas.push(cep);
    return Promise.resolve({
      logradouro: 'Rua do CEP',
      bairro: 'Bairro do CEP',
      cidade: 'Sao Paulo',
      estado: 'SP',
      codigoMunicipio: '3550308',
    });
  },
};

async function importar(
  db: FakeDb,
  c: Cena,
  over: Partial<DepsImportadorLi> = {},
): Promise<{
  readonly r: Awaited<ReturnType<typeof importarPedidoLi>>;
  readonly urls: string[];
  readonly avisosDeLog: unknown[][];
}> {
  const { fetch, urls } = plataformaLi(roteiroDe(c));
  const contexto = await loadLojaIntegradaContext(asDb(db), CONTA, {
    ambiente: AMBIENTE_LIGADO,
    ritmo: ritmoFalso().ritmo,
    registro: { escrever: gravadorDeLog().escrever },
    fetch,
  });
  const espiao = loggerEspiao();
  const r = await importarPedidoLi(asDb(db), contexto, payload(), {
    agoraMs: () => AGORA_MS,
    arrayUnion,
    increment,
    logger: espiao.logger,
    viaCep: viaCepFalso,
    tentativa: 0,
    ...over,
  });
  return { r, urls, avisosDeLog: espiao.chamadas };
}

const mockCliente = vi.mocked(findOrCreateCliente);

function clienteResolvido(clienteId = CLIENTE_ID): FindOrCreateClienteResult {
  return {
    clienteId,
    created: true,
    matchedBy: null,
    rejected: [],
    dropped: [],
    idMercadoLivreConflito: null,
  };
}

beforeEach(() => {
  __resetAllReadCaches();
  __limparRegistrosUnicosParaTestes();
  viaCepChamadas.length = 0;
  mockCliente.mockReset();
  // The channel rule: a document creates (or matches); no document and no match refuses.
  mockCliente.mockImplementation((_db, input) =>
    input.fields.cpf_cnpj === null
      ? Promise.reject(new ClienteSemIdentidadeForteError())
      : Promise.resolve(clienteResolvido()),
  );
});

afterEach(() => {
  __resetAllReadCaches();
});

function novoDb(): FakeDb {
  const db = new FakeDb();
  seedContaCompleta(db);
  return db;
}

/** The pedido doc, through its admin handle (another writer's writes). */
function refPedido(db: FakeDb) {
  return pedidoCollection.docRef(asDb(db), {}, PEDIDO_ID);
}

/** Delete the pagamento doc directly (an operator, a cleanup). */
async function apagarPagamento(db: FakeDb): Promise<void> {
  await pagamentoCollection.docRef(asDb(db), { pedidoId: PEDIDO_ID }, PAGAMENTO_ID).delete();
}

/**
 * Another writer that lands on the pedido right before each of the next
 * `vezes` batches — re-armed AFTER its own write, which would otherwise
 * consume the next hook in the queue.
 */
function escritorAntesDeCadaLote(db: FakeDb, vezes: number): void {
  let feitas = 0;
  const armar = () => {
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      feitas += 1;
      await refPedido(db).update({ outroEscritor: feitas });
      if (feitas < vezes) armar();
    });
  };
  armar();
}

/** The writes that landed on the pedido or one of its pagamentos. */
function escritasDoPedido(db: FakeDb) {
  return db.escritas.filter(
    (e) => e.caminho === CAMINHO_PEDIDO || e.caminho.startsWith(`${CAMINHO_PEDIDO}/pagamentos/`),
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the import                                 */
/* -------------------------------------------------------------------------- */

describe('a first import: the pedido and its pagamento in ONE batch', () => {
  it('creates both under one commit, parses as the schemas, and resolves the three order avisos', async () => {
    const db = novoDb();
    const { r, urls } = await importar(db, cena());
    expect(r).toEqual({ kind: 'importado' });

    // ONE batch, both creates.
    const escritas = escritasDoPedido(db);
    expect(escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['create', CAMINHO_PEDIDO],
      ['create', CAMINHO_PAGAMENTO],
    ]);
    expect(new Set(escritas.map((e) => e.lote))).toEqual(new Set([1]));

    const pedido = db.ler(CAMINHO_PEDIDO)!;
    expect(pedidoSchema.safeParse(pedido).success).toBe(true);
    expect(pedido).toMatchObject({
      ehSaida: true,
      numero: String(NUMERO_LI),
      estado: ESTADO_PEDIDO.pago,
      integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
      operacaoPedidoOuterRef: 'documents/operacoes/op-1',
      lastMarketplaceUpdate: WATERMARK_2H,
      valorCobrado: 114.8,
      descontoTotal: 0,
      error: null,
      // No strong identity (the synthetic buyer has no document): no refs.
      clientePedidoOuterRef: null,
      enderecoFiscalOuterRef: null,
    });
    const frete = pedido.freteInicial as DocData;
    expect(frete).toMatchObject({
      modalidade: MODALIDADE_FRETE.cif,
      estado: ESTADO_FRETE.despachoAutorizado,
      externalId: '801',
      // No Loja Integrada int_frete for the conta.
      integracaoFreteOuterRef: null,
      valorCobrado: 14.8,
    });
    expect(typeof frete.prazoDespacho).toBe('number');

    const pagamento = db.ler(CAMINHO_PAGAMENTO)!;
    expect(pagamentoSchema.safeParse(pagamento).success).toBe(true);
    expect(pagamento).toMatchObject({
      id: String(ID_PAGAMENTO_LI),
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 114.8,
      lastProviderUpdate: WATERMARK_2H,
      cartao: { tpIntegra: '2', bandeira: null, cAut: null },
    });

    // The three order-clocked avisos: each resolved, clocked by the order's stamp.
    for (const tipo of [
      TIPO_AVISO.lojaIntegradaSituacaoDesconhecida,
      TIPO_AVISO.lojaIntegradaPedidoContestado,
      TIPO_AVISO.lojaIntegradaPedidoHub,
    ] as const) {
      const aviso = db.ler(caminhoAvisoDoPedido(tipo));
      expect(aviso, tipo).toMatchObject({ relogioEvento: WATERMARK_2H });
      expect(aviso?.resolvidoEm, tipo).not.toBeNull();
    }

    // The unbound line and the identity-less buyer are incidentes.
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`).sort()).toEqual(
      [ID_INCIDENTE_LI.clienteSemIdentidade, idIncidenteLinhaLi(String(ID_ITEM_LI))].sort(),
    );
    expect(db.ler(caminhoIncidente(idIncidenteLinhaLi(String(ID_ITEM_LI))))).toMatchObject({
      subtipo: SUBTIPO_INCIDENTE_LI.produtoNaoVinculado,
      tipo: 'o',
      origem: 99,
      resolucao: null,
    });

    // The detail, then the history with its explicit limit. No produto GET: the line names an LI id.
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      '/v1/pedido/9001/',
      '/v1/situacao_historico/search/',
    ]);
    expect(new URL(urls[1]!).searchParams.get('limit')).toBe('50');
  });

  it('a second import at a NEWER stamp moves the estado and the pagamento in one batch of two updates', async () => {
    const db = novoDb();
    const c = cena({
      situacao: { codigo: 'aguardando_pagamento', id: 2 },
      data_modificacao: carimboLi(1),
    });
    c.historico = [
      linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado'),
    ];
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
    expect(db.ler(CAMINHO_PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.pendente);

    c.detalhe = pedidoLiBruto();
    c.historico = historicoPagoLi();
    const antes = db.escritas.length;
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    const novas = db.escritas.slice(antes).filter((e) => e.lote !== undefined);
    expect(novas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['update', CAMINHO_PEDIDO],
      ['update', CAMINHO_PAGAMENTO],
    ]);
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: WATERMARK_2H,
    });
    expect(db.ler(CAMINHO_PAGAMENTO)).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      lastProviderUpdate: WATERMARK_2H,
    });
  });

  it('an equal-stamp redelivery is sem-mudanca: no batch, the avisos rewritten as no-ops', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    const antes = db.escritas.length;
    expect((await importar(db, c)).r).toEqual({ kind: 'sem-mudanca' });
    expect(escritasDoPedido(db).length).toBe(2);
    expect(db.escritas.slice(antes).filter((e) => e.lote !== undefined)).toEqual([]);
  });
});

describe('obsoleto: a strictly newer stored stamp writes NOTHING of any kind', () => {
  it('no pedido, pagamento, mapa, cliente, endereço, incidente or aviso write — and no produto read', async () => {
    const db = novoDb();
    seedIntFrete(db);
    db.seed(CAMINHO_PEDIDO, {
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: WATERMARK_2H + 1,
    });
    const c = cena({ cliente: { nome: 'X', cpf: CPF_VALIDO_LI } });
    const antes = db.escritas.length;
    const { r, urls } = await importar(db, c);
    expect(r).toEqual({ kind: 'obsoleto' });
    expect(db.escritas.length).toBe(antes);
    expect(mockCliente).not.toHaveBeenCalled();
    expect(db.consultas.filter((q) => q.colecao === 'produtos' || q.grupo)).toEqual([]);
    expect(urls).toHaveLength(2);
  });
});

describe('import step 1: every refusal before any write', () => {
  it.each([
    ['a line with no id', { itens: [{ ...linhaPadrao(), id: '' }] }, 'itens[].id'],
    ['a shipment with no id', { envios: [{ ...envioPadrao(), id: null }] }, 'envios[].id'],
    ['a payment with no id', { pagamentos: [{ ...pagamentoPadrao(), id: '' }] }, 'pagamentos[].id'],
    ['a payment id of 0', { pagamentos: [{ ...pagamentoPadrao(), id: 0 }] }, 'pagamentos[].id'],
    [
      'a line with no price',
      { itens: [{ ...linhaPadrao(), preco_venda: null }] },
      'itens[].preco_venda',
    ],
    [
      'a payment with no valor',
      { pagamentos: [{ ...pagamentoPadrao(), valor: '' }] },
      'pagamentos[].valor',
    ],
    [
      'two lines with ONE id (one key, two lines)',
      { itens: [linhaPadrao(), { ...linhaPadrao(), linha: 2 }] },
      'itens[].id',
    ],
    [
      'two payments with ONE id (one document, two writes)',
      { pagamentos: [pagamentoPadrao(), { ...pagamentoPadrao(), valor: '1.00' }] },
      'pagamentos[].id',
    ],
    ['another numero', { numero: NUMERO_LI + 1 }, 'numero'],
    ['an unreadable stamp', { data_modificacao: '2027-01-10 12:00:00' }, 'data_modificacao'],
  ])('%s ⇒ a LiSchemaError naming its field, and zero writes', async (_nome, over, campo) => {
    // Steps 6 and 7 WOULD write here (the mapa row, the cliente, the endereço — the near-miss
    // below): the refusal must come before them, not merely before the batch.
    const db = dbQueEscreveAntesDoLote();
    const c = cena({ cliente: COMPRADOR_COM_CPF, ...(over as DocData) });
    const antes = db.escritas.length;
    const err: unknown = await importar(db, c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as LiSchemaError).campos).toContain(campo);
    expect(db.escritas.length).toBe(antes);
    expect(mockCliente).not.toHaveBeenCalled();
    expect(db.ler(CAMINHO_INT_FRETE)?.mapa).toEqual([]);
  });

  it('near-miss: the same fixture with a valid order writes the mapa row, resolves the cliente and stores the endereço', async () => {
    const db = dbQueEscreveAntesDoLote();
    expect((await importar(db, cena({ cliente: COMPRADOR_COM_CPF }))).r).toEqual({
      kind: 'importado',
    });
    expect(mockCliente).toHaveBeenCalledTimes(1);
    expect((db.ler(CAMINHO_INT_FRETE)?.mapa as DocData[]).length).toBe(1);
    expect(db.idsEm(`clientes/${CLIENTE_ID}/enderecos`)).toHaveLength(1);
  });

  it('a pedido body the schema refuses (a conta operação that is not a ref) ⇒ ZodError, zero pedido and zero pagamento', async () => {
    const db = new FakeDb();
    seedContaCompleta(db, { operacaoOuterRef: 'nao-e-um-ref' });
    const err: unknown = await importar(db, cena()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
    expect(db.idsEm(`${CAMINHO_PEDIDO}/pagamentos`)).toEqual([]);
    expect(escritasDoPedido(db)).toEqual([]);
  });
});

/** A conta with its Loja Integrada int_frete: an import with a documented buyer writes at steps 6 and 7. */
function dbQueEscreveAntesDoLote(): FakeDb {
  const db = novoDb();
  seedIntFrete(db);
  return db;
}

function linhaPadrao(): DocData {
  return (pedidoLiBruto().itens as DocData[])[0]!;
}
function envioPadrao(): DocData {
  return (pedidoLiBruto().envios as DocData[])[0]!;
}
function pagamentoPadrao(): DocData {
  return (pedidoLiBruto().pagamentos as DocData[])[0]!;
}

describe('import step 2: the history, strict on attempts 0 and 1 only', () => {
  const comLacuna = (): Cena => {
    const c = cena();
    // The detail says paid, the history never reaches it.
    c.historico = [
      linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado'),
    ];
    return c;
  };

  it.each([0, 1])(
    'attempt %i with a hole ⇒ LiHistoricoIncompletoError, zero writes',
    async (tentativa) => {
      const db = novoDb();
      const antes = db.escritas.length;
      const err: unknown = await importar(db, comLacuna(), { tentativa }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LiHistoricoIncompletoError);
      expect((err as LiHistoricoIncompletoError).lacunas).toEqual(['codigo-ausente']);
      expect(db.escritas.length).toBe(antes);
    },
  );

  it.each([2, null])(
    'attempt %s with the same hole ⇒ imported, the approval date null, a WARNING',
    async (tentativa) => {
      const db = novoDb();
      const { r, avisosDeLog } = await importar(db, comLacuna(), { tentativa });
      expect(r).toEqual({ kind: 'importado' });
      expect(db.ler(CAMINHO_PAGAMENTO)?.dataAprovacao).toBeNull();
      expect(JSON.stringify(avisosDeLog)).toContain('lacunas');
    },
  );
});

describe('the hub guard (D5)', () => {
  it('an id_anymarket ⇒ hub: no pedido, no pagamento, the hub aviso RAISED', async () => {
    const db = novoDb();
    const { r } = await importar(db, cena({ id_anymarket: 77 }));
    expect(r).toEqual({ kind: 'hub' });
    expect(escritasDoPedido(db)).toEqual([]);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toEqual([]);
    const aviso = db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub));
    expect(aviso).toMatchObject({ resolvidoEm: null, relogioEvento: WATERMARK_2H });
    expect(aviso?.params).toEqual({ loja: 'Loja de teste', pedido: String(NUMERO_LI) });
  });

  it('a raised hub row is RESOLVED by the next import WITHOUT a marker, at its newer stamp — which imports the order', async () => {
    const db = novoDb();
    const c = cena({ id_anymarket: 77 });
    expect((await importar(db, c)).r).toEqual({ kind: 'hub' });
    const caminho = caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub);
    expect(db.ler(caminho)).toMatchObject({ resolvidoEm: null, relogioEvento: WATERMARK_2H });

    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(3) });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)).toBeDefined();
    const aviso = db.ler(caminho)!;
    expect(aviso.resolvidoEm).not.toBeNull();
    expect(aviso.resolucaoMotivo).toBe('sem-marca-de-hub');
    expect(aviso.relogioEvento).toBe(dataLiParaMicros(carimboLi(3)));
  });

  it('near-miss: a late OLDER marker-free import cannot close a raised hub row (equal stamp: a no-op)', async () => {
    const db = novoDb();
    const c = cena({ id_anymarket: 77, data_modificacao: carimboLi(3) });
    await importar(db, c);
    // The same order, marker-free, at an OLDER stamp: nothing stored to call it obsoleto, so it
    // imports — and its clocked resolve is stale against the raise.
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(2) });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub))).toMatchObject({
      resolvidoEm: null,
      relogioEvento: dataLiParaMicros(carimboLi(3)),
    });
  });

  it('a hub order in a dead-sale codigo ⇒ hub, the aviso RESOLVED (nothing is left to import)', async () => {
    const db = novoDb();
    const c = cena({ id_anymarket: 77 });
    await importar(db, c);
    c.detalhe = pedidoLiBruto({
      id_anymarket: 77,
      situacao: { codigo: 'pedido_cancelado', id: 8 },
      data_modificacao: carimboLi(3),
    });
    c.historico = [linhaHistoricoLi(1, carimboLi(0, 100), 'pedido_cancelado', 'pedido_efetuado')];
    expect((await importar(db, c)).r).toEqual({ kind: 'hub' });
    expect(
      db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub))?.resolvidoEm,
    ).not.toBeNull();
    expect(escritasDoPedido(db)).toEqual([]);
  });

  it.each([
    ['a payment id of 0', { id: 0 }],
    ['a payment with no id', { id: null }],
    ['a payment with no valor', { valor: '' }],
  ])(
    '⚠️ a hub order whose payment carries %s ⇒ hub (the aviso), never a schema park: no key is built for it',
    async (_nome, over) => {
      const db = novoDb();
      const { r } = await importar(
        db,
        cena({
          pagamentos: [
            { ...pagamentoPadrao(), forma_pagamento: { codigo: 'PAGAMENTOEXTERNO' }, ...over },
          ],
        }),
      );
      expect(r).toEqual({ kind: 'hub' });
      expect(escritasDoPedido(db)).toEqual([]);
      expect(
        db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub))?.resolvidoEm,
      ).toBeNull();
    },
  );

  it('near-miss: the same payment WITHOUT a hub marker is refused before any write', async () => {
    const db = dbQueEscreveAntesDoLote();
    const antes = db.escritas.length;
    const err: unknown = await importar(
      db,
      cena({ cliente: COMPRADOR_COM_CPF, pagamentos: [{ ...pagamentoPadrao(), id: 0 }] }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(db.escritas.length).toBe(antes);
    expect(mockCliente).not.toHaveBeenCalled();
  });

  it('near-miss: an empty-text `id_anymarket` is the provider’s “nothing”, read through the wire schema ⇒ imported, no hub row raised', async () => {
    const db = novoDb();
    expect((await importar(db, cena({ id_anymarket: '' }))).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)).toBeDefined();
    expect(
      db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub))?.resolvidoEm,
    ).not.toBeNull();
  });

  it('the markers, pinned both ways', () => {
    const base = pedidoLiBruto();
    const ler = (over: DocData) =>
      ehPedidoDeHubLi(
        // The predicate over an ALREADY-parsed order (no wire schema here): `''` is pinned end to
        // end below, where the schema reads it as null.
        JSON.parse(JSON.stringify({ ...base, ...over })) as Parameters<typeof ehPedidoDeHubLi>[0],
      );
    expect(ler({ id_anymarket: null })).toBe(false);
    expect(ler({ id_anymarket: 0 })).toBe(true);
    expect(
      ler({
        pagamentos: [{ ...pagamentoPadrao(), forma_pagamento: { codigo: 'PAGAMENTOEXTERNO' } }],
      }),
    ).toBe(true);
    // Exact: another case is another codigo.
    expect(
      ler({
        pagamentos: [{ ...pagamentoPadrao(), forma_pagamento: { codigo: 'pagamentoexterno' } }],
      }),
    ).toBe(false);
    expect(vendaEncerradaLi('pedido_cancelado', false)).toBe(true);
    expect(vendaEncerradaLi('pedido_pago', true)).toBe(false);
    expect(vendaEncerradaLi('codigo_novo', false)).toBe(false);
  });
});

describe('the cliente and the endereço (import step 7)', () => {
  it('a buyer with a valid CPF ⇒ the cliente and the endereço refs, the recipient’s name on the endereço', async () => {
    const db = novoDb();
    const c = cena({
      cliente: {
        id: 1,
        nome: 'Comprador de Teste',
        cpf: CPF_VALIDO_LI,
        email: 'comprador@example.com',
      },
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(mockCliente).toHaveBeenCalledTimes(1);
    expect(mockCliente.mock.calls[0]?.[1].fields.cpf_cnpj).toBe('52998224725');
    const pedido = db.ler(CAMINHO_PEDIDO)!;
    expect(pedido.clientePedidoOuterRef).toBe(`documents/clientes/${CLIENTE_ID}`);
    const endereco = pedido.enderecoFiscalOuterRef as string;
    expect(endereco).toMatch(
      new RegExp(`^documents/clientes/${CLIENTE_ID}/enderecos/[0-9a-f]{40}$`),
    );
    // The freight block names the same endereço.
    expect((pedido.freteInicial as DocData).enderecoFreteOuterReference).toBe(endereco);
    const guardado = db.ler(endereco.slice('documents/'.length))!;
    expect(guardado).toMatchObject({ nome: 'Recebedor de Teste', cpf_cnpj: null, estado: 'SP' });
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      ID_INCIDENTE_LI.clienteSemIdentidade,
    );
  });

  it('a later run with the refs stored never resolves the cliente again', async () => {
    const db = novoDb();
    const c = cena({ cliente: { id: 1, nome: 'C', cpf: CPF_VALIDO_LI } });
    await importar(db, c);
    c.detalhe = pedidoLiBruto({
      cliente: { id: 1, nome: 'C', cpf: CPF_VALIDO_LI },
      data_modificacao: carimboLi(3),
    });
    await importar(db, c);
    expect(mockCliente).toHaveBeenCalledTimes(1);
  });

  it('⚠️ another writer links ANOTHER cliente between the read and the batch ⇒ the retry keeps it, and never pairs it with the endereço stored under ours', async () => {
    const db = novoDb();
    // The method maps to an active Melhor Envio target: only an endereço lets the route land.
    seedIntFrete(db, { mapa: [linhaMapeada('me-1')] });
    db.seed('int_frete/me-1', { tipo: 'melhorEnvios', ativo: true });
    // A first import with no identity: the pedido holds no refs.
    await importar(db, cena());
    expect(db.ler(CAMINHO_PEDIDO)?.clientePedidoOuterRef).toBeNull();
    mockCliente.mockClear();

    // Now the buyer has a document: step 7 resolves OUR cliente and stores the endereço under it.
    const c = cena({
      cliente: { id: 1, nome: 'C', cpf: CPF_VALIDO_LI },
      data_modificacao: carimboLi(3),
    });
    const outro = 'documents/clientes/cliente-de-outro-escritor';
    let ligou = false;
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      ligou = true;
      await refPedido(db).update({ clientePedidoOuterRef: outro });
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(ligou).toBe(true);
    expect(mockCliente).toHaveBeenCalledTimes(1);
    // Our endereço WAS stored (step 7 ran against S), under our cliente.
    expect(db.idsEm(`clientes/${CLIENTE_ID}/enderecos`)).toHaveLength(1);

    const pedido = db.ler(CAMINHO_PEDIDO)!;
    expect(pedido.clientePedidoOuterRef).toBe(outro);
    // Re-derived from S′: the endereço belongs to another person, so neither ref takes it —
    // and with no endereço the freight keeps its amount but takes no carrier route.
    expect(pedido.enderecoFiscalOuterRef).toBeNull();
    expect(pedido.freteInicial).toMatchObject({
      enderecoFreteOuterReference: null,
      integracaoFreteOuterRef: null,
      externalOptionId: null,
      externalOptionData: null,
      valorCobrado: 14.8,
    });
  });

  /** The pedido without its identity incidente (a migrated pedido never had one). */
  async function semIncidenteDeIdentidade(db: FakeDb): Promise<void> {
    await incidenteCollection
      .docRef(asDb(db), { pedidoId: PEDIDO_ID }, ID_INCIDENTE_LI.clienteSemIdentidade)
      .delete();
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      ID_INCIDENTE_LI.clienteSemIdentidade,
    );
  }

  it('⚠️ an identity-less buyer while another writer links a cliente between the read and the batch ⇒ NO “sem cliente” incidente on a pedido that holds one', async () => {
    const db = novoDb();
    await importar(db, cena());
    await semIncidenteDeIdentidade(db);
    const outro = 'documents/clientes/cliente-de-outro-escritor';
    let ligou = false;
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      ligou = true;
      await refPedido(db).update({ clientePedidoOuterRef: outro });
    });
    expect((await importar(db, cena({ data_modificacao: carimboLi(3) }))).r).toEqual({
      kind: 'importado',
    });
    expect(ligou).toBe(true);
    expect(db.ler(CAMINHO_PEDIDO)?.clientePedidoOuterRef).toBe(outro);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      ID_INCIDENTE_LI.clienteSemIdentidade,
    );
  });

  it('near-miss: the same identity-less import with no concurrent link ⇒ the incidente is raised', async () => {
    const db = novoDb();
    await importar(db, cena());
    await semIncidenteDeIdentidade(db);
    expect((await importar(db, cena({ data_modificacao: carimboLi(3) }))).r).toEqual({
      kind: 'importado',
    });
    expect(db.ler(CAMINHO_PEDIDO)?.clientePedidoOuterRef).toBeNull();
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toContain(
      ID_INCIDENTE_LI.clienteSemIdentidade,
    );
  });

  it('a transient failure of the cliente step is NOT “no identity”: it rethrows, and nothing of the pedido is written', async () => {
    const db = novoDb();
    mockCliente.mockRejectedValueOnce(grpc(14, 'UNAVAILABLE'));
    const err: unknown = await importar(db, cena({ cliente: COMPRADOR_COM_CPF })).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 14 });
    expect(escritasDoPedido(db)).toEqual([]);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toEqual([]);
  });

  it('a buyer whose CNPJ is invalid but whose CPF is valid ⇒ the cliente BY THE CPF: the mapper’s fallback reaches the cliente step', async () => {
    const db = novoDb();
    const c = cena({
      cliente: {
        ...COMPRADOR_COM_CPF,
        razao_social: 'Empresa de Teste',
        // One check digit off: no CNPJ at all.
        cnpj: '11.222.333/0001-80',
      },
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(mockCliente).toHaveBeenCalledTimes(1);
    expect(mockCliente.mock.calls[0]?.[1].fields).toMatchObject({
      cpf_cnpj: '52998224725',
      nome: 'Comprador de Teste',
    });
    expect(db.ler(CAMINHO_PEDIDO)?.clientePedidoOuterRef).toBe(`documents/clientes/${CLIENTE_ID}`);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      ID_INCIDENTE_LI.clienteSemIdentidade,
    );
  });

  it('near-miss: the same buyer with a VALID CNPJ ⇒ the cliente by the CNPJ, named by its razão social', async () => {
    const db = novoDb();
    const c = cena({
      cliente: {
        ...COMPRADOR_COM_CPF,
        razao_social: 'Empresa de Teste',
        cnpj: '11.222.333/0001-81',
      },
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(mockCliente.mock.calls[0]?.[1].fields).toMatchObject({
      cpf_cnpj: '11222333000181',
      nome: 'Empresa de Teste',
    });
  });

  it('an unknown estado ⇒ the CEP recovery, through the injected client', async () => {
    const db = novoDb();
    const c = cena({
      cliente: { id: 1, nome: 'C', cpf: CPF_VALIDO_LI },
      endereco_entrega: { ...(pedidoLiBruto().endereco_entrega as DocData), estado: 'Sao Paulo' },
    });
    await importar(db, c);
    expect(viaCepChamadas).toEqual(['01310100']);
    const endereco = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
    expect(db.ler(endereco.slice('documents/'.length))?.estado).toBe('SP');
  });

  it('no strong identity ⇒ the pedido without refs, plus the incidente', async () => {
    const db = novoDb();
    await importar(db, cena());
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      clientePedidoOuterRef: null,
      enderecoFiscalOuterRef: null,
    });
    expect(db.ler(caminhoIncidente(ID_INCIDENTE_LI.clienteSemIdentidade))).toMatchObject({
      subtipo: SUBTIPO_INCIDENTE_LI.clienteSemIdentidade,
    });
    // NEAR-MISS of the stored-endereço wording: this pedido holds no endereço either.
    expect(
      db.ler(caminhoIncidente(ID_INCIDENTE_LI.clienteSemIdentidade))?.motivoDoIncidente,
    ).toContain('ficou sem cliente e sem endereço.');
    // Nothing is stored to pair: no endereço incidente.
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      ID_INCIDENTE_LI.enderecoDeOutroCliente,
    );
  });
});

describe('the produto resolution (import step 5)', () => {
  function seedProduto(db: FakeDb, id: string, campos: DocData = {}): void {
    db.seed(`produtos/${id}`, { sku: `sku-${id}`, paiId: null, ...campos });
  }
  function seedVinculo(db: FakeDb, produtoId: string, idLi: number, forma = 'canonica'): void {
    db.seed(`produtos/${produtoId}/produtolojaintegrada/l-${produtoId}-${String(idLi)}`, {
      contaLojaIntegrada:
        forma === 'canonica' ? `documents/integracao/${CONTA}` : `integracao/${CONTA}`,
      id: idLi,
      sku: `sku-${produtoId}`,
    });
  }
  function itemGravado(db: FakeDb): DocData {
    const itens = db.ler(CAMINHO_PEDIDO)?.itens as Record<string, DocData[]>;
    return Object.values(itens).flat()[0]!;
  }

  it('the line’s Loja Integrada id through a link doc binds its owner — and no incidente', async () => {
    const db = novoDb();
    seedProduto(db, 'p-filho', { paiId: 'p-pai' });
    seedVinculo(db, 'p-filho', ID_PRODUTO_LI, 'nua');
    await importar(db, cena());
    expect(itemGravado(db)).toMatchObject({
      produtoUid: 'p-filho',
      mktplaceId: String(ID_PRODUTO_LI),
    });
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      idIncidenteLinhaLi(String(ID_ITEM_LI)),
    );
    const grupo = db.consultas.find((q) => q.grupo === true);
    expect(grupo?.filtros).toEqual([
      ['contaLojaIntegrada', 'in', [`documents/integracao/${CONTA}`, `integracao/${CONTA}`]],
      ['id', '==', ID_PRODUTO_LI],
    ]);
  });

  it('a família-de-um root owner binds its sole member; a kit root stays the root', async () => {
    const db = novoDb();
    seedProduto(db, 'p-raiz', { filhoUnicoId: 'p-membro' });
    seedProduto(db, 'p-membro', { paiId: 'p-raiz' });
    seedVinculo(db, 'p-raiz', ID_PRODUTO_LI);
    await importar(db, cena());
    expect(itemGravado(db).produtoUid).toBe('p-membro');

    const kit = novoDb();
    seedProduto(kit, 'p-kit', { filhoUnicoId: 'p-membro', ehKit: true });
    seedProduto(kit, 'p-membro', { paiId: 'p-kit' });
    seedVinculo(kit, 'p-kit', ID_PRODUTO_LI);
    await importar(kit, cena());
    expect(itemGravado(kit).produtoUid).toBe('p-kit');
  });

  it('two owners ⇒ unbound (ambiguous) with an incidente; two docs under ONE owner ⇒ bound', async () => {
    const db = novoDb();
    seedProduto(db, 'p-a', { paiId: 'x' });
    seedProduto(db, 'p-b', { paiId: 'x' });
    seedVinculo(db, 'p-a', ID_PRODUTO_LI);
    seedVinculo(db, 'p-b', ID_PRODUTO_LI);
    await importar(db, cena());
    expect(itemGravado(db).produtoUid).toBeNull();
    expect(
      db.ler(caminhoIncidente(idIncidenteLinhaLi(String(ID_ITEM_LI))))?.motivoDoIncidente,
    ).toContain('mais de um');

    const um = novoDb();
    seedProduto(um, 'p-a', { paiId: 'x' });
    seedVinculo(um, 'p-a', ID_PRODUTO_LI, 'canonica');
    um.seed(`produtos/p-a/produtolojaintegrada/outro`, {
      contaLojaIntegrada: `integracao/${CONTA}`,
      id: ID_PRODUTO_LI,
      sku: 's',
    });
    await importar(um, cena());
    expect(itemGravado(um).produtoUid).toBe('p-a');
  });

  it('the parent link scopes the SKU rung: a child with the line’s SKU under the linked parent binds', async () => {
    const db = novoDb();
    seedProduto(db, 'p-pai');
    seedProduto(db, 'p-filho', { paiId: 'p-pai', sku: SKU_LI });
    seedVinculo(db, 'p-pai', ID_PRODUTO_PAI_LI);
    await importar(db, cena());
    expect(itemGravado(db).produtoUid).toBe('p-filho');
  });

  it('an id_externo line: the SKU first, then the GET ⇒ the link docs', async () => {
    const db = novoDb();
    seedProduto(db, 'p-ext', { paiId: 'x' });
    seedVinculo(db, 'p-ext', 8001);
    const c = cena({
      itens: [
        { ...linhaPadrao(), produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null },
      ],
    });
    c.produtos.set('321', () => ({ status: 200, corpo: { id: 8001, sku: 'x' } }));
    const { urls } = await importar(db, c);
    expect(itemGravado(db)).toMatchObject({ produtoUid: 'p-ext', mktplaceId: '8001' });
    expect(urls.some((u) => new URL(u).pathname === '/v1/produto/321/')).toBe(true);
  });

  it.each([
    ['a 404', { status: 404, corpo: { erro: 'x' } }],
    ['a body that does not parse', { status: 200, corpo: { sem: 'id' } }],
  ])(
    'the id_externo GET answers %s ⇒ the LINE unbound with an incidente, the pedido imported',
    async (_nome, resposta) => {
      const db = novoDb();
      const c = cena({
        itens: [
          { ...linhaPadrao(), produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null },
        ],
      });
      c.produtos.set('321', () => resposta);
      expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
      expect(itemGravado(db).produtoUid).toBeNull();
      expect(
        db.ler(caminhoIncidente(idIncidenteLinhaLi(String(ID_ITEM_LI))))?.motivoDoIncidente,
      ).toContain('id externo');
    },
  );

  it('a 5xx on the id_externo GET is NOT the line’s: it rethrows, and no pedido is written', async () => {
    const db = novoDb();
    const c = cena({
      itens: [
        { ...linhaPadrao(), produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null },
      ],
    });
    c.produtos.set('321', () => ({ status: 503, corpo: { erro: 'x' } }));
    const { fetch, urls } = plataformaLi(roteiroDe(c));
    const contexto = await loadLojaIntegradaContext(asDb(db), CONTA, {
      ambiente: AMBIENTE_LIGADO,
      ritmo: ritmoFalso().ritmo,
      registro: { escrever: gravadorDeLog().escrever },
      fetch,
    });
    const err: unknown = await importarPedidoLi(asDb(db), contexto, payload(), {
      agoraMs: () => AGORA_MS,
      arrayUnion,
      increment,
      viaCep: viaCepFalso,
      tentativa: 0,
    }).catch((e: unknown) => e);
    // THE produto GET's own 503 — not a scripted 500 for a route nobody expected.
    expect(err).toBeInstanceOf(LiHttpError);
    expect(err).not.toBeInstanceOf(LiNotFoundError);
    expect((err as LiHttpError).status).toBe(503);
    expect(urls.some((u) => new URL(u).pathname === '/v1/produto/321/')).toBe(true);
    expect(escritasDoPedido(db)).toEqual([]);
  });

  /** The order with a SECOND line Loja Integrada added later (unbound: no link, no SKU match). */
  function comLinhaNova(horas: number): DocData {
    return pedidoLiBruto({
      data_modificacao: carimboLi(horas),
      itens: [
        linhaPadrao(),
        {
          ...linhaPadrao(),
          id: ID_ITEM_LI + 1,
          linha: 2,
          sku: 'sku-sem-produto',
          quantidade: '1.000',
          preco_venda: '10.0000',
          preco_subtotal: '10.0000',
          produto: '/api/v1/produto/7999',
          produto_pai: null,
        },
      ],
      valor_subtotal: '110.00',
      valor_total: '124.80',
      pagamentos: [{ ...pagamentoPadrao(), valor: '124.80', valor_pago: '124.80' }],
    });
  }
  const ID_LINHA_NOVA = String(ID_ITEM_LI + 1);

  it('⚠️ a FROZEN pedido does not take a line Loja Integrada added later: no incidente asks to bind a line it does not hold', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    await refPedido(db).update({ hasUserInteraction: true });

    c.detalhe = comLinhaNova(3);
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    const ids = Object.values(db.ler(CAMINHO_PEDIDO)?.itens as Record<string, DocData[]>)
      .flat()
      .map((l) => l.ensureUniqueId);
    expect(ids).toEqual([String(ID_ITEM_LI)]);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      idIncidenteLinhaLi(ID_LINHA_NOVA),
    );
    // The line the pedido DOES hold, still unbound, keeps its incidente.
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toContain(
      idIncidenteLinhaLi(String(ID_ITEM_LI)),
    );
  });

  it('near-miss: the same added line on a pedido NOT frozen is stored, and its incidente raised', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    c.detalhe = comLinhaNova(3);
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    const ids = Object.values(db.ler(CAMINHO_PEDIDO)?.itens as Record<string, DocData[]>)
      .flat()
      .map((l) => l.ensureUniqueId);
    expect(ids).toEqual([String(ID_ITEM_LI), ID_LINHA_NOVA]);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toContain(idIncidenteLinhaLi(ID_LINHA_NOVA));
  });

  it('a stored line already bound raises no incidente on a later unbound import', async () => {
    const db = novoDb();
    seedProduto(db, 'p-filho', { paiId: 'p-pai' });
    seedVinculo(db, 'p-filho', ID_PRODUTO_LI);
    await importar(db, cena());
    // The link is gone now; the stored line keeps its produto (append-only).
    db.seed(`produtos/p-filho/produtolojaintegrada/l-p-filho-${String(ID_PRODUTO_LI)}`, {
      contaLojaIntegrada: 'documents/integracao/outra-conta',
      id: ID_PRODUTO_LI,
      sku: 's',
    });
    const c = cena({ data_modificacao: carimboLi(3) });
    await importar(db, c);
    expect(itemGravado(db).produtoUid).toBe('p-filho');
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      idIncidenteLinhaLi(String(ID_ITEM_LI)),
    );
  });
});

describe('the freight routing and its aviso (import step 6)', () => {
  it('a mapped, active Melhor Envio target ⇒ routed, the service id beside it, the aviso resolved at the target read', async () => {
    const db = novoDb();
    seedIntFrete(db, { mapa: [linhaMapeada('me-1')] });
    db.seed('int_frete/me-1', { tipo: 'melhorEnvios', ativo: true });
    // A buyer with an endereço: an order without one takes no route (below).
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(db.ler(CAMINHO_PEDIDO)?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: 'documents/int_frete/me-1',
      externalOptionId: '2',
    });
    const aviso = db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`);
    expect(aviso?.resolvidoEm).not.toBeNull();
    expect(typeof aviso?.relogioEvento).toBe('number');
  });

  it('EQUAL pair: a Melhor Envio service stored as the number 2 or as the string `2` ⇒ the same route, `externalOptionId` `2`', async () => {
    for (const id of [2, '2']) {
      const db = novoDb();
      seedIntFrete(db, { mapa: [linhaMapeada('me-1', { id })] });
      db.seed('int_frete/me-1', { tipo: 'melhorEnvios', ativo: true });
      await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
      expect(db.ler(CAMINHO_PEDIDO)?.freteInicial, JSON.stringify(id)).toMatchObject({
        integracaoFreteOuterRef: 'documents/int_frete/me-1',
        externalOptionId: '2',
      });
      expect(
        db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`)?.resolvidoEm,
        JSON.stringify(id),
      ).not.toBeNull();
    }
  });

  it('⚠️ NEAR-MISS: a Melhor Envio service that is not a canonical positive integer (`02`, `0`, `2.0`, `1e3`) is NO service ⇒ the conta’s LI doc, the aviso RAISED `alvo-sem-servico`', async () => {
    for (const id of ['02', 0, '2.0', '1e3']) {
      const db = novoDb();
      seedIntFrete(db, { mapa: [linhaMapeada('me-1', { id })] });
      db.seed('int_frete/me-1', { tipo: 'melhorEnvios', ativo: true });
      await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
      expect(db.ler(CAMINHO_PEDIDO)?.freteInicial, JSON.stringify(id)).toMatchObject({
        integracaoFreteOuterRef: `documents/int_frete/lojaIntegrada-${CONTA}`,
        externalOptionId: null,
      });
      expect(
        db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`),
        JSON.stringify(id),
      ).toMatchObject({ resolvidoEm: null, motivo: 'alvo-sem-servico' });
    }
  });

  it('a motoboy target on a row that still carries a Melhor Envio service ⇒ routed to it with NO `externalOptionId`', async () => {
    const db = novoDb();
    seedIntFrete(db, { mapa: [linhaMapeada('moto-1', { id: 2 })] });
    db.seed('int_frete/moto-1', { tipo: 'motoboy', ativo: true });
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(db.ler(CAMINHO_PEDIDO)?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: 'documents/int_frete/moto-1',
      externalOptionId: null,
    });
  });

  it('an inactive target ⇒ the conta’s LI doc, the aviso RAISED with the motivo code', async () => {
    const db = novoDb();
    seedIntFrete(db, { mapa: [linhaMapeada('me-1')] });
    db.seed('int_frete/me-1', { tipo: 'melhorEnvios', ativo: false });
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(db.ler(CAMINHO_PEDIDO)?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/lojaIntegrada-${CONTA}`,
      externalOptionId: null,
    });
    const aviso = db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`);
    expect(aviso).toMatchObject({
      resolvidoEm: null,
      motivo: 'alvo-inativo',
      params: {
        loja: 'Loja de teste',
        chave: CHAVE_FORMA_ENVIO_LI,
        formaEnvio: 'Gateway de teste - Transportadora',
        motivo: 'alvo-inativo',
      },
    });
  });

  it('EQUAL pair: a mapped row whose target doc is ABSENT ⇒ the conta’s LI doc, the aviso RAISED `alvo-ausente`, after ONE read of that doc', async () => {
    const db = novoDb();
    seedIntFrete(db, { mapa: [linhaMapeada('me-404')] });
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(db.ler(CAMINHO_PEDIDO)?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/lojaIntegrada-${CONTA}`,
      externalOptionId: null,
    });
    expect(db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`)).toMatchObject({
      resolvidoEm: null,
      motivo: 'alvo-ausente',
    });
    expect(db.leituras.filter((l) => l === 'int_frete/me-404')).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: a mapped row whose uid names a target NO document can be (`..`) ⇒ the same `alvo-ausente`, with NO read of it', async () => {
    for (const uid of ['..', 'int_frete/..', '.']) {
      const db = novoDb();
      seedIntFrete(db, { mapa: [linhaMapeada(uid)] });
      await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
      expect(db.ler(CAMINHO_PEDIDO)?.freteInicial, uid).toMatchObject({
        integracaoFreteOuterRef: `documents/int_frete/lojaIntegrada-${CONTA}`,
        externalOptionId: null,
      });
      expect(
        db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`),
        uid,
      ).toMatchObject({ resolvidoEm: null, motivo: 'alvo-ausente' });
      // The shared row decision never hands such an id to a document read.
      expect(
        db.leituras.filter((l) => l.startsWith('int_frete/') && l !== CAMINHO_INT_FRETE),
        uid,
      ).toEqual([]);
    }
  });

  it('an unmapped method ⇒ registered in the mapa, the conta’s LI doc, the aviso resolved clocked by the int_frete read', async () => {
    const db = novoDb();
    seedIntFrete(db);
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    const mapa = db.ler(CAMINHO_INT_FRETE)?.mapa as DocData[];
    expect(mapa.map((l) => l.idOriginal)).toEqual([CHAVE_FORMA_ENVIO_LI]);
    expect(db.ler(CAMINHO_PEDIDO)?.freteInicial).toMatchObject({
      integracaoFreteOuterRef: `documents/int_frete/lojaIntegrada-${CONTA}`,
    });
    const aviso = db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`);
    expect(aviso?.resolvidoEm).not.toBeNull();
  });

  it('no Loja Integrada int_frete for the conta ⇒ no ref, and the aviso is left alone (no clock)', async () => {
    const db = novoDb();
    await importar(db, cena());
    expect(db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`)).toBeUndefined();
  });

  it('a conta configured FOB is overridden to CIF on an order with freight: ONE warning per conta', async () => {
    const db = new FakeDb();
    seedContaCompleta(db, { modalidadeFreteImportacao: MODALIDADE_FRETE.fob });
    const primeiro = await importar(db, cena());
    expect((db.ler(CAMINHO_PEDIDO)?.freteInicial as DocData).modalidade).toBe(MODALIDADE_FRETE.cif);
    expect(JSON.stringify(primeiro.avisosDeLog)).toContain('CIF');
    const segundo = await importar(db, cena({ data_modificacao: carimboLi(3) }));
    expect(JSON.stringify(segundo.avisosDeLog)).not.toContain('CIF');
  });
});

/** Every field a label is quoted or bought from, empty. */
const SEM_ROTA = {
  integracaoFreteOuterRef: null,
  externalOptionId: null,
  externalOptionIntegracao: null,
  externalOptionData: null,
} as const;
const ROTA_ME = {
  integracaoFreteOuterRef: 'documents/int_frete/me-1',
  externalOptionId: '2',
  externalOptionIntegracao: null,
  externalOptionData: { ...FORMA_ENVIO_LI },
} as const;

/** The conta's int_frete mapping the method to an ACTIVE Melhor Envio target. */
function dbComAlvo(): FakeDb {
  const db = novoDb();
  seedIntFrete(db, { mapa: [linhaMapeada('me-1')] });
  db.seed('int_frete/me-1', { tipo: 'melhorEnvios', ativo: true });
  return db;
}
function frete(db: FakeDb): DocData {
  return db.ler(CAMINHO_PEDIDO)?.freteInicial as DocData;
}

describe('⚠️ an order without an endereço: its freight amount, never a carrier route', () => {
  it('EQUAL: no cliente and no endereço ⇒ the amount, the modalidade and the rest of the block, no route — and the mapa registration still runs', async () => {
    const db = novoDb();
    seedIntFrete(db);
    expect((await importar(db, cena())).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef).toBeNull();
    expect(frete(db)).toMatchObject({
      ...SEM_ROTA,
      enderecoFreteOuterReference: null,
      valorCobrado: 14.8,
      modalidade: MODALIDADE_FRETE.cif,
      externalId: '801',
      estado: ESTADO_FRETE.despachoAutorizado,
    });
    expect(typeof frete(db).prazoDespacho).toBe('number');
    // The key is registered all the same (step 20), and its aviso decided.
    const mapa = db.ler(CAMINHO_INT_FRETE)?.mapa as DocData[];
    expect(mapa.map((l) => l.idOriginal)).toEqual([CHAVE_FORMA_ENVIO_LI]);
    expect(
      db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`)?.resolvidoEm,
    ).not.toBeNull();
    // The amount is kept, so the totals still add up.
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).not.toContain(
      ID_INCIDENTE_LI.totaisDivergentes,
    );
  });

  it('NEAR-MISS: the same order mapped to an active Melhor Envio target — no endereço ⇒ no route; the buyer’s endereço ⇒ the route', async () => {
    const sem = dbComAlvo();
    await importar(sem, cena());
    expect(frete(sem)).toMatchObject({ ...SEM_ROTA, valorCobrado: 14.8 });

    const com = dbComAlvo();
    await importar(com, cena({ cliente: COMPRADOR_COM_CPF }));
    const endereco = com.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
    expect(endereco).toMatch(/^documents\/clientes\//);
    expect(frete(com)).toMatchObject({
      ...ROTA_ME,
      enderecoFreteOuterReference: endereco,
      valorCobrado: 14.8,
    });
  });

  it('a route STORED by an operator, and still no endereço ⇒ the route is never cleared nor overwritten', async () => {
    const db = dbComAlvo();
    await importar(db, cena());
    const doOperador = {
      integracaoFreteOuterRef: 'documents/int_frete/me-9',
      externalOptionId: '7',
      externalOptionIntegracao: null,
      externalOptionData: { id: 7, nome: 'Escolha do operador' },
    };
    await refPedido(db).update({ freteInicial: { ...frete(db), ...doOperador } });

    // New Loja Integrada freight money at a newer stamp: the merge runs (not frozen).
    const c = cena({
      data_modificacao: carimboLi(3),
      valor_envio: '20.00',
      valor_total: '120.00',
      envios: [{ ...envioPadrao(), valor: '20.00' }],
      pagamentos: [{ ...pagamentoPadrao(), valor: '120.00', valor_pago: '120.00' }],
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(frete(db)).toMatchObject({ ...doOperador, valorCobrado: 20 });
  });

  it('a stored EMPTY route and the endereço present now ⇒ the route is filled as on a create', async () => {
    const db = dbComAlvo();
    await importar(db, cena());
    expect(frete(db)).toMatchObject(SEM_ROTA);

    await importar(db, cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) }));
    const endereco = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
    expect(endereco).toMatch(/^documents\/clientes\//);
    expect(frete(db)).toMatchObject({ ...ROTA_ME, enderecoFreteOuterReference: endereco });
  });

  it('⚠️ the same, after an operator SAVED the pedido (frozen) ⇒ the route AND the empty raw method fill; the operator’s money stays', async () => {
    const db = dbComAlvo();
    await importar(db, cena());
    expect(frete(db)).toMatchObject(SEM_ROTA);
    // Any operator save freezes the pedido — here a money edit on the block.
    await refPedido(db).update({
      hasUserInteraction: true,
      freteInicial: { ...frete(db), valorCobrado: 30 },
    });

    await importar(db, cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) }));
    const endereco = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
    expect(endereco).toMatch(/^documents\/clientes\//);
    expect(frete(db)).toMatchObject({
      ...ROTA_ME,
      enderecoFreteOuterReference: endereco,
      valorCobrado: 30,
    });
  });

  it('⚠️ NEAR-MISS: an operator RE-ROUTED the pedido on the pedido screen (which writes the method null) ⇒ the next import leaves the method empty beside the operator’s ref', async () => {
    const db = dbComAlvo();
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(frete(db)).toMatchObject(ROTA_ME);
    // What the Frete tab saves on a change of integração that had a quote.
    await refPedido(db).update({
      hasUserInteraction: true,
      freteInicial: {
        ...frete(db),
        integracaoFreteOuterRef: 'documents/int_frete/motoboy-1',
        externalOptionId: null,
        externalOptionIntegracao: null,
        externalOptionData: null,
      },
    });

    await importar(db, cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) }));
    expect(frete(db)).toMatchObject({
      integracaoFreteOuterRef: 'documents/int_frete/motoboy-1',
      externalOptionId: null,
      externalOptionData: null,
    });
  });

  it('NEAR-MISS: a frozen pedido whose raw method an earlier import STORED keeps it, though Loja Integrada now sends another', async () => {
    const db = dbComAlvo();
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(frete(db).externalOptionData).toEqual({ ...FORMA_ENVIO_LI });
    await refPedido(db).update({ hasUserInteraction: true });

    const outra = { ...FORMA_ENVIO_LI, nome: 'Gateway de teste (renomeado)' };
    await importar(
      db,
      cena({
        cliente: COMPRADOR_COM_CPF,
        data_modificacao: carimboLi(3),
        envios: [{ ...envioPadrao(), forma_envio: outra }],
      }),
    );
    expect(frete(db).externalOptionData).toEqual({ ...FORMA_ENVIO_LI });
  });
});

describe('⚠️ a re-import that replaces the stored method keeps the keys Loja Integrada does not own', () => {
  it('EQUAL: a label purchase’s agency beside the method survives a re-import that REPLACES the method (not frozen)', async () => {
    const db = dbComAlvo();
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF }));
    expect(frete(db)).toMatchObject(ROTA_ME);
    // What a Melhor Envio label purchase leaves: the agency beside the method.
    await refPedido(db).update({
      freteInicial: { ...frete(db), externalOptionData: { ...FORMA_ENVIO_LI, agency: 42 } },
    });

    const outra = { ...FORMA_ENVIO_LI, nome: 'Gateway de teste (renomeado)' };
    const c = cena({
      cliente: COMPRADOR_COM_CPF,
      data_modificacao: carimboLi(3),
      envios: [{ ...envioPadrao(), forma_envio: outra }],
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(frete(db).externalOptionData).toEqual({ ...outra, agency: 42 });
  });
});

describe('⚠️ a PAID order carrying NO CEP retries, then fails LOUDLY (owner decisions, 2026-10-19 and 2026-10-20)', () => {
  const CAMINHO_AVISO_PAGO = `avisos/${chaveDoAvisoDoPedidoLi(
    TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
    CONTA,
    PEDIDO_ID,
  )}`;
  /** A paid order (the fixture's) from a buyer WITH a document — only the address is missing. */
  const pagoSemEndereco = (over: DocData = {}) =>
    cena({ cliente: COMPRADOR_COM_CPF, endereco_entrega: null, ...over });
  /** An awaiting-payment order: `aguardando_pagamento`, its one history row. */
  const aguardando = (over: DocData = {}): Cena => ({
    ...cena({
      cliente: COMPRADOR_COM_CPF,
      endereco_entrega: null,
      situacao: { codigo: 'aguardando_pagamento', id: 2 },
      ...over,
    }),
    historico: [linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado')],
  });
  /** The conta's mapa routing the method to an active target of `tipo`. */
  function dbMapeadoPara(tipo: string): FakeDb {
    const db = novoDb();
    seedIntFrete(db, { mapa: [{ ...linhaMapeada('alvo-1', null), targetTipoIntegracao: tipo }] });
    db.seed('int_frete/alvo-1', { tipo, ativo: true });
    return db;
  }

  it('EQUAL: no endereco_entrega ⇒ the retryable error; the ONLY writes are about the conta’s configuration (the mapa registration, the freight aviso) — no cliente, endereço, pedido, pagamento, incidente or order aviso', async () => {
    const db = novoDb();
    seedIntFrete(db);
    const erro = await importar(db, pagoSemEndereco()).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LiPedidoPagoSemEnderecoError);
    expect((erro as LiPedidoPagoSemEnderecoError).pedido).toEqual({
      integracaoId: CONTA,
      lojaNome: 'Loja de teste',
      pedidoId: PEDIDO_ID,
      numero: String(NUMERO_LI),
      relogioUs: WATERMARK_2H,
    });
    expect(db.escritas.map((e) => e.caminho)).toEqual([
      CAMINHO_INT_FRETE,
      `avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`,
    ]);
    expect(mockCliente).not.toHaveBeenCalled();
  });

  it('⚠️ a refused order still gets the FREIGHT aviso its routing decided: mapped to an INACTIVE pickup, the operator learns why it does not route', async () => {
    const db = novoDb();
    seedIntFrete(db, {
      mapa: [{ ...linhaMapeada('alvo-1', null), targetTipoIntegracao: 'retiradaNaLoja' }],
    });
    db.seed('int_frete/alvo-1', { tipo: INTEGRACAO_FRETE.retiradaNaLoja, ativo: false });
    await expect(importar(db, pagoSemEndereco())).rejects.toBeInstanceOf(
      LiPedidoPagoSemEnderecoError,
    );
    expect(db.ler(`avisos/${chaveDoAvisoDeFreteLi(CONTA, CHAVE_FORMA_ENVIO_LI)}`)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
      resolvidoEm: null,
    });
    expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
  });

  it('EXEMPT: a paid order with NO shipment and no address imports — no freight block, nothing to label', async () => {
    const db = novoDb();
    seedIntFrete(db);
    const r = await importar(db, pagoSemEndereco({ envios: [] }));
    expect(r.r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(db.ler(CAMINHO_PEDIDO)?.freteInicial ?? null).toBeNull();
  });

  it('⚠️ ORDER OF ARRIVAL: a CEP-only order (no street) gets the SAME pedido first seen paid as first seen unpaid then paid — the builder’s endereço and the carrier route', async () => {
    const soCep = {
      ...(pedidoLiBruto().endereco_entrega as DocData),
      endereco: null,
    };
    const pagoPrimeiro = dbComAlvo();
    expect((await importar(pagoPrimeiro, pagoSemEndereco({ endereco_entrega: soCep }))).r).toEqual({
      kind: 'importado',
    });

    const aguardandoPrimeiro = dbComAlvo();
    await importar(aguardandoPrimeiro, aguardando({ endereco_entrega: soCep }));
    await importar(
      aguardandoPrimeiro,
      pagoSemEndereco({ endereco_entrega: soCep, data_modificacao: carimboLi(3) }),
    );

    for (const [nome, db] of [
      ['pago primeiro', pagoPrimeiro],
      ['aguardando primeiro', aguardandoPrimeiro],
    ] as const) {
      const endereco = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
      expect(endereco, nome).toMatch(/^documents\/clientes\//);
      expect(db.ler(CAMINHO_PEDIDO)?.estado, nome).toBe(ESTADO_PEDIDO.pago);
      expect(frete(db), nome).toMatchObject({ ...ROTA_ME, enderecoFreteOuterReference: endereco });
    }
  });

  it('⚠️ rule 7: the stored endereço CLEARED between the read and the batch ⇒ the retry re-asks and refuses; the paid update never lands without an address', async () => {
    const db = novoDb();
    await importar(db, aguardando({ endereco_entrega: pedidoLiBruto().endereco_entrega }));
    expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef).toMatch(/^documents\/clientes\//);
    const c = pagoSemEndereco({
      data_modificacao: carimboLi(3),
      // A line that makes the import call Loja Integrada after it read the pedido.
      itens: [
        { ...linhaPadrao(), produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null },
      ],
    });
    let limpou = false;
    c.antesDoProduto = async () => {
      if (limpou) return;
      limpou = true;
      await refPedido(db).update({
        enderecoFiscalOuterRef: null,
        freteInicial: { ...frete(db), enderecoFreteOuterReference: null },
      });
    };
    await expect(importar(db, c)).rejects.toBeInstanceOf(LiPedidoPagoSemEnderecoError);
    expect(limpou).toBe(true);
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('NEAR-MISS: a lost precondition that leaves the stored endereço in place ⇒ the retry lands the paid update as before', async () => {
    // The re-check is asked of each attempt's snapshot, and this one still holds it.
    const db = novoDb();
    await importar(db, aguardando({ endereco_entrega: pedidoLiBruto().endereco_entrega }));
    escritorAntesDeCadaLote(db, 1);
    const r = await importar(db, pagoSemEndereco({ data_modificacao: carimboLi(3) }));
    expect(r.r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
  });

  it('NEAR-MISS: a NEWER writer that cleared the endereço between the read and the batch ⇒ the retry is `obsoleto`, never a refusal of an observation the pedido already outran', async () => {
    const db = novoDb();
    await importar(db, aguardando({ endereco_entrega: pedidoLiBruto().endereco_entrega }));
    const maisNovo = dataLiParaMicros(carimboLi(5))!;
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      await refPedido(db).update({
        lastMarketplaceUpdate: maisNovo,
        enderecoFiscalOuterRef: null,
        freteInicial: { ...frete(db), enderecoFreteOuterReference: null },
      });
    });
    const r = await importar(db, pagoSemEndereco({ data_modificacao: carimboLi(3) }));
    expect(r.r).toEqual({ kind: 'obsoleto' });
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      lastMarketplaceUpdate: maisNovo,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    });
  });

  it('NEAR-MISS: a method NAMED like a pickup but mapped to a carrier is refused — the exemption is the routed target’s tipo, never the name', async () => {
    const db = dbMapeadoPara(INTEGRACAO_FRETE.motoboy);
    const retiradaNoNome = { ...FORMA_ENVIO_LI, nome: 'Retirada na loja', tipo: 'Retirada' };
    await expect(
      importar(
        db,
        pagoSemEndereco({ envios: [{ ...envioPadrao(), forma_envio: retiradaNoNome }] }),
      ),
    ).rejects.toBeInstanceOf(LiPedidoPagoSemEnderecoError);
    expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
  });

  it('EQUAL: an EMPTY block, or a CEP null, empty, BLANK (whitespace carries nothing) or the `-` placeholder, bare or padded (owner decision, 2026-10-20), carries no CEP either', async () => {
    const vazio = { ...(pedidoLiBruto().endereco_entrega as DocData) };
    for (const endereco_entrega of [
      {},
      { ...vazio, cep: null },
      { ...vazio, cep: '' },
      { ...vazio, cep: '   ' },
      { ...vazio, cep: '-' },
      { ...vazio, cep: ' - ' },
    ]) {
      const db = novoDb();
      await expect(
        importar(db, pagoSemEndereco({ endereco_entrega })),
        JSON.stringify(endereco_entrega),
      ).rejects.toBeInstanceOf(LiPedidoPagoSemEnderecoError);
      expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
    }
  });

  it('⚠️ NEAR-MISS (owner decision, 2026-10-20): an INVALID non-empty CEP — a MASKED one and the placeholder’s near-miss `--` included — is never refused: the paid order imports as one without an endereço: the amount and the modalidade, no route, no endereço', async () => {
    const comCep = (cep: string): DocData => ({
      ...(pedidoLiBruto().endereco_entrega as DocData),
      cep,
    });
    for (const cep of ['00000', 'abc', '0131-010', '013101000', '*****-***', '--']) {
      const db = dbComAlvo();
      const r = await importar(db, pagoSemEndereco({ endereco_entrega: comCep(cep) }));
      expect(r.r, cep).toEqual({ kind: 'importado' });
      // The cliente is resolved as for any order; no endereço is built, so no CEP lookup.
      expect(db.ler(CAMINHO_PEDIDO), cep).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        clientePedidoOuterRef: `documents/clientes/${CLIENTE_ID}`,
        enderecoFiscalOuterRef: null,
      });
      expect(frete(db), cep).toMatchObject({
        ...SEM_ROTA,
        enderecoFreteOuterReference: null,
        valorCobrado: 14.8,
        modalidade: MODALIDADE_FRETE.cif,
      });
      expect(
        db.escritas.some((e) => e.caminho.includes('/enderecos/')),
        cep,
      ).toBe(false);
      expect(viaCepChamadas, cep).toEqual([]);
    }
  });

  it('⚠️ ORDER OF ARRIVAL: an INVALID-CEP order gets the SAME pedido first seen paid as first seen unpaid then paid — no endereço, no route', async () => {
    const invalido = { ...(pedidoLiBruto().endereco_entrega as DocData), cep: '00000' };
    const pagoPrimeiro = dbComAlvo();
    expect(
      (await importar(pagoPrimeiro, pagoSemEndereco({ endereco_entrega: invalido }))).r,
    ).toEqual({ kind: 'importado' });

    const aguardandoPrimeiro = dbComAlvo();
    await importar(aguardandoPrimeiro, aguardando({ endereco_entrega: invalido }));
    expect(
      (
        await importar(
          aguardandoPrimeiro,
          pagoSemEndereco({ endereco_entrega: invalido, data_modificacao: carimboLi(3) }),
        )
      ).r,
    ).toEqual({ kind: 'importado' });

    for (const [nome, db] of [
      ['pago primeiro', pagoPrimeiro],
      ['aguardando primeiro', aguardandoPrimeiro],
    ] as const) {
      expect(db.ler(CAMINHO_PEDIDO), nome).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        enderecoFiscalOuterRef: null,
      });
      expect(frete(db), nome).toMatchObject({ ...SEM_ROTA, enderecoFreteOuterReference: null });
    }
  });

  it('NEAR-MISS: the same paid order WITH an address imports, routed', async () => {
    const db = dbComAlvo();
    expect((await importar(db, cena({ cliente: COMPRADOR_COM_CPF }))).r).toEqual({
      kind: 'importado',
    });
    expect(frete(db)).toMatchObject(ROTA_ME);
  });

  it('NEAR-MISS: an UNPAID order without an address imports as before — the amount, no route', async () => {
    const db = dbComAlvo();
    expect((await importar(db, aguardando())).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
    expect(frete(db)).toMatchObject({ ...SEM_ROTA, valorCobrado: 14.8 });
  });

  it('EXEMPT: a paid order whose method maps to a PICKUP imports without an address and KEEPS the pickup route', async () => {
    const db = dbMapeadoPara(INTEGRACAO_FRETE.retiradaNaLoja);
    expect((await importar(db, pagoSemEndereco())).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(frete(db)).toMatchObject({
      integracaoFreteOuterRef: 'documents/int_frete/alvo-1',
      externalOptionData: { ...FORMA_ENVIO_LI },
      enderecoFreteOuterReference: null,
    });
  });

  it('NEAR-MISS: the same order mapped to a MOTOBOY (an address to ride to) is refused', async () => {
    const db = dbMapeadoPara(INTEGRACAO_FRETE.motoboy);
    await expect(importar(db, pagoSemEndereco())).rejects.toBeInstanceOf(
      LiPedidoPagoSemEnderecoError,
    );
    expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
  });

  it('NEAR-MISS: an UNPAID pickup order without an address takes its pickup route too', async () => {
    const db = dbMapeadoPara(INTEGRACAO_FRETE.retiradaNaLoja);
    expect((await importar(db, aguardando())).r).toEqual({ kind: 'importado' });
    expect(frete(db).integracaoFreteOuterRef).toBe('documents/int_frete/alvo-1');
  });

  it('NEAR-MISS: a pedido that already STORES an endereço is no pedido without one — the paid update lands', async () => {
    const db = novoDb();
    await importar(db, aguardando({ endereco_entrega: pedidoLiBruto().endereco_entrega }));
    const endereco = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef;
    expect(endereco).toMatch(/^documents\/clientes\//);

    const r = await importar(db, pagoSemEndereco({ data_modificacao: carimboLi(3) }));
    expect(r.r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      enderecoFiscalOuterRef: endereco,
    });
  });

  it('NEAR-MISS: an UPDATE refused is refused whole — the stored unpaid pedido is not touched', async () => {
    const db = novoDb();
    await importar(db, aguardando());
    const antes = db.ler(CAMINHO_PEDIDO);
    const escritas = escritasDoPedido(db).length;
    await expect(
      importar(db, pagoSemEndereco({ data_modificacao: carimboLi(3) })),
    ).rejects.toBeInstanceOf(LiPedidoPagoSemEnderecoError);
    expect(escritasDoPedido(db)).toHaveLength(escritas);
    expect(db.ler(CAMINHO_PEDIDO)).toEqual(antes);
  });

  it('a later import that FINDS the address imports and resolves the aviso; a late OLDER one cannot', async () => {
    const db = novoDb();
    await avisarPedidoPagoSemEnderecoLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja de teste',
        pedidoId: PEDIDO_ID,
        numero: String(NUMERO_LI),
        relogioUs: WATERMARK_2H,
      },
      { increment, nowMs: AGORA_MS },
    );
    expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).toBeNull();

    // Older than the raise: imports (it has the address), but cannot close the row.
    await importar(db, cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(1) }));
    expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).toBeNull();

    const r = await importar(
      db,
      cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) }),
    );
    expect(r.r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_AVISO_PAGO)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_PEDIDO_LI.pedidoImportado,
    });
    expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).not.toBeNull();
  });

  describe('⚠️ an INVALID CEP keeps the aviso OPEN; it closes only once the pedido has its delivery endereço, a pickup route, or is no longer paid (owner decision, 2026-10-20)', () => {
    const INVALIDO = { ...(pedidoLiBruto().endereco_entrega as DocData), cep: '0131010' };
    /** An endereço an operator linked by hand, stored under the pedido's cliente. */
    const DO_OPERADOR = `documents/clientes/${CLIENTE_ID}/enderecos/do-operador`;
    /** An endereço stored under ANOTHER cliente: the import cannot pair it, so it fills none. */
    const DE_OUTRO = 'documents/clientes/cliente-de-outra-pessoa/enderecos/end-a';

    async function levantarAvisoPago(db: FakeDb): Promise<void> {
      await avisarPedidoPagoSemEnderecoLi(
        asDb(db),
        {
          integracaoId: CONTA,
          lojaNome: 'Loja de teste',
          pedidoId: PEDIDO_ID,
          numero: String(NUMERO_LI),
          relogioUs: WATERMARK_2H,
        },
        { increment, nowMs: AGORA_MS },
      );
      expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).toBeNull();
    }
    function escritasDoAvisoPago(db: FakeDb): number {
      return db.escritas.filter((e) => e.caminho === CAMINHO_AVISO_PAGO).length;
    }
    function resolvido(db: FakeDb): void {
      expect(db.ler(CAMINHO_AVISO_PAGO)).toMatchObject({
        resolucaoMotivo: MOTIVO_RESOLUCAO_PEDIDO_LI.pedidoImportado,
        relogioEvento: dataLiParaMicros(carimboLi(3)),
      });
      expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).not.toBeNull();
    }

    it('EQUAL: a later import with an INVALID CEP and no stored endereço imports (no endereço, no route) and leaves the aviso OPEN — not one write to it', async () => {
      const db = dbComAlvo();
      await levantarAvisoPago(db);
      const antes = db.ler(CAMINHO_AVISO_PAGO);
      const escritas = escritasDoAvisoPago(db);

      // The customer typed a CEP the builder cannot read: past the no-CEP check, so it imports.
      const r = await importar(
        db,
        pagoSemEndereco({ endereco_entrega: INVALIDO, data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        enderecoFiscalOuterRef: null,
      });
      expect(frete(db)).toMatchObject({ ...SEM_ROTA, enderecoFreteOuterReference: null });
      expect(escritasDoAvisoPago(db)).toBe(escritas);
      expect(db.ler(CAMINHO_AVISO_PAGO)).toEqual(antes);
    });

    it('EQUAL: the same import with no row yet raises nothing and seeds nothing — the import is no raiser', async () => {
      const db = dbComAlvo();
      const r = await importar(
        db,
        pagoSemEndereco({ endereco_entrega: INVALIDO, data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      expect(db.ler(CAMINHO_AVISO_PAGO)).toBeUndefined();
    });

    it('⚠️ EQUAL (owner decision, 2026-10-20): a later observation with NO shipment, onto a pedido that holds no endereço, imports and leaves the aviso OPEN — the freight block an earlier observation stored stays as it was', async () => {
      const db = dbComAlvo();
      await importar(db, aguardando({ data_modificacao: carimboLi(1) }));
      const blocoAntes = frete(db);
      expect(blocoAntes).toMatchObject({ ...SEM_ROTA, enderecoFreteOuterReference: null });
      await levantarAvisoPago(db);
      const antes = db.ler(CAMINHO_AVISO_PAGO);
      const escritas = escritasDoAvisoPago(db);

      // Not refused (no shipment, nothing to label), and still no address to ship the block to.
      const r = await importar(db, pagoSemEndereco({ envios: [], data_modificacao: carimboLi(3) }));
      expect(r.r).toEqual({ kind: 'importado' });
      expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        enderecoFiscalOuterRef: null,
      });
      expect(frete(db)).toEqual(blocoAntes);
      expect(escritasDoAvisoPago(db)).toBe(escritas);
      expect(db.ler(CAMINHO_AVISO_PAGO)).toEqual(antes);
    });

    it('NEAR-MISS: the same observation with NO shipment and a VALID CEP stores the endereço and resolves it', async () => {
      const db = dbComAlvo();
      await importar(db, aguardando({ data_modificacao: carimboLi(1) }));
      await levantarAvisoPago(db);
      const r = await importar(
        db,
        cena({ cliente: COMPRADOR_COM_CPF, envios: [], data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      resolvido(db);
      expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef).toMatch(/^documents\/clientes\//);
    });

    it('⚠️ EQUAL (owner decision, 2026-10-20): a VALID CEP from a buyer with NO valid document stores no endereço — there is no cliente to store it under — and leaves the aviso OPEN, beside the cliente-sem-identidade incidente', async () => {
      const db = dbComAlvo();
      await levantarAvisoPago(db);
      const antes = db.ler(CAMINHO_AVISO_PAGO);
      const escritas = escritasDoAvisoPago(db);

      // The fixture's buyer carries no document; its CEP is one the builder reads.
      expect(
        enderecoDoPedidoLi(pedidoLiBruto().endereco_entrega as EnderecoEntregaLi).kind,
      ).not.toBe('sem-cep');
      const r = await importar(db, cena({ data_modificacao: carimboLi(3) }));
      expect(r.r).toEqual({ kind: 'importado' });
      expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        clientePedidoOuterRef: null,
        enderecoFiscalOuterRef: null,
      });
      expect(db.ler(caminhoIncidente(ID_INCIDENTE_LI.clienteSemIdentidade))).toMatchObject({
        subtipo: SUBTIPO_INCIDENTE_LI.clienteSemIdentidade,
      });
      expect(escritasDoAvisoPago(db)).toBe(escritas);
      expect(db.ler(CAMINHO_AVISO_PAGO)).toEqual(antes);
    });

    it('NEAR-MISS: an INVALID CEP on a pedido that already STORES an endereço resolves the aviso — and that endereço is not overwritten', async () => {
      const db = dbComAlvo();
      await importar(db, aguardando({ data_modificacao: carimboLi(1) }));
      await refPedido(db).update({ enderecoFiscalOuterRef: DO_OPERADOR });
      await levantarAvisoPago(db);

      const r = await importar(
        db,
        pagoSemEndereco({ endereco_entrega: INVALIDO, data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      resolvido(db);
      expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        enderecoFiscalOuterRef: DO_OPERADOR,
      });
      expect(
        db.escritas.some((e) => e.caminho.includes('/enderecos/')),
        'no endereço written',
      ).toBe(false);
    });

    it('⚠️ NEAR-MISS: a VALID CEP on a pedido that already STORES an endereço resolves the aviso and never overwrites it — nothing is built from this observation, and the route goes to the STORED endereço', async () => {
      // The invalid-CEP twin above has no endereço to overwrite with; this one does.
      const db = dbComAlvo();
      await importar(db, aguardando({ data_modificacao: carimboLi(1) }));
      await refPedido(db).update({ enderecoFiscalOuterRef: DO_OPERADOR });
      await levantarAvisoPago(db);
      const escritasAntes = db.escritas.length;

      const r = await importar(
        db,
        cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      resolvido(db);
      expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        enderecoFiscalOuterRef: DO_OPERADOR,
      });
      expect(frete(db)).toMatchObject({ ...ROTA_ME, enderecoFreteOuterReference: DO_OPERADOR });
      expect(
        db.escritas.slice(escritasAntes).some((e) => e.caminho.includes('/enderecos/')),
        'no endereço built from the observation',
      ).toBe(false);
    });

    it('NEAR-MISS: a VALID CEP resolves it — this import writes the endereço', async () => {
      const db = dbComAlvo();
      await levantarAvisoPago(db);
      const r = await importar(
        db,
        cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      resolvido(db);
      expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef).toMatch(/^documents\/clientes\//);
    });

    it('NEAR-MISS: a PICKUP resolves it with no endereço at all — no CEP or an invalid one', async () => {
      for (const endereco_entrega of [null, INVALIDO]) {
        const db = dbMapeadoPara(INTEGRACAO_FRETE.retiradaNaLoja);
        await levantarAvisoPago(db);
        const r = await importar(
          db,
          pagoSemEndereco({ endereco_entrega, data_modificacao: carimboLi(3) }),
        );
        expect(r.r, JSON.stringify(endereco_entrega)).toEqual({ kind: 'importado' });
        resolvido(db);
        expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef ?? null).toBeNull();
      }
    });

    it('NEAR-MISS: an order NO LONGER PAID (a dispute) with an invalid CEP resolves it', async () => {
      const db = dbComAlvo();
      await levantarAvisoPago(db);
      const disputa: Cena = {
        ...pagoSemEndereco({
          endereco_entrega: INVALIDO,
          situacao: { codigo: 'pagamento_em_disputa', id: 6 },
          data_modificacao: carimboLi(3),
        }),
        historico: [
          ...historicoPagoLi(),
          linhaHistoricoLi(3, carimboLi(2, 500), 'pagamento_em_disputa', 'pedido_pago'),
        ],
      };
      expect((await importar(db, disputa)).r).toEqual({ kind: 'importado' });
      resolvido(db);
      expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef).toBeNull();
    });

    it('⚠️ rule 7: an endereço another writer STORED between the read and the batch resolves it — the WINNING attempt’s snapshot decides, never S', async () => {
      // DE_OUTRO first: the import cannot pair it, so its fill is empty and ONLY the winning
      // snapshot can close the row — read from S, the row would stay open. DO_OPERADOR pairs.
      for (const guardado of [DE_OUTRO, DO_OPERADOR]) {
        const db = dbComAlvo();
        await importar(db, aguardando({ data_modificacao: carimboLi(1) }));
        await levantarAvisoPago(db);
        // S holds no endereço; another writer stores one right before the first batch.
        db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
          await refPedido(db).update({ enderecoFiscalOuterRef: guardado });
        });
        const r = await importar(
          db,
          pagoSemEndereco({ endereco_entrega: INVALIDO, data_modificacao: carimboLi(3) }),
        );
        expect(r.r, guardado).toEqual({ kind: 'importado' });
        resolvido(db);
        expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef, guardado).toBe(guardado);
      }
    });

    it('⚠️ rule 7: an endereço another writer CLEARED between the read and the batch keeps it OPEN — the WINNING attempt’s snapshot decides, never S', async () => {
      const db = dbComAlvo();
      await importar(db, aguardando({ data_modificacao: carimboLi(1) }));
      await refPedido(db).update({ enderecoFiscalOuterRef: DO_OPERADOR });
      await levantarAvisoPago(db);
      const escritas = escritasDoAvisoPago(db);
      // S holds the endereço; another writer clears it right before the first batch.
      db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
        await refPedido(db).update({ enderecoFiscalOuterRef: null });
      });
      const r = await importar(
        db,
        pagoSemEndereco({ endereco_entrega: INVALIDO, data_modificacao: carimboLi(3) }),
      );
      expect(r.r).toEqual({ kind: 'importado' });
      expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        enderecoFiscalOuterRef: null,
      });
      expect(escritasDoAvisoPago(db)).toBe(escritas);
      expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).toBeNull();
    });
  });

  it('pinned (paid ≠ estado pago): the order moved to a DISPUTE while refused imports with no address and no route, its contestado row raised, and the paid-without-address row resolved', async () => {
    const db = dbComAlvo();
    await expect(importar(db, pagoSemEndereco())).rejects.toBeInstanceOf(
      LiPedidoPagoSemEnderecoError,
    );
    await avisarPedidoPagoSemEnderecoLi(
      asDb(db),
      {
        integracaoId: CONTA,
        lojaNome: 'Loja de teste',
        pedidoId: PEDIDO_ID,
        numero: String(NUMERO_LI),
        relogioUs: WATERMARK_2H,
      },
      { increment, nowMs: AGORA_MS },
    );

    const disputa: Cena = {
      ...pagoSemEndereco({
        situacao: { codigo: 'pagamento_em_disputa', id: 6 },
        data_modificacao: carimboLi(4),
      }),
      historico: [
        ...historicoPagoLi(),
        linhaHistoricoLi(3, carimboLi(3), 'pagamento_em_disputa', 'pedido_pago'),
      ],
    };
    expect((await importar(db, disputa)).r).toEqual({ kind: 'importado' });
    // The table's estado for a dispute is `pago`; the label step refuses a contested codigo.
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef).toBeNull();
    expect(frete(db)).toMatchObject(SEM_ROTA);
    expect(db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoContestado))).toMatchObject({
      motivo: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
      resolvidoEm: null,
    });
    expect(db.ler(CAMINHO_AVISO_PAGO)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_PEDIDO_LI.pedidoImportado,
    });
  });

  describe('through the REAL notification pipeline (the queue and the hot sweep)', () => {
    const payloadTarefa = payload({ dataModificacaoLi: carimboLi(2) });
    const caminhoNotificacao = `notificacoesLojaIntegrada/${docIdNotificacaoLi(payloadTarefa)}`;

    function depsTarefaLi(c: Cena, tentativa: number | null, erros: unknown[][]): DepsTarefaLi {
      const { fetch } = plataformaLi(roteiroDe(c));
      return {
        ambiente: AMBIENTE_LIGADO,
        importador: importarPedidoLi,
        increment,
        arrayUnion,
        viaCep: viaCepFalso,
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
          tentativa,
          idTarefa: null,
          escrever: gravadorDeLog().escrever,
        },
        fetch,
      };
    }

    it('queue backoff, then the sweep, then the PARK at the cap: the ERROR line and the open aviso — and the address arriving later imports and resolves it', async () => {
      const db = novoDb();
      const erros: unknown[][] = [];
      const c = pagoSemEndereco();

      // The queue: attempts 0 and 1 rethrow (the queue's backoff), the last one persists `failed`.
      for (const tentativa of [0, 1]) {
        await expect(
          tratarTarefaLeituraLi(
            asDb(db),
            payloadTarefa,
            tentativa,
            depsTarefaLi(c, tentativa, erros),
          ),
        ).rejects.toBeInstanceOf(LiPedidoPagoSemEnderecoError);
      }
      expect(db.ler(caminhoNotificacao)).toBeUndefined();
      const ultima = await tratarTarefaLeituraLi(
        asDb(db),
        payloadTarefa,
        TASK_MAX_ATTEMPTS - 1,
        depsTarefaLi(c, TASK_MAX_ATTEMPTS - 1, erros),
      );
      expect(ultima.outcome).toBe('failed');
      expect(db.ler(caminhoNotificacao)).toMatchObject({ status: 'failed', tentativas: 0 });

      // The hot sweep: below its cap the row stays failed, silently.
      for (let i = 1; i < MAX_TENTATIVAS; i += 1) {
        db.seed(caminhoNotificacao, { ...db.ler(caminhoNotificacao), processedAt: 0 });
        await reprocessarNotificacoesLi(asDb(db), {}, depsTarefaLi(c, null, erros));
        expect(db.ler(caminhoNotificacao), String(i)).toMatchObject({
          status: 'failed',
          tentativas: i,
        });
      }
      expect(erros).toEqual([]);
      expect(db.ler(CAMINHO_AVISO_PAGO)).toBeUndefined();

      // The cap: parked, ONE ERROR line (ids only), the open aviso. Nothing of the pedido.
      db.seed(caminhoNotificacao, { ...db.ler(caminhoNotificacao), processedAt: 0 });
      await reprocessarNotificacoesLi(asDb(db), {}, depsTarefaLi(c, null, erros));
      expect(db.ler(caminhoNotificacao)).toMatchObject({
        status: 'parked',
        tentativas: MAX_TENTATIVAS,
      });
      expect(erros).toHaveLength(1);
      expect(erros[0]![1]).toEqual({
        integracaoId: CONTA,
        numero: String(NUMERO_LI),
        pedidoId: PEDIDO_ID,
      });
      expect(db.ler(CAMINHO_AVISO_PAGO)).toMatchObject({
        severidade: 'critico',
        params: { loja: 'Loja de teste', pedido: String(NUMERO_LI) },
        relogioEvento: WATERMARK_2H,
        resolvidoEm: null,
      });
      expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
      expect(mockCliente).not.toHaveBeenCalled();

      // The address is filled in the painel: a NEWER change, a new notification, an import.
      const corrigido = cena({ cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) });
      const nova = payload({ dataModificacaoLi: carimboLi(3) });
      const r = await tratarTarefaLeituraLi(asDb(db), nova, 0, depsTarefaLi(corrigido, 0, erros));
      expect(r).toMatchObject({ outcome: 'done', kind: 'importado' });
      expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
      expect(db.ler(CAMINHO_AVISO_PAGO)?.resolvidoEm).not.toBeNull();
    });

    it('residue, pinned: four address refusals, then a TRANSIENT failure on the run that parks ⇒ the generic ERROR line (ids only), but no aviso — the parking error is not ours', async () => {
      const db = novoDb();
      const erros: unknown[][] = [];
      // The previous runs refused the address; this one meets a 503 on the detail.
      const anterior = new LiPedidoPagoSemEnderecoError({
        integracaoId: CONTA,
        lojaNome: 'Loja de teste',
        pedidoId: PEDIDO_ID,
        numero: String(NUMERO_LI),
        relogioUs: WATERMARK_2H,
      });
      const c: Cena = { ...pagoSemEndereco(), detalhe: { status: 503, corpo: { erro: 'x' } } };
      db.seed(caminhoNotificacao, {
        ...payloadTarefa,
        status: 'failed',
        tentativas: MAX_TENTATIVAS - 1,
        erro: anterior.message,
        processedAt: 0,
      });
      await reprocessarNotificacoesLi(asDb(db), {}, depsTarefaLi(c, null, erros));
      expect(db.ler(caminhoNotificacao)).toMatchObject({ status: 'parked' });
      expect(erros).toHaveLength(1);
      expect(String(erros[0]![0])).toContain('estacionada');
      expect(String(erros[0]![0])).not.toContain('sem endereço');
      expect(erros[0]![1]).toMatchObject({ integracaoId: CONTA, numero: String(NUMERO_LI) });
      expect(JSON.stringify(erros)).not.toContain('Loja de teste');
      expect(db.ler(CAMINHO_AVISO_PAGO)).toBeUndefined();
    });
  });
});

describe('⚠️ a reversal landing on a pedido whose label was BOUGHT: the approved estado AND an aviso (owner decision A7, 2026-10-19)', () => {
  const CAMINHO_AVISO_REVERSAO = `avisos/${chaveDoAvisoDoPedidoLi(
    TIPO_AVISO.lojaIntegradaReversaoComEtiqueta,
    CONTA,
    PEDIDO_ID,
  )}`;
  /** The order at `codigo`, reached from paid at a newer stamp. */
  function revertido(codigo: string, id: number, horas = 5): Cena {
    return {
      ...cena({ situacao: { codigo, id }, data_modificacao: carimboLi(horas) }),
      historico: [
        ...historicoPagoLi(),
        linhaHistoricoLi(3, carimboLi(horas - 1), codigo, 'pedido_pago'),
      ],
    };
  }
  /** A paid pedido, then a label bought on it (the Melhor Envio purchase's own write). */
  async function pagoComEtiqueta(printLabelId: string | null = 'etiqueta-1'): Promise<FakeDb> {
    const db = novoDb();
    await importar(db, cena());
    await refPedido(db).update({ freteInicial: { ...frete(db), printLabelId } });
    return db;
  }
  const aberto = (db: FakeDb): boolean => {
    const linha = db.ler(CAMINHO_AVISO_REVERSAO);
    return linha !== undefined && linha.resolvidoEm === null;
  };

  it('EQUAL: a cancellation (8) ⇒ the approved reversal of the estado, AND the open aviso naming it', async () => {
    const db = await pagoComEtiqueta();
    const { r, avisosDeLog } = await importar(db, revertido('pedido_cancelado', 8));
    expect(r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(db.ler(CAMINHO_AVISO_REVERSAO)).toMatchObject({
      motivo: 'cancelado',
      params: { loja: 'Loja de teste', pedido: String(NUMERO_LI), motivo: 'cancelado' },
      relogioEvento: dataLiParaMicros(carimboLi(5)),
      resolvidoEm: null,
    });
    // One WARNING, ids and the code only — never the label id.
    const linha = avisosDeLog.find((l) => String(l[0]).includes('etiqueta comprada'));
    expect(linha?.[1]).toEqual({
      integracaoId: CONTA,
      numero: String(NUMERO_LI),
      motivo: 'cancelado',
    });
  });

  it('NEAR-MISS: the same cancellation on a pedido with NO label (null or "") ⇒ the same estado, and no open aviso', async () => {
    for (const printLabelId of [null, '']) {
      const db = await pagoComEtiqueta(printLabelId);
      await importar(db, revertido('pedido_cancelado', 8));
      expect(db.ler(CAMINHO_PEDIDO)?.estado, String(printLabelId)).toBe(
        ESTADO_PEDIDO.estornadoIntegralmente,
      );
      expect(aberto(db), String(printLabelId)).toBe(false);
    }
  });

  it('EQUAL: a refund after an applied removal keeps both (the approved arm), raises the contestado row AND this one', async () => {
    const db = await pagoComEtiqueta();
    await refPedido(db).update({
      estoqueAplicado: { depositoId: 'd1', ehSaida: true, removido: { 'p-x': 2 } },
    });
    await importar(db, revertido('pedido_chargeback', 16));
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoContestado))).toMatchObject({
      motivo: 'chargeback',
      resolvidoEm: null,
    });
    expect(db.ler(CAMINHO_AVISO_REVERSAO)).toMatchObject({
      motivo: 'chargeback',
      resolvidoEm: null,
    });
  });

  it('EQUAL: EVERY reversal rung on a labelled pedido raises the aviso with its own motivo — the cancellation and each refund codigo (7, 16, 1020), with or without a removal applied', async () => {
    for (const [codigo, id, motivo] of [
      ['pedido_cancelado', 8, MOTIVO_REVERSAO_COM_ETIQUETA_LI.cancelado],
      ['pagamento_devolvido', 7, MOTIVO_REVERSAO_COM_ETIQUETA_LI.devolvido],
      ['pedido_chargeback', 16, MOTIVO_REVERSAO_COM_ETIQUETA_LI.chargeback],
      [
        'pagamento_devolvido_sem_retorno',
        1020,
        MOTIVO_REVERSAO_COM_ETIQUETA_LI.devolvidoSemRetorno,
      ],
    ] as const) {
      for (const removido of [false, true]) {
        const db = await pagoComEtiqueta();
        if (removido) {
          await refPedido(db).update({
            estoqueAplicado: { depositoId: 'd1', ehSaida: true, removido: { 'p-x': 2 } },
          });
        }
        await importar(db, revertido(codigo, id));
        expect(db.ler(CAMINHO_AVISO_REVERSAO), `${codigo}/${String(removido)}`).toMatchObject({
          motivo,
          params: { motivo },
          resolvidoEm: null,
        });
      }
    }
  });

  it('rule 7: a label bought BETWEEN the read and the batch is seen — the verdict is the WINNING attempt’s snapshot, never S', async () => {
    const db = await pagoComEtiqueta(null);
    const c = revertido('pedido_cancelado', 8);
    // A line that makes the import call Loja Integrada after it read the pedido.
    c.detalhe = {
      ...(c.detalhe as DocData),
      itens: [
        { ...linhaPadrao(), produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null },
      ],
    };
    let comprou = false;
    c.antesDoProduto = async () => {
      if (comprou) return;
      comprou = true;
      await refPedido(db).update({
        freteInicial: { ...frete(db), printLabelId: 'etiqueta-tardia' },
      });
    };
    await importar(db, c);
    expect(comprou).toBe(true);
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(aberto(db)).toBe(true);
  });

  it('NEAR-MISS: a cancellation REQUEST (1019) on a labelled pedido is no reversal — no open aviso', async () => {
    const db = await pagoComEtiqueta();
    await importar(db, revertido('cancelamento_solicitado', 1019));
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.processandoCancelamento);
    expect(aberto(db)).toBe(false);
  });

  it('the row closes when Loja Integrada reopens the sale (a newer stamp); a late OLDER import cannot close it', async () => {
    const db = await pagoComEtiqueta();
    await importar(db, revertido('pedido_cancelado', 8, 5));
    expect(aberto(db)).toBe(true);

    // An older observation than the pedido holds is `obsoleto`: it writes nothing, the row included.
    expect((await importar(db, cena({ data_modificacao: carimboLi(3) }))).r).toEqual({
      kind: 'obsoleto',
    });
    expect(aberto(db)).toBe(true);

    // Reopened in the painel, later: the sale is live again, and the row resolves.
    const reaberto: Cena = {
      ...cena({ data_modificacao: carimboLi(7) }),
      historico: [
        ...historicoPagoLi(),
        linhaHistoricoLi(3, carimboLi(4), 'pedido_cancelado', 'pedido_pago'),
        linhaHistoricoLi(4, carimboLi(6), 'pedido_pago', 'pedido_cancelado'),
      ],
    };
    await importar(db, reaberto);
    expect(db.ler(CAMINHO_AVISO_REVERSAO)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_PEDIDO_LI.semReversaoComEtiqueta,
    });
    expect(aberto(db)).toBe(false);
  });
});

describe('⚠️ never a cliente beside another cliente’s endereço (step 7): fiscal and delivery', () => {
  /** An endereço stored under a cliente that is NOT the one the buyer resolves to. */
  const ENDERECO_DE_OUTRO = 'documents/clientes/cliente-de-outra-pessoa/enderecos/end-a';
  /** An endereço stored under the cliente the buyer DOES resolve to (`CLIENTE_ID`). */
  const ENDERECO_DO_COMPRADOR = `documents/clientes/${CLIENTE_ID}/enderecos/end-b`;
  const CLIENTE_DO_COMPRADOR = `documents/clientes/${CLIENTE_ID}`;
  const COMPRADOR_NOVO = { cliente: COMPRADOR_COM_CPF, data_modificacao: carimboLi(3) };

  /**
   * A pedido with NO refs and an empty route (an identity-less first import,
   * its "sem cliente" incidente removed so each test sees only its own), then
   * `over` written by another writer — `clientePedidoOuterRef` stays null
   * unless `over` sets it.
   */
  async function pedidoArmazenado(over: DocData): Promise<FakeDb> {
    const db = dbComAlvo();
    await importar(db, cena());
    expect(frete(db)).toMatchObject(SEM_ROTA);
    await incidenteCollection
      .docRef(asDb(db), { pedidoId: PEDIDO_ID }, ID_INCIDENTE_LI.clienteSemIdentidade)
      .delete();
    if (Object.keys(over).length > 0) await refPedido(db).update(over);
    mockCliente.mockClear();
    return db;
  }

  function incidentes(db: FakeDb): string[] {
    return db.idsEm(`${CAMINHO_PEDIDO}/incidentes`);
  }

  /** Another writer sets the freight block's delivery endereço (the one a label ships to). */
  async function comEntrega(db: FakeDb, entrega: unknown): Promise<void> {
    await refPedido(db).update({
      freteInicial: { ...frete(db), enderecoFreteOuterReference: entrega },
    });
  }

  /** The operator-facing text of the endereço incidente. */
  function motivoDoIncidenteDeEndereco(db: FakeDb): string {
    return db.ler(caminhoIncidente(ID_INCIDENTE_LI.enderecoDeOutroCliente))
      ?.motivoDoIncidente as string;
  }

  /**
   * The fail-safe state with whatever the pedido already held kept AS STORED:
   * no route filled, the delivery endereço untouched, the amount kept, the
   * incidente raised.
   */
  function esperarSemRotaNova(
    db: FakeDb,
    guardado: { readonly cliente: unknown; readonly fiscal: unknown; readonly entrega: unknown },
  ): void {
    const pedido = db.ler(CAMINHO_PEDIDO)!;
    expect(pedido.clientePedidoOuterRef).toEqual(guardado.cliente);
    expect(pedido.enderecoFiscalOuterRef).toEqual(guardado.fiscal);
    expect(frete(db)).toMatchObject({
      ...SEM_ROTA,
      enderecoFreteOuterReference: guardado.entrega,
      valorCobrado: 14.8,
      modalidade: MODALIDADE_FRETE.cif,
    });
    expect(incidentes(db)).toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
  }

  /** The fail-safe state: no cliente filled, the stored endereço kept, no route, the incidente. */
  function esperarEnderecoDeOutro(db: FakeDb, endereco: unknown): void {
    const pedido = db.ler(CAMINHO_PEDIDO)!;
    expect(pedido.clientePedidoOuterRef).toBeNull();
    expect(pedido.enderecoFiscalOuterRef).toEqual(endereco);
    expect(frete(db)).toMatchObject({
      ...SEM_ROTA,
      enderecoFreteOuterReference: null,
      valorCobrado: 14.8,
      modalidade: MODALIDADE_FRETE.cif,
    });
    expect(incidentes(db)).toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    expect(db.ler(caminhoIncidente(ID_INCIDENTE_LI.enderecoDeOutroCliente))).toMatchObject({
      subtipo: SUBTIPO_INCIDENTE_LI.enderecoDeOutroCliente,
      tipo: 'o',
      origem: 99,
      resolucao: null,
    });
  }

  it('REPRO: a buyer resolving to ANOTHER cliente ⇒ the cliente is NOT filled over the endereço, which is kept, takes no route, and raises the incidente', async () => {
    const db = await pedidoArmazenado({ enderecoFiscalOuterRef: ENDERECO_DE_OUTRO });
    const { r, avisosDeLog } = await importar(db, cena(COMPRADOR_NOVO));
    expect(r).toEqual({ kind: 'importado' });
    esperarEnderecoDeOutro(db, ENDERECO_DE_OUTRO);
    // The buyer IS resolved (only that tells the owner apart) — but no endereço is stored
    // under it while one is stored on the pedido, and no "sem cliente" incidente is raised.
    expect(mockCliente).toHaveBeenCalledTimes(1);
    expect(db.idsEm(`clientes/${CLIENTE_ID}/enderecos`)).toEqual([]);
    expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.clienteSemIdentidade);
    expect(JSON.stringify(avisosDeLog)).toContain('outro dono');
    // The message names no buyer datum, and says what the import withheld.
    const motivo = motivoDoIncidenteDeEndereco(db);
    expect(motivo).toContain(String(NUMERO_LI));
    expect(motivo).not.toContain('cliente-de-outra-pessoa');
    expect(motivo).toContain('o endereço fiscal é de outro cliente, e não do cliente do comprador');
    expect(motivo).toContain('não vinculou o cliente do comprador ao pedido');
  });

  it.each([
    ['canonical', ENDERECO_DO_COMPRADOR],
    ['bare', `clientes/${CLIENTE_ID}/enderecos/end-b`],
  ])(
    'EQUAL: the stored endereço is the resolved cliente’s own (%s form) ⇒ the cliente filled, the endereço kept and routed, no incidente',
    async (_forma, endereco) => {
      const db = await pedidoArmazenado({ enderecoFiscalOuterRef: endereco });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      const pedido = db.ler(CAMINHO_PEDIDO)!;
      expect(pedido.clientePedidoOuterRef).toBe(CLIENTE_DO_COMPRADOR);
      // Kept exactly as stored; the freight block takes its canonical form.
      expect(pedido.enderecoFiscalOuterRef).toBe(endereco);
      expect(frete(db)).toMatchObject({
        ...ROTA_ME,
        enderecoFreteOuterReference: ENDERECO_DO_COMPRADOR,
      });
      expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
      // Never replaced: no second endereço under the cliente.
      expect(db.idsEm(`clientes/${CLIENTE_ID}/enderecos`)).toEqual([]);
    },
  );

  it.each([
    ['a longer cliente id', `documents/clientes/${CLIENTE_ID}x/enderecos/end-b`],
    ['a prefix of the cliente id', 'documents/clientes/cliente-li/enderecos/end-b'],
  ])('NEAR-MISS: an owner one character away (%s) is ANOTHER cliente', async (_caso, endereco) => {
    const db = await pedidoArmazenado({ enderecoFiscalOuterRef: endereco });
    expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
    esperarEnderecoDeOutro(db, endereco);
  });

  it.each([
    ['the cliente ref itself, not an endereço', CLIENTE_DO_COMPRADOR],
    ['another collection', `documents/fornecedores/${CLIENTE_ID}/enderecos/end-b`],
    ['a path nested below the endereço', `${ENDERECO_DO_COMPRADOR}/historico/h-1`],
    ['text that is no path', 'endereco-sem-caminho'],
    ['blank text (a value somebody wrote)', ' '],
    ['a number', 42],
    ['a map', { clienteId: CLIENTE_ID }],
  ])(
    'an UNREADABLE stored endereço (%s) is never the resolved cliente’s: treated as another owner',
    async (_caso, endereco) => {
      const db = await pedidoArmazenado({ enderecoFiscalOuterRef: endereco });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      esperarEnderecoDeOutro(db, endereco);
    },
  );

  it('a route an operator STORED beside the foreign endereço is never cleared: only no NEW route is filled', async () => {
    const doOperador = {
      integracaoFreteOuterRef: 'documents/int_frete/me-9',
      externalOptionId: '7',
      externalOptionIntegracao: null,
      externalOptionData: { id: 7, nome: 'Escolha do operador' },
    };
    const db = await pedidoArmazenado({ enderecoFiscalOuterRef: ENDERECO_DE_OUTRO });
    await refPedido(db).update({ freteInicial: { ...frete(db), ...doOperador } });
    expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)?.clientePedidoOuterRef).toBeNull();
    expect(frete(db)).toMatchObject({ ...doOperador, enderecoFreteOuterReference: null });
    expect(incidentes(db)).toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
  });

  it('no strong identity and a stored endereço ⇒ nothing to pair it with: no route, and both incidentes — each worded for a pedido that HOLDS an endereço', async () => {
    const db = await pedidoArmazenado({ enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR });
    expect((await importar(db, cena({ data_modificacao: carimboLi(3) }))).r).toEqual({
      kind: 'importado',
    });
    esperarEnderecoDeOutro(db, ENDERECO_DO_COMPRADOR);
    expect(incidentes(db)).toContain(ID_INCIDENTE_LI.clienteSemIdentidade);
    const semIdentidade = db.ler(caminhoIncidente(ID_INCIDENTE_LI.clienteSemIdentidade))
      ?.motivoDoIncidente as string;
    expect(semIdentidade).toContain('ficou sem cliente.');
    expect(semIdentidade).not.toContain('sem endereço');
    // No "other" cliente exists to compare with: the text says the pedido has none.
    const motivo = motivoDoIncidenteDeEndereco(db);
    expect(motivo).toContain('o pedido está sem cliente');
    expect(motivo).not.toContain('de outro cliente');
    expect(motivo).not.toContain('não vinculou');
  });

  describe('a STORED cliente: never replaced, and its stored endereços must be its own', () => {
    const CLIENTE_X = 'documents/clientes/cliente-ligado';
    const ENDERECO_DE_X = `${CLIENTE_X}/enderecos/end-x`;

    it('REPRO: a stored cliente X beside an endereço of cliente Y and an empty route ⇒ both kept, NO route filled, the incidente — and no cliente step', async () => {
      const db = await pedidoArmazenado({
        clientePedidoOuterRef: CLIENTE_X,
        enderecoFiscalOuterRef: ENDERECO_DE_OUTRO,
      });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(mockCliente).not.toHaveBeenCalled();
      esperarSemRotaNova(db, { cliente: CLIENTE_X, fiscal: ENDERECO_DE_OUTRO, entrega: null });
      const motivo = motivoDoIncidenteDeEndereco(db);
      expect(motivo).toContain('o endereço fiscal é de outro cliente, e não do cliente do pedido');
      // The pedido HAS a cliente: the text never says the import withheld one.
      expect(motivo).not.toContain('não vinculou');
      expect(motivo).toContain('não definiu a transportadora');
    });

    it.each([
      ['canonical cliente, canonical endereço', CLIENTE_X, ENDERECO_DE_X],
      ['canonical cliente, bare endereço', CLIENTE_X, 'clientes/cliente-ligado/enderecos/end-x'],
      ['bare cliente, canonical endereço', 'clientes/cliente-ligado', ENDERECO_DE_X],
    ])(
      'NEAR-MISS: the stored cliente’s OWN endereço (%s) ⇒ routed to its canonical form, never parked, no incidente',
      async (_forma, cliente, endereco) => {
        const db = await pedidoArmazenado({
          clientePedidoOuterRef: cliente,
          enderecoFiscalOuterRef: endereco,
        });
        expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
        expect(mockCliente).not.toHaveBeenCalled();
        const pedido = db.ler(CAMINHO_PEDIDO)!;
        expect(pedido.clientePedidoOuterRef).toBe(cliente);
        expect(pedido.enderecoFiscalOuterRef).toBe(endereco);
        expect(frete(db)).toMatchObject({ ...ROTA_ME, enderecoFreteOuterReference: ENDERECO_DE_X });
        expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
      },
    );

    it.each([
      ['text that is no path', 'endereco-sem-caminho'],
      ['the cliente ref itself', CLIENTE_X],
      ['a number', 42],
      ['a map', { clienteId: 'cliente-ligado' }],
    ])(
      'an UNREADABLE endereço (%s) beside a stored cliente ⇒ never parked, no route, the incidente',
      async (_caso, endereco) => {
        const db = await pedidoArmazenado({
          clientePedidoOuterRef: CLIENTE_X,
          enderecoFiscalOuterRef: endereco,
        });
        expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
        esperarSemRotaNova(db, { cliente: CLIENTE_X, fiscal: endereco, entrega: null });
        expect(motivoDoIncidenteDeEndereco(db)).toContain(
          'não foi possível identificar de qual cliente é o endereço fiscal',
        );
      },
    );

    it.each([
      ['a map', { id: 'cliente-ligado' }],
      ['another collection', 'documents/fornecedores/cliente-ligado'],
      ['a cliente nested below another document', 'documents/lojas/l-1/clientes/cliente-ligado'],
      ['an endereço ref', ENDERECO_DE_X],
    ])(
      'an UNREADABLE stored cliente (%s) matches no endereço, its own-looking one included ⇒ both kept, no route, the incidente',
      async (_caso, cliente) => {
        const db = await pedidoArmazenado({
          clientePedidoOuterRef: cliente,
          enderecoFiscalOuterRef: ENDERECO_DE_X,
        });
        expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
        expect(mockCliente).not.toHaveBeenCalled();
        esperarSemRotaNova(db, { cliente, fiscal: ENDERECO_DE_X, entrega: null });
        expect(motivoDoIncidenteDeEndereco(db)).toContain(
          'o cliente do pedido não pôde ser identificado',
        );
      },
    );

    it.each([
      ['a map', { id: 'cliente-ligado' }],
      // Text whose last id a lenient read would take for `clientes/cliente-ligado`.
      ['another collection', 'documents/fornecedores/cliente-ligado'],
      ['a cliente nested below another document', 'documents/lojas/l-1/clientes/cliente-ligado'],
    ])(
      'NEAR-MISS: an unreadable stored cliente (%s) and NO endereço ⇒ nothing to pair: no endereço stored under any cliente, no route, no incidente',
      async (_caso, cliente) => {
        const db = await pedidoArmazenado({ clientePedidoOuterRef: cliente });
        expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
        expect(mockCliente).not.toHaveBeenCalled();
        const pedido = db.ler(CAMINHO_PEDIDO)!;
        expect(pedido.clientePedidoOuterRef).toEqual(cliente);
        expect(pedido.enderecoFiscalOuterRef).toBeNull();
        // The endereço step never stores one under a cliente path the ref does not name.
        expect(db.idsEm('clientes/cliente-ligado/enderecos')).toEqual([]);
        expect(frete(db)).toMatchObject(SEM_ROTA);
        expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
      },
    );

    it('a route an operator STORED beside the mismatched pair is never cleared', async () => {
      const doOperador = {
        integracaoFreteOuterRef: 'documents/int_frete/me-9',
        externalOptionId: '7',
        externalOptionIntegracao: null,
        externalOptionData: { id: 7, nome: 'Escolha do operador' },
      };
      const db = await pedidoArmazenado({
        clientePedidoOuterRef: CLIENTE_X,
        enderecoFiscalOuterRef: ENDERECO_DE_OUTRO,
      });
      await refPedido(db).update({ freteInicial: { ...frete(db), ...doOperador } });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(frete(db)).toMatchObject(doOperador);
      expect(incidentes(db)).toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    });
  });

  describe('the DELIVERY endereço (freteInicial.enderecoFreteOuterReference): the one a label ships to', () => {
    const ENTREGA_DE_OUTRO = 'documents/clientes/cliente-de-outra-pessoa/enderecos/entrega-a';
    const ENTREGA_DO_COMPRADOR = `${CLIENTE_DO_COMPRADOR}/enderecos/entrega-b`;

    it('REPRO: no cliente, no fiscal endereço, a delivery endereço of ANOTHER cliente ⇒ the buyer’s cliente is NOT filled over it, no route, the delivery kept, the incidente', async () => {
      const db = await pedidoArmazenado({});
      await comEntrega(db, ENTREGA_DE_OUTRO);
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(mockCliente).toHaveBeenCalledTimes(1);
      esperarSemRotaNova(db, { cliente: null, fiscal: null, entrega: ENTREGA_DE_OUTRO });
      const motivo = motivoDoIncidenteDeEndereco(db);
      expect(motivo).toContain('o endereço de entrega é de outro cliente');
      expect(motivo).toContain('não vinculou o cliente do comprador ao pedido');
    });

    it('NEAR-MISS: the delivery endereço is the buyer’s OWN ⇒ the cliente and its fiscal endereço filled, the route filled, the delivery never replaced', async () => {
      const db = await pedidoArmazenado({});
      await comEntrega(db, ENTREGA_DO_COMPRADOR);
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      const pedido = db.ler(CAMINHO_PEDIDO)!;
      expect(pedido.clientePedidoOuterRef).toBe(CLIENTE_DO_COMPRADOR);
      expect(pedido.enderecoFiscalOuterRef).toMatch(
        new RegExp(`^${CLIENTE_DO_COMPRADOR}/enderecos/[0-9a-f]{40}$`),
      );
      expect(frete(db)).toMatchObject({
        ...ROTA_ME,
        enderecoFreteOuterReference: ENTREGA_DO_COMPRADOR,
      });
      expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    });

    it('a stored cliente with its OWN fiscal endereço and a delivery endereço of ANOTHER ⇒ no route, the incidente names the delivery', async () => {
      const db = await pedidoArmazenado({
        clientePedidoOuterRef: CLIENTE_DO_COMPRADOR,
        enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR,
      });
      await comEntrega(db, ENTREGA_DE_OUTRO);
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      esperarSemRotaNova(db, {
        cliente: CLIENTE_DO_COMPRADOR,
        fiscal: ENDERECO_DO_COMPRADOR,
        entrega: ENTREGA_DE_OUTRO,
      });
      const motivo = motivoDoIncidenteDeEndereco(db);
      expect(motivo).toContain('o endereço de entrega é de outro cliente');
      expect(motivo).not.toContain('o endereço fiscal é de outro cliente');
    });

    it('a stored cliente, NO fiscal endereço and a delivery endereço of ANOTHER ⇒ the fiscal one stored under the stored cliente and filled (a pair), still no route, the incidente', async () => {
      const aMao = 'documents/clientes/cliente-ligado-a-mao';
      const db = await pedidoArmazenado({ clientePedidoOuterRef: aMao });
      await comEntrega(db, ENTREGA_DE_OUTRO);
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      const fiscal = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
      expect(fiscal).toMatch(new RegExp(`^${aMao}/enderecos/[0-9a-f]{40}$`));
      esperarSemRotaNova(db, { cliente: aMao, fiscal, entrega: ENTREGA_DE_OUTRO });
    });

    it('an UNREADABLE delivery endereço beside a matching pair ⇒ no route, the incidente', async () => {
      const ilegivel = { clienteId: CLIENTE_ID };
      const db = await pedidoArmazenado({
        clientePedidoOuterRef: CLIENTE_DO_COMPRADOR,
        enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR,
      });
      await comEntrega(db, ilegivel);
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      esperarSemRotaNova(db, {
        cliente: CLIENTE_DO_COMPRADOR,
        fiscal: ENDERECO_DO_COMPRADOR,
        entrega: ilegivel,
      });
      expect(motivoDoIncidenteDeEndereco(db)).toContain(
        'não foi possível identificar de qual cliente é o endereço de entrega',
      );
    });

    it('NEAR-MISS: the same pair with the delivery endereço EQUAL to the fiscal one ⇒ routed, no incidente', async () => {
      const db = await pedidoArmazenado({
        clientePedidoOuterRef: CLIENTE_DO_COMPRADOR,
        enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR,
      });
      await comEntrega(db, ENDERECO_DO_COMPRADOR);
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(frete(db)).toMatchObject({
        ...ROTA_ME,
        enderecoFreteOuterReference: ENDERECO_DO_COMPRADOR,
      });
      expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    });
  });

  it('a cliente linked by hand and NO endereço ⇒ the order’s endereço is stored under THAT cliente and routed (owner decision)', async () => {
    const aMao = 'cliente-ligado-a-mao';
    const db = await pedidoArmazenado({ clientePedidoOuterRef: `documents/clientes/${aMao}` });
    expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
    expect(mockCliente).not.toHaveBeenCalled();
    const endereco = db.ler(CAMINHO_PEDIDO)?.enderecoFiscalOuterRef as string;
    expect(endereco).toMatch(new RegExp(`^documents/clientes/${aMao}/enderecos/[0-9a-f]{40}$`));
    expect(frete(db)).toMatchObject({ ...ROTA_ME, enderecoFreteOuterReference: endereco });
    expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
  });

  describe('rule 7: the pairing is re-derived from S′ on the retry', () => {
    /** Another writer lands `over` on the pedido right before our first batch. */
    function escritorAntesDoLote(db: FakeDb, over: DocData): { readonly escreveu: () => boolean } {
      let escreveu = false;
      db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
        escreveu = true;
        await refPedido(db).update(over);
      });
      return { escreveu: () => escreveu };
    }

    it('⚠️ another writer stores an endereço of ANOTHER cliente between the read and the batch ⇒ the retry fills no cliente, routes nothing, raises the incidente', async () => {
      const db = await pedidoArmazenado({});
      const escritor = escritorAntesDoLote(db, { enderecoFiscalOuterRef: ENDERECO_DE_OUTRO });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(escritor.escreveu()).toBe(true);
      // Step 7 ran against S (no endereço): ours was stored under the buyer's cliente…
      expect(db.idsEm(`clientes/${CLIENTE_ID}/enderecos`)).toHaveLength(1);
      // …and S′ decided: neither our cliente nor our endereço over the other writer's.
      esperarEnderecoDeOutro(db, ENDERECO_DE_OUTRO);
    });

    it('NEAR-MISS: the other writer’s endereço is under the buyer’s OWN cliente ⇒ the retry fills the cliente beside it and routes to it', async () => {
      const db = await pedidoArmazenado({});
      escritorAntesDoLote(db, { enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      const pedido = db.ler(CAMINHO_PEDIDO)!;
      expect(pedido.clientePedidoOuterRef).toBe(CLIENTE_DO_COMPRADOR);
      expect(pedido.enderecoFiscalOuterRef).toBe(ENDERECO_DO_COMPRADOR);
      expect(frete(db)).toMatchObject({
        ...ROTA_ME,
        enderecoFreteOuterReference: ENDERECO_DO_COMPRADOR,
      });
      expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    });

    it('the foreign endereço is CLEARED between the read and the batch ⇒ S′ holds none: the cliente is filled, no route (no endereço), and NO incidente', async () => {
      const db = await pedidoArmazenado({ enderecoFiscalOuterRef: ENDERECO_DE_OUTRO });
      escritorAntesDoLote(db, { enderecoFiscalOuterRef: null });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      const pedido = db.ler(CAMINHO_PEDIDO)!;
      expect(pedido.clientePedidoOuterRef).toBe(CLIENTE_DO_COMPRADOR);
      // Step 7 saw S's endereço and stored none; the next import stores the buyer's.
      expect(pedido.enderecoFiscalOuterRef).toBeNull();
      expect(frete(db)).toMatchObject({ ...SEM_ROTA, enderecoFreteOuterReference: null });
      expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    });

    it('⚠️ another writer links ANOTHER cliente beside the buyer’s own stored endereço between the read and the batch ⇒ S′ is a mismatched pair: no route, the incidente', async () => {
      const outro = 'documents/clientes/cliente-de-outro-escritor';
      const db = await pedidoArmazenado({ enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR });
      const escritor = escritorAntesDoLote(db, { clientePedidoOuterRef: outro });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(escritor.escreveu()).toBe(true);
      // Against S the pair matched (the buyer's own endereço); S′ carries ANOTHER cliente.
      esperarSemRotaNova(db, { cliente: outro, fiscal: ENDERECO_DO_COMPRADOR, entrega: null });
      expect(motivoDoIncidenteDeEndereco(db)).toContain('e não do cliente do pedido');
    });

    it('NEAR-MISS: a mismatched stored pair FIXED by another writer between the read and the batch ⇒ S′ pairs: routed, no incidente', async () => {
      const db = await pedidoArmazenado({
        clientePedidoOuterRef: CLIENTE_DO_COMPRADOR,
        enderecoFiscalOuterRef: ENDERECO_DE_OUTRO,
      });
      escritorAntesDoLote(db, { enderecoFiscalOuterRef: ENDERECO_DO_COMPRADOR });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(frete(db)).toMatchObject({
        ...ROTA_ME,
        enderecoFreteOuterReference: ENDERECO_DO_COMPRADOR,
      });
      expect(incidentes(db)).not.toContain(ID_INCIDENTE_LI.enderecoDeOutroCliente);
    });

    it('⚠️ another writer stores a DELIVERY endereço of ANOTHER cliente between the read and the batch ⇒ the retry fills no cliente, routes nothing, raises the incidente', async () => {
      const entrega = 'documents/clientes/cliente-de-outra-pessoa/enderecos/entrega-a';
      const db = await pedidoArmazenado({});
      const freteDoPedido = frete(db);
      const escritor = escritorAntesDoLote(db, {
        freteInicial: { ...freteDoPedido, enderecoFreteOuterReference: entrega },
      });
      expect((await importar(db, cena(COMPRADOR_NOVO))).r).toEqual({ kind: 'importado' });
      expect(escritor.escreveu()).toBe(true);
      esperarSemRotaNova(db, { cliente: null, fiscal: null, entrega });
    });
  });
});

describe('rule 7: ONE batch, re-derived whole on every lost precondition', () => {
  it('a refund after the stock sync applied the removal mid-import ⇒ the batch aborts, S′ keeps both — the pagamento is NEVER estornado', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    expect(db.ler(CAMINHO_PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);

    // 1020 (refund without return), with a line that makes the import GET
    // something AFTER it read the pedido: the stock sync lands in that window.
    c.detalhe = pedidoLiBruto({
      situacao: { codigo: 'pagamento_devolvido_sem_retorno', id: 1020 },
      data_modificacao: carimboLi(5),
      itens: [
        { ...linhaPadrao(), produto: '/api/v1/produto/321/?id_externo=1', produto_pai: null },
      ],
    });
    c.historico = [
      ...historicoPagoLi(),
      linhaHistoricoLi(3, carimboLi(4), 'pagamento_devolvido_sem_retorno', 'pedido_pago'),
    ];
    let sincronizou = false;
    c.antesDoProduto = async () => {
      if (sincronizou) return;
      sincronizou = true;
      const ref = refPedido(db);
      await ref.update({
        estoqueAplicado: { depositoId: 'd1', ehSaida: true, removido: { 'p-x': 2 } },
      });
    };
    const lotesAntes = new Set(db.escritas.map((e) => e.lote)).size;
    const { r } = await importar(db, c);
    expect(r).toEqual({ kind: 'importado' });

    // Kept: the estado AND the stored payment status (the goods may not have come back).
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(db.ler(CAMINHO_PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    // No write carrying the refund status ever landed: the batch decided from S aborted whole,
    // and S′ decided `manter` (only the clocks move).
    const statusEscritos = db
      .escritasEm(CAMINHO_PAGAMENTO)
      .map((e) => e.dados?.status_pagamento)
      .filter((s) => s !== undefined);
    expect(statusEscritos).toEqual([STATUS_PAGAMENTO.aprovado]);
    expect(new Set(db.escritas.map((e) => e.lote)).size).toBe(lotesAntes + 1);
    // The refund is recorded on the contestado aviso.
    expect(db.ler(caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaPedidoContestado))).toMatchObject({
      resolvidoEm: null,
      motivo: 'devolvido-sem-retorno',
    });
  });

  it(`${String(MAX_TENTATIVAS_ESCRITA_PEDIDO_LI)} lost preconditions in a row ⇒ LiPedidoEmConflitoError, and nothing of the batch landed`, async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(5), valor_total: '120.00' });
    // A writer that lands before EVERY commit of this import.
    escritorAntesDeCadaLote(db, MAX_TENTATIVAS_ESCRITA_PEDIDO_LI);
    const antes = db.ler(CAMINHO_PEDIDO)!;
    const err: unknown = await importar(db, c).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiPedidoEmConflitoError);
    const depois = db.ler(CAMINHO_PEDIDO)!;
    expect(depois.lastMarketplaceUpdate).toBe(antes.lastMarketplaceUpdate);
    expect(depois.valorCobrado).toBe(antes.valorCobrado);
  });

  it('one lost precondition ⇒ the retry re-reads S′ and RE-DERIVES from it: an operator’s freeze that landed mid-import keeps its money', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    // New Loja Integrada money: a patch decided from S writes `valorCobrado`.
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(5), valor_total: '120.00' });
    let editou = false;
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      editou = true;
      await refPedido(db).update({ hasUserInteraction: true, valorCobrado: 99.9 });
    });
    const leiturasAntes = db.leituras.filter((l) => l === CAMINHO_PEDIDO).length;
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(editou).toBe(true);
    // S, then S′: the batch decided from S aborted, and the retry read again.
    expect(db.leituras.filter((l) => l === CAMINHO_PEDIDO).length - leiturasAntes).toBe(2);
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      hasUserInteraction: true,
      valorCobrado: 99.9,
      lastMarketplaceUpdate: dataLiParaMicros(carimboLi(5)),
    });
    // No write carrying the S-based money ever landed.
    expect(db.escritasEm(CAMINHO_PEDIDO).some((e) => e.dados?.valorCobrado === 120)).toBe(false);
  });

  it('an operator’s money edit (hasUserInteraction) survives the next Loja Integrada change', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    await refPedido(db).update({
      hasUserInteraction: true,
      valorCobrado: 99.9,
      descontoTotal: 14.9,
    });
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(5) });
    await importar(db, c);
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      valorCobrado: 99.9,
      descontoTotal: 14.9,
      lastMarketplaceUpdate: dataLiParaMicros(carimboLi(5)),
    });
  });

  it('the CARRIER: an empty pedido patch with a pagamento write still carries the pedido’s precondition', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    // The pagamento is gone; the same order comes again at the SAME stamp.
    await apagarPagamento(db);
    const antes = db.escritas.length;
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    const lote = db.escritas.slice(antes).filter((e) => e.lote !== undefined);
    expect(lote.map((e) => [e.verbo, e.caminho])).toEqual([
      ['update', CAMINHO_PEDIDO],
      ['create', CAMINHO_PAGAMENTO],
    ]);
    // The carrier re-writes the stored watermark exactly as read, and nothing else.
    expect(lote[0]?.dados).toEqual({ lastMarketplaceUpdate: WATERMARK_2H });
  });

  it('the carrier loses its precondition ⇒ the pagamento create is NOT written either', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    await apagarPagamento(db);
    escritorAntesDeCadaLote(db, MAX_TENTATIVAS_ESCRITA_PEDIDO_LI);
    await expect(importar(db, c)).rejects.toBeInstanceOf(LiPedidoEmConflitoError);
    expect(db.ler(CAMINHO_PAGAMENTO)).toBeUndefined();
  });

  it('a concurrent CREATE of the same pedido ⇒ 6 aborts the batch, the retry takes the update path', async () => {
    const db = novoDb();
    const c = cena();
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      await refPedido(db).create({
        estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        lastMarketplaceUpdate: 1,
      });
    });
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: WATERMARK_2H,
    });
    expect(db.ler(CAMINHO_PAGAMENTO)?.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
  });

  it('another writer changes the PAGAMENTO between its read and the batch ⇒ the batch aborts, the retry RE-READS it, and both writes survive', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(5) });
    let escreveu = false;
    db.antesDaProximaEscrita(CAMINHO_PAGAMENTO, async () => {
      escreveu = true;
      await pagamentoCollection
        .docRef(asDb(db), { pedidoId: PEDIDO_ID }, PAGAMENTO_ID)
        .update({ outroEscritor: 1 });
    });
    const leiturasAntes = db.leituras.filter((l) => l === CAMINHO_PAGAMENTO).length;
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(escreveu).toBe(true);
    // Read once per attempt: the retry decided from the pagamento as the other writer left it.
    expect(db.leituras.filter((l) => l === CAMINHO_PAGAMENTO).length - leiturasAntes).toBe(2);
    expect(db.ler(CAMINHO_PAGAMENTO)).toMatchObject({
      outroEscritor: 1,
      lastProviderUpdate: dataLiParaMicros(carimboLi(5)),
    });
  });

  it('a NEWER import lands between the read and the batch ⇒ the retry is obsoleto: nothing of ours is written, avisos and incidentes included', async () => {
    const db = novoDb();
    await importar(db, cena());
    const maisNovo = dataLiParaMicros(carimboLi(5))!;
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, async () => {
      await refPedido(db).update({ lastMarketplaceUpdate: maisNovo });
    });
    const antes = db.escritas.length;
    expect((await importar(db, cena({ data_modificacao: carimboLi(3) }))).r).toEqual({
      kind: 'obsoleto',
    });
    // Only the other writer's write landed.
    expect(db.escritas.slice(antes).map((e) => e.caminho)).toEqual([CAMINHO_PEDIDO]);
    expect(db.ler(CAMINHO_PEDIDO)?.lastMarketplaceUpdate).toBe(maisNovo);
  });

  it('a commit that answers NOT_FOUND (5) is a lost race too: re-read, re-derive, land', async () => {
    const db = novoDb();
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, () => {
      throw grpc(5, 'NOT_FOUND');
    });
    expect((await importar(db, cena())).r).toEqual({ kind: 'importado' });
    expect(db.leituras.filter((l) => l === CAMINHO_PEDIDO)).toHaveLength(2);
    expect(db.ler(CAMINHO_PAGAMENTO)).toBeDefined();
  });

  it('near-miss: a commit that fails for any OTHER reason is no lost race — it rethrows at once, unretried, and nothing landed', async () => {
    const db = novoDb();
    db.antesDaProximaEscrita(CAMINHO_PEDIDO, () => {
      throw grpc(14, 'UNAVAILABLE');
    });
    const err: unknown = await importar(db, cena()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 14 });
    expect(err).not.toBeInstanceOf(LiPedidoEmConflitoError);
    expect(db.leituras.filter((l) => l === CAMINHO_PEDIDO)).toHaveLength(1);
    expect(escritasDoPedido(db)).toEqual([]);
  });
});

describe('a crash between the batch and the avisos is healed by the retry', () => {
  it('the FIRST write after the batch fails (an incidente) ⇒ neither incidentes nor avisos landed; the sem-mudanca retry writes both', async () => {
    const db = novoDb();
    const c = cena({ situacao: { codigo: 'codigo_novo', id: 999 } });
    c.historico = [linhaHistoricoLi(1, carimboLi(0, 100), 'codigo_novo', 'pedido_efetuado')];
    const linha = caminhoIncidente(idIncidenteLinhaLi(String(ID_ITEM_LI)));
    const aviso = caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida);
    db.falharEscrita(linha, grpc(14, 'UNAVAILABLE'));
    await expect(importar(db, c)).rejects.toMatchObject({ code: 14 });
    // The batch landed; nothing of step 11 did.
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.error);
    expect(db.ler(CAMINHO_PAGAMENTO)).toBeDefined();
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toEqual([]);
    expect(db.ler(aviso)).toBeUndefined();

    db.falharEscrita(linha, null);
    const antes = db.escritas.length;
    expect((await importar(db, c)).r).toEqual({ kind: 'situacao-desconhecida' });
    expect(db.escritas.slice(antes).filter((e) => e.lote !== undefined)).toEqual([]);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toContain(
      idIncidenteLinhaLi(String(ID_ITEM_LI)),
    );
    expect(db.ler(aviso)).toMatchObject({ resolvidoEm: null, relogioEvento: WATERMARK_2H });
  });

  it('the aviso write fails after the batch and the incidentes landed ⇒ the sem-mudanca retry still raises the aviso', async () => {
    const db = novoDb();
    const c = cena({ situacao: { codigo: 'codigo_novo', id: 999 } });
    c.historico = [linhaHistoricoLi(1, carimboLi(0, 100), 'codigo_novo', 'pedido_efetuado')];
    const chave = caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida);
    db.falharEscrita(chave, grpc(14, 'UNAVAILABLE'));
    await expect(importar(db, c)).rejects.toMatchObject({ code: 14 });
    // The batch and the incidentes landed (step 11 writes them first); the aviso did not.
    expect(db.ler(CAMINHO_PEDIDO)?.estado).toBe(ESTADO_PEDIDO.error);
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toContain(
      idIncidenteLinhaLi(String(ID_ITEM_LI)),
    );
    expect(db.ler(chave)).toBeUndefined();

    db.falharEscrita(chave, null);
    const antes = db.escritas.length;
    expect((await importar(db, c)).r).toEqual({ kind: 'situacao-desconhecida' });
    expect(db.escritas.slice(antes).filter((e) => e.lote !== undefined)).toEqual([]);
    expect(db.ler(chave)).toMatchObject({
      resolvidoEm: null,
      relogioEvento: WATERMARK_2H,
      params: { loja: 'Loja de teste', pedido: String(NUMERO_LI), codigo: 'codigo_novo' },
    });
    expect(db.idsEm(`${CAMINHO_PEDIDO}/incidentes`)).toContain(
      idIncidenteLinhaLi(String(ID_ITEM_LI)),
    );
  });
});

describe('an unknown codigo on update', () => {
  it('keeps the stored estado, sets our error, raises the aviso; a known codigo later resolves it; a late OLDER import cannot', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);

    c.detalhe = pedidoLiBruto({
      situacao: { codigo: 'codigo_novo', id: 999 },
      data_modificacao: carimboLi(4),
    });
    c.historico = [
      ...historicoPagoLi(),
      linhaHistoricoLi(3, carimboLi(3), 'codigo_novo', 'pedido_pago'),
    ];
    expect((await importar(db, c)).r).toEqual({ kind: 'situacao-desconhecida' });
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      error: expect.stringContaining('[loja-integrada] '),
    });
    const chave = caminhoAvisoDoPedido(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida);
    expect(db.ler(chave)?.resolvidoEm).toBeNull();

    // A late, OLDER observation: obsoleto, nothing written, the row stays open.
    const tardio = cena({ data_modificacao: carimboLi(3) });
    expect((await importar(db, tardio)).r).toEqual({ kind: 'obsoleto' });
    expect(db.ler(chave)?.resolvidoEm).toBeNull();

    // A newer, KNOWN codigo resolves it and clears our error.
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(6) });
    c.historico = historicoPagoLi();
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    expect(db.ler(chave)?.resolvidoEm).not.toBeNull();
    expect(db.ler(CAMINHO_PEDIDO)?.error).toBeNull();
  });

  it('an error another writer left is never cleared', async () => {
    const db = novoDb();
    const c = cena();
    await importar(db, c);
    await refPedido(db).update({ error: 'NF-e rejeitada' });
    c.detalhe = pedidoLiBruto({ data_modificacao: carimboLi(5) });
    await importar(db, c);
    expect(db.ler(CAMINHO_PEDIDO)?.error).toBe('NF-e rejeitada');
  });
});

describe('the step-7 loop: a tracking write-back re-imported at a newer stamp', () => {
  it('only the watermark, ultimaModificacao and the pagamento’s lastProviderUpdate move', async () => {
    const db = novoDb();
    const comCodigo = (horas: number) =>
      pedidoLiBruto({
        situacao: { codigo: 'pedido_enviado', id: 11 },
        data_modificacao: carimboLi(horas),
        envios: [{ ...envioPadrao(), objeto: 'AA000000000BR' }],
      });
    const c = cena();
    c.detalhe = comCodigo(2);
    c.historico = [
      ...historicoPagoLi(),
      linhaHistoricoLi(3, carimboLi(1, 500), 'pedido_enviado', 'pedido_pago'),
    ];
    await importar(db, c);
    // The label flow took the freight further.
    const pedidoRef = refPedido(db);
    const freteAntes = {
      ...(db.ler(CAMINHO_PEDIDO)?.freteInicial as DocData),
      estado: ESTADO_FRETE.postado,
    };
    await pedidoRef.update({ freteInicial: freteAntes });
    const antes = db.ler(CAMINHO_PEDIDO)!;

    c.detalhe = comCodigo(8);
    const escritas = db.escritas.length;
    expect((await importar(db, c)).r).toEqual({ kind: 'importado' });
    const lote = db.escritas.slice(escritas).filter((e) => e.lote !== undefined);
    expect(lote.map((e) => [e.verbo, e.caminho])).toEqual([
      ['update', CAMINHO_PEDIDO],
      ['update', CAMINHO_PAGAMENTO],
    ]);
    expect(Object.keys(lote[0]!.dados!).sort()).toEqual([
      'lastMarketplaceUpdate',
      'ultimaModificacao',
    ]);
    expect(Object.keys(lote[1]!.dados!).sort()).toEqual([
      'lastProviderUpdate',
      'ultimaModificacao',
    ]);
    const depois = db.ler(CAMINHO_PEDIDO)!;
    expect(depois.estado).toBe(antes.estado);
    expect(depois.freteInicial).toEqual(antes.freteInicial);
    expect(depois.itens).toEqual(antes.itens);
  });
});

describe('clienteDoEnderecoLi: the owner of a stored endereço ref, read tolerantly', () => {
  it.each([
    ['canonical', 'documents/clientes/c-1/enderecos/e-1'],
    ['bare', 'clientes/c-1/enderecos/e-1'],
    ['doubled slashes', 'documents//clientes/c-1//enderecos/e-1'],
  ])('EQUAL: the %s form names the cliente `documents/clientes/c-1`', (_forma, ref) => {
    expect(clienteDoEnderecoLi(ref)).toBe('documents/clientes/c-1');
  });

  it('NEAR-MISS: one character more in the cliente id is another owner', () => {
    expect(clienteDoEnderecoLi('documents/clientes/c-12/enderecos/e-1')).toBe(
      'documents/clientes/c-12',
    );
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty text', ''],
    ['a number', 7],
    ['a map', { clienteId: 'c-1' }],
    ['a cliente ref', 'documents/clientes/c-1'],
    ['a collection path', 'documents/clientes/c-1/enderecos'],
    ['another root collection', 'documents/fornecedores/c-1/enderecos/e-1'],
    ['another subcollection', 'documents/clientes/c-1/contatos/e-1'],
    ['nested below an endereço', 'documents/clientes/c-1/enderecos/e-1/historico/h-1'],
    ['nested above the cliente', 'documents/lojas/l-1/clientes/c-1/enderecos/e-1'],
  ])('UNREADABLE (%s) ⇒ no owner, which matches no cliente', (_caso, ref) => {
    expect(clienteDoEnderecoLi(ref)).toBeNull();
  });
});

describe('clienteCanonicoLi: a stored cliente ref, read tolerantly', () => {
  it.each([
    ['canonical', 'documents/clientes/c-1'],
    ['bare', 'clientes/c-1'],
    ['doubled slashes', 'documents//clientes//c-1'],
  ])('EQUAL: the %s form is the cliente `documents/clientes/c-1`', (_forma, ref) => {
    expect(clienteCanonicoLi(ref)).toBe('documents/clientes/c-1');
  });

  it('NEAR-MISS: one character more in the id is another cliente', () => {
    expect(clienteCanonicoLi('clientes/c-12')).toBe('documents/clientes/c-12');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty text', ''],
    ['a number', 7],
    ['a map', { id: 'c-1' }],
    ['another collection', 'documents/fornecedores/c-1'],
    ['an endereço ref', 'documents/clientes/c-1/enderecos/e-1'],
    ['nested below another document', 'documents/lojas/l-1/clientes/c-1'],
    ['a collection path', 'documents/clientes'],
  ])('UNREADABLE (%s) ⇒ no cliente, which owns no endereço', (_caso, ref) => {
    expect(clienteCanonicoLi(ref)).toBeNull();
  });
});

describe('the units: no conversion outside dataLi.ts', () => {
  it('the watermark is the order stamp read in the LI zone, never as UTC', async () => {
    const db = novoDb();
    await importar(db, cena());
    const utc = Date.parse(`${carimboLi(2).slice(0, 23)}Z`) * 1000;
    expect(db.ler(CAMINHO_PEDIDO)?.lastMarketplaceUpdate).toBe(WATERMARK_2H);
    expect(WATERMARK_2H - utc).toBe(3 * 3_600 * 1_000_000);
  });

  it('the aviso key of the freight tipo is a digest: two keys the fold would merge stay apart', () => {
    expect(chaveDoAvisoDeFreteLi(CONTA, '1---PAC.X')).not.toBe(
      chaveDoAvisoDeFreteLi(CONTA, '1---PAC_X'),
    );
    expect(chaveDoAvisoDoPedidoLi(TIPO_AVISO.lojaIntegradaPedidoHub, CONTA, PEDIDO_ID)).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaPedidoHub, conta: CONTA, entidade: PEDIDO_ID }),
    );
  });

  it('the synthetic method is the key the helpers build', () => {
    expect(`${String(FORMA_ENVIO_LI.id)}---${FORMA_ENVIO_LI.code}`).toBe(CHAVE_FORMA_ENVIO_LI);
  });
});

describe('the wired seam (PR 5-d): the pipeline runs the REAL import, the run attempt deciding the history mode', () => {
  /**
   * A run's deps as the functions roots bind them — the seam read from the
   * table, the attempt on `registro` (`null` in a sweep) — with the read switch
   * ON as a PARAMETER (never the process environment) and the scripted
   * platform as the context's `fetch`.
   */
  function depsDaRun(
    c: Cena,
    tentativa: number | null,
  ): { readonly deps: DepsTarefaLi; readonly urls: string[] } {
    const { fetch, urls } = plataformaLi(roteiroDe(c));
    const deps: DepsTarefaLi = {
      ambiente: AMBIENTE_LIGADO,
      importador: importadorPedidoLi(),
      increment,
      arrayUnion,
      viaCep: viaCepFalso,
      agoraMs: () => AGORA_MS,
      esperar: () => Promise.resolve(),
      logger: loggerEspiao().logger,
      registro: {
        fluxo: 'intake',
        tentativa,
        idTarefa: tentativa === null ? null : `tarefa-${String(tentativa)}`,
        escrever: gravadorDeLog().escrever,
      },
      fetch,
    };
    return { deps, urls };
  }

  /** The detail says paid; the history never reaches it. */
  function comLacuna(): Cena {
    const c = cena();
    c.historico = [
      linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado'),
    ];
    return c;
  }

  it('a task resolves `done`/`importado`: the pedido and its pagamento written, no notification row', async () => {
    const db = novoDb();
    const { deps, urls } = depsDaRun(cena(), 0);

    const r = await tratarTarefaLeituraLi(asDb(db), payload(), 0, deps);

    expect(r).toEqual({ outcome: 'done', kind: 'importado', detail: 'importado' });
    // The import itself ran: a stand-in that answered `importado` writes none of this.
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: WATERMARK_2H,
    });
    expect(db.ler(CAMINHO_PAGAMENTO)).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 114.8,
    });
    expect(db.idsEm(COLECAO_NOTIFICACOES_LI)).toEqual([]);
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      '/v1/pedido/9001/',
      '/v1/situacao_historico/search/',
    ]);
  });

  it.each([0, 1])(
    'a history hole on attempt %i RETHROWS for the queue to retry: nothing written, no row',
    async (tentativa) => {
      const db = novoDb();
      const { deps } = depsDaRun(comLacuna(), tentativa);

      await expect(
        tratarTarefaLeituraLi(asDb(db), payload(), tentativa, deps),
      ).rejects.toBeInstanceOf(LiHistoricoIncompletoError);

      expect(db.ler(CAMINHO_PEDIDO)).toBeUndefined();
      expect(db.ler(CAMINHO_PAGAMENTO)).toBeUndefined();
      expect(db.idsEm(COLECAO_NOTIFICACOES_LI)).toEqual([]);
    },
  );

  it('the same hole on the LAST attempt imports DEGRADED — never persisted `failed`', async () => {
    const ultima = TASK_MAX_ATTEMPTS - 1;
    // The last attempt is the one a strict read would turn into a `failed` row;
    // the degraded read must import instead.
    expect(ultima).toBe(2);
    const db = novoDb();
    const { deps } = depsDaRun(comLacuna(), ultima);

    const r = await tratarTarefaLeituraLi(asDb(db), payload(), ultima, deps);

    expect(r).toEqual({ outcome: 'done', kind: 'importado', detail: 'importado' });
    expect(db.ler(CAMINHO_PAGAMENTO)?.dataAprovacao).toBeNull();
    expect(db.idsEm(COLECAO_NOTIFICACOES_LI)).toEqual([]);
  });

  it('the hot sweep runs it INLINE with no attempt, so degraded: a failed row with a hole imports and is deleted', async () => {
    const db = novoDb();
    const linha = seedNotificacaoLi(db, CONTA, String(NUMERO_LI), 'failed', {
      dataModificacaoLi: carimboLi(2),
    });
    const { deps } = depsDaRun(comLacuna(), null);

    const r = await reprocessarNotificacoesLi(asDb(db), { limit: 10, now: AGORA_MS }, deps);

    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    expect(db.ler(linha)).toBeUndefined();
    expect(db.ler(CAMINHO_PEDIDO)).toMatchObject({ estado: ESTADO_PEDIDO.pago });
    expect(db.ler(CAMINHO_PAGAMENTO)?.dataAprovacao).toBeNull();
  });
});
