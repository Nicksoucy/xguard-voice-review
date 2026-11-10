// Tests du chantier 03 (2026-11-10) — « Terminé quand » de la fiche :
//  1. Video : renvoyer a corriger, ajouter un flag, recharger -> le renvoi tient toujours.
//  2. Coupure reseau pendant « J'ai fini » (video) et « Approuver » (voix) -> la page le dit,
//     ne recharge pas, et propose « Réessayer », qui aboutit quand le reseau revient.
//  3. Voix : taper dans la case de correction, cliquer un autre mot -> le texte est encore la.
// Tout tourne sur un Supabase SIMULE (page.route) : zero appel a la base de production.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { WORDS, LESSON } from '../fixtures/review.mjs';

const MP4 = readFileSync(new URL('../fixtures/mini.mp4', import.meta.url));

// ── Mock de la page video, AVEC MEMOIRE : les POST video_reviews sont gardes et relus au
// rechargement, comme le ferait PostgREST (upsert lesson_key + reviewer_name).
async function mockVideo(page, { coupe = () => false } = {}) {
  const etat = { reviews: [], posts: [] };
  await page.route('**/js.sentry-cdn.com/**', (r) => r.abort());
  await page.route('**/storage/v1/**', (route) => {
    if (route.request().url().includes('.mp4')) {
      return route.fulfill({ status: 200, contentType: 'video/mp4', body: MP4 });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes('/video_reviews') && req.method() === 'POST') {
      if (coupe()) return route.abort('internetdisconnected');
      const body = JSON.parse(req.postData() || '{}');
      etat.posts.push(body);
      const i = etat.reviews.findIndex((r) => r.reviewer_name === body.reviewer_name);
      if (i >= 0) etat.reviews[i] = { ...etat.reviews[i], ...body };
      else etat.reviews.push(body);
      return route.fulfill({ status: 201, body: '' });
    }
    let data = [];
    if (url.includes('/lessons?')) data = [LESSON];
    else if (url.includes('/lesson_status?')) data = [{ status: 'approved' }];
    else if (url.includes('/video_metadata?')) data = [{ lesson_key: LESSON.lesson_key, video_path: 'demo/v1.mp4', version: 1, produced_at: '2026-11-09T10:00:00Z' }];
    else if (url.includes('/video_reviews?')) {
      const m = url.match(/reviewer_name=eq\.([^&]+)/);
      const nom = m ? decodeURIComponent(m[1]) : null;
      data = etat.reviews.filter((r) => !nom || r.reviewer_name === nom);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  return etat;
}

const URL_VIDEO = '/review-video.html?key=' + encodeURIComponent(LESSON.lesson_key);

async function ajouterFlag(page, categorie = 'visual') {
  await page.locator('.add-flag-btn').click();
  await page.locator(`input[name="flagCat"][value="${categorie}"]`).check();
  await page.locator('#addflag-modal-bg button:has-text("Ajouter")').click();
}

test('vidéo : un renvoi à corriger survit à un flag ajouté puis à un rechargement', async ({ page }) => {
  const etat = await mockVideo(page);
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL_VIDEO);
  await expect(page.locator('#finish-btn')).toBeVisible();

  // Un probleme bloquant, puis « J'ai fini » -> la video part a corriger.
  await ajouterFlag(page);
  await page.locator('#finish-btn').click();
  await expect(page.locator('#finish-confirm')).toHaveText('Envoyer à corriger');
  await page.locator('#finish-confirm').click();
  await expect(page.locator('#recheck-banner')).toContainText('Renvoyée à corriger');
  expect(etat.reviews[0].rejected).toBe(true);

  // Apres le rechargement automatique : on ajoute un AUTRE flag. L'autosauvegarde (2 s)
  // ne doit plus remettre rejected=false — c'etait le bogue de review-video.js:349-353.
  await ajouterFlag(page, 'text_cut');
  await expect.poll(() => etat.posts.at(-1)?.flags?.length, { timeout: 6000 }).toBe(2);
  expect(etat.posts.at(-1).rejected).toBe(true);
  expect(etat.posts.at(-1).approved).toBe(false);

  await page.reload();
  await expect(page.locator('#recheck-banner')).toContainText('Renvoyée à corriger');
  await expect(page.locator('.flag-row')).toHaveCount(2);
});

test('vidéo : coupure réseau pendant « J’ai fini » → message, pas de rechargement, Réessayer', async ({ page }) => {
  let coupe = false;
  const etat = await mockVideo(page, { coupe: () => coupe });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL_VIDEO);
  await expect(page.locator('#finish-btn')).toBeVisible();

  coupe = true;
  await page.locator('#finish-btn').click();
  await expect(page.locator('#finish-confirm')).toHaveText('Oui, approuver');
  await page.locator('#finish-confirm').click();

  // Apres les reessais automatiques : bandeau rouge persistant + bouton « Réessayer ».
  const barre = page.locator('#xg-net-bar');
  await expect(barre.getByRole('button', { name: 'Réessayer' })).toBeVisible({ timeout: 15000 });
  await expect(barre).toContainText('pas de connexion');
  await expect(page.locator('#finish-msg')).toContainText('Pas envoyé');
  // Le verdict n'a jamais ete enregistre et la page n'a pas recharge.
  expect(etat.reviews.length).toBe(0);
  await expect(page.locator('#approved-banner')).toBeVisible(); // verdict garde sur la page

  // Le reseau revient : « Réessayer » aboutit, puis la page recharge sur l'etat serveur.
  coupe = false;
  await barre.getByRole('button', { name: 'Réessayer' }).click();
  await expect.poll(() => etat.reviews[0]?.approved, { timeout: 8000 }).toBe(true);
  await expect(page.locator('#approved-banner')).toContainText('Tu as approuvé');
  await expect(barre).toBeHidden();
});

// ── Page voix ────────────────────────────────────────────────────────
async function mockVoix(page, { coupe = () => false } = {}) {
  const etat = { voice_reviews: [] };
  await page.route('**/js.sentry-cdn.com/**', (r) => r.abort());
  await page.route('**/storage/v1/**', (route) => {
    if (route.request().url().includes('timestamps')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WORDS) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'POST') {
      if (url.includes('/voice_reviews')) {
        if (coupe()) return route.abort('internetdisconnected');
        etat.voice_reviews.push(JSON.parse(req.postData() || '{}'));
      }
      return route.fulfill({ status: 201, body: '' });
    }
    const data = url.includes('/lessons?') ? [LESSON] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  return etat;
}
const URL_VOIX = '/review.html?key=' + encodeURIComponent(LESSON.lesson_key);


test('voix : coupure réseau pendant « Approuver » → message qui reste + Réessayer qui aboutit', async ({ page }) => {
  let coupe = false;
  const etat = await mockVoix(page, { coupe: () => coupe });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL_VOIX);
  await page.locator('.w').first().waitFor();

  coupe = true;
  await page.locator('button:has-text("Approuver la le")').click();
  await page.locator('#modal-bg button:has-text("Oui")').click();

  const barre = page.locator('#xg-net-bar');
  await expect(barre.getByRole('button', { name: 'Réessayer' })).toBeVisible({ timeout: 15000 });
  await expect(barre).toContainText('approuver la leçon');
  await expect(page.locator('#msg')).toContainText('Pas enregistré');
  // Le message d'erreur ne disparait plus apres 2,5 s.
  await page.waitForTimeout(3000);
  await expect(page.locator('#msg')).toContainText('Pas enregistré');
  expect(etat.voice_reviews.length).toBe(0);

  coupe = false;
  await barre.getByRole('button', { name: 'Réessayer' }).click();
  await expect.poll(() => etat.voice_reviews.at(-1)?.approved, { timeout: 8000 }).toBe(true);
  await expect(page.locator('#msg')).toContainText('Leçon approuvée');
  await expect(barre).toBeHidden();
});

test('voix : le texte tapé dans la case de correction reste après un clic sur un autre mot', async ({ page }) => {
  await mockVoix(page);
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL_VOIX);
  await page.locator('.w').first().waitFor();

  await page.locator('.w').nth(0).click();
  const caseCorr = page.locator('#rfix0');
  await caseCorr.fill('bon-jour');
  // Un autre mot -> renderFlags rebatit toute la liste (c'est la qu'on perdait la saisie).
  await page.locator('.w').nth(2).click();
  await expect(page.locator('#fl .ri')).toHaveCount(2);
  await expect(page.locator('#rfix0')).toHaveValue('bon-jour');
});

test('voix : la revue ne se charge pas → lecture seule, aucun écrasement en base', async ({ page }) => {
  const posts = [];
  await page.route('**/js.sentry-cdn.com/**', (r) => r.abort());
  await page.route('**/storage/v1/**', (route) =>
    route.request().url().includes('timestamps')
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WORDS) })
      : route.fulfill({ status: 404, body: '{}' }),
  );
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') { posts.push(req.url()); return route.fulfill({ status: 201, body: '' }); }
    if (req.url().includes('/voice_reviews?')) return route.fulfill({ status: 503, body: '{}' });
    const data = req.url().includes('/lessons?') ? [LESSON] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL_VOIX);
  await page.locator('.w').first().waitFor();
  await expect(page.locator('#xg-net-bar')).toContainText('charger ta revue', { timeout: 15000 });

  await page.locator('.w').first().click();
  await page.waitForTimeout(2500);
  expect(posts.filter((u) => u.includes('voice_reviews'))).toEqual([]);
  await expect(page.locator('#msg')).toContainText('pas encore chargée');
});

test('voix : le texte à réviser a un contraste d’au moins 4,5:1 (axe, règle color-contrast)', async ({ page }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  await mockVoix(page);
  await page.addInitScript(() => localStorage.setItem('rn', 'Rawen'));
  await page.goto(URL_VOIX);
  await page.locator('.w').first().waitFor();
  // Un mot marque (rouge) pour verifier aussi cette couleur-la.
  await page.locator('.w').nth(1).click();
  const r = await new AxeBuilder({ page }).include('#wc').withRules(['color-contrast']).analyze();
  expect(r.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ') + ' : ' + n.failureSummary))).toEqual([]);
  const taille = await page.locator('.w').first().evaluate((el) => getComputedStyle(el).fontSize);
  expect(taille).toBe('16px');
});
