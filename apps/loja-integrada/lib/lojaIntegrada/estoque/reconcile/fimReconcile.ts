/**
 * The daily stock reconcile's END phase (`fim`; master plan step 12, PR 12-g): per conta, in the
 * run's `contas` order (`idxConta`, one unit each — {@link FimReconcileLi.unidade}), the avisos the
 * run decides, raised or resolved ONCE, and the conta's `ultimoReconcile`. The slice
 * (`despachoReconcile.ts`) writes the conta's root in its end-of-slice batch, then releases the
 * lease after the last conta. Next-free, `db` a parameter.
 *
 * ## Which conta
 *
 * Every conta of the run is read again, uncached (`contasReconcile.ts`), with its root. A conta
 * GONE (or no longer a Loja Integrada one) gets nothing: no root write, no aviso — the expiry
 * sweep's orphan pass closes its rows. A conta inactive, or whose depósito moved since the take,
 * gets its `ultimoReconcile` but NO aviso: the run's findings are about a conta that is not the one
 * it now is.
 *
 * ## At the release ({@link FimReconcileLi.revisaoDeDeposito})
 *
 * Once, in the slice that releases the lease, the contas are LISTED again
 * (`revisaoDeDepositoNaLiberacaoLi`, `contasReconcile.ts`): an active conta whose depósito is not
 * the one the run fixed in its root — or an active conta with a depósito the run did not take —
 * asks for ONE new full run after the release (`estoque-reconcile-redeposito-<µs>`), because the
 * depósito-change trigger's own run met this one's lease and was refused. The roots read for the
 * end phase give the depósitos the run fixed; the listing is the release's only extra read.
 *
 * ## The avisos — only under `on`, and only for a conta the valve is live for
 *
 * A conta's avisos are written only when the stock valve is exactly `on` AND live for some target
 * of the conta (`valvulaLigadaParaContaLi`: the canary `*`, or a list entry of the conta) — the
 * contract of the stock avisos (`aviso.ts`: never under dry-run, outside the canary or with the
 * valve off). Each is clocked by the RUN's start (`relogioDoEnvioDeEstoqueUs`, the app's one
 * conversion module), so an older run can neither reopen nor close a newer one's row.
 *
 * | Aviso | Count (the conta's counters) | Sample | Resolved when |
 * | --- | --- | --- | --- |
 * | `lojaIntegradaEstoqueSemErp` | `retidos` | `retido` | 0 |
 * | `lojaIntegradaEstoqueVinculo` `ambiguo` | `ambiguos` | `ambiguo` | 0 |
 * | … `duplicado` | `duplicados` | `duplicado` | 0 |
 * | … `ausente` | `ausentes` | `ausente` | 0 |
 * | … `estoque-ambiguo` | `estoqueAmbiguo` | `estoque-ambiguo` | 0 |
 * | … `deposito-sem-registros` (the safety gate) | `zeroPorDeposito`, only when `bloqueadoDeposito` | `deposito-sem-registros` | the gate did not trip |
 * | … `sem-linha-na-loja` | `semLinhaNaLoja` (each confirmed by a 404) | `sem-linha-na-loja` | 0, and ONLY when the conta's list was read whole AND every unseen linked child confirmed (`listaCompleta` and `verificacaoFeita`) — a conta whose store phase was skipped (the read switch, a park) or cut short leaves it untouched |
 *
 * A count above 0 RAISES (a repeat replaces `params`: the count and the sample, up to 200 produto
 * ids, sorted, joined by `, `); 0 RESOLVES — but only an OPEN row: one read, and a write only on a
 * real open → resolved transition, never a seeded resolved row (`avisosEstoque.ts`'s pattern).
 * Not live for the conta ⇒ no aviso read or written: ONE INFO line per non-zero row instead, with
 * its count and its sample (ids only), which is what a dry-run review reads.
 *
 * ## `ultimoReconcile`
 *
 * `{ execucaoId, iniciadoEmMs, concluidoEmMs, contadores }` — the conta's counters of the run
 * (`c<idx><Nome>`) with the prefix taken off (`c0Validos` → `validos`; `c1` never takes `c10`'s),
 * and the list cursor cleared (`reconcile: null`: no run is reading the conta's list). Written in
 * the slice's batch, under the root's own read (tier 1).
 *
 * Every line carries ids and counts only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here — not even in a comment (`estrutura.test.ts`).
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  avisoCollection,
  sincEstoqueLojaIntegradaCollection,
} from '@delfrance/data/admin/collections';
import { type PlanoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  type ExecucaoContaEstoqueLi,
  MOTIVO_AMOSTRA_ESTOQUE_LI,
  MOTIVO_ESTOQUE_VINCULO_LI,
  type MotivoAmostraEstoqueLi,
  type MotivoEstoqueVinculoLi,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  execucaoContaEstoqueLiSchema,
} from '@delfrance/schemas';

import { agoraUsDe, relogioDoEnvioDeEstoqueUs } from '../../avisos/avisos';
import { type ValvulaLi, valvulaLigadaParaContaLi } from '../../core/valvulas';
import {
  type ContaRevistaLi,
  indisponibilidadeDaContaLi,
  reverContasDoRunLi,
  revisaoDeDepositoNaLiberacaoLi,
} from './contasReconcile';
import type { EscritaSincLi } from './execucaoReconcile';
import { type OrcamentoReconcileLi, UNIDADE_RECONCILE_LI } from './orcamentoReconcile';
import type { EstadoContaReconcileLi } from './snapshotReconcile';

const TAG = '[loja-integrada/estoque] reconcile';

/** The motivo every machine resolution of the reconcile's avisos is stamped with. */
export const MOTIVO_RESOLUCAO_RECONCILE_LI = 'conferencia-sem-casos';

/**
 * The conta's counters of the run, the prefix `c<idx>` taken off (module header). Pure. Only a
 * name whose prefix is followed by an upper-case letter is the conta's: `c1Validos` is conta 1's,
 * `c10Validos` conta 10's.
 */
export function contadoresDaContaLi(
  contadores: Readonly<Record<string, number>>,
  idx: number,
): Record<string, number> {
  const prefixo = `c${String(idx)}`;
  const saida: Record<string, number> = {};
  for (const [nome, n] of Object.entries(contadores)) {
    if (!nome.startsWith(prefixo)) continue;
    const resto = nome.slice(prefixo.length);
    const primeira = resto.charAt(0);
    if (primeira === '' || primeira < 'A' || primeira > 'Z') continue;
    saida[`${primeira.toLowerCase()}${resto.slice(1)}`] = n;
  }
  return saida;
}

/** One row the end phase decides for a conta. */
interface CasoDoFimLi {
  readonly tipo:
    | typeof TIPO_AVISO.lojaIntegradaEstoqueSemErp
    | typeof TIPO_AVISO.lojaIntegradaEstoqueVinculo;
  readonly motivo: MotivoEstoqueVinculoLi | null;
  readonly amostra: MotivoAmostraEstoqueLi;
  readonly produtos: number;
  /** Whether a count of 0 may resolve it (module header's table). */
  readonly resolvivel: boolean;
}

/** The rows of one conta, from its counters (module header's table). Pure. */
export function casosDoFimLi(c: Readonly<Record<string, number>>): readonly CasoDoFimLi[] {
  const n = (nome: string): number => c[nome] ?? 0;
  const vinculo = (
    motivo: MotivoEstoqueVinculoLi,
    amostra: MotivoAmostraEstoqueLi,
    produtos: number,
    resolvivel = true,
  ): CasoDoFimLi => ({
    tipo: TIPO_AVISO.lojaIntegradaEstoqueVinculo,
    motivo,
    amostra,
    produtos,
    resolvivel,
  });
  return [
    {
      tipo: TIPO_AVISO.lojaIntegradaEstoqueSemErp,
      motivo: null,
      amostra: MOTIVO_AMOSTRA_ESTOQUE_LI.retido,
      produtos: n('retidos'),
      resolvivel: true,
    },
    vinculo(MOTIVO_ESTOQUE_VINCULO_LI.ambiguo, MOTIVO_AMOSTRA_ESTOQUE_LI.ambiguo, n('ambiguos')),
    vinculo(
      MOTIVO_ESTOQUE_VINCULO_LI.duplicado,
      MOTIVO_AMOSTRA_ESTOQUE_LI.duplicado,
      n('duplicados'),
    ),
    vinculo(MOTIVO_ESTOQUE_VINCULO_LI.ausente, MOTIVO_AMOSTRA_ESTOQUE_LI.ausente, n('ausentes')),
    vinculo(
      MOTIVO_ESTOQUE_VINCULO_LI.estoqueAmbiguo,
      MOTIVO_AMOSTRA_ESTOQUE_LI.estoqueAmbiguo,
      n('estoqueAmbiguo'),
    ),
    vinculo(
      MOTIVO_ESTOQUE_VINCULO_LI.depositoSemRegistros,
      MOTIVO_AMOSTRA_ESTOQUE_LI.depositoSemRegistros,
      n('bloqueadoDeposito') > 0 ? n('zeroPorDeposito') : 0,
    ),
    vinculo(
      MOTIVO_ESTOQUE_VINCULO_LI.semLinhaNaLoja,
      MOTIVO_AMOSTRA_ESTOQUE_LI.semLinhaNaLoja,
      n('semLinhaNaLoja'),
      n('listaCompleta') > 0 && n('verificacaoFeita') > 0,
    ),
  ];
}

/** What the end phase needs of the slice's deps. */
export interface DepsFimReconcileLi {
  readonly agoraMs: () => number;
  /** A tier-0 `FieldValue.increment`, for the aviso writer's `ocorrencias`. */
  readonly increment: (by: number) => unknown;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** What one slice hands its end phase. */
export interface ArgsFimReconcileLi {
  readonly db: Firestore;
  readonly deps: DepsFimReconcileLi;
  readonly execucaoId: string;
  /** MS. When the run began: the avisos' clock and `ultimoReconcile.iniciadoEmMs`. */
  readonly runIniciadoEmMs: number;
  readonly contas: readonly string[];
  readonly valvula: ValvulaLi;
  readonly orcamento: OrcamentoReconcileLi;
  /** The run's counters as they stand. */
  readonly contadores: () => Readonly<Record<string, number>>;
  /** Where the conta roots' writes go: the slice's end-of-slice batch. */
  readonly escritas: EscritaSincLi[];
  /**
   * The conta's state when THIS slice already loaded it (an earlier phase of the same slice): the
   * end is then recorded on it, so the root is written once (`EstadoContaReconcileLi.encerrar`).
   */
  readonly estadoCarregado: (contaId: string) => EstadoContaReconcileLi | undefined;
}

/** What one {@link FimReconcileLi.unidade} call decided. */
export type PassoFimLi =
  | { readonly tipo: 'unidade' }
  | { readonly tipo: 'sem-orcamento' }
  /** A conta's root belongs to another run: the slice stops. */
  | { readonly tipo: 'parado' };

/** The end phase of ONE slice (module header). */
export class FimReconcileLi {
  private readonly args: ArgsFimReconcileLi;
  private revistas: Map<string, ContaRevistaLi> | null = null;
  private raizes: Map<string, DocumentSnapshot> | null = null;

  constructor(args: ArgsFimReconcileLi) {
    this.args = args;
  }

  /** The contas and their roots, read once per slice (module header, "Which conta"). */
  private async lidos(): Promise<{
    readonly revistas: Map<string, ContaRevistaLi>;
    readonly raizes: Map<string, DocumentSnapshot>;
  }> {
    const { db, contas } = this.args;
    if (this.revistas === null || this.raizes === null) {
      const [revistas, snaps] = await Promise.all([
        reverContasDoRunLi(db, contas),
        db.getAll(...contas.map((id) => sincEstoqueLojaIntegradaCollection.docRef(db, {}, id))),
      ]);
      this.revistas = revistas;
      this.raizes = new Map(contas.map((id, n) => [id, snaps[n] as DocumentSnapshot]));
    }
    return { revistas: this.revistas, raizes: this.raizes };
  }

  /** ONE conta's end (module header). */
  async unidade(idx: number): Promise<PassoFimLi> {
    const { deps, execucaoId } = this.args;
    const contaId = this.args.contas[idx];
    if (contaId === undefined) throw new TypeError('fim do reconcile: conta fora da lista');
    if (!this.args.orcamento.cabe(UNIDADE_RECONCILE_LI.fim)) return { tipo: 'sem-orcamento' };
    const { revistas, raizes } = await this.lidos();
    const revista = revistas.get(contaId);
    const snapRaiz = raizes.get(contaId);
    if (revista === undefined || !revista.existe || snapRaiz === undefined || !snapRaiz.exists) {
      deps.logger.info(`${TAG} conta ausente no fim — nada gravado para ela`, {
        execucaoId,
        contaId,
      });
      return { tipo: 'unidade' };
    }
    const raiz = sincEstoqueLojaIntegradaCollection.parseRead(snapRaiz.data() ?? {});
    const execucao = execucaoContaEstoqueLiSchema.safeParse(raiz.execucao);
    if (!execucao.success || execucao.data.execucaoId !== execucaoId) return { tipo: 'parado' };

    const indisponivel = indisponibilidadeDaContaLi(revista, execucao.data.depositoId);
    const contadores = contadoresDaContaLi(this.args.contadores(), idx);
    const casos = casosDoFimLi(contadores);
    const ligada = indisponivel === null && valvulaLigadaParaContaLi(this.args.valvula, contaId);
    if (ligada) {
      for (const caso of casos) await this.aviso(contaId, revista.nome, execucao.data, caso);
    } else {
      for (const caso of casos) {
        if (caso.produtos === 0) continue;
        deps.logger.info(`${TAG} achado da conta (sem aviso)`, {
          execucaoId,
          contaId,
          tipo: caso.tipo,
          motivo: caso.motivo,
          produtos: caso.produtos,
          amostra: amostraDe(execucao.data, caso.amostra),
          indisponivel,
        });
      }
    }

    const ultimoReconcile = {
      execucaoId,
      iniciadoEmMs: this.args.runIniciadoEmMs,
      concluidoEmMs: deps.agoraMs(),
      contadores,
    };
    const carregado = this.args.estadoCarregado(contaId);
    if (carregado !== undefined) {
      carregado.encerrar(ultimoReconcile);
    } else {
      this.args.escritas.push({
        tipo: 'gravar',
        ref: snapRaiz.ref,
        versao: snapRaiz.updateTime ?? null,
        dados: sincEstoqueLojaIntegradaCollection.parseMerge({ ultimoReconcile, reconcile: null }),
      });
    }
    return { tipo: 'unidade' };
  }

  /**
   * The release's check (module header, "At the release"): the µs a depósito change asks a new
   * full run by, `0` for none. The depósitos the run fixed come from the roots this phase read.
   */
  async revisaoDeDeposito(): Promise<number> {
    const { raizes } = await this.lidos();
    const fixados = new Map<string, string>();
    for (const [contaId, snap] of raizes) {
      if (!snap.exists) continue;
      const raiz = sincEstoqueLojaIntegradaCollection.parseRead(snap.data() ?? {});
      const execucao = execucaoContaEstoqueLiSchema.safeParse(raiz.execucao);
      if (execucao.success && execucao.data.execucaoId === this.args.execucaoId) {
        fixados.set(contaId, execucao.data.depositoId);
      }
    }
    return revisaoDeDepositoNaLiberacaoLi(this.args.db, {
      fixados,
      runIniciadoEmMs: this.args.runIniciadoEmMs,
    });
  }

  /** One row: raised on a count, resolved (when open) on none, untouched when not decidable. */
  private async aviso(
    contaId: string,
    nome: string,
    execucao: ExecucaoContaEstoqueLi,
    caso: CasoDoFimLi,
  ): Promise<void> {
    const { db, deps } = this.args;
    const amostra = amostraDe(execucao, caso.amostra).join(', ');
    const base: Omit<PlanoAviso, 'relogioEvento'> = {
      tipo: caso.tipo,
      conta: contaId,
      ...(caso.motivo === null ? {} : { entidade: caso.motivo, motivo: caso.motivo }),
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: nome,
        ...(caso.motivo === null ? {} : { motivo: caso.motivo }),
      },
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
            ...(amostra === '' ? {} : { amostra }),
          },
          relogioEvento,
        },
        { increment: deps.increment, agoraUs, logger: deps.logger },
      );
      return;
    }
    if (!caso.resolvivel) return;
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
      {
        ...base,
        relogioEvento,
      },
    );
  }
}

/** A sample of the run, sorted (ids only). */
function amostraDe(execucao: ExecucaoContaEstoqueLi, motivo: MotivoAmostraEstoqueLi): string[] {
  return [...(execucao.amostras[motivo] ?? [])].sort();
}
