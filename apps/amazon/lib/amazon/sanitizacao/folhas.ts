/**
 * The `--dry-run` leaf table: for every leaf of a capture's body, its path, its
 * JSON type and what the `fixture` profile did to it — NEVER its value, with two
 * closed exceptions that answer the step-2b plan's §1.2 format questions
 * (items 1–4b) without printing anything personal:
 *
 * ```
 * order.orderItems.*.product.sellerSku : string → falsificado (1)
 * order.payment.paymentExecutions.*.paymentMethod : string = Pix → mantido (1)
 * order.tax.taxRegistrations.*.taxRegistrationNumber : string ~ cpfPontuado → falsificado (1)
 * ```
 *
 * - **A closed-grammar enum leaf prints its value** (`= …`): `paymentMethod`,
 *   `programs[]`, `detailedStatus`, `packageStatus`, `taxRegistrationType`,
 *   `taxRegistrationAttributes[].key` — only when the profile KEPT it, it is an
 *   enum token (`^[A-Z][A-Za-z0-9_]{0,63}$`) and it trips no pattern (the
 *   check-digit pass included) and no listed term.
 * - **A document leaf prints its SHAPE CLASS only** (`~ …`): the name of the
 *   redactor's placeholder the value maps to (`cpfPontuado`, `cnpj14`,
 *   `cnpjRaiz8`, …), or `outro(<length>)`.
 *
 * - `mantido`: the sanitized leaf equals the raw one.
 * - `falsificado`: replaced by a fake of the same JSON type.
 * - `redigido`: replaced by something of another type.
 *
 * The raw and the sanitized trees are walked in parallel BY ENTRY POSITION
 * (`folhasEmParalelo`): the redactor keeps every object's key order and array
 * length, and renames a key in place. Array indices print as `*`, repeated
 * leaves collapse into one line with a count, and a key prints only through
 * `rotuloDeChave`.
 */
import {
  PLACEHOLDERS_DOCUMENTO_AMAZON,
  type ValorJsonAmazon,
  placeholderDeDocumento,
} from '../core/redacao';
import {
  type ListaDeNomesAmazon,
  rotuloDeChave,
  tiposDoTextoAmazon,
  tiposMascaradosAmazon,
} from '../fixtures/piiScan';

export type TratamentoDaFolhaAmazon = 'mantido' | 'falsificado' | 'redigido';
export type TipoDaFolhaAmazon = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export interface LinhaDeFolhaAmazon {
  readonly caminho: string;
  readonly tipo: TipoDaFolhaAmazon;
  readonly tratamento: TratamentoDaFolhaAmazon;
  /** `= <enum value>`, `~ <document shape class>`, or `null`. */
  readonly detalhe: string | null;
  readonly contagem: number;
}

/** One leaf of the raw tree beside what the redactor made of it. */
export interface ParDeFolhasAmazon {
  /** The path as the redaction tables spell it (raw keys, `*` for an index). */
  readonly caminhoDaTabela: string;
  /** The path as it may be PRINTED (keys through `rotuloDeChave`). */
  readonly caminhoImpresso: string;
  readonly tipo: TipoDaFolhaAmazon;
  readonly bruto: unknown;
  readonly sanitizado: unknown;
  readonly tratamento: TratamentoDaFolhaAmazon;
}

const ehObjetoSimples = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function tipoDe(v: unknown): TipoDaFolhaAmazon {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}

/** A key that cannot be part of a table path reads as `<?>` (the redactor's own rule). */
const segmentoDaTabela = (k: string) => (k === '' || k.includes('.') || k === '*' ? '<?>' : k);
const juntar = (partes: readonly string[]) => (partes.length === 0 ? '' : partes.join('.'));

/**
 * Every leaf of `bruto` beside the sanitized value at the same position. An empty
 * container is a leaf; a container the redactor replaced is one `redigido` leaf.
 */
export function folhasEmParalelo(
  bruto: unknown,
  sanitizado: ValorJsonAmazon,
  lista: ListaDeNomesAmazon | null,
): ParDeFolhasAmazon[] {
  const pares: ParDeFolhasAmazon[] = [];
  const anotar = (
    tabela: readonly string[],
    impresso: readonly string[],
    b: unknown,
    s: unknown,
    tratamento: TratamentoDaFolhaAmazon,
  ) => {
    pares.push({
      caminhoDaTabela: juntar(tabela),
      caminhoImpresso: impresso.length === 0 ? '<raiz>' : juntar(impresso),
      tipo: tipoDe(b),
      bruto: b,
      sanitizado: s,
      tratamento,
    });
  };

  function andar(
    b: unknown,
    s: unknown,
    tabela: readonly string[],
    impresso: readonly string[],
  ): void {
    if (Array.isArray(b)) {
      if (!Array.isArray(s) || s.length !== b.length) {
        anotar(tabela, impresso, b, s, 'redigido');
        return;
      }
      if (b.length === 0) anotar(tabela, impresso, b, s, 'mantido');
      b.forEach((x, i) => {
        andar(x, s[i], [...tabela, '*'], [...impresso, '*']);
      });
      return;
    }
    if (ehObjetoSimples(b)) {
      const chaves = Object.keys(b);
      const valores = ehObjetoSimples(s) ? Object.values(s) : null;
      if (valores?.length !== chaves.length) {
        anotar(tabela, impresso, b, s, 'redigido');
        return;
      }
      if (chaves.length === 0) anotar(tabela, impresso, b, s, 'mantido');
      chaves.forEach((k, i) => {
        andar(
          b[k],
          valores[i],
          [...tabela, segmentoDaTabela(k)],
          [...impresso, rotuloDeChave(k, lista)],
        );
      });
      return;
    }
    if (b === s) anotar(tabela, impresso, b, s, 'mantido');
    else if (tipoDe(s) === tipoDe(b)) anotar(tabela, impresso, b, s, 'falsificado');
    else anotar(tabela, impresso, b, s, 'redigido');
  }

  andar(bruto, sanitizado, [], []);
  return pares;
}

/** The leaves whose kept value is a closed-grammar enum, printed. */
const ENUMS_IMPRESSOS: readonly RegExp[] = [
  /(?:^|\.)paymentMethod$/,
  /(?:^|\.)programs\.\*$/,
  /(?:^|\.)detailedStatus$/,
  /(?:^|\.)packageStatus(?:\.status)?$/,
  /(?:^|\.)taxRegistrationType$/,
  /(?:^|\.)taxRegistrationAttributes\.\*\.key$/,
];
const TOKEN_DE_ENUM = /^[A-Z][A-Za-z0-9_]{0,63}$/;
const CHAVES_DE_DOCUMENTO = /(?:^|\.)(?:taxRegistrationNumber|acquirerId)$/i;

/** The name of the placeholder a document value maps to: its shape, never its value. */
export function classeDeDocumento(v: string): string {
  const placeholder = placeholderDeDocumento(v);
  const nome = Object.entries(PLACEHOLDERS_DOCUMENTO_AMAZON).find(([, p]) => p === placeholder);
  return nome?.[0] ?? `outro(${String(v.length)})`;
}

function detalheDe(p: ParDeFolhasAmazon, lista: ListaDeNomesAmazon | null): string | null {
  if (typeof p.bruto !== 'string') return null;
  if (CHAVES_DE_DOCUMENTO.test(p.caminhoDaTabela)) return `~ ${classeDeDocumento(p.bruto)}`;
  if (
    p.tratamento === 'mantido' &&
    ENUMS_IMPRESSOS.some((re) => re.test(p.caminhoDaTabela)) &&
    TOKEN_DE_ENUM.test(p.bruto) &&
    tiposDoTextoAmazon(p.bruto, lista).length === 0 &&
    tiposMascaradosAmazon(p.bruto, { digitos: true }).length === 0
  ) {
    return `= ${p.bruto}`;
  }
  return null;
}

interface LinhaMutavel {
  readonly caminho: string;
  readonly tipo: TipoDaFolhaAmazon;
  readonly tratamento: TratamentoDaFolhaAmazon;
  readonly detalhe: string | null;
  contagem: number;
}

/** The leaf table of one body, in first-seen order: printed paths, types and treatments only. */
export function tabelaDeFolhas(
  bruto: unknown,
  sanitizado: ValorJsonAmazon,
  lista: ListaDeNomesAmazon | null,
): LinhaDeFolhaAmazon[] {
  const linhas = new Map<string, LinhaMutavel>();
  for (const p of folhasEmParalelo(bruto, sanitizado, lista)) {
    const detalhe = detalheDe(p, lista);
    const chave = `${p.caminhoImpresso}\u0000${p.tipo}\u0000${p.tratamento}\u0000${detalhe ?? ''}`;
    const existente = linhas.get(chave);
    if (existente !== undefined) existente.contagem += 1;
    else {
      linhas.set(chave, {
        caminho: p.caminhoImpresso,
        tipo: p.tipo,
        tratamento: p.tratamento,
        detalhe,
        contagem: 1,
      });
    }
  }
  return [...linhas.values()];
}

/** `caminho : tipo [= valor | ~ classe] → tratamento (contagem)`, one per line. */
export function formatarFolhas(linhas: readonly LinhaDeFolhaAmazon[]): string[] {
  return linhas.map(
    (l) =>
      `${l.caminho} : ${l.tipo}${l.detalhe === null ? '' : ` ${l.detalhe}`} → ${l.tratamento} (${String(l.contagem)})`,
  );
}
