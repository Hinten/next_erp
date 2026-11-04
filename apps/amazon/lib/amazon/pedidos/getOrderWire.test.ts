/**
 * The package's `getOrder` schema against the two FULL-shape BR `getOrder`
 * bodies this app holds: the committed sanitized fixture
 * (`fixtures/__wire__/sb-getorder-br.json`, the model's own example) and the
 * test transcription `getOrderBr()` (`testing/sandboxBr.ts`). The package's
 * own example is reduced (no buyer, recipient, alias or ASIN), so only here do
 * a real response's UNDECLARED leaves meet the schema: a `.strict()` order,
 * line, buyer or address would refuse every BR order, and park it, while every
 * package test stays green. Since PR 5-c1 the same check also runs over the
 * owner's captures C1 and C1b: eight REAL production bodies (sanitized) and one
 * `searchOrders` row.
 *
 * A test file, so the step-5 single-caller scan (production files only) never
 * reads it. No Amazon call (D11): no client and no `fetch`, only a parse.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  pedidoWireAmazonSchema,
  respostaGetOrderSchema,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';

import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import { getOrderBr } from '../testing/sandboxBr';

type Caminho = readonly (string | number)[];

/** A fixture's response body, through the envelope's own validated reader. */
function corpoDe(nome: string): unknown {
  const leitura = lerFixtureAmazon(readFileSync(join(DIRETORIO_WIRE_AMAZON, nome), 'utf8'));
  if (!leitura.ok) throw new Error(`${nome} não é um envelope válido`);
  return leitura.data.resposta.corpo;
}

const corpoDoFixture = (): unknown => corpoDe('sb-getorder-br.json');

/** The value at `caminho`, or `undefined`. */
function valorEm(dados: unknown, caminho: Caminho): unknown {
  return caminho.reduce<unknown>(
    (atual, chave) =>
      atual !== null && typeof atual === 'object'
        ? (atual as Record<string | number, unknown>)[chave]
        : undefined,
    dados,
  );
}

/**
 * Leaves a real BR `getOrder` carries and the schema never declares (the
 * package's `types.ts` lists why), one per object level that must stay loose.
 */
const NAO_DECLARADAS: readonly Caminho[] = [
  ['order', 'orderAliases'],
  ['order', 'buyer', 'buyerEmail'],
  ['order', 'recipient', 'deliveryAddress', 'phone'],
  ['order', 'recipient', 'deliveryAddress', 'addressLine2'],
  ['order', 'orderItems', 0, 'product', 'asin'],
  ['order', 'orderItems', 0, 'promotion'],
  ['order', 'orderItems', 0, 'fulfillment', 'packing'],
];

describe.each<[string, () => unknown]>([
  ['sb-getorder-br.json (the sanitized model example)', corpoDoFixture],
  ['getOrderBr() (the test transcription)', getOrderBr],
])('respostaGetOrderSchema over %s', (_nome, corpo) => {
  it('parses, and the parse IS the body: no key stripped, no value transformed', () => {
    const lida = respostaGetOrderSchema.safeParse(corpo());
    expect(lida.success).toBe(true);
    expect(lida.data).toStrictEqual(corpo());
  });

  it.each(NAO_DECLARADAS.map((c) => [c.join('.'), c] as const))(
    'the undeclared %s reads back verbatim (passthrough)',
    (_caminho, caminho) => {
      const original = valorEm(corpo(), caminho);
      // Anti-vacuity: the body really carries it.
      expect(original).toBeDefined();
      expect(valorEm(respostaGetOrderSchema.parse(corpo()), caminho)).toStrictEqual(original);
    },
  );
});

/**
 * The owner's captures C1 (PR 5-c1) and C1b (2026-11-03): eight REAL production
 * `getOrder` bodies, sanitized (ids faked by key, personal text redacted; every
 * structure, enum, date and amount real). The model's example cannot show what
 * production adds; these can: a refused real order would be parked, not imported.
 * Every read but one is SHIPPED or CANCELLED; `c1-pendente.json` is PENDING.
 */
const GET_ORDER_C1_ENVIADOS = [
  'c1-busca-mesmo-pedido.json',
  'c1-cancelado-depois.json',
  'c1-dba-e-transito.json',
  'c1-dba-f-entregue.json',
  'c1-devolvido.json',
  'c1-entregue-antigo.json',
  'c1-pix.json',
] as const;

/**
 * Undeclared leaves every real read carries, whatever its status (the package's
 * `types.ts` lists why each is unread).
 */
const NAO_DECLARADAS_C1: readonly Caminho[] = [
  ['order', 'proceeds', 'grandTotal'],
  ['order', 'salesChannel', 'marketplaceName'],
  ['order', 'fulfillment', 'fulfillmentServiceLevel'],
  ['order', 'orderItems', 0, 'product', 'asin'],
  ['order', 'orderItems', 0, 'product', 'condition'],
  ['order', 'orderItems', 0, 'proceeds', 'proceedsTotal'],
];

/**
 * Undeclared leaves only a SHIPPED or CANCELLED read carries: the PENDING one
 * has no package and no fulfillment order yet.
 */
const NAO_DECLARADAS_C1_ENVIADOS: readonly Caminho[] = [
  ['order', 'fulfillmentOrders'],
  ['order', 'packages', 0, 'carrier'],
  ['order', 'packages', 0, 'shippingService'],
  ['order', 'packages', 0, 'shipTime'],
];

/** Undeclared leaves only the PENDING read carries. */
const NAO_DECLARADAS_C1_PENDENTE: readonly Caminho[] = [
  ['order', 'fulfillment', 'labelPrintingWindow'],
];

const LEITURAS_REAIS: readonly (readonly [string, readonly Caminho[]])[] = [
  ...GET_ORDER_C1_ENVIADOS.map(
    (nome) => [nome, [...NAO_DECLARADAS_C1, ...NAO_DECLARADAS_C1_ENVIADOS]] as const,
  ),
  ['c1-pendente.json', [...NAO_DECLARADAS_C1, ...NAO_DECLARADAS_C1_PENDENTE]],
];

it('the per-status leaves are per status: the PENDING read carries none of the shipped-only ones, and no shipped read the PENDING-only one', () => {
  for (const c of NAO_DECLARADAS_C1_ENVIADOS) {
    expect(valorEm(corpoDe('c1-pendente.json'), c), c.join('.')).toBeUndefined();
  }
  for (const nome of GET_ORDER_C1_ENVIADOS) {
    for (const c of NAO_DECLARADAS_C1_PENDENTE) {
      expect(valorEm(corpoDe(nome), c), `${nome}: ${c.join('.')}`).toBeUndefined();
    }
  }
});

describe.each(LEITURAS_REAIS)(
  'respostaGetOrderSchema over the REAL %s (captures C1, C1b)',
  (nome, naoDeclaradas) => {
    const corpo = () => corpoDe(nome);

    it('parses, and the parse IS the body: no key stripped, no value transformed', () => {
      const lida = respostaGetOrderSchema.safeParse(corpo());
      expect(lida.success).toBe(true);
      expect(lida.data).toStrictEqual(corpo());
    });

    it.each(naoDeclaradas.map((c) => [c.join('.'), c] as const))(
      'the undeclared %s reads back verbatim (passthrough)',
      (_caminho, caminho) => {
        const original = valorEm(corpo(), caminho);
        // Anti-vacuity: the real body carries it.
        expect(original).toBeDefined();
        expect(valorEm(respostaGetOrderSchema.parse(corpo()), caminho)).toStrictEqual(original);
      },
    );

    it('every model-example undeclared leaf this real body carries reads back verbatim', () => {
      const presentes = NAO_DECLARADAS.filter((c) => valorEm(corpo(), c) !== undefined);
      // Anti-vacuity: at least the ASIN is on every real line.
      expect(presentes.map((c) => c.join('.'))).toContain('order.orderItems.0.product.asin');
      const lida = respostaGetOrderSchema.parse(corpo());
      for (const c of presentes) expect(valorEm(lida, c)).toStrictEqual(valorEm(corpo(), c));
    });
  },
);

it('the searchOrders row of the same order (c1-busca.json) is one more real order the order schema keeps whole', () => {
  const pagina = corpoDe('c1-busca.json') as { orders: unknown[] };
  expect(pagina.orders).toHaveLength(1);
  const lida = pedidoWireAmazonSchema.safeParse(pagina.orders[0]);
  expect(lida.success).toBe(true);
  expect(lida.data).toStrictEqual(pagina.orders[0]);
});
