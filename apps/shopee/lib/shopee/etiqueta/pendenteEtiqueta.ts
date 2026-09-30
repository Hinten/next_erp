/**
 * The label flow's WIRE WORDS that do not need Next (#1523, step 15): the 202
 * body the web polls, the frozen pt-BR sentences the runner puts in it, the
 * NF-e outcome the 409 carries, and the download filename.
 *
 * ⚠️ **Pure, and imports nothing but types.** The runner (`executarEtiqueta.ts`)
 * and the CLI read their sentences and shapes from HERE, so neither loads
 * `next/server` (review 1, R5-1): step 15b's automatic arrange reaches the
 * runner's folder from the functions bundle, which must stay Next-free. The
 * one Next-bound module is `respostaEtiqueta.ts` — the mapper from the
 * runner's result to an HTTP response — and only the route imports it;
 * `disciplinaDaPasta.test.ts` pins both halves of the split.
 *
 * ## ⚠️ The 202 body is a MIRROR, not a shared schema (R-aa)
 *
 * {@link EtiquetaPendente} is the PRODUCER's shape. **PR 2's web schema
 * (`apps/web/lib/shopee/wire.ts`) must mirror these names and parse the body
 * TOLERANTLY** — an obligation on that file, never a statement about it (#1369:
 * a doc must not assert what another copy does). The two are compared by the
 * round-trip lens, line by line. A rename here is a wire change on both sides
 * of a deploy.
 *
 * Three questions exist, and only three (`acao`): wait, choose how to ship ONE
 * package, or download the packages one at a time. The 1-hour confirm was
 * removed with its whole apparatus (Lucas, 2026-09-30, reconcile Appendix A).
 */
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

/** The 202 body — PR 2's web schema must mirror these names (R-aa). */
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
