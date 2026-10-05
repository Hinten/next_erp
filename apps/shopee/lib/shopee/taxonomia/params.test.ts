import { describe, expect, it } from 'vitest';

import {
  type LeituraParam,
  lerCategoryIdObrigatorio,
  lerCategoryIdOpcional,
  lerIntegracaoId,
  lerInteiro,
  lerTextoObrigatorio,
  lerTextoOpcional,
} from './params';

/**
 * `URLSearchParams` from a plain record, so a spec reads as the query string it
 * stands for. A `null` value means the key is absent; `''` means it was sent
 * empty (`?categoryId=`), which is a DIFFERENT input and has its own rows below.
 */
function query(entradas: Record<string, string | null>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [chave, valor] of Object.entries(entradas)) {
    if (valor !== null) params.append(chave, valor);
  }
  return params;
}

function valorDe<T>(leitura: LeituraParam<T>): T {
  if (!leitura.ok) throw new Error(`esperava sucesso, veio: ${leitura.erro}`);
  return leitura.valor;
}

function erroDe<T>(leitura: LeituraParam<T>): string {
  if (leitura.ok) throw new Error(`esperava erro, veio: ${JSON.stringify(leitura.valor)}`);
  return leitura.erro;
}

describe('lerCategoryIdObrigatorio', () => {
  it('aceita um id de categoria só com dígitos', () => {
    expect(valorDe(lerCategoryIdObrigatorio(query({ categoryId: '100182' })))).toBe(100182);
  });

  // ⚠️ O par que importa: a tabela abaixo mostra onde a leitura PARA. Cada linha
  // é um valor que `parseInt` aceitaria (ou converteria em algo plausível) e que
  // assinaria uma chamada perfeitamente válida para a categoria ERRADA — a
  // Shopee responderia 200 com os atributos de outra categoria.
  it.each([
    ['100182abc', 'categoryId deve conter apenas dígitos.'], // parseInt → 100182
    ['1e5', 'categoryId deve conter apenas dígitos.'], // Number → 100000
    [' 100182', 'categoryId deve conter apenas dígitos.'], // Number → 100182
    ['100182 ', 'categoryId deve conter apenas dígitos.'],
    ['1.5', 'categoryId deve conter apenas dígitos.'], // parseInt → 1
    ['-1', 'categoryId deve conter apenas dígitos.'],
    ['+1', 'categoryId deve conter apenas dígitos.'],
    ['0x10', 'categoryId deve conter apenas dígitos.'], // Number → 16
    ['   ', 'categoryId deve conter apenas dígitos.'],
    ['0', 'categoryId deve ser um inteiro positivo.'], // Number('') também daria 0
  ])('recusa %j com a mensagem em pt-BR', (raw, mensagem) => {
    expect(erroDe(lerCategoryIdObrigatorio(query({ categoryId: raw })))).toBe(mensagem);
  });

  it.each([
    ['ausente', null],
    ['enviado vazio', ''],
  ])('cobra o parâmetro quando ele está %s', (_caso, raw) => {
    expect(erroDe(lerCategoryIdObrigatorio(query({ categoryId: raw })))).toBe(
      'categoryId é obrigatório.',
    );
  });

  it('recusa um id acima do inteiro seguro em vez de arredondá-lo', () => {
    // O par: 2^53 - 1 passa, 2^53 + 1 não. `Number('9007199254740993')` responde
    // 9007199254740992 sem erro — um id de provedor que "cabe" é uma suposição,
    // não um fato (os brand_id da Shopee já passam de int32).
    expect(valorDe(lerCategoryIdObrigatorio(query({ categoryId: '9007199254740991' })))).toBe(
      9_007_199_254_740_991,
    );
    expect(erroDe(lerCategoryIdObrigatorio(query({ categoryId: '9007199254740993' })))).toBe(
      'categoryId deve ser um inteiro positivo.',
    );
  });
});

describe('lerCategoryIdOpcional', () => {
  it('responde null quando o parâmetro não veio — a leitura da loja inteira', () => {
    // `null` é VALOR, não falha: `get_item_limit` documenta o parâmetro como
    // opcional e responde as faixas da loja sem ele.
    expect(valorDe(lerCategoryIdOpcional(query({})))).toBeNull();
  });

  it('responde null quando o parâmetro veio vazio', () => {
    expect(valorDe(lerCategoryIdOpcional(query({ categoryId: '' })))).toBeNull();
  });

  it('valida com o mesmo rigor quando o parâmetro veio', () => {
    // A quase-falha do caso acima: ausente vira null, presente e inválido é 400.
    // Um `0` implícito aqui guardaria a resposta da loja sob uma categoria que
    // não existe.
    expect(valorDe(lerCategoryIdOpcional(query({ categoryId: '100182' })))).toBe(100182);
    expect(erroDe(lerCategoryIdOpcional(query({ categoryId: '0' })))).toBe(
      'categoryId deve ser um inteiro positivo.',
    );
    expect(erroDe(lerCategoryIdOpcional(query({ categoryId: '1e5' })))).toBe(
      'categoryId deve conter apenas dígitos.',
    );
  });
});

describe('lerInteiro — pageSize (1 a 100)', () => {
  const opcoes = { min: 1, max: 100, padrao: 100 } as const;

  it('usa o padrão quando o parâmetro não veio', () => {
    expect(valorDe(lerInteiro(query({}), 'pageSize', opcoes))).toBe(100);
  });

  it('aceita as duas bordas', () => {
    expect(valorDe(lerInteiro(query({ pageSize: '1' }), 'pageSize', opcoes))).toBe(1);
    expect(valorDe(lerInteiro(query({ pageSize: '100' }), 'pageSize', opcoes))).toBe(100);
  });

  // A quase-falha de cada borda: um a menos e um a mais. `page_size` é 1–100 na
  // própria página do `get_brand_list`; 101 tem de morrer aqui, com o nome do
  // parâmetro, e não virar um `ShopeeConfigError` genérico no pacote.
  it.each(['0', '101', '-1', '1.5', '1e2', ' 50', 'muitos'])(
    'recusa pageSize=%j com a mesma mensagem',
    (raw) => {
      expect(erroDe(lerInteiro(query({ pageSize: raw }), 'pageSize', opcoes))).toBe(
        'pageSize deve estar entre 1 e 100.',
      );
    },
  );
});

describe('lerInteiro — offset (>= 0, sem teto)', () => {
  const opcoes = { min: 0, padrao: 0 } as const;

  it('aceita zero, que é o primeiro offset da paginação', () => {
    // O par do `pageSize` acima: aqui `0` é válido. Uma leitura que recusasse
    // todo falsy nunca leria a primeira página de marcas.
    expect(valorDe(lerInteiro(query({ offset: '0' }), 'offset', opcoes))).toBe(0);
  });

  it('aceita um offset grande, porque a página não documenta teto', () => {
    expect(valorDe(lerInteiro(query({ offset: '3200' }), 'offset', opcoes))).toBe(3200);
  });

  it.each(['-1', '1.5', ' 10', '   '])('recusa offset=%j', (raw) => {
    expect(erroDe(lerInteiro(query({ offset: raw }), 'offset', opcoes))).toBe(
      'offset deve ser um inteiro >= 0.',
    );
  });

  it('trata o parâmetro vazio como ausente, caindo no padrão', () => {
    // A quase-falha da linha '   ' acima: vazio é ausente, espaço em branco não.
    expect(valorDe(lerInteiro(query({ offset: '' }), 'offset', opcoes))).toBe(0);
  });
});

describe('lerInteiro — status (1 normal / 2 pendente)', () => {
  const opcoes = {
    min: 1,
    max: 2,
    padrao: 1,
    mensagem: 'status deve ser 1 (normal) ou 2 (pendente).',
  } as const;

  it.each([
    ['1', 1],
    ['2', 2],
  ])('aceita status=%j', (raw, esperado) => {
    expect(valorDe(lerInteiro(query({ status: raw }), 'status', opcoes))).toBe(esperado);
  });

  it.each(['0', '3', 'normal'])(
    'recusa status=%j com a mensagem da enumeração, não com uma faixa',
    (raw) => {
      // "deve estar entre 1 e 2" seria verdadeiro e inútil: o parâmetro é uma
      // enumeração, e a mensagem tem de dizer o que cada valor significa.
      expect(erroDe(lerInteiro(query({ status: raw }), 'status', opcoes))).toBe(
        'status deve ser 1 (normal) ou 2 (pendente).',
      );
    },
  );
});

describe('lerTextoObrigatorio / lerTextoOpcional', () => {
  it('apara o texto — a assimetria proposital com os parâmetros numéricos', () => {
    // Espaço em volta de um NOME é digitação de operador; em volta de um id de
    // provedor não é nada legítimo. Por isso um é aparado e o outro é recusado
    // (a linha ' 100182' na tabela do categoryId é a outra metade deste par).
    expect(valorDe(lerTextoObrigatorio(query({ nome: '  Camiseta Básica  ' }), 'nome'))).toBe(
      'Camiseta Básica',
    );
  });

  it.each([
    ['ausente', null],
    ['vazio', ''],
    ['só espaços', '   '],
  ])('cobra o nome quando ele está %s', (_caso, raw) => {
    expect(erroDe(lerTextoObrigatorio(query({ nome: raw }), 'nome'))).toBe('nome é obrigatório.');
  });

  it('responde null para o opcional ausente, vazio ou só com espaços', () => {
    expect(valorDe(lerTextoOpcional(query({}), 'imagemCapa'))).toBeNull();
    expect(valorDe(lerTextoOpcional(query({ imagemCapa: '' }), 'imagemCapa'))).toBeNull();
    expect(valorDe(lerTextoOpcional(query({ imagemCapa: '  ' }), 'imagemCapa'))).toBeNull();
  });

  it('devolve o texto aparado quando o opcional veio', () => {
    expect(valorDe(lerTextoOpcional(query({ imagemCapa: ' abc123 ' }), 'imagemCapa'))).toBe(
      'abc123',
    );
  });
});

describe('lerIntegracaoId', () => {
  it('devolve o id aparado', () => {
    expect(valorDe(lerIntegracaoId(query({ integracaoId: ' int-1 ' })))).toBe('int-1');
  });

  it.each([
    ['ausente', null],
    ['vazio', ''],
    ['só espaços', ' '],
  ])('recusa o id %s com a mensagem que as rotas já usam', (_caso, raw) => {
    // Mesma frase da rota /conta, que já responde 400 com ela — duas mensagens
    // diferentes para a mesma falta seriam duas coisas a manter em dia.
    expect(erroDe(lerIntegracaoId(query({ integracaoId: raw })))).toBe(
      'integracaoId é obrigatório.',
    );
  });
});
