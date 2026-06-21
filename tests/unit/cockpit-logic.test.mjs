import { describe, it, expect } from 'vitest';
import cockpit from '../../lib/cockpit-logic.js';
import { COURSES, LESSONS, LMS, AUDIO_STAGES, VIDEO_STAGES } from '../fixtures/cockpit.mjs';

const {
  perCourseCounts,
  finishedCourses,
  tabCounts,
  byStage,
  gStatusOf,
  coursePhase,
  healthState,
  lessonName,
} = cockpit;

describe('perCourseCounts', () => {
  const pc = perCourseCounts(COURSES, LESSONS);

  it('compte les lecons produites par etape', () => {
    expect(pc['tireur-actif'].done).toBe(3);
    expect(pc['surete-aeroportuaire'].done).toBe(4);
    expect(pc['communications'].video_production).toBe(5);
    expect(pc['intervention'].voice_review).toBe(2);
    expect(pc['intervention'].done).toBe(3);
  });

  it('range les conteneurs vides (pipeline_stage inconnu) dans not_produced', () => {
    expect(pc['surete-aeroportuaire'].not_produced).toBe(2);
    expect(pc['le-port-uniforme'].not_produced).toBe(1);
    expect(pc['tireur-actif'].not_produced).toBe(0);
  });
});

describe('finishedCourses (regression MET)', () => {
  const pc = perCourseCounts(COURSES, LESSONS);
  const fin = finishedCourses(COURSES, pc).map((c) => c.id);

  it('inclut une formation 100% produite et done', () => {
    expect(fin).toContain('tireur-actif');
  });

  it('inclut MET malgre ses conteneurs vides (le bug corrige)', () => {
    // MET : 4 lecons done + 2 conteneurs vides. L'ancien calcul faisait 4 !== 6 → exclue.
    expect(fin).toContain('surete-aeroportuaire');
  });

  it("exclut un cours qui n'a que des conteneurs vides", () => {
    expect(fin).not.toContain('le-port-uniforme');
  });

  it('exclut les formations encore en production', () => {
    expect(fin).not.toContain('communications');
    expect(fin).not.toContain('intervention');
  });

  it('donne exactement 2 formations finies sur ce jeu', () => {
    expect(fin.length).toBe(2);
  });
});

describe('tabCounts', () => {
  const pc = perCourseCounts(COURSES, LESSONS);
  const c = tabCounts(COURSES, LESSONS, LMS, pc, AUDIO_STAGES, VIDEO_STAGES);

  it('compte les onglets de revision', () => {
    expect(c.audio).toBe(2); // intervention voice_review x2
    expect(c.prod).toBe(5); // communications video_production x5
    expect(c.done).toBe(2); // tireur-actif + MET
  });

  it('GHL = finies pas encore importees/en ligne (tireur-actif est live → exclu)', () => {
    expect(c.ghl).toBe(1); // seulement MET reste a importer
  });
});

describe('byStage', () => {
  it('regroupe et trie par etape', () => {
    const m = byStage(LESSONS);
    expect(m.done.length).toBe(3 + 4 + 3); // tireur + MET + intervention
    expect(m.video_production.length).toBe(5);
    expect(m.voice_review.length).toBe(2);
  });
});

describe('gStatusOf', () => {
  it('mappe les statuts GHL', () => {
    expect(gStatusOf(null).key).toBe('pret');
    expect(gStatusOf({ status: 'exported' }).key).toBe('exported');
    expect(gStatusOf({ status: 'imported' }).key).toBe('imported');
    expect(gStatusOf({ status: 'live' }).key).toBe('live');
    expect(gStatusOf({ status: 'bidon' }).key).toBe('pret');
  });
});

describe('coursePhase', () => {
  it('Pret LMS quand tout est done', () => {
    expect(coursePhase({ done: 4, voice_review: 0, voice_recheck: 0 }).cls).toBe('ready');
  });
  it('Phase video quand voix finie mais video pas done', () => {
    expect(
      coursePhase({ video_production: 5, done: 0, voice_review: 0, voice_recheck: 0 }).cls,
    ).toBe('video');
  });
  it('Phase voix quand il reste de la voix a reviser', () => {
    expect(coursePhase({ voice_review: 2, done: 3, voice_recheck: 0 }).cls).toBe('voice');
  });
});

describe('lessonName (anti-crash null lesson_key)', () => {
  it('prefere short_title puis title', () => {
    expect(lessonName({ short_title: 'Court', title: 'Long' })).toBe('Court');
    expect(lessonName({ title: 'Long' })).toBe('Long');
  });
  it('derive du lesson_key sinon', () => {
    expect(lessonName({ lesson_key: 'cours/m1/03-intro' })).toBe('03-intro');
  });
  it('ne plante pas si lesson_key est null/absent', () => {
    expect(lessonName({ lesson_key: null })).toBe('?');
    expect(lessonName({})).toBe('?');
  });
});

describe('healthState', () => {
  const base = new Date('2026-06-21T12:00:00Z').getTime();

  it('cache le bandeau si battement recent', () => {
    const h = { last_heartbeat: new Date(base - 5 * 60000).toISOString(), status: 'ok' };
    expect(healthState(h, base).show).toBe(false);
  });
  it('affiche le bandeau si > 15 min sans battement', () => {
    const h = {
      last_heartbeat: new Date(base - 30 * 60000).toISOString(),
      status: 'ok',
      next_jobs: { pending: 3 },
    };
    const st = healthState(h, base);
    expect(st.show).toBe(true);
    expect(st.pending).toBe(3);
  });
  it('affiche le bandeau si statut error meme avec battement recent', () => {
    const h = { last_heartbeat: new Date(base - 1 * 60000).toISOString(), status: 'error' };
    expect(healthState(h, base).show).toBe(true);
  });
  it('cache si pas de heartbeat du tout', () => {
    expect(healthState(null, base).show).toBe(false);
    expect(healthState({}, base).show).toBe(false);
  });
});
