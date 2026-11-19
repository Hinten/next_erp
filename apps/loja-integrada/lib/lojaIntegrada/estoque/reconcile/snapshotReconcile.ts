/**
 * The daily stock reconcile's per-conta STATE as one slice holds it (master plan step 12, PR 12-g):
 * the conta's root `sincEstoqueLojaIntegrada/{conta}` (the run's `execucao`), its 32 snapshot
 * buckets and its `pais` document — read ONCE per slice in one `getAll`, changed in memory, and
 * written back in the slice's end-of-slice batch (`execucaoReconcile.ts`), each document `create`d
 * when absent and otherwise `update`d under THIS slice's read of it.
 *
 * ## A document of another run is replaced at first touch
 *
 * A bucket (or `pais`) whose `execucaoId` is another run's — or that is off its schema — is
 * replaced by this run's on load, carrying forward ONLY its `x` entries (a store row no link of
 * the conta names: carried so the list walk does not look it up again every day; a later walk or
 * lookup of THIS run overrides it). The replaced document is marked to be written, so by the end of
 * the walk every bucket carries this run's id and the list walk never reads another run's `v`.
 *
 * ## Which entry wins ({@link mesclarEntradaSnapshotLi}, pure)
 *
 * Several produtos can name one store id of a conta. In this order:
 *
 *  - no entry yet ⇒ the new one;
 *  - a new `x` (a link whose produto is gone) never displaces anything, and is never counted as a
 *    second produto;
 *  - a stored `x` (carried, or from a gone produto) is displaced by any entry of a live produto;
 *  - the SAME produto again ⇒ the new entry (a re-evaluation);
 *  - two produtos ⇒ `dup` (`p` = the first, nothing sent), both produtos sampled; a third joins
 *    the sample.
 *
 * Equal (one produto): `v` then `v` of the same `p`. Distinct: `v` of `p1` then `v` of `p2` ⇒
 * `dup`; `amb` of `p1` then `v` of `p2` ⇒ `dup`; but `x` then `v` of `p1` ⇒ `v`.
 *
 * ## What the store's list walk adds (the `li` phase, `faseLi.ts`)
 *
 * The same state carries the conta's list walk: its cursor (the root's `reconcile`, written only
 * when the walk moved it), the store ids the walk has seen (the root's `execucao.vistos`, held as
 * a set and written sorted by numeric value), and the removal of a stale `x` entry once the whole
 * list was read without its row ({@link EstadoContaReconcileLi.removerSemVinculo}).
 *
 * Next-free, `db` a parameter, every access through a `@delfrance/data/admin/collections` handle.
 */
import type { DocumentReference, Firestore, Timestamp } from 'firebase-admin/firestore';
import {
  paisSnapshotEstoqueLiCollection,
  sincEstoqueLojaIntegradaCollection,
  snapshotEstoqueLiCollection,
} from '@delfrance/data/admin/collections';
import {
  BALDES_SNAPSHOT_ESTOQUE_LI,
  type EntradaSnapshotEstoqueLi,
  type ExecucaoContaEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  ID_PAIS_SNAPSHOT_ESTOQUE_LI,
  MAX_AMOSTRA_AVISO_ESTOQUE_LI,
  MOTIVO_AMOSTRA_ESTOQUE_LI,
  type MotivoAmostraEstoqueLi,
  type ReconcileContaEstoqueLi,
  type UltimoReconcileEstoqueLi,
  baldeSnapshotEstoqueLi,
  entradaSnapshotEstoqueLiSchema,
  execucaoContaEstoqueLiSchema,
  paisSnapshotEstoqueLiSchema,
  reconcileContaEstoqueLiSchema,
  snapshotEstoqueLiSchema,
  ultimoReconcileEstoqueLiSchema,
} from '@delfrance/schemas';

import { compararIdLi } from '../planoEstoqueLi';
import type { EscritaSincLi } from './execucaoReconcile';

/** One conta of the run: its index in `contas`, its id and the depósito the run fixed. */
export interface ContaDoRunLi {
  readonly idx: number;
  readonly contaId: string;
  readonly depositoId: string;
}

/**
 * A per-conta counter's stored name in the run document's `contadores`: the conta's index, then
 * the name (`c0Validos`).
 */
export function nomeDoContadorDaContaLi(idx: number, nome: string): string {
  return `c${String(idx)}${nome.charAt(0).toUpperCase()}${nome.slice(1)}`;
}

/** Every bucket id, `'00'` to `'31'`. */
export const IDS_BALDES_SNAPSHOT_LI: readonly string[] = Array.from(
  { length: BALDES_SNAPSHOT_ESTOQUE_LI },
  (_, n) => String(n).padStart(2, '0'),
);

/** What {@link mesclarEntradaSnapshotLi} decided. */
export interface MesclaEntradaLi {
  readonly entrada: EntradaSnapshotEstoqueLi;
  /** The produtos a NEW duplicate names (both on the first collision, the newcomer after). */
  readonly duplicados: readonly string[];
}

/** Which entry wins (module header). Pure. */
export function mesclarEntradaSnapshotLi(
  existente: EntradaSnapshotEstoqueLi | undefined,
  nova: EntradaSnapshotEstoqueLi,
): MesclaEntradaLi {
  if (existente === undefined) return { entrada: nova, duplicados: [] };
  if (nova.f === FLAG_ENTRADA_ESTOQUE_LI.semVinculo) {
    return { entrada: existente, duplicados: [] };
  }
  if (existente.f === FLAG_ENTRADA_ESTOQUE_LI.semVinculo || existente.p === nova.p) {
    return { entrada: nova, duplicados: [] };
  }
  const novoProduto = nova.p === null ? [] : [nova.p];
  if (existente.f === FLAG_ENTRADA_ESTOQUE_LI.duplicado) {
    return { entrada: existente, duplicados: novoProduto };
  }
  return {
    entrada: { p: existente.p, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.duplicado },
    duplicados: [...(existente.p === null ? [] : [existente.p]), ...novoProduto],
  };
}

/** A sinc document as one slice read it: its ref, the stamp of that read (`null` = absent). */
interface DocLidoLi {
  readonly ref: DocumentReference;
  versao: Timestamp | null;
  sujo: boolean;
}

/** One bucket in memory. */
interface BaldeLi extends DocLidoLi {
  readonly e: Map<string, EntradaSnapshotEstoqueLi>;
}

/** The parents document in memory. */
interface PaisLi extends DocLidoLi {
  readonly ids: Set<string>;
}

/**
 * The root in memory: its `execucao` (the ERP side and the list walk) and its `reconcile` cursor
 * (the list walk only, written only when `cursorSujo`).
 */
interface RaizLi extends DocLidoLi {
  execucao: ExecucaoContaEstoqueLi;
  reconcile: ReconcileContaEstoqueLi | null;
  cursorSujo: boolean;
  /** The run's end for this conta (`fimReconcile.ts`), written only once set. */
  ultimoReconcile: UltimoReconcileEstoqueLi | null;
}

/** Only the `x` entries of a bucket of another run (module header). */
function sobreviventes(dados: unknown): Map<string, EntradaSnapshotEstoqueLi> {
  const saida = new Map<string, EntradaSnapshotEstoqueLi>();
  const e =
    typeof dados === 'object' && dados !== null && Object.hasOwn(dados, 'e')
      ? Reflect.get(dados, 'e')
      : undefined;
  if (typeof e !== 'object' || e === null) return saida;
  for (const [idLi, bruta] of Object.entries(e as Record<string, unknown>)) {
    const entrada = entradaSnapshotEstoqueLiSchema.safeParse(bruta);
    if (
      entrada.success &&
      entrada.data.f === FLAG_ENTRADA_ESTOQUE_LI.semVinculo &&
      baldeSnapshotEstoqueLi(idLi) !== null
    ) {
      saida.set(idLi, { p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo });
    }
  }
  return saida;
}

/** One conta's state in memory (module header). */
export class EstadoContaReconcileLi {
  readonly conta: ContaDoRunLi;
  readonly raiz: RaizLi;
  readonly baldes: ReadonlyMap<string, BaldeLi>;
  readonly pais: PaisLi;
  private readonly execucaoId: string;
  /** `raiz.execucao.vistos` as a set: the one copy from load to write. */
  private readonly vistos: Set<string>;

  constructor(args: {
    conta: ContaDoRunLi;
    execucaoId: string;
    raiz: RaizLi;
    baldes: ReadonlyMap<string, BaldeLi>;
    pais: PaisLi;
  }) {
    this.conta = args.conta;
    this.execucaoId = args.execucaoId;
    this.raiz = args.raiz;
    this.baldes = args.baldes;
    this.pais = args.pais;
    this.vistos = new Set(args.raiz.execucao.vistos);
  }

  /** The entry of `idLi`, or `undefined`. Throws `RangeError` on a non-canonical id (a bug). */
  entrada(idLi: string): EntradaSnapshotEstoqueLi | undefined {
    return this.balde(idLi).e.get(idLi);
  }

  private balde(idLi: string): BaldeLi {
    const id = baldeSnapshotEstoqueLi(idLi);
    const balde = id === null ? undefined : this.baldes.get(id);
    if (balde === undefined) throw new RangeError('estado do reconcile: id da loja inválido');
    return balde;
  }

  /** Records one entry under the precedence rule; returns the produtos a new duplicate names. */
  aplicar(idLi: string, nova: EntradaSnapshotEstoqueLi): readonly string[] {
    const parsed = entradaSnapshotEstoqueLiSchema.parse(nova);
    const balde = this.balde(idLi);
    const { entrada, duplicados } = mesclarEntradaSnapshotLi(balde.e.get(idLi), parsed);
    balde.e.set(idLi, entrada);
    balde.sujo = true;
    if (duplicados.length > 0) this.amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.duplicado, duplicados);
    return duplicados;
  }

  /** Whether `idLi` is a parent's store id of this conta (its row is never sent). */
  ehPai(idLi: string): boolean {
    return this.pais.ids.has(idLi);
  }

  /** Removes an `x` entry (and only an `x` entry); whether one was removed. */
  removerSemVinculo(idLi: string): boolean {
    const balde = this.balde(idLi);
    if (balde.e.get(idLi)?.f !== FLAG_ENTRADA_ESTOQUE_LI.semVinculo) return false;
    balde.e.delete(idLi);
    balde.sujo = true;
    return true;
  }

  /** The list walk's cursor as stored (another run's included: the caller judges it). */
  cursor(): ReconcileContaEstoqueLi | null {
    return this.raiz.reconcile;
  }

  /** Replaces the list walk's cursor, parsed. */
  definirCursor(cursor: ReconcileContaEstoqueLi): void {
    this.raiz.reconcile = reconcileContaEstoqueLiSchema.parse(cursor);
    this.raiz.cursorSujo = true;
    this.raiz.sujo = true;
  }

  /** Whether the list walk of this run has seen or settled `idLi`. */
  visto(idLi: string): boolean {
    return this.vistos.has(idLi);
  }

  /** Records that the list walk saw or settled `idLi`. */
  marcarVisto(idLi: string): void {
    if (this.vistos.has(idLi)) return;
    this.vistos.add(idLi);
    this.raiz.sujo = true;
  }

  /** Forgets every store id seen: a list walk that starts over. */
  reiniciarVistos(): void {
    if (this.vistos.size === 0) return;
    this.vistos.clear();
    this.raiz.sujo = true;
  }

  /** A parent's store id. */
  adicionarPai(idLi: string): void {
    if (this.pais.ids.has(idLi)) return;
    this.pais.ids.add(idLi);
    this.pais.sujo = true;
  }

  /** Adds produto ids to a sample, deduplicated, at most {@link MAX_AMOSTRA_AVISO_ESTOQUE_LI}. */
  amostrar(motivo: MotivoAmostraEstoqueLi, produtoIds: readonly string[]): void {
    const atual = this.raiz.execucao.amostras[motivo] ?? [];
    const novos = [...new Set(produtoIds)].filter((id) => !atual.includes(id));
    if (novos.length === 0 || atual.length >= MAX_AMOSTRA_AVISO_ESTOQUE_LI) return;
    this.raiz.execucao = {
      ...this.raiz.execucao,
      amostras: {
        ...this.raiz.execucao.amostras,
        [motivo]: [...atual, ...novos].slice(0, MAX_AMOSTRA_AVISO_ESTOQUE_LI),
      },
    };
    this.raiz.sujo = true;
  }

  /**
   * The conta's end of the run (`fimReconcile.ts`): its `ultimoReconcile`, parsed, and the list
   * cursor cleared — written with the rest of the root, so the slice never writes the root twice.
   */
  encerrar(ultimo: UltimoReconcileEstoqueLi): void {
    this.raiz.ultimoReconcile = ultimoReconcileEstoqueLiSchema.parse(ultimo);
    this.raiz.reconcile = null;
    this.raiz.cursorSujo = true;
    this.raiz.sujo = true;
  }

  /** Replaces the run state's map cursor (or anything else of it), parsed. */
  atualizarExecucao(patch: Partial<ExecucaoContaEstoqueLi>): void {
    this.raiz.execucao = execucaoContaEstoqueLiSchema.parse({ ...this.raiz.execucao, ...patch });
    this.raiz.sujo = true;
  }

  /** Every entry of every bucket (the kits map is built from them). */
  *entradas(): Generator<readonly [string, EntradaSnapshotEstoqueLi]> {
    for (const balde of this.baldes.values()) yield* balde.e;
  }

  /** The writes of every document changed in memory, each whole and parsed (module header). */
  escritas(): EscritaSincLi[] {
    const saida: EscritaSincLi[] = [];
    if (this.raiz.sujo) {
      const execucao = { ...this.raiz.execucao, vistos: [...this.vistos].sort(compararIdLi) };
      saida.push({
        tipo: 'gravar',
        ref: this.raiz.ref,
        versao: this.raiz.versao,
        dados: sincEstoqueLojaIntegradaCollection.parseMerge({
          execucao,
          ...(this.raiz.cursorSujo ? { reconcile: this.raiz.reconcile } : {}),
          ...(this.raiz.ultimoReconcile === null
            ? {}
            : { ultimoReconcile: this.raiz.ultimoReconcile }),
        }),
      });
    }
    for (const balde of this.baldes.values()) {
      if (!balde.sujo) continue;
      saida.push({
        tipo: 'gravar',
        ref: balde.ref,
        versao: balde.versao,
        dados: snapshotEstoqueLiSchema.parse({
          execucaoId: this.execucaoId,
          e: Object.fromEntries([...balde.e].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        }),
      });
    }
    if (this.pais.sujo) {
      saida.push({
        tipo: 'gravar',
        ref: this.pais.ref,
        versao: this.pais.versao,
        dados: paisSnapshotEstoqueLiSchema.parse({
          execucaoId: this.execucaoId,
          ids: [...this.pais.ids].sort(),
        }),
      });
    }
    return saida;
  }

  /** After the batch landed: each written document's new stamp, and nothing left to write. */
  gravado(versoes: ReadonlyMap<string, Timestamp | null>): void {
    for (const doc of [this.raiz, this.pais, ...this.baldes.values()]) {
      if (!doc.sujo) continue;
      const versao = versoes.get(doc.ref.path);
      if (versao !== undefined) doc.versao = versao;
      doc.sujo = false;
    }
    this.raiz.cursorSujo = false;
  }
}

/**
 * The root, the 32 buckets and `pais` of every conta of the run (`contaIds`, the run document's
 * `contas` in order from index `primeiroIdx` — the list walk loads one conta at a time), in ONE
 * `getAll` (module header); each conta's depósito is the one its root's `execucao` fixed. A root
 * whose `execucao` is not THIS run's is a lease this slice does not hold: `null`, and the caller
 * stops.
 */
export async function carregarEstadosReconcileLi(
  db: Firestore,
  execucaoId: string,
  contaIds: readonly string[],
  primeiroIdx = 0,
): Promise<Map<string, EstadoContaReconcileLi> | null> {
  const estados = new Map<string, EstadoContaReconcileLi>();
  if (contaIds.length === 0) return estados;
  const refs = contaIds.flatMap((contaId) => [
    sincEstoqueLojaIntegradaCollection.docRef(db, {}, contaId),
    ...IDS_BALDES_SNAPSHOT_LI.map((id) =>
      snapshotEstoqueLiCollection.docRef(db, { integracaoId: contaId }, id),
    ),
    paisSnapshotEstoqueLiCollection.docRef(
      db,
      { integracaoId: contaId },
      ID_PAIS_SNAPSHOT_ESTOQUE_LI,
    ),
  ]);
  const snaps = await db.getAll(...refs);
  const porConta = IDS_BALDES_SNAPSHOT_LI.length + 2;
  for (const [n, contaId] of contaIds.entries()) {
    const fatia = snaps.slice(n * porConta, (n + 1) * porConta);
    const [snapRaiz, ...resto] = fatia;
    const snapPais = resto.pop();
    if (snapRaiz === undefined || snapPais === undefined) return null;

    const raizLida = sincEstoqueLojaIntegradaCollection.parseRead(
      snapRaiz.exists ? snapRaiz.data() : {},
    );
    const execucao = execucaoContaEstoqueLiSchema.safeParse(raizLida.execucao);
    if (!execucao.success || execucao.data.execucaoId !== execucaoId) return null;
    const conta: ContaDoRunLi = {
      idx: primeiroIdx + n,
      contaId,
      depositoId: execucao.data.depositoId,
    };
    const cursor = reconcileContaEstoqueLiSchema.safeParse(raizLida.reconcile);

    const baldes = new Map<string, BaldeLi>();
    resto.forEach((snap, b) => {
      const id = IDS_BALDES_SNAPSHOT_LI[b] ?? '';
      const dados: unknown = snap.exists ? snap.data() : undefined;
      const lido = snapshotEstoqueLiSchema.safeParse(dados);
      const doRun = lido.success && lido.data.execucaoId === execucaoId;
      baldes.set(id, {
        ref: snap.ref,
        versao: snap.exists ? (snap.updateTime ?? null) : null,
        sujo: !doRun,
        e: doRun
          ? new Map(
              Object.entries(lido.data.e).filter(([idLi]) => baldeSnapshotEstoqueLi(idLi) === id),
            )
          : sobreviventes(dados),
      });
    });

    const paisLido = paisSnapshotEstoqueLiSchema.safeParse(
      snapPais.exists ? snapPais.data() : undefined,
    );
    const paisDoRun = paisLido.success && paisLido.data.execucaoId === execucaoId;
    estados.set(
      contaId,
      new EstadoContaReconcileLi({
        conta,
        execucaoId,
        raiz: {
          ref: snapRaiz.ref,
          versao: snapRaiz.exists ? (snapRaiz.updateTime ?? null) : null,
          sujo: false,
          execucao: execucao.data,
          reconcile: cursor.success ? cursor.data : null,
          cursorSujo: false,
          ultimoReconcile: null,
        },
        baldes,
        pais: {
          ref: snapPais.ref,
          versao: snapPais.exists ? (snapPais.updateTime ?? null) : null,
          sujo: !paisDoRun,
          ids: new Set(paisDoRun ? paisLido.data.ids : []),
        },
      }),
    );
  }
  return estados;
}
