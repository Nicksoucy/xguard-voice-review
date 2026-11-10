#!/usr/bin/env node
/**
 * scripts/bump-cache.mjs — Met le hash du commit dans TOUS les ?v= des pages (correctif 14,
 * chantier 03, 2026-11-10). A lancer juste avant chaque push sur gh-pages.
 *
 * POURQUOI. Le navigateur de la reviseuse garde les .js et .css en cache tant que leur
 * adresse ne change pas. Les ?v=AAAAMMJJx etaient changes a la main, donc oublies :
 * cockpit.js modifie le 27 octobre etait encore reference ?v=20260829a, et Rawen pouvait
 * tourner sur l'ancien code sans que personne le sache. Ici, chaque deploiement donne une
 * adresse neuve a tous les fichiers locaux, sans rien oublier.
 * (Le chantier 08 remplacera ce script par une vraie chaine de livraison.)
 *
 * Usage :
 *   git commit ...                      # d'abord le code
 *   node scripts/bump-cache.mjs         # puis les ?v= = hash court de HEAD
 *   git commit -am "Cache : ?v=<hash>" && git push origin gh-pages
 *   node scripts/bump-cache.mjs --dry   # montre ce qui changerait, sans ecrire
 *
 * Sort en erreur (code 1) si l'arbre git a des changements non commites dans les fichiers
 * servis : le hash ne decrirait pas ce qui part en production.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry');
const IGNORES = new Set(['node_modules', '.git', 'backups', 'test-results', 'playwright-report', 'tests']);

// Pages HTML servies (racine, en/, lms/...).
export function pagesHtml(dir = RACINE) {
  const out = [];
  for (const nom of readdirSync(dir)) {
    if (IGNORES.has(nom)) continue;
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) out.push(...pagesHtml(p));
    else if (nom.endsWith('.html')) out.push(p);
  }
  return out;
}

// Remplace (ou ajoute) ?v= sur chaque src/href LOCAL vers un .js ou un .css.
// Les adresses externes (https://, //cdn) ne sont jamais touchees.
export function versionner(html, version) {
  return html.replace(/\b(src|href)="([^"]+?\.(?:js|css))(\?v=[^"]*)?"/g, (tout, attr, chemin) => {
    if (/^(https?:)?\/\//i.test(chemin)) return tout;
    return `${attr}="${chemin}?v=${version}"`;
  });
}

function principal() {
  const git = (...a) => execFileSync('git', a, { cwd: RACINE, encoding: 'utf8' }).trim();
  const sale = git('status', '--porcelain', '--', '*.html', '*.js', '*.css')
    .split('\n')
    .filter((l) => l && !l.includes('scripts/bump-cache.mjs') && !/^\?\? /.test(l));
  if (sale.length && !DRY) {
    console.error('✗ Des fichiers servis ont des changements non commites — committe d\'abord :');
    for (const l of sale) console.error('   ' + l);
    process.exit(1);
  }
  const version = git('rev-parse', '--short', 'HEAD');
  let n = 0;
  for (const f of pagesHtml()) {
    const avant = readFileSync(f, 'utf8');
    const apres = versionner(avant, version);
    if (apres !== avant) {
      n++;
      console.log((DRY ? '[dry] ' : '') + relative(RACINE, f));
      if (!DRY) writeFileSync(f, apres);
    }
  }
  console.log(`${n} page(s) ${DRY ? 'a mettre' : 'mises'} a ?v=${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
