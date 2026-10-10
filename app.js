(function () {
'use strict';

/* ---------- Données de base ---------- */
var PRAYERS = [
  { k: 'fajr',    n: 'Fajr' },
  { k: 'zohr',    n: 'Dhuhr' },
  { k: 'asr',     n: 'Asr' },
  { k: 'maghreb', n: 'Maghrib' },
  { k: 'icha',    n: 'Isha' },
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
var state = null;          // { v:2, cfg:{totals,on,since,est}, prefs, days:{'YYYY-MM-DD':[6]}, updatedAt }
var view = 'home';         // home | log | stats | set
var statsTab = 'over';     // over | cal | list
var calMonth = null, calSel = null;
var sheet = null;
var wiz = null;            // assistant d'estimation (en mémoire seulement)
var secOpen = {};          // sections repliables ouvertes
var loading = false;
var sync = 'local';        // local | connecting | synced | saving | offline | error
var authMode = 'login', authMsg = null, bootError = false, bootMsg = '', busy = false, baseAt = 0, lastPull = 0;
var customRate = 7;
var histLimit = 60;
var saveTimer = null, retryTimer = null, saving = false, dirty = false;
var toastTimer = null, toastFn = null;
var lastAll = null;

/* Réglages par défaut des nouveaux champs (comptes existants compris) */
var DEFAULT_PREFS = {
  milestones: [50, 100, 500, 1000],
  showMilestones: true,
  reminders: { on: false, type: 'daily', time: '20:00', days: [0, 1, 2, 3, 4, 5, 6], goal: 5 }
};

function cleanPrefs(p) {
  p = p && typeof p === 'object' ? p : {};
  var ms = Array.isArray(p.milestones) ? p.milestones : DEFAULT_PREFS.milestones;
  var seen = {};
  ms = ms.map(function (n) { return Math.round(Number(n)); })
    .filter(function (n) { return isFinite(n) && n >= 1 && n <= 1000000 && !seen[n] && (seen[n] = true); })
    .sort(function (a, b) { return a - b; }).slice(0, 12);
  var r = p.reminders && typeof p.reminders === 'object' ? p.reminders : {};
  var days = Array.isArray(r.days) ? r.days.map(Number).filter(function (d) { return d >= 0 && d <= 6 && d % 1 === 0; }) : DEFAULT_PREFS.reminders.days.slice();
  var goal = Math.round(Number(r.goal));
  return {
    milestones: ms,
    showMilestones: p.showMilestones !== false,
    reminders: {
      on: r.on === true,
      type: ['daily', 'goal', 'weekly'].indexOf(r.type) >= 0 ? r.type : 'daily',
      time: /^\d{2}:\d{2}$/.test(r.time) ? r.time : '20:00',
      days: days,
      goal: isFinite(goal) && goal >= 1 ? Math.min(goal, 100) : 5
    }
  };
}
/* La recette de l'estimation sert uniquement à pré-remplir l'assistant : on la garde telle quelle si elle reste raisonnable */
function cleanEst(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  try { var s = JSON.stringify(e); return s.length > 8000 ? null : JSON.parse(s); } catch (x) { return null; }
}

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
    v: 2,
    cfg: { totals: totals, on: on, since: typeof o.cfg.since === 'string' ? o.cfg.since : todayKey(), est: cleanEst(o.cfg.est) },
    prefs: cleanPrefs(o.prefs),
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
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
  return fetch(CFG.SUPABASE_URL + path, {
    method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctl ? ctl.signal : undefined
  }).then(function (res) {
    return res.text().then(function (t) {
      clearTimeout(timer);
      var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
      if (!res.ok) {
        var err = new Error((j && (j.msg || j.error_description || j.message || j.error)) || ('HTTP ' + res.status));
        err.status = res.status; err.body = j;
        throw err;
      }
      return j;
    });
  }, function (e) { clearTimeout(timer); throw e; });
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
  storeSession(null); state = null; loading = false; sheet = null; uid = null; wiz = null;
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
  var newer = remote.updatedAt >= local.updatedAt ? remote : local;
  var m = { v: 2, cfg: newer.cfg, prefs: newer.prefs, days: {}, updatedAt: Date.now() };
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
      state = remote; wiz = null; saveLocal(); setDirty(false); setBase(remote.updatedAt); changed = true;
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
  loading = !state; bootError = false; view = 'home'; wiz = null; calMonth = null; calSel = null; sheet = null; authMode = 'login'; authMsg = null;
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
    storeSession(null); state = null; uid = null; sheet = null; loading = false; wiz = null;
    authMode = 'login'; authMsg = null; view = 'home';
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

/* Compteurs : "faites" = somme de ce qui est enregistré jour par jour (state.days).
   "restantes" = objectif - faites, jamais négatif. */
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
    extra: sum(act.map(function (x) { return x.extra; })),
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
function dayTotal(k) {
  var r = state.days[k];
  return r ? sum(activeIdx().map(function (i) { return r[i] || 0; })) : 0;
}
function weekStartDate(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
/* Activité réellement enregistrée (jamais d'invention de jours manquants) */
function activity() {
  var today = startOfToday(), tk = dkey(today), wk = dkey(weekStartDate(today)), mk = tk.slice(0, 7);
  var rows = histRows(), t = 0, w = 0, m = 0;
  rows.forEach(function (r) {
    if (r.k === tk) t += r.s;
    if (r.k >= wk && r.k <= tk) w += r.s;
    if (r.k.slice(0, 7) === mk) m += r.s;
  });
  var last14 = [];
  for (var j = 13; j >= 0; j--) { var d = addDays(today, -j); last14.push({ k: dkey(d), d: d, s: dayTotal(dkey(d)) }); }
  return { today: t, week: w, month: m, rows: rows, last14: last14, days: rows.length, lastKey: rows.length ? rows[0].k : null };
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
/* Étapes personnelles : calculées à partir de ce qui a été enregistré */
function milestonesOf(rows) {
  var asc = rows.slice().reverse();
  var total = sum(asc.map(function (r) { return r.s; }));
  var list = state.prefs.milestones.map(function (m) {
    var c = 0, date = null;
    for (var i = 0; i < asc.length; i++) { c += asc[i].s; if (c >= m) { date = asc[i].k; break; } }
    return { n: m, date: date, left: Math.max(0, m - total) };
  });
  return { total: total, list: list };
}

/* ---------- Rappels dans l'app (aucune notification système) ---------- */
function reminderBanner() {
  var r = state.prefs.reminders;
  if (!r.on) return '';
  var now = new Date(), tk = todayKey();
  if (r.days.indexOf(now.getDay()) < 0) return '';
  if (pad(now.getHours()) + ':' + pad(now.getMinutes()) < r.time) return '';
  try { if (localStorage.getItem('qada-rem:' + uid) === tk) return ''; } catch (e) {}
  var a = activity(), msg;
  if (r.type === 'daily') {
    if (a.today > 0) return '';
    msg = 'Un petit moment pour ton suivi\u00A0? Tu peux enregistrer un rattrapage quand tu le souhaites.';
  } else if (r.type === 'goal') {
    if (a.today >= r.goal) return '';
    msg = 'Objectif du jour\u00A0: ' + r.goal + ' \u00B7 ' + a.today + ' enregistrée' + (a.today > 1 ? 's' : '') + '. Chaque effort compte.';
  } else {
    msg = a.week > 0
      ? 'Bilan de la semaine\u00A0: ' + a.week + ' prière' + (a.week > 1 ? 's' : '') + ' enregistrée' + (a.week > 1 ? 's' : '') + '. Merci pour ton suivi.'
      : 'Bilan de la semaine\u00A0: rien d’enregistré pour l’instant. Tu peux reprendre ton suivi quand tu le souhaites.';
  }
  return '<div class="banner" role="status"><span>' + esc(msg) + '</span><button class="link" data-act="rem-dismiss">Fermer</button></div>';
}
function dismissReminder() {
  try { localStorage.setItem('qada-rem:' + uid, todayKey()); } catch (e) {}
  render();
}

function estSummary() {
  var e = state.cfg.est;
  if (!e || !e.method) return 'Nombres saisis directement (aucune méthode enregistrée).';
  var m = e.method === 'custom' ? 'Rattrapage personnalisé' : 'Rattrapage classique';
  return m + (e.at && /^\d{4}-\d{2}-\d{2}$/.test(e.at) ? ', calculé le ' + fmtDate(parseKey(e.at)) : '');
}

/* ---------- Vues ---------- */
var NO_ACT = '<p class="empty">Aucune prière n’est comptée pour l’instant. Active-en une dans les paramètres.</p>';

function headerHtml() {
  var t = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  var title = { home: 'Rattrapage', log: 'Mes prières', stats: 'Statistiques', set: 'Paramètres' }[view] || 'Rattrapage';
  return '<header class="top"><h1>' + title + '</h1><time>' + esc(t) + '</time></header>';
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
  if (x.total === 0) restHtml = '<span class="fin">Rien à rattraper</span>';
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

function heroHtml(st) {
  var cap = st.sumRest === 0 ? 'objectif atteint' : (st.sumRest > 1 ? 'prières restantes' : 'prière restante');
  return '<section class="hero" aria-label="Progression globale">' +
    '<div class="arc">' + arcSvg(st) +
      '<div class="arc-text"><div class="big">' + fmt(st.sumRest) + '</div><div class="cap">' + cap + '</div></div></div>' +
    '<p class="hero-sub">' + fmt(st.counted) + ' faites sur ' + fmt(st.sumTotal) + ' \u00B7 ' + pctFmt(st.pct) + '</p>' +
    '<div class="hero-actions">' +
      '<button class="btn primary" data-act="inc-all">+1 de chaque</button>' +
      '<button class="btn ghost" data-act="open-day">Autre jour</button>' +
    '</div></section>';
}

/* ----- Accueil ----- */
function viewHome() {
  var st = stats();
  if (!st.act.length) return NO_ACT;
  var a = activity();
  var recent = a.rows.length
    ? '<div class="sum" style="margin-top:12px"><div><b>' + a.today + '</b><span>aujourd’hui</span></div>' +
      '<div><b>' + a.week + '</b><span>cette semaine</span></div><div><b>' + a.month + '</b><span>ce mois-ci</span></div></div>'
    : '<p class="empty">Ton activité apparaîtra ici dès ton premier rattrapage enregistré.</p>';
  return reminderBanner() + heroHtml(st) + recent +
    '<button class="link center" data-act="tab" data-tab="log">Voir le détail par prière</button>';
}

/* ----- Rattrapage ----- */
function viewLog() {
  var st = stats();
  if (!st.act.length) return NO_ACT;
  return '<div class="log-head"><div><b>' + fmt(st.sumRest) + '</b> <span>restantes au total</span></div>' +
    '<button class="btn ghost" data-act="open-day">Autre jour</button></div>' +
    '<ul class="rows">' + st.act.map(rowHtml).join('') + '</ul>' +
    '<button class="btn primary wide" data-act="inc-all" style="margin-top:14px">+1 de chaque</button>';
}

/* ----- Statistiques ----- */
function planRight(c) { return '<div class="plan-dur">' + esc(c.span) + '</div><div class="plan-date">' + esc(c.date) + '</div>'; }
function planSub(r, n) { return 'de chaque prière (' + fmt(r * n) + ' au total)'; }

function planBlock(st) {
  if (!st.act.length) return NO_ACT;
  if (st.maxRest === 0) {
    return '<div class="done"><div class="done-big">Objectif atteint</div><p>Tout est rattrapé. Si tu veux continuer, augmente un objectif dans les paramètres.</p></div>';
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
  return '<p class="note">Une projection est une hypothèse, pas une promesse. Elle suppose que tu rattrapes chaque jour le même nombre de chaque prière. ' +
    'Le calcul suit la prière la plus en retard : ' + worst.n + ', ' + fmt(worst.rest) + ' restantes.</p>' +
    paceHtml + '<ul class="plan">' + rows + custom + '</ul>';
}

function barsSvg(last14) {
  var W = 320, H = 112, padB = 20, padT = 16, n = last14.length, bw = 16, gap = (W - n * bw) / (n + 1);
  var max = Math.max.apply(null, last14.map(function (x) { return x.s; }).concat([1]));
  var out = '<line class="ch-base" x1="0" y1="' + (H - padB) + '" x2="' + W + '" y2="' + (H - padB) + '"/>';
  last14.forEach(function (x, i) {
    var bx = gap + i * (bw + gap), h = x.s ? Math.max(3, x.s / max * (H - padB - padT)) : 0, by = H - padB - h;
    if (x.s) {
      out += '<rect class="ch-bar' + (i === n - 1 ? ' today' : '') + '" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw + '" height="' + h.toFixed(1) + '" rx="3"/>' +
        '<text class="ch-t" x="' + (bx + bw / 2).toFixed(1) + '" y="' + (by - 4).toFixed(1) + '" text-anchor="middle">' + x.s + '</text>';
    }
    out += '<text class="ch-t" x="' + (bx + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + 'DLMMJVS'.charAt(x.d.getDay()) + '</text>';
  });
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Prières enregistrées par jour sur les 14 derniers jours">' + out + '</svg>';
}
function cumulSvg(rows) {
  var asc = rows.slice().reverse();
  if (asc.length < 2) return '';
  var W = 320, H = 120, pl = 6, pr = 6, pt = 14, pb = 20;
  var t0 = parseKey(asc[0].k).getTime();
  var t1 = Math.max(startOfToday().getTime(), parseKey(asc[asc.length - 1].k).getTime());
  var tspan = Math.max(1, t1 - t0), total = sum(asc.map(function (r) { return r.s; }));
  var x = function (t) { return pl + (t - t0) / tspan * (W - pl - pr); };
  var y = function (v) { return H - pb - v / total * (H - pt - pb); };
  var c = 0, pts = [[x(t0), y(0)]];
  asc.forEach(function (r) {
    var t = parseKey(r.k).getTime();
    pts.push([x(t), y(c)]); c += r.s; pts.push([x(t), y(c)]);
  });
  pts.push([x(t1), y(c)]);
  var line = 'M' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L');
  var area = line + ' L' + x(t1).toFixed(1) + ' ' + y(0).toFixed(1) + ' L' + x(t0).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z';
  var d0 = parseKey(asc[0].k).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Total des prières enregistrées depuis le début du suivi">' +
    '<line class="ch-base" x1="0" y1="' + (H - pb) + '" x2="' + W + '" y2="' + (H - pb) + '"/>' +
    '<path class="ch-area" d="' + area + '"/><path class="ch-line" d="' + line + '"/>' +
    '<text class="ch-t" x="' + pl + '" y="' + (H - 5) + '">' + esc(d0) + '</text>' +
    '<text class="ch-t" x="' + (W - pr) + '" y="' + (H - 5) + '" text-anchor="end">aujourd’hui</text>' +
    '<text class="ch-t" x="' + (pl + 2) + '" y="' + (pt - 3) + '">' + fmt(total) + '</text></svg>';
}
function shortDate(k) { return parseKey(k).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }

function statsOver() {
  var st = stats();
  if (!st.act.length) return NO_ACT;
  var a = activity(), ms = milestonesOf(a.rows);
  var h = '<div class="card"><div class="kv">' +
    '<div><b>' + fmt(st.sumTotal) + '</b><span>Estimation de départ</span></div>' +
    '<div><b>' + fmt(st.counted) + '</b><span>Rattrapées</span></div>' +
    '<div><b>' + fmt(st.sumRest) + '</b><span>Restantes</span></div>' +
    '<div><b>' + pctFmt(st.pct) + '</b><span>Progression</span></div></div>' +
    '<div class="meter"><i style="width:' + st.pct.toFixed(2) + '%"></i></div>' +
    (st.extra ? '<p class="cap2" style="margin:10px 0 0">+' + fmt(st.extra) + ' prières enregistrées en plus de l’estimation.</p>' : '') + '</div>';

  h += '<h2 class="h2">Par prière</h2><ul class="prog">' + st.act.map(function (x) {
    var p = x.total ? Math.min(100, x.done / x.total * 100) : 100;
    return '<li style="--c:' + COLORS[x.i] + '"><span class="prog-n">' + x.n + '</span>' +
      '<span class="prog-v">' + fmt(Math.min(x.done, x.total)) + ' / ' + fmt(x.total) + (x.total ? ' \u00B7 ' + pctFmt(p) : '') + '</span>' +
      '<div class="bar"><i style="width:' + p.toFixed(2) + '%"></i></div></li>';
  }).join('') + '</ul>';

  h += '<h2 class="h2">Activité enregistrée</h2>';
  if (!a.rows.length) {
    h += '<div class="card"><p class="empty0">Rien d’enregistré pour l’instant. Tes rattrapages apparaîtront ici dès que tu en saisiras un.</p></div>';
  } else {
    h += '<div class="sum"><div><b>' + a.today + '</b><span>aujourd’hui</span></div><div><b>' + a.week + '</b><span>cette semaine</span></div>' +
      '<div><b>' + a.month + '</b><span>ce mois-ci</span></div></div>' +
      '<div class="card" style="margin-top:12px"><p class="cap2">14 derniers jours</p>' + barsSvg(a.last14) + '</div>' +
      '<p class="note" style="margin-top:8px">Seuls les rattrapages saisis dans l’app sont comptés.</p>';
  }

  h += '<h2 class="h2">Mon parcours</h2><div class="card">';
  if (!a.rows.length) {
    h += '<p class="empty0">Ton parcours se dessinera au fil de tes rattrapages. Chaque effort compte.</p>';
  } else {
    h += '<div class="kv"><div><b>' + fmt(a.days) + '</b><span>jours avec une activité</span></div>' +
      '<div><b>' + fmt(ms.total) + '</b><span>prières enregistrées</span></div></div>' +
      '<p class="cap2" style="margin:12px 0 0">Dernière activité : ' + esc(fmtDay(a.lastKey)) + '</p>';
    var cu = cumulSvg(a.rows);
    if (cu) h += '<p class="cap2" style="margin:14px 0 4px">Depuis le début de ton suivi</p>' + cu;
    var gap = Math.round((startOfToday() - parseKey(a.lastKey)) / 86400000);
    if (gap >= 3) h += '<p class="gentle">Chaque effort compte. Tu peux reprendre ton suivi quand tu le souhaites.</p>';
  }
  if (state.prefs.showMilestones && ms.list.length) {
    h += '<p class="cap2" style="margin:14px 0 6px">Étapes personnelles</p><div class="mss">' + ms.list.map(function (m) {
      return '<span class="ms' + (m.date ? ' done' : '') + '">' + fmt(m.n) + ' \u00B7 ' + (m.date ? 'atteinte le ' + esc(shortDate(m.date)) : 'encore ' + fmt(m.left)) + '</span>';
    }).join('') + '</div>';
  }
  h += '</div>';

  h += '<details class="sec" data-sec="proj"' + (secOpen.proj ? ' open' : '') + '><summary>Projection <small>hypothèse</small></summary>' +
    '<div class="sec-body">' + planBlock(st) + '</div></details>';
  return h;
}

function statsCal() {
  var now = startOfToday(), nk = dkey(now);
  if (!calMonth) calMonth = { y: now.getFullYear(), m: now.getMonth() };
  if (!calSel) calSel = nk;
  var y = calMonth.y, m = calMonth.m, first = new Date(y, m, 1), nd = new Date(y, m + 1, 0).getDate(), lead = (first.getDay() + 6) % 7;
  var isCur = y === now.getFullYear() && m === now.getMonth();
  var title = first.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  var cells = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(function (w) { return '<div class="cal-w">' + w + '</div>'; }).join('');
  for (var b = 0; b < lead; b++) cells += '<div></div>';
  for (var d = 1; d <= nd; d++) {
    var k = y + '-' + pad(m + 1) + '-' + pad(d), s = dayTotal(k);
    cells += '<button class="cal-d' + (k === nk ? ' today' : '') + (k === calSel ? ' sel' : '') + (s > 0 ? ' has' : '') + '" data-act="cal-sel" data-date="' + k + '"' +
      (k > nk ? ' disabled' : '') + ' aria-label="' + esc(fmtDay(k)) + (s > 0 ? ' : ' + s + ' enregistrée' + (s > 1 ? 's' : '') : '') + '">' + d + '<i></i></button>';
  }
  var sum1 = dayTotal(calSel), row = state.days[calSel], act = activeIdx(), detail;
  if (sum1 > 0 && row) {
    detail = '<div class="day-chips" style="margin-top:6px">' + act.filter(function (i) { return row[i] > 0; }).map(function (i) {
      return '<span class="chip" style="--c:' + COLORS[i] + '"><i></i>' + PRAYERS[i].n + ' ' + row[i] + '</span>';
    }).join('') + '</div>';
  } else detail = '<p class="cap2" style="margin:6px 0 0">Rien d’enregistré ce jour-là.</p>';
  return '<div class="cal-head"><div class="cal-title">' + esc(title) + '</div><div class="cal-nav">' +
    '<button class="icon-btn" data-act="cal-prev" aria-label="Mois précédent">\u2039</button>' +
    '<button class="icon-btn" data-act="cal-next" aria-label="Mois suivant"' + (isCur ? ' disabled' : '') + '>\u203A</button></div></div>' +
    '<div class="cal">' + cells + '</div>' +
    '<div class="card" style="margin-top:12px"><div class="cal-sel-h"><b>' + esc(fmtDay(calSel)) + '</b><span>' + sum1 + ' enregistrée' + (sum1 > 1 ? 's' : '') + '</span></div>' + detail +
    (calSel <= nk ? '<button class="btn ghost" style="margin-top:12px" data-act="open-day" data-date="' + calSel + '">Modifier ce jour</button>' : '') + '</div>' +
    '<p class="note" style="margin-top:10px">Un point marque un jour où quelque chose a été enregistré. Un jour sans point n’a simplement rien d’enregistré.</p>';
}

function statsList() {
  var rows = histRows();
  var total = sum(rows.map(function (r) { return r.s; }));
  var mk = todayKey().slice(0, 7);
  var thisMonth = rows.filter(function (r) { return r.k.slice(0, 7) === mk; }).length;
  var shown = rows.slice(0, histLimit), list;
  if (!rows.length) {
    list = '<p class="empty">Rien pour l’instant. Chaque prière rattrapée apparaîtra ici, jour par jour.</p>';
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
    '<div><b>' + thisMonth + '</b><span>jours ce mois-ci</span></div></div>' +
    '<div class="hist-head"><h2 class="h2">Jour par jour</h2><button class="btn ghost" data-act="open-day">Ajouter un jour</button></div>' + list;
}

function viewStats() {
  var seg = [['over', 'Vue d’ensemble'], ['cal', 'Calendrier'], ['list', 'Jour par jour']].map(function (x) {
    return '<button type="button" class="seg-b" aria-pressed="' + (statsTab === x[0]) + '" data-act="stats-tab" data-v="' + x[0] + '">' + x[1] + '</button>';
  }).join('');
  return '<div class="seg" role="group" aria-label="Rubriques">' + seg + '</div>' +
    (statsTab === 'cal' ? statsCal() : statsTab === 'list' ? statsList() : statsOver());
}

/* ----- Paramètres ----- */
var DISCLAIMER = '<p><b>Une estimation, pas une certitude.</b> Ce nombre est un outil de suivi personnel, pas un calcul religieux infaillible. ' +
  'Il dépend uniquement des informations que tu donnes : le nombre réel de prières à rattraper peut être différent.</p>' +
  '<p>Si tu as un doute, il peut être prudent de retenir une estimation suffisamment haute pour éviter de sous-estimer ton retard, tout en restant raisonnable. ' +
  'Tu peux corriger les chiffres, et modifier ton estimation à tout moment.</p>' +
  '<p>Cette application organise ton suivi : elle ne donne pas d’avis religieux et ne tranche pas les questions de jurisprudence, qui peuvent varier selon les écoles et les situations. ' +
  'Pour une question particulière ou une situation complexe, n’hésite pas à demander conseil à une personne de science qualifiée.</p>' +
  '<p>L’objectif est d’avancer à ton rythme, sans pression ni culpabilité.</p>';

function remSection() {
  var r = state.prefs.reminders, L = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  var chips = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
    return '<label class="dchip"><input type="checkbox" data-act="rem-day" data-d="' + d + '"' + (r.days.indexOf(d) >= 0 ? ' checked' : '') + ' aria-label="' + ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][d] + '"><span>' + L[d] + '</span></label>';
  }).join('');
  var body = '<p class="note">Facultatifs et désactivés par défaut. Ces rappels s’affichent dans l’app quand tu l’ouvres. ' +
    'Les notifications système (app fermée) ne sont pas disponibles pour l’instant.</p>' +
    '<label class="check"><input type="checkbox" data-act="rem-on"' + (r.on ? ' checked' : '') + '><span>Activer les rappels dans l’app</span></label>';
  if (r.on) {
    body += '<label class="field"><span>Type de rappel</span><select data-act="rem-type">' +
      optList([['daily', 'Rappel quotidien discret'], ['goal', 'Objectif du jour'], ['weekly', 'Bilan de la semaine']], r.type) + '</select></label>' +
      (r.type === 'goal' ? '<label class="field" style="margin-top:10px"><span>Objectif du jour (nombre de prières)</span><input type="number" inputmode="numeric" min="1" max="100" data-act="rem-goal" value="' + r.goal + '"></label>' : '') +
      '<label class="field" style="margin-top:10px"><span>À partir de</span><input type="time" data-act="rem-time" value="' + esc(r.time) + '"></label>' +
      '<p class="cap2" style="margin:14px 0 6px">Jours concernés</p><div class="dchips">' + chips + '</div>' +
      '<button class="link" data-act="rem-off" style="margin-top:8px">Tout désactiver</button>';
  }
  return '<details class="sec" data-sec="rem"' + (secOpen.rem ? ' open' : '') + '><summary>Rappels <small>' + (r.on ? 'activés' : 'désactivés') + '</small></summary><div class="sec-body">' + body + '</div></details>';
}

function viewSet() {
  var st = stats(), p = state.prefs;
  var rows = st.items.map(function (x) {
    return '<li class="set-row' + (x.on ? '' : ' off') + '" style="--c:' + COLORS[x.i] + '">' +
      '<label class="chk"><input type="checkbox" data-act="toggle" data-i="' + x.i + '"' + (x.on ? ' checked' : '') + ' aria-label="Compter ' + x.n + '"></label>' +
      '<div class="set-name">' + x.n + '<small>' + fmt(x.done) + ' faites</small></div>' +
      '<input class="num-in" type="number" inputmode="numeric" min="0" step="1" data-act="total" data-i="' + x.i + '" value="' + x.total + '" aria-label="Objectif ' + x.n + '">' +
      '</li>';
  }).join('');
  return '<h2 class="h2" style="margin-top:6px">Mon estimation</h2>' +
    '<div class="card"><p class="est-sum">' + esc(estSummary()) + '</p>' +
    '<p class="note" style="margin:6px 0 12px">Quand tu modifies ton estimation, ce que tu as déjà rattrapé est conservé : seul l’objectif change, et tu valides avant.</p>' +
    '<div class="btn-row"><button class="btn primary" data-act="wiz-open" data-m="edit">Modifier mon estimation</button>' +
    '<button class="btn ghost" data-act="wiz-open" data-m="switch">Changer de méthode</button></div></div>' +
    '<h2 class="h2">Objectifs</h2>' +
    '<p class="note">Nombre de prières à rattraper pour chaque prière : tu peux le corriger directement. En cas de doute, tu peux augmenter le chiffre. Décoche une prière pour ne plus la compter.</p>' +
    '<ul class="set-list">' + rows + '</ul>' +
    '<div class="add-days"><label for="add-days">Ajouter des jours à toutes les prières comptées</label>' +
    '<div class="add-in"><input id="add-days" type="number" inputmode="numeric" min="1" value="30"><button class="btn ghost" data-act="add-days">Ajouter</button></div></div>' +
    '<details class="sec" data-sec="ms"' + (secOpen.ms ? ' open' : '') + '><summary>Étapes du parcours</summary><div class="sec-body">' +
      '<label class="check"><input type="checkbox" data-act="ms-show"' + (p.showMilestones ? ' checked' : '') + '><span>Afficher les étapes dans les statistiques</span></label>' +
      '<label class="field"><span>Étapes (nombres séparés par des virgules)</span><input type="text" inputmode="numeric" data-act="ms-list" value="' + esc(p.milestones.join(', ')) + '"></label></div></details>' +
    remSection() +
    '<h2 class="h2">Compte</h2>' +
    '<p class="note">' + esc(userEmail) + '</p>' +
    '<p class="note" id="sync-label">' + esc(syncText()) + '</p>' +
    '<div class="btn-row"><button class="btn ghost" data-act="logout">Se déconnecter</button></div>' +
    '<h2 class="h2">Sauvegarde</h2>' +
    '<p class="note">Garde une copie de tes données dans un fichier, ou restaure-en une.</p>' +
    '<div class="btn-row"><button class="btn ghost" data-act="export">Exporter</button><button class="btn ghost" data-act="open-import">Importer</button></div>' +
    '<details class="sec" data-sec="about"' + (secOpen.about ? ' open' : '') + '><summary>À propos des estimations</summary><div class="sec-body callout-in">' + DISCLAIMER + '</div></details>' +
    '<h2 class="h2">Repartir de zéro</h2>' +
    '<p class="note">Efface les objectifs et tout l’historique.</p>' +
    '<button class="btn danger" data-act="ask-reset">Tout effacer</button>';
}

/* ---------- Assistant d'estimation ---------- */
var SHARE_OPTS = [[100, 'Toutes les prières (100 %)'], [75, 'Environ les trois quarts'], [50, 'Environ la moitié'], [25, 'Environ un quart']];
var MARGIN_OPTS = [[0, 'Aucune'], [5, '+5 %'], [10, '+10 %'], [20, '+20 %']];

function optList(list, cur) {
  return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
}
function freqOpts(cur, withPlaceholder) {
  return (withPlaceholder ? '<option value=""' + (cur ? '' : ' selected') + ' disabled>Choisir…</option>' : '') +
    window.QadaEstimate.FREQS.map(function (f) { return '<option value="' + f.k + '"' + (f.k === cur ? ' selected' : '') + '>' + f.label + ' (' + f.hint + ')</option>'; }).join('');
}

function freshWiz(mode) {
  var prayers = {};
  PRAYERS.forEach(function (p) { prayers[p.k] = { kind: 'freq', freq: '', count: '', periods: [] }; });
  return {
    mode: mode, step: 'method', method: null, margin: 0, share: 100, witr: true,
    start: { startMode: 'date', startDate: '', birthDate: '', startAge: '', endMode: 'today', endDate: '', years: '', months: '' },
    prayers: prayers, calc: null
  };
}
function coerce(dst, v) {
  if (v === undefined || v === null) return dst;
  if (typeof dst === 'number') { var n = Number(v); return isFinite(n) ? n : dst; }
  if (typeof dst === 'boolean') return v === true;
  return String(v).slice(0, 12);
}
function wizFromState(mode) {
  var w = freshWiz('edit'), e = state.cfg.est, QE = window.QadaEstimate;
  w.witr = state.cfg.on.witr !== false;
  if (e && (e.method === 'classic' || e.method === 'custom')) {
    w.method = e.method;
    w.margin = coerce(w.margin, e.margin); w.share = coerce(w.share, e.share);
    if (e.start && typeof e.start === 'object') Object.keys(w.start).forEach(function (k) { w.start[k] = coerce(w.start[k], e.start[k]); });
    if (['date', 'age', 'duration'].indexOf(w.start.startMode) < 0) w.start.startMode = 'date';
    if (['today', 'date'].indexOf(w.start.endMode) < 0) w.start.endMode = 'today';
    if (e.prayers && typeof e.prayers === 'object') PRAYERS.forEach(function (p) {
      var s = e.prayers[p.k], d = w.prayers[p.k];
      if (!s || typeof s !== 'object') return;
      if (['none', 'count', 'freq', 'periods'].indexOf(s.kind) >= 0) d.kind = s.kind;
      if (QE.freqOf(s.freq)) d.freq = s.freq;
      d.count = coerce(d.count, s.count);
      d.periods = Array.isArray(s.periods) ? s.periods.slice(0, 12).map(function (q) {
        q = q || {};
        return { from: coerce('', q.from), to: coerce('', q.to), freq: QE.freqOf(q.freq) ? q.freq : '' };
      }) : [];
    });
  } else {
    /* Nombres saisis directement : on propose une durée équivalente comme point de départ */
    var days = Math.max.apply(null, PRAYERS.map(function (p) { return state.cfg.totals[p.k] || 0; }).concat([0]));
    w.method = 'classic'; w.start.startMode = 'duration';
    if (days > 0) {
      var yy = Math.floor(days / 365.25), mm = Math.round((days - yy * 365.25) / 30.4375);
      if (mm >= 12) { yy++; mm = 0; }
      w.start.years = String(yy); w.start.months = String(mm);
    }
  }
  w.step = mode === 'switch' ? 'method' : 'form';
  return w;
}
function setPath(o, path, v) {
  var ks = path.split('.');
  for (var i = 0; i < ks.length; i++) if (ks[i] === '__proto__' || ks[i] === 'constructor' || ks[i] === 'prototype') return;
  for (var j = 0; j < ks.length - 1; j++) { o = o[ks[j]]; if (o == null) return; }
  o[ks[ks.length - 1]] = v;
}

/* Calcule les totaux proposés. Renvoie { error } ou { totals, shorts, lines } */
function wizCompute() {
  var QE = window.QadaEstimate, w = wiz, today = startOfToday();
  var margin = Math.round(Number(w.margin)) || 0, res = { totals: {}, shorts: {}, lines: {} };
  if (w.method === 'classic') {
    var c = QE.calcClassic(w.start, w.share, margin, today);
    if (c.error) return { error: c.error };
    PRAYERS.forEach(function (p) { res.totals[p.k] = c.total; res.shorts[p.k] = c.short; res.lines[p.k] = c.lines; });
    return res;
  }
  var range = QE.resolveRange(Object.assign({}, w.start, { endMode: 'today' }), today), err = null;
  PRAYERS.forEach(function (p) {
    if (p.k === 'witr' && !w.witr) { res.totals[p.k] = state ? (state.cfg.totals.witr || 0) : 0; res.shorts[p.k] = ''; res.lines[p.k] = []; return; }
    var r = QE.calcPrayer(w.prayers[p.k], range, margin, today);
    if (r.error) { err = err || (p.n + ' : ' + r.error); return; }
    res.totals[p.k] = r.n; res.shorts[p.k] = r.short; res.lines[p.k] = r.lines;
  });
  return err ? { error: err } : res;
}
function updateWizLive() {
  if (!wiz || wiz.step !== 'form') return;
  var QE = window.QadaEstimate, today = startOfToday(), margin = Math.round(Number(wiz.margin)) || 0;
  if (wiz.method === 'classic') {
    var el = $('#w-live');
    if (!el) return;
    var c = QE.calcClassic(wiz.start, wiz.share, margin, today);
    el.textContent = c.error ? c.error : '\u2248 ' + fmt(c.total) + ' prières à rattraper pour chaque prière (' + c.short + ')';
  } else {
    var range = QE.resolveRange(Object.assign({}, wiz.start, { endMode: 'today' }), today);
    PRAYERS.forEach(function (p) {
      var e = $('#w-est-' + p.k);
      if (!e) return;
      var r = QE.calcPrayer(wiz.prayers[p.k], range, margin, today);
      e.textContent = r.error ? '' : '\u2248 ' + fmt(r.n);
    });
  }
}
function updateResTotal() {
  var el = $('#w-total');
  if (!el || !wiz) return;
  var t = 0;
  PRAYERS.forEach(function (p) { var i = $('#w-t-' + p.k); if (i) t += Math.max(0, Math.round(Number(i.value) || 0)); });
  el.textContent = fmt(t);
}

function wizWrap(inner) { return '<section class="setup">' + inner + '</section>'; }
function wizHead(title) {
  return '<div class="wiz-top"><button class="link" data-act="wiz-back">\u2190 Retour</button>' +
    (wiz.mode === 'edit' ? '<button class="link" data-act="wiz-cancel">Annuler</button>' : '<span></span>') + '</div>' +
    '<h1 class="setup-h">' + title + '</h1>';
}
function wizMethod() {
  var edit = wiz.mode === 'edit';
  return wizWrap((edit ? '<div class="wiz-top"><span></span><button class="link" data-act="wiz-cancel">Annuler</button></div>' : '') +
    '<h1 class="setup-h">Comment veux-tu estimer ton retard\u00A0?</h1>' +
    '<p class="note">Les deux méthodes alimentent le même suivi. Tu pourras corriger ton estimation à tout moment.' +
    (edit ? ' Ce que tu as déjà rattrapé est conservé : seul l’objectif change, et tu valides avant.' : '') + '</p>' +
    '<button class="choice" data-act="wiz-method" data-m="classic"><b>Rattrapage classique</b>' +
      '<span>Une estimation globale : tu indiques la période concernée, et le même nombre est compté pour chaque prière.</span></button>' +
    '<button class="choice" data-act="wiz-method" data-m="custom"><b>Rattrapage personnalisé</b>' +
      '<span>Prière par prière : tu indiques à quelle fréquence tu manquais chacune, éventuellement par périodes.</span></button>' +
    (edit ? '' : '<button class="link" data-act="open-import">J’ai déjà une sauvegarde</button>'));
}
function startBlock(withEnd) {
  var s = wiz.start, today = todayKey();
  var seg = function (path, list, cur, label) {
    return '<div class="seg" role="group" aria-label="' + label + '">' + list.map(function (x) {
      return '<button type="button" class="seg-b" aria-pressed="' + (cur === x[0]) + '" data-act="wiz-set" data-k="' + path + '" data-v="' + x[0] + '">' + x[1] + '</button>';
    }).join('') + '</div>';
  };
  var h = '<p class="cap2">Début de la période</p>' + seg('start.startMode', [['date', 'Date'], ['age', 'Âge'], ['duration', 'Durée']], s.startMode, 'Début de la période');
  if (s.startMode === 'date') {
    h += '<label class="field"><span>Date de début</span><input type="date" data-w="start.startDate" value="' + esc(s.startDate) + '" max="' + today + '"></label>';
  } else if (s.startMode === 'age') {
    h += '<div class="fields two"><label class="field"><span>Date de naissance</span><input type="date" data-w="start.birthDate" value="' + esc(s.birthDate) + '" max="' + today + '"></label>' +
      '<label class="field"><span>Âge de début</span><input type="number" inputmode="numeric" min="0" max="100" data-w="start.startAge" value="' + esc(s.startAge) + '"></label></div>' +
      '<p class="note">L’âge de début dépend de ta situation personnelle : c’est à toi de le déterminer. En cas de doute, demande conseil à une personne de science qualifiée.</p>';
  } else {
    h += '<div class="fields two"><label class="field"><span>Années</span><input type="number" inputmode="numeric" min="0" placeholder="0" data-w="start.years" value="' + esc(s.years) + '"></label>' +
      '<label class="field"><span>Mois</span><input type="number" inputmode="numeric" min="0" max="11" placeholder="0" data-w="start.months" value="' + esc(s.months) + '"></label></div>';
  }
  if (withEnd && s.startMode !== 'duration') {
    h += '<p class="cap2" style="margin-top:14px">Fin de la période</p>' + seg('start.endMode', [['today', 'Aujourd’hui'], ['date', 'Autre date']], s.endMode, 'Fin de la période');
    if (s.endMode === 'date') h += '<label class="field"><span>Date de fin</span><input type="date" data-w="start.endDate" value="' + esc(s.endDate) + '" max="' + today + '"></label>';
  }
  return h;
}
function marginField() {
  return '<label class="field"><span>Marge de précaution (facultatif)</span><select data-w="margin" data-num="1">' + optList(MARGIN_OPTS, wiz.margin) + '</select></label>' +
    '<p class="note">Ajoute un pourcentage à l’estimation, par prudence en cas de doute. Tu pourras toujours corriger le résultat.</p>';
}
function witrField() {
  return '<label class="check" style="margin-top:16px"><input type="checkbox" data-w="witr" data-rr="1"' + (wiz.witr ? ' checked' : '') + '><span>Compter aussi le Witr</span></label>' +
    '<p class="note">Son statut varie selon les écoles : à toi de choisir.</p>';
}
function wizClassic() {
  return wizWrap(wizHead('Rattrapage classique') +
    '<p class="note">Hypothèse du calcul : toutes les prières de la période sont comptées, pour chacune des cinq prières. Les options te permettent d’affiner.</p>' +
    startBlock(true) + witrField() +
    '<details class="sec" data-sec="w-opt"' + (secOpen['w-opt'] ? ' open' : '') + '><summary>Options <small>facultatif</small></summary><div class="sec-body">' +
      '<label class="field"><span>Part des prières manquées sur la période</span><select data-w="share" data-num="1">' + optList(SHARE_OPTS, wiz.share) + '</select></label>' +
      marginField() + '</div></details>' +
    '<p class="auth-msg" id="w-live"></p><p class="auth-msg err" id="w-msg"></p>' +
    '<button class="btn primary wide" data-act="wiz-next">Voir l’estimation</button>');
}
function periodRow(k, q, n, count) {
  var pre = 'prayers.' + k + '.periods.' + n + '.', today = todayKey();
  return '<div class="per"><div class="fields two"><label class="field"><span>Du</span><input type="date" data-w="' + pre + 'from" value="' + esc(q.from) + '" max="' + today + '"></label>' +
    '<label class="field"><span>Au (vide = aujourd’hui)</span><input type="date" data-w="' + pre + 'to" value="' + esc(q.to) + '" max="' + today + '"></label></div>' +
    '<label class="field"><span>Fréquence</span><select data-w="' + pre + 'freq">' + freqOpts(q.freq, true) + '</select></label>' +
    (count > 1 ? '<button class="link danger" data-act="wiz-per-del" data-p="' + k + '" data-n="' + n + '">Retirer cette période</button>' : '') + '</div>';
}
function prayerCard(p) {
  var i = PRAYERS.indexOf(p), d = wiz.prayers[p.k];
  var h = '<div class="pcard" style="--c:' + COLORS[i] + '"><div class="pcard-h"><span class="pcard-n">' + p.n + '</span><span class="pcard-est" id="w-est-' + p.k + '"></span></div>';
  if (d.kind === 'periods') {
    h += d.periods.map(function (q, n) { return periodRow(p.k, q, n, d.periods.length); }).join('') +
      '<div class="btn-row" style="margin-top:10px"><button class="btn ghost" data-act="wiz-per-add" data-p="' + p.k + '">+ Ajouter une période</button>' +
      '<button class="link" data-act="wiz-per-off" data-p="' + p.k + '">Revenir à une seule fréquence</button></div>';
  } else {
    var cur = d.kind === 'count' ? '__count' : d.kind === 'none' ? '__none' : (d.freq || '');
    h += '<label class="field"><span>Fréquence des prières manquées</span><select data-act="wiz-kind" data-p="' + p.k + '">' +
      freqOpts(cur, true) + '<option value="__count"' + (cur === '__count' ? ' selected' : '') + '>Je connais le nombre</option>' +
      '<option value="__none"' + (cur === '__none' ? ' selected' : '') + '>Rien à rattraper</option></select></label>';
    if (d.kind === 'count') {
      h += '<label class="field" style="margin-top:10px"><span>Nombre de prières à rattraper</span><input type="number" inputmode="numeric" min="0" data-w="prayers.' + p.k + '.count" value="' + esc(d.count) + '"></label>';
    }
    h += '<button class="link" data-act="wiz-per-on" data-p="' + p.k + '">Mes habitudes ont changé…</button>';
  }
  return h + '</div>';
}
function wizCustom() {
  var cards = PRAYERS.filter(function (p) { return p.k !== 'witr' || wiz.witr; }).map(prayerCard).join('');
  return wizWrap(wizHead('Rattrapage personnalisé') +
    '<p class="note">Choisis, pour chaque prière, ce qui te ressemble le plus. Les questions avancées sont facultatives.</p>' +
    startBlock(false) +
    '<p class="note">La période va jusqu’à aujourd’hui. Si tes habitudes ont changé, utilise « Mes habitudes ont changé » dans la prière concernée.</p>' +
    witrField() + '<div style="margin-top:12px">' + cards + '</div>' +
    '<details class="sec" data-sec="w-opt"' + (secOpen['w-opt'] ? ' open' : '') + '><summary>Options <small>facultatif</small></summary><div class="sec-body">' + marginField() + '</div></details>' +
    '<p class="auth-msg err" id="w-msg"></p>' +
    '<button class="btn primary wide" data-act="wiz-next">Voir l’estimation</button>');
}
function wizResult() {
  var c = wiz.calc, edit = wiz.mode === 'edit', total = 0, done = 0;
  var rows = PRAYERS.filter(function (p) { return p.k !== 'witr' || wiz.witr; }).map(function (p) {
    var i = PRAYERS.indexOf(p);
    total += c.totals[p.k] || 0;
    var old = edit ? '<div class="res-s">Objectif actuel : ' + fmt(state.cfg.totals[p.k] || 0) + '</div>' : '';
    return '<li class="res-row" style="--c:' + COLORS[i] + '"><div><div class="res-n">' + p.n + '</div><div class="res-s">' + esc(c.shorts[p.k] || '') + '</div>' + old + '</div>' +
      '<input class="num-in" type="number" inputmode="numeric" min="0" id="w-t-' + p.k + '" value="' + (c.totals[p.k] || 0) + '" aria-label="Estimation ' + p.n + '"></li>';
  }).join('');
  if (edit) { for (var k in state.days) done += sum(state.days[k]); }
  return wizWrap(wizHead('Ton estimation') +
    '<p class="note">Vérifie les chiffres et ajuste-les si besoin : ce sont eux qui serviront de point de départ à ton suivi.</p>' +
    '<ul class="set-list">' + rows + '</ul>' +
    '<p class="res-total">Total : <b id="w-total">' + fmt(total) + '</b> prières</p>' +
    (edit ? '<p class="note">Ce que tu as déjà enregistré (' + fmt(done) + ' prières) est conservé. Seul l’objectif change.</p>' : '') +
    '<div class="callout">' + DISCLAIMER + '</div>' +
    '<button class="btn primary wide" data-act="wiz-apply">' + (edit ? 'Appliquer cette estimation' : 'Commencer mon suivi') + '</button>');
}
function viewWizard() {
  if (wiz.step === 'method') return wizMethod();
  if (wiz.step === 'result') return wizResult();
  return wiz.method === 'custom' ? wizCustom() : wizClassic();
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
    if (loading) app.innerHTML = '<div class="boot">Chargement\u2026</div>';
    else if (bootError) app.innerHTML = viewBootError();
    else { if (!wiz) wiz = freshWiz('setup'); app.innerHTML = viewWizard(); }
  } else if (wiz) {
    tabs.hidden = true;
    app.innerHTML = viewWizard();
  } else {
    tabs.hidden = false;
    var v = { home: viewHome, log: viewLog, stats: viewStats, set: viewSet }[view] || viewHome;
    app.innerHTML = headerHtml() + v();
    Array.prototype.forEach.call(tabs.querySelectorAll('.tab'), function (b) {
      if (b.dataset.tab === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  if (wiz && wiz.step === 'form') updateWizLive();
  renderSheet();
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
/* ---------- Actions de l'assistant d'estimation ---------- */
function wizGo(step) { wiz.step = step; render(); window.scrollTo(0, 0); }
function wizOpen(kind) { wiz = wizFromState(kind); render(); window.scrollTo(0, 0); }
function wizCancel() { wiz = null; render(); window.scrollTo(0, 0); }
function wizBack() {
  if (wiz.step === 'result') return wizGo('form');
  if (wiz.step === 'form') return wizGo('method');
  if (wiz.mode === 'edit') wizCancel();
}
function wizNext() {
  var r = wizCompute();
  if (r.error) { var m = $('#w-msg'); if (m) m.textContent = r.error; return; }
  wiz.calc = r;
  wizGo('result');
}
function wizApply() {
  var totals = {}, any = 0;
  PRAYERS.forEach(function (p) {
    var el = $('#w-t-' + p.k), v;
    if (el) { v = Math.max(0, Math.min(1000000, Math.round(Number(el.value) || 0))); any += v; }
    else v = (wiz.calc && wiz.calc.totals[p.k]) || 0;
    totals[p.k] = v;
  });
  if (!any) { toast('Indique au moins une prière à rattraper'); return; }
  var est = {
    method: wiz.method, margin: wiz.margin, share: wiz.share,
    start: JSON.parse(JSON.stringify(wiz.start)), prayers: JSON.parse(JSON.stringify(wiz.prayers)), at: todayKey()
  };
  var edit = wiz.mode === 'edit';
  if (!edit) {
    var on = {};
    PRAYERS.forEach(function (p) { on[p.k] = p.k === 'witr' ? wiz.witr : true; });
    state = { v: 2, cfg: { totals: totals, on: on, since: todayKey(), est: est }, prefs: cleanPrefs(null), days: {}, updatedAt: 0 };
  } else {
    /* Seuls les objectifs et la recette changent : state.days (tout l'historique) n'est jamais touché */
    PRAYERS.forEach(function (p) { state.cfg.totals[p.k] = totals[p.k]; });
    state.cfg.on.witr = wiz.witr;
    state.cfg.est = est;
  }
  wiz = null; view = 'home'; calMonth = null; calSel = null;
  commit();
  window.scrollTo(0, 0);
  toast(edit ? 'Estimation mise à jour. Ton suivi est conservé.' : 'C’est parti. Tu peux corriger ton estimation à tout moment.');
}
function wizPerOn(k) {
  var QE = window.QadaEstimate, d = wiz.prayers[k];
  var rg = QE.resolveRange(Object.assign({}, wiz.start, { endMode: 'today' }), startOfToday()), from = '';
  if (rg && !rg.error) from = dkey(rg.from || addDays(startOfToday(), -rg.days));
  d.kind = 'periods';
  d.periods = [{ from: from, to: '', freq: QE.freqOf(d.freq) ? d.freq : '' }];
  render();
}
function wizPerOff(k) {
  var d = wiz.prayers[k];
  if (d.periods[0] && window.QadaEstimate.freqOf(d.periods[0].freq)) d.freq = d.periods[0].freq;
  d.kind = 'freq'; d.periods = [];
  render();
}
function wizPerAdd(k) {
  var d = wiz.prayers[k];
  if (d.periods.length < 12) d.periods.push({ from: '', to: '', freq: '' });
  render();
}
function wizPerDel(k, n) {
  var d = wiz.prayers[k];
  if (d.periods.length > 1) d.periods.splice(n, 1);
  render();
}
function wizField(t, isChange) {
  if (!wiz || !t.dataset || !t.dataset.w) return false;
  var v = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.num) v = Number(v) || 0;
  setPath(wiz, t.dataset.w, v);
  if (isChange && t.dataset.rr) render(); else updateWizLive();
  return true;
}
function shiftMonth(n) {
  var d = new Date(calMonth.y, calMonth.m + n, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
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
  state = obj; sheet = null; view = 'home'; wiz = null;
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
    state = null; setDirty(false); setBase(0); saveLocal(); view = 'home'; wiz = null;
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
    case 'tab':
      if (['home', 'log', 'stats', 'set'].indexOf(el.dataset.tab) < 0) break;
      view = el.dataset.tab; histLimit = 60; render(); window.scrollTo(0, 0); break;
    case 'stats-tab': statsTab = el.dataset.v; render(); break;
    case 'cal-sel': calSel = el.dataset.date; render(); break;
    case 'cal-prev': calMonth = shiftMonth(-1); render(); break;
    case 'cal-next': calMonth = shiftMonth(1); render(); break;
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
    case 'wiz-open': wizOpen(el.dataset.m); break;
    case 'wiz-method': wiz.method = el.dataset.m; wizGo('form'); break;
    case 'wiz-back': wizBack(); break;
    case 'wiz-cancel': wizCancel(); break;
    case 'wiz-next': wizNext(); break;
    case 'wiz-apply': wizApply(); break;
    case 'wiz-set': setPath(wiz, el.dataset.k, el.dataset.v); render(); break;
    case 'wiz-per-on': wizPerOn(el.dataset.p); break;
    case 'wiz-per-off': wizPerOff(el.dataset.p); break;
    case 'wiz-per-add': wizPerAdd(el.dataset.p); break;
    case 'wiz-per-del': wizPerDel(el.dataset.p, Number(el.dataset.n)); break;
    case 'rem-off': state.prefs.reminders.on = false; commit(); break;
    case 'rem-dismiss': dismissReminder(); break;
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
  if (wizField(t, true)) return;
  if (a === 'wiz-kind' && wiz) {
    var d = wiz.prayers[t.dataset.p], v = t.value;
    if (v === '__count') d.kind = 'count';
    else if (v === '__none') d.kind = 'none';
    else { d.kind = 'freq'; d.freq = v; }
    render();
  } else if (a === 'total') {
    state.cfg.totals[PRAYERS[Number(t.dataset.i)].k] = Math.max(0, Math.min(1000000, Math.round(Number(t.value) || 0)));
    commit();
  } else if (a === 'toggle') {
    state.cfg.on[PRAYERS[Number(t.dataset.i)].k] = t.checked;
    commit();
  } else if (a === 'rem-on') {
    state.prefs.reminders.on = t.checked;
    try { localStorage.removeItem('qada-rem:' + uid); } catch (x) {}
    commit();
  } else if (a === 'rem-type') {
    state.prefs.reminders.type = t.value; commit();
  } else if (a === 'rem-time') {
    if (/^\d{2}:\d{2}$/.test(t.value)) { state.prefs.reminders.time = t.value; commit(); }
  } else if (a === 'rem-goal') {
    var g = Math.round(Number(t.value));
    if (g >= 1) { state.prefs.reminders.goal = Math.min(100, g); commit(); }
  } else if (a === 'rem-day') {
    var dd = Number(t.dataset.d), arr = state.prefs.reminders.days.slice(), ix = arr.indexOf(dd);
    if (t.checked && ix < 0) arr.push(dd);
    if (!t.checked && ix >= 0) arr.splice(ix, 1);
    state.prefs.reminders.days = arr; commit();
  } else if (a === 'ms-show') {
    state.prefs.showMilestones = t.checked; commit();
  } else if (a === 'ms-list') {
    state.prefs.milestones = cleanPrefs({ milestones: t.value.split(/[^0-9]+/).filter(Boolean).map(Number) }).milestones;
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
  } else if (wizField(t, false)) {
    /* champ de l'assistant : l'aperçu a été mis à jour */
  } else if (t.id && t.id.indexOf('w-t-') === 0) {
    updateResTotal();
  } else if (t.id === 'import-json' && sheet) {
    sheet.text = t.value;
  }
});

document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet) closeSheet(); });
/* Mémorise les sections repliables ouvertes pour qu'elles le restent après un rafraîchissement de l'écran */
document.addEventListener('toggle', function (e) {
  var d = e.target;
  if (d && d.dataset && d.dataset.sec) secOpen[d.dataset.sec] = d.open;
}, true);

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
