/**
 * **The single-flight lease of a native kit CREATE** (#1912) — the I/O half of
 * `@delfrance/schemas`' `kitCriacaoShopee` (the reading, the constants, the
 * codes and the ADR 0011 mapping live there).
 *
 * `add_kit_item` is NOT idempotent: before this lease, two tabs, two operators,
 * or the CLI beside the web could each pass the same-SKU scan and each create a
 * kit (register 303, test RT15). Now every create arm — `kit-criar`,
 * `kit-recriar`, `kit-converter`, from the route and from `publicar:anuncio
 * --live` — runs, per (conta, kit produto):
 *
 *  1. {@link reservarCriacaoDeKit} BEFORE `prepararKit` reads the links: a
 *     `create()` of the lease, or the takeover of one that reads `livre`.
 *     Another run's live lease ⇒ 409 `SHOPEE_KIT_CRIACAO_EM_ANDAMENTO` with its
 *     `aguardarMs`, and ZERO Shopee calls. Because the links are read only
 *     under the lease, a run that comes after another run's release sees that
 *     run's link and resumes as `completar`, never as a second create.
 *  2. {@link podeContinuarNaReserva} — the scan's deadline checkpoint.
 *  3. {@link liberarParaEnvio}, right before `add_kit_item`: the credential is
 *     warmed, the send gate checked (`dentroDoPrazoDeEnvio` against the lease's
 *     `ateMs` and the request's ceiling), and the lease STAMPED (`enviadoEmMs`,
 *     `sku`) under a token check + `lastUpdateTime` precondition — the fresh
 *     ownership check of ADR 0011 condition 4. Any miss ⇒ 409
 *     `SHOPEE_KIT_CRIACAO_EXPIRADA`, nothing sent.
 *  4. {@link liberarReserva} once the run KNOWS: nothing was sent (a refusal, a
 *     `nao-criado`, a `completar`), or the new kit's link is written. After an
 *     `incerto` — or any throw once the send started — the lease is KEPT and
 *     expires on its own (stamped: `ateMs` + the post-send grace).
 *
 * Every write is tier 0/1 of root rule 7 (a `create()`, or an `update`/`delete`
 * under the read's `lastUpdateTime`, re-decided at most
 * {@link TENTATIVAS_DA_RESERVA} times) — this folder still opens no
 * multi-document atomic block, and this file never spells its API.
 *
 * Clock-free: every instant is `controles.agora()`, the route's (or the CLI's)
 * live clock. There is deliberately no fallback to `nowMs` (a constant clock
 * makes the send gate vacuous).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  CODIGO_CRIACAO_KIT_SHOPEE,
  CRIACAO_KIT_SHOPEE_TTL_MS,
  criacaoKitShopeeSchema,
  estadoDaCriacaoDeKitShopee,
  type ArmaDaCriacaoDeKitShopee,
  type CodigoCriacaoKitShopee,
  type CriacaoKitShopee,
} from '@delfrance/schemas';
import { kitCriacaoShopeeCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';

import {
  dentroDoPrazoDeEnvio,
  type ControlesDaPublicacaoAoVivo,
} from '../anuncios/reservaRascunho';
import { isGrpcCodedError } from '../core/containment';
import { idDaCriacaoDeKit } from './idsKit';

/** How many times a lost `create()` / precondition is re-read and re-decided. */
export const TENTATIVAS_DA_RESERVA = 3;

/** The clock and deadline the lease needs — the route's (or the CLI's) live controls. */
export type ControlesDaReservaDeKit = Pick<
  ControlesDaPublicacaoAoVivo,
  'agora' | 'prazoDaRequisicao' | 'aquecerCredencial'
>;

/**
 * A kit create the lease refused. Every code means THIS run sent nothing to
 * Shopee. An APP class, never a `ShopeeError`: the route maps it to a 409
 * BEFORE `isShopeeError`, and no Shopee-error ladder may read it.
 */
export class ConflitoDeCriacaoDeKitShopeeError extends Error {
  readonly code: CodigoCriacaoKitShopee;
  /** MILLISECONDS until another attempt can be taken, when waiting helps; else `null`. */
  readonly aguardarMs: number | null;

  constructor(args: {
    readonly code: CodigoCriacaoKitShopee;
    readonly mensagem: string;
    readonly aguardarMs?: number | null;
  }) {
    super(args.mensagem);
    this.name = 'ConflitoDeCriacaoDeKitShopeeError';
    this.code = args.code;
    this.aguardarMs = args.aguardarMs ?? null;
  }
}

/** Whole minutes, rounded UP, for a sentence — never for a decision. */
function minutos(ms: number): string {
  const m = Math.max(Math.ceil(ms / 60_000), 1);
  return m === 1 ? '1 minuto' : `${String(m)} minutos`;
}

export function conflitoKitEmAndamento(aguardarMs: number): ConflitoDeCriacaoDeKitShopeeError {
  return new ConflitoDeCriacaoDeKitShopeeError({
    code: CODIGO_CRIACAO_KIT_SHOPEE.emAndamento,
    aguardarMs,
    mensagem:
      'outra criação deste kit nativo nesta conta está em andamento — nada foi enviado; ' +
      `aguarde ${minutos(aguardarMs)} e tente de novo`,
  });
}

export function conflitoKitExpirado(motivo: string): ConflitoDeCriacaoDeKitShopeeError {
  return new ConflitoDeCriacaoDeKitShopeeError({
    code: CODIGO_CRIACAO_KIT_SHOPEE.expirada,
    mensagem: `${motivo} — nada foi enviado à Shopee; tente de novo`,
  });
}

function conflitoKitContencao(): ConflitoDeCriacaoDeKitShopeeError {
  return new ConflitoDeCriacaoDeKitShopeeError({
    code: CODIGO_CRIACAO_KIT_SHOPEE.contencao,
    mensagem:
      'não foi possível reservar a criação deste kit nativo (escritas concorrentes) — nada foi ' +
      'enviado; tente de novo',
  });
}

export function conflitoKitVinculosMudaram(): ConflitoDeCriacaoDeKitShopeeError {
  return new ConflitoDeCriacaoDeKitShopeeError({
    code: CODIGO_CRIACAO_KIT_SHOPEE.vinculosMudaram,
    mensagem:
      'este produto passou a ter um anúncio ativo nesta conta — a primeira publicação como kit ' +
      'nativo não se aplica mais; nada foi enviado. Recarregue a página',
  });
}

/** What a run holds while it may be on its way to `add_kit_item`. */
export interface ReservaDeCriacaoDeKit {
  readonly docId: string;
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly token: string;
  /** MILLISECONDS. */
  readonly desdeMs: number;
  /** MILLISECONDS — `desdeMs + CRIACAO_KIT_SHOPEE_TTL_MS`. */
  readonly ateMs: number;
  readonly controles: ControlesDaReservaDeKit;
  /**
   * Where the run is — MUTATED by the applier, read by the arm's wrapper:
   * `tomada` (nothing sent: the wrapper releases), `enviando` (the send may
   * have left: the lease is KEPT), `encerrada` (released, or deliberately
   * kept — nothing more to do).
   */
  fase: 'tomada' | 'enviando' | 'encerrada';
}

function refDaReserva(db: Firestore, docId: string) {
  return kitCriacaoShopeeCollection.docRef(db, {}, docId);
}

/** A lost `create()` or precondition, or a document gone since the read: re-decided. */
function perdeuACorrida(err: unknown): boolean {
  return isAlreadyExists(err) || isFailedPrecondition(err) || isNotFound(err);
}

/**
 * Take the create lease of one kit produto on one conta (module header, step 1).
 *
 * @throws ConflitoDeCriacaoDeKitShopeeError `emAndamento` while another run
 *   holds it; `contencao` after {@link TENTATIVAS_DA_RESERVA} lost races.
 */
export async function reservarCriacaoDeKit(
  db: Firestore,
  alvo: {
    readonly integracaoId: string;
    readonly produtoId: string;
    readonly arma: ArmaDaCriacaoDeKitShopee;
  },
  controles: ControlesDaReservaDeKit,
): Promise<ReservaDeCriacaoDeKit> {
  const docId = idDaCriacaoDeKit(alvo.integracaoId, alvo.produtoId);
  const ref = refDaReserva(db, docId);
  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_RESERVA; tentativa += 1) {
    const snap = await ref.get();
    const agora = controles.agora();
    if (snap.exists) {
      const estado = estadoDaCriacaoDeKitShopee(snap.data(), agora);
      if (estado.tipo === 'em-andamento') throw conflitoKitEmAndamento(estado.aguardarMs);
    }
    const lease: CriacaoKitShopee = {
      v: 1,
      integracaoId: alvo.integracaoId,
      produtoId: alvo.produtoId,
      arma: alvo.arma,
      token: kitCriacaoShopeeCollection.newDocId(db, {}),
      desdeMs: agora,
      ateMs: agora + CRIACAO_KIT_SHOPEE_TTL_MS,
      enviadoEmMs: null,
      sku: null,
    };
    try {
      if (snap.exists) {
        // A takeover of a lease that reads `livre` (expired, or corrupt —
        // ADR 0011 condition 3). Delete-then-create, never an `update` over it:
        // a corrupt document's stray keys would survive an update and keep it
        // unreadable for ever. Both writes lose cleanly to a racing taker.
        await ref.delete({ lastUpdateTime: snap.updateTime });
      }
      await ref.create(kitCriacaoShopeeCollection.parse(lease));
    } catch (err) {
      if (!perdeuACorrida(err)) throw err;
      continue;
    }
    return {
      docId,
      integracaoId: alvo.integracaoId,
      produtoId: alvo.produtoId,
      token: lease.token,
      desdeMs: lease.desdeMs,
      ateMs: lease.ateMs,
      controles,
      fase: 'tomada',
    };
  }
  throw conflitoKitContencao();
}

/**
 * The scan's deadline checkpoint (module header, step 2): `true` while a send
 * would still fit before `min(ateMs, prazoDaRequisicao)` with the margin — the
 * SAME comparison as the send gate, never a second copy (#1369).
 */
export function podeContinuarNaReserva(reserva: ReservaDeCriacaoDeKit): () => boolean {
  return () => dentroDoPrazoDeEnvio({ expiraEm: reserva.ateMs }, reserva.controles);
}

/**
 * Right before `add_kit_item` (module header, step 3): warm the credential,
 * check the send gate, then STAMP the lease as ours under a fresh read. Leaves
 * `fase = 'enviando'` — from here on the lease is kept unless the applier
 * learns nothing was created.
 *
 * @param sku the `item_sku` the body carries (`''` when it carries none).
 * @throws ConflitoDeCriacaoDeKitShopeeError `expirada` — nothing sent.
 */
export async function liberarParaEnvio(
  db: Firestore,
  reserva: ReservaDeCriacaoDeKit,
  sku: string,
): Promise<void> {
  if (reserva.fase !== 'tomada') {
    throw new Error(`[shopee/kits] envio de kit com a reserva em fase ${reserva.fase}`);
  }
  // Warmed FIRST: a token refresh has no deadline, and it must run before the
  // gate reads the clock, never between the gate and the send.
  await reserva.controles.aquecerCredencial();
  if (!dentroDoPrazoDeEnvio({ expiraEm: reserva.ateMs }, reserva.controles)) {
    throw conflitoKitExpirado('a criação do kit não cabe mais no prazo desta publicação');
  }
  const ref = refDaReserva(db, reserva.docId);
  const snap = await ref.get();
  const lido = snap.exists ? criacaoKitShopeeSchema.safeParse(snap.data()) : null;
  const estado = estadoDaCriacaoDeKitShopee(snap.data(), reserva.controles.agora());
  if (
    lido === null ||
    !lido.success ||
    lido.data.token !== reserva.token ||
    estado.tipo !== 'em-andamento'
  ) {
    throw conflitoKitExpirado('a reserva desta criação de kit não é mais desta execução');
  }
  try {
    await ref.update(
      { enviadoEmMs: reserva.controles.agora(), sku },
      { lastUpdateTime: snap.updateTime },
    );
  } catch (err) {
    if (!perdeuACorrida(err)) throw err;
    throw conflitoKitExpirado('a reserva desta criação de kit mudou antes do envio');
  }
  reserva.fase = 'enviando';
}

/**
 * MILLISECONDS a STAMPED lease of this run keeps other runs out — the 202's
 * `aguardarMs` after an `incerto` (the lease is kept, not released). Always a
 * positive integer.
 */
export function esperaDaReservaEnviada(reserva: ReservaDeCriacaoDeKit): number {
  const fim = reserva.ateMs + AGUARDAR_KIT_INCERTO_SHOPEE_MS;
  const agora = reserva.controles.agora();
  const restante = Number.isFinite(agora) ? fim - agora : fim - reserva.desdeMs;
  return Math.max(1, Math.ceil(restante));
}

/**
 * Hand the lease back (module header, step 4): token-fenced — a lease another
 * run took over is never touched — and under the read's `lastUpdateTime`.
 * Sets `fase = 'encerrada'`.
 *
 * BEST EFFORT: a Firestore failure here is logged and swallowed — the run's
 * real outcome (a refusal, a created kit) must reach the caller, and a lease
 * that could not be deleted simply expires on its own.
 */
export async function liberarReserva(db: Firestore, reserva: ReservaDeCriacaoDeKit): Promise<void> {
  reserva.fase = 'encerrada';
  const ref = refDaReserva(db, reserva.docId);
  try {
    const snap = await ref.get();
    if (!snap.exists) return;
    const lido = criacaoKitShopeeSchema.safeParse(snap.data());
    if (!lido.success || lido.data.token !== reserva.token) return;
    await ref.delete({ lastUpdateTime: snap.updateTime });
  } catch (err) {
    // A concurrent change means the lease is no longer ours to delete; any
    // other Firestore failure leaves it to expire. Anything else is our bug.
    if (!perdeuACorrida(err) && !isGrpcCodedError(err)) throw err;
    console.warn('[shopee/kits] a reserva da criação de kit não foi liberada; ela expira sozinha', {
      integracaoId: reserva.integracaoId,
      produtoId: reserva.produtoId,
      codigo: (err as { readonly code?: unknown }).code ?? null,
    });
  }
}
