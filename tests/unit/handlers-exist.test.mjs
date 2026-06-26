// Smoke test « boutons morts » : garantit que TOUTE fonction appelee depuis un handler
// (attribut on*="..." statique dans review.html OU genere dynamiquement dans un innerHTML JS)
// est bien DEFINIE quelque part dans les fichiers JS charges. Tout le code est non-module ->
// chaque `function X()` / `var X =` top-level est sur window, donc « defini globalement » se
// verifie par parsing statique des declarations. Aucun navigateur requis, zero flakiness.
//
// Ce test aurait attrape n'importe quel oubli lors du decoupage recent en review/*.js
// (une fonction deplacee/renommee -> bouton qui throw ReferenceError au clic chez Hela).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('review.html');

// Fichiers JS charges par review.html (on ignore les <script> http/CDN).
const scriptSrcs = [...html.matchAll(/<script\s+src="([^"?]+)(?:\?[^"]*)?"/g)]
  .map((m) => m[1])
  .filter((src) => !/^https?:/.test(src));

const jsSources = scriptSrcs.map((src) => {
  try {
    return read(src);
  } catch (e) {
    return '';
  }
});
const allJs = jsSources.join('\n');

// ── Identifiants appeles comme FONCTION et NON precedes d'un point (donc pas une methode) ──
// `approveOneFlag(` -> capture ; `flags.get(` / `els.classList.remove(` -> ignore (methode).
const CALL_RE = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
function calleesIn(handlerBody) {
  const out = new Set();
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(handlerBody))) out.add(m[1]);
  return out;
}

// ── Collecte des handlers : on*="..." dans le HTML ET dans les littéraux innerHTML des JS ──
const HANDLER_RE = /on[a-z]+\s*=\s*"([^"]*)"/g;
function collectCallees(source) {
  const callees = new Set();
  let m;
  HANDLER_RE.lastIndex = 0;
  while ((m = HANDLER_RE.exec(source))) {
    calleesIn(m[1]).forEach((c) => callees.add(c));
  }
  return callees;
}

const usedCallees = new Set();
collectCallees(html).forEach((c) => usedCallees.add(c));
jsSources.forEach((js) => collectCallees(js).forEach((c) => usedCallees.add(c)));

// ── Definitions top-level dans les JS charges ──
const defined = new Set();
for (const m of allJs.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of allJs.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);

// Mots-cles JS + globals navigateur qui peuvent apparaitre comme « callee » mais ne sont pas
// des fonctions a definir nous-memes.
const IGNORE = new Set([
  'if', 'for', 'while', 'switch', 'return', 'typeof', 'function', 'catch', 'new', 'delete',
  'in', 'of', 'do', 'else', 'var', 'let', 'const', 'void', 'instanceof', 'throw', 'case',
  'break', 'continue', 'try', 'finally', 'this', 'true', 'false', 'null', 'undefined', 'await',
  'document', 'window', 'console', 'navigator', 'localStorage', 'sessionStorage', 'location',
  'Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Set',
  'Map', 'Promise', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'alert', 'confirm', 'prompt',
  'fetch', 'encodeURIComponent', 'decodeURIComponent', 'XGReview', 'XGFormat', 'Sentry',
]);

describe('smoke : tous les handlers pointent vers une fonction definie', () => {
  it('review.html se charge avec des scripts locaux', () => {
    expect(scriptSrcs.length).toBeGreaterThan(4);
    expect(usedCallees.size).toBeGreaterThan(10); // on a bien collecte des handlers
  });

  it('aucun bouton mort (handler vers une fonction inexistante)', () => {
    const missing = [...usedCallees].filter((name) => !defined.has(name) && !IGNORE.has(name));
    expect(missing, 'Handlers sans fonction definie : ' + missing.join(', ')).toEqual([]);
  });

  it('les fonctions critiques d’Hela sont definies', () => {
    for (const fn of [
      'submitCorrectionRequest', 'submitRepeat', 'approveOneFlag', 'approveAllGreens',
      'listenSentence', 'markReflag', 'undoReflag', 'askApprove', 'confirmApprove',
      'saveReview', 'flagStutter', 'toggleFilterMode', 'jmp', 'submitSentenceFlag',
      'roGuard', 'flushAutoSave', 'saveLocalBackup', 'maybeOfferLocalRestore',
    ]) {
      expect(defined.has(fn), 'manque : ' + fn).toBe(true);
    }
  });
});
