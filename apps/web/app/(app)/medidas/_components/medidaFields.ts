import type { FieldConfig } from '@delfrance/ui';

/** Tabs for the medidas ObjectView (shared by the create + edit pages). */
export const MEDIDA_SECTIONS: string[] = ['Dados gerais', 'Fotos'];

/**
 * Hidden from rendering on CREATE (`novo`). `fotosArquivosIds` is DERIVED in
 * `deriveOnSave`, never rendered; the timestamps are stamped by the save; the
 * Mercado Livre map is written by the ML tab itself (its own requests and
 * writes), so it never enters the form and the dirty-field patch never touches
 * it. `tabelasMedidasShopee` is hidden here only because the Shopee tab is
 * EDIT-only — see {@link MEDIDA_EXCLUDED_FIELDS_EDITAR}.
 * `fotos` is intentionally NOT here — it renders in the Fotos tab.
 */
export const MEDIDA_EXCLUDED_FIELDS: string[] = [
  'fotosArquivosIds',
  'tabelasDeMedidasMercadoLivre',
  'tabelasMedidasShopee',
  'dataCadastro',
  'ultimaModificacao',
];

/**
 * The edit page's list: the create list minus `tabelasMedidasShopee`, which on
 * edit IS a form field — the Shopee tab (`MedidasShopeeManager`) stages picks
 * into it and "Salvar alterações" writes it through `ObjectView`'s save
 * transaction, the #1757 baseline guard included (step 18, #1526).
 */
export const MEDIDA_EXCLUDED_FIELDS_EDITAR: string[] = MEDIDA_EXCLUDED_FIELDS.filter(
  (f) => f !== 'tabelasMedidasShopee',
);

/** Labels + tab assignment for the Dados-gerais inputs. */
export const medidaFieldOverrides: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados gerais' },
  codigo: { label: 'Código interno', section: 'Dados gerais' },
  descricao: {
    label: 'Descrição',
    section: 'Dados gerais',
    // A description can be a long block of text — render an autosizing textarea
    // (grows as you type) instead of a single-line input.
    kind: 'longText',
    hint: 'Se suportado pelo marketplace, é enviada junto à descrição do produto.',
  },
};
