/**
 * The conta's connection status as the panel sees it — an explicit PROJECTION of
 * the conta and its credential into `statusContaAmazonSchema`
 * (`@delfrance/schemas`), never the document itself.
 *
 * ⚠️ Field by field, on purpose. Spreading the credential would put the refresh
 * token, the access token and the park's ref on the wire; the projection names
 * the seven fields the panel may see and nothing else. `status.test.ts` pins the
 * key set and that no token, ref or fingerprint appears in the output.
 *
 * Next-free and clock-free: `agoraMs` and the environment are parameters. It
 * makes NO Amazon call — the status is what WE stored — so the read switch does
 * not gate it; it is only REPORTED (`chamadasLigadas`), so the panel can say why
 * the connect button answers 503.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { dataCivilNoFuso } from '@delfrance/core/datetime';
import {
  FUSO_FISCAL,
  type StatusContaAmazon,
  diasParaReautorizarAmazon,
  reautorizarAteAmazon,
} from '@delfrance/schemas';

import { lerContaAmazon } from '../core/contas';
import { type CredencialLida, lerCredencial } from '../core/credentialStore';
import { ContaAmazonNaoEncontradaError, CredencialAmazonInvalidaError } from '../core/erros';
import { lerChaveDeChamadasAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';

/** "Not connected": every date `null`. A state to render, not a failure. */
function naoConectada(credencialInvalida: boolean, chamadasLigadas: boolean): StatusContaAmazon {
  return {
    connected: false,
    credencialInvalida,
    autorizadoEm: null,
    reautorizarAte: null,
    diasParaReautorizar: null,
    reconexaoPendente: null,
    chamadasLigadas,
  };
}

/**
 * The status of one conta, read UNCACHED.
 *
 * - no such conta, or not an Amazon conta → `ContaAmazonNaoEncontradaError`
 *   (404). Inactive, unconnected or parked contas answer normally: the panel is
 *   where they get fixed;
 * - no credential → not connected;
 * - a corrupt credential → `{ connected: false, credencialInvalida: true }`,
 *   never an error: a new consent overwrites it.
 */
export async function statusContaAmazon(
  db: Firestore,
  integracaoId: string,
  deps: { readonly ambiente: AmbienteAmazon; readonly agoraMs: number },
): Promise<StatusContaAmazon> {
  const conta = await lerContaAmazon(db, integracaoId);
  if (conta === null) throw new ContaAmazonNaoEncontradaError(integracaoId);
  const chamadasLigadas = lerChaveDeChamadasAmazon(deps.ambiente);

  let lida: CredencialLida | null;
  try {
    lida = await lerCredencial(db, integracaoId);
  } catch (err) {
    if (err instanceof CredencialAmazonInvalidaError) return naoConectada(true, chamadasLigadas);
    throw err;
  }
  if (lida === null) return naoConectada(false, chamadasLigadas);

  const { autorizadoEmMs, reconexaoPendente } = lida.credencial;
  return {
    connected: true,
    credencialInvalida: false,
    autorizadoEm: dataCivilNoFuso(autorizadoEmMs, FUSO_FISCAL),
    reautorizarAte: reautorizarAteAmazon(autorizadoEmMs),
    diasParaReautorizar: diasParaReautorizarAmazon(autorizadoEmMs, deps.agoraMs),
    // Two fields, named: the park's ref and LWA code are guard inputs, not display values.
    reconexaoPendente:
      reconexaoPendente === null
        ? null
        : {
            desde: dataCivilNoFuso(reconexaoPendente.desdeMs, FUSO_FISCAL),
            status: reconexaoPendente.status,
          },
    chamadasLigadas,
  };
}
