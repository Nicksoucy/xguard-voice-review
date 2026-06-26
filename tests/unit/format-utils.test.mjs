import { describe, it, expect } from 'vitest';
import fmt from '../../lib/format-utils.js';

const { esc, csvEscape, rowsToCSV } = fmt;

describe('esc (anti-XSS)', () => {
  it('echappe les caracteres dangereux', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('"quote"')).toBe('&quot;quote&quot;');
    expect(esc("l'apostrophe")).toBe('l&#39;apostrophe');
  });
  it('tolere null/undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
  it('neutralise une injection de balise script', () => {
    expect(esc('<script>evil()</script>')).not.toContain('<script>');
  });
});

describe('csvEscape (RFC 4180)', () => {
  it('entoure de guillemets si virgule/quote/newline', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });
  it('laisse tel quel sinon, et vide pour null', () => {
    expect(csvEscape('simple')).toBe('simple');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(42)).toBe('42');
  });
});

describe('rowsToCSV', () => {
  it('construit un CSV avec entete', () => {
    const csv = rowsToCSV(
      [
        { a: 1, b: 'x,y' },
        { a: 2, b: 'z' },
      ],
      ['a', 'b'],
    );
    expect(csv).toBe('a,b\n1,"x,y"\n2,z');
  });
  it("retourne juste l'entete si pas de lignes", () => {
    expect(rowsToCSV([], ['a', 'b'])).toBe('a,b\n');
  });
});

describe('fmtDate (date lisible fr-CA, tolerante)', () => {
  it('formate une date ISO valide', () => {
    const s = fmt.fmtDate('2026-06-25T14:30:00Z');
    expect(typeof s).toBe('string');
    expect(s).toContain('2026');
  });
  it('ne lance JAMAIS sur entree invalide / null / undefined (retourne une string)', () => {
    expect(() => fmt.fmtDate('pas-une-date')).not.toThrow();
    expect(() => fmt.fmtDate(null)).not.toThrow();
    expect(() => fmt.fmtDate(undefined)).not.toThrow();
    expect(typeof fmt.fmtDate('pas-une-date')).toBe('string');
  });
});
