import { Zip, ZipDeflate, strFromU8, strToU8, unzipSync } from 'fflate';

/**
 * Parse ZPL blocks from a string. ZPL blocks are delimited by ^XA (start) and
 * ^XZ (end). Regex parser, matching the legacy Dart original: a single
 * physical line holding several `^XA…^XZ` blocks yields SEVERAL blocks — a
 * line-based scanner would see one, letting a DANFE that shares a line with
 * the transport label defeat the strip.
 */
export function parseZplBlocks(zpl: string): string[] {
  return zpl.match(/\^XA[\s\S]*?\^XZ/g) ?? [];
}

/**
 * Remove ZPL blocks containing 'DANFE' (case-INSENSITIVE, legacy parity) from
 * a ZPL string. Kept blocks are re-joined with '\n' (legacy join).
 * If no DANFE blocks are found or removal would result in no blocks, returns null.
 */
export function removeZplDanfeBlocks(zpl: string): string | null {
  const blocks = parseZplBlocks(zpl);

  if (blocks.length === 0) {
    return null;
  }

  const filteredBlocks = blocks.filter((block) => !block.toUpperCase().includes('DANFE'));

  // If filtering would remove all blocks, don't filter
  if (filteredBlocks.length === 0) {
    return null;
  }

  // If no blocks were actually removed, return null (fail-safe)
  if (filteredBlocks.length === blocks.length) {
    return null;
  }

  return filteredBlocks.join('\n');
}

/**
 * Remove DANFE blocks from a ZIP file containing ZPL labels.
 * Returns the processed ZIP bytes (with DANFE blocks removed), or null if no changes
 * should be made (fail-safe).
 *
 * The fail-safe behavior ensures printing is never blocked:
 * - If the input ZIP is corrupt/invalid, returns null (preserves original)
 * - If no DANFE blocks are found in any file, returns null (no changes needed)
 * - If removal would empty a file's content, skips removal for that file
 * - If all files would be emptied, returns null (preserves original)
 */
export function removeZplDanfeFromZip(zipBytes: Uint8Array): Uint8Array | null {
  // Unzip the input; on corrupt ZIP, fail-safe to return null (preserve original)
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (err) {
    if (err instanceof Error) {
      // Corrupt or invalid ZIP — return null to preserve the original bytes
      return null;
    }
    throw err;
  }

  let hadAnyDanfe = false;
  const processedFiles: Record<string, Uint8Array> = {};

  for (const [filename, fileBytes] of Object.entries(unzipped)) {
    // latin1 (the `true` flag) is byte-exact on round-trip; a UTF-8 decode of
    // arbitrary bytes is lossy (U+FFFD) and would corrupt >0x7F bytes on
    // re-encode. The 'DANFE'/'^XA' matches are ASCII, safe under either.
    const fileContent = strFromU8(fileBytes, true);

    // Only entries that look like ZPL are rewritten; PDFs (folha de
    // controle/PLP) and any other entry are copied byte-intact (legacy parity).
    if (!fileContent.includes('^XA')) {
      processedFiles[filename] = fileBytes;
      continue;
    }

    const processed = removeZplDanfeBlocks(fileContent);
    if (processed !== null) {
      hadAnyDanfe = true;
      processedFiles[filename] = strToU8(processed, true);
    } else {
      // No DANFE found or removal would empty this file
      processedFiles[filename] = fileBytes;
    }
  }

  // If no DANFE was found in any file, fail-safe: return null
  if (!hadAnyDanfe) {
    return null;
  }

  // Re-zip the processed files. Same fail-safe as the unzip above: the legacy
  // guarantee is "em qualquer erro, mantém o original — nunca bloquear a
  // impressão", so an error surfacing through the Zip callback must yield
  // null (caller keeps the original bytes), never propagate.
  try {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, data, _final) => {
      if (err) throw err;
      if (data.length) chunks.push(data);
    });

    for (const [filename, content] of Object.entries(processedFiles)) {
      const entry = new ZipDeflate(filename, { level: 6 });
      zip.add(entry);
      entry.push(content, true);
    }

    zip.end();

    const blob = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      blob.set(chunk, offset);
      offset += chunk.length;
    }

    return blob;
  } catch (err) {
    if (err instanceof Error) {
      return null;
    }
    throw err;
  }
}
