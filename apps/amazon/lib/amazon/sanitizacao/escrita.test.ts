import { describe, expect, it } from 'vitest';

import { gerarCpf } from '../testing/documentos';
import {
  type DiscoDasFixturesAmazon,
  descreverErroAmazon,
  escreverFixturesAmazon,
  mensagemDoErroInesperadoAmazon,
  novoProgressoDaEscritaAmazon,
  resumoDoProgressoAmazon,
} from './escrita';

/** A disk that fails on the n-th call of one operation, and records what is left. */
function disco(
  falha: { readonly em: 'escreverTemporario' | 'promover'; readonly vez: number } | null,
) {
  const temporarios = new Set<string>();
  const fixtures = new Set<string>();
  const contagem = { escreverTemporario: 0, promover: 0 };
  const d: DiscoDasFixturesAmazon = {
    escreverTemporario: (nome) => {
      contagem.escreverTemporario += 1;
      if (falha?.em === 'escreverTemporario' && contagem.escreverTemporario === falha.vez) {
        throw new Error('ENOSPC');
      }
      temporarios.add(nome);
    },
    promover: (nome) => {
      contagem.promover += 1;
      if (falha?.em === 'promover' && contagem.promover === falha.vez) throw new Error('EPERM');
      temporarios.delete(nome);
      fixtures.add(nome);
    },
    descartarTemporario: (nome) => {
      temporarios.delete(nome);
    },
  };
  return { d, temporarios, fixtures };
}

const ESCRITAS = ['a', 'b', 'c'].map((nome) => ({ nome, texto: '{}\n' }));

describe('★ two-phase atomic writes', () => {
  it('a clean write promotes every fixture and leaves no temporary', () => {
    const { d, temporarios, fixtures } = disco(null);
    const p = novoProgressoDaEscritaAmazon();
    escreverFixturesAmazon(ESCRITAS, d, p);
    expect([...fixtures]).toEqual(['a', 'b', 'c']);
    expect(temporarios.size).toBe(0);
    expect(resumoDoProgressoAmazon(p)).toBeNull();
  });

  it('a failed temporary write replaces NO fixture and leaves no temporary', () => {
    const { d, temporarios, fixtures } = disco({ em: 'escreverTemporario', vez: 2 });
    const p = novoProgressoDaEscritaAmazon();
    expect(() => {
      escreverFixturesAmazon(ESCRITAS, d, p);
    }).toThrow('ENOSPC');
    expect(fixtures.size).toBe(0);
    expect(temporarios.size).toBe(0);
    expect(resumoDoProgressoAmazon(p)).toBe('no fixture was written (due: a, b, c).');
  });

  it('a failure after the first rename leaves no .tmp and reports what landed', () => {
    const { d, temporarios, fixtures } = disco({ em: 'promover', vez: 2 });
    const p = novoProgressoDaEscritaAmazon();
    expect(() => {
      escreverFixturesAmazon(ESCRITAS, d, p);
    }).toThrow('EPERM');
    expect([...fixtures]).toEqual(['a']);
    expect(temporarios.size).toBe(0);
    expect(resumoDoProgressoAmazon(p)).toBe(
      '1 of 3 fixture(s) had been written (a); not written: b, c.',
    );
  });
});

describe('★ the uncaught handler prints no message and no path', () => {
  it('only the class name and the code, plus the write progress', () => {
    const cpf = gerarCpf('529982247');
    const err = Object.assign(new TypeError(`Invalid URL: /home/fulano/capturas/${cpf}.json`), {
      code: 'ERR_INVALID_URL',
    });
    const p = novoProgressoDaEscritaAmazon();
    p.devidas = ['a', 'b'];
    p.promovidas.push('a');
    const texto = mensagemDoErroInesperadoAmazon(err, p);
    expect(texto).toBe(
      'sanitizar: unexpected error (TypeError ERR_INVALID_URL); no other detail of it is shown.\n' +
        'sanitizar: 1 of 2 fixture(s) had been written (a); not written: b.\n',
    );
    expect(texto).not.toContain(cpf);
    expect(texto).not.toContain('/home');
  });

  it('a code or a class name outside its grammar is dropped, a non-object is its type', () => {
    expect(descreverErroAmazon(Object.assign(new Error('x'), { code: 'enoent /tmp/a' }))).toBe(
      'Error',
    );
    expect(descreverErroAmazon('texto com segredo')).toBe('string');
    expect(descreverErroAmazon(null)).toBe('object');
  });
});
