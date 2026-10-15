/**
 * The two Shopee refusal folds (`core/recusaShopee.ts`, promoted out of step
 * 14's `nfe/classificarNfe.ts` for step 15, #1523).
 *
 * Each fold decides whether two Shopee texts are "the same" for a refusal
 * table, so every case names a PAIR (must fold equal) and a NEAR-MISS (must
 * stay distinct) — root `CLAUDE.md`'s fold-scope rule (#1372): a test that a
 * fold APPLIES cannot show where it STOPS.
 *
 * ⚠️ The codes and sentences are Shopee's documented ones; no real identifier
 * appears here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { codigoCanonicoShopee, fraseCanonicaShopee } from './recusaShopee';

/* ------------------------------- o código ---------------------------------- */

describe('codigoCanonicoShopee — apara, tira UM segmento de módulo, apara de novo', () => {
  it.each<[string, string, string]>([
    [
      'o TAB que a página da api imprime depois do código',
      'order.upload_invoice_error\t',
      'upload_invoice_error',
    ],
    ['um espaço À FRENTE', ' logistics.package_already_shipped', 'package_already_shipped'],
    ['um TAB À FRENTE', '\tlogistics.package_already_shipped', 'package_already_shipped'],
    ['o código já sem módulo', 'package_already_shipped', 'package_already_shipped'],
    ['o código sem módulo, com espaços nas pontas', '  error_param  ', 'error_param'],
    // The SECOND trim: a blank between the dot and the code falls only after the strip.
    ['um branco DEPOIS do segmento', 'order. upload_invoice_error', 'upload_invoice_error'],
  ])('PAR: %s dobra para o código nu', (_rotulo, bruto, esperado) => {
    expect(codigoCanonicoShopee(bruto)).toBe(esperado);
  });

  it('PAR: o espaço e o TAB à frente dobram para o MESMO código que a grafia limpa', () => {
    const limpo = codigoCanonicoShopee('logistics.package_already_shipped');
    expect(codigoCanonicoShopee(' logistics.package_already_shipped')).toBe(limpo);
    expect(codigoCanonicoShopee('\tlogistics.package_already_shipped')).toBe(limpo);
    expect(limpo).toBe('package_already_shipped');
  });

  it('PAR (de propósito): o módulo some — `order.` e `logistics.` dão o mesmo código nu', () => {
    // The tables are keyed on the module-less code; which module answered does
    // not change the row. That is the fold's declared scope, not an accident.
    expect(codigoCanonicoShopee('logistics.error_param')).toBe(
      codigoCanonicoShopee('order.error_param'),
    );
  });

  it.each<[string, string, string]>([
    // Exactly ONE segment: a greedy strip would make any code that merely ENDS
    // in a known one match it.
    ['DOIS segmentos: o segundo fica', 'a.b.source_ip_undeclared', 'b.source_ip_undeclared'],
    ['só o prefixo: nunca vira vazio', 'logistics.', 'logistics.'],
    [
      'módulo com MAIÚSCULA: não é um segmento de módulo',
      'Logistics.error_param',
      'Logistics.error_param',
    ],
    ['a caixa do código é mantida', 'Error_Param', 'Error_Param'],
  ])('QUASE-MISS: %s', (_rotulo, bruto, esperado) => {
    expect(codigoCanonicoShopee(bruto)).toBe(esperado);
  });

  it('QUASE-MISS: um segmento de módulo a MAIS continua distinto do código nu', () => {
    expect(codigoCanonicoShopee('a.b.source_ip_undeclared')).not.toBe('source_ip_undeclared');
    expect(codigoCanonicoShopee('logistics.order.package_already_shipped')).not.toBe(
      codigoCanonicoShopee('logistics.package_already_shipped'),
    );
  });

  it('QUASE-MISS: um código DIFERENTE sob o mesmo módulo continua diferente', () => {
    expect(codigoCanonicoShopee('logistics.package_already_shipped')).not.toBe(
      codigoCanonicoShopee('logistics.package_can_not_print'),
    );
  });
});

/* ------------------------------- a frase ----------------------------------- */

describe('fraseCanonicaShopee — a frase como as agulhas a leem', () => {
  it('`null` ⇒ `""`, que nenhuma agulha casa; vazio e só-branco também', () => {
    expect(fraseCanonicaShopee(null)).toBe('');
    expect(fraseCanonicaShopee('')).toBe('');
    expect(fraseCanonicaShopee(' \t\n ')).toBe('');
  });

  it.each<[string, string, string]>([
    [
      'o prefixo do envelope, os dois pontos finais do guia 382',
      'Wrong parameters, detail: Invalid CNPJ..',
      'invalid cnpj',
    ],
    ['o prefixo em MAIÚSCULAS', 'WRONG PARAMETERS, DETAIL: Invalid CNPJ.', 'invalid cnpj'],
    [
      'brancos repetidos DENTRO do prefixo (colapsados antes da tira)',
      'Wrong parameters,\t\tdetail:   Invalid CNPJ',
      'invalid cnpj',
    ],
    [
      'um espaço e um TAB ANTES do prefixo (aparados antes da tira)',
      ' \tWrong parameters, detail: Invalid CNPJ.',
      'invalid cnpj',
    ],
    ['brancos repetidos no meio da frase', 'Invalid\t\tCNPJ', 'invalid cnpj'],
    ['pontos e brancos no fim, misturados', 'Invalid CNPJ. . .', 'invalid cnpj'],
    [
      'a frase do `get_shipping_parameter`, com o mesmo molde',
      'Wrong parameters, detail: The package has been shipped.',
      'the package has been shipped',
    ],
  ])('PAR: %s', (_rotulo, bruto, esperado) => {
    expect(fraseCanonicaShopee(bruto)).toBe(esperado);
  });

  it('PAR: com e sem o prefixo, a mesma frase dobra igual', () => {
    expect(fraseCanonicaShopee('Wrong parameters, detail: Invalid CNPJ..')).toBe(
      fraseCanonicaShopee('invalid cnpj'),
    );
  });

  it.each<[string, string, string]>([
    [
      'o prefixo no MEIO da frase fica',
      'Error: Wrong parameters, detail: Invalid CNPJ',
      'error: wrong parameters, detail: invalid cnpj',
    ],
    [
      'o prefixo no SINGULAR não é o do envelope',
      'Wrong parameter, detail: Invalid CNPJ',
      'wrong parameter, detail: invalid cnpj',
    ],
    ['o hífen do meio fica (`nf-e` ≠ `nfe`)', 'Invalid NF-e model.', 'invalid nf-e model'],
    [
      'o ponto do MEIO fica; só o do fim cai',
      'Only model 55. Try again.',
      'only model 55. try again',
    ],
  ])('QUASE-MISS: %s', (_rotulo, bruto, esperado) => {
    expect(fraseCanonicaShopee(bruto)).toBe(esperado);
  });

  it('QUASE-MISS: a pontuação interna mantém distintas frases que só ela separa', () => {
    expect(fraseCanonicaShopee('Invalid NF-e.')).not.toBe(fraseCanonicaShopee('Invalid NFe.'));
    expect(fraseCanonicaShopee('Error: Wrong parameters, detail: x')).not.toBe(
      fraseCanonicaShopee('x'),
    );
  });
});

/* ----------------------------- uma cópia só -------------------------------- */

describe('uma cópia só: o classificador da NF-e importa as dobras, não as redeclara', () => {
  const fonte = readFileSync(new URL('../nfe/classificarNfe.ts', import.meta.url), 'utf8');

  it('importa as duas dobras deste módulo', () => {
    expect(fonte).toMatch(
      /import \{ codigoCanonicoShopee, fraseCanonicaShopee \} from '\.\.\/core\/recusaShopee';/,
    );
    expect(fonte).toContain('codigoCanonicoShopee(err.code)');
    expect(fonte).toContain('fraseCanonicaShopee(err.providerMessage)');
  });

  it('não guarda as cópias privadas nem a regex do prefixo, nem chama a tira do pacote', () => {
    expect(fonte).not.toMatch(/function (codigoDaRecusa|detalheDaRecusa)\b/);
    expect(fonte).not.toMatch(/\/\^wrong parameters/i);
    expect(fonte).not.toContain('shopeeCodeSemPrefixoDeModulo(');
  });
});
