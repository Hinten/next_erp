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
 * Losses already established elsewhere, so a run's real result is not buried
 * under decisions already taken.
 *
 * `ehKit` — `IS_KIT` is read on import and NEVER written on publish (legacy did
 * the same), so it round-trips to `false`. Pinned in
 * `packages/integrations/mercado-livre/test/roundTrip.test.ts`.
 */
export const DIVERGENCIAS_CONHECIDAS: ReadonlyMap<string, string> = new Map([
  ['ehKit', 'IS_KIT é lido no import e NUNCA enviado no publish — volta como false (#1087 §5)'],
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
  const nota = DIVERGENCIAS_CONHECIDAS.get(campo);
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
  return { roundTrip, esperadasPerdidas };
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
