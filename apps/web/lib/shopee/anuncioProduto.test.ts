import { describe, expect, it } from 'vitest';
import {
  ESTADO_ANUNCIO_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  estadoAnuncioShopeeSchema,
  tipoAcaoSugeridaPublicacaoShopeeSchema,
} from '@delfrance/schemas';

import {
  COR_ESTADO_ANUNCIO_SHOPEE,
  FRASE_PRIMEIRA_PUBLICACAO_SHOPEE,
  FRASE_RECUSA_SEM_PASSO_SHOPEE,
  ROTULO_ESTADO_ANUNCIO_SHOPEE,
  TEXTO_ACAO_SUGERIDA,
  ehFraseDeTerminal,
  estadoAnuncioShopeeLido,
  formatarInstanteShopee,
  itemIdDoAnuncioShopee,
  ordenarVinculosShopee,
  resumoDaReverificacaoShopee,
  textoDaEtapaShopee,
  textoDoProblemaShopee,
  urlDoAnuncioShopee,
} from './anuncioProduto';
import type { RespostaReverificarShopee } from './wire';

/**
 * T6 (reconcile §4, PR 6): the tab's pure display helpers — the storefront URL,
 * the label maps and the order one conta's links are listed in. The order's
 * "live" is `anuncioShopeeVivo` from `@delfrance/schemas` (K1-m2), so the
 * near-misses below are chosen where a plausible web copy would disagree with it.
 *
 * PR 7: the copy of the actions — `TEXTO_ACAO_SUGERIDA`, the one reader of a
 * refusal row (`textoDoProblemaShopee`) and the re-verify toast. Lens 8: no
 * string the tab renders may carry CLI text.
 */

/** CLI copy, by the server-side pin's own shape plus the word "comando" (lens 8). */
const TEXTO_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio|comando/i;

describe('urlDoAnuncioShopee', () => {
  it('builds the storefront page from two positive safe integers', () => {
    expect(urlDoAnuncioShopee(987654, 1000001)).toBe(
      'https://shopee.com.br/product/987654/1000001',
    );
  });

  it('gives no URL unless BOTH ids can address something (never /product/null/…)', () => {
    expect(urlDoAnuncioShopee(987654, null)).toBeNull(); // a draft link
    expect(urlDoAnuncioShopee(null, 1000001)).toBeNull(); // a conta never connected
    expect(urlDoAnuncioShopee(undefined, 1000001)).toBeNull();
    expect(urlDoAnuncioShopee(987654, 0)).toBeNull();
    expect(urlDoAnuncioShopee(987654, -1)).toBeNull();
    expect(urlDoAnuncioShopee(987654, 1.5)).toBeNull();
    expect(urlDoAnuncioShopee(987654, Number.NaN)).toBeNull();
    // NEAR-MISS: the right digits as a STRING are not an id the schema stores.
    expect(urlDoAnuncioShopee(987654, '1000001')).toBeNull();
    // NEAR-MISS: finite but past 2^53 — the digits would not be the stored ones.
    expect(urlDoAnuncioShopee(987654, 2 ** 53 + 2)).toBeNull();
  });
});

describe('itemIdDoAnuncioShopee', () => {
  it('prints the stored id of a published listing, and nothing for a draft', () => {
    expect(itemIdDoAnuncioShopee(1000001)).toBe(1000001);
    expect(itemIdDoAnuncioShopee(null)).toBeNull();
    expect(itemIdDoAnuncioShopee(0)).toBeNull();
    // NEAR-MISS: the digits as text are not a stored id.
    expect(itemIdDoAnuncioShopee('1000001')).toBeNull();
  });
});

describe('the estado label maps', () => {
  it('name every member of the folded vocabulary, and nothing else', () => {
    const membros = [...estadoAnuncioShopeeSchema.options].sort();
    expect(Object.keys(ROTULO_ESTADO_ANUNCIO_SHOPEE).sort()).toEqual(membros);
    expect(Object.keys(COR_ESTADO_ANUNCIO_SHOPEE).sort()).toEqual(membros);
  });

  it('reads an unknown or absent stored estado as "never folded", never as a member', () => {
    expect(estadoAnuncioShopeeLido(ESTADO_ANUNCIO_SHOPEE.emRevisao)).toBe(
      ESTADO_ANUNCIO_SHOPEE.emRevisao,
    );
    expect(estadoAnuncioShopeeLido(null)).toBeNull();
    expect(estadoAnuncioShopeeLido(undefined)).toBeNull();
    // NEAR-MISS: a string outside the vocabulary is not "removido" nor "desconhecido".
    expect(estadoAnuncioShopeeLido('arquivado')).toBeNull();
    expect(estadoAnuncioShopeeLido('Removido')).toBeNull();
  });
});

describe('formatarInstanteShopee', () => {
  it('formats a millisecond stamp in São Paulo, whatever the machine’s zone', () => {
    // 2026-10-01T03:00:00Z is São Paulo's midnight.
    expect(formatarInstanteShopee(Date.UTC(2026, 9, 1, 3, 0))).toBe('01/10/2026, 00:00');
  });

  it('answers null for anything that is not a finite number', () => {
    expect(formatarInstanteShopee(null)).toBeNull();
    expect(formatarInstanteShopee('1790823600000')).toBeNull();
    expect(formatarInstanteShopee(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('answers null — never throws — for a finite stamp outside the ECMAScript time range', () => {
    // `Intl.DateTimeFormat#format` throws a RangeError past ±8.64e15: one such
    // stored stamp would crash the whole tab mid-render.
    expect(() => formatarInstanteShopee(8.64e15 + 1)).not.toThrow();
    expect(formatarInstanteShopee(8.64e15 + 1)).toBeNull();
    expect(formatarInstanteShopee(-8.64e15 - 1)).toBeNull();
    expect(formatarInstanteShopee(Number.MAX_VALUE)).toBeNull();
  });

  it('NEAR-MISS: still formats the range’s own edges', () => {
    // +275760-09-13T00:00Z (São Paulo, UTC−3) and its mirror — the last
    // instants a Date can hold. The bound is inclusive.
    expect(formatarInstanteShopee(8.64e15)).toBe('12/09/275760, 21:00');
    expect(formatarInstanteShopee(-8.64e15)).not.toBeNull();
  });
});

describe('ordenarVinculosShopee', () => {
  const v = (id: string, data: Record<string, unknown>) => ({ id, data });
  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

  it('lists live, then superseded, then removed, whatever the input order', () => {
    const removido = v('a-removido', {
      item_id: 1000001,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      publicadoEm: 300,
    });
    const substituido = v('b-substituido', {
      item_id: 1000002,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: 'z-vivo',
      publicadoEm: 200,
    });
    const vivo = v('z-vivo', {
      item_id: 1000003,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      publicadoEm: 100,
    });
    expect(ids(ordenarVinculosShopee([removido, substituido, vivo]))).toEqual([
      'z-vivo',
      'b-substituido',
      'a-removido',
    ]);
  });

  it('treats a never-folded link (estadoAnuncio null) as live, and a draft (item_id null) as not', () => {
    const naoVerificado = v('b', { item_id: 1000001, estadoAnuncio: null });
    const pausado = v('c', { item_id: 1000002, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const rascunho = v('a', { item_id: null, estadoAnuncio: null });
    expect(ids(ordenarVinculosShopee([rascunho, pausado, naoVerificado]))).toEqual(['b', 'c', 'a']);
  });

  it('takes "live" from the schemas predicate, not a web copy of it (NEAR-MISSES)', () => {
    // `anuncioShopeeVivo` tests `isFinite`, not `isSafeInteger`: an id past
    // 2^53 is still a survivor there, so it must sort with the live ones here.
    const grande = v('b-grande', { item_id: 2 ** 53 + 2, estadoAnuncio: null });
    // …and a STRINGIFIED id is NOT alive there (the recorded false-negative
    // direction), so a `Number(item_id)` copy would wrongly lift it.
    const textual = v('a-textual', { item_id: '1000001', estadoAnuncio: null });
    // A superseded link that is also removed is dead first: not "superseded".
    const substituidoMorto = v('a-subst-morto', {
      item_id: 1000004,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      substituidoPorLinkDocId: 'outro',
      publicadoEm: 999,
    });
    // An EMPTY pointer is "not superseded" for `ehVinculoSubstituido` — its id
    // sorts AFTER the superseded one's, so only the group can put it first.
    const ponteiroVazio = v('e-vazio', {
      item_id: 1000005,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: '',
    });
    const substituido = v('d-subst', {
      item_id: 1000006,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      substituidoPorLinkDocId: 'e-vazio',
    });
    expect(
      ids(ordenarVinculosShopee([textual, substituidoMorto, substituido, ponteiroVazio, grande])),
    ).toEqual(['b-grande', 'e-vazio', 'd-subst', 'a-subst-morto', 'a-textual']);
  });

  it('within a group: most recently published first, never-published last, then the doc id', () => {
    const antigo = v('a', { item_id: 1, estadoAnuncio: null, publicadoEm: 100 });
    const recente = v('b', { item_id: 2, estadoAnuncio: null, publicadoEm: 200 });
    const semData = v('c', { item_id: 3, estadoAnuncio: null, publicadoEm: null });
    const semDataAntes = v('0', { item_id: 4, estadoAnuncio: null });
    expect(ids(ordenarVinculosShopee([semData, antigo, semDataAntes, recente]))).toEqual([
      'b',
      'a',
      '0',
      'c',
    ]);
  });

  it('returns a new array and leaves the input untouched', () => {
    const entrada = [v('b', { item_id: null }), v('a', { item_id: 1 })];
    const saida = ordenarVinculosShopee(entrada);
    expect(saida).not.toBe(entrada);
    expect(ids(entrada)).toEqual(['b', 'a']);
  });
});

describe('TEXTO_ACAO_SUGERIDA', () => {
  it('names every tipo of the shared vocabulary, and nothing else', () => {
    expect(Object.keys(TEXTO_ACAO_SUGERIDA).sort()).toEqual(
      [...tipoAcaoSugeridaPublicacaoShopeeSchema.options].sort(),
    );
  });

  it('never carries CLI text (lens 8)', () => {
    for (const texto of [
      ...Object.values(TEXTO_ACAO_SUGERIDA),
      FRASE_PRIMEIRA_PUBLICACAO_SHOPEE,
      FRASE_RECUSA_SEM_PASSO_SHOPEE,
    ]) {
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });

  it('words the import as a condition, never a promise (residual 24)', () => {
    const importar = TEXTO_ACAO_SUGERIDA[TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar];
    expect(importar).toContain('importação em massa');
    expect(importar).toContain('se ele ainda não estiver vinculado a nenhum produto');
    expect(importar).toContain('se nenhum outro produto tiver o mesmo SKU');
  });
});

describe('ehFraseDeTerminal', () => {
  it('flags a flag, a script name and the word "comando"', () => {
    expect(ehFraseDeTerminal('publique sem --link')).toBe(true);
    expect(ehFraseDeTerminal('--recriar no início')).toBe(true);
    expect(ehFraseDeTerminal('rode publicar:anuncio de novo')).toBe(true);
    expect(ehFraseDeTerminal('rode exatamente o mesmo comando de novo')).toBe(true);
    expect(ehFraseDeTerminal('Comandos do terminal')).toBe(true);
  });

  it('leaves a mechanism sentence alone (NEAR-MISSES)', () => {
    // A slug is hyphenated, never double-dashed after a space.
    expect(ehFraseDeTerminal('motivo kit-ja-existe-na-shopee')).toBe(false);
    // An em dash is prose; "anúncio" without the colon is a word.
    expect(ehFraseDeTerminal('o anúncio — ele foi removido')).toBe(false);
    expect(ehFraseDeTerminal('anuncio removido')).toBe(false);
    // "comando" only as a word.
    expect(ehFraseDeTerminal('o comandante da loja')).toBe(false);
  });
});

describe('textoDoProblemaShopee', () => {
  const T = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;
  const CLI = 'publique com --link L1 --recriar (importar:anuncio)';

  it('never shows the server sentence for a row WITH an acao — the ids come from the acao', () => {
    const recriar = textoDoProblemaShopee({
      mensagem: CLI,
      acao: { tipo: T.recriar, linkDocId: 'L1' },
    });
    expect(recriar).toBe(`${TEXTO_ACAO_SUGERIDA[T.recriar]} Vínculo: L1.`);
    const importar = textoDoProblemaShopee({
      mensagem: CLI,
      acao: { tipo: T.importar, itemIds: [1000009, 1000010] },
    });
    expect(importar).toBe(
      `${TEXTO_ACAO_SUGERIDA[T.importar]} Anúncio(s) na Shopee: 1000009, 1000010.`,
    );
    const escolher = textoDoProblemaShopee({
      mensagem: CLI,
      acao: { tipo: T.escolherVinculo, linkDocIds: ['L1', 'L2'] },
    });
    expect(escolher).toBe(`${TEXTO_ACAO_SUGERIDA[T.escolherVinculo]} Vínculos: L1, L2.`);
    for (const acao of [{ tipo: T.semOpcoesDeKit }, { tipo: T.informarPrincipal }] as const) {
      expect(textoDoProblemaShopee({ mensagem: CLI, acao })).toBe(TEXTO_ACAO_SUGERIDA[acao.tipo]);
    }
    for (const t of [recriar, importar, escolher]) expect(t).not.toMatch(TEXTO_DE_TERMINAL);
  });

  it('an `importar` hit a link already holds names its produto, never the mass import (R5-08)', () => {
    const MASSA = 'importação em massa';
    // One held, one free, in the same row: worded APART.
    const misto = textoDoProblemaShopee({
      mensagem: CLI,
      acao: {
        tipo: T.importar,
        itemIds: [1000009, 1000010],
        vinculados: [{ itemId: 1000010, produtoId: 'prod-2' }],
      },
    });
    expect(misto).toContain(MASSA);
    expect(misto).toContain('Anúncio(s) na Shopee sem vínculo: 1000009.');
    expect(misto).toContain(
      'O anúncio 1000010 já está vinculado ao produto prod-2 — a importação não o muda; confira o SKU desse produto.',
    );
    expect(misto).not.toContain('O anúncio 1000009');

    // Every hit held: the mass-import sentence goes — it cannot help any of them.
    const todos = textoDoProblemaShopee({
      mensagem: CLI,
      acao: {
        tipo: T.importar,
        itemIds: [1000010],
        vinculados: [{ itemId: 1000010, produtoId: 'prod-2' }],
      },
    });
    expect(todos).not.toContain(MASSA);
    expect(todos).toContain('Já existe na Shopee um kit com o SKU deste produto — não crie outro.');
    expect(todos).toContain('O anúncio 1000010 já está vinculado ao produto prod-2');

    // The server reported NONE held: every id is a mass-import candidate.
    const nenhum = textoDoProblemaShopee({
      mensagem: CLI,
      acao: { tipo: T.importar, itemIds: [1000009], vinculados: [] },
    });
    expect(nenhum).toBe(
      `${TEXTO_ACAO_SUGERIDA[T.importar]} Anúncio(s) na Shopee sem vínculo: 1000009.`,
    );
    for (const t of [misto, todos, nenhum]) expect(t).not.toMatch(TEXTO_DE_TERMINAL);
  });

  it('NEAR-MISS: an `importar` from a server that does not report `vinculados` reads as before', () => {
    for (const vinculados of [undefined, null]) {
      expect(
        textoDoProblemaShopee({
          mensagem: CLI,
          acao: { tipo: T.importar, itemIds: [1000009, 1000010], vinculados },
        }),
      ).toBe(`${TEXTO_ACAO_SUGERIDA[T.importar]} Anúncio(s) na Shopee: 1000009, 1000010.`);
    }
  });

  it('a republish names its link, or says there is none — never offering a publish with no link', () => {
    expect(
      textoDoProblemaShopee({ mensagem: CLI, acao: { tipo: T.republicar, linkDocId: 'L2' } }),
    ).toBe(`${TEXTO_ACAO_SUGERIDA[T.republicar]} Vínculo: L2.`);
    const semVinculo = textoDoProblemaShopee({
      mensagem: CLI,
      acao: { tipo: T.republicar, linkDocId: null },
    });
    expect(semVinculo).toContain('O vínculo não foi indicado');
    expect(semVinculo).not.toContain('Vínculo:');
  });

  it('shows a row WITHOUT an acao as it is, unless the sentence was written for a terminal', () => {
    expect(
      textoDoProblemaShopee({ mensagem: 'A categoria não aceita este atributo.', acao: null }),
    ).toBe('A categoria não aceita este atributo.');
    expect(
      textoDoProblemaShopee({ mensagem: 'rode exatamente o mesmo comando de novo', acao: null }),
    ).toBe(FRASE_RECUSA_SEM_PASSO_SHOPEE);
  });
});

describe('textoDaEtapaShopee', () => {
  /** apps/shopee's `EtapaPublicacao` (`errosPublicacao.ts`), all thirteen. */
  const ETAPAS = [
    'fotos',
    'add_item',
    'update_item',
    'init_tier_variation',
    'update_tier_variation',
    'add_model',
    'update_model',
    'get_model_list',
    'relistagem',
    'leitura-de-volta',
    'add_kit_item',
    'update_kit_item',
    'delete_item',
  ];
  const DESCONHECIDA = 'uma etapa que esta tela ainda não descreve';

  it('labels every step the server names, and never prints the raw code', () => {
    for (const etapa of ETAPAS) {
      const texto = textoDaEtapaShopee(etapa);
      expect(texto, etapa).toMatch(/^Recusada na etapa: .+\. Escritas anteriores/);
      // `fotos` is a pt-BR word as well as a code; every other code is a slug.
      if (etapa !== 'fotos') expect(texto, etapa).not.toContain(etapa);
      expect(texto, etapa).not.toContain(DESCONHECIDA);
      expect(texto, etapa).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });

  it('says a refused create created nothing — the one fact the step alone settles', () => {
    expect(textoDaEtapaShopee('add_kit_item')).toContain('a Shopee não criou o kit');
    expect(textoDaEtapaShopee('add_item')).toContain('a Shopee não criou o anúncio');
  });

  it('NEAR-MISS: an unknown step, or an inherited property name, gets the neutral label', () => {
    for (const etapa of ['etapa_nova', 'toString', '__proto__', 'constructor', '']) {
      const texto = textoDaEtapaShopee(etapa);
      expect(texto, etapa).toContain(DESCONHECIDA);
      expect(texto, etapa).not.toContain('undefined');
    }
  });
});

describe('resumoDaReverificacaoShopee', () => {
  const r = (extra: Partial<RespostaReverificarShopee> = {}): RespostaReverificarShopee => ({
    acao: 'atualizado',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    deboost: false,
    violacoes: [],
    violacoesLidas: true,
    modelos: null,
    avisoResolvido: false,
    avisoReceitaKit: null,
    ...extra,
  });

  it('keys the toast on the route’s acao, and titles it with the state the ERP now holds', () => {
    expect(resumoDaReverificacaoShopee(r())).toEqual({
      cor: 'green',
      titulo: 'Anúncio reverificado — Ativo',
      mensagem: 'O ERP atualizou o anúncio com o que a Shopee informa agora.',
    });
    expect(resumoDaReverificacaoShopee(r({ acao: 'ignorado-sem-mudanca' })).mensagem).toBe(
      'Nada mudou desde a última leitura.',
    );
    const removido = resumoDaReverificacaoShopee(
      r({ acao: 'removido', estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    );
    expect(removido.cor).toBe('orange');
    expect(removido.titulo).toBe('Anúncio reverificado — Removido');
  });

  it('answers a value this build does not know with the neutral sentence, never a crash', () => {
    expect(resumoDaReverificacaoShopee(r({ acao: 'novo-desfecho' })).mensagem).toBe(
      'A Shopee respondeu à reverificação.',
    );
    // NEAR-MISS: a prototype member is not one of the three.
    expect(resumoDaReverificacaoShopee(r({ acao: 'constructor' })).mensagem).toBe(
      'A Shopee respondeu à reverificação.',
    );
  });

  it('adds what else the run found: deboost, unread violations, models gone, the kit aviso', () => {
    const tudo = resumoDaReverificacaoShopee(
      r({
        deboost: true,
        violacoesLidas: false,
        modelos: { total: 3, atualizados: 1, ausentes: 2 },
        avisoReceitaKit: 'resolvido',
      }),
    );
    expect(tudo.mensagem).toBe(
      'O ERP atualizou o anúncio com o que a Shopee informa agora. Ele está rebaixado na busca. ' +
        'As violações não puderam ser lidas agora — as mostradas são as guardadas. ' +
        '2 variação(ões) não estão mais na Shopee. O aviso de composição do kit foi resolvido.',
    );
    expect(resumoDaReverificacaoShopee(r({ avisoReceitaKit: 'aberto' })).mensagem).toContain(
      'continua aberto',
    );
    expect(resumoDaReverificacaoShopee(r({ avisoReceitaKit: 'nada' })).mensagem).toBe(
      'O ERP atualizou o anúncio com o que a Shopee informa agora.',
    );
  });
});
