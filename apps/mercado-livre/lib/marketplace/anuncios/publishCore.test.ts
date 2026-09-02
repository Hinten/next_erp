import { describe, expect, it } from 'vitest';
import {
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  ML_PRODUTO_HERDADO_ATTRIBUTE_IDS,
  attrBrand,
  buildItemPayload,
} from '@delfrance/integrations-mercado-livre';
import { MARCA_ATTRIBUTE_ID } from '@delfrance/schemas';
import {
  MercadoLivrePublishError,
  type PublishGrupoVariacao,
  type PublishProduto,
  type TabelaBindingMotivo,
  assemblePublishInput,
  buildParentAttributes,
  combinationsFromVariacoes,
  linkAttributesAfterPublish,
  mergeStoredCombinations,
  publishModeIssues,
  resolveCondition,
  resolveListingModel,
  resolvePrice,
  resolveSkuPaiAtributo,
  sizeChartIssue,
  TABELA_BINDING_RECUSA,
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

  it('a legacy listing is never judged by its id shape', () => {
    // The guard is scoped to User Products: only that model ever stores a family
    // id here, so a numeric legacy id (however unlikely) is not ours to reject.
    expect(publishModeIssues({ ...base, linkId: '123456' })).toEqual([]);
    // ...and a legacy produto with no children is an ordinary simple listing.
    expect(publishModeIssues({ ...base, linkId: null })).toEqual([]);
  });

  // ⚠️ #1398. This case USED to publish: `classificarMembroUnico` answered
  // `'criar'` and publish minted the sole member itself — above every later
  // throw site, so a publish the operator saw FAIL had still reshaped the
  // produto and moved its stock, silently. It is now refused, and the message
  // names the repair rather than the diagnosis.
  it('a User-Products produto that was never published and has no member is refused', () => {
    const issues = publishModeIssues({ ...base, model: 'user-products', linkId: null });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('sem item vendável');
    expect(issues[0]).toContain('Variações');
  });

  // ⛔ The near-miss, and the one that must NOT become a refusal. Same model,
  // same zero children — but `link.id` is a real item id, so there is a live,
  // selling listing whose id has to reach the member link. Refusing here would
  // leave the operator creating a member BY HAND without that id, which makes
  // the fan-out POST a duplicate and the sweep close the original.
  it('a User-Products produto ALREADY published as a simple item still publishes', () => {
    expect(publishModeIssues({ ...base, model: 'user-products', linkId: 'MLB2631229629' })).toEqual(
      [],
    );
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

describe('resolveSkuPaiAtributo (#1400)', () => {
  /** A member ML does not have yet. */
  const novo = { itemId: null, skuPaiAtributo: false };
  /** A live member whose item does NOT carry the characteristic. */
  const vivoSem = { itemId: 'MLB222', skuPaiAtributo: false };
  /** A live member whose item DOES carry it. */
  const vivoCom = { itemId: 'MLB111', skuPaiAtributo: true };

  const base = {
    isUserProductSeller: true,
    linkId: null as string | null,
    membros: [] as Array<{ itemId: string | null; skuPaiAtributo: boolean }>,
    produtoSku: 'SKU-PAI',
  };

  it('sends on a brand-new família, with no configuration', () => {
    expect(resolveSkuPaiAtributo({ ...base, membros: [novo, novo] })).toEqual({
      skuPai: 'SKU-PAI',
    });
  });

  it('⛔ never adds it to a família ML already has — the listing-splitting case', () => {
    // The dangerous one. A published família whose members lack the attribute
    // must not gain it: a custom attribute's NAME is in ML's family hash, so a
    // member re-hashes and leaves the família.
    expect(resolveSkuPaiAtributo({ ...base, linkId: 'FAM1', membros: [novo] })).toEqual({
      skuPai: null,
    });
    // ⛔ And the case a `linkId`-only test would MISS: adding one more variation
    // to an existing família. `link.id` can be null on a família whose members
    // are live, so the member item ids are the load-bearing half of the test.
    expect(resolveSkuPaiAtributo({ ...base, linkId: null, membros: [novo, vivoSem] })).toEqual({
      skuPai: null,
    });
  });

  it('⛔ a PARTIALLY-published família finishes uniformly — the split-beyond-repair case', () => {
    // The fan-out is sequential and persists each member as ML confirms it, so a
    // run that created member 1 and then died on member 2 leaves member 1's item
    // carrying the characteristic and nothing on the parent link. Asking the
    // MEMBERS is what makes the retry send it to the rest; asking a parent flag
    // the failure path never wrote would create members 2 and 3 WITHOUT it,
    // beside a sibling that has it.
    expect(
      resolveSkuPaiAtributo({ ...base, linkId: null, membros: [vivoCom, novo, novo] }),
    ).toEqual({ skuPai: 'SKU-PAI' });
  });

  it('a SINGLE-product UP listing also gets it — deliberate, not incidental', () => {
    // ⚠️ `publish.ts` materialises the sole member before this runs, so a
    // childless UP produto arrives as ONE member with no itemId. The import
    // chain does not need the characteristic there (rung 3 reads the member's
    // own SELLER_SKU, since a família of one has no combos), so this is a
    // public characteristic bought for one narrow case: variations added on ML
    // instead of in the ERP, where rung 2 has no códigos to peel.
    //
    // Pinned so that switching to `membros.length > 1` — a legitimate choice
    // that is uniform in both directions — is a conscious edit rather than a
    // silent change to what buyers see.
    expect(resolveSkuPaiAtributo({ ...base, membros: [novo] })).toEqual({
      skuPai: 'SKU-PAI',
    });
  });

  it('keeps sending to a família that already carries it', () => {
    // Dropping the attribute would re-hash every member that has it.
    expect(resolveSkuPaiAtributo({ ...base, linkId: 'FAM1', membros: [vivoCom] })).toEqual({
      skuPai: 'SKU-PAI',
    });
  });

  it('one member carrying it is enough — the answer is an OR, never a majority', () => {
    expect(
      resolveSkuPaiAtributo({ ...base, linkId: 'FAM1', membros: [vivoSem, vivoSem, vivoCom] }),
    ).toEqual({ skuPai: 'SKU-PAI' });
  });

  it('a blank-ish produto sku sends nothing rather than an empty characteristic', () => {
    for (const produtoSku of [null, '', '   ']) {
      expect(resolveSkuPaiAtributo({ ...base, membros: [novo], produtoSku })).toEqual({
        skuPai: null,
      });
    }
    // …but a padded one is trimmed, not refused.
    expect(
      resolveSkuPaiAtributo({ ...base, membros: [novo], produtoSku: '  SKU-PAI  ' }).skuPai,
    ).toBe('SKU-PAI');
  });

  it('never applies to the legacy variations[] model, which has a real parent item', () => {
    expect(
      resolveSkuPaiAtributo({ ...base, isUserProductSeller: false, membros: [vivoCom] }),
    ).toEqual({ skuPai: null });
  });
});

describe('buildParentAttributes', () => {
  it('emits link customs + SELLER_SKU + WEIGHT + package dimensions', () => {
    const attrs = buildParentAttributes(
      produto,
      { docId: 'l', id: null, attributes: [{ id: 'BRAND', value_name: 'Acme' }] },
      null,
      { marca: null },
    );
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
    const attrs = buildParentAttributes({ ...produto, alturaCm: null }, null, null, {
      marca: null,
    });
    expect(attrs.map((a) => a.id)).toEqual(['SELLER_SKU', 'WEIGHT']);
  });

  // ⚠️ The stale-copy path. A link doc written before the editor withheld these
  // ids can still carry one, and `attributesForSave` cannot prune an id the
  // CATEGORY does not list — so a stored `WEIGHT` in such a category survives
  // every save. Appending the derived copy beside it ships the attribute TWICE,
  // once with the operator's old value. Publish owns these ids unconditionally.
  it('drops a stored copy of a derived id instead of duplicating it', () => {
    const attrs = buildParentAttributes(
      produto,
      {
        docId: 'l',
        id: null,
        attributes: [
          { id: 'BRAND', value_name: 'Acme' },
          { id: 'WEIGHT', value_name: '99 kg' },
          { id: 'SELLER_PACKAGE_HEIGHT', value_name: '99 cm' },
        ],
      },
      null,
      { marca: null },
    );
    expect(attrs.filter((a) => a.id === 'WEIGHT')).toHaveLength(1);
    expect(attrs.filter((a) => a.id === 'SELLER_PACKAGE_HEIGHT')).toHaveLength(1);
    // The produto's value wins, not the stale one.
    expect(attrs.find((a) => a.id === 'WEIGHT')?.value_name).not.toBe('99 kg');
    expect(attrs.find((a) => a.id === 'SELLER_PACKAGE_HEIGHT')?.value_name).not.toBe('99 cm');
    // A non-derived stored attribute is still preserved.
    expect(attrs.find((a) => a.id === 'BRAND')?.value_name).toBe('Acme');
  });

  // The stored copy goes even when the produto cannot replace it — a value the
  // ERP owns and could not derive is not a value to fall back on: it is the one
  // the operator is being told to fill in on the produto.
  it('drops a stored derived id even with nothing to replace it', () => {
    const attrs = buildParentAttributes(
      { ...produto, alturaCm: null },
      {
        docId: 'l',
        id: null,
        attributes: [{ id: 'SELLER_PACKAGE_HEIGHT', value_name: '99 cm' }],
      },
      null,
      { marca: null },
    );
    expect(attrs.map((a) => a.id)).toEqual(['SELLER_SKU', 'WEIGHT']);
  });

  it('omits SELLER_SKU when the item has variations (#799 bug 3)', () => {
    // Each variation carries its own SELLER_SKU in `attributes`, so it is never
    // a combination id and the mapper's combination prune cannot reach the
    // parent's. The legacy removes it by id (models.dart:1508-1515).
    const attrs = buildParentAttributes({ ...produto, alturaCm: null }, null, null, {
      includeSku: false,
      marca: null,
    });
    expect(attrs.map((a) => a.id)).toEqual(['WEIGHT']);
  });

  // ---- BRAND: herdado, not derived -------------------------------------
  // The produto decides when it has a Marca; otherwise the listing's own stored
  // brand stands. Both halves matter and they fail in opposite directions.

  it("replaces a stored BRAND with the produto's Marca", () => {
    const attrs = buildParentAttributes(
      produto,
      {
        docId: 'l',
        id: null,
        attributes: [{ id: 'BRAND', value_id: '9999', value_name: 'Acme' }],
      },
      null,
      { marca: 'Hering' },
    );
    expect(attrs.filter((a) => a.id === 'BRAND')).toEqual([{ id: 'BRAND', value_name: 'Hering' }]);
    expect(attrs.map((a) => a.id)).toEqual([
      'BRAND',
      'SELLER_SKU',
      'WEIGHT',
      'SELLER_PACKAGE_HEIGHT',
      'SELLER_PACKAGE_LENGTH',
      'SELLER_PACKAGE_WIDTH',
      'SELLER_PACKAGE_WEIGHT',
    ]);
  });

  // ⚠️ THE regression this whole design exists to prevent. Treating BRAND like a
  // derived id would drop this entry and publish nothing in its place — for
  // every produto whose Marca is still empty, which today is most of them. The
  // `value_id` assertion is the second half: an enumerated ML brand carries one,
  // and rebuilding the entry through `attrBrand` would silently discard it.
  it('keeps a stored BRAND verbatim, value_id and all, when the produto has no Marca', () => {
    const armazenada = { id: 'BRAND', value_id: '9999', value_name: 'Acme' };
    const attrs = buildParentAttributes(
      produto,
      { docId: 'l', id: null, attributes: [armazenada] },
      null,
      { marca: null },
    );
    expect(attrs.filter((a) => a.id === 'BRAND')).toEqual([armazenada]);
  });

  it('reads a whitespace-only Marca as absent rather than blanking the stored brand', () => {
    const attrs = buildParentAttributes(
      produto,
      { docId: 'l', id: null, attributes: [{ id: 'BRAND', value_name: 'Acme' }] },
      null,
      { marca: '   ' },
    );
    expect(attrs.find((a) => a.id === 'BRAND')?.value_name).toBe('Acme');
  });

  it('trims the produto Marca on the way to the wire', () => {
    const attrs = buildParentAttributes(produto, null, null, { marca: '  Hering  ' });
    expect(attrs.find((a) => a.id === 'BRAND')?.value_name).toBe('Hering');
  });

  // ⚠️ The case the IMPORT backfill created (#1087). Since the importer began
  // filling `extraData.marca` from the listing's own BRAND, the common produto is
  // one whose Marca was COPIED from the entry already on the link — so rebuilding
  // it through `attrBrand` would strip the `value_id` ML had already matched, on
  // every listing the import touched, and hand ML back a bare name to resolve
  // again. Same answer, strictly poorer copy.
  it('keeps the stored value_id when the produto Marca says the same thing', () => {
    const armazenada = { id: 'BRAND', value_id: '9999', value_name: 'Acme' };
    const attrs = buildParentAttributes(
      produto,
      { docId: 'l', id: null, attributes: [armazenada] },
      null,
      { marca: 'Acme' },
    );
    expect(attrs.filter((a) => a.id === 'BRAND')).toEqual([armazenada]);
  });

  // The remove-then-add pair has to stay symmetric: skipping the add while still
  // running the remove would publish NO brand at all.
  it('emits exactly one BRAND when the stored value matches', () => {
    const attrs = buildParentAttributes(
      produto,
      { docId: 'l', id: null, attributes: [{ id: 'BRAND', value_id: '9999', value_name: 'Acme' }] },
      null,
      { marca: '  Acme  ' },
    );
    expect(attrs.filter((a) => a.id === 'BRAND')).toHaveLength(1);
  });

  // ⚠️ Only an EXACT match may skip the rebuild. A differing Marca means the
  // operator retyped it and must win — a case-insensitive test here would keep
  // publishing the stale brand.
  it('still rebuilds when the Marca differs only in case', () => {
    const attrs = buildParentAttributes(
      produto,
      { docId: 'l', id: null, attributes: [{ id: 'BRAND', value_id: '9999', value_name: 'Acme' }] },
      null,
      { marca: 'ACME' },
    );
    expect(attrs.filter((a) => a.id === 'BRAND')).toEqual([{ id: 'BRAND', value_name: 'ACME' }]);
  });

  it('emits no BRAND at all when neither the produto nor the listing has one', () => {
    const attrs = buildParentAttributes(produto, null, null, { marca: null });
    expect(attrs.some((a) => a.id === 'BRAND')).toBe(false);
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
    marca: null,
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

  it('a domain mismatch in a guia category BLOCKS the assembly, naming both domains', () => {
    // The wiring: `sizeChartIssue`'s verdict has to reach the aggregate throw,
    // or the pure function is correct and nothing acts on it.
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        sizeChartMotivo: {
          codigo: 'dominio-divergente',
          categoryId: 'MLB1398',
          nome: 'Camiseta lisa infantil',
          dominiosDaTabela: ['MLB-SHIRTS'],
          dominioDaCategoria: 'MLB-T_SHIRTS',
        },
        categoriaUsaGuia: true,
      }),
    ).toThrow(/MLB-SHIRTS.*MLB-T_SHIRTS/);
  });

  it('the same mismatch in a category with NO guia assembles fine', () => {
    // ⚠️ The control: without it, a refusal that fired unconditionally would
    // still satisfy the test above.
    expect(() =>
      assemblePublishInput({
        ...baseArgs,
        sizeChartMotivo: {
          codigo: 'dominio-divergente',
          categoryId: 'MLB1398',
          nome: 'Camiseta lisa infantil',
          dominiosDaTabela: ['MLB-SHIRTS'],
          dominioDaCategoria: 'MLB-T_SHIRTS',
        },
        categoriaUsaGuia: false,
      }),
    ).not.toThrow();
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

describe('linkAttributesAfterPublish', () => {
  const enviado = [
    { id: 'MODEL', value_name: 'X' },
    { id: 'BRAND', value_name: 'Hering' },
    { id: 'SELLER_SKU', value_name: 'SKU-1' },
    { id: 'WEIGHT', value_name: '0.9 kg' },
  ];

  it('stores what was sent, minus the derived ids (#799 bug 7)', () => {
    expect(linkAttributesAfterPublish(enviado, null).map((a) => a.id)).toEqual(['MODEL']);
  });

  // ⚠️ THE latching bug. Publish derives BRAND from the produto's Marca; storing
  // that value makes the Marca its own fallback, so clearing Marca on the
  // produto could never again clear the listing's brand — `resolveMarcaAnuncio`
  // would just read back the value publish itself wrote, and the screen would
  // caption it "Valor guardado neste anúncio" while telling the operator to fill
  // the very field they had just emptied.
  it('never persists the BRAND it derived from the produto', () => {
    const out = linkAttributesAfterPublish(enviado, null);
    expect(out.some((a) => a.id === 'BRAND')).toBe(false);
  });

  // ⚠️ The opposite direction, and the one that loses data. This entry is the
  // FALLBACK publish reads when the produto has no Marca — for a produto whose
  // Marca is empty it is the only copy in existence — so a publish that USED it
  // must not delete it on the way out.
  it('carries a stored BRAND back verbatim, value_id and all', () => {
    const armazenado = { id: 'BRAND', value_id: '9999', value_name: 'Acme' };
    const out = linkAttributesAfterPublish(enviado, [armazenado]);
    expect(out.filter((a) => a.id === 'BRAND')).toEqual([armazenado]);
  });

  it('keeps the stored one rather than the derived one when both exist', () => {
    const armazenado = { id: 'BRAND', value_id: '9999', value_name: 'Acme' };
    const out = linkAttributesAfterPublish(enviado, [armazenado]);
    expect(out.filter((a) => a.id === 'BRAND')).toHaveLength(1);
    expect(out.find((a) => a.id === 'BRAND')?.value_name).toBe('Acme');
  });

  // A stale derived id sitting on the doc is NOT carried back — only herdado
  // ids are, and this is the asymmetry the two sets exist to express.
  it('does not resurrect a stored derived id', () => {
    const out = linkAttributesAfterPublish(enviado, [{ id: 'WEIGHT', value_name: '99 kg' }]);
    expect(out.some((a) => a.id === 'WEIGHT')).toBe(false);
  });

  it('drops an id-less attribute, which the link wire schema forbids', () => {
    const out = linkAttributesAfterPublish([{ name: 'Sabor', value_name: 'Uva' }], null);
    expect(out).toEqual([]);
  });
});

// ⚠️ `BRAND` is spelled in two packages that CANNOT import each other: the ML
// package must not depend on `@delfrance/schemas` (its root carries the OAuth
// core, and `apps/web` reaches schemas), so `attrBrand` and
// `ML_PRODUTO_HERDADO_ATTRIBUTE_IDS` hold their own literal while
// `MARCA_ATTRIBUTE_ID` holds the shared one. Nothing in either package can see
// the disagreement — but this app imports both, so it can.
//
// A drift here is silent and total: publish would filter on one id and re-add
// the other, shipping the attribute twice (once with the operator's stale value)
// while the produto's Marca never replaced anything.
describe('the BRAND id agrees across the two packages that cannot import each other', () => {
  it('is what attrBrand emits', () => {
    expect(attrBrand('Hering').id).toBe(MARCA_ATTRIBUTE_ID);
  });

  it('is the herdado list membership', () => {
    expect(ML_PRODUTO_HERDADO_ATTRIBUTE_IDS).toContain(MARCA_ATTRIBUTE_ID);
  });

  // The control: the constant is a real id, not an empty string that would make
  // both assertions above pass against anything.
  it('is a non-empty id no derived rule also claims', () => {
    expect(MARCA_ATTRIBUTE_ID.length).toBeGreaterThan(0);
    expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).not.toContain(MARCA_ATTRIBUTE_ID);
  });
});

/**
 * The local refusal for a tabela de medidas that bound no chart (#1087).
 *
 * ⚠️ Every case is asserted TWICE — once with `categoriaUsaGuia: true` (the
 * refusal fires) and once with `false` (it does not). One direction alone is
 * vacuous: a rule that always refused would satisfy the first sweep, and a rule
 * that never refused would satisfy the second.
 */
describe('sizeChartIssue', () => {
  const divergente: TabelaBindingMotivo = {
    codigo: 'dominio-divergente',
    categoryId: 'MLB1398',
    nome: 'Camiseta lisa infantil',
    dominiosDaTabela: ['MLB-SHIRTS'],
    dominioDaCategoria: 'MLB-T_SHIRTS',
  };

  /** Every reason that must produce an issue in a category that uses a guia. */
  const RECUSAVEIS: TabelaBindingMotivo[] = [
    divergente,
    { codigo: 'tabela-inexistente', tabMediId: 'tm-1' },
    { codigo: 'tabela-sem-guias-nesta-conta', tabMediId: 'tm-1', nome: 'Camisetas' },
    { codigo: 'categoria-sem-dominio', categoryId: 'MLB1398' },
    {
      codigo: 'guias-nao-enviadas',
      categoryId: 'MLB1398',
      dominioDaCategoria: 'MLB-T_SHIRTS',
      nome: 'Camisetas',
    },
    {
      codigo: 'sem-atributos-correspondentes',
      categoryId: 'MLB1398',
      dominioDaCategoria: 'MLB-T_SHIRTS',
      nome: 'Camisetas',
    },
  ];

  /** Reasons that are SILENT even where a guia is used, each for its own reason. */
  const SILENCIOSOS: TabelaBindingMotivo[] = [
    { codigo: 'vinculada', chartId: '7523235' },
    // Not asking for a chart — shouting at every listing without one buries the
    // message that matters.
    { codigo: 'produto-sem-tabela' },
    // `assemblePublishInput` already raises its own `categoria … não definida`.
    { codigo: 'anuncio-sem-categoria', tabMediId: 'tm-1' },
  ];

  /**
   * ⚠️ The two lists are PARTITIONS of `TABELA_BINDING_RECUSA`, checked against
   * it below rather than hand-maintained beside it. They were a second, unchecked
   * copy of the same rule — the very thing that constant exists to end.
   */
  it('the two lists reconstitute TABELA_BINDING_RECUSA exactly', () => {
    const declarados = Object.entries(TABELA_BINDING_RECUSA);
    expect(RECUSAVEIS.map((m) => m.codigo).sort()).toEqual(
      declarados
        .filter(([, recusa]) => recusa)
        .map(([c]) => c)
        .sort(),
    );
    expect(SILENCIOSOS.map((m) => m.codigo).sort()).toEqual(
      declarados
        .filter(([, recusa]) => !recusa)
        .map(([c]) => c)
        .sort(),
    );
  });

  it('⚠️ no guia declares a domain at all → names only the CATEGORY domain', () => {
    // ⚠️ Legacy data allows a null `domain_id`, so `dominiosDaTabela` is EMPTY
    // and the ordinary sentence would read "está no domínio , mas…". Shipped
    // untested on both copies of this message; it is reachable, so it is pinned.
    const issue = sizeChartIssue(
      {
        codigo: 'dominio-divergente',
        categoryId: 'MLB1398',
        nome: 'Camisetas',
        dominiosDaTabela: [],
        dominioDaCategoria: 'MLB-T_SHIRTS',
      },
      true,
    )!;
    expect(issue).toContain('não tem nenhuma guia no domínio MLB-T_SHIRTS');
    expect(issue).not.toContain('está no domínio ,');
    expect(issue).not.toContain('categoria de —');
  });

  it('names BOTH domains on the live case — the sentence that is the whole fix', () => {
    const issue = sizeChartIssue(divergente, true);
    expect(issue).toContain('MLB-SHIRTS');
    expect(issue).toContain('MLB-T_SHIRTS');
    expect(issue).toContain('Camiseta lisa infantil');
  });

  it('every refusable reason produces a DISTINCT issue where the category uses a guia', () => {
    const issues = RECUSAVEIS.map((m) => sizeChartIssue(m, true));
    expect(issues.every((i) => i != null && i.length > 0)).toBe(true);
    // Distinct, or two different problems would send the operator to the same
    // place — which is the conflation this whole change exists to remove.
    expect(new Set(issues).size).toBe(RECUSAVEIS.length);
  });

  it('refuses NOTHING where the category carries no guia — or was never asked', () => {
    for (const motivo of [...RECUSAVEIS, ...SILENCIOSOS]) {
      expect(sizeChartIssue(motivo, false)).toBeNull();
      expect(sizeChartIssue(motivo, null)).toBeNull();
      expect(sizeChartIssue(motivo, undefined)).toBeNull();
    }
  });

  it('stays silent for the three reasons that are not this gate to report', () => {
    for (const motivo of SILENCIOSOS) {
      expect(sizeChartIssue(motivo, true)).toBeNull();
    }
  });

  it('no motivo at all → nothing, whatever the category says', () => {
    expect(sizeChartIssue(null, true)).toBeNull();
    expect(sizeChartIssue(undefined, true)).toBeNull();
  });
});
