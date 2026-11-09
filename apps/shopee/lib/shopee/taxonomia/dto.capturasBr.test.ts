/**
 * The P13a capture pins (#1911): `projetarAtributos` over the eight COMMITTED
 * BR attribute trees (`fixtures/__wire__/get_attribute_tree.br-*.json`, read
 * through `wireCorpus.ts` and the package's own operation schema).
 *
 * ⚠️ **Counts and booleans**, labelled by fixture — the `capturasBr.test.ts`
 * convention. Every expected name is DERIVED from the committed body (its
 * `pt-BR` `multi_lang` entry, else its `name`); the only literals are the four
 * suffixed labels Lucas's 2026-11-04 decision (Q2 = A) spells, and the ids,
 * which are Shopee's PUBLIC taxonomy. If a body and a count disagree, the
 * finding is about the code or about Shopee — never a reason to edit the body.
 */
import {
  type ShopeeAttribute,
  type ShopeeAttributeValue,
  shopeeAttributeTreeSchema,
} from '@delfrance/integrations-shopee';
import type { AtributoDto } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { atributosParaPublicar } from '../anuncios/montagemAnuncio';
import {
  CORPOS_BR_1911,
  FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA,
  FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_VARIACOES,
  FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA,
  FIXTURE_ATTRIBUTE_TREE_BR_C_CAMISETA,
  FIXTURE_ATTRIBUTE_TREE_BR_D_SHAMPOO,
  lerFixture,
} from '../fixtures/wireCorpus';
import { projetarAtributos } from './dto';

/**
 * Every committed BR attribute tree — DERIVED from `CORPOS_BR_1911` (which
 * `wireCorpus.test.ts` ties to the disk), so a new tree is projected here too
 * and moves the anchor below instead of going unread.
 */
const ARVORES = CORPOS_BR_1911.filter((f) => f.startsWith('get_attribute_tree.'));

/** Connection Type, its Wireless value — public taxonomy (the b-capa tree). */
const TIPO_DE_CONEXAO = 100_408;
const SEM_FIO = 2530;

/** The parsed tree of one committed body: one requested category, one row. */
function arvoreDe(file: string): readonly ShopeeAttribute[] {
  const lido = shopeeAttributeTreeSchema.parse(lerFixture(file));
  expect(lido.response.list, file).toHaveLength(1);
  return lido.response.list[0]?.attribute_tree ?? [];
}

/** The body's own `pt-BR` text — what the projection must show when there is one. */
function ptBrDoCorpo(row: ShopeeAttribute | ShopeeAttributeValue): string | undefined {
  return row.multi_lang.find((m) => m.language === 'pt-BR')?.value ?? undefined;
}

/** One raw node beside the name it was projected to. */
interface Par {
  readonly file: string;
  readonly tipo: 'atributo' | 'valor';
  /** The attribute id; for a value, the attribute it belongs to. */
  readonly atributo: number;
  /** The node's own id (the attribute id, or the value id). */
  readonly id: number;
  readonly bruto: ShopeeAttribute | ShopeeAttributeValue;
  readonly projetado: string | null;
  /** Which sibling list the node sits in — the scope of a collision. */
  readonly lista: string;
}

/** Walk raw and projected trees in lockstep (the projection keeps order). */
function emparelhar(
  file: string,
  brutos: readonly ShopeeAttribute[],
  projetados: readonly AtributoDto[],
  lista: string,
  saida: Par[],
): void {
  expect(projetados.map((a) => a.attributeId)).toEqual(brutos.map((a) => a.attribute_id));
  brutos.forEach((a, i) => {
    const dto = projetados[i];
    if (dto === undefined) return;
    saida.push({
      file,
      tipo: 'atributo',
      atributo: a.attribute_id,
      id: a.attribute_id,
      bruto: a,
      projetado: dto.name,
      lista,
    });
    expect(dto.attributeValueList.map((v) => v.valueId)).toEqual(
      a.attribute_value_list.map((v) => v.value_id),
    );
    a.attribute_value_list.forEach((v, j) => {
      const dv = dto.attributeValueList[j];
      if (dv === undefined) return;
      saida.push({
        file,
        tipo: 'valor',
        atributo: a.attribute_id,
        id: v.value_id,
        bruto: v,
        projetado: dv.name,
        lista: `${lista}/a${String(a.attribute_id)}`,
      });
      emparelhar(
        file,
        v.child_attribute_list,
        dv.childAttributeList,
        `${lista}/a${String(a.attribute_id)}/v${String(v.value_id)}`,
        saida,
      );
    });
  });
}

function todosOsPares(): Par[] {
  const pares: Par[] = [];
  for (const file of ARVORES) {
    const arvore = arvoreDe(file);
    const { atributos, truncated } = projetarAtributos(arvore);
    expect(truncated, file).toBe(false);
    emparelhar(file, arvore, atributos, 'raiz', pares);
  }
  return pares;
}

describe('P13a sobre as oito árvores BR — get_attribute_tree.br-*', () => {
  it('get_attribute_tree.br-* (as oito): o passeio vê 141 atributos e 708 valores (âncora contra vacuidade)', () => {
    expect(ARVORES).toHaveLength(8);
    const pares = todosOsPares();
    expect(pares.filter((p) => p.tipo === 'atributo')).toHaveLength(141);
    expect(pares.filter((p) => p.tipo === 'valor')).toHaveLength(708);
  });

  it(`get_attribute_tree.br-*: UM só nó sem \`pt-BR\` — ${FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA} 100134/1942 — e ele mostra o nome da Shopee`, () => {
    const semPtBr = todosOsPares().filter((p) => ptBrDoCorpo(p.bruto) === undefined);
    expect(semPtBr.map((p) => [p.file, p.tipo, p.atributo, p.id])).toEqual([
      [FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA, 'valor', 100134, 1942],
    ]);
    const [unico] = semPtBr;
    expect(typeof unico?.bruto.name).toBe('string');
    expect(unico?.projetado === unico?.bruto.name).toBe(true);
  });

  it('get_attribute_tree.br-*: 3 grupos colidem, todos no 100134 — e só eles levam sufixo, com o nome da Shopee', () => {
    const sufixados = todosOsPares().filter(
      (p) => p.projetado !== (ptBrDoCorpo(p.bruto) ?? p.bruto.name),
    );
    expect(sufixados.map((p) => [p.file, p.tipo, p.atributo, p.id, p.projetado])).toEqual([
      [FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA, 'valor', 100134, 1801, 'Porcelana (Porcelain)'],
      [FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA, 'valor', 100134, 1955, 'Porcelana (Fine China)'],
      [FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_VARIACOES, 'valor', 100134, 1156, 'Lã (Fleece)'],
      [FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_VARIACOES, 'valor', 100134, 1775, 'Lã (Wool)'],
      [FIXTURE_ATTRIBUTE_TREE_BR_C_CAMISETA, 'valor', 100134, 1156, 'Lã (Fleece)'],
      [FIXTURE_ATTRIBUTE_TREE_BR_C_CAMISETA, 'valor', 100134, 1775, 'Lã (Wool)'],
    ]);
    // Each suffix is the body's own `pt-BR` text plus its own `name`.
    expect(
      sufixados.map((p) => p.projetado === `${ptBrDoCorpo(p.bruto) ?? ''} (${p.bruto.name ?? ''})`),
    ).toEqual([true, true, true, true, true, true]);
    expect(new Set(sufixados.map((p) => `${p.file}|${p.lista}`)).size).toBe(3);
  });

  it('get_attribute_tree.br-*: todo outro nome é EXATAMENTE a entrada `pt-BR` do corpo (849 − 6 − 1 = 842)', () => {
    const pares = todosOsPares();
    const iguaisAoPtBr = pares.filter((p) => {
      const pt = ptBrDoCorpo(p.bruto);
      return pt !== undefined && p.projetado === pt;
    });
    expect(iguaisAoPtBr).toHaveLength(pares.length - 6 - 1);
    expect(pares).toHaveLength(849);
  });

  it('get_attribute_tree.br-*: nenhuma lista de irmãos projetada oferece dois rótulos iguais', () => {
    // ⚠️ Mais ESTRITO que o código, de propósito: compara o rótulo como a tela
    // o mostra (NFC, pontas aparadas, espaços colapsados) entre ids DISTINTOS.
    // Uma captura nova com «Lã» × «Lã », ou com o resíduo de uma passada só,
    // fica vermelha aqui em vez de concordar com o predicado do próprio código.
    const exibido = (n: string): string => n.normalize('NFC').trim().replace(/\s+/gu, ' ');
    const porLista = new Map<string, Map<string, Set<number>>>();
    for (const p of todosOsPares()) {
      if (p.projetado === null) continue;
      const chave = `${p.file}|${p.tipo}|${p.lista}`;
      const rotulos = porLista.get(chave) ?? new Map<string, Set<number>>();
      const ids = rotulos.get(exibido(p.projetado)) ?? new Set<number>();
      ids.add(p.id);
      rotulos.set(exibido(p.projetado), ids);
      porLista.set(chave, rotulos);
    }
    const repetidas = [...porLista].filter(([, rotulos]) =>
      [...rotulos.values()].some((ids) => ids.size > 1),
    );
    expect(porLista.size > 0).toBe(true);
    expect(repetidas.map(([chave]) => chave)).toEqual([]);
  });

  it(`get_attribute_tree.br-*: a entrada \`pt-BR\` às vezes É o inglês — ${FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA} 101534 e ${FIXTURE_ATTRIBUTE_TREE_BR_D_SHAMPOO} 101317 saem sem tradução`, () => {
    // O docblock de `projetarAtributos` cita estes dois: a projeção não traduz.
    const naoTraduzidos = todosOsPares().filter(
      (p) =>
        p.tipo === 'atributo' &&
        typeof p.bruto.name === 'string' &&
        ptBrDoCorpo(p.bruto) === p.bruto.name &&
        p.projetado === p.bruto.name,
    );
    const ids = naoTraduzidos.map((p) => `${p.file}|${String(p.id)}`);
    expect(ids.includes(`${FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA}|101534`)).toBe(true);
    expect(ids.includes(`${FIXTURE_ATTRIBUTE_TREE_BR_D_SHAMPOO}|101317`)).toBe(true);
  });
});

describe(`P13a × o publicador — ${FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA}`, () => {
  /** The b-capa tree's raw nodes the sentence is made of. */
  function nosDaCapa() {
    const arvore = arvoreDe(FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA);
    const conexao = arvore.find((a) => a.attribute_id === TIPO_DE_CONEXAO);
    const semFio = conexao?.attribute_value_list.find((v) => v.value_id === SEM_FIO);
    return { arvore, conexao, semFio, filhos: semFio?.child_attribute_list ?? [] };
  }

  it(`${FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA}: sem atributo armazenado, \`faltando\` tem 1 entrada — o \`pt-BR\` do 100408, não o nome inglês`, () => {
    const { arvore, conexao } = nosDaCapa();
    expect(conexao?.mandatory).toBe(true);

    const { faltando } = atributosParaPublicar(null, projetarAtributos(arvore));

    expect(faltando).toHaveLength(1);
    expect(conexao === undefined ? false : faltando[0] === ptBrDoCorpo(conexao)).toBe(true);
    expect(faltando[0] === conexao?.name).toBe(false);
  });

  it(`${FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA}: com 100408 = 2530 armazenado, \`faltando\` tem 3 entradas «<filho> (em <pai>: <valor>)», tudo em português`, () => {
    const { arvore, conexao, semFio, filhos } = nosDaCapa();
    expect(filhos).toHaveLength(3);
    expect(filhos.every((f) => f.mandatory)).toBe(true);

    const { faltando } = atributosParaPublicar(
      [{ attribute_id: TIPO_DE_CONEXAO, attribute_value_list: [{ value_id: SEM_FIO }] }],
      projetarAtributos(arvore),
    );

    const pai = conexao === undefined ? undefined : ptBrDoCorpo(conexao);
    const valor = semFio === undefined ? undefined : ptBrDoCorpo(semFio);
    expect(pai !== undefined && valor !== undefined).toBe(true);
    expect(faltando).toHaveLength(3);
    expect(
      filhos.map(
        (f, i) => faltando[i] === `${ptBrDoCorpo(f) ?? '?'} (em ${pai ?? '?'}: ${valor ?? '?'})`,
      ),
    ).toEqual([true, true, true]);
    // ⛔ None of Shopee's English names reaches the sentence.
    const ingleses = [conexao?.name, semFio?.name, ...filhos.map((f) => f.name)];
    expect(
      faltando.some((linha) => ingleses.some((n) => typeof n === 'string' && linha.includes(n))),
    ).toBe(false);
  });
});
