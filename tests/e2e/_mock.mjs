// Helper de mock reseau pour les tests E2E : simule les reponses Supabase REST et coupe le CDN
// Sentry, pour que les pages tournent hors-ligne et de facon deterministe.
import { COURSES, LESSONS, LMS } from '../fixtures/cockpit.mjs';
import { WORDS, LESSON } from '../fixtures/review.mjs';

export async function mockSupabase(page, over = {}) {
  // Couper le CDN Sentry (sentry-init.js bascule alors sur un stub silencieux).
  await page.route('**/js.sentry-cdn.com/**', (route) => route.abort());

  // Storage Supabase (timestamps voix, videos) : 404 deterministe (pas de fichiers en test).
  await page.route('**/storage/v1/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );

  // Router toutes les requetes REST Supabase vers les fixtures.
  await page.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    let body = [];
    if (url.includes('/courses?')) body = over.courses || COURSES;
    else if (url.includes('/lesson_status_full')) body = over.lessons || LESSONS;
    else if (url.includes('/course_lms_status')) body = over.lms || LMS;
    else body = []; // correction_requests, watchdog_heartbeat, etc.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

// Mock de review.html centre sur le circuit CRAYON (sentence_flags), STATEFUL :
// les POST s'ajoutent aux rows et les PATCH les modifient, comme le ferait
// PostgREST. Les GET re-filtrent l'etat selon les params de l'URL
// (id=eq.N, sentence_index=eq.N, applied=eq.false...) pour que les trois
// requetes du circuit (badges / modal / dedup) voient des donnees coherentes.
// `sentenceFlags` = rows initiales (les plus recentes EN PREMIER, comme
// order=created_at.desc). Retourne l'etat pour les assertions.
export async function mockReviewPage(page, { sentenceFlags = [] } = {}) {
  const state = {
    flags: [...sentenceFlags], // rows sentence_flags vivantes (triees desc)
    posts: [], // corps des POST /sentence_flags interceptes
    patches: [], // {id, body} des PATCH /sentence_flags
    nextId: 900,
  };

  await page.route('**/js.sentry-cdn.com/**', (r) => r.abort());

  await page.route('**/storage/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('timestamps')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(WORDS),
      });
    }
    // mp3 et autres : 404 deterministe (pas d'audio reel en test).
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    if (url.includes('/sentence_flags')) {
      if (method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(req.postData() || '{}');
        } catch (e) {}
        state.posts.push(body);
        // Nouvelle demande = en file (applied=false, auto_status null), en tete (desc).
        state.flags.unshift({ id: state.nextId++, applied: false, auto_status: null, ...body });
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
      }
      if (method === 'PATCH') {
        let body = {};
        try {
          body = JSON.parse(req.postData() || '{}');
        } catch (e) {}
        const m = url.match(/[?&]id=eq\.(\d+)/);
        const id = m ? Number(m[1]) : null;
        state.patches.push({ id, body });
        const row = state.flags.find((f) => f.id === id);
        if (row) Object.assign(row, body);
        return route.fulfill({ status: 204, body: '' });
      }
      // GET : re-filtrer l'etat comme PostgREST.
      let rows = state.flags;
      const byId = url.match(/[?&]id=eq\.(\d+)/);
      if (byId) rows = rows.filter((f) => f.id === Number(byId[1]));
      const bySi = url.match(/[?&]sentence_index=eq\.(\d+)/);
      if (bySi) rows = rows.filter((f) => f.sentence_index === Number(bySi[1]));
      // Requete de dedup : demandes ACTIVES seulement (en file ou en cours).
      if (url.includes('applied=eq.false')) {
        rows = rows.filter(
          (f) => !f.applied && (f.auto_status == null || f.auto_status === 'processing'),
        );
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rows),
      });
    }

    // Autres POST (voice_reviews autosave...) : accepter sans effet.
    if (method === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    }
    // GET restants : la lecon, et vide pour tout le reste (lesson_status, history...).
    let data = [];
    if (url.includes('/lessons?')) data = [LESSON];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });

  return state;
}
