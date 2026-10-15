import { describe, expect, it } from 'vitest';
import { inutNumeracaoSchema, inutNumeracaoMeta } from './inutilizacaoNumeracao';

const MINIMAL = {
  serie: 1,
  nNFIni: 5,
  nNFFin: 12,
  xJust: 'Inutilizacao de faixa nao utilizada',
  xml_enviado: null,
  xml_retorno: null,
  cStat: null,
  xMotivo: null,
  nProt: null,
  error: null,
};

describe('inutNumeracaoSchema', () => {
  it('parses a minimal record and defaults estado to iniciado', () => {
    const out = inutNumeracaoSchema.parse(MINIMAL);
    expect(out.estado).toBe('0'); // EstadoEnviNFeMsg.iniciado
    expect(out.nNFIni).toBe(5);
    expect(out.nNFFin).toBe(12);
  });

  it('requires xJust to be at least 15 chars (SEFAZ rule)', () => {
    expect(inutNumeracaoSchema.safeParse({ ...MINIMAL, xJust: 'curto' }).success).toBe(false);
  });

  it('accepts a homologada record with cStat / xMotivo / nProt', () => {
    const out = inutNumeracaoSchema.parse({
      ...MINIMAL,
      cStat: '102',
      xMotivo: 'Inutilizacao de numero homologada',
      nProt: '135200000088888',
      estado: '3', // concluido
    });
    expect(out.cStat).toBe('102');
    expect(out.nProt).toBe('135200000088888');
    expect(out.estado).toBe('3');
  });

  it('keeps a 17-digit nProt and a 4-digit cStat as-is (NT 2025.002 §5.1, #329)', () => {
    const out = inutNumeracaoSchema.parse({
      ...MINIMAL,
      cStat: '1115',
      nProt: '13526000000012345',
    });
    expect(out.cStat).toBe('1115');
    expect(out.nProt).toBe('13526000000012345');
  });

  it('targets the per-filial inutilizacao subcollection', () => {
    expect(inutNumeracaoMeta.collectionPath).toBe('filiais/{filialId}/inutilizacao');
  });
});
