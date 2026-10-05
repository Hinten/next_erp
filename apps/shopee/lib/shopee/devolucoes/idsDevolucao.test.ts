import { describe, expect, it } from 'vitest';
import { RETURN_SN_SHOPEE_MAX } from '@delfrance/schemas';

import { PREFIXO_ID_INCIDENTE_DEVOLUCAO, idIncidenteDevolucaoShopee } from './idsDevolucao';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma delas é real.                               */
/* -------------------------------------------------------------------------- */

/** Digits-only fixture return_sn. */
const RETURN_SN = '2609100000000001';
/**
 * The ALPHANUMERIC fixture (#1525 R-0): the doc samples carry letters
 * (`2411280EDT4JRV5`), so a digits-only guard must turn THIS one red.
 */
const RETURN_SN_ALFA = '260910ABCDE0001';

describe('idIncidenteDevolucaoShopee', () => {
  it('é "shopee-devolucao-" + o return_sn, byte a byte (o id é chave — nunca reformatar)', () => {
    expect(PREFIXO_ID_INCIDENTE_DEVOLUCAO).toBe('shopee-devolucao-');
    expect(idIncidenteDevolucaoShopee(RETURN_SN)).toBe('shopee-devolucao-2609100000000001');
  });

  it('aceita o return_sn ALFANUMÉRICO — um guard só de dígitos fica vermelho aqui', () => {
    expect(idIncidenteDevolucaoShopee(RETURN_SN_ALFA)).toBe('shopee-devolucao-260910ABCDE0001');
  });

  it('aceita os dois extremos do formato: 1 e 64 caracteres', () => {
    expect(idIncidenteDevolucaoShopee('A')).toBe('shopee-devolucao-A');
    const maximo = 'Z'.repeat(RETURN_SN_SHOPEE_MAX);
    expect(idIncidenteDevolucaoShopee(maximo)).toBe(`shopee-devolucao-${maximo}`);
  });

  it('dois returns distintos dão dois ids distintos (a dobra não junta vizinhos)', () => {
    // Near-miss half: ids that differ in case, in one digit or by a prefix stay
    // DIFFERENT documents.
    const ids = [RETURN_SN, '2609100000000002', RETURN_SN_ALFA, '260910abcde0001', '26091'].map(
      idIncidenteDevolucaoShopee,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['vazio', ''],
    ['só espaço', ' '],
    ['com espaço à esquerda', ` ${RETURN_SN}`],
    ['com espaço à direita', `${RETURN_SN} `],
    ['com quebra de linha', `${RETURN_SN}\n`],
    ['com barra (forkaria o caminho)', '2609/100001'],
    ['com ponto', '2609.1'],
    ['só ponto-ponto', '..'],
    ['com dois-pontos', '2609:1'],
    ['com sublinhado (formaria __x__)', '__x__'],
    ['com hífen', '2609-1'],
    ['acentuado', 'DEVOLUÇÃO1'],
    ['65 caracteres', 'Z'.repeat(RETURN_SN_SHOPEE_MAX + 1)],
  ])('RECUSA (RangeError) um return_sn %s — recusa, nunca conserta', (_rotulo, bruto) => {
    expect(() => idIncidenteDevolucaoShopee(bruto)).toThrow(RangeError);
  });

  it('RECUSA um não-string vindo de um chamador sem tipo', () => {
    expect(() => idIncidenteDevolucaoShopee(2609100000000001 as unknown as string)).toThrow(
      RangeError,
    );
    expect(() => idIncidenteDevolucaoShopee(null as unknown as string)).toThrow(RangeError);
  });

  it('a mensagem nomeia o CAMPO e o comprimento, nunca o valor', () => {
    const intruso = 'VALOR/QUE/NAO/PODE/VAZAR';
    let mensagem = '';
    try {
      idIncidenteDevolucaoShopee(intruso);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      mensagem = err.message;
    }
    expect(mensagem).toContain('return_sn');
    expect(mensagem).toContain(String(intruso.length));
    expect(mensagem).not.toContain(intruso);
    expect(mensagem).not.toContain('VAZAR');
  });
});
