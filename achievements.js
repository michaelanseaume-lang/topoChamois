'use strict';
// Succès : définitions + évaluation. Un succès débloqué est définitif (table user_achievements).
module.exports = function (db, { GRADES, DONE_SQL }) {
  const gi = g => GRADES.indexOf(g), DAY = 86400000;
  const D = [];
  const add = (cat, key, icon, title, desc, goal, val) => D.push({ cat, key, icon, title, desc, goal, val });
  const flag = f => c => (f(c) ? 1 : 0);

  // 1. Progression
  [[1, '👣', 'Premier pas', 'Grimper sa première voie'], [10, '🔟', 'Ça commence !', 'Grimper 10 voies'], [25, '🧗', 'Petit grimpeur', 'Grimper 25 voies'],
   [50, '🏠', 'Habitué', 'Grimper 50 voies'], [100, '💯', 'Accro à la grimpe', 'Grimper 100 voies'], [250, '⚙️', 'Machine à grimper', 'Grimper 250 voies'],
   [500, '🏅', 'Légende du club', 'Grimper 500 voies'], [1000, '🌋', 'Force de la nature', 'Grimper 1 000 voies'], [2000, '👑', 'Le mur est à moi', 'Grimper 2 000 voies']]
    .forEach(([n, i, t, d]) => add('Progression', 'climb-' + n, i, t, d, n, c => c.climbs));
  [['5a', '🌱', 'Premier 5A'], ['5b', '🌿', 'Le cap des 5B'], ['6a', '🔥', 'Dans la cour des grands'], ['6b', '🧠', 'Sixième sens'], ['6c', '🌶️', 'Ça commence à piquer'],
   ['7a', '7️⃣', 'Club des 7'], ['7b', '🏔️', 'Au sommet'], ['7c', '⚔️', 'Machine de guerre'], ['8a', '⚡', 'Dieu de la grimpe']]
    .forEach(([g, i, t]) => add('Progression', 'grade-' + g, i, t, g === '8a' ? 'Réaliser un 8A ou plus' : `Réussir une voie en ${g.toUpperCase()} (ou plus)`, 1, flag(c => c.best >= gi(g))));

  // 2. Ouverture
  [[1, '🌿', 'Ouvreur en herbe', 'Ouvrir sa première voie'], [5, '🪨', 'Première pierre', 'Ouvrir 5 voies'], [10, '🔧', 'Ouvreur confirmé', 'Ouvrir 10 voies'],
   [25, '📐', 'Architecte du mur', 'Ouvrir 25 voies'], [50, '🛠️', 'Maître ouvreur', 'Ouvrir 50 voies'], [100, '🏛️', 'Légende de l’ouverture', 'Ouvrir 100 voies']]
    .forEach(([n, i, t, d]) => add('Ouverture', 'open-' + n, i, t, d, n, c => c.opened));
  add('Ouverture', 'creator', '🥇', 'Le créateur', 'Être le premier à grimper sa propre voie', 1, flag(c => c.creator));
  add('Ouverture', 'tester', '🧪', 'Le testeur', 'Faire grimper 10 personnes sur une voie que vous avez ouverte', 10, c => c.maxOthers);
  add('Ouverture', 'chief', '🎖️', 'La voie du chef', 'Ouvrir une voie réussie par au moins 20 grimpeurs', 20, c => c.maxClimbers);
  add('Ouverture', 'sadist', '😈', 'Le sadique', 'Ouvrir une voie que personne ne réussit pendant 30 jours', 30, c => c.maxUnclimbedDays);
  add('Ouverture', 'democrat', '🗳️', 'Le démocrate', 'Ouvrir une voie réussie par au moins 50 % des membres (5 grimpeurs minimum)', 50, c => c.maxPct);

  // 3. Régularité
  add('Régularité', 'days-3', '📅', 'Jamais deux sans trois', 'Grimper 3 jours différents', 3, c => c.days);
  add('Régularité', 'weeks-5', '🗓️', 'Fidèle au poste', 'Grimper 5 semaines consécutives', 5, c => c.maxRun);
  add('Régularité', 'weeks-10', '🔁', 'Rendez-vous habituel', 'Grimper 10 semaines consécutives', 10, c => c.maxRun);
  add('Régularité', 'week-3d', '🔋', 'Increvable', 'Grimper 3 jours dans la même semaine', 3, c => c.maxPerWeek);
  add('Régularité', 'session-20', '🏃', 'Marathonien', 'Grimper 20 voies dans une séance', 20, c => c.maxInSession);
  add('Régularité', 'session-40', '🥵', 'Session XXL', 'Grimper 40 voies dans une séance', 40, c => c.maxInSession);
  add('Régularité', 'comeback', '↩️', 'Le retour', 'Revenir grimper après 30 jours d’absence', 1, flag(c => c.maxGap >= 30));
  add('Régularité', 'sessions-100', '🏟️', 'Accro du club', 'Participer à 100 séances', 100, c => c.sessions);

  // 4. Défis
  add('Défis', 'perfect-relay', '✅', 'Le sans-faute', 'Réussir toutes les voies d’un même relais (2 voies minimum)', 1, flag(c => c.perfectRelais > 0));
  add('Défis', 'colors-5', '🎨', 'Collectionneur', 'Réussir des voies de 5 couleurs différentes', 5, c => c.colors);
  add('Défis', 'rainbow', '🌈', 'Arc-en-ciel', 'Réussir une voie de chaque couleur', 10, c => c.colors);
  add('Défis', 'grades-5', '🎯', 'Le polyvalent', 'Réussir 5 voies dans 5 cotations différentes', 5, c => c.grades);
  add('Défis', 'first-try-10', '🏹', 'Le perfectionniste', 'Réussir 10 voies dès le premier essai (à vue ou flash)', 10, c => c.firstTry);
  add('Défis', 'persevere', '🐢', 'Le persévérant', 'Réussir une voie après au moins 10 essais (compteur d’essais)', 1, flag(c => c.persevere > 0));
  add('Défis', 'returnee', '🧟', 'Le revenant', 'Réussir une voie qui vous avait résisté lors d’une séance précédente', 1, flag(c => c.returnee > 0));
  add('Défis', 'new-hunter', '🐺', 'Le chasseur de nouveautés', 'Être parmi les 5 premiers à réussir une voie nouvelle (dans ses 14 premiers jours)', 1, flag(c => c.hunter));

  // 5. Championnat (indépendant des autres succès)
  add('Championnat', 'champ-1', '🥇', 'Champion du mois', 'Remporter un championnat mensuel', 1, c => c.golds);
  add('Championnat', 'champ-2', '🥇', 'Double champion', 'Remporter 2 championnats mensuels', 2, c => c.golds);
  add('Championnat', 'champ-3', '🥇', 'Triple champion', 'Remporter 3 championnats mensuels', 3, c => c.golds);
  add('Championnat', 'champ-10', '🏆', 'Légende du championnat', 'Remporter 10 championnats mensuels', 10, c => c.golds);

  // 6. Bonus (humour)
  add('Bonus', 'early', '🌅', 'Lève-tôt', 'Grimper avant 9 h', 1, flag(c => c.early));
  add('Bonus', 'night', '🦉', 'Noctambule', 'Grimper après 21 h', 1, flag(c => c.night));
  add('Bonus', 'xmas', '🎅', 'Noël au sommet', 'Grimper le 24 ou le 25 décembre', 1, flag(c => c.xmas));
  add('Bonus', 'newyear', '🎆', 'Bonne année grimpée', 'Grimper le 1er janvier', 1, flag(c => c.newyear));
  add('Bonus', 'weekend', '🍻', 'Week-end sportif', 'Grimper le samedi et le dimanche du même week-end', 1, flag(c => c.weekend));
  add('Bonus', 'chatty', '💬', 'Le bavard', 'Écrire 10 commentaires', 10, c => c.comments);
  add('Bonus', 'director', '🎬', 'Le réalisateur', 'Ajouter 3 vidéos', 3, c => c.videos);
  add('Bonus', 'photographer', '📸', 'Le photographe', 'Ajouter une photo de relais', 1, c => c.photos);
  add('Bonus', 'union', '✊', 'Le syndicaliste', 'Contester 5 cotations', 5, c => c.contests);
  add('Bonus', 'yes', '👍', 'Béni-oui-oui', 'Valider 20 cotations', 20, c => c.validations);
  add('Bonus', 'flash10', '⚡', 'Flash Gordon', 'Réussir 10 flashs', 10, c => c.flashes);
  add('Bonus', 'pink', '🌸', 'La vie en rose', 'Réussir une voie rose', 1, flag(c => c.pink));
  add('Bonus', 'dark', '🖤', 'Le côté obscur', 'Réussir une voie noire', 1, flag(c => c.dark));
  add('Bonus', 'projects', '🧩', 'Projet de vie', 'Avoir 10 voies en « travail en cours »', 10, c => c.projects);

  const one = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.values(r)[0] || 0 : 0; };
  const dt = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const weekOf = d => { const t = dt(d), wd = (new Date(t).getUTCDay() + 6) % 7; return Math.floor((t - wd * DAY) / (7 * DAY)); }; // semaines du lundi au dimanche

  function ctx(uid) {
    const cl = db.prepare(`SELECT voie_id, grade, color, status, strftime('%Y-%m-%d', created_at, 'localtime') d,
      CAST(strftime('%H', created_at, 'localtime') AS INTEGER) h, strftime('%m-%d', created_at, 'localtime') md
      FROM climbs WHERE user_id = ? ORDER BY created_at`).all(uid);
    const days = [...new Set(cl.map(r => r.d))].sort(), weeks = [...new Set(days.map(weekOf))].sort((a, b) => a - b);
    let run = 1, maxRun = weeks.length ? 1 : 0;
    for (let i = 1; i < weeks.length; i++) { run = weeks[i] === weeks[i - 1] + 1 ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
    const perWeek = {}; days.forEach(d => { const w = weekOf(d); perWeek[w] = (perWeek[w] || 0) + 1; });
    let maxGap = 0; for (let i = 1; i < days.length; i++) maxGap = Math.max(maxGap, (dt(days[i]) - dt(days[i - 1])) / DAY);
    const daySet = new Set(days);
    const total = one('SELECT COUNT(*) FROM users');
    const mine = db.prepare(`SELECT v.id, v.created_at,
      (SELECT COUNT(DISTINCT user_id) FROM climbs WHERE voie_id = v.id) climbers,
      (SELECT COUNT(DISTINCT user_id) FROM climbs WHERE voie_id = v.id AND user_id != o.user_id) others,
      (SELECT user_id FROM climbs WHERE voie_id = v.id ORDER BY created_at, id LIMIT 1) first_user
      FROM openings o JOIN voies v ON v.id = o.voie_id WHERE o.user_id = ?`).all(uid);
    const max = (arr, f) => arr.reduce((m, x) => Math.max(m, f(x)), 0);
    return {
      climbs: cl.length, best: max(cl, r => gi(r.grade) + 1) - 1,
      days: days.length, maxRun, maxPerWeek: max(Object.values(perWeek), x => x), maxGap,
      sessions: one('SELECT COUNT(*) FROM sessions WHERE user_id = ? AND ended_at IS NOT NULL', uid),
      maxInSession: one(`SELECT MAX(n) FROM (SELECT COUNT(*) n FROM ascents WHERE user_id = ? AND status IN (${DONE_SQL}) GROUP BY session_id)`, uid),
      opened: one('SELECT COUNT(*) FROM openings WHERE user_id = ?', uid),
      creator: mine.some(v => v.first_user === uid), maxOthers: max(mine, v => v.others), maxClimbers: max(mine, v => v.climbers),
      maxUnclimbedDays: max(mine.filter(v => v.climbers === 0), v => Math.floor((Date.now() - Date.parse(v.created_at)) / DAY)),
      maxPct: max(mine.filter(v => v.climbers >= 5 && total), v => Math.round(v.climbers / total * 100)),
      perfectRelais: one(`SELECT COUNT(*) FROM relais r WHERE (SELECT COUNT(*) FROM voies v WHERE v.relais_id = r.id) >= 2
        AND NOT EXISTS (SELECT 1 FROM voies v WHERE v.relais_id = r.id AND NOT EXISTS
          (SELECT 1 FROM statuses s WHERE s.user_id = ? AND s.voie_id = v.id AND s.status IN (${DONE_SQL})))`, uid),
      colors: new Set(cl.map(r => r.color)).size, grades: new Set(cl.map(r => r.grade)).size,
      firstTry: cl.filter(r => r.status === 'avue' || r.status === 'flash').length, flashes: cl.filter(r => r.status === 'flash').length,
      persevere: one(`SELECT COUNT(*) FROM statuses s JOIN voie_tries t ON t.user_id = s.user_id AND t.voie_id = s.voie_id
        WHERE s.user_id = ? AND s.status IN (${DONE_SQL}) AND t.n >= 10`, uid),
      returnee: one(`SELECT COUNT(*) FROM statuses WHERE user_id = ? AND status IN (${DONE_SQL}) AND worked_at IS NOT NULL AND substr(worked_at, 1, 10) < substr(updated_at, 1, 10)`, uid),
      hunter: !!one(`SELECT 1 FROM climbs c JOIN voies v ON v.id = c.voie_id WHERE c.user_id = ?
        AND julianday(c.created_at) - julianday(v.created_at) <= 14
        AND (SELECT COUNT(DISTINCT c2.user_id) FROM climbs c2 WHERE c2.voie_id = c.voie_id AND c2.user_id != c.user_id AND c2.created_at < c.created_at) < 5 LIMIT 1`, uid),
      early: cl.some(r => r.h < 9), night: cl.some(r => r.h >= 21), xmas: cl.some(r => r.md === '12-24' || r.md === '12-25'), newyear: cl.some(r => r.md === '01-01'),
      weekend: days.some(d => new Date(dt(d)).getUTCDay() === 6 && daySet.has(new Date(dt(d) + DAY).toISOString().slice(0, 10))),
      comments: one('SELECT COUNT(*) FROM comments WHERE user_id = ?', uid), videos: one('SELECT COUNT(*) FROM videos WHERE user_id = ?', uid),
      photos: one('SELECT COUNT(*) FROM relais WHERE photo_by = ?', uid), contests: one('SELECT COUNT(*) FROM contests WHERE user_id = ?', uid),
      validations: one('SELECT COUNT(*) FROM validations WHERE user_id = ?', uid),
      pink: cl.some(r => r.color === 'rose'), dark: cl.some(r => r.color === 'noir'),
      golds: one("SELECT COUNT(*) FROM results WHERE user_id = ? AND medal = 'gold'", uid),
      projects: one("SELECT COUNT(*) FROM statuses WHERE user_id = ? AND status = 'travail'", uid)
    };
  }

  function evaluate(uid) { // débloque ce qui doit l'être ; renvoie le contexte calculé
    const c = ctx(uid), have = new Set(db.prepare('SELECT key FROM user_achievements WHERE user_id = ?').all(uid).map(r => r.key));
    const ins = db.prepare('INSERT OR IGNORE INTO user_achievements(user_id, key, unlocked_at) VALUES(?,?,?)'), t = new Date().toISOString();
    D.filter(d => !have.has(d.key) && d.val(c) >= d.goal).forEach(d => ins.run(uid, d.key, t));
    return c;
  }
  function list(uid) {
    const c = evaluate(uid), at = Object.fromEntries(db.prepare('SELECT key, unlocked_at FROM user_achievements WHERE user_id = ?').all(uid).map(r => [r.key, r.unlocked_at]));
    return D.map(d => ({ key: d.key, cat: d.cat, icon: d.icon, title: d.title, desc: d.desc, goal: d.goal,
      cur: Math.min(Math.floor(d.val(c)), d.goal), done: !!at[d.key], at: at[d.key] || null }));
  }
  function unseen(uid) {
    const keys = db.prepare('SELECT key FROM user_achievements WHERE user_id = ? AND seen = 0 ORDER BY unlocked_at').all(uid).map(r => r.key);
    return keys.map(k => D.find(d => d.key === k)).filter(Boolean).map(d => ({ key: d.key, icon: d.icon, title: d.title, desc: d.desc }));
  }
  const markSeen = uid => db.prepare('UPDATE user_achievements SET seen = 1 WHERE user_id = ?').run(uid);
  return { evaluate, list, unseen, markSeen, total: D.length };
};
