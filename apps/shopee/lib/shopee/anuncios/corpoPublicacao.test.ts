import { describe, expect, it } from 'vitest';
import {
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_UNLIST_MAX_ITEMS,
} from '@delfrance/integrations-shopee';
import { ACAO_STATUS_ANUNCIO } from '@delfrance/schemas';

import { MSG_BODY_INVALIDO } from '../produtos/corpoImportacao';
import {
  CODIGO_ACAO_INVALIDA,
  CODIGO_SELECAO_EXCEDE_LIMITE,
  CODIGO_SELECAO_INVALIDA,
  MSG_CATEGORY_ID_INVALIDO,
  MSG_LINK_EXIGE_UM_PRODUTO,
  MSG_PRODUTO_ID_INVALIDO,
  MSG_SELECAO_INVALIDA,
  MSG_STATUS_PUBLICACAO,
  corpoDeErroAnuncioStatus,
  lerCorpoAnuncioStatus,
  lerCorpoPublicar,
  lerCorpoReverificar,
  naoDocId,
} from './corpoPublicacao';

const INT_A = 'int-1';
const PRODUTO = 'prod-1';
const LINK = 'link-1';

/** Os quatro valores que `.doc(id)` não pode receber de um corpo. */
const IDS_RECUSADOS: readonly unknown[] = ['', 'a/b', 'a/b/c', '.', '..', 7, null, {}, []];

/** Ids estranhos mas LEGÍTIMOS — o near-miss de cada recusa acima. */
const IDS_ACEITOS: readonly string[] = ['-', '0', 'a.b', '...', 'a-b_c', 'A'.repeat(200)];

describe('naoDocId', () => {
  it('recusa o vazio, o separador e os dois nomes relativos', () => {
    for (const v of ['', 'a/b', 'a/b/c', '.', '..']) {
      expect(naoDocId(v), JSON.stringify(v)).toBe(true);
    }
  });

  it('recusa qualquer coisa que não seja string, inclusive as VERDADEIRAS', () => {
    // Um não-string que por acaso é truthy passa por um guarda `!valor` e só
    // estoura lá dentro do `.doc(id)` — um 500 para o que é erro do cliente.
    for (const v of [7, {}, [], true, () => 1]) {
      expect(naoDocId(v), JSON.stringify(v) ?? String(v)).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: um ponto NO MEIO, três pontos e um hífen sozinho são ids válidos', () => {
    // A recusa é dos nomes relativos EXATOS: alargá-la para `includes('.')`
    // deixaria de aceitar ids que o Firestore aceita perfeitamente.
    for (const v of IDS_ACEITOS) expect(naoDocId(v), v).toBe(false);
  });
});

describe('lerCorpoPublicar', () => {
  it('lê os três campos e aplica os dois padrões', () => {
    const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO });

    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.valor).toEqual({
      integracaoId: INT_A,
      produtoId: PRODUTO,
      linkDocId: null,
      status: SHOPEE_ITEM_STATUS_WRITABLE.normal,
      categoryId: null,
    });
  });

  it('um corpo que não é objeto simples é a MESMA frase do JSON malformado', () => {
    for (const body of [null, [1], 'x', 7]) {
      const lido = lerCorpoPublicar(body);
      expect(lido.ok, JSON.stringify(body) ?? 'null').toBe(false);
      if (lido.ok) continue;
      expect(lido.erro).toBe(MSG_BODY_INVALIDO);
    }
  });

  it('integracaoId e produtoId são obrigatórios', () => {
    for (const nome of ['integracaoId', 'produtoId']) {
      const corpo: Record<string, unknown> = { integracaoId: INT_A, produtoId: PRODUTO };
      delete corpo[nome];
      const lido = lerCorpoPublicar(corpo);
      expect(lido.ok, nome).toBe(false);
      if (lido.ok) continue;
      expect(lido.erro).toBe(`${nome} é obrigatório.`);
    }
  });

  it('⛔ todo id inutilizável é recusado ANTES de qualquer `.doc(id)`', () => {
    for (const v of IDS_RECUSADOS) {
      const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: v });
      expect(lido.ok, JSON.stringify(v) ?? 'null').toBe(false);
      if (lido.ok) continue;
      // Um ausente/null cai na frase de obrigatório; os demais na de id.
      expect(v === null ? `produtoId é obrigatório.` : MSG_PRODUTO_ID_INVALIDO).toBe(lido.erro);
    }
  });

  it('a frase de id inválido tem UMA grafia, montada pelo próprio construtor', () => {
    // `MSG_PRODUTO_ID_INVALIDO` é derivada de `msgIdInvalido('produtoId')`; se
    // alguém escrever a segunda cópia à mão, esta igualdade quebra.
    const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: 'a/b' });
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.erro).toBe(MSG_PRODUTO_ID_INVALIDO);
    expect(MSG_PRODUTO_ID_INVALIDO).toContain('produtoId');
  });

  it('linkDocId ausente e linkDocId null são os dois "sem recorte"', () => {
    for (const body of [
      { integracaoId: INT_A, produtoId: PRODUTO },
      { integracaoId: INT_A, produtoId: PRODUTO, linkDocId: null },
    ]) {
      const lido = lerCorpoPublicar(body);
      expect(lido.ok).toBe(true);
      if (!lido.ok) continue;
      expect(lido.valor.linkDocId).toBeNull();
    }
  });

  it('um linkDocId PRESENTE e inutilizável é recusado', () => {
    const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, linkDocId: '' });
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.erro).toContain('linkDocId');
  });

  it('status aceita os DOIS graváveis e recusa o resto', () => {
    for (const status of [SHOPEE_ITEM_STATUS_WRITABLE.normal, SHOPEE_ITEM_STATUS_WRITABLE.unlist]) {
      const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, status });
      expect(lido.ok, status).toBe(true);
      if (!lido.ok) continue;
      expect(lido.valor.status).toBe(status);
    }
  });

  it('⛔ nenhuma dobra de caixa: `normal` minúsculo é RECUSADO, não convertido', () => {
    // `'normal'` não é `'NORMAL'` neste fio; converter aqui mandaria à Shopee um
    // valor que ela recusa depois de dizer ao operador que o pedido estava bom.
    for (const status of ['normal', 'Unlist', 'DELETED', '', 1, true]) {
      const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, status });
      expect(lido.ok, JSON.stringify(status)).toBe(false);
      if (lido.ok) continue;
      expect(lido.erro).toBe(MSG_STATUS_PUBLICACAO);
    }
  });

  it('status null cai no padrão NORMAL, como o ausente', () => {
    const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, status: null });
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.valor.status).toBe(SHOPEE_ITEM_STATUS_WRITABLE.normal);
  });

  it('categoryId opcional: ausente e null viram null, e um inteiro positivo passa', () => {
    expect(lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO })).toMatchObject({
      valor: { categoryId: null },
    });
    expect(
      lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, categoryId: null }),
    ).toMatchObject({ valor: { categoryId: null } });
    expect(
      lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, categoryId: 100017 }),
    ).toMatchObject({ valor: { categoryId: 100017 } });
  });

  it('⛔ um categoryId em STRING é recusado, nunca coagido', () => {
    // A mesma regra do `itemId`: um id em string não casa nada no fio nem no
    // índice de categorias, e a coerção é o defeito, não a conveniência.
    for (const v of ['100017', 0, -1, 1.5, Number.NaN, {}]) {
      const lido = lerCorpoPublicar({ integracaoId: INT_A, produtoId: PRODUTO, categoryId: v });
      expect(lido.ok, JSON.stringify(v)).toBe(false);
      if (lido.ok) continue;
      expect(lido.erro).toBe(MSG_CATEGORY_ID_INVALIDO);
    }
  });
});

describe('lerCorpoAnuncioStatus', () => {
  function corpo(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      integracaoId: INT_A,
      produtoIds: [PRODUTO],
      acao: ACAO_STATUS_ANUNCIO.pausar,
      ...over,
    };
  }

  it('lê os quatro campos', () => {
    const lido = lerCorpoAnuncioStatus(corpo({ linkDocId: LINK }));
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.valor).toEqual({
      integracaoId: INT_A,
      produtoIds: [PRODUTO],
      acao: ACAO_STATUS_ANUNCIO.pausar,
      linkDocId: LINK,
    });
  });

  it('deduplica MANTENDO a ordem do pedido', () => {
    const lido = lerCorpoAnuncioStatus(corpo({ produtoIds: ['c', 'a', 'c', 'b', 'a'] }));
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.valor.produtoIds).toEqual(['c', 'a', 'b']);
  });

  it('uma acao fora das duas responde SHOPEE_ACAO_INVALIDA', () => {
    for (const acao of ['pausado', 'PAUSAR', '', 1, null, undefined]) {
      const lido = lerCorpoAnuncioStatus(corpo({ acao }));
      expect(lido.ok, JSON.stringify(acao) ?? 'undefined').toBe(false);
      if (lido.ok) continue;
      expect(lido.codigo).toBe(CODIGO_ACAO_INVALIDA);
    }
    expect(lerCorpoAnuncioStatus(corpo({ acao: ACAO_STATUS_ANUNCIO.reativar })).ok).toBe(true);
  });

  it('uma seleção vazia, não-lista ou com id inutilizável responde SHOPEE_SELECAO_INVALIDA', () => {
    for (const produtoIds of [[], 'p-1', {}, [PRODUTO, ''], [PRODUTO, 7], ['a/b'], [null]]) {
      const lido = lerCorpoAnuncioStatus(corpo({ produtoIds }));
      expect(lido.ok, JSON.stringify(produtoIds)).toBe(false);
      if (lido.ok) continue;
      expect(lido.codigo).toBe(CODIGO_SELECAO_INVALIDA);
      expect(lido.erro).toBe(MSG_SELECAO_INVALIDA);
    }
  });

  it('⛔ acima do limite RECUSA e diz o limite e o pedido — nunca trunca', () => {
    const ids = Array.from({ length: SHOPEE_UNLIST_MAX_ITEMS + 1 }, (_, i) => `p-${String(i)}`);
    const lido = lerCorpoAnuncioStatus(corpo({ produtoIds: ids }));

    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.codigo).toBe(CODIGO_SELECAO_EXCEDE_LIMITE);
    expect(lido.limite).toBe(SHOPEE_UNLIST_MAX_ITEMS);
    expect(lido.solicitados).toBe(SHOPEE_UNLIST_MAX_ITEMS + 1);
  });

  it('⚠️ NEAR-MISS: 51 ids com 50 DISTINTOS é aceito — o limite é sobre o deduplicado', () => {
    const ids = Array.from({ length: SHOPEE_UNLIST_MAX_ITEMS }, (_, i) => `p-${String(i)}`);
    const lido = lerCorpoAnuncioStatus(corpo({ produtoIds: [...ids, ids[0]] }));

    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.valor.produtoIds).toHaveLength(SHOPEE_UNLIST_MAX_ITEMS);
  });

  it('exatamente o limite passa', () => {
    const ids = Array.from({ length: SHOPEE_UNLIST_MAX_ITEMS }, (_, i) => `p-${String(i)}`);
    expect(lerCorpoAnuncioStatus(corpo({ produtoIds: ids })).ok).toBe(true);
  });

  it('linkDocId com ≠ 1 produto responde SHOPEE_SELECAO_INVALIDA', () => {
    const lido = lerCorpoAnuncioStatus(corpo({ produtoIds: ['p-1', 'p-2'], linkDocId: LINK }));
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.codigo).toBe(CODIGO_SELECAO_INVALIDA);
    expect(lido.erro).toBe(MSG_LINK_EXIGE_UM_PRODUTO);
  });

  it('⚠️ NEAR-MISS: dois ids IGUAIS com linkDocId passam — um produto depois de deduplicar', () => {
    const lido = lerCorpoAnuncioStatus(corpo({ produtoIds: [PRODUTO, PRODUTO], linkDocId: LINK }));
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.valor.produtoIds).toEqual([PRODUTO]);
  });

  it('um linkDocId inutilizável é recusado pela frase de id', () => {
    const lido = lerCorpoAnuncioStatus(corpo({ linkDocId: 'a/b' }));
    expect(lido.ok).toBe(false);
    if (lido.ok) return;
    expect(lido.erro).toContain('linkDocId');
  });
});

describe('corpoDeErroAnuncioStatus', () => {
  it('sem código nem números é só `error`', () => {
    expect(corpoDeErroAnuncioStatus({ erro: 'x' })).toEqual({ error: 'x' });
  });

  it('com código sem números NÃO inventa limite nem solicitados', () => {
    expect(corpoDeErroAnuncioStatus({ erro: 'x', codigo: CODIGO_SELECAO_INVALIDA })).toEqual({
      error: 'x',
      code: CODIGO_SELECAO_INVALIDA,
    });
  });

  it('os dois números só entram JUNTOS', () => {
    expect(
      corpoDeErroAnuncioStatus({ erro: 'x', codigo: CODIGO_SELECAO_EXCEDE_LIMITE, limite: 50 }),
    ).toEqual({ error: 'x', code: CODIGO_SELECAO_EXCEDE_LIMITE });
    expect(
      corpoDeErroAnuncioStatus({
        erro: 'x',
        codigo: CODIGO_SELECAO_EXCEDE_LIMITE,
        limite: 50,
        solicitados: 51,
      }),
    ).toEqual({ error: 'x', code: CODIGO_SELECAO_EXCEDE_LIMITE, limite: 50, solicitados: 51 });
  });
});

describe('lerCorpoReverificar', () => {
  it('lê os três campos, com linkDocId opcional', () => {
    expect(lerCorpoReverificar({ integracaoId: INT_A, produtoId: PRODUTO })).toEqual({
      ok: true,
      valor: { integracaoId: INT_A, produtoId: PRODUTO, linkDocId: null },
    });
    expect(
      lerCorpoReverificar({ integracaoId: INT_A, produtoId: PRODUTO, linkDocId: LINK }),
    ).toMatchObject({ valor: { linkDocId: LINK } });
  });

  it('recusa um produtoId em branco e um linkDocId não-string', () => {
    expect(lerCorpoReverificar({ integracaoId: INT_A, produtoId: '' }).ok).toBe(false);
    expect(lerCorpoReverificar({ integracaoId: INT_A, produtoId: PRODUTO, linkDocId: 7 }).ok).toBe(
      false,
    );
  });
});
