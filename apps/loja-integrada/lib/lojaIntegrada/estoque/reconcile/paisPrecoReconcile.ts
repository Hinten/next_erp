/**
 * The daily reconcile's PARENTS phase for price (`pais-preco`; master plan step 13, PR 13-f1): per
 * priced conta, every valid child's TARGET `a`, computed by the shared price function from what
 * the key walk stored and from its parent, each parent read ONCE per conta per run. Next-free,
 * `db` a parameter.
 *
 * ## The target ({@link alvoDaEntradaPrecoLi}, pure)
 *
 * `precoAlvoLi` itself, over the child REBUILT from its entry — its `paiId` (`pai`) and a `precos`
 * map that reads back exactly as its stored readings (`precosDasLeiturasLi` over
 * `leituraTabelaDoSnapshotLi`) — and the parent's RAW masked data as read (`null` = no such
 * document). So the child rule, `propagaPrecoAosFilhos` and every hold are the shared ones
 * verbatim, never a second copy: a propagating parent prices the child from the PARENT's entries
 * (and holds it without a parent price, whatever the child has), a parent that does not propagate
 * leaves the child its own, and a missing parent holds it `pai-ausente`.
 *
 * ## One unit (worst case 20 s, `orcamentoPrecoReconcile.ts`)
 *
 *  1. Every valid ROOT entry still without a target gets one — no read.
 *  2. The children still without one name their parents; the first
 *     {@link MAX_PAIS_POR_LEITURA_PRECO_LI} distinct ones, in id order, are read in ONE `getAll`
 *     masked to `CAMPOS_PRODUTO_PRECO_LI` (`paisLidos`, `paisAusentes`).
 *  3. Every child of those parents gets its target in the same unit.
 *  4. When no valid entry is left without a target, the conta is done: its counters (`alvos`,
 *     `limpezas` — the targets that clear the promotion —, `promoNaoMenor`, `retidos`,
 *     `retidosSemPreco`, `retidosIlegiveis`, `retidosSemPai`), the `retido` sample (the held
 *     children's ERP produto ids), the buckets' `anteriores` cleared, `paisConcluido: 1`, and ONE
 *     INFO line with the counters.
 *
 * ## Incremental, so it keeps no state of its own
 *
 * A parent read in a unit prices ALL its pending children in that unit, and a resumed slice
 * re-derives what is pending from the buckets, which already hold the targets of every unit that
 * landed. So each parent is read once per conta per run, nothing but the buckets is persisted, and
 * no parents document (`snapshot/paisErp`, reserved) can grow toward 1 MiB and stall the slice's
 * one batch — which carries the stock flow's writes too.
 *
 * Every line carries ids and counts only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type AlvoSnapshotPrecoLi,
  type EntradaSnapshotPrecoLi,
  FLAG_ENTRADA_PRECO_LI,
  type LeituraTabelaPrecoLi,
  MOTIVO_AMOSTRA_PRECO_LI,
  MOTIVO_RETENCAO_PRECO_LI,
  type TabelasPrecoLi,
  alvoSnapshotDoAlvoLi,
  leituraTabelaDoSnapshotLi,
  precoAlvoLi,
  precosDasLeiturasLi,
} from '@delfrance/schemas';

import { CAMPOS_PRODUTO_PRECO_LI } from '../../preco/leituraPrecoErp';
import { MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI } from '../leituraEstoqueErp';
import type { EstadoContaPrecoLi } from './estadoPrecoReconcile';

const TAG = '[loja-integrada/preco] reconcile';

/** The most parents one unit reads: the stock walk's `getAll` bound, the SAME constant. */
export const MAX_PAIS_POR_LEITURA_PRECO_LI = MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI;

/** The conta counter that says the phase is done for it (`fimPrecoReconcile.ts` reads it). */
export const CONTADOR_PAIS_CONCLUIDO_LI = 'paisConcluido';

/**
 * A valid entry's target (module header, "The target"). Pure. `pai` is the parent's RAW masked
 * data (`null` = no such document; ignored for a root).
 */
export function alvoDaEntradaPrecoLi(args: {
  readonly entrada: EntradaSnapshotPrecoLi;
  readonly pai: Readonly<Record<string, unknown>> | null;
  readonly tabelas: TabelasPrecoLi;
}): AlvoSnapshotPrecoLi {
  const { entrada, tabelas } = args;
  const leituras: Record<string, LeituraTabelaPrecoLi> = {
    [tabelas.normal]: leituraTabelaDoSnapshotLi(entrada.n),
  };
  if (tabelas.promocional !== null) {
    leituras[tabelas.promocional] = leituraTabelaDoSnapshotLi(entrada.pr);
  }
  const dados: Record<string, unknown> = { precos: precosDasLeiturasLi(leituras) };
  if (entrada.pai != null) dados.paiId = entrada.pai;
  return alvoSnapshotDoAlvoLi(
    precoAlvoLi({
      produto: { id: entrada.p, dados },
      pai: args.pai,
      tabelaNormalId: tabelas.normal,
      tabelaPromocionalId: tabelas.promocional,
    }),
  );
}

/** What one unit did. */
export type PassoPaisPrecoLi = 'unidade' | 'conta-encerrada';

/** The counters of a finished conta, from every valid entry's target (module header, step 4). */
function contadoresDosAlvos(estado: EstadoContaPrecoLi): {
  readonly contadores: ReadonlyMap<string, number>;
  readonly retidos: readonly string[];
} {
  const contadores = new Map<string, number>();
  const somar = (nome: string): void => {
    contadores.set(nome, (contadores.get(nome) ?? 0) + 1);
  };
  const retidos: string[] = [];
  for (const [, e] of estado.entradas()) {
    if (e.f !== FLAG_ENTRADA_PRECO_LI.valido || e.a == null) continue;
    if ('r' in e.a) {
      somar('retidos');
      retidos.push(e.p);
      if (e.a.r === MOTIVO_RETENCAO_PRECO_LI.semPreco) somar('retidosSemPreco');
      else if (e.a.r === MOTIVO_RETENCAO_PRECO_LI.ilegivel) somar('retidosIlegiveis');
      else if (e.a.r === MOTIVO_RETENCAO_PRECO_LI.paiAusente) somar('retidosSemPai');
      continue;
    }
    somar('alvos');
    if (e.a.q === null) somar('limpezas');
    else if (e.a.q >= e.a.c) somar('promoNaoMenor');
  }
  return { contadores, retidos };
}

/** The parents phase of ONE slice (module header). */
export class PaisPrecoReconcileLi {
  private readonly db: Firestore;
  private readonly execucaoId: string;
  private readonly logger: { info(msg: string, meta?: Record<string, unknown>): void };

  constructor(args: {
    readonly db: Firestore;
    readonly execucaoId: string;
    readonly logger: { info(msg: string, meta?: Record<string, unknown>): void };
  }) {
    this.db = args.db;
    this.execucaoId = args.execucaoId;
    this.logger = args.logger;
  }

  /**
   * ONE unit for the conta (module header). The caller checks the budget first and hands a state
   * loaded with its buckets.
   */
  async unidade(estado: EstadoContaPrecoLi): Promise<PassoPaisPrecoLi> {
    if (estado.contador(CONTADOR_PAIS_CONCLUIDO_LI) > 0) return 'conta-encerrada';
    if (!estado.comBaldes) throw new TypeError('reconcile: fase de pais sem os baldes da conta');
    const { tabelas } = estado.conta;

    // 1. The roots, and what the children still pending name.
    const pendentesPorPai = new Map<string, string[]>();
    for (const [idLi, e] of estado.entradas()) {
      if (e.f !== FLAG_ENTRADA_PRECO_LI.valido || e.a != null) continue;
      if (e.pai == null) {
        estado.definirAlvo(idLi, alvoDaEntradaPrecoLi({ entrada: e, pai: null, tabelas }));
        continue;
      }
      const filhos = pendentesPorPai.get(e.pai);
      if (filhos === undefined) pendentesPorPai.set(e.pai, [idLi]);
      else filhos.push(idLi);
    }

    // 2–3. The next parents, read once, and every child of theirs.
    const pais = [...pendentesPorPai.keys()].sort().slice(0, MAX_PAIS_POR_LEITURA_PRECO_LI);
    if (pais.length > 0) {
      const snaps = await this.db.getAll(
        ...pais.map((id) => produtoCollection.docRef(this.db, {}, id)),
        { fieldMask: [...CAMPOS_PRODUTO_PRECO_LI] },
      );
      let ausentes = 0;
      pais.forEach((paiId, n) => {
        const snap = snaps[n];
        const pai = snap?.exists === true ? (snap.data() ?? {}) : null;
        if (pai === null) ausentes += 1;
        for (const idLi of pendentesPorPai.get(paiId) ?? []) {
          const entrada = estado.entrada(idLi);
          if (entrada === undefined) throw new TypeError('reconcile: filho pendente sumiu');
          estado.definirAlvo(idLi, alvoDaEntradaPrecoLi({ entrada, pai, tabelas }));
        }
        pendentesPorPai.delete(paiId);
      });
      estado.contar('paisLidos', pais.length);
      estado.contar('paisAusentes', ausentes);
    }
    if (pendentesPorPai.size > 0) return 'unidade';

    // 4. The conta is done.
    const { contadores, retidos } = contadoresDosAlvos(estado);
    for (const [nome, n] of contadores) estado.contar(nome, n);
    estado.amostrar(MOTIVO_AMOSTRA_PRECO_LI.retido, retidos);
    estado.limparAnteriores();
    estado.contar(CONTADOR_PAIS_CONCLUIDO_LI);
    this.logger.info(`${TAG} alvos da conta calculados`, {
      execucaoId: this.execucaoId,
      contaId: estado.conta.contaId,
      ...Object.fromEntries(
        [
          'alvos',
          'limpezas',
          'promoNaoMenor',
          'retidos',
          'retidosSemPreco',
          'retidosIlegiveis',
          'retidosSemPai',
          'paisLidos',
          'paisAusentes',
        ].map((nome) => [nome, estado.contador(nome)]),
      ),
    });
    return 'conta-encerrada';
  }
}
