import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatarAchadosLi, piiScan } from './piiScan';
import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  LEIAME_WIRE_LI,
  NOME_DE_CAPTURA_LI,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
  serializarFixtureLi,
} from './wireCorpus';

/**
 * The floor that keeps the assertions below non-vacuous: the number of committed
 * fixtures, 18 since the owner's first captures (step 3) — the Mercado Livre
 * corpus test is the precedent. Those captures held 19 pairs; `pedido-enviado`
 * was a byte-identical duplicate of `pedido-boleto` (the same order requested
 * twice) and is not committed (`__wire__/README.md`).
 *
 * ⚠️ It equals the count on purpose, so a fixture that disappears fails here
 * instead of silently shrinking what the scan below covers. A change that adds
 * fixtures raises it, and one that deliberately removes a fixture lowers it, in
 * the same commit. Below it, "every fixture is valid and clean" holds of fewer
 * files than were reviewed.
 */
const MINIMO_DE_FIXTURES = 18;

describe('__wire__ corpus', () => {
  const arquivos = listarArquivosDoCorpusLi();

  it(`holds at least ${String(MINIMO_DE_FIXTURES)} fixture(s)`, () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(MINIMO_DE_FIXTURES);
  });

  it('every file is `<nome>.json`', () => {
    for (const arquivo of arquivos) {
      expect(
        arquivo.endsWith('.json') && NOME_DE_CAPTURA_LI.test(arquivo.slice(0, -5)),
        arquivo,
      ).toBe(true);
    }
  });

  // ⚠️ Only booleans and finding lists are asserted: a failure prints paths and
  // kinds, never a body value (`toEqual` on a body would print the body).
  it('every file is a valid envelope, serialised the one way, and passes both scanner layers', () => {
    const problemas: string[] = [];
    for (const arquivo of arquivos) {
      const texto = readFileSync(join(DIRETORIO_WIRE_LI, arquivo), 'utf8');
      const leitura = lerFixtureLi(texto);
      if (!leitura.ok) {
        problemas.push(`${arquivo} :: envelope-invalido`);
        continue;
      }
      if (serializarFixtureLi(leitura.data) !== texto) problemas.push(`${arquivo} :: serializacao`);
      problemas.push(...formatarAchadosLi(arquivo, piiScan(leitura.data)));
    }
    expect(problemas).toEqual([]);
  });

  it('the README is there and states the provenance', () => {
    const leiame = readFileSync(join(DIRETORIO_WIRE_LI, LEIAME_WIRE_LI), 'utf8');
    for (const trecho of [
      'captured by the store owner',
      'scripts/sanitizar.ts',
      'are fakes',
      'SKUs, order numeros, dates, quantities and prices are real',
      'MINIMO_DE_FIXTURES',
    ]) {
      expect(leiame, trecho).toContain(trecho);
    }
  });
});

describe('the envelope schema', () => {
  const VALIDO: EnvelopeFixtureLi = {
    versao: 1,
    perfil: 'fixture',
    credencial: 'personal-token',
    capturadoEm: '2026-10-07',
    requisicao: { metodo: 'GET', caminho: '/v1/situacao/', query: [['limit', '20']] },
    resposta: { status: 200, politica: 'configuracao', forma: 'json', bytes: 2, corpo: {} },
  };
  const texto = (v: unknown) => JSON.stringify(v);

  it('accepts a valid envelope, and keeps an own `__proto__` key in the body', () => {
    expect(lerFixtureLi(texto(VALIDO)).ok).toBe(true);
    const comProto = texto(VALIDO).replace('"corpo":{}', '"corpo":{"__proto__":{"x":1}}');
    const leitura = lerFixtureLi(comProto);
    expect(leitura.ok).toBe(true);
    if (leitura.ok) expect(Object.keys(leitura.data.resposta.corpo ?? {})).toEqual(['__proto__']);
  });

  it.each([
    ['an unknown credential', { ...VALIDO, credencial: 'outra' }],
    ['an extra top-level key', { ...VALIDO, alias: 'x' }],
    ['a time of day', { ...VALIDO, capturadoEm: '2026-10-07T10:00:00Z' }],
    ['the webhook class', { ...VALIDO, resposta: { ...VALIDO.resposta, politica: 'webhook' } }],
    ['an unparsed form', { ...VALIDO, resposta: { ...VALIDO.resposta, forma: 'nao-analisado' } }],
    ['a header', { ...VALIDO, requisicao: { ...VALIDO.requisicao, cabecalhos: {} } }],
  ])('refuses %s', (_caso, valor) => {
    expect(lerFixtureLi(texto(valor)).ok).toBe(false);
  });
});
