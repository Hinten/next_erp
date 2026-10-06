import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ESTADO_LISTA_SHOPEE,
  MOTIVO_ENTRADA_SHOPEE_ILEGIVEL,
  lerEntradasShopeeDaConta,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { lerTabelaMedidasDoProduto } from './lerTabelaMedidasDoProduto';

/* ---------------------------------- fixtures ------------------------------ */

const CONTA = 'int-1';
/** O quase-par da chave do mapa: um id que COMEÇA com o desta conta. */
const OUTRA_CONTA = 'int-10';
const TAB_ID = 'tab-1';
const CAMINHO = `tabMedi/${TAB_ID}`;
const REF = `documents/tabMedi/${TAB_ID}`;

/** A entrada do corpus legado — ids de AMOSTRA da doc da Shopee (`400055`, `700024641`). */
const ENTRADA = { categoryId: 400055, size_chart_id: 700024641, name: 'Camisetas' } as const;

const FOTO_1 = {
  arquivoOuterRef: 'arquivos/tab-1_aaa',
  arquivo400pxOuterRef: 'arquivos/tab-1_aaa_400',
};
const FOTO_2 = { arquivoOuterRef: 'arquivos/tab-1_bbb' };

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

function ler(ref: unknown, conta = CONTA) {
  return lerTabelaMedidasDoProduto(asDb(db), ref, conta);
}

function leituras(): number {
  return db.opLog.filter((op) => op.op === 'get').length;
}

/* -------------------------------------------------------------------------- */
/*                      (1) sem tabela — ZERO leituras (M76)                   */
/* -------------------------------------------------------------------------- */

describe('o produto sem tabela', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['vazio', ''],
    ['em branco', '   '],
    ['número', 42],
    ['objeto', { path: REF }],
    ['lista', [REF]],
  ])('%s ⇒ produto-sem-tabela, sem tocar o banco', async (_rotulo, ref) => {
    expect(await ler(ref)).toStrictEqual({ tipo: 'produto-sem-tabela' });
    expect(db.opLog).toEqual([]);
    expect(db.caminhos).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (2) um ref que não aponta para tabMedi — sem leitura         */
/* -------------------------------------------------------------------------- */

describe('o ref inutilizável', () => {
  it.each([
    ['outra coleção', 'documents/produtos/tab-1'],
    ['outra coleção, forma nua', 'categorias/tab-1'],
    ['só o id (sem coleção)', TAB_ID],
    ['um ponto como id', 'documents/tabMedi/..'],
    ['uma subcoleção de tabMedi', 'documents/tabMedi/tab-1/fotos/f-1'],
    ['a coleção sem id', 'documents/tabMedi/'],
  ])('%s ⇒ tabela-inexistente com tabMediId null, e NENHUMA leitura', async (_rotulo, ref) => {
    // Mesmo com o documento presente: ler `tabMedi/<o id>` de um ref de OUTRA
    // coleção anexaria a tabela de outra pessoa a este anúncio.
    db.seed(CAMINHO, { tabelasMedidasShopee: { [CONTA]: [ENTRADA] } });
    expect(await ler(ref)).toStrictEqual({ tipo: 'tabela-inexistente', tabMediId: null });
    expect(leituras()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                         (3) a leitura — UMA, pelo handle                    */
/* -------------------------------------------------------------------------- */

describe('a leitura', () => {
  it('as duas formas do ref (canônica e nua) leem o MESMO documento, uma vez cada', async () => {
    db.seed(CAMINHO, { tabelasMedidasShopee: { [CONTA]: [ENTRADA] } });

    for (const ref of [REF, `tabMedi/${TAB_ID}`]) {
      const antes = leituras();
      const lida = await ler(ref);
      expect(lida.tipo, ref).toBe('lida');
      expect(leituras() - antes, ref).toBe(1);
    }
    expect(db.opLog.map((op) => op.path)).toEqual([CAMINHO, CAMINHO]);
  });

  it('um documento ausente ⇒ tabela-inexistente com o id lido', async () => {
    expect(await ler(REF)).toStrictEqual({ tipo: 'tabela-inexistente', tabMediId: TAB_ID });
    expect(db.opLog).toEqual([{ op: 'get', path: CAMINHO }]);
  });

  it('a entrada do corpus chega como a fatia de leitura a entrega — a MESMA regra, não uma cópia', async () => {
    const mapa = { [CONTA]: [ENTRADA] };
    db.seed(CAMINHO, { nome: 'Camisetas', tabelasMedidasShopee: mapa });

    const lida = await ler(REF);

    expect(lida).toStrictEqual({
      tipo: 'lida',
      tabMediId: TAB_ID,
      leitura: lerEntradasShopeeDaConta(mapa, CONTA),
      primeiraFoto: null,
    });
    if (lida.tipo !== 'lida') throw new Error('inalcançável');
    expect(lida.leitura.linhas).toStrictEqual([{ indice: 0, entrada: ENTRADA, motivo: null }]);
    // Os ids continuam NÚMEROS — nada de texto no caminho até o corpo.
    expect(typeof lida.leitura.linhas[0]?.entrada?.size_chart_id).toBe('number');
  });

  it('NUNCA escreve — nem no caminho feliz, nem no ausente, nem no inutilizável', async () => {
    db.seed(CAMINHO, { tabelasMedidasShopee: { [CONTA]: [ENTRADA] }, fotos: [FOTO_1] });
    await ler(REF);
    await ler('documents/tabMedi/outra');
    await ler('documents/produtos/x');
    await ler(null);
    expect(db.writes).toEqual([]);
    expect(db.opLog.every((op) => op.op === 'get')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*            (4) a tolerância do corpus — regra 8 (M77) e a conta certa        */
/* -------------------------------------------------------------------------- */

describe('o corpus legado', () => {
  it.each([
    ['o campo ausente', {}],
    ['o campo null', { tabelasMedidasShopee: null }],
    ['o mapa vazio', { tabelasMedidasShopee: {} }],
    ['a chave desta conta null', { tabelasMedidasShopee: { [CONTA]: null } }],
    ['só OUTRA conta tem entradas', { tabelasMedidasShopee: { [OUTRA_CONTA]: [ENTRADA] } }],
  ])('%s ⇒ lida, sem-lista, nenhuma linha', async (_rotulo, doc) => {
    db.seed(CAMINHO, doc);
    const lida = await ler(REF);
    expect(lida.tipo).toBe('lida');
    if (lida.tipo !== 'lida') throw new Error('inalcançável');
    expect(lida.leitura).toStrictEqual({ estado: ESTADO_LISTA_SHOPEE.semLista, linhas: [] });
  });

  it('M77 — um mapa ML LIXO, fotos lixo e a chave null de outra conta não custam as entradas DESTA conta', async () => {
    db.seed(CAMINHO, {
      nome: 42,
      tabelasDeMedidasMercadoLivre: 'lixo',
      fotos: 'lixo',
      dataCadastro: 'ontem',
      tabelasMedidasShopee: { [OUTRA_CONTA]: null, [CONTA]: [ENTRADA] },
    });

    const lida = await ler(REF);

    if (lida.tipo !== 'lida') throw new Error(`esperava lida, veio ${lida.tipo}`);
    expect(lida.leitura.estado).toBe(ESTADO_LISTA_SHOPEE.lista);
    expect(lida.leitura.linhas).toStrictEqual([{ indice: 0, entrada: ENTRADA, motivo: null }]);
    expect(lida.primeiraFoto).toBeNull();
  });

  it('uma entrada ilegível é CONTADA na sua posição crua, e não derruba a vizinha', async () => {
    db.seed(CAMINHO, {
      tabelasMedidasShopee: {
        [CONTA]: [{ categoryId: '400055', size_chart_id: 700024641, name: 'x' }, ENTRADA, null],
      },
    });

    const lida = await ler(REF);

    if (lida.tipo !== 'lida') throw new Error('inalcançável');
    expect(lida.leitura.linhas).toStrictEqual([
      { indice: 0, entrada: null, motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.categoriaInvalida },
      { indice: 1, entrada: ENTRADA, motivo: null },
      { indice: 2, entrada: null, motivo: MOTIVO_ENTRADA_SHOPEE_ILEGIVEL.entradaInvalida },
    ]);
  });

  it('⛔ QUASE-PAR da chave: a conta `int-1` não lê a lista de `int-10`, e vice-versa', async () => {
    const deOutra = { categoryId: 400056, size_chart_id: 700024642, name: 'Calças' };
    db.seed(CAMINHO, { tabelasMedidasShopee: { [CONTA]: [ENTRADA], [OUTRA_CONTA]: [deOutra] } });

    const minha = await ler(REF, CONTA);
    const dela = await ler(REF, OUTRA_CONTA);

    if (minha.tipo !== 'lida' || dela.tipo !== 'lida') throw new Error('inalcançável');
    expect(minha.leitura.linhas.map((l) => l.entrada)).toStrictEqual([ENTRADA]);
    expect(dela.leitura.linhas.map((l) => l.entrada)).toStrictEqual([deOutra]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (5) a PRIMEIRA foto — e só a primeira (M-A3)                */
/* -------------------------------------------------------------------------- */

describe('a primeira foto da tabela', () => {
  it('é `fotos[0]`, pelo schema da foto (os derivados ausentes viram null)', async () => {
    db.seed(CAMINHO, { fotos: [FOTO_1, FOTO_2] });
    const lida = await ler(REF);
    if (lida.tipo !== 'lida') throw new Error('inalcançável');
    expect(lida.primeiraFoto).toStrictEqual({
      arquivoOuterRef: 'arquivos/tab-1_aaa',
      arquivo200pxOuterRef: null,
      arquivo400pxOuterRef: 'arquivos/tab-1_aaa_400',
      arquivoJpegOuterRef: null,
      grupoDeVariacoesOuterRef: null,
      variantePath: null,
    });
  });

  it('M-A3 — ⛔ uma primeira foto ILEGÍVEL dá null: a SEGUNDA nunca é escolhida no lugar', async () => {
    // A ordem é do operador, e as fotos depois da primeira podem ser da peça,
    // não da tabela — mandar uma delas publicaria a imagem errada como tabela.
    db.seed(CAMINHO, { fotos: [{ semArquivo: true }, FOTO_2] });
    const lida = await ler(REF);
    if (lida.tipo !== 'lida') throw new Error('inalcançável');
    expect(lida.primeiraFoto).toBeNull();
  });

  it.each([
    ['ausente', {}],
    ['null', { fotos: null }],
    ['vazia', { fotos: [] }],
    ['não é lista', { fotos: { 0: FOTO_1 } }],
  ])('fotos %s ⇒ null', async (_rotulo, doc) => {
    db.seed(CAMINHO, doc);
    const lida = await ler(REF);
    if (lida.tipo !== 'lida') throw new Error('inalcançável');
    expect(lida.primeiraFoto).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                           (6) disciplina do módulo                          */
/* -------------------------------------------------------------------------- */

describe('disciplina do módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./lerTabelaMedidasDoProduto.ts', import.meta.url)),
    'utf8',
  );

  it('lê pelo handle da coleção e pela fatia do schemas — nunca uma coleção inline nem um parse local', () => {
    expect(fonte).toContain('tabelaDeMedidasCollection.docRef(');
    expect(fonte).toContain('lerEntradasShopeeDaConta(');
    expect(fonte).not.toMatch(/\.collection\(/);
    expect(fonte).not.toContain('parseRead(');
    // Uma regra de seleção só (#1369): este módulo LÊ, não escolhe.
    expect(fonte).not.toMatch(/categoryId\s*===/);
    expect(fonte).not.toContain('resolverEntradaShopee');
  });

  it('não escreve, não tem relógio, não fala com a Shopee', () => {
    for (const proibido of [
      '.set(',
      '.update(',
      '.merge(',
      '.delete(',
      'runTransaction',
      'Date.now',
      'process.env',
      'next/server',
      '@delfrance/integrations-shopee',
    ]) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });
});
