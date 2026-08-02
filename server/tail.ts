import { openSync, readSync, closeSync, statSync } from 'node:fs';

export class Tailer {
  private offsets = new Map<string, number>();

  readNew(filePath: string): string[] {
    const size = statSync(filePath).size;
    let off = this.offsets.get(filePath) ?? 0;
    if (size <= off) return [];
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(size - off);
    readSync(fd, buf, 0, buf.length, off);
    closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return [];                 // no complete line yet
    this.offsets.set(filePath, off + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'));
    return text.slice(0, lastNl).split('\n').filter(Boolean);
  }
}
