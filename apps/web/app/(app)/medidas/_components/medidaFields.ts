import type { FieldConfig } from '@delfrance/ui';

/** Tabs for the medidas ObjectView (shared by the create + edit pages). */
export const MEDIDA_SECTIONS: string[] = ['Dados gerais', 'Fotos'];

/**
 * Hidden from rendering. `fotosArquivosIds` stays excluded — it's DERIVED in
 * `deriveOnSave`, never rendered; the marketplace maps + timestamps are
 * integration/server-managed and preserved by the dirty-field patch save.
 * `fotos` is intentionally NOT here — it renders in the Fotos tab.
 */
export const MEDIDA_EXCLUDED_FIELDS: string[] = [
  'fotosArquivosIds',
  'tabelasDeMedidasMercadoLivre',
  'tabelasMedidasShopee',
  'dataCadastro',
  'ultimaModificacao',
];

/** Labels + tab assignment for the Dados-gerais inputs. */
export const medidaFieldOverrides: Record<string, FieldConfig> = {
  nome: { label: 'Nome', section: 'Dados gerais' },
  codigo: { label: 'Código interno', section: 'Dados gerais' },
  descricao: {
    label: 'Descrição',
    section: 'Dados gerais',
    hint: 'Se suportado pelo marketplace, é enviada junto à descrição do produto.',
  },
};
