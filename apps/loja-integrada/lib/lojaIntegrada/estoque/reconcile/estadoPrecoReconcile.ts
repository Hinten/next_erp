/**
 * The daily reconcile's per-conta PRICE state as one slice holds it (master plan step 13, PR
 * 13-f1): the conta's price root `sincPrecoLojaIntegrada/{conta}` (this run's `execucaoPreco`) and
 * its 32 snapshot buckets — read once per slice, changed in memory, and written back in the
 * slice's end-of-slice batch beside the stock state (`despachoReconcile.ts`), each document
 * `create`d when absent and otherwise `update`d under THIS slice's read of it (root `CLAUDE.md`
 * rule 7, tier 1: the batch also rides the run document's own precondition). The sibling of
 * `snapshotReconcile.ts`, apart from it so the stock state's shape never moves.
 *
 * ## Which contas are priced
 *
 * A conta is priced by the run when its root's `execucaoPreco` is THIS run's — the take wrote it,
 * with the tabelas the run fixed (`execucaoReconcile.ts`). A root of another run, or one off its
 * schema, is not this run's conta: it is left out of the loaded map, its buckets ignored, and no
 * price phase touches it. (The stock state stops the slice on such a root; the price arm only
 * skips the conta — a price problem never stops the stock flow.)
 *
 * ## A bucket of another run is replaced at load
 *
 * A bucket whose `execucaoId` is another run's — or that is off its schema, or absent — is
 * replaced on load by an empty one of this run, marked to be written, so the first ERP slice
 * writes all 32 and by the end of the walk every bucket carries this run's id. From a bucket of
 * another run that parses, every VALID entry's previous target and deferral move into the new
 * bucket's `anteriores` (`{ ap: a, tp: t }`, absent keys omitted); nothing is carried from a
 * bucket off its schema. Writing a `v` entry for an id takes `ap` / `tp` back out of `anteriores`
 * and removes the key (`sincPrecoLojaIntegrada.ts`, "The life of an entry").
 *
 * ## Which entry wins ({@link mesclarEntradaPrecoLi}, pure)
 *
 *  - no entry yet ⇒ the new one;
 *  - the SAME produto again ⇒ the new one (a re-evaluation; a `v` keeps the `ap`/`tp` it took);
 *  - an existing `dup` stays `dup`;
 *  - another produto ⇒ `{ p: the first, f: 'dup' }` — a NEW duplicate, counted `duplicados`.
 *
 * Equal (one produto): `v(p1)` then `v(p1)`. Distinct: `v(p1)` then `v(p2)` ⇒ `dup`; `pai(p1)`
 * then `v(p2)` ⇒ `dup`.
 *
 * ## Where the price counters and samples live
 *
 * In the conta's own root (`execucaoPreco.contadores`, `.amostras`), never in the run document:
 * the stock's `ultimoReconcile` never picks one up, and the run document's byte budget stays the
 * stock's.
 *
 * Next-free, `db` a parameter, every access through a `@delfrance/data/admin/collections` handle.
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here (`estrutura.test.ts`).
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import {
  sincPrecoLojaIntegradaCollection,
  snapshotPrecoLiCollection,
} from '@delfrance/data/admin/collections';
import {
  type AlvoSnapshotPrecoLi,
  type AnteriorPrecoLi,
  type EntradaSnapshotPrecoLi,
  type ExecucaoContaPrecoLi,
  FLAG_ENTRADA_PRECO_LI,
  MAX_AMOSTRA_AVISO_PRECO_LI,
  type MotivoAmostraPrecoLi,
  type TabelasPrecoLi,
  type UltimoReconcilePrecoLi,
  alvoSnapshotPrecoLiSchema,
  baldeSnapshotEstoqueLi,
  entradaSnapshotPrecoLiSchema,
  execucaoContaPrecoLiSchema,
  snapshotPrecoLiSchema,
  ultimoReconcilePrecoLiSchema,
} from '@delfrance/schemas';

import type { EscritaSincLi } from './execucaoReconcile';
import { IDS_BALDES_SNAPSHOT_LI } from './snapshotReconcile';

/** One priced conta of the run: its index in `contas`, its id and the tabelas the run fixed. */
export interface ContaPrecoDoRunLi {
  readonly idx: number;
  readonly contaId: string;
  readonly tabelas: TabelasPrecoLi;
}

/** What {@link mesclarEntradaPrecoLi} decided. */
export interface MesclaEntradaPrecoLi {
  readonly entrada: EntradaSnapshotPrecoLi;
  /** Whether this made a NEW duplicate (counted once per id). */
  readonly novoDuplicado: boolean;
}

/** Which entry wins (module header). Pure. */
export function mesclarEntradaPrecoLi(
  existente: EntradaSnapshotPrecoLi | undefined,
  nova: EntradaSnapshotPrecoLi,
): MesclaEntradaPrecoLi {
  if (existente === undefined || existente.p === nova.p) {
    return { entrada: nova, novoDuplicado: false };
  }
  if (existente.f === FLAG_ENTRADA_PRECO_LI.duplicado) {
    return { entrada: existente, novoDuplicado: false };
  }
  return {
    entrada: { p: existente.p, f: FLAG_ENTRADA_PRECO_LI.duplicado },
    novoDuplicado: true,
  };
}

/** A price document as one slice read it: its ref, the stamp of that read (`null` = absent). */
interface DocLidoPrecoLi {
  readonly ref: DocumentReference;
  versao: Timestamp | null;
  sujo: boolean;
}

/** One bucket in memory: its entries and the carry of the previous run. */
interface BaldePrecoLi extends DocLidoPrecoLi {
  readonly e: Map<string, EntradaSnapshotPrecoLi>;
  readonly anteriores: Map<string, AnteriorPrecoLi>;
}

/** The root in memory: this run's `execucaoPreco`, and the conta's end once it is set. */
interface RaizPrecoLi extends DocLidoPrecoLi {
  execucaoPreco: ExecucaoContaPrecoLi;
  /** The run's end for this conta (`fimPrecoReconcile.ts`), written only once set. */
  ultimoReconcilePreco: UltimoReconcilePrecoLi | null;
}

/** Sorted by key, as a stored map is written (a stable document). */
function ordenado<T>(m: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** One conta's price state in memory (module header). */
export class EstadoContaPrecoLi {
  readonly conta: ContaPrecoDoRunLi;
  readonly raiz: RaizPrecoLi;
  /** The buckets this slice loaded, by id (`'00'`..`'31'`); empty when loaded without them. */
  readonly baldes: ReadonlyMap<string, BaldePrecoLi>;
  private readonly execucaoId: string;

  constructor(args: {
    readonly conta: ContaPrecoDoRunLi;
    readonly execucaoId: string;
    readonly raiz: RaizPrecoLi;
    readonly baldes: ReadonlyMap<string, BaldePrecoLi>;
  }) {
    this.conta = args.conta;
    this.execucaoId = args.execucaoId;
    this.raiz = args.raiz;
    this.baldes = args.baldes;
  }

  /** Whether the 32 buckets are loaded (the ERP side and the parents unit need them). */
  get comBaldes(): boolean {
    return this.baldes.size === IDS_BALDES_SNAPSHOT_LI.length;
  }

  private balde(idLi: string): BaldePrecoLi {
    const id = baldeSnapshotEstoqueLi(idLi);
    const balde = id === null ? undefined : this.baldes.get(id);
    if (balde === undefined) throw new RangeError('estado de preço do reconcile: balde ausente');
    return balde;
  }

  /** The entry of `idLi`, or `undefined`. Throws `RangeError` on a non-canonical id or no bucket. */
  entrada(idLi: string): EntradaSnapshotPrecoLi | undefined {
    return this.balde(idLi).e.get(idLi);
  }

  /**
   * Records one ALREADY-PARSED entry under the precedence rule (module header); a `v` entry takes
   * the id's carried `ap` / `tp` (from `anteriores`, else from the entry of the same produto it
   * replaces). Returns whether a NEW duplicate was made, and counts it `duplicados`.
   */
  aplicar(idLi: string, nova: EntradaSnapshotPrecoLi): boolean {
    const balde = this.balde(idLi);
    const existente = balde.e.get(idLi);
    let entrada = nova;
    if (nova.f === FLAG_ENTRADA_PRECO_LI.valido) {
      const carregado =
        balde.anteriores.get(idLi) ??
        (existente !== undefined &&
        existente.p === nova.p &&
        existente.f === FLAG_ENTRADA_PRECO_LI.valido
          ? { ap: existente.ap, tp: existente.tp }
          : undefined);
      const { ap, tp, ...resto } = nova;
      const novoAp = carregado?.ap ?? ap;
      const novoTp = carregado?.tp ?? tp;
      entrada = {
        ...resto,
        ...(novoAp == null ? {} : { ap: novoAp }),
        ...(novoTp == null ? {} : { tp: novoTp }),
      };
      if (balde.anteriores.delete(idLi)) balde.sujo = true;
    }
    const { entrada: vencedora, novoDuplicado } = mesclarEntradaPrecoLi(existente, entrada);
    balde.e.set(idLi, vencedora);
    balde.sujo = true;
    if (novoDuplicado) this.contar('duplicados');
    return novoDuplicado;
  }

  /** Every entry of one bucket (`'00'`..`'31'`), or none when the bucket is not loaded. */
  *entradasDoBalde(id: string): Generator<readonly [string, EntradaSnapshotPrecoLi]> {
    const balde = this.baldes.get(id);
    if (balde !== undefined) yield* balde.e;
  }

  /** Every entry of every loaded bucket. */
  *entradas(): Generator<readonly [string, EntradaSnapshotPrecoLi]> {
    for (const balde of this.baldes.values()) yield* balde.e;
  }

  /** Sets a VALID entry's target (the parents unit). Throws `RangeError` for any other entry. */
  definirAlvo(idLi: string, alvo: AlvoSnapshotPrecoLi): void {
    const balde = this.balde(idLi);
    const atual = balde.e.get(idLi);
    if (atual?.f !== FLAG_ENTRADA_PRECO_LI.valido) {
      throw new RangeError('estado de preço do reconcile: alvo numa entrada que não é válida');
    }
    balde.e.set(idLi, { ...atual, a: alvoSnapshotPrecoLiSchema.parse(alvo) });
    balde.sujo = true;
  }

  /** Clears every loaded bucket's carry (the parents unit's end). */
  limparAnteriores(): void {
    for (const balde of this.baldes.values()) {
      if (balde.anteriores.size === 0) continue;
      balde.anteriores.clear();
      balde.sujo = true;
    }
  }

  /** The conta's price counter `nome` (0 when unset). */
  contador(nome: string): number {
    return this.raiz.execucaoPreco.contadores[nome] ?? 0;
  }

  /** Adds `n` to the conta's price counter `nome` (nothing for 0). */
  contar(nome: string, n = 1): void {
    if (n === 0) return;
    this.raiz.execucaoPreco = {
      ...this.raiz.execucaoPreco,
      contadores: {
        ...this.raiz.execucaoPreco.contadores,
        [nome]: this.contador(nome) + n,
      },
    };
    this.raiz.sujo = true;
  }

  /** Adds produto ids to a sample, deduplicated, at most {@link MAX_AMOSTRA_AVISO_PRECO_LI}. */
  amostrar(motivo: MotivoAmostraPrecoLi, produtoIds: readonly string[]): void {
    const atual = this.raiz.execucaoPreco.amostras[motivo] ?? [];
    const novos = [...new Set(produtoIds)].filter((id) => !atual.includes(id));
    if (novos.length === 0 || atual.length >= MAX_AMOSTRA_AVISO_PRECO_LI) return;
    this.raiz.execucaoPreco = {
      ...this.raiz.execucaoPreco,
      amostras: {
        ...this.raiz.execucaoPreco.amostras,
        [motivo]: [...atual, ...novos].slice(0, MAX_AMOSTRA_AVISO_PRECO_LI),
      },
    };
    this.raiz.sujo = true;
  }

  /** The conta's sample `motivo`, sorted (ids only). */
  amostra(motivo: MotivoAmostraPrecoLi): string[] {
    return [...(this.raiz.execucaoPreco.amostras[motivo] ?? [])].sort();
  }

  /**
   * The conta's end of the run (`fimPrecoReconcile.ts`): its `ultimoReconcilePreco`, parsed, and
   * the store read's cursor cleared — written with the rest of the root, so the slice never writes
   * the root twice.
   */
  encerrar(ultimo: UltimoReconcilePrecoLi): void {
    this.raiz.ultimoReconcilePreco = ultimoReconcilePrecoLiSchema.parse(ultimo);
    this.raiz.sujo = true;
  }

  /** The writes of every document changed in memory, each WHOLE and parsed (module header). */
  escritas(): EscritaSincLi[] {
    const saida: EscritaSincLi[] = [];
    if (this.raiz.sujo) {
      saida.push({
        tipo: 'gravar',
        ref: this.raiz.ref,
        versao: this.raiz.versao,
        dados: sincPrecoLojaIntegradaCollection.parseMerge({
          execucaoPreco: this.raiz.execucaoPreco,
          ...(this.raiz.ultimoReconcilePreco === null
            ? {}
            : { ultimoReconcilePreco: this.raiz.ultimoReconcilePreco, reconcilePreco: null }),
        }),
      });
    }
    for (const balde of this.baldes.values()) {
      if (!balde.sujo) continue;
      saida.push({
        tipo: 'gravar',
        ref: balde.ref,
        versao: balde.versao,
        // `anteriores` ALWAYS, an emptied one as `{}`: an `update` keeps a field it omits.
        dados: snapshotPrecoLiSchema.parse({
          execucaoId: this.execucaoId,
          e: ordenado(balde.e),
          anteriores: ordenado(balde.anteriores),
        }),
      });
    }
    return saida;
  }

  /** After the batch landed: each written document's new stamp, and nothing left to write. */
  gravado(versoes: ReadonlyMap<string, Timestamp | null>): void {
    for (const doc of [this.raiz, ...this.baldes.values()]) {
      if (!doc.sujo) continue;
      const versao = versoes.get(doc.ref.path);
      if (versao !== undefined) doc.versao = versao;
      doc.sujo = false;
    }
  }
}

/** Whether the buckets are loaded with the roots (`todos`) or not (`nenhum`). */
export type BaldesDoCarregamentoPrecoLi = 'todos' | 'nenhum';

/** The previous run's carry of a bucket of another run that parses (module header). */
function anterioresDe(
  e: Readonly<Record<string, EntradaSnapshotPrecoLi>>,
  id: string,
): Map<string, AnteriorPrecoLi> {
  const saida = new Map<string, AnteriorPrecoLi>();
  for (const [idLi, entrada] of Object.entries(e)) {
    if (entrada.f !== FLAG_ENTRADA_PRECO_LI.valido || baldeSnapshotEstoqueLi(idLi) !== id) continue;
    const anterior: AnteriorPrecoLi = {
      ...(entrada.a == null ? {} : { ap: entrada.a }),
      ...(entrada.t === true ? { tp: true as const } : {}),
    };
    if (Object.keys(anterior).length > 0) saida.set(idLi, anterior);
  }
  return saida;
}

/** One bucket as read: this run's kept, any other replaced (module header). */
function baldeLido(snap: DocumentSnapshot, id: string, execucaoId: string): BaldePrecoLi {
  const dados: unknown = snap.exists ? snap.data() : undefined;
  const lido = snapshotPrecoLiSchema.safeParse(dados);
  const versao = snap.exists ? (snap.updateTime ?? null) : null;
  const doBalde = <T>(m: Readonly<Record<string, T>>): Map<string, T> =>
    new Map(Object.entries(m).filter(([idLi]) => baldeSnapshotEstoqueLi(idLi) === id));
  if (lido.success && lido.data.execucaoId === execucaoId) {
    return {
      ref: snap.ref,
      versao,
      sujo: false,
      e: doBalde(lido.data.e),
      anteriores: doBalde(lido.data.anteriores),
    };
  }
  return {
    ref: snap.ref,
    versao,
    sujo: true,
    e: new Map(),
    anteriores: lido.success ? anterioresDe(lido.data.e, id) : new Map(),
  };
}

/**
 * The price state of every conta of `contas` that THIS run priced (module header, "Which contas
 * are priced"), by conta id: their roots in ONE `getAll`, then — with `baldes: 'todos'` — the 32
 * buckets of the priced ones in ONE more. A conta whose root is not this run's is absent from the
 * map. No read for an empty list.
 */
export async function carregarEstadosPrecoLi(
  db: Firestore,
  execucaoId: string,
  contas: readonly { readonly idx: number; readonly contaId: string }[],
  opcoes: { readonly baldes: BaldesDoCarregamentoPrecoLi },
): Promise<Map<string, EstadoContaPrecoLi>> {
  const estados = new Map<string, EstadoContaPrecoLi>();
  if (contas.length === 0) return estados;
  const raizes = await db.getAll(
    ...contas.map((c) => sincPrecoLojaIntegradaCollection.docRef(db, {}, c.contaId)),
  );
  const precificadas: { readonly conta: ContaPrecoDoRunLi; readonly snap: DocumentSnapshot }[] = [];
  contas.forEach((c, n) => {
    const snap = raizes[n];
    if (snap === undefined || !snap.exists) return;
    const bruto: Readonly<Record<string, unknown>> = snap.data() ?? {};
    const execucao = execucaoContaPrecoLiSchema.safeParse(
      Object.hasOwn(bruto, 'execucaoPreco') ? bruto.execucaoPreco : undefined,
    );
    if (!execucao.success || execucao.data.execucaoId !== execucaoId) return;
    precificadas.push({
      conta: { idx: c.idx, contaId: c.contaId, tabelas: execucao.data.tabelas },
      snap,
    });
  });
  if (precificadas.length === 0) return estados;

  const porConta = new Map<string, Map<string, BaldePrecoLi>>();
  if (opcoes.baldes === 'todos') {
    const snaps = await db.getAll(
      ...precificadas.flatMap(({ conta }) =>
        IDS_BALDES_SNAPSHOT_LI.map((id) =>
          snapshotPrecoLiCollection.docRef(db, { integracaoId: conta.contaId }, id),
        ),
      ),
    );
    precificadas.forEach(({ conta }, n) => {
      const baldes = new Map<string, BaldePrecoLi>();
      IDS_BALDES_SNAPSHOT_LI.forEach((id, b) => {
        const snap = snaps[n * IDS_BALDES_SNAPSHOT_LI.length + b];
        if (snap === undefined) throw new TypeError('reconcile: getAll sem um balde de preço');
        baldes.set(id, baldeLido(snap, id, execucaoId));
      });
      porConta.set(conta.contaId, baldes);
    });
  }

  for (const { conta, snap } of precificadas) {
    const bruto: Readonly<Record<string, unknown>> = snap.data() ?? {};
    estados.set(
      conta.contaId,
      new EstadoContaPrecoLi({
        conta,
        execucaoId,
        raiz: {
          ref: snap.ref,
          versao: snap.updateTime ?? null,
          sujo: false,
          execucaoPreco: execucaoContaPrecoLiSchema.parse(bruto.execucaoPreco),
          ultimoReconcilePreco: null,
        },
        baldes: porConta.get(conta.contaId) ?? new Map(),
      }),
    );
  }
  return estados;
}

/** An entry parsed as the snapshot stores it — the one check every caller's entry passes. */
export function entradaPrecoValidadaLi(entrada: unknown): EntradaSnapshotPrecoLi {
  return entradaSnapshotPrecoLiSchema.parse(entrada);
}
