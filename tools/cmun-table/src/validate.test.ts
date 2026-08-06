import { describe, expect, it } from 'vitest';
import { cmunDocId, cmunSchema } from '@delfrance/schemas';
import { type CmunDumpRow, CmunDumpError, formatGapReport, validateDump } from './validate';

/** Fixtures are three rows, so the "does this look like Brazil?" bands are off. */
const OPTS = { sanityBands: false } as const;

function row(over: Partial<CmunDumpRow> = {}): CmunDumpRow {
  return {
    cepInicial: 1_000_000,
    cepFinal: 1_099_999,
    cMun: '3550308',
    nomeMunicipio: 'SAO PAULO',
    uf: 'SP',
    ...over,
  };
}

describe('validateDump', () => {
  it('normalizes a clean dump into importable faixas', () => {
    const result = validateDump(
      [
        row({
          cepInicial: 2_000_000,
          cepFinal: 2_099_999,
          cMun: '3304557',
          nomeMunicipio: 'RIO DE JANEIRO',
          uf: 'RJ',
        }),
        row(),
      ],
      OPTS,
    );

    // Sorted by cepInicial regardless of the dump's document order — the legacy
    // seed used Firestore auto-ids, so the order is arbitrary. `cMun` stays a
    // STRING (it is a code, not a number) and the município/UF ride along,
    // because the import writes them straight into `cmunSchema`.
    expect(result.ranges).toEqual([
      {
        cepInicial: 1_000_000,
        cepFinal: 1_099_999,
        cMun: '3550308',
        nomeMunicipio: 'SAO PAULO',
        estado: 'SP',
      },
      {
        cepInicial: 2_000_000,
        cepFinal: 2_099_999,
        cMun: '3304557',
        nomeMunicipio: 'RIO DE JANEIRO',
        estado: 'RJ',
      },
    ]);
    expect(result.codeCount).toBe(2);
  });

  it('produces rows the CMUN schema accepts, with a deterministic doc id', () => {
    // The import writes these straight into Firestore, so validated output has
    // to survive `cmunSchema.parse` — and the id has to be derivable, or a
    // re-run duplicates every faixa the way the legacy auto-id seeder did.
    const [range] = validateDump([row()], OPTS).ranges;

    const parsed = cmunSchema.parse({
      cepInicial: range!.cepInicial,
      cepFinal: range!.cepFinal,
      cMun: String(range!.cMun).padStart(7, '0'),
      nomeMunicipio: 'SAO PAULO',
      estado: 'SP',
      origem: 'tabelao',
    });

    expect(parsed.cepInicial).toBe(1_000_000);
    expect(parsed.cMun).toBe('3550308');
    expect(cmunDocId(range!.cepInicial)).toBe('01000000');
  });

  describe('fatal checks', () => {
    it('rejects a CEP bound that arrived as a string', () => {
      // The legacy import ran `int.parse` and stored Firestore integers, so a
      // string here means the dump mixed types — and `Number(cep)`'s
      // leading-zero assumption is void.
      expect(() => validateDump([row({ cepInicial: '01000000' })], OPTS)).toThrow(CmunDumpError);
    });

    it('rejects a cMun that is not 7 digits', () => {
      expect(() => validateDump([row({ cMun: '355030' })], OPTS)).toThrow(CmunDumpError);
      expect(() => validateDump([row({ cMun: 3_550_308 })], OPTS)).toThrow(CmunDumpError);
    });

    it('rejects a cMun whose prefix contradicts its UF', () => {
      // THE check that catches a corrupt dump: cMun's first 2 digits are the
      // state's IBGE code, so this cross-validates two independently imported
      // CSV columns.
      const err = validateDump.bind(null, [row({ uf: 'RJ' })], OPTS);
      expect(err).toThrow(CmunDumpError);
      expect(err).toThrow(/não pertence à UF RJ/);
    });

    it('rejects an unknown UF', () => {
      expect(() => validateDump([row({ uf: 'XX' })], OPTS)).toThrow(CmunDumpError);
    });

    it('rejects an inverted or out-of-bounds faixa', () => {
      expect(() =>
        validateDump([row({ cepInicial: 1_099_999, cepFinal: 1_000_000 })], OPTS),
      ).toThrow(CmunDumpError);
      expect(() => validateDump([row({ cepInicial: 999 })], OPTS)).toThrow(CmunDumpError);
    });

    it('rejects overlapping faixas', () => {
      const err = validateDump.bind(
        null,
        [row(), row({ cepInicial: 1_050_000, cepFinal: 1_199_999, cMun: '3304557', uf: 'RJ' })],
        OPTS,
      );
      expect(err).toThrow(CmunDumpError);
      expect(err).toThrow(/sobrepostas/);
    });

    it('reports EVERY problem in one run, not just the first', () => {
      const err = validateDump.bind(
        null,
        [row({ cMun: 'nope' }), row({ cepInicial: 2_000_000, cepFinal: 2_099_999, uf: 'ZZ' })],
        OPTS,
      );

      expect(err).toThrow(CmunDumpError);
      try {
        validateDump(
          [row({ cMun: 'nope' }), row({ cepInicial: 2_000_000, cepFinal: 2_099_999, uf: 'ZZ' })],
          OPTS,
        );
      } catch (e) {
        if (!(e instanceof CmunDumpError)) throw e;
        expect(e.issues.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('rejects a truncated export when the sanity bands are on', () => {
      expect(() => validateDump([row()])).toThrow(/banda esperada/);
    });

    it('numbers rows the way a human reads the dump — 1-based', () => {
      // The dump is JSONL; "linha N" has to match the line you open in an
      // editor, not the 0-based array index.
      const err = validateDump.bind(null, [row(), row({ cMun: 'nope' })], OPTS);

      expect(err).toThrow(/linha 2:/);
      expect(err).not.toThrow(/linha 0:/);
    });
  });

  describe('exterior rows', () => {
    it('drops them and reports the count', () => {
      const result = validateDump(
        [row(), row({ uf: 'EX', cMun: '9999999', cepInicial: 9_000_000, cepFinal: 9_099_999 })],
        OPTS,
      );

      expect(result.droppedExterior).toBe(1);
      expect(result.ranges).toHaveLength(1);
      expect(result.warnings.join(' ')).toMatch(/exterior/);
    });

    it.each(['ex', 'Ex', 'eX'])('drops a %s row too — the check is case-insensitive', (uf) => {
      // The main path uppercases `uf` before validating, so a lowercase
      // exterior row would otherwise dodge the drop and be encoded as a real
      // faixa (and then fail the UF cross-check for the wrong reason).
      const result = validateDump(
        [row(), row({ uf, cMun: '9999999', cepInicial: 9_000_000, cepFinal: 9_099_999 })],
        OPTS,
      );

      expect(result.droppedExterior).toBe(1);
      expect(result.ranges).toHaveLength(1);
    });
  });

  describe('gap report', () => {
    it('measures the holes between faixas', () => {
      const result = validateDump(
        [
          row({ cepInicial: 1_000_000, cepFinal: 1_099_999 }),
          row({ cepInicial: 2_000_000, cepFinal: 2_099_999, cMun: '3304557', uf: 'RJ' }),
        ],
        OPTS,
      );

      expect(result.gaps.count).toBe(1);
      expect(result.gaps.cepsUncovered).toBe(900_000);
      expect(result.gaps.largest[0]).toEqual({ from: 1_100_000, to: 1_999_999, size: 900_000 });
    });

    it('sees no gap between adjacent faixas', () => {
      const result = validateDump(
        [
          row({ cepInicial: 1_000_000, cepFinal: 1_099_999 }),
          row({ cepInicial: 1_100_000, cepFinal: 1_199_999 }),
        ],
        OPTS,
      );

      expect(result.gaps.count).toBe(0);
      expect(formatGapReport(result.gaps)).toMatch(/Nenhum buraco/);
    });
  });

  describe('non-fatal warnings', () => {
    it('flags a município spelled two ways across its faixas', () => {
      const result = validateDump(
        [
          row({ nomeMunicipio: 'SAO PAULO' }),
          row({ cepInicial: 1_100_000, cepFinal: 1_199_999, nomeMunicipio: 'SÃO PAULO' }),
        ],
        OPTS,
      );

      expect(result.warnings.join(' ')).toMatch(/nomeMunicipio divergente/);
      expect(result.ranges).toHaveLength(2); // non-fatal
    });
  });
});
