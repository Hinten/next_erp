import { describe, expect, it } from 'vitest';
import { DELETE_MARK } from '@delfrance/ui';

import {
  CONFLITO_VINCULO_LI,
  MARCA_CONFLITO_VINCULO_LI,
  alternarRemocaoLi,
  prepararVinculosLi,
  rebaseVinculosLi,
} from './vinculadorLi';
import { MARCA_CONFLITO_VINCULO_SHOPEE, marcaDeConflitoShopee } from './vinculadorShopee';
import {
  CONFLITO_VINCULO,
  criarNucleoDeVinculos,
  idsDasVariantes,
  nomesDasVariantes,
  valorAposEsvaziar,
} from './vinculosDeCanal';

/**
 * The linkers' shared core, driven through a TOY key so nothing here leans on a
 * channel. Loja Integrada's own suites (`vinculadorLi.test.ts`,
 * `VinculadorLojaIntegrada.test.tsx`, `[id]/page.test.tsx`) stay byte-unedited over
 * the alias module: that is the extraction's neutrality proof.
 *
 * Every fold comes as a PAIR: what must come out equal, and the near-miss that
 * must stay distinct.
 */

type Doc = Record<string, unknown>;

const MARCA = '_marcaDoBrinquedo';
const EMBRULHO = '_embrulhoDoBrinquedo';

const nucleo = criarNucleoDeVinculos({
  marcaConflito: MARCA,
  chaveValorIlegivel: EMBRULHO,
  chaveDe: (e) => (typeof e.chave === 'string' ? e.chave : null),
});

const item = (chave: string, valor: unknown = 1): Doc => ({ chave, valor });

describe('preparar — o que a gravação escreve', () => {
  it('descarta o removido e o marcado «removido», tira as marcas do resto', () => {
    const intacto = item('a');
    const removido = { ...item('b'), [DELETE_MARK]: true };
    const desfeito = { ...item('c'), [DELETE_MARK]: false };
    const alterado = { ...item('d'), [MARCA]: CONFLITO_VINCULO.alterado };
    const sumiu = { ...item('e'), [MARCA]: CONFLITO_VINCULO.removido };

    expect(nucleo.preparar([intacto, removido, desfeito, alterado, sumiu])).toEqual([
      intacto,
      item('c'),
      item('d'),
    ]);
  });

  it('IGUAL: uma entrada sem marca volta como o MESMO objeto, chaves estranhas e tudo', () => {
    const intacto = { ...item('a'), chaveDesconhecida: 7 };
    expect((nucleo.preparar([intacto]) as Doc[])[0]).toBe(intacto);
  });

  it('⚠️ QUASE-PAR: uma entrada com marca volta como CÓPIA, e a original fica intacta', () => {
    const marcada = { ...item('a'), [MARCA]: CONFLITO_VINCULO.alterado };
    const antes = structuredClone(marcada);
    const saida = (nucleo.preparar([marcada]) as Doc[])[0];
    expect(saida).not.toBe(marcada);
    expect(saida).toEqual(item('a'));
    expect(marcada).toEqual(antes);
  });

  it('um valor que não é lista passa direto (o schema reclama dele)', () => {
    expect(nucleo.preparar(null)).toBeNull();
    const ilegivel = { legado: true };
    expect(nucleo.preparar(ilegivel)).toBe(ilegivel);
  });

  it('prepararComOrigem aponta cada entrada gravada para o índice do formulário', () => {
    const removido = { ...item('a'), [DELETE_MARK]: true };
    const { lista, origem } = nucleo.prepararComOrigem([removido, item('b'), 'lixo']);
    expect(lista).toEqual([item('b'), 'lixo']);
    expect(origem).toEqual([1, 2]);
  });

  it('prepararComOrigem de um valor que não é lista é vazio', () => {
    expect(nucleo.prepararComOrigem({ legado: 1 })).toEqual({ lista: [], origem: [] });
  });
});

describe('editadasPorValor — editada ou intacta, por VALOR contra o seed', () => {
  const guardado = item('a', [1, 2]);

  it('IGUAL: outro objeto com o mesmo valor está intacto', () => {
    expect(nucleo.editadasPorValor([structuredClone(guardado)], { links: [guardado] })).toEqual(
      new Set(),
    );
  });

  it.each([
    ['um array reordenado', item('a', [2, 1])],
    ['`null` onde o seed não tem a chave', { ...guardado, extra: null }],
    ['um número virou string', item('a', ['1', 2])],
  ])('⚠️ QUASE-PAR: %s ⇒ editada', (_caso, entrada) => {
    expect(nucleo.editadasPorValor([entrada], { links: [guardado] })).toEqual(new Set([0]));
  });

  it('⚠️ FALHA FECHADO: sem seed publicado toda entrada conta como editada', () => {
    expect(nucleo.editadasPorValor([guardado, guardado], null)).toEqual(new Set([0, 1]));
  });

  it('⚠️ cada entrada do seed responde por UMA entrada', () => {
    expect(
      nucleo.editadasPorValor([guardado, structuredClone(guardado)], { links: [guardado] }),
    ).toEqual(new Set([1]));
  });

  it('um seed sem lista deixa toda entrada editada', () => {
    expect(nucleo.editadasPorValor([guardado], { links: null })).toEqual(new Set([0]));
  });
});

describe('alternarRemocao e substituirEntrada — sempre uma lista NOVA', () => {
  it('remove e desfaz: a marca vem e vai, o valor volta exato', () => {
    const lista = [item('a')];
    const marcada = nucleo.alternarRemocao(lista, 0);
    expect((marcada[0] as Doc)[DELETE_MARK]).toBe(true);
    expect(lista[0]).toEqual(item('a'));
    expect(nucleo.alternarRemocao(marcada, 0)).toEqual(lista);
  });

  it('⚠️ desfazer não é editar: a nota do conflito fica, e a gravação ainda descarta', () => {
    const marcado = { ...item('a'), [MARCA]: CONFLITO_VINCULO.removido };
    const volta = nucleo.alternarRemocao(nucleo.alternarRemocao([marcado], 0), 0);
    expect(volta).toEqual([marcado]);
    expect(nucleo.marcaDeConflito(volta[0])).toBe(CONFLITO_VINCULO.removido);
    expect(nucleo.preparar(volta)).toEqual([]);
  });

  it('até um elemento que não é objeto pode ser removido e restaurado', () => {
    const marcada = nucleo.alternarRemocao(['lixo'], 0);
    expect(marcada[0]).toEqual({ [DELETE_MARK]: true, [EMBRULHO]: 'lixo' });
    expect(nucleo.removidaNoFormulario(marcada[0])).toBe(true);
    expect(nucleo.normalizarEntrada(marcada[0])).toBe('lixo');
    expect(nucleo.preparar(marcada)).toEqual([]);
    expect(nucleo.alternarRemocao(marcada, 0)).toEqual(['lixo']);
  });

  it('um índice fora da lista não muda nada', () => {
    expect(nucleo.alternarRemocao([item('a')], 5)).toEqual([item('a')]);
    expect(nucleo.substituirEntrada([item('a')], 5, item('z'))).toEqual([item('a')]);
  });

  it('substituirEntrada troca só o índice pedido', () => {
    const lista = [item('a'), item('b')];
    const nova = nucleo.substituirEntrada(lista, 1, item('z'));
    expect(nova).toEqual([item('a'), item('z')]);
    expect(lista[1]).toEqual(item('b'));
  });
});

describe('as marcas são da instância', () => {
  it('⚠️ QUASE-PAR: a marca de outro canal é só uma chave desconhecida', () => {
    const outro = { ...item('a'), [MARCA_CONFLITO_VINCULO_LI]: CONFLITO_VINCULO.removido };
    expect(nucleo.marcaDeConflito(outro)).toBeNull();
    expect(nucleo.normalizarEntrada(outro)).toBe(outro);
    expect(nucleo.preparar([outro])).toEqual([outro]);
    expect(marcaDeConflitoShopee(outro)).toBeNull();
  });

  it('uma marca com outro valor não é nota de conflito', () => {
    expect(nucleo.marcaDeConflito({ ...item('a'), [MARCA]: 'outra' })).toBeNull();
  });

  it('uma propriedade herdada não é dado guardado', () => {
    const herdada = Object.create({ [DELETE_MARK]: true }) as Doc;
    expect(nucleo.removidaNoFormulario(herdada)).toBe(false);
  });

  it('IGUAL: as marcas e os valores da Loja Integrada são os de sempre', () => {
    expect(MARCA_CONFLITO_VINCULO_LI).toBe('_conflitoVinculoLi');
    expect(CONFLITO_VINCULO_LI).toEqual({ alterado: 'alterado', removido: 'removido' });
    expect(alternarRemocaoLi(['lixo'], 0)[0]).toEqual({
      [DELETE_MARK]: true,
      _valorIlegivelLi: 'lixo',
    });
    expect(prepararVinculosLi([{ _conflitoVinculoLi: 'alterado', x: 1 }])).toEqual([{ x: 1 }]);
  });

  it('⚠️ QUASE-PAR: a chave da Loja Integrada é exata — « C1» e «C1» na mesma grade são dois vínculos, não uma colisão', () => {
    const vinculoLi = (conta: string, opcao: number): Doc => ({
      name: 'Tamanho',
      grade_id: 900201,
      integracaoLiId: conta,
      variationOptions: [
        { li_option_id: opcao, li_option_name: 'P', arakene_variation_id: ['v1'] },
      ],
    });
    const meu = vinculoLi('C1', 900302);
    const doServidor = vinculoLi(' C1', 900302);
    expect(
      rebaseVinculosLi({
        loaded: [vinculoLi('C1', 900301), vinculoLi(' C1', 900301)],
        server: [vinculoLi('C1', 900301), doServidor],
        mine: [meu, vinculoLi(' C1', 900301)],
      }),
    ).toEqual({ value: [meu, doServidor], collided: false });
  });

  it('⚠️ QUASE-PAR: a marca da Shopee é outra, então os canais não leem um ao outro', () => {
    expect(MARCA_CONFLITO_VINCULO_SHOPEE).toBe('_conflitoVinculoShopee');
    expect(MARCA_CONFLITO_VINCULO_SHOPEE).not.toBe(MARCA_CONFLITO_VINCULO_LI);
  });
});

describe('rebasePorChave — o conflito se resolve por chave', () => {
  const a = item('a');
  const b = item('b');

  it('IGUAL: cada lado acrescentou uma chave ⇒ as duas ficam, sem colisão', () => {
    expect(nucleo.rebasePorChave({ loaded: [a], server: [a, b], mine: [a, item('c')] })).toEqual({
      value: [a, b, item('c')],
      collided: false,
    });
  });

  it('só eu mudei ⇒ a minha; só o servidor mudou ⇒ a dele', () => {
    const minha = item('a', 'minha');
    expect(nucleo.rebasePorChave({ loaded: [a], server: [a], mine: [minha] })).toEqual({
      value: [minha],
      collided: false,
    });
    const dele = item('a', 'dele');
    expect(nucleo.rebasePorChave({ loaded: [a], server: [dele], mine: [a] })).toEqual({
      value: [dele],
      collided: false,
    });
  });

  it('os dois fizeram a MESMA mudança ⇒ sem colisão', () => {
    const igual = item('a', 'igual');
    expect(nucleo.rebasePorChave({ loaded: [a], server: [igual], mine: [igual] })).toEqual({
      value: [igual],
      collided: false,
    });
  });

  it('⚠️ QUASE-PAR: os dois mudaram a mesma chave, diferente ⇒ fica a do servidor, marcada', () => {
    const dele = item('a', 'dele');
    const r = nucleo.rebasePorChave({ loaded: [a], server: [dele], mine: [item('a', 'minha')] });
    expect(r.collided).toBe(true);
    expect(r.value).toEqual([{ ...dele, [MARCA]: CONFLITO_VINCULO.alterado }]);
    expect(nucleo.preparar(r.value)).toEqual([dele]);
  });

  it('o servidor removeu o que eu mudei ⇒ a minha, marcada «removido», descartada ao gravar', () => {
    const minha = item('a', 'minha');
    const r = nucleo.rebasePorChave({ loaded: [a], server: [], mine: [minha] });
    expect(r.collided).toBe(true);
    expect(r.value).toEqual([{ ...minha, [MARCA]: CONFLITO_VINCULO.removido }]);
    expect(nucleo.preparar(r.value)).toEqual([]);
  });

  it('os dois removeram a mesma chave ⇒ sem colisão, e nada volta', () => {
    const r = nucleo.rebasePorChave({
      loaded: [a],
      server: [],
      mine: [{ ...a, [DELETE_MARK]: true }],
    });
    expect(r).toEqual({ value: [], collided: false });
  });

  it('a minha remoção marcada é reaplicada sobre o que o servidor ainda tem', () => {
    const r = nucleo.rebasePorChave({
      loaded: [a],
      server: [a, b],
      mine: [{ ...a, [DELETE_MARK]: true }],
    });
    expect(r.collided).toBe(false);
    expect(nucleo.preparar(r.value)).toEqual([b]);
  });

  it('uma entrada sem chave vinda do servidor nunca some', () => {
    const meiaBoca = { semChave: true };
    const r = nucleo.rebasePorChave({ loaded: [], server: [meiaBoca], mine: [a] });
    expect(r).toEqual({ value: [meiaBoca, a], collided: false });
  });

  it('uma remoção marcada de entrada sem chave vale enquanto o servidor ainda a tem', () => {
    const meiaBoca = { semChave: true };
    const removida = { ...meiaBoca, [DELETE_MARK]: true };
    const ainda = nucleo.rebasePorChave({
      loaded: [meiaBoca],
      server: [meiaBoca, b],
      mine: [removida],
    });
    expect(ainda.collided).toBe(false);
    expect(nucleo.preparar(ainda.value)).toEqual([b]);

    const jaFoi = nucleo.rebasePorChave({ loaded: [meiaBoca], server: [b], mine: [removida] });
    expect(jaFoi).toEqual({ value: [b], collided: false });
  });

  it('um valor que não é lista não se mescla: fica o do servidor, e para', () => {
    const ilegivel = { legado: 1 };
    expect(nucleo.rebasePorChave({ loaded: [a], server: ilegivel, mine: [a] })).toEqual({
      value: ilegivel,
      collided: true,
    });
  });

  it('um campo que o servidor guarda como `null` se comporta como lista vazia', () => {
    expect(nucleo.rebasePorChave({ loaded: null, server: null, mine: [b] })).toEqual({
      value: [b],
      collided: false,
    });
    expect(nucleo.rebasePorChave({ loaded: null, server: null, mine: null })).toEqual({
      value: null,
      collided: false,
    });
  });
});

describe('valorAposEsvaziar — #1787', () => {
  it.each([
    ['chave ausente', undefined],
    ['`null`', null],
  ])('IGUAL: lista vazia sobre %s volta ao seed', (_caso, seed) => {
    expect(valorAposEsvaziar([], seed)).toBe(seed);
  });

  it('⚠️ QUASE-PAR: `[]` guardado volta como `[]`, nunca `null`', () => {
    const seed: unknown[] = [];
    expect(valorAposEsvaziar([], seed)).toBe(seed);
  });

  it('uma lista que ainda tem algo fica como está', () => {
    const lista = [item('a')];
    expect(valorAposEsvaziar(lista, null)).toBe(lista);
  });

  it('⚠️ QUASE-PAR: um seed que guarda algo não ressuscita ao esvaziar', () => {
    const lista: unknown[] = [];
    expect(valorAposEsvaziar(lista, [item('a')])).toBe(lista);
  });

  it('um seed que não é lista não volta: quem o substituiu foi o operador', () => {
    const lista: unknown[] = [];
    expect(valorAposEsvaziar(lista, { legado: 1 })).toBe(lista);
  });
});

describe('idsDasVariantes e nomesDasVariantes — exatos, sem dobra', () => {
  it('os ids saem na ordem, sem as variantes marcadas para exclusão', () => {
    const variacoes = [
      { id: 'v1', nome: 'P' },
      { id: 'v2', nome: 'M', [DELETE_MARK]: true },
      { id: 3 },
      'lixo',
      { id: 'v4', nome: 'G', [DELETE_MARK]: false },
    ];
    expect(idsDasVariantes(variacoes)).toEqual(['v1', 'v4']);
    expect(idsDasVariantes(null)).toEqual([]);
  });

  it('o primeiro nome vence, e um nome vazio não é nome', () => {
    const nomes = nomesDasVariantes(
      [
        { id: 'v1', nome: 'P' },
        { id: 'v2', nome: '' },
      ],
      [
        { id: 'v1', nome: 'Outro' },
        { id: 'v2', nome: 'M' },
      ],
      null,
    );
    expect(nomes.get('v1')).toBe('P');
    expect(nomes.get('v2')).toBe('M');
  });
});
