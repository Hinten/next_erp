import { dvChaveAcesso } from '@delfrance/schemas';

/**
 * Minimal authorized NF-e fixtures for unit tests — NOT exported from the
 * package (tests import it relatively, like `fakePort.ts`). Only what a
 * devolução reads from an origin `nfev4` doc: a valid chave and the
 * `<det>` lines `lerItensDoProc` parses.
 */

/** A chave de acesso with a correct check digit, distinct per `n`. */
export function chaveFake(n: number): string {
  const chave43 = `3526109999999900019155004${String(n).padStart(9, '0')}100000000`;
  const dv = dvChaveAcesso(chave43);
  if (dv === null) throw new Error(`chaveFake(${n}): not a chave shape`);
  return `${chave43}${dv}`;
}

/** One origin det line; `nItem` defaults to the line's position (1-based). */
export interface LinhaFake {
  readonly cProd: string;
  readonly vUnCom?: number;
  readonly nItem?: number;
  readonly uCom?: string;
}

/** An `<nfeProc>` carrying `linhas` as its dets, in the given order. */
export function procNFeFake(linhas: readonly LinhaFake[]): string {
  const dets = linhas
    .map(
      (l, i) =>
        `<det nItem="${l.nItem ?? i + 1}"><prod><cProd>${l.cProd}</cProd><cEAN>SEM GTIN</cEAN>` +
        `<xProd>Produto ${l.cProd}</xProd><NCM>61099000</NCM><CFOP>5102</CFOP>` +
        `<uCom>${l.uCom ?? 'UN'}</uCom><qCom>1.0000</qCom><vUnCom>${l.vUnCom ?? 10}</vUnCom>` +
        `</prod><imposto/></det>`,
    )
    .join('');
  return (
    `<nfeProc versao="4.00"><NFe><infNFe Id="NFe" versao="4.00"><ide/>${dets}</infNFe></NFe>` +
    `<protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`
  );
}

/** An approved `nfev4` doc, as `listNFesAprovadas` returns it. */
export function nfeAprovadaFake(
  chave: string,
  linhas: readonly LinhaFake[] | null,
  ultimaModificacao = 1,
): Record<string, unknown> {
  return {
    chave,
    ultima_modificacao: ultimaModificacao,
    xml_nfe_proc: linhas === null ? null : procNFeFake(linhas),
  };
}
