import { describe, expect, it } from 'vitest';
import {
  ESTADO_ENVI_NFE_MSG,
  enviNfeMsgMeta,
  enviNfeMsgSchema,
  estadoEnviNFeMsgSchema,
} from './enviNfeMsg';

const VALID_CHAVE = '35260514200166000187550010000000071000000018';

describe('enviNfeMsgSchema', () => {
  it('round-trips a typical lote-respondido message', () => {
    const input = {
      targetsChnfe: [VALID_CHAVE],
      idLote: 7,
      indSinc: '1' as const,
      xml_enviado: '<NFe>…</NFe>',
      xml_retorno: '{"cStat":"103"}',
      nRec: '351000000000123',
      cStat: '103',
      xMotivo: 'Lote recebido com sucesso',
      error: null,
      tpEmis: 1,
      estado: ESTADO_ENVI_NFE_MSG.respondido,
      timestamp: '2026-05-20T10:30:00.000Z',
      ultima_modificacao: '2026-05-20T10:30:00.000Z',
    };
    const parsed = enviNfeMsgSchema.parse(input);
    expect(parsed.targetsChnfe).toEqual([VALID_CHAVE]);
    expect(parsed.estado).toBe('2');
    expect(parsed.nRec).toBe('351000000000123');
  });

  it('round-trips a consulta message (no idLote, no xml_enviado)', () => {
    const parsed = enviNfeMsgSchema.parse({
      targetsChnfe: [VALID_CHAVE],
      idLote: null,
      indSinc: null,
      xml_enviado: null,
      xml_retorno: '{"cStat":"100"}',
      nRec: '351000000000123',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      error: null,
      tpEmis: 1,
      estado: ESTADO_ENVI_NFE_MSG.concluido,
    });
    expect(parsed.idLote).toBeNull();
    expect(parsed.estado).toBe('3');
  });

  it('rejects a chave that is not 44 chars', () => {
    expect(() =>
      enviNfeMsgSchema.parse({
        targetsChnfe: ['too-short'],
        idLote: null,
        indSinc: null,
        xml_enviado: null,
        xml_retorno: null,
        nRec: null,
        cStat: null,
        xMotivo: null,
        error: null,
        tpEmis: null,
      }),
    ).toThrow();
  });

  it.each(['e', '0', '1', '2', '3', '4', 't', 'i', 'a', 'c', 'n'] as const)(
    'accepts EstadoEnviNFeMsg wire value "%s"',
    (value) => {
      expect(estadoEnviNFeMsgSchema.parse(value)).toBe(value);
    },
  );

  it('exposes the Phase A subset on ESTADO_ENVI_NFE_MSG', () => {
    expect(ESTADO_ENVI_NFE_MSG.respondido).toBe('2');
    expect(ESTADO_ENVI_NFE_MSG.concluido).toBe('3');
    expect(ESTADO_ENVI_NFE_MSG.error).toBe('e');
  });

  it('declares the per-Filial subcollection path', () => {
    expect(enviNfeMsgMeta.collectionPath).toBe('filiais/{filialId}/enviNfe');
  });
});
