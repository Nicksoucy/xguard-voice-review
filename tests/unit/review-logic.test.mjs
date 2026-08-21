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
  it('prononciation : respelling identique au mot -> erreur (bug Hela "grand → grand")', () => {
    // Hela retape "grand" pour "grand" : aucun son fourni -> on refuse au lieu de produire "grand → grand".
    const r = buildCorrection({ category: 'pronunciation', word: 'grand', value: 'grand' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SON/);
  });
  it('prononciation : identité insensible casse/accents/ponctuation -> erreur', () => {
    expect(buildCorrection({ category: 'pronunciation', word: 'Grand', value: 'grand,' }).ok).toBe(false);
  });
  it('prononciation : vrai respelling différent -> passe normalement', () => {
    const r = buildCorrection({ category: 'pronunciation', word: 'grand', value: 'grann' });
    expect(r).toMatchObject({ ok: true, intent: 'pronunciation', correctionNote: 'grand → grann' });
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

describe('gardes lecture-seule / approbation (robustesse 2026-06-25)', () => {
  it('canEditReview : faux seulement quand on regarde un autre reviseur', () => {
    expect(review.canEditReview(null)).toBe(true);
    expect(review.canEditReview('')).toBe(true);
    expect(review.canEditReview('Hela')).toBe(false);
  });
  it('shouldWriteReview : ecrit si PAS lecture seule OU approbation forcee (le bug d’approbation)', () => {
    expect(review.shouldWriteReview(null, false)).toBe(true);
    expect(review.shouldWriteReview(null, true)).toBe(true);
    expect(review.shouldWriteReview('Hela', false)).toBe(false); // autosave bloque en supervision
    expect(review.shouldWriteReview('Hela', true)).toBe(true); // approuver ecrit NOTRE propre record
  });
  it('shouldWarnBeforeUnload : seulement si dirty ET pas en lecture seule', () => {
    expect(review.shouldWarnBeforeUnload(true, null)).toBe(true);
    expect(review.shouldWarnBeforeUnload(true, 'Hela')).toBe(false);
    expect(review.shouldWarnBeforeUnload(false, null)).toBe(false);
  });
  it('approvedToPersist : approbation sticky (une autosave ne dés-approuve PAS)', () => {
    expect(review.approvedToPersist(true, false)).toBe(true); // approbation explicite
    expect(review.approvedToPersist(false, true)).toBe(true); // autosave APRES approbation -> reste approuve
    expect(review.approvedToPersist(false, false)).toBe(false); // jamais approuve
    expect(review.approvedToPersist(true, true)).toBe(true);
  });
});

describe('ecoute d’une phrase (segment)', () => {
  it('segmentShouldStop : vrai a la fin de la plage (marge 0.02)', () => {
    expect(review.segmentShouldStop(5.0, { start: 2, end: 5 })).toBe(true);
    expect(review.segmentShouldStop(4.9, { start: 2, end: 5 })).toBe(false);
    expect(review.segmentShouldStop(10, null)).toBe(false);
  });
  it('nextSegmentStop : seekTo clampe a 0, stopAt = fin', () => {
    expect(review.nextSegmentStop({ start: -0.3, end: 5 })).toEqual({ seekTo: 0, stopAt: 5 });
    expect(review.nextSegmentStop({ start: 2, end: 5 })).toEqual({ seekTo: 2, stopAt: 5 });
    expect(review.nextSegmentStop(null)).toBe(null);
  });
});

describe('filtre / lecture (logique extraite de player.js)', () => {
  const W = buildWords();
  it('currentSentenceAt : sentenceIndex du mot joue, -1 avant le debut', () => {
    expect(review.currentSentenceAt(W, -1)).toBe(-1);
    expect(review.currentSentenceAt(W, 0.5)).toBe(0);
    expect(review.currentSentenceAt(W, 3.5)).toBe(1);
    expect(review.currentSentenceAt(W, 30.5)).toBe(2);
    expect(review.currentSentenceAt([], 5)).toBe(-1);
  });
  it('nextRegenStart : debut de la prochaine phrase a revoir >= t', () => {
    const ranges = computeSentenceRanges(W);
    expect(review.nextRegenStart([1, 2], ranges, 0)).toBe(3); // phrase 1 commence a 3
    expect(review.nextRegenStart([2], ranges, 0)).toBe(30); // phrase 2 commence a 30
    expect(review.nextRegenStart([1], ranges, 100)).toBe(null); // aucune apres 100
    expect(review.nextRegenStart(null, ranges, 0)).toBe(null);
  });
  it('countPhrasesToReview : phrases regenerees a flag actif, dedupe, exclut cachees', () => {
    expect(review.countPhrasesToReview([{ sentenceIndex: 1 }], [1])).toBe(1);
    expect(review.countPhrasesToReview([{ sentenceIndex: 1 }, { sentenceIndex: 1 }], [1])).toBe(1);
    expect(review.countPhrasesToReview([{ sentenceIndex: 1, approved_after_regen: true }], [1])).toBe(0);
    expect(review.countPhrasesToReview([{ sentenceIndex: 9 }], [1])).toBe(0);
    expect(review.countPhrasesToReview([{ sentenceIndex: 1 }], null)).toBe(0);
  });
});

describe('backup local (anti-perte)', () => {
  it('shouldWriteBackup : seulement si dirty + lecon + pas lecture seule (anti faux-prompt)', () => {
    expect(review.shouldWriteBackup(true, { lesson_key: 'x' }, null)).toBe(true);
    expect(review.shouldWriteBackup(false, { lesson_key: 'x' }, null)).toBe(false); // rien de non sauvegarde
    expect(review.shouldWriteBackup(true, null, null)).toBe(false); // pas de lecon
    expect(review.shouldWriteBackup(true, { lesson_key: 'x' }, 'Hela')).toBe(false); // lecture seule
  });
  it('buildBackupKey : cle par lecon ET par reviseur', () => {
    expect(review.buildBackupKey('cours/m1/l1', 'Hela')).toBe('vrbak:cours/m1/l1:Hela');
    expect(review.buildBackupKey('cours/m1/l1', 'Nicolas')).not.toBe(
      review.buildBackupKey('cours/m1/l1', 'Hela'),
    );
    expect(review.buildBackupKey(null, null)).toBe('vrbak:?:Anonyme');
  });
  it('shouldRestoreBackup : restaure si backup strictement plus recent (marge 2s)', () => {
    const server = '2026-06-25T14:00:00Z';
    const serverMs = Date.parse(server);
    expect(review.shouldRestoreBackup(serverMs + 5000, server)).toBe(true);
    expect(review.shouldRestoreBackup(serverMs + 1000, server)).toBe(false); // dans la marge -> serveur
    expect(review.shouldRestoreBackup(serverMs - 10000, server)).toBe(false);
    expect(review.shouldRestoreBackup(serverMs + 5000, null)).toBe(true); // pas de serveur -> restaure
    expect(review.shouldRestoreBackup(0, server)).toBe(false); // pas de backup
  });
});

// ── Audit 2026-07-02 : mot nu + statuts du crayon ─────────────────────
describe('buildCorrection — mot nu (ponctuation collee des timestamps)', () => {
  it('retire la ponctuation collee au mot flagge ("répandue." -> note propre)', () => {
    // Cas reel Hela 2026-06-30 : la note "répandue. → rependue" etait introuvable
    // dans la source a cause du point colle -> 5 tentatives puis abandon.
    const r = review.buildCorrection({ category: 'typo', word: 'répandue.', value: 'rependue' });
    expect(r.ok).toBe(true);
    expect(r.correctionNote).toBe('répandue → rependue');
  });
  it('refuse un typo identique au mot une fois nettoye (rien a corriger)', () => {
    const r = review.buildCorrection({ category: 'typo', word: 'répandue.', value: 'répandue' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('déjà');
  });
  it('nettoie aussi guillemets et parentheses aux bords', () => {
    const r = review.buildCorrection({ category: 'typo', word: '«cotes»', value: 'cotés' });
    expect(r.ok).toBe(true);
    expect(r.correctionNote).toBe('cotes → cotés');
  });
});

describe('sentenceFlagStatusLabel — boucle de feedback du crayon', () => {
  it('applique -> vert avec date', () => {
    const r = review.sentenceFlagStatusLabel({ applied: true, applied_at: '2026-07-02T10:00:00Z' });
    expect(r.c).toBe('done');
    expect(r.t).toContain('✅');
  });
  it('skipped -> orange avec la raison', () => {
    const r = review.sentenceFlagStatusLabel({ applied: false, auto_status: 'skipped', skip_reason: 'phrase introuvable' });
    expect(r.c).toBe('error');
    expect(r.t).toContain('phrase introuvable');
  });
  it('en file (auto_status null) -> en traitement', () => {
    const r = review.sentenceFlagStatusLabel({ applied: false, auto_status: null });
    expect(r.c).toBe('pending');
  });
  it('converted -> re-roll voix', () => {
    const r = review.sentenceFlagStatusLabel({ applied: false, auto_status: 'converted' });
    expect(r.t).toContain('re-roll');
  });
});

describe('correctionStatusLabel — doublon', () => {
  // 2026-08-21 : la dedup fermait les doublons en 'done', donc affiches « ✅ Corrige »
  // alors que rien n'avait ete fait pour eux. Si l'originale mourait ensuite en
  // needs_review, les deux etaient perdues et l'ecran annoncait un succes.
  it('un doublon ne s affiche PAS comme corrige', () => {
    const l = correctionStatusLabel({ status: 'superseded' });
    expect(l.t).toContain('Doublon');
    expect(l.t).not.toContain('Corrigé');
    expect(l.c).toBe('pending');
  });

  it('un vrai done reste « corrige »', () => {
    expect(correctionStatusLabel({ status: 'done' }).t).toContain('Corrigé');
  });
});
