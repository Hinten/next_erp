/**
 * The owner's capture C1b (2026-11-03) through the REAL code, the way
 * `capturasC1.test.ts` runs C1: two more `getOrder` reads of real Amazon BR
 * orders, sanitized by the same tool under the same salt.
 *
 *  - `c1-pendente.json`: an order still PENDING (awaiting payment
 *    confirmation) when read, the first real pre-approval read. It settles two
 *    rows of plan §3 decision 39 (row 8: `fulfilledBy` on PENDING; row 1c: the
 *    MARKETPLACE CNPJ's length) and shows what decision 17 (no cliente before
 *    approval), the payment table and the freight table make of a real one.
 *  - `c1-dba-f-entregue.json`: the SAME order as `c1-dba-e-transito.json` (one
 *    keyed fake order id), read again once delivered: the second half of the
 *    7-r pair. Amazon moved `lastUpdatedTime` on the one package change
 *    observed (the delivery; n=1, the pickup only inferred, every other package
 *    status unseen), which refutes "frozen on package events", so no in-transit
 *    refresh is built: the backstop poll would have re-listed this order once
 *    delivered. The equal-clock freight rule stays the defence for a package
 *    event that does not move the clock.
 *
 * What the fixtures are, and D11, as `capturasC1.test.ts` says: REAL dates,
 * money, statuses and enums; FAKE ids, documents and personal text; the UF a
 * placeholder. No Amazon call: the global `fetch` refuses, the harness's
 * scripted `fetch` serves the fixture's body, and `findOrCreateCliente` /
 * `ensureEndereco` are spies.
 *
 * Nothing here pins the NEXT read of the pending order (once paid): that
 * capture decides, and its pins arrive with it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  pedidoWireAmazonSchema,
  type PedidoWireAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  EFEITO_ESTOQUE_NENHUM,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  FORMA_PAGAMENTO,
  MODALIDADE_FRETE,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  TIPO_CLIENTE,
  efeitoEstoquePedido,
  estadoFreteSchema,
  estadoPedidoSchema,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, chavePedidoPrecisaAtencao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import { INVOICE_STATUS_AMAZON, lerFreteAmazon } from '../frete/estadoFreteAmazon';
import { gerarCnpj, gerarCpf } from '../testing/documentos';
import { asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso, caminhoConta } from '../testing/fixtures';
import {
  CONTA_IMPORTADOR,
  harnessImportador,
  payloadPush,
  registroTeste,
  respostaDoPedido,
  type HarnessImportador,
} from '../testing/importadorAmazon';
import {
  enderecoBrutoAmazon,
  identidadeCompradorAmazon,
  intermediadorConfere,
  registroMarketplaceAmazon,
} from './clienteAmazon';
import { TEXTO_ERRO_AMAZON } from './estadoPedidoAmazon';
import { importarPedidoAmazon } from './importarPedido';
import { REGRA_D17_AMAZON } from './itensAmazon';
import { lerInstanteAmazon } from './janelaPoll';
import { makePedidoIdAmazon } from './orderIds';
import {
  execucoesPagamentoAmazon,
  formaDePagamentoAmazon,
  somaPagamentoAmazon,
} from './pagamentoAmazon';

const m = vi.hoisted(() => ({ findOrCreateCliente: vi.fn(), ensureEndereco: vi.fn() }));

vi.mock('@delfrance/data/admin/clientes', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/clientes')>();
  return { ...real, findOrCreateCliente: m.findOrCreateCliente };
});
vi.mock('@delfrance/data/admin/enderecos', async (original) => {
  const real = await original<typeof import('@delfrance/data/admin/enderecos')>();
  return { ...real, ensureEndereco: m.ensureEndereco };
});

const CONTA_REF = `documents/integracao/${CONTA_IMPORTADOR}`;

/** The sanitizer's buyer-document placeholder (bare, 11 digits), rebuilt from its base. */
const CPF_DO_FIXTURE = gerarCpf('000000001');
/** The sanitizer's CNPJ placeholder (bare, 14 digits), rebuilt from its base. */
const CNPJ_DO_FIXTURE = gerarCnpj('112223330001');

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

/** The C1b reads, and the C1 read the delivered one re-reads. */
type Leitura = 'c1-pendente.json' | 'c1-dba-f-entregue.json' | 'c1-dba-e-transito.json';

/** A fixture's envelope, through its own validated reader. */
function envelope(nome: Leitura) {
  const leitura = lerFixtureAmazon(readFileSync(join(DIRETORIO_WIRE_AMAZON, nome), 'utf8'));
  if (!leitura.ok) throw new Error(`${nome} não é um envelope válido`);
  return leitura.data;
}

/** A fixture's `order`: a FRESH copy every call. */
function pedido(nome: Leitura): Json {
  return structuredClone((envelope(nome).resposta.corpo as { order: Json }).order);
}

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

/**
 * Every leaf where `a` and `b` differ, as a dotted path: a key present on one
 * side only counts as a difference (its value on the other side is `undefined`).
 */
function folhasDiferentes(a: unknown, b: unknown, caminho = ''): string[] {
  const objeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (!objeto(a) || !objeto(b)) return Object.is(a, b) ? [] : [caminho];
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...chaves].flatMap((k) => folhasDiferentes(a[k], b[k], caminho ? `${caminho}.${k}` : k));
}

const orderIdDe = (order: Json): string => String(order.orderId);
const caminhoPedido = (order: Json): string =>
  `pedidos/${makePedidoIdAmazon(CONTA_IMPORTADOR, orderIdDe(order))}`;
const caminhoPagamento = (order: Json): string =>
  `${caminhoPedido(order)}/pagamentos/${makePedidoIdAmazon(CONTA_IMPORTADOR, orderIdDe(order))}`;
const pacote0 = (order: Json): Json => (order.packages as Json[])[0] as Json;

/* ------------------------------------- the harness ------------------------------------- */

interface Execucao {
  readonly h: HarnessImportador;
  importar(corpo: Json): ReturnType<typeof importarPedidoAmazon>;
}

function montar(): Execucao {
  const h = harnessImportador();
  return {
    h,
    async importar(corpo) {
      h.respostas = [respostaDoPedido(corpo)];
      const contexto = await h.contexto();
      return importarPedidoAmazon(asDb(h.db), contexto, payloadPush(orderIdDe(corpo)), {
        agora: () => AGORA_MS,
        increment,
        logger: h.log.logger,
        // A lookup that answers nothing: the fixtures' UF is a placeholder.
        viaCep: { buscarCep: () => Promise.resolve(null) },
        agendamento: h.agendamentos.produtor,
        registro: registroTeste(0),
      });
    },
  };
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
 * `order` (as `capturasC1.test.ts` seeds it): nothing the CONFIGURATION lacks
 * can file an incidente or an aviso, so whatever is filed comes from the order.
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
const frete = (ex: Execucao, order: Json) =>
  ex.h.db.ler(caminhoPedido(order))?.freteInicial as Json;

/**
 * What the stock sync converges to for the stored pedido under an operação that
 * moves stock AND tracks the reservation: the shared desired-state predicate,
 * fed the two estados it reads beside the operação.
 */
function estoque(ex: Execucao, order: Json) {
  const doc = ex.h.db.ler(caminhoPedido(order)) ?? {};
  const estadoFrete = estadoFreteSchema.safeParse((doc.freteInicial as Json | undefined)?.estado);
  return efeitoEstoquePedido({
    estado: estadoPedidoSchema.parse(doc.estado),
    estadoFrete: estadoFrete.success ? estadoFrete.data : null,
    ehSaida: doc.ehSaida === true,
    movimentaEstoque: true,
    movimentaIndisponivelEstoque: true,
    jaMovimentado: false,
  });
}

/* ======================================================================================= */

describe('★ C1b, 7-r — the in-transit order read again once delivered', () => {
  it('★ 7-r verdict: lastUpdatedTime moves on a package-only change (delivered) — one order, the clock later, every other differing leaf under packages[], the status pair PICKED_UP/IN_TRANSIT → DELIVERED/DELIVERED', () => {
    const transito = pedido('c1-dba-e-transito.json');
    const entregue = pedido('c1-dba-f-entregue.json');
    expect(orderIdDe(entregue)).toBe(orderIdDe(transito));

    // (a) strictly later, as the importer's own reader reads it (the watermark).
    expect(transito.lastUpdatedTime).toBe('2026-10-28T16:37:54.503Z');
    expect(entregue.lastUpdatedTime).toBe('2026-10-31T17:03:55.349Z');
    const antes = lerInstanteAmazon(String(transito.lastUpdatedTime));
    const depois = lerInstanteAmazon(String(entregue.lastUpdatedTime));
    expect(antes?.us).toBe(usDe(transito.lastUpdatedTime));
    expect(depois?.us).toBe(usDe(entregue.lastUpdatedTime));
    expect(depois?.us ?? 0).toBeGreaterThan(antes?.us ?? Number.POSITIVE_INFINITY);

    // (b) nothing outside the packages moved, as far as the sanitized reads show: not the
    // status, the invoice, the money. Redacted text (the parties, the authorization code) is
    // a fixed placeholder, so it compares equal by construction and (b) cannot see it.
    const diferencas = folhasDiferentes(transito, entregue);
    expect(diferencas.filter((p) => p !== 'lastUpdatedTime' && !p.startsWith('packages.'))).toEqual(
      [],
    );
    expect(diferencas.sort()).toEqual([
      'lastUpdatedTime',
      'packages.0.createdTime',
      'packages.0.packageStatus.detailedStatus',
      'packages.0.packageStatus.status',
    ]);
    // What (b) cannot see, corroborated: the RAW bodies differ in size by exactly what the
    // sanitized ones do (the dropped createdTime, IN_TRANSIT → DELIVERED), so a redacted
    // value that changed would have had to keep its length.
    const bytesCrus = (nome: Leitura) => envelope(nome).resposta.bytes;
    const bytesSanitizados = (nome: Leitura) =>
      new TextEncoder().encode(JSON.stringify(envelope(nome).resposta.corpo)).byteLength;
    expect([
      bytesCrus('c1-dba-e-transito.json') - bytesCrus('c1-dba-f-entregue.json'),
      bytesSanitizados('c1-dba-e-transito.json') - bytesSanitizados('c1-dba-f-entregue.json'),
    ]).toEqual([42, 42]);

    // (c) the package's status pair is the change.
    expect(pacote0(transito).packageStatus).toEqual({
      detailedStatus: 'PICKED_UP',
      status: 'IN_TRANSIT',
    });
    expect(pacote0(entregue).packageStatus).toEqual({
      detailedStatus: 'DELIVERED',
      status: 'DELIVERED',
    });

    // Suggestive, not proof: on the transit read the clock already sits after the
    // package's creation, consistent with the pickup having moved it too.
    expect(usDe(transito.lastUpdatedTime)).toBeGreaterThan(usDe(pacote0(transito).createdTime));
  });

  it('the delivered read on FIRST sight ⇒ created pago, freight entregue, its package row built without the createdTime it lost; nothing filed', async () => {
    const ex = montar();
    const order = pedido('c1-dba-f-entregue.json');
    expect(Object.hasOwn(pacote0(order), 'createdTime')).toBe(false);
    configurar(ex, order);
    await expect(ex.importar(order)).resolves.toMatchObject({
      kind: 'importado',
      detalhe: { acao: 'criado', itens: REGRA_D17_AMAZON.escrever },
    });
    expect(ex.h.db.ler(caminhoPedido(order))?.estado).toBe(ESTADO_PEDIDO.pago);
    expect(frete(ex, order)).toMatchObject({
      estado: ESTADO_FRETE.entregue,
      pacotes: [
        {
          numero: pacote0(order).packageReferenceId,
          estado: ESTADO_FRETE.entregue,
          estadoMarketplace: 'DELIVERED',
          statusMarketplace: 'DELIVERED',
          codRastreio: pacote0(order).trackingNumber,
          canalId: null,
          prazoDespacho: null,
          atualizadoEm: usDe(order.lastUpdatedTime),
          fonte: 'getOrder',
        },
      ],
    });
    expect(incidentesDe(ex, order)).toEqual([]);
    expect(escritasEm(ex, 'avisos/')).toEqual([]);
    // The one log code is the fixtures' redacted UF (a sanitizer artifact).
    expect(codigosDeLog(ex)).toEqual(['uf-nao-resolvida']);
  });

  it('★ c1-dba-e-transito, then c1-dba-f-entregue, on ONE db ⇒ the delivered read is APPLIED: the watermark advances, freight postado → entregue, the diary row re-stamped at the new clock, codRastreio unchanged; no codRastreio-divergente, no incidente, no aviso, the pagamento untouched', async () => {
    const ex = montar();
    const transito = pedido('c1-dba-e-transito.json');
    configurar(ex, transito);
    await ex.importar(transito);
    const pedidoPath = caminhoPedido(transito);
    expect(frete(ex, transito).estado).toBe(ESTADO_FRETE.postado);
    const [linhaAntes] = frete(ex, transito).pacotes as Json[];
    const codAntes = frete(ex, transito).codRastreio;
    const pagamentoAntes = ex.h.db.ler(caminhoPagamento(transito));
    const logAntes = codigosDeLog(ex).length;

    const entregue = pedido('c1-dba-f-entregue.json');
    await expect(ex.importar(entregue)).resolves.toEqual({
      kind: 'importado',
      detalhe: {
        acao: 'atualizado',
        itens: REGRA_D17_AMAZON.manter,
        linhasPreservadas: 0,
        linhasDivergentes: 0,
        linhasSemProduto: 0,
      },
    });
    const watermarkUs = usDe(entregue.lastUpdatedTime);
    expect(ex.h.db.ler(pedidoPath)).toMatchObject({
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: watermarkUs,
      marketplace: { status: 'SHIPPED', statusEm: watermarkUs, invoiceStatus: 'ACCEPTED' },
    });
    expect(frete(ex, entregue).estado).toBe(ESTADO_FRETE.entregue);
    expect(frete(ex, entregue).codRastreio).toBe(codAntes);
    expect(codAntes).toBe(pacote0(entregue).trackingNumber);
    expect(frete(ex, entregue).pacotes).toStrictEqual([
      {
        ...linhaAntes,
        estado: ESTADO_FRETE.entregue,
        estadoMarketplace: 'DELIVERED',
        statusMarketplace: 'DELIVERED',
        atualizadoEm: watermarkUs,
      },
    ]);
    expect(codigosDeLog(ex).slice(logAntes)).toEqual([]);
    expect(incidentesDe(ex, entregue)).toEqual([]);
    expect(escritasEm(ex, 'avisos/')).toEqual([]);
    expect(ex.h.db.ler(caminhoPagamento(entregue))).toStrictEqual(pagamentoAntes);
  });

  it('★ the package createdTime the delivered read DROPPED is invisible: the read and the same read with the transit read’s createdTime put back land BYTE-EQUAL pedidos, and the diary row holds no key derived from it', async () => {
    const transito = pedido('c1-dba-e-transito.json');
    const comCriacao = pedido('c1-dba-f-entregue.json');
    pacote0(comCriacao).createdTime = pacote0(transito).createdTime;
    const contexto = { relogioUs: 1, armazenados: null };
    expect(lerFreteAmazon(lido(pedido('c1-dba-f-entregue.json')), contexto)).toStrictEqual(
      lerFreteAmazon(lido(comCriacao), contexto),
    );

    const finais = [];
    for (const delivered of [pedido('c1-dba-f-entregue.json'), comCriacao]) {
      const ex = montar();
      configurar(ex, transito);
      await ex.importar(pedido('c1-dba-e-transito.json'));
      await expect(ex.importar(delivered)).resolves.toMatchObject({ kind: 'importado' });
      expect(incidentesDe(ex, delivered)).toEqual([]);
      expect(escritasEm(ex, 'avisos/')).toEqual([]);
      finais.push(ex.h.db.ler(caminhoPedido(delivered)));
    }
    expect(finais[0]).toStrictEqual(finais[1]);
    const [linha] = valorEm(finais[0], 'freteInicial', 'pacotes') as Json[];
    expect(Object.keys(linha ?? {}).sort()).toEqual([
      'atualizadoEm',
      'canalId',
      'codRastreio',
      'estado',
      'estadoMarketplace',
      'fonte',
      'numero',
      'prazoDespacho',
      'statusMarketplace',
    ]);
  });

  it('★ the dropped createdTime where the change detector decides: the delivered read stored, then the SAME package re-read at a newer clock ⇒ the diary row keeps its first stamp, with or without the transit read’s createdTime put back; the two final pedidos are byte-equal', async () => {
    const criacao = pacote0(pedido('c1-dba-e-transito.json')).createdTime;
    const leitura = (comCriacao: boolean, lastUpdatedTime?: string): Json => {
      const order = pedido('c1-dba-f-entregue.json');
      if (comCriacao) pacote0(order).createdTime = criacao;
      if (lastUpdatedTime !== undefined) order.lastUpdatedTime = lastUpdatedTime;
      return order;
    };
    const primeiraUs = usDe(pedido('c1-dba-f-entregue.json').lastUpdatedTime);
    const depois = '2026-11-02T00:00:00.000Z';

    const finais = [];
    for (const comCriacao of [false, true]) {
      const ex = montar();
      configurar(ex, leitura(comCriacao));
      await expect(ex.importar(leitura(comCriacao))).resolves.toMatchObject({
        kind: 'importado',
        detalhe: { acao: 'criado' },
      });
      await expect(ex.importar(leitura(comCriacao, depois))).resolves.toMatchObject({
        kind: 'importado',
        detalhe: { acao: 'atualizado' },
      });
      const final = ex.h.db.ler(caminhoPedido(leitura(comCriacao)));
      // Anti-vacuity: the newer clock was applied (the watermark moved) …
      expect(final?.lastMarketplaceUpdate).toBe(usDe(depois));
      // … and the unchanged package kept the stamp of the read that changed it.
      expect(valorEm(final, 'freteInicial', 'pacotes', 0, 'atualizadoEm')).toBe(primeiraUs);
      expect(incidentesDe(ex, leitura(comCriacao))).toEqual([]);
      expect(escritasEm(ex, 'avisos/')).toEqual([]);
      finais.push(final);
    }
    expect(finais[0]).toStrictEqual(finais[1]);
  });

  it('★ rule 7, the reverse order: the delivered read stored, the OLDER transit read arriving late ⇒ obsoleto with ZERO writes; the freight stays entregue', async () => {
    const ex = montar();
    const entregue = pedido('c1-dba-f-entregue.json');
    configurar(ex, entregue);
    await ex.importar(entregue);
    const escritas = ex.h.db.escritas.length;
    const antes = ex.h.db.ler(caminhoPedido(entregue));
    await expect(ex.importar(pedido('c1-dba-e-transito.json'))).resolves.toEqual({
      kind: 'obsoleto',
    });
    expect(ex.h.db.escritas).toHaveLength(escritas);
    expect(ex.h.db.ler(caminhoPedido(entregue))).toStrictEqual(antes);
    expect(frete(ex, entregue).estado).toBe(ESTADO_FRETE.entregue);
  });
});

/* ======================================================================================= */

describe('★ C1b — the first real PENDING read (c1-pendente), on first sight', () => {
  it('the read: MERCHANT on PENDING; three registrations (MERCHANT with a legal name only, MARKETPLACE CNPJ of 14 bare digits, BUYER CPF); no buyer block; a recipient with only a CEP and a name; invoice NOT_FOUND; one Installments execution with no amount; no package, no fulfillment order', () => {
    const bruto = pedido('c1-pendente.json');
    const order = lido(bruto);
    expect(order.fulfillment).toMatchObject({
      fulfilledBy: 'MERCHANT',
      fulfillmentStatus: 'PENDING',
    });
    expect(Object.hasOwn(bruto.fulfillment as Json, 'labelPrintingWindow')).toBe(true);
    expect(Object.hasOwn(bruto.fulfillment as Json, 'deliverByWindow')).toBe(false);
    expect(order.programs).toEqual(['DELIVERY_BY_AMAZON']);
    expect(order.tax?.taxRegistrations).toEqual([
      { legalName: 'REDACTED', entityType: 'MERCHANT' },
      {
        entityType: 'MARKETPLACE',
        taxRegistrationType: 'CNPJ',
        taxRegistrationNumber: CNPJ_DO_FIXTURE,
      },
      { entityType: 'BUYER', taxRegistrationType: 'CPF', taxRegistrationNumber: CPF_DO_FIXTURE },
    ]);
    expect(Object.hasOwn(bruto, 'buyer')).toBe(false);
    expect(Object.keys(valorEm(bruto, 'recipient', 'deliveryAddress') as Json).sort()).toEqual([
      'name',
      'postalCode',
    ]);
    expect(order.tax?.taxInvoicing?.invoiceStatus).toBe(INVOICE_STATUS_AMAZON.notFound);
    expect(order.payment?.paymentExecutions).toEqual([{ paymentMethod: 'Installments' }]);
    expect(valorEm(bruto, 'proceeds', 'grandTotal')).toEqual({
      amount: '64.85',
      currencyCode: 'BRL',
    });
    for (const ausente of ['packages', 'fulfillmentOrders', 'buyer']) {
      expect(Object.hasOwn(bruto, ausente), ausente).toBe(false);
    }
    for (const c of ['createdTime', 'lastUpdatedTime'] as const) {
      expect(bruto[c]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('★ decision 39 row 8: fulfilledBy IS present on PENDING ⇒ created through the status table at aguardandoConfirmacaoDePagamento, which reserves (decision 13); no error, no logistica aviso or incidente, no pagamento', async () => {
    const ex = montar();
    const order = pedido('c1-pendente.json');
    configurar(ex, order);
    await expect(ex.importar(order)).resolves.toEqual({
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
    expect(ex.h.db.ler(caminhoPedido(order))).toMatchObject({
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      error: null,
      numero: orderIdDe(order),
      integracaoPedidoOuterRef: CONTA_REF,
      lastMarketplaceUpdate: watermarkUs,
      timestamp: usDe(order.createdTime),
      valorCobrado: 64.85,
      descontoTotal: 0,
      marketplace: {
        tipo: 'amazon',
        status: 'PENDING',
        statusEm: watermarkUs,
        cancelBy: null,
        invoiceStatus: 'NOT_FOUND',
        fulfilledBy: 'MERCHANT',
        programs: ['DELIVERY_BY_AMAZON'],
      },
    });
    const itens = Object.values(
      ex.h.db.ler(caminhoPedido(order))?.itens as Record<string, Json[]>,
    ).flat();
    expect(itens).toEqual([
      expect.objectContaining({ quantidade: 1, precoDeVenda: 64.85, descontoUnitario: 0 }),
    ]);
    expect(estoque(ex, order)).toEqual({ reservar: true, remover: false, adicionar: false });
    expect(ex.h.db.ler(caminhoPagamento(order))).toBeUndefined();
    expect(incidentesDe(ex, order)).toEqual([]);
    expect(escritasEm(ex, 'avisos/')).toEqual([]);
    expect(codigosDeLog(ex)).toEqual([]);
  });

  it('★ decision 39 row 8, NEAR-MISS: the same read with fulfilledBy DELETED takes the provisional default — error + the crítico logistica-desconhecida, nothing reserved: the real MERCHANT is what keeps the create off that arm', async () => {
    const ex = montar();
    const order = pedido('c1-pendente.json');
    delete (order.fulfillment as Json).fulfilledBy;
    configurar(ex, order);
    await expect(ex.importar(order)).resolves.toMatchObject({
      kind: 'importado',
      detalhe: { acao: 'criado' },
    });
    expect(ex.h.db.ler(caminhoPedido(order))).toMatchObject({
      estado: ESTADO_PEDIDO.error,
      error: TEXTO_ERRO_AMAZON.logisticaDesconhecida,
      marketplace: { status: 'PENDING', fulfilledBy: null },
    });
    expect(estoque(ex, order)).toEqual(EFEITO_ESTOQUE_NENHUM);
    expect(
      ex.h.db.ler(
        caminhoAviso(
          chavePedidoPrecisaAtencao(
            CONTA_IMPORTADOR,
            orderIdDe(order),
            MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida,
          ),
        ),
      ),
    ).toMatchObject({ severidade: 'critico', resolvidoEm: null, ocorrencias: 1 });
  });

  it('★ decision 17: NO cliente and NO endereço — the BUYER CPF is on the read, but before approval the import does not ask (and the read has no buyer name anyway); NEAR-MISS: a buyer name composed in makes the identity whole, and still nothing is resolved', async () => {
    const order = pedido('c1-pendente.json');
    expect(identidadeCompradorAmazon(lido(order))).toEqual({ ok: false, motivo: 'sem-nome' });
    expect(enderecoBrutoAmazon(lido(order))?.bruto).toMatchObject({
      cepRaw: valorEm(order, 'recipient', 'deliveryAddress', 'postalCode'),
      logradouro: null,
      numero: null,
    });

    const comNome = pedido('c1-pendente.json');
    comNome.buyer = { buyerName: 'Comprador Composto' };
    // Anti-vacuity: with the name the identity is complete, the CPF placeholder included.
    expect(identidadeCompradorAmazon(lido(comNome))).toEqual({
      ok: true,
      campos: {
        tipo: TIPO_CLIENTE.pessoaFisica,
        nome: 'Comprador Composto',
        cpf_cnpj: CPF_DO_FIXTURE,
        idEstrangeiro: null,
        ie: null,
        telefone: null,
        email: null,
      },
    });

    for (const corpo of [order, comNome]) {
      const ex = montar();
      configurar(ex, corpo);
      await ex.importar(corpo);
      expect(ex.h.db.ler(caminhoPedido(corpo))?.clientePedidoOuterRef).toBeNull();
      expect(frete(ex, corpo).enderecoFreteOuterReference).toBeNull();
      // Not even the approved-order incidente: a PENDING order has no cliente to miss.
      expect(incidentesDe(ex, corpo)).toEqual([]);
    }
    expect(m.findOrCreateCliente).not.toHaveBeenCalled();
    expect(m.ensureEndereco).not.toHaveBeenCalled();
  });

  it('★ the payment: Installments is NOT a token the table knows (99, "Amazon: Installments") and its one execution has no amount (Σ unreadable) — on the PENDING read none of it is asked: no pagamento, no forma-pagamento-desconhecida, no pagamento-divergente, no log line', async () => {
    expect(formaDePagamentoAmazon('Installments')).toEqual({
      forma: FORMA_PAGAMENTO.outros,
      conhecida: false,
      descricao: 'Amazon: Installments',
    });
    const order = pedido('c1-pendente.json');
    const execucoes = execucoesPagamentoAmazon(lido(order));
    expect(execucoes).toEqual([
      expect.objectContaining({
        metodo: 'Installments',
        valor: null,
        adquirente: undefined,
        marca: undefined,
        autorizacao: undefined,
      }),
    ]);
    expect(somaPagamentoAmazon(execucoes)).toBeNull();

    const ex = montar();
    configurar(ex, order);
    await ex.importar(order);
    expect(ex.h.db.ler(caminhoPagamento(order))).toBeUndefined();
    expect(escritasEm(ex, `${caminhoPedido(order)}/pagamentos/`)).toEqual([]);
    expect(incidentesDe(ex, order)).toEqual([]);
    expect(codigosDeLog(ex)).toEqual([]);
  });

  it('★ the freight: invoice NOT_FOUND and no package on a PENDING read ⇒ the seed as is — iniciado, no diary, no tracking, the ship-by deadline only; no nota-fiscal event. NEAR-MISS: the same NOT_FOUND under UNSHIPPED would answer aguardandoNFe (the status, not the invoice, keeps it off)', async () => {
    const order = pedido('c1-pendente.json');
    const contexto = { relogioUs: 1, armazenados: null };
    expect(lerFreteAmazon(lido(order), contexto)).toEqual({
      alvo: null,
      dobra: null,
      mercadoriaFora: false,
      semNota: false,
      notaNaoExigida: false,
      motivos: [],
    });
    const aEnviar = pedido('c1-pendente.json');
    (aEnviar.fulfillment as Json).fulfillmentStatus = 'UNSHIPPED';
    expect(lerFreteAmazon(lido(aEnviar), contexto).alvo).toBe(ESTADO_FRETE.aguardandoNFe);

    const ex = montar();
    configurar(ex, order);
    await ex.importar(order);
    const bloco = frete(ex, order);
    expect(bloco).toMatchObject({
      estado: ESTADO_FRETE.iniciado,
      externalOptionIntegracao: 'amz',
      integracaoFreteOuterRef: `documents/int_frete/amz-${CONTA_IMPORTADOR}`,
      enderecoFreteOuterReference: null,
      modalidade: MODALIDADE_FRETE.fob,
      valorCobrado: null,
      codRastreio: null,
      prazoDespacho: usDe(valorEm(order, 'fulfillment', 'shipByWindow', 'latestDateTime')),
      dataPrevisaoEntrega: null,
      ultimaModificacao: usDe(order.lastUpdatedTime),
    });
    expect(Object.hasOwn(bloco, 'pacotes')).toBe(false);
    expect(codigosDeLog(ex)).not.toContain('nota-fiscal-nao-informada');
  });

  it('★ decision 39 row 1c: the MARKETPLACE CNPJ is 14 bare digits ⇒ the FULL-equality arm — the conta’s own CNPJ confere and resolves a standing intermediador-divergente; NEAR-MISS: the same root with another branch DIVERGES (an 8-digit root would have conferred) and raises it', async () => {
    const order = pedido('c1-pendente.json');
    const wire = registroMarketplaceAmazon(lido(order));
    expect(wire).toBe(CNPJ_DO_FIXTURE);
    expect(wire).toMatch(/^\d{14}$/);
    const outraFilial = gerarCnpj('112223330002');
    expect(outraFilial.slice(0, 8)).toBe(CNPJ_DO_FIXTURE.slice(0, 8));
    expect(intermediadorConfere(wire, CNPJ_DO_FIXTURE)).toBe('confere');
    expect(intermediadorConfere(wire, outraFilial)).toBe('diverge');
    expect(intermediadorConfere(CNPJ_DO_FIXTURE.slice(0, 8), outraFilial)).toBe('confere');

    const ex = montar();
    const avisoPath = caminhoAviso(
      chaveContaPrecisaAtencao(CONTA_IMPORTADOR, MOTIVO_CONTA_AMAZON.intermediadorDivergente),
    );
    configurar(ex, order, { cpf_cnpj: outraFilial });
    await ex.importar(order);
    expect(ex.h.db.ler(avisoPath)).toMatchObject({ resolvidoEm: null, ocorrencias: 1 });

    conta(ex, { cpf_cnpj: CNPJ_DO_FIXTURE });
    await expect(ex.importar(pedido('c1-pendente.json'))).resolves.toMatchObject({
      kind: 'sem-mudanca',
    });
    expect(ex.h.db.ler(avisoPath)?.resolvidoEm).not.toBeNull();
  });
});
