import { describe, expect, it } from 'vitest';
import { type ChamadaLi, TOKEN_REMOVIDO } from '@delfrance/integrations-loja-integrada';

import { espiarStdout, gravadorDeLog } from '../testing/fixtures';
import {
  CHAVES_DA_LINHA,
  type CampoLogLi,
  MAX_TRECHO_CORPO_BYTES,
  criarObservadorLi,
  escritorPadrao,
  linhaDaChamada,
  registrarEventoLi,
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
      evento({ caminho: '/v1/categoria/', status: 401, resultado: 'auth', corpo }),
      OPCOES,
    );
    expect(linha.corpoTruncado).toBe(true);
    expect(bytesUtf8(linha.trechoCorpo ?? '')).toBeLessThanOrEqual(MAX_TRECHO_CORPO_BYTES);
    expect(linha.trechoCorpo).not.toContain('fulano');
    expect(linha.trechoCorpo).not.toContain('@');
    expect(linha.mascarados).toBe(1);
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

  it('over every body × class × status: exactly one line each', () => {
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
