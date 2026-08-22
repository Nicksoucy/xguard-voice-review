/**
 * tests/unit/workflows-valides.test.mjs
 *
 * INCIDENT (2026-07-02 → 2026-08-22, sept semaines). deploy-prod.yml avait une YAML
 * invalide : les lignes du corps de commentaire etaient ecrites colonne 1, donc HORS du
 * bloc `run: |`. GitHub Actions ne pouvait pas demarrer le workflow — chaque push
 * produisait un `startup_failure`, un ✗ rouge en 0 seconde, sans aucun journal a lire.
 * 10 push sur 10. Personne ne l'a vu, parce qu'un ✗ rouge permanent devient du decor.
 *
 * Rien ne validait ces fichiers. C'est la vraie cause des sept semaines, pas la faute
 * de frappe. Ce test coute 20 ms.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOSSIER = path.join(RACINE, '.github/workflows');
const fichiers = fs.readdirSync(DOSSIER).filter((f) => /\.ya?ml$/.test(f));

describe('workflows GitHub Actions', () => {
  it('il y a bien des workflows a verifier', () => {
    expect(fichiers.length).toBeGreaterThan(0);
  });

  for (const f of fichiers) {
    describe(f, () => {
      const brut = fs.readFileSync(path.join(DOSSIER, f), 'utf8');
      let doc;

      it('est une YAML valide', () => {
        // C'est LE test qui manquait. Sans lui, GitHub echoue au demarrage et le seul
        // symptome est un ✗ rouge sans journal.
        expect(() => { doc = yaml.load(brut); }).not.toThrow();
      });

      it('a un nom, un declencheur et au moins un job', () => {
        doc = doc || yaml.load(brut);
        expect(doc.name, 'clé `name` manquante').toBeTruthy();
        // `on` est interprete comme le booleen true par YAML 1.1 — les deux formes valent.
        const decl = doc.on !== undefined ? doc.on : doc[true];
        expect(decl, 'clé `on` manquante').toBeTruthy();
        expect(Object.keys(doc.jobs || {}).length, 'aucun job').toBeGreaterThan(0);
      });

      it('chaque job declare runs-on et des steps', () => {
        doc = doc || yaml.load(brut);
        for (const [nom, job] of Object.entries(doc.jobs || {})) {
          expect(job['runs-on'], `${nom} : runs-on manquant`).toBeTruthy();
          expect(Array.isArray(job.steps), `${nom} : steps manquants`).toBe(true);
          expect(job.steps.length, `${nom} : aucune etape`).toBeGreaterThan(0);
        }
      });

      // Le piege exact qui a casse deploy-prod : une ligne collee a la colonne 0 au
      // milieu du fichier. En YAML c'est une nouvelle cle de premier niveau — donc soit
      // le parsing casse, soit on obtient silencieusement autre chose que ce qu'on croit.
      it("n'a pas de ligne parasite collee a la marge", () => {
        const lignes = brut.split('\n');
        const CLES_RACINE = /^(name|on|jobs|env|defaults|permissions|concurrency|run-name)\s*:/;
        const parasites = [];
        lignes.forEach((l, i) => {
          if (i === 0 || !l.trim()) return;
          if (l.startsWith(' ') || l.startsWith('#') || l.startsWith('-')) return;
          if (CLES_RACINE.test(l)) return;
          parasites.push(`ligne ${i + 1} : ${l.slice(0, 70)}`);
        });
        expect(parasites, `lignes hors indentation :\n${parasites.join('\n')}`).toEqual([]);
      });
    });
  }
});
