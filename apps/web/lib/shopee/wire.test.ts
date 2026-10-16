import { describe, expect, it } from 'vitest';

import {
  ESTADO_ANUNCIO_SHOPEE,
  PROBLEMA_TABELA_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  TIPO_CELULA_TABELA_SHOPEE,
  detalheTabelaMedidasDtoSchema as detalheCompartilhadoSchema,
  listaTabelasMedidasDtoSchema as listaCompartilhadaSchema,
  projetarTabelaShopee,
  tabelaMedidasLinhaDtoSchema as linhaCompartilhadaSchema,
  tabelaShopeeProjetadaSchema,
  type DetalheTabelaShopeeEntrada,
} from '@delfrance/schemas';

import { ShopeeClientRespostaInvalidaError, createShopeeClient } from './client';
import {
  ACAO_RECLAMACAO_SHOPEE,
  DETALHES_ERRO_SHOPEE_VAZIOS,
  SOLUCAO_DEVOLUCAO_SHOPEE,
  acaoReclamacaoShopeeSchema,
  anuncioStatusShopeeListingSchema,
  anuncioStatusShopeeSchema,
  canceladoShopeeSchema,
  categoriaNoDtoSchema,
  detalheTabelaMedidasDtoSchema,
  detalhesErroShopeeSchema,
  envioEstoqueManualShopeeSchema,
  envioPrecoManualShopeeSchema,
  jobIdShopeeSchema,
  listaTabelasMedidasDtoSchema,
  massImportStatusShopeeSchema,
  oauthStartResponseSchema,
  priceSyncHistoricoShopeeSchema,
  priceSyncRelatorioPaginaShopeeSchema,
  priceSyncStatusShopeeSchema,
  problemaShopeeSchema,
  respostaCategoriasShopeeSchema,
  respostaLimitesShopeeSchema,
  respostaPublicarShopeeSchema,
  respostaReverificarShopeeSchema,
  shopeeContaStatusSchema,
  shopeeEtiquetaPendenteSchema,
  shopeeLojaSchema,
  shopeeReclamacaoAcaoRespostaSchema,
  shopeeReclamacaoEstadoSchema,
  solucaoDevolucaoShopeeSchema,
  tabelaMedidasLinhaDtoSchema,
} from './wire';

/**
 * What these guard is the set of DECISIONS the schemas encode. Each one is a
 * place where a later "simplification" would take a working screen down against
 * a backend one deploy away from this browser, which is the failure the mirror
 * exists to make visible rather than silent.
 *
 * ⚠️ Every "tolerates X" case below is worthless on its own — `z.any()` passes
 * all of them. The controls are the NEAR-MISS assertions (a value one character
 * away from the tolerated one that must still be rejected) and the anti-vacuity
 * block at the end. If a genuinely wrong body stops being rejected, this file
 * has stopped testing anything.
 */

/** A connected conta exactly as `GET /conta` projects it. */
const CONTA = {
  connected: true,
  shopId: 123_456_789_012_345,
  mainAccountId: null,
  authTime: 1_756_000_000_000,
  expireTime: 1_787_536_000_000,
  diasParaExpirar: 365,
  loja: { shopName: 'Loja Teste', region: 'BR', status: 'NORMAL' },
  credencial: { expiraEm: 1_756_014_400_000, expirada: false, renovacaoFalhou: false },
};

describe('numbers: tolerant where the value passes THROUGH us, strict where we compute it', () => {
  it('⭐ accepts a QUOTED shopId — it reaches the wire through the SOFT parseRead', () => {
    // `shop_id` is denormalised onto the integração document and read back with
    // `parseRead`, which logs and returns the RAW document on a mismatch (rule
    // 8 read-tolerance). A legacy quoted id therefore reaches this browser
    // unchanged, and #1087 is what a strict `z.number()` costs when it does:
    // the whole body fails before any field is read.
    const r = shopeeContaStatusSchema.parse({ ...CONTA, shopId: '123456789012345' });

    expect(r.shopId).toBe(123_456_789_012_345);
  });

  it('the quoted and unquoted forms of the SAME id parse to the same value', () => {
    // The equal pair. Two spellings of one id must not produce two contas.
    const quoted = shopeeContaStatusSchema.parse({ ...CONTA, shopId: '123456789012345' });
    const bare = shopeeContaStatusSchema.parse({ ...CONTA, shopId: 123_456_789_012_345 });

    expect(quoted.shopId).toBe(bare.shopId);
  });

  it('accepts quoted mainAccountId / authTime / expireTime for the same reason', () => {
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      shopId: null,
      mainAccountId: '99',
      authTime: '1756000000000',
      expireTime: '1787536000000',
    });

    expect([r.mainAccountId, r.authTime, r.expireTime]).toEqual([
      99, 1_756_000_000_000, 1_787_536_000_000,
    ]);
  });

  it('⚠️ NEAR MISS — REJECTS a quoted diasParaExpirar, which this backend computed', () => {
    // The other half of the rule, and the reason the tolerance is not blanket.
    // `diasParaExpirar` is `Math.floor` arithmetic done in `apps/shopee`; a
    // string there is OUR serialisation bug and has to be loud. Deleting this
    // case would let a single `wireInt()` sweep pass unnoticed.
    const r = shopeeContaStatusSchema.safeParse({ ...CONTA, diasParaExpirar: '12' });

    expect(r.success).toBe(false);
  });

  it('⚠️ NEAR MISS — REJECTS a quoted credencial.expiraEm, ours as well', () => {
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      credencial: { expiraEm: '1756014400000', expirada: false, renovacaoFalhou: false },
    });

    expect(r.success).toBe(false);
  });

  it('⚠️ REJECTS a shopId that is not a number in any spelling', () => {
    // `wireInt()` reads exactly one decimal literal and hands anything else to
    // `z.number()` verbatim — it is not `z.coerce.number()`, which would read
    // `''` as 0 and invent a shop.
    for (const shopId of ['', 'abc', '0x1F', '1e3', {}, true]) {
      expect(shopeeContaStatusSchema.safeParse({ ...CONTA, shopId }).success).toBe(false);
    }
  });
});

describe('credencial.renovacaoFalhou — the field a NEWER browser reads off an OLDER backend', () => {
  it('⭐ defaults to false when the backend answering this browser predates the field', () => {
    // Rule 2's maintenance note, exercised: `apps/web` and `apps/shopee` deploy
    // separately, so a browser carrying this build routinely talks to a backend
    // that never heard of `renovacaoFalhou`. Required, it would blank the whole
    // conta screen for the length of that skew; defaulted, it reads as "no
    // failure known" and the panel shows the healthy copy until the backend
    // catches up.
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      credencial: { expiraEm: 1_756_014_400_000, expirada: true },
    });

    expect(r.credencial?.renovacaoFalhou).toBe(false);
  });

  it('⚠️ NEAR MISS — a backend that DOES send `true` keeps it', () => {
    // The control on the default. A `.catch(false)`, or a default applied over a
    // present value, would pass the case above and silently paint every dead
    // grant as healthy — which is the whole state this field exists to surface.
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      credencial: { expiraEm: 1_756_014_400_000, expirada: true, renovacaoFalhou: true },
    });

    expect(r.credencial?.renovacaoFalhou).toBe(true);
  });

  it('⚠️ REJECTS a non-boolean — the default covers ABSENT, never malformed', () => {
    // `.default()` fires on `undefined` only. A `'true'` here is our own
    // serialisation bug on the backend side and must be loud (rule 3), not
    // quietly folded to `false` — which would read as a healthy conta.
    for (const renovacaoFalhou of ['true', 1, null]) {
      const r = shopeeContaStatusSchema.safeParse({
        ...CONTA,
        credencial: { expiraEm: 1_756_014_400_000, expirada: true, renovacaoFalhou },
      });

      expect(r.success).toBe(false);
    }
  });
});

describe('loja.status — a widened enum degrades the BADGE, not the read', () => {
  it('⭐ maps an unknown lifecycle member to null and keeps the rest of the loja', () => {
    // Shopee documents three values today. A fourth must cost one badge, never
    // the conta panel — the `pagamento.ts` `.catch(null)` idiom.
    const r = shopeeContaStatusSchema.parse({
      ...CONTA,
      loja: { shopName: 'Loja Teste', region: 'BR', status: 'SUSPENDED' },
    });

    expect(r.loja?.status).toBeNull();
    expect(r.loja?.shopName).toBe('Loja Teste');
  });

  it('the three known members survive the catch', () => {
    // The control: a `.catch(null)` that swallowed everything would pass the
    // case above just as happily.
    for (const status of ['BANNED', 'FROZEN', 'NORMAL'] as const) {
      expect(shopeeLojaSchema.parse({ shopName: null, region: null, status }).status).toBe(status);
    }
  });

  it('⚠️ NEAR MISS — a malformed SIBLING still rejects the whole loja', () => {
    // The catch is scoped to `status` alone. Without this, widening it to the
    // object (or to `z.any()`) would leave every case above green.
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      loja: { shopName: 42, region: 'BR', status: 'NORMAL' },
    });

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('loja.shopName');
  });

  it('an ABSENT status key also degrades to null — a consequence of the catch, written down', () => {
    // Not a separate decision: `.catch` catches the missing-key failure too. It
    // is pinned so nobody discovers it by surprise, and it is the tolerant
    // direction anyway (rule 2's maintenance note).
    expect(shopeeLojaSchema.parse({ shopName: null, region: null }).status).toBeNull();
  });
});

describe('unknown keys pass — the browser is routinely older or newer than the backend', () => {
  it('keeps parsing when the backend grows a field this build never heard of', () => {
    // Nothing here is `.strict()`. A strict object would turn every forward
    // deploy of `apps/shopee` into an outage on this screen.
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      campoNovoDoFuturo: { qualquer: 'coisa' },
    });

    expect(r.success).toBe(true);
  });

  it('strips the unknown key rather than carrying it into the type', () => {
    const r = shopeeContaStatusSchema.parse({ ...CONTA, campoNovoDoFuturo: 1 });

    expect('campoNovoDoFuturo' in r).toBe(false);
  });
});

describe('the disconnected answer is a STATE, not a failure', () => {
  it('parses `CONTA_DESCONECTADA` — every key null except connected', () => {
    // The most common body this route serves. If it did not parse, a conta that
    // was never connected would render as an error.
    const r = shopeeContaStatusSchema.parse({
      connected: false,
      shopId: null,
      mainAccountId: null,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: null,
    });

    expect(r.connected).toBe(false);
    expect(r.credencial).toBeNull();
  });

  it('parses the REVOKED shape — disconnected, but both clocks still echoed', () => {
    const r = shopeeContaStatusSchema.parse({
      connected: false,
      shopId: 123,
      mainAccountId: null,
      authTime: null,
      expireTime: null,
      diasParaExpirar: null,
      loja: null,
      credencial: { expiraEm: 10, expirada: true, renovacaoFalhou: true },
    });

    expect(r.shopId).toBe(123);
    expect(r.credencial?.expirada).toBe(true);
  });
});

describe('oauthStartResponseSchema', () => {
  it('accepts a real consent URL', () => {
    const url =
      'https://partner.test-stable.shopeemobile.com/api/v2/shop/auth_partner?partner_id=1';

    expect(oauthStartResponseSchema.parse({ authorizeUrl: url }).authorizeUrl).toBe(url);
  });

  it('⭐ REJECTS an empty authorizeUrl — `location.assign("")` silently RELOADS', () => {
    // The near miss that matters here: `''` is a string, so a bare `z.string()`
    // would accept it and the operator would click "Conectar conta" and land
    // back on the same page with no error anywhere.
    expect(oauthStartResponseSchema.safeParse({ authorizeUrl: '' }).success).toBe(false);
  });
});

describe('⚠️ ANTI-VACUITY — a wrong body is still rejected', () => {
  // Without these, every "tolerates X" case above passes just as happily
  // against `z.any()`, and this file would be pinning nothing at all.
  it('rejects a MISSING connected — the field the panel switches on', () => {
    // `{}` cast to `ShopeeContaStatus` reads `connected === undefined`, which is
    // falsy: the screen would tell the operator to reconnect a live account.
    const { connected: _drop, ...sem } = CONTA;
    const r = shopeeContaStatusSchema.safeParse(sem);

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('connected');
  });

  it('rejects `connected: "sim"` — a boolean is not a truthy string', () => {
    expect(shopeeContaStatusSchema.safeParse({ ...CONTA, connected: 'sim' }).success).toBe(false);
  });

  it('rejects an ABSENT credencial — nullable is not optional', () => {
    // Rule 2: nothing here is optional today, because no return path omits it.
    // A defaulted `credencial` would make "no credential stored" and "the
    // backend forgot to send it" the same picture.
    const { credencial: _drop, ...sem } = CONTA;

    expect(shopeeContaStatusSchema.safeParse(sem).success).toBe(false);
  });

  it('rejects an ABSENT loja for the same reason', () => {
    const { loja: _drop, ...sem } = CONTA;

    expect(shopeeContaStatusSchema.safeParse(sem).success).toBe(false);
  });

  it('rejects null where the whole object is required', () => {
    expect(shopeeContaStatusSchema.safeParse(null).success).toBe(false);
  });

  it('names the offending field PATHS, which is what the operator error carries', () => {
    // `call()` builds its message out of these paths, and paths only — never
    // values. A response body is a live credential often enough that the rule
    // holds unconditionally (#1015).
    const r = shopeeContaStatusSchema.safeParse({
      ...CONTA,
      connected: 'sim',
      diasParaExpirar: '12',
    });

    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('connected');
    expect(campos).toContain('diasParaExpirar');
  });

  it('rejects a missing authorizeUrl', () => {
    expect(oauthStartResponseSchema.safeParse({}).success).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * The label 202 body (#1523, step 15) — the mirror of the backend's `EtiquetaPendente`
 * ------------------------------------------------------------------------- */

/**
 * The mirror rule (reconcile R-aa): every 202 variant the BACKEND's own tests
 * build, copied here as a literal and named by its source, must parse through
 * this browser's schema. A rename on either side then reds this block instead
 * of a label flow in production. Only the fixtures are copied — the sentences
 * are the backend's frozen `MENSAGEM_DA_FASE` / `MENSAGEM_ESCOLHER_ENVIO`.
 *
 * The sources: `route.test.ts` is `apps/shopee/app/api/marketplace/shopee/etiqueta/`;
 * `respostaEtiqueta.test.ts`, `etiquetaCli.test.ts` and `executarEtiqueta.test.ts`
 * are `apps/shopee/lib/shopee/etiqueta/`.
 */
/** `apps/shopee/app/api/marketplace/shopee/etiqueta/route.test.ts` `AGUARDAR`. */
const AGUARDAR: Record<string, unknown> = {
  acao: 'aguardar',
  fase: 'aguardando-rastreio',
  tentarEmMs: 5_000,
  mensagem: 'Envio organizado; aguardando o código de rastreio da transportadora.',
  progresso: { total: 1, organizados: 1, comRastreio: 0, prontos: 0 },
};

/** `apps/shopee/app/api/marketplace/shopee/etiqueta/route.test.ts` `ESCOLHER`. */
const ESCOLHER: Record<string, unknown> = {
  acao: 'escolher-envio',
  fase: 'programando',
  pacote: 'OFG000000000001',
  pacoteRotulo: null,
  mensagem:
    'Escolha como enviar o pacote: o endereço e o horário da coleta, ou a postagem na agência.',
  enderecos: [
    {
      id: '2001',
      rotulo: 'Rua do Vendedor, 100',
      principal: true,
      horarios: [{ id: 'slot-1', rotulo: '09:00', recomendado: true }],
    },
  ],
  permiteDropoff: true,
  escolhaInvalida: false,
  progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
};

/** `apps/shopee/app/api/marketplace/shopee/etiqueta/route.test.ts` — the `baixar-por-pacote` row. */
const BAIXAR: Record<string, unknown> = {
  acao: 'baixar-por-pacote',
  fase: 'baixando',
  pacotes: ['OFG000000000001', 'OFG000000000002'],
  mensagem: 'x',
  progresso: { total: 2, organizados: 2, comRastreio: 2, prontos: 2 },
};

/**
 * `apps/shopee/lib/shopee/etiqueta/executarEtiqueta.test.ts` — the three-package
 * poll whose budget ran out: that test pins `acao`, `fase` and `tentarEmMs: 0`
 * (`toMatchObject`); the sentence and the counts are filled in here.
 */
const AGUARDAR_SEM_ESPERA: Record<string, unknown> = {
  acao: 'aguardar',
  fase: 'aguardando-rastreio',
  tentarEmMs: 0,
  mensagem: 'Envio organizado; aguardando o código de rastreio da transportadora.',
  progresso: { total: 3, organizados: 3, comRastreio: 0, prontos: 0 },
};

/**
 * `apps/shopee/lib/shopee/etiqueta/executarEtiqueta.test.ts` "51 pacotes prontos
 * do mesmo canal ⇒ baixar-por-pacote com os 51, ZERO download" (review 1,
 * mutantes 60 e 61) — pinned WHOLE (`toStrictEqual`), its `prontos(51)` package
 * names and `MENSAGEM_BAIXAR_POR_PACOTE` included. Past Shopee's 50-package
 * download ceiling the backend asks for the per-package loop ON PURPOSE, so a
 * cap on `pacotes` here is a label that never prints (review 2, Q1-1).
 */
const BAIXAR_51: Record<string, unknown> = {
  acao: 'baixar-por-pacote',
  fase: 'baixando',
  pacotes: Array.from({ length: 51 }, (_, i) => `PACOTE-TESTE-${String(i).padStart(3, '0')}`),
  mensagem:
    'Os pacotes deste pedido vão por transportadoras diferentes; cada etiqueta é baixada separadamente.',
  progresso: { total: 51, organizados: 51, comRastreio: 51, prontos: 51 },
};

/**
 * `apps/shopee/lib/shopee/etiqueta/executarEtiqueta.test.ts` "a volta completa",
 * step 1 ("the question, ZERO ship") — the PICKUP-ONLY question: two addresses,
 * no dropoff on offer. That test pins `acao`, `fase`, `pacote`, `pacoteRotulo`,
 * `escolhaInvalida`, `permiteDropoff: false` and the address ids `2001`/`2002`
 * (`toMatchObject`); the sentence (`MENSAGEM_ESCOLHER_ENVIO`), the labels (as
 * `modoDeEnvio.ts` projects its `DOIS_ENDERECOS`) and the counts are filled in
 * here.
 */
const ESCOLHER_SO_COLETA: Record<string, unknown> = {
  acao: 'escolher-envio',
  fase: 'programando',
  pacote: 'OFG000000000001',
  pacoteRotulo: null,
  mensagem:
    'Escolha como enviar o pacote: o endereço e o horário da coleta, ou a postagem na agência.',
  enderecos: [
    {
      id: '2001',
      rotulo: 'Rua do Vendedor, 100',
      principal: false,
      horarios: [{ id: 'slot-1', rotulo: '21/09/2026 · 09:00', recomendado: false }],
    },
    {
      id: '2002',
      rotulo: 'Rua do Vendedor, 200',
      principal: false,
      horarios: [{ id: 'slot-2', rotulo: '21/09/2026 · 14:00', recomendado: false }],
    },
  ],
  permiteDropoff: false,
  escolhaInvalida: false,
  progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
};

/**
 * `apps/shopee/lib/shopee/etiqueta/etiquetaCli.test.ts` "uma resposta que a
 * Shopee não aceita é respondida UMA vez: a segunda pergunta encerra" — the
 * SECOND call, the RE-ASKED question (`escolhaInvalida: true`, an `enderecoId`
 * that matches no address). That test pins `tipo` and `escolhaInvalida: true`
 * on the call's summary; the rest is how `executarEtiqueta.ts`'s `'pergunta'`
 * arm projects it over that file's `DOIS_ENDERECOS` — `MENSAGEM_ESCOLHA_INVALIDA`
 * above all, the one sentence only this variant carries.
 */
const ESCOLHER_DE_NOVO: Record<string, unknown> = {
  ...ESCOLHER_SO_COLETA,
  mensagem:
    'A opção escolhida não está mais disponível na Shopee — escolha de novo como enviar o pacote.',
  enderecos: [
    {
      id: '2001',
      rotulo: 'Rua do Vendedor, 100, Cidade do Vendedor',
      principal: false,
      horarios: [{ id: 'slot-1', rotulo: '21/09/2026 · 09:00', recomendado: false }],
    },
    {
      id: '2002',
      rotulo: 'Rua do Vendedor, 200, Cidade do Vendedor',
      principal: false,
      horarios: [{ id: 'slot-2', rotulo: '21/09/2026 · 14:00', recomendado: false }],
    },
  ],
  escolhaInvalida: true,
};

const PENDENTES_DO_BACKEND: [string, Record<string, unknown>][] = [
  ['route.test.ts `AGUARDAR`', AGUARDAR],
  ['route.test.ts `ESCOLHER`', ESCOLHER],
  ['route.test.ts `baixar-por-pacote`', BAIXAR],
  [
    'respostaEtiqueta.test.ts `202 pendente` (a ZERO-SLOT address, "Pacote 1 de 2")',
    {
      acao: 'escolher-envio',
      fase: 'programando',
      pacote: 'OFG000000000001',
      pacoteRotulo: 'Pacote 1 de 2',
      mensagem: 'm',
      enderecos: [{ id: '2001', rotulo: 'Rua do Vendedor', principal: true, horarios: [] }],
      permiteDropoff: true,
      escolhaInvalida: false,
      progresso: { total: 1, organizados: 1, comRastreio: 0, prontos: 0 },
    },
  ],
  [
    'etiquetaCli.test.ts `R2-4 PAR` (NO address, dropoff only)',
    {
      acao: 'escolher-envio',
      fase: 'programando',
      pacote: 'OFG000000000002',
      pacoteRotulo: 'Pacote 2 de 2',
      mensagem: 'm',
      enderecos: [],
      permiteDropoff: true,
      escolhaInvalida: false,
      progresso: { total: 2, organizados: 1, comRastreio: 0, prontos: 0 },
    },
  ],
  ['executarEtiqueta.test.ts `tentarEmMs: 0` (the budget ran out mid-poll)', AGUARDAR_SEM_ESPERA],
  ['executarEtiqueta.test.ts `51 pacotes prontos` (past the 50-package download)', BAIXAR_51],
  [
    'executarEtiqueta.test.ts `a volta completa` step 1 (PICKUP ONLY, `permiteDropoff: false`)',
    ESCOLHER_SO_COLETA,
  ],
  [
    'etiquetaCli.test.ts `respondida UMA vez` call 2 (RE-ASKED, `escolhaInvalida: true`)',
    ESCOLHER_DE_NOVO,
  ],
];

describe('the label 202 — every variant the BACKEND builds parses here (R-aa)', () => {
  it.each(PENDENTES_DO_BACKEND)('%s', (_fonte, corpo) => {
    const r = shopeeEtiquetaPendenteSchema.safeParse(corpo);

    expect(r.success).toBe(true);
    // Value-for-value: the mirror neither drops nor rewrites a field the
    // backend sent (every literal carries `escolhaInvalida` when it applies).
    expect(r.data).toEqual(corpo);
  });

  it('exactly three members, and the three the backend has', () => {
    // A member dropped here reds the parse above; a member ADDED here without
    // a backend producing it is dead code nobody would notice.
    expect(shopeeEtiquetaPendenteSchema.options.map((o) => o.shape.acao.value).sort()).toEqual([
      'aguardar',
      'baixar-por-pacote',
      'escolher-envio',
    ]);
  });
});

describe('the label 202 — an unknown acao is REJECTED, an unknown key passes', () => {
  it('⭐ W17: REJECTS an acao this build does not know — it is never read as a wait', () => {
    // A new member is a question the caller would have to ANSWER. Folding it
    // into `aguardar` would poll a question nobody asks until the budget ran out.
    for (const acao of ['confirmar', 'ignorar', 'AGUARDAR', '']) {
      const r = shopeeEtiquetaPendenteSchema.safeParse({ ...AGUARDAR, acao });

      expect(r.success).toBe(false);
    }
  });

  it('⚠️ the removed 1-hour `confirmar` shape stays rejected, WHATEVER it carries', () => {
    // Appendix A deleted the member on both sides. A body shaped like its old
    // design (`pergunta`, `mensagem`) must not slip through another member.
    const r = shopeeEtiquetaPendenteSchema.safeParse({
      acao: 'confirmar',
      fase: 'programando',
      pergunta: 'menos-de-uma-hora',
      mensagem: 'm',
      progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
    });

    expect(r.success).toBe(false);
  });

  it('keeps parsing when a variant grows a key this build never heard of — and strips it', () => {
    const r = shopeeEtiquetaPendenteSchema.parse({ ...ESCOLHER, campoNovo: { a: 1 } });

    expect(r.acao).toBe('escolher-envio');
    expect('campoNovo' in r).toBe(false);
  });

  it('a phase this build never heard of passes — `fase` is a free string', () => {
    // The browser shows the backend's own `mensagem` and only compares two
    // phases for equality; an enum would kill the flow on a forward deploy.
    const r = shopeeEtiquetaPendenteSchema.parse({
      ...AGUARDAR,
      fase: 'fase-do-futuro',
    });

    expect(r.fase).toBe('fase-do-futuro');
  });

  it('⚠️ NEAR MISS — an EMPTY fase is rejected (the free string is not blanket)', () => {
    expect(shopeeEtiquetaPendenteSchema.safeParse({ ...AGUARDAR, fase: '' }).success).toBe(false);
  });
});

describe('the label 202 — `progresso` is REQUIRED on every member', () => {
  it.each(PENDENTES_DO_BACKEND)('rejects %s WITHOUT progresso', (_fonte, corpo) => {
    // It is what makes the give-up message deterministic; no deployed backend
    // omits it, so a default would only hide our own bug.
    const { progresso: _drop, ...sem } = corpo;
    const r = shopeeEtiquetaPendenteSchema.safeParse(sem);

    expect(r.success).toBe(false);
  });

  it('⚠️ rejects a QUOTED or negative count — the backend computed it (rule 3)', () => {
    for (const total of ['1', -1, 1.5]) {
      const r = shopeeEtiquetaPendenteSchema.safeParse({
        ...AGUARDAR,
        progresso: { total, organizados: 0, comRastreio: 0, prontos: 0 },
      });

      expect(r.success).toBe(false);
    }
  });
});

describe('the label 202 — `escolhaInvalida` defaults to false, and only when ABSENT', () => {
  it('⭐ an absent escolhaInvalida reads as false', () => {
    const { escolhaInvalida: _drop, ...sem } = ESCOLHER;
    const r = shopeeEtiquetaPendenteSchema.parse(sem);

    expect(r.acao === 'escolher-envio' ? r.escolhaInvalida : null).toBe(false);
  });

  it('⚠️ NEAR MISS — a backend that sends `true` keeps it (the re-asked question)', () => {
    const r = shopeeEtiquetaPendenteSchema.parse({ ...ESCOLHER, escolhaInvalida: true });

    expect(r.acao === 'escolher-envio' ? r.escolhaInvalida : null).toBe(true);
  });

  it('⚠️ REJECTS a non-boolean — the default covers ABSENT, never malformed', () => {
    for (const escolhaInvalida of ['true', 1, null]) {
      expect(shopeeEtiquetaPendenteSchema.safeParse({ ...ESCOLHER, escolhaInvalida }).success).toBe(
        false,
      );
    }
  });
});

describe('the label 202 — a question must be answerable', () => {
  it('⭐ NO address is legal only WITH the dropoff on offer', () => {
    const semEndereco = { ...ESCOLHER, enderecos: [] };

    expect(
      shopeeEtiquetaPendenteSchema.safeParse({ ...semEndereco, permiteDropoff: true }).success,
    ).toBe(true);
    const r = shopeeEtiquetaPendenteSchema.safeParse({ ...semEndereco, permiteDropoff: false });
    expect(r.success).toBe(false);
    const campos = r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    expect(campos).toContain('enderecos');
  });

  it('an address WITHOUT the dropoff is a question too — the pickup-only offer', () => {
    // The near miss of the refine: it gates the EMPTY list, never the dropoff.
    expect(
      shopeeEtiquetaPendenteSchema.safeParse({ ...ESCOLHER, permiteDropoff: false }).success,
    ).toBe(true);
  });

  it('⚠️ REJECTS a numeric address id — ids are opaque STRINGS on this wire', () => {
    // The backend `String()`s Shopee's int64 `address_id`; a number here is our
    // own serialisation bug, and a browser that echoed it back as a number
    // would be refused by the route's strict `envio` reader.
    const r = shopeeEtiquetaPendenteSchema.safeParse({
      ...ESCOLHER,
      enderecos: [{ id: 2001, rotulo: 'Rua', principal: true, horarios: [] }],
    });

    expect(r.success).toBe(false);
  });

  it('⚠️ REJECTS an empty pacote — it is echoed back in `envio.pacote`', () => {
    expect(shopeeEtiquetaPendenteSchema.safeParse({ ...ESCOLHER, pacote: '' }).success).toBe(false);
  });
});

describe('the label 202 — `baixar-por-pacote` lists 2 or more packages, with NO upper bound', () => {
  const pacotes = (n: number) =>
    Array.from({ length: n }, (_, i) => `OFG${String(i + 1).padStart(12, '0')}`);
  const baixar = (lista: string[]) => ({ ...BAIXAR, pacotes: lista });

  it('accepts the lower bound, 50, and ⭐ 51 — past Shopee’s download ceiling, the backend asks for THIS loop', () => {
    // Q1-1: 50 is Shopee's cap on ONE download, which is WHY the backend sends
    // the per-package loop for 51 (the `BAIXAR_51` mirror row above). A cap
    // here turned that body into "faça o deploy de apps/shopee" on every click.
    for (const n of [2, 50, 51, 120]) {
      expect(shopeeEtiquetaPendenteSchema.safeParse(baixar(pacotes(n))).success).toBe(true);
    }
  });

  it('⚠️ NEAR MISS — rejects one package (not a split) and none', () => {
    expect(shopeeEtiquetaPendenteSchema.safeParse(baixar(pacotes(1))).success).toBe(false);
    expect(shopeeEtiquetaPendenteSchema.safeParse(baixar([])).success).toBe(false);
  });

  it('⚠️ NEAR MISS — rejects an EMPTY package number anywhere in a long list', () => {
    // The dropped cap is not blanket tolerance: each entry is still echoed
    // back as `pacote` on its own call.
    const lista = pacotes(51);
    lista[50] = '';
    expect(shopeeEtiquetaPendenteSchema.safeParse(baixar(lista)).success).toBe(false);
  });
});

describe('the label 202 — `tentarEmMs`', () => {
  it('accepts 0 — the CALLER clamps the wait, never the schema (W10 lives in the provider)', () => {
    expect(AGUARDAR_SEM_ESPERA).toMatchObject({ tentarEmMs: 0 });
    expect(shopeeEtiquetaPendenteSchema.safeParse(AGUARDAR_SEM_ESPERA).success).toBe(true);
  });

  it('⚠️ REJECTS a negative or QUOTED wait — ours, hence strict', () => {
    for (const tentarEmMs of [-1, '5000', null]) {
      expect(shopeeEtiquetaPendenteSchema.safeParse({ ...AGUARDAR, tentarEmMs }).success).toBe(
        false,
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * Returns (#1525, step 17) — `GET …/reclamacao/estado`, `POST …/reclamacao/acao`
 * ------------------------------------------------------------------------- */

/** A REQUESTED return the backend lists `confirmar` on — fixture ids only. */
const ESTADO = {
  returnSn: '260910ABCDE0001',
  orderSn: '260910KJBHUJDM',
  pedidoId: 'pedido-1',
  status: 'REQUESTED',
  terminal: false,
  solucao: 'REFUND',
  motivo: 'ITEM_DAMAGED',
  motivoReavaliado: null,
  valorReembolso: 89.9,
  valorAntesDesconto: 99.9,
  moeda: 'BRL',
  tipoRequisicao: 0,
  tipoValidacao: 'seller_validation',
  negociacao: {
    status: 'PENDING_RESPOND',
    solucaoOfertada: 'RETURN_REFUND',
    valorOfertado: 50,
    contrapropostasRestantes: 2,
  },
  prova: { status: 'NOT_NEEDED' },
  compensacao: null,
  prazos: [
    { tipo: 'resposta-vendedor', prazoMs: 1_790_000_000_000, reembolsoAutomatico: true },
    { tipo: 'proposta', prazoMs: 1_790_100_000_000, reembolsoAutomatico: false },
  ],
  solucoes: [{ solucao: 'REFUND', ajustavel: true, minimo: 10, maximo: 89.9 }],
  acoesDisponiveis: ['confirmar', 'ofertar', 'aceitar-oferta'],
  motivoSemAcao: null,
  pendenciasForaDoErp: ['contestar'],
};

const parseEstado = (body: unknown) => shopeeReclamacaoEstadoSchema.safeParse(body);

describe('the returns estado — every Shopee token is a FREE string', () => {
  it('parses the estado the backend builds — the control', () => {
    const r = parseEstado(ESTADO);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(ESTADO);
  });

  it('⭐ an UNKNOWN status, reason, sub-status or validation type passes — the label shows it raw', () => {
    const r = parseEstado({
      ...ESTADO,
      status: 'SOME_NEW_STATUS',
      motivo: 'SOME_NEW_REASON',
      motivoReavaliado: 'OTHER_NEW',
      tipoValidacao: 'drone_validation',
      negociacao: { ...ESTADO.negociacao, status: 'PENDING_SHOPEE' },
      prova: { status: 'UNDER_REVIEW' },
      compensacao: { status: 'COMPENSATION_SOMETHING', valor: 3 },
    });
    expect(r.success).toBe(true);
  });

  it('⭐ an UNKNOWN action, deadline or Seller-Centre code passes — a badge, never a dead panel', () => {
    const r = parseEstado({
      ...ESTADO,
      acoesDisponiveis: ['contestar-no-erp'],
      prazos: [{ tipo: 'prazo-novo', prazoMs: 1_790_000_000_000, reembolsoAutomatico: false }],
      pendenciasForaDoErp: ['algo-novo'],
    });
    expect(r.success).toBe(true);
  });

  it('unknown KEYS pass, top level and nested (rule 1)', () => {
    const r = parseEstado({
      ...ESTADO,
      campoNovo: 1,
      negociacao: { ...ESTADO.negociacao, autor: 'comprador' },
      solucoes: [{ ...ESTADO.solucoes[0], moeda: 'BRL' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('the returns estado — Shopee numbers are tolerant, our flags are not', () => {
  it('⭐ a QUOTED amount, deadline, request type or count is read (wireNumber / wireInt)', () => {
    const r = parseEstado({
      ...ESTADO,
      valorReembolso: '12.34',
      valorAntesDesconto: '20',
      tipoRequisicao: '1',
      negociacao: { ...ESTADO.negociacao, valorOfertado: '5.5', contrapropostasRestantes: '0' },
      prazos: [{ tipo: 'final-vendedor', prazoMs: '1790000000000', reembolsoAutomatico: true }],
      solucoes: [{ solucao: 'REFUND', ajustavel: true, minimo: '1.5', maximo: '89.90' }],
    });
    expect(r.success).toBe(true);
    expect(r.data?.valorReembolso).toBe(12.34);
    expect(r.data?.tipoRequisicao).toBe(1);
    expect(r.data?.prazos[0]?.prazoMs).toBe(1_790_000_000_000);
    expect(r.data?.solucoes[0]?.maximo).toBe(89.9);
  });

  it('NEAR MISS: a non-numeric amount, a fractional deadline or a quoted boolean is REJECTED', () => {
    expect(parseEstado({ ...ESTADO, valorReembolso: 'doze' }).success).toBe(false);
    expect(
      parseEstado({
        ...ESTADO,
        prazos: [{ tipo: 'proposta', prazoMs: 1.5, reembolsoAutomatico: false }],
      }).success,
    ).toBe(false);
    expect(parseEstado({ ...ESTADO, terminal: 'false' }).success).toBe(false);
    expect(
      parseEstado({
        ...ESTADO,
        solucoes: [{ solucao: 'REFUND', ajustavel: 'true', minimo: null, maximo: null }],
      }).success,
    ).toBe(false);
  });
});

describe('the returns estado — the four arrays carry NO default (W10)', () => {
  it.each(['acoesDisponiveis', 'prazos', 'solucoes', 'pendenciasForaDoErp'] as const)(
    '⭐ an ABSENT `%s` FAILS the parse — never read as "nothing"',
    (campo) => {
      const { [campo]: _omitido, ...semCampo } = ESTADO;
      const r = parseEstado(semCampo);
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join('.'))).toContain(campo);
    },
  );

  it('NEAR MISS: an EMPTY array is a real answer and parses as empty', () => {
    const r = parseEstado({
      ...ESTADO,
      acoesDisponiveis: [],
      prazos: [],
      solucoes: [],
      pendenciasForaDoErp: [],
      motivoSemAcao: 'A devolução está em análise pela Shopee.',
    });
    expect(r.success).toBe(true);
    expect(r.data?.acoesDisponiveis).toEqual([]);
  });

  it('`null` is not an array either — refused', () => {
    expect(parseEstado({ ...ESTADO, acoesDisponiveis: null }).success).toBe(false);
  });
});

describe('the returns estado — the solução is the one CLOSED enum (the browser sends it back)', () => {
  it('accepts both members and null where nullable', () => {
    for (const solucao of [SOLUCAO_DEVOLUCAO_SHOPEE.devolucaoEReembolso, 'REFUND', null]) {
      expect(parseEstado({ ...ESTADO, solucao }).success).toBe(true);
    }
    expect(solucaoDevolucaoShopeeSchema.options).toEqual(['RETURN_REFUND', 'REFUND']);
  });

  it('NEAR MISS: Shopee’s int encoding, a lower-cased member or an unknown one is REJECTED', () => {
    for (const solucao of [0, 1, '0', 'refund', 'RETURN_AND_REFUND']) {
      expect(parseEstado({ ...ESTADO, solucao }).success).toBe(false);
      expect(
        parseEstado({ ...ESTADO, negociacao: { ...ESTADO.negociacao, solucaoOfertada: solucao } })
          .success,
      ).toBe(false);
      expect(
        parseEstado({
          ...ESTADO,
          solucoes: [{ solucao, ajustavel: false, minimo: null, maximo: null }],
        }).success,
      ).toBe(false);
    }
  });

  it('the companion constants agree with the enums (prefer-schema-enum)', () => {
    expect(Object.values(SOLUCAO_DEVOLUCAO_SHOPEE).sort()).toEqual(
      [...solucaoDevolucaoShopeeSchema.options].sort(),
    );
    expect(Object.values(ACAO_RECLAMACAO_SHOPEE).sort()).toEqual(
      [...acaoReclamacaoShopeeSchema.options].sort(),
    );
  });
});

describe('the returns estado — ANTI-VACUITY', () => {
  it.each([
    ['returnSn', ''],
    ['pedidoId', ''],
    ['status', ''],
    ['status', null],
    ['terminal', null],
    ['negociacao', 'nenhuma'],
    ['prazos', [{ tipo: '', prazoMs: 1, reembolsoAutomatico: true }]],
    ['acoesDisponiveis', [1]],
  ] as const)('rejects `%s` = %j', (campo, valor) => {
    expect(parseEstado({ ...ESTADO, [campo]: valor }).success).toBe(false);
  });
});

describe('the acao answer', () => {
  const RESPOSTA = { ok: true, acao: 'confirmar', returnSn: '260910ABCDE0001' };

  it('parses with and without `atualizacao`', () => {
    expect(
      shopeeReclamacaoAcaoRespostaSchema.parse({ ...RESPOSTA, atualizacao: 'nao-enfileirada' }),
    ).toEqual({ ...RESPOSTA, atualizacao: 'nao-enfileirada' });
    expect(shopeeReclamacaoAcaoRespostaSchema.parse(RESPOSTA).atualizacao).toBeUndefined();
  });

  it('an unknown `atualizacao` degrades to "not said" — never a failure after an irreversible action', () => {
    expect(
      shopeeReclamacaoAcaoRespostaSchema.parse({ ...RESPOSTA, atualizacao: 'adiada' }).atualizacao,
    ).toBeUndefined();
  });

  it('⭐ NEAR MISS: `ok: false` (or absent) is a contract breach, never a success', () => {
    expect(shopeeReclamacaoAcaoRespostaSchema.safeParse({ ...RESPOSTA, ok: false }).success).toBe(
      false,
    );
    const { ok: _ok, ...semOk } = RESPOSTA;
    expect(shopeeReclamacaoAcaoRespostaSchema.safeParse(semOk).success).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Size charts (#1526, step 18)
 * ------------------------------------------------------------------------- */

/** One category row exactly as `taxonomia/dto.ts`'s `projetarCategoria` builds it. */
const CATEGORIA = { categoryId: 100087, name: 'Camisetas', originalName: 'T-shirts', isLeaf: true };
const RAIZ = { categoryId: 100017, name: 'Moda Feminina', originalName: null, isLeaf: false };

describe('the categorias answer', () => {
  it('parses the ROOTS answer and the NODE answer — the control', () => {
    expect(respostaCategoriasShopeeSchema.parse({ raizes: [RAIZ], no: null })).toEqual({
      raizes: [RAIZ],
      no: null,
    });
    const no = { ...CATEGORIA, parentId: 100017, pathFromRoot: [RAIZ, CATEGORIA], children: [] };
    expect(respostaCategoriasShopeeSchema.parse({ raizes: null, no })).toEqual({
      raizes: null,
      no,
    });
  });

  it('`parentId: 0` (a root) is a value, never an absence', () => {
    const no = { ...RAIZ, parentId: 0, pathFromRoot: [RAIZ], children: [CATEGORIA] };
    expect(categoriaNoDtoSchema.parse(no).parentId).toBe(0);
  });

  it('⭐ a body with NEITHER half is refused — an empty picker would look like a tree with nothing in it', () => {
    expect(respostaCategoriasShopeeSchema.safeParse({ raizes: null, no: null }).success).toBe(
      false,
    );
  });

  it('NEAR-MISS: an EMPTY roots list is still an answer', () => {
    expect(respostaCategoriasShopeeSchema.safeParse({ raizes: [], no: null }).success).toBe(true);
  });

  it('rule 3: a quoted category id is OUR serialisation bug — refused, never folded', () => {
    expect(
      respostaCategoriasShopeeSchema.safeParse({
        raizes: [{ ...RAIZ, categoryId: '100017' }],
        no: null,
      }).success,
    ).toBe(false);
  });

  it('rule 1: an unknown key is stripped, never fatal', () => {
    const r = respostaCategoriasShopeeSchema.parse({
      raizes: [{ ...RAIZ, novo: 1 }],
      no: null,
      extra: true,
    });
    expect(r).toEqual({ raizes: [RAIZ], no: null });
  });
});

describe('the limites answer — only the size-chart slice', () => {
  /** A whole `taxonomia/limites` 200, other bands included, as the route answers it. */
  const LIMITES = {
    scope: 'category',
    categoryId: 100087,
    limites: {
      priceLimit: { min: 1, max: 100_000 },
      dtsLimit: { daysToShipLimit: { min: -1, max: 30 }, nonPreOrderDaysToShip: 2 },
      weightLimit: { weightMandatory: true },
      sizeChartLimit: {
        sizeChartMandatory: true,
        supportImageSizeChart: false,
        supportTemplateSizeChart: null,
      },
    },
    gtinLimit: null,
    supportsPreOrder: true,
  };

  it('keeps the size-chart flags — three-valued — and strips every other band', () => {
    expect(respostaLimitesShopeeSchema.parse(LIMITES)).toEqual({
      scope: 'category',
      categoryId: 100087,
      limites: {
        sizeChartLimit: {
          sizeChartMandatory: true,
          supportImageSizeChart: false,
          supportTemplateSizeChart: null,
        },
      },
    });
  });

  it('a band this browser never reads cannot cost the screen — even a malformed one', () => {
    const r = respostaLimitesShopeeSchema.safeParse({
      ...LIMITES,
      limites: { ...LIMITES.limites, priceLimit: 'quebrado' },
    });
    expect(r.success).toBe(true);
  });

  it('`sizeChartLimit: null` (Shopee sent none) parses; a shop-wide answer has `categoryId: null`', () => {
    const r = respostaLimitesShopeeSchema.parse({
      scope: 'shop',
      categoryId: null,
      limites: { sizeChartLimit: null },
    });
    expect(r.limites.sizeChartLimit).toBeNull();
    expect(r.categoryId).toBeNull();
  });

  it.each([
    ['a missing sizeChartLimit (rule 2)', { scope: 'category', categoryId: 1, limites: {} }],
    [
      'a quoted boolean',
      {
        scope: 'category',
        categoryId: 1,
        limites: {
          sizeChartLimit: {
            sizeChartMandatory: 'true',
            supportImageSizeChart: null,
            supportTemplateSizeChart: null,
          },
        },
      },
    ],
  ])('NEAR-MISS: %s is refused', (_nome, corpo) => {
    expect(respostaLimitesShopeeSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('the tabela-medidas lista answer', () => {
  const LISTA = {
    leaf: true,
    categoryId: 100087,
    tabelas: [
      { sizeChartId: 700024641, sizeChartName: 'Tabela Básica', legivel: true },
      { sizeChartId: 700024613, sizeChartName: null, legivel: false },
    ],
    totalCount: 3,
    truncado: false,
    removidas: 1,
    idsIlegiveis: 0,
  };

  it('⭐ ONE declaration: the browser’s lista/detalhe schemas ARE `@delfrance/schemas`’ — the objects the apps/shopee routes build against', () => {
    expect(listaTabelasMedidasDtoSchema).toBe(listaCompartilhadaSchema);
    expect(tabelaMedidasLinhaDtoSchema).toBe(linhaCompartilhadaSchema);
    expect(detalheTabelaMedidasDtoSchema).toBe(detalheCompartilhadoSchema);
  });

  it('parses a leaf answer and a non-leaf one — the control', () => {
    expect(listaTabelasMedidasDtoSchema.parse(LISTA)).toEqual(LISTA);
    const naoFolha = {
      leaf: false,
      categoryId: 100017,
      tabelas: [],
      totalCount: null,
      truncado: false,
      removidas: 0,
      idsIlegiveis: 0,
    };
    expect(listaTabelasMedidasDtoSchema.parse(naoFolha)).toEqual(naoFolha);
  });

  it.each([
    ['truncado', undefined],
    ['removidas', undefined],
    ['tabelas', undefined],
  ])('rule 2: a missing `%s` is refused — never read as "complete" / "none"', (campo, valor) => {
    expect(listaTabelasMedidasDtoSchema.safeParse({ ...LISTA, [campo]: valor }).success).toBe(
      false,
    );
  });

  it('rule 3: a quoted sizeChartId is refused', () => {
    const corpo = { ...LISTA, tabelas: [{ ...LISTA.tabelas[0], sizeChartId: '700024641' }] };
    expect(listaTabelasMedidasDtoSchema.safeParse(corpo).success).toBe(false);
  });
});

/**
 * Shopee's own `get_size_chart_detail` page sample (`testtestt`, 3×3, id
 * 700024639) — the `response` payload, verbatim. Inline because `apps/web`
 * cannot reach `apps/shopee`'s `__wire__` corpus.
 */
const DETALHE_DOC: DetalheTabelaShopeeEntrada = {
  size_chart_id: 700024639,
  size_chart_name: 'testtestt',
  size_chart_table: {
    column_list: [
      {
        measurement: {
          display_name: 'test single input number',
          input_type: 'Input Single Number',
          unit: 'cm',
        },
        measurement_value_list: [1, 2, 3].map((value) => ({
          max_value: null,
          min_value: null,
          option: null,
          value,
        })),
      },
      {
        measurement: {
          display_name: 'susu_input_range_number_with_special_unit_kg',
          input_type: 'Input Range Number',
          unit: 'kg',
        },
        measurement_value_list: [
          [12, 13],
          [13, 14],
          [14, 16],
        ].map(([min_value, max_value]) => ({
          max_value: max_value ?? null,
          min_value: min_value ?? null,
          option: null,
          value: null,
        })),
      },
      {
        measurement: {
          display_name: 'regional 001 dropdowm',
          input_type: 'Single Dropdown',
          unit: 'cm',
        },
        measurement_value_list: ['01s', '01m', '01l'].map((option) => ({
          max_value: null,
          min_value: null,
          option,
          value: null,
        })),
      },
    ],
  },
};

describe('the tabela-medidas detalhe answer — ONE schema for the chart', () => {
  it('⭐ the inner table IS `@delfrance/schemas`’ schema — no third declaration of the projector output', () => {
    expect(detalheTabelaMedidasDtoSchema.shape.tabela).toBe(tabelaShopeeProjetadaSchema);
  });

  it('⭐ RT7 (server half): the real projector’s output, through JSON, parses back EQUAL — 3×3, no problems', () => {
    const tabela = projetarTabelaShopee(700024639, DETALHE_DOC);

    const lido = detalheTabelaMedidasDtoSchema.parse(JSON.parse(JSON.stringify({ tabela })));

    expect(lido).toEqual({ tabela });
    expect(lido.tabela.sizeChartId).toBe(700024639);
    expect(lido.tabela.problemas).toEqual([]);
    expect(lido.tabela.linhas).toHaveLength(3);
    expect(lido.tabela.linhas?.[0]?.map((c) => c.tipo)).toEqual([
      TIPO_CELULA_TABELA_SHOPEE.numero,
      TIPO_CELULA_TABELA_SHOPEE.faixa,
      TIPO_CELULA_TABELA_SHOPEE.opcao,
    ]);
  });

  it('the doc sample asked under a LIST id reads exactly one `id-divergente` — Shopee’s two samples show different charts', () => {
    const { problemas } = detalheTabelaMedidasDtoSchema.parse({
      tabela: projetarTabelaShopee(700024641, DETALHE_DOC),
    }).tabela;

    expect(problemas.map((p) => p.codigo)).toEqual([PROBLEMA_TABELA_SHOPEE.idDivergente]);
  });

  it('R-b: a NEWER backend’s unknown `tipo` / `codigo` still parses (rendered generically)', () => {
    const tabela = projetarTabelaShopee(700024639, DETALHE_DOC);
    const novo = {
      ...tabela,
      colunas: tabela.colunas.map((c) => ({
        ...c,
        celulas: c.celulas.map((cel) => ({ ...cel, tipo: 'tipo-novo' })),
      })),
      problemas: [
        {
          codigo: 'problema-novo',
          coluna: null,
          linha: null,
          inputType: null,
          comprimentos: null,
          pedido: null,
          recebido: null,
        },
      ],
    };
    expect(detalheTabelaMedidasDtoSchema.safeParse({ tabela: novo }).success).toBe(true);
  });

  it('NEAR-MISS: a problem missing one of its seven keys is refused; so is a body with no `tabela`', () => {
    const tabela = projetarTabelaShopee(700024641, DETALHE_DOC);
    const [problema] = tabela.problemas;
    expect(problema).toBeDefined();
    const { recebido: _recebido, ...semRecebido } = problema ?? { recebido: null };
    expect(
      detalheTabelaMedidasDtoSchema.safeParse({ tabela: { ...tabela, problemas: [semRecebido] } })
        .success,
    ).toBe(false);
    expect(detalheTabelaMedidasDtoSchema.safeParse(tabela).success).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Step 21 (#1529, sub-step 21-1) — the pushes, publish, re-verify, the jobs and
 * the error extras
 * ------------------------------------------------------------------------- */

// Fixture ids only: integração `int-1`, produtos `prod-1`/`prod-2`, link
// `link-1`, item 1000001, job `job-1`. Each body below carries EVERY key its
// route builds by name (`apps/shopee/app/api/marketplace/shopee/<route>/route.ts`),
// the stripped ones included — the parse is checked against the real envelope.

/** A price-push row as `enviar-precos/route.ts` builds it (its `CHAVES_DA_LISTAGEM_PRECO`). */
const LINHA_PRECO = {
  produtoId: 'prod-1',
  produtoNome: 'Camiseta',
  variacaoProdutoId: 'prod-2',
  anuncioId: '1000001',
  linkDocId: 'link-1',
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Preço enviado.',
  preco: 99.9,
  precoAnterior: 89.9,
  variacoes: null,
  codigo: null,
};

const ENVELOPE_PRECO = {
  canal: 'shopee',
  integracaoId: 'int-1',
  contaNome: 'Conta Teste',
  solicitados: 1,
  familias: 1,
  resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [LINHA_PRECO],
  produtosSemEnvio: [],
  pausadoAte: null,
};

const LINHA_STATUS = {
  produtoId: 'prod-1',
  produtoNome: 'Camiseta',
  anuncioId: '1000001',
  linkDocId: 'link-1',
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Anúncio pausado.',
  statusFinal: 'UNLIST',
  estadoAnuncio: 'pausado',
  membros: null,
};

/** The item 200 as `publicar/route.ts`'s `corpoDoItem` builds it. */
const ITEM_200 = {
  itemId: 1000001,
  estadoAnuncio: 'ativo',
  itemStatus: 'NORMAL',
  modelos: { total: 2, criados: 0, atualizados: 2, semFilho: 0 },
  fotos: { reutilizadas: 3, enviadas: 0, falhas: 0 },
  avisoShopee: null,
  taxInfoOmitido: null,
  tabelaDeMedidas: {
    sizeChartId: 700024641,
    fonte: 'modelo',
    motivo: null,
    fotoOmitida: null,
    avisoObrigatoria: false,
  },
};

/** The kit 202 as `publicar/route.ts` builds it: `corpoDoKit` + `mensagem` (+ `aguardarMs` once PR 5 lands). */
const KIT_202 = {
  arma: 'kit-recriar',
  desfecho: 'incerto',
  itemId: null,
  linkDocId: null,
  estadoAnuncio: null,
  itemStatus: null,
  kitNativo: null,
  modelos: { vinculados: 0, anexados: 0, semFilho: 0 },
  antecessor: null,
  avisos: [],
  avisosResolvidos: 0,
  recusa: { codigo: 'error_busy', fraseShopee: 'System busy', motivo: 'instabilidade-shopee' },
  comando: 'pnpm --filter @delfrance/shopee-app publicar:anuncio --integracao int-1 --recriar',
  mensagem: 'A Shopee pode ter criado o kit. Aguarde 4 minutos e rode exatamente o mesmo comando.',
  aguardarMs: 240_000,
};

/** One violation row as `shopeeViolacaoSchema` stores it — the re-verify answers the ROW LIST. */
const VIOLACAO = {
  violation_type: 'deboost',
  violation_reason: 'Categoria incorreta',
  suggestion: 'Mude a categoria',
  fix_deadline_time: 1_790_000_000_000,
  update_time: 1_789_000_000_000,
  suggested_category: [{ category_id: 100087, category_name: 'Camisetas' }],
  kind: 'deboost',
  days_to_fix: null,
};

const REVERIFICAR = {
  acao: 'atualizado',
  estadoAnuncio: 'ativo',
  itemStatus: 'NORMAL',
  deboost: true,
  violacoes: [VIOLACAO],
  violacoesLidas: true,
  modelos: { total: 2, atualizados: 1, ausentes: 0 },
  avisoResolvido: false,
  avisoReceitaKit: null,
  chamadasShopee: 3,
};

/** `importar-todos/status/route.ts`'s 200, by name. */
const MASS_STATUS = {
  status: 'running',
  scanned: 10,
  imported: 4,
  created: 2,
  skipped: 1,
  kits: 1,
  failureCount: 1,
  failures: [{ itemId: 1000002, motivo: 'sem-nome', mensagem: 'O anúncio não tem nome.' }],
  restante: 5,
  varreduraExaurida: false,
  startedAt: 1_790_000_000_000,
  updatedAt: 1_790_000_060_000,
  finishedAt: null,
  erro: null,
};

const CONTADORES = {
  status: 'running',
  baixarPreco: false,
  planejados: 3,
  enviados: 1,
  pulados: 1,
  falhas: 1,
  pausas: 0,
  parques: 2,
  retomarEm: 1_790_003_600_000,
  filaRestante: 4,
  relatorioCompleto: false,
  relatorioShards: 1,
  startedAt: 1_790_000_000_000,
  updatedAt: 1_790_000_060_000,
  finishedAt: null,
  erro: null,
};

const PULO = {
  itemId: '1000001',
  produtoId: 'prod-1',
  code: 'sem-link',
  linkDocId: 'link-1',
  precoAnterior: null,
  mensagem: 'O produto não tem anúncio nesta conta.',
};

/** `atualizar-precos/status/route.ts`'s 200, by name. */
const PRICE_STATUS = {
  jobId: 'job-1',
  ...CONTADORES,
  skips: [PULO],
  failures: [{ ...PULO, code: 'preco-recusado', error: 'error_update_price_fail' }],
};

/** `atualizar-precos/historico/route.ts`'s 200, by name — no samples. */
const ENVIO_HISTORICO = { jobId: 'job-1', integracaoId: 'int-1', ...CONTADORES };
const HISTORICO = { envios: [ENVIO_HISTORICO] };

/** One `relatorio/route.ts` row — the 13 keys it sends, NO `variacoes`. */
const LINHA_RELATORIO = {
  produtoId: 'prod-1',
  variacaoProdutoId: 'prod-2',
  anuncioId: '1000001',
  linkDocId: 'link-1',
  resultado: 'enviado',
  fase: 'envio',
  motivo: null,
  mensagem: 'Preço enviado.',
  erro: null,
  preco: 99.9,
  precoAnterior: 89.9,
  produtoNome: 'Camiseta P',
  sku: 'CAM-P',
};
const RELATORIO = {
  linhas: [LINHA_RELATORIO],
  proximoDepois: null,
  status: 'completed',
  relatorioCompleto: true,
  filaRestante: 0,
};

/** The extras of a 422 publish refusal (`core/respond.ts`'s BLOCKED arm). */
const PROBLEMA_COM_ACAO = {
  campo: null,
  motivo: 'listagem-removida',
  mensagem: 'O kit foi removido da Shopee.',
  acao: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar, linkDocId: 'link-1' },
};

describe('step 21 — every route body parses here (the control)', () => {
  it.each([
    ['enviar-precos', envioPrecoManualShopeeSchema, ENVELOPE_PRECO],
    ['publicar (item)', respostaPublicarShopeeSchema, ITEM_200],
    ['publicar (kit 202)', respostaPublicarShopeeSchema, KIT_202],
    ['reverificar-anuncio', respostaReverificarShopeeSchema, REVERIFICAR],
    ['importar-todos/status', massImportStatusShopeeSchema, MASS_STATUS],
    ['atualizar-precos/status', priceSyncStatusShopeeSchema, PRICE_STATUS],
    ['atualizar-precos/historico', priceSyncHistoricoShopeeSchema, HISTORICO],
    ['atualizar-precos/relatorio', priceSyncRelatorioPaginaShopeeSchema, RELATORIO],
  ] as const)('%s (the stock envelope has its own block below)', (_rota, schema, corpo) => {
    expect(schema.safeParse(corpo).success).toBe(true);
  });

  it('the status run parses, and its rows keep their reading', () => {
    const r = anuncioStatusShopeeSchema.parse({
      canal: 'shopee',
      integracaoId: 'int-1',
      acao: 'pausar',
      solicitados: 1,
      familias: 1,
      resumo: { aplicados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
      listings: [LINHA_STATUS],
      produtosSemAnuncio: [],
      pausadoAte: null,
    });

    expect(r.listings[0]?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.pausado);
    expect(r.listings[0]).not.toHaveProperty('membros');
  });

  it('a pause/reactivate direction outside the shared two is refused', () => {
    expect(
      anuncioStatusShopeeSchema.safeParse({
        canal: 'shopee',
        integracaoId: 'int-1',
        acao: 'excluir',
        listings: [],
        produtosSemAnuncio: [],
        pausadoAte: null,
      }).success,
    ).toBe(false);
  });
});

describe('step 21 — the stock envelope declares the SLICE the dialog reads', () => {
  const ESTOQUE = {
    canal: 'shopee',
    integracaoId: 'int-1',
    contaNome: 'Conta Teste',
    solicitados: 1,
    familias: 1,
    resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
    listings: [
      {
        produtoId: 'prod-1',
        produtoNome: 'Camiseta',
        variacaoProdutoId: null,
        anuncioId: '1000001',
        linkDocId: 'link-1',
        outcome: 'enviado',
        // A clamped SUCCESS still carries a motivo — `outcome` is the verdict.
        motivo: 'clampado-promocao',
        mensagem: 'Estoque enviado (elevado ao piso da promoção).',
        quantidade: 7,
        variacoes: [{ modelId: 2000458821, resultado: 'enviado' }],
        modelosRecusados: 0,
        clampados: 1,
        rearme: null,
      },
    ],
    produtosSemEnvio: [
      { produtoId: 'prod-2', produtoNome: null, motivo: 'sem-link', mensagem: 'Sem anúncio.' },
    ],
    pausadoAte: null,
  };

  it('parses, keeps the success with its motivo, and drops the keys it names as stripped', () => {
    const r = envioEstoqueManualShopeeSchema.parse(ESTOQUE);

    expect(r.listings[0]).toMatchObject({ outcome: 'enviado', motivo: 'clampado-promocao' });
    expect(r.listings[0]).not.toHaveProperty('variacoes');
    expect(r.listings[0]).not.toHaveProperty('rearme');
    expect(r).not.toHaveProperty('resumo');
  });

  it('⚠️ NEAR MISS: an outcome outside the four is refused — never read as a fifth success', () => {
    const corpo = { ...ESTOQUE, listings: [{ ...ESTOQUE.listings[0], outcome: 'parcial' }] };
    expect(envioEstoqueManualShopeeSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('step 21 — price rows: tolerant where Shopee’s, strict where ours (C9)', () => {
  it('⭐ a QUOTED `precoAnterior` (read off Shopee) parses to its number', () => {
    const r = envioPrecoManualShopeeSchema.parse({
      ...ENVELOPE_PRECO,
      listings: [{ ...LINHA_PRECO, precoAnterior: '89.9' }],
    });

    expect(r.listings[0]?.precoAnterior).toBe(89.9);
  });

  it('⚠️ NEAR MISS: the same quoted value on `preco` (OURS) is refused — the two tolerances never swap', () => {
    expect(
      envioPrecoManualShopeeSchema.safeParse({
        ...ENVELOPE_PRECO,
        listings: [{ ...LINHA_PRECO, preco: '89.9' }],
      }).success,
    ).toBe(false);
  });

  it('⭐ RT5: an OLDER backend’s row without the child label reads `variacaoNome`/`variacaoSku` as null', () => {
    const r = envioPrecoManualShopeeSchema.parse(ENVELOPE_PRECO);

    expect(r.listings[0]?.variacaoNome).toBeNull();
    expect(r.listings[0]?.variacaoSku).toBeNull();
  });

  it('a NEWER backend’s label rides through', () => {
    const r = envioPrecoManualShopeeSchema.parse({
      ...ENVELOPE_PRECO,
      listings: [{ ...LINHA_PRECO, variacaoNome: 'Camiseta P', variacaoSku: 'CAM-P' }],
    });

    expect(r.listings[0]).toMatchObject({ variacaoNome: 'Camiseta P', variacaoSku: 'CAM-P' });
  });

  it('NEAR MISS: a non-string label is refused — the default covers ABSENCE only', () => {
    expect(
      envioPrecoManualShopeeSchema.safeParse({
        ...ENVELOPE_PRECO,
        listings: [{ ...LINHA_PRECO, variacaoNome: 42 }],
      }).success,
    ).toBe(false);
  });
});

describe('step 21 — publish: the arms are tagged, the kit FIRST (C10, C18)', () => {
  it('⭐ the kit 202 is `tipo: kit`, `desfecho: incerto`, with its `aguardarMs`', () => {
    const r = respostaPublicarShopeeSchema.parse(KIT_202);

    expect(r.tipo).toBe('kit');
    if (r.tipo !== 'kit') return;
    expect(r.desfecho).toBe('incerto');
    expect(r.aguardarMs).toBe(240_000);
  });

  it('⭐ the item 200 is `tipo: item`', () => {
    const r = respostaPublicarShopeeSchema.parse(ITEM_200);

    expect(r.tipo).toBe('item');
    if (r.tipo !== 'item') return;
    expect(r.itemId).toBe(1000001);
    expect(r.tabelaDeMedidas.fonte).toBe('modelo');
  });

  it('a kit body is NEVER typed `item`, whatever the union tries — the item keys are absent from it', () => {
    expect(respostaPublicarShopeeSchema.parse({ ...KIT_202, desfecho: 'criado' }).tipo).toBe('kit');
    // And a kit body missing its arm is not silently an item.
    const { arma: _semArma, ...kitSemArma } = KIT_202;
    expect(respostaPublicarShopeeSchema.safeParse(kitSemArma).success).toBe(false);
  });

  it('a `tipo` key the backend might send never overrides the tag', () => {
    expect(respostaPublicarShopeeSchema.parse({ ...ITEM_200, tipo: 'kit' }).tipo).toBe('item');
  });

  it('⭐ C18: the kit 202 carries `comando` and `mensagem` (CLI text) — the parse exposes NEITHER', () => {
    const r = respostaPublicarShopeeSchema.parse(KIT_202);

    expect(r).not.toHaveProperty('comando');
    expect(r).not.toHaveProperty('mensagem');
  });

  it('a backend older than `aguardarMs` still parses — the caller then waits the shared constant', () => {
    const { aguardarMs: _drop, ...semAguardar } = KIT_202;
    const r = respostaPublicarShopeeSchema.parse(semAguardar);

    expect(r.tipo).toBe('kit');
    expect(r).not.toHaveProperty('aguardarMs');
  });

  it('NEAR MISS: a zero or fractional `aguardarMs` is refused, never waited', () => {
    expect(respostaPublicarShopeeSchema.safeParse({ ...KIT_202, aguardarMs: 0 }).success).toBe(
      false,
    );
    expect(respostaPublicarShopeeSchema.safeParse({ ...KIT_202, aguardarMs: 1.5 }).success).toBe(
      false,
    );
  });

  it('a `desfecho` this build does not know is refused — the tab branches on it', () => {
    expect(
      respostaPublicarShopeeSchema.safeParse({ ...KIT_202, desfecho: 'parcial' }).success,
    ).toBe(false);
  });

  it('`fotoOmitida` is a CODE, never a boolean', () => {
    expect(
      respostaPublicarShopeeSchema.safeParse({
        ...ITEM_200,
        tabelaDeMedidas: { ...ITEM_200.tabelaDeMedidas, fotoOmitida: true },
      }).success,
    ).toBe(false);
  });
});

describe('step 21 — the jobs: Shopee’s shapes, not Mercado Livre’s (C11, C12)', () => {
  it('⭐ C11: a mass-import failure row carries Shopee’s NUMERIC itemId', () => {
    const r = massImportStatusShopeeSchema.parse(MASS_STATUS);

    expect(r.failures[0]).toEqual({
      itemId: 1000002,
      motivo: 'sem-nome',
      mensagem: 'O anúncio não tem nome.',
    });
  });

  it('⚠️ NEAR MISS (C11): a QUOTED itemId (ML’s failure shape) is refused', () => {
    expect(
      massImportStatusShopeeSchema.safeParse({
        ...MASS_STATUS,
        failures: [{ ...MASS_STATUS.failures[0], itemId: '1000002' }],
      }).success,
    ).toBe(false);
  });

  it('⭐ C12: the price status KEEPS `retomarEm`, `parques` and `filaRestante` — never silently stripped', () => {
    const r = priceSyncStatusShopeeSchema.parse(PRICE_STATUS);

    expect(r).toMatchObject({ retomarEm: 1_790_003_600_000, parques: 2, filaRestante: 4 });
    expect(r.failures[0]?.error).toBe('error_update_price_fail');
  });

  it('⭐ C12: a report page whose rows carry NO `variacoes` parses — the key is Mercado Livre’s', () => {
    const r = priceSyncRelatorioPaginaShopeeSchema.parse(RELATORIO);

    expect(r.linhas[0]).toMatchObject({ produtoNome: 'Camiseta P', sku: 'CAM-P' });
    expect(r.linhas[0]).not.toHaveProperty('variacoes');
  });

  it('a job status this build does not know is refused (the shared enum)', () => {
    expect(
      massImportStatusShopeeSchema.safeParse({ ...MASS_STATUS, status: 'paused' }).success,
    ).toBe(false);
  });

  it('`jobIdShopeeSchema` refuses an EMPTY id — a poll of nothing', () => {
    expect(jobIdShopeeSchema.safeParse({ jobId: '' }).success).toBe(false);
    expect(jobIdShopeeSchema.parse({ jobId: 'job-1' })).toEqual({ jobId: 'job-1' });
  });

  it('`canceladoShopeeSchema` accepts only `cancelled`', () => {
    expect(canceladoShopeeSchema.safeParse({ status: 'cancelled' }).success).toBe(true);
    expect(canceladoShopeeSchema.safeParse({ status: 'running' }).success).toBe(false);
  });
});

describe('step 21 — `estadoAnuncio` degrades ONE field, never the answer (C13)', () => {
  it.each([
    ['a member a newer backend adds', 'novo-estado'],
    ['a number', 7],
  ])('⭐ %s reads as `desconhecido` on a status row', (_n, estadoAnuncio) => {
    const r = anuncioStatusShopeeListingSchema.parse({ ...LINHA_STATUS, estadoAnuncio });

    expect(r.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.desconhecido);
  });

  it('`null` stays `null` — "nothing read" is not "unknown"', () => {
    expect(
      anuncioStatusShopeeListingSchema.parse({ ...LINHA_STATUS, estadoAnuncio: null })
        .estadoAnuncio,
    ).toBeNull();
  });

  it('⚠️ NEAR MISS: the catch is SCOPED — a malformed sibling still rejects the row', () => {
    expect(
      anuncioStatusShopeeListingSchema.safeParse({
        ...LINHA_STATUS,
        estadoAnuncio: 'novo-estado',
        outcome: 'parcial',
      }).success,
    ).toBe(false);
  });

  it('the same tolerance on the publish arms and on the re-verify', () => {
    const item = respostaPublicarShopeeSchema.parse({ ...ITEM_200, estadoAnuncio: 'novo-estado' });
    const reverificado = respostaReverificarShopeeSchema.parse({
      ...REVERIFICAR,
      estadoAnuncio: 'novo-estado',
    });

    expect(item.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.desconhecido);
    expect(reverificado.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.desconhecido);
  });
});

describe('step 21 — unknown keys strip, and where the strip STOPS (C15)', () => {
  it('⭐ an unknown top-level key on a price skip sample, a report row and a violation row is ABSENT', () => {
    const status = priceSyncStatusShopeeSchema.parse({
      ...PRICE_STATUS,
      skips: [{ ...PULO, chaveNova: 'x' }],
    });
    const pagina = priceSyncRelatorioPaginaShopeeSchema.parse({
      ...RELATORIO,
      linhas: [{ ...LINHA_RELATORIO, chaveNova: 'x' }],
    });
    const reverificado = respostaReverificarShopeeSchema.parse({
      ...REVERIFICAR,
      violacoes: [{ ...VIOLACAO, chaveNova: 'x' }],
    });

    expect(status.skips[0]).not.toHaveProperty('chaveNova');
    expect(pagina.linhas[0]).not.toHaveProperty('chaveNova');
    expect(reverificado.violacoes[0]).not.toHaveProperty('chaveNova');
  });

  it('⚠️ NEAR MISS: an unknown key INSIDE a `suggested_category[]` item SURVIVES — `.strip()` is shallow (documented)', () => {
    const reverificado = respostaReverificarShopeeSchema.parse({
      ...REVERIFICAR,
      violacoes: [
        {
          ...VIOLACAO,
          suggested_category: [{ category_id: 100087, category_name: 'Camisetas', novo: 1 }],
        },
      ],
    });

    expect(reverificado.violacoes[0]?.suggested_category?.[0]).toHaveProperty('novo', 1);
  });

  it('a violation row keeps its eight modelled keys', () => {
    const r = respostaReverificarShopeeSchema.parse(REVERIFICAR);

    expect(r.violacoes[0]).toEqual(VIOLACAO);
    expect(r).not.toHaveProperty('chamadasShopee');
  });
});

describe('step 21 — `problemas[].acao` is caught PER ROW (C17)', () => {
  it('⭐ an `acao` with an unknown `tipo` keeps its row (acao `null`); the sibling’s valid acao SURVIVES', () => {
    const detalhes = detalhesErroShopeeSchema.parse({
      error: 'Publicação bloqueada.',
      code: 'SHOPEE_PUBLISH_BLOCKED',
      problemas: [{ ...PROBLEMA_COM_ACAO, acao: { tipo: 'novo-tipo' } }, PROBLEMA_COM_ACAO],
    });

    expect(detalhes.problemas).toHaveLength(2);
    expect(detalhes.problemas?.[0]).toMatchObject({
      motivo: 'listagem-removida',
      mensagem: 'O kit foi removido da Shopee.',
      acao: null,
    });
    expect(detalhes.problemas?.[1]?.acao).toEqual(PROBLEMA_COM_ACAO.acao);
  });

  it('RT2: every `tipo` the shared vocabulary declares parses on a row', () => {
    const acoes = [
      { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar, linkDocId: 'link-1' },
      { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar, linkDocId: null },
      { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.semOpcoesDeKit },
      { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.informarPrincipal },
      { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar, itemIds: [1000001] },
      {
        tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.escolherVinculo,
        linkDocIds: ['link-1', 'link-2'],
      },
    ];
    for (const acao of acoes) {
      expect(problemaShopeeSchema.parse({ ...PROBLEMA_COM_ACAO, acao }).acao).toEqual(acao);
    }
  });

  it('a row with no `acao` at all (step-11 refusals, an older backend) reads `acao: null`', () => {
    const { acao: _drop, ...semAcao } = PROBLEMA_COM_ACAO;
    expect(problemaShopeeSchema.parse(semAcao).acao).toBeNull();
  });

  it('NEAR MISS: a row missing its `motivo` is not a refusal — the list reads as absent, the error still constructs', () => {
    const { motivo: _drop, ...semMotivo } = PROBLEMA_COM_ACAO;
    const detalhes = detalhesErroShopeeSchema.parse({ problemas: [semMotivo] });

    expect(detalhes.problemas).toBeNull();
  });
});

describe('step 21 — the error extras: every field on its own', () => {
  it('an empty body reads exactly the all-absent constant', () => {
    expect(detalhesErroShopeeSchema.parse({})).toEqual(DETALHES_ERRO_SHOPEE_VAZIOS);
  });

  it('each field read independently — a wrong type nulls only itself', () => {
    expect(
      detalhesErroShopeeSchema.parse({ jobId: 7, linkDocId: 'link-1', solicitados: 'x' }),
    ).toMatchObject({ jobId: null, linkDocId: 'link-1', solicitados: null });
  });
});

describe('step 21 — a stored-doc default is NOT a wire tolerance: a missing key is loud (C19)', () => {
  function clienteQueResponde(corpo: unknown) {
    return createShopeeClient({
      baseUrl: 'http://localhost:3009',
      getAuthToken: async () => 'token',
      fetch: async () =>
        new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
  }

  /** `obj` without `chave` — the key ABSENT, not `undefined`. */
  function sem(obj: Readonly<Record<string, unknown>>, chave: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== chave));
  }

  const JOB = { integracaoId: 'int-1', jobId: 'job-1' };

  it.each([
    [
      'a mass-import status without `failures`',
      'failures',
      (c: ReturnType<typeof clienteQueResponde>) => c.massImportStatus(JOB),
      sem(MASS_STATUS, 'failures'),
    ],
    [
      'a mass-import status without `scanned`',
      'scanned',
      (c: ReturnType<typeof clienteQueResponde>) => c.massImportStatus(JOB),
      sem(MASS_STATUS, 'scanned'),
    ],
    [
      'a price status without `parques`',
      'parques',
      (c: ReturnType<typeof clienteQueResponde>) => c.priceSyncStatus(JOB),
      sem(PRICE_STATUS, 'parques'),
    ],
    [
      'a historico row without `falhas`',
      'envios[].falhas',
      (c: ReturnType<typeof clienteQueResponde>) => c.priceSyncHistorico({ integracaoId: 'int-1' }),
      { envios: [sem(ENVIO_HISTORICO, 'falhas')] },
    ],
    [
      'a report row without `mensagem`',
      'linhas[].mensagem',
      (c: ReturnType<typeof clienteQueResponde>) => c.priceSyncRelatorio(JOB),
      { ...RELATORIO, linhas: [sem(LINHA_RELATORIO, 'mensagem')] },
    ],
  ] as const)(
    '⭐ %s ⇒ ShopeeClientRespostaInvalidaError naming it — never a 0 or a []',
    async (_n, campo, chamar, corpo) => {
      const c = clienteQueResponde(corpo);

      const err = await chamar(c).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
      expect((err as ShopeeClientRespostaInvalidaError).campos).toContain(campo);
    },
  );
});
