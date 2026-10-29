/**
 * The owner's capture C1 through the REAL code (PR 5-c1, plan §3 decision 39):
 * one `searchOrders` page and six `getOrder` reads of six real Amazon BR orders
 * (`fixtures/__wire__/c1-*.json`), plus the Delivery `getInvoiceStatus` of the
 * in-transit one (`c2-status-aceita.json`). Each order is pinned as the
 * importer meets it FIRST (created or skipped; the estado, the freight, the
 * pagamento, the incidentes); a checkpoint that needs a STORED pedido runs the
 * real read as an UPDATE over a pre-read composed in test code from the same
 * fixture — always named as such (`antes…`), because Amazon never sent it.
 *
 * ## What the fixtures are
 *
 * The raw captures went through the offline sanitizer only (`scripts/sanitizar.ts`);
 * this file reads its output through the envelope's own validated reader.
 * REAL: every date, money amount, quantity, status and enum. FAKE: the ids
 * (keyed: one raw id is one fake across the batch, so the getInvoiceStatus and
 * the in-transit order share an orderId), the documents (a FIXED placeholder
 * that keeps the shape — dotted or bare, 11 or 14 digits, always DV-valid),
 * every personal text (`REDACTED`), the UF, the country and `addressType`.
 * What that allows here:
 *  - every buyer is the SAME CPF placeholder, so two orders in one FakeDb would
 *    be one cliente: each order is imported into its own harness;
 *  - the UF and the CEP are placeholders, so every endereço takes the
 *    unknown-UF recovery (`uf-nao-resolvida`): nothing here asserts an
 *    endereço's estado or país, or that log line's absence;
 *  - a placeholder is always DV-valid: a REAL document failing its check
 *    digits is beyond these fixtures.
 * The two placeholders are rebuilt at run time from their bases
 * (`testing/documentos.ts`): no DV-valid document is written in this file.
 *
 * ## D11
 *
 * No Amazon call: the global `fetch` refuses, the harness's scripted `fetch`
 * serves the fixture's body, and `findOrCreateCliente` / `ensureEndereco` are
 * spies (the emulator suite runs the real ones).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { nextPedidoEstado } from '@delfrance/data/pedido';
import {
  pedidoWireAmazonSchema,
  respostaSearchOrdersSchema,
  type PedidoWireAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  BANDEIRA,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  FORMA_PAGAMENTO,
  MODALIDADE_FRETE,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  STATUS_PAGAMENTO,
  TIPO_CLIENTE,
  statusToEstadoPedido,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, chavePedidoPrecisaAtencao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  DIRETORIO_WIRE_AMAZON,
  lerFixtureAmazon,
  type EnvelopeFixtureAmazon,
} from '../fixtures/wireCorpus';
import {
  INVOICE_STATUS_AMAZON,
  lerFreteAmazon,
  statusPacoteComMercadoriaForaAmazon,
} from '../frete/estadoFreteAmazon';
import type { PayloadNotificacaoAmazon } from '../notificacoes/notificacao';
import { gerarCnpj, gerarCpf, pontuarCpf } from '../testing/documentos';
import { asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso, caminhoConta } from '../testing/fixtures';
import {
  CONTA_IMPORTADOR,
  harnessImportador,
  payloadPoll,
  payloadPush,
  registroTeste,
  respostaDoPedido,
  type HarnessImportador,
} from '../testing/importadorAmazon';
import {
  identidadeCompradorAmazon,
  enderecoBrutoAmazon,
  intermediadorConfere,
  registroMarketplaceAmazon,
} from './clienteAmazon';
import { INCIDENTE_PEDIDO_AMAZON, type IncidentePedidoAmazon } from './codigosPedidoAmazon';
import {
  dinheiroDoPedidoAmazon,
  reaisDeMoneyAmazon,
  ressalvasDoDinheiroAmazon,
} from './dinheiroAmazon';
import { AmazonCancelamentoRecenteError, AmazonLeituraDefasadaError } from './erros';
import { ehStatusConhecidoAmazon } from './estadoPedidoAmazon';
import { importarPedidoAmazon } from './importarPedido';
import { idIncidenteDoCodigoAmazon } from './incidentesPedidoAmazon';
import { REGRA_D17_AMAZON, linhasRecebidasAmazon, regraD17Amazon } from './itensAmazon';
import { lerInstanteAmazon, lerLinhaPollAmazon } from './janelaPoll';
import { makePedidoIdAmazon } from './orderIds';
import {
  execucoesPagamentoAmazon,
  formaDePagamentoAmazon,
  somaPagamentoAmazon,
} from './pagamentoAmazon';
import { mapearPedidoAmazon, montarEscritaPedidoAmazon } from './pedidoMapeamento';
import { classificarVendaAmazon } from './vendaAmazon';

const m = vi.hoisted(() => ({ findOrCreateCliente: vi.fn(), ensureEndereco: vi.fn() }));

vi.mock('@delfrance/data/admin/clientes', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/clientes')>();
  return { ...real, findOrCreateCliente: m.findOrCreateCliente };
});
vi.mock('@delfrance/data/admin/enderecos', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/enderecos')>();
  return { ...real, ensureEndereco: m.ensureEndereco };
});

const CLIENTE = 'documents/clientes/cli-1';
const ENDERECO = 'documents/clientes/cli-1/enderecos/end-1';
const CONTA_REF = `documents/integracao/${CONTA_IMPORTADOR}`;

/** The sanitizer's buyer-document placeholder (bare, 11 digits), rebuilt from its base. */
const CPF_DO_FIXTURE = gerarCpf('000000001');
/** The sanitizer's acquirer placeholder (bare, 14 digits), rebuilt from its base. */
const CNPJ_ADQUIRENTE_DO_FIXTURE = gerarCnpj('112223330001');

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
  m.findOrCreateCliente.mockReset();
  m.findOrCreateCliente.mockResolvedValue({
    clienteId: 'cli-1',
    created: true,
    matchedBy: null,
    rejected: [],
    dropped: [],
    idMercadoLivreConflito: null,
  });
  m.ensureEndereco.mockReset();
  m.ensureEndereco.mockResolvedValue('end-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/* ------------------------------------ the fixtures ------------------------------------ */

type Json = Record<string, unknown>;

/** The six `getOrder` fixtures of C1 (`c1-busca.json` is the searchOrders page). */
const GET_ORDER_C1 = [
  'c1-busca-mesmo-pedido.json',
  'c1-cancelado-depois.json',
  'c1-dba-e-transito.json',
  'c1-devolvido.json',
  'c1-entregue-antigo.json',
  'c1-pix.json',
] as const;
type GetOrderC1 = (typeof GET_ORDER_C1)[number];

/** A fixture's envelope, through its own validated reader. */
function envelope(nome: string): EnvelopeFixtureAmazon {
  const leitura = lerFixtureAmazon(readFileSync(join(DIRETORIO_WIRE_AMAZON, nome), 'utf8'));
  if (!leitura.ok) throw new Error(`${nome} não é um envelope válido`);
  return leitura.data;
}

/** A getOrder fixture's `order`, a FRESH copy every call (tests compose pre-reads from it). */
function pedidoC1(nome: GetOrderC1): Json {
  return structuredClone((envelope(nome).resposta.corpo as { order: Json }).order);
}

/** `c1-busca.json`'s one searchOrders row, a fresh copy. */
function linhaDaBuscaC1(): Json {
  const [linha] = (envelope('c1-busca.json').resposta.corpo as { orders: Json[] }).orders;
  if (linha === undefined) throw new Error('c1-busca.json sem linha');
  return structuredClone(linha);
}

/** Every C1 order read: the searchOrders row and the six getOrder bodies. */
const LEITURAS_C1: readonly (readonly [string, () => Json])[] = [
  ['c1-busca.json (orders[0])', linhaDaBuscaC1],
  ...GET_ORDER_C1.map((nome) => [nome, () => pedidoC1(nome)] as const),
];

const lido = (order: Json): PedidoWireAmazon => pedidoWireAmazonSchema.parse(order);

/** The value at `caminho` inside `dados`, or `undefined`. */
function valorEm(dados: unknown, ...caminho: readonly (string | number)[]): unknown {
  return caminho.reduce<unknown>(
    (atual, chave) =>
      atual !== null && typeof atual === 'object'
        ? (atual as Record<string | number, unknown>)[chave]
        : undefined,
    dados,
  );
}

/** An ISO instant in µs, by an oracle independent of the importer's reader (ms-precision stamps). */
function usDe(iso: unknown): number {
  if (typeof iso !== 'string') throw new Error('instante ausente');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`instante ilegível: ${iso}`);
  return ms * 1000;
}

const orderIdDe = (order: Json): string => String(order.orderId);
const caminhoPedido = (order: Json): string =>
  `pedidos/${makePedidoIdAmazon(CONTA_IMPORTADOR, orderIdDe(order))}`;
const caminhoPagamento = (order: Json): string =>
  `${caminhoPedido(order)}/pagamentos/${makePedidoIdAmazon(CONTA_IMPORTADOR, orderIdDe(order))}`;
const pacote0 = (order: Json): Json => (order.packages as Json[])[0] as Json;
const linha0 = (order: Json): Json => (order.orderItems as Json[])[0] as Json;

/* ------------------------------------- the harness ------------------------------------- */

interface Execucao {
  readonly h: HarnessImportador;
  /** What `deps.agora` answers (the 15-min window is measured from it). */
  agoraMs: number;
  importar(
    corpo: Json,
    opcoes?: { payload?: PayloadNotificacaoAmazon; tentativa?: number | null },
  ): ReturnType<typeof importarPedidoAmazon>;
}

function montar(): Execucao {
  const h = harnessImportador();
  const ex: Execucao = {
    h,
    agoraMs: AGORA_MS,
    async importar(corpo, opcoes = {}) {
      h.respostas = [respostaDoPedido(corpo)];
      const contexto = await h.contexto();
      return importarPedidoAmazon(
        asDb(h.db),
        contexto,
        opcoes.payload ?? payloadPush(orderIdDe(corpo)),
        {
          agora: () => ex.agoraMs,
          increment,
          logger: h.log.logger,
          // A lookup that answers nothing: the fixtures' UF is a placeholder.
          viaCep: { buscarCep: () => Promise.resolve(null) },
          registro: registroTeste(opcoes.tentativa === undefined ? 0 : opcoes.tentativa),
        },
      );
    },
  };
  return ex;
}

/** The conta, re-seeded with extra fields. */
function conta(ex: Execucao, extra: Json) {
  ex.h.db.seed(caminhoConta(CONTA_IMPORTADOR), {
    ...(ex.h.db.ler(caminhoConta(CONTA_IMPORTADOR)) ?? {}),
    ...extra,
  });
}

/**
 * A conta with an operação, an active `amz` int_frete and a link doc per SKU of
 * `order`: nothing the CONFIGURATION lacks can file an incidente or an aviso,
 * so whatever is filed comes from the order.
 */
function configurar(ex: Execucao, order: Json, extraConta: Json = {}) {
  conta(ex, { operacaoOuterRef: 'documents/operacao/op-1', ...extraConta });
  ex.h.db.seed(`int_frete/amz-${CONTA_IMPORTADOR}`, {
    tipo: 'amz',
    contaAmazonContaFreteAmazonOuterRef: CONTA_REF,
    ativo: true,
    dataCadastro: 1,
  });
  for (const linha of order.orderItems as Json[]) {
    const sku = String((linha.product as Json).sellerSku);
    const produtoId = `p-${sku}`;
    ex.h.db.seed(`produtos/${produtoId}`, { nome: `Produto ${produtoId}` });
    ex.h.db.seed(`produtos/${produtoId}/prodAmazon/l-${produtoId}`, {
      contaAmazonOuterRef: CONTA_REF,
      sku,
    });
  }
}

const escritasEm = (ex: Execucao, prefixo: string) =>
  ex.h.db.escritas.filter((e) => e.caminho.startsWith(prefixo));
const incidentesDe = (ex: Execucao, order: Json): string[] =>
  ex.h.db
    .caminhos()
    .filter((c) => c.startsWith(`${caminhoPedido(order)}/incidentes/`))
    .map((c) => c.slice(`${caminhoPedido(order)}/incidentes/`.length))
    .sort();
const codigosDeLog = (ex: Execucao): unknown[] =>
  ex.h.log.linhas.filter((l) => l.meta?.evento === 'pedido').map((l) => l.meta?.codigo);
const idDo = (codigo: IncidentePedidoAmazon) => idIncidenteDoCodigoAmazon(codigo);
const frete = (ex: Execucao, order: Json) =>
  ex.h.db.ler(caminhoPedido(order))?.freteInicial as Json;

/* ======================================================================================= */

describe('★ the corpus: what every C1 read states (a new or re-sanitized capture that breaks one reds HERE first)', () => {
  it.each(LEITURAS_C1)(
    '%s: MERCHANT, DELIVERY_BY_AMAZON, a known status, ONE BUYER CPF and no MARKETPLACE, the invoice ACCEPTED, ONE execution summing to grandTotal, millisecond UTC stamps',
    (_nome, ler) => {
      const bruto = ler();
      const order = lido(bruto);
      expect(order.fulfillment?.fulfilledBy).toBe('MERCHANT');
      expect(order.programs).toEqual(['DELIVERY_BY_AMAZON']);
      expect(ehStatusConhecidoAmazon(order.fulfillment?.fulfillmentStatus ?? null)).toBe(true);
      expect(
        order.tax?.taxRegistrations?.map((r) => [r.entityType, r.taxRegistrationType]),
      ).toEqual([['BUYER', 'CPF']]);
      expect(registroMarketplaceAmazon(order)).toBeNull();
      expect(order.tax?.taxInvoicing?.invoiceStatus).toBe('ACCEPTED');
      expect(order.payment?.paymentExecutions).toHaveLength(1);
      // grandTotal is undeclared (passthrough) and read by nothing. The model
      // calls it what the seller receives; on C1 it equals Σ executions on every
      // read, the cancelled order included (no fee is deducted there).
      const grandTotal = valorEm(bruto, 'proceeds', 'grandTotal') as { amount: string };
      expect(somaPagamentoAmazon(execucoesPagamentoAmazon(order))).toBe(
        reaisDeMoneyAmazon(grandTotal),
      );
      for (const campo of ['createdTime', 'lastUpdatedTime'] as const) {
        const iso = bruto[campo] as string;
        expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(lerInstanteAmazon(iso)).toEqual({ us: usDe(iso), ms: Date.parse(iso) });
      }
    },
  );

  it('the order status is SHIPPED or CANCELLED — never an order-level DELIVERED: delivery and return live in the packages, whose (detailedStatus, status) pairs are exactly these four', () => {
    const status = new Set<unknown>();
    const pares = new Set<string>();
    for (const nome of GET_ORDER_C1) {
      const order = lido(pedidoC1(nome));
      status.add(order.fulfillment?.fulfillmentStatus);
      for (const p of order.packages ?? []) {
        pares.add(`${String(p.packageStatus?.detailedStatus)}/${String(p.packageStatus?.status)}`);
      }
    }
    expect([...status].sort()).toEqual(['CANCELLED', 'SHIPPED']);
    expect([...pares].sort()).toEqual([
      'DELIVERED/DELIVERED',
      'LABEL_CANCELLED/CANCELLED',
      'PICKED_UP/IN_TRANSIT',
      'RETURNED_TO_SELLER/UNDELIVERABLE',
    ]);
  });

  it('carrier and shippingService, kept verbatim by the sanitizer: AMZBR on six reads, ECTBR on the one return; Std EZ Local ×3, Regional ×3, National ×1 (the owner’s own count over the same seven raw files); shipTime is a whole-hour cutoff per carrier', () => {
    const porLeitura = LEITURAS_C1.map(([nome, ler]) => {
      const pacotes = ler().packages as Json[];
      expect(pacotes).toHaveLength(1);
      const p = pacotes[0] as Json;
      expect(p.shipTime).toMatch(p.carrier === 'ECTBR' ? /T17:00:00Z$/ : /T21:00:00Z$/);
      return [nome, p.carrier, p.shippingService];
    });
    expect(porLeitura).toEqual([
      ['c1-busca.json (orders[0])', 'AMZBR', 'Std EZ Local'],
      ['c1-busca-mesmo-pedido.json', 'AMZBR', 'Std EZ Local'],
      ['c1-cancelado-depois.json', 'AMZBR', 'Std EZ Regional'],
      ['c1-dba-e-transito.json', 'AMZBR', 'Std EZ Regional'],
      ['c1-devolvido.json', 'ECTBR', 'Std EZ Regional'],
      ['c1-entregue-antigo.json', 'AMZBR', 'Std EZ National'],
      ['c1-pix.json', 'AMZBR', 'Std EZ Local'],
    ]);
    const contagem = (i: 1 | 2) =>
      porLeitura.reduce<Record<string, number>>((acc, linha) => {
        const chave = String(linha[i]);
        acc[chave] = (acc[chave] ?? 0) + 1;
        return acc;
      }, {});
    expect(contagem(1)).toEqual({ AMZBR: 6, ECTBR: 1 });
    expect(contagem(2)).toEqual({
      'Std EZ Local': 3,
      'Std EZ Regional': 3,
      'Std EZ National': 1,
    });
  });

  it('★ PR 5-f f3: every real package carries a KNOWN detailedStatus, so the status-only goods-out fallback is never reached; stripped of it, IN_TRANSIT, DELIVERED and UNDELIVERABLE read as goods out and CANCELLED does not', () => {
    for (const nome of GET_ORDER_C1) {
      for (const p of lido(pedidoC1(nome)).packages ?? []) {
        expect(
          statusPacoteComMercadoriaForaAmazon(
            p.packageStatus?.detailedStatus,
            p.packageStatus?.status,
          ),
        ).toBe(false);
      }
    }
    const semDetalhe = (nome: GetOrderC1) =>
      statusPacoteComMercadoriaForaAmazon(
        undefined,
        valorEm(pacote0(pedidoC1(nome)), 'packageStatus', 'status'),
      );
    expect(semDetalhe('c1-dba-e-transito.json')).toBe(true);
    expect(semDetalhe('c1-pix.json')).toBe(true);
    expect(semDetalhe('c1-devolvido.json')).toBe(true);
    expect(semDetalhe('c1-cancelado-depois.json')).toBe(false);
  });
});

/* ======================================================================================= */

describe('★ C1 item 1 — the buyer: the dotted and the bare CPF are ONE cliente, nothing else folds into it', () => {
  const numeroDoComprador = (order: Json) =>
    valorEm(order, 'tax', 'taxRegistrations', 0, 'taxRegistrationNumber');
  function comNumero(order: Json, numero: string): Json {
    ((order.tax as Json).taxRegistrations as Json[])[0] = {
      entityType: 'BUYER',
      taxRegistrationType: 'CPF',
      taxRegistrationNumber: numero,
    };
    return order;
  }

  it('EQUAL: the 2026-10-20 order sends the DOTTED form, the others the BARE one, in the same batch ⇒ the same identity: the bare digits, pessoa física, no IE, no phone, no e-mail', () => {
    const pontuado = pedidoC1('c1-busca-mesmo-pedido.json');
    const puro = pedidoC1('c1-entregue-antigo.json');
    // Anti-vacuity: Amazon really sent two different strings.
    expect(numeroDoComprador(pontuado)).toBe(pontuarCpf(CPF_DO_FIXTURE));
    expect(numeroDoComprador(puro)).toBe(CPF_DO_FIXTURE);
    expect(numeroDoComprador(linhaDaBuscaC1())).toBe(pontuarCpf(CPF_DO_FIXTURE));
    const identidade = identidadeCompradorAmazon(lido(pontuado));
    expect(identidade).toEqual({
      ok: true,
      campos: {
        tipo: TIPO_CLIENTE.pessoaFisica,
        nome: 'REDACTED',
        cpf_cnpj: CPF_DO_FIXTURE,
        idEstrangeiro: null,
        ie: null,
        telefone: null,
        email: null,
      },
    });
    expect(identidadeCompradorAmazon(lido(puro))).toEqual(identidade);
  });

  it('NEAR-MISS: one digit apart stays apart — another DV-valid CPF in the dotted form is ANOTHER document; the dotted form with a wrong check digit is no document at all', () => {
    const outroCpf = gerarCpf('000000002');
    expect(outroCpf).not.toBe(CPF_DO_FIXTURE);
    const outro = identidadeCompradorAmazon(
      lido(comNumero(pedidoC1('c1-busca-mesmo-pedido.json'), pontuarCpf(outroCpf))),
    );
    expect(outro).toMatchObject({ ok: true, campos: { cpf_cnpj: outroCpf } });
    const pontuado = pontuarCpf(CPF_DO_FIXTURE);
    const digitoErrado = `${pontuado.slice(0, -1)}${pontuado.endsWith('0') ? '1' : '0'}`;
    expect(
      identidadeCompradorAmazon(
        lido(comNumero(pedidoC1('c1-busca-mesmo-pedido.json'), digitoErrado)),
      ),
    ).toEqual({ ok: false, motivo: 'sem-documento' });
  });

  it('★ through the importer: the dotted read and the bare read hand findOrCreateCliente BYTE-EQUAL fields, and each pedido carries the resolved cliente', async () => {
    for (const nome of ['c1-busca-mesmo-pedido.json', 'c1-entregue-antigo.json'] as const) {
      const ex = montar();
      const order = pedidoC1(nome);
      configurar(ex, order);
      await ex.importar(order);
      expect(ex.h.db.ler(caminhoPedido(order))?.clientePedidoOuterRef).toBe(CLIENTE);
    }
    expect(m.findOrCreateCliente).toHaveBeenCalledTimes(2);
    const [pontuado, puro] = m.findOrCreateCliente.mock.calls.map((c) => (c[1] as Json).fields);
    expect(pontuado).toEqual(puro);
    expect(JSON.stringify(pontuado)).toBe(JSON.stringify(puro));
    expect(pontuado).toMatchObject({ cpf_cnpj: CPF_DO_FIXTURE, ie: null });
  });

  it('the recipient phone Amazon sends on the in-transit read is never read: the cliente and the endereço both get telefone null (decision 17)', async () => {
    const order = pedidoC1('c1-dba-e-transito.json');
    // Anti-vacuity: the only C1 read carrying one.
    expect(valorEm(order, 'recipient', 'deliveryAddress', 'phone')).toEqual(expect.any(String));
    const ex = montar();
    configurar(ex, order);
    await ex.importar(order);
    expect((m.findOrCreateCliente.mock.calls[0]?.[1] as Json).fields).toMatchObject({
      telefone: null,
    });
    expect(m.ensureEndereco.mock.calls[0]?.[2]).toMatchObject({ telefone: null, cpf_cnpj: null });
  });

  it('★ the endereço (decision 18): extendedFields is the source when sent (c1-pix); WITHOUT it (c1-devolvido, the one Correios order) número, bairro and complemento are absent and addressLine1 is the logradouro; addressLine2 is never a source', () => {
    const comExtras = pedidoC1('c1-pix.json');
    const extras = valorEm(comExtras, 'recipient', 'deliveryAddress', 'extendedFields') as Json;
    const bruto = enderecoBrutoAmazon(lido(comExtras))?.bruto;
    expect(bruto).toMatchObject({
      logradouro: extras.streetName,
      numero: extras.streetNumber,
      bairro: extras.neighborhood,
      complemento: extras.complement,
    });
    expect(bruto?.numero).not.toBeNull();

    const semExtras = pedidoC1('c1-devolvido.json');
    const endereco = valorEm(semExtras, 'recipient', 'deliveryAddress') as Json;
    // Anti-vacuity: the real shape has no extendedFields and does carry an addressLine2.
    expect(Object.hasOwn(endereco, 'extendedFields')).toBe(false);
    expect(endereco.addressLine2).toEqual(expect.any(String));
    endereco.addressLine2 = 'Marca da Linha Dois';
    const sem = enderecoBrutoAmazon(lido(semExtras))?.bruto;
    expect(sem).toMatchObject({
      logradouro: endereco.addressLine1,
      numero: null,
      bairro: null,
      complemento: null,
    });
    expect(JSON.stringify(sem)).not.toContain('Marca da Linha Dois');
  });

  it('★ MARKETPLACE: no C1 read carries the registration, as Amazon documents (PENDING/UNSHIPPED reads only, and C1 holds none: every read is SHIPPED or CANCELLED) ⇒ no verdict, never a mismatch', () => {
    const cnpjDaConta = gerarCnpj();
    for (const nome of GET_ORDER_C1) {
      const order = lido(pedidoC1(nome));
      expect(order.tax?.taxRegistrations?.every((r) => r.entityType === 'BUYER')).toBe(true);
      expect(intermediadorConfere(registroMarketplaceAmazon(order), cnpjDaConta)).toBe(
        'sem-veredito',
      );
    }
    // NEAR-MISS: the root-aware arm still answers when a registration exists (synthetic input).
    expect(intermediadorConfere(cnpjDaConta.slice(0, 8), cnpjDaConta)).toBe('confere');
  });

  it('★ end to end: a standing intermediador-divergente is neither resolved nor re-raised by a real read without the registration; the pedido carries the conta ref the NF-e takes its intermediador from', async () => {
    const ex = montar();
    const cnpjDaConta = gerarCnpj();
    const avisoPath = caminhoAviso(
      chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.intermediadorDivergente),
    );
    // Raised by a pre-read composed in test code: c1-pix with a DIVERGING registration.
    const divergente = pedidoC1('c1-pix.json');
    ((divergente.tax as Json).taxRegistrations as Json[]).push({
      entityType: 'MARKETPLACE',
      taxRegistrationNumber: gerarCnpj('987654320001'),
    });
    configurar(ex, divergente, { cpf_cnpj: cnpjDaConta });
    await ex.importar(divergente);
    expect(ex.h.db.ler(avisoPath)?.resolvidoEm).toBeNull();
    const escritasDoAviso = ex.h.db.escritasEm(avisoPath).length;

    const real = pedidoC1('c1-entregue-antigo.json');
    configurar(ex, real, { cpf_cnpj: cnpjDaConta });
    await expect(ex.importar(real)).resolves.toMatchObject({ kind: 'importado' });
    expect(ex.h.db.ler(avisoPath)?.resolvidoEm).toBeNull();
    expect(ex.h.db.escritasEm(avisoPath)).toHaveLength(escritasDoAviso);
    expect(ex.h.db.ler(caminhoPedido(real))?.integracaoPedidoOuterRef).toBe(CONTA_REF);
  });

  it('withheld PII on the CANCELLED read: buyer and recipient ABSENT (not blank) while the BUYER registration and the invoice status stay ⇒ sem-nome and no endereço; NEAR-MISS: a three-month-old delivered order still carries both', () => {
    const cancelado = pedidoC1('c1-cancelado-depois.json');
    expect(Object.hasOwn(cancelado, 'buyer')).toBe(false);
    expect(Object.hasOwn(cancelado, 'recipient')).toBe(false);
    expect(numeroDoComprador(cancelado)).toBe(CPF_DO_FIXTURE);
    expect(identidadeCompradorAmazon(lido(cancelado))).toEqual({ ok: false, motivo: 'sem-nome' });
    expect(enderecoBrutoAmazon(lido(cancelado))).toBeNull();

    const antigo = pedidoC1('c1-pix.json');
    expect(antigo.createdTime).toMatch(/^2026-07-/);
    expect(identidadeCompradorAmazon(lido(antigo))).toMatchObject({ ok: true });
    expect(enderecoBrutoAmazon(lido(antigo))).not.toBeNull();
  });
});

/* ======================================================================================= */

/** The four orders a first sight IMPORTS, with what the real code makes of each. */
const APROVADOS_C1 = [
  {
    nome: 'c1-busca-mesmo-pedido.json',
    frete: ESTADO_FRETE.entregue,
    forma: FORMA_PAGAMENTO.cartao_credito,
    bandeira: BANDEIRA.mastercard,
    valor: 36.11,
    valorCobrado: 36.11,
    valorFrete: null,
  },
  {
    nome: 'c1-dba-e-transito.json',
    frete: ESTADO_FRETE.postado,
    forma: FORMA_PAGAMENTO.cartao_credito,
    bandeira: BANDEIRA.visa,
    valor: 179.54,
    valorCobrado: 179.54,
    valorFrete: null,
  },
  {
    // The only order whose buyer paid shipping: under the conta default (FOB)
    // the pagamento states the note's total, the pedido still totals the freight.
    nome: 'c1-entregue-antigo.json',
    frete: ESTADO_FRETE.entregue,
    forma: FORMA_PAGAMENTO.pix,
    bandeira: null,
    valor: 39.44,
    valorCobrado: 63.48,
    valorFrete: 24.04,
  },
  {
    nome: 'c1-pix.json',
    frete: ESTADO_FRETE.entregue,
    forma: FORMA_PAGAMENTO.pix,
    bandeira: null,
    valor: 39.91,
    valorCobrado: 39.91,
    valorFrete: null,
  },
] as const;

describe('★ first sight of every approved C1 order (decision 12: a first-seen SHIPPED is imported) — the pedido, the freight, the pagamento, and NOTHING filed', () => {
  it.each(APROVADOS_C1)(
    '$nome ⇒ created pago, freight $frete, forma $forma, valor $valor',
    async (caso) => {
      const order = pedidoC1(caso.nome);
      const ex = montar();
      configurar(ex, order);
      const r = await ex.importar(order);
      expect(r).toEqual({
        kind: 'importado',
        detalhe: {
          acao: 'criado',
          itens: REGRA_D17_AMAZON.escrever,
          linhasPreservadas: 0,
          linhasDivergentes: 0,
          linhasSemProduto: 0,
        },
      });

      const watermarkUs = usDe(order.lastUpdatedTime);
      const pacote = pacote0(order);
      const doc = ex.h.db.ler(caminhoPedido(order)) ?? {};
      expect(doc).toMatchObject({
        estado: ESTADO_PEDIDO.pago,
        numero: orderIdDe(order),
        integracaoPedidoOuterRef: CONTA_REF,
        clientePedidoOuterRef: CLIENTE,
        lastMarketplaceUpdate: watermarkUs,
        valorCobrado: caso.valorCobrado,
        descontoTotal: 0,
        marketplace: {
          tipo: 'amazon',
          status: 'SHIPPED',
          statusEm: watermarkUs,
          cancelBy: null,
          invoiceStatus: 'ACCEPTED',
          fulfilledBy: 'MERCHANT',
          programs: ['DELIVERY_BY_AMAZON'],
        },
      });
      // The one line, bound, at Amazon's unit price (tax-inclusive: no TAX row exists).
      const itens = Object.values(doc.itens as Record<string, Json[]>).flat();
      expect(itens).toHaveLength(1);
      expect(itens[0]).toMatchObject({
        mktplaceId: linha0(order).orderItemId,
        quantidade: 1,
        precoDeVenda: reaisDeMoneyAmazon(
          valorEm(linha0(order), 'product', 'price', 'unitPrice') as { amount: string },
        ),
        descontoUnitario: 0,
      });

      expect(frete(ex, order)).toMatchObject({
        estado: caso.frete,
        externalOptionIntegracao: 'amz',
        modalidade: MODALIDADE_FRETE.fob,
        valorCobrado: caso.valorFrete,
        codRastreio: pacote.trackingNumber,
        enderecoFreteOuterReference: ENDERECO,
        prazoDespacho: usDe(valorEm(order, 'fulfillment', 'shipByWindow', 'latestDateTime')),
        pacotes: [
          {
            numero: pacote.packageReferenceId,
            estado: caso.frete,
            estadoMarketplace: valorEm(pacote, 'packageStatus', 'detailedStatus'),
            statusMarketplace: valorEm(pacote, 'packageStatus', 'status'),
            codRastreio: pacote.trackingNumber,
            canalId: null,
            prazoDespacho: null,
            atualizadoEm: watermarkUs,
            fonte: 'getOrder',
          },
        ],
      });

      // C1 item 2: the real token, the always-built block, the bare 14-digit acquirer.
      expect(ex.h.db.ler(caminhoPagamento(order))).toMatchObject({
        id: orderIdDe(order),
        forma_de_pagamento: caso.forma,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        valor: caso.valor,
        descricaoPagamento: null,
        dataAprovacao: watermarkUs,
        dataCancelamento: null,
        cartao: {
          tpIntegra: '2',
          bandeira: caso.bandeira,
          numeroCartao: null,
          cAut: 'REDACTED',
          cnpj_instituicao: CNPJ_ADQUIRENTE_DO_FIXTURE,
          tarifa: null,
          tarifaFixa: null,
          prazoRecebimento: null,
        },
      });

      // Nothing filed: no incidente (money, payment, line), no aviso of any kind.
      expect(incidentesDe(ex, order)).toEqual([]);
      expect(escritasEm(ex, 'avisos/')).toEqual([]);
      // The one log code is the fixtures' redacted UF (a sanitizer artifact).
      expect(codigosDeLog(ex).filter((c) => c !== 'uf-nao-resolvida')).toEqual([]);
    },
  );

  // The money comparators are NOT pinned here: on a shipped redelivery D17 keeps
  // the lines (`manter`) and the stored pagamento's positive valor is only
  // filled when empty, so no centavo comparison decides anything (each one
  // mutated to "always different" leaves this test green). Decision 41's
  // centavo near-misses live in the unit suites that re-derive the money group.
  it('★ an equal-clock redelivery of a real order ⇒ sem-mudanca with ZERO writes: no field of a real card block or package row reads as a change (decision 41)', async () => {
    for (const nome of [
      'c1-pix.json',
      'c1-dba-e-transito.json',
      'c1-entregue-antigo.json',
    ] as const) {
      const ex = montar();
      const order = pedidoC1(nome);
      configurar(ex, order);
      await ex.importar(order);
      const escritas = ex.h.db.escritas.length;
      await expect(ex.importar(pedidoC1(nome))).resolves.toMatchObject({
        kind: 'sem-mudanca',
        detalhe: { acao: null, itens: REGRA_D17_AMAZON.manter },
      });
      expect(ex.h.db.escritas).toHaveLength(escritas);
    }
  });
});

/* ======================================================================================= */

describe('★ C1 item 2 — the payment', () => {
  it('the exact tokens Amazon BR sends: CreditCard ⇒ 3 and Pix ⇒ 17, both known; NEAR-MISS: another casing is NOT folded (99, unknown)', () => {
    const metodos = new Set(
      GET_ORDER_C1.map((n) =>
        valorEm(pedidoC1(n), 'payment', 'paymentExecutions', 0, 'paymentMethod'),
      ),
    );
    expect([...metodos].sort()).toEqual(['CreditCard', 'Pix']);
    expect(formaDePagamentoAmazon('CreditCard')).toEqual({
      forma: FORMA_PAGAMENTO.cartao_credito,
      conhecida: true,
      descricao: null,
    });
    expect(formaDePagamentoAmazon('Pix')).toEqual({
      forma: FORMA_PAGAMENTO.pix,
      conhecida: true,
      descricao: null,
    });
    expect(formaDePagamentoAmazon('PIX')).toMatchObject({
      forma: FORMA_PAGAMENTO.outros,
      conhecida: false,
    });
  });

  it('the acquirerId is a BARE 14-digit CNPJ on every execution, Pix included; the card brands are Amazon’s CamelCase (MasterCard, Visa, Elo) and absent on Pix', () => {
    const marcas: unknown[] = [];
    for (const nome of GET_ORDER_C1) {
      const [execucao] = execucoesPagamentoAmazon(lido(pedidoC1(nome)));
      expect(execucao?.adquirente).toBe(CNPJ_ADQUIRENTE_DO_FIXTURE);
      if (execucao?.metodo === 'Pix') expect(execucao.marca).toBeUndefined();
      else marcas.push(execucao?.marca);
    }
    expect([...new Set(marcas)].sort()).toEqual(['Elo', 'MasterCard', 'Visa']);
  });
});

/* ======================================================================================= */

describe('★ C1 item 4 — the money: unitPrice tax-inclusive, ITEM and SHIPPING rows only, no money incidente', () => {
  it.each(LEITURAS_C1)(
    '%s: only ITEM / SHIPPING breakdowns, none itemised, no ressalva',
    (_nome, ler) => {
      const bruto = ler();
      const tipos = new Set<unknown>();
      for (const quebras of [
        valorEm(bruto, 'proceeds', 'breakdowns'),
        ...(bruto.orderItems as Json[]).map((l) => valorEm(l, 'proceeds', 'breakdowns')),
      ] as Json[][]) {
        for (const q of quebras) {
          tipos.add(q.type);
          expect(Object.hasOwn(q, 'detailedBreakdowns')).toBe(false);
        }
      }
      expect([...tipos].every((t) => t === 'ITEM' || t === 'SHIPPING')).toBe(true);
      expect(ressalvasDoDinheiroAmazon(lido(bruto))).toEqual({
        linhasDescontoNaoDetalhado: 0,
        quebrasImposto: 0,
      });
    },
  );

  it('the freight: 24.04 on the one order whose buyer paid shipping, ABSENT (null, never 0) on every other — and no discount anywhere', () => {
    expect(dinheiroDoPedidoAmazon(lido(pedidoC1('c1-entregue-antigo.json')))).toEqual({
      descontoTotal: 0,
      valorFrete: 24.04,
    });
    for (const nome of GET_ORDER_C1.filter((n) => n !== 'c1-entregue-antigo.json')) {
      expect(dinheiroDoPedidoAmazon(lido(pedidoC1(nome)))).toEqual({
        descontoTotal: 0,
        valorFrete: null,
      });
    }
  });

  it('★ the FOB answer of 2026-10-21 on a REAL buyer-paid shipping order: valor 39.44 (Σ executions − freight) under the conta default, 63.48 under CIF; the pedido totals 63.48 either way; no pagamento-divergente', async () => {
    for (const [modalidade, valor] of [
      [MODALIDADE_FRETE.fob, 39.44],
      [MODALIDADE_FRETE.cif, 63.48],
    ] as const) {
      const ex = montar();
      const order = pedidoC1('c1-entregue-antigo.json');
      configurar(ex, order, { modalidadeFreteImportacao: modalidade });
      await ex.importar(order);
      expect(ex.h.db.ler(caminhoPagamento(order))?.valor).toBe(valor);
      expect(ex.h.db.ler(caminhoPedido(order))?.valorCobrado).toBe(63.48);
      expect(frete(ex, order)).toMatchObject({ modalidade, valorCobrado: 24.04 });
      expect(incidentesDe(ex, order)).toEqual([]);
    }
  });
});

/* ======================================================================================= */

describe('★ C1 item 4b and decisions 12 / 44 — the cancelled and the returned order on first sight', () => {
  it('the real cancellation ZEROES the quantity (0, not absent) and KEEPS the price, the proceeds and the payment; the per-line execution names MERCHANT ⇒ D17 row 2', () => {
    const order = lido(pedidoC1('c1-cancelado-depois.json'));
    expect(linhasRecebidasAmazon(order)).toEqual([
      expect.objectContaining({
        quantidade: 0,
        precoUnitario: 82.85,
        execucaoCancelamento: true,
        solicitacaoCancelamento: false,
        canceladoPor: 'MERCHANT',
      }),
    ]);
    expect(somaPagamentoAmazon(execucoesPagamentoAmazon(order))).toBe(82.85);
    const venda = classificarVendaAmazon(order, null);
    expect(venda).toMatchObject({
      fase: 'cancelado',
      cancelado: true,
      execucao: true,
      reversaoPacote: false,
      zerado: false,
      revertido: true,
      primeiraVez: true,
    });
    expect(regraD17Amazon(venda)).toEqual({
      linha: 2,
      regra: REGRA_D17_AMAZON.canceladoNaoImportado,
    });
  });

  it('the real return is a SHIPPED order with full money whose ONLY reversal signal is the package (RETURNED_TO_SELLER) ⇒ D17 row 3', () => {
    const venda = classificarVendaAmazon(lido(pedidoC1('c1-devolvido.json')), null);
    expect(venda).toMatchObject({
      fase: 'env',
      cancelado: false,
      execucao: false,
      reversaoPacote: true,
      zerado: false,
      revertido: true,
    });
    expect(regraD17Amazon(venda)).toEqual({
      linha: 3,
      regra: REGRA_D17_AMAZON.reversaoNaoImportada,
    });
  });

  it('★ c1-cancelado-depois long after the cancellation ⇒ cancelado-nao-importado: ZERO writes, no cliente, no endereço', async () => {
    const ex = montar();
    const order = pedidoC1('c1-cancelado-depois.json');
    configurar(ex, order);
    const escritas = ex.h.db.escritas.length;
    await expect(ex.importar(order)).resolves.toEqual({ kind: 'cancelado-nao-importado' });
    expect(ex.h.db.escritas).toHaveLength(escritas);
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(m.ensureEndereco).not.toHaveBeenCalled();
    expect(codigosDeLog(ex)).toEqual(['cancelado-nao-importado']);
  });

  it('★ the 15-min window measured from the REAL millisecond stamp: 1 ms short ⇒ AmazonCancelamentoRecenteError (idadeS 899), zero writes; exactly 15 min ⇒ skipped', async () => {
    const order = pedidoC1('c1-cancelado-depois.json');
    const carimboMs = Date.parse(String(order.lastUpdatedTime));
    const cedo = montar();
    cedo.agoraMs = carimboMs + 15 * 60_000 - 1;
    await expect(cedo.importar(order)).rejects.toBeInstanceOf(AmazonCancelamentoRecenteError);
    expect(cedo.h.db.escritas).toEqual([]);
    expect(cedo.h.log.linhas.map((l) => l.meta)).toContainEqual(
      expect.objectContaining({ codigo: 'cancelamento-recente', idadeS: 899 }),
    );
    const exato = montar();
    exato.agoraMs = carimboMs + 15 * 60_000;
    await expect(exato.importar(pedidoC1('c1-cancelado-depois.json'))).resolves.toEqual({
      kind: 'cancelado-nao-importado',
    });
    expect(exato.h.db.escritas).toEqual([]);
  });

  it('★ c1-devolvido on first sight ⇒ reversao-nao-importada, ZERO writes (decision 44); inside the window it WAITS like a cancellation', async () => {
    const ex = montar();
    const order = pedidoC1('c1-devolvido.json');
    configurar(ex, order);
    const escritas = ex.h.db.escritas.length;
    await expect(ex.importar(order)).resolves.toEqual({ kind: 'reversao-nao-importada' });
    expect(ex.h.db.escritas).toHaveLength(escritas);
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(codigosDeLog(ex)).toEqual(['reversao-nao-importada']);

    const cedo = montar();
    cedo.agoraMs = Date.parse(String(order.lastUpdatedTime)) + 5 * 60_000;
    await expect(cedo.importar(pedidoC1('c1-devolvido.json'))).rejects.toBeInstanceOf(
      AmazonCancelamentoRecenteError,
    );
    expect(cedo.h.db.escritas).toEqual([]);
  });
});

/* ======================================================================================= */

describe('★ decision 39, the review row: one order through searchOrders and getOrder within a minute', () => {
  it('the row and the body are IDENTICAL, key order included — lastUpdatedTime byte-equal, so the poll’s µs is the read’s', () => {
    const busca = linhaDaBuscaC1();
    const get = pedidoC1('c1-busca-mesmo-pedido.json');
    expect(busca).toStrictEqual(get);
    expect(JSON.stringify(busca)).toBe(JSON.stringify(get));
    expect(busca.lastUpdatedTime).toBe('2026-10-21T09:35:47.932Z');
    expect(lerLinhaPollAmazon(busca)).toEqual({
      orderId: orderIdDe(get),
      lastUpdatedUs: usDe(get.lastUpdatedTime),
      lastUpdatedMs: Date.parse(String(get.lastUpdatedTime)),
    });
    // The page itself: one row, a next token, a millisecond lastUpdatedBefore.
    const pagina = respostaSearchOrdersSchema.parse(envelope('c1-busca.json').resposta.corpo);
    expect(pagina.orders).toHaveLength(1);
    expect(pagina.pagination?.nextToken).toEqual(expect.any(String));
    expect(pagina.lastUpdatedBefore).toMatch(/\.\d{3}Z$/);
  });

  it('★ the poll’s task (the search µs) with the getOrder body ⇒ created, never refused as lagging; the push with the SEARCH row as body ⇒ sem-mudanca, ZERO writes', async () => {
    const ex = montar();
    const get = pedidoC1('c1-busca-mesmo-pedido.json');
    configurar(ex, get);
    const us = lerLinhaPollAmazon(linhaDaBuscaC1())?.lastUpdatedUs ?? 0;
    await expect(
      ex.importar(get, { payload: payloadPoll(us, orderIdDe(get)) }),
    ).resolves.toMatchObject({ kind: 'importado', detalhe: { acao: 'criado' } });
    const escritas = ex.h.db.escritas.length;
    await expect(ex.importar(linhaDaBuscaC1())).resolves.toMatchObject({ kind: 'sem-mudanca' });
    expect(ex.h.db.escritas).toHaveLength(escritas);
  });

  it('NEAR-MISS: a poll task ONE µs newer than the read ⇒ AmazonLeituraDefasadaError on a queue attempt (decision 3)', async () => {
    const ex = montar();
    const get = pedidoC1('c1-busca-mesmo-pedido.json');
    configurar(ex, get);
    await expect(
      ex.importar(get, { payload: payloadPoll(usDe(get.lastUpdatedTime) + 1, orderIdDe(get)) }),
    ).rejects.toBeInstanceOf(AmazonLeituraDefasadaError);
    expect(escritasEm(ex, 'pedidos/')).toEqual([]);
  });
});

/* ======================================================================================= */

/** The in-transit order as it stood SCHEDULED: composed in test code (Amazon never sent it). */
function antesAgendadoDbaETransito(): Json {
  const order = pedidoC1('c1-dba-e-transito.json');
  const pacote = pacote0(order);
  (order.fulfillment as Json).fulfillmentStatus = 'UNSHIPPED';
  pacote.packageStatus = { detailedStatus: 'PENDING_PICK_UP', status: 'PENDING' };
  order.lastUpdatedTime = pacote.createdTime;
  return order;
}

/** The cancelled order as it stood APPROVED: composed in test code (Amazon never sent it). */
function antesDoCancelamento(): Json {
  const order = pedidoC1('c1-cancelado-depois.json');
  const linha = linha0(order);
  linha.quantityOrdered = 1;
  linha.fulfillment = { quantityUnfulfilled: 1, quantityFulfilled: 0 };
  delete linha.cancellation;
  delete order.packages;
  (order.fulfillment as Json).fulfillmentStatus = 'UNSHIPPED';
  // The buyer and the recipient the approved read carried (placeholders, from another fixture).
  const comPii = pedidoC1('c1-entregue-antigo.json');
  order.buyer = comPii.buyer;
  order.recipient = comPii.recipient;
  order.lastUpdatedTime = '2026-10-24T14:00:00.000Z';
  return order;
}

/** The returned order while it was IN TRANSIT: composed in test code (Amazon never sent it). */
function antesDaDevolucao(): Json {
  const order = pedidoC1('c1-devolvido.json');
  pacote0(order).packageStatus = { detailedStatus: 'PICKED_UP', status: 'IN_TRANSIT' };
  order.lastUpdatedTime = '2026-09-17T18:00:00.000Z';
  return order;
}

describe('★ the real reads as UPDATES of a stored pedido (each pre-read composed in test code from the same fixture)', () => {
  it('c1-dba-e-transito over its scheduled pre-read ⇒ freight aguardandoPostagem → postado, the diary row stamped with the real clock; the same read again ⇒ sem-mudanca, zero writes', async () => {
    const ex = montar();
    const antes = antesAgendadoDbaETransito();
    configurar(ex, antes);
    await ex.importar(antes);
    expect(frete(ex, antes).estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    const real = pedidoC1('c1-dba-e-transito.json');
    await expect(ex.importar(real)).resolves.toMatchObject({ kind: 'importado' });
    expect(frete(ex, real)).toMatchObject({
      estado: ESTADO_FRETE.postado,
      pacotes: [
        expect.objectContaining({
          estado: ESTADO_FRETE.postado,
          estadoMarketplace: 'PICKED_UP',
          statusMarketplace: 'IN_TRANSIT',
          atualizadoEm: usDe(real.lastUpdatedTime),
        }),
      ],
    });
    const escritas = ex.h.db.escritas.length;
    await expect(ex.importar(pedidoC1('c1-dba-e-transito.json'))).resolves.toMatchObject({
      kind: 'sem-mudanca',
    });
    expect(ex.h.db.escritas).toHaveLength(escritas);
  });

  // At an EQUAL clock the row's stamp cannot tell "unmoved" from "re-stamped"
  // (both are the same µs): the row-clock rule is pinned by the NEWER-clock
  // unchanged-package re-read below.
  it('★ the 7-r readiness pair (C1 holds only its first half): DELIVERED at an EQUAL clock ⇒ entregue (decision 2); at a NEWER clock ⇒ entregue with the row stamped at it', async () => {
    for (const novoClock of [null, '2026-11-06T17:00:00.000Z'] as const) {
      const ex = montar();
      const transito = pedidoC1('c1-dba-e-transito.json');
      configurar(ex, transito);
      await ex.importar(transito);
      const entregue = pedidoC1('c1-dba-e-transito.json');
      pacote0(entregue).packageStatus = { detailedStatus: 'DELIVERED', status: 'DELIVERED' };
      if (novoClock !== null) entregue.lastUpdatedTime = novoClock;
      await expect(ex.importar(entregue)).resolves.toMatchObject({ kind: 'importado' });
      expect(frete(ex, entregue)).toMatchObject({
        estado: ESTADO_FRETE.entregue,
        pacotes: [
          expect.objectContaining({
            estadoMarketplace: 'DELIVERED',
            atualizadoEm: usDe(novoClock ?? transito.lastUpdatedTime),
          }),
        ],
      });
    }
  });

  it('★ the row clock (decision 2): c1-dba-e-transito re-read at a NEWER clock with its package UNCHANGED ⇒ the pedido moves to the new watermark, the diary row keeps the first read’s stamp', async () => {
    const ex = montar();
    const transito = pedidoC1('c1-dba-e-transito.json');
    configurar(ex, transito);
    await ex.importar(transito);
    const [linhaAntes] = frete(ex, transito).pacotes as Json[];
    expect(linhaAntes).toMatchObject({ atualizadoEm: usDe(transito.lastUpdatedTime) });

    // Composed in test code: the same read, the order clock one hour later.
    const depois = pedidoC1('c1-dba-e-transito.json');
    depois.lastUpdatedTime = '2026-10-28T17:37:54.503Z';
    await expect(ex.importar(depois)).resolves.toMatchObject({ kind: 'importado' });
    expect(ex.h.db.ler(caminhoPedido(depois))?.lastMarketplaceUpdate).toBe(
      usDe(depois.lastUpdatedTime),
    );
    expect(frete(ex, depois).estado).toBe(ESTADO_FRETE.postado);
    expect(frete(ex, depois).pacotes).toStrictEqual([linhaAntes]);
  });

  it('★ c1-cancelado-depois over its approved pre-read ⇒ estornadoIntegralmente, the pagamento estornado at its value, the line kept at quantity 1 against the real 0, the freight cancelado, possivel-reembolso; the stored cliente and endereço are never erased', async () => {
    const ex = montar();
    const antes = antesDoCancelamento();
    configurar(ex, antes);
    await ex.importar(antes);
    const pedidoPath = caminhoPedido(antes);
    expect(ex.h.db.ler(pedidoPath)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      clientePedidoOuterRef: CLIENTE,
    });
    expect(frete(ex, antes).estado).toBe(ESTADO_FRETE.aguardandoAgendamento);
    const escritas = ex.h.db.escritas.length;

    const real = pedidoC1('c1-cancelado-depois.json');
    await expect(ex.importar(real)).resolves.toMatchObject({
      kind: 'importado',
      detalhe: { itens: REGRA_D17_AMAZON.preservarReversao, linhasPreservadas: 1 },
    });
    const doc = ex.h.db.ler(pedidoPath) ?? {};
    expect(doc).toMatchObject({
      estado: ESTADO_PEDIDO.estornadoIntegralmente,
      clientePedidoOuterRef: CLIENTE,
      valorCobrado: 82.85,
      marketplace: { status: 'CANCELLED', cancelBy: 'MERCHANT', fulfilledBy: 'MERCHANT' },
    });
    const itens = Object.values(doc.itens as Record<string, Json[]>).flat();
    expect(itens).toEqual([expect.objectContaining({ quantidade: 1, precoDeVenda: 82.85 })]);
    expect(frete(ex, real)).toMatchObject({
      estado: ESTADO_FRETE.cancelado,
      enderecoFreteOuterReference: ENDERECO,
      pacotes: [
        expect.objectContaining({
          estado: ESTADO_FRETE.despachoNegado,
          estadoMarketplace: 'LABEL_CANCELLED',
          statusMarketplace: 'CANCELLED',
        }),
      ],
    });
    const pagamento = ex.h.db.ler(caminhoPagamento(real)) ?? {};
    expect(pagamento).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.estornado,
      valor: 82.85,
      dataCancelamento: usDe(real.lastUpdatedTime),
    });
    expect(statusToEstadoPedido(pagamento.status_pagamento as never)).toBe(doc.estado);
    expect(incidentesDe(ex, real)).toEqual([idDo(INCIDENTE_PEDIDO_AMAZON.possivelReembolso)]);
    // The withheld buyer and recipient erase nothing, and are not even looked up.
    const patches = ex.h.db.escritas
      .slice(escritas)
      .filter((e) => e.caminho === pedidoPath)
      .map((e) => [e.verbo, Object.keys(e.dados ?? {}).sort()]);
    expect(patches).toEqual([['update', expect.arrayContaining(['estado', 'freteInicial'])]]);
    expect(patches[0]?.[1]).not.toContain('clientePedidoOuterRef');
    expect(m.findOrCreateCliente).toHaveBeenCalledTimes(1);
    expect(m.ensureEndereco).toHaveBeenCalledTimes(1);
    // The cancelled ORDER suppresses the coleta-cancelada aviso of its LABEL_CANCELLED package.
    expect(
      ex.h.db.ler(
        caminhoAviso(
          chavePedidoPrecisaAtencao(
            CONTA_IMPORTADOR,
            orderIdDe(real),
            MOTIVO_PEDIDO_AMAZON.coletaCancelada,
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it('★ c1-devolvido over its in-transit pre-read ⇒ freight devolvido, the pedido STAYS pago, the pagamento untouched (Elo ⇒ 06, 27.55), possivel-reembolso and no pagamento-divergente; the pre-read’s endereço without extendedFields was S/N, SEM BAIRRO', async () => {
    const ex = montar();
    const antes = antesDaDevolucao();
    configurar(ex, antes);
    await ex.importar(antes);
    // Decision 18 on the real no-extendedFields shape: nothing invented, addressLine2 unread.
    expect(m.ensureEndereco.mock.calls[0]?.[2]).toMatchObject({
      numero: 'S/N',
      bairro: 'SEM BAIRRO',
      complemento: null,
    });
    const pagamentoPath = caminhoPagamento(antes);
    expect(ex.h.db.ler(pagamentoPath)).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 27.55,
      cartao: { bandeira: BANDEIRA.elo, cnpj_instituicao: CNPJ_ADQUIRENTE_DO_FIXTURE },
    });
    const pagamentoAntes = ex.h.db.ler(pagamentoPath);
    const escritasDoPagamento = ex.h.db.escritasEm(pagamentoPath).length;

    const real = pedidoC1('c1-devolvido.json');
    await expect(ex.importar(real)).resolves.toMatchObject({
      kind: 'importado',
      detalhe: { itens: REGRA_D17_AMAZON.preservarReversao },
    });
    expect(ex.h.db.ler(caminhoPedido(real))?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(frete(ex, real).estado).toBe(ESTADO_FRETE.devolvido);
    // The pagamento's only write is the batch's precondition CARRIER: one stored
    // field re-written exactly as read, so the document is byte-identical.
    const novas = ex.h.db.escritasEm(pagamentoPath).slice(escritasDoPagamento);
    expect(novas.map((e) => [e.verbo, e.dados, e.comPrecondicao])).toEqual([
      ['update', { status_pagamento: STATUS_PAGAMENTO.aprovado }, true],
    ]);
    expect(ex.h.db.ler(pagamentoPath)).toStrictEqual(pagamentoAntes);
    expect(incidentesDe(ex, real)).toEqual([idDo(INCIDENTE_PEDIDO_AMAZON.possivelReembolso)]);
  });
});

/* ======================================================================================= */

describe('★ C1 item 3 — what the freight and the pedido never read', () => {
  it.each(GET_ORDER_C1)(
    '%s: the fold is BLIND to shipTime (a planned pickup cutoff, not a handover), createdTime, carrier, shippingService and packageItems',
    (nome) => {
      const contexto = { relogioUs: 1, armazenados: null };
      const base = lerFreteAmazon(lido(pedidoC1(nome)), contexto);
      const semExtras = pedidoC1(nome);
      for (const p of semExtras.packages as Json[]) {
        for (const k of ['shipTime', 'createdTime', 'carrier', 'shippingService', 'packageItems'])
          delete p[k];
      }
      expect(lerFreteAmazon(lido(semExtras), contexto)).toStrictEqual(base);
      const outroHorario = pedidoC1(nome);
      for (const p of outroHorario.packages as Json[]) p.shipTime = '1999-01-01T00:00:00Z';
      expect(lerFreteAmazon(lido(outroHorario), contexto)).toStrictEqual(base);
    },
  );

  it('programs and fulfillmentOrders decide nothing: another program, none, or no fulfillmentOrders change the create ONLY in marketplace.programs (DBA is never keyed on AMAZON_EASY_SHIP; fulfillmentOrders on a MERCHANT order is never AFN)', () => {
    const entradas = {
      integracaoPedidoOuterRef: CONTA_REF,
      operacaoPedidoOuterRef: null,
      clientePedidoOuterRef: null,
      enderecoFreteOuterReference: null,
      integracaoFreteOuterRef: null,
      modalidadeFreteImportacao: null,
      vinculos: new Map<string, string>(),
    };
    const criar = (order: Json) => {
      const r = montarEscritaPedidoAmazon(null, null, mapearPedidoAmazon(lido(order), entradas), {
        nowUs: 1_900_000_000_000_000,
      });
      if (r.tipo !== 'criar') throw new Error(`esperava criar, veio ${r.tipo}`);
      return r;
    };
    const semProgramas = (corpo: Readonly<Json>) => ({
      ...corpo,
      marketplace: { ...(corpo.marketplace as Json), programs: '<omitido>' },
    });
    for (const nome of ['c1-dba-e-transito.json', 'c1-pix.json'] as const) {
      const base = criar(pedidoC1(nome));
      expect((base.corpo.marketplace as Json).programs).toEqual(['DELIVERY_BY_AMAZON']);
      for (const programs of [['AMAZON_EASY_SHIP'], []]) {
        const variante = pedidoC1(nome);
        variante.programs = programs;
        const r = criar(variante);
        expect((r.corpo.marketplace as Json).programs).toEqual(programs);
        expect(semProgramas(r.corpo)).toStrictEqual(semProgramas(base.corpo));
        expect(r.pagamento).toStrictEqual(base.pagamento);
        expect(r.decisao).toStrictEqual(base.decisao);
      }
      const semFo = pedidoC1(nome);
      delete semFo.fulfillmentOrders;
      expect(criar(semFo)).toStrictEqual(base);
    }
  });
});

/* ======================================================================================= */

describe('★ capture C2 — getInvoiceStatus (Delivery API) for the in-transit order: not the order-level vocabulary', () => {
  it('the same order (one keyed fake), every status PascalCase `Accepted` while the order says `ACCEPTED`; no amazonShipmentId and an invoice id that is not a bare NF-e chave — unlike the sandbox model', () => {
    const c2 = envelope('c2-status-aceita.json');
    const corpo = c2.resposta.corpo as Json;
    const transito = pedidoC1('c1-dba-e-transito.json');
    expect(corpo.amazonOrderId).toBe(orderIdDe(transito));
    expect(Object.keys(corpo).sort()).toEqual([
      'amazonOrderId',
      'invoiceStatus',
      'invoices',
      'orderInvoicingStatus',
    ]);
    expect(corpo.invoiceStatus).toBe('Accepted');
    expect(corpo.orderInvoicingStatus).toBe('Accepted');
    expect((corpo.invoices as Json[]).map((i) => i.status)).toEqual(['Accepted']);
    expect(valorEm(transito, 'tax', 'taxInvoicing', 'invoiceStatus')).toBe('ACCEPTED');
    // The order-level constant matches the order, and NEVER the Delivery API's answer.
    const ordem = Object.values(INVOICE_STATUS_AMAZON) as readonly string[];
    expect(ordem).toContain('ACCEPTED');
    expect(ordem).not.toContain(corpo.invoiceStatus);
    expect(ordem).not.toContain(corpo.orderInvoicingStatus);
    // The sanitizer fakes a chave-shaped id and REPLACED this one.
    expect(valorEm(corpo, 'invoices', 0, 'id')).not.toMatch(/^\d{44}$/);
    // NEAR-MISS, the sandbox model: an amazonShipmentId and a 44-digit chave.
    const sandbox = envelope('sb-invoice-status.json').resposta.corpo as Json;
    expect(sandbox.amazonShipmentId).toEqual(expect.any(String));
    expect(valorEm(sandbox, 'invoices', 0, 'id')).toMatch(/^\d{44}$/);
    // The request names the program EasyShip, while the order's programs[] says DELIVERY_BY_AMAZON.
    expect(c2.requisicao.tipo === 'http' && c2.requisicao.query).toContainEqual([
      'programType',
      'EasyShip',
    ]);
  });
});

/* ======================================================================================= */

describe('RESIDUES on real data — owner decisions, pinned so the choice flips exactly these tests', () => {
  it('RESIDUE (plan §4 item 4, #873): c1-entregue-antigo under FOB is pago with valor 39.44 against a pedido total of 63.48, so the shared reconcile relabels it on any Pagamentos-tab mutation; NEAR-MISS: under CIF nothing is relabelled', async () => {
    for (const [modalidade, relabel] of [
      [MODALIDADE_FRETE.fob, true],
      [MODALIDADE_FRETE.cif, false],
    ] as const) {
      const ex = montar();
      const order = pedidoC1('c1-entregue-antigo.json');
      configurar(ex, order, { modalidadeFreteImportacao: modalidade });
      await ex.importar(order);
      const total = ex.h.db.ler(caminhoPedido(order))?.valorCobrado as number;
      const valor = ex.h.db.ler(caminhoPagamento(order))?.valor as number;
      expect(nextPedidoEstado(ESTADO_PEDIDO.pago, total, valor, valor)).toEqual(
        relabel
          ? {
              estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
              autorizarDespacho: false,
            }
          : null,
      );
    }
  });

  it('RESIDUE (decision 29): a pagamento CREATED from a first-seen SHIPPED read is approved at that read’s clock — 241 h after the purchase on c1-entregue-antigo', async () => {
    const ex = montar();
    const order = pedidoC1('c1-entregue-antigo.json');
    configurar(ex, order);
    await ex.importar(order);
    const dataAprovacao = ex.h.db.ler(caminhoPagamento(order))?.dataAprovacao as number;
    expect(dataAprovacao).toBe(usDe(order.lastUpdatedTime));
    expect(Math.floor((dataAprovacao - usDe(order.createdTime)) / 3_600_000_000)).toBe(241);
  });

  // A SYNTHETIC pairing: the one real CANCELLED read is a MERCHANT cancellation
  // made after an ACCEPTED invoice; whether a PENDING-time cancellation (by the
  // buyer or the system) carries a cancellationExecution at all is unseen.
  it('RESIDUE (incidente text): IF a cancellation of a stored PENDING pedido — never approved, never paid — carries the per-line cancellationExecution the real CANCELLED read carries, possivel-reembolso is filed; NEAR-MISS: the same read without the execution files nothing', async () => {
    for (const [comExecucao, esperados] of [
      [true, [idDo(INCIDENTE_PEDIDO_AMAZON.possivelReembolso)]],
      [false, []],
    ] as const) {
      const ex = montar();
      const pendente = antesDoCancelamento();
      (pendente.fulfillment as Json).fulfillmentStatus = 'PENDING';
      delete pendente.buyer;
      delete pendente.recipient;
      configurar(ex, pendente);
      await ex.importar(pendente);
      expect(ex.h.db.ler(caminhoPedido(pendente))?.estado).toBe(
        ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      );
      const real = pedidoC1('c1-cancelado-depois.json');
      if (!comExecucao) delete linha0(real).cancellation;
      await ex.importar(real);
      expect(ex.h.db.ler(caminhoPedido(real))?.estado).toBe(ESTADO_PEDIDO.cancelado);
      expect(ex.h.db.ler(caminhoPagamento(real))).toBeUndefined();
      expect(incidentesDe(ex, real)).toEqual(esperados);
    }
  });

  it('RESIDUE (stock): a real return keeps the units REMOVED — devolvido is a removing freight estado — and the only signal is possivel-reembolso, which names no restock', async () => {
    expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(ESTADO_FRETE.devolvido)).toBe(true);
    const ex = montar();
    const antes = antesDaDevolucao();
    configurar(ex, antes);
    await ex.importar(antes);
    const real = pedidoC1('c1-devolvido.json');
    await ex.importar(real);
    expect(ex.h.db.ler(caminhoPedido(real))?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(frete(ex, real).estado).toBe(ESTADO_FRETE.devolvido);
    expect(incidentesDe(ex, real)).toEqual([idDo(INCIDENTE_PEDIDO_AMAZON.possivelReembolso)]);
    // No aviso either: nothing asks a person to put the units back.
    expect(escritasEm(ex, 'avisos/')).toEqual([]);
  });
});
