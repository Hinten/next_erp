/**
 * CNPJ Alfanumérico (IN RFB 2.229/2024 · NT 2026.004) — the XSD gate must accept
 * an alphanumeric CNPJ, and must still reject the near-misses.
 *
 * ⚠️ WHY THIS EXISTS. Before the `PL_010d_v1.03` pack landed, `TCnpj` was
 * `[0-9]{14}` and an alphanumeric destinatário died in `validateXsd` — locally,
 * before the request ever reached SEFAZ. That is the correct behaviour for a
 * schema-invalid document (root `CLAUDE.md`: never let one reach SEFAZ, it feeds
 * the 656 ban path), which is exactly why the fix had to be the schema and not a
 * bypass. This test is the regression pin for that swap.
 *
 * ⚠️ The assertion is NOT "the XML validates" — the generator emits an UNSIGNED
 * `<NFe>`, and the schema requires `<Signature>`, so a bare
 * `resolves.toBeUndefined()` fails for a reason that has nothing to do with the
 * CNPJ. Each case therefore filters the error list for a CNPJ/chave pattern
 * facet, which is the only thing this test is about.
 */
import { describe, expect, it } from 'vitest';

import { validateCNPJ } from '@delfrance/core/documents';
import { TIPO_CLIENTE } from '@delfrance/schemas';

import { generateNFe } from '../../src/generator';
import { NFeXsdValidationError, validateXsd } from '../../src/xsd';
import { buildHomologacaoFixture } from '../helpers/homologacao-fixture';

/** Every XSD error whose message names a `pattern` facet. */
async function errosDePattern(cpfCnpj: string): Promise<string[]> {
  const base = buildHomologacaoFixture({
    numeracao: 1,
    serie: 2,
    cnpj: '99999999000191',
    ie: '111111111',
  });
  // ⚠️ `tipo` is forced back to PESSOA JURÍDICA here, and that is load-bearing:
  // the shared fixture's destinatário is a pessoa física (SEFAZ rejects every
  // CNPJ we may use with cStat 181 — see the fixture's own comment), so without
  // this override the alfa value would land in `<CPF>`, whose facet is
  // `[0-9]{11}`, and the test would report a pattern error that says nothing
  // about `TCnpj`.
  //
  // ⚠️ `ie` is deliberately NOT overridden. An earlier revision set the
  // não-contribuinte sentinel here and claimed a PJ with no `ie` was a different
  // rung — it is not: `classifyIe(null)` answers `'ausente'`, and `parties.ts`
  // folds `'ausente'` and `'naoContribuinte'` into the same `indIEDest='9'` arm
  // with no `<IE>`. The override was inert, and an inert line that claims to be
  // load-bearing is the thing the next reader trips over.
  const out = generateNFe({
    ...base,
    cliente: { ...base.cliente, tipo: TIPO_CLIENTE.pessoaJuridica, cpf_cnpj: cpfCnpj },
  });
  try {
    await validateXsd('NFe', out.nfeXml);
    return [];
  } catch (err) {
    if (err instanceof NFeXsdValidationError) {
      return err.errors.map((e) => e.message).filter((m) => m.includes("facet 'pattern'"));
    }
    throw err;
  }
}

describe('CNPJ alfanumérico — XSD gate (NT 2026.004 / PL_010d)', () => {
  /**
   * Real rows from SEFAZ's published "CNPJs alfa cadastrados no CCC de
   * homologação" table — the CNPJs the live suites are meant to emit to.
   *
   * ⚠️ These are the reason the whole pack swap happened, so pinning them here
   * is the point: they prove the vendored facet and our own check-digit
   * implementation both accept SEFAZ's OWN published data. Either one drifting
   * reds this test instead of a live SEFAZ round trip.
   */
  const OFICIAIS = [
    'PC3D315K000193', // RS
    'MMH9SKDL539Y64', // MG
    'UGVG75BM000152', // GO
    'MBS1MDGN000111', // AM
    'RHXHP3ET000108', // ES
    'A0021382000161', // SC
  ] as const;

  it.each(OFICIAIS)('%s satisfies the TCnpj facet and the canonical DV', (cnpj) => {
    // tiposBasico_v4.00 `TCnpj` is `[0-9A-Z]{12}[0-9]{2}`, and
    // `@delfrance/core/documents` has enforced exactly that shape plus the
    // ASCII-48 módulo-11 weighting since the IN RFB 2.229 prep work. The two
    // agreeing on SEFAZ's own values is what makes the swap trustworthy.
    expect(/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)).toBe(true);
    expect(validateCNPJ(cnpj)).toBe(true);
  });

  it('accepts an alphanumeric destinatário CNPJ', async () => {
    await expect(errosDePattern('PC3D315K000193')).resolves.toEqual([]);
  });

  it('still accepts a purely numeric destinatário CNPJ (control)', async () => {
    await expect(errosDePattern('99999999000191')).resolves.toEqual([]);
  });

  // ⚠️ The near-misses. A fold that accepts everything is not a fix — these pin
  // where the widened facet STOPS.
  it('rejects a lowercase CNPJ — the facet is [0-9A-Z], not case-insensitive', async () => {
    const erros = await errosDePattern('pc3d315k000193');
    expect(erros.join(' ')).toMatch(/pc3d315k000193/i);
  });

  it('rejects letters in the two check-digit positions', async () => {
    // `[0-9A-Z]{12}[0-9]{2}` — the DV stays numeric even in the alfa format.
    const erros = await errosDePattern('PC3D315K0001AB');
    expect(erros.join(' ')).toMatch(/PC3D315K0001AB/);
  });

  it('a bad check digit still fails the canonical validator', () => {
    expect(validateCNPJ('PC3D315K000193')).toBe(true);
    expect(validateCNPJ('PC3D315K000194')).toBe(false);
  });
});

/**
 * The two in-package guards that still spoke `[0-9]{14}` after the pack swap.
 * Both take a COUNTERPARTY's CNPJ — exactly who the Receita issues alfa CNPJs
 * to — and both used `replace(/\D/g, '')`, which ate the letters and then
 * rejected the wreckage.
 */
describe('CNPJ alfanumérico — the generator guards', () => {
  function fixtureComCnpjFab(cnpjFab: string) {
    const base = buildHomologacaoFixture({
      numeracao: 1,
      serie: 2,
      cnpj: '99999999000191',
      ie: '111111111',
    });
    return {
      ...base,
      // ⚠️ BOTH are required to reach the guard: det.ts only emits the
      // indEscala/CNPJFab pair when `item.indEscala != null && item.CEST`.
      // Setting indEscala alone makes these tests pass vacuously.
      itens: base.itens.map((i) => ({
        ...i,
        CEST: i.CEST ?? '2803800',
        indEscala: false,
        CNPJFab: cnpjFab,
      })),
    };
  }

  it('accepts an alphanumeric CNPJFab (fabricante)', () => {
    expect(() => generateNFe(fixtureComCnpjFab('PC3D315K000193'))).not.toThrow();
  });

  it('still rejects a CNPJFab with a bad DV, and echoes it un-mangled', () => {
    // ⚠️ The old message printed the STRIPPED value ('3315000193'), so the
    // operator was shown digits they never typed. The value in the error must be
    // recognisable as what is in the cadastro.
    expect(() => generateNFe(fixtureComCnpjFab('PC3D315K000194'))).toThrow(/PC3D315K000194/);
  });

  it('accepts a 44-char chNFeReferenciada whose CNPJ body is alphanumeric', () => {
    const base = buildHomologacaoFixture({
      numeracao: 1,
      serie: 2,
      cnpj: '99999999000191',
      ie: '111111111',
    });
    const chaveAlfa = `432601PC3D315K0001${'9'.repeat(26)}`;
    expect(chaveAlfa).toHaveLength(44);
    expect(() => generateNFe({ ...base, chNFeReferenciadas: [chaveAlfa] })).not.toThrow();
  });
});
