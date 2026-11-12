import { z } from 'zod';
import { inteiroPositivoCanonicoLi } from './mapaFreteLojaIntegrada';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `sincEstoqueLojaIntegrada/{integracaoId}` (TOP-LEVEL) and its three subcollections — the
 * per-conta state of the Loja Integrada stock sync (master plan step 12, PR 12-a): the daily
 * reconcile's cursor and last-run stats, the ERP-side snapshot the reconcile diffs the store's
 * stock list against, and the component → store-kits map the kit fan-out reads. ONE root
 * document per conta, doc id = `integracaoId`.
 *
 * ## Nothing here is ever SENT
 *
 * Every quantity a stock PUT carries is derived at send time from the ERP and from a fresh
 * read of the store's row (model A). The snapshot and the kits map are PRE-FILTERS: they decide
 * which children are worth a send run, never what that run sends, so a stale entry can only
 * waste one store read or miss a change until the next daily reconcile — never write a wrong
 * number.
 *
 * ## The documents
 *
 *  - the root: {@link sincEstoqueLojaIntegradaSchema} — the reconcile's resumable cursor into the
 *    store's stock list (`reconcile`) and the counters of the last finished run
 *    (`ultimoReconcile`);
 *  - `snapshot/{'00'..'31'}`: {@link snapshotEstoqueLiSchema} — one entry per store product id
 *    the ERP side knows, bucketed by {@link baldeSnapshotEstoqueLi} (the id modulo 32), so no
 *    document approaches the 1 MiB limit at the measured catalogue sizes (about 50 bytes an
 *    entry);
 *  - `snapshot/pais`: {@link paisSnapshotEstoqueLiSchema} — the store ids of the parent
 *    products, whose stock rows are never sent (only a child's row is);
 *  - `kits/{componenteProdutoId}`: {@link kitsComponenteEstoqueLiSchema} — for one ERP component,
 *    the store-linked kits that contain it, inline up to {@link MAX_KITS_EM_LINHA_ESTOQUE_LI},
 *    otherwise in shards;
 *  - `kitsFatias/{componenteProdutoId}~{n}`: {@link fatiaKitsComponenteEstoqueLiSchema} — those
 *    shards, at most {@link MAX_KITS_POR_FATIA_ESTOQUE_LI} kits each, ids from
 *    {@link idFatiaKitsEstoqueLi}. A subcollection of their own, never beside the headers: a
 *    produto id may itself end in `~0`, so a header and a shard sharing one collection could
 *    share one document id, and a listing could not tell them apart.
 *
 * ## Units
 *
 * Every stamp is MILLISECONDS and says so in its name (`…Ms`). This app keeps µs to its one
 * avisos module.
 *
 * ## Writers (root `CLAUDE.md` rule 7)
 *
 * Only the reconcile run holding the lease in `reconcileEstoqueLojaIntegrada/atual` writes
 * here, each write a native precondition (`update(patch, { lastUpdateTime })` on the slice's own
 * read, advance-only), and every document written by a run carries that run's `execucaoId`: a
 * slice with another `execucaoId` is refused, and the kits map is swept by it (a header or shard
 * of an older run is stale). The send runs and the trigger only READ. No transaction.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits no match block and
 * no client can read any of it. Bare schemas, never a `{ schema, meta }` export
 * (`registry.test.ts`). Unknown keys are STRIPPED.
 */

/** The root collection's path. */
export const COLECAO_SINC_ESTOQUE_LI = 'sincEstoqueLojaIntegrada';

/** The three subcollections under one conta's root document. */
export const SUBCOLECOES_SINC_ESTOQUE_LI = {
  snapshot: 'snapshot',
  kits: 'kits',
  kitsFatias: 'kitsFatias',
} as const;

/* -------------------------------------------------------------------------- */
/*                                  Grammars                                   */
/* -------------------------------------------------------------------------- */

/**
 * A store product id as these documents key it: its canonical decimal text — a positive
 * integer, no leading zero, no sign, at most 16 digits — and a safe integer. A Firestore map key
 * is text, so a stored number never appears here.
 *
 * The grammar has ONE spelling, the shared reader `inteiroPositivoCanonicoLi`, which the link's
 * counts predicate reads ids through too: text is accepted exactly when the reader returns it
 * unchanged, so nothing is folded here (`'01'` is not `'1'`; it is no id at all).
 */
export const idProdutoLiTextoSchema = z.string().refine((v) => inteiroPositivoCanonicoLi(v) === v, {
  message: 'id da loja fora da forma canônica',
});

/** The bytes a Firestore document id may take. */
const MAX_BYTES_ID_DOCUMENTO = 1500;

/**
 * An ERP document id (a produto, an estoque record) as Firestore accepts it: no `/`, not `.` or
 * `..`, not `__…__`, at most 1 500 bytes.
 */
export const idDocumentoEstoqueLiSchema = z
  .string()
  .min(1)
  .regex(/^[^/]+$/)
  .refine((v) => v !== '.' && v !== '..' && !/^__.*__$/.test(v), {
    message: 'id de documento reservado',
  })
  .refine((v) => new TextEncoder().encode(v).length <= MAX_BYTES_ID_DOCUMENTO, {
    message: 'id de documento acima de 1 500 bytes',
  });

/**
 * The id of one reconcile run: letters, digits, `-` and `_` only, because it names Cloud Tasks
 * tasks (`estoque-reconcile-<AAAAMMDD>` for the scheduled run, `…-manual-<ms>` for an operator's,
 * `…-deposito-<ms>` for a depósito change), and at most 100 characters.
 */
export const ID_EXECUCAO_ESTOQUE_LI_REGEX = /^[A-Za-z0-9_-]{1,100}$/;

export const idExecucaoEstoqueLiSchema = z.string().regex(ID_EXECUCAO_ESTOQUE_LI_REGEX);

/** A counter's name: an identifier, so it reads as a log field too. */
const nomeContadorSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/);

/** Named counters of a run, each a non-negative integer. */
export const contadoresEstoqueLiSchema = z.record(
  nomeContadorSchema,
  z.number().int().nonnegative(),
);

/* -------------------------------------------------------------------------- */
/*                                  The root                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the reconcile stands in the store's stock list for this conta. The list has no filter,
 * so it is read whole, one page per call, `limite` rows at a time from `offset`: a run cut
 * short at page 13 of 25 resumes at 13. `null` = no run is reading this conta's list.
 */
export const reconcileContaEstoqueLiSchema = z.object({
  /** The next row to read, 0-based. */
  offset: z.number().int().nonnegative(),
  /** The page size the run started with; a run never changes it mid-list. */
  limite: z.number().int().min(1).max(1000),
  /** MS. When this conta's list read began. */
  iniciadoEmMs: millisSinceEpoch(),
});
export type ReconcileContaEstoqueLi = z.infer<typeof reconcileContaEstoqueLiSchema>;

/** What the last FINISHED reconcile run counted for this conta (an operator's view, never a decision input). */
export const ultimoReconcileEstoqueLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  /** MS. */
  iniciadoEmMs: millisSinceEpoch(),
  /** MS. */
  concluidoEmMs: millisSinceEpoch(),
  /** Rows read, entries, candidates, holds, … — named by the run. */
  contadores: contadoresEstoqueLiSchema.default({}),
});
export type UltimoReconcileEstoqueLi = z.infer<typeof ultimoReconcileEstoqueLiSchema>;

export const sincEstoqueLojaIntegradaSchema = z.object({
  reconcile: reconcileContaEstoqueLiSchema.nullable().default(null),
  ultimoReconcile: ultimoReconcileEstoqueLiSchema.nullable().default(null),
});
export type SincEstoqueLojaIntegrada = z.infer<typeof sincEstoqueLojaIntegradaSchema>;

/* -------------------------------------------------------------------------- */
/*                                The snapshot                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the reconcile's ERP side decided about one store product id — the entry's `f`:
 *
 *  - `v` (valid): a counting child link of this conta on one produto, with a computed S;
 *  - `r` (held): the produto never had an ERP stock record at ANY depósito — never pushed, listed
 *    in the "sem estoque no ERP" aviso (a produto with a record elsewhere is pushed the conta
 *    depósito's real 0);
 *  - `par` (parity): the child's own marketplace status says `enviarEstoque === false`;
 *  - `amb` (ambiguous): WHICH record to read is ambiguous — two counting child links of this
 *    conta on the produto, or two stock records at the conta's depósito neither of which is the
 *    canonical one;
 *  - `dup` (duplicate): the same store id is linked from two ERP produtos; neither is pushed;
 *  - `ns` (not supported): a shape the step does not send;
 *  - `x` (no link): a row of the store's list that no link of this conta names — cached so the
 *    lookup is not repeated every day.
 *
 * Only `v` is ever a send candidate.
 */
export const flagEntradaEstoqueLiSchema = z.enum(['v', 'r', 'par', 'amb', 'dup', 'ns', 'x']);
export type FlagEntradaEstoqueLi = z.infer<typeof flagEntradaEstoqueLiSchema>;

/** Named members of {@link flagEntradaEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FLAG_ENTRADA_ESTOQUE_LI = {
  valido: 'v',
  retido: 'r',
  paridade: 'par',
  ambiguo: 'amb',
  duplicado: 'dup',
  naoSuportado: 'ns',
  semVinculo: 'x',
} as const satisfies Record<string, FlagEntradaEstoqueLi>;

/**
 * One snapshot entry, kept short on purpose (keys of one or two letters: about 50 bytes):
 *
 *  - `p`: the ERP produto (the CHILD) the link sits under; `null` exactly when `f` is `x`;
 *  - `s`: S, the ERP sellable quantity at the conta's depósito, floored and clamped at 0 only —
 *    the upper cap is applied at diff and send time, never baked in here; present exactly when
 *    `f` is `v`;
 *  - `f`: {@link flagEntradaEstoqueLiSchema};
 *  - `k`: `true` when the produto is a kit (its S derives from its components); absent
 *    otherwise, never `false`, to keep the entry short.
 */
export const entradaSnapshotEstoqueLiSchema = z
  .object({
    p: idDocumentoEstoqueLiSchema.nullable(),
    s: z.number().int().nonnegative().nullable(),
    f: flagEntradaEstoqueLiSchema,
    k: z.literal(true).nullable().optional(),
  })
  .superRefine((entrada, ctx) => {
    const semVinculo = entrada.f === FLAG_ENTRADA_ESTOQUE_LI.semVinculo;
    if (semVinculo !== (entrada.p === null)) {
      ctx.addIssue({ code: 'custom', path: ['p'], message: 'p é nulo exatamente quando f = x' });
    }
    if ((entrada.f === FLAG_ENTRADA_ESTOQUE_LI.valido) !== (entrada.s !== null)) {
      ctx.addIssue({ code: 'custom', path: ['s'], message: 's existe exatamente quando f = v' });
    }
    if (semVinculo && entrada.k != null) {
      ctx.addIssue({ code: 'custom', path: ['k'], message: 'uma linha sem vínculo não é kit' });
    }
  });
export type EntradaSnapshotEstoqueLi = z.infer<typeof entradaSnapshotEstoqueLiSchema>;

/** How many buckets the snapshot is split into. */
export const BALDES_SNAPSHOT_ESTOQUE_LI = 32;

/** A bucket document id: `'00'` to `'31'`. */
export const ID_BALDE_SNAPSHOT_ESTOQUE_LI_REGEX = /^(?:[0-2][0-9]|3[01])$/;

/** The parents document's id, beside the 32 buckets. */
export const ID_PAIS_SNAPSHOT_ESTOQUE_LI = 'pais';

/**
 * The bucket document of a store product id: the id modulo {@link BALDES_SNAPSHOT_ESTOQUE_LI},
 * zero-padded to two digits (`'1'` → `'01'`, `'32'` → `'00'`). Pure and total over text: `null`
 * for anything that is not the canonical id text ({@link idProdutoLiTextoSchema}) — `'01'`,
 * `'0'`, `'1.0'`, `' 1'`, `''`, an id above 2^53 − 1. A caller holding a NUMBER converts it with
 * the shared canonical reader first; this function folds nothing.
 *
 * Exact for every accepted id: a safe integer's remainder is exact in double arithmetic.
 */
export function baldeSnapshotEstoqueLi(idLi: string): string | null {
  if (!idProdutoLiTextoSchema.safeParse(idLi).success) return null;
  return String(Number(idLi) % BALDES_SNAPSHOT_ESTOQUE_LI).padStart(2, '0');
}

/** `snapshot/{'00'..'31'}`: the entries of one bucket, keyed by store product id. */
export const snapshotEstoqueLiSchema = z.object({
  /** The run that wrote this bucket. */
  execucaoId: idExecucaoEstoqueLiSchema,
  e: z.record(idProdutoLiTextoSchema, entradaSnapshotEstoqueLiSchema).default({}),
});
export type SnapshotEstoqueLi = z.infer<typeof snapshotEstoqueLiSchema>;

/** `snapshot/pais`: the store ids of the parent products of this conta's links. */
export const paisSnapshotEstoqueLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  ids: z.array(idProdutoLiTextoSchema).default([]),
});
export type PaisSnapshotEstoqueLi = z.infer<typeof paisSnapshotEstoqueLiSchema>;

/* -------------------------------------------------------------------------- */
/*                                 The kits map                                */
/* -------------------------------------------------------------------------- */

/** A component's quantity in a kit: positive and finite, possibly fractional. */
const qtdComponenteKitSchema = z.number().positive().finite();

/**
 * One store-linked kit containing the component: `i`, the kit's store id; `q`, every
 * constraining component of the kit (this one included) → its quantity in the kit.
 */
export const kitDoComponenteEstoqueLiSchema = z.object({
  i: idProdutoLiTextoSchema,
  q: z
    .record(idDocumentoEstoqueLiSchema, qtdComponenteKitSchema)
    .refine((q) => Object.keys(q).length > 0, { message: 'um kit sem componente' }),
});
export type KitDoComponenteEstoqueLi = z.infer<typeof kitDoComponenteEstoqueLiSchema>;

/** The store-linked kits of one component, by kit produto id. */
const kitsDoComponenteSchema = z.record(idDocumentoEstoqueLiSchema, kitDoComponenteEstoqueLiSchema);

/**
 * Up to this many kits per component live inline in the header; beyond it they move to shards.
 * The same 30 is the default ceiling of the eager kit fan-out: a component with more store kits
 * than that sends only its zero-crossings at once and leaves the rest to the nightly reconcile.
 * The eager path reads only the header, so a configured ceiling above this one has to be refused
 * where the trigger reads its environment.
 */
export const MAX_KITS_EM_LINHA_ESTOQUE_LI = 30;

/** The most kits one shard holds (about 100 bytes each). */
export const MAX_KITS_POR_FATIA_ESTOQUE_LI = 1000;

/**
 * `kits/{componenteProdutoId}`: the header of one component.
 *
 *  - `F`: how many store-linked kits contain it;
 *  - `qMax`: its largest quantity in any of them — when ⌊min(available before, after) / qMax⌋
 *    exceeds the cap, no kit can change and the fan-out reads nothing more;
 *  - `comps`: every component of those kits (this one included) → its stock record id at the
 *    conta's depósito, or `null` when it has none there — deduplicated across kits, so a sibling
 *    is read once however many kits share it;
 *  - `kits`: inline when `F` ≤ {@link MAX_KITS_EM_LINHA_ESTOQUE_LI}, else `null` and
 *    `fatias` = ⌈F / {@link MAX_KITS_POR_FATIA_ESTOQUE_LI}⌉ shards hold them.
 *
 * Two schemas, on the precedent of `clienteSchema`/`clienteFormSchema`: this one is the SHAPE
 * alone, the one the admin handle validates writes with — a merge patch is checked against its
 * `.partial()`, which Zod refuses (a plain `Error`) on an object carrying refinements. The
 * cross-field rules above are {@link kitsComponenteEstoqueLiSchema}'s: a full write and every read
 * that decides anything parse with THAT one.
 */
export const kitsComponenteEstoqueLiBaseSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  F: z.number().int().min(1),
  qMax: qtdComponenteKitSchema,
  comps: z.record(idDocumentoEstoqueLiSchema, idDocumentoEstoqueLiSchema.nullable()).default({}),
  kits: kitsDoComponenteSchema.nullable().default(null),
  fatias: z.number().int().nonnegative().default(0),
});

/** {@link kitsComponenteEstoqueLiBaseSchema} with its invariants: `F`, `kits` and `fatias` agree. */
export const kitsComponenteEstoqueLiSchema = kitsComponenteEstoqueLiBaseSchema.superRefine(
  (cabecalho, ctx) => {
    if (cabecalho.kits !== null) {
      if (Object.keys(cabecalho.kits).length !== cabecalho.F) {
        ctx.addIssue({ code: 'custom', path: ['kits'], message: 'F difere dos kits em linha' });
      }
      if (cabecalho.F > MAX_KITS_EM_LINHA_ESTOQUE_LI || cabecalho.fatias !== 0) {
        ctx.addIssue({ code: 'custom', path: ['fatias'], message: 'kits em linha não têm fatias' });
      }
      return;
    }
    if (cabecalho.F <= MAX_KITS_EM_LINHA_ESTOQUE_LI) {
      ctx.addIssue({ code: 'custom', path: ['kits'], message: 'poucos kits ficam em linha' });
    }
    if (cabecalho.fatias !== Math.ceil(cabecalho.F / MAX_KITS_POR_FATIA_ESTOQUE_LI)) {
      ctx.addIssue({ code: 'custom', path: ['fatias'], message: 'fatias difere de F' });
    }
  },
);
export type KitsComponenteEstoqueLi = z.infer<typeof kitsComponenteEstoqueLiSchema>;

/** `kitsFatias/{componenteProdutoId}~{n}`: one shard of a component with more than 30 store kits. */
export const fatiaKitsComponenteEstoqueLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  kits: kitsDoComponenteSchema.refine(
    (kits) => {
      const n = Object.keys(kits).length;
      return n >= 1 && n <= MAX_KITS_POR_FATIA_ESTOQUE_LI;
    },
    { message: 'uma fatia tem de 1 a 1000 kits' },
  ),
});
export type FatiaKitsComponenteEstoqueLi = z.infer<typeof fatiaKitsComponenteEstoqueLiSchema>;

/**
 * The document id of shard `n` of component `componenteId` in `kitsFatias`: `<componenteId>~<n>`.
 * Unambiguous among the shards — `n` is digits only, so the LAST `~` splits any shard id back into
 * exactly one (component, n), even for a component id that itself contains `~`. Never beside the
 * headers (the module header says why), so no produto id can make a shard id a header id.
 *
 * Throws `RangeError` on an id {@link idDocumentoEstoqueLiSchema} refuses, an `n` that is not a
 * non-negative safe integer, or a result past the 1 500-byte document id limit: every input comes
 * from a parsed document, so a throw here is a bug.
 */
export function idFatiaKitsEstoqueLi(componenteId: string, n: number): string {
  if (
    !idDocumentoEstoqueLiSchema.safeParse(componenteId).success ||
    !Number.isSafeInteger(n) ||
    n < 0
  ) {
    throw new RangeError('idFatiaKitsEstoqueLi: componenteId ou n inválido');
  }
  const id = `${componenteId}~${String(n)}`;
  if (new TextEncoder().encode(id).length > MAX_BYTES_ID_DOCUMENTO) {
    throw new RangeError('idFatiaKitsEstoqueLi: id acima de 1 500 bytes');
  }
  return id;
}
