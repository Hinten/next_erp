import { describe, expect, it } from 'vitest';

import {
  categoriaAtributoSchema,
  reclamacaoEstadoSchema,
  categoriasSchema,
  contaSchema,
  jobsEmAndamentoSchema,
  massImportStatusSchema,
  medidaSugestaoSchema,
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

/** One `enviosPreco` entry exactly as `GET /jobs-em-andamento` now projects it. */
const PRICE_SYNC_ENTRY = {
  jobId: 'env-1',
  integracaoId: 'int-2',
  status: 'running',
  baixarPreco: false,
  planejados: 9,
  enviados: 3,
  pulados: 1,
  naoEnumerados: 1,
  falhas: 0,
  pausas: 0,
  skips: [],
  failures: [],
  startedAt: 1000,
  updatedAt: 2000,
  finishedAt: null,
  erro: null,
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

  it('⭐ fills an absent medida valueList with null, the fallback aiCellValue applies', () => {
    // `apps/mercado-livre` deploys BEFORE `apps/web`, so a browser running ahead
    // of that deploy sees no `valueList`. Required, it would fail the WHOLE
    // suggestion response and take the working half of the AI fill down with it.
    expect(
      medidaSugestaoSchema.parse({
        rowKey: 'g/1/v/p',
        attributeId: 'CHEST',
        value_id: null,
        value_name: '52',
      }).valueList,
    ).toBeNull();
  });

  it('⭐ fills an absent naoEnumerados with 0 instead of killing the WHOLE rail lookup', () => {
    // This one was not hypothetical. `GET /jobs-em-andamento` never sent
    // `naoEnumerados` — it arrived with #1072 on the `status` route and on this
    // schema, and the projection was missed — so a required field meant `call()`
    // threw `MercadoLivreClientRespostaInvalidaError` for EVERY lookup made
    // while any conta had a running price-sync job. The rail then rendered
    // "Não foi possível consultar os jobs em andamento" and the operator lost
    // the mass-import cards too. The route sends it now; this keeps a browser
    // running ahead of that deploy working.
    const { naoEnumerados: _drop, ...semNaoEnumerados } = PRICE_SYNC_ENTRY;

    const r = jobsEmAndamentoSchema.parse({
      importacoes: [],
      enviosPreco: [semNaoEnumerados],
    });

    expect(r.enviosPreco[0]!.naoEnumerados).toBe(0);
  });

  it('⚠️ still rejects a price entry missing a counter that has no default', () => {
    // The control for the case above: without it, `naoEnumerados: z.any()`
    // would pass that test just as happily.
    const { pulados: _drop, ...semPulados } = PRICE_SYNC_ENTRY;

    expect(() =>
      jobsEmAndamentoSchema.parse({ importacoes: [], enviosPreco: [semPulados] }),
    ).toThrow();
  });
});

describe('medidaSugestao.valueList — declared, or silently stripped', () => {
  it('⭐ KEEPS every member of a size-equivalence suggestion', () => {
    // ⚠️ The regression this exists for: a `z.object` strips unknown keys, so an
    // UNDECLARED `valueList` would stop arriving the day this endpoint moves
    // behind validation — with no error anywhere — and every size-equivalence
    // suggestion would collapse back to its first member. The mapping onto ML's
    // standard sizes IS the feature (their docs map one row onto 34/36/38/40),
    // so losing it silently is worse than losing the whole response.
    expect(
      medidaSugestaoSchema.parse({
        rowKey: 'g/1/v/p',
        attributeId: 'FILTRABLE_SIZE',
        value_id: '3189130',
        value_name: '34, 36, 38',
        valueList: [
          { id: '3189130', name: '34' },
          { id: '4608574', name: '36' },
          { id: '3259450', name: '38' },
        ],
      }).valueList,
    ).toHaveLength(3);
  });

  it('accepts an explicit null for a scalar column', () => {
    expect(
      medidaSugestaoSchema.parse({
        rowKey: 'g/1/v/p',
        attributeId: 'CHEST',
        value_id: null,
        value_name: '52',
        valueList: null,
      }).valueList,
    ).toBeNull();
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

  it('rejects a malformed valueList MEMBER, so the tolerant cases above mean something', () => {
    // `.nullable().default(null)` tolerates absent and null — it must not
    // tolerate a list of the wrong shape, or the two cases pinning the members
    // survive against `z.any()`.
    expect(
      medidaSugestaoSchema.safeParse({
        rowKey: 'g/1/v/p',
        attributeId: 'FILTRABLE_SIZE',
        value_id: null,
        value_name: '38',
        valueList: [{ id: '38' }],
      }).success,
    ).toBe(false);
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

describe('reclamacaoEstado — the WIRE names, not the stale interface ones', () => {
  const BASE = {
    claimId: 5_000_000_001,
    status: 'opened',
    stage: 'claim',
    tipo: 'mediations',
    reasonId: 'PNR',
    tipoReclamacao: 'PNR',
    acoesDisponiveis: [],
    prazos: [],
    expectativas: null,
    expectativasIndisponiveis: false,
    ofertasParciais: null,
  };

  it('⭐ accepts podeEnviarMensagem / motivoSemMensagem', async () => {
    // What `claimResolve.ts:209-210` actually puts on the wire. The interface
    // said `podeResponder` / `motivoSemResposta` — renamed on the backend in
    // dbe53a99 and never carried across — and the cast hid it, so
    // `ReclamacaoMlPanel` read `undefined` and ALWAYS showed the generic
    // "nenhuma ação" sentence instead of ML's real reason. A live bug on main.
    const r = reclamacaoEstadoSchema.parse({
      ...BASE,
      podeEnviarMensagem: false,
      motivoSemMensagem: 'Reclamação encerrada no Mercado Livre',
    });

    expect(r.motivoSemMensagem).toBe('Reclamação encerrada no Mercado Livre');
  });

  it('⚠️ REJECTS the stale interface names', async () => {
    // The guard. Without this the rename can drift back in silence exactly the
    // way it drifted out — the panel would simply stop showing the reason again.
    const r = reclamacaoEstadoSchema.safeParse({
      ...BASE,
      podeResponder: false,
      motivoSemResposta: 'algo',
    });

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('podeEnviarMensagem');
    expect(campos).toContain('motivoSemMensagem');
  });

  it('⚠️ REJECTS an absent acoesDisponiveis instead of defaulting it to []', async () => {
    // Its own doc says the list "empties as the claim closes", so a defaulted
    // `[]` would render "no actions available" identically to a claim ML never
    // answered for. `claimResolve.ts:207` always sends it; there is no evidence
    // for a default and nothing for one to rescue.
    const { acoesDisponiveis: _drop, ...sem } = BASE;
    const r = reclamacaoEstadoSchema.safeParse({
      ...sem,
      podeEnviarMensagem: true,
      motivoSemMensagem: null,
    });

    expect(r.success).toBe(false);
  });
});
