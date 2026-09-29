/**
 * The post-send verification of the Shopee price sync (#1521, step 13): after
 * `update_price` ACCEPTED a write, does the price Shopee reports equal the one
 * we sent? ONE function, {@link verificarPrecosEnviados}, and the ONE matcher
 * that ties an echo row back to the model we sent, {@link modeloDoEco}.
 *
 * ## The source is a constant, and the probe chose the echo
 *
 * `FONTE_DE_VERIFICACAO_PRECO` (`constantesPreco.ts`) picks between the
 * `update_price` ECHO (`'eco'`, zero calls) and a fresh read-back
 * (`'releitura'`, the injected `reler`, one read per item on the quota every
 * conta shares). The SG sandbox probe of 2026-09-24 measured echo == request ==
 * read-back on every accepted write (P4/P8), so the echo stands. What the echo
 * can NOT prove — that the STORED value equals the echoed one on a shop where
 * the two would differ — is why the read-back seam exists at all: the flip is
 * that literal, never a change here. A price write does not move the listing's
 * update clock (probe P5), so that clock stands in for neither source.
 *
 * ## ⚠️ A no-model echo carries NO `model_id` (probe P4c)
 *
 * The request of an item without variations carries `model_id:
 * SHOPEE_PRECO_MODEL_ID_SEM_MODELO` (a zero), but its `success_list` entry comes
 * back WITHOUT the key — the package reads it as `null`. So the echo of the one
 * no-model entry is matched by that ABSENCE, never by an equality with zero on
 * the echo side, which would find nothing and report a landed write as
 * unanswered. The reverse holds too: on an item WITH models a `null` echo
 * answers no model at all — it is never guessed onto the one sent model it
 * could plausibly be, nor onto the first. A numbered `0` echo on a no-model
 * send (the price page's own sample prints it; the wire never did) is ALSO
 * accepted as that entry's echo (ruling D-10): a no-model send carries one
 * entry, so the zero can only be its answer, and calling a landed write
 * unanswered is the worse error. Both rules live in the ONE branch of
 * {@link modeloDoEco}.
 *
 * Whether a send was a no-model one is read off `enviados` itself: exactly one
 * entry, at `SHOPEE_PRECO_MODEL_ID_SEM_MODELO`. That is sound because the
 * package's validator admits that id ONLY alone in the list, and the decision's
 * structure gate never addresses a has-model listing without its models — so a
 * has-model send can never look like one.
 *
 * ## What counts where
 *
 * - **A divergence** is a sent model whose echo carries a NUMBER that is not the
 *   same price in reais as the one sent (`mesmoPrecoEmReais`, the one price fold
 *   — never an exact `===`, never a tolerance). Any divergent number on a model
 *   makes it divergent, even beside an agreeing duplicate.
 * - **`ecosNulos`** counts the sent models with no echo number to compare: an
 *   echo row whose price is `null` (a documented confirmation without the
 *   number), or no echo row at all. Neither is a divergence — a missing row is
 *   the sender's attribution to call (`modelo-sem-resposta`), and a numberless
 *   confirmation is still a confirmation. The count is RETURNED, not logged:
 *   this module does not know which listing it is judging, the caller does.
 * - **On a read-back** the fresh shelf price of each sent model is compared
 *   with the same fold, and an unreadable or absent price IS a divergence: the
 *   read-back is the source asked for precisely to PROVE the stored value, and
 *   an unknown price is never "already correct" (the fold's own `null` rule).
 *   `ecosNulos` is always `0` there — a read-back has no echo.
 *
 * Echo rows for a model we did not send are ignored: they certify nothing we
 * wrote, and attribution is the sender's job.
 *
 * PURE apart from the injected `reler`: no clock, no Firestore, no client. It
 * catches nothing — an error of `reler` reaches the sender as the same
 * instance, and the sender owns the ladder. A mismatch never stamps the link
 * (the write was accepted and the listing is fine; only the value is
 * uncertified), which is the sender's rule and not this module's to enforce.
 */
import type { ShopeeUpdatePrice } from '@delfrance/integrations-shopee';
import { mesmoPrecoEmReais } from '@delfrance/schemas';

import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import type { LeituraDePreco } from './leituraPreco';

/** One model the sender WROTE, at the price it wrote. */
type PrecoEnviado = { readonly modelId: number; readonly precoAlvo: number };

/** The verdict: every sent model confirmed (or numberless), or the ones that diverge. */
type VereditoDeVerificacao =
  | { readonly ok: true; readonly ecosNulos: number }
  | { readonly ok: false; readonly divergentes: readonly number[] };

/**
 * Was this a NO-MODEL send? Exactly one entry, at
 * `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` — the sent side, where the id is the
 * constant we put on the wire (the echo side never carries it).
 */
function ehEnvioSemModelo(enviados: readonly PrecoEnviado[]): boolean {
  return enviados.length === 1 && enviados[0]?.modelId === SHOPEE_PRECO_MODEL_ID_SEM_MODELO;
}

/**
 * Which SENT model a `success_list` row answers — seam amendment C-4, the ONE
 * definition, meant for the sender's attribution as much as for this module.
 *
 * - `semModelo` (the item has no variations): the row answers
 *   `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` when its `model_id` is ABSENT (`null` —
 *   what the sandbox sends, probe P4c) OR the page's own sample `0` (ruling
 *   D-10: a no-model send carries ONE entry, so a `0` echo can only be its
 *   answer, and calling a landed write `modelo-sem-resposta` is the worse
 *   error); a real id answers nothing.
 * - Otherwise: the row answers its own `model_id`, and a `null` answers
 *   NOTHING (never guessed). Whether that id was sent is the caller's
 *   membership test.
 *
 * @returns the answered model id, or `null` when the row answers none.
 */
export function modeloDoEco(
  linha: { readonly model_id: number | null },
  semModelo: boolean,
): number | null {
  if (semModelo) {
    return linha.model_id === null || linha.model_id === SHOPEE_PRECO_MODEL_ID_SEM_MODELO
      ? SHOPEE_PRECO_MODEL_ID_SEM_MODELO
      : null;
  }
  return linha.model_id;
}

/** The echo verdict — zero calls. */
function verificarPeloEco(
  enviados: readonly PrecoEnviado[],
  resposta: ShopeeUpdatePrice,
): VereditoDeVerificacao {
  const semModelo = ehEnvioSemModelo(enviados);
  const divergentes: number[] = [];
  let ecosNulos = 0;
  for (const enviado of enviados) {
    const numeros = resposta.success_list
      .filter((linha) => modeloDoEco(linha, semModelo) === enviado.modelId)
      .map((linha) => linha.original_price)
      .filter((preco): preco is number => preco !== null);
    if (numeros.length === 0) {
      ecosNulos += 1;
      continue;
    }
    if (numeros.some((eco) => !mesmoPrecoEmReais(eco, enviado.precoAlvo))) {
      divergentes.push(enviado.modelId);
    }
  }
  return divergentes.length > 0 ? { ok: false, divergentes } : { ok: true, ecosNulos };
}

/** The read-back verdict — the ONE `reler` call already made by the caller. */
function verificarPelaReleitura(
  enviados: readonly PrecoEnviado[],
  leitura: LeituraDePreco,
): VereditoDeVerificacao {
  const divergentes = enviados
    .filter((enviado) => {
      const lido = leitura.modelos.find((modelo) => modelo.modelId === enviado.modelId);
      return !mesmoPrecoEmReais(lido?.precoAnterior ?? null, enviado.precoAlvo);
    })
    .map((enviado) => enviado.modelId);
  return divergentes.length > 0 ? { ok: false, divergentes } : { ok: true, ecosNulos: 0 };
}

/**
 * Verify an ACCEPTED `update_price`: does Shopee now show, for every model in
 * `enviados`, the price we sent?
 *
 * `'eco'` reads `resposta.success_list` and never calls `reler`. `'releitura'`
 * calls `reler` exactly ONCE — and not at all when `enviados` is empty, since
 * there is nothing to prove and a read spends the shared quota — then compares
 * each sent model's fresh `precoAnterior`.
 *
 * @param enviados the models WRITTEN, each at its target price. A no-model
 *   send is the single entry at `SHOPEE_PRECO_MODEL_ID_SEM_MODELO`.
 * @param resposta the `update_price` payload (the envelope's `response`, or the
 *   re-parsed lists of a thrown partial).
 * @param fonte `FONTE_DE_VERIFICACAO_PRECO` at the call site.
 * @param reler the fresh read of the same listing — the same projection the
 *   decision compared against, so a read-back compares like with like.
 * @returns `{ok: true, ecosNulos}` when no sent model diverges, else
 *   `{ok: false, divergentes}` — the diverging model ids, in `enviados` order.
 */
export async function verificarPrecosEnviados(
  enviados: readonly { readonly modelId: number; readonly precoAlvo: number }[],
  resposta: ShopeeUpdatePrice,
  fonte: 'eco' | 'releitura',
  reler: () => Promise<LeituraDePreco>,
): Promise<
  | { readonly ok: true; readonly ecosNulos: number }
  | { readonly ok: false; readonly divergentes: readonly number[] }
> {
  switch (fonte) {
    case 'eco':
      return verificarPeloEco(enviados, resposta);
    case 'releitura':
      if (enviados.length === 0) return { ok: true, ecosNulos: 0 };
      return verificarPelaReleitura(enviados, await reler());
    default: {
      const nunca: never = fonte;
      throw new Error(`verificarPrecosEnviados: fonte desconhecida ${String(nunca)}.`);
    }
  }
}
