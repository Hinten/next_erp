import { describe, it, expect, vi } from 'vitest';
import { ESTADO_NFE, nfeSchema } from '@delfrance/schemas';
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
    const { nRec, chNFe } = extractMarkers('Rejeição: Duplicidade de NF-e [nRec:351000000000123]');
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

  /**
   * CNPJ alfanumérico on the emitente (RFB IN 2.229/2024 · #1619).
   *
   * ⚠️ This is the cStat 539 ANTI-LOSS path, and the old `/chNFe:(\d+)/`
   * failed it in the worst possible way: it captured only the six digits
   * before the first letter and returned a value that was **truthy**, so
   * `recoverFrom539` passed its `if (!recoveredChave)` guard, missed the audit
   * log and marked an authorized NF-e as lost. A falsy result would at least
   * have taken the honest "sem marcador" branch.
   */
  describe('an ALPHANUMERIC chave in xMotivo', () => {
    const CHAVE_ALFA = '432601PC3D315K000193550010000000071000000012';

    it('survives extraction whole — not truncated at the first letter', () => {
      const { nRec, chNFe } = extractMarkers(
        `Rejeição: Duplicidade NF-e com diferença na chave [chNFe:${CHAVE_ALFA}][nRec:351000000000123]`,
      );
      expect(chNFe).toBe(CHAVE_ALFA);
      expect(chNFe).toHaveLength(44);
      // The exact regression: `\d+` stopped at the 'P' of PC3D315K000193.
      expect(chNFe).not.toBe('432601');
      // `nRec` is numeric and must keep working beside it.
      expect(nRec).toBe('351000000000123');
    });

    it('still matches a purely numeric chave — the control', () => {
      expect(RE_CHNFE.exec(`[chNFe:${CHAVE}]`)?.[1]).toBe(CHAVE);
    });

    /**
     * The near-miss. A short or lowercase value must yield **null**, so the
     * caller takes its "sem marcador" branch rather than looking up a wrong
     * chave — falsy is the safe failure here, truthy-but-wrong is not.
     */
    it.each([
      ['too short', '432601PC3D315K0001935500100000000710000000'],
      ['lowercase', '432601pc3d315k000193550010000000071000000012'],
      ['punctuated', '432601-PC3D315K000193550010000000071000000'],
    ])('yields null for a %s chave', (_label, bad) => {
      expect(extractMarkers(`[chNFe:${bad}][nRec:351000000000123]`).chNFe).toBeNull();
    });
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

  it('projects the inline protNFe on sync emission (indSinc=1, cStat=104 + protNFe + no infRec)', () => {
    const out = outcomeFromRetEnviNFe({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '104', // lote-level: processado
      xMotivo: 'Lote processado',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      versao: '4.00',
      protNFe: {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'SP',
          chNFe: CHAVE,
          dhRecbto: '2026-05-20T10:30:00-03:00',
          nProt: '135200000000456',
          cStat: '100', // per-NFe: autorizada
          xMotivo: 'Autorizado o uso da NF-e',
        },
      },
    });
    expect(out.cStat).toBe('100');
    expect(out.xMotivo).toContain('Autorizado');
    expect(out.nRec).toBeNull(); // sync emission has no nRec
  });

  it('projects an inline rejection protNFe (cStat=441 — tPag=99 needs xPag)', () => {
    const out = outcomeFromRetEnviNFe({
      tpAmb: '2',
      verAplic: 'SP',
      cStat: '104',
      xMotivo: 'Lote processado',
      cUF: '35',
      dhRecbto: '2026-05-20T10:30:00-03:00',
      versao: '4.00',
      protNFe: {
        versao: '4.00',
        infProt: {
          tpAmb: '2',
          verAplic: 'SP',
          chNFe: CHAVE,
          dhRecbto: '2026-05-20T10:30:00-03:00',
          cStat: '441',
          xMotivo: 'Rejeição: Descrição do pagamento (xPag) deve ser informada para tPag=99',
        },
      },
    });
    expect(out.cStat).toBe('441');
    expect(out.nRec).toBeNull();
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

  // The cancelada trap: a consSitNFe for a cancelled NF-e returns the
  // cancelamento at the TOP level while `protNFe` still carries the ORIGINAL
  // authorization (cStat 100). Preferring the inner protocol there flipped
  // cancelada docs back to aprovada — the top-level outcome must win.
  it.each([
    ['101', 'Cancelamento de NF-e homologado'],
    ['151', 'Cancelamento de NF-e homologado fora de prazo'],
    ['102', 'Inutilização de número homologado'],
  ] as const)(
    'top-level %s + inner protNFe 100 → the top-level cancelamento wins',
    (topCStat, topXMotivo) => {
      const out = outcomeFromRetConsSit({
        tpAmb: '2',
        verAplic: 'SP',
        cStat: topCStat,
        xMotivo: topXMotivo,
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
            cStat: '100', // the ORIGINAL authorization — must NOT win
            xMotivo: 'Autorizado o uso da NF-e',
          },
        },
      });
      expect(out.cStat).toBe(topCStat);
      expect(out.xMotivo).toBe(topXMotivo);
    },
  );
});

describe('outcomeFromInfProt', () => {
  it('passes cStat + xMotivo through and leaves nRec null when xMotivo has no markers', () => {
    const out = outcomeFromInfProt({
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
      nProt: '135200000000123',
    });
    expect(out.cStat).toBe('100');
    expect(out.xMotivo).toContain('Autorizado');
    expect(out.nRec).toBeNull();
    expect(out.chNFeFromXMotivo).toBeNull();
  });

  it('extracts nRec from xMotivo on duplicidade rejections (e.g. cStat=204)', () => {
    // Without this, the orchestrator's recovery branch has no nRec and
    // falls into consSit(chave) — wrong for cStat=539, useless for 204.
    const out = outcomeFromInfProt({
      cStat: '204',
      xMotivo: 'Rejeição: Duplicidade de NF-e [nRec:351000000000123]',
    });
    expect(out.nRec).toBe('351000000000123');
    expect(out.chNFeFromXMotivo).toBeNull();
  });

  it('extracts both chNFe and nRec from a cStat=539 xMotivo (live SEFAZ shape)', () => {
    const out = outcomeFromInfProt({
      cStat: '539',
      xMotivo:
        'Rejeição: Duplicidade de NF-e com diferença na Chave de Acesso ' +
        `[chNFe:${CHAVE}][nRec:351000131407057]`,
    });
    expect(out.cStat).toBe('539');
    expect(out.chNFeFromXMotivo).toBe(CHAVE);
    expect(out.nRec).toBe('351000131407057');
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

/**
 * #1653 — the sweep hands `isStuckEnviando` the RAW stored `ultima_modificacao`
 * (it reads `doc.data()` without the schema), and what is stored is a ms
 * NUMBER: `nfeSchema` writes one, and so did the legacy Flutter app. The old
 * `Date.parse` turned that number into NaN and counted NaN as stuck, so a doc
 * written one second earlier was already due. The ISO-only cases that stood
 * here never saw it — so every readable shape is now pinned on BOTH sides of
 * the timeout.
 */
describe('isStuckEnviando', () => {
  const NOW = new Date('2026-05-20T12:00:00Z');
  const MINUTE_MS = 60_000;
  const EM_VOO = [
    ['enviando', ESTADO_NFE.enviando],
    ['aguardandoResposta', ESTADO_NFE.aguardandoResposta],
  ] as const;

  /** The same instant, `ageMs` before NOW, in every shape the reader accepts. */
  function stampsAged(ageMs: number): Array<[string, unknown]> {
    const t = NOW.getTime() - ageMs;
    return [
      ['a ms number (nfeSchema, the Flutter corpus)', t],
      ['a µs number', t * 1000],
      ['an ISO string (pre-#220 docs)', new Date(t).toISOString()],
      ['a Date', new Date(t)],
    ];
  }

  describe.each(EM_VOO)('in flight (%s)', (_nome, estado) => {
    it.each(stampsAged(MINUTE_MS))('1 min old, as %s → not stuck', (_shape, stamp) => {
      expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW)).toBe(false);
    });

    it.each(stampsAged(10 * MINUTE_MS))('10 min old, as %s → stuck', (_shape, stamp) => {
      expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW)).toBe(true);
    });

    it.each(stampsAged(DEFAULT_STUCK_TIMEOUT_MS))(
      'exactly the timeout old, as %s → stuck (the bound is inclusive)',
      (_shape, stamp) => {
        expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW)).toBe(true);
      },
    );

    it.each(stampsAged(DEFAULT_STUCK_TIMEOUT_MS - 1))(
      '1 ms short of the timeout, as %s → not stuck',
      (_shape, stamp) => {
        expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW)).toBe(false);
      },
    );

    it.each(stampsAged(2 * MINUTE_MS))(
      '2 min old, as %s → not stuck by default, stuck under a 1-min timeoutMs',
      (_shape, stamp) => {
        expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW)).toBe(false);
        expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW, 60_000)).toBe(true);
      },
    );
  });

  it('reads the value nfeSchema really stores — a ms number one minute old is not stuck', () => {
    const stored = nfeSchema.shape.ultima_modificacao.parse(
      new Date(NOW.getTime() - MINUTE_MS).toISOString(),
    );
    expect(typeof stored).toBe('number');
    expect(isStuckEnviando({ estado: ESTADO_NFE.enviando, ultima_modificacao: stored }, NOW)).toBe(
      false,
    );
  });

  describe('a MISSING stamp counts as stuck — better to re-query than to ignore', () => {
    it('the field is absent', () => {
      expect(isStuckEnviando({ estado: ESTADO_NFE.enviando }, NOW)).toBe(true);
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined],
    ])('the field is %s', (_label, stamp) => {
      expect(isStuckEnviando({ estado: ESTADO_NFE.enviando, ultima_modificacao: stamp }, NOW)).toBe(
        true,
      );
    });
  });

  // Deliberate, not an accident of NaN: ignoring such a doc could strand an
  // anti-loss anchor forever, and the consult's persist re-stamps a ms number.
  it.each<[string, unknown]>([
    ['a non-date string', 'not-a-date'],
    ['an empty string', ''],
    ['a number in the ms/µs gap', 5e13],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a Firestore-Timestamp-like object', { seconds: 1716206340, nanoseconds: 0 }],
    ['a boolean', true],
  ])('a present but UNREADABLE stamp (%s) counts as stuck', (_label, stamp) => {
    expect(isStuckEnviando({ estado: ESTADO_NFE.enviando, ultima_modificacao: stamp }, NOW)).toBe(
      true,
    );
  });

  it.each<[string, number]>([
    ['0', 0],
    ['a negative number', -1],
  ])('the epoch or before it (%s) reads as a very old stamp → stuck', (_label, stamp) => {
    expect(isStuckEnviando({ estado: ESTADO_NFE.enviando, ultima_modificacao: stamp }, NOW)).toBe(
      true,
    );
  });

  // apps/nfe runs TZ=America/Sao_Paulo, so an offset-less string read in the
  // process timezone lands three hours off. Pinned under that zone, with one
  // stamp on each side of the timeout: read as local time, the 10-min-old one
  // would sit in the FUTURE and never be stuck.
  it('an ISO string without an offset is read as UTC, never in the process timezone', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    try {
      expect(
        isStuckEnviando(
          { estado: ESTADO_NFE.enviando, ultima_modificacao: '2026-05-20T11:59:00' },
          NOW,
        ),
      ).toBe(false);
      expect(
        isStuckEnviando(
          { estado: ESTADO_NFE.enviando, ultima_modificacao: '2026-05-20T11:50:00' },
          NOW,
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['aprovada', ESTADO_NFE.aprovada],
    ['rejeitada', ESTADO_NFE.rejeitada],
    ['cancelada', ESTADO_NFE.cancelada],
    ['gerado', ESTADO_NFE.gerado],
  ] as const)(
    'an estado that is not in flight (%s) is never stuck, whatever its stamp',
    (_nome, estado) => {
      for (const stamp of [
        NOW.getTime() - MINUTE_MS,
        NOW.getTime() - 10 * MINUTE_MS,
        'not-a-date',
        null,
      ]) {
        expect(isStuckEnviando({ estado, ultima_modificacao: stamp }, NOW)).toBe(false);
      }
    },
  );

  it('exports a sensible default timeout (5 minutes)', () => {
    expect(DEFAULT_STUCK_TIMEOUT_MS).toBe(5 * 60_000);
  });
});
