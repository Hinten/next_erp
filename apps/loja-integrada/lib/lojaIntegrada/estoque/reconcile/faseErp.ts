/**
 * The daily stock reconcile's ERP EVALUATION of one walk page (master plan step 12, PR 12-g): for
 * every produto the page holds and every conta of the run, the SAME plan a send run makes
 * (`planoEstoqueLi`), from the SAME reads (`leituraEstoqueErp.ts`), turned into the conta's
 * snapshot entry — or a parent id, or nothing. Next-free, `db` a parameter.
 *
 * ## The order, every read the cheapest that answers
 *
 *  1. **The links alone** (`vinculoDaContaLi`, per run conta): a produto with no counting link of
 *     the conta costs nothing; `pai` records the store ids in the conta's `pais` (a parent's row is
 *     never sent, and the store's list holds it); `nao-suportado` and `vinculo-ambiguo` give an
 *     `ns` / `amb` entry to EACH store id the conta's counting links name
 *     (`idsDosVinculosDaContaLi`, the same reader's ids). Nothing of these is read further.
 *  2. **The produtos** a link of some run conta makes a child of: ONE masked `getAll` per 300
 *     (`lerProdutosEstoqueLi`, the send run's mask). A produto that no longer exists ⇒ an `x`
 *     entry (so the store's list walk never looks its id up) and the `ausente` sample.
 *  3. **Parity** (`planoDosVinculosEstoqueLi`) ⇒ `par`; its records are never read.
 *  4. **The records** at each conta's depósito — the produto's own (not for a kit its components
 *     bound) and every bounding component's — through ONE `lerRegistrosNoDepositoLi` per distinct
 *     depósito, with every produto's canonical id as the known one (a `getAll`), the group join and
 *     the own-collection query for what is still unread; at most
 *     {@link CONCORRENCIA_LEITURAS_ERP_LI} queries at once.
 *  5. **The plan**, with no duplicate known (the walk itself finds duplicates: two produtos of one
 *     store id meet in the snapshot, `snapshotReconcile.ts`). `consultar-estoques` ⇒ the
 *     never-had-stock listing, ONE per produto (`temEstoqueEmQualquerDepositoLi`), then the plan
 *     again.
 *  6. **The entry**: `enviar` ⇒ `v` with S (a kit its components bound also carries `k`, its
 *     composition `q` and the record each component resolved to, `e` — the kits map is built from
 *     them, so nothing is read again for it); `retido` ⇒ `r` (and the sample); `estoque-ambiguo` ⇒
 *     `amb` (and the sample).
 *
 * ## The counters (per conta, unprefixed; the slice prefixes them with the conta's index)
 *
 * Besides one per verdict, the two the depósito safety gate is decided from: `avaliados` — the
 * linked, non-parity children whose OWN record feeds S (a kit its components bound is not one) —
 * and `zeroPorDeposito` — those with no record at the conta's depósito but one at another, which
 * are pushed the depósito's real 0 (sampled under `deposito-sem-registros`, the gate's aviso). A
 * depósito misconfigured for the conta shows as a large share of the second in the first. Children
 * held because they never had stock count in `avaliados` only: they are never pushed.
 *
 * And the RUN's (`opcoes.global`, per depósito read, not per conta): what each read path cost —
 * the masked produtos read (`erpProdutosLidos`), the canonical records found and not found by id
 * (`erpCanonicosAchados`, `erpCanonicosAusentes`), the group joins (`erpJuncoes`), the
 * own-collection fallbacks (`erpConsultasProprias`) and the never-had-stock listings
 * (`erpListagensSemEstoque`). Whether a corpus takes the one-point-read path or the
 * NOT_FOUND + join + own query + listing path per produto is what decides a night's reads, so the
 * end line and the staging measurement need them.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  FLAG_ENTRADA_ESTOQUE_LI,
  type EntradaSnapshotEstoqueLi,
  type EstoqueNoDepositoLi,
  MOTIVO_AMOSTRA_ESTOQUE_LI,
  caminhoEstoqueLi,
  estoqueNoDepositoLi,
  idDocumentoEstoqueLiSchema,
  idsDosVinculosDaContaLi,
  makeEstoqueUid,
  vinculoDaContaLi,
} from '@delfrance/schemas';

import {
  CONTAGEM_REGISTROS_NO_DEPOSITO_LI,
  type ContagemRegistrosNoDepositoLi,
  componentesQueLimitamLi,
  emParaleloLi,
  lerProdutosEstoqueLi,
  lerRegistrosNoDepositoLi,
  quantidadesQueLimitamLi,
  temEstoqueEmQualquerDepositoLi,
} from '../leituraEstoqueErp';
import {
  type EntradaPlanoEstoqueLi,
  type PlanoEstoqueLi,
  kitRestritoLi,
  planoDosVinculosEstoqueLi,
  planoEstoqueLi,
} from '../planoEstoqueLi';
import type { DocEstoqueLi, ProdutoEstoqueLi } from '../quantidadeEstoqueLi';
import type { GrupoDeVinculosLi } from './caminhadaVinculos';
import type { ContaDoRunLi, EstadoContaReconcileLi } from './snapshotReconcile';

/** How many record queries and never-had-stock listings run at once (module header, step 4). */
export const CONCURRENCIA_LEITURAS_ERP_LI = 20;

/** A conta's counters of one page, unprefixed (module header). */
export type ContadoresErpLi = Map<string, number>;

/** The RUN's counter each read path of the records reader adds to (module header). */
const CONTADOR_GLOBAL_DO_REGISTRO: Readonly<Record<ContagemRegistrosNoDepositoLi, string>> = {
  [CONTAGEM_REGISTROS_NO_DEPOSITO_LI.canonicosAchados]: 'erpCanonicosAchados',
  [CONTAGEM_REGISTROS_NO_DEPOSITO_LI.canonicosAusentes]: 'erpCanonicosAusentes',
  [CONTAGEM_REGISTROS_NO_DEPOSITO_LI.juncoes]: 'erpJuncoes',
  [CONTAGEM_REGISTROS_NO_DEPOSITO_LI.consultasProprias]: 'erpConsultasProprias',
};

function somar(contadores: ContadoresErpLi, nome: string, n = 1): void {
  if (n === 0) return;
  contadores.set(nome, (contadores.get(nome) ?? 0) + n);
}

/** A (conta, child produto) whose links name one store id: what the reads decide. */
interface VinculadoLi {
  readonly conta: ContaDoRunLi;
  readonly produtoId: string;
  readonly links: readonly unknown[];
  readonly idLi: string;
}

/** The records of one depósito, by the owner in each record's PATH (#932). */
type RegistrosPorDonoLi = ReadonlyMap<string, readonly DocEstoqueLi[]>;

function agruparPorDono(registros: readonly DocEstoqueLi[]): Map<string, DocEstoqueLi[]> {
  const porDono = new Map<string, DocEstoqueLi[]>();
  for (const registro of registros) {
    const dono = caminhoEstoqueLi(registro.caminho)?.produtoId;
    if (dono === undefined) continue;
    const grupo = porDono.get(dono);
    if (grupo === undefined) porDono.set(dono, [registro]);
    else grupo.push(registro);
  }
  return porDono;
}

/**
 * A store kit's composition for its entry: each bounding component → its quantity (`q`) and the
 * record it resolved to at the depósito (`e`, `null` for none or two legacy ones). `null` when a
 * component id is not a document id the map can key (the kit then stays out of the map, counted).
 */
function composicaoDoKitLi(
  produto: ProdutoEstoqueLi,
  depositoId: string,
  porDono: RegistrosPorDonoLi,
): Pick<EntradaSnapshotEstoqueLi, 'q' | 'e'> | null {
  const q = quantidadesQueLimitamLi(produto);
  const componentes = Object.keys(q);
  if (componentes.length === 0) return null;
  if (componentes.some((c) => !idDocumentoEstoqueLiSchema.safeParse(c).success)) return null;
  const e: Record<string, string | null> = {};
  for (const componente of componentes) {
    const resolvido = estoqueNoDepositoLi({
      produtoId: componente,
      depositoId,
      registros: porDono.get(componente) ?? [],
    });
    const estoqueId =
      resolvido.tipo === 'um'
        ? (caminhoEstoqueLi(resolvido.registro.caminho)?.estoqueId ?? null)
        : null;
    e[componente] =
      estoqueId !== null && idDocumentoEstoqueLiSchema.safeParse(estoqueId).success
        ? estoqueId
        : null;
  }
  return { q, e };
}

/**
 * Evaluates one walk page for every conta of the run, writing into each conta's state in memory
 * (module header). Returns each conta's counters of the page, by conta id.
 */
export async function avaliarPaginaErpLi(
  db: Firestore,
  grupos: readonly GrupoDeVinculosLi[],
  contas: readonly ContaDoRunLi[],
  estados: ReadonlyMap<string, EstadoContaReconcileLi>,
  opcoes: {
    readonly concorrencia?: number;
    /** The RUN's read-path counters of the page are added here (module header). */
    readonly global?: ContadoresErpLi;
  } = {},
): Promise<Map<string, ContadoresErpLi>> {
  const concorrencia = opcoes.concorrencia ?? CONCURRENCIA_LEITURAS_ERP_LI;
  const global = opcoes.global ?? new Map<string, number>();
  const contadores = new Map<string, ContadoresErpLi>(contas.map((c) => [c.contaId, new Map()]));
  const estadoDe = (conta: ContaDoRunLi): EstadoContaReconcileLi => {
    const estado = estados.get(conta.contaId);
    if (estado === undefined) throw new RangeError('reconcile: conta sem estado carregado');
    return estado;
  };
  const contar = (conta: ContaDoRunLi, nome: string, n = 1): void => {
    const doConta = contadores.get(conta.contaId);
    if (doConta !== undefined) somar(doConta, nome, n);
  };
  const aplicar = (conta: ContaDoRunLi, idLi: string, entrada: EntradaSnapshotEstoqueLi): void => {
    contar(conta, 'duplicados', estadoDe(conta).aplicar(idLi, entrada).length);
  };

  // 1. The links alone.
  const vinculados: VinculadoLi[] = [];
  for (const { produtoId, links } of grupos) {
    for (const conta of contas) {
      const vinculo = vinculoDaContaLi(conta.contaId, links);
      switch (vinculo.tipo) {
        case 'sem-vinculo':
          break;
        case 'pai':
          for (const idLi of idsDosVinculosDaContaLi(conta.contaId, links)) {
            estadoDe(conta).adicionarPai(idLi);
          }
          contar(conta, 'pais');
          break;
        case 'nao-suportado':
          for (const idLi of idsDosVinculosDaContaLi(conta.contaId, links)) {
            aplicar(conta, idLi, {
              p: produtoId,
              s: null,
              f: FLAG_ENTRADA_ESTOQUE_LI.naoSuportado,
            });
          }
          contar(conta, 'naoSuportados');
          break;
        case 'vinculo-ambiguo':
          for (const idLi of idsDosVinculosDaContaLi(conta.contaId, links)) {
            aplicar(conta, idLi, { p: produtoId, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo });
          }
          estadoDe(conta).amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.ambiguo, [produtoId]);
          contar(conta, 'ambiguos');
          break;
        case 'vinculado':
          vinculados.push({ conta, produtoId, links, idLi: vinculo.idLi });
          break;
      }
    }
  }
  if (vinculados.length === 0) return contadores;

  // 2. The produtos, masked.
  const aLerProdutos = vinculados.map((v) => v.produtoId);
  const produtos = await lerProdutosEstoqueLi(db, aLerProdutos);
  somar(global, 'erpProdutosLidos', new Set(aLerProdutos).size);

  // 3. Parity, and what each depósito must read.
  const aLer = new Map<string, Set<string>>();
  const planejar: { readonly v: VinculadoLi; readonly produto: ProdutoEstoqueLi }[] = [];
  for (const v of vinculados) {
    const produto = produtos.get(v.produtoId) ?? null;
    if (produto === null) {
      aplicar(v.conta, v.idLi, { p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo });
      estadoDe(v.conta).amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.ausente, [v.produtoId]);
      contar(v.conta, 'ausentes');
      continue;
    }
    contar(v.conta, 'vinculados');
    if (
      planoDosVinculosEstoqueLi({ contaId: v.conta.contaId, links: v.links, produto }).tipo ===
      'paridade'
    ) {
      aplicar(v.conta, v.idLi, { p: v.produtoId, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.paridade });
      contar(v.conta, 'paridade');
      continue;
    }
    const ids = aLer.get(v.conta.depositoId) ?? new Set<string>();
    if (!kitRestritoLi(produto)) ids.add(v.produtoId);
    for (const componente of componentesQueLimitamLi(produto)) ids.add(componente);
    aLer.set(v.conta.depositoId, ids);
    planejar.push({ v, produto });
  }

  // 4. The records, one read per distinct depósito.
  const porDeposito = new Map<string, RegistrosPorDonoLi>();
  for (const [depositoId, ids] of aLer) {
    const lista = [...ids];
    const registros = await lerRegistrosNoDepositoLi(
      db,
      lista,
      depositoId,
      Object.fromEntries(lista.map((id) => [id, makeEstoqueUid(id, depositoId)])),
      {
        concorrencia,
        aoContar: (nome, n) => {
          somar(global, CONTADOR_GLOBAL_DO_REGISTRO[nome], n);
        },
      },
    );
    porDeposito.set(depositoId, agruparPorDono(registros));
  }

  // 5. The plans; the never-had-stock listing only where a plan asks for it, once per produto.
  const entradas = planejar.map(({ v, produto }) => {
    const porDono = porDeposito.get(v.conta.depositoId) ?? new Map<string, DocEstoqueLi[]>();
    const restrito = kitRestritoLi(produto);
    const estoque: EstoqueNoDepositoLi = restrito
      ? { tipo: 'nenhum' }
      : estoqueNoDepositoLi({
          produtoId: v.produtoId,
          depositoId: v.conta.depositoId,
          registros: porDono.get(v.produtoId) ?? [],
        });
    const entrada: EntradaPlanoEstoqueLi = {
      contaId: v.conta.contaId,
      produtoId: v.produtoId,
      depositoId: v.conta.depositoId,
      produto,
      links: v.links,
      estoque,
      componentes: componentesQueLimitamLi(produto).flatMap((c) => porDono.get(c) ?? []),
      apagado: false,
      temEstoqueEmQualquerDeposito: null,
      duplicado: false,
    };
    return { v, produto, porDono, restrito, entrada, plano: planoEstoqueLi(entrada) };
  });
  const aConsultar = [
    ...new Set(
      entradas.filter((x) => x.plano.tipo === 'consultar-estoques').map((x) => x.v.produtoId),
    ),
  ];
  somar(global, 'erpListagensSemEstoque', aConsultar.length);
  const consultados = await emParaleloLi(aConsultar, concorrencia, (produtoId) =>
    temEstoqueEmQualquerDepositoLi(db, produtoId),
  );
  const temEstoque = new Map(aConsultar.map((id, i) => [id, consultados[i] === true]));

  // 6. The entries.
  for (const x of entradas) {
    let plano: PlanoEstoqueLi = x.plano;
    if (plano.tipo === 'consultar-estoques') {
      plano = planoEstoqueLi({
        ...x.entrada,
        temEstoqueEmQualquerDeposito: temEstoque.get(x.v.produtoId) ?? false,
      });
    }
    const { conta, produtoId, idLi } = x.v;
    if (!x.restrito) contar(conta, 'avaliados');
    switch (plano.tipo) {
      case 'enviar': {
        const composicao = x.restrito
          ? composicaoDoKitLi(x.produto, conta.depositoId, x.porDono)
          : null;
        if (x.restrito && composicao === null) contar(conta, 'kitsSemComposicao');
        if (plano.kitNaoVerificavel) contar(conta, 'kitsNaoVerificaveis');
        if (!x.restrito && x.entrada.estoque.tipo === 'nenhum') {
          // The safety gate's numerator, and the sample its aviso names (`filaReconcile.ts`).
          estadoDe(conta).amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.depositoSemRegistros, [produtoId]);
          contar(conta, 'zeroPorDeposito');
        }
        aplicar(conta, idLi, {
          p: produtoId,
          s: plano.S,
          f: FLAG_ENTRADA_ESTOQUE_LI.valido,
          ...(x.restrito ? { k: true as const } : {}),
          ...(composicao ?? {}),
        });
        contar(conta, 'validos');
        break;
      }
      case 'retido':
        aplicar(conta, idLi, { p: produtoId, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.retido });
        estadoDe(conta).amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.retido, [produtoId]);
        contar(conta, 'retidos');
        break;
      case 'estoque-ambiguo':
        aplicar(conta, idLi, { p: produtoId, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo });
        estadoDe(conta).amostrar(MOTIVO_AMOSTRA_ESTOQUE_LI.estoqueAmbiguo, [produtoId]);
        contar(conta, 'estoqueAmbiguo');
        break;
      case 'paridade':
        // Unreachable (step 3 took it), kept total.
        aplicar(conta, idLi, { p: produtoId, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.paridade });
        contar(conta, 'paridade');
        break;
      case 'sem-vinculo':
      case 'pai':
      case 'nao-suportado':
      case 'vinculo-ambiguo':
      case 'vinculo-duplicado':
      case 'consultar-estoques':
        // Unreachable: step 1 took the link verdicts, no duplicate is passed, and the listing
        // answered. Counted, never guessed into an entry.
        contar(conta, 'planosInesperados');
        break;
    }
  }
  return contadores;
}
