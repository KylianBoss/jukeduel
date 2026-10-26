const test = require('node:test');
const assert = require('node:assert');
const game = require('../game');

const song = id => ({ id, uri: 'spotify:track:' + id, name: id, artists: 'X', image: '' });

test('duel, votes et doublons', () => {
  const s = { songs: {}, duel: null };
  game.propose(s, song('a'), 'p1');
  assert.deepStrictEqual(s.duel.ids, ['a']);
  assert.strictEqual(game.winner(s.duel), 'a'); // seul candidat : il passe
  game.propose(s, song('b'), 'p1');
  game.propose(s, song('c'), 'p2');
  assert.deepStrictEqual(s.duel.ids, ['a', 'b']); // b complète le duel, c attend
  assert.strictEqual(game.propose(s, song('a'), 'p2'), 'Déjà proposé');
  assert.ok(game.vote(s, 'v1', 'c')); // c n'est pas en duel

  game.vote(s, 'v1', 'b');
  game.vote(s, 'v2', 'b');
  game.vote(s, 'v3', 'a');
  assert.strictEqual(game.winner(s.duel), 'b');
  game.vote(s, 'v2', 'a'); // changement d'avis : 2 contre 1
  assert.strictEqual(game.winner(s.duel), 'a');

  game.played(s, 'a');
  assert.strictEqual(game.propose(s, song('a'), 'p2'), 'Déjà proposé'); // jamais rejoué
  assert.deepStrictEqual([...s.duel.ids].sort(), ['b', 'c']); // le perdant revient
  assert.deepStrictEqual(s.duel.votes, {});

  game.resetPlayed(s);
  assert.strictEqual(game.propose(s, song('a'), 'p2'), undefined); // de nouveau proposable
  assert.deepStrictEqual([...s.duel.ids].sort(), ['b', 'c']); // le duel en cours ne bouge pas
});

test('égalité ou aucun vote : un des deux au hasard', () => {
  for (const votes of [{}, { v1: 'a', v2: 'b' }, { v1: 'a', v2: 'b', v3: game.REROLL }]) {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(game.winner({ ids: ['a', 'b'], votes }));
    assert.deepStrictEqual([...seen].sort(), ['a', 'b']);
  }
});

test('10 sons en attente par personne, retrait de ses propres sons', () => {
  const s = { songs: {}, duel: null };
  for (let i = 0; i < 10; i++) assert.strictEqual(game.propose(s, song('s' + i), 'p1'), undefined);
  assert.match(game.propose(s, song('x'), 'p1'), /10 sons/);
  assert.strictEqual(game.propose(s, song('x'), 'p2'), undefined); // les autres ne sont pas limités

  const [a, b] = s.duel.ids;
  game.vote(s, 'v1', a);
  assert.ok(game.withdraw(s, 'p2', a)); // pas son son
  assert.ok(game.withdraw(s, 'p1', 'inconnu'));
  game.withdraw(s, 'p1', a);
  assert.strictEqual(s.songs[a], undefined);
  assert.ok(s.duel.ids.includes(b) && !s.duel.ids.includes(a) && s.duel.ids.length === 2); // un autre son prend la place
  assert.deepStrictEqual(s.duel.votes, {}); // le vote pour le son retiré est annulé

  game.played(s, b); // le retrait et le son passé libèrent deux places
  assert.strictEqual(game.propose(s, song('y'), 'p1'), undefined);
  assert.strictEqual(game.propose(s, song('z'), 'p1'), undefined);
  assert.match(game.propose(s, song('w'), 'p1'), /10 sons/);
  assert.ok(game.withdraw(s, 'p1', b)); // déjà passé
});

test('relance : la majorité veut deux autres sons, une fois par duel', () => {
  const s = { songs: {}, duel: null };
  for (const id of ['a', 'b', 'c', 'd']) game.propose(s, song(id), 'p');
  const old = [...s.duel.ids];
  game.vote(s, 'v1', old[0]);
  game.vote(s, 'v2', old[0]);
  game.vote(s, 'v3', game.REROLL);
  game.vote(s, 'v4', game.REROLL);
  assert.deepStrictEqual(s.duel.ids, old); // 2 contre 2 : pas la majorité
  game.vote(s, 'v5', game.REROLL);
  assert.deepStrictEqual([...s.duel.ids].sort(), ['a', 'b', 'c', 'd'].filter(x => !old.includes(x))); // deux nouveaux sons
  assert.deepStrictEqual(s.duel.votes, {});
  assert.ok(game.vote(s, 'v1', game.REROLL)); // déjà relancé
  assert.strictEqual(game.canReroll(s), false);

  game.played(s, s.duel.ids[0]);
  assert.strictEqual(game.canReroll(s), true); // nouveau duel, nouvelle relance possible

  const solo = { songs: {}, duel: null };
  game.propose(solo, song('a'), 'p');
  game.propose(solo, song('b'), 'p');
  assert.ok(game.vote(solo, 'v1', game.REROLL)); // rien d'autre à tirer
});

test('pseudos et classement par votes reçus', () => {
  const s = { songs: {}, duel: null };
  assert.match(game.rename(s, 'p1', '  ‮ '), /Choisis/); // vide une fois nettoyé
  assert.strictEqual(game.rename(s, 'p1', '  Kevin​   du\n69 '), undefined);
  assert.strictEqual(s.names.p1, 'Kevin du 69');
  assert.match(game.rename(s, 'p2', 'kevin DU 69'), /pris/);
  assert.strictEqual(game.rename(s, 'p1', 'Kevin du 69'), undefined); // le sien
  game.rename(s, 'p2', 'Léa' + 'a'.repeat(30));
  assert.strictEqual(s.names.p2.length, 20);

  game.propose(s, song('a'), 'p1');
  game.propose(s, song('b'), 'p2');
  game.propose(s, song('c'), 'p3'); // sans pseudo : pas au classement
  for (const v of ['v1', 'v2', 'v3']) game.vote(s, v, 'a');
  game.vote(s, 'v4', 'b');
  game.played(s, 'a');
  assert.deepStrictEqual(game.ranking(s), [{ name: 'Kevin du 69', score: 3 }, { name: s.names.p2, score: 1 }]); // le perdant marque aussi

  game.vote(s, 'v1', 'c');
  game.vote(s, 'v2', 'b');
  game.vote(s, 'v3', 'b');
  game.played(s, 'b');
  assert.deepStrictEqual(game.ranking(s).map(r => r.score), [3, 3]);
  assert.deepStrictEqual(s.scores.p3, 1);

  game.ban(s, 'p1');
  assert.deepStrictEqual(game.ranking(s).map(r => r.name), [s.names.p2]);
  assert.match(game.rename(s, 'p1', 'Autre'), /bloqué/);
});

test("bannissement d'un son ou d'une personne", () => {
  const s = { songs: {}, duel: null };
  for (const id of ['a', 'b']) game.propose(s, song(id), 'troll');
  game.propose(s, song('c'), 'p');
  game.vote(s, 'troll', 'a');
  game.vote(s, 'p', 'b');

  game.ban(s, 'c'); // un son : retiré et refusé à l'avenir
  assert.strictEqual(s.songs.c, undefined);
  assert.match(game.propose(s, song('c'), 'p'), /refusé/);

  game.ban(s, 'troll'); // une personne : ses sons et son vote disparaissent
  assert.deepStrictEqual(Object.keys(s.songs), []);
  assert.strictEqual(s.duel, null);
  assert.match(game.propose(s, song('d'), 'troll'), /bloqué/);
  game.propose(s, song('d'), 'p');
  assert.match(game.vote(s, 'troll', 'd'), /bloqué/);
  assert.strictEqual(game.vote(s, 'p', 'd'), undefined);
});
