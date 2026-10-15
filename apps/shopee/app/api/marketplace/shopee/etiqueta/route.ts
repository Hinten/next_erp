/**
 * `POST /api/marketplace/shopee/etiqueta` — the Shopee LABEL of one pedido
 * (#1523, step 15): arrange the shipment when it is not arranged yet, wait for
 * the tracking number and the document, and answer the label's bytes. Body:
 * `{ pedidoId, formato: 'pdf'|'zpl2', pacote?, envio? }` — strict.
 *
 * One call does as much as fits in the runner's budget and answers one of:
 * 200 the bytes, 202 a question or a wait (`EtiquetaPendente`), 409 a refusal,
 * 403 "you may print but not arrange", 502 an unrecognised file. The web
 * re-calls on a 202; every call re-derives the phase from Shopee, so re-clicking
 * IS the resume path and nothing is stored between calls (R-o: this route
 * writes ZERO documents).
 *
 * ## Auth — `PERM.frete.read`, and `frete.write` only to ARRANGE (R-h)
 *
 * A reprint is a read (ML's `etiqueta` and Melhor Envio's `imprimir` are
 * `frete.read`); `ship_order` is an irreversible act (Melhor Envio's `comprar`
 * is `frete.write`). This route is both, so the base bit is `frete.read` and
 * the runner receives `podeProgramar = hasPerm(perms, PERM.frete.write)`: it
 * answers `sem-permissao` (403) BEFORE `get_shipping_parameter` when an
 * arrange is due and the caller lacks it. A caller with `frete.read` alone
 * still prints an ARRANGED package (S37).
 *
 * ## The ladder — every body rung before any read
 *
 * 1. `verifyCaller` (401/403/500 from the helper) → 2. a JSON body → 3. an
 * object → 4. `pedidoId` a document id → 5. `formato` ∈ `{pdf, zpl2}` →
 * 6. `pacote` absent/`null` or a non-blank string of at most
 * `TAMANHO_MAX_PACOTE` → 7. `envio` absent/`null` or one of the two
 * `EscolhaDeEnvio` shapes, each with its EXACT key set → 8. no OTHER key → 9.
 * ONE clock read (the NF-e re-drive's "now").
 *
 * ⚠️ There is no `confirmacoes` key: the 1-hour confirm was removed with its
 * whole apparatus (Lucas, 2026-09-30, reconcile Appendix A), so a body that
 * still sends one is a 400 by rung 8, never an ignored key.
 *
 * ## Then — ownership, the block, the conta, the runner
 *
 * - The pedido, RAW (`pedidoCollection.docRef(...).get()`); absent ⇒ 404
 *   `SHOPEE_ETIQUETA_PEDIDO_NAO_ENCONTRADO` — the one rung that is the route's
 *   own.
 * - The ladder is `etiqueta/alvoEtiqueta.ts`, the SAME two functions the
 *   `baixar:etiqueta` CLI runs (review 1, R5-3): ownership through
 *   `provaDeIdentidadeShopee` and NEVER the NF-e pedido predicate (R-r, S39;
 *   no proof ⇒ 409 `nao-shopee`); the block, refused only when ANOTHER
 *   integração owns the frete (409 `frete-de-outra-integracao`, S40); then the
 *   cached `readConta` judged by the NF-e upload's own conta predicate (409
 *   `conta-nao-configurada` / `conta-inativa`) BEFORE a client is built, so a
 *   refused conta costs no token read.
 * - `loadShopeeContext(db, contaId).createShopClient()` and the runner. The
 *   route is the composition root: it supplies the client, a MOVING clock (the
 *   runner's budget needs one; the ladder's ONE read is the route's own) and the
 *   sleep.
 *
 * ## The NF-e — re-driven only on `nfe-pendente` (R-e)
 *
 * When Shopee holds the ship for the invoice, the route re-drives the NF-e
 * upload through `reenviarNfeDoPedidoShopee` — the SAME ladder the
 * `enviar-nfe` route runs — and only when the caller has `PERM.pedido.write`;
 * without it nothing is enqueued and the answer says `sem-permissao` (S35). The
 * answer is a 409, TERMINAL for the click: a 202 would re-enqueue on every poll
 * (S36).
 *
 * ## Errors
 *
 * The runner classifies every label-relevant Shopee error into its result;
 * what it rethrows is mapped by `shopeeErrorResponse` UNCHANGED (409
 * `SHOPEE_REAUTH_REQUIRED`, 503 on the network, 502 on a schema drift, …), and
 * anything else rethrows (rule 6).
 *
 * ⚠️ PII: ONE log line here, and only for a `recusa-desconhecida` that carries
 * a `shopeeCode` — `{ op, code }`, the op slug and the token-gated canonical
 * code (review 1, R3-F1), which the 409 body also carries as the optional
 * `shopeeCode`. No answer and no log carries the access key, a tracking
 * number, an address, Shopee's sentence or the bytes of anything but the label
 * itself. The filename carries the pedido's `numero` under Mercado Livre's
 * guard and a package's POSITION — never a package number
 * (`pendenteEtiqueta.ts`).
 */
import { NextResponse } from 'next/server';
import { hasPerm } from '@delfrance/auth';
import { pedidoCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { readConta } from '@/lib/shopee/core/contaCache';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { loadShopeeContext } from '@/lib/shopee/core/shopee';
import {
  avaliarContaParaEtiquetaShopee,
  avaliarPedidoParaEtiquetaShopee,
} from '@/lib/shopee/etiqueta/alvoEtiqueta';
import { TAMANHO_MAX_PACOTE } from '@/lib/shopee/etiqueta/constantesEtiqueta';
import {
  executarEtiquetaShopee,
  type ResultadoEtiqueta,
} from '@/lib/shopee/etiqueta/executarEtiqueta';
import type { EscolhaDeEnvio } from '@/lib/shopee/etiqueta/modoDeEnvio';
import type { MotivoEtiquetaShopee } from '@/lib/shopee/etiqueta/motivosEtiqueta';
import type { DesfechoNfe } from '@/lib/shopee/etiqueta/pendenteEtiqueta';
import { respostaDaEtiqueta } from '@/lib/shopee/etiqueta/respostaEtiqueta';
import { reenviarNfeDoPedidoShopee } from '@/lib/shopee/nfe/reenvioNfe';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The code of the 404 — the pedido document does not exist. */
export const CODIGO_PEDIDO_NAO_ENCONTRADO = 'SHOPEE_ETIQUETA_PEDIDO_NAO_ENCONTRADO';

/** The sentence of the 404. */
export const MSG_PEDIDO_NAO_ENCONTRADO = 'Pedido não encontrado.';

/** The sentence an unusable `pedidoId` gets. */
export const MSG_PEDIDO_ID_INVALIDO = 'pedidoId deve ser um id de documento (sem "/" nem "..").';

/** The sentence a missing or unknown `formato` gets. */
export const MSG_FORMATO_INVALIDO = 'formato é obrigatório e deve ser "pdf" ou "zpl2".';

/** The sentence an unusable `pacote` gets. */
export const MSG_PACOTE_INVALIDO = `pacote, quando informado, deve ser o número de um pacote (texto de 1 a ${String(TAMANHO_MAX_PACOTE)} caracteres).`;

/** The sentence an unusable `envio` gets. */
export const MSG_ENVIO_INVALIDO =
  'envio, quando informado, deve ser { pacote, modo: "pickup", enderecoId, horarioId } ' +
  '(horarioId pode ser null) ou { pacote, modo: "dropoff" }, sem outros campos.';

/** The sentence a body with any other key gets — the runner's input is built by name. */
export const MSG_CAMPO_NAO_ACEITO = 'O corpo aceita apenas pedidoId, formato, pacote e envio.';

/** The only keys the body may carry (no `confirmacoes` — Appendix A). */
const CHAVES_DO_CORPO: ReadonlySet<string> = new Set(['pedidoId', 'formato', 'pacote', 'envio']);

/** The EXACT key set of each `EscolhaDeEnvio` shape (`horarioId` is required, and may be `null`). */
const CHAVES_DO_PICKUP: ReadonlySet<string> = new Set([
  'pacote',
  'modo',
  'enderecoId',
  'horarioId',
]);
const CHAVES_DO_DROPOFF: ReadonlySet<string> = new Set(['pacote', 'modo']);

/** A body reader's verdict: the value, or "unusable" (the caller owns the sentence). */
type Lido<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false };

const ILEGIVEL = { ok: false } as const;

/** A 400 with one sentence. */
function corpoInvalido(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/** A route-owned refusal, through the ONE refusal body the runner's refusals use. */
function recusar(motivo: MotivoEtiquetaShopee): NextResponse {
  return respostaDaEtiqueta({ tipo: 'recusa', motivo }, { numero: null, nfe: null });
}

/** A package number as the body may carry it: non-blank, bounded. Matched EXACTLY later. */
function ehNumeroDePacote(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= TAMANHO_MAX_PACOTE;
}

/** Does `o` carry exactly the keys of `esperadas` — none missing, none extra? */
function temExatamente(o: Record<string, unknown>, esperadas: ReadonlySet<string>): boolean {
  const chaves = Object.keys(o);
  return chaves.length === esperadas.size && chaves.every((chave) => esperadas.has(chave));
}

/** Rung 6: absent/`null` ⇒ the whole order; else one package of a split order. */
function lerPacote(v: unknown): Lido<string | null> {
  if (v == null) return { ok: true, valor: null };
  return ehNumeroDePacote(v) ? { ok: true, valor: v } : ILEGIVEL;
}

/**
 * Rung 7: the operator's answer to an `escolher-envio` question, REBUILT by
 * name. Only the SHAPE is judged here; whether the address and the slot still
 * exist is `escolherModoDeEnvio`'s exact match against a fresh read.
 */
function lerEnvio(v: unknown): Lido<EscolhaDeEnvio | null> {
  if (v == null) return { ok: true, valor: null };
  if (typeof v !== 'object' || Array.isArray(v)) return ILEGIVEL;
  const o = v as Record<string, unknown>;
  const pacote = o['pacote'];
  if (!ehNumeroDePacote(pacote)) return ILEGIVEL;

  if (o['modo'] === 'dropoff') {
    if (!temExatamente(o, CHAVES_DO_DROPOFF)) return ILEGIVEL;
    return { ok: true, valor: { pacote, modo: 'dropoff' } };
  }
  if (o['modo'] !== 'pickup' || !temExatamente(o, CHAVES_DO_PICKUP)) return ILEGIVEL;
  const enderecoId = o['enderecoId'];
  if (typeof enderecoId !== 'string' || enderecoId.trim() === '') return ILEGIVEL;
  // `null` is legal and meaningful: a zero-slot address ("a Shopee agenda").
  const horarioId = o['horarioId'];
  if (horarioId !== null && (typeof horarioId !== 'string' || horarioId.trim() === '')) {
    return ILEGIVEL;
  }
  return { ok: true, valor: { pacote, modo: 'pickup', enderecoId, horarioId } };
}

/**
 * What the route does about the NF-e on an `nfe-pendente` answer: re-drive it
 * (with `PERM.pedido.write`) and map the re-drive's union BY NAME — the access
 * key, the XML and the NF-e document id never leave.
 */
async function desfechoDaNfe(
  db: ReturnType<typeof getAdminFirestore>,
  permissoes: string | undefined,
  pedidoId: string,
  nowMs: number,
): Promise<DesfechoNfe> {
  if (!hasPerm(permissoes, PERM.pedido.write)) return { desfecho: 'sem-permissao' };
  const r = await reenviarNfeDoPedidoShopee(db, { pedidoId, nfeId: null, nowMs });
  switch (r.tipo) {
    case 'enfileirado':
      return { desfecho: 'enfileirado', atrasoSegundos: r.atrasoSegundos };
    case 'nao-elegivel':
      return { desfecho: 'nao-elegivel', motivoNfe: r.motivo };
    case 'nfe-nao-encontrada':
      return { desfecho: 'nfe-nao-encontrada' };
    case 'desligado':
      return { desfecho: 'desligado' };
    default: {
      // A fifth arm stops compiling here instead of reaching the web unmapped.
      const nunca: never = r;
      return nunca;
    }
  }
}

/** The runner's ONE wait, supplied here: no module under `etiqueta/` constructs a timer. */
function dormir(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.frete.read);
  if ('error' in auth) return auth.error;
  const permissoes = auth.caller.permissions;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return corpoInvalido(json.erro);

  // `req.json()` legally yields null, arrays and scalars — those are 400s.
  const bruto = json.valor;
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return corpoInvalido(MSG_BODY_INVALIDO);
  }
  const body = bruto as Record<string, unknown>;

  // TYPE-checked, never truthiness-checked: a `/` would address another
  // document, and a non-string would throw deep inside `.doc(id)` as a 500.
  if (naoDocId(body['pedidoId'])) return corpoInvalido(MSG_PEDIDO_ID_INVALIDO);
  const pedidoId = body['pedidoId'] as string;

  const formato = body['formato'];
  if (formato !== 'pdf' && formato !== 'zpl2') return corpoInvalido(MSG_FORMATO_INVALIDO);

  const pacote = lerPacote(body['pacote']);
  if (!pacote.ok) return corpoInvalido(MSG_PACOTE_INVALIDO);

  const envio = lerEnvio(body['envio']);
  if (!envio.ok) return corpoInvalido(MSG_ENVIO_INVALIDO);

  // STRICT: a `confirmacoes` (or any other key) is refused, never ignored.
  if (Object.keys(body).some((chave) => !CHAVES_DO_CORPO.has(chave))) {
    return corpoInvalido(MSG_CAMPO_NAO_ACEITO);
  }

  // The route's ONE clock read — the NF-e re-drive's SERPRO "now".
  const nowMs = Date.now();
  const db = getAdminFirestore();

  // ---- the pedido, raw, and the ownership proof. ----
  const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  if (!snap.exists) {
    return NextResponse.json(
      { error: MSG_PEDIDO_NAO_ENCONTRADO, code: CODIGO_PEDIDO_NAO_ENCONTRADO },
      { status: 404 },
    );
  }
  const raw = (snap.data() ?? {}) as Record<string, unknown>;
  // ---- the ladder (`alvoEtiqueta.ts`, the CLI's too): ownership, then the block. ----
  const prova = avaliarPedidoParaEtiquetaShopee(pedidoId, raw);
  if (!prova.ok) return recusar(prova.motivo);

  // ---- the conta — the cached reader, before any client or token. ----
  const conta = avaliarContaParaEtiquetaShopee(await readConta(db, prova.contaId));
  if (!conta.ok) return recusar(conta.motivo);

  // ---- the runner. ----
  let r: ResultadoEtiqueta;
  try {
    const client = (await loadShopeeContext(db, prova.contaId)).createShopClient();
    r = await executarEtiquetaShopee(
      {
        client,
        agora: () => Date.now(),
        dormir,
        podeProgramar: hasPerm(permissoes, PERM.frete.write),
      },
      { orderSn: prova.orderSn, formato, pacote: pacote.valor, envio: envio.valor },
    );
  } catch (err) {
    if (isShopeeError(err)) return shopeeErrorResponse(err);
    throw err;
  }

  // The dry run is the CLI's alone; the route never asks for it, so a
  // `simulado` here is a defect — a 500, never a 2xx with nothing in it.
  if (r.tipo === 'simulado') {
    throw new Error('invariante: o executor da etiqueta respondeu simulado fora do modo leitura.');
  }

  // R3-F1: the route's ONE log line. A refusal the table does not know is the
  // datum the table must learn, so its code is recorded — the canonical code
  // the runner already put through `codigoSeguro` (a token, fewer than seven
  // digits: never an order or package number) and our own op slug. Never
  // Shopee's sentence.
  if (r.tipo === 'recusa' && r.shopeeCode !== undefined) {
    console.warn('[shopee/etiqueta] recusa-desconhecida', {
      op: r.operacao ?? null,
      code: r.shopeeCode,
    });
  }

  // ---- the NF-e, only on the one answer that asks for it. ----
  const nfe =
    r.tipo === 'nfe-pendente' ? await desfechoDaNfe(db, permissoes, pedidoId, nowMs) : null;
  return respostaDaEtiqueta(r, { numero: prova.orderSn, nfe });
}
