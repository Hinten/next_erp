import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolverEntradaShopeeDoGrupo } from '@delfrance/schemas';
import { DELETE_MARK } from '@delfrance/ui';
import { ZodError } from 'zod';

import {
  CONFLITO_VINCULO_SHOPEE,
  MARCA_CONFLITO_VINCULO_SHOPEE,
  TIPO_ACHADO_SHOPEE,
  TIPO_ITEM_VINCULO_SHOPEE,
  achadosDaLeituraShopee,
  achadosDoVinculadorShopee,
  agruparVinculosShopee,
  alternarRemocaoShopee,
  chaveDoVinculoShopee,
  definirGrupoDoVinculoShopee,
  definirOpcaoDaVarianteShopee,
  ehVinculoNovoShopee,
  escolhaAtualDaVariante,
  escolhaDaLinhaShopee,
  grupoAusenteShopee,
  linkDoSeedShopee,
  marcaDeConflitoShopee,
  mensagemDoAchadoShopee,
  novoVinculoShopee,
  prepararVinculosShopee,
  rebaseVinculosShopee,
  removerVinculoShopee,
  situacaoDaChaveShopee,
  validarVinculosShopee,
  valorDaLinhaShopee,
  type AchadoVinculoShopee,
  type ItemVinculoShopee,
  type SeedVinculadorShopee,
} from './vinculadorShopee';

/**
 * The Shopee linker's pure rules: what the tab edits, what its save checks, how a
 * conflicting save merges. Taxonomy values are Shopee's public ones; contas,
 * variantes and every other name are invented.
 *
 * Every fold comes as a PAIR — what must come out equal, and the near-miss that
 * must stay distinct:
 *  - the conta key folds a path to its last segment and nothing more;
 *  - a standard option is its id, whatever the name says; a custom one is its
 *    byte-exact name;
 *  - a name is displayed trimmed and stored verbatim;
 *  - the band measures custom names only;
 *  - re-choosing is not an edit, and only a row THIS call emptied is dropped;
 *  - a finding blocks only through an edited entry;
 *  - an emptied list goes back to the seed, whichever it was;
 *  - a conflict merges key by key, and a key both sides changed stays the server's.
 */

type Doc = Record<string, unknown>;

const FASHION = 100352;
const BR = 844758844060204;
const INT = 841350766059029;

const linha = (id: number, nome: string, variantes: string[]): Doc => ({
  shopee_option_id: id,
  shopee_option_name: nome,
  arakene_variation_id: variantes,
});

const vinculo = (conta: string, categoria: unknown, linhas: Doc[], extra: Doc = {}): Doc => ({
  name: `Categoria ${String(categoria)}`,
  category_id: categoria,
  variation_id: 101054,
  variation_group_list: 0,
  integracaoShopeeId: conta,
  variationOptions: linhas,
  ...extra,
});

const variante = (id: string, nome = id.toUpperCase()) => ({ id, nome, codigo: null });
const VARIANTES = [variante('p'), variante('m'), variante('g')];

const seed = (links: unknown, variacoes: unknown = VARIANTES): SeedVinculadorShopee => ({
  links,
  variacoes,
});

const opcoesDe = (entrada: unknown): Doc[] => (entrada as Doc).variationOptions as Doc[];

const tipos = (achados: readonly AchadoVinculoShopee[]) => achados.map((a) => a.tipo);

const ehLegivel = (
  item: ItemVinculoShopee | undefined,
): item is Extract<ItemVinculoShopee, { gemea: boolean }> =>
  item !== undefined && item.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel;

describe('chaveDoVinculoShopee — a chave compartilhada, em texto', () => {
  it('IGUAL: toda forma de caminho da conta dá a mesma chave, e as marcas não contam', () => {
    const nua = chaveDoVinculoShopee(vinculo('int-1', FASHION, []));
    expect(nua).not.toBeNull();
    expect(chaveDoVinculoShopee(vinculo('documents/integracao/int-1', FASHION, []))).toBe(nua);
    expect(chaveDoVinculoShopee(vinculo('integracao/int-1', FASHION, []))).toBe(nua);
    expect(chaveDoVinculoShopee(vinculo('int-1/', FASHION, []))).toBe(nua);
    expect(chaveDoVinculoShopee({ ...vinculo('int-1', FASHION, []), [DELETE_MARK]: true })).toBe(
      nua,
    );
    expect(
      chaveDoVinculoShopee({
        ...vinculo('int-1', FASHION, []),
        [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.alterado,
      }),
    ).toBe(nua);
  });

  it.each(['int-12', 'xint-1', 'Int-1', ' int-1', 'int-1 '])(
    '⚠️ QUASE-PAR: a conta %j é outra chave',
    (conta) => {
      expect(chaveDoVinculoShopee(vinculo(conta, FASHION, []))).not.toBe(
        chaveDoVinculoShopee(vinculo('int-1', FASHION, [])),
      );
    },
  );

  it('⚠️ QUASE-PAR: a categoria como string, ou ausente, não nomeia chave', () => {
    expect(chaveDoVinculoShopee(vinculo('int-1', String(FASHION), []))).toBeNull();
    expect(chaveDoVinculoShopee({ integracaoShopeeId: 'int-1' })).toBeNull();
  });

  it.each([[null], ['lixo'], [7], [[1, 2]], [undefined]])(
    'um elemento que não é objeto (%j) não tem chave, e nunca lança',
    (elemento) => {
      expect(chaveDoVinculoShopee(elemento)).toBeNull();
    },
  );
});

describe('agruparVinculosShopee — um bloco por conta ATIVA, pela chave compartilhada', () => {
  const ativas = new Set(['int-1']);

  it.each(['int-1', 'documents/integracao/int-1', 'integracao/int-1', 'int-1/'])(
    'IGUAL: %j cai no bloco de `int-1`',
    (conta) => {
      const grupos = agruparVinculosShopee([vinculo(conta, FASHION, [])], ativas);
      expect(grupos.porConta.get('int-1')?.map((i) => i.indice)).toEqual([0]);
      expect(grupos.outras).toEqual([]);
    },
  );

  it('IGUAL: as quatro formas juntas formam UM bloco só', () => {
    const grupos = agruparVinculosShopee(
      [
        vinculo('int-1', 1, []),
        vinculo('documents/integracao/int-1', 2, []),
        vinculo('integracao/int-1', 3, []),
        vinculo('int-1/', 4, []),
      ],
      ativas,
    );
    expect([...grupos.porConta.keys()]).toEqual(['int-1']);
    expect(grupos.porConta.get('int-1')?.map((i) => i.indice)).toEqual([0, 1, 2, 3]);
  });

  it.each(['int-12', 'Int-1', ' int-1', 'documents/integracao/int-12', 'int-2'])(
    '⚠️ QUASE-PAR: %j nunca cai no bloco de `int-1`',
    (conta) => {
      const grupos = agruparVinculosShopee([vinculo(conta, FASHION, [])], ativas);
      expect(grupos.porConta.size).toBe(0);
      expect(grupos.outras.map((i) => i.indice)).toEqual([0]);
    },
  );

  it('⚠️ QUASE-PAR: `int-1` nunca cai no bloco de uma conta `int-12`', () => {
    const grupos = agruparVinculosShopee([vinculo('int-1', FASHION, [])], new Set(['int-12']));
    expect(grupos.porConta.size).toBe(0);
    expect(grupos.outras).toHaveLength(1);
  });

  it('entrada legível vira cartão, a personalizada é marcada como tal', () => {
    const padrao = vinculo('int-1', FASHION, [linha(6857, 'P', ['p'])]);
    const custom = vinculo('int-1', 200, [linha(0, 'Cor do ERP', ['p'])], { variation_id: 0 });
    const [a, b] = agruparVinculosShopee([padrao, custom], ativas).porConta.get('int-1') ?? [];
    expect(a?.tipo).toBe(TIPO_ITEM_VINCULO_SHOPEE.padrao);
    expect(b?.tipo).toBe(TIPO_ITEM_VINCULO_SHOPEE.personalizada);
    expect(a?.chave).toEqual({ integracaoId: 'int-1', categoryId: FASHION });
    if (!ehLegivel(a)) throw new TypeError('esperava um item legível');
    expect(a.link.variationOptions).toEqual([linha(6857, 'P', ['p'])]);
    expect(a.gemea).toBe(false);
  });

  it('um elemento de outra conta é mantido, à parte', () => {
    const grupos = agruparVinculosShopee([vinculo('int-2', FASHION, [])], ativas);
    expect(grupos.outras.map((i) => [i.indice, i.chave?.integracaoId])).toEqual([[0, 'int-2']]);
  });

  describe('gêmeas', () => {
    const primeira = vinculo('int-1', FASHION, [linha(6857, 'P', ['p'])]);
    const gemea = vinculo('documents/integracao/int-1', FASHION, [linha(6270, 'M', ['m'])]);

    it('a segunda da mesma chave, mesmo em outra grafia, não é lida pela publicação', () => {
      const itens = agruparVinculosShopee([primeira, gemea], ativas).porConta.get('int-1');
      if (!ehLegivel(itens?.[0]) || !ehLegivel(itens?.[1])) {
        throw new TypeError('esperava dois itens legíveis');
      }
      expect(itens[0].gemea).toBe(false);
      expect(itens[1].gemea).toBe(true);
    });

    it('⚠️ QUASE-PAR: com a primeira marcada para remoção, a seguinte passa a ser a lida', () => {
      const removida = { ...primeira, [DELETE_MARK]: true };
      const itens = agruparVinculosShopee([removida, gemea], ativas).porConta.get('int-1');
      if (!ehLegivel(itens?.[0]) || !ehLegivel(itens?.[1])) {
        throw new TypeError('esperava dois itens legíveis');
      }
      expect(itens[0].removida).toBe(true);
      expect(itens[0].gemea).toBe(false);
      expect(itens[1].gemea).toBe(false);
    });

    it('⚠️ QUASE-PAR: categorias diferentes da mesma conta não são gêmeas', () => {
      const outra = vinculo('int-1', 200, [linha(6270, 'M', ['m'])]);
      const itens = agruparVinculosShopee([primeira, outra], ativas).porConta.get('int-1');
      if (!ehLegivel(itens?.[0]) || !ehLegivel(itens?.[1])) {
        throw new TypeError('esperava dois itens legíveis');
      }
      expect([itens[0].gemea, itens[1].gemea]).toEqual([false, false]);
    });
  });

  describe('elemento ilegível', () => {
    it('nomeando uma conta ativa fica no bloco dela, com os campos recusados', () => {
      const ilegivel = { ...vinculo('int-1', FASHION, []), lixo: 1, variation_id: 'x' };
      const [item] = agruparVinculosShopee([ilegivel], ativas).porConta.get('int-1') ?? [];
      expect(item?.tipo).toBe(TIPO_ITEM_VINCULO_SHOPEE.ilegivel);
      if (item?.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel) throw new TypeError('ilegível');
      expect(item.campos).toEqual(expect.arrayContaining(['variation_id', 'lixo']));
      expect(item.bruto).toBe(ilegivel);
    });

    it('um campo aninhado aparece com o caminho inteiro, sem repetição', () => {
      const ilegivel = vinculo('int-1', FASHION, [
        { ...linha(1, 'x', []), lixo: 1, outro: 2 },
        { shopee_option_id: 'a', shopee_option_name: 'x', arakene_variation_id: [] },
      ]);
      const [item] = agruparVinculosShopee([ilegivel], ativas).porConta.get('int-1') ?? [];
      if (item?.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel) throw new TypeError('ilegível');
      expect(item.campos).toEqual(
        expect.arrayContaining([
          'variationOptions.0.lixo',
          'variationOptions.0.outro',
          'variationOptions.1.shopee_option_id',
        ]),
      );
      expect(new Set(item.campos).size).toBe(item.campos.length);
    });

    it('IGUAL: os campos do item ilegível são os do ilegivel do resolvedor — uma grafia só (#1369)', () => {
      const quebrado = {
        ...vinculo('documents/integracao/int-1', FASHION, [
          linha(6857, 'P', ['p']),
          { ...linha(0, 'Opção inventada 1', []), lixo: 1 },
          { shopee_option_id: 'a', shopee_option_name: 'x', arakene_variation_id: 'p' },
        ]),
        variation_id: 'x',
        variation_group_list: [1],
        lixo: true,
      };
      const [item] = agruparVinculosShopee([quebrado], ativas).porConta.get('int-1') ?? [];
      if (item?.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel) throw new TypeError('ilegível');
      const lida = resolverEntradaShopeeDoGrupo([quebrado], 'int-1', FASHION);
      if (lida.tipo !== 'ilegivel') throw new TypeError('o resolvedor também lê ilegivel');
      expect(item.campos.length).toBeGreaterThanOrEqual(6);
      expect(item.campos).toEqual(lida.campos);
      // The module asks the schema's function; it walks no zod issue itself.
      const fonte = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'vinculadorShopee.ts'),
        'utf8',
      );
      expect(fonte).toContain('camposRecusados(lido.error)');
      expect(fonte).not.toContain('.issues');
    });

    it('sem chave, ou nem objeto, vai para «outras», sem campo em branco', () => {
      const grupos = agruparVinculosShopee(
        [{ name: 'meio feito' }, 'lixo', null, vinculo('int-1', String(FASHION), [])],
        ativas,
      );
      expect(grupos.porConta.size).toBe(0);
      expect(grupos.outras.map((i) => i.tipo)).toEqual([
        TIPO_ITEM_VINCULO_SHOPEE.ilegivel,
        TIPO_ITEM_VINCULO_SHOPEE.ilegivel,
        TIPO_ITEM_VINCULO_SHOPEE.ilegivel,
        TIPO_ITEM_VINCULO_SHOPEE.ilegivel,
      ]);
      const naoObjeto = grupos.outras[1];
      if (naoObjeto?.tipo !== TIPO_ITEM_VINCULO_SHOPEE.ilegivel) throw new TypeError('ilegível');
      expect(naoObjeto.campos).toEqual([]);
    });

    it('marcado para remoção continua listado, no mesmo lugar', () => {
      const ilegivel = { ...vinculo('int-1', FASHION, []), lixo: 1 };
      const grupos = agruparVinculosShopee(alternarRemocaoShopee([ilegivel, 'lixo'], 0), ativas);
      expect(grupos.porConta.get('int-1')?.[0]?.removida).toBe(true);
      expect(grupos.outras[0]?.removida).toBe(false);
      const naoObjeto = agruparVinculosShopee(alternarRemocaoShopee(['lixo'], 0), ativas);
      expect(naoObjeto.outras[0]?.removida).toBe(true);
    });
  });

  it('as notas do conflito chegam ao item', () => {
    const marcado = {
      ...vinculo('int-1', FASHION, []),
      [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.alterado,
    };
    const [item] = agruparVinculosShopee([marcado], ativas).porConta.get('int-1') ?? [];
    expect(item?.conflito).toBe(CONFLITO_VINCULO_SHOPEE.alterado);
    expect(item?.tipo).toBe(TIPO_ITEM_VINCULO_SHOPEE.padrao);
  });

  it('um valor guardado que não é lista avisa; `null` e ausente não', () => {
    expect(agruparVinculosShopee({ legado: 1 }, ativas).formatoInvalido).toBe(true);
    expect(agruparVinculosShopee(null, ativas).formatoInvalido).toBe(false);
    expect(agruparVinculosShopee(undefined, ativas).formatoInvalido).toBe(false);
  });
});

describe('situacaoDaChaveShopee — pode acrescentar?', () => {
  it('livre, vinculada e ilegível', () => {
    const legivel = vinculo('int-1', FASHION, []);
    const ilegivel = { ...vinculo('int-1', 200, []), lixo: 1 };
    expect(situacaoDaChaveShopee([legivel, ilegivel], 'int-1', 300)).toBe('livre');
    expect(situacaoDaChaveShopee([legivel, ilegivel], 'int-1', FASHION)).toBe('vinculada');
    expect(situacaoDaChaveShopee([legivel, ilegivel], 'int-1', 200)).toBe('ilegivel');
    expect(situacaoDaChaveShopee(null, 'int-1', FASHION)).toBe('livre');
  });

  it('IGUAL: uma conta guardada em forma de caminho já vincula a chave', () => {
    const guardado = vinculo('documents/integracao/int-1', FASHION, []);
    expect(situacaoDaChaveShopee([guardado], 'int-1', FASHION)).toBe('vinculada');
  });

  it('⚠️ QUASE-PAR: `int-12` não vincula a chave de `int-1`', () => {
    expect(situacaoDaChaveShopee([vinculo('int-12', FASHION, [])], 'int-1', FASHION)).toBe('livre');
  });

  it('⚠️ uma remoção marcada libera a chave para o substituto', () => {
    const removido = { ...vinculo('int-1', FASHION, []), [DELETE_MARK]: true };
    expect(situacaoDaChaveShopee([removido], 'int-1', FASHION)).toBe('livre');
  });
});

describe('definirOpcaoDaVarianteShopee — a regra da reconstrução', () => {
  const dois = vinculo('int-1', FASHION, [linha(6258, 'Preto', ['p']), linha(9585, 'Preto', [])]);

  describe('identidade da opção', () => {
    it('IGUAL: o mesmo id é a mesma linha, diga o nome o que disser', () => {
      const novo = definirOpcaoDaVarianteShopee(dois, 'm', {
        tipo: 'padrao',
        optionId: 6258,
        nome: 'Outro nome',
      });
      expect(opcoesDe(novo)[0]).toEqual(linha(6258, 'Preto', ['p', 'm']));
    });

    it('⚠️ QUASE-PAR: as duas «Preto» são duas linhas, e escolher uma nunca toca a outra', () => {
      const novo = definirOpcaoDaVarianteShopee(dois, 'g', {
        tipo: 'padrao',
        optionId: 9585,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(6258, 'Preto', ['p']), linha(9585, 'Preto', ['g'])]);
    });

    it('⚠️ QUASE-PAR: escolher 6258 com só 9585 guardada cria outra linha, nunca reaproveita', () => {
      const so9585 = vinculo('int-1', FASHION, [linha(9585, 'Preto', ['m'])]);
      const novo = definirOpcaoDaVarianteShopee(so9585, 'p', {
        tipo: 'padrao',
        optionId: 6258,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(9585, 'Preto', ['m']), linha(6258, 'Preto', ['p'])]);
    });

    it('uma opção personalizada casa pelo nome EXATO', () => {
      const guardado = vinculo('int-1', FASHION, [linha(0, 'Cor do ERP', ['p'])]);
      const novo = definirOpcaoDaVarianteShopee(guardado, 'm', {
        tipo: 'personalizada',
        nome: 'Cor do ERP',
      });
      expect(opcoesDe(novo)).toEqual([linha(0, 'Cor do ERP', ['p', 'm'])]);
    });

    it.each(['cor do erp', ' Cor do ERP', 'Cor do ERP ', 'Cor  do ERP'])(
      '⚠️ QUASE-PAR: %j é OUTRA opção personalizada',
      (nome) => {
        const guardado = vinculo('int-1', FASHION, [linha(0, 'Cor do ERP', ['p'])]);
        const novo = definirOpcaoDaVarianteShopee(guardado, 'm', { tipo: 'personalizada', nome });
        expect(opcoesDe(novo)).toEqual([linha(0, 'Cor do ERP', ['p']), linha(0, nome, ['m'])]);
      },
    );

    it('⚠️ QUASE-PAR: um id padrão não casa com uma personalizada de mesmo nome', () => {
      const guardado = vinculo('int-1', FASHION, [linha(0, 'Preto', ['p'])]);
      const novo = definirOpcaoDaVarianteShopee(guardado, 'm', {
        tipo: 'padrao',
        optionId: 6258,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(0, 'Preto', ['p']), linha(6258, 'Preto', ['m'])]);
    });

    it('`padrao` com id 0 tem a identidade de uma personalizada: o nome', () => {
      const guardado = vinculo('int-1', FASHION, [linha(0, 'Preto', ['p'])]);
      const novo = definirOpcaoDaVarianteShopee(guardado, 'm', {
        tipo: 'padrao',
        optionId: 0,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(0, 'Preto', ['p', 'm'])]);
    });
  });

  describe('exibir vs. guardar', () => {
    it('IGUAL/QUASE-PAR: o nome de uma opção padrão é guardado VERBATIM, com os espaços', () => {
      const novo = definirOpcaoDaVarianteShopee(vinculo('int-1', FASHION, []), 'p', {
        tipo: 'padrao',
        optionId: 9632,
        nome: ' Azul Turquesa ',
      });
      expect(opcoesDe(novo)).toEqual([linha(9632, ' Azul Turquesa ', ['p'])]);
    });

    it('o nome de uma opção personalizada é o da variante, VERBATIM', () => {
      const novo = definirOpcaoDaVarianteShopee(vinculo('int-1', FASHION, []), 'p', {
        tipo: 'personalizada',
        nome: ' Cor do ERP ',
      });
      expect(opcoesDe(novo)).toEqual([linha(0, ' Cor do ERP ', ['p'])]);
    });

    it('a mensagem mostra o nome aparado, sem mudar o que está guardado', () => {
      const achado: AchadoVinculoShopee = {
        tipo: TIPO_ACHADO_SHOPEE.opcaoForaDaArvore,
        bloqueia: false,
        indices: [0],
        opcao: { id: 9632, nome: ' Azul Turquesa ' },
      };
      expect(mensagemDoAchadoShopee(achado, (id) => id)).toContain('A opção Azul Turquesa (9632) ');
    });
  });

  describe('reconstruir', () => {
    it('IGUAL: escolher de novo a opção atual devolve o MESMO objeto', () => {
      expect(
        definirOpcaoDaVarianteShopee(dois, 'p', { tipo: 'padrao', optionId: 6258, nome: 'Preto' }),
      ).toBe(dois);
    });

    it('IGUAL: limpar uma variante sem opção devolve o MESMO objeto', () => {
      expect(definirOpcaoDaVarianteShopee(dois, 'g', { tipo: 'nenhuma' })).toBe(dois);
    });

    it('IGUAL: escolher de novo mantém as marcas, porque não é uma edição', () => {
      const marcado = {
        ...dois,
        [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.removido,
      };
      expect(
        definirOpcaoDaVarianteShopee(marcado, 'p', {
          tipo: 'padrao',
          optionId: 6258,
          nome: 'Preto',
        }),
      ).toBe(marcado);
    });

    it('⚠️ QUASE-PAR: mudar para outra opção é um objeto novo, e o original fica intacto', () => {
      const antes = structuredClone(dois);
      const novo = definirOpcaoDaVarianteShopee(dois, 'p', {
        tipo: 'padrao',
        optionId: 9585,
        nome: 'Preto',
      });
      expect(novo).not.toBe(dois);
      expect(dois).toEqual(antes);
      expect(opcoesDe(novo)).toEqual([linha(9585, 'Preto', ['p'])]);
    });

    it('⚠️ uma linha guardada vazia fica; a que ESTA chamada esvaziou sai', () => {
      expect(opcoesDe(dois)[1]).toEqual(linha(9585, 'Preto', []));
      const novo = definirOpcaoDaVarianteShopee(dois, 'p', { tipo: 'nenhuma' });
      expect(opcoesDe(novo)).toEqual([linha(9585, 'Preto', [])]);
    });

    it('uma linha guardada vazia recebe a variante quando é a escolhida', () => {
      const novo = definirOpcaoDaVarianteShopee(dois, 'm', {
        tipo: 'padrao',
        optionId: 9585,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(6258, 'Preto', ['p']), linha(9585, 'Preto', ['m'])]);
    });

    it('limpar só tira a variante pedida: quem divide a linha fica', () => {
      const dividida = vinculo('int-1', FASHION, [linha(6258, 'Preto', ['p', 'm'])]);
      expect(opcoesDe(definirOpcaoDaVarianteShopee(dividida, 'p', { tipo: 'nenhuma' }))).toEqual([
        linha(6258, 'Preto', ['m']),
      ]);
    });

    it('a variante sai de TODAS as outras linhas, consertando quem estava em duas', () => {
      const emDuas = vinculo('int-1', FASHION, [
        linha(6258, 'Preto', ['p']),
        linha(9585, 'Preto', ['p', 'm']),
        linha(6857, 'P', ['p']),
      ]);
      const novo = definirOpcaoDaVarianteShopee(emDuas, 'p', {
        tipo: 'padrao',
        optionId: 9585,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(9585, 'Preto', ['p', 'm'])]);
    });

    it('⚠️ a mesma opção guardada duas vezes: só a primeira fica com a variante', () => {
      const duplicada = vinculo('int-1', FASHION, [
        linha(6258, 'Preto', ['p']),
        linha(6258, 'Preto', ['p', 'm']),
      ]);
      const novo = definirOpcaoDaVarianteShopee(duplicada, 'p', {
        tipo: 'padrao',
        optionId: 6258,
        nome: 'Preto',
      });
      expect(opcoesDe(novo)).toEqual([linha(6258, 'Preto', ['p']), linha(6258, 'Preto', ['m'])]);
      expect(
        tipos(achadosDoVinculadorShopee([novo], VARIANTES, seed([duplicada]))).filter(
          (t) => t === TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes,
        ),
      ).toEqual([]);
    });

    it('⚠️ um id guardado fora da árvore de hoje nunca cai por causa de outra variante', () => {
      const comForaDaLista = vinculo('int-1', FASHION, [
        linha(6857, 'P', ['p']),
        linha(6933, 'M', ['m']),
      ]);
      const novo = definirOpcaoDaVarianteShopee(comForaDaLista, 'g', {
        tipo: 'padrao',
        optionId: 9632,
        nome: 'Azul Turquesa',
      });
      expect(opcoesDe(novo)).toEqual([
        linha(6857, 'P', ['p']),
        linha(6933, 'M', ['m']),
        linha(9632, 'Azul Turquesa', ['g']),
      ]);
    });

    it('toda outra chave e linha fica como guardada, até uma linha estranha', () => {
      const guardado = vinculo('int-1', FASHION, ['lixo' as unknown as Doc, linha(1, 'x', [])], {
        extra: { a: 1 },
      });
      const novo = definirOpcaoDaVarianteShopee(guardado, 'p', {
        tipo: 'padrao',
        optionId: 2,
        nome: 'y',
      }) as Doc;
      expect(novo.extra).toEqual({ a: 1 });
      expect(novo.variation_group_list).toBe(0);
      expect(opcoesDe(novo)).toEqual(['lixo', linha(1, 'x', []), linha(2, 'y', ['p'])]);
    });

    it('uma variante repetida numa linha sai inteira', () => {
      const repetida = vinculo('int-1', FASHION, [linha(1, 'x', ['p', 'p', 'm'])]);
      expect(opcoesDe(definirOpcaoDaVarianteShopee(repetida, 'p', { tipo: 'nenhuma' }))).toEqual([
        linha(1, 'x', ['m']),
      ]);
    });

    it('uma edição refaz o vínculo marcado pelo conflito: a marca vai embora', () => {
      const marcado = {
        ...dois,
        [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.removido,
      };
      const novo = definirOpcaoDaVarianteShopee(marcado, 'g', {
        tipo: 'padrao',
        optionId: 9585,
        nome: 'Preto',
      });
      expect(marcaDeConflitoShopee(novo)).toBeNull();
      expect(prepararVinculosShopee([novo])).toEqual([novo]);
    });

    it('um vínculo sem `variationOptions` ganha a lista só quando muda', () => {
      const semLista = { ...vinculo('int-1', FASHION, []) };
      delete semLista.variationOptions;
      expect(definirOpcaoDaVarianteShopee(semLista, 'p', { tipo: 'nenhuma' })).toBe(semLista);
      expect(
        opcoesDe(
          definirOpcaoDaVarianteShopee(semLista, 'p', {
            tipo: 'padrao',
            optionId: 1,
            nome: 'x',
          }),
        ),
      ).toEqual([linha(1, 'x', ['p'])]);
    });

    it('uma entrada que não é objeto: nada a limpar, e a escolha começa do zero', () => {
      expect(definirOpcaoDaVarianteShopee('lixo', 'p', { tipo: 'nenhuma' })).toBe('lixo');
      expect(
        opcoesDe(definirOpcaoDaVarianteShopee('lixo', 'p', { tipo: 'personalizada', nome: 'x' })),
      ).toEqual([linha(0, 'x', ['p'])]);
    });
  });
});

describe('escolhaAtualDaVariante, valorDaLinhaShopee, escolhaDaLinhaShopee', () => {
  const pretoA = linha(6258, 'Preto', ['p', 'g']) as never;
  const pretoB = linha(9585, 'Preto', ['m', 'g']) as never;

  it('nenhuma, uma ou várias linhas', () => {
    const link = { variationOptions: [pretoA, pretoB] };
    expect(escolhaAtualDaVariante(link, 'x')).toEqual({ tipo: 'nenhuma' });
    expect(escolhaAtualDaVariante(link, 'p')).toEqual({ tipo: 'uma', linha: pretoA });
    expect(escolhaAtualDaVariante(link, 'g')).toEqual({
      tipo: 'varias',
      linhas: [pretoA, pretoB],
    });
  });

  it('⚠️ QUASE-PAR: as duas «Preto» têm dois valores; duas personalizadas também', () => {
    expect(valorDaLinhaShopee(pretoA)).toBe('6258');
    expect(valorDaLinhaShopee(pretoB)).toBe('9585');
    const a = { shopee_option_id: 0, shopee_option_name: 'Opção inventada 1' };
    const b = { shopee_option_id: 0, shopee_option_name: 'Opção inventada 2' };
    expect(valorDaLinhaShopee(a)).not.toBe(valorDaLinhaShopee(b));
    expect(valorDaLinhaShopee(a)).not.toBe('0');
  });

  it('a escolha que uma linha guardada produz volta à mesma linha', () => {
    const guardado = vinculo('int-1', FASHION, [
      linha(6258, 'Preto', ['p']),
      linha(0, ' Opção inventada 1', ['m']),
    ]);
    for (const [variante, indice] of [
      ['p', 0],
      ['m', 1],
    ] as const) {
      const armazenada = opcoesDe(guardado)[indice] as {
        shopee_option_id: number;
        shopee_option_name: string;
      };
      expect(
        definirOpcaoDaVarianteShopee(guardado, variante, escolhaDaLinhaShopee(armazenada)),
      ).toBe(guardado);
    }
  });
});

describe('novoVinculoShopee', () => {
  it('nasce com a conta nua, sem opção, e nada mais', () => {
    expect(
      novoVinculoShopee('int-1', { categoryId: FASHION, rotulo: 'Categoria inventada' }, 101054, 0),
    ).toEqual({
      name: 'Categoria inventada',
      category_id: FASHION,
      variation_id: 101054,
      variation_group_list: 0,
      integracaoShopeeId: 'int-1',
      variationOptions: [],
    });
  });

  it('IGUAL/QUASE-PAR: o sentinela 0 fica 0; um grupo de 15 dígitos fica exato', () => {
    const categoria = { categoryId: FASHION, rotulo: 'x' };
    expect(novoVinculoShopee('int-1', categoria, 101054, 0).variation_group_list).toBe(0);
    expect(novoVinculoShopee('int-1', categoria, 101054, BR).variation_group_list).toBe(
      844758844060204,
    );
  });

  it('uma conta em branco é recusada antes de entrar no formulário', () => {
    expect(() => novoVinculoShopee('', { categoryId: 1, rotulo: 'x' }, 1, 0)).toThrow(ZodError);
  });

  it('o vínculo novo é uma entrada legível, e fica no bloco da conta', () => {
    const novo = novoVinculoShopee('int-1', { categoryId: FASHION, rotulo: 'x' }, 101054, BR);
    const grupos = agruparVinculosShopee([novo], new Set(['int-1']));
    expect(grupos.porConta.get('int-1')?.[0]?.tipo).toBe(TIPO_ITEM_VINCULO_SHOPEE.padrao);
  });
});

describe('definirGrupoDoVinculoShopee — só a partir de um 0 guardado', () => {
  const semGrupo = vinculo('int-1', FASHION, [linha(6933, 'M', ['m'])]);

  it('grava o grupo escolhido, exato, sem tocar nas linhas', () => {
    const novo = definirGrupoDoVinculoShopee(semGrupo, BR) as Doc;
    expect(novo.variation_group_list).toBe(844758844060204);
    expect(novo.variationOptions).toEqual(semGrupo.variationOptions);
    expect(semGrupo.variation_group_list).toBe(0);
  });

  it('⚠️ QUASE-PAR: um grupo já guardado nunca é sobrescrito, e não é uma edição', () => {
    const comGrupo = { ...semGrupo, variation_group_list: INT };
    expect(definirGrupoDoVinculoShopee(comGrupo, BR)).toBe(comGrupo);
  });

  it('escolher 0, ou numa entrada que não é objeto, não é uma edição', () => {
    expect(definirGrupoDoVinculoShopee(semGrupo, 0)).toBe(semGrupo);
    expect(definirGrupoDoVinculoShopee('lixo', BR)).toBe('lixo');
  });

  it('uma edição refaz o vínculo marcado: a marca vai embora', () => {
    const marcado = { ...semGrupo, [MARCA_CONFLITO_VINCULO_SHOPEE]: 'alterado' };
    expect(marcaDeConflitoShopee(definirGrupoDoVinculoShopee(marcado, BR))).toBeNull();
  });
});

describe('remover um vínculo — #1787', () => {
  const novo = vinculo('int-1', FASHION, []);
  const guardado = vinculo('int-1', 200, [linha(6857, 'P', ['p'])]);

  it.each([
    ['chave ausente', undefined],
    ['`null`', null],
  ])('IGUAL: %s — acrescentar e remover volta ao seed, formulário intacto', (_caso, semente) => {
    expect(removerVinculoShopee([novo], 0, semente)).toBe(semente);
  });

  it('⚠️ QUASE-PAR: `[]` guardado — acrescentar e remover volta `[]`, nunca `null`', () => {
    const semente: unknown[] = [];
    expect(removerVinculoShopee([novo], 0, semente)).toBe(semente);
  });

  it('⚠️ um novo ao lado de um guardado só sai ele, e o guardado fica', () => {
    expect(removerVinculoShopee([guardado, novo], 1, [guardado])).toEqual([guardado]);
  });

  it('⚠️ QUASE-PAR: um guardado é só marcado para remoção, nunca apagado', () => {
    const saida = removerVinculoShopee([guardado], 0, [guardado]) as Doc[];
    expect(saida).toEqual([{ ...guardado, [DELETE_MARK]: true }]);
    expect(removerVinculoShopee(saida, 0, [guardado])).toEqual([guardado]);
  });

  it('⚠️ QUASE-PAR: um guardado EDITADO continua sendo guardado: marcado, não apagado', () => {
    const alterado = definirOpcaoDaVarianteShopee(guardado, 'p', { tipo: 'nenhuma' });
    expect(ehVinculoNovoShopee([alterado], 0, [guardado])).toBe(false);
    expect(removerVinculoShopee([alterado], 0, [guardado])).toEqual([
      { ...(alterado as Doc), [DELETE_MARK]: true },
    ]);
  });

  it('IGUAL: guardado em forma de caminho não é novo', () => {
    expect(
      ehVinculoNovoShopee([novo], 0, [vinculo('documents/integracao/int-1', FASHION, [])]),
    ).toBe(false);
  });

  it('⚠️ QUASE-PAR: a mesma categoria de `int-12` não faz de `int-1` um guardado', () => {
    expect(ehVinculoNovoShopee([novo], 0, [vinculo('int-12', FASHION, [])])).toBe(true);
  });

  it('um elemento sem chave, ou já marcado, nunca é novo', () => {
    expect(ehVinculoNovoShopee([{ name: 'meio feito' }], 0, null)).toBe(false);
    expect(ehVinculoNovoShopee([{ ...novo, [DELETE_MARK]: true }], 0, null)).toBe(false);
  });

  it('um seed que não é lista não faz ninguém guardado, e não ressuscita', () => {
    const semente = { legado: 1 };
    expect(ehVinculoNovoShopee([novo], 0, semente)).toBe(true);
    expect(removerVinculoShopee([novo], 0, semente)).toEqual([]);
  });

  describe('trocar a variação: remover o guardado e adicionar outro da mesma chave', () => {
    const daChave = vinculo('int-1', FASHION, [linha(6858, 'P', ['p'])]);
    const semente = [daChave];
    const substituto = novoVinculoShopee(
      'int-1',
      { categoryId: FASHION, rotulo: 'Categoria inventada' },
      101056,
      0,
    );

    it('remover o guardado, adicionar outro da mesma chave e tirar o novo: o novo sai de vez; desfazer a remoção volta ao pristino', () => {
      const preparado = removerVinculoShopee(semente, 0, semente) as unknown[];
      const comSubstituto = [...preparado, substituto];
      expect(ehVinculoNovoShopee(comSubstituto, 1, semente)).toBe(true);

      const semSubstituto = removerVinculoShopee(comSubstituto, 1, semente) as unknown[];
      expect(semSubstituto).toEqual([{ ...daChave, [DELETE_MARK]: true }]);
      expect(removerVinculoShopee(semSubstituto, 0, semente)).toEqual(semente);
    });

    it('⚠️ QUASE-PAR: o guardado continua só preparado, mesmo com o substituto ao lado', () => {
      const lista = [daChave, substituto];
      expect(ehVinculoNovoShopee(lista, 0, semente)).toBe(false);
      expect(removerVinculoShopee(lista, 0, semente)).toEqual([
        { ...daChave, [DELETE_MARK]: true },
        substituto,
      ]);
    });

    it('gêmeos guardados da mesma chave: nenhum é novo; um terceiro da chave é', () => {
      const gemeo = vinculo('documents/integracao/int-1', FASHION, []);
      expect(ehVinculoNovoShopee([daChave, gemeo], 1, [daChave, gemeo])).toBe(false);
      expect(ehVinculoNovoShopee([daChave, gemeo, substituto], 2, [daChave, gemeo])).toBe(true);
    });
  });
});

describe('linkDoSeedShopee — a entrada guardada que um cartão representa', () => {
  const guardado = vinculo('int-1', FASHION, [linha(6933, 'M', ['m'])]);

  it('IGUAL: a mesma chave, em qualquer grafia, e a mesma variação ⇒ a entrada guardada', () => {
    const editado = definirOpcaoDaVarianteShopee(guardado, 'm', { tipo: 'nenhuma' });
    expect(linkDoSeedShopee([guardado], editado)).toEqual(guardado);
    const emCaminho = vinculo('documents/integracao/int-1', FASHION, [linha(6933, 'M', ['m'])]);
    expect(linkDoSeedShopee([emCaminho], { ...(editado as Doc), [DELETE_MARK]: true })).toEqual(
      emCaminho,
    );
  });

  it('⚠️ QUASE-PAR: outra variação na mesma chave, outra chave, ou nada guardado ⇒ nenhuma', () => {
    const outraVariacao = vinculo('int-1', FASHION, [], { variation_id: 101056 });
    expect(linkDoSeedShopee([guardado], outraVariacao)).toBeNull();
    expect(linkDoSeedShopee([guardado], vinculo('int-12', FASHION, []))).toBeNull();
    expect(linkDoSeedShopee([guardado], vinculo('int-1', 200, []))).toBeNull();
    expect(linkDoSeedShopee(null, guardado)).toBeNull();
    expect(linkDoSeedShopee([{ ...guardado, lixo: 1 }], guardado)).toBeNull();
  });
});

describe('prepararVinculosShopee — o que a gravação escreve', () => {
  it('⚠️ um elemento ilegível intacto volta como está, o mesmo valor', () => {
    const ilegivel = { ...vinculo('int-1', FASHION, []), lixo: 1 };
    const saida = prepararVinculosShopee([ilegivel, 'lixo']) as unknown[];
    expect(saida).toHaveLength(2);
    expect(saida[0]).toBe(ilegivel);
    expect(saida[1]).toBe('lixo');
  });

  it('⚠️ QUASE-PAR: só a remoção marcada tira o elemento ilegível da lista', () => {
    const ilegivel = { ...vinculo('int-1', FASHION, []), lixo: 1 };
    const legivel = vinculo('int-1', 200, []);
    expect(prepararVinculosShopee(alternarRemocaoShopee([ilegivel, legivel], 0))).toEqual([
      legivel,
    ]);
  });

  it('as marcas da Shopee saem; a nota «removido» descarta', () => {
    const alterado = {
      ...vinculo('int-1', 1, []),
      [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.alterado,
    };
    const removido = {
      ...vinculo('int-1', 2, []),
      [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.removido,
    };
    expect(prepararVinculosShopee([alterado, removido])).toEqual([vinculo('int-1', 1, [])]);
  });
});

describe('validarVinculosShopee — o que bloqueia uma gravação', () => {
  const emDuasOpcoes = vinculo('int-1', FASHION, [
    linha(6258, 'Preto', ['p']),
    linha(9585, 'Preto', ['p']),
  ]);

  it('IGUAL: um vínculo intacto com a variante em duas opções + renomear o grupo ⇒ salva', () => {
    const values = {
      nome: 'Renomeado',
      variacoes: VARIANTES,
      linksVariacoesShopee: [structuredClone(emDuasOpcoes)],
    };
    expect(validarVinculosShopee(values, seed([emDuasOpcoes]))).toEqual([]);
  });

  it('⚠️ QUASE-PAR: o mesmo defeito num vínculo EDITADO ⇒ bloqueado, na aba', () => {
    const editado = { ...emDuasOpcoes, name: 'Outro nome' };
    const values = { variacoes: VARIANTES, linksVariacoesShopee: [editado] };
    expect(validarVinculosShopee(values, seed([emDuasOpcoes]))).toEqual([
      {
        path: 'linksVariacoesShopee',
        message:
          'Vínculos Shopee: a variante «P» está em mais de uma opção do vínculo da categoria ' +
          '100352.',
      },
    ]);
  });

  it('⚠️ FALHA FECHADO: sem seed publicado, o defeito guardado bloqueia', () => {
    const values = { variacoes: VARIANTES, linksVariacoesShopee: [emDuasOpcoes] };
    expect(validarVinculosShopee(values, null).map((i) => i.path)).toEqual([
      'linksVariacoesShopee',
    ]);
  });

  it('⚠️ uma variante que o grupo não tem, em duas opções, só avisa: não há o que escolher', () => {
    const fantasma = vinculo('int-1', FASHION, [
      linha(6258, 'Preto', ['fantasma']),
      linha(9585, 'Preto', ['fantasma']),
    ]);
    const values = { variacoes: VARIANTES, linksVariacoesShopee: [fantasma] };
    expect(validarVinculosShopee(values, seed([]))).toEqual([]);
  });

  describe('chave-repetida', () => {
    const primeira = vinculo('int-1', FASHION, [linha(6857, 'P', ['p'])]);
    const gemea = vinculo('documents/integracao/int-1', FASHION, [linha(6270, 'M', ['m'])]);

    it('IGUAL: duas guardadas, ambas intactas ⇒ salva', () => {
      const values = { variacoes: VARIANTES, linksVariacoesShopee: [primeira, gemea] };
      expect(validarVinculosShopee(values, seed([primeira, gemea]))).toEqual([]);
    });

    it('⚠️ QUASE-PAR: a mesma chave em outra grafia, com uma editada ⇒ bloqueado', () => {
      const editada = { ...gemea, name: 'Outro nome' };
      const values = { variacoes: VARIANTES, linksVariacoesShopee: [primeira, editada] };
      expect(validarVinculosShopee(values, seed([primeira, gemea]))[0]?.message).toBe(
        'Vínculos Shopee: o vínculo com a conta int-1 na categoria 100352 aparece mais de uma vez.',
      );
    });

    it('⚠️ QUASE-PAR: `int-12` e `int-1` na mesma categoria não são a mesma chave', () => {
      const outra = vinculo('int-12', FASHION, []);
      const values = { variacoes: VARIANTES, linksVariacoesShopee: [primeira, outra] };
      expect(validarVinculosShopee(values, seed([]))).toEqual([]);
    });

    it('um elemento ilegível de mesma chave não conta aqui: o schema já o recusa', () => {
      const ilegivel = { ...vinculo('int-1', FASHION, []), lixo: 1 };
      const values = { variacoes: VARIANTES, linksVariacoesShopee: [primeira, ilegivel] };
      expect(validarVinculosShopee(values, seed([]))).toEqual([]);
    });
  });

  describe('opcao-personalizada-sem-nome', () => {
    it.each(['', '   ', ' '])('⚠️ o nome %j não é nome: bloqueia num vínculo editado', (nome) => {
      const semNome = vinculo('int-1', FASHION, [linha(0, nome, ['p'])]);
      const values = { variacoes: VARIANTES, linksVariacoesShopee: [semNome] };
      expect(validarVinculosShopee(values, seed([]))[0]?.message).toBe(
        'Vínculos Shopee: a opção personalizada da variante «P» está sem nome.',
      );
    });

    it('a frase fala da OPÇÃO sem nome e chama a variante pelo nome que ela tem hoje', () => {
      const semNome = vinculo('int-1', FASHION, [linha(0, '', ['v9'])]);
      const values = {
        variacoes: [variante('v9', 'Cor do ERP')],
        linksVariacoesShopee: [semNome],
      };
      expect(validarVinculosShopee(values, seed([], values.variacoes))[0]?.message).toBe(
        'Vínculos Shopee: a opção personalizada da variante «Cor do ERP» está sem nome.',
      );
    });

    it('⚠️ QUASE-PAR: uma variante ainda sem nome é chamada pelo id', () => {
      const semNome = vinculo('int-1', FASHION, [linha(0, '', ['v9'])]);
      const values = { variacoes: [variante('v9', '')], linksVariacoesShopee: [semNome] };
      expect(validarVinculosShopee(values, seed([], values.variacoes))[0]?.message).toBe(
        'Vínculos Shopee: a opção personalizada da variante «v9» está sem nome.',
      );
    });

    it('IGUAL: guardado assim e intacto ⇒ salva', () => {
      const semNome = vinculo('int-1', FASHION, [linha(0, ' ', ['p'])]);
      const values = { variacoes: VARIANTES, linksVariacoesShopee: [semNome] };
      expect(validarVinculosShopee(values, seed([semNome]))).toEqual([]);
    });

    it.each([
      ['espaços em volta de um nome', linha(0, '  Cor do ERP  ', ['p'])],
      ['um espaço de largura zero (não é espaço para `trim`)', linha(0, '​', ['p'])],
      ['nome em branco numa opção PADRÃO', linha(6258, ' ', ['p'])],
      ['nome em branco numa linha sem variante', linha(0, ' ', [])],
      [
        'nome em branco numa linha só com variante que o grupo não tem',
        linha(0, ' ', ['fantasma']),
      ],
    ])('⚠️ QUASE-PAR: %s não bloqueia', (_caso, row) => {
      const values = {
        variacoes: VARIANTES,
        linksVariacoesShopee: [vinculo('int-1', FASHION, [row])],
      };
      expect(validarVinculosShopee(values, seed([]))).toEqual([]);
    });
  });

  it('avisos nunca bloqueiam, mesmo num vínculo editado', () => {
    const avisos = vinculo('int-1', FASHION, [
      linha(6258, 'Preto', ['p', 'm']),
      linha(9585, 'Preto', ['fantasma']),
      linha(6857, 'P', ['removida']),
    ]);
    const variacoesDoSeed = [...VARIANTES, variante('removida')];
    const values = { variacoes: VARIANTES, linksVariacoesShopee: [avisos] };
    expect(validarVinculosShopee(values, seed([], variacoesDoSeed))).toEqual([]);
    expect(
      tipos(achadosDoVinculadorShopee([avisos], VARIANTES, seed([], variacoesDoSeed))),
    ).toEqual([
      TIPO_ACHADO_SHOPEE.opcaoComVariasVariantes,
      TIPO_ACHADO_SHOPEE.varianteInexistente,
      TIPO_ACHADO_SHOPEE.varianteRemovidaNestaGravacao,
    ]);
  });

  it('as mensagens de vários bloqueios saem juntas, numa só pendência', () => {
    const repetida = [
      vinculo('int-1', FASHION, [linha(6258, 'Preto', ['p']), linha(9585, 'Preto', ['p'])]),
      vinculo('int-1', FASHION, [linha(0, '', ['m'])]),
    ];
    const issues = validarVinculosShopee(
      { variacoes: VARIANTES, linksVariacoesShopee: repetida },
      seed([]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe(
      'Vínculos Shopee: a variante «P» está em mais de uma opção do vínculo da categoria 100352; ' +
        'a opção personalizada da variante «M» está sem nome; o vínculo com a conta int-1 na ' +
        'categoria 100352 aparece mais de uma vez.',
    );
  });

  it('nada a dizer com o campo ausente, vazio ou fora de lista', () => {
    expect(validarVinculosShopee({ variacoes: VARIANTES }, seed(null))).toEqual([]);
    expect(validarVinculosShopee({ linksVariacoesShopee: [] }, seed(null))).toEqual([]);
    expect(validarVinculosShopee({ linksVariacoesShopee: { x: 1 } }, seed(null))).toEqual([]);
  });
});

describe('achadosDoVinculadorShopee — os achados da aba, nos índices do formulário', () => {
  it('leva os achados ao índice BRUTO, pulando o que está marcado para remoção', () => {
    const removido = {
      ...vinculo('int-1', 1, [linha(1, 'x', ['p']), linha(2, 'y', ['p'])]),
      [DELETE_MARK]: true,
    };
    const defeito = vinculo('int-1', FASHION, [
      linha(6258, 'Preto', ['p']),
      linha(9585, 'Preto', ['p']),
    ]);
    const achados = achadosDoVinculadorShopee([removido, defeito], VARIANTES, seed([defeito]));
    expect(achados).toEqual([
      {
        tipo: TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes,
        bloqueia: false,
        indices: [1],
        varianteId: 'p',
        categoryId: FASHION,
        opcoes: [
          { id: 6258, nome: 'Preto' },
          { id: 9585, nome: 'Preto' },
        ],
      },
    ]);
  });

  it('uma variante marcada para exclusão já aparece aqui como removida nesta gravação', () => {
    const links = [vinculo('int-1', FASHION, [linha(6857, 'G', ['g'])])];
    const vivas = [variante('p'), variante('m'), { ...variante('g'), [DELETE_MARK]: true }];
    expect(achadosDoVinculadorShopee(links, vivas, seed(links))).toEqual([
      {
        tipo: TIPO_ACHADO_SHOPEE.varianteRemovidaNestaGravacao,
        bloqueia: false,
        indices: [0],
        opcao: { id: 6857, nome: 'G' },
        varianteId: 'g',
      },
    ]);
  });

  it('⚠️ QUASE-PAR: uma variante apagada há muito (fora do seed) é só um id solto', () => {
    const links = [vinculo('int-1', FASHION, [linha(6857, 'G', ['antiga'])])];
    expect(tipos(achadosDoVinculadorShopee(links, VARIANTES, seed(links)))).toEqual([
      TIPO_ACHADO_SHOPEE.varianteInexistente,
    ]);
  });

  it('⚠️ uma linha com várias variantes: conta só as que o grupo tem', () => {
    const umaViva = vinculo('int-1', FASHION, [linha(6857, 'P', ['p', 'fantasma'])]);
    expect(tipos(achadosDoVinculadorShopee([umaViva], VARIANTES, seed([umaViva])))).toEqual([
      TIPO_ACHADO_SHOPEE.varianteInexistente,
    ]);
    const duasVivas = vinculo('int-1', FASHION, [linha(6857, 'P', ['p', 'm', 'p'])]);
    const achados = achadosDoVinculadorShopee([duasVivas], VARIANTES, seed([duasVivas]));
    expect(achados).toEqual([
      {
        tipo: TIPO_ACHADO_SHOPEE.opcaoComVariasVariantes,
        bloqueia: false,
        indices: [0],
        opcao: { id: 6857, nome: 'P' },
        variantes: ['p', 'm'],
      },
    ]);
  });

  it('uma variante repetida na MESMA linha não está em duas opções', () => {
    const repetida = vinculo('int-1', FASHION, [linha(6857, 'P', ['p', 'p'])]);
    expect(achadosDoVinculadorShopee([repetida], VARIANTES, seed([]))).toEqual([]);
  });

  it('nada a dizer de um valor que não é lista', () => {
    expect(achadosDoVinculadorShopee({ legado: 1 }, VARIANTES, seed(null))).toEqual([]);
  });
});

describe('achadosDaLeituraShopee — o que depende de uma leitura da Shopee', () => {
  const link = (linhas: Doc[], extra: Doc = {}) =>
    vinculo('int-1', FASHION, linhas, extra) as unknown as Parameters<
      typeof achadosDaLeituraShopee
    >[0];
  const semLeitura = { idsDaArvore: null, gruposComOpcoes: null, faixaDoNome: null };

  describe('opcao-fora-da-arvore', () => {
    const guardado = link([linha(6857, 'P', ['p']), linha(6933, 'M', ['m'])]);

    it('⚠️ um id guardado que a árvore não tem é AVISO, com o id e o nome guardado', () => {
      const achados = achadosDaLeituraShopee(guardado, 3, {
        ...semLeitura,
        idsDaArvore: new Set([6857]),
      });
      expect(achados).toEqual([
        {
          tipo: TIPO_ACHADO_SHOPEE.opcaoForaDaArvore,
          bloqueia: false,
          indices: [3],
          opcao: { id: 6933, nome: 'M' },
        },
      ]);
    });

    it('IGUAL: o grupo BR escolhido lista o `M` 6933', () => {
      const bloco = link([linha(6933, 'M', ['m'])]);
      expect(
        achadosDaLeituraShopee(bloco, 0, { ...semLeitura, idsDaArvore: new Set([6933]) }),
      ).toEqual([]);
    });

    it('⚠️ QUASE-PAR: o `M` 6270 do grupo INT não está na lista do BR', () => {
      const bloco = link([linha(6270, 'M', ['m'])]);
      expect(
        tipos(achadosDaLeituraShopee(bloco, 0, { ...semLeitura, idsDaArvore: new Set([6933]) })),
      ).toEqual([TIPO_ACHADO_SHOPEE.opcaoForaDaArvore]);
    });

    it('sem a árvore lida não se diz nada', () => {
      expect(achadosDaLeituraShopee(guardado, 0, semLeitura)).toEqual([]);
    });

    it('uma linha personalizada nunca está «fora da árvore»: a árvore não lista id 0', () => {
      const custom = link([linha(0, 'Cor do ERP', ['p'])]);
      expect(
        achadosDaLeituraShopee(custom, 0, { ...semLeitura, idsDaArvore: new Set<number>() }),
      ).toEqual([]);
    });

    it('um vínculo personalizado não tem árvore a comparar', () => {
      const custom = link([linha(6857, 'P', ['p'])], { variation_id: 0 });
      expect(
        achadosDaLeituraShopee(custom, 0, { ...semLeitura, idsDaArvore: new Set<number>() }),
      ).toEqual([]);
    });
  });

  describe('grupo-ausente', () => {
    it('⚠️ dois grupos com opções e 0 guardado exigem a escolha', () => {
      const guardado = link([]);
      expect(grupoAusenteShopee(guardado, 2)).toBe(true);
      expect(achadosDaLeituraShopee(guardado, 4, { ...semLeitura, gruposComOpcoes: 2 })).toEqual([
        { tipo: TIPO_ACHADO_SHOPEE.grupoAusente, bloqueia: false, indices: [4] },
      ]);
    });

    it('⚠️ QUASE-PAR: um grupo só é o sentinela de um nível: 0 é o valor certo', () => {
      expect(grupoAusenteShopee(link([]), 1)).toBe(false);
    });

    it('⚠️ QUASE-PAR: um grupo já guardado não falta', () => {
      expect(grupoAusenteShopee(link([], { variation_group_list: BR }), 2)).toBe(false);
    });

    it('sem a árvore lida, ou num vínculo personalizado, não se diz nada', () => {
      expect(grupoAusenteShopee(link([]), null)).toBe(false);
      expect(grupoAusenteShopee(link([], { variation_id: 0 }), 2)).toBe(false);
    });
  });

  describe('nome-fora-da-faixa', () => {
    const banda = { min: 1, max: 30 };
    const comBanda = { ...semLeitura, faixaDoNome: banda };

    it('IGUAL: um nome personalizado de 30 caracteres passa', () => {
      expect(achadosDaLeituraShopee(link([linha(0, 'x'.repeat(30), ['p'])]), 0, comBanda)).toEqual(
        [],
      );
    });

    it('⚠️ QUASE-PAR: com 31 avisa, com o tamanho e a faixa', () => {
      const nome = 'x'.repeat(31);
      expect(achadosDaLeituraShopee(link([linha(0, nome, ['p'])]), 2, comBanda)).toEqual([
        {
          tipo: TIPO_ACHADO_SHOPEE.nomeForaDaFaixa,
          bloqueia: false,
          indices: [2],
          nome,
          comprimento: 31,
          faixa: '1..30',
        },
      ]);
    });

    it('⚠️ QUASE-PAR: um nome PADRÃO de 32 caracteres nunca avisa', () => {
      const nome = 'Sola De Borracha Anti-Derrapante';
      expect(nome).toHaveLength(32);
      expect(achadosDaLeituraShopee(link([linha(6258, nome, ['p'])]), 0, comBanda)).toEqual([]);
    });

    it('mede o nome como é enviado: os espaços em volta não contam', () => {
      const nome = `  ${'x'.repeat(30)}  `;
      expect(achadosDaLeituraShopee(link([linha(0, nome, ['p'])]), 0, comBanda)).toEqual([]);
    });

    it('⚠️ QUASE-PAR: só as pontas saem — espaços repetidos no meio contam, como a publicação envia', () => {
      const nome = `${'x'.repeat(14)}   ${'x'.repeat(14)}`;
      expect(nome).toHaveLength(31);
      expect(tipos(achadosDaLeituraShopee(link([linha(0, nome, ['p'])]), 0, comBanda))).toEqual([
        TIPO_ACHADO_SHOPEE.nomeForaDaFaixa,
      ]);
    });

    it('uma linha sem variante nunca é enviada; sem faixa conhecida não há o que medir', () => {
      const longo = 'x'.repeat(31);
      expect(achadosDaLeituraShopee(link([linha(0, longo, [])]), 0, comBanda)).toEqual([]);
      expect(achadosDaLeituraShopee(link([linha(0, longo, ['p'])]), 0, semLeitura)).toEqual([]);
      expect(
        achadosDaLeituraShopee(link([linha(0, longo, ['p'])]), 0, {
          ...semLeitura,
          faixaDoNome: undefined,
        }),
      ).toEqual([]);
    });

    it('um nome em branco não é da faixa: é do achado de nome ausente', () => {
      expect(achadosDaLeituraShopee(link([linha(0, ' ', ['p'])]), 0, comBanda)).toEqual([]);
    });
  });
});

describe('mensagemDoAchadoShopee — o texto do cartão, pt-BR', () => {
  const nome = (id: string) => id.toUpperCase();

  it.each<[AchadoVinculoShopee, string]>([
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.chaveRepetida,
        bloqueia: false,
        indices: [0, 1],
        integracaoId: 'int-1',
        categoryId: FASHION,
      },
      'Outro vínculo deste grupo com esta conta e categoria vem antes na lista; a publicação lê só aquele. Remova um dos dois.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes,
        bloqueia: true,
        indices: [0],
        varianteId: 'p',
        categoryId: FASHION,
        opcoes: [
          { id: 6258, nome: 'Preto' },
          { id: 9585, nome: 'Preto' },
        ],
      },
      // «usa só a primeira» was true of a create only: an update pairs each live option with its
      // own row, and two live custom options on one variante are refused (apps/shopee
      // tiersPublicacao.test.ts, «duas LINHAS custom ligam duas opções vivas à MESMA variante»).
      'A variante «P» está em mais de uma opção (Preto (6258), Preto (9585)) — a publicação pode usar qualquer uma delas, ou recusar o anúncio. Escolha uma.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.opcaoPersonalizadaSemNome,
        bloqueia: true,
        indices: [0],
        varianteId: 'v-1',
      },
      'A opção personalizada da variante «V-1» está sem nome. Dê um nome à variante (aba Variantes), se ela ainda não tiver, e escolha de novo a opção personalizada dela aqui.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.opcaoComVariasVariantes,
        bloqueia: false,
        indices: [0],
        opcao: { id: 6258, nome: 'Preto' },
        variantes: ['p', 'm'],
      },
      'As variantes «P», «M» estão na mesma opção «Preto»: um produto que tenha mais de uma delas não poderá ser publicado.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.varianteInexistente,
        bloqueia: false,
        indices: [0],
        opcao: { id: 6258, nome: 'Preto' },
        varianteId: 'v-9',
      },
      'A opção «Preto» está vinculada a uma variante que não existe mais neste grupo (v-9); a publicação a ignora.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.varianteRemovidaNestaGravacao,
        bloqueia: false,
        indices: [0],
        opcao: { id: 6258, nome: 'Preto' },
        varianteId: 'p',
      },
      'A variante «P» está vinculada à opção «Preto» da Shopee; ao salvar, o vínculo fica sem efeito.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.opcaoForaDaArvore,
        bloqueia: false,
        indices: [0],
        opcao: { id: 6933, nome: 'M' },
      },
      'A opção M (6933) não está entre as opções atuais da Shopee para a variação e o grupo deste vínculo. O vínculo é mantido: um anúncio publicado pode estar usando essa opção.',
    ],
    [
      { tipo: TIPO_ACHADO_SHOPEE.grupoAusente, bloqueia: false, indices: [0] },
      'A Shopee exige o grupo de opções desta variação, e este vínculo não o registra. Escolha o grupo — ou reimporte o anúncio, que o registra.',
    ],
    [
      {
        tipo: TIPO_ACHADO_SHOPEE.nomeForaDaFaixa,
        bloqueia: false,
        indices: [0],
        nome: ' Cor do ERP ',
        comprimento: 31,
        faixa: '1..30',
      },
      'A opção personalizada «Cor do ERP» tem 31 caracteres e a Shopee aceita 1..30 — encurte o nome da variante (aba Variantes) e escolha de novo a opção personalizada dela aqui.',
    ],
  ])('%j', (achado, texto) => {
    expect(mensagemDoAchadoShopee(achado, nome)).toBe(texto);
  });

  it('uma opção sem nome se diz «Sem nome», e a personalizada dispensa o id 0', () => {
    expect(
      mensagemDoAchadoShopee(
        {
          tipo: TIPO_ACHADO_SHOPEE.varianteEmDuasOpcoes,
          bloqueia: true,
          indices: [0],
          varianteId: 'p',
          categoryId: FASHION,
          opcoes: [
            { id: 6258, nome: ' ' },
            { id: 0, nome: 'Cor do ERP' },
          ],
        },
        nome,
      ),
    ).toContain('(Sem nome (6258), Cor do ERP)');
  });
});

describe('rebaseVinculosShopee — o conflito se resolve por (conta, categoria)', () => {
  const comum = vinculo('int-1', FASHION, [linha(6857, 'P', ['p'])]);
  const doImport = vinculo('int-1', 200, [linha(0, 'Cor do ERP', ['p'])], { variation_id: 0 });
  const meuNovo = vinculo('int-1', 300, [linha(6258, 'Preto', ['p'])]);

  it('IGUAL: o import acrescentou outra (conta, categoria) enquanto eu editava ⇒ as duas ficam', () => {
    expect(
      rebaseVinculosShopee({ loaded: [comum], server: [comum, doImport], mine: [comum, meuNovo] }),
    ).toEqual({ value: [comum, doImport, meuNovo], collided: false });
  });

  it('⚠️ QUASE-PAR: os dois mudaram a MESMA chave ⇒ fica a do servidor, marcada, e colide', () => {
    const doServidor = vinculo('int-1', FASHION, [linha(6857, 'P', ['p', 'm'])]);
    const meu = vinculo('int-1', FASHION, [linha(6857, 'P', ['p', 'g'])]);
    const r = rebaseVinculosShopee({ loaded: [comum], server: [doServidor], mine: [meu] });
    expect(r.collided).toBe(true);
    expect(r.value).toEqual([
      { ...doServidor, [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.alterado },
    ]);
    expect(prepararVinculosShopee(r.value)).toEqual([doServidor]);
  });

  it('IGUAL: a mesma chave em outra grafia conta como a mesma, e colide', () => {
    const doServidor = vinculo('documents/integracao/int-1', FASHION, [linha(1, 'x', ['p'])]);
    const meu = vinculo('int-1', FASHION, [linha(2, 'y', ['p'])]);
    expect(
      rebaseVinculosShopee({ loaded: [comum], server: [doServidor], mine: [meu] }).collided,
    ).toBe(true);
  });

  it('⚠️ QUASE-PAR: `int-12` é outra chave: as duas ficam, sem colisão', () => {
    const doServidor = vinculo('int-12', FASHION, [linha(1, 'x', ['p'])]);
    const meu = vinculo('int-1', FASHION, [linha(2, 'y', ['p'])]);
    expect(rebaseVinculosShopee({ loaded: [], server: [doServidor], mine: [meu] })).toEqual({
      value: [doServidor, meu],
      collided: false,
    });
  });

  it('a minha edição de uma chave que só eu mudei é reaplicada sobre o resto do servidor', () => {
    const meu = definirOpcaoDaVarianteShopee(comum, 'm', {
      tipo: 'padrao',
      optionId: 6270,
      nome: 'M',
    });
    expect(
      rebaseVinculosShopee({ loaded: [comum], server: [comum, doImport], mine: [meu] }),
    ).toEqual({ value: [meu, doImport], collided: false });
  });

  it('a minha remoção marcada é reaplicada; o que o import trouxe fica', () => {
    const r = rebaseVinculosShopee({
      loaded: [comum],
      server: [comum, doImport],
      mine: alternarRemocaoShopee([comum], 0),
    });
    expect(r.collided).toBe(false);
    expect(prepararVinculosShopee(r.value)).toEqual([doImport]);
  });

  it('o servidor removeu o que eu mudei ⇒ «removido»: descartado ao gravar, salvo se refeito', () => {
    const meu = vinculo('int-1', FASHION, [linha(6857, 'P', ['p', 'g'])]);
    const r = rebaseVinculosShopee({ loaded: [comum], server: [], mine: [meu] });
    expect(r.collided).toBe(true);
    expect(r.value).toEqual([
      { ...meu, [MARCA_CONFLITO_VINCULO_SHOPEE]: CONFLITO_VINCULO_SHOPEE.removido },
    ]);
    expect(prepararVinculosShopee(r.value)).toEqual([]);
    const refeito = definirOpcaoDaVarianteShopee((r.value as unknown[])[0], 'm', {
      tipo: 'padrao',
      optionId: 6857,
      nome: 'P',
    });
    expect(prepararVinculosShopee([refeito])).toEqual([refeito]);
  });

  it('⚠️ um elemento ilegível sem chave que está no servidor nunca some', () => {
    const ilegivel = { name: 'meio feito' };
    const r = rebaseVinculosShopee({ loaded: [ilegivel], server: [ilegivel], mine: [meuNovo] });
    expect(r.value).toEqual([ilegivel, meuNovo]);
    expect(r.collided).toBe(false);
  });

  it('um campo ausente no servidor se mescla como lista vazia', () => {
    expect(rebaseVinculosShopee({ loaded: undefined, server: undefined, mine: [meuNovo] })).toEqual(
      { value: [meuNovo], collided: false },
    );
  });

  it('um valor que não é lista não se mescla', () => {
    const ilegivel = { legado: 1 };
    expect(rebaseVinculosShopee({ loaded: [], server: ilegivel, mine: [meuNovo] })).toEqual({
      value: ilegivel,
      collided: true,
    });
  });
});
