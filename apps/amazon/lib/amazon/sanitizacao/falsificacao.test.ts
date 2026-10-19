import { describe, expect, it } from 'vitest';

import { type ClasseFalsaAmazon, passaPredicadoAmazon, redigirCorpo } from '../core/redacao';
import { gerarCnpj, gerarCpf } from '../testing/documentos';
import { getOrderBr } from '../testing/sandboxBr';
import {
  FORMATO_FALSO_CHAVE_NFE,
  FORMATO_FALSO_POR_CLASSE,
  MAXIMO_DE_SORTEIOS,
  TAMANHO_DO_SAL,
  criarFalsificadorAmazon,
  dvDaChaveNfe,
  ehFalsoAmazon,
  falsoInaceitavel,
  falsoZeradoAmazon,
} from './falsificacao';
import { digitosVerificados } from '../fixtures/piiScan';

const SAL_A = new Uint8Array(TAMANHO_DO_SAL).fill(7);
const SAL_B = new Uint8Array(TAMANHO_DO_SAL).fill(9);

/** A raw value of each class, and the leaf predicate its fake must pass. */
const AMOSTRAS: readonly (readonly [
  ClasseFalsaAmazon,
  string,
  Parameters<typeof passaPredicadoAmazon>[0],
])[] = [
  ['pedido', '123-4567890-1234567', 'pedidoAmazon'],
  ['itemPedido', '12345678901234', 'itemPedido'],
  ['itemPedido', 'OIID34853450', 'itemPedido'],
  ['alias', 'PEDIDO-LOJA-0001', 'idDoVendedor'],
  ['pacote', '1ab0f06a-9149-87e0-aba9-7098117872d6', 'opaco'],
  ['asin', 'B012345678', 'asin'],
  ['sku', 'CAMISA-AZUL-G', 'sku'],
  ['rastreio', '1652969339691', 'rastreio'],
  ['chaveNfe', '1'.repeat(44), 'chaveNfe'],
  ['slot', 'AQc48yxSAAAAADZG0qQAAAAA6kkAAAAAAAA=', 'opaco'],
  ['promocao', 'PROMO-NATAL', 'idDoVendedor'],
  ['aplicacao', 'amzn1.sp.solution.12345678-1234-1234-1234-123456789012', 'idAplicacao'],
  ['assinatura', 'subscription-0001', 'opaco'],
  ['notificacao', '12345678-1234-1234-1234-123456789012', 'uuid'],
  ['mensagem', '12345678-1234-1234-1234-123456789012', 'uuid'],
  ['remessa', '1111111111111', 'opaco'],
  ['regiao', 'aa-leste-1', 'rotulo'],
];

describe('the keyed id faker', () => {
  it('the same value and salt give the same fake (joins hold across pairs and runs)', () => {
    const a = criarFalsificadorAmazon(SAL_A);
    const b = criarFalsificadorAmazon(SAL_A);
    for (const [classe, valor] of AMOSTRAS) expect(a(classe, valor)).toBe(b(classe, valor));
    expect(a('pedido', '123-4567890-1234567')).toBe(a('pedido', '123-4567890-1234567'));
  });

  it('near-miss: a different salt gives a different fake', () => {
    const a = criarFalsificadorAmazon(SAL_A);
    const b = criarFalsificadorAmazon(SAL_B);
    expect(a('pedido', '123-4567890-1234567')).not.toBe(b('pedido', '123-4567890-1234567'));
    expect(a('sku', 'CAMISA-AZUL-G')).not.toBe(b('sku', 'CAMISA-AZUL-G'));
  });

  it('near-miss: two values of one class get two fakes, and one value of two classes is keyed by class', () => {
    const f = criarFalsificadorAmazon(SAL_A);
    expect(f('sku', 'A')).not.toBe(f('sku', 'B'));
    expect(f('alias', 'X-1')).not.toBe(f('promocao', 'X-1').replace('PROMO', 'ALIAS'));
  });

  it.each(AMOSTRAS)(
    'every fake of %s matches its FORMATO_FALSO_*, passes its leaf predicate and is a fixpoint',
    (classe, valor, predicado) => {
      const f = criarFalsificadorAmazon(SAL_A);
      const falso = f(classe, valor);
      expect(falso).not.toBe(valor);
      expect(FORMATO_FALSO_POR_CLASSE[classe].test(falso)).toBe(true);
      expect(ehFalsoAmazon(classe, falso)).toBe(true);
      expect(passaPredicadoAmazon(predicado, falso)).toBe(true);
      // Fixpoint: a fake is returned unchanged, by this faker and by one under another salt.
      expect(f(classe, falso)).toBe(falso);
      expect(criarFalsificadorAmazon(SAL_B)(classe, falso)).toBe(falso);
    },
  );

  it('an order item id keeps its length (6 at least)', () => {
    const f = criarFalsificadorAmazon(SAL_A);
    expect(f('itemPedido', '12345678901234')).toHaveLength(14);
    expect(f('itemPedido', 'OIID34853450')).toHaveLength(12);
    expect(f('itemPedido', '12')).toHaveLength(6);
  });

  it('the fake chave NF-e is zero but for mod 55 and a keyed nNF, with a valid DV', () => {
    const chave = criarFalsificadorAmazon(SAL_A)('chaveNfe', '3'.repeat(44));
    expect(FORMATO_FALSO_CHAVE_NFE.test(chave)).toBe(true);
    expect(chave.slice(20, 22)).toBe('55');
    expect(Number(chave.charAt(43))).toBe(dvDaChaveNfe(chave.slice(0, 43)));
  });

  // About 0.5 s here; CI runs every workspace's suite at once and has taken 10×
  // that on a sibling matrix (#1985), so the timeout is headroom, not a budget.
  it(
    'no fake is ever DV-valid or trips the regex layer (property, 10k inputs over every class)',
    { timeout: 30_000 },
    () => {
      const f = criarFalsificadorAmazon(SAL_A);
      const classes = Object.keys(FORMATO_FALSO_POR_CLASSE) as ClasseFalsaAmazon[];
      let n = 0;
      for (let i = 0; i < 10_000; i++) {
        const classe = classes[i % classes.length] ?? 'pedido';
        const valor =
          classe === 'itemPedido' ? String(10_000_000_000_000 + i * 7919) : `v-${String(i)}`;
        const falso = f(classe, valor);
        expect(falsoInaceitavel(falso)).toBe(false);
        expect(digitosVerificados(falso)).toBeNull();
        n += 1;
      }
      expect(n).toBe(10_000);
    },
  );

  it('a candidate that IS a document is refused, and the all-zero fallback never is', () => {
    // DV-valid documents, made at run time (`documentos.ts`), never committed.
    expect(falsoInaceitavel(gerarCpf('529982247'))).toBe(true);
    expect(falsoInaceitavel(gerarCnpj('000001234567'))).toBe(true);
    expect(falsoInaceitavel(`SKU-${gerarCpf('529982247')}`)).toBe(true);
    for (const classe of Object.keys(FORMATO_FALSO_POR_CLASSE) as ClasseFalsaAmazon[]) {
      expect(falsoInaceitavel(falsoZeradoAmazon(classe, '12345678901234'))).toBe(false);
    }
    expect(MAXIMO_DE_SORTEIOS).toBeGreaterThan(8);
  });

  it('the profile with the keyed faker is idempotent: re-running over its own output changes nothing', () => {
    const f = criarFalsificadorAmazon(SAL_A);
    const caminho = '/orders/2026-01-01/orders/000-0000000-0000000';
    const um = redigirCorpo(
      { caminho, status: 200, corpo: JSON.stringify(getOrderBr()) },
      'fixture',
      { falsificador: f },
    );
    if (!um.ok) throw new Error('refused');
    const dois = redigirCorpo(
      { caminho, status: 200, corpo: JSON.stringify(um.corpo) },
      'fixture',
      { falsificador: criarFalsificadorAmazon(SAL_B) },
    );
    if (!dois.ok) throw new Error('refused');
    expect(JSON.stringify(dois.corpo)).toBe(JSON.stringify(um.corpo));
  });
});
