import { Zip, ZipDeflate, strToU8, unzipSync } from 'fflate';

/**
 * Parse ZPL blocks from a string. ZPL blocks are delimited by ^XA (start) and
 * ^XZ (end).
 */
export function parseZplBlocks(zpl: string): string[] {
  const blocks: string[] = [];
  let currentBlock = '';
  let inBlock = false;

  const lines = zpl.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes('^XA')) {
      inBlock = true;
      currentBlock = line;
    } else if (line.includes('^XZ')) {
      currentBlock += '\n' + line;
      blocks.push(currentBlock);
      currentBlock = '';
      inBlock = false;
    } else if (inBlock) {
      currentBlock += '\n' + line;
    }
  }

  // Handle case where ZPL might be on a single line without newlines
  if (inBlock) {
    blocks.push(currentBlock);
  }

  return blocks;
}

/**
 * Remove ZPL blocks containing 'DANFE' from a ZPL string.
 * Returns the reconstructed ZPL with DANFE blocks removed.
 * If no DANFE blocks are found or removal would result in no blocks, returns null.
 */
export function removeZplDanfeBlocks(zpl: string): string | null {
  const blocks = parseZplBlocks(zpl);

  if (blocks.length === 0) {
    return null;
  }

  const filteredBlocks = blocks.filter((block) => !block.includes('DANFE'));

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

  const files = Object.entries(unzipped);
  let hadAnyDanfe = false;
  const processedFiles: Record<string, Uint8Array> = {};

  // Process each file in the ZIP
  for (const [filename, fileBytes] of files) {
    // Try to decode the file as text (ZPL is text-based)
    let fileContent = '';
    try {
      fileContent = new TextDecoder().decode(fileBytes);
    } catch (err) {
      // If it's not text, keep it as-is
      // TextDecoder.decode generally doesn't throw, but we handle it for completeness
      if (err instanceof Error) {
        processedFiles[filename] = fileBytes;
        continue;
      }
      throw err;
    }

    // Try to remove DANFE blocks
    const processed = removeZplDanfeBlocks(fileContent);

    if (processed !== null) {
      hadAnyDanfe = true;
      processedFiles[filename] = strToU8(processed);
    } else {
      // No DANFE found or removal would empty this file
      processedFiles[filename] = fileBytes;
    }
  }

  // If no DANFE was found in any file, fail-safe: return null
  if (!hadAnyDanfe) {
    return null;
  }

  // Re-zip the processed files
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
}
