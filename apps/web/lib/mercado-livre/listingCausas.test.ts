import { describe, expect, it } from 'vitest';
import { ML_CAUSA_TIPO, type MlCausa } from '@delfrance/schemas';

import {
  erroDoCampo,
  errosDeAtributos,
  mergeServerErrors,
  splitCausas,
  textoDaCausa,
} from './listingCausas';

const causa = (over: Partial<MlCausa>): MlCausa => ({
  code: null,
  causaId: null,
  tipo: ML_CAUSA_TIPO.erro,
  departamento: null,
  mensagem: 'algo deu errado',
  referencias: [],
  campos: [],
  ...over,
});

describe('splitCausas', () => {
  it('reports nothing for a link the publisher never stamped', () => {
    expect(splitCausas({ causas: null })).toMatchObject({
      porCampo: {},
      gerais: [],
      avisos: [],
      temCausas: false,
    });
  });

  it('sends a single-control error to that control AND the banner', () => {
    const split = splitCausas({
      causas: [causa({ mensagem: 'Categoria inválida', campos: ['category_id'] })],
    });
    expect(split.porCampo).toEqual({ category_id: ['Categoria inválida'] });
    // #1118 review: NOT `[]`. Resolving to a control is not the same as being
    // visible on one — see the regression block below.
    expect(split.gerais).toHaveLength(1);
  });

  /**
   * #1118 review — the hole this asymmetry closes.
   *
   * `campos` is resolved server-side against the payload we SENT, which carries
   * attributes the editor never renders. An earlier cut kept a single-control
   * cause out of `gerais`; `ListingStatusStrip` also suppresses the raw `errors`
   * fallback as soon as `temCausas` is true, so such a cause was displayed
   * NOWHERE — strictly worse than the `ML 400: Validation error` line this
   * feature replaced.
   */
  describe('a cause pinned to an UNRENDERED control is still shown', () => {
    const naoRenderizados = [
      // Derived, stripped before the editor ever sees them.
      'attributes.SELLER_PACKAGE_WIDTH',
      'attributes.WEIGHT',
      'attributes.SIZE_GRID_ID',
      'attributes.SELLER_SKU',
      // Read-only once the listing is published.
      'listing_type_id',
      // An id absent from the category the operator has since switched to.
      'attributes.OBSOLETO',
    ];

    for (const campo of naoRenderizados) {
      it(`keeps \`${campo}\` in the banner`, () => {
        const split = splitCausas({
          causas: [causa({ mensagem: 'Medida inválida', campos: [campo] })],
        });
        expect(split.gerais).toHaveLength(1);
        expect(split.porCampo[campo]).toEqual(['Medida inválida']);
      });
    }

    it('never drops a blocking cause, whatever it resolved to', () => {
      // The invariant, stated once: `gerais` is the COMPLETE blocking list, so
      // no `campos` value can make a rejection disappear.
      const causas = [
        causa({ mensagem: 'a', campos: [] }),
        causa({ mensagem: 'b', campos: ['title'] }),
        causa({ mensagem: 'c', campos: ['attributes.SELLER_PACKAGE_WIDTH'] }),
        causa({ mensagem: 'd', campos: ['category_id', 'attributes.BRAND'] }),
      ];
      const split = splitCausas({ causas });
      expect(split.gerais.map((c) => c.mensagem)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  it('sends a cause with NO control to the banner', () => {
    const split = splitCausas({
      causas: [causa({ mensagem: 'ME2 é obrigatório', referencias: ['shipping.modes'] })],
    });
    expect(split.porCampo).toEqual({});
    expect(split.gerais).toHaveLength(1);
  });

  it('sends a MULTI-control error to both controls AND the banner', () => {
    // The case the operator cannot reconstruct from red inputs alone: one ML
    // rejection, two fields. Two highlights with no sentence do not say that.
    const split = splitCausas({
      causas: [
        causa({
          mensagem: 'Marca não autorizada nesta categoria',
          campos: ['category_id', 'attributes.BRAND'],
        }),
      ],
    });
    expect(Object.keys(split.porCampo).sort()).toEqual(['attributes.BRAND', 'category_id']);
    expect(split.gerais).toHaveLength(1);
  });

  it('keeps a warning out of the error channels entirely', () => {
    const split = splitCausas({
      causas: [
        causa({
          tipo: ML_CAUSA_TIPO.aviso,
          mensagem: 'AGE_GROUP adicionado',
          campos: ['attributes.AGE_GROUP'],
        }),
      ],
    });
    // ML applied it itself — a red field here reports a problem that is not one.
    expect(split.porCampo).toEqual({});
    expect(split.gerais).toEqual([]);
    expect(split.avisos).toHaveLength(1);
  });

  it('treats an UNLABELLED cause as blocking, not as a warning', () => {
    // A shape we failed to classify is still something the operator must act on.
    const split = splitCausas({ causas: [causa({ tipo: null, mensagem: 'sem tipo' })] });
    expect(split.gerais).toHaveLength(1);
    expect(split.avisos).toEqual([]);
  });

  it('stacks two causes landing on the same control', () => {
    const split = splitCausas({
      causas: [
        causa({ mensagem: 'muito curto', campos: ['title'] }),
        causa({ mensagem: 'gênero divergente', campos: ['title'] }),
      ],
    });
    expect(split.porCampo.title).toEqual(['muito curto', 'gênero divergente']);
  });

  it('ignores an entry with no message rather than rendering a blank line', () => {
    expect(splitCausas({ causas: [causa({ mensagem: '' })] }).temCausas).toBe(false);
  });
});

describe('erroDoCampo / errosDeAtributos', () => {
  it('gives a control its first message — an input holds one line', () => {
    expect(erroDoCampo({ title: ['a', 'b'] }, 'title')).toBe('a');
    expect(erroDoCampo({ title: ['a'] }, 'category_id')).toBeUndefined();
    expect(erroDoCampo(undefined, 'title')).toBeUndefined();
  });

  it('re-keys the attribute controls by bare ML attribute id', () => {
    // `AtributosSection` takes `Record<attributeId, string>` — merging into that
    // is what makes server causes reuse the existing per-row error channel.
    expect(errosDeAtributos({ 'attributes.BRAND': ['falta'], title: ['x'] })).toEqual({
      BRAND: 'falta',
    });
  });
});

describe('textoDaCausa / mergeServerErrors', () => {
  it('appends the raw ML references, so an unmapped path is still actionable', () => {
    expect(
      textoDaCausa(causa({ mensagem: 'ME2 obrigatório', referencias: ['shipping.modes'] })),
    ).toBe('ME2 obrigatório (shipping.modes)');
    expect(textoDaCausa(causa({ mensagem: 'sozinha' }))).toBe('sozinha');
  });

  it('keeps both sources when ML and the pre-flight blame the same control', () => {
    expect(
      mergeServerErrors({ category_id: ['ML recusou'] }, { category_id: ['nem enviamos'] }),
    ).toEqual({ category_id: ['ML recusou', 'nem enviamos'] });
  });
});
