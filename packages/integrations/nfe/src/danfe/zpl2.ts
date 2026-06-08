/**
 * ZPL2 renderer for the DANFE Simplificado — Etiqueta (Zebra label printers).
 *
 * This is **net-new** vs. the legacy Flutter package, whose "etiqueta" was a
 * small PDF. ZPL is emitted directly so a 10×15 cm label streams to a Zebra
 * over raw TCP/USB with no rasterisation: native scalable font (`^A0N`), native
 * Code 128 (`^BCN`) of the 44-digit chave, and `^GB` boxes that mirror the PDF's
 * bordered sections. `^CI28` selects UTF-8 so the Portuguese accents survive.
 *
 * `dpi` defaults to **203** (8 dots/mm → ~800×1200 dots for 10×15 cm); pass
 * `300` for the 12 dots/mm head (~1200×1800). All layout is authored in
 * millimetres and scaled by `dpi/25.4`, so the same code targets both heads.
 *
 * Paste the output into https://labelary.com to preview before a physical run.
 */
import type { DanfeModel, DanfeEndereco } from './model';
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
const MARGIN_MM = 3;
const INNER_W_MM = LABEL_W_MM - 2 * MARGIN_MM;
const PAD_X_MM = MARGIN_MM + 2; // text left inset inside a box
const VAL_RIGHT_MM = LABEL_W_MM - MARGIN_MM - 2; // value right edge
const TEXT_W_MM = INNER_W_MM - 4;
const LH_MM = 4.2; // line height
const BOX_PAD_MM = 1.4; // box inner top/bottom padding
/** Max chars for a razão social / nome so the right-aligned value clears the label. */
const NAME_MAX = 36;

/**
 * Strip the two ZPL control prefixes from field data so a stray `^`/`~` in a
 * razão social or endereço can't terminate the field or inject a command.
 */
function sanitize(text: string): string {
  return text.replace(/[\^~]/g, ' ').toUpperCase();
}

/** A row inside a bordered section. */
type Row =
  | { kind: 'kv'; label: string; value: string }
  | { kind: 'line'; text: string }
  | { kind: 'wrap'; text: string; lines: number };

export function renderSimplificadoZpl(model: DanfeModel, opts: ZplOptions = {}): string {
  const dpi = opts.dpi ?? 203;
  const dpm = dpi / 25.4;
  const mm = (v: number): number => Math.round(v * dpm);
  const widthDots = mm(LABEL_W_MM);

  const H_TITLE = mm(3.2);
  const H_TEXT = mm(2.3);
  const H_CHAVE = mm(2.5);

  const out: string[] = [];
  out.push('^XA', '^CI28', `^PW${widthDots}`, `^LL${mm(LABEL_H_MM)}`, '^LH0,0');

  /** Centered text spanning the full label width. */
  const centered = (yMm: number, str: string, h: number): void => {
    out.push(`^FO0,${mm(yMm)}^A0N,${h}^FB${widthDots},1,0,C,0^FD${sanitize(str)}^FS`);
  };
  /** Left-anchored single line. */
  const leftText = (xMm: number, yMm: number, str: string, h = H_TEXT): void => {
    out.push(`^FO${mm(xMm)},${mm(yMm)}^A0N,${h}^FD${sanitize(str)}^FS`);
  };
  /** Right-justified value whose right edge sits at `rightMm`. */
  const rightText = (yMm: number, str: string, rightMm: number, h = H_TEXT): void => {
    out.push(`^FO0,${mm(yMm)}^A0N,${h}^FB${mm(rightMm)},1,0,R,0^FD${sanitize(str)}^FS`);
  };
  /** Box border (graphic box) of thickness `t` dots. */
  const gbox = (xMm: number, yMm: number, wMm: number, hMm: number, t = 2): void => {
    out.push(`^FO${mm(xMm)},${mm(yMm)}^GB${mm(wMm)},${mm(hMm)},${t}^FS`);
  };

  // Outer border (mirrors the PDF's outer box).
  gbox(MARGIN_MM, MARGIN_MM, INNER_W_MM, LABEL_H_MM - 2 * MARGIN_MM, 2);

  let y = MARGIN_MM + 2;
  centered(y, 'DANFE SIMPLIFICADO - ETIQUETA', H_TITLE);
  y += 6;

  // Centered Code 128. For an all-numeric chave bwip/ZPL use subset C
  // (two digits/symbol); the printed width is deterministic, so compute it and
  // center the field. Module (narrow-bar) width scales with dpi (~0.25 mm).
  const moduleDots = Math.max(2, Math.round(0.25 * dpm));
  const dataSymbols = Math.ceil(model.chave.length / 2);
  // (start C + data + checksum) × 11 modules + 13-module stop pattern.
  const barModules = (dataSymbols + 2) * 11 + 13;
  const barWidthDots = barModules * moduleDots;
  const bcX = Math.max(mm(MARGIN_MM), Math.round((widthDots - barWidthDots) / 2));
  out.push(`^FO${bcX},${mm(y)}^BY${moduleDots}^BCN,${mm(11)},N,N,N^FD${model.chave}^FS`);
  y += 12;
  centered(y, formatChaveAcesso(model.chave), H_CHAVE);
  y += 5;

  /** Draw a bordered section with an optional centered title and rows. */
  const section = (title: string | null, rows: Row[]): void => {
    const titleLines = title ? 1 : 0;
    const bodyLines = rows.reduce((a, r) => a + (r.kind === 'wrap' ? r.lines : 1), 0);
    const hMm = BOX_PAD_MM + (titleLines + bodyLines) * LH_MM + BOX_PAD_MM;
    gbox(MARGIN_MM, y, INNER_W_MM, hMm);
    let yy = y + BOX_PAD_MM;
    if (title) {
      centered(yy, title, H_TEXT);
      yy += LH_MM;
    }
    for (const r of rows) {
      if (r.kind === 'wrap') {
        out.push(
          `^FO${mm(PAD_X_MM)},${mm(yy)}^A0N,${H_TEXT}^FB${mm(TEXT_W_MM)},${r.lines},0,L,0^FD${sanitize(r.text)}^FS`,
        );
        yy += r.lines * LH_MM;
      } else if (r.kind === 'line') {
        leftText(PAD_X_MM, yy, r.text);
        yy += LH_MM;
      } else {
        leftText(PAD_X_MM, yy, r.label);
        rightText(yy, r.value, VAL_RIGHT_MM);
        yy += LH_MM;
      }
    }
    y += hMm + 1.5;
  };

  // Protocolo de autorização de uso.
  if (model.prot) {
    section(null, [
      { kind: 'line', text: 'Protocolo de autorização de uso' },
      {
        kind: 'line',
        text: `${model.prot.nProt ?? ''} ${formatDate(model.prot.dhRecbto)} ${formatTimeSeconds(model.prot.dhRecbto)}`.trim(),
      },
    ]);
  }

  // Emitente.
  const emitDoc = model.emit.cnpj ?? model.emit.cpf;
  section('Dados do emitente', [
    { kind: 'kv', label: model.emit.cnpj ? 'Razão Social' : 'Nome', value: cutString(model.emit.nome, NAME_MAX) },
    ...(emitDoc
      ? [{ kind: 'kv' as const, label: model.emit.cnpj ? 'CNPJ' : 'CPF', value: formatCpfCnpj(emitDoc) }]
      : []),
    { kind: 'kv', label: 'IE', value: model.emit.ie },
    { kind: 'line', text: cutString(enderecoLinha(model.emit.endereco), 64) },
  ]);

  // Dados gerais da NF-e.
  section('Dados gerais da NF-e', [
    { kind: 'kv', label: 'Tipo', value: model.ide.tpNF === '1' ? '1 - Saída' : '0 - Entrada' },
    { kind: 'kv', label: 'NF-e Nº', value: formatNNF(model.ide.nNF) },
    { kind: 'kv', label: 'Série', value: formatSerie(model.ide.serie) },
    { kind: 'kv', label: 'Data da emissão', value: formatDate(model.ide.dhEmi) },
    { kind: 'kv', label: 'Valor total', value: formatMoney(model.total.vNF) },
  ]);

  // Destinatário.
  const destDoc = model.dest.cnpj ?? model.dest.cpf ?? model.dest.idEstrangeiro;
  const destRows: Row[] = [{ kind: 'kv', label: 'Nome', value: cutString(model.dest.nome, NAME_MAX) }];
  if (destDoc) {
    const label = model.dest.cnpj ? 'CNPJ' : model.dest.cpf ? 'CPF' : 'ID Estrangeiro';
    destRows.push({ kind: 'kv', label, value: model.dest.idEstrangeiro ? destDoc : formatCpfCnpj(destDoc) });
  }
  if (model.dest.ie) destRows.push({ kind: 'kv', label: 'IE', value: model.dest.ie });
  if (model.dest.endereco) {
    destRows.push({ kind: 'line', text: cutString(enderecoLinha(model.dest.endereco), 64) });
  }
  section('Dados do destinatário/remetente', destRows);

  // Dados adicionais.
  const infCpl = [model.infAdic.infCpl, model.infAdic.infAdFisco].filter(Boolean).join(' ');
  if (infCpl) {
    section('Dados adicionais', [{ kind: 'wrap', text: cutString(infCpl, 300), lines: 3 }]);
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
function enderecoLinha(e: DanfeEndereco): string {
  const compl = e.complemento ? `, ${e.complemento}` : '';
  const cep = e.cep ? `, CEP: ${formatCep(e.cep)}` : '';
  return `${e.logradouro}, ${e.numero}${compl} - ${e.bairro} - ${e.municipio} - ${e.uf}${cep}`;
}
