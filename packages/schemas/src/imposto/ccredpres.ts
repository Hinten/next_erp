/**
 * Anexo IV (NT 2025.002) — `cCredPres`, the crédito presumido classification
 * codes carried in `gCredPresOper` (UB122). HAND-TRANSCRIBED DATA, not codegen
 * output (root CLAUDE.md rule 3), reviewed as source.
 *
 * Source: https://dfe-portal.svrs.rs.gov.br/DFE/TabelaCreditoPresumido (public
 * SVRS "Conformidade Fácil" page), retrieved 2026-09-28. The page prints the
 * codes as `1`…`13`; the XSD type `TcCredPres` is `\d{2}`
 * (`DFeTiposBasicos_v1.00.xsd`), so they are stored zero-padded, `'01'`…`'13'`.
 * Descriptions are whitespace-folded; flags are verbatim. The page shows no
 * start-of-validity date per code, so none is recorded here.
 *
 * Nothing emits `gCredPresOper` yet (#500) — the table is vendored with Anexo III
 * (#333) so the picker and a later builder read one reviewed copy.
 */
import type { ProvenienciaTabelaRtc } from './cclasstrib';

export const TRIBUTO_CREDITO_PRESUMIDO = { ibs: 'IBS', cbs: 'CBS' } as const;
export type TributoCreditoPresumido =
  (typeof TRIBUTO_CREDITO_PRESUMIDO)[keyof typeof TRIBUTO_CREDITO_PRESUMIDO];

export interface CCredPresEntry {
  /** 2 digits, `'01'`…`'13'` (XSD `TcCredPres`). */
  readonly cCredPres: string;
  readonly descricao: string;
  /** "Apropria DFE" — the credit can be appropriated in the fiscal document itself. */
  readonly apropriaDfe: boolean;
  /** "Apropria Evento" — …or through an event. */
  readonly apropriaEvento: boolean;
  /** "Deduz Valor Total" — the credit is deducted from the document total. */
  readonly deduzValorTotal: boolean;
  /** Which tax the credit applies to. */
  readonly tributos: readonly TributoCreditoPresumido[];
}

export const CCREDPRES_PROVENIENCIA: ProvenienciaTabelaRtc = {
  fonte: 'https://dfe-portal.svrs.rs.gov.br/DFE/TabelaCreditoPresumido',
  obtidoEm: '2026-09-28',
  publicadoAte: null,
  filtro: null,
  linhas: 13,
};

export const CCREDPRES_TABELA: readonly CCredPresEntry[] = [
  {
    cCredPres: '01',
    descricao:
      'Crédito presumido da aquisição de bens e serviços de produtor rural e produtor rural integrado não contribuinte, observado o art. 168 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: true,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs, TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '02',
    descricao:
      'Crédito presumido da aquisição de serviço de transportador autônomo de carga pessoa física não contribuinte, observado o art. 169 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: false,
    apropriaEvento: true,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs, TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '03',
    descricao:
      'Crédito presumido da aquisição de resíduos e demais materiais destinados à reciclagem, reutilização ou logística reversa adquiridos de pessoa física, cooperativa ou outra forma de organização popular, observado o art. 170 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: true,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs, TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '04',
    descricao:
      'Crédito presumido da aquisição de bens móveis usados de pessoa física não contribuinte para revenda, observado o art. 171 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: true,
    deduzValorTotal: true,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs, TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '05',
    descricao:
      'Crédito presumido no regime automotivo, observado o art. 311 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: false,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '06',
    descricao:
      'Crédito presumido no regime automotivo, observado o art. 312 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: false,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '07',
    descricao:
      'Crédito presumido na aquisição por contribuinte na Zona Franca de Manaus, observado o art. 444 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: false,
    deduzValorTotal: true,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs],
  },
  {
    cCredPres: '08',
    descricao:
      'Crédito presumido na aquisição por contribuinte na Zona Franca de Manaus, observado o art. 447 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: false,
    apropriaEvento: true,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs],
  },
  {
    cCredPres: '09',
    descricao:
      'Crédito presumido na aquisição por contribuinte na Zona Franca de Manaus, observado o art. 449 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: false,
    apropriaEvento: true,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs],
  },
  {
    cCredPres: '10',
    descricao:
      'Crédito presumido na aquisição por contribuinte na Zona Franca de Manaus, observado o art. 450 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: false,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
  {
    cCredPres: '11',
    descricao:
      'Crédito presumido na aquisição por contribuinte na Área de Livre Comércio, observado o art. 462 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: false,
    deduzValorTotal: true,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs],
  },
  {
    cCredPres: '12',
    descricao:
      'Crédito presumido na aquisição por contribuinte na Área de Livre Comércio, observado o art. 465 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: false,
    apropriaEvento: true,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.ibs],
  },
  {
    cCredPres: '13',
    descricao:
      'Crédito presumido na aquisição pela indústria na Área de Livre Comércio, observado o art. 467 da Lei Complementar nº 214, de 2025.',
    apropriaDfe: true,
    apropriaEvento: false,
    deduzValorTotal: false,
    tributos: [TRIBUTO_CREDITO_PRESUMIDO.cbs],
  },
];

const POR_CODIGO = new Map(CCREDPRES_TABELA.map((e) => [e.cCredPres, e]));

/** The row for a 2-digit cCredPres code, or null. Exact match only — `'1'` is not `'01'`. */
export function cCredPresEntry(code: string | null | undefined): CCredPresEntry | null {
  if (!code) return null;
  return POR_CODIGO.get(code) ?? null;
}
