'use client';

/**
 * The generic (10×15cm) shipping-label sheet — a self-contained, off-screen
 * DOM render of an {@link EtiquetaGenericaModel}. It is captured to a PDF by
 * `exportEtiquetaGenericaPdf`; it is NOT printed via the browser dialog. Port
 * of the Flutter `EtiquetaFreteGenericaPDF._makeEtiqueta` layout
 * (`.old/packages/integracoes_frete/etiquetas_frete/lib/src/pdf_out/generica.dart`):
 * a bordered card with a centered title/subtitle, the NF-e number, a "Reverso"
 * flag, then cliente / endereço / recebedor blocks, and a signature line (or
 * the reverse delivery block) at the foot.
 *
 * Self-contained styling: a scoped `<style>` block with system fonts and
 * explicit px values (10×15cm at 96dpi) so the on-screen render and the
 * html-to-image capture are byte-for-byte the same — no Mantine CSS variables,
 * no web fonts, no missing-variable surprises.
 */
import { forwardRef } from 'react';

import { formatCep, formatCpfCnpj, formatTelefone } from '@/lib/pedido-print/format';

import type { EtiquetaGenericaAddress, EtiquetaGenericaModel } from './model';

/** 10cm × 15cm in CSS px at 96dpi (1cm ≈ 37.795px). */
export const ETIQUETA_WIDTH_PX = 378;
export const ETIQUETA_HEIGHT_PX = 567;

const CSS = `
.po-etq { width: ${ETIQUETA_WIDTH_PX}px; min-height: ${ETIQUETA_HEIGHT_PX}px; box-sizing: border-box;
  background: #ffffff; color: #000000; font-family: Arial, Helvetica, sans-serif; font-size: 10px;
  line-height: 1.3; border: 1px solid #000000; padding: 8px 10px; }
.po-etq * { box-sizing: border-box; }
.po-etq .title { text-align: center; font-size: 13px; font-weight: 700; }
.po-etq .subtitle { text-align: center; font-size: 11px; font-weight: 700; }
.po-etq .nfe { text-align: center; font-size: 10px; font-weight: 700; margin-bottom: 4px; }
.po-etq .reverso { font-size: 10px; font-weight: 700; }
.po-etq hr { border: none; border-top: 1px solid #000000; margin: 6px 0; }
.po-etq .block-title { text-align: center; font-size: 12px; font-weight: 700; margin-bottom: 2px; }
.po-etq .line { font-size: 10px; margin: 1px 0; }
.po-etq .strong { font-weight: 700; }
.po-etq .sign { font-size: 10px; font-weight: 700; margin: 4px 0; }
`;

function AddressBlock({ a, title }: { a: EtiquetaGenericaAddress; title: string }) {
  return (
    <div>
      <div className="block-title">{title}</div>
      <div className="line">
        Logradouro: {a.logradouro ?? '—'}
        {a.numero ? `, ${a.numero}` : ''}
      </div>
      <div className="line">Bairro: {a.bairro ?? '—'}</div>
      {a.complemento && <div className="line">Complemento: {a.complemento}</div>}
      <div className="line">
        Cidade: {a.cidade ?? '—'}
        {a.uf ? ` - ${a.uf}` : ''}
      </div>
      {a.cep && <div className="line">CEP: {formatCep(a.cep)}</div>}
    </div>
  );
}

export interface EtiquetaGenericaSheetProps {
  model: EtiquetaGenericaModel;
}

export const EtiquetaGenericaSheet = forwardRef<HTMLDivElement, EtiquetaGenericaSheetProps>(
  function EtiquetaGenericaSheet({ model }, ref) {
    const { cliente, endereco, recebedor, enderecoReverso } = model;
    return (
      <div className="po-etq" ref={ref}>
        <style>{CSS}</style>

        <div className="title">{model.title}</div>
        {model.subTitle && <div className="subtitle">{model.subTitle}</div>}
        {model.nfeNumero != null && <div className="nfe">NFe nº: {model.nfeNumero}</div>}
        {model.ehReverso && <div className="reverso">Reverso</div>}

        <hr />

        {cliente ? (
          <>
            <div className="line">Cliente: {cliente.nome ?? '—'}</div>
            {cliente.telefone && (
              <div className="line">Fone: {formatTelefone(cliente.telefone)}</div>
            )}
          </>
        ) : (
          <div className="line">Cliente não informado</div>
        )}

        <hr />

        {endereco ? (
          <AddressBlock a={endereco} title={model.ehReverso ? 'Retirada' : 'Entrega'} />
        ) : (
          <div className="line">Endereço não informado</div>
        )}

        <hr />

        {recebedor && (
          <>
            <div className="line strong">Recebedor: {recebedor.nome ?? '—'}</div>
            {recebedor.cpfCnpj && (
              <div className="line">CPF/CNPJ: {formatCpfCnpj(recebedor.cpfCnpj)}</div>
            )}
            {recebedor.telefone && (
              <div className="line">Fone: {formatTelefone(recebedor.telefone)}</div>
            )}
            <hr />
          </>
        )}

        {model.volumesResumo && (
          <>
            <div className="line strong">Volumes: {model.volumesResumo}</div>
            <hr />
          </>
        )}

        {model.ehReverso && enderecoReverso ? (
          <AddressBlock a={enderecoReverso} title="Entrega" />
        ) : (
          <div>
            <div className="sign">Recebido: _________________________________</div>
            <div className="sign">Data: ____/____/______</div>
          </div>
        )}
      </div>
    );
  },
);
