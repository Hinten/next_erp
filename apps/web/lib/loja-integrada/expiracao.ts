/**
 * How the Loja Integrada Personal Token's expiry is painted on
 * `/canais/loja-integrada/[id]` — colour, words and dates for the panel.
 *
 * The VERDICT is the server's: the status route answers `situacaoValidade`
 * (`ok` / `expirando` / `vencido`) from the same `situacaoValidadeTokenLi`
 * threshold the expiry aviso uses, so the panel's colour and the inbox can never
 * disagree about one conta. This module only maps it to a colour and turns
 * `diasParaExpirar` into words; it recomputes nothing.
 *
 * ⚠️ The expiry is a date the operator COPIED from Loja Integrada's painel, not
 * a clock we observe. A one-time validation at save time is not live health, so
 * nothing here says "conectada".
 *
 * ## Dates without a `Date`
 *
 * `expiraEm` arrives as a São Paulo CIVIL date (`YYYY-MM-DD`) and is shown by
 * splitting the string — never `new Date('2026-12-31')`, which parses as UTC
 * midnight and renders as the 30th anywhere west of Greenwich. The two instants
 * the status carries (`atualizadoEmMs`, `reconexaoPendente.desdeMs`) are turned
 * into a civil date in `FUSO_FISCAL` first, for the same reason.
 */
import { dataCivilNoFuso } from '@delfrance/core/datetime';
import {
  FUSO_FISCAL,
  SITUACAO_VALIDADE_TOKEN_LI,
  type SituacaoValidadeTokenLi,
} from '@delfrance/schemas';

const DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `'2026-12-31'` → `'31/12/2026'`, by splitting the string. Anything that is not
 * a `YYYY-MM-DD` date is returned unchanged rather than guessed at (the wire
 * schema already refuses it, so this is belt and braces).
 */
export function dataCivilParaExibicao(dataCivil: string): string {
  const m = DATA_CIVIL.exec(dataCivil);
  if (m === null) return dataCivil;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** An instant (epoch ms) → `'DD/MM'` of its São Paulo civil date. `null` when not finite. */
export function diaEMesNoFuso(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const m = DATA_CIVIL.exec(dataCivilNoFuso(ms, FUSO_FISCAL));
  return m === null ? null : `${m[3]}/${m[2]}`;
}

/** A Mantine colour name, which is what the badge takes. */
export type CorValidadeLi = 'green' | 'yellow' | 'red' | 'gray';

/**
 * The server's verdict → a colour. `null` (no token, or a status this build
 * could not read) is gray — unknown is never green.
 */
export function corValidadeLi(situacao: SituacaoValidadeTokenLi | null): CorValidadeLi {
  switch (situacao) {
    case SITUACAO_VALIDADE_TOKEN_LI.ok:
      return 'green';
    case SITUACAO_VALIDADE_TOKEN_LI.expirando:
      return 'yellow';
    case SITUACAO_VALIDADE_TOKEN_LI.vencido:
      return 'red';
    case null:
      return 'gray';
  }
}

/**
 * Whole days left → words. The server floors the division, so the last partial
 * day reads `0` — "vence hoje", never "vence em 1 dia" on the morning it
 * expires. Negative is a date that has already passed.
 *
 * `null` and anything non-finite mean "we do not know", which must not be
 * dressed up as a count: a `NaN` would otherwise fall through every comparison
 * into the "venceu" branch and invent a verdict.
 */
export function textoValidadeLi(dias: number | null): string {
  if (dias === null || !Number.isFinite(dias)) return 'validade desconhecida';
  if (dias > 1) return `vence em ${String(dias)} dias`;
  if (dias === 1) return 'vence em 1 dia';
  if (dias === 0) return 'vence hoje';
  if (dias === -1) return 'venceu há 1 dia';
  return `venceu há ${String(-dias)} dias`;
}

/**
 * What the operator should DO about the expiry, or `null` when nothing.
 *
 * - `expirando`: the painel offers "Renovar" from 30 days before; renewing keeps
 *   the SAME token, so here only the date changes ("Só atualizar a validade").
 * - `vencido`: the date the operator copied has passed. Either it was renewed
 *   and only this date is stale, or the token is revoked for good and only a
 *   new one helps — the panel cannot tell which, so it says both.
 */
export function orientacaoValidadeLi(situacao: SituacaoValidadeTokenLi | null): string | null {
  if (situacao === SITUACAO_VALIDADE_TOKEN_LI.expirando) {
    return (
      'Renove o token no painel da Loja Integrada e depois atualize a validade aqui ' +
      '("Só atualizar a validade").'
    );
  }
  if (situacao === SITUACAO_VALIDADE_TOKEN_LI.vencido) {
    return (
      'A validade informada já passou. Se o token foi renovado no painel, atualize a validade ' +
      'aqui; se não foi, ele foi revogado — gere um novo no painel e salve-o aqui.'
    );
  }
  return null;
}
