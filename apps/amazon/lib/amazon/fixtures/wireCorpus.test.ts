import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NOME_DE_CAPTURA_AMAZON, tiposDoNomeAmazon } from '../sanitizacao/lote';
import { formatarAchadosAmazon, piiScan } from './piiScan';
import {
  DIRETORIO_WIRE_AMAZON,
  type EnvelopeFixtureAmazon,
  LEIAME_WIRE_AMAZON,
  ehValorJson,
  lerFixtureAmazon,
  listarArquivosDoCorpusAmazon,
  serializarFixtureAmazon,
} from './wireCorpus';

/**
 * The floor that keeps the assertions below non-vacuous: the number of committed
 * fixtures — 6, the model-sandbox seed (step 2b).
 *
 * ⚠️ It equals the count on purpose, so a fixture that disappears fails here
 * instead of silently shrinking what the scan below covers. A change that adds
 * fixtures raises it, and one that deliberately removes a fixture lowers it, in
 * the same commit.
 */
const MINIMO_DE_FIXTURES = 14;

describe('__wire__ corpus', () => {
  const arquivos = listarArquivosDoCorpusAmazon();

  it(`holds at least ${String(MINIMO_DE_FIXTURES)} fixture(s)`, () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(MINIMO_DE_FIXTURES);
  });

  it('only `<nome>.json` and README.md sit in __wire__ (a leftover .tmp fails)', () => {
    for (const arquivo of arquivos) {
      const nome = arquivo.endsWith('.json') ? arquivo.slice(0, -'.json'.length) : null;
      expect(nome !== null && NOME_DE_CAPTURA_AMAZON.test(nome), arquivo).toBe(true);
    }
  });

  // A file name is public too, and no scanner layer reads it: a hand-placed
  // fixture named after an order id or a phone fails here.
  it('every fixture NAME trips nothing (no id, no document, no digit run)', () => {
    for (const arquivo of arquivos) {
      expect(tiposDoNomeAmazon(arquivo.replace(/\.json$/, ''), null), arquivo).toEqual([]);
    }
  });

  // Only booleans and finding lists are asserted: a failure never prints a body.
  it.each(listarArquivosDoCorpusAmazon())(
    '%s is a valid envelope, serialised the one way, clean under both layers',
    (arquivo) => {
      const texto = readFileSync(join(DIRETORIO_WIRE_AMAZON, arquivo), 'utf8');
      const leitura = lerFixtureAmazon(texto);
      expect(leitura.ok).toBe(true);
      if (!leitura.ok) return;
      const envelope: EnvelopeFixtureAmazon = leitura.data;
      expect(serializarFixtureAmazon(envelope) === texto).toBe(true);
      expect(formatarAchadosAmazon(arquivo, piiScan(envelope))).toEqual([]);
    },
  );

  it('the README carries its provenance phrases', () => {
    const leiame = readFileSync(join(DIRETORIO_WIRE_AMAZON, LEIAME_WIRE_AMAZON), 'utf8');
    for (const frase of [
      'written by\n`scripts/sanitizar.ts` and by nothing else',
      'never edited by hand',
      'No code in this repository calls Amazon before the cutover',
      'model-sandbox examples',
      'Dates, quantities, money',
      '`MINIMO_DE_FIXTURES`',
    ]) {
      expect(leiame.includes(frase), frase).toBe(true);
    }
  });
});

describe('the envelope reader', () => {
  const base = {
    versao: 1,
    perfil: 'fixture',
    credencial: 'modelo-sandbox',
    papeis: ['nao-se-aplica'],
    capturadoEm: '2026-10-19',
    limiteTaxa: null,
    requisicao: { tipo: 'http', metodo: 'GET', caminho: '/x', query: [], corpo: null },
    resposta: { status: 200, politica: 'estrutural', forma: 'json', bytes: 2, corpo: {} },
    anexos: { zip: null },
  };

  it('★ an own __proto__ in a body survives the reader (no zod record copies it away)', () => {
    const texto = JSON.stringify(base).replace('"corpo":{}', '"corpo":{"__proto__":{"x":"y"}}');
    const leitura = lerFixtureAmazon(texto);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const corpo = leitura.data.resposta.corpo as object;
    expect(Object.hasOwn(corpo, '__proto__')).toBe(true);
    expect(ehValorJson(JSON.parse('{"__proto__":1}'))).toBe(true);
  });

  it('refuses an unknown key, a host-bearing field, a status on a notification', () => {
    expect(lerFixtureAmazon(JSON.stringify({ ...base, host: 'x' })).ok).toBe(false);
    expect(
      lerFixtureAmazon(
        JSON.stringify({
          ...base,
          requisicao: { tipo: 'notificacao', notificacao: 'ORDER_CHANGE', transporte: 'sqs' },
        }),
      ).ok,
    ).toBe(false);
    expect(
      lerFixtureAmazon(
        JSON.stringify({
          ...base,
          requisicao: { tipo: 'notificacao', notificacao: 'ORDER_CHANGE', transporte: 'sqs' },
          resposta: { ...base.resposta, status: null },
        }),
      ).ok,
    ).toBe(true);
  });

  it('ehValorJson refuses what JSON cannot hold', () => {
    expect(ehValorJson(Number.NaN)).toBe(false);
    expect(ehValorJson({ a: undefined })).toBe(false);
    expect(ehValorJson([1, 'a', null, { b: true }])).toBe(true);
  });
});
