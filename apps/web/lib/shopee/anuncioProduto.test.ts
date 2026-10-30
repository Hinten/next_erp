import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  ESTADO_ANUNCIO_SHOPEE,
  campoRascunhoShopeeSchema,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  estadoAnuncioShopeeSchema,
  tipoAcaoSugeridaPublicacaoShopeeSchema,
} from '@delfrance/schemas';

import {
  COR_ESTADO_ANUNCIO_SHOPEE,
  FRASE_ITEM_ID_INVALIDO_SHOPEE,
  FRASE_RECUSA_SEM_PASSO_SHOPEE,
  ROTULO_ESTADO_ANUNCIO_SHOPEE,
  TEXTO_ACAO_SUGERIDA,
  TEXTO_AVISO_KIT,
  TEXTO_MOTIVO_KIT,
  chaveIncerto,
  criacaoDeKitIncerta,
  limiteNaCriacaoDeKit,
  ehFraseDeTerminal,
  esperaDoKitIncerto,
  estadoAnuncioShopeeLido,
  formatarInstanteShopee,
  gravarIncerto,
  itemIdDoAnuncioShopee,
  lerIncerto,
  ordenarVinculosShopee,
  resumoDaReverificacaoShopee,
  textoDaEtapaShopee,
  textoDoAvisoKit,
  textoDoProblemaShopee,
  urlDoAnuncioShopee,
  vinculoSubstituidoAlheio,
  DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE,
  FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE,
  FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_INCERTO_SHOPEE,
  ROTULO_CAMPO_RASCUNHO_SHOPEE,
  TEXTO_MOTIVO_ANUNCIO_SHOPEE,
  fraseDaPublicacaoEmAndamentoShopee,
  fraseDaRespostaIlegivelDoRascunhoShopee,
  fraseDaRespostaIncertaDoRascunhoShopee,
  fraseDoConflitoDeConcorrenciaShopee,
  fraseDoConflitoIlegivelShopee,
  fraseDoRascunhoEmAndamentoShopee,
  fraseDoTextoForaDaFaixaShopee,
  textoDaPendenciaRascunhoShopee,
  textoDoSegundoAnuncioShopee,
  FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE,
  FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE,
  FRASE_PENDENCIA_SEM_NOME_SHOPEE,
  FRASE_PRODUTO_INEXISTENTE_SHOPEE,
  FRASE_CATEGORIA_TRAVADA_SHOPEE,
  FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
  FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_SHOPEE,
  FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE,
  FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
  FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
  FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
  FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
  FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
  FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
  MOTIVO_ANUNCIO_SHOPEE,
  ROTULO_CRIAR_PAUSADO_SHOPEE,
  TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE,
  TITULO_ANUNCIO_INCERTO_SHOPEE,
  TITULO_RASCUNHO_PUBLICADO_SHOPEE,
  avisoDoDescarteComAnuncioSemVinculoShopee,
  fraseDaPublicacaoDoRascunhoEmAndamentoShopee,
  fraseDaPublicacaoExpiradaShopee,
  fraseDaPublicacaoInterrompidaShopee,
  fraseDaPublicacaoSemRespostaShopee,
  fraseDoAnuncioIncertoShopee,
  fraseDoRascunhoPublicadoShopee,
  rotuloDaPublicacaoQueAdotaShopee,
  textoDaConfirmacaoDePublicacaoShopee,
  textoDaRecusaGuardadaShopee,
  textoDoSegundoAnuncioNaPublicacaoShopee,
  type IncertoKitShopee,
} from './anuncioProduto';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
} from './client';
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
 *
 * PR 8: the native kit — `TEXTO_MOTIVO_KIT` / `TEXTO_AVISO_KIT` (T5m), which
 * failures leave a kit create UNCERTAIN (`criacaoDeKitIncerta`, with its
 * near-misses), the wait (T5l) and the per-tab store of an uncertain create.
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
      FRASE_ITEM_ID_INVALIDO_SHOPEE,
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

  it('a vinculo-substituido row about ANOTHER link names it; about the block, or unreported, reads as before (R5-01)', () => {
    const acao = { tipo: T.republicar, linkDocId: 'L-kit', substituidoLinkDocId: 'L-velho' };
    const linha = { motivo: 'vinculo-substituido', mensagem: CLI, acao };
    expect(vinculoSubstituidoAlheio(acao, 'L-kit')).toBe('L-velho');
    const alheio = textoDoProblemaShopee(linha, 'L-kit');
    expect(alheio).toContain(
      'O kit nativo antigo do vínculo L-velho foi substituído pelo vínculo L-kit',
    );
    expect(alheio).not.toContain('Este anúncio');
    expect(alheio).not.toMatch(TEXTO_DE_TERMINAL);
    // No successor known: the old link is still named.
    expect(
      textoDoProblemaShopee({ ...linha, acao: { ...acao, linkDocId: null } }, 'L-kit'),
    ).toContain('O kit nativo antigo do vínculo L-velho foi substituído, mas');
    // NEAR-MISSES — the row is about the block, the server did not say, or no block was given.
    const proprio = `${TEXTO_MOTIVO_KIT['vinculo-substituido']} Vínculo: L-kit.`;
    expect(vinculoSubstituidoAlheio(acao, 'L-velho')).toBeNull();
    expect(textoDoProblemaShopee(linha, 'L-velho')).toBe(proprio);
    for (const semAssunto of [
      { tipo: T.republicar, linkDocId: 'L-kit' },
      { ...acao, substituidoLinkDocId: null },
    ]) {
      expect(vinculoSubstituidoAlheio(semAssunto, 'L-kit')).toBeNull();
      expect(textoDoProblemaShopee({ ...linha, acao: semAssunto }, 'L-kit')).toBe(proprio);
    }
    expect(textoDoProblemaShopee(linha)).toBe(proprio);
    expect(vinculoSubstituidoAlheio({ tipo: T.recriar, linkDocId: 'L-velho' }, 'L-kit')).toBeNull();
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

/* -------------------------------------------------------------------------- */
/*                         PR 8 — the native kit                               */
/* -------------------------------------------------------------------------- */

/**
 * The twelve codes of apps/shopee's `kits/resultadoKit.ts` `CodigoAvisoKit` —
 * the vocabulary a kit 200's `avisos[].codigo` carries (reconcile fact 4).
 * Copied here because the browser cannot import apps/shopee and the vocabulary
 * is deliberately not a schemas enum in this step (fact 5); a code added there
 * reaches the tab as `textoDoAvisoKit`'s neutral fallback.
 */
const CODIGOS_AVISO_KIT = [
  'receita-divergente',
  'receita-nao-publicavel',
  'principal-diferente',
  'componente-nao-limita-estoque',
  'receita-espelho-divergente',
  'modelo-sem-filho',
  'variacao-nao-anexada',
  'kit-antigo-nao-excluido',
  'kit-novo-inativo',
  'kit-novo-divergente',
  'kit-alvo-mais-novo',
  'sku-do-kit-nao-enviado',
];

describe('TEXTO_AVISO_KIT / textoDoAvisoKit (T5m)', () => {
  it('words each of the twelve codes a kit run reports, and nothing else', () => {
    expect(Object.keys(TEXTO_AVISO_KIT).sort()).toEqual([...CODIGOS_AVISO_KIT].sort());
    for (const codigo of CODIGOS_AVISO_KIT) {
      expect(textoDoAvisoKit(codigo)).toBe(TEXTO_AVISO_KIT[codigo]);
    }
  });

  it('never carries CLI text (lens 8)', () => {
    for (const texto of Object.values(TEXTO_AVISO_KIT))
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
  });

  it('reads a code this build does not know as a neutral line naming it — never undefined', () => {
    expect(textoDoAvisoKit('kit-codigo-novo')).toBe('Aviso da Shopee (kit-codigo-novo).');
    expect(textoDoAvisoKit('')).toBe('Aviso da Shopee ().');
  });

  it('NEAR-MISS: a prototype member is not a code — the lookup is own-property only', () => {
    for (const codigo of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(textoDoAvisoKit(codigo)).toBe(`Aviso da Shopee (${codigo}).`);
    }
  });
});

describe('TEXTO_MOTIVO_KIT (T5m)', () => {
  it('words instabilidade-shopee itself, with the schemas’ wait, and no row carries CLI text', () => {
    const instabilidade = TEXTO_MOTIVO_KIT['instabilidade-shopee'];
    expect(instabilidade).toBeDefined();
    expect(instabilidade).toContain(`${String(AGUARDAR_KIT_INCERTO_SHOPEE_MS / 60_000)} minutos`);
    for (const texto of Object.values(TEXTO_MOTIVO_KIT))
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
  });

  it('is read FIRST by textoDoProblemaShopee — with or without an acao — and the acao ids still follow', () => {
    const T = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;
    const CLI = 'rode exatamente o mesmo comando de novo daqui a 4 minutos';
    expect(
      textoDoProblemaShopee({ motivo: 'instabilidade-shopee', mensagem: CLI, acao: null }),
    ).toBe(TEXTO_MOTIVO_KIT['instabilidade-shopee']);
    expect(
      textoDoProblemaShopee({
        motivo: 'principal-obrigatorio',
        mensagem: 'informe o componente principal (--principal)',
        acao: { tipo: T.informarPrincipal },
      }),
    ).toBe(TEXTO_MOTIVO_KIT['principal-obrigatorio']);
    expect(
      textoDoProblemaShopee({
        motivo: 'vinculo-substituido',
        mensagem: 'publique sem --link (ou com --link L2)',
        acao: { tipo: T.republicar, linkDocId: 'L2' },
      }),
    ).toBe(`${TEXTO_MOTIVO_KIT['vinculo-substituido'] ?? '?'} Vínculo: L2.`);
  });

  it('NEAR-MISS: a motivo the map lacks — or a prototype member — falls back to the acao copy, then the sentence', () => {
    const T = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;
    expect(
      textoDoProblemaShopee({
        motivo: 'listagem-removida',
        mensagem: 'o kit foi removido — use --recriar',
        acao: { tipo: T.recriar, linkDocId: 'L1' },
      }),
    ).toBe(`${TEXTO_ACAO_SUGERIDA[T.recriar]} Vínculo: L1.`);
    expect(
      textoDoProblemaShopee({
        motivo: 'constructor',
        mensagem: 'A categoria não aceita este atributo.',
        acao: null,
      }),
    ).toBe('A categoria não aceita este atributo.');
  });
});

describe('criacaoDeKitIncerta — a failed kit create that may still have created the kit', () => {
  const http = (status: number, kind: string | null = null) =>
    new ShopeeClientHttpError('falha', status, 'SHOPEE_HTTP_ERROR', null, kind);

  it('calls a lost answer uncertain: a network error, an abort, a 2xx it cannot read', () => {
    expect(criacaoDeKitIncerta(new ShopeeClientNetworkError('Failed to fetch'))).toBe(true);
    expect(
      criacaoDeKitIncerta(
        new ShopeeClientNetworkError('aborted', new DOMException('aborted', 'AbortError')),
      ),
    ).toBe(true);
    expect(criacaoDeKitIncerta(new ShopeeClientRespostaInvalidaError('ruim', 200, ['x']))).toBe(
      true,
    );
  });

  it('calls a 503, a 504 and a 502 that is not a rate limit uncertain', () => {
    for (const err of [http(503), http(504), http(500), http(502), http(502, 'transient')]) {
      expect(criacaoDeKitIncerta(err)).toBe(true);
    }
  });

  it('NEAR-MISS: a rate-limited 502 (burst / daily) and every 4xx are DEFINITE', () => {
    for (const err of [
      http(502, 'burst'),
      http(502, 'daily'),
      http(501),
      http(400),
      http(404),
      http(409),
      http(422),
    ]) {
      expect(criacaoDeKitIncerta(err)).toBe(false);
    }
  });

  it('limiteNaCriacaoDeKit: only a 502 whose kind is a rate limit', () => {
    expect(limiteNaCriacaoDeKit(http(502, 'burst'))).toBe(true);
    expect(limiteNaCriacaoDeKit(http(502, 'daily'))).toBe(true);
    // NEAR-MISSES: the same kind on another status, another kind on a 502, a network error.
    for (const err of [
      http(503, 'burst'),
      http(429, 'daily'),
      http(502, 'transient'),
      http(502),
      new ShopeeClientNetworkError('Failed to fetch'),
    ]) {
      expect(limiteNaCriacaoDeKit(err)).toBe(false);
    }
  });
});

describe('esperaDoKitIncerto (T5l)', () => {
  it('waits the 202’s own aguardarMs, and the schemas’ constant when the body carried none', () => {
    expect(esperaDoKitIncerto(60_000)).toBe(60_000);
    expect(esperaDoKitIncerto(undefined)).toBe(AGUARDAR_KIT_INCERTO_SHOPEE_MS);
  });
});

describe('the uncertain-create store (lerIncerto / gravarIncerto)', () => {
  const INCERTO: IncertoKitShopee = {
    ate: 1_790_000_000_000,
    corpo: {
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L1',
      recriar: true,
      principal: 'c2',
    },
  };

  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('keys one produto’s create on one conta', () => {
    expect(chaveIncerto('int-1', 'prod-1')).toBe('delfrance:shopee:kit-incerto:int-1:prod-1');
  });

  it('round-trips the exact body, and forgets it on null', () => {
    expect(gravarIncerto('int-1', 'prod-1', INCERTO)).toBe(true);
    expect(lerIncerto('int-1', 'prod-1')).toStrictEqual(INCERTO);
    // Another conta, another produto: nothing (key misses — the identity check on
    // the stored body is pinned below).
    expect(lerIncerto('int-2', 'prod-1')).toBeNull();
    expect(lerIncerto('int-1', 'prod-2')).toBeNull();
    expect(gravarIncerto('int-1', 'prod-1', null)).toBe(true);
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
  });

  it('reads a stored value that is not JSON, not the shape, or names another conta or produto as nothing', () => {
    const chave = chaveIncerto('int-1', 'prod-1');
    window.sessionStorage.setItem(chave, '{nao-e-json');
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    window.sessionStorage.setItem(chave, JSON.stringify({ ate: 'amanhã', corpo: {} }));
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    // Not THIS tab's kit re-send: `recriar: false` (the schema takes the flag as
    // `true` or absent — the route itself would accept a `false`), both arm flags
    // at once, neither, a create naming no link (either arm), an empty link, and
    // a status no kit create carries.
    const semLink = { integracaoId: 'int-1', produtoId: 'prod-1' };
    for (const corpo of [
      { ...INCERTO.corpo, recriar: false },
      { ...INCERTO.corpo, converterEmKit: true },
      { integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'L1' },
      { ...semLink, recriar: true },
      { ...semLink, converterEmKit: true },
      { ...INCERTO.corpo, linkDocId: '' },
      { ...INCERTO.corpo, status: 'BANNED' },
      // Stored under int-1:prod-1 but naming ANOTHER produto (the identity's second half).
      { ...INCERTO.corpo, produtoId: 'prod-9' },
    ]) {
      window.sessionStorage.setItem(chave, JSON.stringify({ ...INCERTO, corpo }));
      expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    }
    window.sessionStorage.setItem(
      chave,
      JSON.stringify({ ...INCERTO, corpo: { ...INCERTO.corpo, integracaoId: 'int-9' } }),
    );
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
  });

  it('degrades a blocked store to "nothing stored" and a full one to false — never a throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cheio', 'QuotaExceededError');
    });
    expect(gravarIncerto('int-1', 'prod-1', INCERTO)).toBe(false);
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError');
    });
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    vi.restoreAllMocks();

    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError');
    });
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    expect(gravarIncerto('int-1', 'prod-1', INCERTO)).toBe(false);
  });

  it('NEAR-MISS: an error that is not the store’s own is not swallowed (rule 6)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new TypeError('bug');
    });
    expect(() => lerIncerto('int-1', 'prod-1')).toThrow(TypeError);
  });
});

/**
 * #1911 P10 — the listing DRAFT's copy. `TEXTO_MOTIVO_ANUNCIO_SHOPEE` is read
 * by the one refusal reader right after `TEXTO_MOTIVO_KIT`, with DISJOINT keys
 * (so the lookup order decides nothing); the answer sentences never claim more
 * than the answer says (an unreadable 2xx MAY have saved; a wait is never
 * "0 s"; an `em-andamento` notice never promises the draft comes back free).
 */
describe('TEXTO_MOTIVO_ANUNCIO_SHOPEE (#1911 P10)', () => {
  const T = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;

  it('words exactly the three P10 draft motivos and the eight of P11 — one constant per notice it shares', () => {
    // §C's map size: P10 3 keys + P11 8 keys = 11 (ambígua's second copy is
    // TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE's).
    expect(Object.keys(TEXTO_MOTIVO_ANUNCIO_SHOPEE).sort()).toEqual([
      'anuncio-existente-de-outro-produto',
      'anuncio-existente-sem-vinculo',
      'anuncio-semelhante-existente',
      'busca-de-anuncio-existente-incompleta',
      'busca-de-anuncio-incompleta',
      'criacao-incerta-ambigua',
      'criacao-incerta-ja-vinculada',
      'criacao-incerta-sem-sku',
      'marca-nao-escolhida',
      'rascunho-em-kit-virtual',
      'rascunho-nao-nomeado',
    ]);
    // §C #1 / #3: the block's notice and the pendência ARE these rows.
    expect(TEXTO_MOTIVO_ANUNCIO_SHOPEE['rascunho-em-kit-virtual']).toBe(
      FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
    );
    expect(TEXTO_MOTIVO_ANUNCIO_SHOPEE['marca-nao-escolhida']).toBe(
      FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE,
    );
    for (const texto of Object.values(TEXTO_MOTIVO_ANUNCIO_SHOPEE)) {
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });

  it('shares NO key with TEXTO_MOTIVO_KIT, so which map answers never depends on order', () => {
    const kit = new Set(Object.keys(TEXTO_MOTIVO_KIT));
    for (const chave of Object.keys(TEXTO_MOTIVO_ANUNCIO_SHOPEE))
      expect(kit.has(chave)).toBe(false);
  });

  it('is read by textoDoProblemaShopee — the CLI sentence never shows, the acao ids still follow', () => {
    expect(
      textoDoProblemaShopee({
        motivo: 'rascunho-em-kit-virtual',
        mensagem: 'descarte o rascunho e publique o kit pelo comando de kit',
        acao: null,
      }),
    ).toBe(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE);
    expect(
      textoDoProblemaShopee({
        motivo: 'marca-nao-escolhida',
        mensagem: 'O rascunho não tem marca escolhida.',
        acao: null,
      }),
    ).toBe(FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE);
    const naoNomeado = TEXTO_MOTIVO_ANUNCIO_SHOPEE['rascunho-nao-nomeado'] ?? '?';
    expect(
      textoDoProblemaShopee({
        motivo: 'rascunho-nao-nomeado',
        mensagem: 'publique com --link R1',
        acao: { tipo: T.republicar, linkDocId: 'R1' },
      }),
    ).toBe(`${naoNomeado} Vínculo: R1.`);
    expect(
      textoDoProblemaShopee({
        motivo: 'rascunho-nao-nomeado',
        mensagem: 'publique com --link R1 ou --link R2',
        acao: { tipo: T.escolherVinculo, linkDocIds: ['R1', 'R2'] },
      }),
    ).toBe(`${naoNomeado} Vínculos: R1, R2.`);
  });

  it('NEAR-MISS: the same acao under a KIT motivo keeps the kit copy; a motivo in neither map keeps its sentence', () => {
    // `vinculo-substituido` shares `republicar` with `rascunho-nao-nomeado`.
    expect(
      textoDoProblemaShopee({
        motivo: 'vinculo-substituido',
        mensagem: 'publique sem --link (ou com --link L2)',
        acao: { tipo: T.republicar, linkDocId: 'L2' },
      }),
    ).toBe(`${TEXTO_MOTIVO_KIT['vinculo-substituido'] ?? '?'} Vínculo: L2.`);
    // `kit-virtual-sem-kit` (ehKitVirtual without ehKit) is in NO map.
    const frase = 'O produto marca kit virtual mas não é kit: corrija o cadastro.';
    expect(
      textoDoProblemaShopee({ motivo: 'kit-virtual-sem-kit', mensagem: frase, acao: null }),
    ).toBe(frase);
  });
});

describe('ROTULO_CAMPO_RASCUNHO_SHOPEE', () => {
  it('names every draft field of the shared vocabulary, and nothing else', () => {
    expect(Object.keys(ROTULO_CAMPO_RASCUNHO_SHOPEE).sort()).toEqual(
      [...campoRascunhoShopeeSchema.options].sort(),
    );
  });
});

describe('the draft block’s notices (#1911 P10)', () => {
  const nowMs = Date.UTC(2026, 9, 28, 15, 0, 0);

  it('em-andamento: "até" is nowMs + aguardarMs, before and after expiry — never a promise of "livre"', () => {
    const vivo = fraseDoRascunhoEmAndamentoShopee(
      {
        tipo: 'em-andamento',
        desdeMs: nowMs - 60_000,
        expiraEmMs: nowMs + 240_000,
        aguardarMs: 240_000,
        aposIncerteza: false,
        posExpiracao: false,
      },
      nowMs,
    );
    expect(vivo).toContain(`até ${formatarInstanteShopee(nowMs + 240_000) ?? '?'}`);
    expect(vivo).toContain(`desde ${formatarInstanteShopee(nowMs - 60_000) ?? '?'}`);
    const graca = fraseDoRascunhoEmAndamentoShopee(
      {
        tipo: 'em-andamento',
        desdeMs: nowMs - 400_000,
        expiraEmMs: nowMs - 100_000,
        aguardarMs: 140_000,
        aposIncerteza: false,
        posExpiracao: true,
      },
      nowMs,
    );
    expect(graca).toContain('expirou, mas ainda pode estar terminando');
    expect(graca).toContain(`até ${formatarInstanteShopee(nowMs + 140_000) ?? '?'}`);
    for (const t of [vivo, graca]) {
      expect(t).not.toMatch(/dispon[ií]vel|livre/i);
      expect(t).not.toContain('SKU');
    }
  });

  it('em-andamento after an uncertain attempt adds the SKU advice ⟷ without one it does not', () => {
    const apos = fraseDoRascunhoEmAndamentoShopee(
      {
        tipo: 'em-andamento',
        desdeMs: nowMs,
        expiraEmMs: nowMs + 1_000,
        aguardarMs: 1_000,
        aposIncerteza: true,
        posExpiracao: false,
      },
      nowMs,
    );
    expect(apos).toContain('SKU enviado');
    expect(apos).toContain('não mude o SKU do produto');
  });

  it('incerta: the SKU the search uses (sent, else the current one) and the locked category', () => {
    expect(FRASE_RASCUNHO_INCERTO_SHOPEE).toContain('pelo SKU enviado');
    expect(FRASE_RASCUNHO_INCERTO_SHOPEE).toContain('pelo SKU atual do produto');
    expect(FRASE_RASCUNHO_INCERTO_SHOPEE).toContain('A categoria fica travada');
  });

  it('a band refusal names the measured length and the schemas’ band description', () => {
    expect(fraseDoTextoForaDaFaixaShopee('titulo', 130, { min: 25, max: 120 })).toBe(
      'O título tem 130 caracteres; esta categoria aceita 25..120.',
    );
    expect(fraseDoTextoForaDaFaixaShopee('descricao', 10, { min: 100, max: null })).toBe(
      'A descrição tem 10 caracteres; esta categoria aceita 100..—.',
    );
  });
});

describe('the second-listing confirmation (D15)', () => {
  it('counts what the conta holds and names the duplicate risk; a draft adds the "continue it" line', () => {
    const comRascunho = textoDoSegundoAnuncioShopee({ quantidade: 2, comRascunho: true });
    expect(comRascunho).toContain('já tem 2 anúncio(s) deste produto, incluindo um rascunho.');
    expect(comRascunho).toContain('duplicado (spam)');
    expect(comRascunho).toContain('edite-o em vez de criar outro');
    const soAnuncio = textoDoSegundoAnuncioShopee({ quantidade: 1, comRascunho: false });
    expect(soAnuncio).toContain('já tem 1 anúncio(s) deste produto.');
    expect(soAnuncio).not.toContain('rascunho');
  });

  it('NEAR-MISS: an unreadable vinculos list (0) never reads "já tem 0"', () => {
    const t = textoDoSegundoAnuncioShopee({ quantidade: 0, comRascunho: false });
    expect(t).toContain('Esta conta já tem anúncio(s) deste produto.');
    expect(t).not.toMatch(/\b0\b/);
  });

  it('§I3: says ONLY that Shopee may treat it as a duplicate (spam) and to create it only if really different — never a penalty claim', () => {
    for (const existentes of [
      { quantidade: 2, comRascunho: true },
      { quantidade: 1, comRascunho: false },
      { quantidade: 0, comRascunho: false },
    ]) {
      const t = textoDoSegundoAnuncioShopee(existentes);
      expect(t).not.toMatch(/penalidade|pontos/i);
      expect(t).toContain('pode ser tratado pela Shopee como anúncio duplicado (spam).');
      expect(t).toContain('Crie outro apenas se ele for realmente diferente');
    }
  });
});

describe('the draft sentences name only exits this tab offers (#1911 P10 review)', () => {
  it('R8-copy#11: the kit-virtual notice and 422 never say "publique" — the tab has no first native-kit publish — and say where it is done', () => {
    for (const frase of [
      FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
      FRASE_RASCUNHO_DE_KIT_VIRTUAL_SHOPEE,
    ]) {
      expect(frase).not.toMatch(/publique/i);
      expect(frase).toContain('não é feita por esta tela');
      expect(frase).toContain('terminal');
      expect(frase).not.toMatch(TEXTO_DE_TERMINAL);
    }
    // The notice still says what to do with THIS draft.
    expect(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE).toContain('descarte este rascunho');
  });

  it('R1-rule7#4 / R8-copy#7: a discard conflict names «Desfazer alterações» as the way to the current version — CONDITIONALLY (a clean block shows it already, its Desfazer disabled)', () => {
    expect(FRASE_DESCARTE_EM_CONFLITO_SHOPEE).toContain('nada foi descartado');
    expect(FRASE_DESCARTE_EM_CONFLITO_SHOPEE).toContain(
      'se este rascunho tem alterações não salvas, use antes «Desfazer alterações»',
    );
    // NEAR-MISS: never the unconditional order (wrong when the snapshot lagged
    // and the block, with no entry, already shows the current version).
    expect(FRASE_DESCARTE_EM_CONFLITO_SHOPEE).not.toContain('Use «Desfazer alterações»');
    expect(FRASE_DESCARTE_EM_CONFLITO_SHOPEE).not.toMatch(/tente de novo/i);
  });

  it('R1-rule7#5: the locked-category sentence names how to save the OTHER edits — «Desfazer alterações», offered whenever it shows', () => {
    expect(FRASE_CATEGORIA_TRAVADA_SHOPEE).toContain('Nada é salvo enquanto a troca de categoria');
    expect(FRASE_CATEGORIA_TRAVADA_SHOPEE).toContain('«Desfazer alterações»');
  });
});

describe('the draft routes’ answers (§C.2)', () => {
  it('publicacaoEmAndamento: whole seconds rounded UP — never "0 s" — and what was NOT done, per route', () => {
    expect(fraseDaPublicacaoEmAndamentoShopee(1_500, 'atualizar')).toContain('aguarde 2 s');
    expect(fraseDaPublicacaoEmAndamentoShopee(1_000, 'atualizar')).toContain('aguarde 1 s');
    expect(fraseDaPublicacaoEmAndamentoShopee(1_000, 'atualizar')).toContain('Nada foi gravado.');
    expect(fraseDaPublicacaoEmAndamentoShopee(1_000, 'descartar')).toContain(
      'Nada foi descartado.',
    );
    for (const sem of [null, 0]) {
      const t = fraseDaPublicacaoEmAndamentoShopee(sem, 'atualizar');
      expect(t).toContain('aguarde e confira');
      expect(t).not.toMatch(/\d+ s\b/);
    }
  });

  it('an unreadable 2xx MAY have happened — never a success, never "nada foi"', () => {
    for (const op of ['criar', 'atualizar', 'descartar'] as const) {
      const t = fraseDaRespostaIlegivelDoRascunhoShopee(op);
      expect(t).toMatch(/PODE|PODEM/);
      expect(t).toContain('Recarregue a aba');
      expect(t).not.toMatch(/nada foi/i);
    }
    expect(fraseDaRespostaIlegivelDoRascunhoShopee('criar')).toContain('criado');
    expect(fraseDaRespostaIlegivelDoRascunhoShopee('atualizar')).toContain('salvas');
    expect(fraseDaRespostaIlegivelDoRascunhoShopee('descartar')).toContain('descartado');
  });

  it('no trustworthy answer: a create may be re-sent as is; an edit or a discard is checked first', () => {
    expect(fraseDaRespostaIncertaDoRascunhoShopee('criar')).toContain('nunca é criado duas vezes');
    expect(fraseDaRespostaIncertaDoRascunhoShopee('atualizar')).toContain('confira antes');
    for (const op of ['criar', 'atualizar', 'descartar'] as const) {
      expect(fraseDaRespostaIncertaDoRascunhoShopee(op)).not.toMatch(/nada foi/i);
    }
  });

  it('a conflict nobody can show field by field says nothing was done, per route', () => {
    expect(fraseDoConflitoDeConcorrenciaShopee('atualizar')).toContain('Nada foi gravado.');
    expect(fraseDoConflitoDeConcorrenciaShopee('descartar')).toContain('Nada foi descartado.');
    expect(fraseDoConflitoIlegivelShopee('atualizar')).toContain('Recarregue a aba');
    expect(fraseDoConflitoIlegivelShopee('descartar')).toContain('Nada foi descartado.');
  });

  it('an ATTESTED discard (`criacaoIncerta: true`) says what to do if the listing shows up ⟷ a plain discard does not', () => {
    expect(
      FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE.startsWith(`${FRASE_RASCUNHO_DESCARTADO_SHOPEE} `),
    ).toBe(true);
    expect(FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE).toContain('importe-o — não crie outro');
    expect(FRASE_RASCUNHO_DESCARTADO_SHOPEE).not.toMatch(/import/i);
  });

  it('INEXISTENTE reads by ROUTE: the create’s names the PRODUTO ⟷ the edit/discard’s names the DRAFT and says reload', () => {
    expect(FRASE_PRODUTO_INEXISTENTE_SHOPEE).toMatch(/produto/);
    expect(FRASE_PRODUTO_INEXISTENTE_SHOPEE).not.toMatch(/rascunho/i);
    expect(FRASE_RASCUNHO_INEXISTENTE_SHOPEE).toMatch(/^O rascunho não existe mais/);
    expect(FRASE_RASCUNHO_INEXISTENTE_SHOPEE).toContain('recarregue a aba');
  });

  it('the CRIACAO_INCERTA dialog: case (c) is "do not discard" — the import adopts the draft', () => {
    expect(DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeSemVinculo).toMatch(
      /^O anúncio existe e não está vinculado: não descarte/,
    );
    expect(DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeSemVinculo).toContain('mesmo SKU');
    for (const texto of Object.values(DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE)) {
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });
});

describe('textoDaPendenciaRascunhoShopee — one sentence per pendência kind', () => {
  it('words every kind; the brand one IS the marca-nao-escolhida copy (one constant)', () => {
    expect(textoDaPendenciaRascunhoShopee({ tipo: 'sem-nome' })).toBe(
      FRASE_PENDENCIA_SEM_NOME_SHOPEE,
    );
    expect(textoDaPendenciaRascunhoShopee({ tipo: 'sem-descricao' })).toBe(
      FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE,
    );
    expect(textoDaPendenciaRascunhoShopee({ tipo: 'categoria-ausente' })).toBe(
      FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE,
    );
    expect(textoDaPendenciaRascunhoShopee({ tipo: 'marca-nao-escolhida' })).toBe(
      TEXTO_MOTIVO_ANUNCIO_SHOPEE['marca-nao-escolhida'],
    );
    expect(
      textoDaPendenciaRascunhoShopee({
        tipo: 'titulo-fora-da-faixa',
        comprimento: 130,
        faixa: { min: 25, max: 120 },
      }),
    ).toBe('O título tem 130 caracteres; esta categoria aceita 25..120.');
    expect(
      textoDaPendenciaRascunhoShopee({
        tipo: 'descricao-fora-da-faixa',
        comprimento: 5,
        faixa: { min: 100, max: 3000 },
      }),
    ).toBe('A descrição tem 5 caracteres; esta categoria aceita 100..3000.');
    expect(
      textoDaPendenciaRascunhoShopee({
        tipo: 'atributo-obrigatorio',
        nomes: ['Marca', 'Material'],
      }),
    ).toBe('Preencha os atributos obrigatórios: Marca, Material.');
  });
});

/* -------------------------------------------------------------------------- */
/*                     #1911 P11 — Publicar on a draft                         */
/* -------------------------------------------------------------------------- */

describe('#1911 P11 — the motivo vocabulary is spelled once and keys every map', () => {
  it('every key of both draft maps is a MOTIVO_ANUNCIO_SHOPEE slug, and that vocabulary is the server’s', () => {
    const slugs = new Set<string>(Object.values(MOTIVO_ANUNCIO_SHOPEE));
    expect(new Set(Object.keys(TEXTO_MOTIVO_ANUNCIO_SHOPEE))).toEqual(slugs);
    // The acao-less map is a SUBSET: a renamed slug loses both rows at once.
    for (const chave of Object.keys(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE)) {
      expect(slugs.has(chave)).toBe(true);
    }
    expect(Object.keys(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE)).toEqual(['criacao-incerta-ambigua']);
  });

  it('no row of either map is CLI copy, and the two ambígua copies are distinct', () => {
    for (const texto of [
      ...Object.values(TEXTO_MOTIVO_ANUNCIO_SHOPEE),
      ...Object.values(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE),
    ]) {
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
    }
    expect(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE['criacao-incerta-ambigua']).not.toBe(
      TEXTO_MOTIVO_ANUNCIO_SHOPEE['criacao-incerta-ambigua'],
    );
  });
});

describe('#1911 P11 — textoDoProblemaShopee: §C rows #4–#12', () => {
  const T = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;
  const M = MOTIVO_ANUNCIO_SHOPEE;
  /** The CLI sentences the server sends for these rows — never on screen. */
  const CLI = 'confira e importe-o (importar:anuncio) ou publique com --confirmar-criacao-incerta';
  const KIT = 'Já existe na Shopee um kit com o SKU deste produto';
  const COMPONENTES = 'componentes do kit';
  const MASSA = 'importação em massa';
  const copia = (m: string) => TEXTO_MOTIVO_ANUNCIO_SHOPEE[m] ?? '?';
  const importar = (
    itemIds: number[],
    vinculados?: { itemId: number; produtoId: string }[] | null,
  ) => ({ tipo: T.importar, itemIds, ...(vinculados === undefined ? {} : { vinculados }) });
  const vezes = (texto: string, trecho: string) => texto.split(trecho).length - 1;

  it('#16: the three CLI-worded refusals with NO acao never read as "no next step"', () => {
    for (const motivo of [
      M.criacaoIncertaSemSku,
      M.buscaDeAnuncioIncompleta,
      M.criacaoIncertaAmbigua,
    ]) {
      const texto = textoDoProblemaShopee({ motivo, mensagem: CLI, acao: null });
      expect(texto, motivo).not.toBe(FRASE_RECUSA_SEM_PASSO_SHOPEE);
      expect(texto, motivo).not.toMatch(TEXTO_DE_TERMINAL);
    }
    // NEAR-MISS: a motivo in no map with the same sentence still gets the backstop.
    expect(textoDoProblemaShopee({ motivo: 'outro-motivo', mensagem: CLI, acao: null })).toBe(
      FRASE_RECUSA_SEM_PASSO_SHOPEE,
    );
  });

  it('#4 ambígua WITH its importar: the listing copy + every id — never the kit sentence ⟷ a kit motivo with the same acao keeps it', () => {
    const acao = importar([1000009, 1000010], []);
    const texto = textoDoProblemaShopee({ motivo: M.criacaoIncertaAmbigua, mensagem: CLI, acao });
    expect(texto).toBe(
      `${copia(M.criacaoIncertaAmbigua)} Anúncio(s) na Shopee: 1000009 (sem vínculo), 1000010 (sem vínculo).`,
    );
    expect(texto).not.toContain(KIT);
    expect(texto).not.toContain(COMPONENTES);
    // The copy already names the door: no second mass-import sentence.
    expect(vezes(texto, 'Canais › Shopee')).toBe(1);
    const doKit = textoDoProblemaShopee({ motivo: 'kit-ja-existe-na-shopee', mensagem: CLI, acao });
    expect(doKit).toContain(KIT);
    expect(doKit).toContain(COMPONENTES);
  });

  it('§C rule 3: the importar branch reads ONLY the listing map — a motivo worded by TEXTO_MOTIVO_KIT keeps the kit wording', () => {
    // No kit producer pairs a TEXTO_MOTIVO_KIT motivo with `importar` today; the
    // pin is the rule, so a kit motivo that gains one never reads listing-style ids.
    const acao = importar([1000009], [{ itemId: 1000009, produtoId: 'p9' }]);
    const texto = textoDoProblemaShopee({ motivo: 'vinculo-substituido', mensagem: CLI, acao });
    expect(texto).toContain(KIT);
    expect(texto).not.toContain(TEXTO_MOTIVO_KIT['vinculo-substituido'] ?? '?');
    expect(texto).not.toContain('(do produto p9)');
  });

  it('#5 ambígua with NO acao (the SKU moved) reads its own copy ⟷ the copy keyed on the acao never crosses', () => {
    const semAcao = textoDoProblemaShopee({
      motivo: M.criacaoIncertaAmbigua,
      mensagem: CLI,
      acao: null,
    });
    expect(semAcao).toBe(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[M.criacaoIncertaAmbigua]);
    expect(semAcao).toContain('O SKU do produto mudou');
    const comAcao = textoDoProblemaShopee({
      motivo: M.criacaoIncertaAmbigua,
      mensagem: CLI,
      acao: importar([1000009]),
    });
    expect(comAcao).not.toContain('O SKU do produto mudou');
    expect(semAcao).not.toContain(copia(M.criacaoIncertaAmbigua));
  });

  it('#6 busca-de-anuncio-incompleta: nothing created, waiting does not help — the server’s CLI sentence never shows', () => {
    const texto = textoDoProblemaShopee({
      motivo: M.buscaDeAnuncioIncompleta,
      mensagem: 'a busca não terminou (3 página(s) lida(s)) — importe-o (importar:anuncio)',
      acao: null,
    });
    expect(texto).toBe(copia(M.buscaDeAnuncioIncompleta));
    expect(texto).toContain('nada foi criado');
    expect(texto).toContain('esperar não ajuda');
    expect(texto).not.toContain('página');
  });

  it('#7 criacao-incerta-sem-sku: the SKU step comes BEFORE any import (R-K5)', () => {
    const texto = textoDoProblemaShopee({
      motivo: M.criacaoIncertaSemSku,
      mensagem: CLI,
      acao: null,
    });
    expect(texto).toBe(copia(M.criacaoIncertaSemSku));
    const sku = texto.indexOf('MESMO SKU');
    const importe = texto.indexOf('importe-o');
    expect(sku).toBeGreaterThan(-1);
    expect(importe).toBeGreaterThan(sku);
    expect(texto).toContain('sem SKU a importação cria OUTRO produto');
  });

  it('#8 ja-vinculada: a linked id names ITS produto — «(deste produto)» ⟷ «(do produto X)»; all linked ⇒ no mass-import sentence', () => {
    const acao = importar(
      [1000009, 1000010],
      [
        { itemId: 1000009, produtoId: 'p1' },
        { itemId: 1000010, produtoId: 'p2' },
      ],
    );
    const texto = textoDoProblemaShopee(
      { motivo: M.criacaoIncertaJaVinculada, mensagem: CLI, acao },
      'R1',
      'p1',
    );
    expect(texto).toBe(
      `${copia(M.criacaoIncertaJaVinculada)} Anúncio(s) na Shopee: 1000009 (deste produto), 1000010 (do produto p2).`,
    );
    expect(texto).not.toContain(MASSA);
    expect(texto).not.toContain(KIT);
    // NEAR-MISS: without the block's produto every linked id names its produto.
    expect(
      textoDoProblemaShopee({ motivo: M.criacaoIncertaJaVinculada, mensagem: CLI, acao }, 'R1'),
    ).toContain('1000009 (do produto p1)');
  });

  it('#8 MIXED (linked ids + one unlinked candidate): the free id reads «(sem vínculo)» and gets the mass-import door', () => {
    const texto = textoDoProblemaShopee(
      {
        motivo: M.criacaoIncertaJaVinculada,
        mensagem: CLI,
        acao: importar([1000009, 1000011], [{ itemId: 1000009, produtoId: 'p1' }]),
      },
      'R1',
      'p1',
    );
    expect(texto).toContain('1000009 (deste produto), 1000011 (sem vínculo).');
    expect(texto).toContain(`${MASSA} (Canais › Shopee)`);
    expect(vezes(texto, 'Canais › Shopee')).toBe(1);
  });

  it('#9 anuncio-existente-sem-vinculo (`vinculados: []`): every id unlinked, never the kit conditions ⟷ the kit motivo keeps them', () => {
    const acao = importar([1000009, 1000010], []);
    const texto = textoDoProblemaShopee(
      { motivo: M.anuncioExistenteSemVinculo, mensagem: CLI, acao },
      'R1',
      'p1',
    );
    expect(texto).toBe(
      `${copia(M.anuncioExistenteSemVinculo)} Anúncio(s) na Shopee: 1000009 (sem vínculo), 1000010 (sem vínculo).`,
    );
    expect(texto).not.toContain(COMPONENTES);
    expect(texto).toContain('Nada foi enviado');
    expect(textoDoProblemaShopee({ mensagem: CLI, acao })).toContain(COMPONENTES);
  });

  it('#10 anuncio-existente-de-outro-produto: names the other produto; importing does not help ⟷ #9 in the same 422 reads its own row', () => {
    const outro = textoDoProblemaShopee(
      {
        motivo: M.anuncioExistenteDeOutroProduto,
        mensagem: CLI,
        acao: importar([1000012], [{ itemId: 1000012, produtoId: 'p9' }]),
      },
      'R1',
      'p1',
    );
    expect(outro).toBe(
      `${copia(M.anuncioExistenteDeOutroProduto)} Anúncio(s) na Shopee: 1000012 (do produto p9).`,
    );
    expect(outro).toContain('Importar não resolve');
    expect(outro).not.toContain(MASSA);
    const semVinculo = textoDoProblemaShopee(
      { motivo: M.anuncioExistenteSemVinculo, mensagem: CLI, acao: importar([1000013], []) },
      'R1',
      'p1',
    );
    expect(semVinculo).not.toBe(outro);
    expect(semVinculo).toContain('1000013 (sem vínculo)');
  });

  it('NEAR-MISS: an ordinary-listing importar from a server older than `vinculados` names the ids alone', () => {
    expect(
      textoDoProblemaShopee({
        motivo: M.anuncioExistenteSemVinculo,
        mensagem: CLI,
        acao: importar([1000009], null),
      }),
    ).toBe(`${copia(M.anuncioExistenteSemVinculo)} Anúncio(s) na Shopee: 1000009.`);
  });

  it('#11 busca-de-anuncio-existente-incompleta: the copy names §H Q2’s exit, the server’s sentence (the ids Shopee left out) follows', () => {
    const baseInfo =
      'a busca por um anúncio desta conta com o SKU deste produto não terminou: a Shopee não ' +
      'devolveu os dados de 2 anúncio(s) listado(s) (ids 1000020, 1000021) — nada foi criado; ' +
      'tente de novo; se persistir, confira esses anúncios no Seller Centre';
    const texto = textoDoProblemaShopee({
      motivo: M.buscaDeAnuncioExistenteIncompleta,
      mensagem: baseInfo,
      acao: null,
    });
    expect(texto).toBe(`${copia(M.buscaDeAnuncioExistenteIncompleta)} Detalhe: ${baseInfo}.`);
    for (const passo of [
      'Seller Centre com o SKU deste produto',
      'importe-o (Canais › Shopee)',
      'descarte este rascunho',
    ]) {
      expect(texto).toContain(passo);
    }
    // The copy assumes no cause — never "too many pages" on its own.
    expect(copia(M.buscaDeAnuncioExistenteIncompleta)).not.toMatch(/10 ?000|página/);
    // NEAR-MISS: a terminal-worded server sentence is NOT shown beside it.
    expect(
      textoDoProblemaShopee({
        motivo: M.buscaDeAnuncioExistenteIncompleta,
        mensagem: 'rode publicar:anuncio pelo terminal',
        acao: null,
      }),
    ).toBe(copia(M.buscaDeAnuncioExistenteIncompleta));
    // NEAR-MISS: #11 is not #6 — no attested discard for a `livre` draft.
    expect(texto).not.toContain('Descartar, confirmando');
  });

  it('NEAR-MISS: only #11 shows its sentence beside the copy — #6 (worded too) never does', () => {
    const frase = 'a busca não terminou (2 página(s) lida(s))';
    expect(
      textoDoProblemaShopee({ motivo: M.buscaDeAnuncioIncompleta, mensagem: frase, acao: null }),
    ).not.toContain('Detalhe:');
  });

  it('#12 anuncio-semelhante-existente: our duplicate sentence, never Shopee’s English prose', () => {
    const prosa = 'Item is similar to an existing listing in this shop (error_repeated_mtsku).';
    const texto = textoDoProblemaShopee({
      motivo: M.anuncioSemelhanteExistente,
      mensagem: prosa,
      acao: null,
    });
    expect(texto).toBe(copia(M.anuncioSemelhanteExistente));
    expect(texto).not.toContain('similar');
    expect(texto).toContain('duplicata');
  });
});

describe('#1911 P11 — §C #13/#14: the P7 variation refusals keep their OWN sentence (no new row)', () => {
  it('variacao-sem-vinculo and opcoes-demais read verbatim — never the "no next step" stand-in', () => {
    for (const [motivo, frase] of [
      [
        'variacao-sem-vinculo',
        'O vínculo do grupo "Cor" com esta conta para a categoria 100087 existe mas não pôde ser lido — corrija-o em Variações.',
      ],
      [
        'variacao-sem-vinculo',
        'O tier "Cor" não casa pelo nome com nenhum tier do anúncio — republicar reescreveria as opções. Importe o anúncio ou ajuste o nome do grupo.',
      ],
      ['opcoes-demais', 'O tier "Tamanho" tem um nome longo demais: encurte o nome em Variações.'],
    ] as const) {
      expect(ehFraseDeTerminal(frase)).toBe(false);
      expect(textoDoProblemaShopee({ motivo, mensagem: frase, acao: null })).toBe(frase);
    }
  });
});

describe('#1911 P11 — a STORED refusal row reads the draft copy first (D-P11 #12)', () => {
  it('a stamped duplicate refusal shows our sentence ⟷ a stored `listagem-removida` keeps its own', () => {
    expect(
      textoDaRecusaGuardadaShopee(
        'anuncio-semelhante-existente',
        'Item is similar to an existing listing.',
      ),
    ).toBe(TEXTO_MOTIVO_ANUNCIO_SHOPEE['anuncio-semelhante-existente']);
    expect(textoDaRecusaGuardadaShopee('listagem-removida', 'O anúncio foi removido.')).toBe(
      'O anúncio foi removido.',
    );
  });

  it('a raw row: a non-string motivo reads the sentence; a blank or absent sentence reads null', () => {
    expect(textoDaRecusaGuardadaShopee(42, 'frase')).toBe('frase');
    expect(textoDaRecusaGuardadaShopee(undefined, '   ')).toBeNull();
    expect(textoDaRecusaGuardadaShopee('constructor', null)).toBeNull();
  });
});

describe('#1911 P11 — the Publicar confirmation', () => {
  it('names the conta; on `incerta` it says the publish may ADOPT and «Criar pausado» then does not apply ⟷ livre says neither', () => {
    const livre = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: { tipo: 'livre' },
    });
    expect(livre).toContain('«Loja Teste»');
    expect(livre).not.toContain('Criar pausado');
    const incerta = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: { tipo: 'incerta', desdeMs: null },
    });
    expect(incerta).toContain('vincula-o a este rascunho em vez de criar');
    expect(incerta).toContain('«Criar pausado» não se aplica');
    expect(ROTULO_CRIAR_PAUSADO_SHOPEE).toMatch(/^Criar pausado/);
  });

  it('an attestation exit that ADOPTS (§C #8 mixed) never says «será criado»: it names the adopted listing, «nenhum anúncio novo» and «Criar pausado» not applying ⟷ NEAR-MISS `adota: []` is the create text', () => {
    const adota = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: { tipo: 'incerta', desdeMs: null },
      adota: [222],
    });
    expect(adota).not.toContain('será criado');
    expect(adota).toContain('adotar o anúncio sem vínculo 222 da conta «Loja Teste»');
    expect(adota).toContain('nenhum anúncio novo é criado');
    expect(adota).toContain('«Criar pausado» não se aplica');
    const cria = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: { tipo: 'incerta', desdeMs: null },
      adota: [],
    });
    expect(cria).toContain('O anúncio será criado na conta «Loja Teste»');
    expect(cria).not.toContain('adotar o anúncio');
    expect(cria).toBe(
      textoDaConfirmacaoDePublicacaoShopee({
        contaNome: 'Loja Teste',
        publicacao: { tipo: 'incerta', desdeMs: null },
      }),
    );
  });

  it('the second-listing warning (D15): the count and the duplicate risk — never "já tem 0"', () => {
    const um = textoDoSegundoAnuncioNaPublicacaoShopee({ quantidade: 1, comRascunho: false });
    expect(um).toContain('já tem 1 anúncio(s) deste produto');
    expect(um).toContain('duplicado (spam)');
    expect(textoDoSegundoAnuncioNaPublicacaoShopee({ quantidade: 2, comRascunho: true })).toContain(
      'já tem 2 anúncio(s) ou rascunho(s)',
    );
    expect(
      textoDoSegundoAnuncioNaPublicacaoShopee({ quantidade: 0, comRascunho: false }),
    ).not.toMatch(/\b0\b/);
  });
});

describe('#1911 P11 — the answers of a draft’s Publicar (§C.2)', () => {
  const NOW = 1_800_000_000_000;
  const EM_ANDAMENTO = (aguardarMs: number) =>
    ({
      tipo: 'em-andamento',
      desdeMs: NOW - 60_000,
      expiraEmMs: NOW + aguardarMs,
      aguardarMs,
      aposIncerteza: true,
      posExpiracao: false,
    }) as const;

  it('#6 sibling EM_ANDAMENTO: `vinculos` FIRST — with `aguardarMs` it names the sibling and the seconds', () => {
    const texto = fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
      aguardarMs: 119_001,
      vinculos: [
        { linkDocId: 'R2', itemId: null, rascunho: true },
        { linkDocId: 'L1', itemId: 1000001, rascunho: false },
      ],
    });
    expect(texto).toContain('Outro vínculo deste produto nesta conta está sendo publicado agora');
    expect(texto).toContain('(rascunho R2, anúncio 1000001)');
    expect(texto).toContain('aguarde 120 s');
  });

  it('#6 NEAR-MISS: a sibling with NO `aguardarMs` (uncertain) is the Seller-Centre copy — never "aguarde 0 s"', () => {
    const texto = fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
      aguardarMs: null,
      vinculos: [{ linkDocId: 'R2', itemId: null, rascunho: true }],
    });
    expect(texto).toContain('tem criação incerta (rascunho R2)');
    expect(texto).toContain('confira no Seller Centre');
    expect(texto).not.toContain('aguarde');
  });

  it('#6 NEAR-MISS: the OWN lock (no `vinculos`) is the own-lock copy, whatever `aguardarMs` says', () => {
    const proprio = fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
      aguardarMs: 5_000,
      vinculos: null,
    });
    expect(proprio).toContain('O rascunho está sendo publicado agora');
    expect(proprio).toContain('aguarde 5 s');
    expect(proprio).not.toContain('Outro vínculo');
    for (const aguardarMs of [null, 0]) {
      const semEspera = fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
        aguardarMs,
        vinculos: null,
      });
      expect(semEspera).not.toMatch(/\b0 s\b/);
      expect(semEspera).toContain('aguarde e confira');
    }
    // An EMPTY list is no sibling.
    expect(
      fraseDaPublicacaoDoRascunhoEmAndamentoShopee({ aguardarMs: 5_000, vinculos: [] }),
    ).not.toContain('Outro vínculo');
  });

  it('§H Q3 EXPIRADA: keyed on the code — the server sentence shows, the exit is named, no retry is promised', () => {
    const servidor =
      'a publicação do rascunho R1 parou ANTES do add_item: a busca não coube no tempo da ' +
      'trava. Nada foi enviado à Shopee; tente de novo.';
    const texto = fraseDaPublicacaoExpiradaShopee(servidor);
    expect(texto).toContain('nenhum anúncio foi criado');
    expect(texto).toContain(`Detalhe: ${servidor}`);
    for (const passo of [
      'Seller Centre com o SKU deste produto',
      'importe-o (Canais › Shopee)',
      'descarte este rascunho',
    ]) {
      expect(texto).toContain(passo);
    }
    expect(texto).toContain('não insista');
  });

  it('§H Q3 NEAR-MISS: the request-deadline sentence names the CLI — hidden; our copy never says the SEND timed out nor "nada foi enviado"', () => {
    const cli =
      'a publicação do rascunho R1 parou ANTES do add_item: a busca não coube no tempo desta ' +
      'requisição — pelo CLI (publicar:anuncio), que tem o tempo da trava, ela pode caber. Nada ' +
      'foi enviado à Shopee; tente de novo.';
    const texto = fraseDaPublicacaoExpiradaShopee(cli);
    expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
    expect(texto).not.toContain('Detalhe:');
    expect(texto).not.toMatch(/nada foi enviado/i);
    expect(texto).not.toMatch(/envio (expirou|demorou|excedeu)/i);
    expect(texto).not.toMatch(/^Pode tentar de novo|Tente de novo\./);
  });

  it('CONTENCAO, CRIACAO_INCERTA without a window, and the 404 of a draft discarded elsewhere', () => {
    expect(FRASE_PUBLICACAO_CONTENCAO_SHOPEE).toContain('gravações concorrentes');
    expect(FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE).toContain('não sabe quando');
    expect(FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE).toContain('não existe mais');
    // Never the live link's "this link is not this conta's".
    expect(FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE).not.toContain('não pertence');
  });

  it('a coded 502 on a draft: the server sentence + §H Q2’s exit for a repeat — never a claim about what exists', () => {
    const texto = fraseDaPublicacaoInterrompidaShopee('Shopee recusou get_item_list (offset)');
    expect(texto).toContain('Detalhe: Shopee recusou get_item_list (offset).');
    expect(texto).toContain('se ele continua rascunho e isto se repetir');
    expect(texto).toContain('Seller Centre com o SKU deste produto');
    expect(texto).not.toMatch(/falhou|nenhum anúncio foi criado/);
    expect(fraseDaPublicacaoInterrompidaShopee('rode o comando de novo')).not.toContain('Detalhe:');
    expect(FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE).toContain('Confira o estado do rascunho');
  });

  it('#15 no trustworthy answer: never "falhou" — the wait is the SNAPSHOT’s, as an instant', () => {
    const texto = fraseDaPublicacaoSemRespostaShopee(EM_ANDAMENTO(90_000), NOW);
    expect(texto).toContain(`aguarde até ${formatarInstanteShopee(NOW + 90_000) ?? '?'}`);
    expect(texto).toContain('pode não ter terminado');
    expect(texto).not.toContain('falhou');
    // NEAR-MISS: another reading, another instant — the copy follows the snapshot.
    expect(fraseDaPublicacaoSemRespostaShopee(EM_ANDAMENTO(30 * 60_000), NOW)).not.toBe(texto);
    for (const publicacao of [{ tipo: 'livre' }, { tipo: 'incerta', desdeMs: null }] as const) {
      const outro = fraseDaPublicacaoSemRespostaShopee(publicacao, NOW);
      expect(outro).not.toContain('aguarde até');
      expect(outro).not.toContain('falhou');
    }
  });

  it('#7 the 202: «pode ter criado», never "falhou" — the wait is the snapshot’s reading, not the 202’s nor 240 000', () => {
    const resposta = { reenvioVerificaSku: true, recusa: null } as const;
    const texto = fraseDoAnuncioIncertoShopee(resposta, EM_ANDAMENTO(239_000), NOW);
    expect(texto).toContain(`Aguarde até ${formatarInstanteShopee(NOW + 239_000) ?? '?'}`);
    expect(texto).toContain('publique de novo o mesmo rascunho');
    expect(texto).toContain('pelo SKU enviado');
    expect(texto).toContain('Não mude o SKU do produto');
    expect(texto).not.toContain('falhou');
    expect(TITULO_ANUNCIO_INCERTO_SHOPEE).not.toContain('falhou');
    // NEAR-MISS: the wait over (incerta) ⇒ no instant; the advice stays.
    const depois = fraseDoAnuncioIncertoShopee(resposta, { tipo: 'incerta', desdeMs: NOW }, NOW);
    expect(depois).not.toContain('Aguarde');
    expect(depois).toContain('Publique de novo o mesmo rascunho');
  });

  it('#7 the 202 with `reenvioVerificaSku: false`: the SKU-first text (R-K5); Shopee’s answer follows when it sent one', () => {
    const texto = fraseDoAnuncioIncertoShopee(
      {
        reenvioVerificaSku: false,
        recusa: { codigo: 'error_inner', fraseShopee: 'taking some time to respond' },
      },
      EM_ANDAMENTO(60_000),
      NOW,
    );
    expect(texto).toContain('enviado sem SKU');
    // The SKU-less 202 waits too — on the snapshot's reading, like the SKU'd one.
    expect(texto).toContain(
      `Aguarde até ${formatarInstanteShopee(NOW + 60_000) ?? '?'} e confira no Seller Centre`,
    );
    expect(texto.indexOf('importe-o')).toBeGreaterThan(texto.indexOf('MESMO SKU'));
    expect(texto).not.toContain('pelo SKU enviado');
    expect(texto).toContain('A Shopee respondeu: error_inner — taking some time to respond.');
    expect(
      fraseDoAnuncioIncertoShopee(
        { reenvioVerificaSku: false, recusa: { codigo: 'error_inner', fraseShopee: null } },
        EM_ANDAMENTO(60_000),
        NOW,
      ),
    ).toContain('A Shopee respondeu: error_inner.');
    expect(
      fraseDoAnuncioIncertoShopee({ reenvioVerificaSku: true, recusa: null }, EM_ANDAMENTO(1), NOW),
    ).not.toContain('respondeu');
  });

  it('#14 the 200 of a draft: never «criado», and «Criar pausado» is never implied unless Shopee reads it paused', () => {
    const ativo = fraseDoRascunhoPublicadoShopee(
      { itemId: 1000001, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo },
      { pausadoPedido: true },
    );
    expect(ativo).toContain('anúncio 1000001');
    expect(ativo).toContain('Status na Shopee: Ativo.');
    expect(ativo).toContain('«Criar pausado» não se aplicou');
    for (const t of [ativo, TITULO_RASCUNHO_PUBLICADO_SHOPEE]) expect(t).not.toMatch(/criad|criou/);
    // NEAR-MISSES: paused as asked ⇒ no caveat; not asked ⇒ no caveat; not read ⇒ hedged.
    expect(
      fraseDoRascunhoPublicadoShopee(
        { itemId: 1000001, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado },
        { pausadoPedido: true },
      ),
    ).not.toContain('Criar pausado');
    expect(
      fraseDoRascunhoPublicadoShopee(
        { itemId: 1000001, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo },
        { pausadoPedido: false },
      ),
    ).not.toContain('Criar pausado');
    expect(
      fraseDoRascunhoPublicadoShopee(
        { itemId: 1000001, estadoAnuncio: null },
        { pausadoPedido: true },
      ),
    ).toContain('«Criar pausado» pode não ter se aplicado');
  });

  it('the exits’ copy: the adoption names the free id; the discard warning says it stays on Shopee', () => {
    expect(rotuloDaPublicacaoQueAdotaShopee([1000011])).toBe(
      'Publicar confirmando: o ERP adota o anúncio sem vínculo 1000011 como o desta tentativa — não cria outro',
    );
    expect(avisoDoDescarteComAnuncioSemVinculoShopee([1000011])).toContain(
      'O anúncio sem vínculo 1000011 continua na Shopee',
    );
  });

  it('no Publicar sentence is CLI copy', () => {
    for (const t of [
      FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
      FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
      FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
      FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
      FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
      FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
      FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
      FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE,
      fraseDaPublicacaoExpiradaShopee(''),
      fraseDaPublicacaoInterrompidaShopee(''),
      fraseDoAnuncioIncertoShopee(
        { reenvioVerificaSku: false, recusa: null },
        EM_ANDAMENTO(1),
        NOW,
      ),
    ]) {
      expect(t).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });
});
