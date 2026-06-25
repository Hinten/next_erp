'use client';

/**
 * The customer-facing orçamento sheet — an A4-width, persuasive document
 * rendered from a {@link PedidoPrintModel}. It is captured to a JPEG/PNG image
 * (and wrapped into a PDF) by `useOrcamentoExport`; it is NOT printed via the
 * browser dialog. Port of `pdf_orcamento.dart`, with a cleaner layout: filial
 * header, the customer's tax ids masked, product photos, an emphasized total
 * and the 7-day validity.
 *
 * Self-contained styling: a scoped `<style>` block with system fonts and
 * explicit values (no Mantine CSS variables, no web fonts) so the on-screen
 * render and the html-to-image capture are byte-for-byte the same — no font
 * embedding, no missing-variable surprises.
 */
import { forwardRef } from 'react';

import type { PedidoPrintModel, PrintAddress } from '@/lib/pedido-print/model';
import {
  formatCep,
  formatCpfCnpj,
  formatDate,
  formatReais,
  formatTelefone,
  obscure,
} from '@/lib/pedido-print/format';

/** A4 portrait width in CSS px at 96dpi. */
export const A4_WIDTH_PX = 794;

const SEVEN_DAYS_MICROS = 7 * 24 * 60 * 60 * 1_000_000;

const CSS = `
.po-orc { width: ${A4_WIDTH_PX}px; box-sizing: border-box; background: #ffffff;
  color: #1a1a1a; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.4; }
.po-orc * { box-sizing: border-box; }
.po-orc .pad { padding: 28px 32px; }
.po-orc .head { background: #0b3d63; color: #ffffff; padding: 22px 32px;
  display: flex; justify-content: space-between; align-items: flex-start; }
.po-orc .head .filial { font-size: 20px; font-weight: 700; letter-spacing: .3px; }
.po-orc .head .contact { font-size: 11px; opacity: .9; margin-top: 4px; }
.po-orc .head .orc { text-align: right; }
.po-orc .head .orc .label { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; opacity: .85; }
.po-orc .head .orc .num { font-size: 26px; font-weight: 700; }
.po-orc .head .orc .date { font-size: 11px; opacity: .9; margin-top: 2px; }
.po-orc .cards { display: flex; gap: 16px; margin-top: 18px; }
.po-orc .card { flex: 1; border: 1px solid #d7dee4; border-radius: 8px; padding: 12px 14px; }
.po-orc .card h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
  color: #0b3d63; border-bottom: 1px solid #eef1f4; padding-bottom: 5px; }
.po-orc .card .line { font-size: 11.5px; margin: 2px 0; }
.po-orc .card .line b { color: #555; font-weight: 600; }
.po-orc table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 11.5px; }
.po-orc thead th { background: #0b3d63; color: #fff; text-align: left; padding: 7px 8px; font-weight: 600;
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; }
.po-orc tbody td { padding: 7px 8px; border-bottom: 1px solid #e9edf1; vertical-align: middle; }
.po-orc tbody tr:nth-child(even) td { background: #f7f9fb; }
.po-orc .num-col { text-align: right; white-space: nowrap; }
.po-orc .center { text-align: center; }
.po-orc .prod-nome { font-weight: 600; }
.po-orc .prod-var { color: #777; font-size: 10px; }
.po-orc .foto { width: 44px; height: 44px; object-fit: cover; border-radius: 5px;
  border: 1px solid #e1e6ea; background: #f1f3f5; display: block; }
.po-orc .foto-empty { width: 44px; height: 44px; border-radius: 5px; background: #f1f3f5;
  border: 1px dashed #cfd6dc; display: flex; align-items: center; justify-content: center;
  color: #aab3bb; font-size: 8px; }
.po-orc .totalbar { display: flex; justify-content: flex-end; margin-top: 16px; }
.po-orc .totalbox { min-width: 260px; }
.po-orc .totalbox .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
.po-orc .totalbox .grand { margin-top: 6px; background: #0b3d63; color: #fff; border-radius: 8px;
  padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
.po-orc .totalbox .grand .lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
.po-orc .totalbox .grand .val { font-size: 22px; font-weight: 700; }
.po-orc .validade { margin-top: 16px; background: #fff4e6; border: 1px solid #ffd8a8; border-radius: 8px;
  padding: 10px 14px; font-size: 12px; color: #8a4b00; }
.po-orc .pitch { margin-top: 14px; font-size: 11px; color: #555; line-height: 1.5; }
.po-orc .foot { margin-top: 18px; border-top: 1px solid #e9edf1; padding-top: 10px;
  font-size: 10px; color: #8a949c; text-align: center; }
`;

function AddressLines({ a }: { a: PrintAddress }) {
  return (
    <>
      <div className="line">
        {a.logradouro}, {a.numero}
        {a.complemento ? ` — ${a.complemento}` : ''}
      </div>
      <div className="line">{a.bairro}</div>
      <div className="line">
        {a.cidade} / {a.uf} — CEP {formatCep(a.cep)}
      </div>
    </>
  );
}

export interface OrcamentoSheetProps {
  model: PedidoPrintModel;
}

export const OrcamentoSheet = forwardRef<HTMLDivElement, OrcamentoSheetProps>(
  function OrcamentoSheet({ model }, ref) {
    const { cliente, enderecoFiscal, enderecoEntrega, frete, filial } = model;
    const validadeMicros =
      model.timestampMicros != null ? model.timestampMicros + SEVEN_DAYS_MICROS : null;

    return (
      <div className="po-orc" ref={ref}>
        <style>{CSS}</style>

        <div className="head">
          <div>
            <div className="filial">{filial?.nome ?? 'Orçamento'}</div>
            {filial?.email && <div className="contact">{filial.email}</div>}
            {filial?.telefone && <div className="contact">{formatTelefone(filial.telefone)}</div>}
          </div>
          <div className="orc">
            <div className="label">Orçamento</div>
            <div className="num">Nº {model.numero ?? '—'}</div>
            {model.timestampMicros != null && (
              <div className="date">Emitido em {formatDate(model.timestampMicros)}</div>
            )}
          </div>
        </div>

        <div className="pad">
          <div className="cards">
            {cliente && (
              <div className="card">
                <h3>Cliente</h3>
                {cliente.nome && <div className="line">{cliente.nome}</div>}
                {cliente.cpfCnpj && (
                  <div className="line">
                    <b>CPF/CNPJ:</b> {obscure(formatCpfCnpj(cliente.cpfCnpj))}
                  </div>
                )}
                {cliente.idEstrangeiro && (
                  <div className="line">
                    <b>ID estrangeiro:</b> {obscure(cliente.idEstrangeiro)}
                  </div>
                )}
                {cliente.ie && (
                  <div className="line">
                    <b>IE:</b> {obscure(cliente.ie)}
                  </div>
                )}
                {cliente.email && <div className="line">{cliente.email}</div>}
                {cliente.telefone && <div className="line">{formatTelefone(cliente.telefone)}</div>}
              </div>
            )}

            {(enderecoEntrega ?? enderecoFiscal) && (
              <div className="card">
                <h3>{enderecoEntrega ? 'Entrega' : 'Endereço'}</h3>
                <AddressLines a={(enderecoEntrega ?? enderecoFiscal)!} />
                {frete && (
                  <div className="line" style={{ marginTop: 6 }}>
                    <b>Frete:</b> {frete.tipoNome}
                    {frete.servicoMelhorEnvio ? ` — ${frete.servicoMelhorEnvio}` : ''}
                  </div>
                )}
              </div>
            )}
          </div>

          <table>
            <thead>
              <tr>
                <th>Foto</th>
                <th>SKU</th>
                <th>Produto</th>
                <th className="center">Qtd</th>
                <th className="num-col">Vlr. Un.</th>
                {model.hasDesconto && <th className="num-col">Desc.</th>}
                <th className="num-col">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {model.items.map((item, idx) => (
                <tr key={item.produtoId ?? `row-${idx}`}>
                  <td>
                    {item.fotoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- raster capture needs a plain <img>
                      <img className="foto" src={item.fotoUrl} alt={item.nome ?? 'Produto'} />
                    ) : (
                      <div className="foto-empty">sem foto</div>
                    )}
                  </td>
                  <td>{item.sku ?? '—'}</td>
                  <td>
                    <div className="prod-nome">{item.nome ?? 'Produto'}</div>
                    {item.variacoesText && <div className="prod-var">{item.variacoesText}</div>}
                  </td>
                  <td className="center">{item.quantidade}</td>
                  <td className="num-col">{formatReais(item.precoUnitario)}</td>
                  {model.hasDesconto && (
                    <td className="num-col">{formatReais(item.descontoUnitario)}</td>
                  )}
                  <td className="num-col">{formatReais(item.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="totalbar">
            <div className="totalbox">
              {model.descontoTotal > 0 && (
                <>
                  <div className="row">
                    <span>Subtotal</span>
                    <span>{formatReais(model.subtotal)}</span>
                  </div>
                  <div className="row">
                    <span>Desconto</span>
                    <span>- {formatReais(model.descontoTotal)}</span>
                  </div>
                </>
              )}
              {frete?.valorCobrado != null && frete.valorCobrado > 0 && (
                <div className="row">
                  <span>Frete</span>
                  <span>{formatReais(frete.valorCobrado)}</span>
                </div>
              )}
              <div className="grand">
                <span className="lbl">Total</span>
                <span className="val">{formatReais(model.total)}</span>
              </div>
            </div>
          </div>

          {validadeMicros != null && (
            <div className="validade">
              Este orçamento é válido até <b>{formatDate(validadeMicros)}</b> (7 dias). Garanta o
              seu preço — fale com a gente para confirmar o pedido!
            </div>
          )}

          <div className="pitch">
            Produtos com garantia e envio rápido. Dúvidas sobre tamanhos, prazos ou formas de
            pagamento? Estamos à disposição para ajudar você a fechar o melhor negócio.
          </div>

          <div className="foot">
            {filial?.nome ?? ''}
            {filial?.email ? ` · ${filial.email}` : ''}
            {filial?.telefone ? ` · ${formatTelefone(filial.telefone)}` : ''}
          </div>
        </div>
      </div>
    );
  },
);
