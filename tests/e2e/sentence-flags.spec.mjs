// E2E du circuit CRAYON ✏️ (sentence_flags) sur mock reseau (ZERO appel a Supabase prod).
// Protege la boucle de feedback reparee le 2026-07-02 (« changer la phrase = cassé bout en bout ») :
//  1. Soumettre une reecriture -> POST sentence_flags + badge ⏳ a cote du crayon.
//  2. Flag applique (applied=true) -> badge ✅.
//  3. Flag skipped -> le modal montre la raison, le texte source actuel et « Renvoyer ».
//  4. « Renvoyer avec le texte actuel » -> nouveau POST re-ancre + ancien flag superseded.
//  5. Dedup : une demande active existe deja -> message « Deja demande », AUCUN POST.
import { test, expect } from '@playwright/test';
import { mockReviewPage } from './_mock.mjs';
import { LESSON } from '../fixtures/review.mjs';

const URL = '/review.html?key=' + encodeURIComponent(LESSON.lesson_key);

// Ouvre review.html en tant qu'Hela et attend que les mots soient rendus.
async function openAsHela(page) {
  await page.addInitScript(() => localStorage.setItem('rn', 'Hela'));
  await page.goto(URL);
  await page.locator('.w').first().waitFor({ timeout: 5000 });
}

// Clique le crayon de la phrase #si et attend le modal.
async function openCrayon(page, si) {
  await page.locator('.sm-flag').nth(si).click();
  await expect(page.locator('#sentence-modal-bg')).toBeVisible();
}

test('crayon : soumettre une reecriture -> POST sentence_flags + badge ⏳', async ({ page }) => {
  const state = await mockReviewPage(page); // aucun flag existant
  await openAsHela(page);

  // Au depart : aucun badge (pas de demande sur cette lecon).
  await expect(page.locator('[data-si-badge="0"]')).toHaveText('');

  // Crayon de la phrase #0 -> modal, type « rewrite » preselectionne, on tape le nouveau texte.
  await openCrayon(page, 0);
  await expect(page.locator('input[name="flagType"][value="rewrite"]')).toBeChecked();
  await page.locator('#sentence-corrected').fill('Bonjour le monde');
  await page.locator('#sentence-modal-bg button:has-text("Envoyer la correction")').click();

  // Confirmation dans le modal, et la demande est bien partie.
  await expect(page.locator('#sentence-modal-msg')).toContainText('Correction de phrase envoyée');
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].lesson_key).toBe(LESSON.lesson_key);
  expect(state.posts[0].sentence_index).toBe(0);
  expect(state.posts[0].flag_type).toBe('rewrite');
  expect(state.posts[0].corrected_text).toBe('Bonjour le monde');
  expect(state.posts[0].original_text).toBe('Bonjour monde'); // recollage des timestamps
  expect(state.posts[0].reviewer_name).toBe('Hela');

  // Boucle de feedback : le badge ⏳ apparait a cote du crayon (sentence-status.js).
  const badge = page.locator('[data-si-badge="0"]');
  await expect(badge).toHaveText('⏳');
  await expect(badge).toHaveClass(/sflag-pending/);
});

test('crayon : flag applique (applied=true) -> badge ✅', async ({ page }) => {
  await mockReviewPage(page, {
    sentenceFlags: [
      {
        id: 11,
        lesson_key: LESSON.lesson_key,
        sentence_index: 0,
        flag_type: 'rewrite',
        applied: true,
        applied_at: '2026-07-02T09:30:00Z',
        auto_status: 'applied',
        created_at: '2026-07-01T10:00:00Z',
      },
    ],
  });
  await openAsHela(page);

  const badge = page.locator('[data-si-badge="0"]');
  await expect(badge).toHaveText('✅');
  await expect(badge).toHaveClass(/sflag-done/);
  await expect(badge).toHaveAttribute('title', /Phrase corrigée/);
});

// Fixture d'echec definitif : le worker n'a pas retrouve la phrase dans la source.
const SKIPPED_FLAG = {
  id: 12,
  lesson_key: LESSON.lesson_key,
  sentence_index: 1,
  flag_type: 'rewrite',
  applied: false,
  auto_status: 'skipped',
  skip_reason: 'phrase introuvable dans la source',
  source_sentence: 'La deuxieme phrase a change entre-temps.',
  corrected_text: 'La deuxieme phrase voulue.',
  partial_original: null,
  partial_replacement: null,
  note: null,
  created_at: '2026-07-01T15:00:00Z',
};

test('crayon : flag skipped -> le modal montre la raison, le texte source et « Renvoyer »', async ({
  page,
}) => {
  await mockReviewPage(page, { sentenceFlags: [SKIPPED_FLAG] });
  await openAsHela(page);

  // Le badge d'echec est visible sur la phrase #1.
  const badge = page.locator('[data-si-badge="1"]');
  await expect(badge).toHaveText('⚠');
  await expect(badge).toHaveClass(/sflag-error/);

  // Rouvrir le modal : Hela voit POURQUOI + le texte actuel de la source + le bouton Renvoyer.
  await openCrayon(page, 1);
  const msg = page.locator('#sentence-modal-msg');
  await expect(msg).toContainText('Pas appliquée automatiquement');
  await expect(msg).toContainText('Raison : phrase introuvable dans la source');
  await expect(msg).toContainText('Texte actuel de la source');
  await expect(msg).toContainText('La deuxieme phrase a change entre-temps.');
  await expect(msg.locator('button:has-text("Renvoyer avec le texte actuel")')).toBeVisible();
});

test('crayon : « Renvoyer avec le texte actuel » re-ancre le flag + supersede l’ancien', async ({
  page,
}) => {
  const state = await mockReviewPage(page, { sentenceFlags: [SKIPPED_FLAG] });
  await openAsHela(page);
  await openCrayon(page, 1);

  await page
    .locator('#sentence-modal-msg button:has-text("Renvoyer avec le texte actuel")')
    .click();
  // Attendre le message de SUCCES (« ✓ Renvoye ») — pas juste « Renvoye », que le
  // texte du bouton contient deja avant meme que la requete parte.
  await expect(page.locator('#sentence-modal-msg')).toContainText('✓ Renvoye');

  // Nouveau flag re-ancre sur le texte ACTUEL de la source (pas l'ancien original_text).
  expect(state.posts.length).toBe(1);
  expect(state.posts[0].original_text).toBe(SKIPPED_FLAG.source_sentence);
  expect(state.posts[0].corrected_text).toBe(SKIPPED_FLAG.corrected_text);
  expect(state.posts[0].sentence_index).toBe(1);

  // L'ancien flag ne doit plus jamais repasser dans la machine. Le PATCH part en
  // parallele du message de succes -> on poll au lieu d'asserter tout de suite.
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0].id).toBe(SKIPPED_FLAG.id);
  expect(state.patches[0].body.auto_status).toBe('superseded');

  // Et le badge repasse en file (le renvoi, plus recent, fait foi).
  await expect(page.locator('[data-si-badge="1"]')).toHaveText('⏳');
});

test('crayon : dedup — une demande active existe deja -> « Deja demande », AUCUN POST', async ({
  page,
}) => {
  const state = await mockReviewPage(page, {
    sentenceFlags: [
      {
        id: 13,
        lesson_key: LESSON.lesson_key,
        sentence_index: 0,
        flag_type: 'rewrite',
        applied: false,
        auto_status: null, // en file = ACTIVE
        corrected_text: 'Bonjour le monde',
        created_at: '2026-06-30T08:00:00Z',
      },
    ],
  });
  await openAsHela(page);

  // Re-soumettre une reecriture sur la MEME phrase.
  await openCrayon(page, 0);
  await page.locator('#sentence-corrected').fill('Bonjour tout le monde');
  await page.locator('#sentence-modal-bg button:has-text("Envoyer la correction")').click();

  // Bloque par la dedup : message explicite, et rien n'est parti vers Supabase.
  await expect(page.locator('#sentence-modal-msg')).toContainText('Deja demande');
  await expect(page.locator('#sentence-modal-msg')).toContainText('Pas besoin de re-cliquer');
  expect(state.posts.length).toBe(0);
});
