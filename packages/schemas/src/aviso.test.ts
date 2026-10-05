import { describe, expect, it } from 'vitest';
import {
  PENDENCIA_RECLAMACAO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoNaoLido,
  avisoSchema,
  avisosLeituraSchema,
  chaveDeAviso,
  entradaDeLeitura,
  marcarTodosComoLidos,
  pendenciaReclamacaoSchema,
  rotaInternaSegura,
  tipoAvisoSchema,
  urlExternaSegura,
  type Aviso,
  type AvisosLeitura,
} from './aviso';

const AGORA_US = 1_760_000_000_000_000;

function umAviso(over: Partial<Aviso> = {}): Aviso {
  return avisoSchema.parse({
    tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
    severidade: SEVERIDADE_AVISO.atencao,
    criadoEm: AGORA_US,
    atualizadoEm: AGORA_US,
    ...over,
  });
}

describe('avisoSchema', () => {
  it('fills every optional field with null (never undefined — the SDK rejects it)', () => {
    const parsed = umAviso();
    expect(parsed.canal).toBeNull();
    expect(parsed.motivo).toBeNull();
    expect(parsed.destinatarioUid).toBeNull();
    expect(parsed.urlInterna).toBeNull();
    expect(parsed.urlExterna).toBeNull();
    expect(parsed.prazo).toBeNull();
    expect(parsed.relogioEvento).toBeNull();
    expect(parsed.resolvidoEm).toBeNull();
    expect(parsed.resolucaoMotivo).toBeNull();
    expect(parsed.params).toEqual({});
    expect(parsed.ocorrencias).toBe(1);
  });

  it('keeps `resolvidoEm` a timestamp, not a boolean — it must say HOW LONG it stood', () => {
    const resolvido = umAviso({ resolvidoEm: AGORA_US + 3_600_000_000 });
    expect(resolvido.resolvidoEm).toBe(AGORA_US + 3_600_000_000);
    expect(typeof resolvido.resolvidoEm).toBe('number');
  });

  it('coerces a legacy ms timestamp into µs rather than rendering 1970', () => {
    // `microsSinceEpoch` is tolerant on read; a producer that wrote ms by mistake
    // must not surface as a 1970 date in the panel.
    const parsed = umAviso({ criadoEm: 1_760_000_000_000 });
    expect(parsed.criadoEm).toBe(AGORA_US);
  });
});

describe('TIPO_AVISO_LABELS', () => {
  it('covers every tipo — nothing else fails when a label is missing', () => {
    // `MENSAGENS_POR_TIPO` is total by its `Record<TipoAviso, …>` type, but this
    // map is a bare `as const` handed to `.meta()`: a tipo added without its label
    // typechecks everywhere, so only this test says so.
    expect(Object.keys(TIPO_AVISO_LABELS).sort()).toEqual([...tipoAvisoSchema.options].sort());
    for (const [tipo, label] of Object.entries(TIPO_AVISO_LABELS)) {
      expect(label.trim(), tipo).not.toBe('');
    }
  });

  it('keeps the named-member constant in step with the enum', () => {
    // `satisfies Record<string, TipoAviso>` proves every member is a tipo, not
    // that every tipo has a member.
    expect(Object.keys(TIPO_AVISO).sort()).toEqual([...tipoAvisoSchema.options].sort());
    for (const [nome, valor] of Object.entries(TIPO_AVISO)) expect(valor, nome).toBe(nome);
  });

  it('labels the two dispatch tipos without a provider product name', () => {
    expect(TIPO_AVISO_LABELS.despachoAutomaticoPendente).toBe('Despacho automático pendente');
    expect(TIPO_AVISO_LABELS.etiquetaComPrazo).toBe('Etiqueta com prazo de impressão');
  });

  it('labels the return tipo without a provider name — it is channel-neutral', () => {
    expect(TIPO_AVISO.reclamacaoAguardandoVendedor).toBe('reclamacaoAguardandoVendedor');
    expect(TIPO_AVISO_LABELS.reclamacaoAguardandoVendedor).toBe('Reclamação aguardando o vendedor');
  });
});

describe('PENDENCIA_RECLAMACAO', () => {
  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(PENDENCIA_RECLAMACAO).sort()).toEqual(
      [...pendenciaReclamacaoSchema.options].sort(),
    );
    expect(PENDENCIA_RECLAMACAO).toEqual({
      responderSolicitacao: 'responder-solicitacao',
      responderProposta: 'responder-proposta',
      enviarEvidencias: 'enviar-evidencias',
    });
  });

  it('is CLOSED at three: the pickup is shown on the panel and raises no aviso in v1', () => {
    // `organizar-coleta` is the near-miss: when the seller must act on the
    // reverse pickup is unsettled (register 242), so it is not a pendência.
    expect(pendenciaReclamacaoSchema.options).toHaveLength(3);
    expect(pendenciaReclamacaoSchema.safeParse('organizar-coleta').success).toBe(false);
    expect(pendenciaReclamacaoSchema.safeParse('responder_solicitacao').success).toBe(false);
  });
});

describe('chaveDeAviso — what the fold treats as EQUAL', () => {
  it('collapses the weekly sweep and the provider push for the same expiry window', () => {
    // The Shopee plan has TWO producers for one logical event: the weekly
    // `sweepShopeeAuthorizationExpiry` and Shopee's own `push 12`. They must land
    // on one row, or the operator gets the same warning twice a week.
    const daVarredura = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      entidade: 'shop-77',
      janela: '2026-11-02',
    });
    const doPush = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      entidade: 'shop-77',
      janela: '2026-11-02',
    });
    expect(daVarredura).toBe(doPush);
  });

  it('folds a `/` in a segment — an outerRef must not fork a subcollection path', () => {
    // This is the one that would break Firestore outright: the key IS the
    // document id, and `a/b` would address `avisos/a/b`, a subcollection.
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: 'documents/usuarios/abc',
      entidade: 'pedido-1',
    });
    expect(chave).not.toContain('/');
    expect(chave).toContain('documents_usuarios_abc');
  });

  it('treats `a/b` and `a_b` as the SAME aviso — an accepted cost of that fold', () => {
    const comBarra = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a/b' });
    const comUnderscore = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a_b' });
    expect(comBarra).toBe(comUnderscore);
  });
});

describe('chaveDeAviso — what must stay DISTINCT (the near-miss half)', () => {
  // A test that the fold APPLIES cannot show where it STOPS. #1372 shipped eight
  // passing mutation tests that all asked "does it fold?" and none "does it fold
  // too much?", and real edits silently reached neither the provider nor
  // Firestore. These are the pairs that must NOT collapse.

  it('separates two expiry windows for the same conta', () => {
    const novembro = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      janela: '2026-11-02',
    });
    const dezembro = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      janela: '2026-12-02',
    });
    expect(novembro).not.toBe(dezembro);
  });

  it('separates two violation types on the same item', () => {
    const banido = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'integracao-1',
      entidade: 'item-9:BANNED',
    });
    const deboost = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'integracao-1',
      entidade: 'item-9:DEBOOST',
    });
    expect(banido).not.toBe(deboost);
  });

  it('separates two contas with the same entity id', () => {
    const uma = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, conta: 'a', entidade: 'x' });
    const outra = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, conta: 'b', entidade: 'x' });
    expect(uma).not.toBe(outra);
  });

  it('does not let a missing middle segment alias a present one', () => {
    // Without the empty-segment placeholder, `(tipo, null, 'x')` and
    // `(tipo, 'x', null)` would both join to `tipo:x` and silently merge two
    // unrelated events.
    const semConta = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, entidade: 'x' });
    const semEntidade = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, conta: 'x' });
    expect(semConta).not.toBe(semEntidade);
  });

  it('separates two tipos sharing every other segment', () => {
    const expirando = chaveDeAviso({ tipo: TIPO_AVISO.shopeeAutorizacaoExpirando, conta: 'i-1' });
    const desautorizado = chaveDeAviso({ tipo: TIPO_AVISO.shopeeDesautorizado, conta: 'i-1' });
    expect(expirando).not.toBe(desautorizado);
  });

  it('does not let a colon INSIDE a segment shift the segment boundaries', () => {
    // The separator is the one character the fold must not leave intact: with `:`
    // untouched, `conta='loja:123'` and `(conta='loja', entidade='123')` produce
    // the same document id, so two unrelated operator events silently become one
    // and `ocorrencias` reads as a plausible repeat. The intended usage already
    // puts colons in segments (see the violation-type pair above), so this is not
    // a contrived input.
    const dentroDeUmSegmento = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'loja:123',
    });
    const emDoisSegmentos = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'loja',
      entidade: '123',
    });
    expect(dentroDeUmSegmento).not.toBe(emDoisSegmentos);

    const tresSegmentos = chaveDeAviso({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: 'a',
      entidade: 'b',
      janela: 'c',
    });
    const doisComColon = chaveDeAviso({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: 'a:b',
      entidade: 'c',
    });
    expect(tresSegmentos).not.toBe(doisComColon);
  });

  it('does not let a TRAILING colon alias the same segment without one', () => {
    const comDoisPontos = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a:' });
    const sem = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a' });
    expect(comDoisPontos).not.toBe(sem);
  });

  it('refuses a key too long to be a document id instead of writing a broken one', () => {
    expect(() =>
      chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, entidade: 'x'.repeat(1600) }),
    ).toThrow(RangeError);
  });
});

describe('chaveDeAviso — the two dispatch tipos (Shopee step 15b)', () => {
  // The producer opens `despachoAutomaticoPendente` per PACKAGE per CLASS and
  // `etiquetaComPrazo` per PEDIDO, and the frete callers' resolver must RECOMPUTE
  // the same ids from what it observes: a key it cannot recompute is a row that
  // stands until retention sweeps it.
  const PEDIDO_ID = '0123456789abcdef'.repeat(4); // fixed-length hex, like a Shopee pedido id
  const despacho = (pacote: string, classe: 'nfe' | 'manual') =>
    chaveDeAviso({
      tipo: TIPO_AVISO.despachoAutomaticoPendente,
      conta: 'int-1',
      entidade: `${PEDIDO_ID}:${pacote}`,
      janela: classe,
    });

  it('folds the inner `:` of the entity and keeps the class LAST', () => {
    expect(despacho('OFG000000000001', 'nfe')).toBe(
      `despachoAutomaticoPendente:int-1:${PEDIDO_ID}_OFG000000000001:nfe`,
    );
    // The accepted cost of that fold: `:` and `_` inside the entity are one key.
    // Harmless here — the pedido id is fixed-length hex, so the package number
    // always starts at the same offset and two packages cannot meet.
    expect(
      chaveDeAviso({
        tipo: TIPO_AVISO.despachoAutomaticoPendente,
        conta: 'int-1',
        entidade: `${PEDIDO_ID}_OFG000000000001`,
        janela: 'nfe',
      }),
    ).toBe(despacho('OFG000000000001', 'nfe'));
  });

  it('separates two packages of one pedido — a split order keeps one row per package', () => {
    expect(despacho('OFG000000000001', 'nfe')).not.toBe(despacho('OFG000000000002', 'nfe'));
  });

  it('separates the two classes of one package — a refused arrange after the NF-e is a NEW row', () => {
    expect(despacho('OFG000000000001', 'nfe')).not.toBe(despacho('OFG000000000001', 'manual'));
  });

  it('keys the print alert per PEDIDO, apart from every dispatch row of that pedido', () => {
    const etiqueta = chaveDeAviso({
      tipo: TIPO_AVISO.etiquetaComPrazo,
      conta: 'int-1',
      entidade: PEDIDO_ID,
    });
    expect(etiqueta).toBe(`etiquetaComPrazo:int-1:${PEDIDO_ID}`);
    expect(etiqueta).not.toBe(despacho('OFG000000000001', 'nfe'));
    expect(etiqueta).not.toBe(despacho('OFG000000000001', 'manual'));
  });
});

describe('chaveDeAviso — the return tipo (Shopee step 17)', () => {
  // ONE row per RETURN, keyed on the return id alone. The importer raises and
  // resolves it from two different deliveries, so it must recompute the SAME id
  // from `(integracaoId, returnSn)` every time — a key it cannot recompute is a
  // row nothing ever closes.
  const devolucao = (conta: string, returnSn: string) =>
    chaveDeAviso({ tipo: TIPO_AVISO.reclamacaoAguardandoVendedor, conta, entidade: returnSn });

  it('spells the return id verbatim — an alphanumeric id is never folded', () => {
    expect(devolucao('int-1', '260910ABCDE0001')).toBe(
      'reclamacaoAguardandoVendedor:int-1:260910ABCDE0001',
    );
    expect(devolucao('int-1', '260910ABCDE0001')).toBe(devolucao('int-1', '260910ABCDE0001'));
  });

  it('separates two returns of one pedido, and one return id under two contas', () => {
    expect(devolucao('int-1', '2609100000000001')).not.toBe(devolucao('int-1', '2609100000000002'));
    expect(devolucao('int-1', '2609100000000001')).not.toBe(devolucao('int-2', '2609100000000001'));
  });

  it('never meets the per-pedido decision row — a different tipo, a different row', () => {
    expect(devolucao('int-1', '2609100000000001')).not.toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.pedidoPrecisaDecisao,
        conta: 'int-1',
        entidade: '2609100000000001',
      }),
    );
  });
});

describe('avisoNaoLido', () => {
  const semLeitura: AvisosLeitura = avisosLeituraSchema.parse({});

  it('counts an aviso nobody has read', () => {
    expect(avisoNaoLido(umAviso(), 'a1', semLeitura, 'uid-1')).toBe(true);
  });

  it('ignores a resolved aviso even when unread', () => {
    expect(avisoNaoLido(umAviso({ resolvidoEm: AGORA_US }), 'a1', semLeitura, 'uid-1')).toBe(false);
  });

  it('ignores an aviso addressed to someone else, and keeps a broadcast', () => {
    const deOutro = umAviso({ destinatarioUid: 'uid-2' });
    expect(avisoNaoLido(deOutro, 'a1', semLeitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso({ destinatarioUid: 'uid-1' }), 'a1', semLeitura, 'uid-1')).toBe(
      true,
    );
    expect(avisoNaoLido(umAviso({ destinatarioUid: null }), 'a1', semLeitura, 'uid-1')).toBe(true);
  });

  it('honours a per-item read WITHOUT touching the others', () => {
    const leitura = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('a1', AGORA_US)],
    });
    expect(avisoNaoLido(umAviso(), 'a1', leitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso(), 'a2', leitura, 'uid-1')).toBe(true);
  });

  it('honours the watermark, and still counts one raised after it', () => {
    const leitura = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: AGORA_US });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US }), 'a1', leitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 1 }), 'a2', leitura, 'uid-1')).toBe(true);
  });

  it('re-alerts a REOPENED aviso the operator had read individually', () => {
    // `escreverAviso` reopens a resolved aviso under the SAME id and stamps a
    // fresh `criadoEm`. The read named the version before that, so it no longer
    // covers this one.
    const leitura = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('a1', AGORA_US)],
    });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 10 }), 'a1', leitura, 'uid-1')).toBe(true);
  });

  it('keeps a REPEAT read: the same id at the same `criadoEm` stays read', () => {
    // The near-miss of the reopen above. A repeat bumps `ocorrencias` and leaves
    // `criadoEm` alone, and nagging the operator about it again is precisely what
    // dedup exists to stop.
    const leitura = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('a1', AGORA_US)],
    });
    expect(
      avisoNaoLido(umAviso({ criadoEm: AGORA_US, ocorrencias: 7 }), 'a1', leitura, 'uid-1'),
    ).toBe(false);
  });

  it('gives a bare id no credit — the "compatible" check is the bug', () => {
    // `lidos.includes(avisoId)` is what kept a reopened aviso silenced. A bare id
    // names no version, so it cannot say whether it covers the current one.
    const leitura = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: 0, lidos: ['a1'] });
    expect(avisoNaoLido(umAviso(), 'a1', leitura, 'uid-1')).toBe(true);
  });
});

describe('entradaDeLeitura', () => {
  it('is deterministic: the same (id, criadoEm) is the same entry', () => {
    expect(entradaDeLeitura('a1', AGORA_US)).toBe(entradaDeLeitura('a1', AGORA_US));
  });

  it('keeps one microsecond of `criadoEm` apart', () => {
    expect(entradaDeLeitura('a1', AGORA_US)).not.toBe(entradaDeLeitura('a1', AGORA_US + 1));
  });

  it('never aliases two pairs, even for ids that contain `@` and digits', () => {
    // `chaveDeAviso` does not fold `@`, so an id can carry one. The entry stays
    // injective only because a number never stringifies with an `@` in it. The
    // grid needs an id ENDING in a digit: without a separator `('x1', 2)` and
    // `('x', 12)` both spell `x12`, which is what fails if the `@` is ever dropped
    // or swapped for a digit.
    const entradas = new Set<string>();
    for (const id of ['x', 'x1', 'x@1']) {
      for (const criadoEm of [1, 2, 12]) entradas.add(entradaDeLeitura(id, criadoEm));
    }
    expect(entradas.size).toBe(9);
  });
});

describe('marcarTodosComoLidos', () => {
  it('takes the value it is GIVEN — the caller passes a seen `criadoEm`, not a clock', () => {
    // The rows are stamped by a Cloud Function and the panel runs in a browser, so
    // a "now" read here would compare two different clocks and a fast client would
    // mark unraised avisos read.
    const proximo = marcarTodosComoLidos(AGORA_US + 42);
    expect(proximo.ultimaVisualizacaoUs).toBe(AGORA_US + 42);
  });

  it('advances the watermark AND clears `lidos` in the same value', () => {
    // Advancing without clearing grows the array forever; clearing without
    // advancing marks nothing read. Both halves or neither.
    const proximo = marcarTodosComoLidos(AGORA_US);
    expect(proximo).toEqual({ ultimaVisualizacaoUs: AGORA_US, lidos: [] });
  });

  it('leaves an aviso raised AFTER the mark still unread', () => {
    const leitura = marcarTodosComoLidos(AGORA_US);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 1 }), 'novo', leitura, 'uid-1')).toBe(true);
  });

  it('does not resurrect a stale entry: the clear leaves only the watermark to answer', () => {
    // `chave` is stable, so the same document id comes back when an aviso is
    // re-raised. Once the watermark moves, the per-item entries it replaced must
    // be gone, or the array grows forever and still answers for rows the
    // watermark now owns.
    const antes = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('recorrente', AGORA_US + 5)],
    });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 5 }), 'recorrente', antes, 'uid-1')).toBe(
      false,
    );

    const depois = marcarTodosComoLidos(AGORA_US);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 5 }), 'recorrente', depois, 'uid-1')).toBe(
      true,
    );
  });
});

describe('ROTAS_AVISO', () => {
  it('keeps every `build` output shaped like its `padrao`', () => {
    // Pins the two halves against each other so one cannot be edited alone. The
    // companion test in apps/web asserts each `padrao` is a REAL route directory
    // — that is what turns a rename from "fails nothing" into "fails a test".
    for (const [nome, rota] of Object.entries(ROTAS_AVISO)) {
      const construida = (rota.build as (id?: string) => string)('ID');
      expect(construida.split('/').length, nome).toBe(rota.padrao.split('/').length);
      expect(construida.startsWith('/'), nome).toBe(true);
      expect(construida, nome).not.toContain('undefined');
    }
  });

  it('builds a concrete Shopee conta route', () => {
    expect(ROTAS_AVISO.canalShopee.build('abc')).toBe('/canais/shopee/abc');
  });

  it('lands a dispatch aviso on the checkout, with the pedido id as `?pedido=`', () => {
    expect(ROTAS_AVISO.despachoCheckout.padrao).toBe('/despacho/checkout');
    expect(ROTAS_AVISO.despachoCheckout.build('abc')).toBe('/despacho/checkout?pedido=abc');
    expect(ROTAS_AVISO.despachoCheckout.build('a&b=c d')).toBe(
      '/despacho/checkout?pedido=a%26b%3Dc%20d',
    );
  });

  it('encodes the pedido id, so the checkout reads back exactly the id it was given', () => {
    // The checkout reads `searchParams.get('pedido')` and looks the pedido up by
    // doc id. Unencoded, `&` would end the value early, `#` would start a
    // fragment and `%41`/`+` would decode into another string — each one a
    // lookup of a DIFFERENT pedido, or of none.
    const ids = ['0123456789abcdef'.repeat(4), 'a&b=c', 'a#b', 'a b', 'a+b', 'a/b', 'a?b', '%41'];
    for (const id of ids) {
      const rota = ROTAS_AVISO.despachoCheckout.build(id);
      expect(new URL(rota, 'https://erp.invalid').searchParams.get('pedido'), id).toBe(id);
      expect(rotaInternaSegura(rota), id).toBe(rota);
    }
  });
});

describe('rotaInternaSegura', () => {
  it('accepts a real in-app path', () => {
    expect(rotaInternaSegura('/canais/shopee/abc')).toBe('/canais/shopee/abc');
    expect(rotaInternaSegura('/pedidos/1/editar#fiscal')).toBe('/pedidos/1/editar#fiscal');
  });

  it('refuses a PROTOCOL-RELATIVE path, which starts with `/` but leaves the site', () => {
    // The reason a bare `startsWith('/')` is not the check.
    expect(rotaInternaSegura('//evil.com/x')).toBeNull();
  });

  it('refuses anything that is not a path at all', () => {
    expect(rotaInternaSegura('javascript:alert(1)')).toBeNull();
    expect(rotaInternaSegura('https://evil.com/x')).toBeNull();
    expect(rotaInternaSegura('canais/shopee/abc')).toBeNull();
    expect(rotaInternaSegura(null)).toBeNull();
    expect(rotaInternaSegura('')).toBeNull();
  });

  it('accepts every route the shared builder can emit', () => {
    for (const [nome, rota] of Object.entries(ROTAS_AVISO)) {
      const construida = (rota.build as (id?: string) => string)('ID');
      expect(rotaInternaSegura(construida), nome).toBe(construida);
    }
  });
});

describe('urlExternaSegura', () => {
  const PERMITIDOS = ['shopee.com.br', 'mercadolivre.com.br'];

  it('accepts an https URL on an allowed host and its subdomains', () => {
    expect(urlExternaSegura('https://shopee.com.br/x', PERMITIDOS)).toBe('https://shopee.com.br/x');
    expect(urlExternaSegura('https://seller.shopee.com.br/x', PERMITIDOS)).toBe(
      'https://seller.shopee.com.br/x',
    );
  });

  it('refuses every shape that could execute or leak', () => {
    expect(urlExternaSegura('javascript:alert(1)', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('http://shopee.com.br/x', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('https://evil.com/x', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('nao-e-uma-url', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura(null, PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('', PERMITIDOS)).toBeNull();
  });

  it('refuses a host that merely ENDS with an allowed name', () => {
    // `notshopee.com.br` must not pass a naive `endsWith` check.
    expect(urlExternaSegura('https://notshopee.com.br/x', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('https://shopee.com.br.evil.com/x', PERMITIDOS)).toBeNull();
  });
});
