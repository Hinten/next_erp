import { describe, it, expect } from 'vitest';
import { ESTADO_NFE } from '@delfrance/schemas';
import {
  classifyRecovery,
  DEFAULT_STUCK_TIMEOUT_MS,
  extractMarkers,
  isStuckEnviando,
  outcomeFromInfProt,
  outcomeFromRetConsRec,
  outcomeFromRetConsSit,
  outcomeFromRetEnviNFe,
  RE_CHNFE,
  RE_NREC,
} from '../../src/recovery/index';

const CHAVE = '35200714200166000187550010000000071000000017';

// ---------------------------------------------------------------------------
// Marker extraction
// ---------------------------------------------------------------------------

describe('extractMarkers', () => {
  it('pulls nRec out of a 204 xMotivo', () => {
    const { nRec, chNFe } = extractMarkers(
      'Rejeição: Duplicidade de NF-e [nRec:351000000000123]',
    );
    expect(nRec).toBe('351000000000123');
    expect(chNFe).toBeNull();
  });

  it('pulls both nRec and chNFe out of a 539 xMotivo', () => {
    const { nRec, chNFe } = extractMarkers(
      `Rejeição: Duplicidade NF-e com diferença na chave [chNFe:${CHAVE}][nRec:351000000000123]`,
    );
    expect(nRec).toBe('351000000000123');
    expect(chNFe).toBe(CHAVE);
  });

  it('returns nulls on a non-marker message', () => {
    const { nRec, chNFe } = extractMarkers('Autorizado o uso da NF-e');
    expect(nRec).toBeNull();
    expect(chNFe).toBeNull();
  });

  it('returns nulls when xMotivo is null / undefined / empty', () => {
    expect(extractMarkers(null)).toEqual({ nRec: null, chNFe: null });
    expect(extractMarkers(undefined)).toEqual({ nRec: null, chNFe: null });
    expect(extractMarkers('')).toEqual({ nRec: null, chNFe: null });
  });

  it('regex constants match the documented SEFAZ formats', () => {
    expect(RE_NREC.exec('[nRec:351000000000123]')?.[1]).toBe('351000000000123');
    expect(RE_CHNFE.exec(`[chNFe:${CHAVE}]`)?.[1]).toBe(CHAVE);
  });
});

// ---------------------------------------------------------------------------
// SefazOutcome builders
// ---------------------------------------------------------------------------

describe('outcomeFromRetEnviNFe', () => {
  it('captures cStat=103 with the structured infRec.nRec', () => {
    const out = outcomeFromRetEnviNFe({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '103',
      xMotivo: 'Lote recebido com sucesso',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      infRec: { nRec: '351000000000123', tMed: '1' },
      versao: '4.00',
    });
    expect(out.cStat).toBe('103');
    expect(out.nRec).toBe('351000000000123');
    expect(out.chNFeFromXMotivo).toBeNull();
  });

  it('falls back to xMotivo-embedded nRec when infRec is absent (duplicidade)', () => {
    const out = outcomeFromRetEnviNFe({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '204',
      xMotivo: 'Rejeição: Duplicidade de NF-e [nRec:351000000000999]',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      versao: '4.00',
    });
    expect(out.nRec).toBe('351000000000999');
  });

  it('captures chNFeFromXMotivo on cStat=539', () => {
    const out = outcomeFromRetEnviNFe({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '539',
      xMotivo: `Duplicidade [chNFe:${CHAVE}][nRec:351000000000888]`,
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      versao: '4.00',
    });
    expect(out.chNFeFromXMotivo).toBe(CHAVE);
    expect(out.nRec).toBe('351000000000888');
  });
});

describe('outcomeFromRetConsRec', () => {
  it('captures cStat=105 (still processing) with the nRec for the next poll', () => {
    const out = outcomeFromRetConsRec({
      tpAmb: '2',
      verAplic: 'SP',
      nRec: '351000000000123',
      cStat: '105',
      xMotivo: 'Lote em Processamento',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      versao: '4.00',
    });
    expect(out.cStat).toBe('105');
    expect(out.nRec).toBe('351000000000123');
  });
});

describe('outcomeFromRetConsSit', () => {
  it('uses the inner protNFe when present (server-truth)', () => {
    const out = outcomeFromRetConsSit({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '100', // top-level
      xMotivo: 'Autorizado o uso da NF-e',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      chNFe: CHAVE,
      versao: '4.00',
      protNFe: {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'SP',
          chNFe: CHAVE,
          dhRecbto: '2026-05-20T10:30:00-03:00',
          nProt: '135200000000123',
          cStat: '100',
          xMotivo: 'Autorizado o uso da NF-e',
        },
      },
    });
    expect(out.cStat).toBe('100');
    expect(out.nRec).toBeNull(); // nProt is not nRec
  });

  it('uses the top-level cStat when no protNFe is present (NF-e not found)', () => {
    const out = outcomeFromRetConsSit({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '217',
      xMotivo: 'NF-e não consta na base de dados da SEFAZ',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      chNFe: CHAVE,
      versao: '4.00',
    });
    expect(out.cStat).toBe('217');
    expect(out.nRec).toBeNull();
  });
});

describe('outcomeFromInfProt', () => {
  it('passes cStat + xMotivo through and leaves nRec null', () => {
    const out = outcomeFromInfProt({
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      nProt: '135200000000123',
    });
    expect(out.cStat).toBe('100');
    expect(out.xMotivo).toContain('Autorizado');
    expect(out.nRec).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyRecovery
// ---------------------------------------------------------------------------

describe('classifyRecovery', () => {
  it.each([
    ['100', 'authorized'],
    ['150', 'authorized'],
    ['101', 'terminal-other'], // cancelada
    ['102', 'terminal-other'], // inutilizada
    ['103', 'poll-lote'],
    ['104', 'poll-lote'],
    ['105', 'poll-lote'],
    ['106', 'consult-by-chave'], // lote-nao-localizado
    ['204', 'consult-by-chave'], // duplicidade
    ['205', 'consult-by-chave'],
    ['218', 'consult-by-chave'],
    ['539', 'consult-by-chave'],
    ['110', 'rejected'], // denegada
    ['215', 'rejected'], // schema
    ['280', 'rejected'], // certificado
    ['656', 'backoff'], // consumo indevido
    ['108', 'backoff'], // paralisado momentâneo
    ['109', 'backoff'], // paralisado sem previsão
  ] as const)('classifies %s as %s', (cStat, expected) => {
    expect(classifyRecovery(cStat)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isStuckEnviando
// ---------------------------------------------------------------------------

describe('isStuckEnviando', () => {
  const NOW = new Date('2026-05-20T12:00:00Z');

  it('returns false for terminal estados (aprovada / rejeitada / cancelada)', () => {
    for (const estado of [
      ESTADO_NFE.aprovada,
      ESTADO_NFE.rejeitada,
      ESTADO_NFE.cancelada,
      ESTADO_NFE.gerado,
    ]) {
      expect(
        isStuckEnviando({ estado, ultima_modificacao: '2020-01-01T00:00:00Z' }, NOW),
      ).toBe(false);
    }
  });

  it('returns false when enviando is recent (within timeout)', () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString(); // 1 min ago
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.enviando, ultima_modificacao: recent },
        NOW,
      ),
    ).toBe(false);
  });

  it('returns true when enviando is older than the default timeout', () => {
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString(); // 10 min ago
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.enviando, ultima_modificacao: old },
        NOW,
      ),
    ).toBe(true);
  });

  it('returns true when aguardandoResposta is older than the timeout', () => {
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.aguardandoResposta, ultima_modificacao: old },
        NOW,
      ),
    ).toBe(true);
  });

  it('treats missing ultima_modificacao as stuck (defensive)', () => {
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.enviando, ultima_modificacao: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('treats unparseable timestamps as stuck', () => {
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.enviando, ultima_modificacao: 'not-a-date' },
        NOW,
      ),
    ).toBe(true);
  });

  it('honors a custom timeoutMs', () => {
    const twoMinutesAgo = new Date(NOW.getTime() - 2 * 60_000).toISOString();
    // 5min default — not stuck yet
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.enviando, ultima_modificacao: twoMinutesAgo },
        NOW,
      ),
    ).toBe(false);
    // 1min custom — stuck
    expect(
      isStuckEnviando(
        { estado: ESTADO_NFE.enviando, ultima_modificacao: twoMinutesAgo },
        NOW,
        60_000,
      ),
    ).toBe(true);
  });

  it('exports a sensible default timeout (5 minutes)', () => {
    expect(DEFAULT_STUCK_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
