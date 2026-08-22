/**
 * tests/unit/journal-logic.test.mjs
 *
 * Le Journal existe pour repondre a UNE question : « qu'est-ce qui est mort, et
 * pourquoi ». Les tests portent donc surtout la-dessus — et sur le fait qu'on ne dise
 * jamais « corrigee » quand ca ne l'est pas.
 */
import { describe, it, expect } from 'vitest';
import J from '../../lib/journal-logic.js';

const flag = (o) => Object.assign({ id: 1, lesson_key: 'cours/module-01/01-lecon', created_at: '2026-08-21T12:00:00Z', reviewer_name: 'Héla' }, o);
const dem = (o) => Object.assign({ id: 'abcdef12-0000', lesson_key: 'cours/module-01/01-lecon', created_at: '2026-08-21T12:00:00Z', requested_by: 'Héla' }, o);
const dec = (o) => Object.assign({ id: 'ffff1111-0000', created_at: '2026-08-21T12:00:00Z', decided_by: 'Héla' }, o);

describe('crayon (sentence_flags)', () => {
  it('un flag applique est ABOUTI et n affiche pas de raison', () => {
    const l = J.duCrayon(flag({ applied: true, skip_reason: 'un reste sans interet' }));
    expect(l.categorie).toBe(J.ABOUTI);
    expect(l.raison).toBeNull();
  });

  it('un flag skipped est MORT et porte sa raison', () => {
    const l = J.duCrayon(flag({ applied: false, auto_status: 'skipped', skip_reason: 'phrase originale introuvable dans la source (locator)' }));
    expect(l.categorie).toBe(J.MORT);
    expect(l.raison).toContain('introuvable');
  });

  it('dismissed et obsolete sont MORTS aussi', () => {
    expect(J.duCrayon(flag({ applied: false, auto_status: 'dismissed' })).categorie).toBe(J.MORT);
    expect(J.duCrayon(flag({ applied: false, auto_status: 'obsolete' })).categorie).toBe(J.MORT);
  });

  it('converted et superseded sont EN COURS, pas morts', () => {
    expect(J.duCrayon(flag({ applied: false, auto_status: 'converted' })).categorie).toBe(J.EN_COURS);
    expect(J.duCrayon(flag({ applied: false, auto_status: 'superseded' })).categorie).toBe(J.EN_COURS);
  });

  it('sans statut, c est en file', () => {
    expect(J.duCrayon(flag({ applied: false, auto_status: null })).categorie).toBe(J.EN_COURS);
  });
});

describe('demandes (correction_requests)', () => {
  it('done = abouti, needs_review = mort (elle attend Nicolas)', () => {
    expect(J.desDemandes(dem({ status: 'done' })).categorie).toBe(J.ABOUTI);
    const nr = J.desDemandes(dem({ status: 'needs_review', reason: 're-roll refuse : rien n a change' }));
    expect(nr.categorie).toBe(J.MORT);
    expect(nr.raison).toContain('rien n a change');
  });

  it('un doublon n est PAS annonce comme corrige', () => {
    const l = J.desDemandes(dem({ status: 'superseded' }));
    expect(l.categorie).toBe(J.EN_COURS);
    expect(l.etat).not.toMatch(/Corrigée/);
  });

  it('last_error sert de raison quand reason est vide', () => {
    expect(J.desDemandes(dem({ status: 'error', last_error: 'exit=1 regen impossible' })).raison).toContain('exit=1');
  });
});

describe('atelier du son (studio_decisions)', () => {
  it('applied SANS note = abouti', () => {
    const l = J.delAtelier(dec({ status: 'applied', word: 'tableau', spelling: 'tablo' }));
    expect(l.categorie).toBe(J.ABOUTI);
  });

  // LE MENSONGE QU'ON VIENT DE RETIRER : « Applique au dictionnaire » alors que l'audio
  // de la lecon qu'elle venait d'ecouter n'avait pas bouge d'un octet.
  it('applied AVEC note = demi-reussite, pas « corrigée »', () => {
    const l = J.delAtelier(dec({ status: 'applied', word: 'age', note: "Regle ajoutee au dictionnaire — mais l'audio deja en ligne n'a PAS ete refait." }));
    expect(l.categorie).toBe(J.MORT);
    expect(l.etat).toMatch(/audio pas encore refait/);
    expect(l.raison).toContain("n'a PAS ete refait");
  });

  it('needs_source dit d aller corriger le texte', () => {
    const l = J.delAtelier(dec({ status: 'needs_source', word: 'branches', note: 'Pas de regle globale sur ce mot.' }));
    expect(l.categorie).toBe(J.MORT);
    expect(l.etat).toMatch(/dans le texte/);
  });
});

describe('construire / bilan / filtrer', () => {
  const lignes = J.construire(
    [flag({ id: 1, applied: true }), flag({ id: 2, applied: false, auto_status: 'skipped', skip_reason: 'introuvable', created_at: '2026-08-21T15:00:00Z' })],
    [dem({ status: 'needs_review', created_at: '2026-08-21T09:00:00Z' })],
    [dec({ status: 'applied', word: 'x' })],
  );

  it('fusionne les trois circuits, le plus recent d abord', () => {
    expect(lignes.length).toBe(4);
    expect(lignes[0].quand).toBe('2026-08-21T15:00:00Z');
    expect(new Set(lignes.map((l) => l.circuit))).toEqual(new Set(['crayon', 'demande', 'atelier']));
  });

  it('le bilan chiffre ce qui est mort', () => {
    const b = J.bilan(lignes);
    expect(b.total).toBe(4);
    expect(b.abouti).toBe(2);
    expect(b.mort).toBe(2);
    expect(b.pourcentMort).toBe(50);
  });

  it('filtre par categorie', () => {
    expect(J.filtrer(lignes, J.MORT).length).toBe(2);
    expect(J.filtrer(lignes, 'tout').length).toBe(4);
  });

  it('filtre par personne, sans tenir compte de la casse', () => {
    expect(J.filtrer(lignes, 'tout', 'héla').length).toBe(4);
    expect(J.filtrer(lignes, 'tout', 'quelqu un d autre').length).toBe(0);
  });

  it('liste les personnes vues', () => {
    expect(J.personnes(lignes)).toEqual(['Héla']);
  });

  it('ne plante pas sur des entrees vides', () => {
    expect(J.construire(null, null, null)).toEqual([]);
    expect(J.bilan(null).total).toBe(0);
    expect(J.personnes(null)).toEqual([]);
  });
});

describe('bruit technique', () => {
  // Le jargon interne (« re-roll voix demande via correction_requests (intent glitch) »)
  // n'apprend rien a personne : l'etat dit deja ce qui se passe.
  it('converted et superseded n affichent pas leur raison interne', () => {
    expect(J.duCrayon(flag({ applied: false, auto_status: 'converted', skip_reason: 're-roll voix demande via correction_requests (intent glitch)' })).raison).toBeNull();
    expect(J.duCrayon(flag({ applied: false, auto_status: 'superseded', skip_reason: 'remplace par un renvoi avec le texte actuel' })).raison).toBeNull();
  });

  it('mais une ligne MORTE garde toujours sa raison', () => {
    expect(J.duCrayon(flag({ applied: false, auto_status: 'skipped', skip_reason: 'introuvable' })).raison).toBe('introuvable');
    expect(J.duCrayon(flag({ applied: false, auto_status: 'dismissed', skip_reason: 'source deja correcte' })).raison).toBe('source deja correcte');
  });
});
