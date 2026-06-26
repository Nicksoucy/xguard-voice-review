// Credentials Supabase : prod par defaut, override par sentry-init.js si staging
var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
var SUPA_KEY = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
var STORAGE = SUPA_URL + '/storage/v1/object/public/voiceovers';
var API = SUPA_URL + '/rest/v1';
var H = {apikey:SUPA_KEY,Authorization:'Bearer '+SUPA_KEY};

var params = new URLSearchParams(location.search);
var lessonKey = params.get('key') || '';
var legacyIdx = params.get('lesson');

// Etat global
var L = null;
var W = [];
var els = [];
var flags = new Map();
var glitches = [];
var prevIdx = -1;
var au = null;
var saveTimer = null;
var dirty = false;
// Mode filtre : quand actif, n'affiche que les phrases regenerees (regenIndices)
var regenIndices = null; // null = pas de filtre disponible pour cette lecon
var filterModeActive = false;
// Source des timestamps charges : 'preview' ou 'final'
// Utilise par loadStatus() pour detecter un mismatch avec le chemin audio.
var W_source = 'final'; // par defaut "final" avant que pickBestTimestamps confirme
// Ranges temporels par sentenceIndex, calcules depuis W (timestamps mot-a-mot).
// Ex: sentenceRanges[5] = {start: 12.3, end: 15.7}
var sentenceRanges = {};

// Extrait un contexte autour du mot a l'index i :
// - on reste dans la meme phrase (sentenceIndex) que le mot flagge
// - on veut au moins MIN_BEFORE/MIN_AFTER mots, et au plus MAX_BEFORE/MAX_AFTER
// - si la phrase est plus longue, on tronque et on prefixe/suffixe par "..."
// Objectif : toujours avoir assez de mots autour pour reconnaitre le mot a l'oreille,
// sans jamais enjamber une phrase (ex: pas "...proximite. Declenchez les...").
// Logique pure deleguee a lib/review-logic.js (window.XGReview), testee par vitest.
function getCtx(i){ return XGReview.getCtx(W, i); }
function gsi(i){return W[i] && W[i].sentenceIndex!=null ? W[i].sentenceIndex : '?'}
function fmt(s){return Math.floor(s/60)+':'+('0'+Math.floor(s%60)).slice(-2)}
// Un flag est "resolved" si la phrase (sentenceIndex) a ete regeneree depuis
// la derniere fois qu'il a ete pose. Se base sur regenerated_sentence_indices
// de voiceover_metadata (rempli par regen-from-reviews.mjs).
// Si le reviewer re-clique sur le mot apres regen, le flag repasse en "unresolved"
// (= c'est un nouveau probleme sur la phrase deja regeneree).
// Predicats de flag deleguees a lib/review-logic.js (regenIndices passe en parametre pour isResolved).
function isResolved(flag){ return XGReview.isResolved(flag, regenIndices); }
function isApproved(flag){ return XGReview.isApproved(flag); }
function isAutoResolved(flag){ return XGReview.isAutoResolved(flag); }
function isHidden(flag){ return XGReview.isHidden(flag); }
// Variable de controle UI : afficher ou non les flags deja approuves
var showApproved = false;
function fmtDate(iso){ return XGFormat.fmtDate(iso); }

// ── HELPERS POUR FLAGS GROUPES (Ctrl+click) ──────────────────────
// Un flag groupe a la forme : {index: 12, groupIndices: [12,13,14], word: "cent vingt metres", ...}
// Le "leader" est le mot dont l'index est dans flags.get(). Les autres mots du groupe
// ne sont PAS dans flags.get() mais sont visuellement marques flagged+grouped.

// Trouve le leader d'un groupe contenant ii. Retourne null si ii n'est dans aucun groupe.
// Si ii est lui-meme un leader (flag isole ou leader de groupe), retourne ii.
function findGroupLeader(ii) { return XGReview.findGroupLeader(flags, ii); }

// Trouve le flag le plus PROCHE du mot cliqué (currentIdx) — pour Ctrl+click groupage.
// Strategie : chercher un flag dans la meme phrase, le plus proche en index.
// Ignore approved/auto_resolved (caches), MAIS accepte les resolved (verts) — l'utilisateur
// peut vouloir grouper plusieurs mots qui sonnent encore mal apres regen.
// Si aucun flag dans la meme phrase, retourne null (Ctrl+click cree un nouveau flag).
function findClosestFlag(currentIdx) { return XGReview.findClosestFlag(W, flags, currentIdx); }

// Backwards compat : alias vers findClosestFlag(null) qui retombe sur l'ancien comportement
function findLastActiveFlag() {
  // Garde par compat mais ne devrait plus etre utilise
  var best = null, bestMaxIdx = -1;
  flags.forEach(function(f, ii){
    if (isHidden(f)) return;
    var maxIdx = Array.isArray(f.groupIndices) ? Math.max.apply(null, f.groupIndices) : ii;
    if (maxIdx > bestMaxIdx) { bestMaxIdx = maxIdx; best = ii; }
  });
  return best;
}

// Construit un contexte autour d'un groupe de mots (extension de getCtx pour multi-mots).
// Borne par la phrase du leader (1er mot du groupe).
// Strategie : pour chaque mot, on regarde s'il est dans le groupe.
//   - Mot dans le groupe : on ouvre/ferme un span ** autour des sous-groupes contigus.
//   - Mot hors groupe : on l'ajoute sans **.
// Pour les groupes non-contigus, on insere "..." entre les sous-groupes pour eviter
// d'avoir un contexte enorme englobant tous les mots intermediaires.
function getGroupCtx(groupIndices) { return XGReview.getGroupCtx(W, groupIndices); }

// ── GARDE LECTURE-SEULE ──────────────────────────────────────────
// Renvoie true (et affiche un message) si on regarde la review d'un AUTRE reviseur.
// A appeler en TETE de toute fonction qui MODIFIE la review affichee (flags/glitches).
// NE PAS l'utiliser pour soumettre sa propre demande (correction_requests/sentence_flags) :
// soumettre sous son propre nom est permis meme en lecture seule (ca n'ecrase la review de personne).
function roGuard() {
  if (!XGReview.canEditReview(window.viewingOtherReview)) {
    if (typeof showMsg === 'function') showMsg('\u{1F441}\u{FE0F} Lecture seule — review de ' + window.viewingOtherReview, '');
    return true;
  }
  return false;
}

