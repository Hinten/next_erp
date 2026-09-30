/**
 * The label route's ANSWERS (#1523, step 15): the 202 body the web polls, the
 * frozen pt-BR phase sentences, the download filename, and the one mapper from
 * the runner's result to an HTTP response. It keeps the route thin (app rule 1).
 *
 * ## ⚠️ The 202 body is a MIRROR, not a shared schema (R-aa)
 *
 * {@link EtiquetaPendente} is the PRODUCER's shape; the web parses the same
 * body TOLERANTLY in `apps/web/lib/shopee/wire.ts`, under IDENTICAL names. The
 * two are compared by the round-trip lens, line by line — never by a comment
 * claiming they agree. A rename here is a wire change on both sides of a
 * deploy.
 *
 * Three questions exist, and only three (`acao`): wait, choose how to ship ONE
 * package, or download the packages one at a time. The 1-hour confirm was
 * removed with its whole apparatus (Lucas, 2026-09-30, reconcile Appendix A).
 *
 * ## The status table (reconcile §2.4)
 *
 * | result | status | body |
 * |---|---|---|
 * | `bytes` | 200 | the bytes; the EXACT sniffed `Content-Type`, `attachment`, `no-store` |
 * | `pendente` | 202 | {@link EtiquetaPendente}, `no-store` |
 * | `recusa` / `nfe-pendente` | 409 | `{ error, code: 'SHOPEE_ETIQUETA_RECUSADA', motivo, mensagem, nfe?, tentarApos? }` |
 * | `sem-permissao` | 403 | `{ error, code: 'SHOPEE_ETIQUETA_SEM_PERMISSAO', motivo: 'programar-envio', mensagem }` |
 * | `formato-desconhecido` | 502 | `{ error, code: 'SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO' }` |
 *
 * ⚠️ An unknown file is a 502, NEVER `application/octet-stream`: the print
 * agent answers 200 for a type it cannot print and prints nothing (S44).
 *
 * ⚠️ Shopee's own `Content-Disposition` is never forwarded, and the filename
 * never carries a package number (S45) — only the pedido's `numero`, under
 * Mercado Livre's `[\w.-]+` guard, and the package's POSITION.
 */
import { NextResponse } from 'next/server';

import {
  MOTIVO_ETIQUETA_SHOPEE,
  mensagemDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
} from './errosEtiqueta';
import type { ResultadoEtiqueta } from './executarEtiqueta';
import type { FaseEtiqueta } from './faseEtiqueta';
import type { EnderecoDeColeta } from './modoDeEnvio';

/* -------------------------------- the 202 body ------------------------------- */

/**
 * The counts every 202 carries (R-b): what makes the web's give-up message
 * deterministic — `organizados === total && total > 0` means "already
 * arranged, and it will not be arranged again". Counts only, never an id.
 */
export interface Progresso {
  readonly total: number;
  readonly organizados: number;
  readonly comRastreio: number;
  readonly prontos: number;
}

/** The 202 body — names IDENTICAL to `apps/web/lib/shopee/wire.ts` (R-aa). */
export type EtiquetaPendente =
  | {
      acao: 'aguardar';
      fase: FaseEtiqueta;
      tentarEmMs: number;
      mensagem: string;
      progresso: Progresso;
    }
  | {
      acao: 'escolher-envio';
      fase: 'programando';
      pacote: string;
      pacoteRotulo: string | null;
      mensagem: string;
      enderecos: readonly EnderecoDeColeta[];
      permiteDropoff: boolean;
      escolhaInvalida: boolean;
      progresso: Progresso;
    }
  | {
      acao: 'baixar-por-pacote';
      fase: 'baixando';
      pacotes: readonly string[];
      mensagem: string;
      progresso: Progresso;
    };

/**
 * The pt-BR sentence of each phase — FROZEN (reconcile §2.4); the web shows it
 * once per phase. `Record<FaseEtiqueta, …>`, so a new phase is a compile error
 * here rather than a blank toast.
 */
export const MENSAGEM_DA_FASE: Readonly<Record<FaseEtiqueta, string>> = {
  programando: 'Organizando o envio na Shopee…',
  'aguardando-rastreio': 'Envio organizado; aguardando o código de rastreio da transportadora.',
  'gerando-documento': 'Envio organizado; a Shopee está gerando a etiqueta.',
  baixando: 'Baixando a etiqueta…',
  'renovando-credencial': 'Renovando o acesso à Shopee…',
  'limite-de-requisicoes':
    'A Shopee pediu uma pausa entre as chamadas; tentando de novo em instantes.',
};

/** The `escolher-envio` sentence — the question itself. */
export const MENSAGEM_ESCOLHER_ENVIO =
  'Escolha como enviar o pacote: o endereço e o horário da coleta, ou a postagem na agência.';

/** The `escolher-envio` sentence when the previous answer no longer matches Shopee. */
export const MENSAGEM_ESCOLHA_INVALIDA =
  'A opção escolhida não está mais disponível na Shopee — escolha de novo como enviar o pacote.';

/** The `baixar-por-pacote` sentence. */
export const MENSAGEM_BAIXAR_POR_PACOTE =
  'Os pacotes deste pedido vão por transportadoras diferentes; cada etiqueta é baixada separadamente.';

/* ------------------------------- the NF-e outcome ---------------------------- */

/**
 * What the route did about the NF-e on an `nfe-pendente` answer (R-e): the
 * re-drive's own outcome, or `sem-permissao` when the caller lacks
 * `PERM.pedido.write` and nothing was enqueued.
 */
export type DesfechoNfe = {
  desfecho: 'enfileirado' | 'nao-elegivel' | 'nfe-nao-encontrada' | 'desligado' | 'sem-permissao';
  motivoNfe?: string;
  atrasoSegundos?: number;
};

/** The sentence appended to the `nfe-pendente` refusal, per outcome. */
const FRASE_DO_DESFECHO_NFE: Readonly<Record<DesfechoNfe['desfecho'], string>> = {
  enfileirado: 'O ERP reenviou a NF-e à Shopee; clique em Imprimir de novo em alguns minutos.',
  'nao-elegivel':
    'O ERP não pôde reenviar a NF-e deste pedido — confira o aviso de NF-e do pedido.',
  'nfe-nao-encontrada':
    'O pedido não tem uma NF-e autorizada para enviar — emita a NF-e antes de imprimir a etiqueta.',
  desligado: 'O reenvio automático da NF-e está desligado no momento — tente de novo mais tarde.',
  'sem-permissao': 'Peça a quem pode editar pedidos para reenviar a NF-e à Shopee.',
};

/* -------------------------------- the filename ------------------------------- */

/**
 * The same guard Mercado Livre's label route applies to `numero`: free-form
 * wire data in a header, so a quote, a `%` or a non-latin1 character falls
 * back to the bare name rather than making the header invalid.
 */
const NUMERO_SEGURO = /^[\w.-]+$/;

/**
 * `etiqueta-shopee-<numero>[-p<i>de<n>].<pdf|zip|txt>`.
 *
 * - `numero` is the PEDIDO's number; one that fails `[\w.-]+` (or `null`) ⇒
 *   `etiqueta-shopee`.
 * - The `-p<i>de<n>` suffix only for a per-package download of a split order
 *   (`indice` 1…`total`, `total > 1`). ⚠️ A package NUMBER never appears: the
 *   suffix is the package's POSITION (S45).
 */
export function nomeDoArquivoDeEtiqueta(
  numero: string | null,
  extensao: 'pdf' | 'zip' | 'txt',
  indice: number | null,
  total: number,
): string {
  const base =
    numero !== null && NUMERO_SEGURO.test(numero) ? `etiqueta-shopee-${numero}` : 'etiqueta-shopee';
  const sufixo =
    indice !== null && Number.isSafeInteger(indice) && total > 1 && indice >= 1 && indice <= total
      ? `-p${String(indice)}de${String(total)}`
      : '';
  return `${base}${sufixo}.${extensao}`;
}

/* --------------------------------- the mapper -------------------------------- */

/** The refusal body — step 14's `SHOPEE_NFE_NAO_ELEGIVEL` shape. */
function recusada(
  motivo: MotivoEtiquetaShopee,
  mensagem: string,
  extra: { nfe?: DesfechoNfe; tentarApos?: number },
): NextResponse {
  return NextResponse.json(
    {
      error: mensagem,
      code: 'SHOPEE_ETIQUETA_RECUSADA',
      motivo,
      mensagem,
      ...(extra.nfe === undefined ? {} : { nfe: extra.nfe }),
      ...(extra.tentarApos === undefined ? {} : { tentarApos: extra.tentarApos }),
    },
    { status: 409 },
  );
}

/** The 403 sentence: the caller may print, but not ARRANGE (R-h). */
export const MENSAGEM_SEM_PERMISSAO_PROGRAMAR =
  'Você não tem permissão para organizar o envio na Shopee — a primeira impressão da etiqueta organiza o envio, e isso exige a permissão de alterar o frete. Peça a quem a tem para imprimir esta etiqueta.';

/** The 502 sentence for a file whose signature the ERP does not recognise. */
export const MENSAGEM_FORMATO_DESCONHECIDO =
  'A Shopee devolveu um arquivo de etiqueta em um formato que o ERP não reconhece — imprima a etiqueta pela Central do Vendedor.';

/**
 * The runner's result → the HTTP answer (the table in the module docblock).
 * The dry run's `simulado` never reaches a route, and the type says so.
 *
 * @param ctx.numero the pedido's `numero` (the filename; guarded here).
 * @param ctx.nfe what the route did about the NF-e — only read on `nfe-pendente`.
 */
export function respostaDaEtiqueta(
  r: Exclude<ResultadoEtiqueta, { tipo: 'simulado' }>,
  ctx: { numero: string | null; nfe: DesfechoNfe | null },
): NextResponse {
  switch (r.tipo) {
    case 'bytes':
      // A Uint8Array is a valid undici body; the cast only bridges the DOM
      // lib's BodyInit typing (the Mercado Livre label route's precedent).
      return new NextResponse(r.bytes as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': r.contentType,
          'Content-Disposition': `attachment; filename="${nomeDoArquivoDeEtiqueta(ctx.numero, r.extensao, r.indice, r.total)}"`,
          'Cache-Control': 'no-store',
        },
      });
    case 'pendente':
      return NextResponse.json(r.corpo, {
        status: 202,
        headers: { 'Cache-Control': 'no-store' },
      });
    case 'recusa':
      return recusada(r.motivo, mensagemDoMotivoEtiqueta(r.motivo), {
        ...(r.tentarApos === undefined ? {} : { tentarApos: r.tentarApos }),
      });
    case 'nfe-pendente': {
      const motivo = MOTIVO_ETIQUETA_SHOPEE.nfePendente;
      const base = mensagemDoMotivoEtiqueta(motivo);
      if (ctx.nfe === null) return recusada(motivo, base, {});
      return recusada(motivo, `${base} ${FRASE_DO_DESFECHO_NFE[ctx.nfe.desfecho]}`, {
        nfe: ctx.nfe,
      });
    }
    case 'sem-permissao':
      return NextResponse.json(
        {
          error: MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
          code: 'SHOPEE_ETIQUETA_SEM_PERMISSAO',
          motivo: 'programar-envio',
          mensagem: MENSAGEM_SEM_PERMISSAO_PROGRAMAR,
        },
        { status: 403 },
      );
    case 'formato-desconhecido':
      return NextResponse.json(
        { error: MENSAGEM_FORMATO_DESCONHECIDO, code: 'SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO' },
        { status: 502 },
      );
  }
}
