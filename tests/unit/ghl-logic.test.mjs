import { describe, it, expect } from 'vitest';
import ghl from '../../lib/ghl-logic.js';

const {
  videoStorageUrl,
  filterApprovedLessons,
  groupByModule,
  buildCoursePayload,
  validateGhlPayload,
} = ghl;

const SUPA = 'https://ctjsdpfegpsfpwjgusyi.supabase.co';

const COURSE = { id: 'surete-aeroportuaire', title: 'Surete MET', subtitle: 'Formation initiale' };

// 4 lecons : 2 approved (module 1 et 2), 1 non-approved (in_review), 1 conteneur sans statut.
const LESSONS = [
  {
    lesson_key: 'c/m2/02',
    course_id: 'c',
    module_id: 'm2',
    module_index: 2,
    lesson_index: 1,
    status: 'approved',
    title: 'B',
    video_path: 'videos/b.mp4',
  },
  {
    lesson_key: 'c/m1/01',
    course_id: 'c',
    module_id: 'm1',
    module_index: 1,
    lesson_index: 1,
    status: 'approved',
    title: 'A',
    video_path: 'https://cdn/a.mp4',
  },
  {
    lesson_key: 'c/m1/02',
    course_id: 'c',
    module_id: 'm1',
    module_index: 1,
    lesson_index: 2,
    status: 'in_review',
    title: 'PasPrete',
    video_path: 'videos/x.mp4',
  },
  {
    lesson_key: 'c/scaffold',
    course_id: 'c',
    module_id: 'm0',
    module_index: 0,
    status: null,
    title: 'Conteneur',
  },
];

describe('videoStorageUrl', () => {
  it('garde une URL absolue', () => {
    expect(videoStorageUrl(SUPA, 'https://cdn/a.mp4')).toBe('https://cdn/a.mp4');
  });
  it("compose une URL publique a partir d'un chemin relatif", () => {
    expect(videoStorageUrl(SUPA, 'videos/b.mp4')).toBe(
      SUPA + '/storage/v1/object/public/videos/b.mp4',
    );
  });
  it('retourne vide si pas de chemin', () => {
    expect(videoStorageUrl(SUPA, '')).toBe('');
    expect(videoStorageUrl(SUPA, null)).toBe('');
  });
});

describe('filterApprovedLessons (invariant critique GHL)', () => {
  it('ne garde QUE les lecons status=approved', () => {
    const ready = filterApprovedLessons(LESSONS);
    expect(ready.map((l) => l.lesson_key)).toEqual(['c/m2/02', 'c/m1/01']);
  });
});

describe('groupByModule', () => {
  it('regroupe et trie par module_index', () => {
    const mods = groupByModule(filterApprovedLessons(LESSONS));
    expect(mods.map((m) => m.module_id)).toEqual(['m1', 'm2']);
  });
});

describe('buildCoursePayload', () => {
  const payload = buildCoursePayload(COURSE, LESSONS, SUPA, {
    generated_at: '2026-06-21T00:00:00Z',
    generated_by: 'Nicolas',
  });

  it('exclut les lecons non-approved du payload', () => {
    const titles = payload.products[0].categories.flatMap((c) => c.posts.map((p) => p.title));
    expect(titles).toContain('A');
    expect(titles).toContain('B');
    expect(titles).not.toContain('PasPrete');
    expect(titles).not.toContain('Conteneur');
  });

  it('numerote les modules et posts en 1-indexe, tries', () => {
    const cats = payload.products[0].categories;
    expect(cats[0].sequenceNo).toBe(1);
    expect(cats[0].posts[0].sequenceNo).toBe(1);
    expect(cats[0].title).toBe('Module 1');
  });

  it('resout les URL video (absolue + relative)', () => {
    const posts = payload.products[0].categories.flatMap((c) => c.posts);
    const a = posts.find((p) => p.title === 'A');
    const b = posts.find((p) => p.title === 'B');
    expect(a.videoUrl).toBe('https://cdn/a.mp4');
    expect(b.videoUrl).toBe(SUPA + '/storage/v1/object/public/videos/b.mp4');
  });

  it('renseigne la metadata', () => {
    expect(payload._xguard_metadata.total_lessons).toBe(2);
    expect(payload._xguard_metadata.total_modules).toBe(2);
    expect(payload._xguard_metadata.generated_by).toBe('Nicolas');
    expect(payload.locationId).toBeTruthy();
  });

  it('leve une erreur si aucune lecon approved', () => {
    expect(() => buildCoursePayload(COURSE, [{ status: 'in_review' }], SUPA, {})).toThrow(
      /approved/,
    );
  });
});

describe('validateGhlPayload', () => {
  it('valide un payload correct', () => {
    const payload = buildCoursePayload(COURSE, LESSONS, SUPA, {});
    expect(validateGhlPayload(payload).ok).toBe(true);
  });
  it('rejette un payload sans products', () => {
    const r = validateGhlPayload({ locationId: 'x', products: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it('rejette un post sans videoUrl', () => {
    const bad = {
      locationId: 'x',
      products: [
        { title: 'T', categories: [{ title: 'M', posts: [{ title: 'P', sequenceNo: 1 }] }] },
      ],
    };
    expect(validateGhlPayload(bad).ok).toBe(false);
  });
});

describe('formatModuleTitle', () => {
  it('utilise module_index quand il y a des lecons', () => {
    expect(ghl.formatModuleTitle({ module_index: 3, lessons: [{}] })).toBe('Module 3');
  });
  it('module vide : Module <index> ou Module ? si index manquant', () => {
    expect(ghl.formatModuleTitle({ module_index: 5, lessons: [] })).toBe('Module 5');
    expect(ghl.formatModuleTitle({ lessons: [] })).toBe('Module ?');
  });
});
