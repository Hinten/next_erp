/**
 * The daily reconcile's PRICE END (master plan step 13, PR 13-f1): per priced conta, in the run's
 * `contas` order, right after the conta's stock end unit in the SAME slice (`despachoReconcile.ts`:
 * the two never split), its `ultimoReconcilePreco` and the price avisos the run can decide.
 * Next-free, `db` a parameter.
 *
 * ## Which conta
 *
 *  - not priced by this run (no root of this run) ⇒ nothing;
 *  - GONE (or no longer a Loja Integrada conta, read uncached: `contasPrecoReconcile.ts`) ⇒
 *    nothing written — no root write, no aviso; the expiry sweep's orphan pass closes its rows;
 *  - otherwise `ultimoReconcilePreco = { execucaoId, iniciadoEmMs: the run's start, concluidoEmMs:
 *    now, tabelas: the tabelas the RUN fixed (never the conta's current ones), contadores: the
 *    conta's price counters }`, and the store read's cursor cleared — on the conta's root, in the
 *    slice's batch under the root's own read (tier 1).
 *
 * ## The avisos — only under `on`, live for the conta, available, and with no contained fault
 *
 * Written only when the price valve is EXACTLY `on` and live for the conta
 * (`valvulaLigadaParaContaLi`), the conta is still the one the run priced
 * (`indisponibilidadePrecoLi` is `null`: not inactive, tabelas unchanged) and its price arm had no
 * contained fault (`armaFalhou` 0: a partial snapshot never raises or resolves anything). Each is
 * clocked by the RUN's start (`relogioDoEnvioDeEstoqueUs`, the app's one conversion), so an older
 * run can neither reopen nor close a newer one's row. A count above 0 RAISES (a repeat replaces
 * `params`); 0 RESOLVES, only an OPEN row (one read, a write only on a real open → resolved
 * transition, never a seeded resolved row). A row the run cannot decide is left untouched.
 *
 * | Aviso | Count | Params | Decidable when |
 * | --- | --- | --- | --- |
 * | `lojaIntegradaPrecoSemErp` | `retidos` | `loja`, `produtos`, `ilegiveis`, `semPai`, `amostra` | the parents phase finished the conta (`paisConcluido`) |
 *
 * Not live for the conta ⇒ no aviso read or written: ONE INFO line per decidable non-zero row
 * instead — its count, its sample (ids only) and why the conta is unavailable, if it is — which is
 * what a dry-run review reads.
 *
 * Every line carries ids and counts only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { avisoCollection } from '@delfrance/data/admin/collections';
import { type PlanoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  MOTIVO_AMOSTRA_PRECO_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { agoraUsDe, relogioDoEnvioDeEstoqueUs } from '../../avisos/avisos';
import { type ValvulaLi, valvulaLigadaParaContaLi } from '../../core/valvulas';
import {
  type ContaPrecoRevistaLi,
  indisponibilidadePrecoLi,
  reverContasPrecoLi,
} from './contasPrecoReconcile';
import type { EstadoContaPrecoLi } from './estadoPrecoReconcile';
import { MOTIVO_RESOLUCAO_RECONCILE_LI } from './fimReconcile';
import { CONTADOR_ARMA_FALHOU_LI } from './paginaErpReconcile';
import { CONTADOR_PAIS_CONCLUIDO_LI } from './paisPrecoReconcile';

const TAG = '[loja-integrada/preco] reconcile';

/** What the price end needs of the slice's deps. */
export interface DepsFimPrecoReconcileLi {
  readonly agoraMs: () => number;
  /** A tier-0 `FieldValue.increment`, for the aviso writer's `ocorrencias`. */
  readonly increment: (by: number) => unknown;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** What one slice hands its price end. */
export interface ArgsFimPrecoReconcileLi {
  readonly db: Firestore;
  readonly deps: DepsFimPrecoReconcileLi;
  readonly execucaoId: string;
  /** MS. When the run began: the avisos' clock and `ultimoReconcilePreco.iniciadoEmMs`. */
  readonly runIniciadoEmMs: number;
  readonly contas: readonly string[];
  /** The PRICE valve. */
  readonly valvula: ValvulaLi;
  /**
   * The price states of the slice (loaded once per slice by the caller): a conta absent from it is
   * not priced by this run.
   */
  readonly estadoDe: (idx: number) => Promise<EstadoContaPrecoLi | null>;
}

/** One row the price end decides for a conta. */
export interface CasoDoFimPrecoLi {
  readonly tipo: typeof TIPO_AVISO.lojaIntegradaPrecoSemErp;
  readonly produtos: number;
  readonly params: Readonly<Record<string, number>>;
  readonly amostra: string[];
}

/** The rows a conta's counters can decide (module header's table). Pure. */
export function casosDoFimPrecoLi(estado: EstadoContaPrecoLi): readonly CasoDoFimPrecoLi[] {
  const casos: CasoDoFimPrecoLi[] = [];
  if (estado.contador(CONTADOR_PAIS_CONCLUIDO_LI) > 0) {
    casos.push({
      tipo: TIPO_AVISO.lojaIntegradaPrecoSemErp,
      produtos: estado.contador('retidos'),
      params: {
        ilegiveis: estado.contador('retidosIlegiveis'),
        semPai: estado.contador('retidosSemPai'),
      },
      amostra: estado.amostra(MOTIVO_AMOSTRA_PRECO_LI.retido),
    });
  }
  return casos;
}

/** The price end of ONE slice (module header). */
export class FimPrecoReconcileLi {
  private readonly args: ArgsFimPrecoReconcileLi;
  private revistas: Map<string, ContaPrecoRevistaLi> | null = null;

  constructor(args: ArgsFimPrecoReconcileLi) {
    this.args = args;
  }

  /** ONE conta's price end (module header). */
  async unidade(idx: number): Promise<void> {
    const { db, deps, execucaoId } = this.args;
    const contaId = this.args.contas[idx];
    if (contaId === undefined)
      throw new TypeError('fim de preço do reconcile: conta fora da lista');
    const estado = await this.args.estadoDe(idx);
    if (estado === null) return;
    this.revistas ??= await reverContasPrecoLi(db, this.args.contas);
    const revista = this.revistas.get(contaId);
    if (revista === undefined || !revista.existe) {
      deps.logger.info(`${TAG} conta ausente no fim — nada gravado para ela`, {
        execucaoId,
        contaId,
      });
      return;
    }

    const indisponivel = indisponibilidadePrecoLi(revista, estado.conta.tabelas);
    const casos = casosDoFimPrecoLi(estado);
    const ligada =
      indisponivel === null &&
      estado.contador(CONTADOR_ARMA_FALHOU_LI) === 0 &&
      valvulaLigadaParaContaLi(this.args.valvula, contaId);
    if (ligada) {
      for (const caso of casos) await this.aviso(contaId, revista.nome, caso);
    } else {
      for (const caso of casos) {
        if (caso.produtos === 0) continue;
        deps.logger.info(`${TAG} achado de preço da conta (sem aviso)`, {
          execucaoId,
          contaId,
          tipo: caso.tipo,
          produtos: caso.produtos,
          ...caso.params,
          amostra: caso.amostra,
          indisponivel,
        });
      }
    }

    estado.encerrar({
      execucaoId,
      iniciadoEmMs: this.args.runIniciadoEmMs,
      concluidoEmMs: deps.agoraMs(),
      tabelas: estado.conta.tabelas,
      contadores: { ...estado.raiz.execucaoPreco.contadores },
    });
  }

  /** One row: raised on a count, resolved (when open) on none. */
  private async aviso(contaId: string, nome: string, caso: CasoDoFimPrecoLi): Promise<void> {
    const { db, deps } = this.args;
    const amostra = caso.amostra.join(', ');
    const base: Omit<PlanoAviso, 'relogioEvento'> = {
      tipo: caso.tipo,
      conta: contaId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: nome },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build(contaId), campo: null },
    };
    const relogioEvento = relogioDoEnvioDeEstoqueUs(this.args.runIniciadoEmMs);
    const agoraUs = agoraUsDe({ nowMs: deps.agoraMs() });
    if (caso.produtos > 0) {
      await escreverAviso(
        db,
        {
          ...base,
          params: {
            ...base.params,
            produtos: caso.produtos,
            ...caso.params,
            ...(amostra === '' ? {} : { amostra }),
          },
          relogioEvento,
        },
        { increment: deps.increment, agoraUs, logger: deps.logger },
      );
      return;
    }
    // Resolve only an OPEN row: one read, never a seeded resolved row (module header).
    const chave = chaveDeAviso(base);
    const snap = await avisoCollection.docRef(db, {}, chave).get();
    const dados: Readonly<Record<string, unknown>> | undefined = snap.exists
      ? snap.data()
      : undefined;
    if (dados === undefined || (Object.hasOwn(dados, 'resolvidoEm') && dados.resolvidoEm != null)) {
      return;
    }
    await resolverAviso(
      db,
      chave,
      MOTIVO_RESOLUCAO_RECONCILE_LI,
      { agoraUs },
      { ...base, relogioEvento },
    );
  }
}
