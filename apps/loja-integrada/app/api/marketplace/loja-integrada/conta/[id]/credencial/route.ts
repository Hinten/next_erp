/**
 * `PUT    /api/marketplace/loja-integrada/conta/[id]/credencial` — validate a
 *         Personal Token against Loja Integrada and store it.
 * `DELETE /api/marketplace/loja-integrada/conta/[id]/credencial` — remove it.
 *
 * Both require `PERM.integracao.write`. The bodies and answers are the shared
 * contract in `@delfrance/schemas` (`contaLojaIntegrada.ts`).
 *
 * ## PUT, in order — and nothing is written before step 7
 *
 *  1. the caller, the id, the body (`{ token, expiraEm, versaoEsperada }`; the
 *     token is trimmed at both ends by the schema, once);
 *  2. the expiry date: a real date, today..today + 120 days in São Paulo (422);
 *  3. the conta, read UNCACHED; only `tipo === 3` is required (404), so an
 *     inactive or parked conta can still be fixed;
 *  4. the stored credential, read ONCE, before any call: no document and
 *     `versaoEsperada === null` is a create; a document whose version is
 *     `versaoEsperada` is an update under its `updateTime`; a corrupt one is
 *     409 `LI_CREDENCIAL_INVALIDA`; anything else is 409
 *     `LI_CREDENCIAL_ALTERADA` (another operator, or a park, wrote after the
 *     panel read) — with no Loja Integrada call;
 *  5. the wrong-store guard: the same token stored on ANOTHER Loja Integrada
 *     conta, active or inactive, is 409 `LI_TOKEN_DE_OUTRA_CONTA`;
 *  6. a token short enough to sit inside its own ref is 422 — the package
 *     would refuse every request made with it. Still nothing sent;
 *  7. `validarPersonalToken`, exactly ONE call, logged as one `chamada` line by
 *     the app logger (`core/log.ts`) whenever it was sent: `aceito` stores;
 *     `recusado` and `invalido` are 422, `inconclusivo` 502 (`respostaDeVeredito`);
 *  8. the versioned write (`salvarCredencial`): a lost race is 409, never an
 *     overwrite (root rule 7, tier 3);
 *  9. the conta is read AGAIN: deleted (or re-typed) while the token was being
 *     validated ⇒ the credential just written is removed and the answer is 404.
 *     The conta delete's discovery walk runs once, on the delete, so a write
 *     landing after it would otherwise stay for ever;
 * 10. the avisos (the reconexão row resolved, clocked by this write's commit
 *     time; the expiry row raised or resolved by the shared threshold), then
 *     200 with the status projected from the values written.
 *
 * ## DELETE
 *
 * Unconditional and idempotent (tier 0): the intent is "no token on this
 * conta", whoever saved the current one. No Loja Integrada call — there is no
 * revoke API; the owner removes the token in the painel. Both avisos are
 * resolved, the reconexão one clocked by the delete's commit time.
 *
 * ## Token hygiene
 *
 * The token travels only in the PUT body. It appears in no answer, no log line
 * and no URL; a malformed-JSON `SyntaxError` (whose message quotes the body) is
 * answered with a fixed sentence (`lerCorpoLi`). Logs carry the conta id, the
 * verdict, Loja Integrada's status and the correlation id — never the token
 * nor its fingerprint. The validating GET's own line labels the credential
 * `versaoCredencial: null` (a candidate has no stored version yet).
 *
 * ## The caller going away
 *
 * Only the validation call sits inside the abort `try`, and the branch matches
 * the caller's OWN reason by identity (`err === req.signal.reason`): the
 * package rethrows exactly that object, so any other failure — even one that
 * happens after an abort — is rethrown and surfaces as a 500. Whether Next
 * aborts `req.signal` on a browser disconnect is not verified; if it never
 * does, the branch is dead and harmless.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import {
  type ValidacaoTokenLi,
  validarPersonalToken,
} from '@delfrance/integrations-loja-integrada';
import {
  type RespostaCredencialLojaIntegrada,
  type RespostaRemocaoCredencialLi,
  corpoSalvarCredencialLiSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  type AvisoDepsLi,
  resolverAvisosAposRemocao,
  sincronizarAvisosAposValidacao,
} from '@/lib/lojaIntegrada/avisos/avisos';
import { statusDaCredencial } from '@/lib/lojaIntegrada/conta/status';
import { validarDataDeValidade } from '@/lib/lojaIntegrada/conta/validade';
import {
  contaComOMesmoToken,
  lerContaLojaIntegrada,
  naoEhIdDeConta,
} from '@/lib/lojaIntegrada/core/contas';
import { tokenCabeNaRef } from '@/lib/lojaIntegrada/core/credencial';
import {
  lerCredencial,
  removerCredencial,
  salvarCredencial,
} from '@/lib/lojaIntegrada/core/credentialStore';
import { criarObservadorLi } from '@/lib/lojaIntegrada/core/log';
import {
  LiContaNaoEncontradaError,
  LiCredencialAlteradaError,
} from '@/lib/lojaIntegrada/core/erros';
import {
  isLiAppError,
  lerCorpoLi,
  respostaCancelada,
  respostaDeErroLi,
  respostaDeVeredito,
  respostaIdInvalido,
  respostaTokenDeOutraConta,
  respostaTokenNaRef,
  respostaValidadeRecusada,
} from '@/lib/lojaIntegrada/core/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG = '[loja-integrada/credencial]';

function depsDeAviso(agoraMs: number): AvisoDepsLi {
  return { increment: (by) => FieldValue.increment(by), nowMs: agoraMs, logger: console };
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (naoEhIdDeConta(id)) return respostaIdInvalido();

  const corpo = await lerCorpoLi(req, corpoSalvarCredencialLiSchema);
  if (!corpo.ok) return corpo.resposta;
  const { token, expiraEm, versaoEsperada } = corpo.dados;

  const agoraMs = Date.now();
  const validade = validarDataDeValidade(expiraEm, agoraMs);
  if (!validade.ok) return respostaValidadeRecusada(validade);

  const db = getAdminFirestore();
  try {
    const conta = await lerContaLojaIntegrada(db, id);
    if (conta === null) throw new LiContaNaoEncontradaError(id);

    // Read ONCE, before any call: the version the write will be conditioned on.
    const lida = await lerCredencial(db, id);
    const mesmaVersao = lida === null ? versaoEsperada === null : lida.versaoUs === versaoEsperada;
    if (!mesmaVersao) throw new LiCredencialAlteradaError(id);

    const outraConta = await contaComOMesmoToken(db, id, token, { logger: console });
    if (outraConta !== null) {
      console.warn(`${LOG} token já salvo em outra conta`, { integracaoId: id, outraConta });
      return respostaTokenDeOutraConta();
    }

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
      console.warn(`${LOG} token não aceito`, {
        integracaoId: id,
        veredito: validacao.veredito,
        status: validacao.status,
        correlationId: validacao.correlationId,
      });
      return respostaDeVeredito(validacao);
    }

    const escrita = await salvarCredencial(db, id, {
      personalToken: token,
      tokenExpiraEmMs: validade.tokenExpiraEmMs,
      agoraMs,
      versaoEsperada: lida?.updateTime,
    });

    // The conta may have been deleted while the token was being validated.
    const depois = await lerContaLojaIntegrada(db, id);
    if (depois === null) {
      await removerCredencial(db, id);
      console.warn(`${LOG} conta removida durante a validação; credencial desfeita`, {
        integracaoId: id,
      });
      throw new LiContaNaoEncontradaError(id);
    }

    const avisos = await sincronizarAvisosAposValidacao(
      db,
      {
        integracaoId: id,
        lojaNome: depois.nome,
        tokenExpiraEmMs: validade.tokenExpiraEmMs,
        versaoUs: escrita.versaoUs,
      },
      depsDeAviso(agoraMs),
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

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (naoEhIdDeConta(id)) return respostaIdInvalido();

  const db = getAdminFirestore();
  try {
    const conta = await lerContaLojaIntegrada(db, id);
    if (conta === null) throw new LiContaNaoEncontradaError(id);

    const escrita = await removerCredencial(db, id);
    await resolverAvisosAposRemocao(
      db,
      { integracaoId: id, lojaNome: conta.nome, versaoUs: escrita.versaoUs },
      depsDeAviso(Date.now()),
    );
    const resposta: RespostaRemocaoCredencialLi = { ok: true };
    return NextResponse.json(resposta);
  } catch (err) {
    if (isLiAppError(err)) return respostaDeErroLi(err);
    throw err;
  }
}
