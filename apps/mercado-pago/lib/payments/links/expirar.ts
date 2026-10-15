/**
 * Expiring a Mercado Pago preference — the ONE way this app closes a payment
 * link (#367): the operator's cancel, the auto-close once a link's quota is
 * paid, and the cleanup of the preferences a failed create already minted.
 *
 * Mercado Pago has no "delete" and no "max uses" for a preference; the only lever
 * is `PUT /checkout/preferences/{id}` with `expires` and the two deadlines.
 * Kept apart from `criarLinks.ts` so the auto-close — which the webhook's
 * Cloud Function bundles — does not drag the create flow's collections in with it.
 */
import { formatIsoNoFuso } from '@delfrance/core/datetime';
import {
  MercadoPagoHttpError,
  type MercadoPagoApi,
  type MpPreferenceExpireRequest,
} from '@delfrance/integrations-mercado-pago';
import { FUSO_FISCAL } from '@delfrance/schemas';

/**
 * The PUT body that closes a preference NOW.
 *
 * Both deadlines move: `expiration_date_to` ends the checkout window, and
 * `date_of_expiration` is the payment deadline of the OFFLINE methods and Pix —
 * left in the future, a Pix code or boleto issued before the cancel would stay
 * payable for days after the operator withdrew the link. Whether Mercado Pago
 * honours a past `date_of_expiration` on an already-issued code is confirmed only
 * by the live probe (P5); until then the expire is best effort, which is why a
 * link that is paid after being cancelled still reads as paid
 * (`situacaoDoLink`).
 *
 * The offset is explicit (`-03:00` in São Paulo, never `Z`), the format
 * Mercado Pago documents.
 */
export function expirePatch(agoraMs: number): MpPreferenceExpireRequest {
  const agora = formatIsoNoFuso(agoraMs, FUSO_FISCAL);
  return { expires: true, expiration_date_to: agora, date_of_expiration: agora };
}

/**
 * Close ONE preference — what `cancelarLink`, `encerrarLink` and the orphan
 * cleanup below all call, so the three cannot drift on how a preference is closed.
 *
 * PUTs the full {@link expirePatch}. Mercado Pago may refuse a past (or near-now)
 * `date_of_expiration` with a 400 — unconfirmed until probe P5 — and that refusal
 * must not leave the CHECKOUT open, so a 400 is retried exactly ONCE with the
 * patch minus `date_of_expiration` (`expiration_date_to` is what closes the
 * checkout). Resolves when either PUT succeeds. Anything other than a 400 on the
 * first PUT — and whatever the retry throws — goes to the caller untouched, so its
 * own 4xx / retry policy applies to the FINAL answer.
 */
export async function expirarPreferencia(
  api: Pick<MercadoPagoApi, 'updatePreference'>,
  preferenceId: string,
  agoraMs: number,
): Promise<void> {
  const patch = expirePatch(agoraMs);
  try {
    await api.updatePreference(preferenceId, patch);
  } catch (err) {
    if (!(err instanceof MercadoPagoHttpError && err.status === 400)) throw err;
    console.warn('[mercado-pago] expire refused with 400 — retrying without date_of_expiration', {
      preferenceId,
    });
    await api.updatePreference(preferenceId, {
      expires: patch.expires,
      expiration_date_to: patch.expiration_date_to,
    });
  }
}

/**
 * Best-effort expiry of preferences that must not stay payable: the ones a
 * create minted before it failed, lost a race, or was refused inside the
 * transaction. Never throws — a rejected expiry is logged and the rest still run
 * (`Promise.allSettled`, so no generic catch), because the caller is already
 * reporting a failure and an orphan preference nobody was given is harmless.
 * Each one goes through {@link expirarPreferencia}, 400 fallback included.
 */
export async function expirarPreferencias(
  api: Pick<MercadoPagoApi, 'updatePreference'>,
  preferenceIds: ReadonlyArray<string>,
  agoraMs: number,
): Promise<void> {
  if (preferenceIds.length === 0) return;
  const resultados = await Promise.allSettled(
    preferenceIds.map((preferenceId) => expirarPreferencia(api, preferenceId, agoraMs)),
  );
  resultados.forEach((resultado, indice) => {
    if (resultado.status === 'rejected') {
      const motivo: unknown = resultado.reason;
      console.error('[mercado-pago] could not expire an orphan preference', {
        preferenceId: preferenceIds[indice],
        motivo: motivo instanceof Error ? motivo.message : 'erro desconhecido',
      });
    }
  });
}
