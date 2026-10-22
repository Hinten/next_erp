/**
 * The Amazon expiry sweep — its BODY. Step 3 wraps it in a daily `onSchedule`
 * in the channel's functions codebase; step 2 ships and tests the body offline,
 * so the four aviso tipos land with their producers.
 *
 * Three passes. No clock is read here (`nowMs` is a parameter) and every µs
 * conversion happens in `avisos/avisos.ts`.
 *
 * ## Pass (a): every Amazon conta, ACTIVE OR NOT
 *
 * `listarContasAmazon` — `where(tipo == 8).orderBy(nome)`, the EXISTING
 * `(tipo, nome)` composite. No `ativo` filter: deactivating a conta in the ERP
 * does not stop Amazon's 365-day clock. A conta lacking `nome` falls outside
 * (pinned in `contas.test.ts`). Per conta, ONE strict credential read:
 *
 *  - **no credential** → resolve BOTH per-conta rows as `credencial-ausente`:
 *    the reauthorization row clockless, the reconexão row CLOCKED by the read's
 *    `readTime` — never clockless, so a park committed after that read keeps
 *    its row;
 *  - **reauthorization**: ≤ `LIMIAR_AVISO_AMAZON_DIAS` São Paulo civil days left
 *    raises (29 and 30 warn, a past date too), more resolves — the one decision
 *    in `sincronizarAvisoDeReautorizacao`;
 *  - **parked** → raise the reconexão row at the document's commit time (µs of
 *    `updateTime`); **not parked** → resolve it with that same clock. A repeat
 *    at an equal clock is dropped, so a daily re-raise costs no write.
 *
 * ⚠️ **Per-conta containment** of `CredencialAmazonInvalidaError` (one corrupt
 * credential) or a gRPC status error (`isGrpcStatusError`) only: recorded in
 * `erros`, and the walk moves on. Anything else rethrows out of the sweep —
 * `escreverAviso`'s persistent-contention error included (three lost
 * preconditions on one row is a real problem; the Shopee reasoning).
 *
 * ## Pass (b): open per-conta avisos of contas that no longer exist
 *
 * `resolvidoEm == null` ordered by `criadoEm desc` — the EXISTING
 * `avisos (resolvidoEm ASC, criadoEm DESC)` composite — at
 * {@link PAGINA_AVISOS_ABERTOS} rows a page and at most
 * {@link MAX_PAGINAS_AVISOS_ABERTOS} pages, with a `truncado` flag. Canal and
 * tipo are filtered in CODE (no index can express them). A row whose id is not
 * one of the LISTED contas' chaves is resolved as `conta-removida`: a reconexão
 * row and a step-4 import-stopped row CLOCKED by the enumeration's `readTime`
 * (`resolverAvisoDeContaRemovida`), a reauthorization row clockless. A conta
 * created after that read — and then parked, or failing to import — raised at a
 * later clock, so its row stays open and the next run lists it.
 *
 * ⚠️ Every per-conta tipo's chave is in the existing set, the import-stopped one
 * included: its row belongs to the backstop poll (`pedidos/pollPedidos.ts`)
 * while the conta exists, and leaving its chave out would close a LIVE conta's
 * open import-stopped row on every run. Listed contas are active OR inactive, so
 * a deactivated conta's row is never closed here (a documented residue: the
 * poll skips the conta, so the row waits for a reactivation or a deletion).
 *
 * ⚠️ **Known limit** (Loja Integrada's and Shopee's, the same query): beyond
 * `PAGINA × MAX_PAGINAS` (1 000) open avisos repo-wide, the OLDEST rows — the
 * ones this pass exists for — are never reached. The cure is a discriminated
 * composite index, which is migration-window work; surfaced in the step-2 plan,
 * not opened here.
 *
 * ## Pass (c): the APP secret, only while `AMAZON_CHAMADAS === 'on'`
 *
 * Off means skipped (and logged): before the window the legacy integration owns
 * the secret and its deadline is tracked by hand. On:
 * `AMAZON_LWA_SEGREDO_EXPIRA_EM` exact `YYYY-MM-DD` and a real date (nothing
 * trimmed) → ≤ 30 days raises with `dias` + `expiraEm`, more resolves; unset or
 * invalid → raised WITHOUT a date (an unknown deadline is the riskier state).
 */
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { avisoCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import { CANAL_AVISO, LIMIAR_AVISO_AMAZON_DIAS, diasAteDataCivilAmazon } from '@delfrance/schemas';

import {
  MOTIVO_AVISO_AMAZON,
  TIPOS_AVISO_AMAZON_POR_CONTA,
  avisarReconexaoPendente,
  avisarSegredoLwaExpirando,
  chaveImportacaoParada,
  chaveReautorizacao,
  chaveReconexao,
  resolverAvisoDeContaRemovida,
  resolverReautorizacao,
  resolverReconexaoPendente,
  resolverSegredoLwaExpirando,
  sincronizarAvisoDeReautorizacao,
} from '../avisos/avisos';
import { type ContaAmazonResumo, listarContasAmazon } from '../core/contas';
import { lerCredencialComLeitura } from '../core/credentialStore';
import { CredencialAmazonInvalidaError } from '../core/erros';
import type { LoggerAmazon } from '../core/log';
import { lerChaveDeChamadasAmazon } from '../core/valvulas';
import { type AmbienteAmazon, lerSegredoExpiraEm } from '../env';

/** Open avisos read per page in pass (b). */
export const PAGINA_AVISOS_ABERTOS = 200;
/** Pages read at most in pass (b) — see the known limit in the header. */
export const MAX_PAGINAS_AVISOS_ABERTOS = 5;

export interface ExpiracaoSweepAmazonDeps {
  /** `(by) => FieldValue.increment(by)` — see `avisos/avisos.ts`. */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. */
  readonly nowMs: number;
  /** The environment: the read switch and the secret's recorded date (pass c). */
  readonly ambiente: AmbienteAmazon;
  readonly logger: LoggerAmazon;
}

export interface ExpiracaoSweepAmazonErro {
  /** `conta` = pass (a); `orfaos` = pass (b); `segredo` = pass (c). */
  readonly etapa: 'conta' | 'orfaos' | 'segredo';
  /** The conta id (a), the aviso id or `consulta` (b), or `segredo` (c). */
  readonly id: string;
  /**
   * The error's CLASS name, never its message: step 3 logs this result, and an
   * `AmazonError` message embeds the request path, which can carry a seller id
   * (step-2b plan §3 decision 23).
   */
  readonly erro: string;
}

/** What pass (c) did. */
export type ResultadoSegredoAmazon =
  /** The read switch is off: not evaluated. */
  | { readonly acao: 'pulado' }
  | {
      readonly acao: 'avisado';
      readonly dias: number | null;
      /** `ausente` / `invalida` when raised without a date. */
      readonly data: 'valida' | 'ausente' | 'invalida';
      readonly resultado: ResultadoAviso;
    }
  | { readonly acao: 'resolvido'; readonly dias: number; readonly fechou: boolean }
  /** A gRPC failure, recorded in `erros`. */
  | { readonly acao: 'falhou' };

export interface ExpiracaoSweepAmazonResult {
  /** Amazon contas walked in pass (a), active or not. */
  readonly contas: number;
  /** Of those, the inactive ones (still warned). */
  readonly inativas: number;
  readonly semCredencial: number;
  readonly estacionadas: number;
  readonly reautorizacao: {
    /** Raised or refreshed (a stale drop does not count). */
    readonly avisados: number;
    readonly resolvidos: number;
  };
  readonly reconexao: { readonly avisados: number; readonly resolvidos: number };
  readonly orfaos: {
    readonly lidos: number;
    readonly paginas: number;
    /** The last page read was full at the page cap: older open rows may remain. */
    readonly truncado: boolean;
    readonly resolvidos: number;
  };
  readonly segredo: ResultadoSegredoAmazon;
  readonly erros: readonly ExpiracaoSweepAmazonErro[];
}

/** The containment boundary: an expected failure family is recorded; anything else rethrows. */
function contido(err: unknown): err is Error {
  return err instanceof CredencialAmazonInvalidaError || isGrpcStatusError(err);
}

/** The operator-facing name; the conta id only for a malformed legacy row. */
function nomeDaConta(conta: ContaAmazonResumo): string {
  return conta.nome === '' ? conta.integracaoId : conta.nome;
}

export async function sweepAmazonExpiracoes(
  db: Firestore,
  deps: ExpiracaoSweepAmazonDeps,
): Promise<ExpiracaoSweepAmazonResult> {
  const { logger } = deps;
  const avisoDeps = { increment: deps.increment, nowMs: deps.nowMs, logger };
  const erros: ExpiracaoSweepAmazonErro[] = [];
  let semCredencial = 0;
  let estacionadas = 0;
  let reauAvisados = 0;
  let reauResolvidos = 0;
  let recAvisados = 0;
  let recResolvidos = 0;

  /* ---- pass (a): every Amazon conta, active or not ------------------------ */
  const { contas, leituraUs: listaLidaEmUs } = await listarContasAmazon(db);

  for (const conta of contas) {
    const { integracaoId } = conta;
    try {
      const { lida, readTimeUs } = await lerCredencialComLeitura(db, integracaoId);
      const lojaNome = nomeDaConta(conta);
      if (lida === null) {
        semCredencial += 1;
        if (
          await resolverReautorizacao(
            db,
            integracaoId,
            MOTIVO_AVISO_AMAZON.credencialAusente,
            avisoDeps,
          )
        ) {
          reauResolvidos += 1;
        }
        // Clocked by WHEN the absence was read, never clockless (header).
        if (
          await resolverReconexaoPendente(
            db,
            integracaoId,
            MOTIVO_AVISO_AMAZON.credencialAusente,
            avisoDeps,
            { relogioUs: readTimeUs, lojaNome },
          )
        ) {
          recResolvidos += 1;
        }
        continue;
      }

      const { credencial, versaoUs } = lida;
      const reau = await sincronizarAvisoDeReautorizacao(
        db,
        { integracaoId, lojaNome, autorizadoEmMs: credencial.autorizadoEmMs },
        MOTIVO_AVISO_AMAZON.autorizacaoEmDia,
        avisoDeps,
      );
      if (reau.acao === 'avisado') {
        if (reau.resultado !== 'ignorado') reauAvisados += 1;
      } else if (reau.fechou) {
        reauResolvidos += 1;
      }

      const parada = credencial.reconexaoPendente;
      if (parada !== null) {
        estacionadas += 1;
        const { resultado } = await avisarReconexaoPendente(
          db,
          {
            integracaoId,
            lojaNome,
            status: parada.status,
            codigoLwa: parada.codigoLwa,
            relogioUs: versaoUs,
          },
          avisoDeps,
        );
        if (resultado !== 'ignorado') recAvisados += 1;
      } else if (
        await resolverReconexaoPendente(
          db,
          integracaoId,
          MOTIVO_AVISO_AMAZON.semReconexaoPendente,
          avisoDeps,
          { relogioUs: versaoUs, lojaNome },
        )
      ) {
        recResolvidos += 1;
      }
    } catch (err) {
      if (!contido(err)) throw err;
      erros.push({ etapa: 'conta', id: integracaoId, erro: err.name });
      logger.warn('[amazon/expiracao] conta contida após falha', {
        integracaoId,
        erro: err.name,
      });
    }
  }

  /* ---- pass (b): open per-conta rows of contas that no longer exist ------- */
  const chavesExistentes = new Set<string>();
  for (const conta of contas) {
    chavesExistentes.add(chaveReconexao(conta.integracaoId));
    chavesExistentes.add(chaveReautorizacao(conta.integracaoId));
    // The poll's row while the conta exists (header): never an orphan.
    chavesExistentes.add(chaveImportacaoParada(conta.integracaoId));
  }

  let lidos = 0;
  let paginas = 0;
  let truncado = false;
  let orfaosResolvidos = 0;
  // The cursor is the real document SNAPSHOT: the SDK's `startAfter` treats any
  // other object as a field VALUE. The server seeks past the snapshot's values,
  // so a cursor row this pass just resolved still marks the page boundary.
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
      erros.push({ etapa: 'orfaos', id: 'consulta', erro: err.name });
      logger.warn('[amazon/expiracao] consulta de avisos abertos falhou', { code: err.code });
      break;
    }
    paginas += 1;
    lidos += docs.length;

    for (const doc of docs) {
      const row = doc.data() as Record<string, unknown> | undefined;
      if (row?.canal !== CANAL_AVISO.amazon) continue;
      if (typeof row.tipo !== 'string' || !TIPOS_AVISO_AMAZON_POR_CONTA.has(row.tipo)) continue;
      if (chavesExistentes.has(doc.id)) continue;
      try {
        if (await resolverAvisoDeContaRemovida(db, doc.id, listaLidaEmUs, avisoDeps)) {
          orfaosResolvidos += 1;
        }
      } catch (err) {
        if (!isGrpcStatusError(err)) throw err;
        erros.push({ etapa: 'orfaos', id: doc.id, erro: err.name });
        logger.warn('[amazon/expiracao] aviso órfão contido após falha', {
          chave: doc.id,
          code: err.code,
        });
      }
    }

    const ultimo = docs[docs.length - 1];
    if (docs.length < PAGINA_AVISOS_ABERTOS || ultimo === undefined) break;
    cursor = ultimo;
    if (paginas === MAX_PAGINAS_AVISOS_ABERTOS) truncado = true;
  }

  /* ---- pass (c): the app secret, only while the read switch is on --------- */
  const segredo = await passoDoSegredo(db, deps, avisoDeps, erros);

  return {
    contas: contas.length,
    inativas: contas.filter((c) => !c.ativo).length,
    semCredencial,
    estacionadas,
    reautorizacao: { avisados: reauAvisados, resolvidos: reauResolvidos },
    reconexao: { avisados: recAvisados, resolvidos: recResolvidos },
    orfaos: { lidos, paginas, truncado, resolvidos: orfaosResolvidos },
    segredo,
    erros,
  };
}

async function passoDoSegredo(
  db: Firestore,
  deps: ExpiracaoSweepAmazonDeps,
  avisoDeps: {
    readonly increment: (by: number) => unknown;
    readonly nowMs: number;
    readonly logger: LoggerAmazon;
  },
  erros: ExpiracaoSweepAmazonErro[],
): Promise<ResultadoSegredoAmazon> {
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    deps.logger.info('[amazon/expiracao] segredo do LWA não avaliado: chamadas desligadas', {
      evento: 'segredo-pulado',
    });
    return { acao: 'pulado' };
  }
  const lido = lerSegredoExpiraEm(deps.ambiente);
  try {
    if (lido.tipo !== 'valida') {
      deps.logger.warn('[amazon/expiracao] data de vencimento do segredo do LWA desconhecida', {
        data: lido.tipo,
      });
      const { resultado } = await avisarSegredoLwaExpirando(db, { dataCivil: null }, avisoDeps);
      return { acao: 'avisado', dias: null, data: lido.tipo, resultado };
    }
    const dias = diasAteDataCivilAmazon(lido.dataCivil, deps.nowMs);
    if (dias <= LIMIAR_AVISO_AMAZON_DIAS) {
      const { resultado } = await avisarSegredoLwaExpirando(
        db,
        { dataCivil: lido.dataCivil },
        avisoDeps,
      );
      return { acao: 'avisado', dias, data: 'valida', resultado };
    }
    const fechou = await resolverSegredoLwaExpirando(
      db,
      MOTIVO_AVISO_AMAZON.segredoEmDia,
      avisoDeps,
    );
    return { acao: 'resolvido', dias, fechou };
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    erros.push({ etapa: 'segredo', id: 'segredo', erro: err.name });
    deps.logger.warn('[amazon/expiracao] aviso do segredo contido após falha', { code: err.code });
    return { acao: 'falhou' };
  }
}
