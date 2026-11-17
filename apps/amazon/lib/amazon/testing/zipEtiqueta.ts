/**
 * A label zip, built in test code — **for tests only**, the same rule as
 * `fakeDb.ts`: nothing outside a `*.test.ts` imports this. Never a real label,
 * never a file on disk.
 *
 * A byte-level writer of stored (method 0) entries, because the app does not
 * depend on the zip library its package uses. Every entry carries its real CRC-32
 * and lengths, so the package's extraction verifies it for real; {@link corromper}
 * breaks one on purpose.
 */

const crc32Tabela = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crc32Tabela[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The little-endian writer of one zip record. */
function registro(campos: readonly (readonly [number, 2 | 4])[]): Uint8Array {
  const total = campos.reduce((soma, [, largura]) => soma + largura, 0);
  const saida = new Uint8Array(total);
  const visao = new DataView(saida.buffer);
  let o = 0;
  for (const [valor, largura] of campos) {
    if (largura === 2) visao.setUint16(o, valor, true);
    else visao.setUint32(o, valor, true);
    o += largura;
  }
  return saida;
}

function juntar(partes: readonly Uint8Array[]): Uint8Array {
  const saida = new Uint8Array(partes.reduce((soma, p) => soma + p.length, 0));
  let o = 0;
  for (const p of partes) {
    saida.set(p, o);
    o += p.length;
  }
  return saida;
}

/** The bytes of a text, UTF-8. */
export function bytesDe(texto: string): Uint8Array {
  return new TextEncoder().encode(texto);
}

/** A zip of stored entries, in order. */
export function zipDeTeste(entradas: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let deslocamento = 0;
  const nomes = Object.keys(entradas);
  for (const nome of nomes) {
    const dados = entradas[nome] ?? new Uint8Array(0);
    const nomeBytes = bytesDe(nome);
    const crc = crc32(dados);
    const local = juntar([
      registro([
        [0x04034b50, 4],
        [20, 2],
        [0, 2],
        [0, 2],
        [0, 2],
        [0, 2],
        [crc, 4],
        [dados.length, 4],
        [dados.length, 4],
        [nomeBytes.length, 2],
        [0, 2],
      ]),
      nomeBytes,
      dados,
    ]);
    centrais.push(
      juntar([
        registro([
          [0x02014b50, 4],
          [20, 2],
          [20, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [crc, 4],
          [dados.length, 4],
          [dados.length, 4],
          [nomeBytes.length, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 4],
          [deslocamento, 4],
        ]),
        nomeBytes,
      ]),
    );
    locais.push(local);
    deslocamento += local.length;
  }
  const diretorio = juntar(centrais);
  return juntar([
    ...locais,
    diretorio,
    registro([
      [0x06054b50, 4],
      [0, 2],
      [0, 2],
      [nomes.length, 2],
      [nomes.length, 2],
      [diretorio.length, 4],
      [deslocamento, 4],
      [0, 2],
    ]),
  ]);
}

/** The same zip with one byte of the stored `conteudo` changed: its recorded CRC-32 no longer holds. */
export function corromper(zip: Uint8Array, conteudo: Uint8Array): Uint8Array {
  const copia = zip.slice();
  const i = copia.findIndex((_, o) => conteudo.every((b, j) => copia[o + j] === b));
  if (i === -1) throw new RangeError('corromper: o conteúdo não está no zip');
  copia[i] = ((copia[i] ?? 0) + 1) & 0xff;
  return copia;
}
