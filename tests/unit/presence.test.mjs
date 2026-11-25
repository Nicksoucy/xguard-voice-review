// Temps de revue réel (lib/presence.js, 2026-11-25) : quand une minute compte.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../lib/presence.js');
const { tempsRevueParPersonne } = require('../../lib/cockpit-logic.js');

const T = Date.parse('2026-11-25T14:30:40Z');

describe('estActif', () => {
  it('onglet caché = jamais actif, même avec un média', () => {
    expect(P.estActif({ visible: false, mediaEnCours: true, derniereInteraction: T, maintenant: T })).toBe(false);
  });
  it('média qui joue = actif sans geste', () => {
    expect(P.estActif({ visible: true, mediaEnCours: true, derniereInteraction: 0, maintenant: T })).toBe(true);
  });
  it('geste récent = actif ; plus de 2 min sans geste = inactif', () => {
    expect(P.estActif({ visible: true, derniereInteraction: T - 119000, maintenant: T })).toBe(true);
    expect(P.estActif({ visible: true, derniereInteraction: T - 121000, maintenant: T })).toBe(false);
  });
  it('aucun geste depuis l’ouverture = inactif (onglet oublié)', () => {
    expect(P.estActif({ visible: true, derniereInteraction: 0, maintenant: T })).toBe(false);
  });
});

describe('ligneAEnvoyer', () => {
  const actif = { visible: true, derniereInteraction: T, maintenant: T };
  it('une ligne par minute, au début de la minute', () => {
    const l = P.ligneAEnvoyer(actif, ' Rawen ', null, 'voix', 'c/m/l');
    expect(l).toEqual({ reviewer_name: 'Rawen', minute: '2026-11-25T14:30:00.000Z', page: 'voix', lesson_key: 'c/m/l' });
    expect(P.ligneAEnvoyer(actif, 'Rawen', l.minute, 'voix', 'c/m/l')).toBeNull();
  });
  it('sans nom = rien', () => {
    expect(P.ligneAEnvoyer(actif, '  ', null, 'voix', null)).toBeNull();
  });
});

describe('typePage', () => {
  it('sépare voix, vidéo, édition anglaise et cockpit', () => {
    expect(P.typePage('/xguard-voice-review/review.html')).toBe('voix');
    expect(P.typePage('/xguard-voice-review/review-video.html')).toBe('video');
    expect(P.typePage('/xguard-voice-review/en/review.html')).toBe('voice-en');
    expect(P.typePage('/xguard-voice-review/en/review-video.html')).toBe('video-en');
    expect(P.typePage('/xguard-voice-review/')).toBe('cockpit');
    expect(P.typePage('/xguard-voice-review/en/')).toBe('accueil-en');
    expect(P.typePage('/xguard-voice-review/en/index.html')).toBe('accueil-en');
  });
});

describe('tempsRevueParPersonne', () => {
  const rows = [
    { reviewer: 'rawen', reviewer_affiche: 'Rawen', jour: '2026-11-25', minutes_actives: 95, minutes_voix: 60, minutes_video: 30, minutes_autres: 5, debut: 'a', fin: 'b' },
    { reviewer: 'rawen', reviewer_affiche: 'rawen', jour: '2026-11-24', minutes_actives: 300 },
    { reviewer: 'rawen', jour: '2026-11-18', minutes_actives: 999 }, // hors des 7 jours
    { reviewer: 'hela', reviewer_affiche: 'Héla', jour: '2026-11-23', minutes_actives: 40 },
    { reviewer: 'nicolas', jour: '2026-11-25', minutes_actives: 500 },
  ];
  it('aujourd’hui + 7 jours, Nicolas caché, la plus active aujourd’hui d’abord', () => {
    const r = tempsRevueParPersonne(rows, '2026-11-25', ['Nicolas']);
    expect(r.map((p) => p.nom)).toEqual(['Rawen', 'Héla']);
    expect(r[0].aujourdhui.minutes).toBe(95);
    expect(r[0].semaine).toBe(395);
    expect(r[0].joursActifs).toBe(2);
    expect(r[1].aujourdhui).toBeNull();
  });
});

describe('dureeEnMots', () => {
  it('formate en minutes puis en heures', () => {
    expect(P.dureeEnMots(42)).toBe('42 min');
    expect(P.dureeEnMots(60)).toBe('1 h');
    expect(P.dureeEnMots(95)).toBe('1 h 35');
  });
});
