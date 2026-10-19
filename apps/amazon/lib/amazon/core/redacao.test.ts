import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';
import { z } from 'zod';

import { gerarCnpj, gerarCpf, pontuarCnpj, pontuarCpf } from '../testing/documentos';
import { falsificadorDeTeste } from '../testing/fixtures';
import { getOrderBr, searchOrdersBr } from '../testing/sandboxBr';
import {
  CHAVES_DA_QUERY_AMAZON,
  CHAVES_NEGADAS_AMAZON,
  CODIGOS_ERRO_AMAZON,
  CODIGO_OUTRO,
  FALSO_AMAZON,
  ISENTOS_DE_DIGITOS,
  LIMITE_ANALISE_BYTES,
  MODELOS_DE_CAMINHO_AMAZON,
  NOTIFICACAO_ORDER_CHANGE,
  PLACEHOLDERS_DOCUMENTO_AMAZON,
  PLACEHOLDERS_FIXTURE_AMAZON,
  PREFIXOS_NEGADOS_AMAZON,
  PROFUNDIDADE_MAXIMA_JSON,
  PROFUNDIDADE_MAXIMA_PERCURSO,
  REDIGIDO,
  SEGMENTO_REDIGIDO,
  SELLER_ID_REDIGIDO,
  SUBARVORES_NEGADAS_AMAZON,
  TABELAS_AMAZON,
  type TabelaRedacaoAmazon,
  bytesUtf8,
  chaveDeCredencialAmazon,
  chaveNegadaAmazon,
  classificarCaminho,
  cortarUtf8,
  mascararTexto,
  placeholderDeDocumento,
  profundidadeJson,
  redigirCaminhoEQuery,
  redigirCorpo,
  redigirRequisicaoParaFixture,
  regrasDaFolhaAmazon,
} from './redacao';

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/** Generated at run time: valid check digits, never committed (`documentos.ts`). */
const CPF = gerarCpf('123456789');
const CPF_PONTUADO = pontuarCpf(CPF);
const CNPJ = gerarCnpj('112223330001');
const CNPJ_LETRA = gerarCnpj('12ABC34501DE');

const GET_ORDER = '/orders/2026-01-01/orders/123-4567890-1234567';
const SEARCH = '/orders/2026-01-01/orders';
const STATUS_NF = '/delivery/2022-07-01/invoice/status';
const BULK = '/easyShip/2022-03-23/packages/bulk';
const PACOTE = '/easyShip/2022-03-23/package';
const RDT = '/tokens/2021-03-01/restrictedDataToken';
const DESCONHECIDO = '/algo/2030-01-01/coisa';

const SEM_CORTE = 64 * 1024 * 1024;

function log(caminho: string, status: number | null, corpo: string | null) {
  return redigirCorpo({ caminho, status, corpo }, 'log', { maxBytes: SEM_CORTE });
}

/** The `log` excerpt of a JSON body, parsed back (the walk emits JSON). */
function logJson(caminho: string, status: number, corpo: unknown): unknown {
  const r = log(caminho, status, JSON.stringify(corpo));
  expect(r.forma).toBe('json');
  return JSON.parse(r.trecho ?? 'null') as unknown;
}

function fixture(caminho: string, status: number | null, corpo: string | null) {
  return redigirCorpo({ caminho, status, corpo }, 'fixture', {
    falsificador: falsificadorDeTeste(),
  });
}

/** The `fixture` body of a JSON body; fails the test on a refusal. */
function fixtureJson(caminho: string, status: number, corpo: unknown): unknown {
  const r = fixture(caminho, status, JSON.stringify(corpo));
  if (!r.ok) throw new Error(`fixture refused: ${r.motivo}`);
  return r.corpo;
}

/** The value at a dotted path (`order.orderItems.0.orderItemId`). */
function em(v: unknown, caminho: string): unknown {
  let atual = v;
  for (const k of caminho.split('.')) {
    if (atual === null || typeof atual !== 'object') return undefined;
    atual = Object.entries(atual).find(([chave]) => chave === k)?.[1];
  }
  return atual;
}

/** Every string leaf of a value. */
function textos(v: unknown, saida: string[] = []): string[] {
  if (typeof v === 'string') saida.push(v);
  else if (Array.isArray(v)) for (const x of v) textos(x, saida);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) textos(x, saida);
  return saida;
}

/** The leaf paths of a value, the generator's way (`*` for an index). */
function caminhosDe(v: unknown, caminho = '', saida = new Set<string>()): Set<string> {
  const juntar = (k: string) => (caminho === '' ? k : `${caminho}.${k}`);
  if (Array.isArray(v)) {
    if (v.length === 0) saida.add(caminho);
    for (const x of v) caminhosDe(x, juntar('*'), saida);
  } else if (v !== null && typeof v === 'object') {
    const chaves = Object.keys(v);
    if (chaves.length === 0) saida.add(caminho);
    for (const k of chaves) caminhosDe((v as Record<string, unknown>)[k], juntar(k), saida);
  } else saida.add(caminho);
  return saida;
}

/* -------------------------------------------------------------------------- */
/*                       The committed leaf inventory                          */
/* -------------------------------------------------------------------------- */

const inventarioSchema = z.object({
  geradoPor: z.literal('amazon-doc.mjs folhas'),
  modelos: z.record(
    z.string(),
    z.object({ arquivo: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  ),
  operacoes: z.array(
    z.object({
      modelo: z.string(),
      operationId: z.string(),
      status: z.enum(['200', 'erro', 'notificacao']),
      folhas: z.array(z.object({ caminho: z.string(), tipo: z.string().min(1) })),
    }),
  ),
  exemplosBr: z.record(z.string(), z.array(z.string())),
  codigosDeErroDosExemplos: z.array(z.string()),
});

const INVENTARIO = inventarioSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../testing/especificacaoFolhas.json', import.meta.url)),
      'utf8',
    ),
  ),
);

const PRIMITIVOS = new Set(['string', 'integer', 'number', 'boolean', 'null']);
const ehPrimitivo = (tipo: string) => tipo.split('|').some((t) => PRIMITIVOS.has(t));

const OPERACOES_DO_PLANO = [
  'searchOrders',
  'getOrder',
  'getInvoiceStatus',
  'submitInvoice',
  'createScheduledPackageBulk',
  'getScheduledPackage',
  'createRestrictedDataToken',
  'OrderChangeNotification',
];

/** The 2xx (or notification) inventory entries: what the tables classify. */
const CORPOS = INVENTARIO.operacoes.filter((o) => o.status !== 'erro');

describe('spec coverage — against the committed leaf inventory', () => {
  it('reads the inventory (anti-vacuity): the 7 operations plus the notification, hundreds of leaves', () => {
    expect(new Set(INVENTARIO.operacoes.map((o) => o.operationId))).toEqual(
      new Set(OPERACOES_DO_PLANO),
    );
    expect(CORPOS.flatMap((o) => o.folhas).length).toBeGreaterThan(300);
    expect(Object.keys(INVENTARIO.exemplosBr).sort()).toEqual(['getOrder', 'searchOrders']);
  });

  it('every terminal leaf is classified EXACTLY once: allowed, soLog, denied or segredo', () => {
    const problemas: string[] = [];
    for (const op of CORPOS) {
      const caminhos = op.folhas.map((f) => f.caminho);
      for (const { caminho } of op.folhas) {
        if (caminhos.some((c) => c.startsWith(`${caminho}.`))) continue; // a container
        const regras = regrasDaFolhaAmazon(op.operationId, caminho);
        if (regras.length !== 1) {
          problemas.push(
            `${op.operationId} ${caminho}: ${regras.map((r) => r.tipo).join('+') || '∅'}`,
          );
        }
      }
    }
    expect(problemas).toEqual([]);
  });

  it('a mutation of the classifier fails it (anti-vacuity): an unknown leaf has no rule', () => {
    expect(regrasDaFolhaAmazon('getOrder', 'order.campoNovo')).toEqual([]);
    expect(regrasDaFolhaAmazon('getOrder', 'order.buyer.buyerName')).toEqual([{ tipo: 'negada' }]);
    expect(regrasDaFolhaAmazon('createRestrictedDataToken', 'restrictedDataToken')).toEqual([
      { tipo: 'segredo' },
    ]);
  });

  /** Allow-listed on purpose although the inventory does not show them, each with its reason. */
  const FORA_DA_ESPECIFICACAO: Readonly<Record<string, string>> = {
    awsRegion: 'the SQS record envelope the Pipe delivers (AWS docs), not the notification schema',
    'attributes.ApproximateReceiveCount': 'the SQS record envelope',
    'attributes.SentTimestamp': 'the SQS record envelope',
    'attributes.ApproximateFirstReceiveTimestamp': 'the SQS record envelope',
    messageId: 'the SQS record envelope',
    '*.awsRegion': 'the SQS record envelope, a batch',
    '*.attributes.ApproximateReceiveCount': 'the SQS record envelope, a batch',
    '*.attributes.SentTimestamp': 'the SQS record envelope, a batch',
    '*.attributes.ApproximateFirstReceiveTimestamp': 'the SQS record envelope, a batch',
    '*.messageId': 'the SQS record envelope, a batch',
  };

  it('every keep-list entry (allowed or soLog) resolves to a primitive leaf of its operation, or is named as off-spec', () => {
    const casos: readonly (readonly [TabelaRedacaoAmazon, string])[] = [
      [TABELAS_AMAZON.searchOrders, 'searchOrders'],
      [TABELAS_AMAZON.getOrder, 'getOrder'],
      [TABELAS_AMAZON.getInvoiceStatus, 'getInvoiceStatus'],
      [TABELAS_AMAZON.submitInvoice, 'submitInvoice'],
      [TABELAS_AMAZON.getScheduledPackage, 'getScheduledPackage'],
      [TABELAS_AMAZON.createScheduledPackageBulk, 'createScheduledPackageBulk'],
      [TABELAS_AMAZON.orderChange, 'OrderChangeNotification'],
    ];
    const naoResolvidas: string[] = [];
    const usadas = new Set<string>();
    for (const [t, operationId] of casos) {
      const op = CORPOS.find((o) => o.operationId === operationId);
      expect(op, operationId).toBeDefined();
      const folhas = new Set(
        (op?.folhas ?? []).filter((f) => ehPrimitivo(f.tipo)).map((f) => f.caminho),
      );
      for (const entrada of [...t.permitidas.keys(), ...t.soLog.keys(), ...t.negadas]) {
        if (folhas.has(entrada)) continue;
        if (t === TABELAS_AMAZON.orderChange && Object.hasOwn(FORA_DA_ESPECIFICACAO, entrada)) {
          usadas.add(entrada);
          continue;
        }
        if (
          t === TABELAS_AMAZON.orderChange &&
          /^(\*\.)?(eventSource|attributes\.AWSTraceHeader)$/.test(entrada)
        ) {
          continue; // the SQS envelope's own negadas
        }
        naoResolvidas.push(`${t.nome} ${entrada}`);
      }
    }
    expect(naoResolvidas).toEqual([]);
    // A named exception no table uses any more is stale too.
    expect([...usadas].sort()).toEqual(Object.keys(FORA_DA_ESPECIFICACAO).sort());
  });

  it('every amount, quantity* and status leaf of an estrutural operation is ALLOWED', () => {
    const faltando: string[] = [];
    for (const op of CORPOS) {
      if (classificarPorNome(op.operationId) === 'segredo') continue;
      for (const { caminho } of op.folhas) {
        const ultima = (caminho.split('.').pop() ?? '').toLowerCase();
        if (ultima !== 'amount' && !ultima.startsWith('quantity') && !ultima.endsWith('status')) {
          continue;
        }
        const regras = regrasDaFolhaAmazon(op.operationId, caminho);
        if (regras.length !== 1 || regras[0]?.tipo !== 'permitida') {
          faltando.push(`${op.operationId} ${caminho}`);
        }
      }
    }
    expect(faltando).toEqual([]);
  });

  it('no always-denied key sits on an allowed or soLog path (it would be a dead allow)', () => {
    const mortas: string[] = [];
    for (const t of Object.values(TABELAS_AMAZON)) {
      for (const entrada of [...t.permitidas.keys(), ...t.soLog.keys()]) {
        if (entrada.split('.').some((k) => k !== '*' && chaveNegadaAmazon(k))) {
          mortas.push(`${t.nome} ${entrada}`);
        }
      }
    }
    expect(mortas).toEqual([]);
  });

  it('allowed and soLog are disjoint in every table', () => {
    for (const t of Object.values(TABELAS_AMAZON)) {
      for (const c of t.soLog.keys()) expect(t.permitidas.has(c), `${t.nome} ${c}`).toBe(false);
    }
  });

  it('an `aberto` (open-map) leaf must be denied; a synthetic one is not claimed by any allow', () => {
    for (const op of CORPOS) {
      for (const f of op.folhas.filter((x) => x.tipo === 'aberto')) {
        const regras = regrasDaFolhaAmazon(op.operationId, f.caminho);
        expect(
          regras.map((r) => r.tipo),
          `${op.operationId} ${f.caminho}`,
        ).not.toContain('permitida');
      }
    }
    // Anti-vacuity on today's inventory (no open map in the in-scope models).
    expect(regrasDaFolhaAmazon('getOrder', 'order.*').some((r) => r.tipo === 'permitida')).toBe(
      false,
    );
  });

  it('every error entry carries errors[].code, and its message/details are denied keys', () => {
    const erros = INVENTARIO.operacoes.filter((o) => o.status === 'erro');
    expect(erros.length).toBe(6);
    for (const op of erros) {
      const caminhos = op.folhas.map((f) => f.caminho);
      expect(
        caminhos.some((c) => c.endsWith('.code')),
        op.operationId,
      ).toBe(true);
      for (const c of caminhos.filter((x) => /\.(message|details)$/.test(x))) {
        expect(chaveNegadaAmazon(c.split('.').pop() ?? ''), c).toBe(true);
      }
    }
  });

  it('CODIGOS_ERRO_AMAZON holds every code the generator found in the models examples', () => {
    expect(INVENTARIO.codigosDeErroDosExemplos.length).toBeGreaterThan(0);
    for (const c of INVENTARIO.codigosDeErroDosExemplos) {
      expect(CODIGOS_ERRO_AMAZON.has(c), c).toBe(true);
    }
  });

  it('the security lists are pinned verbatim', () => {
    expect([...SUBARVORES_NEGADAS_AMAZON]).toEqual([
      'buyer',
      'recipient',
      'shipFromAddress',
      'taxRegistrationAddress',
      'internationalShipping',
      'customization',
      'deliveryPreference',
    ]);
    expect([...CHAVES_NEGADAS_AMAZON]).toEqual([
      'buyerName',
      'buyerEmail',
      'buyerCompanyName',
      'buyerPurchaseOrderNumber',
      'name',
      'companyName',
      'legalName',
      'taxRegistrationNumber',
      'acquirerId',
      'authorizationCode',
      'giftMessage',
      'conditionNote',
      'title',
      'customizedUrl',
      'serialNumbers',
      'orderItemSerialNumbers',
      'cancelReason',
      'iossNumber',
      'responsibleParty',
      'transparencyCodes',
      'packageIdentifier',
      'printableDocumentsUrl',
      'url',
      'restrictedDataToken',
      'invoiceContent',
      'receiptHandle',
      'eventSourceARN',
      'SenderId',
      'md5OfBody',
      'messageAttributes',
      'DestinationPostalCode',
      'ChangeReason',
      'otp',
      'returnReason',
      'message',
      'details',
    ]);
    expect(PREFIXOS_NEGADOS_AMAZON).toEqual([
      'address',
      'postal',
      'phone',
      'email',
      'street',
      'gift',
    ]);
    expect([...ISENTOS_DE_DIGITOS].sort()).toEqual(
      [
        'pedidoAmazon',
        'itemPedido',
        'asin',
        'inteiro',
        'decimal',
        'dataIso',
        'chaveNfe',
        'uuid',
        'opaco',
        'idMarketplace',
        'idAplicacao',
      ].sort(),
    );
    expect(ISENTOS_DE_DIGITOS.has('sku')).toBe(false);
    // A seller-typed id has the `opaco` grammar, never its exemption.
    expect(ISENTOS_DE_DIGITOS.has('idDoVendedor')).toBe(false);
    for (const folha of [
      'order.orderAliases.*.aliasId',
      'order.orderItems.*.promotion.breakdowns.*.promotionId',
      'order.packages.*.packageReferenceId',
    ]) {
      expect(regrasDaFolhaAmazon('getOrder', folha), folha).toEqual([
        { tipo: 'soLog', predicado: 'idDoVendedor', classe: expect.any(String) as unknown },
      ]);
    }
  });
});

function classificarPorNome(nome: string): string | null {
  if (nome === 'OrderChangeNotification')
    return classificarCaminho(NOTIFICACAO_ORDER_CHANGE).politica;
  const m = MODELOS_DE_CAMINHO_AMAZON.find((x) => x.nome === nome);
  return m?.politica ?? null;
}

/* -------------------------------------------------------------------------- */
/*                           The BR sandbox snapshot                           */
/* -------------------------------------------------------------------------- */

describe('the BR sandbox order (§3 decision 11)', () => {
  it('each transcription has EXACTLY the leaf paths of its sandbox case (structural parity)', () => {
    expect([...caminhosDe(getOrderBr())].sort()).toEqual(INVENTARIO.exemplosBr.getOrder);
    expect([...caminhosDe(searchOrdersBr())].sort()).toEqual(INVENTARIO.exemplosBr.searchOrders);
  });

  it('the base transcription carries no DV-valid id (the near-miss variant below injects one)', () => {
    for (const id of ['10000000000001', '10000000000002']) expect(validateCNPJ(id)).toBe(false);
    expect(
      validateCNPJ(String(em(searchOrdersBr(), 'orders.0.payment.paymentExecutions.0.acquirerId'))),
    ).toBe(true);
  });

  const instantaneo = () => ({
    getOrder: {
      log: JSON.parse(
        log(GET_ORDER, 200, JSON.stringify(getOrderBr())).trecho ?? 'null',
      ) as unknown,
      fixture: fixtureJson(GET_ORDER, 200, getOrderBr()),
    },
    searchOrders: {
      log: JSON.parse(
        log(SEARCH, 200, JSON.stringify(searchOrdersBr())).trecho ?? 'null',
      ) as unknown,
      fixture: fixtureJson(SEARCH, 200, searchOrdersBr()),
    },
  });

  it('both profiles, snapshotted', () => {
    expect(instantaneo()).toMatchSnapshot();
  });

  it('the snapshot holds nothing the regex layer or a DV pass finds, outside the placeholders', () => {
    const achados: string[] = [];
    for (const s of textos(instantaneo())) {
      if (PLACEHOLDERS_FIXTURE_AMAZON.has(s)) continue;
      if (mascararTexto(s, { digitos: true }).mascarados > 0) achados.push(s.slice(0, 40));
      for (const m of s.match(/[0-9A-Z]{11,14}/g) ?? []) {
        if ((m.length === 11 && validateCPF(m)) || (m.length === 14 && validateCNPJ(m))) {
          achados.push(`dv:${m.length}`);
        }
      }
    }
    expect(achados).toEqual([]);
    // Anti-vacuity: the fixture side really carries the shape-preserving placeholders.
    const todos = textos(instantaneo());
    expect(todos).toContain(PLACEHOLDERS_DOCUMENTO_AMAZON.cnpjPontuado);
    expect(todos).toContain(PLACEHOLDERS_DOCUMENTO_AMAZON.cnpjRaiz8);
    expect(todos).toContain('0000000000');
  });

  it('the snapshot never carries a buyer value of the transcription', () => {
    const texto = JSON.stringify(instantaneo());
    for (const pii of [
      'Compradora Ficticia Um',
      'Comprador Ficticio Dois',
      'compradora-ficticia@example.invalid',
      'Rua Ficticia',
      '+55 11 90000-0000',
      '01000-000',
      'Mensagem ficticia de presente',
      'Produto Ficticio de Teste',
      'Empresa Ficticia Ltda',
      'Loja Ficticia Ltda',
      'PO-TESTE-0000',
      '9876501234',
      '87654321',
    ]) {
      expect(texto, pii).not.toContain(pii);
    }
  });

  describe('variants', () => {
    const comRegistro = (numero: string) => {
      const b = searchOrdersBr();
      const pedido = b.orders[0] as { tax: { taxRegistrations: unknown[] } };
      pedido.tax.taxRegistrations.push({
        entityType: 'BUYER',
        taxRegistrationType: 'CPF',
        taxRegistrationNumber: numero,
      });
      return b;
    };

    it.each([
      ['punctuated', CPF_PONTUADO, PLACEHOLDERS_DOCUMENTO_AMAZON.cpfPontuado],
      ['bare 11', CPF, PLACEHOLDERS_DOCUMENTO_AMAZON.cpf11],
    ])(
      '★ a BUYER CPF registration (%s, DV-valid at run time) is redacted by key, and keeps its shape in a fixture',
      (_c, numero, placeholder) => {
        const caminho = 'orders.0.tax.taxRegistrations.3.taxRegistrationNumber';
        expect(em(logJson(SEARCH, 200, comRegistro(numero)), caminho)).toBe(REDIGIDO);
        expect(em(fixtureJson(SEARCH, 200, comRegistro(numero)), caminho)).toBe(placeholder);
        expect(JSON.stringify(log(SEARCH, 200, JSON.stringify(comRegistro(numero))))).not.toContain(
          CPF,
        );
      },
    );

    it('★ a CPF planted in sellerSku (an ALLOWED leaf): layer 2 masks it in the log; the fixture fakes it and counts it', () => {
      const b = getOrderBr();
      const item = (b.order.orderItems as { product: { sellerSku: string } }[])[0];
      if (item === undefined) throw new Error('fixture');
      item.product.sellerSku = CPF;
      const r = log(GET_ORDER, 200, JSON.stringify(b));
      expect(em(JSON.parse(r.trecho ?? 'null'), 'order.orderItems.0.product.sellerSku')).toBe(
        '<redacted:cpf>',
      );
      expect(r.mascarados).toBeGreaterThan(0);
      expect(r.trecho).not.toContain(CPF);
      const f = fixture(GET_ORDER, 200, JSON.stringify(b));
      if (!f.ok) throw new Error(f.motivo);
      expect(JSON.stringify(f.corpo)).not.toContain(CPF);
      expect(f.mascarados).toBeGreaterThan(0);
    });

    it('★ near-miss: a DV-valid 14-digit orderItemId stays VERBATIM in the log (the leaf is exempt)', () => {
      const b = getOrderBr();
      const item = (b.order.orderItems as { orderItemId: string }[])[0];
      if (item === undefined) throw new Error('fixture');
      item.orderItemId = CNPJ;
      expect(validateCNPJ(CNPJ)).toBe(true);
      expect(em(logJson(GET_ORDER, 200, b), 'order.orderItems.0.orderItemId')).toBe(CNPJ);
    });

    it('★ near-miss: the same 14 digits under an UNKNOWN key are redacted', () => {
      const b = getOrderBr();
      (b.order as Record<string, unknown>).campoNovo = CNPJ;
      expect(em(logJson(GET_ORDER, 200, b), 'order.campoNovo')).toBe(REDIGIDO);
    });

    it('★ the 8-digit MARKETPLACE root and the 10-digit buyer VAT are redacted by KEY (no pattern catches either)', () => {
      expect(mascararTexto('87654321', { digitos: true }).mascarados).toBe(0);
      expect(mascararTexto('9876501234', { digitos: true }).mascarados).toBe(0);
      const saida = logJson(SEARCH, 200, searchOrdersBr());
      expect(em(saida, 'orders.0.tax.taxRegistrations.0.taxRegistrationNumber')).toBe(REDIGIDO);
      expect(em(saida, 'orders.0.tax.taxRegistrations.1.taxRegistrationNumber')).toBe(REDIGIDO);
      // …while the enum beside them is kept.
      expect(em(saida, 'orders.0.tax.taxRegistrations.1.taxRegistrationType')).toBe('CNPJ');
    });

    it('★ a DV-valid document in a SELLER-typed id (the alias, a promotion, a package reference) takes the check-digit pass', () => {
      const b = getOrderBr();
      b.order.orderAliases = [{ aliasId: CPF, aliasType: 'SELLER_ORDER_ID' }];
      b.order.packages = [{ packageReferenceId: CPF }];
      const item = (
        b.order.orderItems as { promotion: { breakdowns: { promotionId: string }[] } }[]
      )[0];
      const promocao = item?.promotion.breakdowns[0];
      if (promocao === undefined) throw new Error('fixture');
      promocao.promotionId = CNPJ;
      const s = logJson(GET_ORDER, 200, b);
      expect(em(s, 'order.orderAliases.0.aliasId')).toBe('<redacted:cpf>');
      expect(em(s, 'order.packages.0.packageReferenceId')).toBe('<redacted:cpf>');
      expect(em(s, 'order.orderItems.0.promotion.breakdowns.0.promotionId')).toBe(
        '<redacted:cnpj>',
      );
      // Near-miss: the transcription's own seller ids are kept…
      const base = logJson(GET_ORDER, 200, getOrderBr());
      expect(em(base, 'order.orderAliases.0.aliasId')).toBe('BR-PEDIDO-TESTE-0003');
      expect(em(base, 'order.orderItems.0.promotion.breakdowns.0.promotionId')).toBe(
        'BR-PROMO-TESTE-01',
      );
      // …and an AMAZON-made opaque id stays exempt: the same digits survive.
      expect(
        em(
          logJson(PACOTE, 200, { scheduledPackageId: { packageId: CNPJ } }),
          'scheduledPackageId.packageId',
        ),
      ).toBe(CNPJ);
    });

    it.each([
      ['9-2', `${CPF.slice(0, 9)}-${CPF.slice(9)}`, 'cpf'],
      [
        '3.3.3.2',
        `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6, 9)}.${CPF.slice(9)}`,
        'cpf',
      ],
      [
        'a CNPJ without its dots',
        `${CNPJ.slice(0, 8)}/${CNPJ.slice(8, 12)}-${CNPJ.slice(12)}`,
        'cnpj',
      ],
    ])(
      '★ a half-punctuated document (%s) planted in sellerSku is masked in the log and faked in a fixture',
      (_c, documento, tipo) => {
        const b = getOrderBr();
        const item = (b.order.orderItems as { product: { sellerSku: string } }[])[0];
        if (item === undefined) throw new Error('fixture');
        item.product.sellerSku = documento;
        expect(em(logJson(GET_ORDER, 200, b), 'order.orderItems.0.product.sellerSku')).toBe(
          `<redacted:${tipo}>`,
        );
        const f = fixture(GET_ORDER, 200, JSON.stringify(b));
        if (!f.ok) throw new Error(f.motivo);
        expect(JSON.stringify(f.corpo)).not.toContain(documento);
        expect(f.mascarados).toBeGreaterThan(0);
      },
    );

    it('★ fixture: an ALLOWED leaf the regex layer flags is FAKED, and counted; near-miss: a vocabulary carrier is kept', () => {
      const comTransportadora = (carrier: string) => {
        const b = getOrderBr();
        b.order.packages = [{ carrier }];
        return b;
      };
      // `rotulo` admits digits, dots and hyphens: the punctuated CPF passes the predicate.
      const f = fixture(GET_ORDER, 200, JSON.stringify(comTransportadora(CPF_PONTUADO)));
      if (!f.ok) throw new Error(f.motivo);
      expect(em(f.corpo, 'order.packages.0.carrier')).toBe(FALSO_AMAZON.texto);
      expect(f.mascarados).toBeGreaterThan(0);
      const limpo = fixture(GET_ORDER, 200, JSON.stringify(comTransportadora('Correios')));
      if (!limpo.ok) throw new Error(limpo.motivo);
      expect(em(limpo.corpo, 'order.packages.0.carrier')).toBe('Correios');
      expect(limpo.mascarados).toBe(0);
    });

    it('★ fixture: a `rotulo` outside the closed vocabulary (a courier named as the carrier) is FAKED and counted; the log keeps it; near-miss: Correios / SEDEX / Visa / Amazon.com.br are kept', () => {
      const comRotulos = (carrier: string, shippingService: string, cardBrand: string) => {
        const b = getOrderBr();
        b.order.packages = [{ carrier, shippingService }];
        b.order.payment = { paymentExecutions: [{ paymentMethod: 'CreditCard', cardBrand }] };
        return b;
      };
      const livre = comRotulos('Fulano de Tal Entregas', 'Motoboy Sicrano', 'Beltrana Silva');
      const f = fixture(GET_ORDER, 200, JSON.stringify(livre));
      if (!f.ok) throw new Error(f.motivo);
      expect(em(f.corpo, 'order.packages.0.carrier')).toBe(FALSO_AMAZON.texto);
      expect(em(f.corpo, 'order.packages.0.shippingService')).toBe(FALSO_AMAZON.texto);
      expect(em(f.corpo, 'order.payment.paymentExecutions.0.cardBrand')).toBe(FALSO_AMAZON.texto);
      expect(f.mascarados).toBe(3);
      // The log profile is unchanged: a free-text label is an operator's clue there.
      expect(em(logJson(GET_ORDER, 200, livre), 'order.packages.0.carrier')).toBe(
        'Fulano de Tal Entregas',
      );
      // Near-miss: vocabulary values stay, uncounted.
      const conhecido = fixture(
        GET_ORDER,
        200,
        JSON.stringify(comRotulos('Correios', 'SEDEX', 'Visa')),
      );
      if (!conhecido.ok) throw new Error(conhecido.motivo);
      expect(em(conhecido.corpo, 'order.packages.0.carrier')).toBe('Correios');
      expect(em(conhecido.corpo, 'order.packages.0.shippingService')).toBe('SEDEX');
      expect(em(conhecido.corpo, 'order.payment.paymentExecutions.0.cardBrand')).toBe('Visa');
      expect(em(conhecido.corpo, 'order.salesChannel.marketplaceName')).toBe('Amazon.com.br');
      expect(conhecido.mascarados).toBe(0);
      // The fake is a fixpoint: re-redacting the fixture changes nothing and counts nothing.
      const falsificador = falsificadorDeTeste();
      const um = redigirCorpo(
        { caminho: GET_ORDER, status: 200, corpo: JSON.stringify(livre) },
        'fixture',
        { falsificador },
      );
      if (!um.ok) throw new Error(um.motivo);
      const dois = redigirCorpo(
        { caminho: GET_ORDER, status: 200, corpo: JSON.stringify(um.corpo) },
        'fixture',
        { falsificador },
      );
      if (!dois.ok) throw new Error(dois.motivo);
      expect(dois.corpo).toEqual(um.corpo);
      expect(dois.mascarados).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              The keys of a 2xx                              */
/* -------------------------------------------------------------------------- */

describe('the KEYS of a 2xx body', () => {
  it('★ log: every key takes the regex layer (an e-mail or a CPF as a KEY is masked); near-miss: a plain key is kept', () => {
    expect(
      Object.keys(logJson(DESCONHECIDO, 200, { 'a@b.example': 1, [CPF]: 2, status: 3 }) as object),
    ).toEqual(['<redacted:email>', '<redacted:cpf>', 'status']);
    expect(Object.keys(logJson(DESCONHECIDO, 200, { 'andré@example.com': 1 }) as object)).toEqual([
      '<redacted:email>',
    ]);
  });

  it('★ fixture: a key outside the identifier grammar is positional; near-miss: an identifier key survives', () => {
    expect(
      Object.keys(
        fixtureJson(GET_ORDER, 200, { 'a@b.example': 1, 'Atza|x': 2, campoNovo: 3 }) as object,
      ),
    ).toEqual(['chave_redigida_1', 'chave_redigida_2', 'campoNovo']);
  });

  it('★ fixture: a CONFORMING key that embeds a document is positional too, and counted — never laxer than the log', () => {
    const b = getOrderBr();
    b.order[`cpf${CPF}`] = 'x';
    expect(log(GET_ORDER, 200, JSON.stringify(b)).trecho).not.toContain(CPF);
    const f = fixture(GET_ORDER, 200, JSON.stringify(b));
    if (!f.ok) throw new Error(f.motivo);
    expect(JSON.stringify(f.corpo)).not.toContain(CPF);
    expect(f.mascarados).toBeGreaterThan(0);
    const chaves = Object.keys(em(f.corpo, 'order') as object);
    expect(chaves.filter((k) => k.startsWith('chave_redigida_'))).toHaveLength(1);
    // Near-miss: every key of the base transcription survives as it is.
    expect(Object.keys(em(fixtureJson(GET_ORDER, 200, getOrderBr()), 'order') as object)).toEqual(
      Object.keys(getOrderBr().order),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                               Deny keys, case                               */
/* -------------------------------------------------------------------------- */

describe('denied keys', () => {
  it.each(['BuyerEmail', 'BUYEREMAIL', 'buyeremail', 'buyerEmail'])(
    '★ %s is denied, in any case',
    (k) => {
      expect(chaveNegadaAmazon(k)).toBe(true);
      // In an error body a boolean or a small integer would otherwise survive.
      const saida = logJson(GET_ORDER, 400, { errors: [{ code: 'InvalidInput', [k]: 12 }] });
      expect(em(saida, `errors.0.${k}`)).toBe(REDIGIDO);
      const bool = logJson(GET_ORDER, 400, { [k]: true });
      expect(em(bool, k)).toBe(REDIGIDO);
    },
  );

  it('near-miss: in an error body, an allowed-looking small integer under a plain key survives', () => {
    expect(em(logJson(GET_ORDER, 400, { retryAfter: 12 }), 'retryAfter')).toBe(12);
  });

  it('★ near-miss: tax.taxInvoicing.buyerInvoicePreference is KEPT (allowed by path, no deny prefix covers it)', () => {
    const b = { order: { tax: { taxInvoicing: { buyerInvoicePreference: 'BUSINESS' } } } };
    expect(em(logJson(GET_ORDER, 200, b), 'order.tax.taxInvoicing.buyerInvoicePreference')).toBe(
      'BUSINESS',
    );
    expect(chaveNegadaAmazon('buyerInvoicePreference')).toBe(false);
    // The same key under an UNKNOWN parent: the estrutural default redacts it.
    const fora = { order: { outro: { buyerInvoicePreference: 'BUSINESS' } } };
    expect(em(logJson(GET_ORDER, 200, fora), 'order.outro.buyerInvoicePreference')).toBe(REDIGIDO);
  });

  it('a denied subtree wins at ANY depth, keys and lengths kept', () => {
    const b = { order: { buyer: { buyerName: 'X', nested: [{ a: 'Y' }] } } };
    expect(logJson(GET_ORDER, 200, b)).toEqual({
      order: { buyer: { buyerName: REDIGIDO, nested: [{ a: REDIGIDO }] } },
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                               The regex layer                               */
/* -------------------------------------------------------------------------- */

describe('the regex layer, per leaf, on decoded strings', () => {
  it('★ an e-mail hidden behind a JSON escape is masked (the walk reads the DECODED leaf)', () => {
    const corpo = '{"order":{"orderItems":[{"product":{"sellerSku":"a\\u0040b.example"}}]}}';
    expect(corpo).not.toContain('@');
    const r = log(GET_ORDER, 200, corpo);
    expect(em(JSON.parse(r.trecho ?? 'null'), 'order.orderItems.0.product.sellerSku')).toBe(
      '<redacted:email>',
    );
  });

  it.each([
    ['+55 11 98765-4321', '+55 with spaces'],
    ['+5511987654321', 'E.164 BR'],
    ['11 98765 4321', 'DDD and spaces'],
    ['(11) 98765-4321', 'parenthesised DDD'],
    ['+1 206 555 0100', 'international'],
    ['98765-4321', 'hyphenated, no DDD'],
  ])('★ phone %s (%s) → <redacted:telefone>', (fone) => {
    expect(mascararTexto(`tel ${fone} fim`, { digitos: false }).texto).toBe(
      'tel <redacted:telefone> fim',
    );
  });

  it.each([
    ['an order id 3-7-7', '171-9876543-2109876'],
    ['a 14-digit item id', '17198765432109'],
    ['an ISO date with an offset', '2024-12-24T20:30:00-03:00'],
    ['an ISO date with a + offset', '2022-03-09T10:00:00+09:00'],
    ['a UUID', 'd0e9e693-c3ad-4373-979f-ed4ec98dd746'],
    ['an application id', 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000'],
    ['a money string', '1599.90'],
    ['the 44-digit chave', '35200000000000000000000000000000000000000000'],
    ['a host name', 's3.aws.example.com'],
  ])('near-miss: %s stays distinct (no pattern)', (_c, v) => {
    expect(mascararTexto(v, { digitos: false })).toEqual({ texto: v, mascarados: 0 });
  });

  it.each([
    ['cpf', CPF_PONTUADO],
    ['cnpj', pontuarCnpj(CNPJ)],
    ['cnpj', pontuarCnpj(CNPJ_LETRA)],
    ['cnpj-raiz', '12.345.678'],
    ['cep', '01310-100'],
    ['cep', '01.310-100'],
    ['email', 'x@example.com'],
    ['token-lwa', 'Atza|IwEBIAbc'],
    ['token-lwa', 'Atzr|IwEBIAbc'],
    ['segredo-lwa', 'amzn1.oa2-cs.v1.0123abcd'],
    ['chave-aws', 'AKIAABCDEFGHIJKLMNOP'],
    ['arn', 'arn:aws:sqs:xx-teste-1:123456789012:fila'],
    ['url', 'https://x.example/doc?X-Amz-Signature=abc'],
    ['blob', 'A'.repeat(120)],
  ])('always on: %s', (tipo, v) => {
    expect(mascararTexto(`x ${v} y`, { digitos: false }).texto).toBe(`x <redacted:${tipo}> y`);
  });

  it('near-miss: a URL without a query, and a 119-character run, are not masked', () => {
    expect(mascararTexto('https://x.example/doc', { digitos: false }).mascarados).toBe(0);
    expect(mascararTexto('A'.repeat(119), { digitos: false }).mascarados).toBe(0);
  });

  it('with digitos: bare DV-valid CPF / CNPJ / letter CNPJ; near-miss: one wrong DV is kept', () => {
    expect(mascararTexto(CPF, { digitos: true }).texto).toBe('<redacted:cpf>');
    expect(mascararTexto(CNPJ, { digitos: true }).texto).toBe('<redacted:cnpj>');
    expect(mascararTexto(CNPJ_LETRA, { digitos: true }).texto).toBe('<redacted:cnpj>');
    const errado = `${CPF.slice(0, 10)}${String((Number(CPF[10]) + 1) % 10)}`;
    expect(mascararTexto(errado, { digitos: true }).mascarados).toBe(0);
    // Without digitos, the bare runs are never touched.
    expect(mascararTexto(CPF, { digitos: false }).mascarados).toBe(0);
  });

  it.each([
    ['cpf', '9-2', `${CPF.slice(0, 9)}-${CPF.slice(9)}`],
    ['cpf', '3.3.3.2', `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6, 9)}.${CPF.slice(9)}`],
    ['cpf', '3-3-3-2', `${CPF.slice(0, 3)}-${CPF.slice(3, 6)}-${CPF.slice(6, 9)}-${CPF.slice(9)}`],
    ['cpf', '3.3.5', `${CPF.slice(0, 3)}.${CPF.slice(3, 6)}.${CPF.slice(6)}`],
    ['cnpj', 'no dots', `${CNPJ.slice(0, 8)}/${CNPJ.slice(8, 12)}-${CNPJ.slice(12)}`],
    [
      'cnpj',
      'no slash',
      `${CNPJ.slice(0, 2)}.${CNPJ.slice(2, 5)}.${CNPJ.slice(5, 8)}${CNPJ.slice(8, 12)}-${CNPJ.slice(12)}`,
    ],
    [
      'cnpj',
      'letters, no dots',
      `${CNPJ_LETRA.slice(0, 8)}/${CNPJ_LETRA.slice(8, 12)}-${CNPJ_LETRA.slice(12)}`,
    ],
  ])(
    '★ with digitos: a half-punctuated %s (%s) is masked; near-miss: one wrong DV, or no digitos, is kept',
    (tipo, _c, v) => {
      expect(mascararTexto(`x ${v} y`, { digitos: true }).texto).toBe(`x <redacted:${tipo}> y`);
      expect(mascararTexto(`SKU-${v}`, { digitos: true }).texto).toBe(`SKU-<redacted:${tipo}>`);
      expect(mascararTexto(v, { digitos: false }).mascarados).toBe(0);
      const errado = `${v.slice(0, -1)}${String((Number(v.slice(-1)) + 1) % 10)}`;
      expect(mascararTexto(errado, { digitos: true }).mascarados).toBe(0);
    },
  );

  it.each([
    ['an order id 3-7-7', '171-9876543-2109876'],
    ['an ISO date with an offset', '2024-12-24T20:30:00-03:00'],
    ['a UUID', 'd0e9e693-c3ad-4373-979f-ed4ec98dd746'],
    ['an application id', 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000'],
    ['a money string', '1599.90'],
    ['the 44-digit chave', '35200000000000000000000000000000000000000000'],
    ['an epoch in ms', '1700000000000'],
    ['a version date', '2021-06-30'],
  ])('near-miss WITH digitos: %s stays distinct', (_c, v) => {
    expect(mascararTexto(v, { digitos: true })).toEqual({ texto: v, mascarados: 0 });
  });

  it.each([
    ['andré@example.com', '<redacted:email>'],
    ['joão@example.org', '<redacted:email>'],
    ['maria@exämple.example', '<redacted:email>'],
    ['contato andré@example.com.', 'contato <redacted:email>.'],
    // Near-misses: a quote or an ellipsis after an address is never part of it.
    ['“andré@example.com”', '“<redacted:email>”'],
    ['maria@example.net…', '<redacted:email>…'],
  ])('★ an e-mail with non-ASCII letters is masked WHOLE: %s', (t, esperado) => {
    expect(mascararTexto(t, { digitos: false }).texto).toBe(esperado);
  });

  it('never matched: a bare 8-digit CEP or root, a bare 10/11-digit phone, a 12-digit AWS account', () => {
    for (const v of ['01310100', '12345678', '1198765432', '11987654321', '123456789012']) {
      expect(mascararTexto(v, { digitos: false }).mascarados, v).toBe(0);
    }
  });

  it('linear: 1 MiB of "@" with no domain is scanned in under 1 s', () => {
    const t = '@'.repeat(1024 * 1024);
    const inicio = performance.now();
    expect(mascararTexto(t, { digitos: true }).mascarados).toBe(0);
    expect(performance.now() - inicio).toBeLessThan(1000);
  });

  it('linear: 1 MiB of "http://" with no query is scanned in under 1 s', () => {
    const t = 'http://'.repeat(150_000);
    const inicio = performance.now();
    expect(mascararTexto(t, { digitos: true }).mascarados).toBe(0);
    expect(performance.now() - inicio).toBeLessThan(1000);
  });
});

/* -------------------------------------------------------------------------- */
/*                               Path and query                                */
/* -------------------------------------------------------------------------- */

describe('redigirCaminhoEQuery', () => {
  const sellerId = 'AXXXXXXXXXXXXX';
  const caminhoListing = `/listings/2021-08-01/items/${sellerId}/SKU-1`;

  it.each(['log', 'fixture'] as const)(
    '★ the {sellerId} slot is <sellerId> in the %s profile',
    (perfil) => {
      const r = redigirCaminhoEQuery(caminhoListing, [], perfil, {
        falsificador: falsificadorDeTeste(),
      });
      expect(r.caminho.startsWith(`/listings/2021-08-01/items/${SELLER_ID_REDIGIDO}/`)).toBe(true);
      expect(r.texto).not.toContain(sellerId);
    },
  );

  it('a percent-encoded SKU is tested DECODED and emitted RAW in the log; faked in a fixture', () => {
    const r = redigirCaminhoEQuery(
      '/listings/2021-08-01/items/AXXXXXXXXXXXXX/SKU%23A%2BB',
      [],
      'log',
    );
    expect(r.caminho).toBe('/listings/2021-08-01/items/<sellerId>/SKU%23A%2BB');
    // Near-miss: the decoded segment holds a space, outside the SKU grammar.
    expect(
      redigirCaminhoEQuery('/listings/2021-08-01/items/AXXXXXXXXXXXXX/SKU%20A', [], 'log').caminho,
    ).toBe(`/listings/2021-08-01/items/<sellerId>/${SEGMENTO_REDIGIDO}`);
    const f = redigirCaminhoEQuery(
      '/listings/2021-08-01/items/AXXXXXXXXXXXXX/SKU%2DA',
      [],
      'fixture',
      {
        falsificador: falsificadorDeTeste(),
      },
    );
    expect(f.caminho).toMatch(/\/SKU-Z[0-9a-f]{8}$/);
  });

  it('a SKU that IS a document is refused as a segment, and counted', () => {
    const r = redigirCaminhoEQuery(`/listings/2021-08-01/items/AXXXXXXXXXXXXX/${CPF}`, [], 'log');
    expect(r.caminho.endsWith(`/${SEGMENTO_REDIGIDO}`)).toBe(true);
    expect(r.mascarados).toBe(1);
  });

  it('an order id slot is kept in the log, faked in a fixture; a malformed one is <seg>', () => {
    expect(redigirCaminhoEQuery(GET_ORDER, [], 'log').caminho).toBe(GET_ORDER);
    expect(
      redigirCaminhoEQuery(GET_ORDER, [], 'fixture', { falsificador: falsificadorDeTeste() })
        .caminho,
    ).toBe('/orders/2026-01-01/orders/000-0000000-0000001');
    expect(redigirCaminhoEQuery('/orders/2026-01-01/orders/Maria', [], 'log').caminho).toBe(
      `/orders/2026-01-01/orders/${SEGMENTO_REDIGIDO}`,
    );
  });

  describe.each(['log', 'fixture'] as const)(
    'the other slot kinds, in the %s profile',
    (perfil) => {
      const r = (caminho: string) =>
        redigirCaminhoEQuery(caminho, [], perfil, { falsificador: falsificadorDeTeste() }).caminho;

      it('★ a segredo slot (a report or feed document id) is NEVER kept', () => {
        expect(r('/reports/2021-06-30/documents/amzn1.spdoc.1.4.na.x')).toBe(
          `/reports/2021-06-30/documents/${SEGMENTO_REDIGIDO}`,
        );
        expect(r('/feeds/2021-06-30/documents/amzn1.tortuga.4.na.x')).toBe(
          `/feeds/2021-06-30/documents/${SEGMENTO_REDIGIDO}`,
        );
      });

      it('★ a digitos slot keeps digits only; near-miss: a report id is kept', () => {
        expect(r('/reports/2021-06-30/reports/Maria')).toBe(
          `/reports/2021-06-30/reports/${SEGMENTO_REDIGIDO}`,
        );
        expect(r('/reports/2021-06-30/reports/123')).toBe('/reports/2021-06-30/reports/123');
      });

      it('★ an enum slot keeps an enum only; near-miss: ORDER_CHANGE is kept', () => {
        expect(r('/notifications/v1/subscriptions/maria')).toBe(
          `/notifications/v1/subscriptions/${SEGMENTO_REDIGIDO}`,
        );
        expect(r('/notifications/v1/subscriptions/ORDER_CHANGE')).toBe(
          '/notifications/v1/subscriptions/ORDER_CHANGE',
        );
      });

      it("★ a literal `&` cannot split a slot's segment: the WHOLE segment is tested", () => {
        expect(r(`${GET_ORDER}&MariaDaSilva`)).toBe(
          `/orders/2026-01-01/orders/${SEGMENTO_REDIGIDO}`,
        );
        expect(r('/reports/2021-06-30/reports/123&MariaDaSilva')).toBe(
          `/reports/2021-06-30/reports/${SEGMENTO_REDIGIDO}`,
        );
        expect(r('/notifications/v1/subscriptions/ORDER_CHANGE&Maria')).toBe(
          `/notifications/v1/subscriptions/${SEGMENTO_REDIGIDO}`,
        );
        expect(r('/notifications/v1/destinations/abc&Maria')).toBe(
          `/notifications/v1/destinations/${SEGMENTO_REDIGIDO}`,
        );
      });
    },
  );

  it('★ an unknown path with a LOWERCASE name segment gives <seg> (no "lowercase looks safe" rule)', () => {
    expect(redigirCaminhoEQuery('/orders/2026-01-01/joao', [], 'log').caminho).toBe(
      `/orders/2026-01-01/${SEGMENTO_REDIGIDO}`,
    );
    expect(redigirCaminhoEQuery(DESCONHECIDO, [], 'log').caminho).toBe(
      `/${SEGMENTO_REDIGIDO}/2030-01-01/${SEGMENTO_REDIGIDO}`,
    );
  });

  it('★ an unknown query key keeps its name and LOSES its value', () => {
    const r = redigirCaminhoEQuery(
      SEARCH,
      [
        ['buyerEmail', 'a@b.co'],
        ['x-y', 'v'],
      ],
      'log',
    );
    expect(r.query).toEqual([
      ['buyerEmail', REDIGIDO],
      ['chave_redigida_2', REDIGIDO],
    ]);
    expect(r.texto).not.toContain('a@b.co');
  });

  it.each(['nextToken', 'paginationToken'])('★ %s gives <token len=N>', (k) => {
    const r = redigirCaminhoEQuery(SEARCH, [[k, 'abcDEF123==']], 'log');
    expect(r.query).toEqual([[k, '<token len=11>']]);
  });

  it.each([
    'X-Amz-Signature',
    'X-Amz-Credential',
    'access_token',
    'client_secret',
    'state',
    'spapi_oauth_code',
    'apiKey',
  ])(
    'the credential-shaped key %s loses its value, and is recognised as credential-shaped',
    (k) => {
      const r = redigirCaminhoEQuery(SEARCH, [[k, 'valor-secreto']], 'log');
      expect(r.query[0]?.[1]).toBe(REDIGIDO);
      expect(r.texto).not.toContain('valor-secreto');
      // The NAME survives only inside the key grammar (`X-Amz-…` has hyphens).
      expect(r.query[0]?.[0]).toBe(/^[A-Za-z_]{1,32}$/.test(k) ? k : 'chave_redigida_1');
      // The value above is lost as an UNKNOWN key already: what pins the credential
      // check itself is that it recognises the name (it runs before the allow-list).
      expect(chaveDeCredencialAmazon(k)).toBe(true);
    },
  );

  it('the credential check is belt and braces today: no allow-listed query key is credential-shaped', () => {
    expect([...CHAVES_DA_QUERY_AMAZON].filter(chaveDeCredencialAmazon)).toEqual([]);
    // Anti-vacuity: the allow-list is the one the table documents.
    expect(CHAVES_DA_QUERY_AMAZON.has('includedData')).toBe(true);
    expect(CHAVES_DA_QUERY_AMAZON.has('invoiceId')).toBe(true);
    // Near-miss: the pagination cursors are handled before both checks.
    expect(chaveDeCredencialAmazon('nextToken')).toBe(true);
    expect(CHAVES_DA_QUERY_AMAZON.has('nextToken')).toBe(false);
  });

  it('★ near-miss: includedData=BUYER,RECIPIENT and the BR marketplace are KEPT', () => {
    const r = redigirCaminhoEQuery(
      SEARCH,
      [
        ['includedData', 'BUYER,RECIPIENT'],
        ['marketplaceIds', 'A2Q3Y263D00KWC'],
        ['createdAfter', '2024-12-20T00:00:00Z'],
        ['maxResultsPerPage', '20'],
      ],
      'log',
    );
    expect(r.texto).toBe(
      '/orders/2026-01-01/orders?includedData=BUYER,RECIPIENT&marketplaceIds=A2Q3Y263D00KWC&createdAfter=2024-12-20T00:00:00Z&maxResultsPerPage=20',
    );
  });

  it('a known key whose value fails its predicate loses it; the invoice id is kept in log, faked in fixture', () => {
    expect(redigirCaminhoEQuery(SEARCH, [['includedData', 'buyer name']], 'log').query).toEqual([
      ['includedData', REDIGIDO],
    ]);
    const chave = '35200000000000000000000000000000000000000000';
    expect(redigirCaminhoEQuery(STATUS_NF, [['invoiceId', chave]], 'log').query).toEqual([
      ['invoiceId', chave],
    ]);
    const f = redigirCaminhoEQuery(STATUS_NF, [['invoiceId', chave]], 'fixture', {
      falsificador: falsificadorDeTeste(),
    });
    expect(f.query[0]?.[1]).toMatch(/^0{20}55000\d{9}0{9}\d$/);
  });
});

/* -------------------------------------------------------------------------- */
/*                                The error walk                               */
/* -------------------------------------------------------------------------- */

describe('the error walk (every non-2xx JSON body, both profiles)', () => {
  const corpo = {
    errors: [
      {
        code: 'InvalidInput',
        message: 'O pedido 123-4567890-1234567 de Maria não existe',
        details: `cpf ${CPF_PONTUADO}`,
      },
      { code: 'Maria' },
      { code: 'a@b.co' },
    ],
    flag: true,
    vazio: null,
    pequeno: 9_999_999,
    grande: 10_000_000,
    fracao: 0.5,
    'a@b.co': 1,
    palavra: 'Unauthorized',
  };

  it('★ only structure, booleans, null, integers below 1e7 and KNOWN codes survive; message/details never do', () => {
    expect(logJson(GET_ORDER, 400, corpo)).toEqual({
      errors: [
        { code: 'InvalidInput', message: REDIGIDO, details: REDIGIDO },
        { code: CODIGO_OUTRO },
        { code: CODIGO_OUTRO },
      ],
      flag: true,
      vazio: null,
      pequeno: 9_999_999,
      grande: REDIGIDO,
      fracao: REDIGIDO,
      chave_redigida_7: 1,
      palavra: REDIGIDO,
    });
  });

  it('the fixture profile takes the same walk, with fakes', () => {
    const f = fixtureJson(GET_ORDER, 400, corpo);
    expect(em(f, 'errors.0.code')).toBe('InvalidInput');
    expect(em(f, 'errors.0.message')).toBe(FALSO_AMAZON.texto);
    expect(em(f, 'errors.1.code')).toBe(CODIGO_OUTRO);
    expect(em(f, 'grande')).toBe(0);
    expect(JSON.stringify(f)).not.toContain('Maria');
  });

  it('a code array inherits its key; an LWA-style `error` word is refused', () => {
    expect(logJson(GET_ORDER, 500, { code: ['InternalFailure', 'Nome'], error: 'x' })).toEqual({
      code: ['InternalFailure', CODIGO_OUTRO],
      error: REDIGIDO,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                ORDER_CHANGE                                 */
/* -------------------------------------------------------------------------- */

describe('ORDER_CHANGE (the pseudo path, raw and Pipe-wrapped)', () => {
  const notificacao = () => ({
    NotificationVersion: '1.0',
    NotificationType: 'ORDER_CHANGE',
    PayloadVersion: '1.0',
    EventTime: '2020-01-11T00:09:53.109Z',
    Payload: {
      OrderChangeNotification: {
        NotificationLevel: 'OrderLevel',
        SellerId: 'AXXXXXXXXXXXXX',
        AmazonOrderId: '123-4567890-1234567',
        OrderChangeType: 'BuyerRequestedChange',
        OrderChangeTrigger: {
          TimeOfOrderChange: '2022-11-29T19:42:04.284Z',
          ChangeReason: 'A compradora Fulana pediu o cancelamento',
        },
        Summary: {
          MarketplaceId: 'A2Q3Y263D00KWC',
          OrderStatus: 'Unshipped',
          DestinationPostalCode: '01310-100',
          OrderItems: [{ OrderItemId: 'OIID00000001', SellerSKU: 'SKU-TESTE-0001', Quantity: 1 }],
        },
      },
    },
    NotificationMetadata: {
      ApplicationId: 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000',
      SubscriptionId: 'subscription-id-teste',
      PublishTime: '2020-07-13T19:42:04.284Z',
      NotificationId: '00000000-0000-4000-8000-000000000001',
    },
  });

  const registroSqs = (corpo: string) => ({
    messageId: '00000000-0000-4000-8000-000000000002',
    receiptHandle: 'AQEBexemploReceiptHandle',
    body: corpo,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1700000000000',
      SenderId: 'AIDAABCDEFGHIJKLMNOP',
      ApproximateFirstReceiveTimestamp: '1700000000001',
    },
    messageAttributes: { segredo: { stringValue: 'x' } },
    md5OfBody: '0123456789abcdef0123456789abcdef',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:xx-teste-1:123456789012:fila-teste',
    awsRegion: 'xx-teste-1',
  });

  it('★ the raw notification: SellerId → <sellerId>, DestinationPostalCode and ChangeReason redacted', () => {
    const s = logJson(NOTIFICACAO_ORDER_CHANGE, 200, notificacao());
    const oc = 'Payload.OrderChangeNotification';
    expect(em(s, `${oc}.SellerId`)).toBe(SELLER_ID_REDIGIDO);
    expect(em(s, `${oc}.OrderChangeTrigger.ChangeReason`)).toBe(REDIGIDO);
    expect(em(s, `${oc}.Summary.DestinationPostalCode`)).toBe(REDIGIDO);
    expect(em(s, `${oc}.AmazonOrderId`)).toBe('123-4567890-1234567');
    expect(em(s, `${oc}.Summary.OrderItems.0.Quantity`)).toBe(1);
    // The fixture: <sellerId> too, and the order id faked.
    const f = fixtureJson(NOTIFICACAO_ORDER_CHANGE, 200, notificacao());
    expect(em(f, `${oc}.SellerId`)).toBe(SELLER_ID_REDIGIDO);
    expect(em(f, `${oc}.AmazonOrderId`)).toBe('000-0000000-0000001');
  });

  it.each([
    ['one record', (c: string) => registroSqs(c), ''],
    ['a batch', (c: string) => [registroSqs(c)], '0.'],
  ])(
    '★ the Pipe body (%s) is PARSED and walked; receiptHandle, eventSourceARN and SenderId are redacted',
    (_c, montar, p) => {
      const s = logJson(NOTIFICACAO_ORDER_CHANGE, 200, montar(JSON.stringify(notificacao())));
      expect(em(s, `${p}receiptHandle`)).toBe(REDIGIDO);
      expect(em(s, `${p}eventSourceARN`)).toBe(REDIGIDO);
      expect(em(s, `${p}attributes.SenderId`)).toBe(REDIGIDO);
      expect(em(s, `${p}md5OfBody`)).toBe(REDIGIDO);
      expect(em(s, `${p}messageAttributes.segredo.stringValue`)).toBe(REDIGIDO);
      expect(em(s, `${p}awsRegion`)).toBe('xx-teste-1');
      expect(em(s, `${p}messageId`)).toBe('00000000-0000-4000-8000-000000000002');
      const corpo = JSON.parse(String(em(s, `${p}body`))) as unknown;
      expect(em(corpo, 'Payload.OrderChangeNotification.SellerId')).toBe(SELLER_ID_REDIGIDO);
      expect(em(corpo, 'Payload.OrderChangeNotification.OrderChangeTrigger.ChangeReason')).toBe(
        REDIGIDO,
      );
      expect(JSON.stringify(s)).not.toContain('Fulana');
      expect(JSON.stringify(s)).not.toContain('123456789012');
    },
  );

  it('★ awsRegion is kept in the log and FAKED in a fixture (the fixtures are public)', () => {
    const registro = registroSqs(JSON.stringify(notificacao()));
    expect(em(logJson(NOTIFICACAO_ORDER_CHANGE, 200, registro), 'awsRegion')).toBe('xx-teste-1');
    expect(em(fixtureJson(NOTIFICACAO_ORDER_CHANGE, 200, registro), 'awsRegion')).toBe(
      'xx-regiao-1',
    );
    expect(em(fixtureJson(NOTIFICACAO_ORDER_CHANGE, 200, [registro]), '0.awsRegion')).toBe(
      'xx-regiao-1',
    );
  });

  it('a body string that is not a JSON object is refused whole', () => {
    const s = logJson(NOTIFICACAO_ORDER_CHANGE, 200, registroSqs(`cpf ${CPF_PONTUADO}`));
    expect(em(s, 'body')).toBe(REDIGIDO);
  });

  it('near-miss: the same `body` key on an order path is NOT parsed (only the notification table nests)', () => {
    const s = logJson(GET_ORDER, 200, { body: JSON.stringify({ a: 1 }) });
    expect(em(s, 'body')).toBe(REDIGIDO);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Mechanics                                  */
/* -------------------------------------------------------------------------- */

describe('mechanics', () => {
  it('fixture idempotence: the profile run over its own output gives the same output', () => {
    const casos: readonly (readonly [string, number, unknown])[] = [
      [GET_ORDER, 200, getOrderBr()],
      [SEARCH, 200, searchOrdersBr()],
      [GET_ORDER, 400, { errors: [{ code: 'Nome', message: 'm', details: 'd' }], x: 0.5 }],
      [
        NOTIFICACAO_ORDER_CHANGE,
        200,
        {
          messageId: '00000000-0000-4000-8000-000000000002',
          awsRegion: 'xx-teste-1',
          body: JSON.stringify({ EventTime: '2020-01-11T00:09:53Z' }),
        },
      ],
    ];
    for (const [caminho, status, corpo] of casos) {
      const falsificador = falsificadorDeTeste();
      const um = redigirCorpo({ caminho, status, corpo: JSON.stringify(corpo) }, 'fixture', {
        falsificador,
      });
      if (!um.ok) throw new Error(um.motivo);
      const dois = redigirCorpo({ caminho, status, corpo: JSON.stringify(um.corpo) }, 'fixture', {
        falsificador,
      });
      if (!dois.ok) throw new Error(dois.motivo);
      expect(dois.corpo, caminho).toEqual(um.corpo);
    }
  });

  it('the fixture refusals', () => {
    expect(fixture(GET_ORDER, null, null)).toEqual({ ok: false, motivo: 'sem-resposta' });
    expect(fixture(RDT, 200, '{"restrictedDataToken":"x"}')).toEqual({
      ok: false,
      motivo: 'segredo',
    });
    expect(fixture(DESCONHECIDO, 200, '{}')).toEqual({ ok: false, motivo: 'sem-tabela' });
    expect(fixture('/easyShip/2022-03-23/timeSlot', 200, '{}')).toEqual({
      ok: false,
      motivo: 'sem-tabela',
    });
    expect(fixture(GET_ORDER, 200, '<html>')).toEqual({ ok: false, motivo: 'nao-json' });
    expect(fixture(GET_ORDER, 200, '"texto"')).toEqual({ ok: false, motivo: 'nao-json' });
    const fundo = `${'['.repeat(PROFUNDIDADE_MAXIMA_JSON + 1)}${']'.repeat(PROFUNDIDADE_MAXIMA_JSON + 1)}`;
    expect(fixture(GET_ORDER, 200, fundo)).toEqual({ ok: false, motivo: 'profundo-demais' });
    expect(fixture(GET_ORDER, 200, '')).toMatchObject({ ok: true, forma: 'vazio', corpo: null });
  });

  it('the log forms: segredo, empty, too big, too deep, text, scalar', () => {
    expect(log(RDT, 200, '{"restrictedDataToken":"x"}')).toMatchObject({
      politica: 'segredo',
      forma: null,
      trecho: null,
    });
    expect(log(GET_ORDER, 200, '')).toMatchObject({ forma: 'vazio', bytes: 0, trecho: null });
    expect(log(GET_ORDER, null, null)).toMatchObject({ forma: 'vazio', bytes: null, trecho: null });
    const grande = `{"a":"${'x'.repeat(LIMITE_ANALISE_BYTES.log)}"}`;
    expect(log(GET_ORDER, 200, grande)).toMatchObject({ forma: 'grande', trecho: null });
    const fundo = `${'['.repeat(PROFUNDIDADE_MAXIMA_JSON + 1)}${']'.repeat(PROFUNDIDADE_MAXIMA_JSON + 1)}`;
    expect(log(GET_ORDER, 200, fundo)).toMatchObject({ forma: 'profundo', trecho: null });
    // Near-miss: exactly 256 deep IS parsed (and redacted below the walker's cap).
    const limite = `${'['.repeat(PROFUNDIDADE_MAXIMA_JSON)}${']'.repeat(PROFUNDIDADE_MAXIMA_JSON)}`;
    expect(log(GET_ORDER, 200, limite).forma).toBe('json');
    expect(log(GET_ORDER, 200, '<html>Maria</html>')).toMatchObject({
      forma: 'texto',
      trecho: null,
    });
    expect(log(GET_ORDER, 200, '"Maria"')).toMatchObject({ forma: 'texto', trecho: null });
    expect(log(GET_ORDER, 200, '42')).toMatchObject({ forma: 'texto', trecho: null });
  });

  it('an unknown path keeps KEYS only in the log', () => {
    expect(logJson(DESCONHECIDO, 200, { status: 'OK', lista: [1, 'a'] })).toEqual({
      status: REDIGIDO,
      lista: [REDIGIDO, REDIGIDO],
    });
  });

  it('the walker stops at its own cap', () => {
    let v: unknown = 'fundo';
    for (let i = 0; i < PROFUNDIDADE_MAXIMA_PERCURSO + 5; i++) v = [v];
    const t = log(DESCONHECIDO, 200, JSON.stringify(v)).trecho ?? '';
    expect(t).toContain(REDIGIDO);
    expect(t).not.toContain('fundo');
  });

  it('cortarUtf8: on a code-point boundary; a 4-byte character is never split', () => {
    expect(cortarUtf8('abc', 3)).toEqual({ texto: 'abc', truncado: false });
    expect(cortarUtf8('abcd', 3)).toEqual({ texto: 'abc', truncado: true });
    expect(cortarUtf8('a😀', 4)).toEqual({ texto: 'a', truncado: true });
    expect(cortarUtf8('a😀', 5)).toEqual({ texto: 'a😀', truncado: false });
    expect(cortarUtf8('ãé', 3)).toEqual({ texto: 'ã', truncado: true });
    expect(bytesUtf8('a😀ã')).toBe(7);
    // A lone surrogate counts as U+FFFD: 3 bytes.
    expect(bytesUtf8('\ud800')).toBe(3);
  });

  it('profundidadeJson ignores brackets inside strings and stops past the limit', () => {
    expect(profundidadeJson('{"a":"[[[[{{{{"}')).toBe(1);
    expect(profundidadeJson('[[["\\"]"]]]')).toBe(3);
    expect(profundidadeJson('['.repeat(10_000), 256)).toBe(257);
  });

  it('placeholderDeDocumento: one placeholder per shape, every DV-bearing one valid', () => {
    expect(placeholderDeDocumento(CPF_PONTUADO)).toBe('000.000.001-91');
    expect(placeholderDeDocumento(CPF)).toBe('00000000191');
    expect(placeholderDeDocumento(pontuarCnpj(CNPJ))).toBe('11.222.333/0001-81');
    expect(placeholderDeDocumento(CNPJ)).toBe('11222333000181');
    expect(placeholderDeDocumento('12345678')).toBe('11222333');
    expect(placeholderDeDocumento(pontuarCnpj(CNPJ_LETRA))).toBe('12.ABC.345/01DE-35');
    expect(placeholderDeDocumento(CNPJ_LETRA)).toBe('12ABC34501DE35');
    expect(placeholderDeDocumento('1234567890')).toBe('0000000000');
    const d = PLACEHOLDERS_DOCUMENTO_AMAZON;
    for (const v of [d.cpfPontuado, d.cpf11]) expect(validateCPF(v), v).toBe(true);
    for (const v of [d.cnpjPontuado, d.cnpj14, d.cnpjAlfanumericoPontuado, d.cnpjAlfanumerico14]) {
      expect(validateCNPJ(v), v).toBe(true);
    }
    // Near-miss: a punctuated and a bare CNPJ map to DISTINCT placeholders.
    expect(placeholderDeDocumento(pontuarCnpj(CNPJ))).not.toBe(placeholderDeDocumento(CNPJ));
  });

  it('totality: the redactor never throws, in either profile, over the hostile bodies', () => {
    const hostis = [
      `{"a":"${'x'.repeat(LIMITE_ANALISE_BYTES.log)}"}`,
      '['.repeat(10_000) + ']'.repeat(10_000),
      '{"a":"\\ud800\\udfff\\ud800"}',
      '𐀀�',
      '{"n":1e400,"m":-0,"g":12345678901234567890}',
      '{"__proto__":{"x":1},"constructor":{"prototype":1}}',
      '"escalar"',
      '',
      'null',
      '[]',
      '{}',
    ];
    const caminhos = [
      GET_ORDER,
      SEARCH,
      RDT,
      DESCONHECIDO,
      NOTIFICACAO_ORDER_CHANGE,
      BULK,
      PACOTE,
      '',
      'x',
    ];
    for (const corpo of hostis) {
      for (const caminho of caminhos) {
        for (const status of [200, 204, 302, 400, 401, 404, 429, 500, null]) {
          expect(() => log(caminho, status, corpo)).not.toThrow();
          expect(() => fixture(caminho, status, corpo)).not.toThrow();
          expect(() => redigirCaminhoEQuery(caminho, [['%zz', '%E0%A4%A']], 'log')).not.toThrow();
        }
      }
    }
  });

  it('an own __proto__ key is just a key in the output', () => {
    const s = logJson(DESCONHECIDO, 200, JSON.parse('{"__proto__":{"x":1}}') as unknown);
    expect(Object.keys(s as object)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
  });

  it('every template is classified by its own path (anti-vacuity on the table)', () => {
    expect(classificarCaminho(GET_ORDER)).toMatchObject({
      politica: 'estrutural',
      modelo: 'getOrder',
    });
    expect(classificarCaminho(SEARCH).tabela).toBe(TABELAS_AMAZON.searchOrders);
    expect(classificarCaminho(RDT).politica).toBe('segredo');
    expect(classificarCaminho('/applications/2023-11-30/clientSecret').politica).toBe('segredo');
    expect(classificarCaminho('/reports/2021-06-30/documents/doc-1').politica).toBe('segredo');
    expect(classificarCaminho('/feeds/2021-06-30/documents').politica).toBe('segredo');
    expect(classificarCaminho('/feeds/2021-06-30/documents/doc-1').politica).toBe('segredo');
    expect(classificarCaminho(DESCONHECIDO)).toEqual({
      politica: 'estrutural',
      modelo: null,
      tabela: null,
    });
    expect(classificarCaminho(NOTIFICACAO_ORDER_CHANGE).tabela).toBe(TABELAS_AMAZON.orderChange);
  });
});

describe('the bulk REQUEST table (step 2b-b `.req.json`, fixture only)', () => {
  const corpo = JSON.stringify({
    marketplaceId: 'A2Q3Y263D00KWC',
    orderScheduleDetailsList: [
      {
        amazonOrderId: '123-4567890-1234567',
        packageDetails: {
          packageItems: [{ orderItemId: '12345678901234', orderItemSerialNumbers: ['S1'] }],
          packageTimeSlot: { slotId: 'SLOT1', endTime: '2026-10-20T12:00:00Z' },
          packageIdentifier: 'caixa-1',
        },
      },
    ],
    labelFormat: 'ZPL',
    observacao: 'texto livre',
  });

  it('keeps the allowed leaves, fakes the ids, redacts the denied keys and anything unnamed', () => {
    const r = redigirRequisicaoParaFixture(
      { caminho: BULK, metodo: 'POST', corpo },
      { falsificador: falsificadorDeTeste() },
    );
    if (!r.ok) throw new Error(r.motivo);
    expect(r.corpo).toEqual({
      marketplaceId: 'A2Q3Y263D00KWC',
      orderScheduleDetailsList: [
        {
          amazonOrderId: '000-0000000-0000001',
          packageDetails: {
            packageItems: [{ orderItemId: '00000000000002', orderItemSerialNumbers: ['REDACTED'] }],
            packageTimeSlot: { slotId: 'SLOT-Z00000003', endTime: '2026-10-20T12:00:00Z' },
            packageIdentifier: 'REDACTED',
          },
        },
      ],
      labelFormat: 'ZPL',
      observacao: 'REDACTED',
    });
    expect(r.mascarados).toBe(0);
  });

  it('near-miss: only a POST to a template with a request table; anything else is sem-tabela', () => {
    const f = { falsificador: falsificadorDeTeste() };
    expect(redigirRequisicaoParaFixture({ caminho: BULK, metodo: 'PUT', corpo }, f)).toEqual({
      ok: false,
      motivo: 'sem-tabela',
    });
    expect(redigirRequisicaoParaFixture({ caminho: PACOTE, metodo: 'POST', corpo }, f)).toEqual({
      ok: false,
      motivo: 'sem-tabela',
    });
    expect(redigirRequisicaoParaFixture({ caminho: BULK, metodo: 'POST', corpo: 'x' }, f)).toEqual({
      ok: false,
      motivo: 'nao-json',
    });
  });
});
