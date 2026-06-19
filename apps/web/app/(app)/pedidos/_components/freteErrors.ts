/**
 * Flatten a react-hook-form nested error subtree into a flat list of
 * `{ path, label, message }` leaves, so a tab can name every invalid field —
 * even ones with no rendered `<Controller>` input.
 *
 * The pedido form is bespoke (non-ObjectView), and its per-tab feedback
 * (`pedidoErrorTabs.ts`) routes only top-level RHF keys. A nested
 * `freteInicial.<x>` error on a derived/cache field (e.g. `externalOptionIntegracao`,
 * which has no input) therefore marks the Frete tab but shows nothing inline.
 * This mirrors the `hiddenErrors` surfacing ObjectView got in #221, ported to
 * the bespoke form. See issue #218.
 */

export interface FlatFieldError {
  /** Dotted path relative to the walked root (e.g. `volumes.0.dimensoes.altura`). */
  readonly path: string;
  /** Human label for the field (first path segment), for display. */
  readonly label: string;
  readonly message: string;
}

/** An RHF leaf error always carries a string `message` (+ `type`/`ref`). */
function isLeaf(node: Record<string, unknown>): boolean {
  return typeof node.message === 'string';
}

function walk(node: unknown, path: string, labelOf: (p: string) => string, out: FlatFieldError[]) {
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (isLeaf(record)) {
    out.push({ path, label: labelOf(path), message: record.message as string });
    return; // leaf — don't descend into `ref`/`type`
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, path ? `${path}.${i}` : String(i), labelOf, out));
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    // `ref`/`type`/`message` belong to a leaf; `root` is RHF's object-level
    // (cross-field) error slot — keep it, it walks to a leaf.
    if (key === 'ref' || key === 'type' || key === 'message') continue;
    walk(child, path ? `${path}.${key}` : key, labelOf, out);
  }
}

/**
 * Walk an RHF error node (e.g. `formState.errors.freteInicial`) into its leaf
 * errors. `labelOf` maps a dotted path to a human label.
 */
export function flattenFieldErrors(
  node: unknown,
  labelOf: (path: string) => string,
): FlatFieldError[] {
  const out: FlatFieldError[] = [];
  walk(node, '', labelOf, out);
  return out;
}

/** pt-BR labels for `freteInicial` subfields (mirror the schema `describe()`s). */
const FRETE_FIELD_LABELS: Readonly<Record<string, string>> = {
  externalId: 'ID externo',
  printLabelId: 'Etiqueta',
  externalOptionId: 'Opção de frete',
  externalOptionIntegracao: 'Integração da opção',
  externalOptionData: 'Dados da opção de frete',
  externalOptionSelectionDate: 'Data de seleção da opção',
  estado: 'Status do frete',
  integracaoFreteOuterRef: 'Integração do frete',
  integracaoTargetOuterRef: 'Target da integração',
  clienteRecebedorOuterReference: 'Quem recebe',
  enderecoFreteOuterReference: 'Endereço de entrega',
  modalidade: 'Modalidade',
  transportadora: 'Transportadora',
  veiculo: 'Veículo',
  reboques: 'Reboques',
  vagao: 'Vagão',
  balsa: 'Balsa',
  volumes: 'Volumes',
  codRastreio: 'Código de rastreio',
  valorCobrado: 'Valor cobrado',
  custoCalculado: 'Custo calculado',
  custoFinal: 'Custo final',
  ehReverso: 'Frete reverso',
  prazoExtra: 'Prazo extra',
  prazoDespacho: 'Prazo de despacho',
  dataEntrega: 'Data de entrega',
  dataPrevisaoEntrega: 'Previsão de entrega',
  valor_assegurado: 'Valor assegurado',
  maoPropria: 'Mão própria',
  avisoRecebimento: 'Aviso de recebimento',
};

/** Label a `freteInicial` error path by its first segment; fall back to raw. */
export function freteFieldLabel(path: string): string {
  if (path === '' || path === 'root') return 'Frete';
  const first = path.split('.')[0] ?? path;
  return FRETE_FIELD_LABELS[first] ?? first;
}

/** Convenience: flatten a `freteInicial` error node with the frete labels. */
export function collectFreteErrors(node: unknown): FlatFieldError[] {
  return flattenFieldErrors(node, freteFieldLabel);
}
