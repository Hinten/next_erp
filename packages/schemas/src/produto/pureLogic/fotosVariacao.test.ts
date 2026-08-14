import { describe, expect, it } from 'vitest';
import type { Foto } from '../../storage/foto';
import { fotosForVariacao } from './fotosVariacao';
import { varianteFakePath } from './variacoes';

/** A photo, optionally tagged for one variante. */
function foto(id: string, variantePath: string | null = null): Foto {
  return {
    arquivoOuterRef: `arquivos/${id}`,
    arquivo200pxOuterRef: null,
    arquivo400pxOuterRef: null,
    arquivoJpegOuterRef: null,
    grupoDeVariacoesOuterRef: variantePath ? 'documents/grupoDeVariacoes/g-cor' : null,
    variantePath,
  };
}

const AZUL = varianteFakePath('g-cor', 'v-azul');
const PRETO = varianteFakePath('g-cor', 'v-preto');

describe('fotosForVariacao', () => {
  it('rung 1: the child’s own fotos win outright', () => {
    const own = [foto('own-1')];
    expect(fotosForVariacao(own, [foto('pai-1')], [AZUL])).toEqual(own);
  });

  it('rung 2: the parent photos tagged for one of the child’s variacoesUid', () => {
    const parent = [foto('pai-1', PRETO), foto('pai-2', AZUL), foto('pai-3')];
    expect(fotosForVariacao(null, parent, [AZUL])).toEqual([foto('pai-2', AZUL)]);
  });

  it('rung 3: every parent photo when nothing is tagged for this child', () => {
    const parent = [foto('pai-1', PRETO), foto('pai-2')];
    // ML requires every variation to carry a picture, so "no match" cannot mean
    // "no pictures" — it means the whole parent gallery.
    expect(fotosForVariacao(null, parent, [AZUL])).toEqual(parent);
  });

  it('rung 3 also covers a child with no variacoesUid at all', () => {
    const parent = [foto('pai-1', PRETO)];
    expect(fotosForVariacao(null, parent, [])).toEqual(parent);
    expect(fotosForVariacao([], parent, null)).toEqual(parent);
  });

  it('emits each matching photo ONCE, in parent order', () => {
    // The legacy loops per variacoesUid and concatenates the matches of each, so
    // a photo reachable from two uids went out twice — a repeated picture_id.
    const parent = [foto('pai-1', AZUL), foto('pai-2', PRETO)];
    expect(fotosForVariacao(null, parent, [PRETO, AZUL])).toEqual(parent);
  });

  it('does not cross-match two groups that share a variante id', () => {
    // `Foto2.ehAMesmaVariacao` compares the last two path segments, the second
    // of which is the literal `variacoes` — so it matched on the variante id
    // alone. The importer's `n-<slug>` fallback makes that collision real.
    const parent = [foto('pai-1', varianteFakePath('g-sabor', 'n-azul'))];
    const resolved = fotosForVariacao(null, parent, [varianteFakePath('g-cor', 'n-azul')]);
    expect(resolved).toEqual(parent); // rung 3, NOT a tagged match
  });

  it('an untagged photo never matches a uid', () => {
    const parent = [foto('pai-1'), foto('pai-2', AZUL)];
    expect(fotosForVariacao(null, parent, [AZUL])).toEqual([foto('pai-2', AZUL)]);
  });

  it('no parent photos and no own photos → empty', () => {
    expect(fotosForVariacao(null, null, [AZUL])).toEqual([]);
    expect(fotosForVariacao([], [], [AZUL])).toEqual([]);
  });
});
