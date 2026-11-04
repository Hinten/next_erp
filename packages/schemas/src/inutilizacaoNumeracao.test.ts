import { describe, expect, it } from 'vitest';
import { ufSchema, UF_SIGLA } from './endereco';
import {
  inutilizacaoSeAplica,
  inutNumeracaoSchema,
  inutNumeracaoMeta,
  motivoInutilizacaoNaoSeAplica,
} from './inutilizacaoNumeracao';

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

describe('inutilizacaoSeAplica (Ajuste SINIEF nº 40/2026)', () => {
  // 00:00 of 01/11/2026 in each UF's legal time.
  const SP_BA_VIGENCIA = Date.UTC(2026, 10, 1, 3); // −03:00
  const AC_VIGENCIA = Date.UTC(2026, 10, 1, 5); // −05:00
  const MUITO_DEPOIS = Date.UTC(2030, 0, 1);

  it('SP: still applies at 31/10 23:59:59.999 local, no longer at 01/11 00:00 local', () => {
    expect(inutilizacaoSeAplica(UF_SIGLA.SP, SP_BA_VIGENCIA - 1)).toBe(true);
    expect(inutilizacaoSeAplica(UF_SIGLA.SP, SP_BA_VIGENCIA)).toBe(false);
  });

  it('SP: a UTC-midnight instant (21:00 of 31/10 in SP) is still on the old side', () => {
    expect(inutilizacaoSeAplica(UF_SIGLA.SP, Date.UTC(2026, 10, 1, 0))).toBe(true);
  });

  it('BA follows the same −03:00 boundary', () => {
    expect(inutilizacaoSeAplica(UF_SIGLA.BA, SP_BA_VIGENCIA - 1)).toBe(true);
    expect(inutilizacaoSeAplica(UF_SIGLA.BA, SP_BA_VIGENCIA)).toBe(false);
  });

  it('AC switches at its own −05:00 midnight, two hours after SP', () => {
    expect(inutilizacaoSeAplica(UF_SIGLA.AC, SP_BA_VIGENCIA)).toBe(true);
    expect(inutilizacaoSeAplica(UF_SIGLA.AC, AC_VIGENCIA - 1)).toBe(true);
    expect(inutilizacaoSeAplica(UF_SIGLA.AC, AC_VIGENCIA)).toBe(false);
  });

  it('a UF outside the Ajuste keeps the pedido, long after the date', () => {
    expect(inutilizacaoSeAplica(UF_SIGLA.MG, MUITO_DEPOIS)).toBe(true);
    expect(inutilizacaoSeAplica(UF_SIGLA.EX, MUITO_DEPOIS)).toBe(true);
  });

  it('after the date, exactly AC, BA and SP lose it', () => {
    const sem = ufSchema.options.filter((uf) => !inutilizacaoSeAplica(uf, MUITO_DEPOIS));
    expect(sem).toEqual([UF_SIGLA.AC, UF_SIGLA.BA, UF_SIGLA.SP]);
  });

  it('before the date, every UF still has it', () => {
    expect(ufSchema.options.every((uf) => inutilizacaoSeAplica(uf, SP_BA_VIGENCIA - 1))).toBe(true);
  });

  it('the motivo names the Ajuste, the state and the date', () => {
    const motivo = motivoInutilizacaoNaoSeAplica(UF_SIGLA.SP);
    expect(motivo).toContain('Ajuste SINIEF nº 40/2026');
    expect(motivo).toContain('de São Paulo');
    expect(motivo).toContain('01/11/2026');
  });
});
