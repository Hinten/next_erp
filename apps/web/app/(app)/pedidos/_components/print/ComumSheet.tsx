'use client';

/**
 * The warehouse separation sheet — one A4 page (or more) per pedido, printed in
 * batches via `window.print()` (react-to-print, iframe-isolated). Port of
 * `pdf_formato.dart`: Code128 barcode of the número, vendedor, cliente (NOT
 * masked) + internal notes, frete + delivery address, the dispatch-deadline
 * marker, and the items table with stock, localização, photos and kit
 * component sub-rows.
 *
 * Self-contained `<style>` (system fonts, explicit values) + `@media print`
 * rules so the sheet looks the same on screen, in the preview and when printed.
 * Each sheet is a `break-before: page` block so pedidos never share a page.
 */
import { useEffect, useRef } from 'react';

import type { PedidoPrintModel, PrintAddress, PrintItem } from '@/lib/pedido-print/model';
import { isDispatchOverdue } from '@/lib/pedido-print/model';
import {
  formatCep,
  formatCpfCnpj,
  formatDate,
  formatDateTime,
  formatReais,
  formatTelefone,
} from '@/lib/pedido-print/format';

export const COMUM_CSS = `
.po-com { width: 794px; box-sizing: border-box; background: #fff; color: #1a1a1a;
  font-family: Arial, Helvetica, sans-serif; font-size: 11px; line-height: 1.35; padding: 18px 22px; }
.po-com * { box-sizing: border-box; }
.po-com .barcode { display: flex; justify-content: center; }
.po-com .barcode svg { height: 48px; }
.po-com .title { text-align: center; font-size: 17px; font-weight: 700; margin-top: 2px; }
.po-com .vendedor { text-align: center; font-size: 11px; font-weight: 700; }
.po-com .cards { display: flex; gap: 10px; margin-top: 8px; }
.po-com .card { flex: 1; border: 1px solid #000; padding: 5px 7px; }
.po-com .card h4 { margin: 0 0 3px; font-size: 11px; font-weight: 700; }
.po-com .card .line { font-size: 10.5px; margin: 1px 0; }
.po-com .foot { border: 1px solid #000; padding: 5px 7px; margin-top: 8px; display: flex;
  flex-wrap: wrap; gap: 4px 24px; font-size: 10.5px; }
.po-com .foot .overdue { color: #c92a2a; font-weight: 700; }
.po-com .foot b { font-weight: 700; }
.po-com .obs { margin-top: 8px; font-weight: 700; font-size: 10.5px; }
.po-com table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 10.5px; }
.po-com thead { display: table-header-group; }
.po-com thead th { border-bottom: 1.5px solid #000; text-align: left; padding: 4px 5px;
  font-weight: 700; font-size: 10px; }
.po-com tbody { break-inside: avoid; page-break-inside: avoid; }
.po-com tbody td { padding: 4px 5px; border-bottom: 1px solid #ccc; vertical-align: middle; }
.po-com .num-col { text-align: right; white-space: nowrap; }
.po-com .center { text-align: center; }
.po-com .estoque { color: #444; font-weight: 700; }
.po-com .prod-nome { font-weight: 600; }
.po-com .prod-var { color: #666; font-size: 9.5px; }
.po-com .comp td { background: #f4f6f8; }
.po-com .comp .indent { padding-left: 16px; position: relative; }
.po-com .comp .indent::before { content: '↳'; position: absolute; left: 4px; color: #888; }
.po-com .foto { width: 40px; height: 40px; object-fit: cover; border: 1px solid #ddd;
  background: #f1f3f5; display: block; }
.po-com .foto-empty { width: 40px; height: 40px; border: 1px dashed #ccc; background: #f1f3f5;
  display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 8px; }
@media print {
  .po-com { width: auto; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

function AddressLines({ a }: { a: PrintAddress }) {
  return (
    <>
      {a.recebedorNome && (
        <div className="line">
          <b>{a.recebedorNome}</b>
        </div>
      )}
      <div className="line">
        {a.logradouro}, {a.numero}
        {a.complemento ? ` — ${a.complemento}` : ''}
      </div>
      <div className="line">
        {a.bairro} — {a.cidade}/{a.uf}
      </div>
      <div className="line">CEP {formatCep(a.cep)}</div>
    </>
  );
}

function Foto({ url, alt }: { url: string | null; alt: string }) {
  if (!url) return <div className="foto-empty">sem foto</div>;
  // eslint-disable-next-line @next/next/no-img-element -- print sheet needs a plain <img>
  return <img className="foto" src={url} alt={alt} />;
}

function ItemRows({ item, idx }: { item: PrintItem; idx: number }) {
  return (
    <tbody>
      <tr>
        <td className="estoque">{item.estoqueText}</td>
        <td>
          <Foto url={item.fotoUrl} alt={item.nome ?? 'Produto'} />
        </td>
        <td>{item.sku ?? '—'}</td>
        <td>
          <div className="prod-nome">{item.nome ?? 'Produto'}</div>
          {item.variacoesText && <div className="prod-var">{item.variacoesText}</div>}
        </td>
        <td>{item.localizacao}</td>
        <td className="center">{item.quantidade}</td>
        <td className="num-col">{formatReais(item.precoUnitario)}</td>
        <td className="num-col">{formatReais(item.subtotal)}</td>
      </tr>
      {item.componentes.map((c, ci) => (
        <tr className="comp" key={`${idx}-c${ci}`}>
          <td className="estoque">{c.estoqueText}</td>
          <td>
            <Foto url={c.fotoUrl} alt={c.nome ?? 'Componente'} />
          </td>
          <td className="indent">{c.sku ?? '—'}</td>
          <td>
            <div className="prod-nome">{c.nome ?? 'Componente'}</div>
            {c.variacoesText && <div className="prod-var">{c.variacoesText}</div>}
          </td>
          <td>{c.localizacao}</td>
          <td className="center">{c.quantidade}</td>
          <td className="num-col" />
          <td className="num-col" />
        </tr>
      ))}
    </tbody>
  );
}

export interface ComumSheetProps {
  model: PedidoPrintModel;
}

export function ComumSheet({ model }: ComumSheetProps) {
  const barcodeRef = useRef<SVGSVGElement>(null);
  const { cliente, enderecoFiscal, enderecoEntrega, frete } = model;
  const overdue = isDispatchOverdue(model.prazoDespachoMicros);

  // Render the Code128 barcode of the número into the inline <svg> (local draw,
  // no network) once the sheet mounts, before react-to-print clones it.
  useEffect(() => {
    const svg = barcodeRef.current;
    if (!svg) return;
    let cancelled = false;
    void import('jsbarcode').then(({ default: JsBarcode }) => {
      if (cancelled || !barcodeRef.current) return;
      JsBarcode(barcodeRef.current, model.numero ?? 'SEM-NUMERO', {
        format: 'CODE128',
        displayValue: false,
        height: 48,
        width: 1.4,
        margin: 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [model.numero]);

  return (
    <div className="po-com">
      <style>{COMUM_CSS}</style>

      <div className="barcode">
        <svg ref={barcodeRef} />
      </div>
      <div className="title">
        Pedido {model.numero ?? '—'}
        {model.integracaoNome ? ` (${model.integracaoNome})` : ''}
      </div>
      {model.vendedorNome && <div className="vendedor">Vendedor(a): {model.vendedorNome}</div>}

      <div className="cards">
        <div className="card">
          <h4>Cliente</h4>
          {cliente ? (
            <>
              {cliente.nome && <div className="line">{cliente.nome}</div>}
              {cliente.cpfCnpj && (
                <div className="line">CNPJ/CPF: {formatCpfCnpj(cliente.cpfCnpj)}</div>
              )}
              {cliente.idEstrangeiro && (
                <div className="line">ID estrangeiro: {cliente.idEstrangeiro}</div>
              )}
              {cliente.ie && <div className="line">IE: {cliente.ie}</div>}
              {cliente.email && <div className="line">{cliente.email}</div>}
              {cliente.telefone && <div className="line">{formatTelefone(cliente.telefone)}</div>}
              {cliente.observacoesInternas && (
                <div className="line">Obs.: {cliente.observacoesInternas}</div>
              )}
            </>
          ) : (
            <div className="line">
              <b>Cliente: Anônimo</b>
            </div>
          )}
        </div>
        <div className="card">
          <h4>Endereço fiscal</h4>
          {enderecoFiscal ? (
            <AddressLines a={enderecoFiscal} />
          ) : (
            <div className="line">Não informado</div>
          )}
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <h4>Frete</h4>
          {frete ? (
            <>
              <div className="line">Tipo: {frete.tipoNome}</div>
              <div className="line">Modalidade: {frete.modalidadeLabel}</div>
              {frete.servicoMelhorEnvio && (
                <div className="line">Serviço: {frete.servicoMelhorEnvio}</div>
              )}
              {frete.transportadora?.nome && (
                <div className="line">
                  Transportadora: {frete.transportadora.nome}
                  {frete.transportadora.cnpj
                    ? ` — ${formatCpfCnpj(frete.transportadora.cnpj)}`
                    : ''}
                </div>
              )}
              {frete.veiculo && <div className="line">Veículo: {frete.veiculo}</div>}
              <div className="line">
                Valor: {formatReais(frete.valorCobrado ?? 0)}
                {frete.ehReverso ? ' · Reverso' : ''}
              </div>
              {frete.temSeguro && frete.valorSeguro != null && (
                <div className="line">Seguro: {formatReais(frete.valorSeguro)}</div>
              )}
            </>
          ) : (
            <div className="line">
              <b>Pedido sem forma de entrega.</b>
            </div>
          )}
        </div>
        <div className="card">
          <h4>Endereço de entrega</h4>
          {enderecoEntrega ? (
            <AddressLines a={enderecoEntrega} />
          ) : (
            <div className="line">Sem endereço de entrega</div>
          )}
        </div>
      </div>

      <div className="foot">
        <span className={overdue ? 'overdue' : ''}>
          {model.prazoDespachoMicros != null
            ? `${overdue ? '! ' : ''}Prazo de despacho: ${formatDate(model.prazoDespachoMicros)}`
            : 'Prazo de despacho não informado'}
        </span>
        {model.timestampMicros != null && (
          <span>Data do pedido: {formatDateTime(model.timestampMicros)}</span>
        )}
        <span>Estado: {model.estadoLabel}</span>
        <span>
          <b>Total: {formatReais(model.total)}</b> ({model.totalQuantidadeItens}{' '}
          {model.totalQuantidadeItens === 1 ? 'item' : 'itens'})
        </span>
      </div>

      {model.observacoesInternas && (
        <div className="obs">Observações internas: {model.observacoesInternas}</div>
      )}

      <table>
        <thead>
          <tr>
            <th>Estoque</th>
            <th>Foto</th>
            <th>SKU</th>
            <th>Produto</th>
            <th>Localização</th>
            <th className="center">Qtd</th>
            <th className="num-col">Vlr. Un.</th>
            <th className="num-col">Subtotal</th>
          </tr>
        </thead>
        {model.items.map((item, idx) => (
          <ItemRows item={item} idx={idx} key={item.produtoId ?? `row-${idx}`} />
        ))}
      </table>
    </div>
  );
}
