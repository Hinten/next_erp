import { describe, expect, it } from 'vitest';
import { type ChamadaLi, TOKEN_REMOVIDO } from '@delfrance/integrations-loja-integrada';

import { espiarStdout, gravadorDeLog } from '../testing/fixtures';
import {
  CHAVES_DA_LINHA,
  type CampoLogLi,
  MAX_LINHA_RESTAURACAO_BYTES,
  MAX_TRECHO_CORPO_BYTES,
  SEVERIDADE_DA_ESCRITA_LI,
  criarObservadorLi,
  escritorPadrao,
  linhaDaChamada,
  linhaSerializadaLi,
  registrarDerivaLi,
  registrarDiffLi,
  registrarEscritaLi,
  registrarEventoLi,
  registrarRestauracaoLi,
  serializarValorLi,
  severidadeDaChamada,
} from './log';
import { bytesUtf8 } from './redacao';
import { montarRef } from './refCredencial';

const FINGERPRINT = 'abcdef0123456789';
const VERSAO_MS = 1_790_000_000_000;
const SENTINELA = 'SENTINELA-corpo-cliente';
const EMAIL = 'fulano@exemplo.invalid';

function evento(over: Partial<ChamadaLi> = {}): ChamadaLi {
  return {
    operacao: 'buscarPedidos',
    metodo: 'GET',
    caminho: '/v1/pedido/search/',
    query: [
      ['since_atualizado', '2026-09-25T00:00:00'],
      ['limit', '50'],
      ['email', EMAIL],
    ],
    correlationId: 'corr-1',
    enviouCorrelationId: false,
    refCredencial: montarRef(FINGERPRINT, VERSAO_MS),
    status: 200,
    latenciaMs: 12,
    resultado: 'ok',
    codigoLimite: null,
    retryAfterS: null,
    corpo: JSON.stringify({
      meta: { limit: 50, next: null, offset: 0, previous: null, total_count: 1 },
      objects: [{ numero: 165, cliente: SENTINELA, obs: TOKEN_REMOVIDO }],
    }),
    ...over,
  };
}

const OPCOES = { conta: 'conta-li-1', fluxo: 'intake', tentativa: 3, idTarefa: 't-9' };

describe('linhaDaChamada — the line is a projection', () => {
  it('has exactly the keys of the line schema, in order', () => {
    const { linha } = linhaDaChamada(evento(), OPCOES);
    expect(Object.keys(linha)).toEqual([...CHAVES_DA_LINHA]);
    expect([...CHAVES_DA_LINHA]).toEqual([
      'evento',
      'conta',
      'fluxo',
      'operacao',
      'metodo',
      'recurso',
      'politica',
      'caminho',
      'status',
      'resultado',
      'tentativa',
      'credencial',
      'versaoCredencial',
      'codigoLimite',
      'retryAfterS',
      'latenciaMs',
      'correlationId',
      'enviouCorrelationId',
      'idTarefa',
      'idNotificacao',
      'trechoCorpo',
      'corpoBytes',
      'corpoForma',
      'corpoTruncado',
      'mascarados',
    ]);
  });

  it('every campo is a primitive', () => {
    const { linha } = linhaDaChamada(evento(), OPCOES);
    for (const [chave, valor] of Object.entries(linha)) {
      expect(valor === null || ['string', 'number', 'boolean'].includes(typeof valor), chave).toBe(
        true,
      );
    }
  });

  it('never the raw query, the raw body, the ref or the fingerprint', () => {
    const e = evento();
    const { linha } = linhaDaChamada(e, OPCOES);
    const texto = JSON.stringify(linha);
    expect(texto).not.toContain(EMAIL);
    expect(texto).not.toContain(SENTINELA);
    expect(texto).not.toContain(TOKEN_REMOVIDO);
    expect(texto).not.toContain(e.refCredencial);
    expect(texto).not.toContain(FINGERPRINT);
    expect(texto).not.toContain(e.corpo ?? '');
    expect(linha).toMatchObject({
      caminho: '/v1/pedido/search/?since_atualizado=2026-09-25T00:00:00&limit=50&email=<redacted>',
      politica: 'estrutural',
      recurso: 'pedido',
      corpoForma: 'json',
      corpoTruncado: false,
    });
    expect(JSON.parse(linha.trechoCorpo ?? '')).toMatchObject({
      objects: [{ numero: 165, cliente: '<redacted>', obs: '<redacted>' }],
    });
  });

  it("labels the credential by its TYPE and its ref's VERSION only", () => {
    const { linha } = linhaDaChamada(evento(), OPCOES);
    expect(linha.credencial).toBe('personal-token');
    expect(linha.versaoCredencial).toBe(String(VERSAO_MS));
    expect(
      linhaDaChamada(evento({ refCredencial: 'candidato' }), OPCOES).linha.versaoCredencial,
    ).toBeNull();
  });

  it('adds what the package event lacks, from the options', () => {
    const { linha } = linhaDaChamada(evento(), OPCOES);
    expect(linha).toMatchObject({
      evento: 'chamada',
      conta: 'conta-li-1',
      fluxo: 'intake',
      tentativa: 3,
      idTarefa: 't-9',
      idNotificacao: null,
      correlationId: 'corr-1',
      enviouCorrelationId: false,
    });
    expect(linhaDaChamada(evento(), { conta: 'c' }).linha).toMatchObject({
      fluxo: null,
      tentativa: null,
      idTarefa: null,
    });
  });

  it('mask first, cut second: an e-mail straddling the 2048-byte edge leaves no fragment', () => {
    // The 2048th byte falls inside `exemplo`: a text cut FIRST would end in
    // `fulano@exe`, which no pattern recognises any more.
    const corpo = `${'x'.repeat(2037)} ${EMAIL} ${'y'.repeat(100)}`;
    expect(corpo.slice(0, MAX_TRECHO_CORPO_BYTES).endsWith('fulano@exe')).toBe(true);
    const { linha } = linhaDaChamada(
      evento({ caminho: '/v1/categoria/', status: 400, resultado: 'http', corpo }),
      OPCOES,
    );
    expect(linha.corpoTruncado).toBe(true);
    expect(bytesUtf8(linha.trechoCorpo ?? '')).toBeLessThanOrEqual(MAX_TRECHO_CORPO_BYTES);
    expect(linha.trechoCorpo).not.toContain('fulano');
    expect(linha.trechoCorpo).not.toContain('@');
    expect(linha.mascarados).toBe(1);
  });

  it('a candidate credential (the validating GET) logs NO body excerpt, whatever the status', () => {
    // How Loja Integrada answers a bad token beyond 401/403 is unobserved, and
    // the package scrubs only the token AS SENT: a partial or escaped echo
    // survives the scrub.
    const parcial = 'li-token-sentinela-AAAA';
    const corpo = JSON.stringify({ detalhe: `token ${parcial} recusado`, codigo: '633' });
    for (const [status, resultado] of [
      [200, 'schema'],
      [400, 'http'],
      [401, 'auth'],
      [422, 'http'],
      [500, 'http'],
    ] as const) {
      const { linha } = linhaDaChamada(
        evento({ refCredencial: 'candidato', caminho: '/v1/categoria/', status, resultado, corpo }),
        OPCOES,
      );
      expect(linha, String(status)).toMatchObject({
        versaoCredencial: null,
        trechoCorpo: null,
        corpoBytes: bytesUtf8(corpo),
        corpoForma: 'json',
        corpoTruncado: false,
        mascarados: 0,
      });
      expect(JSON.stringify(linha)).not.toContain(parcial);
    }
    // Near-miss: the same 400 under a stored credential keeps an excerpt — the
    // error walk's, so the code stays and the echo does not.
    const guardada = linhaDaChamada(
      evento({ caminho: '/v1/categoria/', status: 400, resultado: 'http', corpo }),
      OPCOES,
    ).linha;
    expect(guardada.versaoCredencial).toBe(String(VERSAO_MS));
    expect(guardada.trechoCorpo).toBe('{"detalhe":"<redacted>","codigo":"633"}');
  });

  it('a stored-credential error echoing a partial token under an undocumented key logs no fragment of it', () => {
    // The package scrubs only the token AS SENT; a code-shaped fragment under a
    // key no list names used to survive both the error walk and the catalogue text.
    const parcial = 'li-token-sentinela-AAAA';
    for (const caminho of ['/v1/pedido/search/', '/v1/categoria/', '/v1/situacao/']) {
      for (const [status, resultado] of [
        [400, 'http'],
        [404, 'nao-encontrado'],
        [422, 'http'],
        [429, 'limite'],
        [500, 'http'],
        [503, 'http'],
      ] as const) {
        for (const corpo of [
          JSON.stringify({ detalhe: parcial, codigo: 'x1' }),
          JSON.stringify({ erroInterno: { ref: parcial } }),
          JSON.stringify([{ chaveUsada: parcial }]),
        ]) {
          const { linha } = linhaDaChamada(evento({ caminho, status, resultado, corpo }), OPCOES);
          expect(linha.versaoCredencial).toBe(String(VERSAO_MS));
          expect(linha.trechoCorpo, `${caminho} ${String(status)} ${corpo}`).not.toBeNull();
          expect(JSON.stringify(linha), `${caminho} ${String(status)}`).not.toContain(parcial);
        }
      }
    }
  });

  it('a stored-credential error echoing a credential-shaped value under an ALLOWED key logs no fragment of it; a code survives', () => {
    // The allowed keys (codigo, code, erro, error, tipo, campo) keep a string only
    // when it is 1 to 7 digits; a 20-40 char token-shaped echo used to pass.
    const ecos = ['aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d', '3f9a1c7e5b2d8f4a6c0e9b1d'];
    for (const caminho of ['/v1/pedido/search/', '/v1/categoria/', '/v1/situacao/']) {
      for (const [status, resultado] of [
        [400, 'http'],
        [429, 'limite'],
        [500, 'http'],
      ] as const) {
        const corpo = JSON.stringify({
          codigo: ecos[0],
          error: [ecos[1]],
          tipo: [[ecos[0]]],
          code: '633',
        });
        const { linha } = linhaDaChamada(evento({ caminho, status, resultado, corpo }), OPCOES);
        const contexto = `${caminho} ${String(status)}`;
        for (const eco of ecos) expect(JSON.stringify(linha), contexto).not.toContain(eco);
        expect(linha.trechoCorpo, contexto).toBe(
          '{"codigo":"<redacted>","error":["<redacted>"],"tipo":[["<redacted>"]],"code":"633"}',
        );
      }
    }
  });

  it('a stored-credential error echoing a token as a KEY, or a word or a fraction under an allowed key, logs none of it; a numeric code survives', () => {
    // Round 3 on #1877: a key passed only the regex layer, and the code-word
    // grammar kept a first name, a full name, an e-mail local part and an
    // error NAME under the allowed keys, and any fraction below 1e7.
    const base62 = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d';
    const hex = '3f9a1c7e5b2d8f4a6c0e9b1d';
    const palavras = [
      'Joao',
      'JOAO_DA_SILVA',
      'joao.silva',
      'Unauthorized',
      'SLUG_IN_USE',
    ] as const;
    for (const caminho of ['/v1/pedido/search/', '/v1/categoria/', '/v1/situacao/']) {
      for (const [status, resultado] of [
        [400, 'http'],
        [429, 'limite'],
        [500, 'http'],
      ] as const) {
        const corpo = JSON.stringify({
          [base62]: 1,
          erro: { [hex]: palavras[0] },
          error: palavras[3],
          code: palavras[4],
          tipo: [palavras[1]],
          campo: palavras[2],
          codigo: '633',
          limite: 12.5,
        });
        const { linha } = linhaDaChamada(evento({ caminho, status, resultado, corpo }), OPCOES);
        const contexto = `${caminho} ${String(status)}`;
        const texto = JSON.stringify(linha);
        for (const eco of [base62, hex, ...palavras, '12.5']) {
          expect(texto, `${contexto} ${eco}`).not.toContain(eco);
        }
        expect(linha.trechoCorpo, contexto).toBe(
          '{"chave_redigida_1":1,"erro":{"chave_redigida_1":"<redacted>"},"error":"<redacted>","code":"<redacted>","tipo":["<redacted>"],"campo":"<redacted>","codigo":"633","limite":"<redacted>"}',
        );
      }
    }
  });

  it('a call with no response logs no body', () => {
    const { linha } = linhaDaChamada(
      evento({ status: null, corpo: null, resultado: 'rede' }),
      OPCOES,
    );
    expect(linha).toMatchObject({ trechoCorpo: null, corpoBytes: null, corpoForma: null });
  });
});

describe('severidadeDaChamada', () => {
  const RESULTADOS: readonly ChamadaLi['resultado'][] = [
    'ok',
    'cancelado',
    'nao-encontrado',
    'limite',
    'rede',
    'tempo-esgotado',
    'http',
    'schema',
    'auth',
    'inesperado',
  ];
  const STATUSES = [null, 200, 301, 404, 429, 500, 503];

  it.each(RESULTADOS.flatMap((r) => STATUSES.map((s) => [r, s] as const)))(
    '%s with status %s',
    (resultado, status) => {
      const esperada =
        resultado === 'ok' || resultado === 'cancelado'
          ? 'INFO'
          : ['nao-encontrado', 'limite', 'rede', 'tempo-esgotado'].includes(resultado)
            ? 'WARNING'
            : resultado === 'http' && status !== null && status >= 500
              ? 'WARNING'
              : 'ERROR';
      expect(severidadeDaChamada(resultado, status)).toBe(esperada);
    },
  );

  it('an unknown resultado (a newer package) is never INFO, DEBUG or WARNING', () => {
    // The exhaustive switch is the compile-time guard; at run time an arm the
    // switch does not know yields no severity (Cloud Logging's DEFAULT), which
    // is louder than INFO. Mapping it to INFO would hide it among the ok lines.
    const desconhecido = 'resultado-novo' as unknown as ChamadaLi['resultado'];
    for (const status of [null, 200, 404, 500]) {
      expect(['ERROR', undefined]).toContain(severidadeDaChamada(desconhecido, status));
    }
  });

  it('near-miss: http 3xx/4xx is an ERROR, http 5xx a WARNING', () => {
    expect(severidadeDaChamada('http', 302)).toBe('ERROR');
    expect(severidadeDaChamada('http', 499)).toBe('ERROR');
    expect(severidadeDaChamada('http', 500)).toBe('WARNING');
  });
});

describe('the sinks', () => {
  it('the default sink writes exactly ONE line, ending in \\n, that parses — severity first', () => {
    const stdout = espiarStdout();
    try {
      escritorPadrao('WARNING', 'mensagem', { a: 1, severity: 'INFO', message: 'outra' });
      const escritas = stdout.escritas();
      expect(escritas).toHaveLength(1);
      expect(escritas[0]?.endsWith('\n')).toBe(true);
      expect(escritas[0]?.split('\n')).toHaveLength(2);
      expect(JSON.parse(escritas[0] ?? '')).toEqual({
        severity: 'WARNING',
        message: 'mensagem',
        a: 1,
      });
    } finally {
      stdout.restaurar();
    }
  });

  it('a __proto__ campo is just a key', () => {
    const stdout = espiarStdout();
    try {
      const campos: Record<string, CampoLogLi> = Object.fromEntries([['__proto__', 1]]);
      escritorPadrao('INFO', 'm', campos);
      expect(stdout.escritas()[0]).toContain('"__proto__":1');
    } finally {
      stdout.restaurar();
    }
  });

  it('criarObservadorLi writes one line per call through the given sink', () => {
    const gravador = gravadorDeLog();
    const observar = criarObservadorLi({ ...OPCOES, escrever: gravador.escrever });
    observar(evento());
    observar(evento({ resultado: 'auth', status: 401 }));
    expect(gravador.linhas.map((l) => l.severidade)).toEqual(['INFO', 'ERROR']);
    expect(gravador.linhas[0]?.mensagem).toBe('[loja-integrada] buscarPedidos: 200 (ok)');
    expect(gravador.linhas[0]?.campos.conta).toBe('conta-li-1');
  });

  it('registrarEventoLi: the envelope, then primitive campos that cannot overwrite it', () => {
    const gravador = gravadorDeLog();
    registrarEventoLi(
      'valvula',
      'WARNING',
      { modo: 'off', conta: 'outra', evento: 'x' },
      { conta: null, fluxo: 'estoque', escrever: gravador.escrever },
    );
    expect(gravador.linhas).toEqual([
      {
        severidade: 'WARNING',
        mensagem: '[loja-integrada] valvula',
        campos: {
          evento: 'valvula',
          conta: null,
          fluxo: 'estoque',
          tentativa: null,
          idTarefa: null,
          idNotificacao: null,
          modo: 'off',
        },
      },
    ]);
  });

  it('CampoLogLi is primitives only — an object or a bigint does not compile', () => {
    const gravador = gravadorDeLog();
    const o = { conta: 'c', escrever: gravador.escrever };
    // @ts-expect-error — an object is not a CampoLogLi
    registrarEventoLi('valvula', 'INFO', { x: { a: 1 } }, o);
    // @ts-expect-error — a bigint is not a CampoLogLi
    registrarEventoLi('valvula', 'INFO', { x: 1n }, o);
    expect(gravador.linhas).toHaveLength(2);
  });
});

describe('the observer never throws', () => {
  const corpos: readonly (string | null)[] = [
    null,
    '',
    'null',
    '"x"',
    '[]',
    '<html>erro</html>',
    '{"a": ',
    `${'['.repeat(10_000)}${']'.repeat(10_000)}`,
    `[${Array(500_000).fill('1').join(',')}]`,
    `"${'x'.repeat(2 * 1024 * 1024)}"`,
  ];
  const caminhos = ['/v1/pedido/1', '/v1/situacao/', '/v1/produto/1', '/webhooks/v1/pedido'];
  const statuses = [200, 401, 429, 503, null];

  // Every body × class × status, through the whole observer: seconds on a loaded
  // CI runner, so the default timeout would turn load into a red test.
  it('over every body × class × status: exactly one line each', { timeout: 30_000 }, () => {
    const gravador = gravadorDeLog();
    const observar = criarObservadorLi({ conta: 'c', escrever: gravador.escrever });
    for (const corpo of corpos) {
      for (const caminho of caminhos) {
        for (const status of statuses) {
          expect(() => observar(evento({ caminho, status, corpo, query: [] }))).not.toThrow();
        }
      }
    }
    expect(gravador.linhas).toHaveLength(corpos.length * caminhos.length * statuses.length);
    for (const l of gravador.linhas) {
      expect(bytesUtf8(String(l.campos.trechoCorpo ?? ''))).toBeLessThanOrEqual(
        MAX_TRECHO_CORPO_BYTES,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                  The write engine's lines (step 7, PR 7-b)                 */
/* -------------------------------------------------------------------------- */

describe('serializarValorLi — the ONE way a structured value reaches a line, total', () => {
  it('EQUAL pair: a JSON value serialises exactly as JSON.stringify does', () => {
    const valores: readonly unknown[] = [
      null,
      true,
      0,
      -12.5,
      'PJ1BR',
      '',
      'aspas " e \\ barra',
      [],
      {},
      [1, 'a', null, { b: [true] }],
      { situacao: { codigo: 'pedido_pago' }, envios: [{ id: 801, objeto: null }] },
    ];
    for (const v of valores) expect(serializarValorLi(v)).toBe(JSON.stringify(v));
  });

  it('⚠️ NEAR-MISS: null, an empty string and an absent value stay distinct on the line', () => {
    expect(serializarValorLi(null)).toBe('null');
    expect(serializarValorLi('')).toBe('""');
    expect(serializarValorLi(undefined)).toBe('<ausente>');
    expect(serializarValorLi(1)).not.toBe(serializarValorLi('1'));
  });

  it('never throws: a cycle, a bigint, a function, a symbol, a non-finite number, depth 40, an accessor', () => {
    const ciclo: Record<string, unknown> = { a: 1 };
    ciclo.eu = ciclo;
    const lista: unknown[] = [1];
    lista.push(lista);
    let fundo: unknown = 'folha';
    for (let i = 0; i < 40; i++) fundo = { n: fundo };
    const comGetter = Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => {
        throw new TypeError('um getter nunca é chamado');
      },
    });
    expect(serializarValorLi(ciclo)).toBe('{"a":1,"eu":"<ciclo>"}');
    expect(serializarValorLi(lista)).toBe('[1,"<ciclo>"]');
    expect(serializarValorLi(10n)).toBe('<bigint>');
    expect(serializarValorLi({ x: 10n })).toBe('{"x":"<bigint>"}');
    expect(serializarValorLi(() => 1)).toBe('<nao-serializavel>');
    expect(serializarValorLi(Symbol('s'))).toBe('<nao-serializavel>');
    expect(serializarValorLi({ n: Number.NaN, i: Infinity })).toBe(
      '{"n":"<nao-serializavel>","i":"<nao-serializavel>"}',
    );
    expect(serializarValorLi(comGetter)).toBe('{"x":"<nao-serializavel>"}');
    expect(() => serializarValorLi(fundo)).not.toThrow();
    expect(serializarValorLi(fundo)).toContain('"<fundo>"');
    // The same object twice, side by side, is not a cycle.
    const comum = { c: 1 };
    expect(serializarValorLi([comum, comum])).toBe('[{"c":1},{"c":1}]');
  });

  it('a value inside an array that is absent is marked, never read as null', () => {
    expect(serializarValorLi([undefined, null])).toBe('["<ausente>",null]');
    // A key whose value is absent is absent, as in JSON.
    expect(serializarValorLi({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('linhaSerializadaLi — the exact text of a line, shared by the sink and the size check', () => {
  it('is what the default sink writes, minus the newline', () => {
    const stdout = espiarStdout();
    try {
      const campos = { a: 1, b: 'x', severity: 'INFO', message: 'outra' };
      escritorPadrao('WARNING', 'mensagem', campos);
      expect(stdout.escritas()).toEqual([`${linhaSerializadaLi('WARNING', 'mensagem', campos)}\n`]);
      expect(linhaSerializadaLi('WARNING', 'mensagem', campos)).toBe(
        '{"severity":"WARNING","message":"mensagem","a":1,"b":"x"}',
      );
    } finally {
      stdout.restaurar();
    }
  });
});

const REGISTRO = { conta: 'conta-li-1', fluxo: 'rastreio', tentativa: 2, idTarefa: 't-7' };

describe('registrarRestauracaoLi — the restore snapshot, capped on the EXACT line', () => {
  const restauracao = (chave: string) => ({
    recurso: 165,
    caminho: '/v1/pedido/165/',
    status: 200,
    corpo: { numero: 165, [chave]: null },
  });

  function bytesDaLinha(chave: string): number {
    const gravador = gravadorDeLog();
    registrarRestauracaoLi(restauracao(chave), { ...REGISTRO, escrever: gravador.escrever });
    const l = gravador.linhas[0];
    if (l === undefined) throw new TypeError('nenhuma linha');
    return bytesUtf8(linhaSerializadaLi(l.severidade, l.mensagem, l.campos));
  }

  it('one INFO line: the envelope, then the redacted path, the status and the serialised body', () => {
    const gravador = gravadorDeLog();
    const r = registrarRestauracaoLi(restauracao('extra'), {
      ...REGISTRO,
      escrever: gravador.escrever,
    });
    expect(r.escrita).toBe(true);
    expect(gravador.linhas).toEqual([
      {
        severidade: 'INFO',
        mensagem: '[loja-integrada] restauracao',
        campos: {
          evento: 'restauracao',
          conta: 'conta-li-1',
          fluxo: 'rastreio',
          tentativa: 2,
          idTarefa: 't-7',
          idNotificacao: null,
          recurso: 165,
          caminho: '/v1/pedido/165/',
          status: 200,
          politica: 'estrutural',
          corpo: '{"numero":165,"extra":null}',
        },
      },
    ]);
    expect(r.bytes).toBe(bytesDaLinha('extra'));
  });

  it('EQUAL pair: a line of EXACTLY 200 KB (UTF-8, the line as the sink writes it) is written', () => {
    const base = bytesDaLinha('');
    const chave = 'a'.repeat(MAX_LINHA_RESTAURACAO_BYTES - base);
    expect(bytesDaLinha(chave)).toBe(MAX_LINHA_RESTAURACAO_BYTES);
    const gravador = gravadorDeLog();
    const r = registrarRestauracaoLi(restauracao(chave), {
      ...REGISTRO,
      escrever: gravador.escrever,
    });
    expect(r).toEqual({ escrita: true, bytes: MAX_LINHA_RESTAURACAO_BYTES });
    expect(gravador.linhas).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: one byte more is NOT written — never truncated, nothing at all', () => {
    expect(MAX_LINHA_RESTAURACAO_BYTES).toBe(200 * 1024);
    const base = bytesDaLinha('');
    const chave = 'a'.repeat(MAX_LINHA_RESTAURACAO_BYTES - base + 1);
    const gravador = gravadorDeLog();
    const r = registrarRestauracaoLi(restauracao(chave), {
      ...REGISTRO,
      escrever: gravador.escrever,
    });
    expect(r).toEqual({ escrita: false, bytes: MAX_LINHA_RESTAURACAO_BYTES + 1 });
    expect(gravador.linhas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a multi-byte character counts its UTF-8 bytes, not its UTF-16 units', () => {
    const base = bytesDaLinha('');
    // `ã` is ONE UTF-16 unit and TWO UTF-8 bytes: half as many fill the line.
    const chave = 'ã'.repeat(Math.floor((MAX_LINHA_RESTAURACAO_BYTES - base) / 2) + 1);
    expect(chave.length).toBeLessThan(MAX_LINHA_RESTAURACAO_BYTES - base);
    const gravador = gravadorDeLog();
    expect(
      registrarRestauracaoLi(restauracao(chave), { ...REGISTRO, escrever: gravador.escrever })
        .escrita,
    ).toBe(false);
    expect(gravador.linhas).toEqual([]);
  });
});

describe('registrarDiffLi — one line per field, and a so-mudou field never logs its value', () => {
  it('`valor`: before and after through the serialiser, with the decision motivo', () => {
    const gravador = gravadorDeLog();
    registrarDiffLi(
      {
        recurso: 165,
        tipo: 'objeto-envio',
        campo: 'objeto',
        politica: 'valor',
        antes: null,
        depois: 'PJ1BR',
        mudou: true,
        motivo: 'fora-do-canario',
      },
      { ...REGISTRO, escrever: gravador.escrever },
    );
    expect(gravador.linhas).toEqual([
      {
        severidade: 'INFO',
        mensagem: '[loja-integrada] diff',
        campos: {
          evento: 'diff',
          conta: 'conta-li-1',
          fluxo: 'rastreio',
          tentativa: 2,
          idTarefa: 't-7',
          idNotificacao: null,
          recurso: 165,
          tipo: 'objeto-envio',
          campo: 'objeto',
          politica: 'valor',
          antes: 'null',
          depois: '"PJ1BR"',
          mudou: true,
          motivo: 'fora-do-canario',
        },
      },
    ]);
  });

  it('`valor`: an ABSENT before is `<ausente>`, never `null`', () => {
    const gravador = gravadorDeLog();
    registrarDiffLi(
      {
        recurso: 165,
        tipo: 'objeto-envio',
        campo: 'objeto',
        politica: 'valor',
        antes: undefined,
        depois: 'PJ1BR',
        mudou: true,
        motivo: 'valvula',
      },
      { ...REGISTRO, escrever: gravador.escrever },
    );
    expect(gravador.linhas[0]?.campos.antes).toBe('<ausente>');
  });

  it('`so-mudou`: no value on the line, only whether it changed', () => {
    const gravador = gravadorDeLog();
    registrarDiffLi(
      {
        recurso: 165,
        tipo: 'teste',
        campo: 'token',
        politica: 'so-mudou',
        antes: 'SEGREDO-ANTES',
        depois: 'SEGREDO-DEPOIS',
        mudou: true,
        motivo: 'valvula',
      },
      { ...REGISTRO, escrever: gravador.escrever },
    );
    expect(JSON.stringify(gravador.linhas)).not.toContain('SEGREDO');
    expect(gravador.linhas[0]?.campos).toMatchObject({
      antes: null,
      depois: null,
      mudou: true,
      politica: 'so-mudou',
    });
  });
});

describe('registrarEscritaLi and registrarDerivaLi', () => {
  it('each sequence outcome has its severity: WARNING for a write without its effect or a retried refusal', () => {
    expect(SEVERIDADE_DA_ESCRITA_LI).toEqual({
      aplicada: 'INFO',
      pendente: 'INFO',
      'efeito-observado': 'INFO',
      'efeito-pendente': 'INFO',
      'objeto-sem-efeito': 'WARNING',
      'objeto-nao-enviado': 'INFO',
      'recusada-retentativa': 'WARNING',
    });
  });

  it('an escrita line carries ids, the outcome and the status — never an echo body', () => {
    const gravador = gravadorDeLog();
    registrarEscritaLi(
      {
        recurso: 165,
        tipo: 'situacao-pedido',
        campo: 'codigo',
        resultado: 'recusada-retentativa',
        status: 403,
        aplicada: null,
        leituraEco: null,
      },
      { ...REGISTRO, escrever: gravador.escrever },
    );
    expect(gravador.linhas).toEqual([
      {
        severidade: 'WARNING',
        mensagem: '[loja-integrada] escrita',
        campos: {
          evento: 'escrita',
          conta: 'conta-li-1',
          fluxo: 'rastreio',
          tentativa: 2,
          idTarefa: 't-7',
          idNotificacao: null,
          recurso: 165,
          tipo: 'situacao-pedido',
          campo: 'codigo',
          resultado: 'recusada-retentativa',
          status: 403,
          aplicada: null,
          leituraEco: null,
        },
      },
    ]);
  });

  it('a deriva line is a WARNING with what was written and what was read back', () => {
    const gravador = gravadorDeLog();
    registrarDerivaLi(
      {
        recurso: 165,
        tipo: 'objeto-envio',
        campo: 'objeto',
        politica: 'valor',
        escrito: 'PJ1BR',
        lido: 'OUTRO1BR',
      },
      { ...REGISTRO, escrever: gravador.escrever },
    );
    expect(gravador.linhas[0]).toMatchObject({
      severidade: 'WARNING',
      mensagem: '[loja-integrada] deriva',
      campos: { evento: 'deriva', escrito: '"PJ1BR"', lido: '"OUTRO1BR"', campo: 'objeto' },
    });
    const soMudou = gravadorDeLog();
    registrarDerivaLi(
      {
        recurso: 165,
        tipo: 'teste',
        campo: 'token',
        politica: 'so-mudou',
        escrito: 'SEGREDO-A',
        lido: 'SEGREDO-B',
      },
      { ...REGISTRO, escrever: soMudou.escrever },
    );
    expect(JSON.stringify(soMudou.linhas)).not.toContain('SEGREDO');
  });
});

describe('the observer never throws on a WRITE (PUT) event', () => {
  // A write client's observer runs after the outcome is known: a throw would
  // reject a write that LANDED (the package's `escrita.ts`). So it must be total
  // on every PUT answer the package can report.
  const casos: readonly [string, Partial<ChamadaLi>][] = [
    [
      'a 2xx echo',
      { status: 200, resultado: 'ok', corpo: '{"id":801,"objeto":"PJ258408772BR","prazo":5}' },
    ],
    ['a 2xx with an EMPTY echo', { status: 204, resultado: 'ok', corpo: '' }],
    ['a 202 with an HTML echo', { status: 202, resultado: 'ok', corpo: '<html>aceito</html>' }],
    ['a malformed echo', { status: 200, resultado: 'ok', corpo: '{"id": 8' }],
    [
      'a 2xx whose echo was CUT by the deadline',
      { status: 200, resultado: 'tempo-esgotado', corpo: null },
    ],
    [
      'a 2xx whose echo was cut by a dropped connection',
      { status: 200, resultado: 'rede', corpo: null },
    ],
    ['a 403 refusal', { status: 403, resultado: 'auth', corpo: '{"error":"forbidden"}' }],
    ['a 302', { status: 302, resultado: 'http', corpo: '' }],
  ];
  const caminhos = ['/v1/pedido_envio/801', '/v1/situacao/pedido/165'];

  it.each(casos)('%s: exactly one line, labelled PUT', (_caso, over) => {
    for (const caminho of caminhos) {
      const gravador = gravadorDeLog();
      const observar = criarObservadorLi({ ...OPCOES, escrever: gravador.escrever });
      expect(() =>
        observar(evento({ ...over, metodo: 'PUT', operacao: 'escrita', caminho, query: [] })),
      ).not.toThrow();
      expect(gravador.linhas).toHaveLength(1);
      expect(gravador.linhas[0]?.campos).toMatchObject({ metodo: 'PUT', caminho });
    }
  });
});
