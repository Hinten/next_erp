/**
 * Map NF-e HTTP-client outcomes (success + typed errors) to Mantine
 * notification shapes — title, message, color — in PT-BR. The UI
 * layer pipes the result of `notificationForNFeResult` or
 * `notificationForNFeError` straight into `notifications.show(...)`.
 *
 * Kept separate from the React component so the mapping can be unit
 * tested without a DOM.
 *
 * This is also the ONE place a cStat maps to operator guidance: the toast
 * helpers, the NF column's HoverCard and the lote dialog all call
 * `orientacaoRejeicaoNFe` here rather than keeping a second mapper (#852).
 */
import {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  NFeXsdValidationFailedError,
  type NFeEmitResult,
} from '@delfrance/integrations-nfe/http-provider';
import {
  ESTADO_NFE,
  IE_SENTINELA,
  TIPO_CLIENTE,
  normalizarIe,
  type TipoCliente,
} from '@delfrance/schemas';
import { z } from 'zod';

import { ID_DEST, IND_IE_DEST, type DestinatarioNFe, type IdDest } from './destinatarioNFe';

/** An in-app route the notification offers under its message. */
export interface NotificationLink {
  readonly href: string;
  readonly label: string;
}

export interface NotificationShape {
  readonly title: string;
  readonly message: string;
  readonly color: 'green' | 'teal' | 'blue' | 'yellow' | 'red' | 'gray';
  /**
   * Optional navigation rendered below the message — today only the cliente's
   * cadastro on a cStat 805 rejection (#852). Absent on every other shape.
   */
  readonly link?: NotificationLink | null;
}

/**
 * cStat 805 — "A SEFAZ do destinatário não permite Contribuinte Isento de
 * Inscrição Estadual". Rule E16a-30 (Obrig.; NT 2025.001 v1.03 widened it to
 * idDest 1 OR 2 in 17 UFs, keyed on the destinatário's UF) plus E16a-35
 * (Facult., idDest=1 at the UF's discretion). The one rejection whose guidance
 * needs more than the error itself: WHAT was sent (the signed XML) and WHO the
 * cliente is (the cadastro) — see `.claude/skills/nfe/references/`.
 */
export const CSTAT_DESTINATARIO_ISENTO_RECUSADO = '805';

/**
 * Does this cStat's guidance need the rejected NF-e + cliente context? An
 * EXACT match — `'8050'`, `' 805'` and `'085'` are other codes, not this one.
 * The gate that keeps every other rejection from paying for extra reads.
 */
export function rejeicaoPrecisaContexto(cStat: string | null | undefined): boolean {
  return cStat === CSTAT_DESTINATARIO_ISENTO_RECUSADO;
}

/** What the cliente cadastro says TODAY — each field `null` when unknown or not a string. */
export interface CadastroClienteRejeicao {
  readonly nome: string | null;
  readonly tipo: TipoCliente | null;
  readonly ie: string | null;
}

export interface ClienteDaRejeicao {
  /** The `d_cliente` doc id, from the pedido's `clientePedidoOuterRef`. */
  readonly id: string;
  /** `null` = the read failed or the doc is missing — the id-only link survives. */
  readonly cadastro: CadastroClienteRejeicao | null;
}

export interface ContextoRejeicaoNFe {
  /** From the rejected nfev4 doc's signed XML; `null` = unreadable → generic toast. */
  readonly destinatario: DestinatarioNFe | null;
  /** `null` = the pedido has no cliente ref (or it did not resolve) → no link. */
  readonly cliente: ClienteDaRejeicao | null;
}

export interface OrientacaoRejeicao {
  /**
   * `corrigirCadastro` — the cadastro still declares ISENTO (or is unknown): fix it.
   * `reemitir` — the cadastro was already changed: only a new emission is missing.
   */
  readonly situacao: 'corrigirCadastro' | 'reemitir';
  readonly titulo: string;
  readonly texto: string;
  readonly cor: 'red' | 'yellow';
  readonly link: NotificationLink | null;
}

/**
 * Would the cadastro AS IT STANDS still produce `indIEDest='2'`? The web mirror
 * of the generator's ladder — `classifyIe` + `buildDest` in
 * `packages/integrations/nfe/src/generator/parties.ts`: '2' is reachable ONLY
 * for a pessoa jurídica whose `ie` normalises to `IE_SENTINELA.isento`. A
 * PF/estrangeiro, a `NAO CONTRIBUINTE` or a blank `ie` all yield '9', and
 * anything else yields '1'. (The ladder's first rung — exterior → '9' — is
 * idDest=3, which never gets this far: see `ID_DEST_COM_ORIENTACAO_805`.)
 *
 * Mirrored, not imported: `apps/web` cannot import the generator (only the
 * http-provider subpath is allowed), and moving the predicate into
 * `packages/schemas` would widen this web-only change's CI into the NF-e lanes.
 * ⚠️ If that ladder changes, change this with it — the near-miss tests in
 * `errors.test.ts` pin both sides of the fold. A drift costs a wrong "já
 * alterado" hint, never a wrong fiscal document.
 */
export function cadastroAindaDeclaraIsento(c: CadastroClienteRejeicao): boolean {
  return c.tipo === TIPO_CLIENTE.pessoaJuridica && normalizarIe(c.ie) === IE_SENTINELA.isento;
}

/**
 * Which operations get the 805 guidance — the owner-decision knob (#852):
 * internal AND interstate, following NT 2025.001 v1.03 E16a-30 (idDest 1 ou 2).
 * idDest=3 (exterior) and anything unknown fall back to the generic toast.
 */
const ID_DEST_COM_ORIENTACAO_805: ReadonlySet<IdDest> = new Set<IdDest>([
  ID_DEST.interna,
  ID_DEST.interestadual,
]);

/**
 * Operator guidance for a rejection that needs context — today only cStat 805
 * sent with `indIEDest='2'` on an internal or interstate operation. `null` for
 * everything else, which keeps the caller on its generic text.
 *
 * The copy is PAST tense about what was sent ("A NF-e foi enviada com …") and
 * never states today's cadastro as fact: when the cadastro no longer declares
 * ISENTO it switches to the `reemitir` variant; when it is unknown it falls
 * back to the fix-it text, which is true either way.
 */
export function orientacaoRejeicaoNFe(
  cStat: string | null | undefined,
  contexto: ContextoRejeicaoNFe | null,
): OrientacaoRejeicao | null {
  if (!rejeicaoPrecisaContexto(cStat)) return null;
  const destinatario = contexto?.destinatario ?? null;
  if (destinatario == null) return null;
  if (destinatario.indIEDest !== IND_IE_DEST.isento) return null;
  if (!ID_DEST_COM_ORIENTACAO_805.has(destinatario.idDest)) return null;

  const cliente = contexto?.cliente ?? null;
  const nomeCadastro = cliente?.cadastro?.nome?.trim() ?? '';
  const nome = nomeCadastro === '' ? null : nomeCadastro;
  const uf = destinatario.uf;

  const quem = nome ? `o cliente ${nome}` : 'o cliente deste pedido';
  const sefaz = uf ? `a SEFAZ-${uf}` : 'a SEFAZ do destinatário';
  const onde =
    destinatario.idDest === ID_DEST.interna
      ? ' não aceita em operação interna'
      : uf
        ? ', UF do destinatário, não aceita em operação interestadual'
        : ' não aceita em operação interestadual';
  const fato =
    `A NF-e foi enviada com ${quem} marcado como Isento de inscrição estadual, ` +
    `o que ${sefaz}${onde}.`;

  const link: NotificationLink | null = cliente
    ? {
        href: `/clientes/${cliente.id}`,
        label: nome ? `Abrir cadastro de ${nome}` : 'Abrir cadastro do cliente',
      }
    : null;

  if (cliente?.cadastro != null && !cadastroAindaDeclaraIsento(cliente.cadastro)) {
    return {
      situacao: 'reemitir',
      titulo: 'Cadastro do cliente já alterado',
      texto: `${fato} O cadastro já não está como Isento: emita a NF-e novamente.`,
      cor: 'yellow',
      link,
    };
  }
  return {
    situacao: 'corrigirCadastro',
    titulo: 'Inscrição estadual do cliente recusada pela SEFAZ',
    texto:
      `${fato} Corrija o cadastro: informe a inscrição estadual do cliente (o botão ` +
      '"Buscar dados do CNPJ" do cadastro tenta obtê-la na SEFAZ) ou, se ele não for ' +
      'contribuinte do ICMS, preencha o campo Inscrição estadual com ' +
      `"${IE_SENTINELA.naoContribuinte}" (venda a não contribuinte exige operação de ` +
      'consumidor final). Depois emita a NF-e novamente.',
    cor: 'red',
    link,
  };
}

/**
 * Map a successful `emitir` result to a notification. The orchestrator
 * returns `estado='rejeitada'` with HTTP 422, which the HTTP client
 * raises as `NFeRejectedError` — so this function only sees the
 * happy-ish paths (`aprovada` / `enviando` / `aguardandoResposta`).
 * Includes a defensive default for any unexpected estado.
 */
export function notificationForNFeResult(result: NFeEmitResult): NotificationShape {
  // `reused: true` means the dedup branch short-circuited: the pedido
  // already had an nfev4 doc in a bloqueada cStat (100/101/102/...).
  // Show a distinct yellow toast so the user knows their click was
  // a no-op rather than a fresh authorization.
  if (result.reused) {
    return {
      title: 'NFe já emitida',
      message:
        `Já existe uma NFe ${result.cStat ? `(cStat=${result.cStat}) ` : ''}` +
        'para este pedido — nova emissão foi pulada.',
      color: 'yellow',
    };
  }
  if (result.estado === ESTADO_NFE.aprovada) {
    const protocol = result.nRec ?? result.chave.slice(-15);
    return {
      title: 'NF-e autorizada',
      message: `Protocolo ${protocol} — cStat=${result.cStat} ${result.xMotivo}`,
      color: 'green',
    };
  }
  if (result.estado === ESTADO_NFE.enviando || result.estado === ESTADO_NFE.aguardandoResposta) {
    return {
      title: 'NF-e em processamento',
      message: `Lote enviado a SEFAZ; aguardando protocolo (cStat=${result.cStat} ${result.xMotivo}).`,
      color: 'blue',
    };
  }
  if (result.estado === ESTADO_NFE.rejeitada) {
    return {
      title: 'NF-e rejeitada',
      message: `cStat=${result.cStat}: ${result.xMotivo}`,
      color: 'red',
    };
  }
  if (result.estado === ESTADO_NFE.epecAprovado) {
    // 468 — the pós-EPEC transmission ran but the home SEFAZ hasn't pulled
    // the EPEC from the Ambiente Nacional yet. The doc stays 'p'; the
    // operator just waits a few minutes and emits again.
    if (result.cStat === '468') {
      return {
        title: 'EPEC ainda não sincronizado na SEFAZ',
        message:
          `cStat=468: ${result.xMotivo} — a SEFAZ autorizadora ainda não recebeu o EPEC ` +
          'do Ambiente Nacional. Aguarde alguns minutos e emita novamente para transmitir ' +
          'a NF-e completa.',
        color: 'yellow',
      };
    }
    // 135/136 — the EPEC summary was registered at the Ambiente Nacional.
    return {
      title: 'EPEC registrado',
      message:
        `cStat=${result.cStat}: ${result.xMotivo} — NF-e em contingência EPEC. A DANFE já ` +
        'pode ser impressa; com o modo EPEC ainda ativo, emita novamente quando a SEFAZ ' +
        'normalizar para transmitir a NF-e completa (mesma chave).',
      color: 'teal',
    };
  }
  return {
    title: 'NF-e enviada',
    message: `Estado: ${result.estado} (cStat=${result.cStat} ${result.xMotivo}).`,
    color: 'gray',
  };
}

/**
 * Map a thrown error from `client.emitir(...)` to a notification.
 * Narrows via `instanceof` on the typed error classes exported from
 * `@delfrance/integrations-nfe`. Returns a generic fallback for
 * anything that doesn't match.
 *
 * `contexto` only matters for an `NFeRejectedError` whose cStat has
 * guidance (`orientacaoRejeicaoNFe`): the verbatim `cStat=…: <xMotivo>`
 * prefix stays — SEFAZ outcomes must remain copy-pasteable — and the
 * guidance follows after ' — ', with the cadastro link. The toast stays
 * red for both variants. Without guidance the shape is exactly the
 * generic one.
 */
export function notificationForNFeError(
  err: unknown,
  contexto: ContextoRejeicaoNFe | null = null,
): NotificationShape {
  if (err instanceof NFeRejectedError) {
    const orientacao = orientacaoRejeicaoNFe(err.cStat, contexto);
    if (orientacao != null) {
      return {
        title: orientacao.titulo,
        message: `cStat=${err.cStat}: ${err.xMotivo} — ${orientacao.texto}`,
        color: 'red',
        link: orientacao.link,
      };
    }
    return {
      title: 'SEFAZ rejeitou a NF-e',
      message: `cStat=${err.cStat}: ${err.xMotivo}`,
      color: 'red',
    };
  }
  if (err instanceof NFeCertificateError) {
    // A per-filial cert pre-flight failure — resolved BEFORE any SEFAZ contact
    // (no stored cert / wrong key / expired). The message is the route's pt-BR
    // text; never frame it as a SEFAZ rejection.
    return {
      title: 'Certificado digital da filial',
      message: err.message,
      color: 'red',
    };
  }
  if (err instanceof NFeBlockedError) {
    return {
      title: 'Pedido bloqueado',
      message: 'A emissão de NF-e está bloqueada para este pedido (campo bloquearEmissaoNFe).',
      color: 'yellow',
    };
  }
  if (err instanceof NFePedidoNotFoundError) {
    return {
      title: 'Pedido não encontrado',
      message: `O pedido ${err.pedidoId} não foi encontrado pelo servidor de NF-e.`,
      color: 'red',
    };
  }
  if (err instanceof NFeAuthError) {
    if (err.status === 403) {
      return {
        title: 'Sem permissão',
        message: err.message || 'Você não tem permissão para emitir NF-e (fiscal.write).',
        color: 'red',
      };
    }
    return {
      title: 'Sessão inválida',
      message: err.message || 'Faça login novamente para emitir NF-e.',
      color: 'red',
    };
  }
  if (err instanceof NFeRuntimeNotReadyError) {
    // `apps/nfe`'s 503 response puts the underlying error message in
    // `body.code` (route `apps/nfe/app/api/nfe/emitir/route.ts:62-66`).
    // Surface it so cert / chain / env issues are diagnosable from the
    // toast alone.
    const detail =
      err.body !== null && typeof err.body === 'object' && 'code' in err.body
        ? String((err.body as { code: unknown }).code)
        : null;
    return {
      title: 'Servidor NF-e indisponível',
      message:
        detail ||
        'O serviço de emissão não está pronto (certificado, chain TLS ou runtime). ' +
          'Tente novamente em alguns instantes.',
      color: 'red',
    };
  }
  if (err instanceof NFeBadRequestError) {
    return {
      title: 'Requisição inválida',
      message: err.message,
      color: 'red',
    };
  }
  if (err instanceof NFeNetworkError) {
    return {
      title: 'Erro de rede',
      message:
        'Não foi possível alcançar o servidor de NF-e. Verifique a conexão e tente novamente.',
      color: 'red',
    };
  }
  if (err instanceof NFeXsdValidationFailedError) {
    // Deterministic: the XML (ours, or SEFAZ's reply) failed the SEFAZ schema on
    // the server. Repeating the action replays it; the message names the element.
    return {
      title: 'XML fora do schema da SEFAZ',
      message: err.message,
      color: 'red',
    };
  }
  if (err instanceof NFeServerError) {
    return {
      title: 'Erro no servidor de NF-e',
      message: err.message,
      color: 'red',
    };
  }
  return {
    title: 'Erro inesperado',
    message: err instanceof Error ? err.message : 'Falha desconhecida ao emitir NF-e.',
    color: 'red',
  };
}

/**
 * Loads the context `orientacaoRejeicaoNFe` needs for one rejected emission.
 * Injected so this module stays pure; the Firestore-backed implementation is
 * `carregadorContextoRejeicao` (`./contextoRejeicao`).
 */
export type CarregarContextoRejeicao = (alvo: {
  readonly pedidoId: string;
  readonly nfeId: string;
}) => Promise<ContextoRejeicaoNFe>;

/**
 * The two ids the 422 emit body carries (the route returns the full
 * `EmitResult`). Validated locally: `nfeEmitResultSchema` is not re-exported
 * from the http-provider subpath, and exporting it would touch an nfe-live path.
 */
const alvoRejeicaoSchema = z.object({
  pedidoId: z.string().min(1),
  nfeId: z.string().min(1),
});

/**
 * `notificationForNFeError`, plus the context lookup for the rejections that
 * need it. The loader runs ONLY for an `NFeRejectedError` whose cStat passes
 * `rejeicaoPrecisaContexto` AND whose body names both the pedido and the nfev4
 * doc — every other error resolves to the synchronous mapping without a read.
 * A loader rejection propagates: the Firestore-backed one already degrades a
 * `FirebaseError` to a partial context, so what reaches here is a bug.
 */
export async function notificationForNFeErrorComContexto(
  err: unknown,
  carregar: CarregarContextoRejeicao,
): Promise<NotificationShape> {
  if (!(err instanceof NFeRejectedError) || !rejeicaoPrecisaContexto(err.cStat)) {
    return notificationForNFeError(err);
  }
  const alvo = alvoRejeicaoSchema.safeParse(err.body);
  if (!alvo.success) return notificationForNFeError(err);
  const contexto = await carregar({ pedidoId: alvo.data.pedidoId, nfeId: alvo.data.nfeId });
  return notificationForNFeError(err, contexto);
}
