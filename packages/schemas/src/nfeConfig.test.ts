import { describe, expect, it } from 'vitest';

import { ambienteNFEschema, nfeConfigMeta, nfeConfigSchema } from './nfeConfig';

const MINIMAL = {
  numeracao_atual: 0,
  serie: 1,
  idLote: 0,
  ambiente: '2' as const,
};

describe('nfeConfigSchema', () => {
  it('accepts a minimal valid NFeConfig (homologação seed)', () => {
    const out = nfeConfigSchema.parse(MINIMAL);
    expect(out).toMatchObject({
      numeracao_atual: 0,
      serie: 1,
      idLote: 0,
      ambiente: '2',
    });
  });

  it('rejects negative numeracao_atual', () => {
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, numeracao_atual: -1 }).success).toBe(false);
  });

  it('rejects non-integer numeracao_atual', () => {
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, numeracao_atual: 1.5 }).success).toBe(false);
  });

  it('rejects serie outside [0, 889]', () => {
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, serie: 999 }).success).toBe(false);
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, serie: -1 }).success).toBe(false);
  });

  it('rejects unknown ambiente', () => {
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, ambiente: '3' }).success).toBe(false);
  });

  it('coerces a legacy ISO timestamp to ms since epoch', () => {
    const out = nfeConfigSchema.parse({
      ...MINIMAL,
      timestamp: '2026-05-20T10:30:00Z',
    });
    expect(out.timestamp).toBe(new Date('2026-05-20T10:30:00Z').getTime());
  });
});

describe('ambienteNFEschema', () => {
  it('maps SEFAZ wire codes', () => {
    expect(ambienteNFEschema.parse('1')).toBe('1'); // produção
    expect(ambienteNFEschema.parse('2')).toBe('2'); // homologação
  });
});

describe('nfeConfigMeta', () => {
  it('targets the nfeconfig subcollection of filiais', () => {
    expect(nfeConfigMeta.collectionPath).toBe('filiais/{filialId}/nfeconfig');
  });

  it('uses the existing fiscal BigInt permission bits', () => {
    expect(nfeConfigMeta.permissions.read).toBe(1n << 72n);
    expect(nfeConfigMeta.permissions.write).toBe(1n << 73n);
    expect(nfeConfigMeta.permissions.delete).toBe(1n << 74n);
  });
});

describe('nfeConfigSchema — contingência', () => {
  it('defaults to modo none with null justificativa/dataInicio (legacy docs parse)', () => {
    const out = nfeConfigSchema.parse(MINIMAL);
    expect(out.contingencia_modo).toBe('none');
    expect(out.contingencia_justificativa).toBeNull();
    expect(out.contingencia_dataInicio).toBeNull();
  });

  it('accepts an active svc mode with justificativa + dataInicio', () => {
    const out = nfeConfigSchema.parse({
      ...MINIMAL,
      contingencia_modo: 'svc',
      contingencia_justificativa: 'SEFAZ indisponível desde as 08h',
      contingencia_dataInicio: '2026-06-10T08:00:00.000Z',
    });
    expect(out.contingencia_modo).toBe('svc');
  });

  it('rejects an active mode without justificativa or dataInicio', () => {
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, contingencia_modo: 'svc' }).success).toBe(false);
    expect(
      nfeConfigSchema.safeParse({
        ...MINIMAL,
        contingencia_modo: 'svc',
        contingencia_justificativa: 'SEFAZ indisponível desde as 08h',
      }).success,
    ).toBe(false);
  });

  it('rejects a justificativa shorter than 15 or longer than 255 chars', () => {
    expect(
      nfeConfigSchema.safeParse({
        ...MINIMAL,
        contingencia_modo: 'svc',
        contingencia_justificativa: 'curta',
        contingencia_dataInicio: '2026-06-10T08:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      nfeConfigSchema.safeParse({
        ...MINIMAL,
        contingencia_modo: 'svc',
        contingencia_justificativa: 'x'.repeat(256),
        contingencia_dataInicio: '2026-06-10T08:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown modo', () => {
    expect(nfeConfigSchema.safeParse({ ...MINIMAL, contingencia_modo: 'scan' }).success).toBe(
      false,
    );
  });
});
