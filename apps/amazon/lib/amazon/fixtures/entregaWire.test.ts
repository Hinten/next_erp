/**
 * The package's Delivery schemas (`entrega.ts`, step 14) against the committed
 * Delivery bodies this app holds: the owner's one real status read (capture
 * C2, `c2-status-aceita.json`) and the model's sandbox examples, made by the
 * sanitizer (`sb-invoice-status*.json`, `sb-submit-invoice-*.json`). The
 * package cannot read this folder, so its tests parse hand copies of these
 * bodies; only here do the committed fixtures themselves meet the schemas, so a
 * copy, a fixture and a schema cannot drift apart unseen.
 *
 * Schemas only: no client, no Delivery helper and no `fetch` (D11) — nothing
 * here calls, or could call, Amazon.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  respostaEnvioNotaFiscalSchema,
  respostaStatusNotaFiscalSchema,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';

import { DIRETORIO_WIRE_AMAZON, type EnvelopeFixtureAmazon, lerFixtureAmazon } from './wireCorpus';

const CAMINHO_STATUS = '/delivery/2022-07-01/invoice/status';
const CAMINHO_ENVIO = '/delivery/2022-07-01/invoice';

/** A fixture, through the envelope's own validated reader. */
function envelopeDe(nome: string): EnvelopeFixtureAmazon {
  const leitura = lerFixtureAmazon(readFileSync(join(DIRETORIO_WIRE_AMAZON, nome), 'utf8'));
  if (!leitura.ok) throw new Error(`${nome} não é um envelope válido`);
  return leitura.data;
}

/** The request's method and path; a notification has neither. */
function rotaDe(e: EnvelopeFixtureAmazon): readonly [string, string] | null {
  return e.requisicao.tipo === 'http' ? [e.requisicao.metodo, e.requisicao.caminho] : null;
}

describe.each([
  ['c2-status-aceita.json', 'capture C2, sanitized'],
  ['sb-invoice-status.json', 'the model example'],
])('respostaStatusNotaFiscalSchema over %s (%s)', (nome) => {
  it('is a getInvoiceStatus 200 that parses, and the parse IS the body: no key stripped', () => {
    const e = envelopeDe(nome);
    expect(rotaDe(e)).toEqual(['GET', CAMINHO_STATUS]);
    expect(e.resposta.status).toBe(200);
    const lida = respostaStatusNotaFiscalSchema.safeParse(e.resposta.corpo);
    expect(lida.success).toBe(true);
    expect(lida.data).toStrictEqual(e.resposta.corpo);
    // Anti-vacuity: a real body, with the invoice rows the app reads.
    expect(lida.data?.invoices?.length).toBeGreaterThan(0);
  });
});

describe('respostaEnvioNotaFiscalSchema over sb-submit-invoice-200.json (the model example)', () => {
  it('is a submitInvoice 2xx that parses, and the parse IS the body', () => {
    const e = envelopeDe('sb-submit-invoice-200.json');
    expect(rotaDe(e)).toEqual(['POST', CAMINHO_ENVIO]);
    expect(e.resposta.status).toBe(200);
    const lida = respostaEnvioNotaFiscalSchema.safeParse(e.resposta.corpo);
    expect(lida.success).toBe(true);
    expect(lida.data).toStrictEqual(e.resposta.corpo);
  });
});

describe.each([
  ['sb-invoice-status-400.json', 'GET', CAMINHO_STATUS, 'InvalidInput'],
  ['sb-submit-invoice-400.json', 'POST', CAMINHO_ENVIO, 'EntityNotFound'],
])('the 400 model example %s', (nome, metodo, caminho, codigo) => {
  it(`carries exactly the code the package's error reads (${codigo}), the sanitizer kept it`, () => {
    const e = envelopeDe(nome);
    expect(rotaDe(e)).toEqual([metodo, caminho]);
    expect(e.resposta.status).toBe(400);
    // The package's tests feed this same code to `codigosErro` from a hand
    // copy; 14-c keys the submit's `EntityNotFound` on it.
    const corpo = e.resposta.corpo as { errors?: readonly { code?: unknown }[] } | null;
    expect(corpo?.errors?.map((x) => x.code)).toEqual([codigo]);
  });
});
