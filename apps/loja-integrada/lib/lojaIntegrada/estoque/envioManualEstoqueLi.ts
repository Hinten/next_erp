/**
 * The MANUAL stock push (master plan step 12, PR 12-h): the core of `POST
 * /api/marketplace/loja-integrada/enviar-estoque`, the produtos table's "enviar estoque" for a
 * Loja Integrada conta. It ENQUEUES; it sends nothing. One `estoque` task (`origem: manual`, ids
 * only) per linked child onto the stock queue, through the merged pure producer
 * (`agendadorEstoque.ts`); the send run decides minutes later, from its own fresh reads, whether
 * anything is written. So a queued row says `enfileirado`, never "sent". Next-free, `db`, the
 * producer and the clock are parameters; no environment read, no Loja Integrada call, no
 * credential read (`estrutura.test.ts` walks the route's closure).
 *
 * ## In order (each read the cheapest that answers its question)
 *
 *  1. The selected ids, deduplicated in request order (`solicitados` counts these).
 *  2. ONE masked `getAll` of all of them (≤ {@link MAX_PRODUTOS_ENVIO_ESTOQUE_LI} point reads,
 *     {@link CAMPOS_PRODUTO_ENVIO_MANUAL_LI}). A missing document ⇒ ONE `produto-ausente` entry;
 *     one whose `integracoesComProduto` does not name the conta ⇒ ONE `sem-vinculo` entry and no
 *     further read. That array is the produto-side conta list the other channels' sweeps
 *     pre-filter on — deliberately OVER-inclusive (`produtos/integracoesComProdutoLi.ts`), so a
 *     produto it lists is still classified by its links below; a link it misses is the window
 *     backfill's to restore, and such a produto is still covered by the stock trigger and the
 *     nightly reconcile, which never read the array. This is what keeps a mixed selection — the
 *     whole /produtos selection reaches every supported channel — from paying a listing per child
 *     of every family that is not on this store.
 *  3. A selected CHILD (`paiId` set) is its own target. A selected ROOT that passed is expanded:
 *     ONE query `produtos where paiId == <root> and integracoesComProduto array-contains <conta>`,
 *     projected to {@link CAMPOS_FILHO_ENVIO_MANUAL_LI}, `limit` {@link MAX_ALVOS_ENVIO_ESTOQUE_LI}
 *     + 1 — on the declared COLLECTION index `produtos (paiId, integracoesComProduto, __name__)`,
 *     the SAME constant the `.where()` calls are built from (`envioManualEstoqueLi.test.ts` pins
 *     the shape against `firestore.indexes.json`; Enterprise bills data scanned). Children found
 *     ⇒ they are the targets and the root never is (a parent's row is never sent); none ⇒ the
 *     root is its own target (a simple produto, or a parent none of whose children names the
 *     conta — its links then say `pai`). {@link CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI} at a time.
 *  4. The targets, deduplicated (a root and one of its children both selected make one task).
 *     More than {@link MAX_ALVOS_ENVIO_ESTOQUE_LI} ⇒ `excede-limite`, refused WHOLE before any
 *     listing or enqueue — never truncated.
 *  5. Per target, ONE where-less listing of its own `produtolojaintegrada` documents
 *     (`lerVinculosDoProdutoLi`, the send run's own read: the produto's partition, no index), then
 *     the send run's own link-only plan (`planoDosVinculosEstoqueLi`, the ONE copy): `vinculado`
 *     ⇒ the enqueue; `paridade` (the operator's per-listing "do not send stock") and `pai` /
 *     `nao-suportado` / `vinculo-ambiguo` ⇒ a `pulado` row; `sem-vinculo` ⇒ no row. A selected id
 *     none of whose targets made a row gets ONE `sem-vinculo` entry, never one per child.
 *  6. The enqueue: `enfileirarTarefaEstoqueLi`, the clock read right before it, so the task is
 *     NAMED by its minute window — a double click in the same minute meets its own task (an
 *     answered already-exists is success, and still `enfileirado`); a click in the next minute is
 *     one more send run. A transient Cloud Tasks failure on one target is that row's `falha`
 *     (`fila-indisponivel`: it may have landed, and a repeat in the same minute collides); the
 *     round still finishes. Anything else — a `ZodError`, the root's `MissingRegionError`, a
 *     deploy-shaped refusal, the closed valve the route already checked — is rethrown once the
 *     round settles: a 500 after which some tasks MAY exist.
 *
 * Cost per request: one conta read (the route's), one `getAll` of the selection, one index query
 * per selected root that names the conta, one listing per target (≤ {@link
 * MAX_ALVOS_ENVIO_ESTOQUE_LI}, each about the size of its few link documents), one enqueue per
 * linked child. No produto read beyond the masked selection, no stock record, no Firestore write.
 *
 * ## What stays the SEND RUN's alone
 *
 * Everything after the links: the never-had-stock hold (`retido`), a duplicate link of the store
 * id (`vinculo-duplicado`), an ambiguous stock record, `refletido` (the store already shows the
 * number), the store's 404, the conta's park and its credential (which this route never reads),
 * the depósito it re-reads, the canary and the cap. A row this route queued may still end in any
 * of those; the send run logs it, and the nightly reconcile re-covers the produto.
 *
 * ## The bound, and why it is 30
 *
 * The stock queue is single-file (one dispatch at a time), and a manual run is a read-back run
 * (about 11 s): {@link MAX_ALVOS_ENVIO_ESTOQUE_LI} = 30 unpaced tasks hold it for about five and a
 * half minutes, the burst the stock trigger already makes for one component's eager kits. Cloud
 * Tasks orders no ready tasks, so a larger batch would delay every event-driven send behind it
 * (an oversell window). The value is the owner's to change; a larger one should reserve its sends
 * on the global slot instead (`slotEstoqueLi.ts`), which queues them behind any reconcile.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  MAX_PRODUTOS_ENVIO_ESTOQUE_LI,
  MOTIVO_ENVIO_ESTOQUE_LI,
  MODO_ESTOQUE_LI,
  ORIGEM_TAREFA_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  type LinhaEnvioEstoqueLi,
  type ModoEstoqueLi,
  type MotivoEnvioEstoqueLi,
  type ProdutoSemEnvioEstoqueLi,
  type RespostaEnvioEstoqueLi,
  respostaEnvioEstoqueLiSchema,
} from '@delfrance/schemas';

import {
  type AgendadorEstoqueLi,
  LiTarefasTransitoriasError,
  enfileirarTarefaEstoqueLi,
} from './agendadorEstoque';
import { lerVinculosDoProdutoLi } from './leituraEstoqueErp';
import { planoDosVinculosEstoqueLi } from './planoEstoqueLi';

export { MAX_PRODUTOS_ENVIO_ESTOQUE_LI };

/** The most children one push may enqueue (module header, "The bound"). */
export const MAX_ALVOS_ENVIO_ESTOQUE_LI = 30;

/** The expansion queries, and the listings with their enqueues, in flight at once. */
export const CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI = 20;

/** The selected produtos' fields the push reads (step 2): its family, its contas, parity, name. */
export const CAMPOS_PRODUTO_ENVIO_MANUAL_LI = [
  'paiId',
  'integracoesComProduto',
  'statusProdutosMarketplace',
  'nome',
] as const;

/**
 * The COLLECTION index the expansion rides, in order — `produtos (paiId, integracoesComProduto,
 * __name__)`: an equality on the first, `array-contains` on the second. The SAME constant the
 * `.where()` calls are built from.
 */
export const CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI = ['paiId', 'integracoesComProduto'] as const;

/** What the expansion projects of each child: parity and the row's name. */
export const CAMPOS_FILHO_ENVIO_MANUAL_LI = ['statusProdutosMarketplace', 'nome'] as const;

/** The pt-BR sentence of a queued row, by the stock valve the route read. Never "enviado". */
export const MENSAGEM_ENFILEIRADO_LI: Readonly<Record<ModoEstoqueLi, string>> = {
  [MODO_ESTOQUE_LI.on]:
    'Na fila: em alguns minutos o estoque do ERP é conferido com a loja, que só é atualizada ' +
    'se divergir.',
  [MODO_ESTOQUE_LI.dryRun]:
    'Na fila em modo de teste: o envio é só simulado, nada é gravado na loja.',
};

/** The pt-BR sentence of each skip and failure. */
export const MENSAGEM_MOTIVO_ENVIO_ESTOQUE_LI: Readonly<Record<MotivoEnvioEstoqueLi, string>> = {
  [MOTIVO_ENVIO_ESTOQUE_LI.semVinculo]: 'Sem anúncio vinculado nesta conta da Loja Integrada.',
  [MOTIVO_ENVIO_ESTOQUE_LI.pai]:
    'Só o produto pai está vinculado nesta conta, sem variação vinculada: nada a enviar.',
  [MOTIVO_ENVIO_ESTOQUE_LI.naoSuportado]:
    'Vinculado a um produto simples da loja (sem grade): o envio de estoque ainda não cobre esse caso.',
  [MOTIVO_ENVIO_ESTOQUE_LI.vinculoAmbiguo]:
    'Vinculado a dois produtos desta loja: corrija o vínculo antes de enviar.',
  [MOTIVO_ENVIO_ESTOQUE_LI.paridade]: 'Envio de estoque desligado para este anúncio.',
  [MOTIVO_ENVIO_ESTOQUE_LI.produtoAusente]: 'Produto não encontrado no ERP.',
  [MOTIVO_ENVIO_ESTOQUE_LI.filaIndisponivel]:
    'Não confirmado pela fila; repetir no mesmo minuto não duplica.',
};

/** What the push was asked: the conta, the selection, and the stock valve the route read. */
export interface PedidoEnvioManualEstoqueLi {
  readonly contaId: string;
  readonly produtoIds: readonly string[];
  readonly modo: ModoEstoqueLi;
}

export interface DepsEnvioManualEstoqueLi {
  readonly db: Firestore;
  readonly agendador: AgendadorEstoqueLi;
  /** Read right before each enqueue (the task's minute window). */
  readonly agoraMs: () => number;
}

/** The push's counts, for its one log line. */
export interface ContagensEnvioManualEstoqueLi {
  solicitados: number;
  consultas: number;
  alvos: number;
  listagens: number;
  enfileirados: number;
  pulados: number;
  falhas: number;
}

export type ResultadoEnvioManualEstoqueLi =
  | {
      readonly tipo: 'respondido';
      readonly resposta: RespostaEnvioEstoqueLi;
      readonly contagens: ContagensEnvioManualEstoqueLi;
    }
  /** More targets than {@link MAX_ALVOS_ENVIO_ESTOQUE_LI}: nothing listed, nothing enqueued. */
  | {
      readonly tipo: 'excede-limite';
      readonly limite: number;
      readonly alvos: number;
      readonly contagens: ContagensEnvioManualEstoqueLi;
    };

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

function nomeDe(dados: Readonly<Record<string, unknown>>): string | null {
  const nome = proprio(dados, 'nome');
  return typeof nome === 'string' && nome !== '' ? nome : null;
}

/** Whether the produto-side conta list names this conta (step 2): a list holding exactly its id. */
function nomeiaAConta(dados: Readonly<Record<string, unknown>>, contaId: string): boolean {
  const contas = proprio(dados, 'integracoesComProduto');
  return Array.isArray(contas) && contas.includes(contaId);
}

/** One target: the child (or simple produto) a task would be for. */
interface AlvoLi {
  readonly produtoId: string;
  /** The FIRST selected id that led here, in request order. */
  readonly solicitadoId: string;
  readonly produtoNome: string | null;
  readonly statusProdutosMarketplace: unknown;
}

/** One selected id that passed step 2: what it is, and the targets it led to. */
interface SelecionadoLi {
  readonly id: string;
  readonly nome: string | null;
  /** Its masked fields, as step 2 read them. */
  readonly dados: Readonly<Record<string, unknown>>;
  /** A root (no `paiId`): expanded in step 3. A child is its own target. */
  readonly raiz: boolean;
  readonly alvos: string[];
}

/** Runs `tarefas` `n` at a time; resolves when all settle, rejects with the first other failure. */
async function emRodadas<T>(
  itens: readonly T[],
  n: number,
  tarefa: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < itens.length; i += n) {
    const desfechos = await Promise.allSettled(itens.slice(i, i + n).map(tarefa));
    for (const d of desfechos) {
      if (d.status === 'rejected') throw d.reason;
    }
  }
}

/** The push (module header). */
export async function enviarEstoqueManualLi(
  pedido: PedidoEnvioManualEstoqueLi,
  deps: DepsEnvioManualEstoqueLi,
): Promise<ResultadoEnvioManualEstoqueLi> {
  const { contaId } = pedido;
  const { db } = deps;
  const unicos = [...new Set(pedido.produtoIds)];
  const contagens: ContagensEnvioManualEstoqueLi = {
    solicitados: unicos.length,
    consultas: 0,
    alvos: 0,
    listagens: 0,
    enfileirados: 0,
    pulados: 0,
    falhas: 0,
  };
  const produtosSemEnvio: ProdutoSemEnvioEstoqueLi[] = [];
  const semEnvio = (produtoId: string, produtoNome: string | null, motivo: MotivoEnvioEstoqueLi) =>
    produtosSemEnvio.push({
      produtoId,
      produtoNome,
      motivo,
      mensagem: MENSAGEM_MOTIVO_ENVIO_ESTOQUE_LI[motivo],
    });

  // 2. The selection, masked, in ONE getAll.
  const snaps =
    unicos.length === 0
      ? []
      : await db.getAll(...unicos.map((id) => produtoCollection.docRef(db, {}, id)), {
          fieldMask: [...CAMPOS_PRODUTO_ENVIO_MANUAL_LI],
        });
  const alvos = new Map<string, AlvoLi>();
  const juntarAlvo = (selecionado: SelecionadoLi, alvo: Omit<AlvoLi, 'solicitadoId'>) => {
    selecionado.alvos.push(alvo.produtoId);
    if (!alvos.has(alvo.produtoId)) {
      alvos.set(alvo.produtoId, { ...alvo, solicitadoId: selecionado.id });
    }
  };
  const selecionados: SelecionadoLi[] = [];
  unicos.forEach((id, n) => {
    const snap = snaps[n];
    if (snap === undefined || !snap.exists) {
      semEnvio(id, null, MOTIVO_ENVIO_ESTOQUE_LI.produtoAusente);
      return;
    }
    const dados: Readonly<Record<string, unknown>> = snap.data() ?? {};
    if (!nomeiaAConta(dados, contaId)) {
      semEnvio(id, nomeDe(dados), MOTIVO_ENVIO_ESTOQUE_LI.semVinculo);
      return;
    }
    const paiId = proprio(dados, 'paiId');
    selecionados.push({
      id,
      nome: nomeDe(dados),
      dados,
      raiz: typeof paiId !== 'string' || paiId === '',
      alvos: [],
    });
  });
  const raizes = selecionados.filter((s) => s.raiz);

  // 3. The roots' children that name the conta, on the declared index.
  const filhosDaRaiz = new Map<string, readonly Omit<AlvoLi, 'solicitadoId'>[]>();
  const [campoPai, campoContas] = CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_LI;
  let alvosAteAqui = 0;
  for (let i = 0; i < raizes.length; i += CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI) {
    const rodada = raizes.slice(i, i + CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI);
    const respostas = await Promise.all(
      rodada.map(async (raiz) => {
        const snap = await produtoCollection
          .ref(db, {})
          .where(campoPai, '==', raiz.id)
          .where(campoContas, 'array-contains', contaId)
          .select(...CAMPOS_FILHO_ENVIO_MANUAL_LI)
          .limit(MAX_ALVOS_ENVIO_ESTOQUE_LI + 1)
          .get();
        return [raiz.id, snap.docs] as const;
      }),
    );
    contagens.consultas += rodada.length;
    for (const [raizId, docs] of respostas) {
      const filhos = docs.map((d) => {
        const dados: Readonly<Record<string, unknown>> = d.data();
        return {
          produtoId: d.id,
          produtoNome: nomeDe(dados),
          statusProdutosMarketplace: proprio(dados, 'statusProdutosMarketplace'),
        };
      });
      filhosDaRaiz.set(raizId, filhos);
      alvosAteAqui += Math.max(1, filhos.length);
    }
    // The roots' targets are distinct by construction (a child has ONE `paiId`), so a bound the
    // families read so far already pass needs no more queries.
    if (alvosAteAqui > MAX_ALVOS_ENVIO_ESTOQUE_LI) break;
  }

  // 4. The targets, in selection order, deduplicated.
  for (const selecionado of selecionados) {
    const filhos = selecionado.raiz ? filhosDaRaiz.get(selecionado.id) : [];
    // A root the early stop never queried: the request is refused below anyway.
    if (filhos === undefined) continue;
    if (filhos.length === 0) {
      // A selected child, or a root with no child naming the conta: its own target.
      juntarAlvo(selecionado, {
        produtoId: selecionado.id,
        produtoNome: selecionado.nome,
        statusProdutosMarketplace: proprio(selecionado.dados, 'statusProdutosMarketplace'),
      });
    } else {
      for (const filho of filhos) juntarAlvo(selecionado, filho);
    }
  }
  contagens.alvos = alvos.size;
  const naoConsultadas = raizes.some((r) => !filhosDaRaiz.has(r.id));
  if (alvos.size > MAX_ALVOS_ENVIO_ESTOQUE_LI || naoConsultadas) {
    return {
      tipo: 'excede-limite',
      limite: MAX_ALVOS_ENVIO_ESTOQUE_LI,
      alvos: Math.max(alvos.size, alvosAteAqui),
      contagens,
    };
  }

  // 5–6. Per target: its links, the send run's link-only plan, the enqueue.
  const linhas = new Map<string, LinhaEnvioEstoqueLi>();
  const linha = (
    alvo: AlvoLi,
    resultado: LinhaEnvioEstoqueLi['resultado'],
    idLi: string | null,
    motivo: MotivoEnvioEstoqueLi | null,
  ): LinhaEnvioEstoqueLi => ({
    produtoId: alvo.produtoId,
    solicitadoId: alvo.solicitadoId,
    produtoNome: alvo.produtoNome,
    idLi,
    resultado,
    motivo,
    mensagem:
      motivo === null
        ? MENSAGEM_ENFILEIRADO_LI[pedido.modo]
        : MENSAGEM_MOTIVO_ENVIO_ESTOQUE_LI[motivo],
  });
  await emRodadas([...alvos.values()], CONCORRENCIA_ENVIO_MANUAL_ESTOQUE_LI, async (alvo) => {
    const links = await lerVinculosDoProdutoLi(db, alvo.produtoId);
    contagens.listagens += 1;
    const plano = planoDosVinculosEstoqueLi({
      contaId,
      links,
      produto: { statusProdutosMarketplace: alvo.statusProdutosMarketplace },
    });
    switch (plano.tipo) {
      case 'sem-vinculo':
        return;
      case 'pai':
      case 'nao-suportado':
      case 'vinculo-ambiguo':
        linhas.set(
          alvo.produtoId,
          linha(alvo, RESULTADO_ENVIO_ESTOQUE_LI.pulado, null, plano.tipo),
        );
        contagens.pulados += 1;
        return;
      case 'paridade':
        linhas.set(
          alvo.produtoId,
          linha(
            alvo,
            RESULTADO_ENVIO_ESTOQUE_LI.pulado,
            plano.idLi,
            MOTIVO_ENVIO_ESTOQUE_LI.paridade,
          ),
        );
        contagens.pulados += 1;
        return;
      case 'vinculado':
        break;
    }
    try {
      await enfileirarTarefaEstoqueLi(deps.agendador, deps.agoraMs, {
        contaId,
        produtoId: alvo.produtoId,
        origem: ORIGEM_TAREFA_ESTOQUE_LI.manual,
        estoqueId: null,
        apagado: false,
        estoqueIds: null,
        geracao: 0,
      });
    } catch (err) {
      if (!(err instanceof LiTarefasTransitoriasError)) throw err;
      linhas.set(
        alvo.produtoId,
        linha(
          alvo,
          RESULTADO_ENVIO_ESTOQUE_LI.falha,
          plano.idLi,
          MOTIVO_ENVIO_ESTOQUE_LI.filaIndisponivel,
        ),
      );
      contagens.falhas += 1;
      return;
    }
    linhas.set(
      alvo.produtoId,
      linha(alvo, RESULTADO_ENVIO_ESTOQUE_LI.enfileirado, plano.idLi, null),
    );
    contagens.enfileirados += 1;
  });

  // The rows in target order; ONE `sem-vinculo` entry per selected id none of whose targets made one.
  const listings = [...alvos.keys()].flatMap((id) => {
    const l = linhas.get(id);
    return l === undefined ? [] : [l];
  });
  for (const selecionado of selecionados) {
    if (!selecionado.alvos.some((id) => linhas.has(id))) {
      semEnvio(selecionado.id, selecionado.nome, MOTIVO_ENVIO_ESTOQUE_LI.semVinculo);
    }
  }
  // Selection order for the entries too (the step-2 ones were pushed first).
  const ordem = new Map(unicos.map((id, n) => [id, n]));
  produtosSemEnvio.sort((a, b) => (ordem.get(a.produtoId) ?? 0) - (ordem.get(b.produtoId) ?? 0));

  return {
    tipo: 'respondido',
    resposta: respostaEnvioEstoqueLiSchema.parse({
      contaId,
      modo: pedido.modo,
      solicitados: unicos.length,
      listings,
      produtosSemEnvio,
    }),
    contagens,
  };
}
