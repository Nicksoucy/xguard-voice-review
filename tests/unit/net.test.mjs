// Logique pure de lib/net.js (chantier 03) : quand reessayer, quoi dire, etat d'un robot.
import { describe, it, expect } from 'vitest';
import net from '../../lib/net.js';

const { estReessayable, delaiReessai, messageErreur, ageEnMots, etatRobot } = net;

describe('estReessayable', () => {
  it('reessaie le reseau coupe, 408, 429 et les 5xx', () => {
    for (const s of [0, 408, 429, 500, 502, 503, 522]) expect(estReessayable(s)).toBe(true);
  });
  it('ne reessaie jamais une demande refusee (4xx)', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(estReessayable(s)).toBe(false);
  });
});

describe('delaiReessai', () => {
  it('1,5 s, 4 s puis 8 s plafonne', () => {
    expect(delaiReessai(1)).toBe(1500);
    expect(delaiReessai(2)).toBe(4000);
    expect(delaiReessai(3)).toBe(8000);
    expect(delaiReessai(9)).toBe(8000);
  });
});

describe('messageErreur', () => {
  it('reseau coupe : parle de connexion', () => {
    expect(messageErreur('approuver la leçon', { status: 0 })).toMatch(/^Pas pu approuver la leçon : pas de connexion/);
  });
  it('erreur serveur : donne le code', () => {
    expect(messageErreur('charger la leçon', { status: 503 })).toMatch(/code 503/);
  });
});

describe('ageEnMots', () => {
  it('minutes, heures, jours', () => {
    expect(ageEnMots(0.2)).toMatch(/moins d’une minute/);
    expect(ageEnMots(7)).toBe('il y a 7 min');
    expect(ageEnMots(180)).toBe('il y a 3 h');
    expect(ageEnMots(60 * 72)).toBe('il y a 3 jours');
  });
});

describe('etatRobot', () => {
  const now = Date.parse('2026-11-10T14:00:00Z');
  const rows = [
    { id: 'xguard-correction@mac', last_heartbeat: '2026-11-10T13:58:00Z' },
    { id: 'xguard-correction@nitro', last_heartbeat: '2026-11-10T10:00:00Z' },
    { id: 'xguard-studio@mac', last_heartbeat: '2026-11-10T13:59:30Z' },
  ];
  it('prend le battement le plus recent du prefixe', () => {
    const e = etatRobot(rows, 'xguard-correction', now, 15);
    expect(e.connu).toBe(true);
    expect(e.vivant).toBe(true);
    expect(Math.round(e.ageMin)).toBe(2);
  });
  it('muet au-dela du seuil', () => {
    const e = etatRobot([rows[1]], 'xguard-correction', now, 15);
    expect(e.vivant).toBe(false);
    expect(e.age).toBe('il y a 4 h');
  });
  it('inconnu sans battement', () => {
    expect(etatRobot([], 'xguard-correction', now).connu).toBe(false);
    expect(etatRobot(null, 'x', now).connu).toBe(false);
  });
});
