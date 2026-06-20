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
function getCtx(i){
  var MIN_BEFORE = 6, MIN_AFTER = 6;
  var MAX_BEFORE = 10, MAX_AFTER = 10;
  if (!W[i]) return '';
  var si = W[i].sentenceIndex;
  // Trouver le debut de la phrase courante
  var sentStart = i;
  while (sentStart > 0 && W[sentStart-1].sentenceIndex === si) sentStart--;
  // Trouver la fin de la phrase courante
  var sentEnd = i;
  while (sentEnd < W.length-1 && W[sentEnd+1].sentenceIndex === si) sentEnd++;
  // Calculer la fenetre : au moins MIN, au plus MAX, sans sortir de la phrase
  var s = Math.max(sentStart, i - MAX_BEFORE);
  var e = Math.min(sentEnd, i + MAX_AFTER);
  // Si la phrase est courte, on prend tout (pas besoin de tronquer)
  if (sentEnd - sentStart <= MIN_BEFORE + MIN_AFTER) {
    s = sentStart;
    e = sentEnd;
  }
  var prefix = s > sentStart ? '... ' : '';
  var suffix = e < sentEnd ? ' ...' : '';
  var r = [];
  for (var k = s; k <= e; k++) {
    r.push(k === i ? '**'+W[k].word+'**' : W[k].word);
  }
  return prefix + r.join(' ') + suffix;
}
function gsi(i){return W[i] && W[i].sentenceIndex!=null ? W[i].sentenceIndex : '?'}
function fmt(s){return Math.floor(s/60)+':'+('0'+Math.floor(s%60)).slice(-2)}
// Un flag est "resolved" si la phrase (sentenceIndex) a ete regeneree depuis
// la derniere fois qu'il a ete pose. Se base sur regenerated_sentence_indices
// de voiceover_metadata (rempli par regen-from-reviews.mjs).
// Si le reviewer re-clique sur le mot apres regen, le flag repasse en "unresolved"
// (= c'est un nouveau probleme sur la phrase deja regeneree).
function isResolved(flag){
  if (!regenIndices) return false;
  if (flag.reflagged) return false; // re-flagge manuellement apres regen
  if (flag.sentenceIndex === null || flag.sentenceIndex === undefined || flag.sentenceIndex === '?') return false;
  return regenIndices.indexOf(flag.sentenceIndex) !== -1;
}
// Un flag est "approved_after_regen" quand Nicolas a explicitement confirme
// qu'apres regen le mot sonne bien. Il est cache de la liste par defaut.
function isApproved(flag){ return !!flag.approved_after_regen; }
// Un flag est "auto_resolved" quand le mot flagged n'existe plus dans le texte
// apres reformulation (detecte automatiquement par auto-resolve-orphan-flags.mjs).
// Cache par defaut comme isApproved.
function isAutoResolved(flag){ return !!flag.auto_resolved; }
// Combine : flag a cacher de la liste active
function isHidden(flag){ return isApproved(flag) || isAutoResolved(flag); }
// Variable de controle UI : afficher ou non les flags deja approuves
var showApproved = false;
function fmtDate(iso){try{return new Date(iso).toLocaleString('fr-CA',{dateStyle:'medium',timeStyle:'short'})}catch(e){return iso}}

// ── HELPERS POUR FLAGS GROUPES (Ctrl+click) ──────────────────────
// Un flag groupe a la forme : {index: 12, groupIndices: [12,13,14], word: "cent vingt metres", ...}
// Le "leader" est le mot dont l'index est dans flags.get(). Les autres mots du groupe
// ne sont PAS dans flags.get() mais sont visuellement marques flagged+grouped.

// Trouve le leader d'un groupe contenant ii. Retourne null si ii n'est dans aucun groupe.
// Si ii est lui-meme un leader (flag isole ou leader de groupe), retourne ii.
function findGroupLeader(ii) {
  if (flags.has(ii)) return ii;
  // Chercher dans tous les flags si un a groupIndices contenant ii
  var leaderIdx = null;
  flags.forEach(function(f, leaderIi){
    if (Array.isArray(f.groupIndices) && f.groupIndices.indexOf(ii) !== -1) {
      leaderIdx = leaderIi;
    }
  });
  return leaderIdx;
}

// Trouve le flag le plus PROCHE du mot cliqué (currentIdx) — pour Ctrl+click groupage.
// Strategie : chercher un flag dans la meme phrase, le plus proche en index.
// Ignore approved/auto_resolved (caches), MAIS accepte les resolved (verts) — l'utilisateur
// peut vouloir grouper plusieurs mots qui sonnent encore mal apres regen.
// Si aucun flag dans la meme phrase, retourne null (Ctrl+click cree un nouveau flag).
function findClosestFlag(currentIdx) {
  if (currentIdx == null || !W[currentIdx]) return null;
  var currentSi = W[currentIdx].sentenceIndex;
  var best = null;
  var bestDistance = Infinity;
  flags.forEach(function(f, leaderIi){
    if (isHidden(f)) return; // skip approved/auto_resolved (caches de toute facon)
    // Calculer la distance min entre currentIdx et n'importe quel mot du flag
    var memberIndices = Array.isArray(f.groupIndices) ? f.groupIndices : [leaderIi];
    var minDist = Infinity;
    var sameSentence = false;
    for (var i = 0; i < memberIndices.length; i++) {
      var mi = memberIndices[i];
      if (W[mi] && W[mi].sentenceIndex === currentSi) sameSentence = true;
      var d = Math.abs(mi - currentIdx);
      if (d < minDist) minDist = d;
    }
    // Priorite stricte aux flags dans la meme phrase
    if (sameSentence && minDist < bestDistance) {
      bestDistance = minDist;
      best = leaderIi;
    }
  });
  return best;
}

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
function getGroupCtx(groupIndices) {
  if (!groupIndices || groupIndices.length === 0) return '';
  var sortedIdx = groupIndices.slice().sort(function(a,b){ return a-b; });
  var first = sortedIdx[0];
  var last = sortedIdx[sortedIdx.length - 1];
  if (!W[first]) return '';
  var si = W[first].sentenceIndex;
  // Trouver les bornes de la phrase
  var sentStart = first;
  while (sentStart > 0 && W[sentStart-1].sentenceIndex === si) sentStart--;
  var sentEnd = last;
  while (sentEnd < W.length-1 && W[sentEnd+1].sentenceIndex === si) sentEnd++;

  // Detecter les sous-groupes contigus pour eviter de marquer ** chaque mot individuellement.
  // Ex: groupIndices=[200,201,202,250] -> sous-groupes [[200,201,202], [250]]
  var groupSet = new Set(sortedIdx);
  var subGroups = [];
  var cur = [sortedIdx[0]];
  for (var i = 1; i < sortedIdx.length; i++) {
    if (sortedIdx[i] === sortedIdx[i-1] + 1) {
      cur.push(sortedIdx[i]);
    } else {
      subGroups.push(cur);
      cur = [sortedIdx[i]];
    }
  }
  subGroups.push(cur);

  // Pour chaque sous-groupe, construire un contexte local : ~5 mots avant + sous-groupe + ~5 mots apres,
  // borne par sentStart/sentEnd. Puis joindre avec " ... " entre sous-groupes.
  var WINDOW = 5;
  var parts = [];
  var lastEnd = -1; // indice de fin du contexte precedent (pour detecter chevauchements)
  for (var sg = 0; sg < subGroups.length; sg++) {
    var sub = subGroups[sg];
    var subFirst = sub[0];
    var subLast = sub[sub.length - 1];
    var winStart = Math.max(sentStart, subFirst - WINDOW);
    var winEnd = Math.min(sentEnd, subLast + WINDOW);
    // Si chevauchement avec le contexte precedent, decoller
    var localPrefix = '';
    if (lastEnd >= 0 && winStart <= lastEnd + 1) {
      // Fusionne avec le precedent : on commence apres lastEnd
      winStart = lastEnd + 1;
    } else if (sg === 0 && winStart > sentStart) {
      localPrefix = '... ';
    } else if (sg > 0) {
      localPrefix = ' ... ';
    }
    var r = [];
    for (var k = winStart; k <= winEnd; k++) {
      if (groupSet.has(k)) {
        // Detecter ouverture/fermeture du span **
        var openBold = !groupSet.has(k-1) || k === winStart;
        var closeBold = !groupSet.has(k+1) || k === winEnd;
        var token = W[k].word;
        if (openBold) token = '**' + token;
        if (closeBold) token = token + '**';
        r.push(token);
      } else {
        r.push(W[k].word);
      }
    }
    parts.push(localPrefix + r.join(' '));
    lastEnd = winEnd;
  }
  var suffix = lastEnd < sentEnd ? ' ...' : '';
  return parts.join('') + suffix;
}

