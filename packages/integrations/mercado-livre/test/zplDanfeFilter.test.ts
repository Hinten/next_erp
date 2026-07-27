import { describe, it, expect } from 'vitest';
import { parseZplBlocks, removeZplDanfeBlocks, removeZplDanfeFromZip } from '../src/zplDanfeFilter';
import { Zip, ZipDeflate, strToU8 } from 'fflate';

describe('zplDanfeFilter', () => {
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

    it('is case-sensitive: only uppercase DANFE is matched', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD This contains danfe text ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      // Lowercase "danfe" does not match the uppercase "DANFE" filter
      expect(result).toBeNull();
    });

    it('removes uppercase DANFE blocks while preserving lowercase danfe text', () => {
      const zpl = `^XA
^FO10,10
^A0,30,30^FD DANFE ^FS
^XZ
^XA
^FO10,10
^A0,30,30^FD This has danfe in lowercase ^FS
^XZ`;
      const result = removeZplDanfeBlocks(zpl);
      // Uppercase DANFE is removed, lowercase danfe is preserved
      expect(result).not.toBeNull();
      expect(result).toContain('danfe');
      expect(result).not.toContain('DANFE');
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
