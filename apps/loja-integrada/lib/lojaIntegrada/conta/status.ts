/**
 * The conta's credential status as the panel sees it — an explicit PROJECTION
 * of the credential document into `statusContaLojaIntegradaSchema`
 * (`@delfrance/schemas`), never the document itself.
 *
 * ⚠️ Field by field, on purpose. Spreading the document would put the token,
 * its fingerprint and the park's `refCredencial` on the wire; the projection
 * names the seven fields the panel may see and nothing else. `status.test.ts`
 * pins that the token, the fingerprint and the ref appear nowhere in the
 * output.
 *
 * Next-free and clock-free: `agoraMs` is a parameter.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { dataCivilNoFuso } from '@delfrance/core/datetime';
import {
  type CredenciaisLojaIntegrada,
  FUSO_FISCAL,
  type StatusContaLojaIntegrada,
  diasParaExpirarLi,
  situacaoValidadeTokenLi,
} from '@delfrance/schemas';

import { lerContaLojaIntegrada } from '../core/contas';
import { lerCredencial } from '../core/credentialStore';
import { LiContaNaoEncontradaError } from '../core/erros';

/** "No token stored": every field `null`. A state to render, not a failure. */
export function statusNaoConfigurado(): StatusContaLojaIntegrada {
  return {
    configurado: false,
    expiraEm: null,
    diasParaExpirar: null,
    situacaoValidade: null,
    atualizadoEmMs: null,
    versaoCredencialUs: null,
    reconexaoPendente: null,
  };
}

/** The credential fields the projection reads — never the token. */
export type CamposDoStatus = Pick<
  CredenciaisLojaIntegrada,
  'tokenExpiraEmMs' | 'tokenAtualizadoEmMs' | 'reconexaoPendente'
>;

/**
 * Project a stored (or just-written) credential.
 *
 * @param versaoUs the credential document's commit time in µs — `CredencialLida.versaoUs`
 *   for a read, `EscritaCredencial.versaoUs` for a write (a document's
 *   `updateTime` IS its last write's `writeTime`). The panel echoes it back as
 *   `versaoEsperada`.
 */
export function statusDaCredencial(
  c: CamposDoStatus,
  versaoUs: number,
  agoraMs: number,
): StatusContaLojaIntegrada {
  const dias = diasParaExpirarLi(c.tokenExpiraEmMs, agoraMs);
  const parada = c.reconexaoPendente;
  return {
    configurado: true,
    // The stored instant is 23:59:59 São Paulo on the operator's date, so this
    // reads back as exactly the date they typed.
    expiraEm: dataCivilNoFuso(c.tokenExpiraEmMs, FUSO_FISCAL),
    diasParaExpirar: dias,
    situacaoValidade: situacaoValidadeTokenLi(dias),
    atualizadoEmMs: c.tokenAtualizadoEmMs,
    versaoCredencialUs: versaoUs,
    // Two fields, named: the park's ref is a guard input, not a display value.
    reconexaoPendente: parada === null ? null : { desdeMs: parada.desdeMs, status: parada.status },
  };
}

/**
 * The status of one conta, read UNCACHED.
 *
 * - no such conta, or not a Loja Integrada conta → `LiContaNaoEncontradaError`
 *   (404). Inactive or parked contas answer normally: the panel is where they
 *   get fixed.
 * - no credential → {@link statusNaoConfigurado};
 * - a corrupt credential → `LiCredencialInvalidaError` (409 with the field
 *   PATHS), never a 500: the panel tells the operator to remove the token and
 *   save it again.
 */
export async function lerStatusDaConta(
  db: Firestore,
  integracaoId: string,
  agoraMs: number,
): Promise<StatusContaLojaIntegrada> {
  const conta = await lerContaLojaIntegrada(db, integracaoId);
  if (conta === null) throw new LiContaNaoEncontradaError(integracaoId);
  const lida = await lerCredencial(db, integracaoId);
  if (lida === null) return statusNaoConfigurado();
  return statusDaCredencial(lida.credencial, lida.versaoUs, agoraMs);
}
