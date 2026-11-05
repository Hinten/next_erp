/**
 * The product import's ADD-CHILD (master plan step 9, "complete"): a store variation missing from
 * an ERP family the cascade matched (`ausente` under the matched parent) is added to that family —
 * its produto, its `extraData` and this conta's link — together with the parent's `filhoUnicoId`
 * re-derived over the FULL child set, in ONE batch. Under Simular the same reads, checks and probe
 * run and nothing is written.
 *
 * Call it only once the PARENT's link of this conta stands on `erpPaiId` (`vinculos.ts` confirmed
 * it, or under Simular would): a variation is never linked beside a missing parent link.
 *
 * ## Which variations
 *
 * Every variation the cascade left `ausente` whose options ALL resolved (`resolverFilhosLi` resolved
 * them over the grupos the caller passed: the memo, plus the Simular overlay) — a variation with an
 * option that did not resolve, with no SKU, or with a SKU the store repeats was already reported by
 * the cascade, and is skipped here with nothing added. On top of it, a variation is added ONLY when
 *  - it is visible: a hidden or blocked one is never created (`oculto-nao-criado`; decided
 *    2026-11-03 — the next run adds it once the store shows it);
 *  - every option's grupo is one the family ALREADY uses — the parent's `grupoDeVariacoesUid`, or a
 *    child's `grupoDeVariacoesUid` or `variacoesUid` — else `variacao-sem-vinculo` naming the
 *    options: a new axis would change the family's shape, which the import never does;
 *  - its combination of variantes is no existing child's (`variacao-ambigua`, naming it) and no
 *    other added variation's (`variacao-ambigua` on both);
 *  - every planned document parses (`dado-invalido`, field names) and its SKU passes the create
 *    probe: an exact hit anywhere in the catalogue ⇒ `sku-ja-existe` naming the ERP ids, a
 *    "parecido" hit alone ⇒ `sku-parecido` — that variation is left out, the others still added.
 * A variation added is built by the whole-family create's rules (`familiaNova.ts`): the id keyed by
 * its SKU, the name by the ERP family rule over the ERP PARENT's stored name, the taxonomy from the
 * resolution, the store's values through the fill-empty's one field map (the parent's resolved
 * category, the parent's box when its own read detail has none), `ordem` after the highest the
 * siblings hold.
 *
 * ## Each attempt (root rule 7, the plan's row 8) — tier 1 on the PARENT
 *
 *  1. The parent by id — gone, or itself a child ⇒ `conflito-de-escrita` and nothing added — and the
 *     FULL child set (`paiId == <parent>`).
 *  2. Each planned id by id ({@link estadoDoIdPlanejadoLi}): the variation's SKU under this parent
 *     already there ⇒ not created again — this conta's link beside it, born in the same commit, is
 *     THIS conta's batch landed with its reply lost (counted as added, `retomado`); otherwise another
 *     writer's (another conta's import of the same store family) ⇒ `existentes`, for the caller's
 *     existing-product path (fill and link). Anything else at the id ⇒ `sku-ja-existe`.
 *  3. The checks above, the grupos read by id, the probe — in the same dispatch, immediately before
 *     the commit, no Loja Integrada call in between.
 *  4. ONE batch: every child `create()`, their `extraData` and link `create()`s, and
 *     `update(parent, { filhoUnicoId: derivarFilhoUnico(<the child set read in THIS attempt> +
 *     <the added ones>), ultimaModificacao }, { lastUpdateTime: <the parent's read> })` — written
 *     even when the pointer does not move: it is the guard. Every ERP writer that changes a child
 *     set writes the parent in the same batch (`familia.ts`), so a sibling deleted or added between
 *     step 1 and the commit fails the precondition; a 9 (or 5, or a 6 on a child id) starts the next
 *     attempt from step 1 — the parent AND the child set re-read, everything re-planned. At most
 *     {@link MAX_TENTATIVAS_FILHO_NOVO_LI} attempts, then `conflito-de-escrita`.
 *
 * ## After the commit: the pointer re-derived ({@link rederivarFilhoUnicoLi})
 *
 * A writer that changes the child set WITHOUT writing the parent (a sibling created alone, its
 * pointer fixed afterwards) is invisible to the precondition. So after a landed add the pointer is
 * derived again from a live read — `paiId == <parent> limit 2` (two answer "one or more than one"),
 * the parent re-read — and written tier 1 on that read when it differs; a lost precondition re-runs
 * the WHOLE derivation once. The shape and its stated residual are the Mercado Livre importer's
 * (`apps/mercado-livre/lib/marketplace/importacao/import.ts`, `aplicarPonteiroMembroUnico`): a
 * second concurrent writer in the same instant is not worth a loop, and the pointer self-heals on
 * that writer's own derivation, the next import or the next save of the produto.
 *
 * ⚠️ Accepted residuals: the parent's selection (`variacoesUid`, the variation screen's picked
 * variantes) is NOT extended with an added child's variante — it is not empty, and the import never
 * writes over a value; the child shows in the family regardless. An operator's hand-made produto
 * with an added SKU (an auto id) landing between the probe and the commit is the next run's
 * `sku-ambiguo`.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 *  - the child set (`paiId == <parent>`) and the re-derive (`… limit 2`): the prefix of
 *    `produtos (paiId ASC, nome ASC)`, the read the Mercado Livre importer rides too;
 *  - the probe: `produtos where sku in [...]`, served by `produtos (sku ASC)`;
 *  - the parent, the planned ids, a link and the grupos: documents by id.
 *
 * ## Errors (root rule 6)
 *
 * Only the codes a guarded write loses with are caught, narrowed by their gRPC code
 * (`FAILED_PRECONDITION`, `NOT_FOUND`, `ALREADY_EXISTS`); everything else propagates and the task
 * retries.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import { sondarSkusLi } from '@delfrance/data/admin/produtos';
import {
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  derivarFilhoUnico,
  idFromRefOrNull,
  parseFakePath,
  sameCombo,
} from '@delfrance/schemas';

import { valoresDoLiLi } from './completar';
import {
  ESTADO_DO_ID_PLANEJADO_LI,
  type OpcaoResolvidaLi,
  PAPEL_DO_PRODUTO_CRIADO_LI,
  type ProdutoPlanejadoLi,
  type SkuSondadoLi,
  combinacaoLi,
  criadoComOVinculoDaContaLi,
  enfileirarCriacoesLi,
  estadoDoIdPlanejadoLi,
  idProdutoCriadoLi,
  lerGruposErpLi,
  opcoesResolvidasLi,
  paiArmazenadoLi,
  planejarDocCriadoLi,
  taxonomiaDoFilhoLi,
  veredictoDaSondaLi,
} from './familiaNova';
import type { FamiliaLi, FilhoDaFamiliaLi } from './familias';
import {
  PAPEL_DO_VINCULO_LI,
  type PendenciaDoPlanoLi,
  type VinculoPlanejadoLi,
  ocultoNaLojaLi,
  planejarVinculoLi,
} from './plano';
import { type ResolucaoDosFilhosLi, SITUACAO_DO_FILHO_LI } from './resolucao';

/** The attempts of one add: the first and two re-plans after a lost commit (module header). */
export const MAX_TENTATIVAS_FILHO_NOVO_LI = 3;

/* -------------------------------------------------------------------------- */
/*                                   The pointer                               */
/* -------------------------------------------------------------------------- */

/** How the post-commit re-derive ended. */
export type DesfechoDoPonteiroLi =
  /** The stored pointer is what the live child set says. */
  | 'igual'
  /** It was not, and was written. */
  | 'corrigido'
  /** Its write lost twice; the next derivation repairs it (module header). */
  | 'perdeu'
  /** The parent is gone. */
  | 'pai-ausente';

/** Named members of {@link DesfechoDoPonteiroLi}. */
export const DESFECHO_DO_PONTEIRO_LI = {
  igual: 'igual',
  corrigido: 'corrigido',
  perdeu: 'perdeu',
  paiAusente: 'pai-ausente',
} as const satisfies Record<string, DesfechoDoPonteiroLi>;

/**
 * Re-derive parent `paiId`'s `filhoUnicoId` from a LIVE read (module header, "After the commit"):
 * the parent, then `paiId == <parent> limit 2`; written tier 1 on the parent's read only when it
 * differs; a lost precondition re-runs the whole derivation `tentativas` more times.
 */
export async function rederivarFilhoUnicoLi(
  db: Firestore,
  paiId: string,
  agoraMs: number,
  tentativas = 1,
): Promise<DesfechoDoPonteiroLi> {
  const ref = produtoCollection.docRef(db, {}, paiId);
  const snap = await ref.get();
  if (!snap.exists || snap.updateTime === undefined) return DESFECHO_DO_PONTEIRO_LI.paiAusente;
  const filhos = await produtoCollection.ref(db, {}).where('paiId', '==', paiId).limit(2).get();
  const filhoUnicoId = derivarFilhoUnico(filhos.docs.map((d) => ({ id: d.id })));
  const armazenado: unknown = ((snap.data() ?? {}) as Record<string, unknown>).filhoUnicoId;
  if ((armazenado ?? null) === filhoUnicoId) return DESFECHO_DO_PONTEIRO_LI.igual;
  try {
    await ref.update(produtoCollection.parseMerge({ filhoUnicoId, ultimaModificacao: agoraMs }), {
      lastUpdateTime: snap.updateTime,
    });
    return DESFECHO_DO_PONTEIRO_LI.corrigido;
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
  }
  // ⚠️ The DERIVATION re-runs, not just the write: the point is to see what invalidated it.
  if (tentativas > 0) return rederivarFilhoUnicoLi(db, paiId, agoraMs, tentativas - 1);
  return DESFECHO_DO_PONTEIRO_LI.perdeu;
}

/* -------------------------------------------------------------------------- */
/*                                 The family's grupos                          */
/* -------------------------------------------------------------------------- */

/** The bare ids of a stored list of grupo refs or variante fake paths (strings only). */
function idsDe(v: unknown, ler: (s: string) => string | null): string[] {
  if (!Array.isArray(v)) return [];
  const lista: readonly unknown[] = v;
  return lista.flatMap((x) => {
    const id = typeof x === 'string' ? ler(x) : null;
    return id === null ? [] : [id];
  });
}

/**
 * The grupos an ERP family already uses (module header, "Which variations"): the parent's
 * `grupoDeVariacoesUid`, and each child's `grupoDeVariacoesUid` and the grupo of each of its
 * `variacoesUid` — every stored ref form read through the shared readers. Pure.
 */
export function gruposDaFamiliaErpLi(
  pai: Readonly<Record<string, unknown>>,
  filhos: readonly Readonly<Record<string, unknown>>[],
): ReadonlySet<string> {
  const grupos = new Set<string>(idsDe(pai.grupoDeVariacoesUid, idFromRefOrNull));
  for (const f of filhos) {
    for (const id of idsDe(f.grupoDeVariacoesUid, idFromRefOrNull)) grupos.add(id);
    for (const id of idsDe(f.variacoesUid, (s) => parseFakePath(s)?.grupoId ?? null)) {
      grupos.add(id);
    }
  }
  return grupos;
}

/* -------------------------------------------------------------------------- */
/*                                   The add                                   */
/* -------------------------------------------------------------------------- */

export interface DepsFilhoNovoLi {
  readonly db: Firestore;
  /** The Loja Integrada conta (integração doc id) the job reads. */
  readonly contaId: string;
  /** Simular reads, checks and probes exactly as `aplicar` does, and writes nothing. */
  readonly modo: ModoImportacaoLi;
  /** The job's clock, ms: the created produtos' stamps and the parent's `ultimaModificacao`. */
  readonly agoraMs: () => number;
  /**
   * Test seam: runs after an attempt's child-set read, its checks and its probe, right before its
   * commit — where a sibling delete lands in the emulator suite. Production passes nothing.
   */
  readonly antesDoCommit?: () => Promise<void> | void;
}

export interface EntradaDoFilhoNovoLi {
  /** The store family, with the details this job read. */
  readonly familia: FamiliaLi;
  /** The matched ERP parent. */
  readonly erpPaiId: string;
  /** The cascade's verdict on the family's variations under `erpPaiId` (`resolverFilhosLi`). */
  readonly filhos: Pick<ResolucaoDosFilhosLi, 'filhos'>;
  /** SKUs two store rows carry (`skusRepetidosNaLojaLi`): never created. */
  readonly skusRepetidos: ReadonlySet<string>;
  /** The parent's resolved ERP categoria — what its existing variations are filled with too. */
  readonly categoriaErpId: string | null;
  /** The job's brand list. */
  readonly marcas: readonly MarcaCatalogoLi[];
}

/** One variation added (Simular: that would be). */
export interface FilhoAdicionadoLi {
  readonly liId: number;
  readonly produtoId: string;
  /** This conta's batch had already landed (its reply lost): nothing written for it by this call. */
  readonly retomado: boolean;
}

/** A variation found at its id, under this parent, from another writer's add. */
export interface FilhoExistenteLi {
  readonly liId: number;
  readonly produtoId: string;
}

export interface ResultadoDoFilhoNovoLi {
  readonly adicionados: readonly FilhoAdicionadoLi[];
  /** For the caller's existing-product path (fill and link). */
  readonly existentes: readonly FilhoExistenteLi[];
  /** The links the batch wrote beside the added variations (none for a `retomado` one). */
  readonly vinculos: readonly VinculoPlanejadoLi[];
  readonly pendencias: readonly PendenciaDoPlanoLi[];
  /** Store ids whose produto name was cut. */
  readonly nomesCortados: readonly number[];
  /** A batch of this call landed (`aplicar` only). */
  readonly gravado: boolean;
  /** The post-commit re-derive; `null` when nothing was added under `aplicar`. */
  readonly ponteiro: DesfechoDoPonteiroLi | null;
}

/** A variation the add considers: visible, with a SKU and every option resolved. */
interface Candidato {
  readonly filho: FilhoDaFamiliaLi;
  readonly sku: string;
  readonly produtoId: string;
  readonly opcoes: readonly OpcaoResolvidaLi[];
}

/** One attempt: a result, or a lost commit (the caller re-plans). */
type Tentativa =
  | { readonly tipo: 'fim'; readonly resultado: ResultadoDoFilhoNovoLi }
  | { readonly tipo: 'perdeu' };

/** The highest integer `ordem` the siblings hold, or `-1`. */
function maiorOrdem(filhos: readonly Readonly<Record<string, unknown>>[]): number {
  return filhos.reduce(
    (m, f) => (typeof f.ordem === 'number' && Number.isInteger(f.ordem) ? Math.max(m, f.ordem) : m),
    -1,
  );
}

/** One attempt (module header, "Each attempt"). */
async function tentar(
  deps: DepsFilhoNovoLi,
  entrada: EntradaDoFilhoNovoLi,
  candidatos: readonly Candidato[],
  pendenciasFixas: readonly PendenciaDoPlanoLi[],
): Promise<Tentativa> {
  const { db } = deps;
  const { familia, erpPaiId } = entrada;
  const pendencias: PendenciaDoPlanoLi[] = [...pendenciasFixas];
  const recusar = (codigo: PendenciaDoPlanoLi['codigo'], liId: number | null, refs: string[]) => {
    pendencias.push({ codigo, liId, referencias: refs });
  };
  const fim = (r: Partial<ResultadoDoFilhoNovoLi>): Tentativa => ({
    tipo: 'fim',
    resultado: {
      adicionados: [],
      existentes: [],
      vinculos: [],
      nomesCortados: [],
      gravado: false,
      ponteiro: null,
      ...r,
      pendencias,
    },
  });

  // (1) The parent and the FULL child set.
  const paiRef = produtoCollection.docRef(db, {}, erpPaiId);
  const paiSnap = await paiRef.get();
  const pai = (paiSnap.data() ?? {}) as Record<string, unknown>;
  if (!paiSnap.exists || paiSnap.updateTime === undefined || paiArmazenadoLi(pai) !== null) {
    recusar(PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, null, [erpPaiId]);
    return fim({});
  }
  const conjunto = await produtoCollection.ref(db, {}).where('paiId', '==', erpPaiId).get();
  const irmaos = conjunto.docs.map((d) => ({
    id: d.id,
    dados: (d.data() ?? {}) as Record<string, unknown>,
  }));

  // (2) The planned ids.
  const snaps = await Promise.all(
    candidatos.map((c) => produtoCollection.docRef(db, {}, c.produtoId).get()),
  );
  const adicionados: FilhoAdicionadoLi[] = [];
  const existentes: FilhoExistenteLi[] = [];
  const livres: Candidato[] = [];
  for (const [i, c] of candidatos.entries()) {
    const snap: DocumentSnapshot | undefined = snaps[i];
    const liId = c.filho.linha.id;
    const estado =
      snap === undefined
        ? ESTADO_DO_ID_PLANEJADO_LI.livre
        : estadoDoIdPlanejadoLi(snap, { sku: c.sku, paiId: erpPaiId });
    if (estado === ESTADO_DO_ID_PLANEJADO_LI.outro) {
      recusar(PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId, [c.produtoId]);
    } else if (estado === ESTADO_DO_ID_PLANEJADO_LI.nosso && snap !== undefined) {
      const nosso =
        deps.modo !== MODO_IMPORTACAO_LI.simular &&
        (await criadoComOVinculoDaContaLi(db, deps.contaId, snap, liId));
      if (nosso) adicionados.push({ liId, produtoId: c.produtoId, retomado: true });
      else existentes.push({ liId, produtoId: c.produtoId });
    } else {
      livres.push(c);
    }
  }

  // (3) The family's grupos, the combinations.
  const gruposDaFamilia = gruposDaFamiliaErpLi(
    pai,
    irmaos.map((i) => i.dados),
  );
  const aptos: Candidato[] = [];
  for (const c of livres) {
    const liId = c.filho.linha.id;
    const novos = c.opcoes.filter((o) => !gruposDaFamilia.has(o.grupoId));
    if (novos.length > 0) {
      recusar(
        PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
        liId,
        novos.map((o) => `${String(o.gradeId)}/${String(o.opcaoId)}`),
      );
      continue;
    }
    const combinacao = combinacaoLi(c.opcoes);
    const iguais = irmaos.filter((i) => {
      const uids: unknown = i.dados.variacoesUid;
      return (
        Array.isArray(uids) &&
        sameCombo(
          uids.filter((u): u is string => typeof u === 'string'),
          combinacao,
        )
      );
    });
    if (iguais.length > 0) {
      recusar(
        PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
        liId,
        iguais.map((i) => i.id),
      );
      continue;
    }
    if (livres.some((o) => o !== c && sameCombo(combinacaoLi(o.opcoes), combinacao))) {
      recusar(PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId, []);
      continue;
    }
    aptos.push(c);
  }

  // The names, by the ERP family rule over the parent's stored name.
  const nomeDoPai = typeof pai.nome === 'string' && pai.nome !== '' ? pai.nome : null;
  const planejados: ProdutoPlanejadoLi[] = [];
  const nomesCortados: number[] = [];
  let ordem = -1;
  if (aptos.length > 0 && nomeDoPai === null) {
    for (const c of aptos)
      recusar(PENDENCIA_IMPORTACAO_LI.dadoInvalido, c.filho.linha.id, ['nome']);
  } else if (aptos.length > 0 && nomeDoPai !== null) {
    const grupos = await lerGruposErpLi(
      db,
      aptos.flatMap((c) => c.opcoes.map((o) => o.grupoId)),
    );
    const agora = deps.agoraMs();
    ordem = maiorOrdem(irmaos.map((i) => i.dados));
    for (const c of aptos) {
      const { linha, detalhe } = c.filho;
      const t = taxonomiaDoFilhoLi(c.opcoes, nomeDoPai, grupos);
      if (t.tipo === 'recusada') {
        recusar(t.codigo, linha.id, [...t.referencias]);
        continue;
      }
      const doc = planejarDocCriadoLi(
        {
          nome: t.nome,
          sku: c.sku,
          paiId: erpPaiId,
          // Provisional: the final `ordem` is given to the variations the probe lets through.
          ordem: ordem + 1,
          variacoesUid: [...t.variacoesUid],
          grupoDeVariacoesUid: [...t.grupoDeVariacoesUid],
        },
        valoresDoLiLi({
          papel: PAPEL_DO_VINCULO_LI.filho,
          linha,
          detalhe,
          detalheDoPai: familia.detalheDaRaiz,
          categoriaErpId: entrada.categoriaErpId,
          marcas: entrada.marcas,
        }),
        typeof detalhe?.usado === 'boolean'
          ? detalhe.usado
          : typeof familia.detalheDaRaiz?.usado === 'boolean'
            ? familia.detalheDaRaiz.usado
            : null,
        agora,
      );
      if (doc.tipo === 'invalido') {
        recusar(PENDENCIA_IMPORTACAO_LI.dadoInvalido, linha.id, [...doc.campos]);
        continue;
      }
      const vinculo = planejarVinculoLi(
        deps.contaId,
        PAPEL_DO_VINCULO_LI.filho,
        c.produtoId,
        linha,
        detalhe,
        familia.raiz.id,
      );
      if (vinculo.tipo === 'invalido') {
        recusar(PENDENCIA_IMPORTACAO_LI.dadoInvalido, linha.id, [...vinculo.campos]);
        continue;
      }
      if (doc.descricaoLongaTamanho !== null) {
        recusar(PENDENCIA_IMPORTACAO_LI.descricaoLonga, linha.id, [
          String(doc.descricaoLongaTamanho),
        ]);
      }
      if (t.nomeCortado) nomesCortados.push(linha.id);
      planejados.push({
        produtoId: c.produtoId,
        papel: PAPEL_DO_PRODUTO_CRIADO_LI.filho,
        liId: linha.id,
        sku: c.sku,
        paiId: erpPaiId,
        doc: { ...doc.doc },
        extraData: doc.extraData,
        vinculo: vinculo.vinculo,
      });
    }
  }

  // The probe, immediately before the commit.
  let aCriar = planejados;
  if (planejados.length > 0) {
    const skus: SkuSondadoLi[] = planejados.map((p) => ({ sku: p.sku, liId: p.liId }));
    const sonda = await sondarSkusLi(
      db,
      skus.map((s) => s.sku),
    );
    const colisoes = veredictoDaSondaLi(sonda, skus, new Set(candidatos.map((c) => c.produtoId)));
    pendencias.push(...colisoes);
    const recusados = new Set(colisoes.map((p) => p.liId));
    // `ordem` after the highest the siblings hold, in the order the survivors were planned.
    aCriar = planejados
      .filter((p) => !recusados.has(p.liId))
      .map((p, i) => ({ ...p, doc: { ...p.doc, ordem: ordem + 1 + i } }));
  }
  const resultado = {
    adicionados: [
      ...adicionados,
      ...aCriar.map((p) => ({ liId: p.liId, produtoId: p.produtoId, retomado: false })),
    ].sort((a, b) => a.liId - b.liId),
    existentes,
    vinculos: aCriar.flatMap((p) => (p.vinculo === null ? [] : [p.vinculo])),
    nomesCortados: nomesCortados.filter((id) => aCriar.some((p) => p.liId === id)),
  };
  if (deps.modo === MODO_IMPORTACAO_LI.simular) return fim(resultado);
  if (aCriar.length === 0) {
    // Nothing to write; a landed batch of ours still has its pointer checked against a live read.
    const ponteiro =
      adicionados.length > 0 ? await rederivarFilhoUnicoLi(db, erpPaiId, deps.agoraMs()) : null;
    return fim({ ...resultado, gravado: adicionados.length > 0, ponteiro });
  }

  // (4) ONE batch: the children, their extraData and links, and the parent's pointer under its read.
  const lote = db.batch();
  enfileirarCriacoesLi(db, lote, aCriar);
  lote.update(
    paiRef,
    produtoCollection.parseMerge({
      filhoUnicoId: derivarFilhoUnico([
        ...irmaos.map((i) => ({ id: i.id })),
        ...aCriar.map((p) => ({ id: p.produtoId })),
      ]),
      ultimaModificacao: deps.agoraMs(),
    }),
    { lastUpdateTime: paiSnap.updateTime },
  );
  await deps.antesDoCommit?.();
  try {
    await lote.commit();
  } catch (err) {
    if (isFailedPrecondition(err) || isNotFound(err) || isAlreadyExists(err)) {
      return { tipo: 'perdeu' };
    }
    throw err;
  }
  const ponteiro = await rederivarFilhoUnicoLi(db, erpPaiId, deps.agoraMs());
  return fim({ ...resultado, gravado: true, ponteiro });
}

/**
 * Add the store variations missing from a matched ERP family (module header), or — under Simular —
 * decide exactly what `aplicar` would. Call it after the parent's link is confirmed, once every
 * detail the family needs is read, with no Loja Integrada call between this call's start and end.
 */
export async function adicionarFilhosLi(
  deps: DepsFilhoNovoLi,
  entrada: EntradaDoFilhoNovoLi,
): Promise<ResultadoDoFilhoNovoLi> {
  const porId = new Map(entrada.familia.filhos.map((f) => [f.linha.id, f]));
  const fixas: PendenciaDoPlanoLi[] = [];
  const candidatos: Candidato[] = [];
  for (const r of entrada.filhos.filhos) {
    const filho = porId.get(r.liId);
    if (r.situacao !== SITUACAO_DO_FILHO_LI.ausente || filho === undefined) continue;
    if (ocultoNaLojaLi(filho.linha)) {
      fixas.push({
        codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado,
        liId: r.liId,
        referencias: [],
      });
      continue;
    }
    // No SKU, a SKU the store repeats, an option that did not resolve: the cascade reported it.
    const { sku } = filho.linha;
    const opcoes = opcoesResolvidasLi(r.opcoes);
    if (sku === null || entrada.skusRepetidos.has(sku) || opcoes.tipo === 'recusada') continue;
    candidatos.push({ filho, sku, produtoId: idProdutoCriadoLi(sku), opcoes: opcoes.opcoes });
  }
  const vazio: ResultadoDoFilhoNovoLi = {
    adicionados: [],
    existentes: [],
    vinculos: [],
    pendencias: fixas,
    nomesCortados: [],
    gravado: false,
    ponteiro: null,
  };
  if (candidatos.length === 0) return vazio;

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_FILHO_NOVO_LI; tentativa += 1) {
    const t = await tentar(deps, entrada, candidatos, fixas);
    if (t.tipo === 'fim') return t.resultado;
  }
  return {
    ...vazio,
    pendencias: [
      ...fixas,
      ...candidatos.map((c) => ({
        codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
        liId: c.filho.linha.id,
        referencias: [entrada.erpPaiId],
      })),
    ],
  };
}
