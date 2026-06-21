// Fixtures cockpit — reproduisent la forme reelle de la vue Supabase lesson_status_full
// et de la table courses / course_lms_status. Incluent le cas "type-MET" (lecons produites
// toutes done + conteneurs vides) qui a causé le bug finishedCourses.

// Construit une lecon minimale (les colonnes utiles a la logique cockpit).
export function lesson(course_id, pipeline_stage, extra = {}) {
  return Object.assign(
    {
      lesson_key: course_id + '/' + (extra.k || Math.random().toString(36).slice(2)),
      course_id,
      pipeline_stage,
      status: pipeline_stage === 'done' ? 'approved' : 'in_review',
      sort_order: extra.sort_order || 0,
    },
    extra,
  );
}

// Repete n lecons d'une meme etape pour un cours.
function many(course_id, stage, n) {
  const out = [];
  for (let i = 0; i < n; i++)
    out.push(lesson(course_id, stage, { k: stage + '-' + i, sort_order: i }));
  return out;
}

export const COURSES = [
  {
    id: 'tireur-actif',
    title: 'Sensibilisation aux situations de tireur actif',
    visible: true,
    sort_order: 1,
  },
  {
    id: 'surete-aeroportuaire',
    title: 'Surete aeroportuaire MET — Formation initiale (16 h)',
    visible: true,
    sort_order: 6,
  },
  {
    id: 'le-port-uniforme',
    title: "Le port de l'uniforme et le code éthique",
    visible: true,
    sort_order: 0,
  },
  {
    id: 'communications',
    title: 'Gestion des communications (radio & verbale) — 2 h',
    visible: true,
    sort_order: 9,
  },
  {
    id: 'intervention',
    title: 'Intervention en situation de tireur actif — 4 h',
    visible: true,
    sort_order: 10,
  },
];

// LESSONS : un mélange représentatif.
export const LESSONS = [
  // tireur-actif : 3 lecons toutes done → FINIE
  ...many('tireur-actif', 'done', 3),

  // MET : 4 lecons produites toutes done + 2 conteneurs vides (pipeline_stage null) → FINIE (apres fix)
  ...many('surete-aeroportuaire', 'done', 4),
  lesson('surete-aeroportuaire', null, { k: 'scaffold-1', voiceover_uploaded_at: null }),
  lesson('surete-aeroportuaire', null, { k: 'scaffold-2', voiceover_uploaded_at: null }),

  // le-port-uniforme : 1 seul conteneur vide, rien de produit → JAMAIS finie, invisible partout
  lesson('le-port-uniforme', null, { k: 'scaffold-only' }),

  // communications : voix faite mais 0 video → Phase video, PAS finie
  ...many('communications', 'video_production', 5),

  // intervention : voix en cours (mix voice_review + done) → Phase voix, PAS finie
  ...many('intervention', 'voice_review', 2),
  ...many('intervention', 'done', 3),
];

// Statut import GHL : tireur-actif deja en ligne ; MET pas encore touchee.
export const LMS = [{ course_id: 'tireur-actif', target: 'ghl', status: 'live' }];

export const AUDIO_STAGES = { voice_recheck: 0, voice_review: 1 };
export const VIDEO_STAGES = { video_review: 0 };
