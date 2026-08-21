// Le LABEL d'un flag de prononciation (« mot → graphie ») ne doit JAMAIS partir tel quel
// dans le champ « Mot a tester » de l'atelier du son.
//
// INCIDENT (19-20 aout 2026). lib/review-logic.js fabrique le libelle « inspecté → inspecter ».
// studio.js le recopiait tel quel dans le formulaire ; le worker generait alors un mp3 de la
// chaine complete, Hela l'ecoutait, choisissait — et checkDictRule refusait la decision
// (« contient une fleche — c'est le LABEL d'un flag, pas un mot du script »). Quatre rejets
// sur ce seul motif, et Hela a redepose « inspecte » quatre fois avant que ca passe.
//
// studio.js n'est pas un module importable (script de page). On extrait donc la fonction
// de la source et on l'evalue — meme approche que handlers-exist.test.mjs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(ROOT, 'studio.js'), 'utf8');

const bloc = src.match(/var FLECHE = [\s\S]*?\n\}/);
if (!bloc) throw new Error('decouperLabelFlag introuvable dans studio.js');
const decouperLabelFlag = new Function(`${bloc[0]}; return decouperLabelFlag;`)();

describe('decouperLabelFlag', () => {
  it('separe le mot de la graphie sur une fleche unicode', () => {
    expect(decouperLabelFlag('inspecté → inspecter')).toEqual({ mot: 'inspecté', graphie: 'inspecter' });
  });

  it('accepte les autres formes de fleche', () => {
    for (const f of ['->', '=>', '⇒']) {
      expect(decouperLabelFlag(`Durant ${f} duron`)).toEqual({ mot: 'Durant', graphie: 'duron' });
    }
  });

  it('laisse un mot simple intact', () => {
    expect(decouperLabelFlag('tableau')).toEqual({ mot: 'tableau', graphie: '' });
  });

  it('tolere l absence d espaces autour de la fleche', () => {
    expect(decouperLabelFlag('fils→fil')).toEqual({ mot: 'fils', graphie: 'fil' });
  });

  it('ne rend jamais un mot contenant une fleche', () => {
    for (const s of ['a → b', 'a->b', 'a ⇒ b', 'x => y', '', null, undefined]) {
      expect(decouperLabelFlag(s).mot).not.toMatch(/→|⇒|->|=>/);
    }
  });
});

describe('cablage dans studio.js', () => {
  it('prefill passe par decouperLabelFlag avant de remplir le champ', () => {
    const fn = src.match(/function prefill\([\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/decouperLabelFlag\(/);
    // le champ ne recoit jamais l'argument brut
    expect(fn).not.toMatch(/\$\('word'\)\.value\s*=\s*word\s*;/);
  });

  it('le bouton « Tester » de la file envoie le mot seul, pas le libelle', () => {
    const fn = src.match(/function loadFlagged\([\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/decouperLabelFlag\(note\)/);
    expect(fn).toMatch(/prefill\('\+JSON\.stringify\(d\.mot\)/);
  });

  it('le parametre ?word= de l URL est filtre aussi', () => {
    const init = src.match(/\(function init\(\)[\s\S]*?\n\}\)\(\);/)[0];
    expect(init).toMatch(/decouperLabelFlag\(q \|\| ''\)/);
  });
});
