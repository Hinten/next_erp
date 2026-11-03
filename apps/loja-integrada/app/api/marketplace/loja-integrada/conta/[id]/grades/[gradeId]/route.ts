/**
 * `GET /api/marketplace/loja-integrada/conta/[id]/grades/[gradeId]` — one grade of the store and
 * the options it offers (master plan step 10, #1821). Requires `PERM.integracao.read`. The web's
 * variation linker calls it, one grade at a time.
 *
 * The wire contract is `packages/schemas/src/catalogoLojaIntegrada.ts`: every 200 is built through
 * `respostaGradeLiSchema`. An option whose `grade` names ANOTHER grade is not offered; one whose
 * `grade` cannot be read is kept (both counted on the core's WARN line).
 *
 * - 200 `{ grade, opcoes, lidaEmMs }`; `?atualizar=1` (exactly) asks for a fresh read.
 * - 400 `LI_ID_INVALIDO`: the conta id, or a `gradeId` that is not a canonical positive integer
 *   (`gradeIdDaRotaLi`: `08946`, `1e3`, `0` are refused) — answered BEFORE anything is read.
 * - 401/403 (the caller).
 * - The conta's own refusals: 503 `LI_CHAMADAS_DESLIGADAS` (the read switch, D17), 404/409 for the
 *   conta and its credential; a 401 parks the conta first.
 * - The read's own: 409 `LI_GRADE_AUSENTE_NA_LOJA` (a 404: deleted in the painel, or another
 *   store's token), 502 `LI_RECURSO_NAO_PERMITIDO` (a 403: NOTHING is parked), 502
 *   `LI_LOJA_INDISPONIVEL` (an outage, or a detail of another grade), 503 `LI_LIMITE_DE_CHAMADAS`,
 *   504 `LI_TEMPO_ESGOTADO_LOJA`.
 * - 499 with an empty body: the caller went away during the read.
 * - Anything else (a 3xx, a 400, Firestore, our own misconfiguration) is rethrown, so it surfaces
 *   as a 500 (root rule 6).
 *
 * The work is `lib/lojaIntegrada/catalogo/catalogo.ts` (the context loader and its switch first,
 * then the cache, then the paced package read and the grade's identity check).
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { gradeIdDaRotaLi, respostaGradeLiSchema } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { lerCatalogoLi, pedeAtualizacaoLi } from '@/lib/lojaIntegrada/catalogo/catalogo';
import { naoEhIdDeConta } from '@/lib/lojaIntegrada/core/contas';
import {
  respostaCancelada,
  respostaDeFalhaDeLeituraLi,
  respostaIdDeGradeInvalido,
  respostaIdInvalido,
} from '@/lib/lojaIntegrada/core/respond';
import { ritmoDeLeituraLi } from '@/lib/lojaIntegrada/core/ritmo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The pacer's sleep. */
function esperar(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; gradeId: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;
  const { id, gradeId: segmento } = await params;
  if (naoEhIdDeConta(id)) return respostaIdInvalido();
  // The grade id answers before anything is read: the canonical decimal, or a 400.
  const gradeId = gradeIdDaRotaLi(segmento);
  if (gradeId === null) return respostaIdDeGradeInvalido();

  const r = await lerCatalogoLi(
    {
      db: getAdminFirestore(),
      ambiente: process.env,
      ritmo: ritmoDeLeituraLi(esperar),
      sinal: req.signal,
      agoraMs: () => Date.now(),
      increment: (by: number) => FieldValue.increment(by),
      logger: console,
    },
    id,
    { recurso: 'grade', gradeId },
    { atualizar: pedeAtualizacaoLi(req.url) },
  );

  switch (r.tipo) {
    case 'cancelado':
      return respostaCancelada();
    case 'falha':
      return respostaDeFalhaDeLeituraLi(r.falha);
    case 'resposta':
      // The web derives its own freshness from `lidaEmMs`; the browser keeps no copy.
      return NextResponse.json(respostaGradeLiSchema.parse(r.resposta), {
        headers: { 'Cache-Control': 'no-store' },
      });
  }
}
