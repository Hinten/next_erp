/**
 * Shared by the live homologação suites (`emission.homologacao.test.ts`,
 * `svc.homologacao.test.ts`): coerce a `retEnviNFe` (sync or async) down
 * to the inner `protNFe`.
 *
 * - `cStat=104` (Lote processado) → `ret.protNFe` is set inline.
 * - `cStat=103` (Lote recebido) → poll `consultarLote` for the protNFe.
 * - `cStat=100` (rare for autorizarLote) → return ret as-is, no protNFe.
 * - anything else (denial, signature error, etc.) → return undefined so
 *   the caller surfaces the lote-level message.
 */
import { assertNotConsumoIndevido } from '../../src/state';
import { consultarLote } from '../../src/operations/index';
import type { SefazCall } from '../../src/soap';
import type { TProtNFe } from '../../src/types/nfe-schema';

export async function resolveProtocol(
  ret: { cStat: string; xMotivo: string; protNFe?: TProtNFe; infRec?: { nRec: string } },
  call: SefazCall,
): Promise<TProtNFe | undefined> {
  if (ret.protNFe) return ret.protNFe;
  if (ret.cStat !== '103') return undefined;
  if (!ret.infRec?.nRec) return undefined;
  // Bounded poll: 8 × 5s = 40s ceiling. SEFAZ's SLA: 95% within 3 min;
  // homologação typically replies in 1–3 polls.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const poll = await consultarLote(call, { nRec: ret.infRec.nRec });
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
