// E2E des parcours critiques de la review voix, sur mock reseau (ZERO appel a Supabase prod) :
//  1. Mode lecture seule (Nicolas supervise Hela) : un clic mot ne sauve PAS, mais Approuver sauve.
//  2. Flag un mot + Corriger : envoie bien une demande de correction.
//  3. Approuver une lecon : envoie bien voice_reviews approved=true.
import { test, expect } from '@playwright/test';

// Petit jeu de timestamps : 2 phrases, 4 mots. Suffit a rendre des <span class="w"> cliquables.
const WORDS = [
  { word: 'Bonjour', sentenceIndex: 0, start: 0, end: 0.5 },
  { word: 'monde', sentenceIndex: 0, start: 0.5, end: 1.0 },
  { word: 'deuxieme', sentenceIndex: 1, start: 1.0, end: 1.5 },
  { word: 'phrase', sentenceIndex: 1, start: 1.5, end: 2.0 },
];
const LESSON = {
  lesson_key: 'demo/module-01/01-demo',
  course_id: 'demo',
  title: 'Lecon demo',
  short_title: 'Demo',
  duration_seconds: 2,
};

// Installe le mock reseau. `reviews` = ce que renvoie GET voice_reviews (vide ou review d'un autre).
// Retourne un objet `posts` qui accumule les corps des POST interceptes.
async function mockReview(page, reviews = []) {
  const posts = { correction_requests: [], voice_reviews: [] };
  await page.route('**/js.sentry-cdn.com/**', (r) => r.abort());

  await page.route('**/storage/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('timestamps')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WORDS) });
    }
    // mp3 et autres : 404 deterministe (pas d'audio reel en test).
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (method === 'POST') {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      if (url.includes('/correction_requests')) posts.correction_requests.push(body);
      else if (url.includes('/voice_reviews')) posts.voice_reviews.push(body);
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    }
    // GET
    let data = [];
    if (url.includes('/lessons?')) data = [LESSON];
    else if (url.includes('/voice_reviews?')) data = reviews;
    else data = []; // lesson_status, voiceover_metadata, correction_requests, history...
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });

  return posts;
}

const URL = '/review.html?key=' + encodeURIComponent(LESSON.lesson_key);

test('lecture seule : un clic mot ne sauve PAS, mais Approuver sauve (protege le travail d’Hela)', async ({ page }) => {
  // Hela a une review existante ; Nicolas (rn different) la regarde -> mode lecture seule.
  const posts = await mockReview(page, [
    { lesson_key: LESSON.lesson_key, reviewer_name: 'Hela', flags: [], glitches: [], approved: false, updated_at: '2026-06-25T10:00:00Z' },
  ]);
  await page.addInitScript(() => localStorage.setItem('rn', 'Nicolas'));
  await page.goto(URL);

  // Les mots se rendent + le bandeau lecture seule apparait.
  await page.locator('.w').first().waitFor({ timeout: 5000 });
  await expect(page.locator('#viewing-banner')).toBeVisible();

  // Clic sur un mot : roGuard bloque -> AUCUN POST voice_reviews (autosave inhibe).
  await page.locator('.w').first().click();
  await page.waitForTimeout(300);
  expect(posts.voice_reviews.length).toBe(0);

  // Approuver la lecon : ecrit NOTRE propre review (force) -> POST voice_reviews approved=true.
  await page.locator('button:has-text("Approuver la le")').first().click();
  await page.locator('#modal-bg button:has-text("Oui")').click();
  await page.waitForTimeout(300);
  expect(posts.voice_reviews.length).toBe(1);
  expect(posts.voice_reviews[0].approved).toBe(true);
  expect(posts.voice_reviews[0].reviewer_name).toBe('Nicolas');
});

test('flag un mot + Corriger -> envoie une demande de correction', async ({ page }) => {
  const posts = await mockReview(page, []); // pas de review existante -> mode normal
  await page.addInitScript(() => localStorage.setItem('rn', 'Hela'));
  await page.goto(URL);

  await page.locator('.w').first().waitFor({ timeout: 5000 });
  // Flag le 1er mot : un bloc de flag apparait dans #fl.
  await page.locator('.w').first().click();
  await page.locator('#fl input.rfix').first().waitFor({ timeout: 5000 });
  // Tape un "son voulu" (prononciation) different du mot, puis Corriger.
  await page.locator('#fl input.rfix').first().fill('bon-jour');
  await page.locator('#fl button:has-text("Corriger")').first().click();
  await page.waitForTimeout(300);

  expect(posts.correction_requests.length).toBe(1);
  expect(posts.correction_requests[0].lesson_key).toBe(LESSON.lesson_key);
  expect(['word', 'pronunciation']).toContain(posts.correction_requests[0].intent);
});

test('approuver une lecon (mode normal) -> POST voice_reviews approved=true', async ({ page }) => {
  const posts = await mockReview(page, []);
  await page.addInitScript(() => localStorage.setItem('rn', 'Hela'));
  await page.goto(URL);

  await page.locator('.w').first().waitFor({ timeout: 5000 });
  await page.locator('button:has-text("Approuver la le")').first().click();
  await page.locator('#modal-bg button:has-text("Oui")').click();
  await page.waitForTimeout(300);

  expect(posts.voice_reviews.length).toBeGreaterThanOrEqual(1);
  const approved = posts.voice_reviews.find((p) => p.approved === true);
  expect(approved).toBeTruthy();
  expect(approved.reviewer_name).toBe('Hela');
});
