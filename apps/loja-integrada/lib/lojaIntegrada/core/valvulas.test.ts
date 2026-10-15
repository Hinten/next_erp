/**
 * The write valves, the canary lists and the read switch (`core/valvulas.ts`),
 * all on an INJECTED environment: nothing here reads or writes the process's.
 *
 * Every rule is pinned with its near miss: the exact `on` writes and `ON` does
 * not; `*` widens and ` *` does not; `c1:10` authorizes `c1:10` and not
 * `c1:100`, `c1:1` or `c2:10`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { gravadorDeLog } from '../testing/fixtures';
import {
  type AlvoLi,
  CANARIO_ENV_LI,
  CANARIO_TODOS,
  CHAMADAS_ENV_LI,
  FLUXO_LI,
  MODO_LI,
  VALVULA_ENV_LI,
  camposDaValvula,
  chaveDoAlvo,
  decidirAlvo,
  lerChaveDeChamadas,
  lerValvula,
  registrarChamadaBloqueadaLi,
  registrarValvulaLi,
  severidadeDaValvula,
} from './valvulas';

const FLUXOS = Object.values(FLUXO_LI);
const C1_10: AlvoLi = { contaId: 'c1', recurso: 10 };

/** The stock valve under `modo`, with the stock canary list set to `canario`. */
function estoque(modo: string | undefined, canario?: string) {
  const ambiente: Record<string, string | undefined> = {
    [VALVULA_ENV_LI.estoque]: modo,
    [CANARIO_ENV_LI.estoque]: canario,
  };
  return lerValvula(FLUXO_LI.estoque, ambiente);
}

/* -------------------------------------------------------------------------- */
/*                                  The mode                                   */
/* -------------------------------------------------------------------------- */

describe('lerValvula — the mode: only the exact strings count', () => {
  it.each([
    ['on', 'on', true],
    ['dry-run', 'dry-run', true],
    ['off', 'off', true],
    // The template ships the line blank: blank and unset are expected, not typos.
    ['', 'off', true],
    [undefined, 'off', true],
    // Everything else is OFF — and flagged.
    ['ON', 'off', false],
    ['On', 'off', false],
    [' on', 'off', false],
    ['on ', 'off', false],
    ['on\n', 'off', false],
    ['true', 'off', false],
    ['1', 'off', false],
    ['yes', 'off', false],
    ['DRY-RUN', 'off', false],
    ['dry_run', 'off', false],
    ['dryrun', 'off', false],
    [' dry-run', 'off', false],
    ['OFF', 'off', false],
  ])('%j → %s (recognised: %s)', (valor, modo, reconhecido) => {
    const v = estoque(valor);
    expect(v.modo).toBe(modo);
    expect(v.modoReconhecido).toBe(reconhecido);
  });

  it('⭐ near-miss: `on` writes; `ON`, ` on`, `on `, `true`, `1` are all off', () => {
    expect(decidirAlvo(estoque('on', CANARIO_TODOS), C1_10)).toEqual({
      modo: 'on',
      motivo: 'todos',
    });
    for (const quase of ['ON', ' on', 'on ', 'true', '1']) {
      expect(decidirAlvo(estoque(quase, CANARIO_TODOS), C1_10), quase).toEqual({ modo: 'off' });
    }
  });

  it('an unrecognised mode makes the run-start line a WARNING; a recognised one, INFO', () => {
    expect(severidadeDaValvula(estoque('ON'))).toBe('WARNING');
    expect(severidadeDaValvula(estoque('true'))).toBe('WARNING');
    expect(severidadeDaValvula(estoque(undefined))).toBe('INFO');
    expect(severidadeDaValvula(estoque(''))).toBe('INFO');
    expect(severidadeDaValvula(estoque('off'))).toBe('INFO');
    expect(severidadeDaValvula(estoque('dry-run'))).toBe('INFO');
    expect(severidadeDaValvula(estoque('on', CANARIO_TODOS))).toBe('INFO');
  });
});

describe('lerValvula — isolation: each flow reads only its own names', () => {
  it.each(FLUXOS)('only %s turns on when only its own valve and list are set', (fluxo) => {
    const chave = (Object.keys(FLUXO_LI) as (keyof typeof FLUXO_LI)[]).find(
      (k) => FLUXO_LI[k] === fluxo,
    );
    if (chave === undefined) throw new TypeError(fluxo);
    const ambiente: Record<string, string> = { [VALVULA_ENV_LI[chave]]: 'on' };
    if (chave !== 'webhookRegistro') ambiente[CANARIO_ENV_LI[chave]] = CANARIO_TODOS;

    for (const outro of FLUXOS) {
      const v = lerValvula(outro, ambiente);
      expect(v.fluxo).toBe(outro);
      expect(v.modo, `${fluxo} → ${outro}`).toBe(outro === fluxo ? 'on' : 'off');
      if (outro !== fluxo && v.canario !== null) expect(v.canario).toEqual({ tipo: 'nenhum' });
    }
  });

  it('the read switch moves no valve, and no valve moves the read switch', () => {
    const v = lerValvula(FLUXO_LI.estoque, {
      [CHAMADAS_ENV_LI]: 'on',
      [CANARIO_ENV_LI.estoque]: CANARIO_TODOS,
    });
    expect(v.modo).toBe('off');
    expect(lerChaveDeChamadas({ [VALVULA_ENV_LI.estoque]: 'on' })).toBe(false);
  });

  it('reads the environment ONCE: the valve is a snapshot for the whole run', () => {
    const ambiente: Record<string, string | undefined> = {
      [VALVULA_ENV_LI.estoque]: 'on',
      [CANARIO_ENV_LI.estoque]: 'c1:10',
    };
    const v = lerValvula(FLUXO_LI.estoque, ambiente);
    ambiente[VALVULA_ENV_LI.estoque] = 'off';
    ambiente[CANARIO_ENV_LI.estoque] = '';
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'on', motivo: 'no-canario' });
  });

  it('the webhook registration has no canary list: its valve reads `modo` alone, and decidirAlvo never says `on`', () => {
    const v = lerValvula(FLUXO_LI.webhookRegistro, {
      [VALVULA_ENV_LI.webhookRegistro]: 'on',
    });
    expect(v).toEqual({
      fluxo: 'webhook-registro',
      modo: 'on',
      modoReconhecido: true,
      canario: null,
    });
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'dry-run', motivo: 'sem-canario' });
  });
});

/* -------------------------------------------------------------------------- */
/*                               The canary list                               */
/* -------------------------------------------------------------------------- */

describe('the canary value (Q2): `*` is the only widening', () => {
  it.each([
    ['unset', undefined, { tipo: 'nenhum' }],
    ['blank', '', { tipo: 'nenhum' }],
    ['exactly *', '*', { tipo: 'todos' }],
  ])('%s', (_caso, valor, canario) => {
    expect(estoque('on', valor).canario).toEqual(canario);
  });

  it('⭐ unset and blank mean NO target: under `on`, everything dry-runs', () => {
    for (const valor of [undefined, '']) {
      expect(decidirAlvo(estoque('on', valor), C1_10)).toEqual({
        modo: 'dry-run',
        motivo: 'sem-canario',
      });
    }
  });

  it('⭐ `*` means every valid target', () => {
    const v = estoque('on', '*');
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'on', motivo: 'todos' });
    expect(decidirAlvo(v, { contaId: 'outra_conta-2', recurso: 987654321 })).toEqual({
      modo: 'on',
      motivo: 'todos',
    });
  });

  it.each([' *', '* ', '**', '*,*', '"*"', 'all', 'todos'])(
    '⭐ near-miss %j is not `*`: a list with malformed entries, so no target',
    (valor) => {
      const v = estoque('on', valor);
      expect(v.canario?.tipo).toBe('lista');
      expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'dry-run', motivo: 'fora-do-canario' });
      expect(severidadeDaValvula(v)).toBe('WARNING');
    },
  );

  it('`*` inside a list is malformed: `*,c1:10` authorizes only c1:10', () => {
    const v = estoque('on', '*,c1:10');
    expect(v.canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:10']),
      entradas: 2,
      malformadas: [1],
    });
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'on', motivo: 'no-canario' });
    expect(decidirAlvo(v, { contaId: 'c2', recurso: 10 })).toEqual({
      modo: 'dry-run',
      motivo: 'fora-do-canario',
    });
  });

  it('⭐ c1:10 authorizes c1:10 — and not c2:10, c1:100, c1:1 (no prefix match)', () => {
    const v = estoque('on', 'c1:10');
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'on', motivo: 'no-canario' });
    for (const alvo of [
      { contaId: 'c2', recurso: 10 },
      { contaId: 'c1', recurso: 100 },
      { contaId: 'c1', recurso: 1 },
      { contaId: 'c', recurso: 110 },
      { contaId: 'C1', recurso: 10 },
    ]) {
      expect(decidirAlvo(v, alvo), JSON.stringify(alvo)).toEqual({
        modo: 'dry-run',
        motivo: 'fora-do-canario',
      });
    }
  });

  it('a list of several, with duplicates, per conta', () => {
    const v = estoque('on', 'c1:10,c2:20,c1:10,c1:30');
    expect(v.canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:10', 'c2:20', 'c1:30']),
      entradas: 4,
      malformadas: [],
    });
    expect(decidirAlvo(v, { contaId: 'c2', recurso: 20 }).modo).toBe('on');
    expect(decidirAlvo(v, { contaId: 'c2', recurso: 10 }).modo).toBe('dry-run');
    expect(severidadeDaValvula(v)).toBe('INFO');
  });

  it('a trailing comma is one malformed (empty) entry; the rest still counts', () => {
    const v = estoque('on', 'c1:10,');
    expect(v.canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:10']),
      entradas: 2,
      malformadas: [2],
    });
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'on', motivo: 'no-canario' });
  });

  it.each([
    'c1:010',
    ' c1:10',
    'c1:10 ',
    'c1 :10',
    'c1: 10',
    'c1:',
    ':10',
    'c1:0',
    'c1:1e3',
    'c1:10.0',
    'c1:-1',
    'c1:+10',
    'a:b:10',
    'c1.x:10',
    'c1:10;c2:3',
    'c1:9007199254740992',
    'c1:12345678901234567',
    `${'a'.repeat(129)}:10`,
    '',
  ])('malformed %j is simply not listed, and reported by position', (entrada) => {
    const v = estoque('on', `c9:5,${entrada}`);
    expect(v.canario).toMatchObject({ tipo: 'lista', malformadas: [2] });
    expect(v.canario?.tipo === 'lista' ? [...v.canario.chaves] : null).toEqual(['c9:5']);
    // The target the entry was probably meant for stays a dry-run.
    expect(decidirAlvo(v, C1_10)).toEqual({ modo: 'dry-run', motivo: 'fora-do-canario' });
    expect(severidadeDaValvula(v)).toBe('WARNING');
  });

  it('near-miss: the boundaries of the grammar that ARE well formed', () => {
    const conta128 = 'a'.repeat(128);
    const v = estoque('on', `${conta128}:1,c_1-X:9007199254740991,Z:1000`);
    expect(v.canario).toMatchObject({ tipo: 'lista', malformadas: [] });
    expect(decidirAlvo(v, { contaId: conta128, recurso: 1 }).modo).toBe('on');
    expect(decidirAlvo(v, { contaId: 'c_1-X', recurso: Number.MAX_SAFE_INTEGER }).modo).toBe('on');
    expect(decidirAlvo(v, { contaId: 'Z', recurso: 1000 }).modo).toBe('on');
  });

  it('the list is ignored under dry-run and off', () => {
    expect(decidirAlvo(estoque('dry-run', 'c1:10'), C1_10)).toEqual({
      modo: 'dry-run',
      motivo: 'valvula',
    });
    expect(decidirAlvo(estoque('dry-run', '*'), C1_10)).toEqual({
      modo: 'dry-run',
      motivo: 'valvula',
    });
    expect(decidirAlvo(estoque('off', 'c1:10'), C1_10)).toEqual({ modo: 'off' });
    expect(decidirAlvo(estoque(undefined, '*'), C1_10)).toEqual({ modo: 'off' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The target                                  */
/* -------------------------------------------------------------------------- */

describe('chaveDoAlvo and invalid targets', () => {
  it('the canonical key is `<contaId>:<recurso>`', () => {
    expect(chaveDoAlvo(C1_10)).toBe('c1:10');
    expect(chaveDoAlvo({ contaId: 'A_b-9', recurso: 1 })).toBe('A_b-9:1');
  });

  it.each([
    ['recurso 0', { contaId: 'c1', recurso: 0 }],
    ['recurso -1', { contaId: 'c1', recurso: -1 }],
    ['recurso NaN', { contaId: 'c1', recurso: Number.NaN }],
    ['recurso 1.5', { contaId: 'c1', recurso: 1.5 }],
    ['recurso Infinity', { contaId: 'c1', recurso: Number.POSITIVE_INFINITY }],
    ['recurso 2^53', { contaId: 'c1', recurso: 2 ** 53 }],
    ['a conta id with a space', { contaId: 'c 1', recurso: 10 }],
    ['a conta id with a colon', { contaId: 'c1:10', recurso: 10 }],
    ['an empty conta id', { contaId: '', recurso: 10 }],
    ['a conta id too long', { contaId: 'a'.repeat(129), recurso: 10 }],
  ])('%s → no key; under `on`, alvo-invalido even with `*`', (_caso, alvo) => {
    expect(chaveDoAlvo(alvo)).toBeNull();
    expect(decidirAlvo(estoque('on', '*'), alvo)).toEqual({
      modo: 'dry-run',
      motivo: 'alvo-invalido',
    });
    expect(decidirAlvo(estoque('on', 'c1:10'), alvo)).toEqual({
      modo: 'dry-run',
      motivo: 'alvo-invalido',
    });
  });

  it('a malformed list entry can never equal a key: " c1:10" lists nothing a target can match', () => {
    const v = estoque('on', ' c1:10');
    expect(decidirAlvo(v, C1_10).modo).toBe('dry-run');
    expect(decidirAlvo(v, { contaId: ' c1', recurso: 10 })).toEqual({
      modo: 'dry-run',
      motivo: 'alvo-invalido',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              The run-start line                             */
/* -------------------------------------------------------------------------- */

describe('registrarValvulaLi — the run-start line', () => {
  it('primitives only; the flow comes from the valve', () => {
    const gravador = gravadorDeLog();
    registrarValvulaLi(estoque('on', 'c1:10,c2:20'), {
      conta: null,
      tentativa: 2,
      escrever: gravador.escrever,
    });
    expect(gravador.linhas).toEqual([
      {
        severidade: 'INFO',
        mensagem: '[loja-integrada] valvula',
        campos: {
          evento: 'valvula',
          conta: null,
          fluxo: 'estoque',
          tentativa: 2,
          idTarefa: null,
          idNotificacao: null,
          modo: 'on',
          modoReconhecido: true,
          canario: 'lista',
          canarioEntradas: 2,
          canarioMalformadas: 0,
          posicoesMalformadas: null,
        },
      },
    ]);
  });

  it('a caller cannot relabel the flow', () => {
    const gravador = gravadorDeLog();
    const opcoes = { conta: null, fluxo: 'preco', escrever: gravador.escrever };
    registrarValvulaLi(estoque('off'), opcoes);
    expect(gravador.linhas[0]?.campos.fluxo).toBe('estoque');
  });

  it('⭐ malformed entries by POSITION only, never by text — an operator may paste anything', () => {
    const gravador = gravadorDeLog();
    const colado = 'SENTINELA-colada:010';
    registrarValvulaLi(estoque('on', `c1:10,${colado},c2:5, c3:7`), {
      conta: null,
      escrever: gravador.escrever,
    });
    expect(gravador.linhas[0]?.severidade).toBe('WARNING');
    expect(gravador.linhas[0]?.campos).toMatchObject({
      canario: 'lista',
      canarioEntradas: 4,
      canarioMalformadas: 2,
      posicoesMalformadas: '2,4',
    });
    const texto = JSON.stringify(gravador.linhas);
    expect(texto).not.toContain('SENTINELA');
    expect(texto).not.toContain('c3:7');
    expect(texto).not.toContain('c1:10');
  });

  it('nenhum, todos and the webhook flow', () => {
    expect(camposDaValvula(estoque('on'))).toMatchObject({
      canario: 'nenhum',
      canarioEntradas: 0,
      canarioMalformadas: 0,
    });
    expect(camposDaValvula(estoque('on', '*'))).toMatchObject({
      canario: 'todos',
      canarioEntradas: 0,
    });
    expect(
      camposDaValvula(
        lerValvula(FLUXO_LI.webhookRegistro, { [VALVULA_ENV_LI.webhookRegistro]: 'dry-run' }),
      ),
    ).toEqual({
      modo: 'dry-run',
      modoReconhecido: true,
      canario: null,
      canarioEntradas: null,
      canarioMalformadas: 0,
      posicoesMalformadas: null,
    });
  });

  it('an unrecognised mode is a WARNING line that never echoes the value', () => {
    const gravador = gravadorDeLog();
    registrarValvulaLi(estoque('SENTINELA-modo'), { conta: null, escrever: gravador.escrever });
    expect(gravador.linhas[0]?.severidade).toBe('WARNING');
    expect(gravador.linhas[0]?.campos).toMatchObject({ modo: 'off', modoReconhecido: false });
    expect(JSON.stringify(gravador.linhas)).not.toContain('SENTINELA');
  });
});

/* -------------------------------------------------------------------------- */
/*                               The read switch                               */
/* -------------------------------------------------------------------------- */

describe('lerChaveDeChamadas — the read switch (D17): only the exact `on`', () => {
  it.each([
    ['on', true],
    [undefined, false],
    ['', false],
    ['off', false],
    ['ON', false],
    ['On', false],
    [' on', false],
    ['on ', false],
    ['true', false],
    ['1', false],
    ['yes', false],
  ])('%j → %s', (valor, chamadas) => {
    expect(lerChaveDeChamadas({ [CHAMADAS_ENV_LI]: valor })).toBe(chamadas);
  });

  it('an empty environment calls nothing', () => {
    expect(lerChaveDeChamadas({})).toBe(false);
  });

  it.each([
    [undefined, 'INFO', true],
    ['', 'INFO', true],
    ['off', 'INFO', true],
    ['ON', 'WARNING', false],
    ['SENTINELA-chave', 'WARNING', false],
  ])(
    'a refused call is one line: %j → %s, the value never echoed',
    (valor, severidade, reconhecido) => {
      const gravador = gravadorDeLog();
      registrarChamadaBloqueadaLi(
        'validarPersonalToken',
        { [CHAMADAS_ENV_LI]: valor },
        {
          conta: 'conta-li-1',
          escrever: gravador.escrever,
        },
      );
      expect(gravador.linhas).toEqual([
        {
          severidade,
          mensagem: '[loja-integrada] chamada-bloqueada',
          campos: {
            evento: 'chamada-bloqueada',
            conta: 'conta-li-1',
            fluxo: null,
            tentativa: null,
            idTarefa: null,
            idNotificacao: null,
            operacao: 'validarPersonalToken',
            chave: CHAMADAS_ENV_LI,
            valorReconhecido: reconhecido,
          },
        },
      ]);
      expect(JSON.stringify(gravador.linhas)).not.toContain('SENTINELA');
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                                 Name drift                                  */
/* -------------------------------------------------------------------------- */

describe('the names: one per flow, documented where the operator looks', () => {
  const NOMES = [
    ...Object.values(VALVULA_ENV_LI),
    ...Object.values(CANARIO_ENV_LI),
    CHAMADAS_ENV_LI,
  ];
  const linhasDe = (relativo: string) =>
    readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8').split(/\r?\n/);
  const ENV_EXAMPLE = linhasDe('../../../../../.env.example');
  const APPHOSTING = linhasDe('../../../apphosting.yaml');

  it('five valves, four canary lists, one switch — distinct, prefixed, none secret-shaped', () => {
    expect(Object.keys(VALVULA_ENV_LI)).toHaveLength(5);
    expect(Object.keys(CANARIO_ENV_LI)).toHaveLength(4);
    expect(new Set(NOMES).size).toBe(NOMES.length);
    for (const nome of NOMES) {
      expect(nome).toMatch(/^LOJA_INTEGRADA_[A-Z_]+$/);
      // `env-example-split.test.js`'s credential suffixes: these are config.
      expect(nome).not.toMatch(/(SECRET|PASSWORD|_TOKEN|PRIVATE_KEY|CERT_BASE64|ENC_KEY)$/);
    }
  });

  it.each([...Object.values(VALVULA_ENV_LI), ...Object.values(CANARIO_ENV_LI), CHAMADAS_ENV_LI])(
    '%s: a BLANK line in .env.example and a comment row in apphosting.yaml',
    (nome) => {
      expect(ENV_EXAMPLE).toContain(`${nome}=`);
      expect(ENV_EXAMPLE.filter((l) => l.startsWith(`${nome}=`))).toEqual([`${nome}=`]);
      expect(APPHOSTING.some((l) => new RegExp(`^#\\s+${nome}\\b`).test(l))).toBe(true);
    },
  );

  it('apphosting.yaml declares none of them as an `env:` row — a baked `off` could override the console', () => {
    for (const nome of NOMES) {
      expect(APPHOSTING.some((l) => !l.trimStart().startsWith('#') && l.includes(nome))).toBe(
        false,
      );
    }
  });

  it('the flow values are what the log query filters on', () => {
    expect(FLUXOS).toEqual(['estoque', 'preco', 'anuncio', 'rastreio', 'webhook-registro']);
    expect(Object.values(MODO_LI)).toEqual(['off', 'dry-run', 'on']);
  });
});
