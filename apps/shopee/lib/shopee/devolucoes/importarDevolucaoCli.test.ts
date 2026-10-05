/**
 * The `importar:devolucao` CLI's testable half (#1525, step 17): the argv
 * parser. It used to live inline in `scripts/importar-devolucao.ts`, outside
 * vitest's `include`, so its two refusals — `--live` and a `return_sn` outside
 * the shared predicate — could be deleted with every suite still green
 * (mutation survivors O-CLI-1 / O-CLI-2, review R5 F4). This file is gap test
 * G3 plus the rest of the parser's contract.
 *
 * A predicate test names a PAIR (must come out equal) and a NEAR-MISS (must
 * stay distinct). ⚠️ Fixture ids only.
 */
import { describe, expect, it } from 'vitest';

import {
  ArgumentoInvalidoError,
  MSG_LIVE_NAO_EXISTE,
  MSG_RETURN_SN_FORA_DO_FORMATO,
  USO_IMPORTAR_DEVOLUCAO,
  parseArgs,
} from './importarDevolucaoCli';

const BASE = ['--integracao', 'int-1', '--return-sn'];
const RETURN_SN_DIGITOS = '2609100000000001';
const RETURN_SN_ALFA = '260910ABCDE0001';

/** The refusal's message — and the proof that it IS a refusal of this class. */
function recusa(argv: readonly string[]): string {
  try {
    parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgumentoInvalidoError) return err.message;
    throw err;
  }
  throw new Error(`parseArgs aceitou ${JSON.stringify(argv)}`);
}

describe('G3 — as duas recusas do parser (O-CLI-1 / O-CLI-2)', () => {
  it('O-CLI-1: --live é RECUSADO, com o motivo — nunca aceito em silêncio', () => {
    expect(() => parseArgs([...BASE, RETURN_SN_DIGITOS, '--live'])).toThrow(ArgumentoInvalidoError);
    expect(recusa([...BASE, RETURN_SN_DIGITOS, '--live'])).toBe(MSG_LIVE_NAO_EXISTE);
  });

  it('O-CLI-1 (par): --live=1 também — a forma inline não é uma porta lateral', () => {
    expect(recusa([...BASE, RETURN_SN_DIGITOS, '--live=1'])).toBe(MSG_LIVE_NAO_EXISTE);
  });

  it('O-CLI-1 (quase): --dry-run é aceito e é o único modo', () => {
    expect(parseArgs([...BASE, RETURN_SN_DIGITOS, '--dry-run'])).toEqual({
      kind: 'ensaiar',
      args: {
        integracaoId: 'int-1',
        returnSn: RETURN_SN_DIGITOS,
        orderSn: null,
        json: false,
        projectId: null,
      },
    });
  });

  it('O-CLI-2: return_sn fora do formato é recusado', () => {
    expect(() => parseArgs([...BASE, '2609-0001'])).toThrow(/fora do formato/);
  });

  it.each<[string, string]>([
    ['hífen', '2609-0001'],
    ['ponto', '2609.0001'],
    ['65 caracteres', `A${'1'.repeat(64)}`],
    ['não-ASCII', '2609ÁBCDE'],
    ['espaço interno', '2609 0001'],
  ])('O-CLI-2: %s ⇒ recusado, e a mensagem não ecoa o valor', (_t, sn) => {
    const msg = recusa([...BASE, sn]);
    expect(msg).toBe(MSG_RETURN_SN_FORA_DO_FORMATO);
    expect(msg).not.toContain(sn);
  });

  it('QUASE-IGUAL: o alfanumérico passa VERBATIM', () => {
    expect(parseArgs([...BASE, RETURN_SN_ALFA])).toEqual({
      kind: 'ensaiar',
      args: {
        integracaoId: 'int-1',
        returnSn: RETURN_SN_ALFA,
        orderSn: null,
        json: false,
        projectId: null,
      },
    });
  });

  it('QUASE-IGUAL: 64 caracteres passam; 65 não (o predicado compartilhado)', () => {
    const sessentaEQuatro = `A${'1'.repeat(63)}`;
    const r = parseArgs([...BASE, sessentaEQuatro]);
    expect(r.kind === 'ensaiar' && r.args.returnSn).toBe(sessentaEQuatro);
    expect(recusa([...BASE, `${sessentaEQuatro}1`])).toBe(MSG_RETURN_SN_FORA_DO_FORMATO);
  });
});

describe('o resto do contrato do parser', () => {
  it('--help e -h respondem ANTES de validar qualquer coisa — mesmo ao lado de --live', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgs(['-h', '--live'])).toEqual({ kind: 'ajuda' });
  });

  it('todas as opções, separadas e inline, chegam por nome', () => {
    expect(
      parseArgs([
        '--integracao=int-1',
        '--return-sn',
        RETURN_SN_ALFA,
        '--order-sn',
        '260910KJBHUJDM',
        '--project=demo-erp',
        '--json',
      ]),
    ).toEqual({
      kind: 'ensaiar',
      args: {
        integracaoId: 'int-1',
        returnSn: RETURN_SN_ALFA,
        orderSn: '260910KJBHUJDM',
        json: true,
        projectId: 'demo-erp',
      },
    });
  });

  it.each<[string, readonly string[], RegExp]>([
    ['sem --integracao', ['--return-sn', RETURN_SN_DIGITOS], /--integracao .* obrigatório/],
    ['sem --return-sn', ['--integracao', 'int-1'], /--return-sn .* obrigatório/],
    ['--return-sn= vazio', ['--integracao', 'int-1', '--return-sn='], /--return-sn exige um valor/],
    ['--return-sn só espaços', [...BASE, '   '], /--return-sn exige um valor/],
    ['--return-sn sem valor no fim', [...BASE], /--return-sn exige um valor/],
    [
      'uma flag sem valor não engole a seguinte',
      ['--integracao', '--return-sn', RETURN_SN_DIGITOS],
      /--integracao exige um valor/,
    ],
    ['o separador "--"', ['--', ...BASE, RETURN_SN_DIGITOS], /Separador "--"/],
    ['uma opção desconhecida', [...BASE, RETURN_SN_DIGITOS, '--forcar'], /desconhecida/],
  ])('%s ⇒ ArgumentoInvalidoError', (_t, argv, mensagem) => {
    expect(recusa(argv)).toMatch(mensagem);
  });

  it('a ajuda diz que não há --live e não carrega o separador "--" do pnpm', () => {
    expect(USO_IMPORTAR_DEVOLUCAO).toContain('Não existe --live');
    expect(USO_IMPORTAR_DEVOLUCAO).not.toMatch(/importar:devolucao\s+--\s/);
  });
});
