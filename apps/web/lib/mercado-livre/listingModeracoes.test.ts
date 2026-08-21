import { describe, expect, it } from 'vitest';
import type { MlModeracao } from '@delfrance/schemas';

import { linkFixture } from './linkFixture';
import {
  SECAO_LABELS,
  corDaModeracao,
  moderacoesDoLink,
  moderacoesPorCampo,
  secaoLabel,
  secoesLabel,
  severidadeModeracao,
} from './listingModeracoes';

const moderacaoFixture = (over: Partial<MlModeracao> = {}): MlModeracao => ({
  nome: 'POOR_QUALITY_THUMBNAIL',
  dataCriacao: null,
  motivo: 'Seu anúncio foi pausado porque descumpre nossas políticas.',
  remedio: 'Substitua as fotos.',
  secoes: ['pictures'],
  evidencias: [],
  ...over,
});

describe('severidadeModeracao', () => {
  it('reason + remedy is the fixable case', () => {
    expect(severidadeModeracao(moderacaoFixture())).toBe('com-conserto');
  });

  /**
   * ML's docs: a removed listing returns REASON and no REMEDY *because there is
   * no way back*. This is the ONLY state the UI may describe as unrecoverable.
   */
  it('reason with no remedy is unrecoverable', () => {
    expect(severidadeModeracao(moderacaoFixture({ remedio: null }))).toBe('sem-conserto');
  });

  /**
   * ⚠️ THE distinction this type exists for. `sem-motivo` also carries
   * `remedio: null`, so a boolean on `remedio` alone would call it unrecoverable
   * — telling the operator to abandon a listing ML merely failed to explain.
   */
  it('no reason at all is NOT unrecoverable — it is unexplained', () => {
    const semTexto = moderacaoFixture({ motivo: null, remedio: null });
    expect(severidadeModeracao(semTexto)).toBe('sem-motivo');
    expect(severidadeModeracao(semTexto)).not.toBe('sem-conserto');
  });

  /**
   * Trim-aware on a RAW entry too, not only on one `moderacoesDoLink` already
   * normalised — this is exported, so it has to be right for whoever calls it.
   */
  it('treats a blank reason as no reason, even unnormalised', () => {
    expect(severidadeModeracao(moderacaoFixture({ motivo: '   ', remedio: null }))).toBe(
      'sem-motivo',
    );
    expect(severidadeModeracao(moderacaoFixture({ remedio: '  ' }))).toBe('sem-conserto');
  });
});

describe('corDaModeracao', () => {
  it('red only when something really is unrecoverable', () => {
    expect(corDaModeracao([moderacaoFixture({ remedio: null })])).toBe('red');
  });

  it('orange for an unexplained moderation, yellow for a fixable one', () => {
    expect(corDaModeracao([moderacaoFixture({ motivo: null, remedio: null })])).toBe('orange');
    expect(corDaModeracao([moderacaoFixture()])).toBe('yellow');
  });

  it('the WORST entry decides the block, whatever the order', () => {
    const fixavel = moderacaoFixture();
    const terminal = moderacaoFixture({ nome: 'DENYLIST', remedio: null });
    expect(corDaModeracao([fixavel, terminal])).toBe('red');
    expect(corDaModeracao([terminal, fixavel])).toBe('red');
  });

  it('never throws on an empty list', () => {
    expect(typeof corDaModeracao([])).toBe('string');
  });
});

describe('moderacoesDoLink', () => {
  it('reads nothing from a link that has none', () => {
    expect(moderacoesDoLink(linkFixture())).toEqual([]);
    expect(moderacoesDoLink({ moderacoes: null })).toEqual([]);
  });

  it('keeps a name-only entry — ML moderated it and sent no prose', () => {
    const semTexto = moderacaoFixture({ motivo: null, remedio: null });
    expect(moderacoesDoLink({ moderacoes: [semTexto] })).toEqual([semTexto]);
  });

  /**
   * ⚠️ Not redundant with the backend gate. Every field on `mlModeracaoSchema` is
   * nullable and the shape is `.passthrough()`, so an entry saying nothing PARSES
   * — and this reads documents the Flutter app and a legacy corpus also touched.
   * Rendering one would produce an alert with no content, which is the "red alert
   * saying nothing" the whole feature exists to avoid.
   */
  it('drops an entry with neither reason nor filter name', () => {
    const vazio = moderacaoFixture({ motivo: null, nome: null, remedio: null });
    expect(moderacoesDoLink({ moderacoes: [vazio] })).toEqual([]);
    expect(
      moderacoesDoLink({ moderacoes: [moderacaoFixture({ motivo: null, nome: '  ' })] }),
    ).toEqual([]);
  });

  /**
   * ⚠️ The contract every consumer downstream relies on. Without it a
   * `motivo: '   '` entry clears the visibility gate on its `nome`, then passes
   * a plain `motivo == null` test as a REAL reason — classified `sem-conserto`
   * and rendered as an EMPTY reason under the red "não pode ser reativado".
   *
   * Normalising once here makes that unrepresentable, instead of requiring a
   * trim-aware predicate at each of the six places a field is read and being
   * one oversight away from the bug.
   */
  it('blanks become null, so `== null` is right downstream', () => {
    const [m] = moderacoesDoLink({
      moderacoes: [
        moderacaoFixture({
          nome: ' DENYLIST ',
          motivo: '   ',
          remedio: '\t',
          secoes: [' title ', ''],
        }),
      ],
    });
    expect(m?.motivo).toBeNull();
    expect(m?.remedio).toBeNull();
    // Trimmed, not merely kept — the `nome` is what this entry survived on.
    expect(m?.nome).toBe('DENYLIST');
    expect(m?.secoes).toEqual(['title']);
  });

  it('a blank motivo is unexplained, never a removal', () => {
    const [m] = moderacoesDoLink({
      moderacoes: [moderacaoFixture({ nome: 'DENYLIST', motivo: '   ', remedio: null })],
    });
    expect(severidadeModeracao(m!)).toBe('sem-motivo');
  });
});

describe('secaoLabel', () => {
  it('translates the four sections ML documents', () => {
    expect(secaoLabel('pictures')).toBe('Fotos');
    expect(secaoLabel('title')).toBe('Título');
    expect(secaoLabel('category')).toBe('Categoria');
    expect(secaoLabel('item')).toBe('Anúncio');
  });

  /**
   * ML is free to add a fifth section. An unknown one must still tell the
   * operator where to look rather than vanish — the same fallback `estadoLabel`
   * uses for an unrecognised estado code.
   */
  it('falls back to the RAW value for a section ML has not documented', () => {
    expect(secaoLabel('description')).toBe('description');
    expect(SECAO_LABELS.description).toBeUndefined();
  });

  it('de-duplicates when two evidences name the same section', () => {
    expect(secoesLabel(['pictures', 'pictures', 'title'])).toBe('Fotos, Título');
  });
});

describe('moderacoesPorCampo', () => {
  it('pins a title moderation to the título control', () => {
    const link = { moderacoes: [moderacaoFixture({ secoes: ['title'], motivo: 'Título ruim' })] };
    expect(moderacoesPorCampo(link)).toEqual({ title: ['Título ruim'] });
  });

  it('pins a category moderation to the categoria control', () => {
    const link = {
      moderacoes: [moderacaoFixture({ secoes: ['category'], motivo: 'Categoria errada' })],
    };
    expect(moderacoesPorCampo(link)).toEqual({ category_id: ['Categoria errada'] });
  });

  /**
   * ⚠️ Neither resolves to a control — the photos are managed outside this form
   * and `item` names the whole listing. That is precisely why the strip lists
   * every moderation unconditionally instead of depending on this mapping.
   */
  it('maps pictures and item to NO control at all', () => {
    expect(
      moderacoesPorCampo({ moderacoes: [moderacaoFixture({ secoes: ['pictures'] })] }),
    ).toEqual({});
    expect(moderacoesPorCampo({ moderacoes: [moderacaoFixture({ secoes: ['item'] })] })).toEqual(
      {},
    );
    expect(moderacoesPorCampo({ moderacoes: [moderacaoFixture({ secoes: [] })] })).toEqual({});
  });

  /**
   * ⚠️ Our sentence, explicitly framed — never the bare `POOR_QUALITY_THUMBNAIL`.
   * The schema forbids storing `nome` as the reason because a raw
   * SCREAMING_SNAKE id reads as ML's own prose; the framing is what makes showing
   * it honest here.
   */
  it('frames a name-only moderation instead of printing the raw filter id', () => {
    const link = {
      moderacoes: [moderacaoFixture({ motivo: null, remedio: null, secoes: ['title'] })],
    };
    const mensagem = moderacoesPorCampo(link).title?.[0] ?? '';
    expect(mensagem).toContain('Moderado pelo Mercado Livre');
    expect(mensagem).toContain('POOR_QUALITY_THUMBNAIL');
    expect(mensagem).not.toBe('POOR_QUALITY_THUMBNAIL');
  });

  it('collects two moderations onto the same control', () => {
    const link = {
      moderacoes: [
        moderacaoFixture({ secoes: ['title'], motivo: 'A' }),
        moderacaoFixture({ secoes: ['title'], motivo: 'B' }),
      ],
    };
    expect(moderacoesPorCampo(link)).toEqual({ title: ['A', 'B'] });
  });

  it('does not duplicate a message when one moderation repeats a section', () => {
    const link = {
      moderacoes: [moderacaoFixture({ secoes: ['title', 'title'], motivo: 'Título ruim' })],
    };
    expect(moderacoesPorCampo(link)).toEqual({ title: ['Título ruim'] });
  });
});
