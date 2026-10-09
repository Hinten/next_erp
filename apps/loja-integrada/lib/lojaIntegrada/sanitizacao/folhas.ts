/**
 * The `--dry-run` leaf table: for every leaf of a capture's body, its path, its
 * JSON type and what the `fixture` profile did to it — NEVER its value.
 *
 * ```
 * objects.*.itens.*.sku : string → mantido (3)
 * objects.*.cliente.nome : string → falsificado (3)
 * ```
 *
 * - `mantido`: the sanitized leaf equals the raw one.
 * - `falsificado`: replaced by a fake of the same JSON type.
 * - `redigido`: replaced by something of another type (a subtree past the
 *   walker's depth cap became a string).
 *
 * The raw and the sanitized trees are walked in parallel BY ENTRY POSITION
 * (`folhasEmParalelo`): the redactor keeps every object's key order and array
 * length, and renames a key (`chave_redigida_<n>`) in place. Array indices print
 * as `*`, repeated leaves collapse into one line with a count, and a key prints
 * only through `rotuloDeChave` (an identifier that trips nothing; otherwise
 * `<chave>` or the mask's tag).
 */
import type { ValorJsonLi } from '../core/redacao';
import { type ListaDeNomesLi, rotuloDeChave } from '../fixtures/piiScan';

export type TratamentoDaFolhaLi = 'mantido' | 'falsificado' | 'redigido';
export type TipoDaFolhaLi = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export interface LinhaDeFolhaLi {
  readonly caminho: string;
  readonly tipo: TipoDaFolhaLi;
  readonly tratamento: TratamentoDaFolhaLi;
  readonly contagem: number;
}

/** One leaf of the raw tree beside what the redactor made of it. */
export interface ParDeFolhasLi {
  /** The path as the redaction tables spell it (raw keys, `*` for an index). */
  readonly caminhoDaTabela: string;
  /** The path as it may be PRINTED (keys through `rotuloDeChave`). */
  readonly caminhoImpresso: string;
  readonly tipo: TipoDaFolhaLi;
  readonly bruto: unknown;
  readonly sanitizado: unknown;
  readonly tratamento: TratamentoDaFolhaLi;
}

const ehObjetoSimples = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function tipoDe(v: unknown): TipoDaFolhaLi {
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
 * container is a leaf; a container the redactor replaced (past its depth cap) is
 * one `redigido` leaf.
 */
export function folhasEmParalelo(
  bruto: unknown,
  sanitizado: ValorJsonLi,
  lista: ListaDeNomesLi | null,
): ParDeFolhasLi[] {
  const pares: ParDeFolhasLi[] = [];
  const anotar = (
    tabela: readonly string[],
    impresso: readonly string[],
    b: unknown,
    s: unknown,
    tratamento: TratamentoDaFolhaLi,
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

interface LinhaMutavel {
  readonly caminho: string;
  readonly tipo: TipoDaFolhaLi;
  readonly tratamento: TratamentoDaFolhaLi;
  contagem: number;
}

/** The leaf table of one body, in first-seen order: printed paths, types and treatments only. */
export function tabelaDeFolhas(
  bruto: unknown,
  sanitizado: ValorJsonLi,
  lista: ListaDeNomesLi | null,
): LinhaDeFolhaLi[] {
  const linhas = new Map<string, LinhaMutavel>();
  for (const p of folhasEmParalelo(bruto, sanitizado, lista)) {
    const chave = `${p.caminhoImpresso}\u0000${p.tipo}\u0000${p.tratamento}`;
    const existente = linhas.get(chave);
    if (existente !== undefined) existente.contagem += 1;
    else {
      linhas.set(chave, {
        caminho: p.caminhoImpresso,
        tipo: p.tipo,
        tratamento: p.tratamento,
        contagem: 1,
      });
    }
  }
  return [...linhas.values()];
}

/** `caminho : tipo → tratamento (contagem)`, one per line. */
export function formatarFolhas(linhas: readonly LinhaDeFolhaLi[]): string[] {
  return linhas.map((l) => `${l.caminho} : ${l.tipo} → ${l.tratamento} (${String(l.contagem)})`);
}
