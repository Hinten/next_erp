/**
 * ZPL2 renderer for the DANFE Simplificado — Etiqueta (Zebra label printers).
 *
 * This is **net-new** vs. the legacy Flutter package, whose "etiqueta" was a
 * small PDF. ZPL is emitted directly so a 10×15 cm label streams to a Zebra
 * over raw TCP/USB with no rasterisation: native scalable font (`^A0N`) and
 * native Code 128 (`^BCN`) of the 44-digit chave. `^CI28` selects UTF-8 so the
 * Portuguese accents survive.
 *
 * `dpi` defaults to **203** (8 dots/mm → ~800×1200 dots for 10×15 cm); pass
 * `300` for the 12 dots/mm head (~1200×1800). All layout is authored in
 * millimetres and scaled by `dpi/25.4`, so the same code targets both heads.
 *
 * Paste the output into https://labelary.com to preview before a physical run.
 */
import type { DanfeModel } from './model';
import {
  cutString,
  formatCep,
  formatChaveAcesso,
  formatCpfCnpj,
  formatDate,
  formatMoney,
  formatNNF,
  formatSerie,
  formatTimeSeconds,
} from './format';

export interface ZplOptions {
  /** Printhead density in dots-per-inch. Default 203; 300 also supported. */
  readonly dpi?: number;
}

const LABEL_W_MM = 100;
const LABEL_H_MM = 150;
const MARGIN_MM = 4;
const RIGHT_MM = LABEL_W_MM - MARGIN_MM;

/**
 * Strip the two ZPL control prefixes from field data so a stray `^`/`~` in a
 * razão social or endereço can't terminate the field or inject a command.
 */
function sanitize(text: string): string {
  return text.replace(/[\^~]/g, ' ').toUpperCase();
}

export function renderSimplificadoZpl(model: DanfeModel, opts: ZplOptions = {}): string {
  const dpi = opts.dpi ?? 203;
  const dpm = dpi / 25.4;
  const mm = (v: number): number => Math.round(v * dpm);

  // Font heights (dots) derived from millimetre sizes so they scale with dpi.
  const H_TITLE = mm(3.4);
  const H_TEXT = mm(2.4);
  const H_CHAVE = mm(2.6);

  const out: string[] = [];
  out.push('^XA');
  out.push('^CI28'); // UTF-8
  out.push(`^PW${mm(LABEL_W_MM)}`);
  out.push(`^LL${mm(LABEL_H_MM)}`);
  out.push('^LH0,0');

  /** Centered text spanning the full label width. */
  const centered = (yMm: number, text: string, h: number): void => {
    out.push(`^FO0,${mm(yMm)}^A0N,${h}^FB${mm(LABEL_W_MM)},1,0,C,0^FD${sanitize(text)}^FS`);
  };
  /** Left-anchored label + right-justified value on one row. */
  const row = (yMm: number, label: string, value: string): void => {
    out.push(`^FO${mm(MARGIN_MM)},${mm(yMm)}^A0N,${H_TEXT}^FD${sanitize(label)}^FS`);
    out.push(
      `^FO0,${mm(yMm)}^A0N,${H_TEXT}^FB${mm(RIGHT_MM)},1,0,R,0^FD${sanitize(value)}^FS`,
    );
  };
  /** Left-anchored single line. */
  const line = (yMm: number, text: string, h = H_TEXT): void => {
    out.push(`^FO${mm(MARGIN_MM)},${mm(yMm)}^A0N,${h}^FD${sanitize(text)}^FS`);
  };

  let y = MARGIN_MM;
  centered(y, 'DANFE SIMPLIFICADO - ETIQUETA', H_TITLE);
  y += 6;

  // Code 128 of the 44-digit chave. Module width 2 dots keeps ~44 digits
  // (subset C) inside the label; ^BY sets the narrow-bar width.
  out.push(`^FO${mm(8)},${mm(y)}^BY2^BCN,${mm(12)},N,N,N^FD${model.chave}^FS`);
  y += 16;
  centered(y, formatChaveAcesso(model.chave), H_CHAVE);
  y += 6;

  // Protocolo de autorização de uso.
  if (model.prot) {
    line(y, 'PROTOCOLO DE AUTORIZACAO DE USO');
    y += 4;
    const prot = `${model.prot.nProt ?? ''} ${formatDate(model.prot.dhRecbto)} ${formatTimeSeconds(model.prot.dhRecbto)}`;
    line(y, prot.trim());
    y += 6;
  }

  // Emitente.
  centered(y, 'DADOS DO EMITENTE', H_TEXT);
  y += 4;
  row(y, model.emit.cnpj ? 'RAZAO SOCIAL' : 'NOME', model.emit.nome);
  y += 4;
  const emitDoc = model.emit.cnpj ?? model.emit.cpf;
  if (emitDoc) {
    row(y, model.emit.cnpj ? 'CNPJ' : 'CPF', formatCpfCnpj(emitDoc));
    y += 4;
  }
  row(y, 'IE', model.emit.ie);
  y += 4;
  line(y, cutString(enderecoLinha(model.emit.endereco), 70));
  y += 6;

  // Dados gerais da NF-e.
  centered(y, 'DADOS GERAIS DA NF-E', H_TEXT);
  y += 4;
  row(y, 'TIPO', model.ide.tpNF === '1' ? '1 - SAIDA' : '0 - ENTRADA');
  y += 4;
  row(y, 'NF-E No', formatNNF(model.ide.nNF));
  y += 4;
  row(y, 'SERIE', formatSerie(model.ide.serie));
  y += 4;
  row(y, 'DATA DA EMISSAO', formatDate(model.ide.dhEmi));
  y += 4;
  row(y, 'VALOR TOTAL', formatMoney(model.total.vNF));
  y += 6;

  // Destinatário.
  centered(y, 'DADOS DO DESTINATARIO', H_TEXT);
  y += 4;
  row(y, 'NOME/RAZAO SOCIAL', model.dest.nome);
  y += 4;
  const destDoc = model.dest.cnpj ?? model.dest.cpf ?? model.dest.idEstrangeiro;
  if (destDoc) {
    const destLabel = model.dest.cnpj ? 'CNPJ' : model.dest.cpf ? 'CPF' : 'ID ESTRANGEIRO';
    const destValue = model.dest.idEstrangeiro ? destDoc : formatCpfCnpj(destDoc);
    row(y, destLabel, destValue);
    y += 4;
  }
  if (model.dest.endereco) {
    line(y, cutString(enderecoLinha(model.dest.endereco), 70));
    y += 6;
  }

  // Dados adicionais (wraps in a field block).
  const infCpl = [model.infAdic.infCpl, model.infAdic.infAdFisco].filter(Boolean).join(' ');
  if (infCpl) {
    out.push(
      `^FO${mm(MARGIN_MM)},${mm(y)}^A0N,${H_TEXT}^FB${mm(RIGHT_MM - MARGIN_MM)},6,0,L,0^FD${sanitize(cutString(infCpl, 360))}^FS`,
    );
  }

  // Homologação watermark — a label can't do a rotated translucent overlay,
  // so stamp a prominent line at the foot instead.
  if (model.homologacao) {
    centered(LABEL_H_MM - 8, 'SEM VALOR FISCAL', mm(3.2));
  }

  out.push('^XZ');
  return out.join('\n');
}

/** Compose the one-line address shown on the label. */
function enderecoLinha(e: DanfeModel['emit']['endereco']): string {
  const compl = e.complemento ? `, ${e.complemento}` : '';
  const cep = e.cep ? `, CEP: ${formatCep(e.cep)}` : '';
  return `${e.logradouro}, ${e.numero}${compl} - ${e.bairro} - ${e.municipio} - ${e.uf}${cep}`;
}
