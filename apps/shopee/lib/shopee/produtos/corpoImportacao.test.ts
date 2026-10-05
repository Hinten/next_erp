import { describe, expect, it } from 'vitest';

import {
  OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  SHOPEE_IMPORT_STATUS,
  importacaoShopeeOptionsSchema,
} from '@delfrance/schemas';

import {
  CODIGO_STATUS_RECUSADO,
  MSG_BODY_INVALIDO,
  MSG_ITEM_ID_STRING,
  corpoDeErro,
  lerCorpoCancelar,
  lerCorpoImportar,
  lerCorpoImportarTodos,
  lerJsonDoCorpo,
  sanitizarOpcoesImportacao,
  type LeituraCorpo,
} from './corpoImportacao';

const ITEM_ID = 2500139861;

/** The refusal of a read — a helper so a read that PASSED fails loudly here. */
function recusa<T>(leitura: LeituraCorpo<T>): { erro: string; codigo: string | undefined } {
  if (leitura.ok) throw new Error('esperava uma recusa e a leitura passou');
  return { erro: leitura.erro, codigo: leitura.codigo };
}

/** The accepted value of a read — same reason, the other way round. */
function aceito<T>(leitura: LeituraCorpo<T>): T {
  if (!leitura.ok) throw new Error(`esperava uma leitura válida: ${leitura.erro}`);
  return leitura.valor;
}

describe('o corpo precisa ser um objeto JSON', () => {
  for (const [nome, corpo] of [
    ['null', null],
    ['uma lista', [{ integracaoId: 'int-1', itemId: ITEM_ID }]],
    ['um número', 7],
    ['uma string', '{"integracaoId":"int-1"}'],
  ] as const) {
    it(`recusa ${nome} com a mesma frase`, () => {
      expect(recusa(lerCorpoImportar(corpo)).erro).toBe(MSG_BODY_INVALIDO);
    });
  }

  it('um body JSON malformado vira a MESMA frase de um body não-objeto', async () => {
    const req = new Request('http://localhost/importar', { method: 'POST', body: '{"a":' });
    expect(recusa(await lerJsonDoCorpo(req)).erro).toBe(MSG_BODY_INVALIDO);
  });

  it('um body JSON válido chega cru ao leitor', async () => {
    const req = new Request('http://localhost/importar', {
      method: 'POST',
      body: JSON.stringify({ integracaoId: 'int-1', itemId: ITEM_ID }),
    });
    expect(aceito(await lerJsonDoCorpo(req))).toEqual({ integracaoId: 'int-1', itemId: ITEM_ID });
  });

  it('⛔ um erro que NÃO é SyntaxError sobe (regra 6) em vez de virar 400', async () => {
    // Um corpo que nunca chegou não é um corpo malformado, e responder 400
    // mandaria o operador corrigir uma requisição que já estava certa.
    const req = {
      json: () => Promise.reject(new TypeError('socket fechado no meio da leitura')),
    } as unknown as Request;
    await expect(lerJsonDoCorpo(req)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('integracaoId', () => {
  it('é obrigatório', () => {
    expect(recusa(lerCorpoImportar({ itemId: ITEM_ID })).erro).toBe('integracaoId é obrigatório.');
  });

  it('em branco conta como ausente', () => {
    expect(recusa(lerCorpoImportar({ integracaoId: '   ', itemId: ITEM_ID })).erro).toBe(
      'integracaoId é obrigatório.',
    );
  });

  it('chega aparado', () => {
    expect(
      aceito(lerCorpoImportar({ integracaoId: '  int-1  ', itemId: ITEM_ID })).integracaoId,
    ).toBe('int-1');
  });
});

describe('itemId é um NÚMERO — uma string casa com nada no composto do link', () => {
  it('recusa a string numérica com a sua própria frase', () => {
    expect(recusa(lerCorpoImportar({ integracaoId: 'int-1', itemId: '2500139861' })).erro).toBe(
      MSG_ITEM_ID_STRING,
    );
  });

  it('⛔ a string numérica NÃO é convertida', () => {
    // O defeito seria aceitar: o produto sairia cadastrado uma segunda vez
    // porque `where('item_id','==','2500139861')` não encontra o link existente.
    const lido = lerCorpoImportar({ integracaoId: 'int-1', itemId: String(ITEM_ID) });
    expect(lido.ok).toBe(false);
  });

  it('aceita o número', () => {
    expect(aceito(lerCorpoImportar({ integracaoId: 'int-1', itemId: ITEM_ID })).itemId).toBe(
      ITEM_ID,
    );
  });

  for (const [nome, valor] of [
    ['zero', 0],
    ['negativo', -1],
    ['fracionário', 1.5],
    ['acima do inteiro seguro', 2 ** 53],
  ] as const) {
    it(`recusa ${nome}`, () => {
      expect(recusa(lerCorpoImportar({ integracaoId: 'int-1', itemId: valor })).erro).toBe(
        'itemId deve ser um inteiro positivo.',
      );
    });
  }

  it('recusa a ausência', () => {
    expect(recusa(lerCorpoImportar({ integracaoId: 'int-1' })).erro).toBe(
      'itemId é obrigatório e deve ser um número.',
    );
  });
});

describe('sanitizarOpcoesImportacao', () => {
  it('sem options devolve exatamente os padrões', () => {
    expect(aceito(sanitizarOpcoesImportacao(undefined))).toEqual({
      ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
      statuses: [...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses],
    });
  });

  it('o resultado passa pelo schema do documento sem nenhum default a preencher', () => {
    const opcoes = aceito(sanitizarOpcoesImportacao({ importarFotos: false }));
    expect(importacaoShopeeOptionsSchema.parse(opcoes)).toEqual(opcoes);
  });

  it('chaves desconhecidas são ignoradas, não carregadas', () => {
    const opcoes = aceito(
      sanitizarOpcoesImportacao({ importarFotos: false, apagarTudo: true, fila: [1, 2, 3] }),
    );
    expect(opcoes).not.toHaveProperty('apagarTudo');
    expect(opcoes).not.toHaveProperty('fila');
    expect(opcoes.importarFotos).toBe(false);
  });

  it('⛔ um booleano em forma de string é recusado, nunca convertido', () => {
    // `'false'` é truthy: aceitar por veracidade ligaria um toggle que o
    // operador desligou.
    expect(recusa(sanitizarOpcoesImportacao({ importarFotos: 'false' })).erro).toBe(
      'importarFotos deve ser um booleano.',
    );
  });

  it('options null é recusado em vez de virar os padrões', () => {
    expect(recusa(sanitizarOpcoesImportacao(null)).erro).toBe('options deve ser um objeto.');
  });

  it('deduplica statuses preservando a ordem', () => {
    const opcoes = aceito(
      sanitizarOpcoesImportacao({ statuses: ['UNLIST', 'NORMAL', 'UNLIST', 'NORMAL'] }),
    );
    expect(opcoes.statuses).toEqual([SHOPEE_IMPORT_STATUS.unlist, SHOPEE_IMPORT_STATUS.normal]);
  });

  for (const recusado of ['SELLER_DELETE', 'SHOPEE_DELETE']) {
    it(`recusa ${recusado} com o código que a UI lê`, () => {
      const r = recusa(sanitizarOpcoesImportacao({ statuses: ['NORMAL', recusado] }));
      expect(r.codigo).toBe(CODIGO_STATUS_RECUSADO);
    });
  }

  it('⛔ minúsculas NÃO são normalizadas — `normal` é recusado', () => {
    // Dobrar a caixa aqui mandaria para a Shopee um valor que ela recusa,
    // depois de ter dito ao operador que o pedido estava certo.
    const r = recusa(sanitizarOpcoesImportacao({ statuses: ['normal'] }));
    expect(r.codigo).toBe(CODIGO_STATUS_RECUSADO);
  });

  it('uma lista vazia é recusada (o parâmetro é obrigatório no wire)', () => {
    const r = recusa(sanitizarOpcoesImportacao({ statuses: [] }));
    expect(r.erro).toContain('pelo menos um valor');
    expect(r.codigo).toBeUndefined();
  });

  it('statuses que não é lista é recusado', () => {
    expect(recusa(sanitizarOpcoesImportacao({ statuses: 'NORMAL' })).erro).toBe(
      'statuses deve ser uma lista.',
    );
  });

  it('a janela update_time aceita segundos positivos e null', () => {
    const opcoes = aceito(
      sanitizarOpcoesImportacao({ updateTimeFromS: 1_757_000_000, updateTimeToS: null }),
    );
    expect(opcoes).toMatchObject({ updateTimeFromS: 1_757_000_000, updateTimeToS: null });
  });

  it('recusa uma janela invertida', () => {
    expect(
      recusa(sanitizarOpcoesImportacao({ updateTimeFromS: 200, updateTimeToS: 100 })).erro,
    ).toBe('updateTimeToS deve ser maior que updateTimeFromS.');
  });

  it('⛔ os dois limites IGUAIS também são recusados — a janela seria vazia', () => {
    // O `<=` não é decorativo: com `<` a janela [200, 200] passaria e a
    // varredura pediria à Shopee um intervalo que não contém nenhum segundo.
    expect(
      recusa(sanitizarOpcoesImportacao({ updateTimeFromS: 200, updateTimeToS: 200 })).erro,
    ).toBe('updateTimeToS deve ser maior que updateTimeFromS.');
  });

  it('recusa um limite que não é inteiro positivo', () => {
    expect(recusa(sanitizarOpcoesImportacao({ updateTimeFromS: 0 })).erro).toContain(
      'updateTimeFromS',
    );
  });
});

describe('lerCorpoImportarTodos', () => {
  it('devolve options COMPLETAS quando o corpo não traz nenhuma', () => {
    const corpo = aceito(lerCorpoImportarTodos({ integracaoId: 'int-1' }));
    expect(corpo.options.statuses).toEqual([...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses]);
    expect(Object.keys(corpo.options).sort()).toEqual(
      Object.keys(OPCOES_IMPORTACAO_SHOPEE_PADRAO).sort(),
    );
  });

  it('propaga o código do status recusado que veio dentro de options', () => {
    const r = recusa(
      lerCorpoImportarTodos({
        integracaoId: 'int-1',
        options: { statuses: ['NORMAL', 'SELLER_DELETE'] },
      }),
    );
    expect(r.codigo).toBe(CODIGO_STATUS_RECUSADO);
  });

  it('⛔ statuses FORA de options é uma chave desconhecida do corpo — ignorada em silêncio', () => {
    // O corpo só declara `integracaoId` e `options`; um `statuses` no topo não é
    // uma recusa, e por isso o filtro efetivo continua sendo o padrão.
    const corpo = aceito(lerCorpoImportarTodos({ integracaoId: 'int-1', statuses: ['BANNED'] }));
    expect(corpo.options.statuses).toEqual([...OPCOES_IMPORTACAO_SHOPEE_PADRAO.statuses]);
  });
});

describe('lerCorpoCancelar', () => {
  it('exige integracaoId e jobId', () => {
    expect(recusa(lerCorpoCancelar({ integracaoId: 'int-1' })).erro).toBe('jobId é obrigatório.');
    expect(recusa(lerCorpoCancelar({ jobId: 'job-1' })).erro).toBe('integracaoId é obrigatório.');
  });

  it('apara os dois', () => {
    expect(aceito(lerCorpoCancelar({ integracaoId: ' int-1 ', jobId: ' job-1 ' }))).toEqual({
      integracaoId: 'int-1',
      jobId: 'job-1',
    });
  });
});

describe('corpoDeErro', () => {
  it('sem código emite só `error`', () => {
    expect(corpoDeErro({ erro: 'x' })).toEqual({ error: 'x' });
  });

  it('com código emite os dois', () => {
    expect(corpoDeErro({ erro: 'x', codigo: CODIGO_STATUS_RECUSADO })).toEqual({
      error: 'x',
      code: CODIGO_STATUS_RECUSADO,
    });
  });
});
