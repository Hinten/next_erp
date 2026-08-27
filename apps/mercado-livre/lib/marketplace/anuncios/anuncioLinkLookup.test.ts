/**
 * Both controls for the anúncio link lookup (#1342).
 *
 * ⚠️ The two that matter are a matched pair, and neither is worth anything
 * alone. "A plain link still resolves" passes against the OLD single-stage
 * lookup too — it is the control that proves the fix broke nothing. "A
 * User-Products family member resolves" is the one that was red before the fix
 * and is the entire reason this module exists. A suite carrying only the first
 * proves nothing about the defect it was written for.
 *
 * Mutation check — this file is only worth its runtime if it goes red on a real
 * regression. Delete the stage-2 block from `resolverLinkDoAnuncio` (reverting
 * to today's stage-1-only behaviour) and "resolves a member through the family
 * query" must fail while "resolves a plain link" stays green. Drop the
 * `daMesmaFamilia` guard to a bare `membro != null` and "does not attach a
 * member from ANOTHER family" must fail.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  resolverLinkDoAnuncio,
  type AnuncioLinkPort,
  type LinkPaiCandidato,
} from './anuncioLinkLookup';
import type { UpMemberResolution } from './upMemberLink';

const CONTA = 'int1';
const REF = `documents/integracao/${CONTA}`;
const ITEM = 'MLB5140167173';
/** The family root from the live run that filed this defect. */
const RAIZ = '05abf584e806581ddb2f3e0a48f9d2a034815e7356fe444fdd4a5cc9b6df209b';

function candidato(over: Partial<LinkPaiCandidato> = {}): LinkPaiCandidato {
  return {
    produtoId: 'prod1',
    linkDocId: 'link1',
    link: { id: ITEM, contaOuterRef: REF, isUserProductModel: false },
    ...over,
  };
}

function membro(over: Partial<UpMemberResolution> = {}): UpMemberResolution {
  return {
    childProdutoId: 'filho1',
    memberDocId: 'memb1',
    memberRaw: { itemId: ITEM, sku: 'CAM-PRETA-M' },
    produtoId: RAIZ,
    linkDocId: 'linkFamilia',
    linkRaw: { id: '6264141844942250', contaOuterRef: REF, isUserProductModel: true },
    pmlOuterRef: `documents/produtos/${RAIZ}/produtoMercadoLivre/linkFamilia`,
    ...over,
  };
}

/** A port over fixed answers, with both stages spied so call counts assert. */
function porta(
  candidatos: readonly LinkPaiCandidato[],
  familia: UpMemberResolution | null = null,
): AnuncioLinkPort & {
  linksPorId: ReturnType<typeof vi.fn>;
  familiaPorMembro: ReturnType<typeof vi.fn>;
} {
  return {
    linksPorId: vi.fn(async () => candidatos),
    familiaPorMembro: vi.fn(async () => familia),
  };
}

describe('resolverLinkDoAnuncio — the known-good control', () => {
  it('resolves a plain produtoMercadoLivre link exactly as before', async () => {
    const p = porta([candidato()]);

    const r = await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(r).toMatchObject({ achado: true, produtoId: 'prod1', linkDocId: 'link1', membro: null });
  });

  it('⛔ never pays the member query for a non-UP hit — stage 2 is the cost model', async () => {
    // Stage 2 exists to be skipped by the common case. A version that always ran
    // it would pass every other test in this file and double the read cost of
    // every simple listing.
    const p = porta([candidato()]);

    await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(p.familiaPorMembro).not.toHaveBeenCalled();
  });
});

describe('resolverLinkDoAnuncio — the known-bad control (#1342)', () => {
  it('⛔ resolves a User-Products family MEMBER through the family query', async () => {
    // The defect: the member's own MLB… lives on `variacaoMercadoLivre.itemId`,
    // so stage 1 matches nothing and the old lookup reported the listing as
    // unknown to the ERP. This is the assertion that was red before the fix.
    const p = porta([], membro());

    const r = await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(r).toMatchObject({ achado: true, produtoId: RAIZ, linkDocId: 'linkFamilia' });
  });

  it('carries BOTH ends, so the report can name the family and the member', async () => {
    const p = porta([], membro());

    const r = await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(r.achado && r.membro).toMatchObject({
      produtoId: 'filho1',
      docId: 'memb1',
      via: 'familia',
    });
  });

  it('answers with the FAMILY parent link, not the member link', async () => {
    // The diff downstream reads `link.category_id` &c., which only the parent
    // carries; handing it the member payload would report the family as empty.
    const p = porta([], membro());

    const r = await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(r.achado && r.link.isUserProductModel).toBe(true);
  });
});

describe('resolverLinkDoAnuncio — a UP parent whose own id is member 0', () => {
  const paiUp = candidato({
    produtoId: RAIZ,
    linkDocId: 'linkFamilia',
    link: { id: ITEM, contaOuterRef: REF, isUserProductModel: true },
  });

  it('flags the stage-1 hit as a family member when it is one', async () => {
    // `familyId ?? itemIds[0]` — when ML omits `family_id` the parent's `id` IS
    // member 0's item id, and reporting that as a simple listing is the other
    // half of #1142.
    const p = porta([paiUp], membro({ produtoId: RAIZ, linkDocId: 'linkFamilia' }));

    const r = await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(r.achado && r.membro?.via).toBe('id-do-pai');
  });

  it('⛔ does not attach a member from ANOTHER family', async () => {
    // A different family holding the same item id is unreachable from here; the
    // parent this stage matched stays the answer.
    const p = porta([paiUp], membro({ produtoId: 'outraRaiz', linkDocId: 'outroLink' }));

    const r = await resolverLinkDoAnuncio(p, ITEM, CONTA);

    expect(r).toMatchObject({ achado: true, produtoId: RAIZ, membro: null });
  });
});

describe('resolverLinkDoAnuncio — the misses, which the message has to tell apart', () => {
  it('nothing anywhere → zero candidates, and that is a real finding', async () => {
    const p = porta([]);

    expect(await resolverLinkDoAnuncio(p, ITEM, CONTA)).toEqual({
      achado: false,
      candidatos: 0,
      deOutraConta: 0,
    });
  });

  it('⛔ counts links that exist but belong to another integração', async () => {
    // Same symptom, different problem: the anúncio IS known to the ERP, just not
    // on this conta. Reporting it as unknown sends an operator hunting a listing
    // that is perfectly well linked.
    const p = porta([
      candidato({ link: { id: ITEM, contaOuterRef: 'documents/integracao/outra' } }),
      candidato({ link: { id: ITEM, contaOuterRef: 'documents/integracao/terceira' } }),
    ]);

    expect(await resolverLinkDoAnuncio(p, ITEM, CONTA)).toEqual({
      achado: false,
      candidatos: 2,
      deOutraConta: 2,
    });
  });

  it('skips a candidate with no owning produto rather than returning it', async () => {
    // An orphaned collection-group ref has no `parent.parent`; returning it
    // would hand the caller a produto id of `null` to read.
    const p = porta([candidato({ produtoId: null })]);

    expect(await resolverLinkDoAnuncio(p, ITEM, CONTA)).toMatchObject({
      achado: false,
      candidatos: 1,
      deOutraConta: 0,
    });
  });

  it('falls through to the family query when stage 1 only had other contas', async () => {
    const p = porta(
      [candidato({ link: { id: ITEM, contaOuterRef: 'documents/integracao/outra' } })],
      membro(),
    );

    expect(await resolverLinkDoAnuncio(p, ITEM, CONTA)).toMatchObject({
      achado: true,
      produtoId: RAIZ,
    });
  });
});
