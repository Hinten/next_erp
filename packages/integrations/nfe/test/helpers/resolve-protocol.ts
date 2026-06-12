/**
 * Shared by the live homologação suites (`emission.homologacao.test.ts`,
 * `svc.homologacao.test.ts`): coerce a `retEnviNFe` (sync or async) down
 * to the inner `protNFe`.
 *
 * - `protNFe` already inline (the sync cStat=104 shape) → returned directly.
 * - `cStat=103` (Lote recebido) → poll `consultarLote` for the protNFe.
 * - anything else without an inline protNFe (denial, signature error, the
 *   rare lote-level 100) → returns `undefined` so the caller surfaces the
 *   lote-level cStat/xMotivo.
 *
 * `consReciCall` MUST target the authorizer's **NfeRetAutorizacao** URL —
 * `consultarLote` posts a `consReciNFe` envelope, which the Autorizacao
 * service rejects. Guarded below: every endpoint table's RetAutorizacao
 * URL contains "retautorizacao" (SP lowercase path, SVC PascalCase path),
 * so a mistargeted call fails loudly at the first poll instead of
 * producing a confusing SOAP fault mid-test.
 */
import { assertNotConsumoIndevido } from '../../src/state';
import { consultarLote } from '../../src/operations/index';
import type { SefazCall } from '../../src/soap';
import type { TProtNFe } from '../../src/types/nfe-schema';

export async function resolveProtocol(
  ret: { cStat: string; xMotivo: string; protNFe?: TProtNFe; infRec?: { nRec: string } },
  consReciCall: SefazCall,
): Promise<TProtNFe | undefined> {
  if (ret.protNFe) return ret.protNFe;
  if (ret.cStat !== '103') return undefined;
  if (!ret.infRec?.nRec) return undefined;
  if (!/retautorizacao/i.test(consReciCall.url)) {
    throw new Error(
      `resolveProtocol: consReciCall must target NfeRetAutorizacao, got ${consReciCall.url}`,
    );
  }
  // Bounded poll: 8 × 5s = 40s ceiling. SEFAZ's SLA: 95% within 3 min;
  // homologação typically replies in 1–3 polls.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const poll = await consultarLote(consReciCall, { nRec: ret.infRec.nRec });
    assertNotConsumoIndevido(poll, `consultarLote/attempt=${attempt + 1}`);
    // eslint-disable-next-line no-console
    console.log(
      `[consultarLote attempt=${attempt + 1}] cStat=${poll.cStat} xMotivo="${poll.xMotivo}"`,
    );
    if (poll.cStat === '105') continue; // ainda em processamento
    if (poll.protNFe && poll.protNFe[0]) return poll.protNFe[0];
    return undefined;
  }
  return undefined;
}
