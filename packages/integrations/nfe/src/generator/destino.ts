/**
 * The UF where the operation ENDS — the one fact both `ide.idDest` and the
 * per-item CFOP pick (`cfop` vs `cfopInterestadual`) are decided from (#422).
 *
 * The delivery address wins over the fiscal one, exactly as the legacy Flutter
 * generator did (`ehInsterestadual = (enderecoEntrega?.estado ??
 * enderecoFiscal?.estado) != filial.sede.estado`,
 * `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:254`): for a sale to a
 * consumer the operation's destination is where the goods physically arrive
 * (EC 87/2015), not where the buyer is registered.
 *
 * ⚠️ ONE derivation, deliberately. SEFAZ cross-checks the CFOP's first digit
 * against `idDest` (rules 732/733), so the orchestrator's CFOP pick and the
 * generator's `idDest` must never compute this separately.
 *
 * ⚠️ `entrega` must be the SAME value that decides whether `<entrega>` is
 * emitted. SEFAZ judges `idDest` against `enderDest/UF` or, when the group is
 * present, against `entrega/UF` (rules 772/773, 523). A delivery UF that
 * decides `idDest` without its `<entrega>` group on the wire is the rejection
 * this module exists to avoid.
 */
import type { Endereco, UF } from '@delfrance/schemas';

export function ufDestinoOperacao(
  enderecoDest: Pick<Endereco, 'estado'>,
  enderecoEntrega?: Pick<Endereco, 'estado'> | null,
): UF {
  return (enderecoEntrega ?? enderecoDest).estado;
}
