// Temps de revue réel (lib/presence.js, 2026-11-25) : un geste envoie la minute, sans nom rien ne part,
// et le cockpit affiche le temps du jour.
import { test, expect } from '@playwright/test';
import { mockSupabase, mockReviewPage } from './_mock.mjs';
import { LESSON } from '../fixtures/review.mjs';
const URL = '/review.html?key=' + encodeURIComponent(LESSON.lesson_key);

test('review.html : un clic envoie la minute de présence avec le nom', async ({ page }) => {
  await mockReviewPage(page);
  const envois = [];
  await page.route('**/rest/v1/reviewer_presence', (route) => {
    envois.push({ body: JSON.parse(route.request().postData() || '{}'), prefer: route.request().headers()['prefer'] });
    return route.fulfill({ status: 201, body: '' });
  });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL);
  await page.mouse.click(5, 5);
  await expect.poll(() => envois.length).toBe(1);
  expect(envois[0].body).toMatchObject({ reviewer_name: 'Rawen', page: 'voix', lesson_key: LESSON.lesson_key });
  expect(envois[0].body.minute).toMatch(/:00\.000Z$/);
  expect(envois[0].prefer).toContain('resolution=ignore-duplicates');
  // Deuxième geste dans la même minute : rien de plus.
  await page.keyboard.press('Shift');
  await page.waitForTimeout(300);
  expect(envois.length).toBe(1);
});

test('sans nom, rien ne part', async ({ page }) => {
  await mockReviewPage(page);
  const envois = [];
  await page.route('**/rest/v1/reviewer_presence', (route) => { envois.push(1); return route.fulfill({ status: 201, body: '' }); });
  await page.goto(URL);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(500);
  expect(envois.length).toBe(0);
});

test('cockpit, onglet Production : le temps de revue du jour', async ({ page }) => {
  await mockSupabase(page);
  const jour = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montreal' });
  await page.route('**/rest/v1/temps_revue_jour**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ reviewer: 'rawen', reviewer_affiche: 'Rawen', jour, minutes_actives: 95, minutes_voix: 60, minutes_video: 30, minutes_autres: 5, debut: jour + 'T14:00:00Z', fin: jour + 'T16:10:00Z' }]),
  }));
  await page.addInitScript(() => localStorage.setItem('tab', 'prod'));
  await page.goto('/index.html');
  await expect(page.getByText('Rawen : 1 h 35 aujourd’hui')).toBeVisible();
});
