// Correctif 14 (chantier 03) : scripts/bump-cache.mjs met le meme ?v= partout.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { versionner, pagesHtml } from '../../scripts/bump-cache.mjs';

describe('versionner', () => {
  it('remplace les ?v= existants et en ajoute aux fichiers locaux qui n en ont pas', () => {
    const h = '<script src="cockpit.js?v=20260829a"></script><link rel="stylesheet" href="review.css"><script src="../lib/net.js?v=x"></script>';
    expect(versionner(h, 'abc1234')).toBe('<script src="cockpit.js?v=abc1234"></script><link rel="stylesheet" href="review.css?v=abc1234"><script src="../lib/net.js?v=abc1234"></script>');
  });
  it('ne touche jamais une adresse externe', () => {
    const h = '<script src="https://js.sentry-cdn.com/x.min.js"></script><script src="//cdn.x/y.js"></script>';
    expect(versionner(h, 'abc1234')).toBe(h);
  });
});

describe('pages servies', () => {
  it('chaque .js / .css local est reference avec un ?v= (sinon le cache le fige)', () => {
    const fautes = [];
    for (const f of pagesHtml()) {
      const html = readFileSync(f, 'utf8');
      for (const m of html.matchAll(/\b(?:src|href)="([^"]+?\.(?:js|css))(\?v=[^"]*)?"/g)) {
        if (/^(https?:)?\/\//.test(m[1])) continue;
        if (!m[2]) fautes.push(f.split('voice-review/').pop() + ' : ' + m[1]);
      }
    }
    expect(fautes).toEqual([]);
  });
});
