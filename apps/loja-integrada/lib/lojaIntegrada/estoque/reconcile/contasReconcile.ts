/**
 * The daily stock reconcile's UNCACHED re-reads of the contas (master plan step 12, PR 12-g).
 *
 * ## Is a conta still the one the run took? ({@link reverContasDoRunLi})
 *
 * The queue phase (before each of its slices) and the end phase read every conta of the run again
 * by id, because a run lasts hours. A conta whose depósito moved since the take — or that is gone,
 * no longer a Loja Integrada conta, or inactive — is NOT the conta the snapshot was built for, so
 * nothing more of the run is sent for it, and its avisos are left to the next run. (Every send the
 * run already enqueued carries the run's depósito, and the send run drops one whose conta names
 * another: `processarEstoque.ts`, step 4.)
 *
 * ONE `getAll` per call, by id (point reads, no index), never `contaCache.ts`: what it decides is a
 * send. The depósito is folded by the shared reader (`depositoDaContaLi`, either stored form), and
 * compared with the bare id the take fixed in the conta's root (`execucao.depositoId`) EXACTLY.
 *
 * Equal (available): the take fixed `D1`, the conta now holds `documents/depositos/D1` or
 * `depositos/D1`. Distinct (`deposito-mudou`): it holds `documents/depositos/D2`, or no depósito.
 *
 * ## Does a depósito change ask for a new full run? ({@link revisaoDeDepositoNaLiberacaoLi})
 *
 * The conta trigger's depósito arm (`gatilhoDepositoLi.ts`) enqueues a full run for a re-pointed
 * conta, and a run holding the lease refuses it (`ocupado`). So the running chain asks for ONE full
 * run itself, after its release, named by the newest conta update time it saw
 * ({@link idExecucaoRedepositoLi}), recorded in the run counter {@link CONTADOR_DEPOSITO_MUDOU_LI}
 * — by the arm's own rule: only a conta that is active and HAS a depósito (none → nothing to send
 * to). Two moments record it:
 *
 *  - the queue phase, when it drops a conta's candidates because its depósito moved
 *    ({@link depositoQuePedeRevisaoLi}): those sends are lost to this run whatever happens next — a
 *    change undone before the release (`D1 → D2 → D1`) included;
 *  - the RELEASE, once: the contas listed again (the take's own query) — an active conta with a
 *    depósito whose depósito is not the one the run fixed, or that the run did not take at all (it
 *    was inactive, or had none, at the take). A conta CREATED during the run and never written
 *    since is not one: the arm never fires on a create, and the next night bootstraps it. The
 *    listing reads only `integracao`, and only the suspects are read again by id (for their
 *    stamps): in the steady state the release costs ONE query.
 *
 * Between the release's listing and its commit no arm run can slip in: the reads queue dispatches
 * one task at a time (`filaLeitura.ts`, `maxConcurrentDispatches: 1`), so the arm's task runs only
 * after the slice that releases — and finds the lease free.
 *
 * Next-free, `db` a parameter. Every line elsewhere carries ids only; this module logs nothing.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO, depositoDaContaLi } from '@delfrance/schemas';

import { agoraUsDe, relogioDoDocumentoUs } from '../../avisos/avisos';
import { listarContasLojaIntegrada } from '../../core/contas';

/** The run counter that remembers a depósito change asking for a new run (module header), in µs. */
export const CONTADOR_DEPOSITO_MUDOU_LI = 'depositoMudouEmUs';

/** The id of the full run a depósito change asks for, after this one (module header). */
export function idExecucaoRedepositoLi(versaoUs: number): string {
  return `estoque-reconcile-redeposito-${String(versaoUs)}`;
}

/** One conta, as read now. */
export interface ContaRevistaLi {
  readonly contaId: string;
  /** The document exists AND is a Loja Integrada conta. */
  readonly existe: boolean;
  /** `false` only when the document says so explicitly (the listing's rule). */
  readonly ativo: boolean;
  /** Its depósito as a bare id (`depositoDaContaLi`), or `null`. */
  readonly depositoId: string | null;
  /** The operator-facing store name (`''` when not a string). */
  readonly nome: string;
  /** µs of the read's `updateTime` (`null` when absent): names the depósito re-run. */
  readonly versaoUs: number | null;
  /** µs of the document's `createTime` (`null` when absent): a conta created during the run. */
  readonly criadaUs: number | null;
}

/** Why a conta is not the one the run's snapshot was built for. */
export type IndisponibilidadeContaLi = 'conta-ausente' | 'conta-inativa' | 'deposito-mudou';

/** Named members of {@link IndisponibilidadeContaLi}. */
export const INDISPONIBILIDADE_CONTA_LI = {
  ausente: 'conta-ausente',
  inativa: 'conta-inativa',
  depositoMudou: 'deposito-mudou',
} as const satisfies Record<string, IndisponibilidadeContaLi>;

/** Every conta of `contaIds`, read now, by id, in ONE `getAll` (module header). */
export async function reverContasDoRunLi(
  db: Firestore,
  contaIds: readonly string[],
): Promise<Map<string, ContaRevistaLi>> {
  const revistas = new Map<string, ContaRevistaLi>();
  if (contaIds.length === 0) return revistas;
  const snaps = await db.getAll(...contaIds.map((id) => integracaoCollection.docRef(db, {}, id)));
  contaIds.forEach((contaId, n) => {
    const snap = snaps[n];
    const dados: Readonly<Record<string, unknown>> | undefined = snap?.exists
      ? (snap.data() as Record<string, unknown> | undefined)
      : undefined;
    const existe = dados !== undefined && dados.tipo === INTEGRACAO_TIPO.lojaIntegrada;
    revistas.set(contaId, {
      contaId,
      existe,
      ativo: existe && dados.ativo !== false,
      depositoId: existe ? depositoDaContaLi(dados) : null,
      nome: existe && typeof dados.nome === 'string' ? dados.nome : '',
      versaoUs:
        snap?.exists === true && snap.updateTime !== undefined
          ? relogioDoDocumentoUs(snap.updateTime)
          : null,
      criadaUs:
        snap?.exists === true && snap.createTime !== undefined
          ? relogioDoDocumentoUs(snap.createTime)
          : null,
    });
  });
  return revistas;
}

/**
 * Why `conta` is not the conta the run fixed at `depositoDoRun`, or `null` when it is (module
 * header). Pure. Absent from the map counts as gone.
 */
export function indisponibilidadeDaContaLi(
  conta: ContaRevistaLi | undefined,
  depositoDoRun: string,
): IndisponibilidadeContaLi | null {
  if (conta === undefined || !conta.existe) return INDISPONIBILIDADE_CONTA_LI.ausente;
  if (!conta.ativo) return INDISPONIBILIDADE_CONTA_LI.inativa;
  if (conta.depositoId !== depositoDoRun) return INDISPONIBILIDADE_CONTA_LI.depositoMudou;
  return null;
}

/**
 * The µs a conta's depósito change asks a new full run by, or `0` when it asks for none (module
 * header): the conta is active, has a depósito, that depósito is not `depositoDoRun` (`undefined`:
 * the run did not take the conta) — and it is not a conta created at or after `runIniciadoEmUs`
 * and never written since. Pure. ⚠️ NEAR-MISS: `D1 → D2` asks; `D1 → none` does not (the arm's own
 * rule: nothing to send to).
 */
export function depositoQuePedeRevisaoLi(
  conta: ContaRevistaLi | undefined,
  depositoDoRun: string | undefined,
  runIniciadoEmUs: number,
): number {
  if (conta === undefined || !conta.existe || !conta.ativo || conta.depositoId === null) return 0;
  if (conta.depositoId === depositoDoRun || conta.versaoUs === null) return 0;
  const criadaNoRun =
    depositoDoRun === undefined &&
    conta.criadaUs !== null &&
    conta.criadaUs >= runIniciadoEmUs &&
    conta.criadaUs === conta.versaoUs;
  return criadaNoRun ? 0 : conta.versaoUs;
}

/**
 * The release's check (module header): the contas listed again, and the newest stamp of a conta
 * whose depósito asks for a new full run (`0`: none). `fixados` maps each conta the run took to the
 * depósito its root fixed. ONE query; the suspects only are read again by id, in ONE `getAll`.
 */
export async function revisaoDeDepositoNaLiberacaoLi(
  db: Firestore,
  args: {
    readonly fixados: ReadonlyMap<string, string>;
    readonly runIniciadoEmMs: number;
  },
): Promise<number> {
  const { contas } = await listarContasLojaIntegrada(db);
  const suspeitas = contas
    .filter(
      (c) => c.ativo && c.depositoId !== null && args.fixados.get(c.integracaoId) !== c.depositoId,
    )
    .map((c) => c.integracaoId);
  if (suspeitas.length === 0) return 0;
  const revistas = await reverContasDoRunLi(db, suspeitas);
  let maior = 0;
  for (const contaId of suspeitas) {
    maior = Math.max(
      maior,
      depositoQuePedeRevisaoLi(
        revistas.get(contaId),
        args.fixados.get(contaId),
        agoraUsDe({ nowMs: args.runIniciadoEmMs }),
      ),
    );
  }
  return maior;
}
