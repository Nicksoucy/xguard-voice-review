import { test, expect } from '@playwright/test';
import { mockSupabase } from './_mock.mjs';

// Verifie que le refactor (logique extraite dans lib/*-logic.js) ne casse pas le chargement
// du cockpit et que la logique "formations finies" rend bien le bon resultat dans le navigateur.

test('le cockpit charge sans exception JS et affiche les 5 onglets', async ({ page }) => {
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(String(e)));
  await mockSupabase(page);
  await page.goto('/index.html');

  await expect(page.locator('.tabs button')).toHaveCount(5);
  expect(crashes, 'aucune exception JS non capturee:\n' + crashes.join('\n')).toEqual([]);
});

test("l'onglet Formations finies montre MET (malgre conteneurs vides) et exclut le cours vide", async ({
  page,
}) => {
  await mockSupabase(page);
  await page.goto('/index.html');

  await page.getByRole('button', { name: /Formations finies/ }).click();

  // tireur-actif (3 done) + MET (4 done + 2 conteneurs vides) = finies
  await expect(page.getByText('Sensibilisation aux situations de tireur actif')).toBeVisible();
  await expect(page.getByText(/Surete aeroportuaire MET/)).toBeVisible();

  // le cours qui n'a qu'un conteneur vide ne doit PAS apparaitre
  await expect(page.getByText("Le port de l'uniforme et le code éthique")).toHaveCount(0);

  // l'entete annonce 2 formations finies
  await expect(page.getByText(/2 formations dont toutes les leçons/)).toBeVisible();
});

test("l'onglet Import GHL liste les formations finies pas encore en ligne", async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/index.html');

  await page.getByRole('button', { name: /Import GHL/ }).click();

  // tireur-actif est "live" dans les fixtures → present dans la liste GHL avec le badge EN LIGNE
  await expect(page.getByText(/Surete aeroportuaire MET/)).toBeVisible();
  await expect(page.locator('.gstat.live')).toHaveCount(1);
});
