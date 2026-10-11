'use strict';
(function () {
  const C = window.SANCAK_CONFIG;
  const API = 'https://api.jsonbin.io/v3/b/' + C.BIN_ID;

  // Kurucu sorularının cevap hash'leri (düz yazı değil)
  const FOUNDER_Q = [
    ["Sancak RP'nin kurucusu kimdir?", '493842e003b6f0f7f532622d2663f2040d289ed14594d06421cb62273dae8e95'],
    ["Sancak RP'nin web sitesini yapan kişi kimdir?", '583577fd9ddfb7fb1cd50a54b6409fa69db6d3cb9371bc0c68ae5a8b3968f798'],
    ["Sancak RP'nin tagı nedir?", '80881c1d2b21551ab0618d22fa430eee8475c1a4ff0d0686a5c1a2719e7b02f0'],
    ["Sancak RP'nin en yetkili 2 ismi?", '72d5dcd024b8e7c1f68f018e8c10603ec12454518d51a748e67c75cbb172e632']
  ];

  let DB = null, ME = null, lastLoad = 0, ctl = 1, busy = false, lastSend = 0;
  let timers = [];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = () => new Date().toISOString();
  const fmt = (d) => new Date(d).toLocaleString('tr-TR');
  const safeUrl = (u) => /^(https?:\/\/|img\/)/i.test(u || '');

  /* ---------- Güvenli yardımcılar ---------- */
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  async function hashPw(pw, salt) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256));
  }
  const MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u' };
  const nt = (s) => String(s).replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase().replace(/[çğıöşü]/g, (c) => MAP[c]);
  const ansKey = (s) => String(s).split(/[\s,;]+/).filter(Boolean).map(nt).sort().join('|');
  const ansHash = (s) => sha('sancak|' + ansKey(s));
  function throttle(name, max, sec) {
    const k = 'sk_t_' + name;
    let a = [];
    try { a = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { a = []; }
    const t = Date.now();
    a = a.filter((x) => t - x < sec * 1000);
    if (a.length >= max) throw new Error('Çok hızlı işlem yaptın. Biraz bekleyip tekrar dene.');
    a.push(t);
    localStorage.setItem(k, JSON.stringify(a));
  }

  /* ---------- Veritabanı (JSONBin) ---------- */
  function ensure(d) {
    d.settings = d.settings || {};
    d.settings.siteName = d.settings.siteName || 'Sancak Roleplay';
    d.settings.chatLimit = d.settings.chatLimit || 50;
    ['users', 'ranks', 'menus', 'controlModules', 'applicationQuestions', 'applications', 'announcements', 'banners', 'gallery', 'socials', 'chat', 'logs', 'updates', 'faq', 'tickets'].forEach((k) => { d[k] = d[k] || []; });
    d.security = d.security || {};
    d.security.failedLogins = d.security.failedLogins || [];
    d.security.reports = d.security.reports || [];
    d.security.bannedUsers = d.security.bannedUsers || [];
    d.security.rateLimitPerMinute = d.security.rateLimitPerMinute || 20;
    d.rules = d.rules || 'Kurallar yakında yetkililer tarafından yazılacak.';
    d.about = d.about || 'Sancak Roleplay, Türk oyuncuların buluştuğu bir roleplay topluluğudur.';
    return d;
  }
  async function load() {
    const r = await fetch(API + '/latest', { headers: { 'X-Access-Key': C.ACCESS_KEY, 'X-Bin-Meta': 'false' } });
    if (!r.ok) throw new Error('Veritabanına ulaşılamadı (' + r.status + ')');
    const d = await r.json();
    return ensure(d.record || d);
  }
  async function save(db) {
    const r = await fetch(API, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Access-Key': C.ACCESS_KEY, 'X-Bin-Versioning': 'false' }, body: JSON.stringify(db) });
    if (!r.ok) throw new Error('Kaydedilemedi (' + r.status + ')');
  }
  async function mutate(fn) {
    const db = await load();
    const res = await fn(db);
    await save(db);
    DB = db; lastLoad = Date.now(); syncMe();
    return res;
  }
  async function refresh(force) {
    if (force || !DB || Date.now() - lastLoad > 30000) { DB = await load(); lastLoad = Date.now(); syncMe(); }
  }
  function syncMe() {
    const s = getSession();
    ME = null;
    if (s && DB) { const u = DB.users.find((x) => x.id === s.id); if (u && !u.banned && u.tokenHash === s.th) ME = u; }
  }
  function getSession() { try { return JSON.parse(localStorage.getItem('sk_session') || 'null'); } catch (e) { return null; } }

  /* ---------- Rütbe / yetki ---------- */
  const L = (u, db) => { db = db || DB; if (!u || !u.rankId) return 0; const r = db.ranks.find((x) => x.id === u.rankId); return r ? r.level : 0; };
  const rankName = (u, db) => { db = db || DB; const r = u && db.ranks.find((x) => x.id === u.rankId); return r ? r.name : 'Üye'; };
  const isFirst = (db, u) => !!u && db.settings.firstFounderId === u.id;
  const canTouch = (db, a, t) => isFirst(db, a) || L(t, db) < L(a, db);
  const modMin = (db, id) => { const m = db.controlModules.find((x) => x.id === id); return m ? m.minLevel : 99; };
  function need(db, min) {
    const s = getSession();
    const a = s && db.users.find((u) => u.id === s.id && u.tokenHash === s.th);
    if (!a || a.banned) throw new Error('Giriş yapman gerekiyor.');
    if (L(a, db) < min) throw new Error('Bu işlem için yetkin yok.');
    return a;
  }
  function addLog(db, a, text) {
    db.logs.push({ t: now(), u: a ? a.username : '-', text });
    db.logs = db.logs.slice(-300);
  }
  function rankOpts(db, a) {
    const al = L(a, db);
    return db.ranks.slice().sort((x, y) => y.level - x.level).filter((r) => al >= 18 || r.level < al);
  }
  function setRankDb(db, actor, target, rankId) {
    if (actor.id === target.id) throw new Error('Kendi rütbeni değiştiremezsin.');
    if (!canTouch(db, actor, target)) throw new Error('Bu kullanıcıya müdahale yetkin yok.');
    if (rankId) {
      const r = db.ranks.find((x) => x.id === rankId);
      if (!r) throw new Error('Rütbe bulunamadı.');
      if (!(L(actor, db) >= 18 || r.level < L(actor, db))) throw new Error('Bu rütbeyi veremezsin.');
      target.rankId = rankId;
      addLog(db, actor, target.username + ' kullanıcısına "' + r.name + '" rütbesi verildi.');
    } else {
      target.rankId = null;
      addLog(db, actor, target.username + ' kullanıcısının rütbesi kaldırıldı.');
    }
  }

  /* ---------- Arayüz yardımcıları ---------- */
  function toast(msg, good) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (good ? ' good' : ''); t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 3500);
  }
  function modal(html) { const m = $('#modal'); m.innerHTML = '<div class="box">' + html + '</div>'; m.hidden = false; }
  function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
  const go = (r) => { location.hash = '#/' + r; };
  const empty = (t) => '<p class="muted">' + t + '</p>';

  function renderNav() {
    $('#brandName').textContent = DB ? DB.settings.siteName : 'Sancak Roleplay';
    if (!DB) { $('#nav').innerHTML = ''; return; }
    const lv = L(ME);
    const cur = (location.hash.replace('#/', '') || 'home').split('/')[0];
    const items = DB.menus.filter((m) => m.public || (ME && lv >= (m.minLevel || 0)));
    let h = items.map((m) => '<a href="#/' + esc(m.id) + '" class="' + (cur === m.id ? 'on' : '') + '">' + esc(m.name) + '</a>').join('');
    if (ME) h += '<span class="who">' + esc(ME.username) + ' · ' + esc(rankName(ME)) + '</span><button data-act="logout">Çıkış</button>';
    else h += '<a href="#/login" class="' + (cur === 'login' ? 'on' : '') + '">Giriş</a><a href="#/register" class="' + (cur === 'register' ? 'on' : '') + '">Kayıt ol</a>';
    $('#nav').innerHTML = h;
    $('#notice').innerHTML = DB.settings.maintenance ? '<div class="bar">Site bakım modunda. Sadece yetkililer tüm sayfalara erişebilir.</div>' : '';
  }

  /* ---------- Sayfalar ---------- */
  const P = {}, POST = {};

  P.home = () => {
    const bn = DB.banners.filter((b) => safeUrl(b.img));
    const slides = bn.map((b, i) => '<img class="slide' + (i === 0 ? ' on' : '') + '" src="' + esc(b.img) + '" alt="' + esc(b.title) + '">').join('');
    const ann = DB.announcements.slice().reverse().slice(0, 5).map((a) => '<div class="card"><h3>' + esc(a.title) + '</h3><time>' + fmt(a.t) + '</time><p>' + esc(a.body) + '</p></div>').join('') || empty('Henüz duyuru yok.');
    return '<div class="hero">' + slides + '<div class="txt"><h1>' + esc(DB.settings.siteName) + '</h1><p>İstanbul\'un gecesinde yeni bir hikâye başlıyor. Rolünü seç, şehre katıl.</p>' +
      (ME ? '' : '<a class="btn" href="#/register">Kayıt ol</a> <a class="btn alt" href="#/login">Giriş yap</a>') + '</div></div>' +
      '<section class="blk"><h2>Duyurular</h2>' + ann + '</section>' +
      '<section class="blk"><h2>Oyundan kesitler</h2>' + galleryHtml() + '</section>' +
      (ME ? '' : '<p class="muted">Diğer bölümleri görmek için giriş yapman gerekiyor.</p>');
  };
  POST.home = () => {
    const s = document.querySelectorAll('.hero .slide');
    if (s.length > 1) { let i = 0; timers.push(setInterval(() => { s[i].classList.remove('on'); i = (i + 1) % s.length; s[i].classList.add('on'); }, 5000)); }
  };
  function galleryHtml() {
    const g = DB.gallery.filter((x) => safeUrl(x.img));
    return g.length ? '<div class="grid">' + g.map((x) => '<button class="card shot" data-act="zoom" data-src="' + esc(x.img) + '"><img loading="lazy" src="' + esc(x.img) + '" alt="' + esc(x.title) + '"><span>' + esc(x.title) + '</span></button>').join('') + '</div>' : empty('Henüz görsel yok.');
  }
  P.announcements = () => '<h2>Duyurular</h2>' + (DB.announcements.slice().reverse().map((a) => '<div class="card"><h3>' + esc(a.title) + '</h3><time>' + fmt(a.t) + '</time><p>' + esc(a.body) + '</p></div>').join('') || empty('Henüz duyuru yok.'));
  P.gallery = () => '<h2>Oyundan kesitler</h2>' + galleryHtml();
  P.about = () => '<h2>Hakkımızda</h2><div class="card rules">' + esc(DB.about) + '</div>';
  P.rules = () => '<h2>Kurallar</h2><div class="card rules">' + esc(DB.rules) + '</div>';
  P.updates = () => '<h2>Güncellemeler</h2>' + (DB.updates.slice().reverse().map((u) => '<div class="card"><h3>' + esc(u.title) + '</h3><p class="rules">' + esc(u.body) + '</p></div>').join('') || empty('Henüz güncelleme notu yok.'));
  P.faq = () => '<h2>Sık sorulan sorular</h2>' + (DB.faq.map((f) => '<div class="card"><h3>' + esc(f.q) + '</h3><p class="rules">' + esc(f.a) + '</p></div>').join('') || empty('Henüz soru eklenmedi.'));
  P.socials = () => '<h2>Sosyal medya</h2>' + (DB.socials.filter((s) => safeUrl(s.url)).map((s) => '<div class="card"><h3>' + esc(s.name) + '</h3><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.url) + '</a></div>').join('') || empty('Henüz bağlantı eklenmedi.'));
  P.staff = () => {
    const st = DB.users.filter((u) => u.rankId && !u.banned).sort((a, b) => L(b) - L(a));
    return '<h2>Yetkili kadrosu</h2>' + (st.length ? '<div class="card wrapx"><table><tr><th>Kullanıcı</th><th>Rütbe</th><th>Discord</th></tr>' + st.map((u) => '<tr><td>' + esc(u.username) + '</td><td>' + esc(rankName(u)) + '</td><td>' + esc(u.discord || '-') + '</td></tr>').join('') + '</table></div>' : empty('Henüz yetkili yok.'));
  };

  P.login = () => ME ? '<p>Zaten giriş yaptın.</p>' : '<div class="tabs"><a class="btn" href="#/login">Giriş</a><a class="btn alt" href="#/register">Kayıt ol</a></div><div class="card form"><h2>Giriş yap</h2><form data-form="login"><label>Kullanıcı adı</label><input name="username" required autocomplete="username"><label>Şifre</label><input name="password" type="password" required autocomplete="current-password"><p><button class="btn">Giriş yap</button></p></form></div>';
  P.register = () => ME ? '<p>Zaten giriş yaptın.</p>' : '<div class="tabs"><a class="btn alt" href="#/login">Giriş</a><a class="btn" href="#/register">Kayıt ol</a></div><div class="card form"><h2>Kayıt ol</h2><form data-form="register"><label>Kullanıcı adı (3-20, harf/rakam/_/.)</label><input name="username" required maxlength="20" autocomplete="username"><label>Discord adın (isteğe bağlı)</label><input name="discord" maxlength="40"><label>Şifre (en az 6 karakter)</label><input name="password" type="password" required autocomplete="new-password"><label>Şifre tekrar</label><input name="password2" type="password" required autocomplete="new-password"><p><button class="btn">Kayıt ol</button></p></form></div>';

  P.profile = () => {
    const w = (ME.warnings || []).map((x) => '<li>' + esc(x.reason) + ' <span class="meta">(' + esc(x.by) + ', ' + fmt(x.t) + ')</span></li>').join('');
    return '<h2>Profil</h2><div class="card"><h3>' + esc(ME.username) + '</h3><p>Rütbe: <span class="tag">' + esc(rankName(ME)) + '</span></p><p class="meta">Kayıt: ' + fmt(ME.created) + '</p></div>' +
      '<div class="card form"><h3>Discord adı</h3><form data-form="discord"><input name="discord" maxlength="40" value="' + esc(ME.discord) + '"><p><button class="btn sm">Kaydet</button></p></form></div>' +
      '<div class="card form"><h3>Şifre değiştir</h3><form data-form="password"><label>Eski şifre</label><input name="old" type="password" required><label>Yeni şifre</label><input name="new" type="password" required><p><button class="btn sm">Değiştir</button></p></form></div>' +
      (w ? '<div class="card"><h3>Uyarıların</h3><ul>' + w + '</ul></div>' : '');
  };

  P.chat = () => '<h2>Sohbet</h2><p class="muted">Sohbet ' + DB.settings.chatLimit + ' mesajda bir sıfırlanır.</p><div class="chat" id="chatbox"></div><form class="chatform" data-form="chat"><input name="text" maxlength="300" placeholder="Mesajın…" autocomplete="off" required><button class="btn">Gönder</button></form>';
  POST.chat = () => { drawChat(); timers.push(setInterval(async () => { if (document.hidden) return; try { DB = await load(); lastLoad = Date.now(); syncMe(); drawChat(); } catch (e) { /* sessiz */ } }, 15000)); };
  function drawChat() {
    const b = $('#chatbox'); if (!b) return;
    const bottom = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
    b.innerHTML = DB.chat.map((m) => m.sys ? '<div class="msg sys">' + esc(m.text) + '</div>' : '<div class="msg"><b>' + esc(m.name) + '</b> <small>' + esc(m.rank) + ' · ' + new Date(m.t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) + '</small><br>' + esc(m.text) + '</div>').join('') || '<p class="muted">İlk mesajı sen yaz.</p>';
    if (bottom || !b.dataset.init) { b.scrollTop = b.scrollHeight; b.dataset.init = '1'; }
  }

  P.apply = () => {
    if (L(ME) > 0) return '<h2>Yetkili başvurusu</h2><p>Zaten yetkilisin.</p>';
    const mine = DB.applications.filter((a) => a.userId === ME.id).reverse();
    const pend = mine.find((a) => a.status === 'pending');
    const st = { pending: 'Bekliyor', accepted: 'Kabul edildi', rejected: 'Reddedildi' };
    const hist = mine.map((a) => '<li>' + fmt(a.t) + ' · ' + esc(a.type === 'admin' ? 'Admin' : 'Moderatör') + ' · <span class="tag">' + st[a.status] + '</span></li>').join('');
    if (pend) return '<h2>Yetkili başvurusu</h2><div class="card">Başvurun inceleniyor. Sonuç buraya yansır.</div><ul>' + hist + '</ul>';
    return '<h2>Yetkili başvurusu</h2><div class="card form"><form data-form="apply"><label>Hangi kadro?</label><select name="type"><option value="mod">Moderatör (Stayjer Moderatör olarak başlarsın)</option><option value="admin">Admin (Stayjer Admin olarak başlarsın)</option></select>' +
      DB.applicationQuestions.map((q) => '<label>' + esc(q.q) + '</label><textarea name="a_' + esc(q.id) + '" maxlength="800" required></textarea>').join('') + '<p><button class="btn">Başvuruyu gönder</button></p></form></div>' + (hist ? '<h3>Geçmiş başvurular</h3><ul>' + hist + '</ul>' : '');
  };

  P.support = () => {
    const mine = DB.tickets.filter((t) => t.uid === ME.id).reverse();
    return '<h2>Destek</h2><div class="card form"><form data-form="ticket"><label>Konu</label><input name="subject" maxlength="100" required><label>Mesajın</label><textarea name="msg" maxlength="1000" required></textarea><p><button class="btn">Talep gönder</button></p></form></div>' +
      (mine.length ? '<h3>Taleplerin</h3>' + mine.map((t) => '<div class="card"><b>' + esc(t.subject) + '</b> <span class="tag ' + (t.status === 'open' ? '' : 'ok') + '">' + (t.status === 'open' ? 'Açık' : 'Kapalı') + '</span><p>' + esc(t.msg) + '</p></div>').join('') : '');
  };

  /* ---------- Site kontrol ---------- */
  const CRUD = {
    announcements: { m: 2, f: [['title', 'Başlık'], ['body', 'İçerik', 1]] },
    banners: { m: 3, f: [['title', 'Başlık'], ['img', 'Görsel adresi (img/banner.jpg veya https://…)']] },
    gallery: { m: 4, f: [['title', 'Başlık'], ['img', 'Görsel adresi (img/kesit1.png veya https://…)']] },
    applicationQuestions: { m: 15, f: [['q', 'Soru']] },
    socials: { m: 16, f: [['name', 'Ad'], ['url', 'Bağlantı (https://…)']] },
    updates: { m: 17, f: [['title', 'Başlık'], ['body', 'Not', 1]] },
    faq: { m: 19, f: [['q', 'Soru'], ['a', 'Cevap', 1]] }
  };
  function crudHtml(key) {
    const c = CRUD[key];
    const inputs = (it) => c.f.map((f) => '<label>' + f[1] + '</label>' + (f[2] ? '<textarea name="' + f[0] + '" maxlength="2000">' + esc(it ? it[f[0]] : '') + '</textarea>' : '<input name="' + f[0] + '" maxlength="500" value="' + esc(it ? it[f[0]] : '') + '">')).join('');
    return '<div class="card"><h3>Yeni ekle</h3><form data-form="crud-add" data-key="' + key + '">' + inputs() + '<p><button class="btn">Ekle</button></p></form></div>' +
      DB[key].slice().reverse().map((it) => '<div class="card"><form data-form="crud-edit" data-key="' + key + '" data-id="' + esc(it.id) + '">' + inputs(it) + '<p><button class="btn sm">Kaydet</button> <button type="button" class="btn sm bad" data-act="del" data-key="' + key + '" data-id="' + esc(it.id) + '">Sil</button></p></form></div>').join('');
  }
  function cleanFields(c, d) {
    const o = {};
    c.f.forEach((f) => {
      const v = String(d[f[0]] || '').trim().slice(0, 2000);
      if (!v) throw new Error('Boş alan bırakma.');
      if ((f[0] === 'img' || f[0] === 'url') && !safeUrl(v)) throw new Error('Adres https:// veya img/ ile başlamalı.');
      o[f[0]] = v;
    });
    return o;
  }
  const userOpts = (list) => list.map((u) => '<option value="' + esc(u.id) + '">' + esc(u.username) + ' (' + esc(rankName(u)) + ')</option>').join('');
  function appsHtml(canAct, onlyPending) {
    const st = { pending: 'Bekliyor', accepted: 'Kabul', rejected: 'Red' };
    const list = DB.applications.filter((a) => !onlyPending || a.status === 'pending').slice().reverse();
    return list.map((a) => '<div class="card"><b>' + esc(a.username) + '</b> · ' + (a.type === 'admin' ? 'Admin' : 'Moderatör') + ' <span class="tag ' + (a.status === 'accepted' ? 'ok' : a.status === 'rejected' ? 'bad' : '') + '">' + st[a.status] + '</span><div class="meta">' + fmt(a.t) + (a.by ? ' · ' + esc(a.by) : '') + '</div>' +
      a.answers.map((x) => '<p><b>' + esc(x.q) + '</b><br>' + esc(x.a) + '</p>').join('') +
      (canAct && a.status === 'pending' ? '<button class="btn sm ok row" data-act="appok" data-id="' + esc(a.id) + '">Kabul et</button><button class="btn sm bad" data-act="appno" data-id="' + esc(a.id) + '">Reddet</button>' : '') + '</div>').join('') || empty('Başvuru yok.');
  }
  function rankUsers(withRemove) {
    const opts = rankOpts(DB, ME);
    const list = DB.users.filter((u) => u.id !== ME.id && (withRemove ? u.rankId : !u.rankId));
    if (!list.length) return empty('Listelenecek kullanıcı yok.');
    return list.map((u) => canTouch(DB, ME, u)
      ? '<div class="card"><form data-form="setrank" data-uid="' + esc(u.id) + '"><b>' + esc(u.username) + '</b> <span class="tag">' + esc(rankName(u)) + '</span><select name="rank">' + (withRemove ? '<option value="none">Rütbeyi kaldır</option>' : '') + opts.map((r) => '<option value="' + r.id + '"' + (r.id === u.rankId ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</select><p><button class="btn sm">Uygula</button></p></form></div>'
      : '<div class="card"><b>' + esc(u.username) + '</b> <span class="tag">' + esc(rankName(u)) + '</span> <span class="meta">yetkin yetmiyor</span></div>').join('');
  }

  const MOD = {};
  MOD[1] = () => '<div class="stats">' + [['Üye', DB.users.length], ['Yetkili', DB.users.filter((u) => u.rankId).length], ['Bekleyen başvuru', DB.applications.filter((a) => a.status === 'pending').length], ['Açık destek', DB.tickets.filter((t) => t.status === 'open').length], ['Sohbet mesajı', DB.chat.length]].map((s) => '<div class="stat"><b>' + s[1] + '</b>' + s[0] + '</div>').join('') + '</div>';
  [2, 3, 4, 15, 16, 17, 19].forEach((id) => { const key = Object.keys(CRUD).find((k) => CRUD[k].m === id); MOD[id] = () => crudHtml(key); });
  MOD[5] = () => (DB.chat.filter((m) => !m.sys).slice().reverse().map((m) => '<div class="card"><b>' + esc(m.name) + '</b> <span class="meta">' + fmt(m.t) + '</span><p>' + esc(m.text) + '</p><button class="btn sm bad" data-act="delmsg" data-id="' + esc(m.id) + '">Mesajı sil</button></div>').join('') || empty('Sohbet boş.'));
  MOD[6] = () => '<div class="card"><p>Sohbetteki tüm mesajlar silinir.</p><button class="btn bad" data-act="clearchat">Sohbeti temizle</button></div>';
  MOD[7] = () => '<div class="card wrapx"><table><tr><th>Kullanıcı</th><th>Rütbe</th><th>Discord</th><th>Kayıt</th><th>Durum</th></tr>' + DB.users.map((u) => '<tr><td>' + esc(u.username) + '</td><td>' + esc(rankName(u)) + '</td><td>' + esc(u.discord || '-') + '</td><td>' + fmt(u.created) + '</td><td>' + (u.banned ? '<span class="tag bad">Engelli</span>' : '<span class="tag ok">Aktif</span>') + '</td></tr>').join('') + '</table></div>';
  MOD[8] = () => DB.users.filter((u) => u.id !== ME.id).map((u) => '<div class="card"><b>' + esc(u.username) + '</b> <span class="tag">' + esc(rankName(u)) + '</span> ' + (u.banned ? '<span class="tag bad">Engelli</span>' : '') + (canTouch(DB, ME, u) ? '<p><button class="btn sm ' + (u.banned ? 'ok' : 'bad') + '" data-act="ban" data-uid="' + esc(u.id) + '">' + (u.banned ? 'Engeli kaldır' : 'Engelle') + '</button></p>' : ' <span class="meta">yetkin yetmiyor</span>') + '</div>').join('') || empty('Kullanıcı yok.');
  MOD[9] = () => '<div class="card form"><form data-form="warn"><label>Kullanıcı</label><select name="uid">' + userOpts(DB.users.filter((u) => u.id !== ME.id && canTouch(DB, ME, u))) + '</select><label>Sebep</label><input name="reason" maxlength="200" required><p><button class="btn">Uyar</button></p></form></div>' +
    DB.users.filter((u) => (u.warnings || []).length).map((u) => '<div class="card"><b>' + esc(u.username) + '</b><ul>' + u.warnings.map((w) => '<li>' + esc(w.reason) + ' <span class="meta">(' + esc(w.by) + ')</span></li>').join('') + '</ul></div>').join('');
  MOD[10] = () => '<p class="muted">Rütbesi olmayan kullanıcılara rütbe ver.</p>' + rankUsers(false);
  MOD[11] = () => '<p class="muted">Rütbesi olanların rütbesini değiştir veya kaldır.</p>' + rankUsers(true);
  MOD[12] = () => DB.ranks.slice().sort((a, b) => b.level - a.level).map((r) => '<div class="card"><form data-form="rankname" data-id="' + r.id + '"><label>Seviye ' + r.level + '</label><input name="name" maxlength="40" value="' + esc(r.name) + '"><p><button class="btn sm">Kaydet</button></p></form></div>').join('');
  MOD[13] = () => appsHtml(L(ME) >= modMin(DB, 14), false);
  MOD[14] = () => appsHtml(true, true);
  MOD[20] = () => DB.tickets.slice().reverse().map((t) => '<div class="card"><b>' + esc(t.subject) + '</b> · ' + esc(t.name) + ' <span class="tag ' + (t.status === 'open' ? '' : 'ok') + '">' + (t.status === 'open' ? 'Açık' : 'Kapalı') + '</span><p>' + esc(t.msg) + '</p>' + (t.status === 'open' ? '<button class="btn sm ok row" data-act="tclose" data-id="' + esc(t.id) + '">Kapat</button>' : '') + '<button class="btn sm bad" data-act="tdel" data-id="' + esc(t.id) + '">Sil</button></div>').join('') || empty('Destek talebi yok.');
  MOD[21] = () => '<div class="card wrapx"><table><tr><th>Zaman</th><th>Kim</th><th>İşlem</th></tr>' + DB.logs.slice().reverse().slice(0, 100).map((l) => '<tr><td>' + fmt(l.t) + '</td><td>' + esc(l.u) + '</td><td>' + esc(l.text) + '</td></tr>').join('') + '</table></div>';
  MOD[22] = () => '<div class="card wrapx"><h3>Başarısız girişler</h3><table><tr><th>Zaman</th><th>Hesap</th></tr>' + DB.security.failedLogins.slice().reverse().slice(0, 50).map((f) => '<tr><td>' + fmt(f.t) + '</td><td>' + esc(f.u) + '</td></tr>').join('') + '</table></div><p><a href="#/security">Güvenlik Merkezi\'ne git</a></p>';
  MOD[23] = () => '<div class="card"><p>Bakım modu: <span class="tag ' + (DB.settings.maintenance ? 'bad' : 'ok') + '">' + (DB.settings.maintenance ? 'Açık' : 'Kapalı') + '</span></p><button class="btn" data-act="maint">' + (DB.settings.maintenance ? 'Bakımı kapat' : 'Bakımı aç') + '</button></div>';
  MOD[24] = () => '<div class="card form"><form data-form="settings"><label>Site adı</label><input name="siteName" maxlength="40" value="' + esc(DB.settings.siteName) + '"><label>Sohbet sıfırlama sınırı (mesaj)</label><input name="chatLimit" type="number" min="10" max="500" value="' + DB.settings.chatLimit + '"><label>Hakkımızda</label><textarea name="about" maxlength="3000">' + esc(DB.about) + '</textarea><label>Kurallar</label><textarea name="rules" maxlength="6000" style="min-height:160px">' + esc(DB.rules) + '</textarea><p><button class="btn">Kaydet</button></p></form></div>';
  MOD[25] = () => {
    const fs = DB.users.filter((u) => u.rankId === 1);
    return '<div class="card"><h3>Kurucular</h3>' + (fs.map((u) => '<p><b>' + esc(u.username) + '</b> ' + (isFirst(DB, u) ? '<span class="tag ok">1. Kurucu</span>' : '<span class="tag">Kurucu</span>') + (isFirst(DB, ME) && u.id !== ME.id ? ' <button class="btn sm bad" data-act="unrank" data-uid="' + esc(u.id) + '">Rütbeyi kaldır</button>' : '') + '</p>').join('') || empty('Kurucu yok.')) + '</div>' +
      '<div class="card form"><h3>Yeni kurucu ata</h3><form data-form="assignfounder"><select name="uid">' + userOpts(DB.users.filter((u) => u.rankId !== 1)) + '</select><p><button class="btn">Kurucu yap</button></p></form><p class="meta">Sadece 1. kurucu, diğer kurucuların rütbesini değiştirebilir.</p></div>';
  };

  P.control = () => {
    const lv = L(ME);
    const mods = DB.controlModules.filter((m) => lv >= m.minLevel).sort((a, b) => a.id - b.id);
    if (!mods.length) return '<p>Yetkin yok.</p>';
    if (!mods.find((m) => m.id === ctl)) ctl = mods[0].id;
    const cur = mods.find((m) => m.id === ctl);
    return '<h2>Site kontrol</h2><div class="ctl"><div class="side">' + mods.map((m) => '<button class="' + (m.id === ctl ? 'on' : '') + '" data-act="mod" data-id="' + m.id + '">' + esc(m.name) + '</button>').join('') + '</div><div><h3>' + esc(cur.name) + '</h3>' + (MOD[cur.id] ? MOD[cur.id]() : empty('Bu modül henüz hazır değil.')) + '</div></div>';
  };

  P.security = () => {
    const f = DB.security.failedLogins, rp = DB.security.reports;
    return '<h2>Güvenlik Merkezi</h2><div class="stats"><div class="stat"><b>' + f.filter((x) => Date.now() - x.t < 86400000).length + '</b>24 saatte hatalı giriş</div><div class="stat"><b>' + DB.users.filter((u) => u.banned).length + '</b>Engelli hesap</div><div class="stat"><b>' + rp.filter((r) => r.status === 'new').length + '</b>Yeni güvenlik bildirimi</div></div>' +
      '<div class="card"><h3>Aktif korumalar</h3><ul><li>Şifreler PBKDF2 ile hash\'lenir.</li><li>5 hatalı girişte hesap 5 dakika kilitlenir.</li><li>Tüm kullanıcı içeriği HTML\'e çevrilerek gösterilir (XSS koruması).</li><li>Sıkı içerik güvenlik politikası (CSP) aktif.</li><li>Giriş, kayıt, mesaj ve bildirim formlarında hız sınırı var.</li></ul></div>' +
      '<div class="card"><h3>Kayıtlar</h3><p>Yeni kayıt: <span class="tag ' + (DB.settings.registrationClosed ? 'bad' : 'ok') + '">' + (DB.settings.registrationClosed ? 'Kapalı' : 'Açık') + '</span> <button class="btn sm" data-act="regtoggle">' + (DB.settings.registrationClosed ? 'Aç' : 'Kapat') + '</button></p><button class="btn sm alt" data-act="clearfails">Hatalı giriş kayıtlarını temizle</button></div>' +
      '<h3>Güvenlik bildirimleri (beyaz şapkalı hackerlar)</h3>' + (rp.slice().reverse().map((r) => '<div class="card"><b>' + esc(r.title) + '</b> <span class="tag ' + (r.status === 'new' ? 'bad' : 'ok') + '">' + (r.status === 'new' ? 'Yeni' : 'İncelendi') + '</span><div class="meta">' + fmt(r.t) + ' · ' + esc(r.contact || 'iletişim yok') + '</div><p class="rules">' + esc(r.details) + '</p>' + (r.status === 'new' ? '<button class="btn sm ok row" data-act="rdone" data-id="' + esc(r.id) + '">İncelendi</button>' : '') + '<button class="btn sm bad" data-act="rdel" data-id="' + esc(r.id) + '">Sil</button></div>').join('') || empty('Bildirim yok.')) +
      '<div class="card wrapx"><h3>Son hatalı girişler</h3><table><tr><th>Zaman</th><th>Hesap</th></tr>' + f.slice().reverse().slice(0, 30).map((x) => '<tr><td>' + fmt(x.t) + '</td><td>' + esc(x.u) + '</td></tr>').join('') + '</table></div>';
  };

  /* ---------- Form işleyicileri ---------- */
  const FORM = {};
  function setSession(u, token, th) { localStorage.setItem('sk_session', JSON.stringify({ id: u.id, token, th })); }

  FORM.register = async (f, d) => {
    throttle('reg', 3, 3600);
    const un = d.username.trim();
    if (!/^[A-Za-z0-9_.]{3,20}$/.test(un)) throw new Error('Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ ve . kullanılabilir).');
    if (d.password.length < 6) throw new Error('Şifre en az 6 karakter olmalı.');
    if (d.password !== d.password2) throw new Error('Şifreler aynı değil.');
    const salt = uid() + uid(), hash = await hashPw(d.password, salt), token = uid() + uid() + uid(), th = await sha(token);
    const user = { id: uid(), username: un, discord: String(d.discord || '').trim().slice(0, 40), salt, hash, tokenHash: th, rankId: null, banned: false, warnings: [], created: now() };
    await mutate((db) => {
      if (db.settings.registrationClosed) throw new Error('Kayıtlar şu an kapalı.');
      if (db.users.some((u) => u.username.toLowerCase() === un.toLowerCase())) throw new Error('Bu kullanıcı adı alınmış.');
      db.users.push(user);
    });
    setSession(user, token, th); syncMe(); renderNav(); toast('Hoş geldin!', true); go('home');
  };

  FORM.login = async (f, d) => {
    throttle('login', 8, 60);
    await refresh(true);
    const un = d.username.trim().toLowerCase();
    if (DB.security.failedLogins.filter((x) => x.u === un && Date.now() - x.t < 300000).length >= 5) throw new Error('Çok fazla hatalı deneme. 5 dakika bekle.');
    const u = DB.users.find((x) => x.username.toLowerCase() === un);
    const ok = u && (await hashPw(d.password, u.salt)) === u.hash;
    if (!ok) {
      await mutate((db) => { db.security.failedLogins.push({ u: un.slice(0, 30), t: Date.now() }); db.security.failedLogins = db.security.failedLogins.slice(-200); });
      throw new Error('Kullanıcı adı veya şifre hatalı.');
    }
    if (u.banned) throw new Error('Hesabın engellenmiş.');
    const token = uid() + uid() + uid(), th = await sha(token);
    await mutate((db) => { const x = db.users.find((y) => y.id === u.id); x.tokenHash = th; x.lastLogin = now(); });
    setSession(u, token, th); syncMe(); renderNav(); toast('Giriş yapıldı.', true); go('home');
  };

  FORM.discord = async (f, d) => { await mutate((db) => { need(db, 0); db.users.find((u) => u.id === ME.id).discord = String(d.discord || '').trim().slice(0, 40); }); toast('Kaydedildi.', true); route(); };
  FORM.password = async (f, d) => {
    if (d.new.length < 6) throw new Error('Yeni şifre en az 6 karakter olmalı.');
    const salt = uid() + uid(), hash = await hashPw(d.new, salt);
    const oldOk = (await hashPw(d.old, ME.salt)) === ME.hash;
    if (!oldOk) throw new Error('Eski şifre yanlış.');
    await mutate((db) => { need(db, 0); const u = db.users.find((x) => x.id === ME.id); u.salt = salt; u.hash = hash; });
    f.reset(); toast('Şifre değişti.', true);
  };

  FORM.chat = async (f, d) => {
    const text = d.text.trim().slice(0, 300);
    if (!text) return;
    if (Date.now() - lastSend < 2000) throw new Error('Biraz yavaş yaz.');
    lastSend = Date.now();
    await mutate((db) => {
      const a = need(db, 0);
      if (db.chat.length >= db.settings.chatLimit) db.chat = [{ id: uid(), sys: true, text: 'Sohbet ' + db.settings.chatLimit + ' mesaja ulaştığı için sıfırlandı.', t: now() }];
      db.chat.push({ id: uid(), uid: a.id, name: a.username, rank: rankName(a, db), text, t: now() });
    });
    f.reset(); drawChat();
  };

  FORM.apply = async (f, d) => {
    throttle('apply', 3, 3600);
    await mutate((db) => {
      const a = need(db, 0);
      if (L(a, db) > 0) throw new Error('Zaten yetkilisin.');
      if (db.applications.some((x) => x.userId === a.id && x.status === 'pending')) throw new Error('Bekleyen başvurun var.');
      db.applications.push({ id: uid(), userId: a.id, username: a.username, type: d.type === 'admin' ? 'admin' : 'mod', answers: db.applicationQuestions.map((q) => ({ q: q.q, a: String(d['a_' + q.id] || '').trim().slice(0, 800) })), status: 'pending', t: now() });
      addLog(db, a, 'Yetkili başvurusu gönderdi.');
    });
    toast('Başvurun gönderildi.', true); route();
  };

  FORM.ticket = async (f, d) => {
    throttle('ticket', 5, 3600);
    await mutate((db) => { const a = need(db, 0); db.tickets.push({ id: uid(), uid: a.id, name: a.username, subject: d.subject.trim().slice(0, 100), msg: d.msg.trim().slice(0, 1000), status: 'open', t: now() }); });
    toast('Talebin alındı.', true); route();
  };

  FORM['crud-add'] = async (f, d) => {
    const key = f.dataset.key, c = CRUD[key];
    if (!c) return;
    const o = cleanFields(c, d);
    await mutate((db) => { const a = need(db, modMin(db, c.m)); const it = Object.assign({ id: uid() }, o); if (key === 'announcements') it.t = now(); db[key].push(it); addLog(db, a, key + ' eklendi.'); });
    toast('Eklendi.', true); route();
  };
  FORM['crud-edit'] = async (f, d) => {
    const key = f.dataset.key, c = CRUD[key], id = f.dataset.id;
    if (!c) return;
    const o = cleanFields(c, d);
    await mutate((db) => { const a = need(db, modMin(db, c.m)); const it = db[key].find((x) => String(x.id) === id); if (!it) throw new Error('Kayıt bulunamadı.'); Object.assign(it, o); addLog(db, a, key + ' düzenlendi.'); });
    toast('Kaydedildi.', true); route();
  };

  FORM.setrank = async (f, d) => {
    const tid = f.dataset.uid, rid = d.rank === 'none' ? null : parseInt(d.rank, 10);
    await mutate((db) => { const a = need(db, Math.min(modMin(db, 10), modMin(db, 11))); const t = db.users.find((u) => u.id === tid); if (!t) throw new Error('Kullanıcı yok.'); setRankDb(db, a, t, rid); });
    toast('Rütbe güncellendi.', true); route();
  };
  FORM.rankname = async (f, d) => {
    const id = parseInt(f.dataset.id, 10), name = d.name.trim().slice(0, 40);
    if (!name) throw new Error('İsim boş olamaz.');
    await mutate((db) => { const a = need(db, modMin(db, 12)); const r = db.ranks.find((x) => x.id === id); if (!r) throw new Error('Rütbe yok.'); addLog(db, a, '"' + r.name + '" rütbesi "' + name + '" oldu.'); r.name = name; });
    toast('Kaydedildi.', true); route();
  };
  FORM.warn = async (f, d) => {
    const reason = d.reason.trim().slice(0, 200);
    await mutate((db) => { const a = need(db, modMin(db, 9)); const t = db.users.find((u) => u.id === d.uid); if (!t) throw new Error('Kullanıcı yok.'); if (!canTouch(db, a, t) || t.id === a.id) throw new Error('Bu kullanıcıyı uyaramazsın.'); t.warnings = t.warnings || []; t.warnings.push({ by: a.username, reason, t: now() }); addLog(db, a, t.username + ' uyarıldı: ' + reason); });
    toast('Uyarı verildi.', true); route();
  };
  FORM.settings = async (f, d) => {
    const lim = Math.max(10, Math.min(500, parseInt(d.chatLimit, 10) || 50));
    await mutate((db) => { const a = need(db, modMin(db, 24)); db.settings.siteName = d.siteName.trim().slice(0, 40) || 'Sancak Roleplay'; db.settings.chatLimit = lim; db.about = d.about.slice(0, 3000); db.rules = d.rules.slice(0, 6000); addLog(db, a, 'Site ayarları güncellendi.'); });
    toast('Kaydedildi.', true); renderNav(); route();
  };
  FORM.assignfounder = async (f, d) => {
    await mutate((db) => { const a = need(db, 18); const t = db.users.find((u) => u.id === d.uid); if (!t) throw new Error('Kullanıcı yok.'); t.rankId = 1; addLog(db, a, t.username + ' kurucu yapıldı.'); });
    toast('Kurucu atandı.', true); route();
  };

  FORM.report = async (f, d) => {
    throttle('report', 3, 3600);
    await mutate((db) => { db.security.reports.push({ id: uid(), title: d.title.trim().slice(0, 120), details: d.details.trim().slice(0, 3000), contact: String(d.contact || '').trim().slice(0, 100), status: 'new', t: now() }); db.security.reports = db.security.reports.slice(-100); });
    closeModal(); toast('Bildirimin için teşekkürler.', true);
  };

  FORM.founder = async (f, d) => {
    throttle('founder', 5, 3600);
    if (!ME) throw new Error('Giriş yapman gerekiyor.');
    let ok = true;
    for (let i = 0; i < FOUNDER_Q.length; i++) { if ((await ansHash(d['q' + i] || '')) !== FOUNDER_Q[i][1]) ok = false; }
    if (!ok) {
      await mutate((db) => { db.security.failedLogins.push({ u: 'kurucu-sorusu:' + ME.username, t: Date.now() }); db.security.failedLogins = db.security.failedLogins.slice(-200); });
      throw new Error('Cevaplardan en az biri yanlış.');
    }
    await mutate((db) => {
      const a = need(db, 0);
      if (db.settings.founderClaimed) throw new Error('Kurucu zaten belirlendi.');
      a.rankId = 1; db.settings.founderClaimed = true; db.settings.firstFounderId = a.id;
      addLog(db, a, 'Kurucu rütbesi sorularla alındı.');
    });
    closeModal(); renderNav(); toast('Tebrikler, artık kurucusun!', true); go('control');
  };

  /* ---------- Tıklama eylemleri ---------- */
  const ACT = {};
  ACT.nav = () => $('#nav').classList.toggle('open');
  ACT.close = () => closeModal();
  ACT.zoom = (el) => { if (safeUrl(el.dataset.src)) modal('<img class="big" src="' + esc(el.dataset.src) + '" alt=""><p><button class="btn alt" data-act="close">Kapat</button></p>'); };
  ACT.logout = () => { localStorage.removeItem('sk_session'); ME = null; renderNav(); go('home'); route(); };
  ACT.mod = (el) => { ctl = parseInt(el.dataset.id, 10); route(); };
  ACT.report = () => modal('<h3>Güvenlik açığı bildir</h3><p class="muted">Bir açık bulduysan buradan yetkililere bildir. Lütfen açığı kötüye kullanma.</p><form data-form="report"><label>Başlık</label><input name="title" maxlength="120" required><label>Detaylar</label><textarea name="details" maxlength="3000" required></textarea><label>İletişim (isteğe bağlı)</label><input name="contact" maxlength="100"><p><button class="btn">Gönder</button> <button type="button" class="btn alt" data-act="close">İptal</button></p></form>');
  ACT.founder = () => {
    if (!DB) return;
    if (DB.settings.founderClaimed) return toast('Bu bölüm artık kapalı.');
    if (!ME) { toast('Önce giriş yapmalısın.'); return go('login'); }
    modal('<h3>Kurucu doğrulama</h3><form data-form="founder">' + FOUNDER_Q.map((q, i) => '<label>' + esc(q[0]) + '</label><input name="q' + i + '" required autocomplete="off">').join('') + '<p><button class="btn">Doğrula</button> <button type="button" class="btn alt" data-act="close">İptal</button></p></form>');
  };
  const run = (fn) => async (el) => { if (busy) return; busy = true; try { await fn(el); } catch (e) { toast(e.message || 'Hata'); } busy = false; };
  ACT.del = run(async (el) => {
    if (!confirm('Silinsin mi?')) return;
    const key = el.dataset.key, c = CRUD[key], id = el.dataset.id;
    await mutate((db) => { const a = need(db, modMin(db, c.m)); db[key] = db[key].filter((x) => String(x.id) !== id); addLog(db, a, key + ' silindi.'); });
    toast('Silindi.', true); route();
  });
  ACT.delmsg = run(async (el) => { await mutate((db) => { need(db, modMin(db, 5)); db.chat = db.chat.filter((m) => m.id !== el.dataset.id); }); route(); });
  ACT.clearchat = run(async () => { if (!confirm('Tüm sohbet silinsin mi?')) return; await mutate((db) => { const a = need(db, modMin(db, 6)); db.chat = []; addLog(db, a, 'Sohbet temizlendi.'); }); toast('Temizlendi.', true); route(); });
  ACT.ban = run(async (el) => {
    await mutate((db) => {
      const a = need(db, modMin(db, 8)); const t = db.users.find((u) => u.id === el.dataset.uid);
      if (!t || t.id === a.id || !canTouch(db, a, t)) throw new Error('Bu kullanıcıyı engelleyemezsin.');
      t.banned = !t.banned; if (t.banned) { t.tokenHash = ''; db.security.bannedUsers.push(t.username); } else db.security.bannedUsers = db.security.bannedUsers.filter((n) => n !== t.username);
      addLog(db, a, t.username + (t.banned ? ' engellendi.' : ' engeli kaldırıldı.'));
    });
    route();
  });
  ACT.appok = run(async (el) => {
    await mutate((db) => {
      const a = need(db, modMin(db, 14)); const ap = db.applications.find((x) => x.id === el.dataset.id);
      if (!ap || ap.status !== 'pending') throw new Error('Başvuru bulunamadı.');
      const t = db.users.find((u) => u.id === ap.userId);
      ap.status = 'accepted'; ap.by = a.username;
      if (t && !t.rankId) { t.rankId = ap.type === 'admin' ? 9 : 18; }
      addLog(db, a, ap.username + ' başvurusu kabul edildi.');
    });
    toast('Kabul edildi, rütbe verildi.', true); route();
  });
  ACT.appno = run(async (el) => {
    await mutate((db) => { const a = need(db, modMin(db, 14)); const ap = db.applications.find((x) => x.id === el.dataset.id); if (!ap || ap.status !== 'pending') throw new Error('Başvuru bulunamadı.'); ap.status = 'rejected'; ap.by = a.username; addLog(db, a, ap.username + ' başvurusu reddedildi.'); });
    toast('Reddedildi.', true); route();
  });
  ACT.tclose = run(async (el) => { await mutate((db) => { need(db, modMin(db, 20)); const t = db.tickets.find((x) => x.id === el.dataset.id); if (t) t.status = 'closed'; }); route(); });
  ACT.tdel = run(async (el) => { await mutate((db) => { need(db, modMin(db, 20)); db.tickets = db.tickets.filter((x) => x.id !== el.dataset.id); }); route(); });
  ACT.maint = run(async () => { await mutate((db) => { const a = need(db, modMin(db, 23)); db.settings.maintenance = !db.settings.maintenance; addLog(db, a, 'Bakım modu: ' + db.settings.maintenance); }); renderNav(); route(); });
  ACT.unrank = run(async (el) => { await mutate((db) => { const a = need(db, 18); const t = db.users.find((u) => u.id === el.dataset.uid); if (!t) throw new Error('Kullanıcı yok.'); setRankDb(db, a, t, null); }); route(); });
  ACT.regtoggle = run(async () => { await mutate((db) => { const a = need(db, modMin(db, 22)); db.settings.registrationClosed = !db.settings.registrationClosed; addLog(db, a, 'Kayıt durumu değişti.'); }); route(); });
  ACT.clearfails = run(async () => { await mutate((db) => { need(db, modMin(db, 22)); db.security.failedLogins = []; }); route(); });
  ACT.rdone = run(async (el) => { await mutate((db) => { need(db, modMin(db, 22)); const r = db.security.reports.find((x) => x.id === el.dataset.id); if (r) r.status = 'done'; }); route(); });
  ACT.rdel = run(async (el) => { await mutate((db) => { need(db, modMin(db, 22)); db.security.reports = db.security.reports.filter((x) => x.id !== el.dataset.id); }); route(); });

  document.addEventListener('click', (e) => {
    if (e.target.id === 'modal') return closeModal();
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACT[el.dataset.act];
    if (fn) { try { const r = fn(el, e); if (r && r.catch) r.catch((x) => toast(x.message)); } catch (x) { toast(x.message); } }
    if (el.dataset.act !== 'nav') $('#nav').classList.remove('open');
  });
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const h = FORM[f.dataset.form];
    if (!h || busy) return;
    busy = true;
    try { await h(f, Object.fromEntries(new FormData(f))); } catch (err) { toast(err.message || 'Bir hata oluştu.'); }
    busy = false;
  });

  /* ---------- Yönlendirme ---------- */
  async function route() {
    timers.forEach(clearInterval); timers = [];
    const r = (location.hash.replace('#/', '') || 'home').split('/')[0];
    const app = $('#app');
    try { await refresh(r === 'control' || r === 'security'); } catch (e) { app.innerHTML = '<div class="card"><h3>Bağlantı hatası</h3><p>' + esc(e.message) + '</p><p class="muted">config.js içindeki Bin ID ve Access Key\'i kontrol et.</p></div>'; return; }
    renderNav();
    const menu = DB.menus.find((m) => m.id === r);
    const open = ['login', 'register'].includes(r) || (menu && menu.public);
    let html, shown = false;
    if (!P[r]) html = '<p>Sayfa bulunamadı.</p>';
    else if (!open && !ME) html = '<div class="card"><h3>Giriş gerekli</h3><p>Bu bölümü görmek için giriş yapmalısın.</p><a class="btn" href="#/login">Giriş yap</a> <a class="btn alt" href="#/register">Kayıt ol</a></div>';
    else if (menu && ME && L(ME) < (menu.minLevel || 0)) html = '<div class="card">Bu bölüm için yetkin yok.</div>';
    else if (DB.settings.maintenance && L(ME) === 0 && !open) html = '<div class="card"><h3>Bakımdayız</h3><p>Site kısa süreliğine bakımda. Daha sonra tekrar dene.</p></div>';
    else { html = P[r](); shown = true; }
    app.innerHTML = html;
    if (shown && POST[r]) { try { POST[r](); } catch (e) { /* yoksay */ } }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();
})();
