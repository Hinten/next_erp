/**
 * ONE rule, read by the product import (`importacao/familiaNova.ts`, `importacao/filhoNovo.ts`)
 * and the manual stock push (`estoque/envioManualEstoqueLi.ts`): what a stored `paiId` says about
 * a produto's family. A leaf that imports nothing, so the push route's closure never reaches the
 * import machinery to share it.
 */

/**
 * A stored `paiId` as a parent id: a non-empty string, else none — absent, `null`, `''` (a legacy
 * root's spelling) and any other shape alike. Pure and total.
 */
export function paiArmazenadoLi(dados: Readonly<Record<string, unknown>>): string | null {
  const paiId = dados.paiId;
  return typeof paiId === 'string' && paiId !== '' ? paiId : null;
}
