import { describe, expect, it } from 'vitest';

import {
  type DiscoDasFixturesLi,
  type ProgressoDaEscritaLi,
  escreverFixturesLi,
  novoProgressoDaEscritaLi,
  resumoDoProgressoLi,
} from './escrita';

/** A failure the in-memory disk raises on cue (an EBUSY lock, a full disk). */
class FalhaDoDisco extends Error {
  override readonly name = 'FalhaDoDisco';
}

/** An in-memory `__wire__/`: final fixtures and temporaries, failing on cue. */
function discoEmMemoria(falhas: { readonly escrever?: string; readonly promover?: string } = {}) {
  const fixtures = new Map<string, string>([['velha', 'antes\n']]);
  const temporarios = new Map<string, string>();
  const disco: DiscoDasFixturesLi = {
    escreverTemporario: (nome, texto) => {
      if (falhas.escrever === nome) {
        // A partial temporary is left behind, as a real failing write may leave one.
        temporarios.set(nome, texto.slice(0, 2));
        throw new FalhaDoDisco('write');
      }
      temporarios.set(nome, texto);
    },
    promover: (nome) => {
      if (falhas.promover === nome) throw new FalhaDoDisco('rename');
      const texto = temporarios.get(nome);
      if (texto === undefined) throw new FalhaDoDisco('no temporary');
      fixtures.set(nome, texto);
      temporarios.delete(nome);
    },
    descartarTemporario: (nome) => {
      temporarios.delete(nome);
    },
  };
  return { disco, fixtures, temporarios };
}

const ESCRITAS = [
  { nome: 'a', texto: '{"a":1}\n' },
  { nome: 'b', texto: '{"b":2}\n' },
  { nome: 'velha', texto: '{"c":3}\n' },
];

describe('escreverFixturesLi', () => {
  it('writes every temporary first, then renames each over its fixture', () => {
    const m = discoEmMemoria();
    const progresso = novoProgressoDaEscritaLi();
    escreverFixturesLi(ESCRITAS, m.disco, progresso);
    expect(Object.fromEntries(m.fixtures)).toEqual({
      a: '{"a":1}\n',
      b: '{"b":2}\n',
      velha: '{"c":3}\n',
    });
    expect([...m.temporarios.keys()]).toEqual([]);
    expect(progresso).toEqual({ devidas: ['a', 'b', 'velha'], promovidas: ['a', 'b', 'velha'] });
    expect(resumoDoProgressoLi(progresso)).toBeNull();
  });

  it('a failed temporary write leaves EVERY fixture as it was, and no temporary behind', () => {
    const m = discoEmMemoria({ escrever: 'b' });
    const progresso = novoProgressoDaEscritaLi();
    expect(() => {
      escreverFixturesLi(ESCRITAS, m.disco, progresso);
    }).toThrow(FalhaDoDisco);
    expect(Object.fromEntries(m.fixtures)).toEqual({ velha: 'antes\n' });
    expect([...m.temporarios.keys()]).toEqual([]);
    expect(progresso).toEqual({ devidas: ['a', 'b', 'velha'], promovidas: [] });
    expect(resumoDoProgressoLi(progresso)).toBe('no fixture was written (due: a, b, velha).');
  });

  it('a failed rename says exactly which fixtures were written and which were not', () => {
    const m = discoEmMemoria({ promover: 'b' });
    const progresso = novoProgressoDaEscritaLi();
    expect(() => {
      escreverFixturesLi(ESCRITAS, m.disco, progresso);
    }).toThrow(FalhaDoDisco);
    expect(Object.fromEntries(m.fixtures)).toEqual({ a: '{"a":1}\n', velha: 'antes\n' });
    expect([...m.temporarios.keys()]).toEqual([]);
    expect(progresso).toEqual({ devidas: ['a', 'b', 'velha'], promovidas: ['a'] });
    expect(resumoDoProgressoLi(progresso)).toBe(
      '1 of 3 fixture(s) had been written (a); not written: b, velha.',
    );
  });

  it('nothing to write touches nothing, and reports nothing', () => {
    const m = discoEmMemoria({ escrever: 'a', promover: 'a' });
    const progresso: ProgressoDaEscritaLi = novoProgressoDaEscritaLi();
    escreverFixturesLi([], m.disco, progresso);
    expect(progresso).toEqual({ devidas: [], promovidas: [] });
    expect(resumoDoProgressoLi(progresso)).toBeNull();
  });
});
