/**
 * The int_frete ⇆ marketplace-conta sync, ONE core for every channel (#782 Mercado Livre, #1528
 * Shopee, #1826 Loja Integrada, #1930 Amazon; #1369). The per-channel facts are `VINCULO_INT_FRETE_CONTA` in
 * `@delfrance/schemas`. One pure planner and current-state reconciler serve every channel
 * (#1888). What a lost race does, and why, is argued in the core file and in its
 * transaction-inventory row.
 */
export {
  CAMPOS_SINCRONIZADOS,
  diffCamposIntFrete,
  intFreteContaSync,
  type ContaBruta,
  type DisposicaoIntFrete,
  type IntFreteEncontrado,
  type OpcoesSyncIntFrete,
  type PlanoIntFrete,
  type SyncIntFreteConta,
} from './intFreteContaSync';
