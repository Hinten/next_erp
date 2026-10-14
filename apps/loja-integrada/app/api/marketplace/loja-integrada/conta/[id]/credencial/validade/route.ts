/**
 * `PUT /api/marketplace/loja-integrada/conta/[id]/credencial/validade` — the
 * owner renewed the Personal Token in the painel; store its new expiry date.
 * Requires `PERM.integracao.write`. Body `{ expiraEm, versaoEsperada }`.
 *
 * Renewing in the painel keeps the SAME token, which is shown only once, so the
 * operator cannot paste it again: this route re-validates the STORED token and
 * changes only its expiry. It is also the "revalidate" action after a park the
 * operator believes is wrong — it only ever clears a park on a token Loja
 * Integrada accepted just now.
 *
 * In order:
 *
 *  0. the caller and the id; then the read switch (`LOJA_INTEGRADA_CHAMADAS`,
 *     `core/valvulas.ts`): anything but the exact `on` is 503
 *     `LI_CHAMADAS_DESLIGADAS` with one `chamada-bloqueada` line, before any
 *     read and before any Loja Integrada call (D17);
 *  1. the body;
 *  2. the expiry date: a real date, today..today + 120 days in São Paulo (422);
 *  3. the conta, read UNCACHED; only `tipo === 3` is required (404);
 *  4. the stored credential: absent ⇒ 409 `LI_CREDENCIAL_AUSENTE`; corrupt ⇒
 *     409 `LI_CREDENCIAL_INVALIDA`; a version other than `versaoEsperada` ⇒
 *     409 `LI_CREDENCIAL_ALTERADA` — all before any Loja Integrada call;
 *  5. a stored token that would sit inside its NEW ref ⇒ 422 (never sent);
 *  6. `validarPersonalToken` on the stored token, exactly ONE call, logged as one
 *     `chamada` line (`core/log.ts`) and mapped like the save
 *     (`respostaDeVeredito`). A `recusado` here does NOT park: the next flow call
 *     does, through the context;
 *  7. `atualizarValidade` under the read's `updateTime`: a write in between is
 *     409 `LI_CREDENCIAL_ALTERADA`, a removal in between 409
 *     `LI_CREDENCIAL_AUSENTE`;
 *  8. the avisos, clocked by this write's commit time, then 200 with the status
 *     projected from the values written.
 *
 * No post-write conta re-check, unlike the save: this is an `update`, which can
 * never create the document, so a conta deleted meanwhile leaves nothing behind
 * that its delete's discovery walk does not reclaim.
 *
 * Token hygiene and the abort narrowing are the save route's (see
 * `../route.ts`): the token is read from the store and handed to the package
 * only, never logged or answered.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  type ValidacaoTokenLi,
  validarPersonalToken,
} from '@delfrance/integrations-loja-integrada';
import {
  type RespostaCredencialLojaIntegrada,
  corpoRenovarValidadeLiSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { sincronizarAvisosAposValidacao } from '@/lib/lojaIntegrada/avisos/avisos';
import { statusDaCredencial } from '@/lib/lojaIntegrada/conta/status';
import { validarDataDeValidade } from '@/lib/lojaIntegrada/conta/validade';
import { lerContaLojaIntegrada, naoEhIdDeConta } from '@/lib/lojaIntegrada/core/contas';
import { tokenCabeNaRef } from '@/lib/lojaIntegrada/core/credencial';
import { atualizarValidade, lerCredencial } from '@/lib/lojaIntegrada/core/credentialStore';
import { criarObservadorLi } from '@/lib/lojaIntegrada/core/log';
import {
  LiContaNaoEncontradaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
} from '@/lib/lojaIntegrada/core/erros';
import {
  isLiAppError,
  lerCorpoLi,
  respostaCancelada,
  respostaChamadasDesligadas,
  respostaDeErroLi,
  respostaDeVeredito,
  respostaIdInvalido,
  respostaTokenNaRef,
  respostaValidadeRecusada,
} from '@/lib/lojaIntegrada/core/respond';
import { lerChaveDeChamadas, registrarChamadaBloqueadaLi } from '@/lib/lojaIntegrada/core/valvulas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (naoEhIdDeConta(id)) return respostaIdInvalido();

  // The read switch (D17): read once, before the body. Off ⇒ no read, no call.
  const ambiente = process.env;
  if (!lerChaveDeChamadas(ambiente)) {
    registrarChamadaBloqueadaLi('validarPersonalToken', ambiente, { conta: id });
    return respostaChamadasDesligadas();
  }

  const corpo = await lerCorpoLi(req, corpoRenovarValidadeLiSchema);
  if (!corpo.ok) return corpo.resposta;
  const { expiraEm, versaoEsperada } = corpo.dados;

  const agoraMs = Date.now();
  const validade = validarDataDeValidade(expiraEm, agoraMs);
  if (!validade.ok) return respostaValidadeRecusada(validade);

  const db = getAdminFirestore();
  try {
    const conta = await lerContaLojaIntegrada(db, id);
    if (conta === null) throw new LiContaNaoEncontradaError(id);

    const lida = await lerCredencial(db, id);
    if (lida === null) throw new LiCredencialAusenteError(id);
    if (lida.versaoUs !== versaoEsperada) throw new LiCredencialAlteradaError(id);

    const token = lida.credencial.personalToken;
    if (tokenCabeNaRef(token, agoraMs)) return respostaTokenNaRef();

    let validacao: ValidacaoTokenLi;
    try {
      validacao = await validarPersonalToken({
        token,
        sinal: req.signal,
        onChamada: criarObservadorLi({ conta: id }),
      });
    } catch (err) {
      if (req.signal.aborted && err === req.signal.reason) return respostaCancelada();
      throw err;
    }
    if (validacao.veredito !== 'aceito') {
      console.warn('[loja-integrada/validade] token salvo não aceito na renovação', {
        integracaoId: id,
        veredito: validacao.veredito,
        status: validacao.status,
        correlationId: validacao.correlationId,
      });
      return respostaDeVeredito(validacao);
    }

    const escrita = await atualizarValidade(db, id, {
      tokenExpiraEmMs: validade.tokenExpiraEmMs,
      agoraMs,
      versaoEsperada: lida.updateTime,
    });

    const avisos = await sincronizarAvisosAposValidacao(
      db,
      {
        integracaoId: id,
        lojaNome: conta.nome,
        tokenExpiraEmMs: validade.tokenExpiraEmMs,
        versaoUs: escrita.versaoUs,
      },
      { increment: (by) => FieldValue.increment(by), nowMs: agoraMs, logger: console },
    );

    const resposta: RespostaCredencialLojaIntegrada = {
      ...statusDaCredencial(
        {
          tokenExpiraEmMs: validade.tokenExpiraEmMs,
          tokenAtualizadoEmMs: agoraMs,
          reconexaoPendente: null,
        },
        escrita.versaoUs,
        agoraMs,
      ),
      reconexaoResolvida: avisos.reconexaoResolvida,
    };
    return NextResponse.json(resposta);
  } catch (err) {
    if (isLiAppError(err)) return respostaDeErroLi(err);
    throw err;
  }
}
