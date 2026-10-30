// Atelier du son — ce que Rawen voit apres un choix (plainte du 2026-10-30).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../../lib/studio-logic.js');

describe('estVersionOrigine — le mot tel quel n est pas un choix', () => {
  it('redescend -> redescend (choisi 4 fois le 10-26, « identite from = to »)', () => {
    expect(S.estVersionOrigine('redescend', 'redescend')).toBe(true);
    expect(S.estVersionOrigine('**redescend.**', 'Redescend')).toBe(true);
  });
  it('un accent est un vrai choix : Ton -> Tôn', () => {
    expect(S.estVersionOrigine('Ton', 'Tôn')).toBe(false);
  });
});

describe('rangerVersions — la reference d abord, la phrase en premier', () => {
  const v = [
    { id: 1, spelling: 'redescend', kind: 'graphie' },
    { id: 2, spelling: 'reudéssan', kind: 'graphie' },
    { id: 3, spelling: 'redescend', kind: 'phrase' },
    { id: 4, spelling: 'reudéssan', kind: 'phrase' },
  ];
  it('phrase avant mot seul, version d origine marquee', () => {
    const r = S.rangerVersions('redescend', v);
    expect(r.map((x) => x.v.id)).toEqual([3, 4, 1, 2]);
    expect(r.filter((x) => x.origine).map((x) => x.v.id)).toEqual([3, 1]);
  });
});

describe('etatDecision — le statut suit la VOIX, pas seulement le dico', () => {
  it('regle posee, voix en cours : on continue de sonder', () => {
    const e = S.etatDecision({ status: 'applied', note: '« redescend » se dira « reudéssan » partout.', regen_status: 'running' });
    expect(e.t).toMatch(/en cours de régénération/);
    expect(e.fini).toBe(false);
  });
  it('voix refaite : heure de Montreal et lien de reecoute', () => {
    const e = S.etatDecision({ status: 'applied', note: 'x', regen_status: 'done', regen_done_at: '2026-10-26T14:49:40Z' });
    expect(e.t).toMatch(/Voix refaite à 10:49/);
    expect(e.reecouter).toBe(true);
    expect(e.fini).toBe(true);
  });
  it('voix approuvee (forward-only) : dit pourquoi elle n est pas refaite', () => {
    const e = S.etatDecision({ status: 'applied', note: 'x', regen_status: 'skipped', regen_note: 'la voix de cette lecon est deja approuvee' });
    expect(e.t).toMatch(/Voix pas refaite : la voix de cette lecon est deja approuvee/);
    expect(e.c).toBe('warn');
  });
  it('ancien worker (sans migration 024) : la note fait foi', () => {
    const e = S.etatDecision({ status: 'applied', note: 'Regle... Voix de la lecon refaite a 10:49 : tu peux reecouter.' });
    expect(e.fini).toBe(true);
    expect(e.reecouter).toBe(true);
  });
  it('refus : la raison en francais, plus « identite from = to »', () => {
    const e = S.etatDecision({ status: 'rejected', note: 'Tu as choisi « redescend » tel quel : c est le son d aujourd hui' });
    expect(e.t).toMatch(/^⛔ Pas appliqué : Tu as choisi/);
  });
  it('en attente du worker', () => {
    expect(S.etatDecision({ status: 'pending' }).fini).toBe(false);
  });
});
