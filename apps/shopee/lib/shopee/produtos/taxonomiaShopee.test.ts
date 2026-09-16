import { describe, expect, it } from 'vitest';

import { shopeeModelSchema, type ShopeeModel } from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import { ShopeeImportBlockedError } from './errosImportacao';
import type { GrupoMemo } from './itemLido';
import { aplicarTaxonomiaShopee, criarMemoDeGrupos } from './taxonomiaShopee';
import { planejarTaxonomia, tiersDoItem, type GrupoPlanejado } from './taxonomiaShopeeCore';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const CATEGORIA = 100017;
const AGORA = 1_757_000_000_000;

function modelo(parcial: Record<string, unknown> = {}): ShopeeModel {
  return shopeeModelSchema.parse({ model_id: MODEL_ID, tier_index: [0], ...parcial });
}

/** One tier named `Cor` with two options, both CUSTOM (ids `0`, as a BR shop sends). */
const TIERS_COR = tiersDoItem({
  tiers: [
    {
      name: 'Cor',
      option_list: [
        { option: 'Azul', image: null },
        { option: 'Verde', image: null },
      ],
    },
  ],
  padronizados: [],
});

function planejar(memo: GrupoMemo, tiers = TIERS_COR): readonly GrupoPlanejado[] {
  return planejarTaxonomia({
    tiers,
    modelos: [modelo()],
    candidatos: memo.docs,
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    nomeCategoria: 'Manga Curta',
    nowMs: AGORA,
  }).grupos;
}

/** A stored grupo, with a key only the Flutter app authors. */
function semearGrupo(db: FakeDb, id: string, extra: Record<string, unknown> = {}): void {
  db.seed(`grupoDeVariacoes/${id}`, {
    nome: 'Cor',
    codigo: null,
    ordem: 7,
    tipo: 2,
    permiteFotos: true,
    variacoes: [{ id: 'v-azul', nome: 'Azul', codigo: null }],
    variacoesIds: ['v-azul'],
    campoSoDoFlutter: 'não modelado aqui',
    ...extra,
  });
}

function consultasDeGrupo(db: FakeDb): unknown[] {
  return db.consultas.filter((c) => c.fonte === 'grupoDeVariacoes');
}

/* -------------------------------- 1. o memo ------------------------------- */

describe('criarMemoDeGrupos', () => {
  it('lê a coleção UMA vez, por mais itens que perguntem — o memo é do DESPACHO', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = criarMemoDeGrupos(asDb(db));

    const a = await memo.carregar();
    const b = await memo.carregar();

    expect(consultasDeGrupo(db)).toHaveLength(1);
    expect(a.docs).toHaveLength(1);
    expect(b).toBe(a);
  });

  it('é SINGLE-FLIGHT: duas perguntas concorrentes não viram duas leituras', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = criarMemoDeGrupos(asDb(db));

    await Promise.all([memo.carregar(), memo.carregar(), memo.carregar()]);

    expect(consultasDeGrupo(db)).toHaveLength(1);
  });

  it('um memo NOVO lê de novo — é assim que uma retentativa enxerga quem venceu', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');

    await criarMemoDeGrupos(asDb(db)).carregar();
    semearGrupo(db, 'g-tamanho', { nome: 'Tamanho', tipo: 1 });
    const segundo = await criarMemoDeGrupos(asDb(db)).carregar();

    expect(consultasDeGrupo(db)).toHaveLength(2);
    expect(segundo.docs.map((d) => d.id).sort()).toEqual(['g-cor', 'g-tamanho']);
  });

  it('carrega o documento CRU e o seu carimbo — o patch guardado precisa da leitura de onde veio', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();

    const [doc] = memo.docs;
    expect(doc?.raw.campoSoDoFlutter).toBe('não modelado aqui');
    expect(doc?.updateTime).toBeDefined();
  });
});

/* ------------------------------ 2. a criação ------------------------------ */

describe('aplicarTaxonomiaShopee — criar', () => {
  it('cria o grupo com `ordem: i + 1`, a posição do próprio tier', async () => {
    const db = new FakeDb();
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    const tiers = tiersDoItem({
      tiers: [
        { name: 'Cor', option_list: [{ option: 'Azul', image: null }] },
        { name: 'Tamanho', option_list: [{ option: 'M', image: null }] },
      ],
      padronizados: [],
    });

    await aplicarTaxonomiaShopee(asDb(db), {
      grupos: planejar(memo, tiers),
      memo,
      nowMs: AGORA,
      itemId: ITEM_ID,
    });

    expect(db.store['grupoDeVariacoes/n-cor']?.data.ordem).toBe(1);
    expect(db.store['grupoDeVariacoes/n-tamanho']?.data.ordem).toBe(2);
  });

  it('⛔ a `ordem` de um grupo EXISTENTE nunca é tocada — ela é do operador', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();

    await aplicarTaxonomiaShopee(asDb(db), {
      grupos: planejar(memo),
      memo,
      nowMs: AGORA,
      itemId: ITEM_ID,
    });

    expect(db.store['grupoDeVariacoes/g-cor']?.data.ordem).toBe(7);
    expect(Object.keys(db.patches[0]?.patch ?? {}).sort()).toEqual([
      'linksVariacoesShopee',
      'ultimaModificacao',
      'variacoes',
      'variacoesIds',
    ]);
  });

  it('uma corrida de CRIAÇÃO perdida (ALREADY_EXISTS) recusa em vez de sobrescrever', async () => {
    const db = new FakeDb();
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    const grupos = planejar(memo);
    // Outro gravador criou o mesmo grupo entre a leitura do memo e a escrita.
    db.seed('grupoDeVariacoes/n-cor', { nome: 'Cor', variacoes: [{ id: 'do-vencedor' }] });

    await expect(
      aplicarTaxonomiaShopee(asDb(db), { grupos, memo, nowMs: AGORA, itemId: ITEM_ID }),
    ).rejects.toThrow(ShopeeImportBlockedError);
    expect(db.store['grupoDeVariacoes/n-cor']?.data.variacoes).toEqual([{ id: 'do-vencedor' }]);
  });

  it('uma falha de criação que NÃO é ALREADY_EXISTS propaga', async () => {
    const db = new FakeDb();
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    db.falhasDeCriacao.set(
      'grupoDeVariacoes/n-cor',
      Object.assign(new Error('UNAVAILABLE'), { code: 14 }),
    );

    await expect(
      aplicarTaxonomiaShopee(asDb(db), {
        grupos: planejar(memo),
        memo,
        nowMs: AGORA,
        itemId: ITEM_ID,
      }),
    ).rejects.toThrow('UNAVAILABLE');
  });
});

/* --------------------------- 3. a escrita guardada ------------------------ */

describe('aplicarTaxonomiaShopee — a escrita guardada (tier 1)', () => {
  it('o patch nomeia QUATRO chaves — tudo o que o Flutter escreve sobrevive', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();

    await aplicarTaxonomiaShopee(asDb(db), {
      grupos: planejar(memo),
      memo,
      nowMs: AGORA,
      itemId: ITEM_ID,
    });

    const doc = db.store['grupoDeVariacoes/g-cor']?.data ?? {};
    expect(doc.campoSoDoFlutter).toBe('não modelado aqui');
    expect(doc.ultimaModificacao).toBe(AGORA);
    expect((doc.variacoes as unknown[]).map((v) => (v as { id: string }).id)).toEqual([
      'v-azul',
      'n-verde',
    ]);
  });

  it('⛔ uma escrita concorrente entre o memo e o patch vira `taxonomia-em-conflito`', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    const grupos = planejar(memo);

    // O vencedor: escreve DEPOIS da leitura do memo, o que bumpa o carimbo.
    db.seed('grupoDeVariacoes/g-cor', {
      nome: 'Cor',
      variacoes: [
        { id: 'v-azul', nome: 'Azul' },
        { id: 'do-vencedor', nome: 'Vermelho' },
      ],
      variacoesIds: ['v-azul', 'do-vencedor'],
      campoSoDoFlutter: 'não modelado aqui',
    });

    await expect(
      aplicarTaxonomiaShopee(asDb(db), { grupos, memo, nowMs: AGORA, itemId: ITEM_ID }),
    ).rejects.toMatchObject({ motivo: 'taxonomia-em-conflito', itemId: ITEM_ID });
  });

  it('⛔ a perda NÃO reaplica o patch — os valores do vencedor continuam de pé', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    const grupos = planejar(memo);

    db.seed('grupoDeVariacoes/g-cor', {
      nome: 'Cor',
      variacoes: [{ id: 'do-vencedor', nome: 'Vermelho' }],
      variacoesIds: ['do-vencedor'],
    });

    await expect(
      aplicarTaxonomiaShopee(asDb(db), { grupos, memo, nowMs: AGORA, itemId: ITEM_ID }),
    ).rejects.toThrow(ShopeeImportBlockedError);

    expect(db.store['grupoDeVariacoes/g-cor']?.data.variacoes).toEqual([
      { id: 'do-vencedor', nome: 'Vermelho' },
    ]);
    expect(db.patches).toEqual([]);
  });

  it('a recusa acontece ANTES de qualquer escrita de PRODUTO — nada fica pela metade', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    const grupos = planejar(memo);
    db.seed('grupoDeVariacoes/g-cor', { nome: 'Cor', variacoes: [], variacoesIds: [] });

    await expect(
      aplicarTaxonomiaShopee(asDb(db), { grupos, memo, nowMs: AGORA, itemId: ITEM_ID }),
    ).rejects.toThrow(ShopeeImportBlockedError);

    expect(db.writes.filter((w) => w.path.startsWith('produtos/'))).toEqual([]);
  });

  it('uma falha de update que NÃO é FAILED_PRECONDITION propaga', async () => {
    const db = new FakeDb();
    semearGrupo(db, 'g-cor');
    const memo = await criarMemoDeGrupos(asDb(db)).carregar();
    db.falhasDeUpdate.set(
      'grupoDeVariacoes/g-cor',
      Object.assign(new Error('UNAVAILABLE'), { code: 14 }),
    );

    await expect(
      aplicarTaxonomiaShopee(asDb(db), {
        grupos: planejar(memo),
        memo,
        nowMs: AGORA,
        itemId: ITEM_ID,
      }),
    ).rejects.toThrow('UNAVAILABLE');
  });

  it('uma reimportação byte-idêntica não escreve NADA — `mudou: false` não vira patch', async () => {
    const db = new FakeDb();
    const primeiroMemo = await criarMemoDeGrupos(asDb(db)).carregar();
    await aplicarTaxonomiaShopee(asDb(db), {
      grupos: planejar(primeiroMemo),
      memo: primeiroMemo,
      nowMs: AGORA,
      itemId: ITEM_ID,
    });
    const escritasDaPrimeira = db.writes.length;

    const segundoMemo = await criarMemoDeGrupos(asDb(db)).carregar();
    await aplicarTaxonomiaShopee(asDb(db), {
      grupos: planejar(segundoMemo),
      memo: segundoMemo,
      nowMs: AGORA,
      itemId: ITEM_ID,
    });

    expect(db.writes).toHaveLength(escritasDaPrimeira);
  });

  it('sem grupo planejado não escreve nada', async () => {
    const db = new FakeDb();
    await aplicarTaxonomiaShopee(asDb(db), {
      grupos: [],
      memo: { docs: [] },
      nowMs: AGORA,
      itemId: ITEM_ID,
    });
    expect(db.writes).toEqual([]);
  });
});
