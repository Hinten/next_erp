import { describe, it, expect } from 'vitest';
import { parseZplBlocks, removeZplDanfeBlocks, removeZplDanfeFromZip } from '../src/zplDanfeFilter';
import { Zip, ZipDeflate, strFromU8, strToU8, unzipSync } from 'fflate';

describe('zplDanfeFilter', () => {
  // Helper to extract text from a ZIP file
  function getZipFileContent(zipBytes: Uint8Array, filename: string): string {
    const unzipped = unzipSync(zipBytes);
    const fileBytes = unzipped[filename];
    if (!fileBytes) {
      throw new Error(`File ${filename} not found in ZIP`);
    }
    return new TextDecoder().decode(fileBytes);
  }

  // Helper to build an in-memory ZIP from named byte entries
  function buildZip(entries: Record<string, Uint8Array>): Uint8Array {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, data) => {
      if (err) throw err;
      if (data.length) chunks.push(data);
    });
    for (const [name, content] of Object.entries(entries)) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(content, true);
    }
    zip.end();
    const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      zipBytes.set(chunk, offset);
      offset += chunk.length;
    }
    return zipBytes;
  }

  describe('parseZplBlocks', () => {
    it('parses a single ZPL block', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD TEST ^FS
^XZ`;
      const blocks = parseZplBlocks(zpl);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('^XA');
      expect(blocks[0]).toContain('^XZ');
    });

    it('parses multiple ZPL blocks', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD Label 1 ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label 2 ^FS
^XZ`;
      const blocks = parseZplBlocks(zpl);
      expect(blocks).toHaveLength(2);
    });

    it('parses empty string', () => {
      const blocks = parseZplBlocks('');
      expect(blocks).toHaveLength(0);
    });

    it('parses multiple blocks sharing a single physical line (legacy regex parser)', () => {
      // A line-based scanner sees ONE block here — the regex must see two.
      const zpl = '^XA^FD DANFE SIMPLIFICADO ^FS^XZ^XA^FD Transport ^FS^XZ';
      const blocks = parseZplBlocks(zpl);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toBe('^XA^FD DANFE SIMPLIFICADO ^FS^XZ');
      expect(blocks[1]).toBe('^XA^FD Transport ^FS^XZ');
    });
  });

  describe('removeZplDanfeBlocks', () => {
    it('removes a block containing DANFE', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD DANFE ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      expect(result).not.toBeNull();
      expect(result).not.toContain('DANFE');
      expect(result).toContain('Label');
    });

    it('returns null if no DANFE found', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD Label ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      expect(result).toBeNull();
    });

    it('returns null if all blocks contain DANFE', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD DANFE 1 ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD DANFE 2 ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      expect(result).toBeNull();
    });

    it('preserves blocks without DANFE', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD Label 1 ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD DANFE ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label 2 ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      expect(result).toContain('Label 1');
      expect(result).toContain('Label 2');
      expect(result).not.toContain('DANFE');
    });

    it('matches DANFE case-INSENSITIVELY (legacy parity: bloco.toUpperCase())', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD This contains danfe text ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Transport label ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      // Lowercase "danfe" is a DANFE block too — it must be stripped
      expect(result).not.toBeNull();
      expect(result).not.toContain('danfe');
      expect(result).toContain('Transport label');
    });

    it('strips uppercase, lowercase and mixed-case DANFE blocks alike', () => {
      const zpl = [
        '^XA^FD DANFE ^FS^XZ',
        '^XA^FD danfe ^FS^XZ',
        '^XA^FD DaNfE ^FS^XZ',
        '^XA^FD Transport label ^FS^XZ',
      ].join('\n');
      const result = removeZplDanfeBlocks(zpl);
      expect(result).toBe('^XA^FD Transport label ^FS^XZ');
    });

    it('strips a DANFE block sharing a single physical line with the transport label', () => {
      // The single-line layout must not hide the DANFE inside one giant block.
      const zpl = '^XA^FD DANFE SIMPLIFICADO ^FS^XZ^XA^FD Transport ^FS^XZ';
      expect(removeZplDanfeBlocks(zpl)).toBe('^XA^FD Transport ^FS^XZ');
    });
  });

  describe('removeZplDanfeFromZip', () => {
    it('removes DANFE from a single-file ZIP', async () => {
      // Create a ZIP with one file containing DANFE
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      const zplContent = `^XA
^FO10,10
^A0,30,30^FD DANFE Block ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label ^FS
^XZ`;
      const entry = new ZipDeflate('label.zpl', { level: 6 });
      zip.add(entry);
      entry.push(strToU8(zplContent), true);
      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);
      // Verify DANFE was actually removed
      const content = getZipFileContent(result!, 'label.zpl');
      expect(content).not.toContain('DANFE Block');
      expect(content).toContain('Label');
    });

    it('returns null if no DANFE found in ZIP', async () => {
      // Create a ZIP with a file that has no DANFE
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      const zplContent = `^XA
^FO10,10
^A0,30,30^FD Label ^FS
^XZ`;
      const entry = new ZipDeflate('label.zpl', { level: 6 });
      zip.add(entry);
      entry.push(strToU8(zplContent), true);
      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).toBeNull();
    });

    it('handles multiple files in ZIP with mixed DANFE/no-DANFE', async () => {
      // Create a multi-file ZIP
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      const content1 = `^XA
^FO10,10
^A0,30,30^FD DANFE Block ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label 1 ^FS
^XZ`;

      const content2 = `^XA
^FO10,10
^A0,30,30^FD Label 2 ^FS
^XZ`;

      const entry1 = new ZipDeflate('label1.zpl', { level: 6 });
      zip.add(entry1);
      entry1.push(strToU8(content1), true);

      const entry2 = new ZipDeflate('label2.zpl', { level: 6 });
      zip.add(entry2);
      entry2.push(strToU8(content2), true);

      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).not.toBeNull();
      // Verify DANFE was removed from file1 and file2 still exists
      const label1 = getZipFileContent(result!, 'label1.zpl');
      expect(label1).not.toContain('DANFE');
      expect(label1).toContain('Label 1');
      const label2 = getZipFileContent(result!, 'label2.zpl');
      expect(label2).toContain('Label 2');
    });

    it('returns null if all files would be emptied by DANFE removal', async () => {
      // Create a ZIP where the only content is DANFE
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      const zplContent = `^XA
^FO10,10
^A0,30,30^FD DANFE Only ^FS
^XZ`;
      const entry = new ZipDeflate('label.zpl', { level: 6 });
      zip.add(entry);
      entry.push(strToU8(zplContent), true);
      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).toBeNull();
    });

    it('preserves non-ZPL files in ZIP', async () => {
      // Create a ZIP with both ZPL and non-ZPL files
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      const zplContent = `^XA
^FO10,10
^A0,30,30^FD DANFE Block ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label ^FS
^XZ`;

      const txtContent = 'Some text file';

      const entry1 = new ZipDeflate('label.zpl', { level: 6 });
      zip.add(entry1);
      entry1.push(strToU8(zplContent), true);

      const entry2 = new ZipDeflate('manifest.txt', { level: 6 });
      zip.add(entry2);
      entry2.push(strToU8(txtContent), true);

      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).not.toBeNull();
      // Verify DANFE was removed from ZPL file
      const zplResult = getZipFileContent(result!, 'label.zpl');
      expect(zplResult).not.toContain('DANFE');
      expect(zplResult).toContain('Label');
      // Verify non-ZPL file is preserved unchanged
      const txtResult = getZipFileContent(result!, 'manifest.txt');
      expect(txtResult).toBe(txtContent);
    });

    it('latin1 round-trip: >0x7F bytes in a kept block survive byte-identical after a strip in the same entry', () => {
      // 0xC7 0xE3 ("Çã" in latin1) — a UTF-8 decode maps each to U+FFFD and the
      // re-encode would corrupt them to EF BF BD.
      const keptBytes = new Uint8Array([
        ...strToU8('^XA^FD', true),
        0xc7,
        0xe3,
        ...strToU8('^FS^XZ', true),
      ]);
      const entryBytes = new Uint8Array([...strToU8('^XA^FD DANFE ^FS^XZ\n', true), ...keptBytes]);
      const result = removeZplDanfeFromZip(buildZip({ 'label.zpl': entryBytes }));
      expect(result).not.toBeNull();
      const outBytes = unzipSync(result!)['label.zpl']!;
      expect(Array.from(outBytes)).toEqual(Array.from(keptBytes));
    });

    it('non-ZPL binary entries pass through byte-identical when a strip happens elsewhere in the ZIP', () => {
      // A pseudo-PDF holding EVERY byte value — no '^XA', so it is copied intact.
      const pdfBytes = new Uint8Array(8 + 256);
      pdfBytes.set(strToU8('%PDF-1.4', true), 0);
      for (let i = 0; i < 256; i++) pdfBytes[8 + i] = i;
      const zplContent = '^XA^FD DANFE ^FS^XZ\n^XA^FD Label ^FS^XZ';
      const result = removeZplDanfeFromZip(
        buildZip({ 'label.zpl': strToU8(zplContent, true), 'plp.pdf': pdfBytes }),
      );
      expect(result).not.toBeNull();
      const out = unzipSync(result!);
      expect(Array.from(out['plp.pdf']!)).toEqual(Array.from(pdfBytes));
      const label = strFromU8(out['label.zpl']!, true);
      expect(label).not.toContain('DANFE');
      expect(label).toContain('Label');
    });

    it('strips a single-line multi-block DANFE inside a ZIP entry', () => {
      const zpl = '^XA^FD DANFE SIMPLIFICADO ^FS^XZ^XA^FD Transport ^FS^XZ';
      const result = removeZplDanfeFromZip(buildZip({ 'label.zpl': strToU8(zpl, true) }));
      expect(result).not.toBeNull();
      expect(strFromU8(unzipSync(result!)['label.zpl']!, true)).toBe('^XA^FD Transport ^FS^XZ');
    });

    it('strips lowercase danfe blocks inside a ZIP entry (case-insensitive, legacy parity)', () => {
      const zpl = '^XA^FD danfe simplificado ^FS^XZ\n^XA^FD Transport ^FS^XZ';
      const result = removeZplDanfeFromZip(buildZip({ 'label.zpl': strToU8(zpl, true) }));
      expect(result).not.toBeNull();
      expect(strFromU8(unzipSync(result!)['label.zpl']!, true)).toBe('^XA^FD Transport ^FS^XZ');
    });

    it('handles edge case: empty ZIP', async () => {
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).toBeNull();
    });

    it('preserves the structure of ZIP files', async () => {
      // This test verifies that the output ZIP is valid and can be read
      const chunks: Uint8Array[] = [];
      const zip = new Zip((err, data) => {
        if (err) throw err;
        if (data.length) chunks.push(data);
      });

      const zplContent = `^XA
^FO10,10
^A0,30,30^FD DANFE Block ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD Label ^FS
^XZ`;

      const entry = new ZipDeflate('label.zpl', { level: 6 });
      zip.add(entry);
      entry.push(strToU8(zplContent), true);
      zip.end();

      const zipBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.length;
      }

      const result = removeZplDanfeFromZip(zipBytes);
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);
      // Should be a valid ZIP (starts with PK signature)
      expect(result![0]).toBe(0x50); // 'P'
      expect(result![1]).toBe(0x4b); // 'K'
    });
  });
});
