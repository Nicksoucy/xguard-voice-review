import { describe, it, expect } from 'vitest';
import review from '../../lib/review-logic.js';
import fmt from '../../lib/format-utils.js';

const {
  isResolved,
  isApproved,
  isAutoResolved,
  isHidden,
  getCtx,
  getGroupCtx,
  buildCorrection,
  rerollAllowed,
  findGroupLeader,
  findClosestFlag,
  correctionStatusLabel,
  pickBestTimestamps,
  computeSentenceRanges,
} = review;

// Mots : phrase 0 (idx 0-2), phrase 1 longue (idx 3-22 = 20 mots), phrase 2 (idx 23).
function buildWords() {
  const W = [
    { word: 'A0', sentenceIndex: 0, start: 0, end: 1 },
    { word: 'A1', sentenceIndex: 0, start: 1, end: 2 },
    { word: 'A2', sentenceIndex: 0, start: 2, end: 3 },
  ];
  for (let k = 0; k < 20; k++)
    W.push({ word: 'B' + k, sentenceIndex: 1, start: 3 + k, end: 4 + k });
  W.push({ word: 'C0', sentenceIndex: 2, start: 30, end: 31 });
  return W;
}

describe('predicats de flag', () => {
  it('isResolved : vrai si phrase regeneree et pas reflaggee', () => {
    expect(isResolved({ sentenceIndex: 5 }, [5, 7])).toBe(true);
    expect(isResolved({ sentenceIndex: 5, reflagged: true }, [5])).toBe(false);
    expect(isResolved({ sentenceIndex: 9 }, [5, 7])).toBe(false);
    expect(isResolved({ sentenceIndex: 5 }, null)).toBe(false);
  });
  it('isApproved / isAutoResolved / isHidden', () => {
    expect(isApproved({ approved_after_regen: true })).toBe(true);
    expect(isAutoResolved({ auto_resolved: true })).toBe(true);
    expect(isHidden({ approved_after_regen: true })).toBe(true);
    expect(isHidden({ auto_resolved: true })).toBe(true);
    expect(isHidden({})).toBe(false);
  });
});

describe('getCtx', () => {
  const W = buildWords();
  it('met le mot cible en gras', () => {
    expect(getCtx(W, 0)).toContain('**A0**');
  });
  it('ne deborde jamais sur une autre phrase', () => {
    // idx 3 = premier mot de la phrase 1 : ne doit pas inclure A2 (phrase 0)
    expect(getCtx(W, 3)).not.toContain('A2');
    // idx 22 = dernier mot de la phrase 1 : ne doit pas inclure C0 (phrase 2)
    expect(getCtx(W, 22)).not.toContain('C0');
  });
  it('tronque avec ... quand la phrase est longue', () => {
    const ctx = getCtx(W, 3); // debut d'une phrase de 20 mots
    expect(ctx.startsWith('**B0**')).toBe(true);
    expect(ctx.endsWith(' ...')).toBe(true);
  });
  it('phrase courte : pas de troncature', () => {
    expect(getCtx(W, 1)).toBe('A0 **A1** A2');
  });
});

describe('getGroupCtx', () => {
  const W = buildWords();
  it("marque un sous-groupe contigu d'une seule paire **", () => {
    const ctx = getGroupCtx(W, [4, 5, 6]); // B1 B2 B3
    expect(ctx).toContain('**B1 B2 B3**');
  });
  it('separe les sous-groupes non-contigus par ...', () => {
    const ctx = getGroupCtx(W, [4, 18]); // B1 ... B15
    expect(ctx).toContain('...');
    expect(ctx).toContain('**B1**');
    expect(ctx).toContain('**B15**');
  });
});

describe('findGroupLeader / findClosestFlag', () => {
  const W = buildWords();
  const flags = new Map([
    [4, { groupIndices: [4, 5, 6] }],
    [10, {}],
    [12, { approved_after_regen: true }], // cache
  ]);

  it("findGroupLeader trouve le leader d'un membre de groupe", () => {
    expect(findGroupLeader(flags, 5)).toBe(4);
    expect(findGroupLeader(flags, 10)).toBe(10);
    expect(findGroupLeader(flags, 99)).toBe(null);
  });
  it('findClosestFlag ignore les flags caches et reste dans la phrase', () => {
    expect(findClosestFlag(W, flags, 9)).toBe(10); // 10 est le plus proche actif
    // un mot de la phrase 0 n'a aucun flag dans sa phrase
    expect(findClosestFlag(W, flags, 0)).toBe(null);
  });
});

describe('correctionStatusLabel', () => {
  it('mappe les statuts', () => {
    expect(correctionStatusLabel({ status: 'pending' }).c).toBe('pending');
    expect(correctionStatusLabel({ status: 'processing' }).c).toBe('processing');
    expect(correctionStatusLabel({ status: 'needs_review' }).c).toBe('review');
    expect(correctionStatusLabel({ status: 'error' }).c).toBe('error');
    expect(correctionStatusLabel({ status: 'done' }).c).toBe('done');
    expect(correctionStatusLabel({ status: 'inconnu' }).t).toBe('');
  });
});

describe('pickBestTimestamps', () => {
  it('prend le premier candidat valide (avec sentenceIndex 0)', () => {
    const a = [{ sentenceIndex: 0 }, { sentenceIndex: 1 }];
    const res = pickBestTimestamps([[], a, [{ sentenceIndex: 5 }]]);
    expect(res.words).toBe(a);
    expect(res.source).toBe('preview'); // index 1 → preview
  });
  it('source final si trouve en position 2-3', () => {
    const final = [{ sentenceIndex: 0 }];
    expect(pickBestTimestamps([[], [], final]).source).toBe('final');
  });
  it("fallback sur le plus long si aucun n'a sentenceIndex 0", () => {
    const long = [{ sentenceIndex: 3 }, { sentenceIndex: 4 }];
    expect(pickBestTimestamps([[{ sentenceIndex: 9 }], long]).words).toBe(long);
  });
});

describe('buildInfoBar (anti-XSS produced_by)', () => {
  const fmtDate = (x) => String(x);
  const fmtTime = (x) => String(x);

  it("echappe produced_by venant de Supabase (pas d'injection HTML)", () => {
    const VM = { version: 2, produced_by: '<img src=x onerror=alert(1)>' };
    const html = review.buildInfoBar(VM, fmt.esc, fmtDate, fmtTime);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('echappe aussi produced_at (fmtDate peut renvoyer une chaine brute si invalide)', () => {
    const VM = { produced_at: '<script>evil()</script>' };
    const html = review.buildInfoBar(VM, fmt.esc, fmtDate, fmtTime);
    expect(html).not.toContain('<script>');
  });

  it('rend les champs normaux', () => {
    const VM = { version: 1, produced_by: 'ElevenLabs' };
    const html = review.buildInfoBar(VM, fmt.esc, fmtDate, fmtTime);
    expect(html).toContain('Source : <strong>ElevenLabs</strong>');
    expect(html).toContain('Version 1');
  });
});

describe('computeSentenceRanges', () => {
  it('calcule start/end par phrase', () => {
    const W = buildWords();
    const r = computeSentenceRanges(W);
    expect(r[0]).toEqual({ start: 0, end: 3 });
    expect(r[2]).toEqual({ start: 30, end: 31 });
  });
});

describe('buildCorrection (intention explicite)', () => {
  it('faute de frappe : remplacement obligatoire -> intent word', () => {
    const r = buildCorrection({ category: 'typo', word: 'molette', value: 'manette' });
    expect(r).toMatchObject({ ok: true, intent: 'word', correctionNote: 'molette → manette' });
  });
  it('faute de frappe sans remplacement -> erreur, pas d’envoi', () => {
    const r = buildCorrection({ category: 'typo', word: 'molette', value: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it('prononciation : note seule suffit -> intent pronunciation, note = mot seul (jamais de placeholder injectable)', () => {
    const r = buildCorrection({ category: 'pronunciation', word: 'est', value: '', note: 'comme le verbe' });
    expect(r).toMatchObject({ ok: true, intent: 'pronunciation', correctionNote: 'est', reviewerNote: 'comme le verbe' });
    // Régression bug Hela 2026-06-23 : le correction_note ne doit JAMAIS contenir "[prononciation]"
    // (un worker pourrait l'injecter à voix haute). Le mot seul + l'intention suffisent.
    expect(r.correctionNote).not.toContain('[');
  });
  it('prononciation : indice tapé -> mot → indice', () => {
    const r = buildCorrection({ category: 'pronunciation', word: 'CNESST', value: 'C-N-E-S-S-T' });
    expect(r).toMatchObject({ ok: true, intent: 'pronunciation', correctionNote: 'CNESST → C-N-E-S-S-T' });
  });
  it('prononciation sans indice ni note -> erreur', () => {
    expect(buildCorrection({ category: 'pronunciation', word: 'est', value: '', note: '' }).ok).toBe(false);
  });
  it('phrase à réécrire -> redirige vers le modal de phrase', () => {
    expect(buildCorrection({ category: 'rewrite', word: 'x' })).toMatchObject({ ok: false, redirect: 'sentence' });
  });
  it('respecte une flèche déjà tapée', () => {
    const r = buildCorrection({ category: 'typo', word: 'a', value: 'a → à' });
    expect(r.correctionNote).toBe('a → à');
  });
});

describe('rerollAllowed (le re-roll n’avale pas une correction tapée)', () => {
  it('autorisé si rien de tapé', () => {
    expect(rerollAllowed({ value: '', note: '' })).toBe(true);
    expect(rerollAllowed({})).toBe(true);
  });
  it('BLOQUÉ si un remplacement est tapé (bug molette)', () => {
    expect(rerollAllowed({ value: 'manette', note: '' })).toBe(false);
  });
  it('BLOQUÉ si une note est saisie', () => {
    expect(rerollAllowed({ value: '', note: 'comme le verbe' })).toBe(false);
  });
});

// Régression nommée : les deux cas qui ont piégé Nicolas ne doivent plus jamais se reproduire.
describe('RÉGRESSION molette/est (capture de l’intention)', () => {
  it('molette voulu manette = faute de frappe -> change le MOT (jamais un re-roll)', () => {
    const c = buildCorrection({ category: 'typo', word: 'molette', value: 'manette' });
    expect(c.intent).toBe('word');
    expect(c.correctionNote).toBe('molette → manette');
    // et le bouton re-roll refuserait, car du texte est saisi :
    expect(rerollAllowed({ value: 'manette' })).toBe(false);
  });
  it('est mal prononcé sans cible -> prononciation (humain tranche, pas d’invention type "este")', () => {
    const c = buildCorrection({ category: 'pronunciation', word: 'est', value: '', note: 'le verbe' });
    expect(c.intent).toBe('pronunciation');
    expect(c.correctionNote).toBe('est'); // mot seul, jamais "[prononciation] est" (non injectable)
    expect(c.reviewerNote).toBe('le verbe');
  });
});
