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
  voiceDoneCount,
  sumStages,
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
  const ago = (min) => new Date(base - min * 60000).toISOString();

  it('cache le bandeau si battement recent', () => {
    expect(healthState({ last_heartbeat: ago(5), status: 'alive' }, base, 0).show).toBe(false);
  });
  it('idle (gris) si > 15 min sans battement mais rien en attente', () => {
    const st = healthState(
      { last_heartbeat: ago(30), status: 'alive', next_jobs: { pending: 0 } },
      base,
      0,
    );
    expect(st.show).toBe(true);
    expect(st.level).toBe('idle');
  });
  it('alert (rouge) si > 15 min ET corrections en attente (fetch frais)', () => {
    const st = healthState(
      { last_heartbeat: ago(30), status: 'alive', next_jobs: { pending: 0 } },
      base,
      2,
    );
    expect(st.level).toBe('alert');
    expect(st.pending).toBe(2);
  });
  it('alert si le dernier run du worker comptait du pending (max des deux)', () => {
    const st = healthState(
      { last_heartbeat: ago(30), status: 'alive', next_jobs: { pending: 3 } },
      base,
      0,
    );
    expect(st.level).toBe('alert');
    expect(st.pending).toBe(3);
  });
  it('error (rouge) si statut error meme avec battement recent', () => {
    const st = healthState({ last_heartbeat: ago(1), status: 'error' }, base, 0);
    expect(st.show).toBe(true);
    expect(st.level).toBe('error');
  });
  it('cache si pas de heartbeat du tout', () => {
    expect(healthState(null, base, 0).show).toBe(false);
    expect(healthState({}, base, 0).show).toBe(false);
  });
});

// ── Audit 2026-07-02 : sante PAR MACHINE (fin de l'ecrasement mutuel) ──
describe('machinesState', () => {
  const NOW = Date.parse('2026-07-02T12:00:00Z');
  const beat = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

  it('une puce par machine, la ligne legacy (sans @) est ignoree', () => {
    const r = cockpit.machinesState(
      [
        { id: 'xguard-correction', status: 'alive', last_heartbeat: beat(1), version: 'aaa' },
        { id: 'xguard-correction@MAC', status: 'alive', last_heartbeat: beat(1), version: 'aaa' },
        { id: 'xguard-correction@NITRO', status: 'alive', last_heartbeat: beat(2), version: 'aaa' },
      ],
      NOW,
      0,
    );
    expect(r.machines.length).toBe(2);
    expect(r.machines.every((m) => m.level === 'ok')).toBe(true);
  });

  it('stale-version -> error (machine au code perime)', () => {
    const r = cockpit.machinesState(
      [{ id: 'xguard-correction@NITRO', status: 'stale-version', last_heartbeat: beat(1), version: 'vieux' }],
      NOW,
      0,
    );
    expect(r.machines[0].level).toBe('error');
  });

  it('silencieuse >30 min AVEC du travail en attente -> alert ; sans travail -> idle', () => {
    const rows = [{ id: 'xguard-correction@MAC', status: 'alive', last_heartbeat: beat(45), version: 'aaa' }];
    expect(cockpit.machinesState(rows, NOW, 3).machines[0].level).toBe('alert');
    expect(cockpit.machinesState(rows, NOW, 0).machines[0].level).toBe('idle');
  });

  it('version divergente entre machines vivantes -> perimee (error)', () => {
    const r = cockpit.machinesState(
      [
        { id: 'xguard-correction@MAC', status: 'alive', last_heartbeat: beat(1), version: 'neuf' },
        { id: 'xguard-correction@NITRO', status: 'alive', last_heartbeat: beat(5), version: 'vieux' },
      ],
      NOW,
      0,
    );
    const nitro = r.machines.find((m) => m.host === 'NITRO');
    expect(nitro.staleVersion).toBe(true);
    expect(nitro.level).toBe('error');
  });
});

// Le compteur « Voix » etait code en dur a t/t (cockpit.js:266 et :397) : toujours
// 100 %, quel que soit le nombre de lecons en attente. Hela voyait « Voix 17/17 »
// juste au-dessus d'un badge « 1 a faire ». Ces tests verrouillent le vrai calcul.
describe('voiceDoneCount — le compteur qui mentait', () => {
  it('retire les lecons en revue de voix et celles a re-ecouter', () => {
    expect(voiceDoneCount({ voice_review: 0, voice_recheck: 1, video_review: 0, done: 16 })).toBe(16);
    expect(voiceDoneCount({ voice_review: 2, voice_recheck: 1, video_review: 0, done: 21 })).toBe(21);
  });

  it('vaut le total quand toutes les voix sont reglees', () => {
    const s = { voice_review: 0, voice_recheck: 0, video_review: 3, done: 5 };
    expect(voiceDoneCount(s)).toBe(sumStages(s));
  });

  it('le cas exact du blocage : 17 lecons, 1 a re-ecouter -> 16, pas 17', () => {
    const s = { voice_review: 0, voice_recheck: 1, video_review: 0, done: 16 };
    expect(sumStages(s)).toBe(17);
    expect(voiceDoneCount(s)).toBe(16);
  });
});
