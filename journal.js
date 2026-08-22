/**
 * journal.js — Le Journal des corrections.
 *
 * Une page, trois circuits, une question : qu'est-ce qui est mort et pourquoi.
 * Toute la logique de classement vit dans lib/journal-logic.js (pur, teste) ; ici il n'y
 * a que la requete et l'affichage.
 */
var API = window.XG.API, H = window.XG.H;
var esc = window.XGFormat.esc;
var J = window.XGJournal;

var TOUTES = [];          // les lignes brutes de la periode
var catActive = 'mort';   // on ouvre sur ce qui est bloque : c'est le point de la page
var qui = 'tout';

function depuis(jours) {
  var d = new Date(Date.now() - jours * 86400000);
  return d.toISOString();
}

function charger() {
  var iso = depuis(parseInt(document.getElementById('periode').value, 10));
  document.getElementById('liste').innerHTML = '<div class="chargement">Chargement…</div>';
  var q = '&created_at=gte.' + encodeURIComponent(iso) + '&order=created_at.desc&limit=400';
  Promise.all([
    fetch(API + '/sentence_flags?select=id,lesson_key,sentence_index,original_text,corrected_text,partial_original,partial_replacement,applied,auto_status,skip_reason,reviewer_name,created_at' + q, { headers: H }).then(function (r) { return r.json(); }),
    fetch(API + '/correction_requests?select=id,lesson_key,correction_note,phrase_text,status,reason,last_error,requested_by,created_at' + q, { headers: H }).then(function (r) { return r.json(); }),
    fetch(API + '/studio_decisions?select=id,word,spelling,status,note,decided_by,created_at' + q, { headers: H }).then(function (r) { return r.json(); }),
  ]).then(function (res) {
    TOUTES = J.construire(res[0], res[1], res[2]);
    remplirPersonnes();
    rendre();
  }).catch(function (e) {
    document.getElementById('liste').innerHTML = '<div class="vide">Impossible de lire le journal : ' + esc(e.message) + '</div>';
  });
}

function remplirPersonnes() {
  var sel = document.getElementById('personne');
  var actuel = sel.value;
  var noms = J.personnes(TOUTES);
  sel.innerHTML = '<option value="tout">tout le monde</option>' +
    noms.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
  if (noms.indexOf(actuel) >= 0) sel.value = actuel;
}

function rendreBilan() {
  var visibles = J.filtrer(TOUTES, 'tout', qui);
  var b = J.bilan(visibles);
  var tuiles = [
    { cle: 'tout', cls: 'tout', n: b.total, l: 'envoyées' },
    { cle: J.ABOUTI, cls: 'abouti', n: b.abouti, l: 'abouties' },
    { cle: J.EN_COURS, cls: 'encours', n: b.enCours, l: 'en cours' },
    { cle: J.MORT, cls: 'mort', n: b.mort, l: b.mort > 1 ? 'bloquées' : 'bloquée' },
  ];
  document.getElementById('bilan').innerHTML = tuiles.map(function (t) {
    return '<div class="tuile ' + t.cls + (catActive === t.cle ? ' on' : '') + '" data-cat="' + t.cle + '">' +
      '<div class="n">' + t.n + '</div><div class="l">' + t.l + '</div></div>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.tuile'), function (el) {
    el.onclick = function () { catActive = el.getAttribute('data-cat'); rendre(); };
  });
}

function rendre() {
  rendreBilan();
  var lignes = J.filtrer(TOUTES, catActive, qui);
  document.getElementById('compte').textContent = lignes.length + ' ligne(s)';

  if (!lignes.length) {
    document.getElementById('liste').innerHTML = '<div class="vide">' +
      (catActive === J.MORT ? 'Rien de bloqué sur cette période. Tout est passé.' : 'Rien à afficher.') +
      '</div>';
    return;
  }

  document.getElementById('liste').innerHTML = lignes.map(function (l) {
    var d = new Date(l.quand);
    var quand = isNaN(d) ? '' : (('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) +
      ' à ' + ('0' + d.getHours()).slice(-2) + 'h' + ('0' + d.getMinutes()).slice(-2));
    var quoi = '<span class="badge ' + l.circuit + '">' + l.circuit + '</span>' + esc(String(l.quoi).slice(0, 150));
    if (l.vers) quoi += '<span class="fleche">→</span><span class="vers">' + esc(String(l.vers).slice(0, 90)) + '</span>';
    return '<div class="ligne ' + l.categorie + '">' +
      '<div class="lh"><div class="quoi">' + quoi + '</div>' +
      '<div class="meta">' + esc(quand) + (l.qui ? ' · ' + esc(l.qui) : '') + '</div></div>' +
      '<div class="etat">' + esc(l.etat) + '</div>' +
      (l.raison ? '<div class="raison">' + esc(l.raison) + '</div>' : '') +
      (l.lecon ? '<div class="lecon">' + esc(l.lecon) + '</div>' : '') +
      '</div>';
  }).join('');
}

document.getElementById('periode').addEventListener('change', charger);
document.getElementById('personne').addEventListener('change', function () { qui = this.value; rendre(); });
charger();
