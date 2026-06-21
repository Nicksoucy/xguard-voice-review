import { test, expect } from '@playwright/test';
import { mockSupabase } from './_mock.mjs';

// Verifie que review.html charge bien les modules de logique pure (XGReview, XGFormat) dans le
// navigateur et que le branchement de flags.js/loader.js/corrections.js ne provoque pas
// d'exception "global non defini".

test('review.html expose et execute XGReview / XGFormat sans crash de global', async ({ page }) => {
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(String(e)));
  await mockSupabase(page);
  await page.goto('/review.html?key=demo/lesson');

  // Les modules sont exposes en global.
  expect(await page.evaluate(() => typeof window.XGReview)).toBe('object');
  expect(await page.evaluate(() => typeof window.XGFormat)).toBe('object');

  // Et ils fonctionnent dans le contexte de la page.
  const ctx = await page.evaluate(() =>
    window.XGReview.getCtx([{ word: 'allo', sentenceIndex: 0 }], 0),
  );
  expect(ctx).toBe('**allo**');
  const escaped = await page.evaluate(() => window.XGFormat.esc('<b>x</b>'));
  expect(escaped).toBe('&lt;b&gt;x&lt;/b&gt;');

  // Aucune exception due a un global manquant (ordre de chargement des <script>).
  const globalCrashes = crashes.filter((c) =>
    /XGReview|XGFormat|XGCockpit|XGGhl|is not defined/.test(c),
  );
  expect(globalCrashes, globalCrashes.join('\n')).toEqual([]);
});
