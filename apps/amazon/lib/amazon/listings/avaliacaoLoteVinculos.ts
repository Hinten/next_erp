/**
 * The link verdict of MANY SKUs of one conta at once, for the Amazon listings
 * flows' batches (step 13, PR 13-b): the Firestore half of a batch evaluator —
 * every document the verdict reads, read in bulk, masked to a flow's fields
 * and deduplicated across the SKUs, then the verdict per SKU. ONE module for
 * every flow; the stock flow binds it in `estoque/avaliacaoLoteEstoque.ts`
 * (which then reads the ERP quantity and Amazon's live listings), and a flow's
 * page or feed build reads its SKUs' links through it, never through a copy.
 *
 * ## The reads, in order
 *
 *  1. The link docs of every SKU: the order import's OWN query and ambiguity
 *     detector (`lerVinculosDoSkuAmazon`), ONE per SKU, projected to the flow's
 *     `vinculo` fields (the link doc's product payload never comes back), at
 *     most {@link LARGURA_CONSULTAS_VINCULOS_AMAZON} in flight
 *     ({@link lerVinculosDosSkusListingAmazon}). A SKU the caller already read
 *     that way, with the SAME projection (`vinculosLidos`), is not read again.
 *  2. The donos of every SKU, DEDUPLICATED across the SKUs, through the order
 *     import's own by-id read and gone-dono rule (`lerDonosAmazon`), in `getAll`
 *     calls of at most {@link MAX_REFS_GETALL_VINCULOS_AMAZON} refs, masked to
 *     the hop's fields, the flow's `dono` fields and the caller's `extras.dono`.
 *  3. The resolution per SKU (`resolucaoPorUnidadesAmazon`: gone donos
 *     dropped, two live ⇒ ambiguous), then, for every SKU it binds:
 *     - the units, deduplicated, in `getAll` slices of at most 300, masked to
 *       the flow's `unidade` fields and the caller's `extras.unidade` — except
 *       a unit some dono's read already holds, when that read carried every one
 *       of those fields as a top-level name (it is then never read again; a
 *       map entry, as price's `precos.<tabela>`, is never in a dono's read);
 *     - each distinct unit's children (`lerFilhosDaUnidadeListingAmazon`: keys
 *       only, at most two), at most 16 in flight;
 *     - the parent pointers of the bound dono's links, deduplicated across the
 *       SKUs by their bare path (a 20-child parent's pointer is ONE read), in
 *       calls of at most 300 distinct refs (`lerPaisDosLinksListingAmazon`);
 *     - ONLY for a flow whose masks name the unit's parent (price): the
 *       parents the units' `paiId`s name, deduplicated across the SKUs, in
 *       `getAll` slices of at most 300, masked to the flow's `paiDaUnidade`
 *       fields; a `paiId` that is not a document id is never read.
 *     A unit id that is not a document id (a corrupt `filhoUnicoId`) is never
 *     read: its unit reads as none, so one corrupt produto cannot stop a batch.
 *     The units' and the parents' by-id reads are
 *     {@link lerProdutosPorIdListingAmazon}, exported with the parent rule's
 *     two halves ({@link paiIdsDasUnidadesListingAmazon},
 *     {@link paiDaUnidadeNoLoteListingAmazon}) for a reader that already holds
 *     its unit ids.
 *  4. The verdict per SKU (`avaliarVinculoListingAmazon`, bound by the flow's
 *     `regra`), over exactly the input the per-SKU reader
 *     (`resolverVinculo.ts`) hands it with the same masks — the dono projected
 *     to the reader's dono mask, the unit to the flow's unit fields, the bound
 *     dono's own pointers only — and the same unit parent: parity tests prove
 *     both, at the stock masks and at the price masks.
 *
 * ## The deadline
 *
 * The caller's `prazoMs`, an absolute instant in ms, is read before every
 * batch of link queries, every `getAll` slice and every batch of children
 * seeks. Once it has passed, nothing more is started and the answer is
 * `prazo`, naming the stage it stopped before, with the counts of what was
 * read; nothing partial is handed back. A read already started is awaited.
 *
 * ## What it answers
 *
 * `completa`: per distinct SKU asked, in the order its link docs were read (the
 * SKUs the caller had read first, then the rest, each part sorted), its
 * verdict, its verdict's input, the unit's document as read (the flow's fields
 * and the caller's extras; `null` when no unit was read or it is gone) and the
 * unit's parent (`null` when the flow reads none or the unit names none). Plus
 * the reads by kind.
 *
 * Reads only: no write, no clock but the caller's, no network.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { CONTA_ID_AMAZON_REGEX, naoDocId } from '@delfrance/schemas';

import {
  type DocVinculoAmazon,
  type DonoLidoAmazon,
  type LeituraVinculosDoSkuAmazon,
  RESOLUCAO_LIMITE_VINCULOS_AMAZON,
  type ResolucaoVinculoAmazon,
  donosDosVinculosAmazon,
  lerDonosAmazon,
  lerVinculosDoSkuAmazon,
  mascaraDosDonosAmazon,
  resolucaoPorUnidadesAmazon,
} from '../pedidos/vinculoProdutoAmazon';
import {
  type CampoListingAmazon,
  type CamposVinculoListingAmazon,
  type PaiDaUnidadeListingAmazon,
  camposContidosListingAmazon,
  lerFilhosDaUnidadeListingAmazon,
  lerPaisDosLinksListingAmazon,
  mascaraFirestoreListingAmazon,
  paiIdDaUnidadeListingAmazon,
  projetarCamposListingAmazon,
} from './resolverVinculo';
import {
  type AlvoDoPaiListingAmazon,
  type EntradaVinculoListingAmazon,
  type EnvioDoVinculoListingAmazon,
  type RegraVinculoListingAmazon,
  type UnidadeDoVinculoListingAmazon,
  type VeredictoVinculoListingAmazon,
  avaliarVinculoListingAmazon,
  ponteiroPaiDoVinculoListingAmazon,
} from './vinculoListing';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** Link queries and children seeks in flight at once. */
export const LARGURA_CONSULTAS_VINCULOS_AMAZON = 16;

/** The most refs one `getAll` of this module names. */
export const MAX_REFS_GETALL_VINCULOS_AMAZON = 300;

/** The stage a deadline stopped before (module header, "The deadline"). */
export const ETAPA_AVALIACAO_VINCULOS_AMAZON = {
  vinculos: 'vinculos',
  donos: 'donos',
  unidades: 'unidades',
} as const;

export type EtapaAvaliacaoVinculosAmazon =
  (typeof ETAPA_AVALIACAO_VINCULOS_AMAZON)[keyof typeof ETAPA_AVALIACAO_VINCULOS_AMAZON];

/** How an evaluation ended. */
export const DESFECHO_AVALIACAO_VINCULOS_AMAZON = {
  completa: 'completa',
  prazo: 'prazo',
} as const;

/** The caller's clock and deadline, in MILLISECONDS. */
export interface PrazoVinculosAmazon {
  readonly agora: () => number;
  readonly prazoMs: number;
}

/** What a caller reads besides the flow's own fields, for its own next step. */
export interface ExtrasVinculosAmazon {
  readonly dono: readonly string[];
  readonly unidade: readonly CampoListingAmazon[];
}

export interface OpcoesAvaliacaoVinculosAmazon<E extends EnvioDoVinculoListingAmazon> {
  /**
   * The flow's masks: the verdict's input is projected to exactly these
   * (parity). They must name the same flow as `regra` (else `RangeError`).
   */
  readonly campos: CamposVinculoListingAmazon;
  /** The flow's binding of the verdict. */
  readonly regra: RegraVinculoListingAmazon<E>;
  /** Read besides the flow's fields (absent = nothing more). */
  readonly extras?: ExtrasVinculosAmazon;
  readonly prazo: PrazoVinculosAmazon;
  /**
   * The link docs the caller ALREADY read for some of the SKUs, through
   * {@link lerVinculosDosSkusListingAmazon} with the same `campos.vinculo`: a
   * walk page reads them first to apply its dedupe rule, so a SKU's query runs
   * once per page. A SKU absent here is read as usual; an entry for a SKU not
   * asked is ignored.
   */
  readonly vinculosLidos?: ReadonlyMap<string, LeituraVinculosDoSkuAmazon>;
}

/** What an evaluation read, by kind. */
export interface LeiturasVinculosAmazon {
  /** Link-doc queries (one per SKU not already read). */
  readonly consultas: number;
  /** Produtos read by id: the donos and the other units. */
  readonly produtos: number;
  /** Children seeks (one per distinct unit). */
  readonly filhos: number;
  /** Parent pointers read (distinct). */
  readonly ponteiros: number;
  /** Units' parents read (distinct; price only). */
  readonly pais: number;
}

/** One SKU, its link judged (module header, "What it answers"). */
export interface VinculoAvaliadoAmazon<E extends EnvioDoVinculoListingAmazon> {
  readonly sku: string;
  readonly veredicto: VeredictoVinculoListingAmazon<E>;
  /** The verdict's input, as the per-SKU reader hands it with the same masks. */
  readonly entrada: EntradaVinculoListingAmazon;
  /** The unit's document as read (flow fields and extras); `null` when none was read or it is gone. */
  readonly unidade: Readonly<Record<string, unknown>> | null;
  /** The unit's parent; `null` when the flow reads none or the unit names none. */
  readonly paiDaUnidade: PaiDaUnidadeListingAmazon | null;
}

export type AvaliacaoVinculosAmazon<E extends EnvioDoVinculoListingAmazon> =
  | {
      readonly tipo: typeof DESFECHO_AVALIACAO_VINCULOS_AMAZON.completa;
      /** One per distinct SKU asked, in the order its link docs were read. */
      readonly skus: readonly VinculoAvaliadoAmazon<E>[];
      readonly leituras: LeiturasVinculosAmazon;
    }
  | {
      readonly tipo: typeof DESFECHO_AVALIACAO_VINCULOS_AMAZON.prazo;
      readonly etapa: EtapaAvaliacaoVinculosAmazon;
      readonly leituras: LeiturasVinculosAmazon;
    };

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

/** `itens` in consecutive slices of at most `tamanho`. */
function fatias<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/** Code-unit order (a SKU is compared as exact bytes). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A unit no read named: no fields, no children. */
const SEM_UNIDADE: UnidadeDoVinculoListingAmazon = { raw: {}, filhosIds: [] };

/** One SKU's resolution: the order import's answer, its link docs, the dono it binds. */
interface ResolucaoDoSku {
  readonly resolucao: ResolucaoVinculoAmazon;
  readonly docs: readonly DocVinculoAmazon[];
  /** The ONE live dono the resolution names, or `null`. */
  readonly dono: DonoLidoAmazon | null;
}

/** Counters being summed. */
interface Contadores {
  consultas: number;
  produtos: number;
  filhos: number;
  ponteiros: number;
  pais: number;
}

/* -------------------------------------------------------------------------- */
/*                                the link reads                              */
/* -------------------------------------------------------------------------- */

/**
 * Read 1 of the module header ON ITS OWN: every SKU's link docs through the
 * order import's OWN query (`lerVinculosDoSkuAmazon`), projected to `campos`
 * (a flow's `vinculo` fields), at most
 * {@link LARGURA_CONSULTAS_VINCULOS_AMAZON} in flight, the deadline read before
 * every batch. `null` when the deadline passed before a batch started.
 */
export async function lerVinculosDosSkusListingAmazon(
  db: Firestore,
  contaId: string,
  skus: readonly string[],
  campos: readonly string[],
  prazo: PrazoVinculosAmazon,
): Promise<Map<string, LeituraVinculosDoSkuAmazon> | null> {
  const leituras = new Map<string, LeituraVinculosDoSkuAmazon>();
  for (const fatia of fatias([...new Set(skus)], LARGURA_CONSULTAS_VINCULOS_AMAZON)) {
    if (prazo.agora() >= prazo.prazoMs) return null;
    const lidas = await Promise.all(
      fatia.map(
        async (sku) => [sku, await lerVinculosDoSkuAmazon(db, contaId, sku, { campos })] as const,
      ),
    );
    for (const [sku, lida] of lidas) leituras.set(sku, lida);
  }
  return leituras;
}

/* -------------------------------------------------------------------------- */
/*                                the evaluator                               */
/* -------------------------------------------------------------------------- */

/**
 * The link verdict of every SKU of `skusPedidos` (deduplicated) of `contaId`
 * (module header): reads 1–4, under the deadline.
 *
 * @throws {RangeError} a conta id outside its grammar, a deadline that is not
 *   a ms instant, or masks of one flow with another flow's verdict binding
 *   (nothing read).
 * @throws Firestore's own failures, untouched.
 */
export async function avaliarVinculosEmLoteAmazon<E extends EnvioDoVinculoListingAmazon>(
  db: Firestore,
  contaId: string,
  skusPedidos: readonly string[],
  opcoes: OpcoesAvaliacaoVinculosAmazon<E>,
): Promise<AvaliacaoVinculosAmazon<E>> {
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('avaliacaoLoteVinculos.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
  const { campos, regra, prazo } = opcoes;
  if (!Number.isSafeInteger(prazo.prazoMs) || prazo.prazoMs < 0) {
    throw new RangeError('avaliacaoLoteVinculos.ts: prazoMs deve ser um instante em ms');
  }
  if (campos.fluxo !== regra.fluxo) {
    throw new RangeError(
      'avaliacaoLoteVinculos.ts: as máscaras e a regra são de fluxos diferentes',
    );
  }
  const extras: ExtrasVinculosAmazon = opcoes.extras ?? { dono: [], unidade: [] };
  const skus = [...new Set(skusPedidos)].sort(porTexto);
  const lidos: Contadores = { consultas: 0, produtos: 0, filhos: 0, ponteiros: 0, pais: 0 };
  const venceu = () => prazo.agora() >= prazo.prazoMs;
  const parou = (etapa: EtapaAvaliacaoVinculosAmazon): AvaliacaoVinculosAmazon<E> => ({
    tipo: DESFECHO_AVALIACAO_VINCULOS_AMAZON.prazo,
    etapa,
    leituras: { ...lidos },
  });

  // ---- 1. Every SKU's link docs: THE query, projected (unless the caller read them). ----
  const leituras = new Map<string, LeituraVinculosDoSkuAmazon>();
  for (const sku of skus) {
    const lida = opcoes.vinculosLidos?.get(sku);
    if (lida !== undefined) leituras.set(sku, lida);
  }
  const aConsultar = skus.filter((sku) => !leituras.has(sku));
  if (aConsultar.length > 0) {
    const lidas = await lerVinculosDosSkusListingAmazon(
      db,
      contaId,
      aConsultar,
      campos.vinculo,
      prazo,
    );
    if (lidas === null) return parou(ETAPA_AVALIACAO_VINCULOS_AMAZON.vinculos);
    lidos.consultas += aConsultar.length;
    for (const [sku, lida] of lidas) leituras.set(sku, lida);
  }

  // ---- 2. The donos, deduplicated across the SKUs, masked, sliced. ----
  const camposDosDonos = [...campos.dono, ...extras.dono];
  /** Every dono read: its masked raw, or `null` when it does not exist. */
  const donos = new Map<string, Readonly<Record<string, unknown>> | null>();
  const donosVivos = new Map<string, DonoLidoAmazon>();
  const donoIds = [
    ...new Set(
      [...leituras.values()].flatMap((l) =>
        l.tipo === 'docs' ? donosDosVinculosAmazon(l.docs) : [],
      ),
    ),
  ].sort(porTexto);
  for (const fatia of fatias(donoIds, MAX_REFS_GETALL_VINCULOS_AMAZON)) {
    if (venceu()) return parou(ETAPA_AVALIACAO_VINCULOS_AMAZON.donos);
    const lidas = await lerDonosAmazon(db, fatia, { campos: camposDosDonos });
    lidos.produtos += fatia.length;
    for (const [i, id] of fatia.entries()) {
      const dono = lidas[i] ?? null;
      donos.set(id, dono === null ? null : dono.raw);
      if (dono !== null) donosVivos.set(id, dono);
    }
  }

  // ---- 3. The resolution per SKU; then the units, their children, the pointers, the parents. ----
  const resolucoes = new Map<string, ResolucaoDoSku>();
  for (const [sku, leitura] of leituras) {
    if (leitura.tipo === 'limite') {
      resolucoes.set(sku, { resolucao: RESOLUCAO_LIMITE_VINCULOS_AMAZON, docs: [], dono: null });
      continue;
    }
    const vivos = donosDosVinculosAmazon(leitura.docs)
      .map((id) => donosVivos.get(id))
      .filter((d): d is DonoLidoAmazon => d !== undefined);
    const resolucao = resolucaoPorUnidadesAmazon(vivos.map((d) => d.unidadeId));
    const [dono] = vivos;
    resolucoes.set(sku, {
      resolucao,
      docs: leitura.docs,
      dono: resolucao.produtoId === null || dono === undefined ? null : dono,
    });
  }
  const ligados = [...resolucoes.values()].flatMap((r) => (r.dono === null ? [] : [r.dono]));

  // The units no read holds yet (a corrupt id is never read). A dono's read
  // holds its unit only when it carried every field the unit is read with.
  const camposDaUnidade = [...new Set<CampoListingAmazon>([...campos.unidade, ...extras.unidade])];
  const unidades = camposContidosListingAmazon(
    camposDaUnidade,
    mascaraDosDonosAmazon(camposDosDonos),
  )
    ? donos
    : new Map<string, Readonly<Record<string, unknown>> | null>();
  const unidadesLegiveis = [
    ...new Set(ligados.map((d) => d.unidadeId).filter((id) => !naoDocId(id))),
  ].sort(porTexto);
  const unidadesLidas = await lerProdutosPorIdListingAmazon(
    db,
    unidadesLegiveis.filter((id) => !unidades.has(id)),
    camposDaUnidade,
    {
      venceu,
      aoLer: (n) => {
        lidos.produtos += n;
      },
    },
  );
  if (unidadesLidas === null) return parou(ETAPA_AVALIACAO_VINCULOS_AMAZON.unidades);
  for (const [id, raw] of unidadesLidas) unidades.set(id, raw);

  // Each distinct unit's children, a bounded batch at a time.
  const filhos = new Map<string, readonly string[]>();
  for (const fatia of fatias(unidadesLegiveis, LARGURA_CONSULTAS_VINCULOS_AMAZON)) {
    if (venceu()) return parou(ETAPA_AVALIACAO_VINCULOS_AMAZON.unidades);
    const lidas = await Promise.all(
      fatia.map(async (id) => [id, await lerFilhosDaUnidadeListingAmazon(db, id)] as const),
    );
    lidos.filhos += fatia.length;
    for (const [id, ids] of lidas) filhos.set(id, ids);
  }

  // The bound donos' parent pointers, deduplicated by path, ≤ 300 distinct refs a call.
  const representantes = new Map<string, DocVinculoAmazon>();
  for (const r of resolucoes.values()) {
    if (r.dono === null) continue;
    for (const doc of r.docs) {
      if (doc.donoId !== r.dono.id) continue;
      const ponteiro = ponteiroPaiDoVinculoListingAmazon(doc.dados.produtoAmazonPaiOuterRef);
      if (ponteiro.tipo === 'caminho' && !representantes.has(ponteiro.caminho)) {
        representantes.set(ponteiro.caminho, doc);
      }
    }
  }
  const pais = new Map<string, AlvoDoPaiListingAmazon>();
  const ordenados = [...representantes.entries()].sort(([a], [b]) => porTexto(a, b));
  for (const fatia of fatias(ordenados, MAX_REFS_GETALL_VINCULOS_AMAZON)) {
    if (venceu()) return parou(ETAPA_AVALIACAO_VINCULOS_AMAZON.unidades);
    const lidas = await lerPaisDosLinksListingAmazon(
      db,
      fatia.map(([, doc]) => doc),
    );
    lidos.ponteiros += fatia.length;
    for (const [caminho, alvo] of lidas) pais.set(caminho, alvo);
  }

  // The units' parents, for a flow that reads them: deduplicated, ≤ 300 a call.
  let paisDasUnidades: ReadonlyMap<string, Readonly<Record<string, unknown>> | null> = new Map();
  const mascaraDoPai = campos.paiDaUnidade;
  if (mascaraDoPai !== null) {
    const paisLidos = await lerProdutosPorIdListingAmazon(
      db,
      paiIdsDasUnidadesListingAmazon(unidadesLegiveis.map((id) => unidades.get(id) ?? null)),
      mascaraDoPai,
      {
        venceu,
        aoLer: (n) => {
          lidos.pais += n;
        },
      },
    );
    if (paisLidos === null) return parou(ETAPA_AVALIACAO_VINCULOS_AMAZON.unidades);
    paisDasUnidades = paisLidos;
  }

  // ---- 4. The verdict per SKU, over the per-SKU reader's own input shape. ----
  const avaliados: VinculoAvaliadoAmazon<E>[] = [];
  for (const [sku, r] of resolucoes) {
    const entrada = entradaDoVinculo(contaId, sku, r, campos, unidades, filhos, pais);
    const unidade =
      r.dono === null || naoDocId(r.dono.unidadeId)
        ? null
        : (unidades.get(r.dono.unidadeId) ?? null);
    avaliados.push({
      sku,
      veredicto: avaliarVinculoListingAmazon(entrada, regra),
      entrada,
      unidade,
      paiDaUnidade:
        r.dono === null
          ? null
          : paiDaUnidadeNoLoteListingAmazon(unidade, mascaraDoPai, paisDasUnidades),
    });
  }
  return {
    tipo: DESFECHO_AVALIACAO_VINCULOS_AMAZON.completa,
    skus: avaliados,
    leituras: { ...lidos },
  };
}

/* -------------------------------------------------------------------------- */
/*                         the by-id reads, on their own                       */
/* -------------------------------------------------------------------------- */

/**
 * Produtos by id, masked to `campos` (read 3's units and parents, ON THEIR
 * OWN, for a reader that already holds the ids): each id's document as read,
 * or `null` when it does not exist. The ids are deduplicated and read in
 * code-unit order, in `getAll` calls of at most
 * {@link MAX_REFS_GETALL_VINCULOS_AMAZON} refs; an id that is not a document
 * id is never read and has no entry. `prazo.venceu` is read before every
 * call: once it answers `true`, nothing more is started and the answer is
 * `null`, `prazo.aoLer` having been told the size of every call already made.
 */
export async function lerProdutosPorIdListingAmazon(
  db: Firestore,
  ids: readonly string[],
  campos: readonly CampoListingAmazon[],
  prazo: { readonly venceu: () => boolean; readonly aoLer: (n: number) => void },
): Promise<Map<string, Readonly<Record<string, unknown>> | null> | null> {
  const lidos = new Map<string, Readonly<Record<string, unknown>> | null>();
  const legiveis = [...new Set(ids)].filter((id) => !naoDocId(id)).sort(porTexto);
  for (const fatia of fatias(legiveis, MAX_REFS_GETALL_VINCULOS_AMAZON)) {
    if (prazo.venceu()) return null;
    const snaps = await db.getAll(...fatia.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: mascaraFirestoreListingAmazon(campos),
    });
    prazo.aoLer(fatia.length);
    for (const [i, id] of fatia.entries()) {
      const snap = snaps[i];
      lidos.set(
        id,
        snap?.exists === true ? ((snap.data() ?? {}) as Record<string, unknown>) : null,
      );
    }
  }
  return lidos;
}

/**
 * The parents the given units' documents name, to read with
 * {@link lerProdutosPorIdListingAmazon}: each `paiId` that is a document id,
 * deduplicated, in code-unit order. A unit not read (`null`), or one whose
 * `paiId` is `null`, absent or not a document id, names none to read.
 */
export function paiIdsDasUnidadesListingAmazon(
  unidades: Iterable<Readonly<Record<string, unknown>> | null>,
): string[] {
  const paiIds = new Set<string>();
  for (const raw of unidades) {
    if (raw === null) continue;
    const pai = paiIdDaUnidadeListingAmazon(raw);
    if (pai.nomeia && pai.id !== null) paiIds.add(pai.id);
  }
  return [...paiIds].sort(porTexto);
}

/**
 * One unit's parent as the per-SKU reader answers it, from the parents a
 * batch read: `null` when the flow reads none (`mascaraDoPai` `null`), or the
 * unit was not read or names none; `{ id: null, raw: null }` for a `paiId`
 * that is not a document id; else the parent's document as read (`raw: null`
 * when it does not exist or was not read).
 */
export function paiDaUnidadeNoLoteListingAmazon(
  unidade: Readonly<Record<string, unknown>> | null,
  mascaraDoPai: readonly CampoListingAmazon[] | null,
  paisDasUnidades: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>,
): PaiDaUnidadeListingAmazon | null {
  if (mascaraDoPai === null) return null;
  const pai = paiIdDaUnidadeListingAmazon(unidade ?? {});
  if (!pai.nomeia) return null;
  if (pai.id === null) return { id: null, raw: null };
  return { id: pai.id, raw: paisDasUnidades.get(pai.id) ?? null };
}

/**
 * One SKU's verdict input (module header, read 4): exactly what the per-SKU
 * reader hands the verdict with the same masks — the dono projected to the
 * reader's dono mask, the unit to the flow's unit fields, the bound dono's own
 * pointers only.
 */
function entradaDoVinculo(
  contaId: string,
  sku: string,
  r: ResolucaoDoSku,
  campos: CamposVinculoListingAmazon,
  unidades: ReadonlyMap<string, Readonly<Record<string, unknown>> | null>,
  filhos: ReadonlyMap<string, readonly string[]>,
  pais: ReadonlyMap<string, AlvoDoPaiListingAmazon>,
): EntradaVinculoListingAmazon {
  const { resolucao, docs, dono } = r;
  if (dono === null) {
    return {
      contaId,
      sku,
      resolucao,
      dono: null,
      linksDoSku: docs,
      paisDosLinks: new Map(),
      unidade: SEM_UNIDADE,
    };
  }
  const caminhos = new Set<string>();
  for (const doc of docs) {
    if (doc.donoId !== dono.id) continue;
    const ponteiro = ponteiroPaiDoVinculoListingAmazon(doc.dados.produtoAmazonPaiOuterRef);
    if (ponteiro.tipo === 'caminho') caminhos.add(ponteiro.caminho);
  }
  const paisDoSku = new Map<string, AlvoDoPaiListingAmazon>();
  for (const caminho of [...caminhos].sort(porTexto)) {
    const alvo = pais.get(caminho);
    if (alvo !== undefined) paisDoSku.set(caminho, alvo);
  }
  const rawUnidade = naoDocId(dono.unidadeId) ? null : (unidades.get(dono.unidadeId) ?? null);
  return {
    contaId,
    sku,
    resolucao,
    dono: {
      id: dono.id,
      raw: projetarCamposListingAmazon(dono.raw, mascaraDosDonosAmazon(campos.dono)),
    },
    linksDoSku: docs,
    paisDosLinks: paisDoSku,
    unidade: {
      raw: projetarCamposListingAmazon(rawUnidade ?? {}, campos.unidade),
      filhosIds: filhos.get(dono.unidadeId) ?? [],
    },
  };
}
