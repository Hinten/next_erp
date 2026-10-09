/**
 * The Loja Integrada token-expiry sweep — its BODY. Step 3 wraps it in a daily
 * `onSchedule` in the channel's functions codebase; step 2 ships and tests the
 * body offline, so the expiry tipo lands with its producer.
 *
 * A Personal Token lasts three months unless the store owner renews it in the
 * painel, and an unrenewed token is revoked for good: only the owner can
 * generate a new one. Nothing tells us it is about to lapse except the date the
 * operator copied, so this keeps the two avisos in step with every conta's
 * stored credential — while there is still time to act.
 *
 * ## Pass (a): every Loja Integrada conta, ACTIVE OR NOT
 *
 * `listarContasLojaIntegrada` — `where(tipo == 3).orderBy(nome)`, the declared
 * `(tipo, nome)` composite. Deliberately no `ativo` filter: deactivating a conta
 * in the ERP does not stop the token's clock, and silencing the warning would
 * turn a reversible ERP choice into a token only the owner can regenerate.
 * Removing the token is the way to silence it. Per conta:
 *
 *  - **no credential** → resolve BOTH rows as `credencial-removida`: the
 *    expiry row clockless, the reconexão row CLOCKED by the credential read's
 *    `readTime` (`lerCredencialComLeitura`). A token saved and parked after
 *    that read raised at a later commit time, so this resolve is the stale one
 *    and leaves its row open — a clockless one would close it for good, since
 *    every later raise of that park carries the same clock. The price: the
 *    clock moves every tick, so a conta with no token costs one aviso write
 *    per tick (the resolved row's watermark advancing) plus a seed whenever
 *    retention has swept the row. The clockless expiry resolve also closes a
 *    sweep raise that landed after a removal's resolve.
 *  - **expiry**: `dias <= LIMIAR_AVISO_TOKEN_LI_DIAS` raises, else resolves —
 *    the one decision in `sincronizarAvisoDeExpiracao`, shared with the routes.
 *  - **parked** → raise the reconexão aviso at the credential document's commit
 *    time (µs of `updateTime`); **not parked** → resolve it with that same
 *    clock. A repeat at an equal clock is dropped, so a daily re-raise costs no
 *    write once the first one landed.
 *
 * ⚠️ **Per-conta containment.** A `LiCredencialInvalidaError` (one corrupt
 * credential) or a gRPC status error (`isGrpcStatusError`) is recorded in
 * `erros` and the walk moves on; anything else rethrows out of the sweep — a
 * coding bug must fail the tick loudly. Without it one corrupt credential
 * would cost every other conta its warning. `escreverAviso`'s
 * persistent-contention error is deliberately NOT contained (the Shopee
 * reasoning: three lost preconditions on one aviso row is a real problem).
 *
 * ## Pass (b): open avisos of contas that no longer exist
 *
 * `avisos` is server-owned with no dismiss, so a deleted conta's rows would
 * otherwise stand for ever. The page query is `resolvidoEm == null` ordered by
 * `criadoEm desc` — the collection's declared `(resolvidoEm ASC, criadoEm DESC)`
 * composite, no new index — at {@link PAGINA_AVISOS_ABERTOS} rows a page and at
 * most {@link MAX_PAGINAS_AVISOS_ABERTOS} pages, with a `truncado` flag. The
 * canal and the two tipos are filtered in CODE (no index can express them), and
 * a row whose id is not one of pass (a)'s chaves is resolved as
 * `conta-removida` — an expiry row clockless, a reconexão row CLOCKED by the
 * conta enumeration's `readTime` (`resolverAvisoDeContaRemovida`): a conta
 * created and parked after that list was read raised at a later clock and is
 * left open for the next tick, which lists it. Rows of existing contas are pass
 * (a)'s, never touched here.
 *
 * The cursor is the last row's snapshot, and the server seeks past its VALUES:
 * a row this pass resolved is no longer in the result, and paging continues
 * after it all the same.
 *
 * ⚠️ **Known limit.** `criadoEm DESC` reaches the NEWEST open rows, while the
 * rows this pass exists to close are the OLDEST: beyond
 * `PAGINA × MAX_PAGINAS` (1 000) open avisos across the whole repo they are
 * never reached. It is Shopee's registered limit
 * (`apps/shopee/lib/shopee/pedidos/reservaTravadaSweep.ts`), and `criadoEm ASC`
 * is not the fix for the reasons recorded there. The cure is a discriminated
 * `(canal, tipo, resolvidoEm, criadoEm)` composite — an index deploy, so
 * migration-window work, surfaced in the step-2 plan and not opened here.
 *
 * No clock is read here: `nowMs` is a parameter, and the µs conversions all
 * happen in `avisos/avisos.ts`.
 */
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { avisoCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import { CANAL_AVISO } from '@delfrance/schemas';

import {
  MOTIVO_AVISO_LI,
  TIPOS_AVISO_LI,
  avisarReconexaoPendente,
  chaveExpiracao,
  chaveReconexao,
  resolverAvisoDeContaRemovida,
  resolverExpiracaoToken,
  resolverReconexaoPendente,
  sincronizarAvisoDeExpiracao,
} from '../avisos/avisos';
import { type ContaLojaIntegradaResumo, listarContasLojaIntegrada } from '../core/contas';
import { lerCredencialComLeitura } from '../core/credentialStore';
import { LiCredencialInvalidaError } from '../core/erros';

/** Open avisos read per page in pass (b). */
export const PAGINA_AVISOS_ABERTOS = 200;
/** Pages read at most in pass (b) — see the known limit in the header. */
export const MAX_PAGINAS_AVISOS_ABERTOS = 5;

export interface SweepLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ExpiracaoSweepDeps {
  /** `(by) => FieldValue.increment(by)` — see `avisos/avisos.ts`. */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. */
  readonly nowMs: number;
  readonly logger?: SweepLogger;
}

export interface ExpiracaoSweepErro {
  /** `conta` = pass (a), per conta; `orfaos` = pass (b), per row or its page query. */
  readonly etapa: 'conta' | 'orfaos';
  /** The conta id (pass a) or the aviso id (pass b). */
  readonly id: string;
  readonly erro: string;
}

export interface ExpiracaoSweepResult {
  /** Loja Integrada contas walked in pass (a), active or not. */
  readonly contas: number;
  /** Of those, the contas holding no credential. */
  readonly semCredencial: number;
  /** Of those, the contas whose credential is parked. */
  readonly estacionadas: number;
  readonly expiracao: {
    /** Raised or refreshed (a stale drop does not count). */
    readonly avisados: number;
    /** Rows actually closed. */
    readonly resolvidos: number;
    readonly resultados: Record<ResultadoAviso, number>;
  };
  readonly reconexao: { readonly avisados: number; readonly resolvidos: number };
  readonly orfaos: {
    readonly lidos: number;
    readonly paginas: number;
    /** The last page read was full: older open rows may remain unread. */
    readonly truncado: boolean;
    readonly resolvidos: number;
  };
  readonly erros: readonly ExpiracaoSweepErro[];
}

/**
 * The per-conta (and per-row) containment boundary: an expected failure family
 * is recorded and the walk continues; anything else rethrows.
 */
function contido(err: unknown): err is Error {
  return err instanceof LiCredencialInvalidaError || isGrpcStatusError(err);
}

function loggerDe(deps: ExpiracaoSweepDeps): SweepLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

/** The operator-facing name; the conta id only for a malformed legacy row. */
function nomeDaLoja(conta: ContaLojaIntegradaResumo): string {
  return conta.nome === '' ? conta.integracaoId : conta.nome;
}

export async function sweepLojaIntegradaTokenExpiry(
  db: Firestore,
  deps: ExpiracaoSweepDeps,
): Promise<ExpiracaoSweepResult> {
  const logger = loggerDe(deps);
  const avisoDeps = { increment: deps.increment, nowMs: deps.nowMs, logger };
  const erros: ExpiracaoSweepErro[] = [];
  const resultados: Record<ResultadoAviso, number> = {
    criado: 0,
    repetido: 0,
    reaberto: 0,
    ignorado: 0,
  };
  let semCredencial = 0;
  let estacionadas = 0;
  let expAvisados = 0;
  let expResolvidos = 0;
  let recAvisados = 0;
  let recResolvidos = 0;

  /* ---- pass (a): every Loja Integrada conta, active or not ---------------- */
  const { contas, leituraUs: listaLidaEmUs } = await listarContasLojaIntegrada(db);

  for (const conta of contas) {
    const { integracaoId } = conta;
    try {
      const { lida, leituraUs } = await lerCredencialComLeitura(db, integracaoId);
      const lojaNome = nomeDaLoja(conta);
      if (lida === null) {
        semCredencial += 1;
        if (
          await resolverExpiracaoToken(
            db,
            integracaoId,
            MOTIVO_AVISO_LI.credencialRemovida,
            avisoDeps,
          )
        ) {
          expResolvidos += 1;
        }
        // Clocked by WHEN the absence was read, never clockless (header).
        if (
          await resolverReconexaoPendente(
            db,
            integracaoId,
            MOTIVO_AVISO_LI.credencialRemovida,
            avisoDeps,
            { relogioUs: leituraUs, lojaNome },
          )
        ) {
          recResolvidos += 1;
        }
        continue;
      }

      const { credencial, versaoUs } = lida;

      const exp = await sincronizarAvisoDeExpiracao(
        db,
        { integracaoId, lojaNome, tokenExpiraEmMs: credencial.tokenExpiraEmMs },
        MOTIVO_AVISO_LI.validadeEmDia,
        avisoDeps,
      );
      if (exp.acao === 'avisado') {
        resultados[exp.resultado] += 1;
        if (exp.resultado !== 'ignorado') expAvisados += 1;
      } else if (exp.fechou) {
        expResolvidos += 1;
      }

      const parada = credencial.reconexaoPendente;
      if (parada !== null) {
        estacionadas += 1;
        const { resultado } = await avisarReconexaoPendente(
          db,
          { integracaoId, lojaNome, status: parada.status, relogioUs: versaoUs },
          avisoDeps,
        );
        if (resultado !== 'ignorado') recAvisados += 1;
      } else if (
        await resolverReconexaoPendente(
          db,
          integracaoId,
          MOTIVO_AVISO_LI.semReconexaoPendente,
          avisoDeps,
          { relogioUs: versaoUs, lojaNome },
        )
      ) {
        recResolvidos += 1;
      }
    } catch (err) {
      if (!contido(err)) throw err;
      erros.push({ etapa: 'conta', id: integracaoId, erro: err.message });
      logger.warn('[loja-integrada/expiracao] conta contida após falha', {
        integracaoId,
        erro: err.message,
      });
    }
  }

  /* ---- pass (b): open rows of contas that no longer exist ----------------- */
  const chavesExistentes = new Set<string>();
  for (const conta of contas) {
    chavesExistentes.add(chaveExpiracao(conta.integracaoId));
    chavesExistentes.add(chaveReconexao(conta.integracaoId));
  }

  let lidos = 0;
  let paginas = 0;
  let truncado = false;
  let orfaosResolvidos = 0;
  // The cursor is the real document SNAPSHOT: the SDK's `startAfter` treats any
  // other object as a field VALUE, which would page from the wrong place. The
  // server seeks past the snapshot's values, so a cursor row this pass just
  // resolved still marks the page boundary.
  let cursor: QueryDocumentSnapshot | null = null;

  while (paginas < MAX_PAGINAS_AVISOS_ABERTOS) {
    let docs: QueryDocumentSnapshot[];
    try {
      const base = avisoCollection
        .ref(db, {})
        .where('resolvidoEm', '==', null)
        .orderBy('criadoEm', 'desc')
        .limit(PAGINA_AVISOS_ABERTOS);
      const snap = await (cursor === null ? base : base.startAfter(cursor)).get();
      docs = snap.docs;
    } catch (err) {
      if (!isGrpcStatusError(err)) throw err;
      erros.push({ etapa: 'orfaos', id: 'consulta', erro: err.message });
      logger.warn('[loja-integrada/expiracao] consulta de avisos abertos falhou', {
        erro: err.message,
      });
      break;
    }
    paginas += 1;
    lidos += docs.length;

    for (const doc of docs) {
      const row = doc.data() as Record<string, unknown> | undefined;
      if (row?.canal !== CANAL_AVISO.lojaIntegrada) continue;
      if (typeof row.tipo !== 'string' || !TIPOS_AVISO_LI.has(row.tipo)) continue;
      if (chavesExistentes.has(doc.id)) continue;
      try {
        if (await resolverAvisoDeContaRemovida(db, doc.id, listaLidaEmUs, avisoDeps)) {
          orfaosResolvidos += 1;
        }
      } catch (err) {
        if (!isGrpcStatusError(err)) throw err;
        erros.push({ etapa: 'orfaos', id: doc.id, erro: err.message });
        logger.warn('[loja-integrada/expiracao] aviso órfão contido após falha', {
          chave: doc.id,
          erro: err.message,
        });
      }
    }

    const ultimo = docs[docs.length - 1];
    if (docs.length < PAGINA_AVISOS_ABERTOS || ultimo === undefined) break;
    cursor = ultimo;
    // A full last page means older open rows may remain beyond the cap.
    if (paginas === MAX_PAGINAS_AVISOS_ABERTOS) truncado = true;
  }

  return {
    contas: contas.length,
    semCredencial,
    estacionadas,
    expiracao: { avisados: expAvisados, resolvidos: expResolvidos, resultados },
    reconexao: { avisados: recAvisados, resolvidos: recResolvidos },
    orfaos: { lidos, paginas, truncado, resolvidos: orfaosResolvidos },
    erros,
  };
}
