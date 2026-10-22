/**
 * The package's `getOrder` schema against the two FULL-shape BR `getOrder`
 * bodies this app holds: the committed sanitized fixture
 * (`fixtures/__wire__/sb-getorder-br.json`, the model's own example) and the
 * test transcription `getOrderBr()` (`testing/sandboxBr.ts`). The package's
 * own example is reduced (no buyer, recipient, alias or ASIN), so only here do
 * a real response's UNDECLARED leaves meet the schema: a `.strict()` order,
 * line, buyer or address would refuse every BR order, and park it, while every
 * package test stays green.
 *
 * A test file, so the step-5 single-caller scan (production files only) never
 * reads it. No Amazon call (D11): no client and no `fetch`, only a parse.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { respostaGetOrderSchema } from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';

import { DIRETORIO_WIRE_AMAZON, lerFixtureAmazon } from '../fixtures/wireCorpus';
import { getOrderBr } from '../testing/sandboxBr';

type Caminho = readonly (string | number)[];

/** The fixture's response body, through the envelope's own validated reader. */
function corpoDoFixture(): unknown {
  const leitura = lerFixtureAmazon(
    readFileSync(join(DIRETORIO_WIRE_AMAZON, 'sb-getorder-br.json'), 'utf8'),
  );
  if (!leitura.ok) throw new Error('sb-getorder-br.json não é um envelope válido');
  return leitura.data.resposta.corpo;
}

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
