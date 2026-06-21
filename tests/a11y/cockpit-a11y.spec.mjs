import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockSupabase } from '../e2e/_mock.mjs';

// Audit accessibilite automatise (axe-core) du cockpit. On bloque sur les violations
// serieuses/critiques (les plus impactantes pour Hela au clavier / lecteur d'ecran).

test('index.html : aucune violation a11y serieuse ou critique', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/index.html');
  await page.locator('.tabs button').first().waitFor();

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );

  if (serious.length) {
    console.log(
      'VIOLATIONS a11y:\n' +
        JSON.stringify(
          serious.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.map((n) => n.target).slice(0, 4),
          })),
          null,
          2,
        ),
    );
  }
  expect(serious, 'violations serieuses/critiques').toEqual([]);
});

test('les cartes repliables sont operables au clavier (role=button + Enter)', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/index.html');

  // L'onglet audio (defaut) affiche une carte pour "intervention" (lecons voice_review).
  const head = page.locator('#revhead-intervention');
  await expect(head).toHaveAttribute('role', 'button');
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  // Au clavier : focus puis Entree → la carte se deplie et aria-expanded passe a true.
  await head.focus();
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
});
