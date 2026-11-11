// Tests de l'edition anglaise (dossier en/), mise a niveau du 2026-11-11 :
//  1. Coupure reseau pendant l'enregistrement -> bandeau anglais « Try again », notes gardees
//     sur l'ordinateur, reproposees au rechargement, enregistrees quand le reseau revient.
//  2. Coupure pendant « Approve » -> rien n'est annonce approuve tant que le serveur n'a pas dit oui.
//  3. Lecon a re-ecouter (voix refaite apres la revue) : bandeau, anciennes notes marquees,
//     « I listened again » ecrit la revue sans l'approuver.
//  4. Accueil : section « Listen again » en tete.
// Tout tourne sur un Supabase SIMULE (page.route) : zero appel a la base de production.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { WORDS } from '../fixtures/review.mjs';

const MP4 = readFileSync(new URL('../fixtures/mini.mp4', import.meta.url));

const CLE = 'demo-en/module-01/01-demo';
const URL_REVUE = '/en/review.html?key=' + encodeURIComponent(CLE);

function lecon(over = {}) {
  return {
    lesson_key: CLE, course_id: 'demo-en', title: 'Demo lesson', short_title: 'Demo',
    module_index: 1, lesson_index: 1, status: 'not_reviewed',
    voiceover_uploaded_at: '2026-11-10T12:00:00Z', latest_review_at: null, ...over,
  };
}

// Mock AVEC MEMOIRE : les POST voice_reviews sont gardes et relus au rechargement (upsert).
async function mockEn(page, { coupe = () => false, lesson = lecon(), review = null, demandes = [], metadata = [], battements = [], video = null } = {}) {
  const etat = { posts: [], review, demandes: [...demandes], videoPosts: [], voix: [] };
  await page.route('**/js.sentry-cdn.com/**', (r) => r.abort());
  await page.route('**/storage/v1/**', (route) => {
    if (route.request().url().includes('.mp4')) return route.fulfill({ status: 200, contentType: 'video/mp4', body: MP4 });
    if (route.request().url().includes('timestamps')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WORDS) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/rest/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes('/voice_reviews') && req.method() === 'POST') {
      if (coupe()) return route.abort('internetdisconnected');
      const body = JSON.parse(req.postData() || '{}');
      etat.posts.push(body);
      etat.review = body;
      return route.fulfill({ status: 201, body: '' });
    }
    if (url.includes('/video_reviews') && req.method() === 'POST') {
      etat.videoPosts.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ status: 201, body: '' });
    }
    if (url.includes('/sentence_flags') && req.method() === 'POST') {
      etat.voix.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ status: 201, body: '' });
    }
    if (url.includes('/correction_requests') && req.method() === 'POST') {
      etat.demandes.push({ ...JSON.parse(req.postData() || '{}'), status: 'pending' });
      return route.fulfill({ status: 201, body: '' });
    }
    let data = [];
    if (url.includes('/correction_requests?')) data = etat.demandes;
    else if (url.includes('/video_metadata?')) data = video ? [video] : metadata;
    else if (url.includes('/video_reviews?')) data = [];
    else if (url.includes('/voiceover_metadata?')) data = metadata;
    else if (url.includes('/watchdog_heartbeat?')) data = battements;
    else if (url.includes('/lesson_status_full')) data = [lesson];
    else if (url.includes('/voice_reviews?')) data = etat.review ? [etat.review] : [];
    else if (url.includes('/courses?')) data = [{ id: 'demo-en', title: 'Demo course', short_title: 'Demo', lesson_count: 1 }];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  return etat;
}

test('anglais : coupure à l’enregistrement -> Try again, notes gardées, reprises au rechargement', async ({ page }) => {
  let reseau = false;
  const etat = await mockEn(page, { coupe: () => !reseau });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto(URL_REVUE);
  await page.locator('.w', { hasText: 'monde' }).click();

  // Le bandeau s'affiche des le 1er echec (« Trying again automatically… ») ; le bouton
  // « Try again » arrive apres les 3 essais (1,5 s + 4 s).
  const bandeau = page.locator('#xg-net-bar .xg-net-err', { hasText: 'Could not save your review' });
  await expect(bandeau.locator('button', { hasText: 'Try again' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#msg')).toContainText('Not saved yet');
  expect(etat.posts).toHaveLength(0);

  // Rechargement pendant la panne : le mot marque revient depuis le navigateur.
  await page.reload();
  await expect(page.locator('#banner')).toContainText('We brought back the notes');
  await expect(page.locator('.w.flag', { hasText: 'monde' })).toBeVisible();

  // Le reseau revient : « Try again » enregistre, le bandeau part.
  reseau = true;
  await page.locator('#xg-net-bar button', { hasText: 'Try again' }).click({ timeout: 15000 });
  await expect(page.locator('#msg')).toHaveText('✓ Saved');
  // (Le bandeau audio reste : le mock n'a pas de mp3. Seul celui de l'enregistrement doit partir.)
  await expect(page.locator('#xg-net-bar .xg-net-err', { hasText: 'save your review' })).toHaveCount(0);
  expect(etat.posts.at(-1).flags.map((f) => f.word)).toEqual(['monde']);
  expect(await page.evaluate((k) => localStorage.getItem('xg-en-brouillon:' + k), CLE)).toBeNull();
});

test('anglais : « Approve » sans réseau n’annonce jamais une approbation', async ({ page }) => {
  await mockEn(page, { coupe: () => true });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto(URL_REVUE);
  await expect(page.locator('#title')).toHaveText('Demo lesson');
  await page.locator('#bapprove').click();
  await page.locator('#m-approve button', { hasText: 'Yes, approve' }).click();
  await expect(page.locator('#xg-net-bar .xg-net-err', { hasText: 'Could not approve the lesson' }).locator('button', { hasText: 'Try again' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#msg')).toContainText('Not approved yet');
  await expect(page.locator('#banner')).not.toContainText('You approved');
});

test('anglais : leçon à ré-écouter -> anciennes notes marquées, « I listened again » enregistre sans approuver', async ({ page }) => {
  const ancienne = { lesson_key: CLE, reviewer_name: 'Rachelle', approved: false, updated_at: '2026-11-09T10:00:00Z',
    flags: [{ index: 2, word: 'deuxieme', context: 'deuxieme', time: '0:01', sentenceIndex: 1, note: '', category: 'pronunciation' }], glitches: [] };
  const etat = await mockEn(page, { lesson: lecon({ status: 'needs_recheck', latest_review_at: '2026-11-09T10:00:00Z' }), review: ancienne });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto(URL_REVUE);
  await expect(page.locator('#banner')).toContainText('Please listen again');
  await expect(page.locator('.f.old', { hasText: 'deuxieme' })).toContainText('before the new voice');
  await page.locator('#brecheck').click();
  await expect(page.locator('#msg')).toHaveText('✓ Saved');
  expect(etat.posts).toHaveLength(1);
  expect(etat.posts[0].approved).toBe(false);
  await expect(page.locator('#brecheck')).toBeHidden();
  await expect(page.locator('.f.old')).toHaveCount(0);
});

test('anglais : l’accueil met les leçons à ré-écouter en tête', async ({ page }) => {
  await mockEn(page, { lesson: lecon({ status: 'needs_recheck', module_id: 'm1' }) });
  await page.goto('/en/index.html');
  await expect(page.locator('#recheck h2')).toHaveText('Listen again (1)');
  await expect(page.locator('#recheck .row')).toHaveAttribute('href', 'review.html?key=' + encodeURIComponent(CLE));
});

// ── Robot anglais (2026-11-12) ─────────────────────────────────────────
const VIVANT = [{ id: 'xguard-anglais@mac', last_heartbeat: new Date().toISOString(), status: 'alive' }];

test('anglais : « Fix » envoie la prononciation au robot, au format « mot → son »', async ({ page }) => {
  const etat = await mockEn(page, { battements: VIVANT });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto(URL_REVUE);
  await page.locator('.w', { hasText: 'monde' }).click();
  await expect(page.locator('#robot')).toContainText('Fix robot running');
  // Sans son tape : la page explique quoi faire, rien ne part.
  await page.locator('.f button', { hasText: 'Fix' }).click();
  await expect(page.locator('.f .st')).toContainText('how the word should sound');
  expect(etat.demandes).toHaveLength(0);
  await page.locator('.f input').fill('mond');
  await page.locator('.f button', { hasText: 'Fix' }).click();
  await expect(page.locator('.f .st')).toContainText('The fix robot will redo the voice');
  expect(etat.demandes).toHaveLength(1);
  expect(etat.demandes[0]).toMatchObject({ lesson_key: CLE, phrase_index: 1, sentence_index: 0, intent: 'pronunciation', correction_note: 'monde → mond', requested_by: 'Rachelle' });
});

test('anglais : mot corrigé par le robot -> carte verte, phrase refaite en vert, filtre', async ({ page }) => {
  const review = { lesson_key: CLE, reviewer_name: 'Rachelle', approved: false, updated_at: '2026-11-12T09:00:00Z',
    flags: [{ index: 1, word: 'monde', context: 'Bonjour **monde**', time: '0:00', sentenceIndex: 0, note: 'mond', category: 'pronunciation' }], glitches: [] };
  await mockEn(page, {
    review,
    lesson: lecon({ status: 'needs_recheck', voiceover_uploaded_at: '2026-11-12T10:05:00Z', latest_review_at: '2026-11-12T09:00:00Z' }),
    demandes: [{ phrase_index: 1, status: 'done', applied_mode: 'dict-phrase', completed_at: '2026-11-12T10:05:00Z', correction_note: 'monde → mond' }],
    metadata: [{ regenerated_sentence_indices: [0], regen_source: 'en-correction-bot', voiceover_uploaded_at: '2026-11-12T10:05:00Z' }],
    battements: VIVANT,
  });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto(URL_REVUE);
  await expect(page.locator('.f.fixed')).toContainText('Fixed');
  await expect(page.locator('#s0')).toHaveClass(/green/);
  await expect(page.locator('#s1')).not.toHaveClass(/green/);
  await page.locator('#bfiltre').click();
  await expect(page.locator('#s1')).toBeHidden();
  await expect(page.locator('#s0')).toBeVisible();
  // « Sounds right now » retire la note.
  await page.locator('.f button', { hasText: 'Sounds right now' }).click();
  await expect(page.locator('.f')).toHaveCount(0);
});

test('anglais : un refus du robot se lit, avec sa raison', async ({ page }) => {
  const review = { lesson_key: CLE, reviewer_name: 'Rachelle', approved: false, updated_at: '2026-11-12T09:00:00Z',
    flags: [{ index: 2, word: 'deuxieme', context: '**deuxieme** phrase', time: '0:01', sentenceIndex: 1, note: '', category: 'pronunciation' }], glitches: [] };
  await mockEn(page, { review, demandes: [{ phrase_index: 2, status: 'needs_review', reason: 'Noted for the team.' }] });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto(URL_REVUE);
  await expect(page.locator('.f .st')).toHaveText('⏸ Noted for the team.');
});

// ── Onglets et revision video (2026-11-12) ─────────────────────────────
test('anglais : l’accueil a les 5 onglets du français, et un onglet vide dit pourquoi', async ({ page }) => {
  await mockEn(page, { lesson: lecon({ pipeline_stage: 'voice_review', module_id: 'm1' }) });
  await page.goto('/en/index.html');
  const onglets = page.locator('#tabs button');
  await expect(onglets).toHaveCount(5);
  await expect(onglets).toContainText(['Audio review', 'Video review', 'Production', 'Finished courses', 'GHL import']);
  await onglets.filter({ hasText: 'Video review' }).click();
  await expect(page.locator('#view')).toContainText('No video to watch yet');
  await expect(page.locator('#view')).toContainText('0 of 1 English voices are approved');
  await onglets.filter({ hasText: 'Production' }).click();
  await expect(page.locator('#view')).toContainText('Voice to review');
  await onglets.filter({ hasText: 'GHL import' }).click();
  await expect(page.locator('#view')).toContainText('Nothing to import yet');
  // L'onglet choisi survit au rechargement.
  await page.reload();
  await expect(page.locator('#tabs button.on')).toContainText('GHL import');
});

test('anglais : l’onglet vidéo liste les vidéos à regarder', async ({ page }) => {
  await mockEn(page, { lesson: lecon({ pipeline_stage: 'video_review', module_id: 'm1', latest_approved: true }) });
  await page.goto('/en/index.html#video');
  await expect(page.locator('#view a.row')).toHaveAttribute('href', 'review-video.html?key=' + encodeURIComponent(CLE));
});

test('anglais : page vidéo sans vidéo -> explique pourquoi', async ({ page }) => {
  await mockEn(page);
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto('/en/review-video.html?key=' + encodeURIComponent(CLE));
  await expect(page.locator('#banner')).toContainText('No video yet for this lesson');
  await expect(page.locator('#layout')).toBeHidden();
});

test('anglais : vidéo -> un problème bloquant la renvoie, un problème de voix part au robot', async ({ page }) => {
  const etat = await mockEn(page, {
    lesson: lecon({ latest_approved: true, pipeline_stage: 'video_review' }),
    video: { lesson_key: CLE, video_path: 'demo-en/v1.mp4', version: 1, produced_at: '2026-11-12T10:00:00Z' },
  });
  await page.addInitScript(() => localStorage.setItem('rn', 'Rachelle'));
  await page.goto('/en/review-video.html?key=' + encodeURIComponent(CLE));
  await expect(page.locator('#layout')).toBeVisible();
  // Probleme de voix -> sentence_flags regen, pas un flag video.
  await page.locator('#badd').click();
  await page.locator('input[name="cat"][value="voice"]').check();
  await page.locator('#p-note').fill('monde sounds odd');
  await page.locator('#p-ok').click();
  await expect(page.locator('#p-msg')).toContainText('Sent to the fix robot');
  expect(etat.voix[0]).toMatchObject({ lesson_key: CLE, flag_type: 'regen', sentence_index: 0 });
  await expect(page.locator('#m-probleme')).not.toHaveClass(/on/);
  // Probleme d'ecran bloquant -> « I'm done » renvoie la video.
  await page.locator('#badd').click();
  await page.locator('input[name="cat"][value="typo"]').check();
  await page.locator('#p-note').fill('Recieve on screen');
  await page.locator('#p-ok').click();
  await expect(page.locator('#flags .f')).toHaveCount(1);
  await page.locator('#bfinish').click();
  await expect(page.locator('#fin-titre')).toContainText('Send this video back');
  await page.locator('#fin-ok').click();
  await expect(page.locator('#banner')).toContainText('Sent back to be fixed');
  const dernier = etat.videoPosts.at(-1);
  expect(dernier).toMatchObject({ lesson_key: CLE, rejected: true, approved: false, video_version: 1 });
  expect(dernier.flags[0]).toMatchObject({ category: 'typo', severity: 'blocker', note: 'Recieve on screen' });
});
