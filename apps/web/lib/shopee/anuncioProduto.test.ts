import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
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
  TEXTO_AVISO_KIT,
  TEXTO_MOTIVO_KIT,
  chaveIncerto,
  criacaoDeKitIncerta,
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

  it('NEAR-MISS: a rate-limited 502 (burst / daily) and every 4xx are DEFINITE — nothing ran', () => {
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
    // Another conta, another produto: nothing.
    expect(lerIncerto('int-2', 'prod-1')).toBeNull();
    expect(lerIncerto('int-1', 'prod-2')).toBeNull();
    expect(gravarIncerto('int-1', 'prod-1', null)).toBe(true);
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
  });

  it('reads a stored value that is not JSON, not the shape, or names another conta as nothing', () => {
    const chave = chaveIncerto('int-1', 'prod-1');
    window.sessionStorage.setItem(chave, '{nao-e-json');
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    window.sessionStorage.setItem(chave, JSON.stringify({ ate: 'amanhã', corpo: {} }));
    expect(lerIncerto('int-1', 'prod-1')).toBeNull();
    // Bodies the route refuses (400) are never re-sent: `recriar: false` (the flag is
    // `true` or absent), both arm flags at once, a recriar naming no link.
    for (const corpo of [
      { ...INCERTO.corpo, recriar: false },
      { ...INCERTO.corpo, converterEmKit: true },
      { integracaoId: 'int-1', produtoId: 'prod-1', recriar: true },
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
