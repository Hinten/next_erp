import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AmbienteAmazon } from '../env';
import { loggerEspiao } from '../testing/fixtures';
import {
  CANARIO_ENV_AMAZON,
  CANARIO_TODOS,
  CHAMADAS_ENV_AMAZON,
  FLUXOS_COM_LOTE,
  FLUXO_AMAZON,
  type FluxoAmazon,
  MODO_AMAZON,
  TIPO_DE_ALVO,
  VALVULA_ENV_AMAZON,
  type ValvulaAmazon,
  alvoValido,
  camposDaValvula,
  chaveDoAlvo,
  classificarValorDeChamadas,
  decidirAlvo,
  decidirLote,
  lerCanario,
  lerChaveDeChamadasAmazon,
  lerModo,
  lerValvula,
  registrarChamadaBloqueadaAmazon,
  registrarValvulaAmazon,
  severidadeDaValvula,
} from './valvulas';

describe('lerChaveDeChamadasAmazon', () => {
  it('pins the variable name', () => {
    expect(CHAMADAS_ENV_AMAZON).toBe('AMAZON_CHAMADAS');
  });

  it('passes ONLY the exact `on`', () => {
    expect(lerChaveDeChamadasAmazon({ AMAZON_CHAMADAS: 'on' })).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['off', 'off'],
    // Near-misses: each LOOKS right, and must still not call Amazon.
    ['ON', 'ON'],
    ['On', 'On'],
    ['leading space', ' on'],
    ['trailing space', 'on '],
    ['trailing newline', 'on\n'],
    ['true', 'true'],
    ['1', '1'],
  ])('%s → off', (_c, valor) => {
    expect(lerChaveDeChamadasAmazon({ AMAZON_CHAMADAS: valor })).toBe(false);
  });
});

describe('classificarValorDeChamadas', () => {
  it.each([
    [undefined, 'ausente'],
    ['', 'ausente'],
    ['off', 'off'],
    ['OFF', 'outro'],
    [' ', 'outro'],
    ['ON', 'outro'],
    ['on', 'outro'],
  ] as const)('%j → %s', (valor, classe) => {
    expect(classificarValorDeChamadas(valor)).toBe(classe);
  });
});

describe('registrarChamadaBloqueadaAmazon', () => {
  it('writes ONE INFO line while simply off, naming the route and the class', () => {
    const { logger, linhas } = loggerEspiao();
    registrarChamadaBloqueadaAmazon(logger, { rota: 'oauth-start', valor: undefined });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('info');
    expect(linhas[0]?.meta).toEqual({
      evento: 'chamada-bloqueada',
      rota: 'oauth-start',
      chave: 'AMAZON_CHAMADAS',
      valor: 'ausente',
    });
  });

  it('writes a WARNING for a mis-set value, and never echoes the raw text', () => {
    const { logger, linhas } = loggerEspiao();
    const cru = 'ON-colado-por-engano';
    registrarChamadaBloqueadaAmazon(logger, { rota: 'contexto', valor: cru });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta?.valor).toBe('outro');
    expect(JSON.stringify(linhas)).not.toContain(cru);
  });

  it('`off` is INFO too', () => {
    const { logger, linhas } = loggerEspiao();
    registrarChamadaBloqueadaAmazon(logger, { rota: 'oauth-callback', valor: 'off' });
    expect(linhas[0]?.nivel).toBe('info');
  });
});

// The stdout sink moved to `log.ts`; its tests are `log.test.ts`.

/* -------------------------------------------------------------------------- */
/*                         The write valves and canaries                       */
/* -------------------------------------------------------------------------- */

const FLUXOS = Object.values(FLUXO_AMAZON);
/** Order ids in the faker's own range (`000-0000000-…`): never a real order. */
const PEDIDO_1 = '000-0000000-0000001';
const PEDIDO_2 = '000-0000000-0000002';

/** A valid target of each flow's type, listable. */
const ALVO: Readonly<Record<FluxoAmazon, string>> = {
  estoque: 'SKU-1',
  preco: 'SKU-1',
  nfe: PEDIDO_1,
  agendamento: PEDIDO_1,
};

/** The environment that turns `fluxo` on with exactly `canario`. */
const ligado = (fluxo: FluxoAmazon, canario: string | undefined): AmbienteAmazon => ({
  [VALVULA_ENV_AMAZON[fluxo]]: 'on',
  [CANARIO_ENV_AMAZON[fluxo]]: canario,
});

const estoqueCom = (canario: string | undefined) =>
  lerValvula(FLUXO_AMAZON.estoque, ligado(FLUXO_AMAZON.estoque, canario));

describe('lerModo — the mode: only the exact strings count', () => {
  it.each([
    // [value, mode, recognised]
    [undefined, 'off', true],
    ['', 'off', true],
    ['off', 'off', true],
    ['on', 'on', true],
    ['dry-run', 'dry-run', true],
    // Near-misses of `on`: each LOOKS right, and must still not write.
    ['ON', 'off', false],
    ['On', 'off', false],
    [' on', 'off', false],
    ['on ', 'off', false],
    ['on\n', 'off', false],
    ['true', 'off', false],
    ['1', 'off', false],
    ['yes', 'off', false],
    // Near-misses of `dry-run`: none of them diffs either.
    ['dryrun', 'off', false],
    ['Dry-Run', 'off', false],
    ['dry-run ', 'off', false],
    ['dry_run', 'off', false],
    // An `off` that is not exactly `off` is still off, and worth a warning.
    ['OFF', 'off', false],
    [' ', 'off', false],
  ] as const)('%j → %s (recognised: %s)', (valor, modo, reconhecido) => {
    expect(lerModo(valor)).toEqual({ modo, reconhecido });
    for (const fluxo of FLUXOS) {
      const v = lerValvula(fluxo, { [VALVULA_ENV_AMAZON[fluxo]]: valor });
      expect(v.modo).toBe(modo);
      expect(v.modoReconhecido).toBe(reconhecido);
    }
  });

  it('an unrecognised mode makes the run-start line a WARNING; a recognised one, INFO', () => {
    const v = (modo: string | undefined) =>
      lerValvula(FLUXO_AMAZON.preco, { [VALVULA_ENV_AMAZON.preco]: modo });
    expect(severidadeDaValvula(v('ON'))).toBe('WARNING');
    expect(severidadeDaValvula(v(' off'))).toBe('WARNING');
    expect(severidadeDaValvula(v(undefined))).toBe('INFO');
    expect(severidadeDaValvula(v('off'))).toBe('INFO');
    expect(severidadeDaValvula(v('dry-run'))).toBe('INFO');
    expect(severidadeDaValvula(v('on'))).toBe('INFO');
  });
});

describe('lerValvula — isolation: each flow reads only its own two names, once', () => {
  it.each(FLUXOS)('only %s turns on when only its own valve and list are set', (fluxo) => {
    const ambiente = ligado(fluxo, CANARIO_TODOS);
    for (const outro of FLUXOS) {
      const v = lerValvula(outro, ambiente);
      expect(v.fluxo).toBe(outro);
      expect(v.modo, `${fluxo} → ${outro}`).toBe(outro === fluxo ? 'on' : 'off');
      expect(v.canario, `${fluxo} → ${outro}`).toEqual(
        outro === fluxo ? { tipo: 'todos' } : { tipo: 'nenhum' },
      );
    }
  });

  it('setting AMAZON_MODO_PRECO=on leaves stock off', () => {
    const ambiente = { AMAZON_MODO_PRECO: 'on', AMAZON_CANARIO_PRECO: CANARIO_TODOS };
    const estoque = lerValvula(FLUXO_AMAZON.estoque, ambiente);
    expect(estoque.modo).toBe('off');
    expect(decidirAlvo(estoque, 'c1', 'SKU-1')).toEqual({ modo: 'off' });
  });

  it('the read switch moves no valve, and no valve moves the read switch', () => {
    const v = lerValvula(FLUXO_AMAZON.estoque, {
      [CHAMADAS_ENV_AMAZON]: 'on',
      [CANARIO_ENV_AMAZON.estoque]: CANARIO_TODOS,
    });
    expect(v.modo).toBe('off');
    for (const fluxo of FLUXOS) {
      expect(lerChaveDeChamadasAmazon(ligado(fluxo, CANARIO_TODOS))).toBe(false);
    }
  });

  const TODOS_OS_NOMES = [
    ...Object.values(VALVULA_ENV_AMAZON),
    ...Object.values(CANARIO_ENV_AMAZON),
    CHAMADAS_ENV_AMAZON,
  ];
  /**
   * The environments the read count runs under. Unset is how every name ships
   * until W8, and only there does a fallback read (`?? ambiente['AMAZON_MODO']`)
   * or a second read of an unset name (`?? ambiente[nome]`) happen at all.
   */
  const AMBIENTES_CONTADOS: Readonly<Record<string, () => Record<string, string>>> = {
    'every name set': () => ({
      ...Object.fromEntries(FLUXOS.map((f) => [VALVULA_ENV_AMAZON[f], 'on'])),
      ...Object.fromEntries(FLUXOS.map((f) => [CANARIO_ENV_AMAZON[f], `c1:${ALVO[f]}`])),
      [CHAMADAS_ENV_AMAZON]: 'on',
    }),
    'every name unset': () => ({}),
    "every name ''": () => Object.fromEntries(TODOS_OS_NOMES.map((n) => [n, ''])),
  };

  it.each(FLUXOS.flatMap((f) => Object.keys(AMBIENTES_CONTADOS).map((caso) => [f, caso] as const)))(
    '%s reads the environment ONCE (%s): each of its two names exactly once, nothing else',
    (fluxo, caso) => {
      const leituras: string[] = [];
      const outrosAcessos: string[] = [];
      const valores = AMBIENTES_CONTADOS[caso]?.() ?? {};
      const ambiente = new Proxy(valores, {
        get(alvo, chave, receptor): unknown {
          leituras.push(String(chave));
          return Reflect.get(alvo, chave, receptor);
        },
        has(alvo, chave) {
          outrosAcessos.push(`has ${String(chave)}`);
          return Reflect.has(alvo, chave);
        },
        ownKeys(alvo) {
          outrosAcessos.push('ownKeys');
          return Reflect.ownKeys(alvo);
        },
        getOwnPropertyDescriptor(alvo, chave) {
          outrosAcessos.push(`descriptor ${String(chave)}`);
          return Reflect.getOwnPropertyDescriptor(alvo, chave);
        },
      });

      const v = lerValvula(fluxo, ambiente);
      expect([...leituras].sort()).toEqual(
        [VALVULA_ENV_AMAZON[fluxo], CANARIO_ENV_AMAZON[fluxo]].sort(),
      );
      expect(outrosAcessos).toEqual([]);

      // Deciding, batching and logging never go back to the environment.
      decidirAlvo(v, 'c1', ALVO[fluxo]);
      decidirAlvo(v, 'c2', ALVO[fluxo]);
      camposDaValvula(v);
      registrarValvulaAmazon(loggerEspiao().logger, v);
      expect(leituras).toHaveLength(2);
    },
  );

  it('the valve is a snapshot: a later change to the environment does not move this run', () => {
    const ambiente: Record<string, string | undefined> = ligado(FLUXO_AMAZON.estoque, 'c1:SKU-1');
    const v = lerValvula(FLUXO_AMAZON.estoque, ambiente);
    ambiente[VALVULA_ENV_AMAZON.estoque] = 'off';
    ambiente[CANARIO_ENV_AMAZON.estoque] = '';
    expect(decidirAlvo(v, 'c1', 'SKU-1')).toEqual({ modo: 'on', motivo: 'no-canario' });
  });

  it('a value outside FLUXO_AMAZON (a cast) reads nothing and throws a TypeError', () => {
    expect(() => lerValvula('toString' as FluxoAmazon, {})).toThrow(TypeError);
    expect(() => lerValvula('__proto__' as FluxoAmazon, {})).toThrow(TypeError);
  });
});

describe('the canary list: unset is NO target, and `*` is the only widening', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('%s means no target: under `on`, everything dry-runs (sem-canario)', (_c, canario) => {
    for (const fluxo of FLUXOS) {
      const v = lerValvula(fluxo, ligado(fluxo, canario));
      expect(v.canario).toEqual({ tipo: 'nenhum' });
      expect(decidirAlvo(v, 'c1', ALVO[fluxo])).toEqual({
        modo: 'dry-run',
        motivo: 'sem-canario',
      });
    }
  });

  it('exactly `*` means every VALID target', () => {
    const estoque = estoqueCom(CANARIO_TODOS);
    expect(estoque.canario).toEqual({ tipo: 'todos' });
    for (const [conta, sku] of [
      ['c1', 'SKU-1'],
      ['c2', 'qualquer-outro'],
      ['Z9_x-1', 'A:B'],
    ]) {
      expect(decidirAlvo(estoque, conta, sku)).toEqual({ modo: 'on', motivo: 'todos' });
    }
    const nfe = lerValvula(FLUXO_AMAZON.nfe, ligado(FLUXO_AMAZON.nfe, CANARIO_TODOS));
    expect(decidirAlvo(nfe, 'c1', PEDIDO_2)).toEqual({ modo: 'on', motivo: 'todos' });
  });

  // `' '` is not empty: nothing is trimmed, so spaces alone are one malformed entry.
  it.each([' ', ' *', '* ', '**', '*,*', '"*"', 'all', 'todos', '*\n'])(
    '%j is not `*`: every entry is malformed and no target is on',
    (canario) => {
      const v = estoqueCom(canario);
      expect(v.canario.tipo).toBe('lista');
      if (v.canario.tipo !== 'lista') return;
      expect(v.canario.chaves.size).toBe(0);
      expect(v.canario.malformadas).toEqual(
        Array.from({ length: v.canario.entradas }, (_, i) => i + 1),
      );
      expect(decidirAlvo(v, 'c1', 'SKU-1')).toEqual({
        modo: 'dry-run',
        motivo: 'fora-do-canario',
      });
    },
  );

  it('`*` inside a list is malformed: `*,c1:SKU-1` authorizes only c1:SKU-1', () => {
    const v = estoqueCom('*,c1:SKU-1');
    expect(v.canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:SKU-1']),
      entradas: 2,
      malformadas: [1],
    });
    expect(decidirAlvo(v, 'c1', 'SKU-1')).toEqual({ modo: 'on', motivo: 'no-canario' });
    expect(decidirAlvo(v, 'c2', 'SKU-1')).toEqual({ modo: 'dry-run', motivo: 'fora-do-canario' });
    expect(decidirAlvo(v, 'c1', 'SKU-2')).toEqual({ modo: 'dry-run', motivo: 'fora-do-canario' });
  });

  it('`c1:*` is no per-conta wildcard: the entry is malformed (a WARNING) and c1:SKU-1 still dry-runs', () => {
    const v = estoqueCom('c1:*');
    expect(v.canario).toEqual({ tipo: 'lista', chaves: new Set(), entradas: 1, malformadas: [1] });
    expect(severidadeDaValvula(v)).toBe('WARNING');
    for (const sku of ['SKU-1', 'qualquer-outro']) {
      expect(decidirAlvo(v, 'c1', sku), sku).toEqual({
        modo: 'dry-run',
        motivo: 'fora-do-canario',
      });
    }
    // A SKU that IS literally `*` is valid, but no list can name it: it is reached only at `*`.
    expect(alvoValido(FLUXO_AMAZON.estoque, CANARIO_TODOS)).toBe(true);
    expect(chaveDoAlvo(FLUXO_AMAZON.estoque, 'c1', CANARIO_TODOS)).toBeNull();
    expect(decidirAlvo(v, 'c1', CANARIO_TODOS)).toEqual({
      modo: 'dry-run',
      motivo: 'alvo-nao-listavel',
    });
    expect(decidirAlvo(estoqueCom(CANARIO_TODOS), 'c1', CANARIO_TODOS)).toEqual({
      modo: 'on',
      motivo: 'todos',
    });
    // Near-miss: a `*` INSIDE a longer SKU is an ordinary listable character.
    expect(estoqueCom('c1:A*').canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:A*']),
      entradas: 1,
      malformadas: [],
    });
  });

  it('c1:SKU-1 authorizes c1:SKU-1 — and not c2:SKU-1, c1:SKU-10, c1:SKU, c1:sku-1, C1:SKU-1', () => {
    const v = estoqueCom('c1:SKU-1');
    expect(decidirAlvo(v, 'c1', 'SKU-1')).toEqual({ modo: 'on', motivo: 'no-canario' });
    for (const [conta, sku] of [
      ['c2', 'SKU-1'],
      ['c1', 'SKU-10'], // the entry is a prefix of the target
      ['c1', 'SKU'], // the target is a prefix of the entry
      ['c1', 'sku-1'], // no case fold of the SKU
      ['C1', 'SKU-1'], // nor of the conta
      ['c', '1:SKU-1'], // the same text, split elsewhere
    ]) {
      expect(decidirAlvo(v, conta, sku), `${conta}:${sku}`).toEqual({
        modo: 'dry-run',
        motivo: 'fora-do-canario',
      });
    }
  });

  it('an entry splits at its FIRST `:` — `c1:A:B` lists conta c1 and SKU `A:B`', () => {
    const v = estoqueCom('c1:A:B');
    expect(v.canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:A:B']),
      entradas: 1,
      malformadas: [],
    });
    expect(decidirAlvo(v, 'c1', 'A:B')).toEqual({ modo: 'on', motivo: 'no-canario' });
    // Near-miss: a last-colon split would read conta `c1:A`, which is no conta id.
    expect(decidirAlvo(v, 'c1:A', 'B')).toEqual({ modo: 'dry-run', motivo: 'alvo-invalido' });
  });

  it('a trailing comma and `,,` are malformed at their positions; the rest still counts', () => {
    expect(estoqueCom('c1:SKU-1,').canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:SKU-1']),
      entradas: 2,
      malformadas: [2],
    });
    expect(estoqueCom(',,').canario).toEqual({
      tipo: 'lista',
      chaves: new Set(),
      entradas: 3,
      malformadas: [1, 2, 3],
    });
    expect(estoqueCom('c1:SKU-1,,c2:SKU-2').canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:SKU-1', 'c2:SKU-2']),
      entradas: 3,
      malformadas: [2],
    });
  });

  it('duplicates collapse into one key, and still count as entries', () => {
    expect(estoqueCom('c1:SKU-1,c1:SKU-1,c2:SKU-1').canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c1:SKU-1', 'c2:SKU-1']),
      entradas: 3,
      malformadas: [],
    });
  });

  it.each([
    ['a leading space (nothing trimmed)', ' c1:SKU-1'],
    ['a trailing space', 'c1:SKU-1 '],
    ['a space inside the SKU', 'c1:SKU 1'],
    ['no colon', 'c1SKU-1'],
    ['an empty conta', ':SKU-1'],
    ['an empty SKU', 'c1:'],
    ['a conta outside the grammar', 'c/1:SKU-1'],
    ['a non-ASCII SKU', 'c1:Ação'],
    ['a 41-character SKU', `c1:${'S'.repeat(41)}`],
    ['a tab', 'c1:SKU\t1'],
  ])('malformed: %s', (_c, entrada) => {
    const v = estoqueCom(`c2:SKU-2,${entrada}`);
    expect(v.canario).toEqual({
      tipo: 'lista',
      chaves: new Set(['c2:SKU-2']),
      entradas: 2,
      malformadas: [2],
    });
  });

  it('near-miss: the SKU grammar boundaries that ARE well formed (1 and 40 characters, every printable but space and comma)', () => {
    const printaveis = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
      String.fromCharCode(0x21 + i),
    )
      .filter((c) => c !== ',')
      .join('');
    const v = estoqueCom(
      `c1:X,c1:${'S'.repeat(40)},c1:${printaveis.slice(0, 40)},c1:${printaveis.slice(40, 80)},c1:${printaveis.slice(80)}`,
    );
    expect(v.canario.tipo === 'lista' && v.canario.malformadas).toEqual([]);
    for (const sku of ['X', 'S'.repeat(40), printaveis.slice(0, 40), printaveis.slice(80)]) {
      expect(decidirAlvo(v, 'c1', sku), sku).toEqual({ modo: 'on', motivo: 'no-canario' });
    }
  });

  it('an order list takes 3-7-7 ids only: 3-7-8, 4-7-7 and a SKU are malformed', () => {
    for (const fluxo of [FLUXO_AMAZON.nfe, FLUXO_AMAZON.agendamento]) {
      const v = lerValvula(
        fluxo,
        ligado(fluxo, `c1:${PEDIDO_1},c1:${PEDIDO_1}0,c1:0${PEDIDO_1},c1:SKU-1`),
      );
      expect(v.canario).toEqual({
        tipo: 'lista',
        chaves: new Set([`c1:${PEDIDO_1}`]),
        entradas: 4,
        malformadas: [2, 3, 4],
      });
      expect(decidirAlvo(v, 'c1', PEDIDO_1)).toEqual({ modo: 'on', motivo: 'no-canario' });
      expect(decidirAlvo(v, 'c1', PEDIDO_2)).toEqual({
        modo: 'dry-run',
        motivo: 'fora-do-canario',
      });
    }
  });

  it('a stock list is not an order list: lerCanario reads each by its own grammar', () => {
    expect(lerCanario(`c1:${PEDIDO_1}`, 'sku')).toEqual({
      tipo: 'lista',
      chaves: new Set([`c1:${PEDIDO_1}`]),
      entradas: 1,
      malformadas: [],
    });
    expect(lerCanario('c1:SKU-1', 'pedido')).toEqual({
      tipo: 'lista',
      chaves: new Set(),
      entradas: 1,
      malformadas: [1],
    });
    expect(TIPO_DE_ALVO).toEqual({
      estoque: 'sku',
      preco: 'sku',
      nfe: 'pedido',
      agendamento: 'pedido',
    });
  });

  it('the list is ignored under dry-run and off', () => {
    for (const canario of [CANARIO_TODOS, 'c1:SKU-1', undefined]) {
      const ambiente = (modo: string) => ({
        [VALVULA_ENV_AMAZON.estoque]: modo,
        [CANARIO_ENV_AMAZON.estoque]: canario,
      });
      const dry = lerValvula(FLUXO_AMAZON.estoque, ambiente('dry-run'));
      expect(decidirAlvo(dry, 'c1', 'SKU-1')).toEqual({ modo: 'dry-run', motivo: 'valvula' });
      const off = lerValvula(FLUXO_AMAZON.estoque, ambiente('off'));
      expect(decidirAlvo(off, 'c1', 'SKU-1')).toEqual({ modo: 'off' });
      const torto = lerValvula(FLUXO_AMAZON.estoque, ambiente('ON'));
      expect(decidirAlvo(torto, 'c1', 'SKU-1')).toEqual({ modo: 'off' });
    }
  });
});

describe('target keys: valid, listable, and the keys a list can match', () => {
  it.each([
    ['a listable SKU', 'SKU-1', true],
    ['a SKU with a space', 'SKU 1', true],
    ['a SKU with a comma', 'SKU,1', true],
    ['a non-ASCII SKU', 'Ação', true],
    ['40 astral code points', '😀'.repeat(40), true],
    ['41 astral code points', '😀'.repeat(41), false],
    ['40 characters', 'S'.repeat(40), true],
    ['41 characters', 'S'.repeat(41), false],
    ['empty', '', false],
    ['a NUL', 'SKU\u00001', false],
    ['a DEL', 'SKU\u007f', false],
    ['a C1 control', 'SKU\u0085', false],
    ['a newline', 'SKU-1\n', false],
    ['a lone surrogate', 'SKU\ud800', false],
  ])('stock: %s → valid %s', (_c, sku, valido) => {
    expect(alvoValido(FLUXO_AMAZON.estoque, sku)).toBe(valido);
    expect(alvoValido(FLUXO_AMAZON.preco, sku)).toBe(valido);
  });

  it.each([
    [PEDIDO_1, true],
    [`${PEDIDO_1}0`, false],
    [`0${PEDIDO_1}`, false],
    ['000-0000000-000000a', false],
    ['000 0000000 0000001', false],
    ['SKU-1', false],
  ])('orders: %j → valid %s', (pedido, valido) => {
    expect(alvoValido(FLUXO_AMAZON.nfe, pedido)).toBe(valido);
    expect(alvoValido(FLUXO_AMAZON.agendamento, pedido)).toBe(valido);
  });

  it('a non-string target is never valid, and never a key', () => {
    for (const alvo of [undefined, null, 1, ['SKU-1'], { toString: () => 'SKU-1' }]) {
      expect(alvoValido(FLUXO_AMAZON.estoque, alvo)).toBe(false);
      expect(chaveDoAlvo(FLUXO_AMAZON.estoque, 'c1', alvo)).toBeNull();
    }
  });

  it('chaveDoAlvo is `<contaId>:<alvo>` for a valid, LISTABLE target, else null', () => {
    expect(chaveDoAlvo(FLUXO_AMAZON.estoque, 'c1', 'SKU-1')).toBe('c1:SKU-1');
    expect(chaveDoAlvo(FLUXO_AMAZON.estoque, 'c1', 'A:B')).toBe('c1:A:B');
    expect(chaveDoAlvo(FLUXO_AMAZON.nfe, 'c1', PEDIDO_1)).toBe(`c1:${PEDIDO_1}`);
    for (const [conta, sku] of [
      ['c1', 'SKU 1'], // valid, not listable
      ['c1', 'SKU,1'], // valid, not listable
      ['c1', 'Ação'], // valid, not listable
      ['c/1', 'SKU-1'], // invalid conta
      ['', 'SKU-1'],
      ['c1', ''],
    ]) {
      expect(chaveDoAlvo(FLUXO_AMAZON.estoque, conta, sku), `${conta}:${sku}`).toBeNull();
    }
    expect(chaveDoAlvo(FLUXO_AMAZON.nfe, 'c1', 'SKU-1')).toBeNull();
  });

  it.each(['SKU 1', 'SKU,1', 'Ação'])(
    '%j is valid but not listable: alvo-nao-listavel under a list, on under `*`',
    (sku) => {
      // Even a list that "names" it cannot: the comma splits it, the space malforms it.
      const lista = estoqueCom(`c1:SKU-1,c1:${sku}`);
      expect(decidirAlvo(lista, 'c1', sku)).toEqual({
        modo: 'dry-run',
        motivo: 'alvo-nao-listavel',
      });
      expect(decidirAlvo(estoqueCom(CANARIO_TODOS), 'c1', sku)).toEqual({
        modo: 'on',
        motivo: 'todos',
      });
    },
  );

  it("a malformed entry can never equal a key: it adds NO key, and every key is a target's own", () => {
    // Each alone: a one-entry list with no key at all, whatever the entry's text.
    const MALFORMADAS = [
      ' c1:SKU-1',
      'c1:SKU-1 ',
      ' ',
      'c1:SKU 1',
      'c1SKU-1',
      ':SKU-1',
      'c1:',
      'c/1:SKU-1',
      '"c1:SKU-1"',
      'c1:Ação',
      `c1:${'S'.repeat(41)}`,
      'c1:SKU\t1',
      'c1:*',
    ];
    for (const entrada of MALFORMADAS) {
      expect(lerCanario(entrada, 'sku'), JSON.stringify(entrada)).toEqual({
        tipo: 'lista',
        chaves: new Set(),
        entradas: 1,
        malformadas: [1],
      });
    }
    // Mixed with well-formed ones (and a `*` inside the list): exactly the
    // well-formed keys, each one the key `chaveDoAlvo` gives its own target.
    const v = lerCanario(['c1:SKU-1', ...MALFORMADAS, CANARIO_TODOS, 'c2:A:B'].join(','), 'sku');
    expect(v.tipo).toBe('lista');
    if (v.tipo !== 'lista') return;
    expect(v.chaves).toEqual(new Set(['c1:SKU-1', 'c2:A:B']));
    expect(v.entradas - v.malformadas.length).toBe(v.chaves.size);
    for (const chave of v.chaves) {
      const i = chave.indexOf(':');
      expect(chaveDoAlvo(FLUXO_AMAZON.estoque, chave.slice(0, i), chave.slice(i + 1))).toBe(chave);
    }
    // The decision: the entry's own text, as a target, is no conta id at all.
    const lista = estoqueCom(' c1:SKU-1');
    expect(decidirAlvo(lista, 'c1', 'SKU-1')).toEqual({
      modo: 'dry-run',
      motivo: 'fora-do-canario',
    });
    expect(decidirAlvo(lista, ' c1', 'SKU-1')).toEqual({
      modo: 'dry-run',
      motivo: 'alvo-invalido',
    });
  });

  it.each(FLUXOS)(
    '%s: an invalid conta or target dry-runs as alvo-invalido under `*`, a list, and NO list (validity is checked first)',
    (fluxo) => {
      for (const canario of [CANARIO_TODOS, `c1:${ALVO[fluxo]}`, undefined]) {
        const v = lerValvula(fluxo, ligado(fluxo, canario));
        for (const [conta, alvo] of [
          ['c/1', ALVO[fluxo]],
          ['', ALVO[fluxo]],
          ['x'.repeat(129), ALVO[fluxo]],
          [undefined, ALVO[fluxo]],
          ['c1', ''],
          ['c1', 'X'.repeat(41)],
          ['c1', 'SKU\u00001'],
          ['c1', undefined],
          ['c1', 42],
        ] as const) {
          expect(
            decidirAlvo(v, conta, alvo),
            `${String(canario)} → ${String(conta)}:${String(alvo)}`,
          ).toEqual({ modo: 'dry-run', motivo: 'alvo-invalido' });
        }
        // An order flow refuses a SKU, and a SKU flow takes an order id as a SKU.
        if (TIPO_DE_ALVO[fluxo] === 'pedido') {
          expect(decidirAlvo(v, 'c1', 'SKU-1')).toEqual({
            modo: 'dry-run',
            motivo: 'alvo-invalido',
          });
        }
      }
    },
  );
});

describe('decidirLote: a feed ONLY under `on` and exactly `*` (§4.26)', () => {
  it.each(FLUXOS_COM_LOTE)('%s: the decision table', (fluxo) => {
    const lote = (modo: string | undefined, canario: string | undefined) =>
      decidirLote(
        lerValvula(fluxo, {
          [VALVULA_ENV_AMAZON[fluxo]]: modo,
          [CANARIO_ENV_AMAZON[fluxo]]: canario,
        }),
      );
    expect(lote('on', CANARIO_TODOS)).toEqual({ modo: 'feed' });
    expect(lote('on', 'c1:SKU-1')).toEqual({ modo: 'so-patches-do-canario' });
    expect(lote('on', ' *')).toEqual({ modo: 'so-patches-do-canario' });
    // Spaces alone are a list of one malformed entry: patches, of no target at all.
    expect(lote('on', ' ')).toEqual({ modo: 'so-patches-do-canario' });
    expect(lote('on', undefined)).toEqual({ modo: 'dry-run', motivo: 'sem-canario' });
    expect(lote('on', '')).toEqual({ modo: 'dry-run', motivo: 'sem-canario' });
    // Near-miss: a dry-run never becomes a feed, whatever the list says.
    expect(lote('dry-run', CANARIO_TODOS)).toEqual({ modo: 'dry-run', motivo: 'valvula' });
    expect(lote('dry-run', 'c1:SKU-1')).toEqual({ modo: 'dry-run', motivo: 'valvula' });
    expect(lote('off', CANARIO_TODOS)).toEqual({ modo: 'off' });
    expect(lote(undefined, CANARIO_TODOS)).toEqual({ modo: 'off' });
    expect(lote('ON', CANARIO_TODOS)).toEqual({ modo: 'off' });
  });

  it('near-miss: a list naming EVERY SKU of the batch is still patches, never a feed', () => {
    const skus = Array.from({ length: 50 }, (_, i) => `SKU-${String(i)}`);
    const v = estoqueCom(skus.map((s) => `c1:${s}`).join(','));
    expect(skus.every((s) => decidirAlvo(v, 'c1', s).modo === 'on')).toBe(true);
    expect(decidirLote(v)).toEqual({ modo: 'so-patches-do-canario' });
  });

  it('only stock and price have batches: a per-order flow does not compile into decidirLote', () => {
    expect(FLUXOS_COM_LOTE).toEqual(['estoque', 'preco']);
    const nfe = lerValvula(FLUXO_AMAZON.nfe, {});
    // @ts-expect-error — the NF-e and the scheduling are per order: there is no batch to decide.
    expect(decidirLote(nfe)).toEqual({ modo: 'off' });
  });
});

describe('registrarValvulaAmazon — the run-start line', () => {
  const primitivo = (x: unknown) =>
    x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';

  it('one line, primitives only; counts and positions describe the list', () => {
    const { logger, linhas } = loggerEspiao();
    const v = estoqueCom('c1:SKU-1,c1:SKU-1,,c1:SKU 2');
    registrarValvulaAmazon(logger, v, { conta: 'c1', idTarefa: 'tarefa-1' });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.mensagem).toBe('[amazon] valvula estoque: on');
    expect(linhas[0]?.meta).toEqual({
      modo: 'on',
      modoReconhecido: true,
      canario: 'lista',
      entradas: 4,
      chavesValidas: 1,
      malformadas: '3,4',
      evento: 'valvula',
      conta: 'c1',
      idTarefa: 'tarefa-1',
      fluxo: 'estoque',
    });
    expect(Object.values(linhas[0]?.meta ?? {}).every(primitivo)).toBe(true);
  });

  it('a malformed entry is logged by POSITION only, never by its text', () => {
    const { logger, linhas } = loggerEspiao();
    const colado = 'colado por engano: texto-do-operador';
    const v = estoqueCom(`c1:SKU-1,${colado},c2:${colado}`);
    registrarValvulaAmazon(logger, v);
    expect(linhas[0]?.meta?.malformadas).toBe('2,3');
    const texto = JSON.stringify(linhas);
    expect(texto).not.toContain('colado');
    expect(texto).not.toContain('texto-do-operador');
    // Nor a well-formed one: the list itself never reaches the line.
    expect(texto).not.toContain('SKU-1');
  });

  it('an unrecognised mode is a WARNING line that never echoes the value', () => {
    const { logger, linhas } = loggerEspiao();
    const cru = 'ON-colado-por-engano';
    registrarValvulaAmazon(logger, lerValvula(FLUXO_AMAZON.nfe, { [VALVULA_ENV_AMAZON.nfe]: cru }));
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta).toMatchObject({ modo: 'off', modoReconhecido: false });
    expect(JSON.stringify(linhas)).not.toContain(cru);
  });

  it('`nenhum` and `todos` are INFO with no counts', () => {
    for (const [canario, tipo] of [
      [undefined, 'nenhum'],
      [CANARIO_TODOS, 'todos'],
    ] as const) {
      const { logger, linhas } = loggerEspiao();
      registrarValvulaAmazon(logger, estoqueCom(canario));
      expect(linhas[0]?.nivel).toBe('info');
      expect(linhas[0]?.meta).toMatchObject({
        canario: tipo,
        entradas: null,
        chavesValidas: null,
        malformadas: null,
      });
    }
  });

  it('`fluxo` comes from the valve: a caller cannot relabel the line', () => {
    const { logger, linhas } = loggerEspiao();
    const v = lerValvula(FLUXO_AMAZON.agendamento, {});
    registrarValvulaAmazon(logger, v, { fluxo: 'estoque', evento: 'chamada' } as never);
    expect(linhas[0]?.meta).toMatchObject({ fluxo: 'agendamento', evento: 'valvula' });
    expect(linhas[0]?.mensagem).toBe('[amazon] valvula agendamento: off');
  });

  it('a hand-built valve (a cast) with a mode outside the union decides off, per target and per batch', () => {
    // `ValvulaAmazon` is exported: a later step may rebuild one from a payload.
    for (const modo of ['ON', 'texto-cru', undefined]) {
      const torto = { ...estoqueCom(CANARIO_TODOS), modo: modo as never };
      expect(decidirAlvo(torto, 'c1', 'SKU-1'), String(modo)).toEqual({ modo: 'off' });
      expect(decidirLote(torto), String(modo)).toEqual({ modo: 'off' });
    }
  });

  it('a hand-built valve logs <invalido> for its flow, mode and canary kind — never the raw text — at WARNING', () => {
    const { logger, linhas } = loggerEspiao();
    const forjada = {
      fluxo: 'intake',
      modo: 'texto-cru-do-operador',
      modoReconhecido: true,
      canario: { tipo: 'canario-cru-do-operador' },
    } as unknown as ValvulaAmazon;
    registrarValvulaAmazon(logger, forjada, { idTarefa: 'tarefa-1' });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.mensagem).toBe('[amazon] valvula <invalido>: <invalido>');
    expect(linhas[0]?.meta).toEqual({
      modo: '<invalido>',
      modoReconhecido: false,
      canario: '<invalido>',
      entradas: null,
      chavesValidas: null,
      malformadas: null,
      evento: 'valvula',
      idTarefa: 'tarefa-1',
      fluxo: '<invalido>',
    });
    const texto = JSON.stringify(linhas);
    for (const cru of ['intake', 'texto-cru-do-operador', 'canario-cru-do-operador']) {
      expect(texto).not.toContain(cru);
    }
  });

  it('a hand-built valve with a valid `on` but a canary kind outside its set: no target, and a WARNING', () => {
    const { logger, linhas } = loggerEspiao();
    const torta = { ...estoqueCom(CANARIO_TODOS), canario: { tipo: 'canario-cru' } as never };
    expect(decidirAlvo(torta, 'c1', 'SKU-1')).toEqual({ modo: 'dry-run', motivo: 'sem-canario' });
    expect(decidirLote(torta)).toEqual({ modo: 'dry-run', motivo: 'sem-canario' });
    expect(severidadeDaValvula(torta)).toBe('WARNING');
    registrarValvulaAmazon(logger, torta);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta).toMatchObject({
      fluxo: 'estoque',
      modo: 'on',
      modoReconhecido: true,
      canario: '<invalido>',
    });
    expect(JSON.stringify(linhas)).not.toContain('canario-cru');
  });

  it('a real flow with a cast mode `ON`: the message names the flow and `<invalido>`, never `ON`', () => {
    const { logger, linhas } = loggerEspiao();
    registrarValvulaAmazon(logger, { ...estoqueCom(CANARIO_TODOS), modo: 'ON' as never });
    expect(linhas[0]?.mensagem).toBe('[amazon] valvula estoque: <invalido>');
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta).toMatchObject({ fluxo: 'estoque', modo: '<invalido>' });
    expect(JSON.stringify(linhas)).not.toContain('ON');
  });

  it('camposDaValvula names no envelope key, so a campo can never relabel either', () => {
    const campos = camposDaValvula(estoqueCom('c1:SKU-1'));
    expect(Object.keys(campos)).toEqual([
      'modo',
      'modoReconhecido',
      'canario',
      'entradas',
      'chavesValidas',
      'malformadas',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 Name drift                                  */
/* -------------------------------------------------------------------------- */

describe('the names: one valve and one list per flow, documented where the operator looks', () => {
  const NOMES = [
    ...Object.values(VALVULA_ENV_AMAZON),
    ...Object.values(CANARIO_ENV_AMAZON),
    CHAMADAS_ENV_AMAZON,
  ];
  const linhasDe = (relativo: string) =>
    readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8').split(/\r?\n/);
  const ENV_EXAMPLE = linhasDe('../../../../../.env.example');
  const APPHOSTING = linhasDe('../../../apphosting.yaml');

  it('four valves, four canary lists, one switch — distinct, prefixed, none secret-shaped', () => {
    expect(Object.keys(VALVULA_ENV_AMAZON)).toEqual(FLUXOS);
    expect(Object.keys(CANARIO_ENV_AMAZON)).toEqual(FLUXOS);
    expect(new Set(NOMES).size).toBe(9);
    for (const nome of NOMES) {
      expect(nome).toMatch(/^AMAZON_[A-Z_]+$/);
      // `env-example-split.test.js`'s credential suffixes: these are config.
      expect(nome).not.toMatch(/(SECRET|PASSWORD|_TOKEN|PRIVATE_KEY|CERT_BASE64|ENC_KEY)$/);
    }
  });

  it.each(NOMES)(
    '%s: a BLANK line in .env.example and a comment row in apphosting.yaml',
    (nome) => {
      expect(ENV_EXAMPLE.filter((l) => l.startsWith(`${nome}=`))).toEqual([`${nome}=`]);
      expect(APPHOSTING.some((l) => new RegExp(`^#\\s+${nome}\\b`).test(l))).toBe(true);
    },
  );

  it('apphosting.yaml declares none of them outside a comment — a baked `off` could override the console', () => {
    for (const nome of NOMES) {
      expect(
        APPHOSTING.some((l) => !l.trimStart().startsWith('#') && l.includes(nome)),
        nome,
      ).toBe(false);
    }
    expect(APPHOSTING.some((l) => /^env\s*:/.test(l))).toBe(false);
  });

  it('the flow and mode values are what the log query filters on', () => {
    expect(FLUXOS).toEqual(['estoque', 'preco', 'nfe', 'agendamento']);
    expect(Object.values(MODO_AMAZON)).toEqual(['off', 'dry-run', 'on']);
    expect(CANARIO_TODOS).toBe('*');
  });
});
