/**
 * The label route's ANSWERS (#1523, step 15): the one mapper from the runner's
 * result to an HTTP response, plus the sentences only an HTTP answer carries
 * (the 403, the 502, the NF-e outcome of the 409). It keeps the route thin
 * (app rule 1).
 *
 * ⚠️ **The ONE Next-bound module of the folder, and only the route imports
 * it.** The 202 body's shape, the phase sentences, the NF-e outcome type and
 * the filename live in `pendenteEtiqueta.ts`, which is pure, so the runner and
 * the CLI never load `next/server` (review 1, R5-1). A module under
 * `etiqueta/` may name this one for its TYPES only; `disciplinaDaPasta.test.ts`
 * pins it.
 *
 * ## The status table (reconcile §2.4)
 *
 * | result | status | body |
 * |---|---|---|
 * | `bytes` | 200 | the bytes; the EXACT sniffed `Content-Type`, `attachment`, `no-store` |
 * | `pendente` | 202 | `EtiquetaPendente` (`pendenteEtiqueta.ts`), `no-store` |
 * | `recusa` / `nfe-pendente` | 409 | `{ error, code: 'SHOPEE_ETIQUETA_RECUSADA', motivo, mensagem, nfe?, tentarApos?, shopeeCode? }` |
 * | `sem-permissao` | 403 | `{ error, code: 'SHOPEE_ETIQUETA_SEM_PERMISSAO', motivo: 'programar-envio', mensagem }` |
 * | `formato-desconhecido` | 502 | `{ error, code: 'SHOPEE_ETIQUETA_FORMATO_DESCONHECIDO' }` |
 *
 * ⚠️ **An obligation, not a description of the web.** PR 2's web schema must
 * mirror these names and TOLERATE every optional key — above all `shopeeCode`,
 * which only a `recusa-desconhecida` carries (review 1, R3-F1): Shopee's
 * canonical code, already through the runner's token gate (`codigoSeguro`: at
 * most 64 characters, fewer than seven digits), so an order or package number
 * can never ride it. Nothing here claims what the web does today; the
 * round-trip lens compares the two files.
 *
 * ⚠️ An unknown file is a 502, NEVER `application/octet-stream`: the print
 * agent answers 200 for a type it cannot print and prints nothing (S44).
 *
 * ⚠️ Shopee's own `Content-Disposition` is never forwarded, and the filename
 * never carries a package number (S45) — only the pedido's `numero`, under
 * Mercado Livre's `[\w.-]+` guard, and the package's POSITION
 * ({@link nomeDoArquivoDeEtiqueta}).
 */
import { NextResponse } from 'next/server';

import { MOTIVO_NFE_SHOPEE } from '../nfe/errosNfe';
import type { ResultadoEtiqueta } from './executarEtiqueta';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  mensagemDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
} from './motivosEtiqueta';
import { nomeDoArquivoDeEtiqueta, type DesfechoNfe } from './pendenteEtiqueta';

/**
 * "The pedido has no authorized NF-e yet": nothing was ever uploaded, so there
 * is no NF-e aviso to point the operator at (review 1, R1-F2).
 */
const FRASE_SEM_NFE_AUTORIZADA =
  'O pedido ainda não tem uma NF-e autorizada — emita a NF-e do pedido e clique em Imprimir de novo.';

/**
 * The sentence appended to the `nfe-pendente` refusal, per outcome — read
 * through {@link fraseDoDesfechoNfe}, never directly.
 *
 * ⚠️ `nfe-nao-encontrada` is UNREACHABLE from the label route: it re-drives
 * with `nfeId: null`, and the re-drive answers that arm only for an EXPLICIT
 * `nfeId` whose document is absent. The label route's "no authorized NF-e"
 * arrives as `nao-elegivel` + `sem-nfe-aprovada`; the arm stays for the
 * union's exhaustiveness, with the same sentence.
 */
const FRASE_DO_DESFECHO_NFE: Readonly<Record<DesfechoNfe['desfecho'], string>> = {
  enfileirado: 'O ERP reenviou a NF-e à Shopee; clique em Imprimir de novo em alguns minutos.',
  'nao-elegivel':
    'O ERP não pôde reenviar a NF-e deste pedido — confira o aviso de NF-e do pedido.',
  'nfe-nao-encontrada': FRASE_SEM_NFE_AUTORIZADA,
  desligado: 'O reenvio automático da NF-e está desligado no momento — tente de novo mais tarde.',
  'sem-permissao': 'Peça a quem pode editar pedidos para reenviar a NF-e à Shopee.',
};

/**
 * The NF-e half of the `nfe-pendente` sentence, chosen from the outcome AND the
 * NF-e motivo: `nao-elegivel` because the pedido has no authorized NF-e
 * (`sem-nfe-aprovada`, the COMMON case — the operator clicked Imprimir before
 * emitting) asks for the emission; every other `nao-elegivel` motivo
 * (`emissao-bloqueada`, …) keeps the aviso sentence, because there the aviso is
 * where the reason lives.
 */
function fraseDoDesfechoNfe(nfe: DesfechoNfe): string {
  return nfe.desfecho === 'nao-elegivel' && nfe.motivoNfe === MOTIVO_NFE_SHOPEE.semNfeAprovada
    ? FRASE_SEM_NFE_AUTORIZADA
    : FRASE_DO_DESFECHO_NFE[nfe.desfecho];
}

/* --------------------------------- the mapper -------------------------------- */

/** The refusal body — step 14's `SHOPEE_NFE_NAO_ELEGIVEL` shape. */
function recusada(
  motivo: MotivoEtiquetaShopee,
  mensagem: string,
  extra: { nfe?: DesfechoNfe; tentarApos?: number; shopeeCode?: string },
): NextResponse {
  return NextResponse.json(
    {
      error: mensagem,
      code: 'SHOPEE_ETIQUETA_RECUSADA',
      motivo,
      mensagem,
      ...(extra.nfe === undefined ? {} : { nfe: extra.nfe }),
      ...(extra.tentarApos === undefined ? {} : { tentarApos: extra.tentarApos }),
      ...(extra.shopeeCode === undefined ? {} : { shopeeCode: extra.shopeeCode }),
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
 * @param ctx.numero the pedido's `numero` (the filename; guarded there).
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
        ...(r.shopeeCode === undefined ? {} : { shopeeCode: r.shopeeCode }),
      });
    case 'nfe-pendente': {
      const motivo = MOTIVO_ETIQUETA_SHOPEE.nfePendente;
      const base = mensagemDoMotivoEtiqueta(motivo);
      if (ctx.nfe === null) return recusada(motivo, base, {});
      return recusada(motivo, `${base} ${fraseDoDesfechoNfe(ctx.nfe)}`, { nfe: ctx.nfe });
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
