import { describe, expect, it } from 'vitest';

import {
  categoriaAtributoSchema,
  categoriasSchema,
  contaSchema,
  massImportStatusSchema,
  publicarResultSchema,
  usuarioTesteSchema,
  usuariosTesteResultSchema,
} from './wire';

/**
 * These schemas are declared in this PR and consumed in the next one, so nothing
 * here guards a live code path yet. What they guard is the set of DECISIONS the
 * schemas encode — each one is a place where a later "simplification" would take
 * a working screen down against a backend one deploy behind, which is the exact
 * failure the whole change exists to remove.
 *
 * ⚠️ Every "tolerates X" case below is worthless on its own: `z.any()` passes
 * all of them. The anti-vacuity control is the last describe block — if a
 * genuinely wrong body stops being rejected, these have stopped testing anything.
 */

const ATRIBUTO = {
  id: 'BRAND',
  name: 'Marca',
  valueType: 'string',
  values: [],
  hint: null,
  valueMaxLength: 60,
  defaultUnit: null,
  allowedUnits: [],
  groupId: null,
  groupName: null,
  required: true,
  multivalued: false,
  readOnly: false,
  relevance: 1,
};

const USUARIO = {
  role: 'comprador',
  docId: 'comprador-2',
  id: 2,
  nickname: 'TEST-comprador',
  password: 'qatest328',
  site_id: 'MLB',
  site_status: 'active',
  email: null,
  createdAt: 1_700_000_000_000,
  createdByUserId: 999,
  codigosVerificacaoEmail: { quatro: '0002', seis: '000002' },
};

describe('a field the deployed backend may not send yet', () => {
  it('⭐ accepts a publish result with no itemIds — a revision predating #798', () => {
    // `listingLinks.ts` reads `result.itemIds?.length ?? 1` and must still
    // produce the old single-item sentence. Requiring the field here would turn
    // that documented degrade into a thrown error on every publish.
    const r = publicarResultSchema.parse({
      itemId: 'MLB1',
      estado: 'p',
      permalink: null,
    });

    expect(r.itemIds).toBeUndefined();
    expect(r.orfaosEncerrados).toBeUndefined();
  });

  it('⭐ fills allowedUnits with [] rather than rejecting the attribute', () => {
    // `attributeForm.ts` already reads this as `attr.allowedUnits ?? []`
    // "despite the type saying otherwise" — a response predating the field would
    // otherwise blank the WHOLE attribute grid over a unit. That `??` is the
    // evidence; this is the assertion that the schema wrote it down.
    const { allowedUnits: _drop, ...semUnits } = ATRIBUTO;

    expect(categoriaAtributoSchema.parse(semUnits).allowedUnits).toEqual([]);
  });

  it('fills an absent categoria roots with null, the value the caller expects', () => {
    // `categoriaTree.ts:113` reads `data.roots ?? []`.
    expect(categoriasSchema.parse({ node: null }).roots).toBeNull();
  });
});

describe('usuarioTeste.docId — degrade, never refuse (#1302)', () => {
  it('⭐ maps an ABSENT docId to null instead of failing the read', () => {
    // Every deployment older than the field omits it, including one that already
    // mints correctly. Refusing here would destroy more than it protects: these
    // stored passwords are the only copy that exists — ML reissues none.
    const { docId: _drop, ...sem } = USUARIO;

    expect(usuarioTesteSchema.parse(sem).docId).toBeNull();
  });

  it('treats an empty string the same as absent', () => {
    // `doc ⟨empty⟩` renders identically to the bug that was fixed.
    expect(usuarioTesteSchema.parse({ ...USUARIO, docId: '' }).docId).toBeNull();
  });

  it('leaves a real doc id untouched', () => {
    // The control. A normaliser that flattened everything to null would pass
    // both assertions above and delete the feature.
    expect(usuarioTesteSchema.parse(USUARIO).docId).toBe('comprador-2');
  });
});

describe('credencialRevogada stays OPTIONAL, on purpose', () => {
  it('⚠️ accepts a mint result without it — the capability probe must keep working', () => {
    // Its ABSENCE is how `exigirMintAvulso` dates the backend, and that check
    // answers with a message naming the deploy to run. Making the field required
    // here moves the refusal into the schema and replaces that message with a
    // generic list of field names, sending the operator nowhere useful.
    const r = usuariosTesteResultSchema.parse({
      usuarios: [USUARIO],
      criados: [],
      reaproveitados: ['vendedor', 'comprador'],
      credenciaisRemovidas: 2,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    });

    expect(r.credencialRevogada).toBeUndefined();
  });

  it('keeps false as a real value, distinct from absent', () => {
    // `manterCredencial` makes `false` legitimate, and it is falsy — a probe
    // written as a truthiness check rather than `typeof` would reject exactly
    // the opt-out the panel offers.
    const r = usuariosTesteResultSchema.parse({
      usuarios: [USUARIO],
      criados: ['comprador'],
      reaproveitados: [],
      credenciaisRemovidas: 0,
      credencialRevogada: false,
      conta: { id: 999, nickname: 'LOJA-REAL' },
    });

    expect(r.credencialRevogada).toBe(false);
  });
});

describe('a NEWER backend must not break an older browser', () => {
  it('⭐ ignores keys this checkout has never heard of', () => {
    // The skew runs both ways. A strict object would make every forward deploy
    // an outage for anyone who had not reloaded the tab.
    const r = contaSchema.parse({
      connected: true,
      me: { id: 7, nickname: 'LOJA', email: null, campoNovoDoFuturo: 'x' },
      outroCampoNovo: [1, 2, 3],
    });

    expect(r.connected).toBe(true);
    expect(r.me?.nickname).toBe('LOJA');
  });
});

describe('numbers: tolerant where the value comes from ML, strict where we compute it', () => {
  it('⭐ accepts a QUOTED ML user id', () => {
    // #1087: one quoted `order_id` failed a `z.number().int()`, and because the
    // whole body is validated before any field is read it cost the entire
    // payment import. A forwarded id must never do that again.
    expect(
      contaSchema.parse({
        connected: true,
        me: { id: '2000018052464608', nickname: null, email: null },
      }).me?.id,
    ).toBe(2_000_018_052_464_608);
  });

  it('⚠️ REJECTS a quoted counter that this backend computed itself', () => {
    // The other half of the rule, and the reason it is not blanket tolerance: a
    // string here is our own serialisation bug and should be loud, not absorbed.
    const r = massImportStatusSchema.safeParse({
      status: 'running',
      scanned: '10',
      imported: 0,
      created: 0,
      skipped: 0,
      failureCount: 0,
      failures: [],
      startedAt: 1,
      finishedAt: null,
      erro: null,
    });

    expect(r.success).toBe(false);
  });
});

describe('⚠️ ANTI-VACUITY — a wrong body is still rejected', () => {
  // Without these, every "tolerates X" case above passes just as happily against
  // `z.any()`, and this file would be pinning nothing at all.
  it('rejects a missing REQUIRED field', () => {
    expect(publicarResultSchema.safeParse({ estado: 'p', permalink: null }).success).toBe(false);
  });

  it('rejects a field of the wrong type', () => {
    expect(contaSchema.safeParse({ connected: 'sim', me: null }).success).toBe(false);
  });

  it('rejects an unknown enum member', () => {
    expect(usuarioTesteSchema.safeParse({ ...USUARIO, role: 'admin' }).success).toBe(false);
  });

  it('rejects null where an object is required', () => {
    expect(categoriasSchema.safeParse(null).success).toBe(false);
  });

  it('names the offending field paths, which is what the operator error will carry', () => {
    // The message `call()` builds in the next PR is made of these paths, and
    // paths only — never values. A body is a live credential often enough
    // (`usuarioTeste.password`) that the rule has to hold everywhere.
    const r = usuarioTesteSchema.safeParse({ ...USUARIO, id: 'nao-e-numero', nickname: 42 });

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('id');
    expect(campos).toContain('nickname');
  });
});
