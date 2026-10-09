(function () {
'use strict';

/* ---------- Données de base ---------- */
var PRAYERS = [
  { k: 'fajr',    n: 'Fajr' },
  { k: 'zohr',    n: 'Zohr' },
  { k: 'asr',     n: 'Asr' },
  { k: 'maghreb', n: 'Maghreb' },
  { k: 'icha',    n: 'Icha' },
  { k: 'witr',    n: 'Witr' }
];
var COLORS = PRAYERS.map(function (p) { return 'var(--c-' + p.k + ')'; });
var NF = new Intl.NumberFormat('fr-FR');
var RATES = [1, 2, 3, 4, 5, 10];

var $ = function (s) { return document.querySelector(s); };
var esc = function (s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var zeros = function () { return PRAYERS.map(function () { return 0; }); };
var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
var fmt = function (n) { return NF.format(Math.round(n)); };

/* ---------- Dates ---------- */
var pad = function (n) { return String(n).padStart(2, '0'); };
var dkey = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
var startOfToday = function () { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
var todayKey = function () { return dkey(new Date()); };
var parseKey = function (k) { var p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
var addDays = function (d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); };
var fmtDate = function (d) { return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); };
var fmtDay = function (k) { return parseKey(k).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };

function span(from, to) {
  var y = to.getFullYear() - from.getFullYear();
  var m = to.getMonth() - from.getMonth();
  var d = to.getDate() - from.getDate();
  if (d < 0) { m--; d += new Date(to.getFullYear(), to.getMonth(), 0).getDate(); }
  if (m < 0) { y--; m += 12; }
  return { y: y, m: m, d: d };
}
function fmtSpan(s) {
  var parts = [];
  if (s.y) parts.push(s.y + (s.y > 1 ? ' ans' : ' an'));
  if (s.m) parts.push(s.m + ' mois');
  if (!s.y && s.m < 3 && s.d) parts.push(s.d + (s.d > 1 ? ' jours' : ' jour'));
  return parts.join(' ') || "aujourd\u2019hui";
}
function pctFmt(p) { return (Math.round(p * 10) / 10).toLocaleString('fr-FR') + '\u00A0%'; }

/* ---------- État ---------- */
var state = null;          // { v, cfg:{totals,on,since}, days:{'YYYY-MM-DD':[6]}, updatedAt }
var view = 'log';
var sheet = null;
var loading = false;
var sync = 'local';        // local | connecting | synced | saving | error
var authMode = 'login', authMsg = null, bootError = false, bootMsg = '', busy = false, baseAt = 0, lastPull = 0;
var customRate = 7;
var histLimit = 60;
var saveTimer = null, retryTimer = null, saving = false, dirty = false;
var toastTimer = null, toastFn = null;
var lastAll = null;

function normalize(o) {
  if (!o || typeof o !== 'object' || !o.cfg || typeof o.cfg.totals !== 'object' || !o.cfg.totals) return null;
  var totals = {}, on = {};
  PRAYERS.forEach(function (p) {
    var t = Math.round(Number(o.cfg.totals[p.k]));
    totals[p.k] = isFinite(t) && t >= 0 ? t : 0;
    on[p.k] = !(o.cfg.on && o.cfg.on[p.k] === false);
  });
  var days = {};
  var src = o.days && typeof o.days === 'object' ? o.days : {};
  Object.keys(src).forEach(function (k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !Array.isArray(src[k])) return;
    var row = PRAYERS.map(function (_, i) { var v = Math.round(Number(src[k][i])); return isFinite(v) && v > 0 ? v : 0; });
    if (row.some(function (v) { return v > 0; })) days[k] = row;
  });
  return {
    v: 1,
    cfg: { totals: totals, on: on, since: typeof o.cfg.since === 'string' ? o.cfg.since : todayKey() },
    days: days,
    updatedAt: Number(o.updatedAt) || 0
  };
}
/* ---------- Compte Supabase (Auth + REST, sans bibliothèque) ---------- */
var CFG = window.QADA_CONFIG || {};
var SESSION_KEY = 'qada-session';
var uid = null, userEmail = '', session = null, pulling = false, refreshing = null;

function configOk() {
  var u = CFG.SUPABASE_URL || '', k = CFG.SUPABASE_ANON_KEY || '';
  return /^https:\/\/.+/.test(u) && !!k && !/VOTRE/.test(u + k);
}
function isNetErr(e) { return !e || e.status === undefined; }

function http(method, path, body, token, extra) {
  var headers = { 'apikey': CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
  return fetch(CFG.SUPABASE_URL + path, {
    method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) {
    return res.text().then(function (t) {
      var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
      if (!res.ok) {
        var err = new Error((j && (j.msg || j.error_description || j.message || j.error)) || ('HTTP ' + res.status));
        err.status = res.status; err.body = j;
        throw err;
      }
      return j;
    });
  });
}

function readSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } }
function storeSession(s) {
  session = s;
  try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function toSession(d) {
  var user = d.user ? { id: d.user.id, email: d.user.email } : (session && session.user) || null;
  return {
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600)),
    user: user
  };
}
function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token }).then(function (d) {
    refreshing = null; storeSession(toSession(d));
  }, function (e) {
    refreshing = null;
    if (e.status === 400 || e.status === 401 || e.status === 403) e.authLost = true;
    throw e;
  });
  return refreshing;
}
function authed(method, path, body, extra) {
  var go = function () { return http(method, path, body, session.access_token, extra); };
  var stale = session.expires_at - Date.now() / 1000 < 60;
  return (stale ? refreshSession() : Promise.resolve()).then(go).then(null, function (e) {
    if (e.status === 401 && !stale && !e.authLost) {
      return refreshSession().then(go).then(null, function (e2) { if (e2.status === 401) e2.authLost = true; throw e2; });
    }
    throw e;
  });
}
function expireSession() {
  storeSession(null); state = null; loading = false; sheet = null; uid = null;
  authMode = 'login'; authMsg = { t: 'Ta session a expiré. Reconnecte-toi : tes données sont gardées.', err: true };
  render();
}
function frErr(e) {
  var m = ((e && e.message) || '').toLowerCase();
  if (isNetErr(e)) return 'Pas de connexion internet.';
  if (m.indexOf('invalid login') >= 0) return 'Email ou mot de passe incorrect.';
  if (m.indexOf('not confirmed') >= 0) return 'Confirme d’abord ton adresse email (lien reçu par mail).';
  if (m.indexOf('already registered') >= 0) return 'Un compte existe déjà avec cet email.';
  if (m.indexOf('password') >= 0 && (m.indexOf('least') >= 0 || m.indexOf('short') >= 0 || m.indexOf('weak') >= 0 || m.indexOf('characters') >= 0)) return 'Mot de passe trop faible (6 caractères minimum).';
  if (m.indexOf('same password') >= 0 || m.indexOf('different from the old') >= 0) return 'Choisis un mot de passe différent de l’ancien.';
  if (m.indexOf('rate limit') >= 0 || e.status === 429) return 'Trop de tentatives. Réessaie dans quelques minutes.';
  if (m.indexOf('email') >= 0 && (m.indexOf('valid') >= 0 || m.indexOf('invalid') >= 0)) return 'Adresse email invalide.';
  return 'Une erreur est survenue (' + (e.message || e.status) + ').';
}

/* ---------- Stockage local (par compte) ---------- */
function lsKey() { return 'qada-v1:' + uid; }
function loadLocal() {
  try { var raw = localStorage.getItem(lsKey()); return raw ? normalize(JSON.parse(raw)) : null; } catch (e) { return null; }
}
function saveLocal() {
  try { if (state) localStorage.setItem(lsKey(), JSON.stringify(state)); else localStorage.removeItem(lsKey()); } catch (e) {}
}
function setDirty(v) {
  dirty = v;
  try { if (v) localStorage.setItem('qada-dirty:' + uid, '1'); else localStorage.removeItem('qada-dirty:' + uid); } catch (e) {}
}
function setBase(v) {
  baseAt = v;
  try { localStorage.setItem('qada-base:' + uid, String(v)); } catch (e) {}
}
function commit() {
  state.updatedAt = Date.now();
  saveLocal();
  queueSave();
  render();
}

/* ---------- Synchronisation ---------- */
function syncText() {
  return {
    local: 'Enregistré sur cet appareil uniquement.',
    connecting: 'Connexion en cours…',
    synced: 'Synchronisé : tu retrouves tes données sur tes autres appareils.',
    saving: 'Enregistrement…',
    offline: 'Hors ligne : tes changements sont gardés ici et seront envoyés au retour de la connexion.',
    error: 'L’envoi en ligne a échoué pour l’instant. Tes données restent sur cet appareil et on réessaie.'
  }[sync];
}
function setSync(s) {
  sync = s;
  var el = $('#sync-label');
  if (el) el.textContent = syncText();
}
function queueSave() {
  setDirty(true);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 700);
  setSync(navigator.onLine ? 'saving' : 'offline');
}
function flush() {
  if (saving || !dirty || !session || !state) return Promise.resolve();
  if (!navigator.onLine) { setSync('offline'); return Promise.resolve(); }
  saving = true;
  var at = state.updatedAt;
  var payload = JSON.parse(JSON.stringify(state));
  return authed('POST', '/rest/v1/qada_state?on_conflict=user_id',
    { user_id: uid, data: payload, updated_at: new Date().toISOString() },
    { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
  ).then(function () {
    saving = false;
    setBase(at);
    if (state && state.updatedAt !== at) { return flush(); }
    setDirty(false); setSync('synced');
  }, function (e) {
    saving = false;
    if (e.authLost) return expireSession();
    setSync(isNetErr(e) ? 'offline' : 'error');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { if (dirty) flush(); }, 10000);
  });
}
function mergeStates(local, remote) {
  var m = { v: 1, cfg: remote.updatedAt >= local.updatedAt ? remote.cfg : local.cfg, days: {}, updatedAt: Date.now() };
  var keys = {};
  Object.keys(local.days).concat(Object.keys(remote.days)).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).forEach(function (k) {
    var x = local.days[k] || zeros(), y = remote.days[k] || zeros();
    m.days[k] = x.map(function (v, i) { return Math.max(v, y[i]); });
  });
  return m;
}
function netDown() {
  setSync('offline');
  if (!state && session) {
    loading = false; bootError = true;
    bootMsg = 'Impossible de joindre le serveur. Vérifie ta connexion internet.';
    render();
  }
}
function pull() {
  if (!session || !uid || pulling || saving) return Promise.resolve();
  if (!navigator.onLine) { netDown(); return Promise.resolve(); }
  pulling = true; lastPull = Date.now();
  return authed('GET', '/rest/v1/qada_state?select=data&user_id=eq.' + encodeURIComponent(uid)).then(function (rows) {
    pulling = false;
    var remote = rows && rows[0] ? normalize(rows[0].data) : null;
    var changed = loading || bootError;
    if (remote && !state) {
      state = remote; saveLocal(); setDirty(false); setBase(remote.updatedAt); changed = true;
    } else if (remote && state) {
      if (dirty) {
        if (remote.updatedAt !== baseAt && remote.updatedAt !== state.updatedAt) {
          state = mergeStates(state, remote); saveLocal(); changed = true;
        }
      } else if (remote.updatedAt > state.updatedAt) {
        state = remote; saveLocal(); setBase(remote.updatedAt); changed = true;
      } else if (remote.updatedAt < state.updatedAt) {
        setDirty(true);
      } else {
        setBase(remote.updatedAt);
      }
    } else if (!remote && state) {
      setDirty(true);
    }
    loading = false; bootError = false;
    if (changed) render();
    if (dirty) return flush();
    setSync('synced');
  }, function (e) {
    pulling = false;
    if (e.authLost) return expireSession();
    var net = isNetErr(e);
    setSync(net ? 'offline' : 'error');
    if (!state) {
      loading = false; bootError = true;
      bootMsg = net ? 'Impossible de joindre le serveur. Vérifie ta connexion internet.' : 'Erreur du serveur (' + e.message + '). Vérifie que la table a bien été créée (fichier supabase.sql).';
      render();
    }
  });
}

/* ---------- Connexion / inscription ---------- */
function enterApp() {
  uid = session.user.id; userEmail = session.user.email || '';
  state = loadLocal();
  try {
    dirty = localStorage.getItem('qada-dirty:' + uid) === '1';
    baseAt = Number(localStorage.getItem('qada-base:' + uid)) || 0;
  } catch (e) { dirty = false; baseAt = 0; }
  loading = !state; bootError = false; view = 'log'; sheet = null; authMode = 'login'; authMsg = null;
  setSync(navigator.onLine ? 'connecting' : 'offline');
  render();
  pull();
}
function setAuthMsg(t, err) {
  var el = $('#au-msg');
  if (!el) return;
  el.textContent = t; el.className = 'auth-msg' + (err ? ' err' : '');
}
function setBusy(b) {
  busy = b;
  var btn = $('#au-go'); if (btn) btn.disabled = b;
}
function submitAuth() {
  if (busy) return;
  var mode = authMode;
  var email = (($('#au-e') || {}).value || '').trim();
  var pw = ($('#au-p') || {}).value || '';
  var fail = function (e) { setBusy(false); setAuthMsg(frErr(e), true); };
  if (mode !== 'newpass' && !/^\S+@\S+\.\S+$/.test(email)) { setAuthMsg('Entre une adresse email valide.', true); return; }
  if (mode === 'login' && !pw) { setAuthMsg('Entre ton mot de passe.', true); return; }
  if ((mode === 'signup' || mode === 'newpass') && pw.length < 6) { setAuthMsg('Le mot de passe doit faire au moins 6 caractères.', true); return; }
  setBusy(true); setAuthMsg('', false);
  if (mode === 'login') {
    http('POST', '/auth/v1/token?grant_type=password', { email: email, password: pw }).then(function (d) {
      setBusy(false); storeSession(toSession(d)); enterApp();
    }, fail);
  } else if (mode === 'signup') {
    http('POST', '/auth/v1/signup', { email: email, password: pw }).then(function (d) {
      setBusy(false);
      if (d && d.access_token) { storeSession(toSession(d)); enterApp(); }
      else {
        authMode = 'login';
        authMsg = { t: 'Compte créé. Ouvre le mail de confirmation que tu viens de recevoir, puis connecte-toi.', err: false };
        render();
      }
    }, fail);
  } else if (mode === 'forgot') {
    http('POST', '/auth/v1/recover', { email: email }).then(function () {
      setBusy(false); authMode = 'login';
      authMsg = { t: 'Si un compte existe avec cet email, un lien de réinitialisation vient d’être envoyé.', err: false };
      render();
    }, fail);
  } else if (mode === 'newpass') {
    authed('PUT', '/auth/v1/user', { password: pw }).then(function () { setBusy(false); enterApp(); }, fail);
  }
}
function handleHash() {
  var h = location.hash.replace(/^#/, '');
  if (!/access_token=|error_description=/.test(h)) return false;
  var p = new URLSearchParams(h);
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  if (p.get('error_description')) { authMsg = { t: p.get('error_description'), err: true }; return false; }
  var s = {
    access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || (Math.floor(Date.now() / 1000) + (Number(p.get('expires_in')) || 3600)),
    user: null
  };
  var type = p.get('type');
  http('GET', '/auth/v1/user', undefined, s.access_token).then(function (u) {
    s.user = { id: u.id, email: u.email };
    storeSession(s);
    if (type === 'recovery') {
      uid = null; authMode = 'newpass'; authMsg = { t: 'Choisis un nouveau mot de passe.', err: false }; render();
    } else enterApp();
  }, function (e) { authMsg = { t: frErr(e), err: true }; render(); });
  return true;
}
function logout() {
  var finish = function () {
    clearTimeout(saveTimer); clearTimeout(retryTimer);
    storeSession(null); state = null; uid = null; sheet = null; loading = false;
    authMode = 'login'; authMsg = null; view = 'log';
    render();
  };
  if (dirty && session && navigator.onLine) {
    flush().then(function () {
      if (!dirty) finish(); else askLogout(finish);
    });
  } else if (dirty) askLogout(finish);
  else finish();
}
function askLogout(finish) {
  openSheet({ type: 'confirm', title: 'Se déconnecter ?', danger: false, yes: 'Se déconnecter',
    text: 'Des modifications ne sont pas encore envoyées en ligne. Elles restent sur cet appareil et seront envoyées à ta prochaine connexion avec ce compte.',
    onYes: finish });
}

function viewAuth() {
  var m = authMode;
  var title = { login: 'Connexion', signup: 'Créer un compte', forgot: 'Mot de passe oublié', newpass: 'Nouveau mot de passe' }[m];
  var intro = {
    login: 'Connecte-toi pour retrouver tes données sur cet appareil.',
    signup: 'Ton compte garde tes données en ligne : tu pourras les retrouver sur n’importe quel appareil.',
    forgot: 'Entre ton email : tu recevras un lien pour choisir un nouveau mot de passe.',
    newpass: 'Choisis un nouveau mot de passe (6 caractères minimum).'
  }[m];
  var emailF = m === 'newpass' ? '' :
    '<label class="field"><span>Email</span><input id="au-e" type="email" autocomplete="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false"></label>';
  var pwF = m === 'forgot' ? '' :
    '<label class="field" style="margin-top:10px"><span>' + (m === 'newpass' ? 'Nouveau mot de passe' : 'Mot de passe') + '</span>' +
    '<input id="au-p" type="password" autocomplete="' + (m === 'login' ? 'current-password' : 'new-password') + '"></label>';
  var go = { login: 'Se connecter', signup: 'Créer mon compte', forgot: 'Envoyer le lien', newpass: 'Enregistrer' }[m];
  var msg = '<p class="auth-msg' + (authMsg && authMsg.err ? ' err' : '') + '" id="au-msg">' + (authMsg ? esc(authMsg.t) : '') + '</p>';
  var links = m === 'login'
    ? '<button class="link" data-act="auth-mode" data-mode="signup">Créer un compte</button><button class="link" data-act="auth-mode" data-mode="forgot">Mot de passe oublié</button>'
    : (m === 'newpass' ? '' : '<button class="link" data-act="auth-mode" data-mode="login">Retour à la connexion</button>');
  return '<section class="setup"><h1 class="setup-h">' + title + '</h1><p class="note">' + intro + '</p>' +
    '<form id="auth-form" novalidate>' + emailF + pwF + msg +
    '<button class="btn primary wide" id="au-go" type="submit">' + go + '</button></form>' + links + '</section>';
}
function viewBootError() {
  return '<section class="setup"><h1 class="setup-h">Données introuvables pour l’instant</h1>' +
    '<p class="note">' + esc(bootMsg) + ' Tes données en ligne ne sont pas touchées.</p>' +
    '<button class="btn primary wide" data-act="retry">Réessayer</button>' +
    '<button class="link" data-act="logout">Se déconnecter</button></section>';
}
function viewConfig() {
  return '<section class="setup"><h1 class="setup-h">Configuration manquante</h1>' +
    '<p class="note">Renseigne SUPABASE_URL et SUPABASE_ANON_KEY dans le fichier config.js (voir README).</p></section>';
}

/* ---------- Calculs ---------- */
function isOn(i) { return state.cfg.on[PRAYERS[i].k] !== false; }
function activeIdx() { return PRAYERS.map(function (_, i) { return i; }).filter(isOn); }

function stats() {
  var todayRow = state.days[todayKey()] || zeros();
  var items = PRAYERS.map(function (p, i) {
    var done = 0;
    for (var k in state.days) done += state.days[k][i] || 0;
    var total = state.cfg.totals[p.k] || 0;
    return { i: i, n: p.n, on: isOn(i), total: total, done: done, rest: Math.max(0, total - done), extra: Math.max(0, done - total), today: todayRow[i] || 0 };
  });
  var act = items.filter(function (x) { return x.on; });
  var sumTotal = sum(act.map(function (x) { return x.total; }));
  var sumRest = sum(act.map(function (x) { return x.rest; }));
  var counted = sumTotal - sumRest;
  return {
    items: items, act: act, sumTotal: sumTotal, sumRest: sumRest, counted: counted,
    pct: sumTotal ? counted / sumTotal * 100 : 0,
    maxRest: act.reduce(function (a, x) { return Math.max(a, x.rest); }, 0)
  };
}
function histRows() {
  var idx = activeIdx();
  return Object.keys(state.days).map(function (k) {
    var row = state.days[k];
    return { k: k, row: row, s: sum(idx.map(function (i) { return row[i]; })) };
  }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return a.k < b.k ? 1 : -1; });
}
function streakOf(rows) {
  var has = {}; rows.forEach(function (r) { has[r.k] = true; });
  var d = startOfToday();
  if (!has[dkey(d)]) d = addDays(d, -1);
  var n = 0;
  while (has[dkey(d)]) { n++; d = addDays(d, -1); }
  return n;
}
function paceOf(rows, st) {
  if (!rows.length || !st.act.length) return null;
  var first = parseKey(rows[rows.length - 1].k);
  var today = startOfToday();
  var since = Math.round((today - first) / 86400000) + 1;
  var win = Math.max(1, Math.min(14, since));
  var total = 0;
  for (var j = 0; j < win; j++) {
    var a = state.days[dkey(addDays(today, -j))];
    if (a) st.act.forEach(function (x) { total += a[x.i] || 0; });
  }
  if (!total) return null;
  return { win: win, rate: total / win / st.act.length };
}
function planCalc(perDay, maxRest) {
  var days = Math.ceil(maxRest / perDay);
  if (!isFinite(days) || days > 36500) return { span: 'plus de 100 ans', date: '\u2014' };
  var from = startOfToday();
  var end = addDays(from, days);
  return { span: fmtSpan(span(from, end)), date: fmtDate(end) };
}

/* ---------- Vues ---------- */
function headerHtml() {
  var t = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return '<header class="top"><h1>Rattrapage</h1><time>' + esc(t) + '</time></header>';
}

function arcPath(cx, cy, r, a0, a1) {
  var p = function (a) { return [cx + r * Math.cos(a * Math.PI / 180), cy - r * Math.sin(a * Math.PI / 180)]; };
  var s = p(a0), e = p(a1);
  return 'M' + s[0].toFixed(2) + ' ' + s[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 0 1 ' + e[0].toFixed(2) + ' ' + e[1].toFixed(2);
}
function arcSvg(st) {
  var n = st.act.length;
  if (!n) return '';
  var span180 = 180 / n, gap = n > 1 ? 2.6 : 0, out = '';
  st.act.forEach(function (x, idx) {
    var d = arcPath(160, 160, 138, 180 - idx * span180 - gap / 2, 180 - (idx + 1) * span180 + gap / 2);
    var pct = x.total ? Math.min(100, x.done / x.total * 100) : 100;
    out += '<path class="arc-track" d="' + d + '" pathLength="100"/>';
    if (pct > 0) out += '<path class="arc-fill" d="' + d + '" pathLength="100" style="stroke:' + COLORS[x.i] + '" stroke-dasharray="' + pct.toFixed(3) + ' 100"/>';
  });
  return '<svg viewBox="0 0 320 172" role="img" aria-label="Progression de chaque prière">' + out + '</svg>';
}

function rowHtml(x) {
  var pct = x.total ? Math.min(100, x.done / x.total * 100) : 100;
  var restHtml;
  if (x.total === 0) restHtml = '<span class="fin">Objectif à 0</span>';
  else if (x.rest === 0) restHtml = '<span class="fin">Terminé</span>';
  else restHtml = '<span class="num">' + fmt(x.rest) + '</span><span class="lbl">' + (x.rest > 1 ? 'restantes' : 'restante') + '</span>';
  var meta = '<b>' + fmt(Math.min(x.done, x.total)) + '</b> faites sur ' + fmt(x.total) +
    (x.extra ? ' \u00B7 +' + fmt(x.extra) + ' en plus' : '') +
    ' \u00B7 aujourd\u2019hui <b>' + x.today + '</b>';
  return '<li class="row" style="--c:' + COLORS[x.i] + '">' +
    '<div class="row-name">' + x.n + '</div>' +
    '<div class="row-rest">' + restHtml + '</div>' +
    '<div class="bar"><i style="width:' + pct.toFixed(2) + '%"></i></div>' +
    '<div class="row-meta">' + meta + '</div>' +
    '<div class="row-act">' +
      '<button class="minus" data-act="dec" data-i="' + x.i + '" aria-label="Retirer 1 ' + x.n + '"' + (x.today <= 0 ? ' disabled' : '') + '>\u2212</button>' +
      '<button class="plus" data-act="inc" data-i="' + x.i + '" aria-label="Ajouter 1 ' + x.n + '">+1</button>' +
    '</div></li>';
}

function viewLog() {
  var st = stats();
  if (!st.act.length) {
    return '<p class="empty">Aucune prière n\u2019est comptée pour l\u2019instant. Active-en une dans les réglages.</p>';
  }
  var cap = st.sumRest === 0 ? 'objectif atteint' : (st.sumRest > 1 ? 'prières restantes' : 'prière restante');
  return '<section class="hero" aria-label="Progression globale">' +
    '<div class="arc">' + arcSvg(st) +
      '<div class="arc-text"><div class="big">' + fmt(st.sumRest) + '</div><div class="cap">' + cap + '</div></div></div>' +
    '<p class="hero-sub">' + fmt(st.counted) + ' faites sur ' + fmt(st.sumTotal) + ' \u00B7 ' + pctFmt(st.pct) + '</p>' +
    '<div class="hero-actions">' +
      '<button class="btn primary" data-act="inc-all">+1 de chaque</button>' +
      '<button class="btn ghost" data-act="open-day">Autre jour</button>' +
    '</div></section>' +
    '<ul class="rows">' + st.act.map(rowHtml).join('') + '</ul>';
}

function planRight(c) { return '<div class="plan-dur">' + esc(c.span) + '</div><div class="plan-date">' + esc(c.date) + '</div>'; }
function planSub(r, n) { var t = r * n; return 'de chaque pr\u00E8re'.replace('pr\u00E8re', 'pri\u00E8re') + ' (' + fmt(t) + ' au total)'; }

function viewPlan() {
  var st = stats();
  var head = '<h2 class="h2">Date de fin estimée</h2>';
  if (!st.act.length) return head + '<p class="empty">Aucune prière n\u2019est comptée pour l\u2019instant. Active-en une dans les réglages.</p>';
  if (st.maxRest === 0) {
    return head + '<div class="done"><div class="done-big">Objectif atteint</div><p>Tout est rattrapé. Si tu veux continuer, augmente un objectif dans les réglages.</p></div>';
  }
  var n = st.act.length;
  var worst = st.act.reduce(function (a, x) { return x.rest > a.rest ? x : a; }, st.act[0]);
  var pace = paceOf(histRows(), st);
  var paceHtml = '';
  if (pace && pace.rate > 0) {
    var pc = planCalc(pace.rate, st.maxRest);
    var rr = pace.rate.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    paceHtml = '<div class="pace"><div><div class="pace-t">À ton rythme actuel</div>' +
      '<div class="pace-s">\u2248 ' + rr + ' par prière et par jour (' + pace.win + (pace.win > 1 ? ' derniers jours' : ' dernier jour') + ')</div></div>' +
      '<div class="plan-right">' + planRight(pc) + '</div></div>';
  }
  var rows = RATES.map(function (r) {
    return '<li class="plan-row"><div><div class="plan-rate">' + r + ' par jour</div><div class="plan-sub">' + planSub(r, n) + '</div></div>' +
      '<div class="plan-right">' + planRight(planCalc(r, st.maxRest)) + '</div></li>';
  }).join('');
  var custom = '<li class="plan-row"><div><div class="plan-rate">Autre rythme</div>' +
    '<div class="rate-in"><input id="rate" type="number" inputmode="numeric" min="1" max="1000" value="' + customRate + '" aria-label="Prières par jour pour chaque prière"> par jour</div>' +
    '<div class="plan-sub" id="custom-sub">' + planSub(customRate, n) + '</div></div>' +
    '<div class="plan-right" id="custom-out">' + planRight(planCalc(customRate, st.maxRest)) + '</div></li>';
  return head +
    '<p class="note">Si tu rattrapes chaque jour le même nombre de chaque prière. Le calcul suit la prière la plus en retard : ' +
    worst.n + ', ' + fmt(worst.rest) + ' restantes.</p>' +
    paceHtml + '<ul class="plan">' + rows + custom + '</ul>';
}

function viewHist() {
  var rows = histRows();
  var total = sum(rows.map(function (r) { return r.s; }));
  var shown = rows.slice(0, histLimit);
  var list;
  if (!rows.length) {
    list = '<p class="empty">Rien pour l\u2019instant. Chaque prière rattrapée apparaîtra ici, jour par jour.</p>';
  } else {
    var act = activeIdx();
    list = '<ul class="days">' + shown.map(function (r) {
      var chips = act.filter(function (i) { return r.row[i] > 0; }).map(function (i) {
        return '<span class="chip" style="--c:' + COLORS[i] + '"><i></i>' + PRAYERS[i].n + ' ' + r.row[i] + '</span>';
      }).join('');
      return '<li><button class="day" data-act="open-day" data-date="' + r.k + '">' +
        '<span class="day-date">' + esc(fmtDay(r.k)) + '</span><span class="day-sum">' + r.s + '</span>' +
        '<span class="day-chips">' + chips + '</span></button></li>';
    }).join('') + '</ul>' +
    (rows.length > shown.length ? '<button class="btn ghost more" data-act="more-days">Voir plus de jours</button>' : '');
  }
  return '<div class="sum">' +
    '<div><b>' + fmt(total) + '</b><span>prières faites</span></div>' +
    '<div><b>' + fmt(rows.length) + '</b><span>jours actifs</span></div>' +
    '<div><b>' + streakOf(rows) + '</b><span>jours d\u2019affilée</span></div></div>' +
    '<div class="hist-head"><h2 class="h2">Jour par jour</h2><button class="btn ghost" data-act="open-day">Ajouter un jour</button></div>' + list;
}

function viewSet() {
  var st = stats();
  var rows = st.items.map(function (x) {
    return '<li class="set-row' + (x.on ? '' : ' off') + '" style="--c:' + COLORS[x.i] + '">' +
      '<label class="chk"><input type="checkbox" data-act="toggle" data-i="' + x.i + '"' + (x.on ? ' checked' : '') + ' aria-label="Compter ' + x.n + '"></label>' +
      '<div class="set-name">' + x.n + '<small>' + fmt(x.done) + ' faites</small></div>' +
      '<input class="num-in" type="number" inputmode="numeric" min="0" step="1" data-act="total" data-i="' + x.i + '" value="' + x.total + '" aria-label="Objectif ' + x.n + '">' +
      '</li>';
  }).join('');
  return '<h2 class="h2">Objectifs</h2>' +
    '<p class="note">Nombre de prières à rattraper pour chaque prière. En cas de doute, tu peux augmenter le chiffre. Décoche une prière pour ne plus la compter.</p>' +
    '<ul class="set-list">' + rows + '</ul>' +
    '<div class="add-days"><label for="add-days">Ajouter des jours à toutes les prières comptées</label>' +
    '<div class="add-in"><input id="add-days" type="number" inputmode="numeric" min="1" value="30"><button class="btn ghost" data-act="add-days">Ajouter</button></div></div>' +
    '<h2 class="h2">Compte</h2>' +
    '<p class="note">' + esc(userEmail) + '</p>' +
    '<p class="note" id="sync-label">' + esc(syncText()) + '</p>' +
    '<div class="btn-row"><button class="btn ghost" data-act="logout">Se déconnecter</button></div>' +
    '<h2 class="h2">Sauvegarde</h2>' +
    '<p class="note">Garde une copie de tes données dans un fichier, ou restaure-en une.</p>' +
    '<div class="btn-row"><button class="btn ghost" data-act="export">Exporter</button><button class="btn ghost" data-act="open-import">Importer</button></div>' +
    '<h2 class="h2">Repartir de zéro</h2>' +
    '<p class="note">Efface les objectifs et tout l\u2019historique.</p>' +
    '<button class="btn danger" data-act="ask-reset">Tout effacer</button>';
}

function viewSetup() {
  return '<section class="setup">' +
    '<h1 class="setup-h">Combien de prières à rattraper\u00A0?</h1>' +
    '<p class="note">Indique la période à rattraper. L\u2019app en déduit le nombre de chaque prière, que tu pourras ajuster ensuite dans les réglages.</p>' +
    '<div class="fields">' +
      '<label class="field"><span>Années</span><input id="su-y" type="number" inputmode="numeric" min="0" value="8"></label>' +
      '<label class="field"><span>Mois</span><input id="su-m" type="number" inputmode="numeric" min="0" max="11" value="6"></label>' +
      '<label class="field"><span>Soit en jours</span><input id="su-d" type="number" inputmode="numeric" min="1" value="3105"></label>' +
    '</div>' +
    '<label class="check"><input id="su-w" type="checkbox" checked><span>Compter aussi le Witr</span></label>' +
    '<button class="btn primary wide" data-act="start">Commencer</button>' +
    '<button class="link" data-act="open-import">J\u2019ai déjà une sauvegarde</button>' +
    '</section>';
}

/* ---------- Feuilles (fenêtres du bas) ---------- */
function sheetDay() {
  var st = stats();
  var rows = st.act.map(function (x) {
    var v = sheet.draft[x.i];
    return '<li class="step-row" style="--c:' + COLORS[x.i] + '"><span class="dot"></span><span class="step-name">' + x.n + '</span>' +
      '<div class="stepper">' +
      '<button class="sbtn" data-act="day-step" data-i="' + x.i + '" data-delta="-1" aria-label="Retirer 1 ' + x.n + '"' + (v <= 0 ? ' disabled' : '') + '>\u2212</button>' +
      '<output>' + v + '</output>' +
      '<button class="sbtn" data-act="day-step" data-i="' + x.i + '" data-delta="1" aria-label="Ajouter 1 ' + x.n + '">+</button>' +
      '</div></li>';
  }).join('');
  return '<div class="sheet' + (sheet.fresh ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-label="Prières rattrapées ce jour-là" tabindex="-1">' +
    '<h3>Prières rattrapées</h3>' +
    '<label class="field"><input type="date" id="day-date" value="' + sheet.date + '" max="' + todayKey() + '" style="width:100%;border:1px solid var(--line);border-radius:12px;background:var(--bg);padding:0 12px"></label>' +
    '<ul class="steps">' + rows + '</ul>' +
    '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">Annuler</button><button class="btn primary" data-act="day-save">Enregistrer</button></div>' +
    (sheet.existing ? '<button class="link danger center" data-act="day-clear">Effacer ce jour</button>' : '') +
    '</div>';
}
function sheetConfirm() {
  return '<div class="sheet' + (sheet.fresh ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(sheet.title) + '" tabindex="-1">' +
    '<h3>' + esc(sheet.title) + '</h3><p>' + esc(sheet.text) + '</p>' +
    '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">Annuler</button>' +
    '<button class="btn ' + (sheet.danger ? 'danger' : 'primary') + '" data-act="confirm-yes">' + esc(sheet.yes) + '</button></div></div>';
}
function sheetExport() {
  return '<div class="sheet' + (sheet.fresh ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-label="Sauvegarde" tabindex="-1">' +
    '<h3>Sauvegarde</h3><p>Copie ce texte et garde-le quelque part. Tu pourras le réimporter plus tard.</p>' +
    '<textarea id="export-json" readonly></textarea>' +
    '<div class="sheet-actions" style="margin-top:12px"><button class="btn ghost" data-act="sheet-close">Fermer</button><button class="btn primary" data-act="copy-json">Copier</button></div></div>';
}
function sheetImport() {
  return '<div class="sheet' + (sheet.fresh ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-label="Importer une sauvegarde" tabindex="-1">' +
    '<h3>Importer une sauvegarde</h3><p>Colle le texte d\u2019une sauvegarde ou choisis le fichier. Cela remplace toutes les données actuelles.</p>' +
    '<textarea id="import-json" placeholder="Colle ici le texte de la sauvegarde"></textarea>' +
    '<input type="file" id="import-file" accept=".json,application/json,text/plain">' +
    '<div class="sheet-actions"><button class="btn ghost" data-act="sheet-close">Annuler</button><button class="btn primary" data-act="do-import">Importer</button></div></div>';
}
function renderSheet() {
  var root = $('#sheet-root');
  if (!sheet) { root.innerHTML = ''; document.body.style.overflow = ''; return; }
  var html = sheet.type === 'day' ? sheetDay() : sheet.type === 'confirm' ? sheetConfirm() : sheet.type === 'export' ? sheetExport() : sheetImport();
  sheet.fresh = false;
  root.innerHTML = '<div class="scrim" data-act="scrim">' + html + '</div>';
  document.body.style.overflow = 'hidden';
  if (sheet.type === 'export') $('#export-json').value = sheet.text;
  if (sheet.type === 'import' && sheet.text) $('#import-json').value = sheet.text;
  var s = root.querySelector('.sheet');
  if (s && s.focus) s.focus({ preventScroll: true });
}
function openSheet(s) { s.fresh = true; sheet = s; renderSheet(); }
function closeSheet() { sheet = null; renderSheet(); }

/* ---------- Rendu général ---------- */
function render() {
  var app = $('#app'), tabs = $('#tabs');
  if (!configOk()) {
    tabs.hidden = true;
    app.innerHTML = viewConfig();
  } else if (!session || authMode === 'newpass') {
    tabs.hidden = true;
    app.innerHTML = viewAuth();
  } else if (!state) {
    tabs.hidden = true;
    app.innerHTML = loading ? '<div class="boot">Chargement\u2026</div>' : bootError ? viewBootError() : viewSetup();
  } else {
    tabs.hidden = false;
    var v = { log: viewLog, plan: viewPlan, hist: viewHist, set: viewSet }[view] || viewLog;
    app.innerHTML = headerHtml() + v();
    Array.prototype.forEach.call(tabs.querySelectorAll('.tab'), function (b) {
      if (b.dataset.tab === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  if (sheet) {
    var keepFresh = sheet.fresh;
    renderSheet();
    sheet.fresh = keepFresh && false;
  } else {
    renderSheet();
  }
}

function toast(msg, label, fn) {
  var el = $('#toast');
  toastFn = fn || null;
  el.innerHTML = '<span>' + esc(msg) + '</span>' + (label ? '<button data-act="toast-act">' + esc(label) + '</button>' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; toastFn = null; }, label ? 6000 : 2600);
}

/* ---------- Actions ---------- */
function setRow(key, row) {
  if (row.some(function (v) { return v > 0; })) state.days[key] = row; else delete state.days[key];
}
function bump(i, d) {
  var k = todayKey();
  var row = (state.days[k] || zeros()).slice();
  if (row[i] + d < 0) return;
  row[i] += d;
  setRow(k, row);
  commit();
}
function incAll() {
  var st = stats();
  var idx = st.act.filter(function (x) { return x.rest > 0; }).map(function (x) { return x.i; });
  if (!idx.length) { toast('Tout est déjà rattrapé'); return; }
  var k = todayKey();
  var row = (state.days[k] || zeros()).slice();
  idx.forEach(function (i) { row[i] += 1; });
  setRow(k, row);
  lastAll = { date: k, idx: idx };
  commit();
  toast('+1 ajouté à chaque prière', 'Annuler', undoAll);
}
function undoAll() {
  if (!lastAll) return;
  var row = (state.days[lastAll.date] || zeros()).slice();
  lastAll.idx.forEach(function (i) { row[i] = Math.max(0, row[i] - 1); });
  setRow(lastAll.date, row);
  lastAll = null;
  commit();
}
function openDay(date) {
  var existing = state.days[date];
  openSheet({ type: 'day', date: date, draft: (existing || zeros()).slice(), existing: !!existing });
}
function daySave() {
  var date = sheet.date, row = sheet.draft.slice();
  sheet = null;
  setRow(date, row);
  commit();
  toast('Enregistré');
}
function dayClear() {
  var date = sheet.date;
  sheet = null;
  delete state.days[date];
  commit();
  toast('Jour effacé');
}
function startSetup() {
  var days = Math.round(Number($('#su-d').value));
  if (!(days > 0)) { toast('Indique un nombre de jours supérieur à 0'); return; }
  var witr = $('#su-w').checked, totals = {}, on = {};
  PRAYERS.forEach(function (p) { totals[p.k] = days; on[p.k] = p.k === 'witr' ? witr : true; });
  state = { v: 1, cfg: { totals: totals, on: on, since: todayKey() }, days: {}, updatedAt: 0 };
  view = 'log';
  commit();
}
function addDaysAll() {
  var n = Math.round(Number($('#add-days').value));
  if (!(n > 0)) { toast('Entre un nombre de jours'); return; }
  PRAYERS.forEach(function (p) { if (state.cfg.on[p.k] !== false) state.cfg.totals[p.k] += n; });
  commit();
  toast('+' + fmt(n) + ' jours ajoutés aux objectifs');
}
function doExport() {
  var text = JSON.stringify(state, null, 2);
  var name = 'rattrapage-prieres-' + todayKey() + '.json';
  var fallback = function () { openSheet({ type: 'export', text: text }); };
  try {
    var file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Sauvegarde rattrapage' }).then(function () {
        toast('Sauvegarde exportée');
      }, function (e) { if (!e || e.name !== 'AbortError') fallback(); });
      return;
    }
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return fallback();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('Sauvegarde exportée');
  } catch (e) { fallback(); }
}
function copyJson() {
  var ta = $('#export-json');
  var legacy = function () {
    try { ta.focus(); ta.select(); document.execCommand('copy'); toast('Copié'); }
    catch (e) { toast('Sélectionne le texte et copie-le à la main'); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(ta.value).then(function () { toast('Copié'); }, legacy);
  } else legacy();
}
function doImport() {
  var txt = ((sheet && sheet.text) || '').trim(), obj = null;
  try { obj = normalize(JSON.parse(txt)); } catch (e) {}
  if (!obj) { toast("Ce texte n\u2019est pas une sauvegarde valide"); return; }
  state = obj; sheet = null; view = 'log';
  commit();
  toast('Sauvegarde importée');
}
function askReset() {
  openSheet({ type: 'confirm', title: 'Tout effacer\u00A0?', danger: true, yes: 'Tout effacer',
    text: "Les objectifs et tout l\u2019historique seront supprimés, ici et en ligne. Pense à exporter une sauvegarde avant.",
    onYes: resetAll });
}
function resetAll() {
  if (!navigator.onLine) { toast('Connecte-toi à internet pour tout effacer'); return; }
  authed('DELETE', '/rest/v1/qada_state?user_id=eq.' + encodeURIComponent(uid)).then(function () {
    clearTimeout(saveTimer); clearTimeout(retryTimer);
    state = null; setDirty(false); setBase(0); saveLocal(); view = 'log';
    render();
  }, function (e) {
    if (e.authLost) return expireSession();
    toast('Impossible d’effacer en ligne pour l’instant');
  });
}

/* ---------- Événements ---------- */
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var act = el.dataset.act;
  var i = el.dataset.i !== undefined ? Number(el.dataset.i) : null;
  switch (act) {
    case 'tab': view = el.dataset.tab; histLimit = 60; render(); window.scrollTo(0, 0); break;
    case 'inc': bump(i, 1); break;
    case 'dec': bump(i, -1); break;
    case 'inc-all': incAll(); break;
    case 'open-day': openDay(el.dataset.date || todayKey()); break;
    case 'scrim': if (e.target === el) closeSheet(); break;
    case 'sheet-close': closeSheet(); break;
    case 'day-step': sheet.draft[i] = Math.max(0, sheet.draft[i] + Number(el.dataset.delta)); renderSheet(); break;
    case 'day-save': daySave(); break;
    case 'day-clear': dayClear(); break;
    case 'more-days': histLimit += 60; render(); break;
    case 'start': startSetup(); break;
    case 'add-days': addDaysAll(); break;
    case 'export': doExport(); break;
    case 'copy-json': copyJson(); break;
    case 'open-import': openSheet({ type: 'import', text: '' }); break;
    case 'do-import': doImport(); break;
    case 'ask-reset': askReset(); break;
    case 'logout': logout(); break;
    case 'retry': loading = true; bootError = false; render(); pull(); break;
    case 'auth-mode': authMode = el.dataset.mode; authMsg = null; render(); break;
    case 'confirm-yes': { var fn = sheet && sheet.onYes; closeSheet(); if (fn) fn(); break; }
    case 'toast-act': { var f = toastFn; $('#toast').hidden = true; toastFn = null; if (f) f(); break; }
  }
});

document.addEventListener('change', function (e) {
  var t = e.target, a = t.dataset ? t.dataset.act : null;
  if (a === 'total') {
    state.cfg.totals[PRAYERS[Number(t.dataset.i)].k] = Math.max(0, Math.min(1000000, Math.round(Number(t.value) || 0)));
    commit();
  } else if (a === 'toggle') {
    state.cfg.on[PRAYERS[Number(t.dataset.i)].k] = t.checked;
    commit();
  } else if (t.id === 'day-date' && sheet && sheet.type === 'day') {
    if (!t.value) return;
    var ex = state.days[t.value];
    sheet.date = t.value; sheet.draft = (ex || zeros()).slice(); sheet.existing = !!ex;
    renderSheet();
  } else if (t.id === 'import-file' && t.files && t.files[0]) {
    var r = new FileReader();
    r.onload = function () { if (sheet && sheet.type === 'import') { sheet.text = String(r.result); renderSheet(); } };
    r.readAsText(t.files[0]);
  }
});

document.addEventListener('input', function (e) {
  var t = e.target;
  if (t.id === 'rate') {
    var v = Math.round(Number(t.value));
    if (!(v >= 1)) return;
    customRate = Math.min(1000, v);
    var st = stats(), n = st.act.length;
    $('#custom-out').innerHTML = planRight(planCalc(customRate, st.maxRest));
    $('#custom-sub').textContent = planSub(customRate, n);
  } else if (t.id === 'su-y' || t.id === 'su-m') {
    var y = Number($('#su-y').value) || 0, m = Number($('#su-m').value) || 0;
    $('#su-d').value = Math.round(y * 365.25 + m * 30.4375);
  } else if (t.id === 'import-json' && sheet) {
    sheet.text = t.value;
  }
});

document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet) closeSheet(); });

/* ---------- Démarrage ---------- */
document.addEventListener('submit', function (e) {
  if (e.target && e.target.id === 'auth-form') { e.preventDefault(); submitAuth(); }
});
window.addEventListener('online', function () { if (session && state) { setSync('connecting'); } pull(); });
window.addEventListener('offline', function () { setSync('offline'); });
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && session && Date.now() - lastPull > 15000) pull();
});
setInterval(function () { if (session && state && !document.hidden && !dirty) pull(); }, 60000);

function boot() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
  }
  if (!configOk()) { render(); return; }
  if (handleHash()) { render(); return; }
  var s = readSession();
  if (s && s.user && s.user.id && s.refresh_token) { session = s; enterApp(); }
  else { session = null; render(); }
}
boot();
})();
