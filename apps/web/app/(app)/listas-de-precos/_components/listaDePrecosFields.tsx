import type { FieldConfig } from '@delfrance/ui';
import { FormulaListEditor } from './FormulaListEditor';
import { FormulasPorCategoriaEditor } from './FormulasPorCategoriaEditor';
import { stripFormulasCalculoPreco, stripFormulasPorCategoria } from './formulaStrip';

/**
 * Shared `ObjectView` configuration for the `listaDePrecos` create + edit
 * screens, so labels, tabs and the composite-field editors stay in sync.
 *
 * The two composite fields (`formulasCalculoPreco` array, `formulasPorCategoria`
 * record) get custom `renderInput` editors — the schema-driven default renderer
 * can't render an array-of-objects or a record cleanly — plus a recursive
 * `prepareForSave` that applies the staged-deletion convention (CLAUDE.md
 * rule 7). Module-level const so `ObjectView` can identity-track it.
 */

/** Tab order for the ListaDePrecos ObjectView. */
export const LISTA_DE_PRECOS_SECTIONS: string[] = [
  'Dados gerais',
  'Fórmulas de cálculo',
  'Fórmulas por categoria',
];

/** Server-managed timestamps — never rendered as editable inputs. */
export const LISTA_DE_PRECOS_EXCLUDED_FIELDS: string[] = ['timestamp', 'ultimaModificacao'];

export const listaDePrecosFields: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados gerais' },
  padrao: {
    label: 'Padrão',
    hint: 'Lista aplicada por padrão quando nenhuma outra é escolhida.',
    section: 'Dados gerais',
  },
  ativo: { label: 'Ativo', section: 'Dados gerais' },
  formulasCalculoPreco: {
    label: 'Fórmulas de cálculo',
    section: 'Fórmulas de cálculo',
    prepareForSave: stripFormulasCalculoPreco,
    renderInput: (p) => (
      <FormulaListEditor
        label={p.label}
        hint={p.hint}
        value={p.value}
        onChange={p.onChange}
        disabled={p.disabled}
        error={p.error}
        errorTree={p.errorTree}
      />
    ),
  },
  formulasPorCategoria: {
    label: 'Fórmulas por categoria',
    section: 'Fórmulas por categoria',
    prepareForSave: stripFormulasPorCategoria,
    renderInput: (p) => (
      <FormulasPorCategoriaEditor
        label={p.label}
        hint={p.hint}
        value={p.value}
        onChange={p.onChange}
        disabled={p.disabled}
        errorTree={p.errorTree}
      />
    ),
  },
};

/** Create-mode defaults matching the schema (`ativo` starts true, `padrao` false). */
export const LISTA_DE_PRECOS_CREATE_DEFAULTS = { padrao: false, ativo: true };
