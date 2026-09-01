/**
 * #1087 §5 — the pure half of `scripts/snapshot-produto.ts`: classify the
 * difference between a produto captured BEFORE it was deleted and the produto an
 * ML re-import put back.
 *
 * It lives here rather than in the script because the classification IS the
 * feature, and an unverified classifier is the exact failure this live run keeps
 * turning up — a checker that reports nothing reads identically to a clean pass.
 * No Firestore, no IO, no clock: `produtoSnapshotDiff.test.ts` drives it with
 * both controls (a known-good pair must report zero, a known-bad pair must
 * report the field).
 *
 * ---- The three buckets ----------------------------------------------------
 *  1. **ROUND-TRIP** — what {@link MappedMlItem} claims an import can carry.
 *     A difference here is a FINDING.
 *  2. **EXPECTED-LOST** — history and fiscal state ML never carried. Counted,
 *     never failed.
 *  3. **VOLATILE** — doc ids and clocks, dropped before comparing. Without this
 *     the real rows drown in noise.
 */

/**
 * Produto fields an ML import can actually restore — the `MappedMlItem` contract
 * (`packages/integrations/mercado-livre/src/mapping/importItem.ts`) projected
 * onto produto field names.
 *
 * ⚠️ Keep this tied to that interface. Widening it to "every produto field" is
 * what makes the report unreadable — most of a produto is ERP state ML never saw.
 */
export const CAMPOS_ROUND_TRIP: readonly string[] = [
  'nome',
  'sku',
  'gtin',
  'ehKit',
  'ehUsado',
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
  'precos',
  'ofereceFreteGratis',
  'fotos',
  'videos',
];

/** Link-doc fields the import writes — the `produtoMercadoLivre` half. */
export const CAMPOS_LINK_ROUND_TRIP: readonly string[] = [
  'id',
  'sku',
  'category_id',
  'listing_type_id',
  'condition',
  'estado',
  'status',
  'sub_status',
  'freteGratis',
  'isUserProductModel',
  'userProductId',
  'videoId',
  'attributes',
];

/**
 * Dropped before comparing. Doc ids and clocks differ by construction on a
 * re-import, and the denorm arrays are rebuilt by triggers rather than the
 * import.
 */
export const CAMPOS_VOLATEIS: ReadonlySet<string> = new Set([
  'timestamp',
  'ultimaModificacao',
  'dataCadastro',
  'fotosArquivosIds',
  'paiId',
  // Same reason as `paiId`: it holds a produto DOC ID, and a delete → re-import
  // mints a new one for the sole member (the two sides derive it from different
  // parent-link ids — `upSoleMember.ts:160` vs `importVariations.ts:154`), so a
  // faithful round trip legitimately changes this value.
  'filhoUnicoId',
  'variacoesUid',
  'grupoDeVariacoesUid',
  'componentesKitKeys',
  'integracoesComProduto',
  'marketplace',
  'marketplaceIds',
  'statusProdutosMarketplace',
  'contaOuterRef',
  'produtoMercadoLivreOuterRef',
]);

/**
 * Subcollections ML never carried. Reported as counts, never as failures — a
 * re-imported produto legitimately has none of this history.
 */
export const SUBCOLECOES_ESPERADAS_PERDIDAS: ReadonlySet<string> = new Set([
  'historicoDePrecos',
  'historicoDeCusto',
  'historicoDeModificacoes',
  'historicoEstoque',
  'imposto',
]);

/**
 * Differences already accounted for, so a run's real result is not buried under
 * decisions already taken.
 *
 * ⚠️ A **predicate**, never a field name. Excusing a whole field would hide the
 * real loss it exists to catch — a `nome` that came back genuinely wrong looks
 * identical to one ML merely title-cased, unless something checks WHICH of the
 * two happened. Each entry returns its note only when the difference is exactly
 * the shape it knows about, and `null` otherwise, which sends the row straight
 * back to the findings.
 */
export type DivergenciaConhecida = (antes: unknown, depois: unknown) => string | null;

/** `IS_KIT` is read on import and NEVER written on publish (legacy did the same). */
const kitPerdidoNoPublish: DivergenciaConhecida = (a, b) =>
  a === true && b === false
    ? 'IS_KIT é lido no import e NUNCA enviado no publish — volta como false (#1087 §5)'
    : null;

/** ML title-cases the título; same string, different case. */
const soCaixaDiferente: DivergenciaConhecida = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLocaleLowerCase() === b.toLocaleLowerCase()
    ? 'o Mercado Livre normaliza a caixa do título — mesma string'
    : null;

function atributosPorId(v: unknown): Map<string, unknown> | null {
  if (!Array.isArray(v)) return null;
  const m = new Map<string, unknown>();
  for (const a of v) {
    if (typeof a !== 'object' || a === null) return null;
    const { id, value_name: valueName } = a as { id?: unknown; value_name?: unknown };
    if (typeof id !== 'string') return null;
    m.set(id, valueName);
  }
  return m;
}

/**
 * ML echoes attributes back enriched — it fills `name`, `value_id` and
 * `attribute_group_*` on ids it recognises. Known ONLY while the id set and every
 * `value_name` still agree: a changed or dropped VALUE is a real loss.
 */
const atributosEnriquecidosPeloMl: DivergenciaConhecida = (a, b) => {
  const antes = atributosPorId(a);
  const depois = atributosPorId(b);
  if (antes == null || depois == null) return null;
  if (antes.size !== depois.size) return null;
  for (const [id, valor] of antes) {
    if (!depois.has(id)) return null;
    if (!same(valor, depois.get(id))) return null;
  }
  return 'mesmos ids e value_names — o Mercado Livre apenas devolveu name/value_id preenchidos';
};

function hashesDeFoto(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const f of v) {
    if (typeof f !== 'object' || f === null) return null;
    const ref = (f as { arquivoOuterRef?: unknown }).arquivoOuterRef;
    if (typeof ref !== 'string') return null;
    // `arquivos/<produtoId>_<hash>` — the produto id half necessarily changes on
    // a re-import; the content hash is what must survive.
    const sub = ref.slice(ref.indexOf('_') + 1);
    out.push(sub);
  }
  return out;
}

/**
 * Arquivo refs embed the produto id, which is new after a re-import. Known ONLY
 * while the content hashes match one for one — a MISSING or different photo is a
 * real loss, and that is what the Storage-bucket 404 produced.
 */
const fotosRechaveadas: DivergenciaConhecida = (a, b) => {
  const antes = hashesDeFoto(a);
  const depois = hashesDeFoto(b);
  if (antes == null || depois == null) return null;
  if (antes.length !== depois.length) return null;
  if (antes.some((h, i) => h !== depois[i])) return null;
  return 'mesmas fotos — só o produtoId dentro do arquivoOuterRef mudou';
};

export const DIVERGENCIAS_CONHECIDAS: ReadonlyMap<string, DivergenciaConhecida> = new Map([
  ['ehKit', kitPerdidoNoPublish],
  ['nome', soCaixaDiferente],
  ['attributes', atributosEnriquecidosPeloMl],
  ['fotos', fotosRechaveadas],
]);

export interface DocDump {
  id: string;
  data: Record<string, unknown>;
}

export interface ProdutoDump {
  produtoId: string;
  produto: Record<string, unknown>;
  /** Every subcollection actually present, by leaf name. */
  subcolecoes: Record<string, DocDump[]>;
}

export interface Snapshot {
  versao: 1;
  capturadoEm: string;
  projectId: string;
  integracaoId: string;
  itemId: string | null;
  raiz: ProdutoDump;
  filhos: ProdutoDump[];
}

export type Bucket = 'ok' | 'divergente' | 'ausente' | 'conhecida';

export interface Row {
  campo: string;
  antes: unknown;
  depois: unknown;
  bucket: Bucket;
  nota?: string;
}

/**
 * `null` and `undefined` both mean "nothing here", and a number that survived a
 * `"0.6 kg"` → `0.6` parse can land a float ulp away from its source. Objects
 * and arrays compare structurally — attribute lists are the reason.
 */
export function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

export function row(campo: string, antes: unknown, depois: unknown): Row {
  if (same(antes, depois)) return { campo, antes, depois, bucket: 'ok' };
  const nota = DIVERGENCIAS_CONHECIDAS.get(campo)?.(antes, depois);
  if (nota != null) return { campo, antes, depois, bucket: 'conhecida', nota };
  return { campo, antes, depois, bucket: depois == null ? 'ausente' : 'divergente' };
}

export function compararCampos(
  campos: readonly string[],
  antes: Record<string, unknown> | null,
  depois: Record<string, unknown> | null,
): Row[] {
  return campos.filter((c) => !CAMPOS_VOLATEIS.has(c)).map((c) => row(c, antes?.[c], depois?.[c]));
}

/** The `produtoMercadoLivre` link doc, or null when the produto carries none. */
export function primeiroLink(dump: ProdutoDump): Record<string, unknown> | null {
  return dump.subcolecoes.produtoMercadoLivre?.[0]?.data ?? null;
}

/**
 * Subcollections, as document COUNTS. A re-imported produto's estoque rows carry
 * different ids and timestamps by construction, so a content diff here would be
 * noise; what matters is whether the subcollection came back at all.
 */
export function compararSubcolecoes(
  antes: ProdutoDump,
  depois: ProdutoDump,
): { roundTrip: Row[]; esperadasPerdidas: Row[] } {
  const nomes = [
    ...new Set([...Object.keys(antes.subcolecoes), ...Object.keys(depois.subcolecoes)]),
  ].sort();

  const roundTrip: Row[] = [];
  const esperadasPerdidas: Row[] = [];
  for (const nome of nomes) {
    const r = row(
      `${nome} (docs)`,
      antes.subcolecoes[nome]?.length ?? 0,
      depois.subcolecoes[nome]?.length ?? 0,
    );
    if (SUBCOLECOES_ESPERADAS_PERDIDAS.has(nome)) esperadasPerdidas.push(r);
    else roundTrip.push(r);
  }
  roundTrip.push(...compararExtraData(antes, depois));
  return { roundTrip, esperadasPerdidas };
}

/** The `extraData` doc id is always the literal `singleton` (`PRODUTO_EXTRA_DATA_DOC_ID`). */
const EXTRA_DATA_DOC_ID = 'singleton';

/**
 * extraData fields an ML import can restore, so the report can say whether they
 * actually came back.
 *
 * `marca` is the one that motivated this (#1087): the importer began filling it
 * from the listing's `BRAND`, and nothing here could see it.
 */
export const CAMPOS_EXTRA_DATA_ROUND_TRIP: readonly string[] = ['marca', 'descricao', 'condicao'];

/**
 * Compare the `extraData/singleton` doc FIELD BY FIELD.
 *
 * ⚠️ Without this the subcollection comparison above reports `extraData` by
 * DOCUMENT COUNT alone — so a `marca` of `'Nike'` coming back `null` reads as
 * "1 doc → 1 doc, ok". A checker that cannot fail is the exact hazard this
 * module's own header names, and `marca` sat squarely inside it: the round-trip
 * report was clean for the whole time nothing imported the field.
 */
function compararExtraData(antes: ProdutoDump, depois: ProdutoDump): Row[] {
  const doc = (d: ProdutoDump): Record<string, unknown> | null =>
    d.subcolecoes.extraData?.find((x) => x.id === EXTRA_DATA_DOC_ID)?.data ?? null;
  const a = doc(antes);
  const b = doc(depois);
  // Neither side has one — nothing to say. The count row above already reports a
  // singleton that vanished outright.
  if (a == null && b == null) return [];
  return compararCampos(CAMPOS_EXTRA_DATA_ROUND_TRIP, a, b).map((r) => ({
    ...r,
    campo: `extraData.${r.campo}`,
  }));
}

export interface DiffResult {
  produto: Row[];
  link: Row[];
  subcolecoes: Row[];
  subcolecoesEsperadasPerdidas: Row[];
  filhos: Row[];
  /** Unexplained round-trip losses — the only rows that mean "finding". */
  achados: Row[];
  /** Differences already decided about; reported, never counted as findings. */
  conhecidas: Row[];
}

/**
 * Compare a saved snapshot against a freshly-read one.
 *
 * ⚠️ Children are paired by INDEX after each side was sorted by doc id at
 * capture time. That is a deliberate approximation: a re-import mints new child
 * ids, so nothing stable links a before-child to an after-child, and the count
 * row above is what actually catches a lost variation.
 */
export function diffSnapshots(antes: Snapshot, depois: Snapshot): DiffResult {
  const produto = compararCampos(CAMPOS_ROUND_TRIP, antes.raiz.produto, depois.raiz.produto);
  const link = compararCampos(
    CAMPOS_LINK_ROUND_TRIP,
    primeiroLink(antes.raiz),
    primeiroLink(depois.raiz),
  );
  const subs = compararSubcolecoes(antes.raiz, depois.raiz);

  const filhos: Row[] = [row('filhos (produtos)', antes.filhos.length, depois.filhos.length)];
  const pares = Math.min(antes.filhos.length, depois.filhos.length);
  for (let i = 0; i < pares; i += 1) {
    for (const r of compararCampos(
      CAMPOS_ROUND_TRIP,
      antes.filhos[i]!.produto,
      depois.filhos[i]!.produto,
    )) {
      if (r.bucket !== 'ok') filhos.push({ ...r, campo: `filho[${i}].${r.campo}` });
    }
  }

  const todas = [...produto, ...link, ...subs.roundTrip, ...filhos];
  return {
    produto,
    link,
    subcolecoes: subs.roundTrip,
    subcolecoesEsperadasPerdidas: subs.esperadasPerdidas,
    filhos,
    achados: todas.filter((r) => r.bucket === 'divergente' || r.bucket === 'ausente'),
    conhecidas: todas.filter((r) => r.bucket === 'conhecida'),
  };
}
