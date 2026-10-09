/**
 * The expiry date an operator types when saving or renewing a Personal Token,
 * checked BEFORE anything else happens: a bad date makes no Loja Integrada call
 * and no read of the credential.
 *
 * The date is copied from the painel, never computed: Loja Integrada shows it,
 * and nothing else tells us when the token lapses. It is stored as 23:59:59 in
 * São Paulo on that civil day (`fimDoDiaNoFuso`), so it reads back as the same
 * date in the panel, the aviso and the sweep.
 *
 * The accepted window — today to today + 120 days, São Paulo civil dates — is
 * `janelaDeValidadeTokenLi` in `@delfrance/schemas`, the SAME function the
 * panel's date picker uses for its bounds. This module only turns it into a
 * verdict with a `code` and a pt-BR sentence.
 *
 * Next-free and clock-free: `agoraMs` is a parameter.
 */
import { fimDoDiaNoFuso } from '@delfrance/core/datetime';
import { CODIGO_ERRO_LI, FUSO_FISCAL, janelaDeValidadeTokenLi } from '@delfrance/schemas';

/** A date the route accepts, with the instant it is stored as. */
export interface ValidadeAceita {
  readonly ok: true;
  /** The civil date, exactly as received. */
  readonly expiraEm: string;
  /** ms — 23:59:59 São Paulo on that day: the stored `tokenExpiraEmMs`. */
  readonly tokenExpiraEmMs: number;
}

/** A date the route refuses (422), with the `code` the panel keys its copy on. */
export interface ValidadeRecusada {
  readonly ok: false;
  readonly code:
    | typeof CODIGO_ERRO_LI.validadeInvalida
    | typeof CODIGO_ERRO_LI.validadePassada
    | typeof CODIGO_ERRO_LI.validadeDistante;
  readonly motivo: string;
}

export type ValidadeDoToken = ValidadeAceita | ValidadeRecusada;

/**
 * - not a real `YYYY-MM-DD` date (`2026-02-30`, `31/12/2026`, `''`) →
 *   `LI_VALIDADE_INVALIDA`;
 * - before today in São Paulo → `LI_VALIDADE_PASSADA`;
 * - after today + 120 days → `LI_VALIDADE_DISTANTE` (a typo in the year — a
 *   Personal Token lasts three months);
 * - otherwise accepted, both ends inclusive.
 *
 * The comparisons are on strings: both sides are `YYYY-MM-DD` with a four-digit
 * year (`fimDoDiaNoFuso` refuses any other shape first), so string order is
 * calendar order.
 */
export function validarDataDeValidade(expiraEm: string, agoraMs: number): ValidadeDoToken {
  const tokenExpiraEmMs = fimDoDiaNoFuso(expiraEm, FUSO_FISCAL);
  if (tokenExpiraEmMs === null) {
    return {
      ok: false,
      code: CODIGO_ERRO_LI.validadeInvalida,
      motivo: 'A validade do token precisa ser uma data real (AAAA-MM-DD).',
    };
  }
  const { desde, ate } = janelaDeValidadeTokenLi(agoraMs);
  if (expiraEm < desde) {
    return {
      ok: false,
      code: CODIGO_ERRO_LI.validadePassada,
      motivo: `A validade do token (${expiraEm}) já passou: o mínimo é hoje, ${desde}.`,
    };
  }
  if (expiraEm > ate) {
    return {
      ok: false,
      code: CODIGO_ERRO_LI.validadeDistante,
      motivo: `A validade do token (${expiraEm}) passa do máximo de ${ate}. O token dura três meses: confira o ano.`,
    };
  }
  return { ok: true, expiraEm, tokenExpiraEmMs };
}
