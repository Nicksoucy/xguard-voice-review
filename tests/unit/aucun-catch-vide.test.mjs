// Garde-fou du chantier 03 (2026-11-10) : plus aucun catch vide dans le depot.
// Un catch vide avale une panne sans rien dire : c'est ce qui laissait « Chargement... »
// pour toujours, ou affichait « Enregistre » quand rien n'etait parti.
//
// ESLint (regle no-restricted-syntax de .eslintrc.json) couvre les .js et .mjs, mais pas le
// JavaScript ecrit DANS les pages .html (course.html, en/review.html...). Ce test lit tous les
// fichiers servis et refuse :
//   - catch (e) {}                  bloc vide, meme avec seulement un commentaire dedans
//   - .catch(function(){})          gestionnaire de promesse vide
//   - .catch(() => {})              idem en fleche
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RACINE = new URL('../..', import.meta.url).pathname;
const IGNORES = new Set(['node_modules', '.git', 'backups', 'test-results', 'playwright-report']);

function fichiers(dir) {
  const out = [];
  for (const nom of readdirSync(dir)) {
    if (IGNORES.has(nom)) continue;
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(js|mjs|html)$/.test(nom)) out.push(p);
  }
  return out;
}

// Retire les commentaires /* ... */ et // ... (approximation suffisante pour ce code) afin
// qu'un catch qui ne contient QU'UN commentaire compte comme vide.
function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

const MOTIFS = [
  /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/g,
  /\.catch\(\s*function\s*\(\s*\w*\s*\)\s*\{\s*\}\s*\)/g,
  /\.catch\(\s*(\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/g,
];

describe('aucun catch vide', () => {
  it('ni dans le JavaScript, ni dans les pages HTML', () => {
    const fautes = [];
    for (const f of fichiers(RACINE)) {
      // Ce test-ci decrit les motifs dans ses commentaires : on l'exclut.
      if (f.endsWith('aucun-catch-vide.test.mjs')) continue;
      const src = sansCommentaires(readFileSync(f, 'utf8'));
      for (const m of MOTIFS) {
        for (const x of src.matchAll(m)) {
          const ligne = src.slice(0, x.index).split('\n').length;
          fautes.push(`${relative(RACINE, f)}:${ligne}  ${x[0].replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(fautes).toEqual([]);
  });
});
