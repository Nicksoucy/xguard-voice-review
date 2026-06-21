// Helper de mock reseau pour les tests E2E : simule les reponses Supabase REST et coupe le CDN
// Sentry, pour que les pages tournent hors-ligne et de facon deterministe.
import { COURSES, LESSONS, LMS } from '../fixtures/cockpit.mjs';

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
