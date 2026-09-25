import { FieldPath } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { ShopeeConfigError } from '@delfrance/integrations-shopee';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  lerFamiliasDePrecoPorIds,
  lerPaginaDeFamiliasDePreco,
  lerPrecosDosProdutos,
} from './descobertaPreco';
import { montarItensDePreco, precificarItem, precosDaFamilia } from './planoPreco';

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const ANCORA = 'prod-ancora';
const ANCORA_2 = 'prod-ancora-2';
const FILHO = 'prod-filho';
const LINK_A = 'link-a';
const ITEM_A = 2500139861;
const MODELO = 2000458802;
const TABELA = 'tab-normal';

function precos(valor: number): DocData {
  return { [TABELA]: { valor } };
}

/** Copy the listed keys that are present — what a real projection answers. */
function projetarFake(dados: DocData | undefined, campos: readonly string[] | null): DocData {
  if (dados === undefined) return {};
  if (campos === null) return dados;
  const saida: DocData = {};
  for (const campo of campos) if (Object.hasOwn(dados, campo)) saida[campo] = dados[campo];
  return saida;
}

/** `orderBy(FieldPath.documentId())`, recognised the way the SDK spells it. */
function ehOrdemPorId(campo: unknown): boolean {
  return campo instanceof FieldPath && campo.isEqual(FieldPath.documentId());
}

/** The two operators the keyset page sends; any other one THROWS (the shared double's rule). */
function atende(valorArmazenado: unknown, op: string, valor: unknown): boolean {
  if (op === '==') return valorArmazenado === valor;
  if (op === 'array-contains')
    return Array.isArray(valorArmazenado) && valorArmazenado.includes(valor);
  throw new Error(`FakeDbDePreco: operador não ensinado na consulta por chave: '${op}'`);
}

/**
 * The shared double plus the Admin-SDK read shapes this module uses and the
 * double does not model — `Query.select(...)` (a real projection: unlisted
 * fields vanish), `Firestore.getAll(...refs, { fieldMask })`, and (the paged
 * reader) the KEYSET query: `where(…, 'array-contains', …)`,
 * `orderBy(FieldPath.documentId())` and a `startAfter(<id string>)` VALUE
 * cursor. Extended HERE, never in `testing/fakeDb.ts`: every other suite that
 * drives that file is untouched, and the logs below are this suite's own.
 *
 * ⚠️ The keyset path is ADDITIVE: a query that uses none of those three shapes
 * runs through the shared double exactly as before, so every by-ids assertion
 * above it reads the same chain it always did. A query that uses any of them is
 * answered HERE — the shared double throws on `array-contains` and positions a
 * cursor by snapshot — with the server's order: filter, sort by id, drop every
 * id `<=` the cursor VALUE, then cap. It is logged into the shared
 * `consultasCompletas` in the same row shape, the order spelled `__name__`.
 */
class FakeDbDePreco extends FakeDb {
  /** Every `select(...)`, by collection path. */
  readonly projecoes: { fonte: string; campos: string[] }[] = [];
  /** Every `getAll`, with the document paths and the field mask. */
  readonly leiturasEmLote: { caminhos: string[]; campos: string[] | null }[] = [];
  /** Collection paths whose read REJECTS — an injected outage. */
  readonly falhaEm = new Set<string>();
  /** Answer `getAll` in REVERSE order — the SDK promises no positional contract to lean on. */
  inverterLote = false;
  /** Collection paths whose read settles this many microtasks LATE — a join that finishes out of order. */
  readonly atrasoEm = new Map<string, number>();

  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const buscar = consulta.get;
    const onde = consulta.where;
    const ordenarPor = consulta.orderBy;
    const aposDoc = consulta.startAfter;
    const limitar = consulta.limit;
    const projecoes = this.projecoes;
    const falhaEm = this.falhaEm;
    const atraso = this.atrasoEm.get(colPath) ?? 0;
    const store = this.store;
    const consultasCompletas = this.consultasCompletas;
    let campos: string[] | null = null;
    // The keyset state — used only when the query takes one of the three shapes.
    const clausulas: [string, string, unknown][] = [];
    let porId = false;
    let ordensPorCampo = 0;
    let aposId: string | null = null;
    let limite: number | null = null;
    let porChave = false;

    const lerPorChave = () => {
      if (!porId || ordensPorCampo > 0) {
        throw new Error('FakeDbDePreco: consulta por chave sem `orderBy(documentId())` único');
      }
      consultasCompletas.push({
        fonte: colPath,
        clausulas: [...clausulas],
        ordens: [['__name__', 'asc']],
        limite,
        apos: aposId,
      });
      const prefixo = `${colPath}/`;
      const linhas = Object.entries(store)
        .filter(([path]) => path.startsWith(prefixo) && !path.slice(prefixo.length).includes('/'))
        .map(([path, stored]) => ({ id: path.slice(prefixo.length), dados: stored.data }))
        .filter(({ dados }) => clausulas.every(([c, op, v]) => atende(dados[c], op, v)))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter(({ id }) => aposId === null || id > aposId);
      const pagina = limite === null ? linhas : linhas.slice(0, limite);
      return {
        docs: pagina.map(({ id, dados }) => ({ id, data: () => projetarFake(dados, campos) })),
      };
    };

    return Object.assign(consulta, {
      where: (campo: string, op: string, valor: unknown) => {
        clausulas.push([campo, op, valor]);
        if (op === 'array-contains') porChave = true;
        else onde(campo, op, valor);
        return consulta;
      },
      orderBy: (campo: unknown, direcao: 'asc' | 'desc' = 'asc') => {
        if (ehOrdemPorId(campo)) {
          porId = true;
          porChave = true;
        } else {
          ordensPorCampo += 1;
          ordenarPor(campo as string, direcao);
        }
        return consulta;
      },
      startAfter: (cursor: unknown) => {
        if (typeof cursor === 'string') {
          aposId = cursor;
          porChave = true;
        } else {
          aposDoc(cursor as { id: string });
        }
        return consulta;
      },
      limit: (n: number) => {
        limite = n;
        limitar(n);
        return consulta;
      },
      select: (...lista: string[]) => {
        campos = lista;
        projecoes.push({ fonte: colPath, campos: lista });
        return consulta;
      },
      get: async () => {
        for (let tique = 0; tique < atraso; tique += 1) await Promise.resolve();
        if (falhaEm.has(colPath)) throw grpc(14, 'UNAVAILABLE');
        if (porChave) return lerPorChave();
        const resposta = await buscar();
        return {
          docs: resposta.docs.map((doc) => ({
            ...doc,
            data: () => projetarFake(doc.data(), campos),
          })),
        };
      },
    });
  }

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      path: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    this.leiturasEmLote.push({
      caminhos: refs.map((r) => r.path),
      campos: opcoes?.fieldMask ?? null,
    });
    const ordem = this.inverterLote ? [...refs].reverse() : refs;
    return Promise.all(
      ordem.map(async (ref) => {
        const snap = await ref.get();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () =>
            snap.exists ? projetarFake(snap.data(), opcoes?.fieldMask ?? null) : undefined,
        };
      }),
    );
  }
}

/** One anchor with one listing of this conta and one child carrying one model of it. */
function semear(db: FakeDbDePreco, anchorId = ANCORA, preco = 10): void {
  db.seed(`produtos/${anchorId}`, {
    nome: 'Âncora de teste',
    paiId: null,
    precos: precos(preco),
    descricao: 'um corpo grande que a máscara não deixa passar',
  });
  db.seed(`produtos/${anchorId}/prodshopee/${LINK_A}`, {
    contaProdutoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    item_id: ITEM_A,
    item_status: 'NORMAL',
    kitNativo: false,
    description: 'o corpo inteiro do anúncio',
    estoqueEnviadoEm: 1_700_000_000_000,
    category_id: 100_001,
  });
  db.seed(`produtos/${FILHO}`, { nome: 'Filho', paiId: anchorId, precos: precos(12) });
  db.seed(`produtos/${FILHO}/variashopee/var-1`, {
    contaVariacaoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    produtoShopeeOuterRef: `produtos/${anchorId}/prodshopee/${LINK_A}`,
    model_id: MODELO,
    model_status: 'MODEL_NORMAL',
    tier_index: [0],
    estoqueEnviadoEm: 1_700_000_000_000,
  });
  // A produto that is NOT a child of the anchor — must not be joined.
  db.seed('produtos/prod-estranho', {
    nome: 'Outro',
    paiId: 'prod-outra-ancora',
    precos: precos(99),
  });
}

/* -------------------------------------------------------------------------- */
/*                                  THE READ                                   */
/* -------------------------------------------------------------------------- */

describe('lerFamiliasDePrecoPorIds — a família lida', () => {
  it('projeta a família inteira: vínculos com `linkDocId`, filhos com `precos`, modelos com `varLinkDocId` — e NADA além das listas', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const familias = await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] });

    expect([...familias.keys()]).toEqual([ANCORA]);
    expect(familias.get(ANCORA)).toEqual({
      anchorId: ANCORA,
      precos: precos(10),
      links: [
        {
          contaProdutoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
          item_id: ITEM_A,
          item_status: 'NORMAL',
          kitNativo: false,
          linkDocId: LINK_A,
        },
      ],
      children: [
        {
          produtoId: FILHO,
          precos: precos(12),
          varLinks: [
            {
              contaVariacaoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
              produtoShopeeOuterRef: `produtos/${ANCORA}/prodshopee/${LINK_A}`,
              model_id: MODELO,
              model_status: 'MODEL_NORMAL',
              tier_index: [0],
              varLinkDocId: 'var-1',
            },
          ],
        },
      ],
    });
  });

  it('um campo AUSENTE no documento continua ausente na projeção (nunca uma chave `undefined`)', async () => {
    const db = new FakeDbDePreco();
    semear(db);
    db.seed(`produtos/${ANCORA}/prodshopee/${LINK_A}`, {
      contaProdutoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
      item_id: ITEM_A,
    });

    const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] })).get(ANCORA);

    expect(Object.keys(familia?.links[0] ?? {}).sort()).toEqual([
      'contaProdutoShopeeOuterRef',
      'item_id',
      'linkDocId',
    ]);
  });

  it('a âncora NÃO filtra conta: vínculos de TODAS as contas voltam e o planejador escolhe', async () => {
    const db = new FakeDbDePreco();
    semear(db);
    db.seed(`produtos/${ANCORA}/prodshopee/link-outra-conta`, {
      contaProdutoShopeeOuterRef: 'integracoes/int-12',
      item_id: ITEM_A + 1,
    });

    const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] })).get(ANCORA);

    expect(familia?.links.map((l) => l.linkDocId)).toEqual([LINK_A, 'link-outra-conta']);
    const plano = montarItensDePreco(familia!, INTEGRACAO);
    expect(plano.itens.map((i) => i.linkDocId)).toEqual([LINK_A]);
    expect(plano.pulos).toEqual([]);
  });

  it('da leitura ao preço: o modelo leva o preço do FILHO (12), nunca o da âncora (10)', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] })).get(
      ANCORA,
    )!;
    const [planejado] = montarItensDePreco(familia, INTEGRACAO).itens;
    const item = precificarItem(planejado!, precosDaFamilia(familia), TABELA);

    expect(item.alvos).toEqual([
      { modelId: MODELO, produtoId: FILHO, varLinkDocId: 'var-1', precoAlvo: 12 },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         THE QUERY SHAPES (the ledger)                       */
/* -------------------------------------------------------------------------- */

describe('lerFamiliasDePrecoPorIds — as consultas que chegam ao servidor', () => {
  it('UMA leitura em lote das âncoras mascarada a `precos`, e por âncora: vínculos SEM where, filhos por `paiId ==`, modelos SEM where', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] });

    expect(db.leiturasEmLote).toEqual([{ caminhos: [`produtos/${ANCORA}`], campos: ['precos'] }]);
    const porFonte = [...db.consultasCompletas].sort((a, b) => (a.fonte < b.fonte ? -1 : 1));
    expect(porFonte).toEqual([
      {
        fonte: 'produtos',
        clausulas: [['paiId', '==', ANCORA]],
        ordens: [],
        limite: null,
        apos: null,
      },
      {
        fonte: `produtos/${ANCORA}/prodshopee`,
        clausulas: [],
        ordens: [],
        limite: null,
        apos: null,
      },
      {
        fonte: `produtos/${FILHO}/variashopee`,
        clausulas: [],
        ordens: [],
        limite: null,
        apos: null,
      },
    ]);
  });

  it('cada consulta é PROJETADA: os filhos a `precos`, os vínculos às listas que o planejador lê', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] });

    const porFonte = new Map(db.projecoes.map((p) => [p.fonte, p.campos]));
    expect(porFonte.get('produtos')).toEqual(['precos']);
    expect(porFonte.get(`produtos/${ANCORA}/prodshopee`)).toEqual([
      'contaProdutoShopeeOuterRef',
      'item_id',
      'item_status',
      'estadoAnuncio',
      'kitNativo',
    ]);
    // ⚠️ `produtoShopeeOuterRef` is the load-bearing one: it binds a model to its LISTING.
    expect(porFonte.get(`produtos/${FILHO}/variashopee`)).toEqual([
      'contaVariacaoShopeeOuterRef',
      'produtoShopeeOuterRef',
      'model_id',
      'tier_index',
      'model_status',
      'modeloAusenteEm',
    ]);
  });

  it('PAR — uma lista vazia responde um mapa vazio com ZERO leituras (o lote de nada é recusado pelo SDK)', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const familias = await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [] });

    expect(familias.size).toBe(0);
    expect(db.leiturasEmLote).toEqual([]);
    expect(db.consultasCompletas).toEqual([]);
  });

  it('QUASE-IGUAL — ids repetidos colapsam: UMA leitura em lote com o id UMA vez, e UMA junção', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA, ANCORA, ANCORA] });

    expect(db.leiturasEmLote).toEqual([{ caminhos: [`produtos/${ANCORA}`], campos: ['precos'] }]);
    expect(db.consultasCompletas.filter((c) => c.fonte.endsWith('/prodshopee'))).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                      absent anchors, order, identity, failure               */
/* -------------------------------------------------------------------------- */

describe('lerFamiliasDePrecoPorIds — ausência, ordem, identidade e falha', () => {
  it('⚠️ uma âncora INEXISTENTE fica FORA do mapa (nunca uma família vazia, que leria `sem-link`) e não dispara junção', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const familias = await lerFamiliasDePrecoPorIds(asDb(db), {
      anchorIds: [ANCORA, 'prod-inexistente'],
    });

    expect([...familias.keys()]).toEqual([ANCORA]);
    expect(db.consultasCompletas.map((c) => c.fonte)).not.toContain(
      'produtos/prod-inexistente/prodshopee',
    );
    expect(
      db.consultasCompletas.some((c) =>
        c.clausulas.some(([, , valor]) => valor === 'prod-inexistente'),
      ),
    ).toBe(false);
  });

  it('⚠️ casa a âncora pelo ID do documento, nunca pela POSIÇÃO na resposta do lote', async () => {
    const db = new FakeDbDePreco();
    semear(db, ANCORA, 10);
    db.seed(`produtos/${ANCORA_2}`, { nome: 'Segunda', paiId: null, precos: precos(20) });
    db.inverterLote = true;

    const familias = await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA, ANCORA_2] });

    expect(familias.get(ANCORA)?.precos).toEqual(precos(10));
    expect(familias.get(ANCORA_2)?.precos).toEqual(precos(20));
  });

  it('o mapa segue a ordem do PEDIDO (deduplicado), não a do lote nem a das junções', async () => {
    const db = new FakeDbDePreco();
    semear(db, ANCORA, 10);
    db.seed(`produtos/${ANCORA_2}`, { nome: 'Segunda', paiId: null, precos: precos(20) });
    db.inverterLote = true;

    const familias = await lerFamiliasDePrecoPorIds(asDb(db), {
      anchorIds: [ANCORA_2, ANCORA, ANCORA_2],
    });

    expect([...familias.keys()]).toEqual([ANCORA_2, ANCORA]);
  });

  it('uma âncora sem vínculo nem filho volta como família VAZIA — e o planejador responde `sem-link`', async () => {
    const db = new FakeDbDePreco();
    db.seed(`produtos/${ANCORA_2}`, { nome: 'Sem anúncio', paiId: null, precos: precos(20) });

    const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA_2] })).get(
      ANCORA_2,
    );

    expect(familia).toEqual({ anchorId: ANCORA_2, precos: precos(20), links: [], children: [] });
    expect(montarItensDePreco(familia!, INTEGRACAO).pulos.map((p) => p.motivo)).toEqual([
      'sem-link',
    ]);
  });

  it('uma falha de leitura PROPAGA — nunca uma família que perdeu os vínculos em silêncio', async () => {
    const db = new FakeDbDePreco();
    semear(db);
    db.falhaEm.add(`produtos/${ANCORA}/prodshopee`);

    await expect(lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] })).rejects.toMatchObject(
      {
        code: 14,
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                 the send-time read — lerPrecosDosProdutos (C-d)             */
/* -------------------------------------------------------------------------- */

describe('lerPrecosDosProdutos — os `precos` de produtos NOMEADOS, lidos agora', () => {
  it('UMA leitura em lote mascarada a `precos`: o mapa CRU por id, e nada além de `precos`', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const lidos = await lerPrecosDosProdutos(asDb(db), [ANCORA, FILHO]);

    expect([...lidos]).toEqual([
      [ANCORA, precos(10)],
      [FILHO, precos(12)],
    ]);
    expect(db.leiturasEmLote).toEqual([
      { caminhos: [`produtos/${ANCORA}`, `produtos/${FILHO}`], campos: ['precos'] },
    ]);
    // No subcollection, no query: a key read and nothing else.
    expect(db.consultasCompletas).toEqual([]);
  });

  it('⚠️ PAR — um produto INEXISTENTE (apagado depois do plano) fica FORA do mapa, e nada lança', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const lidos = await lerPrecosDosProdutos(asDb(db), [ANCORA, 'prod-apagado']);

    expect(lidos.has('prod-apagado')).toBe(false);
    expect([...lidos.keys()]).toEqual([ANCORA]);
  });

  it('QUASE-IGUAL — um produto que EXISTE sem `precos` fica NO mapa com `undefined` (presença é existência)', async () => {
    const db = new FakeDbDePreco();
    db.seed(`produtos/${ANCORA_2}`, { nome: 'Sem preço', paiId: null });

    const lidos = await lerPrecosDosProdutos(asDb(db), [ANCORA_2]);

    expect(lidos.has(ANCORA_2)).toBe(true);
    expect(lidos.get(ANCORA_2)).toBeUndefined();
  });

  it('os dois precificam como "sem preço": `precificarItem` dá `null` ao apagado e ao sem `precos`', async () => {
    const db = new FakeDbDePreco();
    db.seed(`produtos/${ANCORA_2}`, { nome: 'Sem preço', paiId: null });
    const lidos = await lerPrecosDosProdutos(asDb(db), [ANCORA_2, 'prod-apagado']);
    const item = (produtoId: string) =>
      precificarItem({ produtoId, linkDocId: LINK_A, itemId: ITEM_A, modelos: [] }, lidos, TABELA);

    expect(item(ANCORA_2).alvos[0]?.precoAlvo).toBeNull();
    expect(item('prod-apagado').alvos[0]?.precoAlvo).toBeNull();
  });

  it('PAR — uma lista vazia responde um mapa vazio com ZERO leituras', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const lidos = await lerPrecosDosProdutos(asDb(db), []);

    expect(lidos.size).toBe(0);
    expect(db.leiturasEmLote).toEqual([]);
  });

  it('QUASE-IGUAL — ids repetidos colapsam: UMA leitura com o id UMA vez', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    await lerPrecosDosProdutos(asDb(db), [FILHO, FILHO, ANCORA, FILHO]);

    expect(db.leiturasEmLote).toEqual([
      { caminhos: [`produtos/${FILHO}`, `produtos/${ANCORA}`], campos: ['precos'] },
    ]);
  });

  it('⚠️ casa pelo ID do documento, nunca pela POSIÇÃO na resposta do lote', async () => {
    const db = new FakeDbDePreco();
    semear(db, ANCORA, 10);
    db.inverterLote = true;

    const lidos = await lerPrecosDosProdutos(asDb(db), [ANCORA, FILHO]);

    expect(lidos.get(ANCORA)).toEqual(precos(10));
    expect(lidos.get(FILHO)).toEqual(precos(12));
  });

  it('a leitura das ÂNCORAS de `lerFamiliasDePrecoPorIds` é ESTE leitor: a mesma máscara, o mesmo "ausente = inexistente"', async () => {
    const db = new FakeDbDePreco();
    semear(db);

    const familias = await lerFamiliasDePrecoPorIds(asDb(db), {
      anchorIds: [ANCORA, 'prod-inexistente'],
    });
    const lidos = await lerPrecosDosProdutos(asDb(db), [ANCORA, 'prod-inexistente']);

    expect(db.leiturasEmLote[0]).toEqual(db.leiturasEmLote[1]);
    expect([...familias.keys()]).toEqual([...lidos.keys()]);
    expect(familias.get(ANCORA)?.precos).toEqual(lidos.get(ANCORA));
  });
});

/* -------------------------------------------------------------------------- */
/*              the paged reader — lerPaginaDeFamiliasDePreco (PR 2)           */
/* -------------------------------------------------------------------------- */

const OUTRA_CONTA = 'int-12';

/**
 * A whole family of ONE anchor carrying `integracoesComProduto` — every id is
 * derived from the anchor's, so several families coexist in one database.
 */
function semearFamiliaDaConta(
  db: FakeDbDePreco,
  anchorId: string,
  opcoes: { readonly preco?: number; readonly contas?: readonly string[] | null } = {},
): void {
  const filho = `${anchorId}-filho`;
  const contas = opcoes.contas === undefined ? [INTEGRACAO] : opcoes.contas;
  db.seed(`produtos/${anchorId}`, {
    nome: `Âncora ${anchorId}`,
    paiId: null,
    precos: precos(opcoes.preco ?? 10),
    ...(contas === null ? {} : { integracoesComProduto: [...contas] }),
    descricao: 'um corpo grande que a máscara não deixa passar',
  });
  db.seed(`produtos/${anchorId}/prodshopee/${LINK_A}`, {
    contaProdutoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    item_id: ITEM_A,
    item_status: 'NORMAL',
    kitNativo: false,
    description: 'o corpo inteiro do anúncio',
  });
  db.seed(`produtos/${filho}`, { nome: 'Filho', paiId: anchorId, precos: precos(12) });
  db.seed(`produtos/${filho}/variashopee/var-1`, {
    contaVariacaoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    produtoShopeeOuterRef: `produtos/${anchorId}/prodshopee/${LINK_A}`,
    model_id: MODELO,
    model_status: 'MODEL_NORMAL',
    tier_index: [0],
  });
}

/** One page of the conta, `int-1`. */
function pagina(db: FakeDbDePreco, afterAnchorId: string | null, pageLimit: number) {
  return lerPaginaDeFamiliasDePreco(asDb(db), {
    integracaoId: INTEGRACAO,
    afterAnchorId,
    pageLimit,
  });
}

/** The keyset page queries — the only ones carrying the conta's `array-contains`. */
function consultasDePagina(db: FakeDbDePreco) {
  return db.consultasCompletas.filter((c) => c.clausulas.some(([, op]) => op === 'array-contains'));
}

describe('lerPaginaDeFamiliasDePreco — o passeio por páginas (o job)', () => {
  it('duas páginas e depois `null`: 3 âncoras, limite 2 ⇒ [a1, a2] → a2, depois [a3] → null — na ordem do ID, qualquer que seja a ordem de gravação', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a3', 'prod-a1', 'prod-a2']) semearFamiliaDaConta(db, id);

    const primeira = await pagina(db, null, 2);
    const segunda = await pagina(db, primeira.nextAfterAnchorId, 2);

    expect(primeira.familias.map((f) => f.anchorId)).toEqual(['prod-a1', 'prod-a2']);
    expect(primeira.nextAfterAnchorId).toBe('prod-a2');
    expect(segunda.familias.map((f) => f.anchorId)).toEqual(['prod-a3']);
    expect(segunda.nextAfterAnchorId).toBeNull();
  });

  it('QUASE-IGUAL — um total MÚLTIPLO exato do limite custa UMA página vazia a mais antes do `null`', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a1', 'prod-a2', 'prod-a3', 'prod-a4']) semearFamiliaDaConta(db, id);

    const primeira = await pagina(db, null, 2);
    const segunda = await pagina(db, primeira.nextAfterAnchorId, 2);
    const terceira = await pagina(db, segunda.nextAfterAnchorId, 2);

    expect(primeira.nextAfterAnchorId).toBe('prod-a2');
    expect(segunda.familias.map((f) => f.anchorId)).toEqual(['prod-a3', 'prod-a4']);
    expect(segunda.nextAfterAnchorId).toBe('prod-a4');
    expect(terceira).toEqual({ familias: [], nextAfterAnchorId: null });
  });

  it('uma conta sem âncora nenhuma: página vazia, `null`, e NENHUMA junção', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, 'prod-a1', { contas: [OUTRA_CONTA] });

    const resultado = await pagina(db, null, 25);

    expect(resultado).toEqual({ familias: [], nextAfterAnchorId: null });
    expect(db.consultasCompletas).toHaveLength(1);
    expect(consultasDePagina(db)).toHaveLength(1);
  });

  it('PAR / QUASE-IGUAL — o escopo: entram as âncoras que CONTÊM a conta; ficam fora o FILHO que carrega a conta, a âncora de OUTRA conta e a âncora sem o campo', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, 'prod-a1');
    semearFamiliaDaConta(db, 'prod-b-outra-conta', { contas: [OUTRA_CONTA] });
    semearFamiliaDaConta(db, 'prod-c-sem-campo', { contas: null });
    semearFamiliaDaConta(db, 'prod-e-duas-contas', { contas: [OUTRA_CONTA, INTEGRACAO] });
    // A CHILD that carries the conta: `paiId` is not null, so it is never an anchor.
    db.seed('produtos/prod-d-filho-com-conta', {
      nome: 'Filho com a conta',
      paiId: 'prod-a1',
      precos: precos(15),
      integracoesComProduto: [INTEGRACAO],
    });

    const { familias, nextAfterAnchorId } = await pagina(db, null, 25);

    expect(familias.map((f) => f.anchorId)).toEqual(['prod-a1', 'prod-e-duas-contas']);
    expect(nextAfterAnchorId).toBeNull();
  });

  it('⚠️ o cursor é um VALOR: uma âncora que SAIU da conta entre dois despachos não quebra o passeio', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a1', 'prod-a2', 'prod-a3']) semearFamiliaDaConta(db, id);

    const primeira = await pagina(db, null, 2);
    // Between the two dispatches the cursor's own anchor loses its listing on the conta.
    semearFamiliaDaConta(db, 'prod-a2', { contas: [] });
    const segunda = await pagina(db, primeira.nextAfterAnchorId, 2);

    expect(primeira.nextAfterAnchorId).toBe('prod-a2');
    expect(segunda.familias.map((f) => f.anchorId)).toEqual(['prod-a3']);
    expect(segunda.nextAfterAnchorId).toBeNull();
  });

  it('as famílias voltam na ordem de CHAVE da página, mesmo quando a junção da primeira termina por ÚLTIMO', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a1', 'prod-a2', 'prod-a3']) semearFamiliaDaConta(db, id);
    db.atrasoEm.set(`produtos/prod-a1/prodshopee`, 50);

    const { familias } = await pagina(db, null, 25);

    expect(familias.map((f) => f.anchorId)).toEqual(['prod-a1', 'prod-a2', 'prod-a3']);
    expect(familias[0]?.links.map((l) => l.linkDocId)).toEqual([LINK_A]);
  });
});

describe('lerPaginaDeFamiliasDePreco — a consulta que chega ao servidor', () => {
  it('UMA consulta clássica por página: `paiId == null` + `array-contains <conta>`, ordenada por `__name__`, com `limit` — e o cursor por VALOR na segunda', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a1', 'prod-a2', 'prod-a3']) semearFamiliaDaConta(db, id);

    const primeira = await pagina(db, null, 2);
    await pagina(db, primeira.nextAfterAnchorId, 2);

    const clausulas = [
      ['paiId', '==', null],
      ['integracoesComProduto', 'array-contains', INTEGRACAO],
    ];
    expect(consultasDePagina(db)).toEqual([
      { fonte: 'produtos', clausulas, ordens: [['__name__', 'asc']], limite: 2, apos: null },
      { fonte: 'produtos', clausulas, ordens: [['__name__', 'asc']], limite: 2, apos: 'prod-a2' },
    ]);
  });

  it('a página é PROJETADA a `precos` e é a ÚNICA leitura das âncoras: ZERO leitura em lote', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, ANCORA);

    const { familias } = await pagina(db, null, 25);

    // The page query is built — and projected — before any join.
    expect(db.projecoes[0]).toEqual({ fonte: 'produtos', campos: ['precos'] });
    expect(db.leiturasEmLote).toEqual([]);
    expect(familias[0]?.precos).toEqual(precos(10));
  });

  it('por âncora, a MESMA junção do leitor por ids: vínculos SEM where, filhos por `paiId ==`, modelos SEM where', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, ANCORA);

    await pagina(db, null, 25);

    const juncao = db.consultasCompletas
      .filter((c) => !c.clausulas.some(([, op]) => op === 'array-contains'))
      .sort((a, b) => (a.fonte < b.fonte ? -1 : 1));
    expect(juncao).toEqual([
      {
        fonte: 'produtos',
        clausulas: [['paiId', '==', ANCORA]],
        ordens: [],
        limite: null,
        apos: null,
      },
      // `-` sorts before `/`: the child's path precedes the anchor's own subcollection.
      {
        fonte: `produtos/${ANCORA}-filho/variashopee`,
        clausulas: [],
        ordens: [],
        limite: null,
        apos: null,
      },
      {
        fonte: `produtos/${ANCORA}/prodshopee`,
        clausulas: [],
        ordens: [],
        limite: null,
        apos: null,
      },
    ]);
  });
});

describe('uma junção, dois leitores — a página ≡ o leitor por ids', () => {
  it('PAR — a família de uma âncora é IDÊNTICA pelos dois leitores: `precos`, vínculos, filhos e modelos', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, ANCORA);

    const { familias } = await pagina(db, null, 25);
    const porIds = await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] });

    // Not a vacuous equality of two empty families.
    expect(familias[0]?.links).toHaveLength(1);
    expect(familias[0]?.children[0]?.varLinks).toHaveLength(1);
    expect(familias).toEqual([porIds.get(ANCORA)]);
    // And the same projection lists on both paths.
    const listas = (fonte: string) =>
      db.projecoes.filter((p) => p.fonte === fonte).map((p) => p.campos);
    const [doVinculoNaPagina, doVinculoPorIds] = listas(`produtos/${ANCORA}/prodshopee`);
    expect(doVinculoNaPagina).toContain('contaProdutoShopeeOuterRef');
    expect(doVinculoNaPagina).toEqual(doVinculoPorIds);
    const [doModeloNaPagina, doModeloPorIds] = listas(`produtos/${ANCORA}-filho/variashopee`);
    expect(doModeloNaPagina).toEqual(doModeloPorIds);
  });

  it('QUASE-IGUAL — a mesma junção, termos de âncora DIFERENTES: por ids a âncora de outra conta volta, na página não', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, ANCORA, { contas: [OUTRA_CONTA] });

    const { familias } = await pagina(db, null, 25);
    const porIds = await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [ANCORA] });

    expect(familias).toEqual([]);
    expect([...porIds.keys()]).toEqual([ANCORA]);
  });

  it('da página ao preço: o modelo leva o preço do FILHO (12), nunca o da âncora (10)', async () => {
    const db = new FakeDbDePreco();
    semearFamiliaDaConta(db, ANCORA);

    const [familia] = (await pagina(db, null, 25)).familias;
    const [planejado] = montarItensDePreco(familia!, INTEGRACAO).itens;
    const item = precificarItem(planejado!, precosDaFamilia(familia!), TABELA);

    expect(item.alvos).toEqual([
      { modelId: MODELO, produtoId: `${ANCORA}-filho`, varLinkDocId: 'var-1', precoAlvo: 12 },
    ]);
  });
});

describe('lerPaginaDeFamiliasDePreco — limite inválido e falha', () => {
  it.each([0, -1, 1.5, Number.NaN])(
    '⚠️ `pageLimit` %s lança `ShopeeConfigError` ANTES de qualquer leitura (um 0 terminaria o job sem enviar nada)',
    async (invalido) => {
      const db = new FakeDbDePreco();
      semearFamiliaDaConta(db, ANCORA);

      await expect(pagina(db, null, invalido)).rejects.toBeInstanceOf(ShopeeConfigError);
      expect(db.consultasCompletas).toEqual([]);
      expect(db.projecoes).toEqual([]);
    },
  );

  it('QUASE-IGUAL — `pageLimit` 1 é aceito: uma família, e o cursor nela', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a1', 'prod-a2']) semearFamiliaDaConta(db, id);

    const resultado = await pagina(db, null, 1);

    expect(resultado.familias.map((f) => f.anchorId)).toEqual(['prod-a1']);
    expect(resultado.nextAfterAnchorId).toBe('prod-a1');
  });

  it('uma falha da junção PROPAGA — nunca uma página com uma família que perdeu os vínculos em silêncio', async () => {
    const db = new FakeDbDePreco();
    for (const id of ['prod-a1', 'prod-a2']) semearFamiliaDaConta(db, id);
    db.falhaEm.add('produtos/prod-a2/prodshopee');

    await expect(pagina(db, null, 25)).rejects.toMatchObject({ code: 14 });
  });
});
