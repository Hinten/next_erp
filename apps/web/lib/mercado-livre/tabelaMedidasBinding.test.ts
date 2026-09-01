import { describe, expect, it } from 'vitest';
import type { MlSizeChart } from '@delfrance/schemas';

import { type AtributoValor, avaliarTabela, avisoDominioTabela } from './tabelaMedidasBinding';

const guia = (over: Partial<MlSizeChart>): MlSizeChart => ({
  id: '7523235',
  nome: 'Grade infantil',
  domain_id: 'MLB-T_SHIRTS',
  attributes: [
    { id: 'BRAND', value_id: 'B1', value_name: 'Veste France' },
    { id: 'GENDER', value_id: '19159491', value_name: 'Infantil' },
  ],
  rows: [],
  ...over,
});

/** The anúncio's own attributes — the other side of every comparison. */
const ANUNCIO: AtributoValor[] = [
  { id: 'BRAND', value_id: 'B1', value_name: 'Veste France' },
  { id: 'GENDER', value_id: '19159491', value_name: 'Infantil' },
];

describe('avaliarTabela', () => {
  it('everything agrees → the guia binds and every cell is a match', () => {
    const { guias, vinculada, anuncio } = avaliarTabela([guia({})], 'MLB-T_SHIRTS', ANUNCIO);
    expect(guias[0]!.dominioOk).toBe(true);
    expect(guias[0]!.veredito).toEqual({ BRAND: true, GENDER: true });
    expect(guias[0]!.vincula).toBe(true);
    expect(vinculada?.chartId).toBe('7523235');
    // The anúncio's own three values, so the operator never has to hold them in
    // their head while reading the table.
    expect(anuncio).toEqual({
      dominio: 'MLB-T_SHIRTS',
      valores: { BRAND: 'Veste France', GENDER: 'Infantil' },
    });
  });

  it('the live case: only the DOMAIN differs, and nothing binds', () => {
    // #1087 — chart 7523235 is MLB-SHIRTS, category MLB1398 asks MLB-T_SHIRTS.
    // Marca and gênero agree, which is exactly why the failure was baffling.
    const { guias, vinculada } = avaliarTabela(
      [guia({ domain_id: 'MLB-SHIRTS' })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(guias[0]!.dominioOk).toBe(false);
    expect(guias[0]!.veredito).toEqual({ BRAND: true, GENDER: true });
    expect(guias[0]!.vincula).toBe(false);
    expect(vinculada).toBeNull();
  });

  it('right domain, wrong GÊNERO → still binds nothing, and the table says which cell', () => {
    // ⚠️ The failure the domain column alone cannot explain — just as silent as
    // the mismatch above, and the reason each attribute gets its own verdict.
    const { guias, vinculada } = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(guias[0]!.dominioOk).toBe(true);
    expect(guias[0]!.veredito.GENDER).toBe(false);
    expect(guias[0]!.vincula).toBe(false);
    expect(vinculada).toBeNull();
  });

  it('a value missing on EITHER side is no verdict at all — not a mismatch', () => {
    const semMarca = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: '19159491', value_name: 'Infantil' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(semMarca.guias[0]!.veredito.BRAND).toBeNull();
    expect(semMarca.guias[0]!.valores.BRAND).toBeNull();

    const anuncioSemMarca = avaliarTabela([guia({})], 'MLB-T_SHIRTS', [
      { id: 'GENDER', value_id: '19159491', value_name: 'Infantil' },
    ]);
    expect(anuncioSemMarca.guias[0]!.veredito.BRAND).toBeNull();
    // …and the guia still binds: an attribute nobody filled in cannot score, so
    // blaming it would send the operator to fix something that is not broken.
    expect(anuncioSemMarca.guias[0]!.vincula).toBe(true);
  });

  it('id OR name — a name match is a hit even when the ids disagree', () => {
    // ⚠️ This test used to assert `false` here, on the reasoning that "comparing
    // names would paint a ✓ the server does not make". The server's scoring is an
    // **OR**: a matching `value_name` IS a hit whatever the ids say. Short-
    // circuiting on ids rendered a red ✗ on a row the very same module labelled
    // `vincula` — two functions describing one decision, disagreeing on screen.
    const idDiverge = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: 'OUTRO', value_name: 'Infantil' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(idDiverge.guias[0]!.veredito.GENDER).toBe(true);
    // The cell and the badge must agree — that is the whole point.
    expect(idDiverge.guias[0]!.vincula).toBe(true);

    // Same id, different label: a hit on the id alone.
    const nomeDiverge = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: '19159491', value_name: 'Criança' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(nomeDiverge.guias[0]!.veredito.GENDER).toBe(true);
  });

  it('neither id nor name matches → a real ✗, and it binds nothing', () => {
    const out = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: 'OUTRO', value_name: 'Feminino' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(out.guias[0]!.veredito.GENDER).toBe(false);
    expect(out.guias[0]!.vincula).toBe(false);
  });

  it('NO cell may contradict the badge beside it', () => {
    // The invariant behind findings like the one above: a guia that binds cannot
    // carry a ✗, because the ✗ claims the server rejected what it accepted.
    const casos = [
      guia({}),
      guia({ attributes: [{ id: 'GENDER', value_id: 'OUTRO', value_name: 'Infantil' }] }),
      guia({ attributes: [{ id: 'BRAND', value_id: 'B1', value_name: 'Outra marca' }] }),
      guia({ attributes: [{ id: 'GENDER', value_id: '19159491' }] }),
    ];
    for (const c of casos) {
      const { guias } = avaliarTabela([c], 'MLB-T_SHIRTS', ANUNCIO);
      const g = guias[0]!;
      if (!g.vincula) continue;
      expect(Object.values(g.veredito)).not.toContain(false);
      expect(g.dominioOk).not.toBe(false);
    }
  });

  it('a guia with no ML id is NUNCA ENVIADA and can never bind', () => {
    const { guias, vinculada } = avaliarTabela([guia({ id: null })], 'MLB-T_SHIRTS', ANUNCIO);
    expect(guias[0]!.enviada).toBe(false);
    expect(guias[0]!.dominioOk).toBe(true); // the domain IS right — that is the point
    expect(guias[0]!.vincula).toBe(false);
    expect(vinculada).toBeNull();
  });

  it('no valued anúncio attributes → the first candidate binds (the legacy boundary)', () => {
    const { vinculada } = avaliarTabela([guia({ id: 'A' }), guia({ id: 'B' })], 'MLB-T_SHIRTS', []);
    expect(vinculada?.chartId).toBe('A');
  });

  it('with valued attributes the BEST scorer wins, and zero hits binds nothing', () => {
    const melhor = avaliarTabela(
      [
        guia({ id: 'A', attributes: [{ id: 'GENDER', value_id: '339665' }] }),
        guia({ id: 'B' }), // matches BRAND and GENDER
      ],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(melhor.vinculada?.chartId).toBe('B');

    const nenhum = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: 'no-such' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(nenhum.vinculada).toBeNull();
  });

  it('⚠️ non-empty but UNVALUED attributes bind NOTHING — the legacy boundary', () => {
    // ⚠️ This module used to key its first-candidate fallback on the FILTERED
    // list while the server keys on the RAW one, so an ML-imported stub
    // (attributes present, none valued) made the panel show a green `vincula`
    // on a pair publish refuses — the exact contradiction it exists to remove.
    // It shipped for a week behind green tests and a confident comment.
    const stub = [{ id: 'GENDER' }];
    const { guias, vinculada } = avaliarTabela([guia({})], 'MLB-T_SHIRTS', stub);
    expect(vinculada).toBeNull();
    expect(guias[0]!.vincula).toBe(false);
    // …while an EMPTY list still takes the fallback, which is the boundary.
    expect(avaliarTabela([guia({})], 'MLB-T_SHIRTS', []).vinculada?.chartId).toBe('7523235');
  });

  it('no category domain yet → no domain verdict at all', () => {
    const { guias, vinculada } = avaliarTabela([guia({})], null, ANUNCIO);
    expect(guias[0]!.dominioOk).toBeNull();
    expect(vinculada).toBeNull();
  });
});

describe('avisoDominioTabela', () => {
  const base = {
    nomeDaTabela: 'Camiseta lisa infantil',
    categoriaUsaGuia: true as boolean | null,
    categoryId: 'MLB1398' as string | null,
  };
  const divergente = avaliarTabela([guia({ domain_id: 'MLB-SHIRTS' })], 'MLB-T_SHIRTS', ANUNCIO);

  it('names BOTH domains and the tabela — the sentence that is the whole fix', () => {
    const aviso = avisoDominioTabela({ ...base, avaliacao: divergente });
    expect(aviso).toContain('MLB-SHIRTS');
    expect(aviso).toContain('MLB-T_SHIRTS');
    expect(aviso).toContain('Camiseta lisa infantil');
    expect(aviso).toContain('MLB1398');
  });

  it('⚠️ no guia declares a domain at all → names only the CATEGORY domain', () => {
    // ⚠️ Legacy data: the read schema allows a null `domain_id`, so
    // `dominiosDaTabela` comes back EMPTY and the ordinary sentence would read
    // "está no domínio , mas…". This branch was shipped untested on both
    // copies of the message; it is reachable, so it is asserted.
    const avaliacao = avaliarTabela([guia({ domain_id: null })], 'MLB-T_SHIRTS', ANUNCIO);
    expect(avaliacao.resolucao.motivo).toBe('dominio-divergente');
    const aviso = avisoDominioTabela({ ...base, avaliacao })!;
    expect(aviso).toContain('não tem nenhuma guia no domínio MLB-T_SHIRTS');
    // …and it must never print an empty or dangling domain list.
    expect(aviso).not.toContain('está no domínio ');
    expect(aviso).not.toContain('categoria de .');
  });

  it('is SILENT while any input is still loading', () => {
    // ⚠️ The never-flash-an-accusation rule this tab already follows for
    // `produtoFotoCount` and `produtoMarca`: `null` is "not arrived", and a
    // warning shown then is a warning the operator learns to ignore.
    expect(avisoDominioTabela({ ...base, avaliacao: null })).toBeNull();
    expect(
      avisoDominioTabela({ ...base, avaliacao: divergente, categoriaUsaGuia: null }),
    ).toBeNull();
    expect(avisoDominioTabela({ ...base, avaliacao: divergente, categoryId: null })).toBeNull();
  });

  it('is silent where the category does not use a guia', () => {
    expect(
      avisoDominioTabela({ ...base, avaliacao: divergente, categoriaUsaGuia: false }),
    ).toBeNull();
  });

  it('is silent when something binds', () => {
    const ok = avaliarTabela([guia({})], 'MLB-T_SHIRTS', ANUNCIO);
    expect(avisoDominioTabela({ ...base, avaliacao: ok })).toBeNull();
  });

  it('does NOT blame the domain when a guia in the right domain simply never went out', () => {
    // Telling this operator their domain is wrong sends them to change the one
    // field that is already correct. What they have to do is press Enviar.
    const rascunho = avaliarTabela([guia({ id: null })], 'MLB-T_SHIRTS', ANUNCIO);
    expect(avisoDominioTabela({ ...base, avaliacao: rascunho })).toBeNull();
  });

  it('does NOT blame the domain on a pure gênero miss', () => {
    const genero = avaliarTabela(
      [guia({ attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }] })],
      'MLB-T_SHIRTS',
      ANUNCIO,
    );
    expect(avisoDominioTabela({ ...base, avaliacao: genero })).toBeNull();
  });
});
