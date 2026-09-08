import { describe, expect, it } from 'vitest';
import {
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  avisoNaoLido,
  avisoSchema,
  avisosLeituraSchema,
  chaveDeAviso,
  marcarTodosComoLidos,
  rotaInternaSegura,
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
    const leitura = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: 0, lidos: ['a1'] });
    expect(avisoNaoLido(umAviso(), 'a1', leitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso(), 'a2', leitura, 'uid-1')).toBe(true);
  });

  it('honours the watermark, and still counts one raised after it', () => {
    const leitura = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: AGORA_US });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US }), 'a1', leitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 1 }), 'a2', leitura, 'uid-1')).toBe(true);
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

  it('does not resurrect a stale id: a re-raised aviso under an old id reads as UNREAD', () => {
    // The trap the clear exists to prevent. `chave` is stable, so the same
    // document id comes back when an aviso is re-raised. If `lidos` still carried
    // that id from before the watermark moved, a genuinely new occurrence would
    // render as already-read.
    const antes = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: 0, lidos: ['recorrente'] });
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
