'use strict';
// Championnat mensuel : points dynamiques, journal des attributions, clôture mensuelle, médailles, hall of fame.
module.exports = function (db, { GRADES }) {
  const TZ = process.env.APP_TZ || 'Europe/Paris';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = d => Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  const periodOf = d => { const p = parts(d); return `${p.year}-${p.month}`; };
  const now = () => new Date().toISOString();
  const gi = g => GRADES.indexOf(g);
  const FLOOR = 5; // plancher : une voie vaut toujours au moins 5 points

  // ---- Valeur d'une voie : points de base (cotation) × coefficient de popularité ----
  function base(grade) {
    const n = Number(grade[0]), l = grade[1];
    if (n <= 4) return 10;
    if (n === 5) return 20;
    if (n === 6) return l === 'c' ? 50 : 35;   // 6a-6b+ : 35 ; 6c-6c+ : 50
    if (n === 7) return l === 'a' ? 50 : 70;   // 7a-7a+ : 50 ; 7b-7c+ : 70
    return 100;                                // 8a et plus
  }
  const coef = n => n <= 2 ? 2 : n <= 5 ? 1.5 : n <= 10 ? 1.2 : n <= 20 ? 1 : n <= 50 ? 0.75 : n <= 100 ? 0.5 : 0.25;
  // `others` = nombre de membres différents (hors soi) ayant déjà réussi la voie : les répétitions ne comptent pas
  function valueInfo(grade, others) { const b = base(grade), c = coef(others); return { base: b, coef: c, climbers: others, pts: Math.max(FLOOR, Math.round(b * c)) }; }

  // ---- Journal des points (chaque attribution est figée : la valeur de la voie peut baisser après coup) ----
  function add(uid, period, kind, ref, pts, label, voieId, sessionId) {
    return db.prepare(`INSERT OR IGNORE INTO points(user_id, period, kind, ref, points, label, voie_id, session_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(uid, period, kind, String(ref), pts, label, voieId || null, sessionId || null, now()).changes > 0;
  }
  const has = (sql, ...a) => !!db.prepare(sql).get(...a);

  // Appelé à la validation d'une réussite (passage vers un statut « réussi »). Les répétitions n'appellent jamais cette fonction.
  function scoreClimb(uid, v, status, sessionId) {
    const period = periodOf(new Date()), ref = String(v.id);
    if (has("SELECT 1 FROM points WHERE user_id = ? AND period = ? AND kind = 'voie' AND ref = ?", uid, period, ref)) return; // une fois par voie et par mois
    const rel = db.prepare('SELECT num FROM relais WHERE id = ?').get(v.relais_id), tag = `${v.grade} · relais ${rel ? rel.num : '?'}`;
    const prior = db.prepare('SELECT COUNT(DISTINCT user_id) n FROM climbs WHERE voie_id = ? AND user_id != ?').get(v.id, uid).n;
    const { pts } = valueInfo(v.grade, prior);
    add(uid, period, 'voie', ref, pts, `Voie ${tag}`, v.id, sessionId);
    if (status === 'avue' || status === 'flash') add(uid, period, 'flash', ref, Math.max(1, Math.round(pts * 0.2)), `Premier essai +20 % · ${tag}`, v.id, sessionId);

    const op = db.prepare('SELECT user_id FROM openings WHERE voie_id = ?').get(v.id), opener = op ? op.user_id : null;
    if (uid !== opener) { // l'ouvreur ne gagne pas de bonus sur sa propre voie
      const others = db.prepare('SELECT COUNT(DISTINCT user_id) n FROM climbs WHERE voie_id = ? AND user_id != ? AND user_id != ?').get(v.id, uid, opener || 0).n;
      if (others === 0 && !has("SELECT 1 FROM points WHERE kind = 'first' AND ref = ?", ref)) add(uid, period, 'first', ref, 30, `Première ascension · ${tag}`, v.id, sessionId);
      // ouvrir une voie rapporte 30 pts quand un autre membre la réussit pour la première fois (évite de gagner des points en créant des voies à vide)
      if (opener && !has("SELECT 1 FROM points WHERE kind = 'opened' AND ref = ?", ref)) add(opener, period, 'opened', ref, 30, `Voie ouverte, 1re réussite · ${tag}`, v.id, null);
    }
    const prev = db.prepare('SELECT grade FROM climbs WHERE user_id = ? AND (voie_id IS NULL OR voie_id != ?)').all(uid, v.id).reduce((m, r) => Math.max(m, gi(r.grade)), -1);
    if (prev >= 0 && gi(v.grade) > prev) add(uid, period, 'best', v.grade, 50, `Au-dessus de votre meilleure cotation · ${v.grade}`, v.id, sessionId);
    if (sessionId) {
      const n = db.prepare("SELECT COUNT(*) n FROM points WHERE user_id = ? AND session_id = ? AND kind = 'voie'").get(uid, sessionId).n;
      if (n === 5) add(uid, period, 's5', sessionId, 30, '5 nouvelles voies dans la séance', null, sessionId);
      if (n === 10) add(uid, period, 's10', sessionId, 75, '10 nouvelles voies dans la séance', null, sessionId);
    }
  }
  const scoredSet = uid => new Set(db.prepare("SELECT ref FROM points WHERE user_id = ? AND period = ? AND kind = 'voie'").all(uid, periodOf(new Date())).map(r => Number(r.ref)));

  // ---- Classements ----
  const standings = period => db.prepare(`SELECT p.user_id id, u.pseudo, SUM(p.points) points, MAX(p.created_at) last FROM points p JOIN users u ON u.id = p.user_id
    WHERE p.period = ? GROUP BY p.user_id HAVING points > 0 ORDER BY points DESC, last ASC`).all(period).map((r, i) => ({ rank: i + 1, id: r.id, pseudo: r.pseudo, points: r.points }));
  const medalsOf = uid => { const m = { gold: 0, silver: 0, bronze: 0 }; db.prepare('SELECT medal, COUNT(*) n FROM results WHERE user_id = ? AND medal IS NOT NULL GROUP BY medal').all(uid).forEach(r => m[r.medal] = r.n); return m; };

  // Clôture des mois écoulés : classement figé, médailles au podium. Le compteur « du mois » repart de zéro de lui-même (nouvelle période).
  function closeMonths() {
    const cur = periodOf(new Date());
    db.prepare('SELECT DISTINCT period FROM points WHERE period < ? AND period NOT IN (SELECT period FROM championships) ORDER BY period').all(cur).forEach(({ period }) => {
      db.transaction(() => {
        db.prepare('INSERT INTO championships(period, closed_at) VALUES(?,?)').run(period, now());
        const medal = ['gold', 'silver', 'bronze'];
        standings(period).forEach(r => db.prepare('INSERT INTO results(period, user_id, rank, points, medal) VALUES(?,?,?,?,?)').run(period, r.id, r.rank, r.points, medal[r.rank - 1] || null));
      })();
    });
  }

  function mine(uid) {
    const cur = periodOf(new Date()), st = standings(cur), me = st.find(r => r.id === uid);
    return { points: me ? me.points : 0, rank: me ? me.rank : null, medals: medalsOf(uid) };
  }
  function championship(uid) {
    closeMonths();
    const cur = periodOf(new Date()), p = parts(new Date()), y = +p.year, m = +p.month;
    const top = (kind, limit = 3) => db.prepare(`SELECT u.pseudo, COUNT(*) n FROM points p JOIN users u ON u.id = p.user_id WHERE p.period = ? AND p.kind = ? GROUP BY p.user_id ORDER BY n DESC LIMIT ?`).all(cur, kind, limit);
    const past = db.prepare('SELECT period FROM championships ORDER BY period DESC LIMIT 12').all().map(({ period }) => ({
      period, podium: db.prepare('SELECT r.rank, u.pseudo, r.points, r.medal FROM results r JOIN users u ON u.id = r.user_id WHERE r.period = ? AND r.rank <= 3 ORDER BY r.rank').all(period) }));
    return {
      period: cur, daysLeft: new Date(Date.UTC(y, m, 0)).getUTCDate() - +p.day, ranking: standings(cur).slice(0, 30), me: {
        ...mine(uid), entries: db.prepare('SELECT label, points, kind, created_at FROM points WHERE user_id = ? AND period = ? ORDER BY id DESC LIMIT 15').all(uid, cur) },
      explorers: top('voie'), firsts: top('first'), past };
  }
  function hall() {
    const rec = (icon, title, sql, ...a) => ({ icon, title, top: db.prepare(sql).all(...a) });
    return [
      rec('🥇', 'Le plus de médailles d’or (championnats gagnés)', "SELECT u.pseudo, COUNT(*) value FROM results r JOIN users u ON u.id = r.user_id WHERE r.medal = 'gold' GROUP BY r.user_id ORDER BY value DESC LIMIT 3"),
      rec('🏅', 'Le plus de podiums (médailles au total)', 'SELECT u.pseudo, COUNT(*) value FROM results r JOIN users u ON u.id = r.user_id WHERE r.medal IS NOT NULL GROUP BY r.user_id ORDER BY value DESC LIMIT 3'),
      rec('🧗', 'Le plus de voies grimpées', 'SELECT u.pseudo, COUNT(*) value FROM climbs c JOIN users u ON u.id = c.user_id GROUP BY c.user_id ORDER BY value DESC LIMIT 3'),
      rec('🔧', 'Le plus de voies ouvertes', 'SELECT u.pseudo, COUNT(*) value FROM openings o JOIN users u ON u.id = o.user_id GROUP BY o.user_id ORDER BY value DESC LIMIT 3'),
      rec('🚀', 'Record de points sur un mois', 'SELECT u.pseudo, SUM(p.points) value, p.period extra FROM points p JOIN users u ON u.id = p.user_id GROUP BY p.user_id, p.period ORDER BY value DESC LIMIT 3'),
      rec('🥾', 'Le plus de premières ascensions', "SELECT u.pseudo, COUNT(*) value FROM points p JOIN users u ON u.id = p.user_id WHERE p.kind = 'first' GROUP BY p.user_id ORDER BY value DESC LIMIT 3")
    ];
  }
  const unseen = uid => db.prepare('SELECT period, rank, points, medal FROM results WHERE user_id = ? AND seen = 0 ORDER BY period').all(uid);
  const markSeen = uid => db.prepare('UPDATE results SET seen = 1 WHERE user_id = ?').run(uid);
  return { valueInfo, scoreClimb, scoredSet, closeMonths, mine, championship, hall, unseen, markSeen, periodOf };
};
