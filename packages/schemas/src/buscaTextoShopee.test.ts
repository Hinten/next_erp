import { describe, expect, it } from 'vitest';

import {
  correspondeABuscaShopee,
  dobrarTextoBuscaShopee,
  termosDaBuscaShopee,
} from './buscaTextoShopee';

const acha = (texto: string, consulta: string): boolean =>
  correspondeABuscaShopee([texto], termosDaBuscaShopee(consulta));

describe('dobrarTextoBuscaShopee', () => {
  it('drops accents, lowercases, collapses whitespace and trims', () => {
    expect(dobrarTextoBuscaShopee('  Calçados   e  ACESSÓRIOS ')).toBe('calcados e acessorios');
  });

  it('folds a DECOMPOSED accent the same as a precomposed one', () => {
    expect(dobrarTextoBuscaShopee('Calçados')).toBe(dobrarTextoBuscaShopee('Calçados'));
  });
});

describe('termosDaBuscaShopee', () => {
  it('splits a folded query into distinct words', () => {
    expect(termosDaBuscaShopee(' Camiseta  MASCULINA camiseta ')).toEqual([
      'camiseta',
      'masculina',
    ]);
  });

  it('a blank query has no terms', () => {
    expect(termosDaBuscaShopee('   ')).toEqual([]);
  });
});

describe('correspondeABuscaShopee', () => {
  it('EQUAL pair: case and accents fold away — `calcados` finds `Calçados`', () => {
    expect(acha('Calçados', 'calcados')).toBe(true);
    expect(acha('calcados', 'CALÇADOS')).toBe(true);
  });

  it('EQUAL pair: word order does not matter, and a word is a substring', () => {
    expect(acha('Camiseta Masculina', 'masculina cami')).toBe(true);
  });

  it('every term must match, each in ANY of the texts', () => {
    const termos = termosDaBuscaShopee('nike azul');
    expect(correspondeABuscaShopee(['Nike', 'Azul Marinho'], termos)).toBe(true);
    expect(correspondeABuscaShopee(['Nike', 'Vermelho'], termos)).toBe(false);
  });

  it('skips null texts and matches everything for an empty query', () => {
    expect(correspondeABuscaShopee([null, 'Nike'], termosDaBuscaShopee('nike'))).toBe(true);
    expect(correspondeABuscaShopee([null], [])).toBe(true);
    expect(correspondeABuscaShopee([null], termosDaBuscaShopee('nike'))).toBe(false);
  });

  it('⚠️ NEAR-MISS: punctuation and separators are NOT folded — `tshirt` does not find `T-Shirt`', () => {
    expect(acha('T-Shirt', 'tshirt')).toBe(false);
    expect(acha('TShirt', 't-shirt')).toBe(false);
  });

  it('⚠️ NEAR-MISS: a different letter is a different word — `calca` does not find `Calda`', () => {
    expect(acha('Calda', 'calca')).toBe(false);
    expect(acha('Calça', 'calda')).toBe(false);
  });
});
