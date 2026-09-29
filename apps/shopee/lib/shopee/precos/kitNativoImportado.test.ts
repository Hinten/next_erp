/**
 * IDA E VOLTA — o `kitNativo` que o IMPORT (passo 9) grava no `prodshopee` é o
 * que o plano de PREÇO (passo 13) lê, pela descoberta real.
 *
 * Os dois lados já têm testes próprios: o import prova que carimba o campo, o
 * plano prova que `kitNativo: true` pula com `kit-derivado`. Nenhum dos dois
 * prova a EMENDA — que o campo que um escreve chega ao outro depois da projeção
 * da descoberta. Foi exatamente essa emenda que faltou: o schema e o plano
 * mestre descreviam um carimbo que o import nunca escrevia, e cada lado passava
 * sozinho.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  shopeeCategoriaSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeKitItemSchema,
  type ShopeeCategoria,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { importacaoShopeeOptionsSchema } from '@delfrance/schemas';

import { criarMemoDeCategorias } from '../produtos/categoriaShopee';
import { importarAnuncioShopee } from '../produtos/importarAnuncio';
import type { ImportarAnuncioDeps, ItemLido } from '../produtos/itemLido';
import { importarKitShopee } from '../produtos/kitShopee';
import { idDoPaiPlanejado } from '../produtos/resolveProduto';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { lerFamiliasDePrecoPorIds } from './descobertaPreco';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import { montarItensDePreco } from './planoPreco';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const COMPONENTE = 2500139862;
const MODEL_A = 2000458802;
const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const AGORA = 1_757_000_000_000;
const PAI_ID = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

/** Só `get_category` responde: o import não chama a Shopee. */
function cliente(): ShopeeClient {
  return new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (prop === 'getCategory') return () => Promise.resolve({ category_list: [...ARVORE] });
      return () => {
        throw new Error(`o import chamou a Shopee: ${String(prop)}`);
      };
    },
  }) as unknown as ShopeeClient;
}

beforeEach(() => {
  limparTaxonomiaShopee();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

function deps(db: FakeDb): ImportarAnuncioDeps {
  return {
    db: asDb(db),
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: 'documents/depositos/dep-1',
    options: importacaoShopeeOptionsSchema.parse({ importarFotos: false }),
    nowMs: AGORA,
    categorias: criarMemoDeCategorias(cliente(), INTEGRACAO),
  };
}

/** Um kit nativo de UM model, com o componente já vinculado no ERP. */
function entradaDeKit(): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({ item_id: ITEM_ID, tag: { kit: true } }),
    models: null,
    taxInfo: null,
    kit: shopeeKitItemSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Kit Camiseta + Boné',
      item_sku: 'KIT-001',
      category_id: 100017,
      model_list: [
        {
          model_id: MODEL_A,
          model_sku: 'KIT-001-A',
          original_price: 99.9,
          component_list: [{ component_item_id: COMPONENTE, component_model_id: 0, quantity: 1 }],
        },
      ],
    }),
    itemId: ITEM_ID,
  };
}

/** Um anúncio COMUM, sem modelos, com preço em BRL. */
function entradaComum(): ItemLido {
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_sku: 'CAM-001',
    category_id: 100017,
    tag: { kit: false },
    price_info: [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }],
  });
  return { base, models: null, taxInfo: null, kit: null, itemId: ITEM_ID };
}

function semearComponente(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Componente', sku: 'comp-a', paiId: null });
  db.seed(`produtos/comp-a/prodshopee/vinc-${String(COMPONENTE)}`, {
    item_id: COMPONENTE,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/**
 * O double compartilhado mais os dois verbos que a descoberta usa e ele não
 * tem — `select` e `getAll` com `fieldMask` —, e os dois APLICAM a projeção.
 * Sem isso um campo que a descoberta deixa de projetar chegaria ao plano mesmo
 * assim, e a ida e volta provaria menos do que diz.
 */
class FakeDbComProjecao extends FakeDb {
  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const buscar = consulta.get;
    let campos: readonly string[] | null = null;
    return Object.assign(consulta, {
      select: (...lista: string[]) => {
        campos = lista;
        return consulta;
      },
      get: async () => {
        const resposta = await buscar();
        return {
          docs: resposta.docs.map((doc) => ({
            ...doc,
            data: () => projetar(doc.data(), campos),
          })),
        };
      },
    });
  }

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const mascara =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] }).fieldMask
        : null;
    const refs = (mascara === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => (snap.exists ? projetar(snap.data(), mascara) : undefined),
        };
      }),
    );
  }
}

function projetar(dados: DocData | undefined, campos: readonly string[] | null): DocData {
  if (dados === undefined) return {};
  if (campos === null) return dados;
  const saida: DocData = {};
  for (const campo of campos) if (Object.hasOwn(dados, campo)) saida[campo] = dados[campo];
  return saida;
}

async function planoDoPai(db: FakeDb) {
  const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [PAI_ID] })).get(PAI_ID);
  expect(familia).toBeDefined();
  return montarItensDePreco(familia!, INTEGRACAO);
}

/* ---------------------------------- os testes ----------------------------- */

describe('ida e volta — o `kitNativo` do import chega ao plano de preço', () => {
  it('um kit NATIVO importado pula com `kit-derivado` e não planeja item nenhum', async () => {
    const db = new FakeDbComProjecao();
    semearComponente(db);

    await importarKitShopee(deps(db), entradaDeKit());
    const plano = await planoDoPai(db);

    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toEqual([
      expect.objectContaining({
        produtoId: PAI_ID,
        itemId: ITEM_ID,
        motivo: MOTIVO_PRECO_SHOPEE.kitDerivado,
      }),
    ]);
  });

  it('⛔ PAR: um anúncio COMUM importado planeja o item — nenhum `kit-derivado`', async () => {
    const db = new FakeDbComProjecao();

    await importarAnuncioShopee(deps(db), entradaComum());
    const plano = await planoDoPai(db);

    expect(plano.pulos.map((p) => p.motivo)).not.toContain(MOTIVO_PRECO_SHOPEE.kitDerivado);
    expect(plano.itens).toHaveLength(1);
    expect(plano.itens[0]).toMatchObject({ itemId: ITEM_ID });
  });

  it('um RE-IMPORT do kit continua pulando — o merge não perde o carimbo', async () => {
    const db = new FakeDbComProjecao();
    semearComponente(db);

    await importarKitShopee(deps(db), entradaDeKit());
    await importarKitShopee(deps(db), entradaDeKit());
    const plano = await planoDoPai(db);

    expect(plano.itens).toEqual([]);
    expect(plano.pulos.map((p) => p.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.kitDerivado]);
  });
});
