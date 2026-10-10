/* Calcul des estimations de prières à rattraper.
   Fonctions pures : aucun accès au DOM, aucune donnée enregistrée.
   Elles servent uniquement à proposer un nombre de départ que l'utilisateur peut corriger. */
(function (root) {
'use strict';

var MAX_DAYS = 36500; // 100 ans : au-delà, on considère que c'est une erreur de saisie

/* Fréquences proposées (nombre de prières manquées, par semaine) — affichées telles quelles à l'utilisateur */
var FREQS = [
  { k: 'daily',   label: 'Tous les jours',               perWeek: 7,    hint: '7 par semaine' },
  { k: 'often',   label: 'Plusieurs fois par semaine',   perWeek: 4,    hint: '≈ 4 par semaine' },
  { k: 'weekly',  label: 'Environ une fois par semaine', perWeek: 1,    hint: '≈ 1 par semaine' },
  { k: 'monthly', label: 'Quelques fois par mois',       perWeek: 0.5,  hint: '≈ 2 par mois' },
  { k: 'rare',    label: 'Occasionnellement',            perWeek: 0.25, hint: '≈ 1 par mois' }
];
function freqOf(k) { for (var i = 0; i < FREQS.length; i++) if (FREQS[i].k === k) return FREQS[i]; return null; }

function valid(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k || '') && !isNaN(parse(k).getTime()); }
function parse(k) { var p = String(k).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function diffDays(a, b) { return Math.round((b - a) / 86400000); }
function fmtD(d) { return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
function nf(n) { return Math.round(n).toLocaleString('fr-FR'); }

/* Règle de comptage : une date de fin choisie est comptée dans la période ;
   « aujourd'hui » n'est pas compté, car la journée n'est pas terminée. */

/* Marge de précaution (en %, entier) : arrondie à l'entier supérieur */
function applyMargin(n, margin) {
  var m = Math.max(0, Math.min(100, Math.round(Number(margin) || 0)));
  return Math.ceil((n * (100 + m)) / 100 - 1e-9);
}

/* Période décrite par c = { startMode:'date'|'age'|'duration', startDate, birthDate, startAge,
   endMode:'today'|'date', endDate, years, months }  →  { from, to, days } ou { error } */
function resolveRange(c, today) {
  c = c || {};
  if (c.startMode === 'duration') {
    var y = Math.max(0, Number(c.years) || 0), m = Math.max(0, Number(c.months) || 0);
    var dd = Math.round(y * 365.25 + m * 30.4375);
    if (dd <= 0) return { error: 'Indique une durée supérieure à 0.' };
    if (dd > MAX_DAYS) return { error: 'La période est trop longue : vérifie ta saisie.' };
    return { from: null, to: null, days: dd, mode: 'duration' };
  }
  var to;
  if (c.endMode === 'date') {
    if (!valid(c.endDate)) return { error: 'Choisis la date de fin.' };
    to = parse(c.endDate);
  } else to = today;
  var from;
  if (c.startMode === 'age') {
    if (!valid(c.birthDate)) return { error: 'Indique ta date de naissance.' };
    var age = Math.round(Number(c.startAge));
    if (c.startAge === '' || c.startAge == null || !isFinite(age) || age < 0 || age > 120) return { error: 'Indique l’âge de début.' };
    var b = parse(c.birthDate);
    from = new Date(b.getFullYear() + age, b.getMonth(), b.getDate());
  } else {
    if (!valid(c.startDate)) return { error: 'Choisis la date de début.' };
    from = parse(c.startDate);
  }
  if (from > to) return { error: 'La date de début doit être avant la date de fin.' };
  var d = diffDays(from, to);
  if (c.endMode === 'date') d += 1; // date de fin choisie : ce jour-là fait partie de la période
  if (d <= 0) return { error: 'La période est vide : vérifie les dates.' };
  if (d > MAX_DAYS) return { error: 'La période est trop longue : vérifie les dates.' };
  return { from: from, to: to, days: d, mode: c.startMode === 'age' ? 'age' : 'date' };
}

function rangeText(r) {
  if (r.mode === 'duration') return 'Durée indiquée : ' + nf(r.days) + ' jours';
  return 'Du ' + fmtD(r.from) + ' au ' + fmtD(r.to) + ' : ' + nf(r.days) + ' jours';
}

/* Méthode classique : même nombre pour chaque prière */
function calcClassic(start, share, margin, today) {
  var r = resolveRange(start, today);
  if (r.error) return { error: r.error };
  var sh = Math.min(100, Math.max(1, Math.round(Number(share)) || 100));
  var base = Math.round(r.days * sh / 100);
  var total = applyMargin(base, margin);
  var lines = [rangeText(r)];
  if (sh < 100) lines.push('Part de prières manquées : ' + sh + ' %  →  ' + nf(base));
  if (margin > 0) lines.push('Marge de précaution : +' + margin + ' %  →  ' + nf(total));
  var short = nf(r.days) + ' jours' + (sh < 100 ? ' × ' + sh + ' %' : '') + (margin > 0 ? ' + ' + margin + ' %' : '');
  return { days: r.days, base: base, total: total, lines: lines, short: short, range: r };
}

/* Méthode personnalisée : une prière.
   p = { kind:'none'|'count'|'freq'|'periods', freq, count, periods:[{from,to,freq}] }
   range = résultat de resolveRange pour la période de départ (peut contenir error) */
function calcPrayer(p, range, margin, today) {
  p = p || {};
  if (p.kind === 'none') return { n: 0, short: 'rien à rattraper', lines: ['Rien à rattraper pour cette prière.'] };
  if (p.kind === 'count') {
    var c = Math.round(Number(p.count));
    if (p.count === '' || p.count == null || !isFinite(c) || c < 0) return { error: 'Indique un nombre.' };
    var n = applyMargin(Math.min(c, 1000000), margin);
    return { n: n, short: nf(c) + ' indiqué' + (margin > 0 ? ' + ' + margin + ' %' : ''), lines: ['Nombre indiqué : ' + nf(c) + (margin > 0 ? '  →  ' + nf(n) + ' avec la marge' : '')] };
  }
  var parts = [], lines = [], raw = 0, i;
  if (p.kind === 'periods') {
    var list = p.periods || [];
    if (!list.length) return { error: 'Ajoute au moins une période.' };
    for (i = 0; i < list.length; i++) {
      var q = list[i], f = freqOf(q.freq);
      if (!f) return { error: 'Choisis une fréquence pour chaque période.' };
      if (!valid(q.from)) return { error: 'Choisis la date de début de chaque période.' };
      var from = parse(q.from), to = q.to ? (valid(q.to) ? parse(q.to) : null) : today;
      if (!to) return { error: 'Date de fin invalide.' };
      if (from > to) return { error: 'Dans une période, le début doit précéder la fin.' };
      var d = diffDays(from, to);
      if (q.to) d += 1; // date de fin indiquée : ce jour-là fait partie de la période
      if (d > MAX_DAYS) return { error: 'Une période est trop longue.' };
      raw += d * f.perWeek / 7;
      lines.push(nf(d) + ' jours, ' + f.label.toLowerCase() + ' (' + f.hint + ')');
      parts.push(nf(d) + ' j');
    }
  } else {
    var fq = freqOf(p.freq);
    if (!fq) return { error: 'Choisis une fréquence.' };
    if (!range || range.error) return { error: (range && range.error) || 'Indique la période.' };
    raw = range.days * fq.perWeek / 7;
    lines.push(nf(range.days) + ' jours, ' + fq.label.toLowerCase() + ' (' + fq.hint + ')');
    parts.push(nf(range.days) + ' j');
  }
  var base = Math.round(raw);
  var total = applyMargin(base, margin);
  lines.push('Estimation : ' + nf(base) + (margin > 0 ? '  →  ' + nf(total) + ' avec la marge de ' + margin + ' %' : ''));
  return { n: total, short: parts.join(' + ') + ' → ' + nf(base) + (margin > 0 ? ' + ' + margin + ' %' : ''), lines: lines };
}

root.QadaEstimate = {
  FREQS: FREQS, freqOf: freqOf, valid: valid, parse: parse, applyMargin: applyMargin,
  resolveRange: resolveRange, calcClassic: calcClassic, calcPrayer: calcPrayer, MAX_DAYS: MAX_DAYS
};
if (typeof module !== 'undefined' && module.exports) module.exports = root.QadaEstimate;
})(typeof window !== 'undefined' ? window : globalThis);
