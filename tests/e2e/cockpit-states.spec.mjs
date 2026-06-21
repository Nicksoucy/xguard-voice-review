import { test, expect } from '@playwright/test';
import { mockSupabase } from './_mock.mjs';

// Etats vides et erreurs du cockpit — robustesse de l'UI quand Supabase renvoie peu/pas/mal.

test('etat vide : aucune lecon → message « rien a reviser »', async ({ page }) => {
  await mockSupabase(page, { courses: [], lessons: [], lms: [] });
  await page.goto('/index.html');
  await expect(page.locator('.allgood')).toContainText(/Rien à réviser/i);
});

test('etat vide : onglet Formations finies sans formation finie', async ({ page }) => {
  // Des cours existent mais aucun n'est 100% fini.
  await mockSupabase(page, {
    courses: [{ id: 'c1', title: 'Cours en cours', visible: true, sort_order: 1 }],
    lessons: [
      {
        lesson_key: 'c1/01',
        course_id: 'c1',
        pipeline_stage: 'voice_review',
        status: 'in_review',
        sort_order: 0,
      },
    ],
    lms: [],
  });
  await page.goto('/index.html');
  await page.getByRole('button', { name: /Formations finies/ }).click();
  await expect(page.locator('.allgood')).toContainText(/Aucune formation 100% terminée/i);
});

test("etat erreur : une requete Supabase echoue → bandeau d'erreur", async ({ page }) => {
  await mockSupabase(page);
  // La requete principale echoue APRES le mock (route ajoutee en dernier = prioritaire).
  await page.route('**/lesson_status_full**', (route) =>
    route.fulfill({ status: 500, body: 'boom' }),
  );
  await page.goto('/index.html');
  await expect(page.locator('.err')).toContainText(/Erreur de chargement/i);
});

test("la bascule d'onglet est memorisee (localStorage)", async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/index.html');
  await page.getByRole('button', { name: /Import GHL/ }).click();
  await expect(page.locator('.tabs button.on')).toContainText(/Import GHL/);
  // Apres rechargement, l'onglet reste sur Import GHL.
  await page.reload();
  await expect(page.locator('.tabs button.on')).toContainText(/Import GHL/);
});
