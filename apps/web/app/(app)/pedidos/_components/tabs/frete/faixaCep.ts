import type { FaixaDeCep } from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';

/**
 * Faixas whose CEP range contains `cepDestino`. Port of the motoboy
 * widget's filter (`.old/lib/integracoes_frete/motoboy/widgets.dart:55-58`):
 * plain integer comparison over the 8-digit strings; no destination CEP →
 * nothing is selectable.
 */
export function selectableFaixas(
  faixas: ReadonlyArray<FaixaDeCep> | null | undefined,
  cepDestino: string | null | undefined,
): FaixaDeCep[] {
  if (!faixas || !cepDestino) return [];
  const cep = Number.parseInt(cepDestino, 10);
  if (!Number.isFinite(cep)) return [];
  return faixas.filter(
    (f) => Number.parseInt(f.cepInicial, 10) <= cep && Number.parseInt(f.cepFinal, 10) >= cep,
  );
}

/**
 * Parse a stored `externalOptionId` back into a faixa. Port of
 * `FaixaDeCep.fromOptionString`
 * (`.old/packages/integracao_frete/lib/src/models.dart:321-330`) with one
 * deviation: malformed strings return `null` instead of throwing (the
 * legacy widget catches the exception and shows "opção inválida").
 */
export function parseFaixaOptionString(optionString: string): FaixaDeCep | null {
  const [cepInicial, cepFinal, custoRaw, valorRaw, prazoRaw] = optionString.split(' - ');
  if (
    cepInicial == null ||
    cepFinal == null ||
    custoRaw == null ||
    valorRaw == null ||
    prazoRaw == null
  ) {
    return null;
  }
  const custo = Number.parseFloat(custoRaw);
  const valor = Number.parseFloat(valorRaw);
  const prazo = Number.parseInt(prazoRaw, 10);
  return {
    cepInicial,
    cepFinal,
    custo: Number.isFinite(custo) ? custo : 0,
    valor: Number.isFinite(valor) ? valor : 0,
    prazo: Number.isFinite(prazo) ? prazo : 0,
  };
}

/** `01310100` → `01310-100` (display only — the wire keeps 8 digits). */
export function formatCep(cep: string): string {
  return /^\d{8}$/.test(cep) ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
}

/**
 * Dropdown label for a faixa. Mirrors `FaixaDeCep.toString`
 * (`.old/packages/integracao_frete/lib/src/models.dart:341-343`):
 * `R$ 20,00 - 1 dias úteis (de 01000-000 a 01999-999)`.
 */
export function faixaLabel(faixa: FaixaDeCep): string {
  const valor = formatReais(faixa.valor);
  return `${valor} - ${faixa.prazo} dias úteis (de ${formatCep(faixa.cepInicial)} a ${formatCep(faixa.cepFinal)})`;
}
