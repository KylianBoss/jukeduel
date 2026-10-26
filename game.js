// Règles du vote, sans I/O pour pouvoir les tester.
// state = { songs: { [id]: { id, uri, name, artists, image, played, by } }, duel: { ids: [id, id?], votes: { [personne]: id | REROLL }, rerolled? } | null,
//           banned: [id de son ou de personne], names: { [personne]: pseudo }, scores: { [personne]: votes reçus } }
const MAX = 10; // sons en attente par personne
const REROLL = 'reroll'; // vote pour tirer deux autres sons

const pending = state => Object.values(state.songs).filter(s => !s.played);
const votes = (duel, id) => Object.values(duel.votes).filter(v => v === id).length;
const banned = (state, x) => !!state.banned?.includes(x);

// Complète le duel avec des sons en attente tirés au hasard, en évitant si possible ceux de `avoid`.
function fillDuel(state, avoid = []) {
  const duel = state.duel ?? { ids: [], votes: {} };
  const free = pending(state).filter(s => !duel.ids.includes(s.id));
  for (const pool of [free.filter(s => !avoid.includes(s.id)), free.filter(s => avoid.includes(s.id))])
    while (duel.ids.length < 2 && pool.length) duel.ids.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
  state.duel = duel.ids.length ? duel : null;
}

// Renvoie un message d'erreur, ou rien si c'est bon.
function propose(state, song, who) {
  if (banned(state, who)) return "L'hôte t'a bloqué";
  if (banned(state, song.id)) return "Son refusé par l'hôte";
  if (state.songs[song.id]) return 'Déjà proposé';
  if (pending(state).filter(s => s.by === who).length >= MAX) return `Tu as déjà ${MAX} sons en attente`;
  state.songs[song.id] = { ...song, played: false, by: who };
  fillDuel(state);
}

// Une seule relance par duel, et seulement s'il reste d'autres sons en attente.
const canReroll = state => !!state.duel && !state.duel.rerolled && pending(state).length > state.duel.ids.length;

function vote(state, who, id) {
  const d = state.duel;
  if (banned(state, who)) return "L'hôte t'a bloqué";
  if (!d?.ids.includes(id) && !(id === REROLL && canReroll(state))) return "Ce son n'est plus en duel";
  d.votes[who] = id;
  // la majorité des votes (au moins 2) veut d'autres sons : nouveau tirage
  const n = votes(d, REROLL);
  if (n >= 2 && n > votes(d, d.ids[0]) + votes(d, d.ids[1])) {
    state.duel = { ids: [], votes: {}, rerolled: true };
    fillDuel(state, d.ids);
  }
}

// Le plus voté gagne ; égalité ou aucun vote → un des deux au hasard.
function winner(duel) {
  if (!duel) return null;
  const [a, b] = duel.ids;
  if (!b) return a;
  const na = votes(duel, a), nb = votes(duel, b);
  return na === nb ? duel.ids[Math.random() < 0.5 ? 0 : 1] : na > nb ? a : b;
}

// Le gagnant ne pourra plus jamais être proposé, le perdant retourne dans la liste.
// Les votes reçus par les deux sons comptent pour le classement de leurs auteurs.
function played(state, id) {
  const d = state.duel;
  for (const x of d?.ids ?? []) {
    const by = state.songs[x].by, n = votes(d, x);
    if (by && n) (state.scores ??= {})[by] = (state.scores[by] ?? 0) + n;
  }
  state.songs[id].played = true;
  state.duel = null;
  fillDuel(state);
}

// Retire un son en attente ; les votes pour lui sont annulés.
function drop(state, id) {
  delete state.songs[id];
  const d = state.duel;
  if (!d?.ids.includes(id)) return;
  d.ids = d.ids.filter(x => x !== id);
  for (const v in d.votes) if (d.votes[v] === id) delete d.votes[v];
  fillDuel(state);
}

// Une personne retire un de ses sons.
function withdraw(state, who, id) {
  const s = state.songs[id];
  if (!s || s.played || s.by !== who) return "Ce son n'est pas à toi";
  drop(state, id);
}

// Admin : bannit un son, ou une personne avec ses sons en attente et son vote.
function ban(state, x) {
  (state.banned ??= []).push(x);
  if (state.duel) delete state.duel.votes[x];
  for (const s of pending(state)) if (s.id === x || s.by === x) drop(state, s.id);
}

// Oublie les sons déjà passés : ils pourront de nouveau être proposés.
function resetPlayed(state) {
  for (const id in state.songs) if (state.songs[id].played) delete state.songs[id];
}

// Pseudo affiché au classement : 20 caractères, unique, sans caractères invisibles.
function rename(state, who, name) {
  name = [...String(name ?? '').replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim()].slice(0, 20).join('');
  if (banned(state, who)) return "L'hôte t'a bloqué";
  if (!name) return 'Choisis un pseudo';
  if (Object.entries(state.names ?? {}).some(([w, n]) => w !== who && n.toLowerCase() === name.toLowerCase())) return 'Ce pseudo est déjà pris';
  (state.names ??= {})[who] = name;
}

// Classement par votes reçus, sans les personnes bloquées.
const ranking = state => Object.entries(state.scores ?? {})
  .filter(([who]) => state.names?.[who] && !banned(state, who))
  .map(([who, score]) => ({ name: state.names[who], score }))
  .sort((a, b) => b.score - a.score);

module.exports = { REROLL, propose, vote, canReroll, votes, winner, played, withdraw, ban, resetPlayed, rename, ranking };
