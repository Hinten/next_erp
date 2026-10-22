import { afterEach, describe, expect, it, vi } from 'vitest';

import { gerarCpf, pontuarCpf } from '../testing/documentos';
import {
  REF_VERSIONADA,
  type EventoDeChamada,
  espiarStdout,
  eventoDeChamada,
  loggerEspiao,
} from '../testing/fixtures';
import { AGENTE_USUARIO_AMAZON } from './agente';
import { REF_CONSENTIMENTO } from './formatoDaRef';
import {
  CHAVES_DA_LINHA,
  INVALIDO,
  LOGGER_STDOUT_AMAZON,
  MAX_CAMPO_TEXTO_BYTES,
  MAX_TRECHO_CORPO_BYTES,
  NAO_PRIMITIVO,
  type CamposLogAmazon,
  type OpcoesObservadorAmazon,
  camposSeguros,
  criarObservadorAmazon,
  linhaDaChamada,
  registrarEventoAmazon,
  severidadeDaChamada,
  warnNaoTipado,
} from './log';
import { LIMITE_ANALISE_BYTES, bytesUtf8, mascararTexto } from './redacao';

afterEach(() => {
  vi.restoreAllMocks();
});

const CPF = gerarCpf('123456789');
const CPF_PONTUADO = pontuarCpf(CPF);
const CONTA = 'conta-1';
const FINGERPRINT = REF_VERSIONADA.split('.')[0] ?? '';
/** An LWA-shaped access token: what a 401/403 may echo. */
const TOKEN = 'Atza|IwEBIAbcDefGhiJklMnoPqrStuVwxYzAbcDefGhiJkl0123456789';
const GET_ORDER = '/orders/2026-01-01/orders/123-4567890-1234567';
const DESCONHECIDO = '/algo/2030-01-01/coisa';

function opcoes(over: Partial<OpcoesObservadorAmazon> = {}): OpcoesObservadorAmazon {
  return { logger: loggerEspiao().logger, conta: CONTA, ...over };
}

const linha = (e: Partial<EventoDeChamada>, o: Partial<OpcoesObservadorAmazon> = {}) =>
  linhaDaChamada(eventoDeChamada(e), opcoes(o)).linha;

describe('the call line is a projection', () => {
  it('★ has EXACTLY the 26 keys of CHAVES_DA_LINHA, in order, and every value is a primitive', () => {
    expect(CHAVES_DA_LINHA).toHaveLength(26);
    const l = linha({});
    expect(Object.keys(l)).toEqual([...CHAVES_DA_LINHA]);
    for (const [k, v] of Object.entries(l)) {
      expect(v === null || ['string', 'number', 'boolean'].includes(typeof v), k).toBe(true);
    }
  });

  it('★ never carries the raw query, the body text, a header, the ref or its fingerprint', () => {
    const l = linha({
      query: [
        ['nextToken', 'CURSOR-SENTINELA-QUERY'],
        ['buyerName', 'NOME-SENTINELA-QUERY'],
      ],
      corpo: JSON.stringify({
        order: { segredo: 'SENTINELA-DO-CORPO', orderId: '123-4567890-1234567' },
      }),
    });
    const texto = JSON.stringify(l);
    for (const proibido of [
      'CURSOR-SENTINELA-QUERY',
      'NOME-SENTINELA-QUERY',
      'SENTINELA-DO-CORPO',
      AGENTE_USUARIO_AMAZON,
      REF_VERSIONADA,
      FINGERPRINT,
    ]) {
      expect(texto, proibido).not.toContain(proibido);
    }
    // Anti-vacuity: the structure of the body IS there.
    expect(l.trechoCorpo).toContain('"orderId":"123-4567890-1234567"');
    expect(l.caminho).toBe(`${GET_ORDER}?nextToken=<token len=22>&buyerName=<redacted>`);
  });

  it('carries the version of the ref, as a number, and the credential kind', () => {
    const l = linha({});
    expect(l.versaoCredencial).toBe(Number(REF_VERSIONADA.split('.')[1]));
    expect(l.credencial).toBe('lwa-acesso');
    expect(linha({ destino: 'lwa', corpo: null }).credencial).toBe('lwa-refresh');
    expect(linha({ destino: 'lwa', corpo: null, refCredencial: REF_CONSENTIMENTO })).toMatchObject({
      credencial: 'lwa-codigo',
      versaoCredencial: null,
    });
  });
});

describe('the excerpt: mask first, cut second', () => {
  it('★ a CPF straddling byte 2048 never appears even partially', () => {
    // `{"order":{"<chave>":"<redacted>","orderItems":[{"product":{"sellerSku":"<CPF>"}}]}}`
    const antes = '{"order":{"';
    const depois = '":"<redacted>","orderItems":[{"product":{"sellerSku":"';
    const n = MAX_TRECHO_CORPO_BYTES - 7 - antes.length - depois.length;
    const chave = 'a '.repeat(Math.ceil(n / 2)).slice(0, n);
    const corpo = {
      order: { [chave]: 1, orderItems: [{ product: { sellerSku: CPF_PONTUADO } }] },
    };
    // Anti-vacuity: unmasked, the CPF would start 7 bytes before the cut.
    expect(`${antes}${chave}${depois}`.length).toBe(MAX_TRECHO_CORPO_BYTES - 7);
    const l = linha({ corpo: JSON.stringify(corpo) });
    expect(l.corpoTruncado).toBe(true);
    expect(l.trechoCorpo).not.toContain(CPF_PONTUADO.slice(0, 5));
    expect(l.mascarados).toBeGreaterThan(0);
  });

  it('★ a 4-byte character at the cut edge is never split', () => {
    const antes = '{"';
    const n = MAX_TRECHO_CORPO_BYTES - 2 - antes.length;
    const chave = `${'a '.repeat(Math.ceil(n / 2)).slice(0, n)}😀resto`;
    const l = linha({ caminho: DESCONHECIDO, corpo: JSON.stringify({ [chave]: 1 }) });
    const t = l.trechoCorpo ?? '';
    expect(l.corpoTruncado).toBe(true);
    expect(bytesUtf8(t)).toBeLessThanOrEqual(MAX_TRECHO_CORPO_BYTES);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(t)).toBe(false);
    expect(t.endsWith('a') || t.endsWith(' ')).toBe(true);
  });

  it('★ near-miss: an excerpt of exactly 2048 bytes is NOT truncated; 2049 is', () => {
    // `{"<chave>":"<redacted>"}` is the key plus 17 bytes.
    const exato = (bytes: number) => {
      const n = bytes - 17;
      return { ['a '.repeat(Math.ceil(n / 2)).slice(0, n)]: 1 };
    };
    const igual = linha({ caminho: DESCONHECIDO, corpo: JSON.stringify(exato(2048)) });
    expect(bytesUtf8(igual.trechoCorpo ?? '')).toBe(2048);
    expect(igual.corpoTruncado).toBe(false);
    const maior = linha({ caminho: DESCONHECIDO, corpo: JSON.stringify(exato(2049)) });
    expect(maior.corpoTruncado).toBe(true);
    expect(bytesUtf8(maior.trechoCorpo ?? '')).toBe(2048);
  });
});

describe('the excerpt fails closed', () => {
  const ecos = [
    ['the whole token', `{"errors":[{"code":"Unauthorized","message":"${TOKEN}"}]}`],
    ['the token URL-encoded', `{"m":"${encodeURIComponent(TOKEN)}"}`],
    ['the token JSON-escaped', `{"m":"${TOKEN.replace('|', '\\u007c')}"}`],
    ['the token HTML-escaped', `<p>${TOKEN.replace('|', '&#124;')}</p>`],
    ['a 12-character fragment', `{"m":"${TOKEN.slice(10, 22)}"}`],
    ['the token as a KEY', `{"${TOKEN.slice(5, 30).replace(/[^A-Za-z]/g, '')}":true}`],
    ['a credential-shaped string', '{"access_token":"tok-qualquer","Authorization":"Bearer x"}'],
  ] as const;

  it.each(
    ecos.flatMap(([nome, corpo]) =>
      [401, 403].flatMap((status) =>
        (['sp-api', 'lwa'] as const).flatMap((destino) =>
          [GET_ORDER, DESCONHECIDO, '/sellers/v1/marketplaceParticipations'].map(
            (caminho) => [nome, status, destino, caminho, corpo] as const,
          ),
        ),
      ),
    ),
  )('★ no excerpt on %s, %i, %s, %s', (_n, status, destino, caminho, corpo) => {
    const l = linha({ status, destino, caminho, corpo, resultado: 'auth' });
    expect(l.trechoCorpo).toBeNull();
    expect(l.corpoForma).toBeNull();
    const texto = JSON.stringify(l);
    expect(texto).not.toContain(TOKEN.slice(5, 17));
    expect(texto).not.toContain(TOKEN.slice(5, 30).replace(/[^A-Za-z]/g, ''));
  });

  it('★ near-miss: a 400 with the same body excerpts the STRUCTURE only, with no fragment of a value', () => {
    for (const [nome, corpo] of ecos) {
      if (nome === 'the token as a KEY') continue;
      const l = linha({ status: 400, corpo, resultado: 'http' });
      const texto = JSON.stringify(l);
      expect(texto, nome).not.toContain(TOKEN.slice(10, 22));
      expect(texto, nome).not.toContain(encodeURIComponent(TOKEN).slice(5, 17));
    }
    const l = linha({ status: 400, corpo: ecos[0][1], resultado: 'http' });
    expect(l.trechoCorpo).toBe('{"errors":[{"code":"Unauthorized","message":"<redacted>"}]}');
  });

  it('the accepted residual: a letters-only KEY survives a 400 error walk — the reason 401/403 is never excerpted', () => {
    const chave = TOKEN.slice(5, 30).replace(/[^A-Za-z]/g, '');
    expect(linha({ status: 400, corpo: `{"${chave}":true}`, resultado: 'http' }).trechoCorpo).toBe(
      `{"${chave}":true}`,
    );
    expect(
      linha({ status: 401, corpo: `{"${chave}":true}`, resultado: 'auth' }).trechoCorpo,
    ).toBeNull();
  });

  it('★ a candidate credential (no ref version) gives no excerpt on a 200; near-miss: a versioned ref is excerpted', () => {
    const corpo = JSON.stringify({ order: { orderId: '123-4567890-1234567' } });
    for (const refCredencial of [REF_CONSENTIMENTO, 'malformada', '']) {
      const l = linha({ corpo, refCredencial });
      expect(l.versaoCredencial, refCredencial).toBeNull();
      expect(l.trechoCorpo, refCredencial).toBeNull();
    }
    expect(linha({ corpo }).trechoCorpo).toBe('{"order":{"orderId":"123-4567890-1234567"}}');
  });

  it('★ a segredo path gives no excerpt on a 200 (the RDT); near-miss: an unknown path gives keys only', () => {
    const rdt = linha({
      caminho: '/tokens/2021-03-01/restrictedDataToken',
      corpo: '{"restrictedDataToken":"Atz.sprdt|segredo","expiresIn":3600}',
    });
    expect(rdt).toMatchObject({ politica: 'segredo', trechoCorpo: null, corpoForma: null });
    const desconhecido = linha({ caminho: DESCONHECIDO, corpo: '{"restrictedValue":"x","n":1}' });
    expect(desconhecido.trechoCorpo).toBe('{"restrictedValue":"<redacted>","n":"<redacted>"}');
  });

  it('an LWA call has no excerpt and no byte count, even if a body slipped through', () => {
    expect(linha({ destino: 'lwa', corpo: '{"access_token":"x"}', status: 200 })).toMatchObject({
      trechoCorpo: null,
      corpoBytes: null,
      corpoForma: null,
    });
  });

  it('the other forms: empty, too big, not JSON', () => {
    expect(linha({ corpo: '' })).toMatchObject({ corpoForma: 'vazio', trechoCorpo: null });
    expect(linha({ corpo: null, status: null, resultado: 'rede' })).toMatchObject({
      corpoForma: 'vazio',
      corpoBytes: null,
    });
    expect(linha({ corpo: '<html>Maria</html>' })).toMatchObject({
      corpoForma: 'texto',
      trechoCorpo: null,
    });
    const grande = `{"a":"${'x'.repeat(LIMITE_ANALISE_BYTES.log)}"}`;
    expect(linha({ corpo: grande })).toMatchObject({ corpoForma: 'grande', trechoCorpo: null });
  });
});

describe('severidadeDaChamada — LI table verbatim', () => {
  it.each([
    ['ok', 200, 'INFO'],
    ['cancelado', null, 'INFO'],
    ['nao-encontrado', 404, 'WARNING'],
    ['limite', 429, 'WARNING'],
    ['rede', null, 'WARNING'],
    ['tempo-esgotado', null, 'WARNING'],
    ['http', 500, 'WARNING'],
    ['http', 503, 'WARNING'],
    ['http', 302, 'ERROR'],
    ['http', 400, 'ERROR'],
    ['http', 413, 'ERROR'],
    ['http', null, 'ERROR'],
    ['schema', 200, 'ERROR'],
    ['auth', 401, 'ERROR'],
    ['inesperado', null, 'ERROR'],
    ['desconhecido', 200, 'ERROR'],
  ] as const)('★ %s / %s → %s', (resultado, status, sev) => {
    expect(severidadeDaChamada(resultado, status)).toBe(sev);
  });

  it('the observer writes through the method the severity names', () => {
    const { logger, linhas } = loggerEspiao();
    const observar = criarObservadorAmazon({ logger, conta: CONTA });
    observar(eventoDeChamada({ resultado: 'ok' }));
    observar(eventoDeChamada({ resultado: 'limite', status: 429 }));
    observar(eventoDeChamada({ resultado: 'auth', status: 403 }));
    expect(linhas.map((l) => l.nivel)).toEqual(['info', 'warn', 'error']);
    expect(linhas[0]?.mensagem).toBe('[amazon] getOrder: 200 (ok)');
    observar(eventoDeChamada({ resultado: 'rede', status: null }));
    expect(linhas[3]?.mensagem).toBe('[amazon] getOrder: sem-resposta (rede)');
  });
});

describe('codigosErro', () => {
  it('★ a known code is kept; a name, an e-mail and a token-shaped code become <outro>; duplicates collapse; [] → null', () => {
    expect(linha({ codigosErro: ['InvalidInput'] }).codigosErro).toBe('InvalidInput');
    expect(
      linha({
        codigosErro: ['Maria', 'a@b.co', TOKEN.slice(0, 40), 'InvalidInput', 'InvalidInput'],
      }).codigosErro,
    ).toBe('<outro>,InvalidInput');
    expect(linha({ codigosErro: [] }).codigosErro).toBeNull();
    expect(JSON.stringify(linha({ codigosErro: ['Maria'] }))).not.toContain('Maria');
  });

  it('codigoLwa goes through the closed union', () => {
    expect(linha({ destino: 'lwa', codigoLwa: 'invalid_grant' }).codigoLwa).toBe('invalid_grant');
    expect(linha({ codigoLwa: 'Maria' as never }).codigoLwa).toBe(INVALIDO);
  });
});

describe('the envelope', () => {
  it('★ each value through its grammar: a malformed idTarefa gives <invalido>', () => {
    const l = linha(
      {},
      {
        fluxo: 'intake',
        tentativa: 3,
        idTarefa: 'tarefa com espaço',
        idNotificacao: 'n-1',
      },
    );
    expect(l).toMatchObject({
      conta: CONTA,
      fluxo: 'intake',
      tentativa: 3,
      idTarefa: INVALIDO,
      idNotificacao: 'n-1',
    });
    expect(linha({}, { conta: 'a/b' }).conta).toBe(INVALIDO);
    expect(linha({}, { fluxo: 'Intake' }).fluxo).toBe(INVALIDO);
    expect(linha({}, { tentativa: 1001 }).tentativa).toBeNull();
    expect(linha({}, { tentativa: -1 }).tentativa).toBeNull();
    expect(linha({}, { tentativa: 1.5 }).tentativa).toBeNull();
    expect(linha({}, { tentativa: 1000 }).tentativa).toBe(1000);
  });

  it('★ a registro carrying conta (cast at run time) cannot relabel the line when conta comes LAST', () => {
    const registro = { conta: 'outra', fluxo: 'intake' } as never as Record<string, unknown>;
    const { logger, linhas } = loggerEspiao();
    criarObservadorAmazon({ ...registro, logger, conta: CONTA })(eventoDeChamada({}));
    expect(linhas[0]?.meta?.conta).toBe(CONTA);
    expect(linhas[0]?.meta?.fluxo).toBe('intake');
  });

  it('the event fields the package constrains are re-checked too (an unknown operation, method or outcome)', () => {
    const l = linha({
      operacao: 'op com espaço',
      metodo: 'TRACE' as never,
      resultado: 'novo' as never,
      destino: 'outro' as never,
      correlationId: 'id com espaço',
    });
    expect(l).toMatchObject({
      operacao: INVALIDO,
      metodo: INVALIDO,
      resultado: INVALIDO,
      destino: INVALIDO,
      correlationId: INVALIDO,
      credencial: INVALIDO,
    });
  });
});

describe('registrarEventoAmazon', () => {
  it('writes the envelope LAST: a campo named like it is dropped', () => {
    const { logger, linhas } = loggerEspiao();
    registrarEventoAmazon(
      logger,
      'chamada-bloqueada',
      'WARNING',
      'msg',
      { evento: 'forjado', conta: 'forjada', rota: 'r' },
      { conta: CONTA, fluxo: 'intake' },
    );
    expect(linhas).toEqual([
      {
        nivel: 'warn',
        mensagem: 'msg',
        meta: { rota: 'r', evento: 'chamada-bloqueada', conta: CONTA, fluxo: 'intake' },
      },
    ]);
  });

  it('writes only the envelope keys it was given', () => {
    const { logger, linhas } = loggerEspiao();
    registrarEventoAmazon(logger, 'chamada-bloqueada', 'INFO', 'm', { x: 1 });
    expect(linhas[0]?.meta).toEqual({ x: 1, evento: 'chamada-bloqueada' });
    expect(linhas[0]?.nivel).toBe('info');
  });

  it.each(['tarefa', 'varredura', 'notificacao'] as const)(
    'step 3 adds `%s`: written as given, with its envelope',
    (evento) => {
      const { logger, linhas } = loggerEspiao();
      registrarEventoAmazon(logger, evento, 'INFO', 'm', { x: 1 }, { fluxo: 'intake' });
      expect(linhas[0]?.meta).toEqual({ x: 1, evento, fluxo: 'intake' });
    },
  );

  it('step 4 adds `poll`: written as given, with its envelope', () => {
    const { logger, linhas } = loggerEspiao();
    registrarEventoAmazon(logger, 'poll', 'INFO', 'm', { x: 1 }, { conta: CONTA, fluxo: 'poll' });
    expect(linhas[0]?.meta).toEqual({ x: 1, evento: 'poll', conta: CONTA, fluxo: 'poll' });
  });

  it('step 20 adds `int-frete`: written as given, with its `conta` envelope', () => {
    const { logger, linhas } = loggerEspiao();
    registrarEventoAmazon(
      logger,
      'int-frete',
      'WARNING',
      'm',
      { acao: 'incompleto' },
      { conta: CONTA },
    );
    expect(linhas).toEqual([
      {
        nivel: 'warn',
        mensagem: 'm',
        meta: { acao: 'incompleto', evento: 'int-frete', conta: CONTA },
      },
    ]);
  });

  it('an evento outside the closed set is <invalido> (near-misses of the step-3, step-4 and step-20 names)', () => {
    const { logger, linhas } = loggerEspiao();
    registrarEventoAmazon(logger, 'tarefas' as never, 'INFO', 'm', {});
    registrarEventoAmazon(logger, 'notificacoes' as never, 'INFO', 'm', {});
    registrarEventoAmazon(logger, 'polls' as never, 'INFO', 'm', {});
    registrarEventoAmazon(logger, 'pollPedidos' as never, 'INFO', 'm', {});
    registrarEventoAmazon(logger, 'intFrete' as never, 'INFO', 'm', {});
    registrarEventoAmazon(logger, 'int_frete' as never, 'INFO', 'm', {});
    registrarEventoAmazon(logger, 'frete' as never, 'INFO', 'm', {});
    expect(linhas.map((l) => l.meta?.evento)).toEqual([
      INVALIDO,
      INVALIDO,
      INVALIDO,
      INVALIDO,
      INVALIDO,
      INVALIDO,
      INVALIDO,
    ]);
  });

  it('is never a call line: a cast `chamada` becomes <invalido>, and a trechoCorpo campo is dropped', () => {
    const { logger, linhas } = loggerEspiao();
    registrarEventoAmazon(logger, 'chamada' as never, 'INFO', 'm', {
      trechoCorpo: '11222333000181',
      x: 1,
    });
    expect(linhas[0]?.meta).toEqual({ x: 1, evento: INVALIDO });
  });
});

describe('the sink (LOGGER_STDOUT_AMAZON)', () => {
  function escrito(acao: () => void): Record<string, unknown>[] {
    const out = espiarStdout();
    acao();
    const linhas = out.linhas();
    out.restaurar();
    for (const l of linhas) {
      expect(l.endsWith('\n')).toBe(true);
      expect(l.split('\n')).toHaveLength(2);
    }
    return linhas.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('★ one parseable JSON line per call, with Cloud Logging severity', () => {
    expect(
      escrito(() => {
        LOGGER_STDOUT_AMAZON.info('a', { x: 1 });
        LOGGER_STDOUT_AMAZON.warn('b');
        LOGGER_STDOUT_AMAZON.error('c', { y: null, z: true });
      }),
    ).toEqual([
      { x: 1, severity: 'INFO', message: 'a' },
      { severity: 'WARNING', message: 'b' },
      { y: null, z: true, severity: 'ERROR', message: 'c' },
    ]);
  });

  it('★ a severity or message campo can NEVER overwrite either', () => {
    const [l] = escrito(() => {
      LOGGER_STDOUT_AMAZON.warn('verdadeira', { severity: 'DEBUG', message: 'forjada' });
    });
    expect(l).toMatchObject({ severity: 'WARNING', message: 'verdadeira' });
  });

  it('★ a __proto__ campo is just a key', () => {
    const [l] = escrito(() => {
      LOGGER_STDOUT_AMAZON.info('m', JSON.parse('{"__proto__":"x","a":1}') as never);
    });
    expect(Object.keys(l ?? {})).toContain('__proto__');
    expect(Object.getPrototypeOf(l)).toBe(Object.prototype);
  });

  it('★ an object, bigint, function, symbol or cycle given to the untyped warn gives <nao-primitivo>, without throwing', () => {
    const ciclo: Record<string, unknown> = {};
    ciclo.eu = ciclo;
    const [l] = escrito(() => {
      warnNaoTipado(LOGGER_STDOUT_AMAZON).warn('m', {
        objeto: { a: 1 },
        grande: 10n,
        funcao: () => 1,
        simbolo: Symbol('s'),
        ciclo,
        indefinido: undefined,
        infinito: Number.POSITIVE_INFINITY,
      });
    });
    expect(l).toEqual({
      objeto: NAO_PRIMITIVO,
      grande: NAO_PRIMITIVO,
      funcao: NAO_PRIMITIVO,
      simbolo: NAO_PRIMITIVO,
      ciclo: NAO_PRIMITIVO,
      infinito: null,
      severity: 'WARNING',
      message: 'm',
    });
    // The sink alone, bypassing the adapter (escreverAviso's own call shape): the same.
    const [direto] = escrito(() => {
      LOGGER_STDOUT_AMAZON.warn('m', { grande: 10n, ciclo } as never);
    });
    expect(direto).toMatchObject({ grande: NAO_PRIMITIVO, ciclo: NAO_PRIMITIVO });
  });

  it('★ a 10 KB campo string is cut to 256 bytes; the message too', () => {
    const [l] = escrito(() => {
      LOGGER_STDOUT_AMAZON.info('x '.repeat(5000), { longo: 'y '.repeat(5000) });
    });
    expect(bytesUtf8(String(l?.longo))).toBe(MAX_CAMPO_TEXTO_BYTES);
    expect(bytesUtf8(String(l?.message))).toBe(MAX_CAMPO_TEXTO_BYTES);
  });

  it('★ a CPF inside a campo string (or the message) is masked', () => {
    const [l] = escrito(() => {
      LOGGER_STDOUT_AMAZON.warn(`falhou ${CPF}`, { erro: `cpf ${CPF_PONTUADO} e ${CPF}` });
    });
    expect(JSON.stringify(l)).not.toContain(CPF);
    expect(JSON.stringify(l)).not.toContain(CPF_PONTUADO);
    expect(l?.erro).toBe('cpf <redacted:cpf> e <redacted:cpf>');
  });

  it('a getter is never invoked: it becomes <nao-primitivo>', () => {
    const lido = vi.fn(() => 'segredo');
    const campos = Object.defineProperty({}, 'g', { get: lido, enumerable: true });
    expect(camposSeguros(campos)).toEqual({ g: NAO_PRIMITIVO });
    expect(lido).not.toHaveBeenCalled();
  });

  it("a CALL line's excerpt keeps its own cap, and an exempt DV-valid id survives the sink", () => {
    const id = '11222333000181';
    const trechoCorpo = `{"orderItemId":"${id}","pad":"${'z '.repeat(600)}"}`;
    const [l] = escrito(() => {
      LOGGER_STDOUT_AMAZON.info('m', { evento: 'chamada', trechoCorpo, outro: id });
    });
    expect(String(l?.trechoCorpo)).toContain(id);
    expect(bytesUtf8(String(l?.trechoCorpo))).toBeGreaterThan(MAX_CAMPO_TEXTO_BYTES);
    // Near-miss: the same digits in any other campo take the check-digit pass.
    expect(l?.outro).toBe('<redacted:cnpj>');
    // Near-miss: the same campo on a NON-call line is an ordinary string —
    // masked with the check-digit pass and cut to the campo cap.
    const naoChamada: readonly CamposLogAmazon[] = [
      { trechoCorpo },
      { evento: 'chamada-bloqueada', trechoCorpo },
    ];
    for (const campos of naoChamada) {
      const [n] = escrito(() => {
        LOGGER_STDOUT_AMAZON.info('m', campos);
      });
      expect(String(n?.trechoCorpo)).not.toContain(id);
      expect(bytesUtf8(String(n?.trechoCorpo))).toBe(MAX_CAMPO_TEXTO_BYTES);
    }
  });

  it.each([
    ['a campo', (t: string) => ['m', { erro: t }] as const, 'erro'],
    ['the message', (t: string) => [t, {}] as const, 'message'],
  ])(
    '★ %s is masked BEFORE its 256-byte cut: a CPF straddling the edge never appears even partially',
    (_c, args, chave) => {
      // 250 bytes of padding that no pattern matches (a run of letters would be a blob).
      const t = `${'a '.repeat(125)}${CPF_PONTUADO}`;
      expect(bytesUtf8(t)).toBeGreaterThan(MAX_CAMPO_TEXTO_BYTES);
      // Anti-vacuity: cut first, the CPF's head would sit inside the cap.
      expect(t.slice(0, MAX_CAMPO_TEXTO_BYTES)).toContain(CPF_PONTUADO.slice(0, 5));
      const [mensagem, campos] = args(t);
      const [l] = escrito(() => {
        LOGGER_STDOUT_AMAZON.warn(mensagem, campos);
      });
      expect(String(l?.[chave])).not.toContain(CPF_PONTUADO.slice(0, 5));
      expect(bytesUtf8(String(l?.[chave]))).toBeLessThanOrEqual(MAX_CAMPO_TEXTO_BYTES);
    },
  );

  it('★ an e-mail with non-ASCII letters, in a campo string, is masked whole', () => {
    const [l] = escrito(() => {
      LOGGER_STDOUT_AMAZON.warn('m', { erro: 'falha para andré@example.com e joão@example.org' });
    });
    expect(l?.erro).toBe('falha para <redacted:email> e <redacted:email>');
  });
});

describe('★ totality: the observer never throws (the code exchange runs it after the state is spent)', () => {
  const invalido = new TextDecoder().decode(new Uint8Array([0xff, 0xfe, 0x7b, 0xc3, 0x28]));
  const corpos: readonly (string | null)[] = [
    `{"a":"${'x'.repeat(LIMITE_ANALISE_BYTES.log)}"}`,
    `${'['.repeat(10_000)}${']'.repeat(10_000)}`,
    '{"a":"\\ud800\\udfff\\udc00"}',
    '𐀀\ud800',
    invalido,
    '{"n":1e400}',
    '-0',
    '{"g":12345678901234567890}',
    '{"__proto__":{"polui":1},"constructor":{"prototype":{"x":1}}}',
    '"escalar"',
    '',
    null,
  ];
  const resultados = [
    'ok',
    'http',
    'auth',
    'nao-encontrado',
    'limite',
    'schema',
    'rede',
    'tempo-esgotado',
    'cancelado',
    'inesperado',
  ] as const;
  const statuses = [200, 302, 400, 401, 403, 404, 429, 500, 503, null];

  // ⚠️ 2,400 observations, ~140 of them walking a 1 MiB body: about 4 s on a
  // workstation but 42 s on the CI runner, where turbo runs every workspace's
  // suite at once (#1985). The timeout is CI headroom, not a budget: the cost
  // of one walk is pinned on CPU time below.
  it(
    'over bodies × resultado × status × destino (a non-throwing logger)',
    { timeout: 120_000 },
    () => {
      let linhas = 0;
      const logger = {
        info: () => {
          linhas += 1;
        },
        warn: () => {
          linhas += 1;
        },
        error: () => {
          linhas += 1;
        },
      };
      const observar = criarObservadorAmazon({ logger, conta: CONTA, fluxo: 'oauth-callback' });
      let n = 0;
      for (const corpo of corpos) {
        for (const resultado of resultados) {
          for (const status of statuses) {
            for (const destino of ['sp-api', 'lwa'] as const) {
              expect(() => {
                observar(eventoDeChamada({ corpo, resultado, status, destino }));
              }).not.toThrow();
              n += 1;
            }
          }
        }
      }
      expect(linhas).toBe(n);
      expect(Object.prototype).not.toHaveProperty('polui');
    },
  );

  it('a path that is not a string (cast at run time) — a null-prototype object, a throwing toString — never throws, and logs as unknown', () => {
    const caminhos: unknown[] = [
      Object.create(null),
      {
        toString() {
          throw new Error('toString');
        },
      },
      12,
      null,
      undefined,
      Symbol('s'),
    ];
    const { logger, linhas } = loggerEspiao();
    const observar = criarObservadorAmazon({ logger, conta: CONTA });
    for (const caminho of caminhos) {
      for (const status of [200, 400]) {
        expect(() => {
          observar(eventoDeChamada({ caminho: caminho as string, status }));
        }).not.toThrow();
      }
    }
    expect(linhas).toHaveLength(caminhos.length * 2);
    for (const l of linhas) {
      expect(l.meta).toMatchObject({ caminho: '<seg>?includedData=BUYER,RECIPIENT' });
    }
    // The untyped adapter's message, likewise.
    for (const mensagem of caminhos) {
      expect(() => {
        warnNaoTipado(logger).warn(mensagem as string, {});
      }).not.toThrow();
    }
    expect(linhas.at(-1)?.mensagem).toBe(NAO_PRIMITIVO);
  });

  it('and the real stdout sink takes every one of those lines without throwing', () => {
    const out = espiarStdout();
    const observar = criarObservadorAmazon({ logger: LOGGER_STDOUT_AMAZON, conta: CONTA });
    for (const corpo of corpos) {
      for (const status of [200, 400, 401]) {
        expect(() => {
          observar(eventoDeChamada({ corpo, status }));
        }).not.toThrow();
      }
    }
    const linhas = out.linhas();
    out.restaurar();
    expect(linhas).toHaveLength(corpos.length * 3);
    for (const l of linhas) expect(() => JSON.parse(l) as unknown).not.toThrow();
  });

  describe('the cost (step-2b plan §5 risk 5): a 1 MiB page is walked leaf by leaf in under 1 s of CPU', () => {
    /** `{"orders":[…]}` filled with `item(i)` up to just under the 1 MiB parse cap. */
    function pagina(item: (i: number) => unknown): string {
      const partes: string[] = [];
      let bytes = '{"orders":[]}'.length;
      for (let i = 0; ; i++) {
        const s = JSON.stringify(item(i));
        if (bytes + s.length + 1 > LIMITE_ANALISE_BYTES.log) break;
        partes.push(s);
        bytes += s.length + 1;
      }
      return `{"orders":[${partes.join(',')}]}`;
    }

    // The 1 s is the plan's CPU budget and holds on the CI runner; only the wall
    // clock (building the page, a shared core) needs headroom there (#1985).
    it.each([
      ['~170k keys', (i: number) => ({ a: i, b: 1, c: 2, d: 3, e: 4 })],
      [
        'allowed enums and seller SKUs',
        (i: number) => ({
          programs: ['PRIME', 'PREMIUM'],
          orderItems: [{ product: { sellerSku: `SKU-${String(i)}` }, quantityOrdered: 1 }],
        }),
      ],
    ])('%s', { timeout: 30_000 }, (_c, item) => {
      const corpo = pagina(item);
      expect(bytesUtf8(corpo)).toBeLessThanOrEqual(LIMITE_ANALISE_BYTES.log);
      const inicio = process.cpuUsage();
      const l = linha({ caminho: '/orders/2026-01-01/orders', corpo });
      const cpu = process.cpuUsage(inicio);
      // Anti-vacuity: it WAS parsed and walked, not refused as too big.
      expect(l).toMatchObject({ corpoForma: 'json', corpoTruncado: true });
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(1000);
    });
  });

  it('the regex layer on its own over the same bodies', () => {
    for (const corpo of corpos) {
      if (corpo !== null) expect(() => mascararTexto(corpo, { digitos: true })).not.toThrow();
    }
  });
});
