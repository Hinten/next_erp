import { describe, expect, it } from 'vitest';
import { buildItemPayload } from '@delfrance/integrations-mercado-livre';
import {
  MercadoLivrePublishError,
  type PublishGrupoVariacao,
  type PublishProduto,
  assemblePublishInput,
  buildParentAttributes,
  combinationsFromVariacoes,
  mergeStoredCombinations,
  publishModeIssues,
  resolveCondition,
  resolveListingModel,
  resolvePrice,
} from './publishCore';

const produto: PublishProduto = {
  id: 'prod-1',
  nome: 'Camiseta Básica',
  sku: 'SKU-1',
  ehUsado: false,
  pesoLiquidoKg: 0.3,
  pesoBrutoKg: 0.4,
  alturaCm: 5,
  larguraCm: 30,
  profundidadeCm: 40,
  precos: { 'lista-1': { valor: 79.9 } },
};

const grupos: PublishGrupoVariacao[] = [
  {
    grupoId: 'g-tam',
    nome: 'Tamanho',
    tipo: 1,
    variacoes: [
      { id: 'v-m', nome: 'M' },
      { id: 'v-g', nome: 'G' },
    ],
  },
  { grupoId: 'g-cor', nome: 'Cor', tipo: 2, variacoes: [{ id: 'v-preto', nome: 'Preto' }] },
  { grupoId: 'g-out', nome: 'Estampa Especial', tipo: null, variacoes: [{ id: 'v-x', nome: 'X' }] },
];

describe('resolveListingModel', () => {
  // ⚠️ Every case makes the two inputs DISAGREE, so a test can only pass by
  // reading the one the precedence rule names.
  it('a PUBLISHED listing follows its persisted flag, never the account tag', () => {
    const published = { docId: 'link-1', id: 'MLB123' };
    expect(resolveListingModel({ ...published, isUserProductModel: true }, false)).toBe(
      'user-products',
    );
    expect(resolveListingModel({ ...published, isUserProductModel: false }, true)).toBe('legacy');
  });

  it('a listing that was NEVER published follows the account tag', () => {
    // The draft link doc apps/web creates carries `isUserProductModel: false`,
    // so reading it here — what publish did before #798 — resolves every first
    // publish on a tagged account to 'legacy' and ML answers 400.
    const draft = { docId: 'link-1', id: null, isUserProductModel: false };
    expect(resolveListingModel(draft, true)).toBe('user-products');
    expect(resolveListingModel(draft, false)).toBe('legacy');
  });

  it('no link doc at all still follows the account tag', () => {
    expect(resolveListingModel(null, true)).toBe('user-products');
    expect(resolveListingModel(null, false)).toBe('legacy');
  });
});

describe('publishModeIssues', () => {
  // A published LEGACY listing: an item id, no children. The baseline every
  // case below deviates from in exactly one dimension.
  const base = {
    estado: 'p' as string | null,
    model: 'legacy' as const,
    linkId: 'MLB111' as string | null,
    childrenCount: 0,
  };

  it("estado 'am' (mid-UPtin) blocks the publish", () => {
    expect(publishModeIssues({ ...base, estado: 'am' })).toEqual([
      expect.stringContaining('migração para o modelo User Products'),
    ]);
  });

  it('every OTHER estado publishes normally', () => {
    // Including null (a first publish) — the block must not fire on a listing
    // that has no state yet.
    for (const estado of [null, 'r', 'a', 'ep', 'v', 'p', 'pa', 'c', 'E']) {
      expect(publishModeIssues({ ...base, estado })).toEqual([]);
    }
  });

  it('a User-Products family that lost every variation is blocked', () => {
    // `linkId` is a FAMILY id and there are no children, so the fan-out does not
    // engage and the publish would fall through to `PUT /items/{familyId}` — the
    // one call this model forbids. Reachable from the normal flow: publish a
    // family, delete every variation, republish.
    const issues = publishModeIssues({
      ...base,
      model: 'user-products',
      linkId: '4260899048783356',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('família User Products');
  });

  it('a User-Products produto that NEVER had variations still publishes', () => {
    // ⚠️ The case the guard must not claim. It is also `isUserProductModel` with
    // zero children — the only difference is that its `linkId` is a real item
    // id, which is why the guard tests the id's SHAPE and not the child count.
    expect(publishModeIssues({ ...base, model: 'user-products', linkId: 'MLB2631229629' })).toEqual(
      [],
    );
  });

  it('the same family id is fine while the variations still exist', () => {
    // With children the fan-out engages and never touches `link.id`.
    expect(
      publishModeIssues({
        ...base,
        model: 'user-products',
        linkId: '4260899048783356',
        childrenCount: 2,
      }),
    ).toEqual([]);
  });

  it('a legacy listing is never judged by its id shape, and a first publish never is', () => {
    // The guard is scoped to User Products: only that model ever stores a family
    // id here, so a numeric legacy id (however unlikely) is not ours to reject.
    expect(publishModeIssues({ ...base, linkId: '123456' })).toEqual([]);
    // Nothing published yet ⇒ no id to misread.
    expect(publishModeIssues({ ...base, model: 'user-products', linkId: null })).toEqual([]);
  });
});

describe('resolvePrice', () => {
  it('reads the tabela-normal price', () => {
    const issues: string[] = [];
    expect(resolvePrice(produto, { id: 'lista-1', nome: 'Tabela Padrão' }, issues)).toBe(79.9);
    expect(issues).toEqual([]);
  });

  it('flags a missing price list (no id at all) — no fallback', () => {
    const issues: string[] = [];
    expect(resolvePrice(produto, { id: null, nome: null }, issues)).toBeNull();
    expect(issues).toEqual(['integração sem tabela de preços (tabelaNormalOuterRef)']);
  });

  it('names the tabela by BOTH nome and id when the nome is known', () => {
    const issues: string[] = [];
    expect(resolvePrice(produto, { id: 'lista-x', nome: 'Tabela Padrão' }, issues)).toBeNull();
    expect(issues).toEqual([
      'produto "Camiseta Básica" sem preço na tabela "Tabela Padrão" (lista-x)',
    ]);
  });

  it('falls back to the id alone when the nome could not be resolved — unchanged pre-fix message', () => {
    const issues: string[] = [];
    expect(resolvePrice(produto, { id: 'lista-x', nome: null }, issues)).toBeNull();
    expect(issues).toEqual(['produto "Camiseta Básica" sem preço na tabela lista-x']);
  });

  it('falls back to the id alone for a blank/whitespace nome — a soft-parsed legacy doc, not "unresolved"', () => {
    // listaDePrecosCache.ts's reader soft-parses on schema mismatch, so a
    // malformed doc can hand back "" or "   " despite the declared type.
    for (const blank of ['', '   ']) {
      const issues: string[] = [];
      expect(resolvePrice(produto, { id: 'lista-x', nome: blank }, issues)).toBeNull();
      expect(issues).toEqual(['produto "Camiseta Básica" sem preço na tabela lista-x']);
    }
  });

  it('falls back to the id alone for a non-string nome — the soft-parse escape hatch defeats the declared type', () => {
    const issues: string[] = [];
    // @ts-expect-error — exercising exactly what parseSoftRead can hand back
    // at runtime despite `nome`'s declared `string | null` type.
    expect(resolvePrice(produto, { id: 'lista-x', nome: 42 }, issues)).toBeNull();
    expect(issues).toEqual(['produto "Camiseta Básica" sem preço na tabela lista-x']);
  });
});

describe('resolveCondition', () => {
  // ⚠️ Every case here makes the produto and the link DISAGREE. The previous
  // version of this suite asserted "persisted link condition wins over
  // everything" with a fixture where both said `used`, so it passed under either
  // precedence and pinned nothing — which is how the produto branch stayed dead
  // for as long as it did.
  it('the PRODUTO decides, even when the link says otherwise', () => {
    // The bug: `produtoMercadoLivreLinkSchema` defaults `condition` to 'new', so
    // every link doc has a truthy value. With the link tested first, a produto
    // marked "usado" published as NEW and nothing on screen said so.
    expect(
      resolveCondition(
        { docId: 'l', id: 'MLB1', condition: 'new' },
        { ...produto, ehUsado: true },
        1,
      ),
    ).toBe('used');
  });

  it('honours extraData.condicao when ehUsado is not set', () => {
    // 1 novo, 2 usado, 3 recondicionado — the field has three values and only
    // one of them is new. Dropping this branch would silently start publishing
    // recondicionado stock as new.
    expect(resolveCondition({ docId: 'l', id: 'MLB1', condition: 'new' }, produto, 2)).toBe('used');
    expect(resolveCondition({ docId: 'l', id: 'MLB1', condition: 'new' }, produto, 3)).toBe('used');
  });

  it('falls back to the link only when the produto says nothing', () => {
    // An imported listing writes `condition` (`importItem.ts`), so for a produto
    // whose own flags were never set it is the best answer available.
    expect(resolveCondition({ docId: 'l', id: 'MLB1', condition: 'used' }, produto, 1)).toBe(
      'used',
    );
    expect(resolveCondition({ docId: 'l', id: 'MLB1', condition: 'used' }, produto, null)).toBe(
      'used',
    );
  });

  it('defaults to new with no signal anywhere', () => {
    expect(resolveCondition(null, produto, 1)).toBe('new');
    expect(resolveCondition(null, produto, null)).toBe('new');
  });
});

describe('buildParentAttributes', () => {
  it('emits link customs + SELLER_SKU + WEIGHT + package dimensions', () => {
    const attrs = buildParentAttributes(produto, {
      docId: 'l',
      id: null,
      attributes: [{ id: 'BRAND', value_name: 'Acme' }],
    });
    expect(attrs.map((a) => a.id)).toEqual([
      'BRAND',
      'SELLER_SKU',
      'WEIGHT',
      'SELLER_PACKAGE_HEIGHT',
      'SELLER_PACKAGE_LENGTH',
      'SELLER_PACKAGE_WIDTH',
      'SELLER_PACKAGE_WEIGHT',
    ]);
    // gross weight (pesoBrutoKg) feeds the package weight, in grams
    expect(attrs.at(-1)).toEqual({ id: 'SELLER_PACKAGE_WEIGHT', value_name: '400 g' });
  });

  it('omits dimensions when any side is missing', () => {
    const attrs = buildParentAttributes({ ...produto, alturaCm: null }, null);
    expect(attrs.map((a) => a.id)).toEqual(['SELLER_SKU', 'WEIGHT']);
  });

  it('omits SELLER_SKU when the item has variations (#799 bug 3)', () => {
    // Each variation carries its own SELLER_SKU in `attributes`, so it is never
    // a combination id and the mapper's combination prune cannot reach the
    // parent's. The legacy removes it by id (models.dart:1508-1515).
    const attrs = buildParentAttributes({ ...produto, alturaCm: null }, null, null, {
      includeSku: false,
    });
    expect(attrs.map((a) => a.id)).toEqual(['WEIGHT']);
  });
});

describe('combinationsFromVariacoes', () => {
  it('maps tamanho→SIZE, cor→COLOR, and an ERP-only grupo to a CUSTOM characteristic', () => {
    const issues: string[] = [];
    const combos = combinationsFromVariacoes(
      [
        'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
        'documents/grupoDeVariacoes/g-cor/variacoes/v-preto',
        'documents/grupoDeVariacoes/g-out/variacoes/v-x',
      ],
      grupos,
      'Filho',
      issues,
    );
    // #797 E8: `g-out` is a Firestore auto-id, so its group is NOT in ML's
    // taxonomy. ML's shape for that is `name` + `value_name` and NO id — the
    // old port sent `{ id: 'ESTAMPA_ESPECIAL' }`, an id that exists nowhere.
    expect(combos).toEqual([
      { id: 'SIZE', value_name: 'M' },
      { id: 'COLOR', value_name: 'Preto' },
      { name: 'Estampa Especial', value_name: 'X' },
    ]);
    expect(issues).toEqual([]);
  });

  it('uses an ML-derived grupo id verbatim, with the variante value_id (#797 E8)', () => {
    // The taxonomy importer names the grupo doc after the ML attribute
    // (`taxonomiaCore.ts:251`) and the variante after its value_id (`:284`).
    const mlGrupos: PublishGrupoVariacao[] = [
      {
        grupoId: 'FLAVOR',
        nome: 'Sabor',
        tipo: 0,
        variacoes: [{ id: '2450279', nome: 'Baunilha', mlValueId: '2450279' }],
      },
    ];
    const issues: string[] = [];
    expect(
      combinationsFromVariacoes(
        ['documents/grupoDeVariacoes/FLAVOR/variacoes/2450279'],
        mlGrupos,
        'Filho',
        issues,
      ),
    ).toEqual([{ id: 'FLAVOR', value_id: '2450279', value_name: 'Baunilha' }]);
    expect(issues).toEqual([]);
  });

  it('omits value_id when ML never minted one (the link holds a NAME, not an id)', () => {
    // `externalVariacaoLinks[].externalId` is `value_id ?? value_name`, so the
    // IO layer passes null unless it equals the variante id. Sending a name as
    // `value_id` would fabricate a taxonomy reference.
    const mlGrupos: PublishGrupoVariacao[] = [
      {
        grupoId: 'FLAVOR',
        nome: 'Sabor',
        tipo: 0,
        variacoes: [{ id: 'n-baunilha', nome: 'Baunilha', mlValueId: null }],
      },
    ];
    expect(
      combinationsFromVariacoes(
        ['documents/grupoDeVariacoes/FLAVOR/variacoes/n-baunilha'],
        mlGrupos,
        'Filho',
        [],
      ),
    ).toEqual([{ id: 'FLAVOR', value_name: 'Baunilha' }]);
  });

  it('reports unknown paths/variants as issues instead of dropping them', () => {
    const issues: string[] = [];
    combinationsFromVariacoes(
      ['nonsense', 'documents/grupoDeVariacoes/g-tam/variacoes/v-missing'],
      grupos,
      'Filho',
      issues,
    );
    expect(issues).toHaveLength(2);
  });
});

describe('mergeStoredCombinations', () => {
  it('recovers a stored combination no grupo can rebuild (#797 E8)', () => {
    // VOLTAGE was configured in Flutter; the ERP has no grupo for it, so the
    // grupo walk alone would DROP it on the first republish.
    expect(
      mergeStoredCombinations(
        [{ id: 'COLOR', value_name: 'Preto' }],
        [{ id: 'VOLTAGE', value_name: '220V' }],
      ),
    ).toEqual([
      { id: 'COLOR', value_name: 'Preto' },
      { id: 'VOLTAGE', value_name: '220V' },
    ]);
  });

  it('the grupo wins a collision — a duplicated combination id is an ML rejection', () => {
    expect(
      mergeStoredCombinations(
        [{ id: 'COLOR', value_name: 'Preto' }],
        [{ id: 'COLOR', value_name: 'Azul (stale)' }],
      ),
    ).toEqual([{ id: 'COLOR', value_name: 'Preto' }]);
  });

  it('keys an id-less entry by name, and drops a valueless one', () => {
    expect(
      mergeStoredCombinations(
        [{ name: 'Sabor', value_name: 'Baunilha' }],
        [{ name: 'Sabor', value_name: 'Menta' }, { id: 'VOLTAGE' }],
      ),
    ).toEqual([{ name: 'Sabor', value_name: 'Baunilha' }]);
  });

  it('is a no-op without stored entries', () => {
    const derived = [{ id: 'SIZE', value_name: 'M' }];
    expect(mergeStoredCombinations(derived, undefined)).toBe(derived);
    expect(mergeStoredCombinations(derived, [])).toBe(derived);
  });
});

describe('assemblePublishInput', () => {
  const baseArgs = {
    produto,
    condicao: 1,
    priceListId: 'lista-1',
    priceListNome: null,
    availableQuantity: 10,
    pictures: [{ id: 'IMG1' }],
    variations: [],
    grupos,
    link: null,
    linkDocId: 'link-doc-1',
    categoryId: 'MLB31447',
    listingTypeId: 'gold_special',
    isUserProductSeller: false,
  };

  it('a PUBLISHED User-Products family still requires category and listing type', () => {
    // `isUpdate` says the FAMILY exists — it says nothing about its members, and
    // a family that gains a variation POSTs that member as a brand-new item.
    // Letting the ordinary create-only rule stand would send that POST with no
    // category and earn a 400 the operator cannot read.
    const upFamily = {
      ...baseArgs,
      isUserProductSeller: true,
      categoryId: null,
      listingTypeId: null,
      // `id` here is the FAMILY id, which is what makes this an update.
      link: { docId: 'link-doc-1', id: '4260899048783356', isUserProductModel: true },
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
    };
    expect(() => assemblePublishInput(upFamily)).toThrowError(/category_id/);

    // The same listing WITHOUT children is one plain item — an update there
    // genuinely needs neither, so the rule must not widen to every UP listing.
    expect(() => assemblePublishInput({ ...upFamily, variations: [] })).not.toThrow();
    // ...and neither does a published LEGACY listing with children: ML takes
    // its variations inside the one PUT, so no member is ever created alone.
    expect(() => assemblePublishInput({ ...upFamily, isUserProductSeller: false })).not.toThrow();
  });

  it('assembles a create input with variations end-to-end', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M', ordem: 1 },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
    });
    expect(input.isUpdate).toBe(false);
    expect(input.title).toBe('Camiseta Básica');
    expect(input.sellerCustomField).toBe('link-doc-1');
    expect(input.price).toBe(79.9);
    // The price is passed through here — buildItemPayload decides whether it
    // reaches the wire (create-only, and never alongside variations).
    // #799 bug 3: with variations the parent must NOT carry SELLER_SKU; each
    // variation has its own below.
    expect(input.attributes!.map((a) => a.id)).toEqual([
      'WEIGHT',
      'SELLER_PACKAGE_HEIGHT',
      'SELLER_PACKAGE_LENGTH',
      'SELLER_PACKAGE_WIDTH',
      'SELLER_PACKAGE_WEIGHT',
    ]);
    expect(input.variations).toHaveLength(1);
    expect(input.variations![0]).toMatchObject({
      produtoId: 'child-1',
      order: 1,
      availableQuantity: 4,
      attributeCombinations: [{ id: 'SIZE', value_name: 'M' }],
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-1-M' }],
    });
  });

  it('merges the stored combinations of the child link doc (#797 E8)', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: 991,
          storedCombinations: [{ id: 'VOLTAGE', value_name: '220V' }],
        },
      ],
    });
    expect(input.variations![0]!.attributeCombinations).toEqual([
      { id: 'SIZE', value_name: 'M' },
      { id: 'VOLTAGE', value_name: '220V' },
    ]);
  });

  it('passes the conta shipping mode through, and normalises absent to null', () => {
    expect(assemblePublishInput({ ...baseArgs, shippingMode: 'me2' }).shippingMode).toBe('me2');
    // Absent must reach the builder as an explicit null rather than undefined:
    // both suppress the node today, but null is the value the conta actually
    // stores, and it keeps this boundary honest about "nothing configured".
    expect(assemblePublishInput(baseArgs).shippingMode).toBeNull();
    expect(assemblePublishInput({ ...baseArgs, shippingMode: null }).shippingMode).toBeNull();
  });

  it('does NOT validate the shipping mode against the seller', () => {
    // Whether a mode is available is an account/category fact only ML holds, and
    // it already answers with a readable `shipping.me2_adoption_mandatory` cause.
    // A local guess would be a second, staler copy of that answer — so this must
    // assemble cleanly and let the publish carry it.
    expect(() => assemblePublishInput({ ...baseArgs, shippingMode: 'me1' })).not.toThrow();
  });

  it('only merges a stored attribute EVERY child can supply (review #1064)', () => {
    // child-2 was added in the ERP after the listing was published, so it has no
    // variation link and no stored VOLTAGE. Merging per-child would send
    // [SIZE, VOLTAGE] for one sibling and [SIZE] for the other — ML requires the
    // same attributes on every variation and rejects the whole item.
    const input = assemblePublishInput({
      ...baseArgs,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: 991,
          storedCombinations: [{ id: 'VOLTAGE', value_name: '220V' }],
        },
        {
          produto: { ...produto, id: 'child-2', nome: 'Camiseta G' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-g'],
          availableQuantity: 2,
          mlVariationId: null,
        },
      ],
    });
    expect(input.variations!.map((v) => v.attributeCombinations)).toEqual([
      [{ id: 'SIZE', value_name: 'M' }],
      [{ id: 'SIZE', value_name: 'G' }],
    ]);
  });

  it('merges a stored attribute when ALL children carry it', () => {
    const withVoltage = (id: string, nome: string, uid: string, valor: string) => ({
      produto: { ...produto, id, nome },
      variacoesUid: [uid],
      availableQuantity: 4,
      mlVariationId: 1,
      storedCombinations: [{ id: 'VOLTAGE', value_name: valor }],
    });
    const input = assemblePublishInput({
      ...baseArgs,
      variations: [
        withVoltage('child-1', 'M', 'documents/grupoDeVariacoes/g-tam/variacoes/v-m', '220V'),
        withVoltage('child-2', 'G', 'documents/grupoDeVariacoes/g-tam/variacoes/v-g', '110V'),
      ],
    });
    expect(input.variations!.map((v) => v.attributeCombinations)).toEqual([
      [
        { id: 'SIZE', value_name: 'M' },
        { id: 'VOLTAGE', value_name: '220V' },
      ],
      [
        { id: 'SIZE', value_name: 'G' },
        { id: 'VOLTAGE', value_name: '110V' },
      ],
    ]);
  });

  it('blocks siblings whose grupos give them DIFFERENT combination sets', () => {
    // Pre-existing hazard the per-child checks could never see: one child is in
    // two grupos, its sibling in one. ML rejects the item, not the variation.
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        variations: [
          {
            produto: { ...produto, id: 'child-1', nome: 'Camiseta M Preta' },
            variacoesUid: [
              'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
              'documents/grupoDeVariacoes/g-cor/variacoes/v-preto',
            ],
            availableQuantity: 4,
            mlVariationId: null,
          },
          {
            produto: { ...produto, id: 'child-2', nome: 'Camiseta G' },
            variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-g'],
            availableQuantity: 2,
            mlVariationId: null,
          },
        ],
      }),
    ).toThrow(/não combinam os MESMOS atributos/);
  });

  it('blocks TWO children each varying by a DIFFERENT single custom characteristic', () => {
    // One custom apiece passes any per-child count, but the ITEM varies by two.
    const doisCustoms: PublishGrupoVariacao[] = [
      { grupoId: 'g-a', nome: 'Sabor', tipo: 0, variacoes: [{ id: 'v-a', nome: 'Menta' }] },
      { grupoId: 'g-b', nome: 'Estampa', tipo: 0, variacoes: [{ id: 'v-b', nome: 'Onça' }] },
    ];
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        grupos: doisCustoms,
        variations: [
          {
            produto: { ...produto, id: 'child-1', nome: 'Menta' },
            variacoesUid: ['documents/grupoDeVariacoes/g-a/variacoes/v-a'],
            availableQuantity: 4,
            mlVariationId: null,
          },
          {
            produto: { ...produto, id: 'child-2', nome: 'Onça' },
            variacoesUid: ['documents/grupoDeVariacoes/g-b/variacoes/v-b'],
            availableQuantity: 4,
            mlVariationId: null,
          },
        ],
      }),
    ).toThrow(/apenas UMA característica personalizada/);
  });

  it('blocks a child varying by TWO custom characteristics — ML allows one', () => {
    const doisCustoms: PublishGrupoVariacao[] = [
      { grupoId: 'g-a', nome: 'Sabor', tipo: 0, variacoes: [{ id: 'v-a', nome: 'Menta' }] },
      { grupoId: 'g-b', nome: 'Estampa', tipo: 0, variacoes: [{ id: 'v-b', nome: 'Onça' }] },
    ];
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        grupos: doisCustoms,
        variations: [
          {
            produto: { ...produto, id: 'child-1', nome: 'Camiseta X' },
            variacoesUid: [
              'documents/grupoDeVariacoes/g-a/variacoes/v-a',
              'documents/grupoDeVariacoes/g-b/variacoes/v-b',
            ],
            availableQuantity: 4,
            mlVariationId: null,
          },
        ],
      }),
    ).toThrow(/apenas UMA característica personalizada/);
  });

  it('keeps the parent SELLER_SKU for a User-Products seller even with children', () => {
    // buildItemPayload drops the variations array entirely for a UP seller, so
    // no per-variation SKU is ever emitted. Suppressing the parent's on child
    // count alone would ship a payload with NO SKU anywhere.
    const input = assemblePublishInput({
      ...baseArgs,
      isUserProductSeller: true,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M', ordem: 1 },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
    });
    expect(input.attributes!.map((a) => a.id)).toContain('SELLER_SKU');

    const data = buildItemPayload(input);
    expect(data.variations).toBeUndefined();
    expect((data.attributes as Array<{ id: string }>).map((a) => a.id)).toContain('SELLER_SKU');
  });

  it('binds the size chart: SIZE_GRID_ID on the parent, SIZE_GRID_ROW_ID + SIZE replacement per variation', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      // A stale binding on the link doc must be REPLACED by the fresh chart.
      link: {
        docId: 'link-doc-1',
        id: null,
        attributes: [
          { id: 'SIZE_GRID_ID', value_name: 'STALE' },
          { id: 'BRAND', value_name: 'Acme' },
        ],
      },
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
          availableQuantity: 4,
          mlVariationId: null,
        },
        {
          produto: { ...produto, id: 'child-2', nome: 'Camiseta G', sku: 'SKU-1-G' },
          variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-g'],
          availableQuantity: 2,
          mlVariationId: null,
        },
      ],
      sizeChart: {
        chartId: '1594439',
        rowByChildId: {
          'child-1': { rowId: '1594439:1', size: { id: 'SIZE', value_name: 'M (38-40)' } },
          // child-2 unmatched — keeps its own variante nome, no ROW_ID.
        },
      },
    });

    const parentIds = input.attributes!.map((a) => a.id);
    expect(parentIds.filter((id) => id === 'SIZE_GRID_ID')).toHaveLength(1);
    expect(input.attributes!.find((a) => a.id === 'SIZE_GRID_ID')).toEqual({
      id: 'SIZE_GRID_ID',
      value_name: '1594439',
    });
    expect(input.attributes!.find((a) => a.id === 'BRAND')).toBeDefined();

    // Matched child: ROW_ID in attributes, chart SIZE replaces the combo.
    expect(input.variations![0]!.attributes).toContainEqual({
      id: 'SIZE_GRID_ROW_ID',
      value_name: '1594439:1',
    });
    expect(input.variations![0]!.attributeCombinations).toEqual([
      { id: 'SIZE', value_name: 'M (38-40)' },
    ]);
    // Unmatched child: untouched.
    expect(input.variations![1]!.attributes).toEqual([{ id: 'SELLER_SKU', value_name: 'SKU-1-G' }]);
    expect(input.variations![1]!.attributeCombinations).toEqual([{ id: 'SIZE', value_name: 'G' }]);
  });

  it('chart SIZE replacement drops EVERY SIZE combo (two tamanho groups → one SIZE)', () => {
    const doisTamanhos: PublishGrupoVariacao[] = [
      ...grupos,
      { grupoId: 'g-tam2', nome: 'Tamanho BR', tipo: 1, variacoes: [{ id: 'v-40', nome: '40' }] },
    ];
    const input = assemblePublishInput({
      ...baseArgs,
      grupos: doisTamanhos,
      variations: [
        {
          produto: { ...produto, id: 'child-1', nome: 'Camiseta M', sku: 'SKU-1-M' },
          variacoesUid: [
            'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
            'documents/grupoDeVariacoes/g-tam2/variacoes/v-40',
          ],
          availableQuantity: 4,
          mlVariationId: null,
        },
      ],
      sizeChart: {
        chartId: '1594439',
        rowByChildId: {
          'child-1': { rowId: '1594439:1', size: { id: 'SIZE', value_name: 'M (38-40)' } },
        },
      },
    });
    const sizes = input.variations![0]!.attributeCombinations.filter((c) => c.id === 'SIZE');
    expect(sizes).toEqual([{ id: 'SIZE', value_name: 'M (38-40)' }]);
  });

  it('no size chart → link attributes untouched (a persisted SIZE_GRID_ID survives)', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      link: {
        docId: 'link-doc-1',
        id: null,
        attributes: [{ id: 'SIZE_GRID_ID', value_name: 'KEEP-ME' }],
      },
    });
    expect(input.attributes!.find((a) => a.id === 'SIZE_GRID_ID')).toEqual({
      id: 'SIZE_GRID_ID',
      value_name: 'KEEP-ME',
    });
  });

  it('update mode (link has an ML id) does not require category/listing type', () => {
    const input = assemblePublishInput({
      ...baseArgs,
      categoryId: null,
      listingTypeId: null,
      link: { docId: 'link-doc-1', id: 'MLB999', condition: 'new' },
    });
    expect(input.isUpdate).toBe(true);
  });

  it('aggregates EVERY blocking issue into one error', () => {
    const bad = () =>
      assemblePublishInput({
        ...baseArgs,
        produto: { ...produto, nome: '  ', precos: null },
        pictures: [],
        categoryId: null,
        listingTypeId: null,
      });
    expect(bad).toThrowError(MercadoLivrePublishError);
    try {
      bad();
    } catch (err) {
      if (!(err instanceof MercadoLivrePublishError)) throw err;
      // nome + preço + categoria + listing type + fotos
      expect(err.issues).toHaveLength(5);
    }
  });

  it('a variation with no resolvable combination blocks the publish', () => {
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        variations: [
          {
            produto: { ...produto, id: 'child-2', nome: 'Filho' },
            variacoesUid: [],
            availableQuantity: 1,
            mlVariationId: null,
          },
        ],
      }),
    ).toThrowError(/sem atributos de combinação/);
  });
});
