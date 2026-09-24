import { describe, expect, it } from 'vitest';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { lerFamiliasDePrecoPorIds } from './descobertaPreco';
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

/**
 * The shared double plus the TWO Admin-SDK read shapes this module uses and
 * the double does not model — `Query.select(...)` (a real projection: unlisted
 * fields vanish) and `Firestore.getAll(...refs, { fieldMask })`. Extended HERE,
 * never in `testing/fakeDb.ts`: every other suite that drives that file is
 * untouched, and both logs below are this suite's own.
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

  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const buscar = consulta.get;
    const projecoes = this.projecoes;
    const falhaEm = this.falhaEm;
    let campos: string[] | null = null;
    return Object.assign(consulta, {
      select: (...lista: string[]) => {
        campos = lista;
        projecoes.push({ fonte: colPath, campos: lista });
        return consulta;
      },
      get: async () => {
        if (falhaEm.has(colPath)) throw grpc(14, 'UNAVAILABLE');
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
