import { describe, expect, it } from 'vitest';

import { attributeIdsInMessage, mapPublishIssue, mapPublishIssues } from './publishIssues';

describe('mapPublishIssue', () => {
  it('routes the parenthesised field keys the server embeds', () => {
    expect(mapPublishIssue('categoria do Mercado Livre não definida (category_id)')).toMatchObject({
      scope: 'listing',
      field: 'category_id',
    });
    expect(mapPublishIssue('tipo de anúncio não definido (listing_type_id)')).toMatchObject({
      scope: 'listing',
      field: 'listing_type_id',
    });
    expect(mapPublishIssue('integração sem tabela de preços (tabelaNormalOuterRef)')).toMatchObject(
      { scope: 'integracao', field: null },
    );
  });

  it('routes the prose issues to the tab that can fix them', () => {
    expect(mapPublishIssue('produto "Camiseta" sem preço na tabela lista-1')).toMatchObject({
      scope: 'produto',
      produtoSection: 'Preço e custo',
    });
    expect(mapPublishIssue('produto sem fotos')).toMatchObject({
      scope: 'produto',
      produtoSection: 'Fotos',
    });
    expect(mapPublishIssue('produto sem nome')).toMatchObject({
      scope: 'produto',
      produtoSection: 'Dados gerais',
    });
    expect(mapPublishIssue('variação "M" sem atributos de combinação')).toMatchObject({
      scope: 'variacao',
    });
    expect(
      mapPublishIssue('variação "M": caminho de variação inválido (documents/x)'),
    ).toMatchObject({ scope: 'variacao' });
  });

  it('falls back to a whole-listing banner rather than guessing', () => {
    // Every issue is ALSO rendered verbatim in the alert, so a miss loses
    // nothing — it just doesn't highlight a control.
    const target = mapPublishIssue('algo totalmente novo que o servidor passou a enviar');
    expect(target).toEqual({
      scope: 'listing',
      field: null,
      produtoSection: null,
      message: 'algo totalmente novo que o servidor passou a enviar',
    });
  });

  it('never loses the original text', () => {
    const issue = 'produto sem fotos';
    expect(mapPublishIssue(issue).message).toBe(issue);
  });
});

describe('mapPublishIssues', () => {
  it('prefers the structured issueDetails when the server sends them', () => {
    const mapped = mapPublishIssues(
      ['prosa que seria mapeada por regex'],
      [{ path: 'attributes.BRAND', message: 'Marca é obrigatória' }],
    );
    expect(mapped).toEqual([
      {
        scope: 'listing',
        field: 'attributes.BRAND',
        produtoSection: null,
        message: 'Marca é obrigatória',
      },
    ]);
  });

  it('falls back to the prose table against today’s server', () => {
    const mapped = mapPublishIssues(['produto sem fotos'], null);
    expect(mapped[0]).toMatchObject({ scope: 'produto', produtoSection: 'Fotos' });
  });

  it('handles an absent issues array', () => {
    expect(mapPublishIssues(null)).toEqual([]);
  });
});

describe('attributeIdsInMessage', () => {
  it('highlights only tokens that are real attribute ids', () => {
    const msg = 'O atributo BRAND é obrigatório para esta categoria';
    expect(attributeIdsInMessage(msg, ['BRAND', 'MODEL'])).toEqual(['BRAND']);
  });

  it('never highlights an unrelated uppercase word', () => {
    // A blind SCREAMING_SNAKE regex would light up random words in Portuguese
    // prose (and ML error bodies are full of them).
    expect(attributeIdsInMessage('ERRO INTERNO no item MLB123', ['BRAND'])).toEqual([]);
  });

  it('de-duplicates repeated mentions', () => {
    expect(attributeIdsInMessage('BRAND e BRAND de novo', ['BRAND'])).toEqual(['BRAND']);
  });
});
