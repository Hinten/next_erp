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
  fraseDosRascunhosIrmaosIncertosShopee,
  fraseDaPublicacaoExpiradaShopee,
  fraseDaPublicacaoInterrompidaShopee,
  fraseDaPublicacaoSemRespostaShopee,
  fraseDoAnuncioIncertoShopee,
  fraseDoRascunhoPublicadoShopee,
  rotuloDaPublicacaoQueAdotaShopee,
  textoDaConfirmacaoDePublicacaoShopee,
  textoDaRecusaGuardadaShopee,
  textoDoSegundoAnuncioNaPublicacaoShopee,
  tituloDoSegundoAnuncioNaPublicacaoShopee,
  FRASE_ATESTACAO_QUE_VARRE_SHOPEE,
  FRASE_ATESTACAO_SEM_BUSCA_SHOPEE,
  FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_FORA_DO_RASCUNHO_SHOPEE,
  FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE,
  FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE,
  FRASE_ATESTACAO_SUPERADA_SHOPEE,
  FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE,
  PORTA_DA_IMPORTACAO_SHOPEE,
  TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE,
  type ContextoDoRascunhoNoProblemaShopee,
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

/** A DRAFT row's context (`textoDoProblemaShopee`'s 4th argument): `livre`, SKU unknown, unattested. */
function contextoDeRascunho(
  extra: Partial<ContextoDoRascunhoNoProblemaShopee> = {},
): ContextoDoRascunhoNoProblemaShopee {
  return { publicacao: { tipo: 'livre' }, skuEnviado: null, respondeAtestacao: false, ...extra };
}

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

  it('R8-copy#2: on a DRAFT row the terminal backstop names no «Reverificar» ⟷ NEAR-MISS a live row keeps it; a non-terminal sentence reads the same on both', () => {
    const cli = { mensagem: 'rode exatamente o mesmo comando de novo', acao: null };
    const rascunho = textoDoProblemaShopee(cli, 'R1', 'p1', contextoDeRascunho());
    expect(rascunho).toBe(FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE);
    expect(rascunho).not.toContain('Reverificar');
    expect(textoDoProblemaShopee(cli, 'R1', 'p1', null)).toBe(FRASE_RECUSA_SEM_PASSO_SHOPEE);
    const frase = { mensagem: 'A categoria não aceita este atributo.', acao: null };
    expect(textoDoProblemaShopee(frase, 'R1', 'p1', contextoDeRascunho())).toBe(frase.mensagem);
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

  const VIVO = { ehRascunho: false } as const;
  const RASCUNHO = { ehRascunho: true } as const;

  it('labels every step the server names, and never prints the raw code', () => {
    for (const etapa of ETAPAS) {
      const texto = textoDaEtapaShopee(etapa, VIVO);
      expect(texto, etapa).toMatch(/^Recusada na etapa: .+\. Escritas anteriores/);
      // `fotos` is a pt-BR word as well as a code; every other code is a slug.
      if (etapa !== 'fotos') expect(texto, etapa).not.toContain(etapa);
      expect(texto, etapa).not.toContain(DESCONHECIDA);
      expect(texto, etapa).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });

  it('says a refused create created nothing — the one fact the step alone settles', () => {
    expect(textoDaEtapaShopee('add_kit_item', VIVO)).toContain('a Shopee não criou o kit');
    expect(textoDaEtapaShopee('add_item', VIVO)).toContain('a Shopee não criou o anúncio');
  });

  it('NEAR-MISS: an unknown step, or an inherited property name, gets the neutral label', () => {
    for (const etapa of ['etapa_nova', 'toString', '__proto__', 'constructor', '']) {
      for (const contexto of [VIVO, RASCUNHO]) {
        const texto = textoDaEtapaShopee(etapa, contexto);
        expect(texto, etapa).toContain(DESCONHECIDA);
        expect(texto, etapa).not.toContain('undefined');
      }
    }
  });

  it('R8-copy#2: a DRAFT refused at `fotos` / `add_item` names «Publicar», never «Reverificar» (its block has none) ⟷ NEAR-MISS a live listing keeps «Reverificar»', () => {
    for (const etapa of ['fotos', 'add_item']) {
      const rascunho = textoDaEtapaShopee(etapa, RASCUNHO);
      expect(rascunho, etapa).not.toContain('Reverificar');
      expect(rascunho, etapa).toContain('use "Publicar" de novo');
      expect(rascunho, etapa).toContain('Esta tentativa não criou o anúncio');
      // Never a bare «nada foi criado»: an `incerta` draft's EARLIER attempt may have.
      expect(rascunho, etapa).not.toMatch(/nada foi criado|nenhum anúncio foi criado/i);
      expect(textoDaEtapaShopee(etapa, VIVO), etapa).toContain('use "Reverificar"');
    }
  });

  it('R8-copy#2 NEAR-MISS: a draft row at a LATER etapa (a snapshot lagging a create) keeps the caution, names no button, never «Publicar»', () => {
    for (const etapa of ['update_model', 'init_tier_variation', 'leitura-de-volta']) {
      const texto = textoDaEtapaShopee(etapa, RASCUNHO);
      expect(texto, etapa).toContain('Escritas anteriores podem já ter chegado à Shopee');
      expect(texto, etapa).not.toContain('Reverificar');
      expect(texto, etapa).not.toContain('"Publicar"');
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

  it('words exactly the three P10 draft motivos, the nine of P11 and #2015’s logistics refusal — one constant per notice it shares', () => {
    // §C's map size: P10 3 keys + P11 9 keys = 12 (ambígua's second copy is
    // TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE's; `criacao-incerta-encerrada`
    // joined in review round 4), + #2015's `logistica-nao-confirmada` = 13.
    expect(Object.keys(TEXTO_MOTIVO_ANUNCIO_SHOPEE).sort()).toEqual([
      'anuncio-existente-de-outro-produto',
      'anuncio-existente-sem-vinculo',
      'anuncio-semelhante-existente',
      'busca-de-anuncio-existente-incompleta',
      'busca-de-anuncio-incompleta',
      'criacao-incerta-ambigua',
      'criacao-incerta-encerrada',
      'criacao-incerta-ja-vinculada',
      'criacao-incerta-sem-sku',
      'logistica-nao-confirmada',
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
  // Web-internal only: that every slug is the SERVER's is pinned in apps/shopee
  // (`anuncios/errosPublicacao.test.ts`, «o vocabulário que a WEB soletra»).
  it('every key of both draft maps is a MOTIVO_ANUNCIO_SHOPEE slug', () => {
    const slugs = new Set<string>(Object.values(MOTIVO_ANUNCIO_SHOPEE));
    expect(new Set(Object.keys(TEXTO_MOTIVO_ANUNCIO_SHOPEE))).toEqual(slugs);
    // The acao-less map is a SUBSET: a renamed slug loses both rows at once.
    for (const chave of Object.keys(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE)) {
      expect(slugs.has(chave)).toBe(true);
    }
    // ja-vinculada with no acao: the §I1 mismatch refusal that found NO candidate.
    expect(Object.keys(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE)).toEqual([
      'criacao-incerta-ambigua',
      'criacao-incerta-ja-vinculada',
    ]);
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
    expect(vezes(texto, PORTA_DA_IMPORTACAO_SHOPEE)).toBe(1);
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

  it('R8-copy#5: the SKU-moved row NAMES the SKU the attempt sent ⟷ NEAR-MISS an unknown one never asks to restore a value nobody sees', () => {
    const linha = { motivo: M.criacaoIncertaAmbigua, mensagem: CLI, acao: null };
    const comSku = textoDoProblemaShopee(
      linha,
      'R1',
      'p1',
      contextoDeRascunho({ skuEnviado: 'SKU-A' }),
    );
    expect(comSku).toContain('enviada com o SKU «SKU-A»');
    expect(comSku).toContain('volte o SKU do produto a «SKU-A» e publique de novo');
    expect(comSku).not.toMatch(TEXTO_DE_TERMINAL);
    // NEAR-MISS: sent with NO SKU — restoring means clearing it, never an empty «».
    const semSku = textoDoProblemaShopee(linha, 'R1', 'p1', contextoDeRascunho({ skuEnviado: '' }));
    expect(semSku).toContain('A tentativa foi enviada sem SKU.');
    expect(semSku).toContain('tire o SKU do produto e publique de novo');
    expect(semSku).not.toContain('«»');
    // NEAR-MISS: unknown (no record, or no context at all) — no «volte … ao enviado».
    for (const desconhecido of [
      textoDoProblemaShopee(linha, 'R1', 'p1', contextoDeRascunho({ skuEnviado: null })),
      textoDoProblemaShopee(linha),
    ]) {
      expect(desconhecido).toBe(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[M.criacaoIncertaAmbigua]);
      expect(desconhecido).not.toMatch(/volte o SKU|ao enviado|«/);
      expect(desconhecido).toContain(
        'Se o anúncio não existe, descarte este rascunho (Descartar, confirmando) e crie outro.',
      );
    }
    // The WITH-acao row never gains a SKU, whatever the context holds.
    expect(
      textoDoProblemaShopee(
        { ...linha, acao: importar([1000009], []) },
        'R1',
        'p1',
        contextoDeRascunho({ skuEnviado: 'SKU-A' }),
      ),
    ).not.toContain('SKU-A');
  });

  it('#6 busca-de-anuncio-incompleta: THIS attempt created nothing, waiting does not help — the server’s CLI sentence never shows', () => {
    const texto = textoDoProblemaShopee({
      motivo: M.buscaDeAnuncioIncompleta,
      mensagem: 'a busca não terminou (3 página(s) lida(s)) — importe-o (importar:anuncio)',
      acao: null,
    });
    expect(texto).toBe(copia(M.buscaDeAnuncioIncompleta));
    expect(texto).toContain('esta tentativa não criou nada');
    expect(texto).toContain('esperar não ajuda');
    expect(texto).not.toContain('página');
  });

  it('review round 2 (R8-copy#0 NIT): #6 is ENSURE’s row — `incerta` by construction — so never the BARE «nada foi criado» (the earlier attempt may have), on the 422 row and the stored one alike ⟷ NEAR-MISS the rest of the row is unchanged: the same check-first exit, the same «esperar não ajuda»', () => {
    const seis = copia(M.buscaDeAnuncioIncompleta);
    expect(seis).not.toContain('nada foi criado');
    expect(seis).toMatch(
      /^A busca pelo anúncio que a última tentativa pode ter criado não terminou — esta tentativa não criou nada\. /,
    );
    // The stored row reads the same map.
    expect(textoDaRecusaGuardadaShopee(M.buscaDeAnuncioIncompleta, 'frase do servidor')).toBe(seis);
    expect(seis).toContain(
      'Tentar de novo só ajuda numa falha momentânea da Shopee; esperar não ajuda. Confira no ' +
        `Seller Centre: se o anúncio existe, importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}); se não ` +
        'existe, descarte este rascunho (Descartar, confirmando) e crie outro.',
    );
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

  it('#8 MIXED (linked ids + one unlinked candidate): the free id reads «(sem vínculo)» and is NEVER pointed at the mass import (review round 2 — the import would mint a new produto; the row’s adoption exit is the path) ⟷ NEAR-MISS every candidate unlinked keeps the door', () => {
    for (const vinculados of [
      [{ itemId: 1000009, produtoId: 'p1' }], // linked to THIS produto
      [{ itemId: 1000009, produtoId: 'p2' }], // linked to ANOTHER produto
    ]) {
      const texto = textoDoProblemaShopee(
        {
          motivo: M.criacaoIncertaJaVinculada,
          mensagem: CLI,
          acao: importar([1000009, 1000011], vinculados),
        },
        'R1',
        'p1',
      );
      expect(texto).toContain('1000011 (sem vínculo).');
      expect(texto).not.toContain(MASSA);
      expect(texto).not.toContain(PORTA_DA_IMPORTACAO_SHOPEE);
      expect(texto).toBe(
        `${copia(M.criacaoIncertaJaVinculada)} Anúncio(s) na Shopee: ` +
          `${vinculados[0]?.produtoId === 'p1' ? '1000009 (deste produto)' : '1000009 (do produto p2)'}, ` +
          '1000011 (sem vínculo).',
      );
    }
    // NEAR-MISS: every candidate unlinked (round 1's §I1 refusal) — the door stays, once.
    const soLivres = textoDoProblemaShopee(
      { motivo: M.criacaoIncertaJaVinculada, mensagem: CLI, acao: importar([1000011], []) },
      'R1',
      'p1',
    );
    expect(soLivres).toContain('1000011 (sem vínculo).');
    expect(soLivres).toContain(`${MASSA} (${PORTA_DA_IMPORTACAO_SHOPEE})`);
    expect(vezes(soLivres, PORTA_DA_IMPORTACAO_SHOPEE)).toBe(1);
    // NEAR-MISS: the rule is ja-vinculada's alone — another listing motivo whose
    // copy does not name the door keeps it for a free id beside a linked one.
    const outroMotivo = textoDoProblemaShopee(
      {
        motivo: M.anuncioExistenteDeOutroProduto,
        mensagem: CLI,
        acao: importar([1000009, 1000011], [{ itemId: 1000009, produtoId: 'p2' }]),
      },
      'R1',
      'p1',
    );
    expect(outroMotivo).toContain(`${MASSA} (${PORTA_DA_IMPORTACAO_SHOPEE})`);
  });

  it('R8-copy#16: ONE spelling of the menu path — the navigation’s «Canais de venda › Shopee» — in every copy of the module, the kit sentence and the discard dialog included', () => {
    expect(PORTA_DA_IMPORTACAO_SHOPEE).toBe('Canais de venda › Shopee');
    const copias = [
      textoDoProblemaShopee({ mensagem: CLI, acao: importar([1000009], []) }), // the kit's door
      DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeSemVinculo,
      ...Object.values(TEXTO_MOTIVO_ANUNCIO_SHOPEE),
      ...Object.values(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE),
      FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
      avisoDoDescarteComAnuncioSemVinculoShopee([1000011]),
    ];
    for (const t of copias) {
      // NEAR-MISS: the short spelling never survives anywhere.
      expect(t).not.toMatch(/\(Canais › Shopee|Canais › Shopee\)/);
    }
    for (const t of [copias[0], copias[1], FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE]) {
      expect(t).toContain(PORTA_DA_IMPORTACAO_SHOPEE);
    }
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
      'Procure o SKU deste produto no Seller Centre',
      `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE})`,
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

  it('§I2 / R8-copy#0: #11 on a `livre` draft CHECKS FIRST — «se já existe … importe-o» comes before «crie-o» ⟷ never an unconditional «crie o anúncio»', () => {
    const linha = { motivo: M.buscaDeAnuncioExistenteIncompleta, mensagem: CLI, acao: null };
    const livre = textoDoProblemaShopee(linha, 'R1', 'p1', contextoDeRascunho());
    expect(livre).toContain(
      'Procure o SKU deste produto no Seller Centre: se já existe um anúncio com ele, importe-o ' +
        `(${PORTA_DA_IMPORTACAO_SHOPEE}) e descarte este rascunho; se não existe, crie-o lá com ` +
        'esse SKU e importe-o.',
    );
    expect(livre.indexOf('se já existe')).toBeLessThan(livre.indexOf('crie-o'));
    expect(livre).not.toMatch(/crie o anúncio no Seller Centre/);
    // Without a context the row reads its `livre` wording (the state the look-up runs in).
    expect(textoDoProblemaShopee(linha)).toBe(livre);
  });

  it('§I2 / R8-copy#0: #11 read on an `incerta` block gives the LAST attempt’s exit — never «crie-o» ⟷ `em-andamento` waits', () => {
    const linha = { motivo: M.buscaDeAnuncioExistenteIncompleta, mensagem: CLI, acao: null };
    const incerta = textoDoProblemaShopee(
      linha,
      'R1',
      'p1',
      contextoDeRascunho({ publicacao: { tipo: 'incerta', desdeMs: 1_800_000_000_000 } }),
    );
    expect(incerta).toContain(
      'Confira no Seller Centre: se o anúncio da última tentativa existe, importe-o ' +
        `(${PORTA_DA_IMPORTACAO_SHOPEE}) — normalmente a importação adota este rascunho; se ela ` +
        'criar um vínculo à parte, descarte este rascunho depois. Se o anúncio não existe, ' +
        'descarte este rascunho. Não crie outro antes de conferir.',
    );
    expect(incerta).not.toMatch(/crie-o|crie o anúncio/);
    const andamento = textoDoProblemaShopee(
      linha,
      'R1',
      'p1',
      contextoDeRascunho({
        publicacao: {
          tipo: 'em-andamento',
          desdeMs: 1,
          expiraEmMs: 2,
          aguardarMs: 1,
          aposIncerteza: false,
          posExpiracao: false,
        },
      }),
    );
    expect(andamento).toContain('aguarde a aba atualizar');
    expect(andamento).not.toMatch(/crie-o|importe-o/);
  });

  it('§I1: a look-up row answering an ATTESTED publish opens with «a situação mudou … não enviou nada» ⟷ NEAR-MISS unattested, a non-look-up row, or a live row never do', () => {
    const jaVinculada = {
      motivo: M.criacaoIncertaJaVinculada,
      mensagem: CLI,
      acao: importar([1000009], [{ itemId: 1000009, produtoId: 'p2' }]),
    };
    const atestada = contextoDeRascunho({
      publicacao: { tipo: 'incerta', desdeMs: 1 },
      respondeAtestacao: true,
    });
    const texto = textoDoProblemaShopee(jaVinculada, 'R1', 'p1', atestada);
    expect(texto.startsWith(`${FRASE_ATESTACAO_SUPERADA_SHOPEE} `)).toBe(true);
    expect(texto).toContain('1000009 (do produto p2)');
    for (const motivo of [
      M.criacaoIncertaSemSku,
      M.criacaoIncertaAmbigua,
      M.buscaDeAnuncioIncompleta,
    ]) {
      expect(
        textoDoProblemaShopee({ motivo, mensagem: CLI, acao: null }, 'R1', 'p1', atestada),
        motivo,
      ).toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
    }
    // NEAR-MISSES.
    expect(
      textoDoProblemaShopee(jaVinculada, 'R1', 'p1', { ...atestada, respondeAtestacao: false }),
    ).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
    expect(textoDoProblemaShopee(jaVinculada, 'R1', 'p1')).not.toContain(
      FRASE_ATESTACAO_SUPERADA_SHOPEE,
    );
    for (const motivo of [M.anuncioExistenteSemVinculo, M.marcaNaoEscolhida, 'opcoes-demais']) {
      expect(
        textoDoProblemaShopee({ motivo, mensagem: 'x', acao: null }, 'R1', 'p1', atestada),
        motivo,
      ).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
    }
  });

  it('§I1: the server’s mismatch refusal reuses `ja-vinculada` — with NO candidate it never says «já vinculado» (nothing was found), and says itself that nothing was sent', () => {
    const SERVIDOR =
      'a confirmação da criação incerta esperava adotar o anúncio 1000011, e a busca de agora ' +
      'não confere — nada foi enviado nem vinculado.';
    for (const [contexto, esperado] of [
      // Off a draft (review round 4): the link moved since — its own wording.
      [undefined, FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE],
      [
        contextoDeRascunho({
          publicacao: { tipo: 'incerta', desdeMs: 1 },
          respondeAtestacao: true,
        }),
        TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[M.criacaoIncertaJaVinculada],
      ],
    ] as const) {
      const texto = textoDoProblemaShopee(
        { motivo: M.criacaoIncertaJaVinculada, mensagem: SERVIDOR, acao: null },
        'R1',
        'p1',
        contexto,
      );
      expect(texto).toBe(esperado);
      expect(texto).toMatch(/não acha nenhum anúncio|não achou nenhum anúncio/);
      expect(texto).toContain('não enviou nada');
      expect(texto).not.toMatch(/já vinculado|Pode ser o anúncio/);
    }
  });

  it('review round 4: the acao-less `ja-vinculada` row OFF a draft (the link was linked by another path after the refusal) keeps the look-up’s fact and never says «publicar de novo cria um anúncio novo» — that block’s button is a Republicar, an update ⟷ NEAR-MISS every draft reading keeps round 1’s wording byte for byte', () => {
    const vinculada = {
      motivo: M.criacaoIncertaJaVinculada,
      mensagem: 'a busca de agora não confere — nada foi enviado nem vinculado.',
      acao: null,
    };
    const BUSCA = TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[M.criacaoIncertaJaVinculada];
    for (const fora of [undefined, null]) {
      const texto = textoDoProblemaShopee(vinculada, 'R1', 'p1', fora);
      expect(texto).toBe(FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE);
      // The look-up DID run: its fact stays (past — the link moved since).
      expect(texto).toContain(
        'A busca desta publicação não achou nenhum anúncio com o SKU enviado',
      );
      expect(texto).toContain('esta publicação não enviou nada nem vinculou anúncio');
      expect(texto).toContain('Este vínculo não é mais um rascunho');
      // No exit the live block does not offer, no create promise, no draft Publicar.
      expect(texto).not.toMatch(/cria um anúncio novo|publique de novo|Publicar do rascunho/);
      expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
      // Distinct from the refusal that ran NO look-up, off a draft too.
      expect(texto).not.toBe(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_FORA_DO_RASCUNHO_SHOPEE);
      expect(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_FORA_DO_RASCUNHO_SHOPEE).not.toMatch(/busca/);
    }
    // NEAR-MISS: on a draft, whatever the reading, round 1's wording — unchanged.
    expect(BUSCA).toContain('se não existe mais, publicar de novo cria um anúncio novo.');
    for (const publicacao of [
      { tipo: 'livre' },
      { tipo: 'incerta', desdeMs: 1 },
    ] as const satisfies readonly ContextoDoRascunhoNoProblemaShopee['publicacao'][]) {
      for (const respondeAtestacao of [true, false]) {
        expect(
          textoDoProblemaShopee(
            vinculada,
            'R1',
            'p1',
            contextoDeRascunho({ publicacao, respondeAtestacao }),
          ),
          `${publicacao.tipo} ${String(respondeAtestacao)}`,
        ).toBe(BUSCA);
      }
    }
    // NEAR-MISS: a ja-vinculada row WITH an acao off a draft is untouched.
    const comAcao = textoDoProblemaShopee(
      { ...vinculada, acao: importar([1000011], [{ itemId: 1000011, produtoId: 'p2' }]) },
      'R1',
      'p1',
    );
    expect(comAcao).not.toContain(FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE);
    expect(comAcao.startsWith(copia(M.criacaoIncertaJaVinculada))).toBe(true);
  });

  it('review round 4 (re-verify): round 1’s acao-less `ja-vinculada` sentence is pinned as a LITERAL — the routing pins around it compare against the map itself, so a rewording of the map would pass them all', () => {
    expect(TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[M.criacaoIncertaJaVinculada]).toBe(
      'A busca de agora não acha nenhum anúncio com o SKU enviado, criado na janela da última ' +
        'tentativa — esta publicação não enviou nada nem vinculou anúncio. Confira no Seller Centre ' +
        'o anúncio que a recusa anterior mostrou: se ele existe, confira o SKU dele (o ERP só o acha ' +
        'pelo SKU que a última tentativa enviou) e publique de novo; se não existe mais, publicar de ' +
        'novo cria um anúncio novo.',
    );
  });

  it('§I1 completion (review round 4): `criacao-incerta-encerrada` — the refusal that ran NO look-up — reads its own sentence by its MOTIVO in EVERY reading of the block, never a search ⟷ NEAR-MISS the acao-less `ja-vinculada` row (a look-up DID run) keeps round 1’s «A busca de agora» wording in every reading too: one shape, two motivos, two sentences', () => {
    const encerrada = {
      motivo: M.criacaoIncertaEncerrada,
      mensagem:
        'a confirmação da criação incerta esperava adotar o anúncio 1000011, mas, quando esta ' +
        'publicação leu o rascunho, ele já não registrava a criação incerta confirmada — nada foi ' +
        'enviado nem vinculado, e nenhuma busca foi feita.',
      acao: null,
    };
    const vinculada = {
      motivo: M.criacaoIncertaJaVinculada,
      mensagem:
        'a confirmação da criação incerta esperava adotar o anúncio 1000011, e a busca de agora ' +
        'não confere — nada foi enviado nem vinculado.',
      acao: null,
    };
    const BUSCA = TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[M.criacaoIncertaJaVinculada];
    // Every reading the block can hand: the row never asks it.
    const leituras: ContextoDoRascunhoNoProblemaShopee['publicacao'][] = [
      { tipo: 'livre' },
      {
        tipo: 'em-andamento',
        desdeMs: 1,
        expiraEmMs: 2,
        aguardarMs: 1,
        aposIncerteza: false,
        posExpiracao: false,
      },
      {
        tipo: 'em-andamento',
        desdeMs: 1,
        expiraEmMs: 2,
        aguardarMs: 1,
        aposIncerteza: true,
        posExpiracao: false,
      },
      { tipo: 'incerta', desdeMs: 1 },
      { tipo: 'incerta', desdeMs: null },
    ];
    for (const publicacao of leituras) {
      for (const respondeAtestacao of [true, false]) {
        const contexto = contextoDeRascunho({ publicacao, respondeAtestacao });
        const rotulo = `${publicacao.tipo} atestada=${String(respondeAtestacao)}`;
        const texto = textoDoProblemaShopee(encerrada, 'R1', 'p1', contexto);
        expect(texto, rotulo).toBe(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE);
        // No look-up ran: never what a search found, never «o ERP procura».
        expect(texto).not.toMatch(/busca|procur|não acha|já vinculado|Pode ser o anúncio/);
        expect(texto).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
        expect(texto).not.toMatch(TEXTO_DE_TERMINAL);
        // NEAR-MISS: the look-up's acao-less row — round 1's wording, whatever the reading.
        const daBusca = textoDoProblemaShopee(vinculada, 'R1', 'p1', contexto);
        expect(daBusca, rotulo).toBe(BUSCA);
        expect(daBusca).not.toContain(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE);
      }
    }
    // The PAST of the read that decided — true after another run records a
    // NEW attempt; never a present «já não registra», never a retry promise.
    expect(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE).toContain(
      'Quando esta publicação leu o rascunho, ele já não registrava a tentativa',
    );
    expect(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE).toContain('não enviou nada à Shopee');
    expect(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE).toContain(
      'publique de novo pelo Publicar do rascunho, sem confirmação',
    );
    expect(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE).not.toMatch(
      /já não registra a|falhou|tente de novo|foi criado|anúncio criado/,
    );
    // Off a draft (the panel hands no context: the link is no draft any more)
    // — the same fact, and no draft «Publicar» to name.
    const fora = textoDoProblemaShopee(encerrada, 'R1', 'p1');
    expect(fora).toBe(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_FORA_DO_RASCUNHO_SHOPEE);
    expect(fora).not.toContain('Publicar do rascunho');
    expect(fora).toContain('esta publicação não enviou nada à Shopee nem vinculou anúncio');
    expect(fora).toContain('Este vínculo não é mais um rascunho');
    // NEAR-MISS: the look-up's row off a draft keeps ITS fact (a search ran) —
    // its own off-draft sentence, never this one.
    expect(textoDoProblemaShopee(vinculada, 'R1', 'p1')).toBe(
      FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE,
    );
    // NEAR-MISS: a ja-vinculada row WITH an acao on a livre draft is untouched.
    const comAcao = textoDoProblemaShopee(
      { ...vinculada, acao: importar([1000011], [{ itemId: 1000011, produtoId: 'p2' }]) },
      'R1',
      'p1',
      contextoDeRascunho(),
    );
    expect(comAcao).not.toContain(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE);
    expect(comAcao.startsWith(copia(M.criacaoIncertaJaVinculada))).toBe(true);
  });

  it('§I1: a mismatch whose candidates are ALL unlinked reads «ainda sem vínculo» ⟷ NEAR-MISS one linked candidate keeps «já vinculado»', () => {
    const livres = textoDoProblemaShopee(
      { motivo: M.criacaoIncertaJaVinculada, mensagem: CLI, acao: importar([1000011], []) },
      'R1',
      'p1',
    );
    expect(livres).toContain('ainda sem vínculo no ERP');
    expect(livres).not.toContain('já vinculado');
    expect(livres).toContain('1000011 (sem vínculo)');
    const umVinculado = textoDoProblemaShopee(
      {
        motivo: M.criacaoIncertaJaVinculada,
        mensagem: CLI,
        acao: importar([1000009, 1000011], [{ itemId: 1000009, produtoId: 'p2' }]),
      },
      'R1',
      'p1',
    );
    expect(umVinculado.startsWith(copia(M.criacaoIncertaJaVinculada))).toBe(true);
    expect(umVinculado).toContain('já vinculado');
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
  const LIVRE = { tipo: 'livre' } as const;
  const INCERTA = { tipo: 'incerta', desdeMs: null } as const;

  it('names the conta; on `incerta` it says the publish may ADOPT and «Criar pausado» then does not apply ⟷ livre says neither', () => {
    const livre = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: LIVRE,
      atestacao: null,
    });
    expect(livre).toContain('«Loja Teste»');
    expect(livre).not.toContain('Criar pausado');
    const incerta = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: INCERTA,
      atestacao: null,
    });
    expect(incerta).toContain('vincula-o a este rascunho em vez de criar');
    expect(incerta).toContain('«Criar pausado» não se aplica');
    expect(ROTULO_CRIAR_PAUSADO_SHOPEE).toMatch(/^Criar pausado/);
  });

  it('an attestation exit that ADOPTS (§C #8 mixed) never says «será criado»: the adopted listing, «nenhum anúncio novo», «Criar pausado» not applying — and (§I1) a changed situation sends nothing', () => {
    const adota = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: INCERTA,
      atestacao: { adota: [222], varre: true },
    });
    expect(adota).not.toContain('será criado');
    expect(adota).toContain('adotar o anúncio sem vínculo 222 da conta «Loja Teste»');
    expect(adota).toContain('nenhum anúncio novo é criado');
    expect(adota).toContain('«Criar pausado» não se aplica');
    expect(adota).toContain(
      'vinculado a outro produto (ou outro anúncio apareceu), nada é enviado',
    );
    // The guard is the SCAN's: an adoption the look-up would not re-check (no
    // producer makes one — every adopting exit scans) never promises it.
    const semBusca = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: INCERTA,
      atestacao: { adota: [222], varre: false },
    });
    expect(semBusca).not.toContain('nada é enviado');
    expect(semBusca).toContain('nenhum anúncio novo é criado');
  });

  it('KNOWN #12: an attestation that CREATES (`adota: []`, sem-sku or the «segundo anúncio») never promises the SKU look-up ⟷ NEAR-MISS the plain incerta publish keeps it', () => {
    for (const publicacao of [INCERTA, LIVRE]) {
      for (const varre of [true, false]) {
        const cria = textoDaConfirmacaoDePublicacaoShopee({
          contaNome: 'Loja Teste',
          publicacao,
          atestacao: { adota: [], varre },
        });
        expect(cria).toContain('O anúncio será criado na conta «Loja Teste»');
        expect(cria).toContain('cria um anúncio novo, sem adotar nenhum existente');
        expect(cria).not.toMatch(/procura pelo|pelo SKU enviado|vincula-o|adotar o anúncio/);
        // A create: «Criar pausado» applies, so the text never says it does not.
        expect(cria).not.toContain('não se aplica');
      }
    }
    const semAtestar = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Teste',
      publicacao: INCERTA,
      atestacao: null,
    });
    expect(semAtestar).toContain('o ERP o procura pelo SKU enviado');
  });

  it('review round 2 (KNOWN #12 PARTIAL): the SKU-less attestation (`varre: false` — the server never scans) never promises a change-guard nor any scan; it says the ERP cannot look such a listing up and to IMPORT it (SKU first) if it appears ⟷ NEAR-MISS the «segundo de propósito» exit (`varre: true`, same `adota: []`) keeps «Se algo mudou…, nada é enviado»', () => {
    for (const publicacao of [INCERTA, LIVRE]) {
      const semSku = textoDaConfirmacaoDePublicacaoShopee({
        contaNome: 'Loja Teste',
        publicacao,
        atestacao: { adota: [], varre: false },
      });
      expect(semSku).toContain(FRASE_ATESTACAO_SEM_BUSCA_SHOPEE);
      expect(semSku).not.toContain(FRASE_ATESTACAO_QUE_VARRE_SHOPEE);
      expect(semSku).not.toMatch(/nada é enviado|recusa volta|procura pelo|pelo SKU enviado/);
      expect(semSku).toContain('não consegue procurar na Shopee um anúncio enviado sem SKU');
      expect(semSku).toContain('não publique');
      // §C rule 5: never «importe-o» before the SKU step.
      expect(semSku.indexOf('MESMO SKU')).toBeGreaterThan(-1);
      expect(semSku.indexOf('importe-o')).toBeGreaterThan(semSku.indexOf('MESMO SKU'));
      const segundo = textoDaConfirmacaoDePublicacaoShopee({
        contaNome: 'Loja Teste',
        publicacao,
        atestacao: { adota: [], varre: true },
      });
      expect(segundo).toContain(
        'Se algo mudou desde a recusa que você conferiu, nada é enviado e a recusa volta ' +
          'atualizada.',
      );
      expect(segundo).not.toContain(FRASE_ATESTACAO_SEM_BUSCA_SHOPEE);
      expect(segundo).not.toBe(semSku);
    }
    expect(FRASE_ATESTACAO_SEM_BUSCA_SHOPEE).not.toMatch(/\(Canais › Shopee/);
    expect(FRASE_ATESTACAO_SEM_BUSCA_SHOPEE).toContain(PORTA_DA_IMPORTACAO_SHOPEE);
  });
});

describe('#1911 P11 — the second-listing warning inside the Publicar confirmation (D15)', () => {
  const LIVRE = { tipo: 'livre' } as const;
  const INCERTA = { tipo: 'incerta', desdeMs: 1 } as const;
  const SEM_ATESTAR = { publicacao: LIVRE, atestacao: null } as const;

  it('the count and the duplicate risk — never "já tem 0"', () => {
    const um = textoDoSegundoAnuncioNaPublicacaoShopee(
      { quantidade: 1, comRascunho: false },
      SEM_ATESTAR,
    );
    expect(um).toContain('já tem 1 anúncio(s) deste produto');
    expect(um).toContain('duplicado (spam)');
    expect(
      textoDoSegundoAnuncioNaPublicacaoShopee({ quantidade: 2, comRascunho: true }, SEM_ATESTAR),
    ).toContain('já tem 2 anúncio(s) ou rascunho(s)');
    expect(
      textoDoSegundoAnuncioNaPublicacaoShopee({ quantidade: 0, comRascunho: false }, SEM_ATESTAR),
    ).not.toMatch(/\b0\b/);
  });

  it('§I3: no penalty claim in ANY shape — only the duplicate (spam) risk', () => {
    for (const existentes of [
      { quantidade: 1, comRascunho: false, naShopee: 1, rascunhos: 0 },
      { quantidade: 1, comRascunho: true, naShopee: 0, rascunhos: 1 },
      { quantidade: 2, comRascunho: true },
    ]) {
      for (const contexto of [
        SEM_ATESTAR,
        { publicacao: INCERTA, atestacao: null },
        { publicacao: INCERTA, atestacao: { adota: [] } },
        { publicacao: INCERTA, atestacao: { adota: [222] } },
      ]) {
        expect(textoDoSegundoAnuncioNaPublicacaoShopee(existentes, contexto)).not.toMatch(
          /penalidade|pontos/i,
        );
      }
    }
  });

  it('R8-copy#3: every counted vínculo a DRAFT ⇒ this is the FIRST listing — never «cria OUTRO anúncio» nor the «outro anúncio» title ⟷ NEAR-MISS 1 live + 1 draft keeps both', () => {
    const soRascunho = { quantidade: 1, comRascunho: true, naShopee: 0, rascunhos: 1 };
    const texto = textoDoSegundoAnuncioNaPublicacaoShopee(soRascunho, SEM_ATESTAR);
    expect(texto).not.toContain('cria OUTRO anúncio');
    expect(texto).toContain('Há 1 outro(s) rascunho(s) deste produto nesta conta');
    expect(texto).toContain('Este será o primeiro anúncio dele na loja');
    const titulo = tituloDoSegundoAnuncioNaPublicacaoShopee(soRascunho, null);
    expect(titulo).not.toBe(TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE);
    expect(titulo).not.toMatch(/outro anúncio/);
    const misto = { quantidade: 2, comRascunho: true, naShopee: 1, rascunhos: 1 };
    expect(textoDoSegundoAnuncioNaPublicacaoShopee(misto, SEM_ATESTAR)).toContain(
      'Esta conta já tem 1 anúncio(s) deste produto na Shopee e 1 outro(s) rascunho(s). Publicar ' +
        'este rascunho cria OUTRO anúncio',
    );
    expect(tituloDoSegundoAnuncioNaPublicacaoShopee(misto, null)).toBe(
      TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE,
    );
  });

  it('review round 3 (R8-copy#3 sibling, VERIFY-2 round-2 PARTIAL): an UNCERTAIN sibling (`rascunhosIncertos`) makes the D15 text say what the server does — it REFUSES this publish (its sibling scan, confirmation or not) until that draft is resolved on its own block — never «Se nenhum foi criado, … cria o primeiro», whatever the act; this draft’s OWN uncertainty alone keeps the adoption caveat ⟷ NEAR-MISS a certain sibling keeps the old text byte for byte', () => {
    const soRascunho = { quantidade: 1, comRascunho: true, naShopee: 0, rascunhos: 1 };
    const irmaoIncerto = { ...soRascunho, rascunhosIncertos: 1 };
    const ANTIGO =
      'Há 1 outro(s) rascunho(s) deste produto nesta conta, e nenhum anúncio dele na Shopee. Este ' +
      'será o primeiro anúncio dele na loja; publicar um outro rascunho depois criaria um segundo ' +
      'anúncio com o mesmo SKU, que a Shopee pode tratar como duplicado (spam).';
    const CAVEAT = 'a menos que o ERP ache o anúncio da última tentativa deste rascunho e o adote';
    const SAIDA =
      'no bloco dele: se a publicação dele ainda estiver em andamento, aguarde-a terminar; depois ' +
      'confira no Seller Centre — se o anúncio da tentativa dele existe, importe-o (Canais de ' +
      'venda › Shopee, com o mesmo SKU do produto) e, se aquele rascunho continuar na aba, ' +
      'descarte-o; se não existe, descarte aquele rascunho (Descartar, confirmando).';
    const IRMAO =
      'Outro rascunho deste produto nesta conta registra uma tentativa de publicar que pode ter ' +
      'criado um anúncio na Shopee — enquanto ela não for resolvida, o ERP não publica este ' +
      `rascunho. Resolva aquele rascunho ${SAIDA}`;
    // NEAR-MISS: nothing uncertain on either side — the old copy, exactly.
    expect(textoDoSegundoAnuncioNaPublicacaoShopee(soRascunho, SEM_ATESTAR)).toBe(ANTIGO);
    // A sibling uncertain, this draft livre: the refusal and its exit, exactly.
    const irmao = textoDoSegundoAnuncioNaPublicacaoShopee(irmaoIncerto, SEM_ATESTAR);
    expect(irmao).toBe(
      'Há 1 outro(s) rascunho(s) deste produto nesta conta, e nenhum anúncio dele vinculado no ' +
        `ERP. ${IRMAO}`,
    );
    // Whatever the act — this draft uncertain too, an attestation that creates
    // or adopts, a live listing beside it — the server refuses the same way.
    for (const [existentes, contexto] of [
      [irmaoIncerto, { publicacao: INCERTA, atestacao: null }],
      [irmaoIncerto, { publicacao: INCERTA, atestacao: { adota: [] } }],
      [irmaoIncerto, { publicacao: INCERTA, atestacao: { adota: [222] } }],
      [
        { quantidade: 2, comRascunho: true, naShopee: 1, rascunhos: 1, rascunhosIncertos: 1 },
        SEM_ATESTAR,
      ],
    ] as const) {
      const t = textoDoSegundoAnuncioNaPublicacaoShopee(existentes, contexto);
      expect(t.endsWith(IRMAO)).toBe(true);
      expect(t).not.toMatch(
        /Se nenhum foi criado|cria o primeiro|Este será o primeiro|cria OUTRO|não cria anúncio|a menos que/,
      );
    }
    // Two uncertain siblings: said in the plural, each resolved on its own block.
    const dois = textoDoSegundoAnuncioNaPublicacaoShopee(
      { quantidade: 2, comRascunho: true, naShopee: 0, rascunhos: 2, rascunhosIncertos: 2 },
      SEM_ATESTAR,
    );
    expect(dois).toContain(
      'Outros rascunhos deste produto nesta conta registram tentativas de publicar que podem ter ' +
        'criado anúncios na Shopee — enquanto elas não forem resolvidas',
    );
    expect(dois).toContain(`Resolva cada um deles ${SAIDA}`);
    // NEAR-MISS: THIS draft uncertain (plain publish), no uncertain sibling —
    // its publish does run (ENSURE first): the caveat, never the refusal.
    const propria = textoDoSegundoAnuncioNaPublicacaoShopee(soRascunho, {
      publicacao: INCERTA,
      atestacao: null,
    });
    expect(propria).toContain(CAVEAT);
    expect(propria).toContain('Publicar este rascunho cria o primeiro anúncio dele na loja');
    expect(propria).not.toContain('o ERP não publica este rascunho');
    for (const t of [irmao, propria]) {
      expect(t).not.toContain('nenhum anúncio dele na Shopee');
      expect(t).not.toContain('Este será o primeiro');
      expect(t).toContain('nenhum anúncio dele vinculado no ERP');
      expect(t).not.toContain('cria OUTRO');
      expect(t).not.toMatch(/penalidade|pontos/i);
    }
    // An adopting attestation (its draft is uncertain by construction) never
    // says «nenhum anúncio dele na Shopee» beside the listing it adopts.
    const adota = textoDoSegundoAnuncioNaPublicacaoShopee(soRascunho, {
      publicacao: INCERTA,
      atestacao: { adota: [222] },
    });
    expect(adota).toContain('nenhum anúncio dele vinculado no ERP');
    expect(adota).not.toContain('nenhum anúncio dele na Shopee');
    // The title is a question about the count — unchanged by either.
    expect(tituloDoSegundoAnuncioNaPublicacaoShopee(irmaoIncerto, null)).toBe(
      tituloDoSegundoAnuncioNaPublicacaoShopee(soRascunho, null),
    );
  });

  it('R8-copy#3 NEAR-MISS: an UNKNOWN split (a literal without it, or an unreadable 409 counting 0/0) never reads as "only drafts"', () => {
    for (const desconhecido of [
      { quantidade: 1, comRascunho: true },
      { quantidade: 0, comRascunho: false, naShopee: 0, rascunhos: 0 },
    ]) {
      expect(textoDoSegundoAnuncioNaPublicacaoShopee(desconhecido, SEM_ATESTAR)).toContain(
        'cria OUTRO anúncio',
      );
      expect(tituloDoSegundoAnuncioNaPublicacaoShopee(desconhecido, null)).toBe(
        TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE,
      );
    }
  });

  it('KNOWN #11: an ADOPTING attestation creates nothing — never «cria OUTRO anúncio»; it names the listing it links ⟷ NEAR-MISS a CREATING attestation (`adota: []`) keeps «cria OUTRO»', () => {
    const vivo = { quantidade: 1, comRascunho: false, naShopee: 1, rascunhos: 0 };
    const adota = textoDoSegundoAnuncioNaPublicacaoShopee(vivo, {
      publicacao: INCERTA,
      atestacao: { adota: [222] },
    });
    expect(adota).not.toContain('cria OUTRO');
    expect(adota).toContain('não cria anúncio');
    expect(adota).toContain('o anúncio 222, que já existe na Shopee');
    expect(adota).toContain('passa a ter mais de um anúncio nesta conta');
    // NEAR-MISS: beside drafts only, the adopted listing is the produto's FIRST here.
    expect(
      textoDoSegundoAnuncioNaPublicacaoShopee(
        { quantidade: 1, comRascunho: true, naShopee: 0, rascunhos: 1 },
        { publicacao: INCERTA, atestacao: { adota: [222] } },
      ),
    ).not.toContain('mais de um anúncio');
    expect(tituloDoSegundoAnuncioNaPublicacaoShopee(vivo, { adota: [222] })).not.toBe(
      TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE,
    );
    const cria = textoDoSegundoAnuncioNaPublicacaoShopee(vivo, {
      publicacao: INCERTA,
      atestacao: { adota: [] },
    });
    expect(cria).toContain('cria OUTRO anúncio');
    // An attested create is a create: no «a menos que o ERP … adote».
    expect(cria).not.toContain('a menos que');
  });

  it('a PLAIN publish of an `incerta` draft may adopt the last attempt’s listing — said beside «cria OUTRO» ⟷ NEAR-MISS `livre` never says it', () => {
    const vivo = { quantidade: 1, comRascunho: false, naShopee: 1, rascunhos: 0 };
    expect(
      textoDoSegundoAnuncioNaPublicacaoShopee(vivo, { publicacao: INCERTA, atestacao: null }),
    ).toContain('a menos que o ERP ache o anúncio da última tentativa e o adote');
    expect(textoDoSegundoAnuncioNaPublicacaoShopee(vivo, SEM_ATESTAR)).not.toContain('a menos que');
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
  const LIVRE_P = { tipo: 'livre' } as const;
  const INCERTA_P = { tipo: 'incerta', desdeMs: NOW - 600_000 } as const;
  const ABERTURA_LIVRE = 'A publicação parou antes de criar o anúncio — nenhum anúncio foi criado.';

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
    expect(texto).not.toContain('aguarde ');
  });

  it('review round 3 (VERIFY-2 R8-copy#3): an uncertain sibling DRAFT’s 409 names the refusal and THE exit — resolve that draft on its block — never «confira … antes de publicar este» alone ⟷ NEAR-MISS a holder that is not a draft keeps today’s sentence byte for byte', () => {
    const SAIDA =
      'no bloco dele: se a publicação dele ainda estiver em andamento, aguarde-a terminar; depois ' +
      'confira no Seller Centre — se o anúncio da tentativa dele existe, importe-o (Canais de ' +
      'venda › Shopee, com o mesmo SKU do produto) e, se aquele rascunho continuar na aba, ' +
      'descarte-o; se não existe, descarte aquele rascunho (Descartar, confirmando).';
    expect(
      fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
        aguardarMs: null,
        vinculos: [{ linkDocId: 'R2', itemId: null, rascunho: true }],
      }),
    ).toBe(
      'Outro vínculo deste produto nesta conta tem criação incerta (rascunho R2) — enquanto ela ' +
        `não for resolvida, o ERP não publica este rascunho. Resolva aquele rascunho ${SAIDA}`,
    );
    expect(
      fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
        aguardarMs: null,
        vinculos: [
          { linkDocId: 'R2', itemId: null, rascunho: true },
          { linkDocId: 'R3', itemId: null, rascunho: true },
        ],
      }),
    ).toContain(
      `(rascunho R2, rascunho R3) — enquanto ela não for resolvida, o ERP não publica este rascunho. Resolva cada um deles ${SAIDA}`,
    );
    // The SAME exit the «Publicar» gate's `irmao-incerto` names.
    expect(fraseDosRascunhosIrmaosIncertosShopee(['R2'])).toBe(
      'Outro rascunho deste produto nesta conta (rascunho R2) registra uma tentativa de publicar ' +
        'que pode ter criado um anúncio na Shopee — enquanto ela não for resolvida, o ERP não ' +
        `publica este rascunho. Resolva aquele rascunho ${SAIDA}`,
    );
    expect(fraseDosRascunhosIrmaosIncertosShopee(['R2', 'R3'])).toBe(
      'Outros rascunhos deste produto nesta conta (rascunho R2, rascunho R3) registram tentativas ' +
        'de publicar que podem ter criado anúncios na Shopee — enquanto elas não forem ' +
        `resolvidas, o ERP não publica este rascunho. Resolva cada um deles ${SAIDA}`,
    );
    // NEAR-MISS: a holder that is not a draft has no draft block to resolve —
    // today's sentence, exactly.
    expect(
      fraseDaPublicacaoDoRascunhoEmAndamentoShopee({
        aguardarMs: null,
        vinculos: [
          { linkDocId: 'R2', itemId: null, rascunho: true },
          { linkDocId: 'L1', itemId: 1000001, rascunho: false },
        ],
      }),
    ).toBe(
      'Outro vínculo deste produto nesta conta tem criação incerta (rascunho R2, anúncio 1000001) ' +
        '— confira no Seller Centre antes de publicar este rascunho.',
    );
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

  /**
   * A FIXTURE in the shape of apps/shopee's `expirada()` sentence since #1911
   * P12 (review R6-docs#3), one per cause — not a contract: the web keys on
   * the CAUSE clause alone, and that clause is what is pinned across the apps
   * (apps/shopee `reservaRascunho.test.ts` builds every producer's sentence
   * and matches it against this module's causes). The tail around the cause
   * may change shape on the server without a web change.
   */
  const expiradaDoServidor = (causa: string) =>
    `a publicação do rascunho R1 parou antes de terminar: ${causa}. Esta tentativa não criou ` +
    'nenhum anúncio.';
  /**
   * The shape an apps/shopee build from BEFORE P12 answers — deploy skew (the
   * two apps deploy apart). Its tail contradicts the tab: «Nada foi enviado» is
   * false on the fiscal retry's second leg, «tente de novo» sits beside «não
   * insista», `add_item` is the API's name.
   */
  const expiradaDoServidorAntesDoP12 = (causa: string) =>
    `a publicação do rascunho R1 parou ANTES do add_item: ${causa}. Nada foi enviado à Shopee; ` +
    'tente de novo.';
  /** The server's own tail, in either shape — never printed beside a KNOWN cause. */
  const CAUDA_DO_SERVIDOR = /parou antes de terminar:|não criou nenhum anúncio|ANTES do add_item/i;
  const CAUSAS = [
    ['o tempo desta requisição acabaria durante o envio', 'o tempo desta requisição acabaria'],
    ['o tempo da trava acabaria durante o envio', 'o tempo reservado para a publicação acabaria'],
    ['a trava da publicação já não é desta execução', 'outra execução assumiu'],
    ['a liberação encontrou a trava fora desta execução', 'outra execução assumiu'],
    ['a busca não coube no tempo da trava', 'não coube no tempo reservado'],
    [
      'a busca não coube no tempo desta requisição — pelo CLI (publicar:anuncio), que tem o ' +
        'tempo da trava, ela pode caber',
      'não coube no tempo desta requisição',
    ],
  ] as const;
  const CONTRADICAO =
    /nada foi enviado|tente de novo\b|add_item|ANTES do|nenhum anúncio foi criado/i;

  it('§H Q3 / R8-copy#6: EXPIRADA prints the CAUSE in the tab’s words — never the server’s own sentence, on any cause, in the shipped shape or a pre-P12 one («ANTES do add_item … Nada foi enviado; tente de novo»)', () => {
    for (const [causa, palavras] of CAUSAS) {
      for (const servidor of [expiradaDoServidor(causa), expiradaDoServidorAntesDoP12(causa)]) {
        for (const publicacao of [LIVRE_P, INCERTA_P]) {
          const texto = fraseDaPublicacaoExpiradaShopee(servidor, publicacao);
          const causaMostrada = /Causa: ([^.]*)\./.exec(texto)?.[1] ?? '';
          expect(causaMostrada, causa).toContain(palavras);
          expect(texto, causa).not.toContain('Detalhe:');
          expect(texto, causa).not.toMatch(TEXTO_DE_TERMINAL);
          expect(texto, causa).not.toContain('R1');
          expect(texto, causa).not.toMatch(CAUDA_DO_SERVIDOR);
          // Only OUR livre opening may say «nenhum anúncio foi criado»; the server never adds one.
          expect(texto.replace(ABERTURA_LIVRE, ''), causa).not.toMatch(CONTRADICAO);
        }
      }
    }
  });

  it('R8-copy#6 NEAR-MISS: a cause this build does not know shows the sentence as «Detalhe:» only when it contradicts nothing — the shipped shape around it is shown, the SAME cause in the pre-P12 shape is not', () => {
    const neutra = 'a reserva não pôde ser confirmada';
    expect(fraseDaPublicacaoExpiradaShopee(neutra, LIVRE_P)).toContain(`Detalhe: ${neutra}.`);
    // «Esta tentativa não criou nenhum anúncio» is scoped to THIS run: true beside the
    // `livre` and the `incerta` copy alike, so the guard must not fold it away.
    for (const publicacao of [LIVRE_P, INCERTA_P]) {
      expect(
        fraseDaPublicacaoExpiradaShopee(expiradaDoServidor(neutra), publicacao),
        publicacao.tipo,
      ).toContain(`Detalhe: ${expiradaDoServidor(neutra)}`);
    }
    // NEAR-MISS: the same unknown cause wrapped in the pre-P12 tail — hidden whole.
    for (const publicacao of [LIVRE_P, INCERTA_P]) {
      const texto = fraseDaPublicacaoExpiradaShopee(
        expiradaDoServidorAntesDoP12(neutra),
        publicacao,
      );
      expect(texto, publicacao.tipo).not.toMatch(/Detalhe:|Causa:/);
      expect(texto, publicacao.tipo).not.toContain(neutra);
    }
    for (const contraditoria of [
      `${neutra}. Nada foi enviado à Shopee`,
      `${neutra}; tente de novo`,
      `${neutra} antes do add_item`,
      `${neutra}. Nenhum anúncio foi criado`,
    ]) {
      expect(fraseDaPublicacaoExpiradaShopee(contraditoria, LIVRE_P), contraditoria).not.toMatch(
        /Detalhe:|Causa:/,
      );
    }
  });

  it('§I2 / R8-copy#0: EXPIRADA on a `livre` draft CHECKS FIRST — «se já existe … importe-o» before «crie-o»; nothing created; no retry promised', () => {
    const texto = fraseDaPublicacaoExpiradaShopee(expiradaDoServidor(CAUSAS[4][0]), LIVRE_P);
    expect(texto.startsWith(ABERTURA_LIVRE)).toBe(true);
    expect(texto).toContain(
      'Procure o SKU deste produto no Seller Centre: se já existe um anúncio com ele, importe-o ' +
        `(${PORTA_DA_IMPORTACAO_SHOPEE}) e descarte este rascunho; se não existe, crie-o lá com ` +
        'esse SKU e importe-o.',
    );
    expect(texto.indexOf('se já existe')).toBeLessThan(texto.indexOf('crie-o'));
    expect(texto).not.toMatch(/crie o anúncio no Seller Centre/);
    expect(texto).toContain('não insista');
    expect(texto).not.toMatch(/^Pode tentar de novo|Tente de novo\./);
  });

  it('§I2 / R8-copy#0 NEAR-MISS: EXPIRADA on an `incerta` draft — «Esta tentativa não criou nada», the last attempt’s listing first, NEVER «crie» nor a bare «nenhum anúncio foi criado»', () => {
    const texto = fraseDaPublicacaoExpiradaShopee(expiradaDoServidor(CAUSAS[4][0]), INCERTA_P);
    expect(texto).toContain(
      'Esta tentativa não criou nada. Confira no Seller Centre: se o anúncio da última tentativa ' +
        `existe, importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) — normalmente a importação adota este ` +
        'rascunho; se ela criar um vínculo à parte, descarte este rascunho depois. Se o anúncio ' +
        'não existe, descarte este rascunho. Não crie outro antes de conferir.',
    );
    expect(texto).not.toMatch(/crie-o|crie o anúncio|nenhum anúncio foi criado/i);
    expect(texto).not.toBe(
      fraseDaPublicacaoExpiradaShopee(expiradaDoServidor(CAUSAS[4][0]), LIVRE_P),
    );
    // No readable attempt window: the import does not adopt — never «adota este rascunho».
    const semJanela = fraseDaPublicacaoExpiradaShopee('x', { tipo: 'incerta', desdeMs: null });
    expect(semJanela).not.toContain('adota este rascunho');
    expect(semJanela).toContain('com o mesmo SKU do produto) e depois descarte este rascunho');
    // `em-andamento`: wait for the reading — no exit yet.
    const andamento = fraseDaPublicacaoExpiradaShopee('x', EM_ANDAMENTO(5_000));
    expect(andamento).toContain('esta tentativa não criou nada');
    expect(andamento).toContain('aguarde a aba atualizar');
    expect(andamento).not.toMatch(/crie-o|importe-o/);
  });

  it('CONTENCAO, CRIACAO_INCERTA without a window, and the 404 of a draft discarded elsewhere', () => {
    expect(FRASE_PUBLICACAO_CONTENCAO_SHOPEE).toContain('gravações concorrentes');
    expect(FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE).toContain('não sabe quando');
    expect(FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE).toContain('não existe mais');
    // Never the live link's "this link is not this conta's".
    expect(FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE).not.toContain('não pertence');
  });

  it('§I4 (review round 4): an ATTESTED publish’s 409 JA_PUBLICADO says the confirmation had no effect and nothing was created or changed — claiming only what the link RECORDS ⟷ NEAR-MISS the draft routes’ sentence (the block’s own Publicar) stays as it was', () => {
    const t = FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE;
    expect(t).toContain('já não é um rascunho');
    expect(t).toContain('A confirmação que você deu não teve efeito');
    expect(t).toContain('esta publicação não criou nem alterou anúncio');
    expect(t).toContain('o anúncio que ele registra agora');
    // Never that it exists on Shopee NOW (it may have been removed since), never
    // «falhou» while a listing is linked, never a retry, never CLI text.
    expect(t).not.toMatch(/existe na Shopee|falhou|tente de novo|publique de novo|foi criado/i);
    expect(t).not.toMatch(TEXTO_DE_TERMINAL);
    // NEAR-MISS: the plain sentence is untouched — and is NOT the attested one.
    expect(FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE).toBe(
      'Este rascunho já virou anúncio na Shopee — recarregue a aba; o conteúdo de um anúncio ' +
        'publicado não é editado aqui.',
    );
    expect(FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE).not.toContain('confirmação');
  });

  it('a coded 502 on a `livre` draft: the server sentence + §I2’s CHECK-FIRST exit for a repeat — never a claim about what exists', () => {
    const texto = fraseDaPublicacaoInterrompidaShopee(
      'Shopee recusou get_item_list (offset)',
      LIVRE_P,
    );
    expect(texto).toContain('Detalhe: Shopee recusou get_item_list (offset).');
    expect(texto).toContain('se ele continua rascunho e isto se repetir');
    expect(texto).toContain('Procure o SKU deste produto no Seller Centre: se já existe');
    expect(texto.indexOf('se já existe')).toBeLessThan(texto.indexOf('crie-o'));
    expect(texto).not.toMatch(/falhou|nenhum anúncio foi criado|não criou nada/);
    expect(fraseDaPublicacaoInterrompidaShopee('rode o comando de novo', LIVRE_P)).not.toContain(
      'Detalhe:',
    );
    expect(FRASE_LIMITE_NA_PUBLICACAO_DO_RASCUNHO_SHOPEE).toContain('Confira o estado do rascunho');
  });

  it('R8-copy#0 NEAR-MISS: a coded 502 on an `incerta` draft — the last attempt’s listing first, never «crie», and NO «esta tentativa não criou nada» (a landed create may not be in the snapshot yet)', () => {
    const texto = fraseDaPublicacaoInterrompidaShopee('Shopee recusou get_item_list', INCERTA_P);
    expect(texto).toContain('Confira no Seller Centre: se o anúncio da última tentativa existe');
    expect(texto).toContain('Não crie outro antes de conferir.');
    expect(texto).not.toMatch(/crie-o|crie o anúncio|não criou nada|nenhum anúncio foi criado/i);
    expect(fraseDaPublicacaoInterrompidaShopee('x', EM_ANDAMENTO(5_000))).toContain(
      'aguarde a aba atualizar',
    );
    // The server sentence is guarded like EXPIRADA's: a retry promise is never printed.
    expect(fraseDaPublicacaoInterrompidaShopee('falhou; tente de novo', LIVRE_P)).not.toContain(
      'Detalhe:',
    );
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
    // Review round 3 (VERIFY-1's mixed-row PARTIAL): its only producer is the
    // MIXED ja-vinculada row, whose free id is NEVER pointed at the mass import
    // (the shared SKU mints another produto) — it says the listing stays, unlinked.
    expect(avisoDoDescarteComAnuncioSemVinculoShopee([1000011])).toBe(
      'O anúncio sem vínculo 1000011 continua na Shopee, sem vínculo no ERP — o descarte não o ' +
        'vincula a nada.',
    );
    expect(avisoDoDescarteComAnuncioSemVinculoShopee([1000011])).not.toContain(
      PORTA_DA_IMPORTACAO_SHOPEE,
    );
    expect(avisoDoDescarteComAnuncioSemVinculoShopee([1000011])).not.toMatch(/import/i);
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
      ...[LIVRE_P, INCERTA_P, EM_ANDAMENTO(1)].flatMap((publicacao) => [
        fraseDaPublicacaoExpiradaShopee('', publicacao),
        fraseDaPublicacaoInterrompidaShopee('', publicacao),
      ]),
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

describe('#1911 P12 round 2 — R7-roundtrip#5 siblings: the import «normalmente» adopts, and a link apart has its exit', () => {
  // apps/shopee `resolveProduto.ts` declines to adopt even over a READABLE
  // window — two adoptable drafts of the produto, Shopee's `create_time`
  // unknown, the SKU on two produtos — and creates a link apart. So no exit
  // on this tab may promise the adoption flat.
  const COM_JANELA = { tipo: 'incerta', desdeMs: 1_800_000_000_000 } as const;
  const SEM_JANELA = { tipo: 'incerta', desdeMs: null } as const;
  const SAIDA_DO_VINCULO_A_PARTE =
    'se ela criar um vínculo à parte, descarte este rascunho depois. Se o anúncio não existe, ' +
    'descarte este rascunho.';

  /** Every «adota este rascunho» in `texto` sits right after «normalmente a importação (o vincula e )». */
  function soPromessasComRessalva(texto: string): boolean {
    const antes = texto.split('adota este rascunho').slice(0, -1);
    return antes.every((trecho) => /normalmente a importação (o vincula e )?$/i.test(trecho));
  }

  const comJanela = () => [
    fraseDaPublicacaoExpiradaShopee('x', COM_JANELA),
    fraseDaPublicacaoInterrompidaShopee('x', COM_JANELA),
    textoDoProblemaShopee(
      {
        motivo: MOTIVO_ANUNCIO_SHOPEE.buscaDeAnuncioExistenteIncompleta,
        mensagem: 'A Shopee deixou de fora o anúncio 1000011.',
        acao: null,
      },
      'R1',
      'p1',
      contextoDeRascunho({ publicacao: COM_JANELA }),
    ),
  ];

  it('an `incerta` exit WITH a window: «normalmente a importação adota este rascunho», then the link-apart exit, then the not-there case naming the listing', () => {
    for (const texto of comJanela()) {
      expect(texto).toContain(
        `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) — normalmente a importação adota este ` +
          `rascunho; ${SAIDA_DO_VINCULO_A_PARTE} Não crie outro antes de conferir.`,
      );
      expect(soPromessasComRessalva(texto)).toBe(true);
      // NEAR-MISS: the flat promise P11 shipped is gone.
      expect(texto).not.toContain('— a importação adota este rascunho');
    }
  });

  it('the SKU-moved row (ENSURE’s, so it HAS a window): «normalmente … o vincula e adota», the attested discard for a link apart — for a named, an empty and an unknown sent SKU', () => {
    const linha = {
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua,
      mensagem: 'x',
      acao: null,
    };
    for (const skuEnviado of ['SKU-A', '', null]) {
      const texto = textoDoProblemaShopee(
        linha,
        'R1',
        'p1',
        contextoDeRascunho({ publicacao: COM_JANELA, skuEnviado }),
      );
      expect(texto, String(skuEnviado)).toContain(
        `importe-o (${PORTA_DA_IMPORTACAO_SHOPEE}) — normalmente a importação o vincula e adota ` +
          'este rascunho; se ela criar um vínculo à parte, descarte este rascunho (Descartar, ' +
          'confirmando). Se o anúncio não existe, ',
      );
      expect(soPromessasComRessalva(texto), String(skuEnviado)).toBe(true);
      // NEAR-MISS: the flat «que o vincula e adota este rascunho» is gone.
      expect(texto, String(skuEnviado)).not.toContain('que o vincula e adota');
      expect(texto, String(skuEnviado)).not.toMatch(TEXTO_DE_TERMINAL);
    }
  });

  it('NEAR-MISS: the exits that never promised the adoption keep their wording — no window (import, then discard) and `livre` (check first)', () => {
    const semJanela = fraseDaPublicacaoExpiradaShopee('x', SEM_JANELA);
    expect(semJanela).toContain(
      'Confira no Seller Centre: se o anúncio da última tentativa existe, importe-o ' +
        `(${PORTA_DA_IMPORTACAO_SHOPEE}, com o mesmo SKU do produto) e depois descarte este ` +
        'rascunho; se não existe, descarte este rascunho. Não crie outro antes de conferir.',
    );
    expect(semJanela).not.toMatch(/adota|vínculo à parte/);
    const livre = fraseDaPublicacaoExpiradaShopee('x', { tipo: 'livre' });
    expect(livre).not.toMatch(/adota|vínculo à parte/);
    // The helper itself: a flat promise is caught, a hedged one is not.
    expect(soPromessasComRessalva('importe-o — a importação adota este rascunho')).toBe(false);
    expect(soPromessasComRessalva('que o vincula e adota este rascunho')).toBe(false);
    expect(soPromessasComRessalva('normalmente a importação adota este rascunho')).toBe(true);
  });

  it('the discard dialog’s case (c) carries the same hedge (round 1) — one wording for one fact', () => {
    expect(soPromessasComRessalva(DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeSemVinculo)).toBe(
      true,
    );
  });
});

describe('#1911 P12 round 3 — VERIFY-1 NIT 2: the no-window publish 409 names the discard after the import', () => {
  // With no readable attempt window the import NEVER adopts the draft (apps/shopee
  // `resolveProduto.ts`, `sem-tentativa`): it links the listing apart and the
  // draft stays `incerta`, so a second Publicar answers this same 409. The
  // sentence must name the way out after the import — the discard, whose dialog
  // offers «já está vinculado» — or the operator loops on «importe-o».
  const PORTA = PORTA_DA_IMPORTACAO_SHOPEE;
  const COM_JANELA = { tipo: 'incerta', desdeMs: 1_800_000_000_000 } as const;
  const SEM_JANELA = { tipo: 'incerta', desdeMs: null } as const;
  const LIVRE = { tipo: 'livre' } as const;
  const DEPOIS_DA_IMPORTACAO = 'e depois descarte este rascunho';

  it('the 409 sentence, byte for byte: import (with the produto’s SKU) THEN discard confirming; not there ⇒ discard confirming; never «adota»', () => {
    const t = FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE;
    expect(t).toBe(
      'A última tentativa pode ter criado o anúncio e o ERP não sabe quando. Confira no Seller ' +
        `Centre: se existir, importe-o (${PORTA}), com o mesmo SKU do produto, e depois descarte ` +
        'este rascunho confirmando; se não, descarte este rascunho confirmando.',
    );
    // The discard follows the import inside the «se existir» branch — before the «se não».
    const importe = t.indexOf('importe-o');
    const depois = t.indexOf(DEPOIS_DA_IMPORTACAO);
    expect(importe).toBeGreaterThan(-1);
    expect(depois).toBeGreaterThan(importe);
    expect(depois).toBeLessThan(t.indexOf('; se não,'));
    // No window to adopt through: no adoption, hedged or flat; no retry; no CLI text.
    expect(t).not.toMatch(/adota|adoção|vínculo à parte/);
    expect(t).not.toMatch(/publique de novo|tente de novo/i);
    expect(t).not.toMatch(TEXTO_DE_TERMINAL);
    // The exit it names is one the tab offers: the discard dialog’s linked case.
    expect(DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeVinculado).toContain(
      'descartar este rascunho',
    );
  });

  it('PAIR: the same reading words the same exit — the 409 and the no-window branch of the Seller-Centre exit both discard AFTER the import', () => {
    for (const t of [
      FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE,
      fraseDaPublicacaoExpiradaShopee('', SEM_JANELA),
      fraseDaPublicacaoInterrompidaShopee('', SEM_JANELA),
    ]) {
      expect(t).toContain(DEPOIS_DA_IMPORTACAO);
      expect(t).not.toContain('adota');
    }
  });

  it('NEAR-MISS: the windowed, the livre and the no-window wordings of the Seller-Centre exit are byte-identical to round 2 — the clause is the 409’s alone', () => {
    const exitComJanela =
      'Confira no Seller Centre: se o anúncio da última tentativa existe, importe-o ' +
      `(${PORTA}) — normalmente a importação adota este rascunho; se ela criar um vínculo à ` +
      'parte, descarte este rascunho depois. Se o anúncio não existe, descarte este rascunho. ' +
      'Não crie outro antes de conferir.';
    const exitSemJanela =
      'Confira no Seller Centre: se o anúncio da última tentativa existe, importe-o ' +
      `(${PORTA}, com o mesmo SKU do produto) e depois descarte este rascunho; se não existe, ` +
      'descarte este rascunho. Não crie outro antes de conferir.';
    const exitLivre =
      'Procure o SKU deste produto no Seller Centre: se já existe um anúncio com ele, importe-o ' +
      `(${PORTA}) e descarte este rascunho; se não existe, crie-o lá com esse SKU e importe-o.`;
    const interrompida = 'A publicação não terminou: a Shopee recusou uma consulta.';

    expect(fraseDaPublicacaoExpiradaShopee('', COM_JANELA)).toBe(
      `A publicação parou antes de terminar. Esta tentativa não criou nada. ${exitComJanela}`,
    );
    expect(fraseDaPublicacaoInterrompidaShopee('', COM_JANELA)).toBe(
      `${interrompida} ${exitComJanela}`,
    );
    expect(fraseDaPublicacaoExpiradaShopee('', SEM_JANELA)).toBe(
      `A publicação parou antes de terminar. Esta tentativa não criou nada. ${exitSemJanela}`,
    );
    expect(fraseDaPublicacaoExpiradaShopee('', LIVRE)).toBe(
      'A publicação parou antes de criar o anúncio — nenhum anúncio foi criado. Tentar de novo ' +
        `só ajuda se a demora foi passageira; se esta mensagem voltar, não insista. ${exitLivre}`,
    );
    expect(fraseDaPublicacaoInterrompidaShopee('', LIVRE)).toBe(
      `${interrompida} Confira o estado do rascunho; se ele continua rascunho e isto se ` +
        `repetir, não insista. ${exitLivre}`,
    );
    // Where the import normally ADOPTS the draft there is nothing to discard
    // after it — only after a link apart. The 409’s clause must not leak here.
    expect(fraseDaPublicacaoExpiradaShopee('', COM_JANELA)).not.toContain(DEPOIS_DA_IMPORTACAO);
    expect(fraseDaPublicacaoInterrompidaShopee('', COM_JANELA)).not.toContain(DEPOIS_DA_IMPORTACAO);
  });

  it('the CATEGORIA_TRAVADA sibling: an import that leaves this draft here still has an exit — the confirmed discard — and nothing promises an adoption', () => {
    // Shown for EVERY `incerta` reading (block and route 409), window or not,
    // so the exit after the import is keyed on what the operator SEES.
    const t = FRASE_CATEGORIA_TRAVADA_SHOPEE;
    expect(t).toBe(
      'A categoria não muda enquanto a última tentativa de publicar estiver incerta: ela pode ' +
        'ter criado o anúncio na categoria gravada. Confira no Seller Centre: se o anúncio ' +
        'existe, dê a ele o mesmo SKU do produto e importe-o; se não existe, ou se este ' +
        'rascunho continuar aqui depois da importação, descarte este rascunho confirmando. ' +
        'Nada é salvo enquanto a troca de categoria estiver pendente: para salvar o resto, use ' +
        '«Desfazer alterações» (desfaz todas as alterações não salvas) e refaça as outras sem ' +
        'trocar a categoria.',
    );
    const importe = t.indexOf('importe-o;');
    const saida = t.indexOf('se este rascunho continuar aqui depois da importação');
    expect(importe).toBeGreaterThan(-1);
    expect(saida).toBeGreaterThan(importe);
    expect(t.indexOf('descarte este rascunho confirmando')).toBeGreaterThan(saida);
    expect(t).not.toMatch(/adota|adoção/);
    expect(t).not.toMatch(/publique de novo|tente de novo/i);
    // ⛔ quase-par: never the 409’s UNCONDITIONAL «e depois descarte» — with a
    // window the import normally adopts the draft, and then nothing is left
    // to discard; the clause is conditional on the draft still being here.
    expect(t).not.toContain(DEPOIS_DA_IMPORTACAO);
    expect(FRASE_PUBLICACAO_CRIACAO_INCERTA_SEM_JANELA_SHOPEE).not.toContain(
      'continuar aqui depois da importação',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*          #2015 — `logistica-nao-confirmada` (Lucas D2 + D3)                 */
/* -------------------------------------------------------------------------- */

/**
 * #2015: a compulsory channel needs a size or a fee that only a stored list
 * THIS app has no record of writing holds, so publish does not re-send it. The
 * server's sentence (N1, apps/shopee `anuncios/logisticaPublicacao.ts`) names
 * the channel and the listing; the tab's copy names the remedy and the one web
 * door that re-reads a LINKED listing. The browser cannot import apps/shopee,
 * so N1 is spelled here from the server's template (the slug itself is pinned
 * cross-app by `anuncios/errosPublicacao.test.ts`, «o vocabulário que a WEB
 * soletra»).
 */
describe('#2015 — logistica-nao-confirmada: the copy, then the server’s channel and listing as «Detalhe:»', () => {
  const M = MOTIVO_ANUNCIO_SHOPEE;
  const n1 = (canal: number, falta: 'um tamanho' | 'uma tarifa de frete', itemId: number) =>
    `O canal obrigatório ${String(canal)} precisa de ${falta}, e o ERP não tem registro de ter ` +
    'lido da Shopee nem de ter enviado a ela o valor gravado neste vínculo, então esse valor ' +
    `não é reenviado. Importe o anúncio ${String(itemId)} para gravar os valores atuais da ` +
    'Shopee e publique de novo.';
  /** apps/shopee's sentences (1) and (2) — `logistica-sem-canal`, unchanged by #2015. */
  const FRASE_1 =
    'O canal obrigatório 80003 não pôde ser habilitado: falta um valor que só o Seller Centre ' +
    'define (tamanho ou tarifa), ou o item não cabe nos limites do canal.';
  const FRASE_2 = 'Nenhum canal obrigatório da loja pôde ser habilitado para este item.';
  const KIT = 'Já existe na Shopee um kit com o SKU deste produto';
  const TERMINAL = 'rode importar:anuncio --item 1000123 e publique de novo';
  const copia = TEXTO_MOTIVO_ANUNCIO_SHOPEE['logistica-nao-confirmada'] ?? '?';

  it('the slug is spelled as the server’s, and the tab words it', () => {
    expect(M.logisticaNaoConfirmada).toBe('logistica-nao-confirmada');
    expect(copia).not.toBe('?');
  });

  it('a LIVE row: the copy, then N1 verbatim as «Detalhe:» — the channel and the listing reach the screen, for a size and for a fee', () => {
    for (const falta of ['um tamanho', 'uma tarifa de frete'] as const) {
      const frase = n1(80003, falta, 1000123);
      // N1 is not terminal text, so the reader shows it (never swaps it out).
      expect(ehFraseDeTerminal(frase)).toBe(false);
      const texto = textoDoProblemaShopee(
        { motivo: M.logisticaNaoConfirmada, mensagem: frase, acao: null },
        'L1',
        'p1',
      );
      expect(texto).toBe(`${copia} Detalhe: ${frase}`);
      expect(texto).toContain('80003');
      expect(texto).toContain('1000123');
      expect(texto).toContain(falta);
    }
  });

  it('the copy: the import is the remedy, through the ONE web door that re-reads a LINKED listing — and it claims only "no record"', () => {
    expect(copia).toContain('Importe o anúncio para gravar os valores atuais da Shopee');
    expect(copia).toContain(`importação em massa (${PORTA_DA_IMPORTACAO_SHOPEE})`);
    expect(copia).toContain('«Atualizar anúncios já cadastrados» marcado');
    // The mass import skips a linked listing unless the option is ticked.
    expect(copia).toContain('sem essa opção um anúncio já vinculado é pulado');
    // True on ANY link the stamp does not vouch for — never "this ERP never wrote it".
    expect(copia).toContain('o ERP não tem registro de');
    expect(copia).not.toMatch(/nunca (foi )?(lido|enviado)|não foi lido/);
    expect(copia).not.toMatch(TEXTO_DE_TERMINAL);
    // Not the produto's weight or size: no field of the produto is the fix.
    expect(copia).not.toMatch(/peso|dimens/i);
  });

  it('never the kit sentence nor «sem próximo passo» — live or draft, attested or not, whatever the sentence', () => {
    for (const mensagem of [n1(80003, 'um tamanho', 1000123), TERMINAL]) {
      for (const rascunho of [
        undefined,
        null,
        contextoDeRascunho(),
        contextoDeRascunho({ respondeAtestacao: true }),
      ]) {
        const t = textoDoProblemaShopee(
          { motivo: M.logisticaNaoConfirmada, mensagem, acao: null },
          'L1',
          'p1',
          rascunho,
        );
        expect(t.startsWith(copia), mensagem).toBe(true);
        expect(t).not.toContain(KIT);
        expect(t).not.toContain(FRASE_RECUSA_SEM_PASSO_SHOPEE);
        expect(t).not.toContain(FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE);
        // Not a look-up refusal: an attested publish gets no «a situação mudou».
        expect(t).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
      }
    }
  });

  it('NEAR-MISS: a terminal-worded sentence under the SAME motivo is not shown beside the copy', () => {
    expect(
      textoDoProblemaShopee({ motivo: M.logisticaNaoConfirmada, mensagem: TERMINAL, acao: null }),
    ).toBe(copia);
  });

  it('NEAR-MISS: `logistica-sem-canal` keeps the server sentence VERBATIM — no copy, no «Detalhe:»', () => {
    for (const frase of [FRASE_1, FRASE_2]) {
      for (const rascunho of [undefined, contextoDeRascunho()]) {
        expect(
          textoDoProblemaShopee(
            { motivo: 'logistica-sem-canal', mensagem: frase, acao: null },
            'L1',
            'p1',
            rascunho,
          ),
        ).toBe(frase);
      }
    }
  });

  it('the «Detalhe:» set is EXACTLY #11 and this row — every other worded motivo shows its copy alone', () => {
    const neutra = 'frase neutra do servidor';
    const comDetalhe = Object.values(M).filter((motivo) =>
      textoDoProblemaShopee({ motivo, mensagem: neutra, acao: null }).includes(
        `Detalhe: ${neutra}.`,
      ),
    );
    expect(comDetalhe.sort()).toEqual(
      [M.buscaDeAnuncioExistenteIncompleta, M.logisticaNaoConfirmada].sort(),
    );
  });

  it('a STORED row reads the copy by its motivo ⟷ NEAR-MISS a stored `logistica-sem-canal` keeps its sentence', () => {
    expect(textoDaRecusaGuardadaShopee(M.logisticaNaoConfirmada, n1(80003, 'um tamanho', 1))).toBe(
      copia,
    );
    expect(textoDaRecusaGuardadaShopee('logistica-sem-canal', FRASE_1)).toBe(FRASE_1);
  });
});
