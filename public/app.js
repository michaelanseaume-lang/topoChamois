'use strict';
const COL = { rouge: '#D6382F', orange: '#EE7B1E', jaune: '#F2C318', vert: '#3E9B4F', bleu: '#2F6FD0', violet: '#7B4BB5', rose: '#E86AA6', noir: '#1E1E1E', blanc: '#F4F4F2', gris: '#8A9199' };
const CN = Object.keys(COL);
const GR = ['4', '5', '6', '7', '8'].flatMap(n => ['a', 'a+', 'b', 'b+', 'c', 'c+'].map(l => n + l));
const ST = [['avue', 'À vue'], ['flash', 'Flash'], ['apres', 'Après travail'], ['travail', 'Travail en cours'], ['non', 'Non réalisé']];
const DONE = ['avue', 'flash', 'apres'];
const ROLES = [['user', 'Grimpeur'], ['opener', 'Ouvreur'], ['admin', 'Admin']];
const S = { user: null, tab: 'topo', open: null, draft: null, admin: false, auth: 'in', err: '', topo: null, profile: null, club: null, members: null, comments: [], videos: [], zoom: null, ach: null, newAch: null, clubTab: 'champ', fl: [], champ: null, hall: null, newChamp: null };

const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ci = g => GR.indexOf(g);
const lbl = s => (ST.find(x => x[0] === s) || [])[1];
const fg = c => ['jaune', 'blanc', 'orange'].includes(c) ? '#1A1A1A' : '#fff';
const val = id => (document.getElementById(id) || {}).value;
const canEdit = () => S.admin && S.user && ['opener', 'admin'].includes(S.user.role);
const isOpener = () => S.user && ['opener', 'admin'].includes(S.user.role);
const adminPref = () => { try { return localStorage.getItem('ouvreur') === '1'; } catch { return false; } };
const allV = () => S.topo ? S.topo.relais.flatMap(r => r.voies.map(v => ({ ...v, rel: r.num, relId: r.id }))) : [];
const findV = id => allV().find(v => v.id == id);
const dateFr = iso => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

function toast(m) { const t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.style.display = m ? 'block' : 'none'; }
function sendFile(url, field, file) { // envoi avec progression (les vidéos peuvent être lourdes)
  return new Promise((res, rej) => {
    const fd = new FormData(); fd.append(field, file);
    const x = new XMLHttpRequest(); x.open('POST', url); x.withCredentials = true;
    x.upload.onprogress = ev => { if (ev.lengthComputable) toast(`Envoi… ${Math.round(ev.loaded / ev.total * 100)} %`); };
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch { }
      if (x.status < 300) res(d); else rej(new Error(x.status === 413 ? 'Fichier trop volumineux pour le serveur' : d.error || 'Échec de l’envoi'));
    };
    x.onerror = () => rej(new Error('Échec de l’envoi (connexion interrompue ou fichier trop volumineux)'));
    toast('Envoi… 0 %'); x.send(fd);
  });
}

async function api(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch { }
  if (r.status === 401 && S.user) { S.user = null; render(); }
  if (!r.ok) throw new Error(d.error || 'Erreur');
  return d;
}

async function load() {
  S.topo = await api('GET', '/api/topo');
  if (S.topo.ach.length) S.newAch = S.topo.ach;
  if (S.topo.champ.length) S.newChamp = S.topo.champ;
  if (S.tab === 'succes') S.ach = await api('GET', '/api/achievements');
  if (S.tab === 'profil' || S.tab === 'session') S.profile = await api('GET', '/api/profile');
  if (S.tab === 'club') {
    S.club = await api('GET', '/api/club');
    [S.champ, S.hall] = await Promise.all([api('GET', '/api/championship'), api('GET', '/api/hall')]);
    S.members = S.user.role === 'admin' ? (await api('GET', '/api/users')).users : null;
  }
  if (S.open && !findV(S.open)) { S.open = null; S.draft = null; }
  if (S.open) {
    const [c, vi] = await Promise.all([api('GET', `/api/voies/${S.open}/comments`), api('GET', `/api/voies/${S.open}/videos`)]);
    S.comments = c.comments; S.videos = vi.videos;
  }
  render();
}

/* ---------- Vues ---------- */
function wheel(sel) {
  const n = CN.length;
  return `<div class="wheel">${CN.map((c, i) => {
    const a = i / n * 6.283 - 1.57;
    return `<button class="sw ${sel === c ? 'on' : ''}" title="${c}" aria-label="${c}" data-act="setc" data-v="${c}" style="background:${COL[c]};left:${85 + 68 * Math.cos(a)}px;top:${85 + 68 * Math.sin(a)}px"></button>`;
  }).join('')}<div class="mut" style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;pointer-events:none">${sel || 'couleur'}</div></div>`;
}

function voieRow(v) {
  const m = S.topo.my[v.id];
  return `<button class="v" data-act="open" data-v="${v.id}"><span class="dot" style="background:${COL[v.color]}"></span><b>${v.grade}</b><span class="n">${e(v.name || v.color[0].toUpperCase() + v.color.slice(1))}${v.setter ? ' · ' + e(v.setter) : ''}${v.videos ? ' · 🎥 ' + v.videos : ''}</span><span class="pts" title="Points de la voie">${v.scored ? '✓' : '⭐ ' + v.pts}</span>${m && m !== 'non' ? `<span class="st ${m}">${lbl(m)}</span>` : `<span class="mut">${v.pct}%</span>`}</button>`;
}

function photoBlock(r) {
  const can = canEdit() || r.photo_mine;
  return `${r.photo ? `<img class="rph" src="${r.photo}" alt="Photo du relais ${r.num}" loading="lazy" data-act="zoom" data-v="${r.photo}">` : ''}<div class="rup"><label class="chip">${r.photo ? '📷 Changer la photo' : '📷 Ajouter une photo du relais'}<input type="file" accept="image/*" class="vh" data-up="photo" data-id="${r.id}"></label>${r.photo && can ? `<button class="chip" data-act="delphoto" data-v="${r.id}">Supprimer la photo</button>` : ''}</div>`;
}

function topo() {
  const lv = S.fl;
  const rs = S.topo.relais.map(r => ({ ...r, voies: lv.length ? r.voies.filter(v => lv.includes(v.grade[0])) : r.voies })).filter(r => !lv.length || r.voies.length);
  return `<div class="bar" role="group" aria-label="Filtrer par niveau"><button class="chip ${lv.length ? '' : 'on'}" data-act="fl" data-v="">Tous</button>${['4', '5', '6', '7', '8'].map(n => `<button class="chip ${lv.includes(n) ? 'on' : ''}" data-act="fl" data-v="${n}" aria-pressed="${lv.includes(n)}">${n}</button>`).join('')}${canEdit() ? `<button class="btn" style="margin-left:auto" data-act="addrel">+ Relais</button>` : ''}</div>
  <div class="grid">${rs.map(r => `<section class="rel"><header><h3>Relais ${r.num}</h3>${canEdit() ? `<button class="btn del" style="padding:4px 10px;font-size:12px" data-act="delrel" data-v="${r.id}">Supprimer</button>` : ''}</header>${photoBlock(r)}${r.voies.map(voieRow).join('') || '<p class="mut" style="padding:0 14px">Aucune voie.</p>'}${canEdit() ? `<button class="add" data-act="addvoie" data-v="${r.id}">+ Ajouter une voie</button>` : ''}</section>`).join('')}</div>${rs.length ? '' : `<p class="mut">${S.topo.relais.length ? 'Aucune voie dans ces niveaux.' : 'Le mur est vide.' + (isOpener() ? ' Activez le mode ouvreur pour ajouter un relais.' : '')}</p>`}`;
}

function sheet() {
  const d = S.draft;
  const v = d ? { ...d } : findV(S.open);
  if (!v) return '';
  const m = S.topo.my[v.id];
  const rel = v.rel;
  const body = d
    ? `<div class="sb"><h3>${d.id ? 'Modifier la voie' : 'Nouvelle voie'}</h3>${wheel(d.color)}<select id="egrade">${GR.map(c => `<option ${c === d.grade ? 'selected' : ''}>${c}</option>`).join('')}</select><div class="row" style="margin-top:8px"><input type="text" id="ename" placeholder="Nom de la voie (facultatif)" maxlength="40" value="${e(d.name)}"><input type="text" id="esetter" placeholder="Ouvreur" maxlength="30" value="${e(d.setter)}"></div><div class="row" style="margin-top:10px"><button class="btn" data-act="saveedit">Enregistrer</button><button class="btn sec" data-act="canceledit">Annuler</button>${d.id ? `<button class="btn del" data-act="delvoie" style="margin-left:auto">Supprimer</button>` : ''}</div></div>`
    : `<div class="sb"><div class="row" style="align-items:center"><span class="mut" style="flex:1">Ouverte par <b style="color:var(--ink)">${e(v.setter || '—')}</b></span>${canEdit() ? `<button class="btn sec" data-act="edit">Modifier</button>` : ''}</div></div>
  <div class="sb"><h3>Mon statut</h3><div class="sts">${ST.map(s => `<button class="chip ${m === s[0] ? 'on' : ''}" data-act="stat" data-v="${s[0]}">${s[1]}</button>`).join('')}</div>${m === 'travail' || m === 'apres' ? `<div class="row" style="align-items:center;margin-top:8px"><span class="mut" style="flex:1">Essais : <b style="color:var(--ink)">${S.topo.tries[v.id] || 0}</b></span><button class="chip" data-act="tries" data-v="-1" aria-label="Un essai de moins">−</button><button class="chip" data-act="tries" data-v="1">+1 essai</button></div>` : ''}${S.topo.session ? `<p class="mut" style="margin:8px 0 0">Session en cours : l’ascension est ajoutée automatiquement.${m && m !== 'non' ? ` <button class="chip" data-act="repeat">+ Refaite pendant la session</button>` : ''}</p>` : ''}</div>
  <div class="sb"><h3>Réussite du club</h3><div class="meter"><i style="width:${v.pct}%"></i></div><span class="mut">${v.pct} % des grimpeurs ont réalisé cette voie</span></div>
  <div class="sb"><h3>Points du championnat</h3>${v.scored ? '<p class="mut" style="margin:0">Voie déjà marquée ce mois-ci ✓ (les répétitions ne rapportent pas de points).</p>' : `<p style="margin:0"><b>${v.pts} pts</b> <span class="mut">· base ${v.base} × ${String(v.coef).replace('.', ',')} (${v.climbers} réussite${v.climbers > 1 ? 's' : ''}) · +20 % si réussie du premier coup</span></p>`}</div>
  <div class="sb"><h3>Cotation</h3><button class="chip ${v.vme ? 'on' : ''}" data-act="valid">✓ Cotation validée · ${v.validations}</button></div>
  <div class="sb"><h3>Cotation contestée ?</h3>${v.contests.map(c => `<div class="row" style="align-items:center;margin-bottom:6px"><span style="flex:1"><b>${c.grade}</b> <span class="mut">· ${c.n} pers.</span></span><button class="chip ${c.me ? 'on' : ''}" data-act="vote" data-v="${c.grade}">D’accord</button></div>`).join('')}<div class="row" style="margin-top:8px"><select id="pcot">${GR.filter(c => c !== v.grade).map(c => `<option>${c}</option>`).join('')}</select><button class="btn sec" style="white-space:nowrap" data-act="contest">Proposer</button></div></div>
  <div class="sb"><h3>Vidéos</h3>${S.videos.map(x => `<div style="margin-bottom:12px"><video controls playsinline preload="metadata" src="${x.url}" style="width:100%;max-height:60vh;border-radius:10px;background:#000"></video><div class="row" style="align-items:center"><span class="mut" style="flex:1">${e(x.pseudo)} · ${new Date(x.created_at).toLocaleDateString('fr-FR')}</span>${x.mine || isOpener() ? `<button class="chip" data-act="delvideo" data-v="${x.id}">Supprimer</button>` : ''}</div></div>`).join('') || '<p class="mut">Aucune vidéo pour cette voie.</p>'}<label class="chip">🎥 Ajouter une vidéo de ma réalisation<input type="file" accept="video/*" class="vh" data-up="video" data-id="${v.id}"></label></div>
  <div class="sb"><h3>Commentaires</h3>${S.comments.map(c => `<p class="cm"><b>${e(c.pseudo)}</b> <small>${new Date(c.created_at).toLocaleDateString('fr-FR')}</small>${c.mine || S.user.role === 'admin' ? ` <button class="chip" style="padding:1px 8px;font-size:12px" data-act="delcomment" data-v="${c.id}">Supprimer</button>` : ''}<br>${e(c.text)}</p>`).join('') || '<p class="mut">Aucun commentaire. Donnez votre bêta.</p>'}<div class="row"><input type="text" id="cm" placeholder="Votre commentaire" maxlength="500"><button class="btn" data-act="comment">Publier</button></div></div>`;
  return `<div class="ov" data-act="close"><div class="sheet" role="dialog" aria-label="Voie">
  <div class="sh" style="background:${COL[v.color]};color:${fg(v.color)}"><div style="flex:1"><div style="opacity:.8">Relais ${rel}</div><h2>${v.grade}</h2><div>${e(v.name || 'Voie sans nom')}</div></div><button class="pill" style="color:inherit;border-color:currentColor" data-act="close">Fermer</button></div>${body}</div></div>`;
}

function sessionChips(list) {
  return list.map(a => `<span class="chip" style="display:inline-flex;gap:6px;align-items:center"><span class="dot" style="width:12px;height:12px;background:${COL[a.color]}"></span>${a.grade}${a.status === 'travail' ? '…' : ''}</span>`).join('');
}
function sessionView() {
  const p = S.profile, a = p.session;
  return `<div class="box"><h2 style="font-size:22px;margin-bottom:8px">${a ? 'Session en cours' : 'Nouvelle session'}</h2>${a ? `<div class="sts" style="margin-bottom:12px">${sessionChips(a.asc) || '<span class="mut">Ouvrez une voie et choisissez un statut pour l’ajouter.</span>'}</div><button class="btn" data-act="endsess">Terminer la session</button>` : `<p class="mut" style="margin-top:0">Démarrez une session, puis notez vos voies depuis le topo.</p><button class="btn" data-act="startsess">Démarrer</button>`}</div>
  <h3 style="margin:18px 0 10px">Sessions passées</h3>${p.sessions.map(s => `<div class="box"><div class="row" style="align-items:center"><b style="flex:1">${dateFr(s.started)}</b><button class="chip" data-act="delsess" data-v="${s.id}">Supprimer</button></div><div class="mut" style="margin:2px 0 8px">${s.asc.filter(x => DONE.includes(x.status)).length} ascension(s)</div><div class="sts">${sessionChips(s.asc)}</div></div>`).join('') || '<p class="mut">Aucune session terminée pour le moment.</p>'}`;
}

function profilView() {
  const { stats: s } = S.profile;
  const tot = Object.values(s.counts).reduce((a, b) => a + b, 0) || 1;
  const ch = S.profile.champ;
  return `<div class="stat"><div><b>${ch.points}</b>points ce mois-ci</div><div><b>🥇${ch.medals.gold} 🥈${ch.medals.silver} 🥉${ch.medals.bronze}</b>palmarès</div></div>
  <div class="stat"><div><b>${s.asc}</b>ascensions en session</div><div><b>${s.done}</b>voies réussies</div><div><b>${s.best || '—'}</b>plus haute cotation</div></div>
  <div class="box"><h3 style="margin-bottom:10px">Mes statuts</h3>${ST.map(x => `<div class="mut" style="display:flex;justify-content:space-between"><span>${x[1]}</span><b style="color:var(--ink)">${s.counts[x[0]]}</b></div><div class="meter"><i style="width:${s.counts[x[0]] / tot * 100}%"></i></div>`).join('')}</div>
  <div class="box"><h3 style="margin-bottom:10px">Voies les plus répétées</h3>${s.top.map(t => `<div class="v" style="border:0;padding:6px 0;cursor:default"><span class="dot" style="background:${COL[t.color]}"></span><b>${t.grade}</b><span class="n">Relais ${t.rel}</span><b>${t.n}×</b></div>`).join('') || '<p class="mut" style="margin:0">Pas encore d’ascension enregistrée en session.</p>'}</div>
  <div class="box"><h3 style="margin-bottom:8px">Mon rôle</h3>${S.user.role === 'admin' ? '<p class="mut" style="margin:0">Vous êtes administrateur (les rôles se gèrent dans l’onglet Club).</p>' : `<div class="sts"><button class="chip ${S.user.role === 'user' ? 'on' : ''}" data-act="myrole" data-v="user">Grimpeur</button><button class="chip ${S.user.role === 'opener' ? 'on' : ''}" data-act="myrole" data-v="opener">Ouvreur</button></div><p class="mut" style="margin-bottom:0">Les ouvreurs peuvent modifier le topo (relais et voies).</p>`}</div>
  <div class="box"><h3 style="margin-bottom:8px">Supprimer mon compte</h3><p class="mut" style="margin-top:0">Supprime définitivement votre compte, vos statuts, sessions et commentaires.</p><input type="password" id="delpw" placeholder="Mot de passe pour confirmer" autocomplete="current-password"><button class="btn del" style="margin-top:8px" data-act="delaccount">Supprimer mon compte</button></div>`;
}

function statsView() {
  const c = S.club, us = c.users;
  const byCot = [...us].sort((a, b) => ci(b.best) - ci(a.best) || b.asc - a.asc);
  const byAsc = [...us].sort((a, b) => b.asc - a.asc);
  const byAch = [...us].sort((a, b) => b.ach - a.ach);
  const li = (arr, f) => arr.slice(0, 8).map((u, i) => `<div class="v" style="border:0;padding:7px 0;cursor:default${u.id === S.user.id ? ';font-weight:700' : ''}"><b style="min-width:26px;color:var(--mut)">${i + 1}</b><span class="n" style="color:var(--ink)">${e(u.pseudo)}</span><b>${f(u)}</b></div>`).join('');
  return `<div class="stat"><div><b>${us.length}</b>grimpeurs inscrits</div><div><b>${c.voies}</b>voies ouvertes</div><div><b>${c.avg}%</b>réussite moyenne</div></div>
  <div class="grid"><div class="box"><h3 style="margin-bottom:8px">Plus hautes cotations</h3>${li(byCot, u => u.best || '—')}</div><div class="box"><h3 style="margin-bottom:8px">Plus assidus</h3>${li(byAsc, u => u.asc + ' asc.')}</div><div class="box"><h3 style="margin-bottom:8px">Chasseurs de succès</h3>${li(byAch, u => u.ach + ' 🏆')}</div><div class="box"><h3 style="margin-bottom:8px">Voies les plus dures</h3>${c.hard.map(v => `<div class="v" style="border:0;padding:7px 0;cursor:default"><span class="dot" style="background:${COL[v.color]}"></span><b>${v.grade}</b><span class="n">Relais ${v.rel}</span><span class="mut">${v.pct}%</span></div>`).join('') || '<p class="mut" style="margin:0">Aucune voie.</p>'}</div></div>
  ${S.members ? `<div class="box"><h3 style="margin-bottom:8px">Membres (administration)</h3>${S.members.map(m => `<div class="row" style="align-items:center;margin-bottom:6px"><span style="flex:1">${e(m.pseudo)}</span><select data-role="${m.id}" style="width:auto">${ROLES.map(r => `<option value="${r[0]}" ${m.role === r[0] ? 'selected' : ''}>${r[1]}</option>`).join('')}</select></div>`).join('')}</div>` : ''}`;
}

function achPopup() {
  const l = S.newAch;
  return `<div class="ov" style="z-index:13;align-items:center"><div class="sheet pop" role="dialog" aria-label="Succès débloqués"><h2>🏆 ${l.length > 1 ? 'Succès débloqués !' : 'Succès débloqué !'}</h2>${l.slice(0, 6).map(x => `<div class="ach done" style="margin-top:10px"><span class="ai">${x.icon}</span><div><b>${e(x.title)}</b><div class="mut">${e(x.desc)}</div></div></div>`).join('')}${l.length > 6 ? `<p class="mut">…et ${l.length - 6} autre(s), à retrouver dans l’onglet Succès.</p>` : ''}<button class="btn" style="width:100%;margin-top:16px" data-act="ackach">Super !</button></div></div>`;
}

function achView() {
  const a = S.ach, cats = [...new Set(a.list.map(x => x.cat))];
  return `<div class="stat"><div><b>${a.unlocked}/${a.total}</b>succès débloqués</div></div>` + cats.map(cat => {
    const items = a.list.filter(x => x.cat === cat);
    return `<h3 style="margin:18px 0 10px">${cat} <span class="mut">${items.filter(x => x.done).length}/${items.length}</span></h3><div class="grid">${items.map(x => `<div class="ach ${x.done ? 'done' : ''}"><span class="ai">${x.icon}</span><div style="flex:1;min-width:0"><b>${e(x.title)}</b><div class="mut">${e(x.desc)}</div>${x.done ? `<div class="mut">Débloqué le ${new Date(x.at).toLocaleDateString('fr-FR')}</div>` : x.goal > 1 ? `<div class="meter"><i style="width:${x.cur / x.goal * 100}%"></i></div><div class="mut">${x.cur} / ${x.goal}</div>` : ''}</div></div>`).join('')}</div>`;
  }).join('');
}

const MEDAL = ['🥇', '🥈', '🥉'];
const periodLabel = p => new Date(p + '-01T12:00:00Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const medalIcon = m => ({ gold: '🥇', silver: '🥈', bronze: '🥉' }[m] || '');

function champPopup() {
  return `<div class="ov" style="z-index:14;align-items:center"><div class="sheet pop" role="dialog" aria-label="Championnat clôturé"><h2>🏁 Championnat clôturé</h2>${S.newChamp.map(r => `<p style="margin:12px 0 0"><b>${periodLabel(r.period)}</b><br>${r.medal ? medalIcon(r.medal) + ' ' : ''}${r.rank === 1 ? '1er' : r.rank + 'e'} avec <b>${r.points} pts</b>${r.medal ? ' — la médaille rejoint votre palmarès !' : ''}</p>`).join('')}<p class="mut">Le compteur de points repart à zéro : un nouveau championnat commence.</p><button class="btn" style="width:100%;margin-top:12px" data-act="ackchamp">C’est reparti !</button></div></div>`;
}

function clubView() {
  const t = S.clubTab;
  return `<div class="bar">${[['champ', '🏅 Championnat'], ['hall', '🏛️ Hall of fame'], ['stats', '📊 Stats du club']].map(x => `<button class="chip ${t === x[0] ? 'on' : ''}" data-act="clubtab" data-v="${x[0]}">${x[1]}</button>`).join('')}</div>` + (t === 'champ' ? champView() : t === 'hall' ? hallView() : statsView());
}

function champView() {
  const c = S.champ, me = c.me;
  const rows = c.ranking.map(r => `<div class="v" style="border:0;padding:7px 0;cursor:default${r.id === S.user.id ? ';font-weight:700' : ''}"><b style="min-width:34px">${MEDAL[r.rank - 1] || r.rank}</b><span class="n" style="color:var(--ink)">${e(r.pseudo)}</span><b>${r.points} pts</b></div>`).join('');
  const small = (arr, f) => arr.map(x => `<div class="row" style="padding:4px 0"><span style="flex:1">${e(x.pseudo)}</span><b>${f(x)}</b></div>`).join('') || '<p class="mut" style="margin:0">Rien pour l’instant.</p>';
  return `<div class="stat"><div><b>${me.points}</b>mes points · ${periodLabel(c.period)}</div><div><b>${me.rank ? '#' + me.rank : '—'}</b>mon rang</div><div><b>${c.daysLeft}</b>jour(s) avant la clôture</div></div>
  <div class="grid"><div class="box"><h3 style="margin-bottom:8px">Classement du mois</h3>${rows || '<p class="mut" style="margin:0">Personne n’a encore marqué de points ce mois-ci. À vous de jouer !</p>'}</div>
  <div class="box"><h3 style="margin-bottom:8px">Mes derniers points</h3>${me.entries.map(x => `<div class="row" style="padding:4px 0"><span style="flex:1" class="mut">${e(x.label)}</span><b>+${x.points}</b></div>`).join('') || '<p class="mut" style="margin:0">Réussissez une voie pour marquer vos premiers points.</p>'}</div>
  <div class="box"><h3 style="margin-bottom:8px">Explorateurs du mois</h3>${small(c.explorers, x => x.n + ' voies')}<h3 style="margin:14px 0 8px">Premières ascensions</h3>${small(c.firsts, x => x.n)}</div></div>
  <details class="box"><summary>Comment sont calculés les points ?</summary><p class="mut">Chaque voie vaut des <b>points de base</b> selon sa cotation (4 : 10 · 5 : 20 · 6a-6b+ : 35 · 6c-7a+ : 50 · 7b-7c+ : 70 · 8a et + : 100), multipliés par un <b>coefficient de popularité</b> : plus la voie a été réussie par de membres différents, moins elle rapporte (de ×2 pour une voie peu réussie à ×0,25 au-delà de 100 réussites). Une voie vaut toujours au moins 5 points. Les répétitions ne comptent pas, et une voie ne rapporte qu’une fois par mois.</p><p class="mut"><b>Bonus :</b> +20 % si réussie du premier coup (à vue ou flash) · +30 pts première ascension de la voie · +30 pts à l’ouvreur quand quelqu’un réussit sa voie pour la première fois · +50 pts pour une cotation supérieure à votre meilleure · +30 pts pour 5 nouvelles voies dans une séance, +75 pts pour 10.</p><p class="mut">Les points sont figés au moment de la réussite. À la fin du mois, le podium reçoit une médaille et les compteurs repartent à zéro.</p></details>
  ${c.past.length ? `<h3 style="margin:18px 0 10px">Championnats passés</h3><div class="grid">${c.past.map(p => `<div class="box"><b>${periodLabel(p.period)}</b>${p.podium.map(r => `<div class="row" style="padding:4px 0"><span style="flex:1">${medalIcon(r.medal)} ${e(r.pseudo)}</span><b>${r.points} pts</b></div>`).join('')}</div>`).join('')}</div>` : ''}`;
}

function hallView() {
  return `<p class="mut" style="margin-top:0">Les records du club depuis la création du site.</p><div class="grid">${S.hall.records.map(r => `<div class="box"><h3 style="margin-bottom:8px">${r.icon} ${e(r.title)}</h3>${r.top.map((t, i) => `<div class="row" style="padding:4px 0"><b style="min-width:26px">${MEDAL[i]}</b><span style="flex:1">${e(t.pseudo)}</span><b>${t.value}</b>${t.extra ? `<span class="mut">${periodLabel(t.extra)}</span>` : ''}</div>`).join('') || '<p class="mut" style="margin:0">Pas encore de record.</p>'}</div>`).join('')}</div>`;
}

function loginView() {
  return `<button class="chip" style="position:fixed;top:12px;right:12px" data-act="theme">${themeLabel()}</button><div class="login"><h1>Topo du mur</h1><p class="mut">Toutes les voies du club, vos ascensions, vos sessions.</p><div class="box"><div class="bar"><button class="chip ${S.auth === 'in' ? 'on' : ''}" data-act="auth" data-v="in">Se connecter</button><button class="chip ${S.auth === 'up' ? 'on' : ''}" data-act="auth" data-v="up">Créer un compte</button></div><input type="text" id="pseudo" placeholder="Pseudo" autocomplete="username" maxlength="20"><input type="password" id="pw" placeholder="Mot de passe" autocomplete="${S.auth === 'in' ? 'current-password' : 'new-password'}">${S.err ? `<p class="err">${e(S.err)}</p>` : ''}<button class="btn" style="width:100%;margin-top:8px" data-act="login">${S.auth === 'in' ? 'Se connecter' : 'Créer mon compte'}</button></div></div>`;
}

const themeNow = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
const themeLabel = () => themeNow() === 'dark' ? '☀️ Mode jour' : '🌙 Mode nuit';

function render() {
  const a = document.getElementById('app');
  const keep = { id: document.activeElement && document.activeElement.id };
  if (!S.user) { a.innerHTML = loginView(); return; }
  const views = { topo, session: sessionView, profil: profilView, club: clubView, succes: achView };
  const ready = S.topo && (S.tab === 'topo' || (S.tab === 'club' ? S.club && S.champ : S.tab === 'succes' ? S.ach : S.profile));
  a.innerHTML = `<header><h1>Topo du mur</h1><button class="pill" data-act="theme" aria-label="Changer de thème">${themeLabel()}</button>${isOpener() ? `<button class="pill ${S.admin ? 'on' : ''}" data-act="admin" aria-pressed="${S.admin}">Mode ouvreur</button>` : ''}<button class="pill" data-act="logout">${e(S.user.pseudo)} · Quitter</button></header>
  <nav>${[['topo', 'Topo'], ['session', 'Sessions'], ['profil', 'Profil'], ['club', 'Club'], ['succes', 'Succès']].map(t => `<button class="${S.tab === t[0] ? 'on' : ''}" data-act="tab" data-v="${t[0]}">${t[1]}</button>`).join('')}</nav>
  <main>${ready ? views[S.tab]() : '<p class="mut">Chargement…</p>'}</main>${S.open !== null && ready ? sheet() : ''}${S.newAch ? achPopup() : ''}${S.newChamp ? champPopup() : ''}${S.zoom ? `<div class="ov" data-act="unzoom" style="z-index:12"><img src="${S.zoom}" alt="" style="max-width:96%;max-height:92%;border-radius:10px"></div>` : ''}`;
  if (keep.id) { const el = document.getElementById(keep.id); if (el) el.focus(); }
}

/* ---------- Actions ---------- */
function syncDraft() {
  if (!S.draft || !document.getElementById('egrade')) return;
  Object.assign(S.draft, { grade: val('egrade'), name: val('ename'), setter: val('esetter') });
}

document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act, v = t.dataset.v, id = S.open;
  if (a === 'close' && t.classList.contains('ov') && ev.target !== t) return; // un clic dans la fiche ne la ferme pas
  try {
    if (a === 'theme') {
      const n = themeNow() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = n;
      try { localStorage.setItem('theme', n); } catch { }
      return render();
    }
    if (a === 'myrole') { S.user = (await api('PUT', '/api/me/role', { role: v })).user; if (v === 'user') S.admin = false; return await load(); }
    if (a === 'delaccount') {
      if (!confirm('Supprimer définitivement votre compte ? Cette action est irréversible.')) return;
      await api('DELETE', '/api/me', { password: val('delpw') });
      Object.assign(S, { user: null, topo: null, profile: null, club: null, ach: null, newAch: null, champ: null, hall: null, newChamp: null, open: null, draft: null, admin: false, auth: 'in', err: '' }); return render();
    }
    if (a === 'delcomment') { if (!confirm('Supprimer ce commentaire ?')) return; await api('DELETE', `/api/comments/${v}`); return await load(); }
    if (a === 'delsess') { if (!confirm('Supprimer cette session ? Ses ascensions ne compteront plus dans vos statistiques (les statuts de vos voies restent).')) return; await api('DELETE', `/api/sessions/${v}`); return await load(); }
    if (a === 'ackach') { S.newAch = null; render(); await api('POST', '/api/achievements/seen'); return; }
    if (a === 'tries') { await api('PUT', `/api/voies/${id}/tries`, { tries: Math.max(0, (S.topo.tries[id] || 0) + Number(v)) }); return await load(); }
    if (a === 'fl') { S.fl = v ? (S.fl.includes(v) ? S.fl.filter(x => x !== v) : [...S.fl, v]) : []; return render(); }
    if (a === 'clubtab') { S.clubTab = v; return render(); }
    if (a === 'ackchamp') { S.newChamp = null; render(); await api('POST', '/api/championship/seen'); return; }
    if (a === 'zoom') { S.zoom = v; return render(); }
    if (a === 'unzoom') { S.zoom = null; return render(); }
    if (a === 'delphoto') { if (!confirm('Supprimer la photo de ce relais ?')) return; await api('DELETE', `/api/relais/${v}/photo`); return await load(); }
    if (a === 'delvideo') { if (!confirm('Supprimer cette vidéo ?')) return; await api('DELETE', `/api/videos/${v}`); return await load(); }
    if (a === 'auth') { S.auth = v; S.err = ''; return render(); }
    if (a === 'login') {
      try {
        const d = await api('POST', S.auth === 'in' ? '/api/login' : '/api/register', { pseudo: val('pseudo'), password: val('pw') });
        S.user = d.user; S.err = ''; S.tab = 'topo'; S.admin = isOpener() && adminPref(); return await load();
      } catch (er) { S.err = er.message; return render(); }
    }
    if (a === 'logout') { await api('POST', '/api/logout'); Object.assign(S, { user: null, topo: null, profile: null, club: null, ach: null, newAch: null, champ: null, hall: null, newChamp: null, open: null, draft: null, admin: false }); return render(); }
    if (a === 'tab') { S.tab = v; S.open = null; S.draft = null; return await load(); }
    if (a === 'admin') { S.admin = !S.admin; S.draft = null; try { localStorage.setItem('ouvreur', S.admin ? '1' : '0'); } catch { } return render(); }
    if (a === 'open') { S.open = +v; S.draft = null; S.comments = []; S.videos = []; return await load(); }
    if (a === 'close') { S.open = null; S.draft = null; return render(); }
    if (a === 'edit') { const c = findV(id); S.draft = { id: c.id, rel: c.rel, color: c.color, grade: c.grade, name: c.name, setter: c.setter }; return render(); }
    if (a === 'canceledit') { if (!S.draft.id) S.open = null; S.draft = null; return render(); }
    if (a === 'setc') { syncDraft(); S.draft.color = v; return render(); }
    if (a === 'saveedit') {
      syncDraft(); const d = S.draft;
      const body = { color: d.color, grade: d.grade, name: d.name, setter: d.setter };
      if (d.id) await api('PUT', `/api/voies/${d.id}`, body); else { await api('POST', `/api/relais/${d.relId}/voies`, body); S.open = null; }
      S.draft = null; return await load();
    }
    if (a === 'delvoie') { if (!confirm('Supprimer cette voie ? Ses vidéos et la photo de son relais seront aussi supprimées.')) return; await api('DELETE', `/api/voies/${S.draft.id}`); S.open = null; S.draft = null; return await load(); }
    if (a === 'stat') { await api('PUT', `/api/voies/${id}/status`, { status: S.topo.my[id] === v ? null : v }); return await load(); }
    if (a === 'repeat') { await api('POST', `/api/voies/${id}/repeat`); return await load(); }
    if (a === 'valid') { await api('POST', `/api/voies/${id}/validate`); return await load(); }
    if (a === 'vote') { await api('POST', `/api/voies/${id}/contest`, { grade: v }); return await load(); }
    if (a === 'contest') { await api('POST', `/api/voies/${id}/contest`, { grade: val('pcot') }); return await load(); }
    if (a === 'comment') { const x = val('cm').trim(); if (!x) return; await api('POST', `/api/voies/${id}/comments`, { text: x }); return await load(); }
    if (a === 'addrel') { const r = await api('POST', '/api/relais'); S.topo.relais.push({ id: r.id, num: r.num, voies: [] }); render(); return await load(); }
    if (a === 'delrel') { if (!confirm('Supprimer ce relais, toutes ses voies, leurs vidéos et sa photo ?')) return; await api('DELETE', `/api/relais/${v}`); return await load(); }
    if (a === 'addvoie') {
      const r = S.topo.relais.find(x => x.id == v);
      S.draft = { relId: r.id, rel: r.num, color: 'rouge', grade: '5a', name: '', setter: S.user.pseudo }; S.open = 0; S.comments = []; return render();
    }
    if (a === 'startsess') { await api('POST', '/api/sessions/start'); return await load(); }
    if (a === 'endsess') { await api('POST', '/api/sessions/end'); return await load(); }
  } catch (er) { alert(er.message); }
});

document.addEventListener('change', async ev => {
  const up = ev.target.closest('[data-up]');
  if (up) {
    const f = up.files[0]; up.value = '';
    if (!f) return;
    const photo = up.dataset.up === 'photo', max = photo ? S.topo.limits.photo : S.topo.limits.video;
    if (f.size > max * 1048576) return alert(`Fichier trop volumineux (max ${max} Mo)`);
    try { await sendFile(photo ? `/api/relais/${up.dataset.id}/photo` : `/api/voies/${up.dataset.id}/videos`, up.dataset.up, f); toast(''); await load(); }
    catch (er) { toast(''); alert(er.message); }
    return;
  }
  const r = ev.target.closest('[data-role]'); if (!r) return;
  try { await api('PUT', `/api/users/${r.dataset.role}/role`, { role: r.value }); } catch (er) { alert(er.message); }
  await load();
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  const id = ev.target.id;
  if (id === 'pw' || id === 'pseudo') document.querySelector('[data-act="login"]').click();
  if (id === 'cm') document.querySelector('[data-act="comment"]').click();
});

(async () => {
  try { S.user = (await api('GET', '/api/me')).user; if (S.user) { S.admin = isOpener() && adminPref(); await load(); } } catch { }
  render();
})();
