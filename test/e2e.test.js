// Cycle complet de server.js face à une fausse API Spotify : connexion, suivi de lecture, file d'attente, erreurs, admin, sécurité.
// Dure ~40 s : il faut laisser passer la fin d'un vrai morceau simulé.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const ENV = { SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'sec', SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8080/callback', ADMIN_PASSWORD: 'pw:with:colons' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jukeduel-'));

test('démarrage : variables manquantes, état illisible', async () => {
  const r = spawnSync(process.execPath, [SERVER], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /ADMIN_PASSWORD/);

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{oups');
  const p = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...ENV, DATA_DIR: dir, PORT: '0' } });
  let out = '';
  p.stdout.on('data', c => out += c);
  while (!out.includes('écoute')) await once(p.stdout, 'data');
  p.kill();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'state.json.corrupt'), 'utf8'), '{oups'); // mis de côté, pas écrasé
});

test('cycle complet avec un faux Spotify', { timeout: 120000 }, async t => {
  const DATA = tmp(), FILE = path.join(DATA, 'state.json');
  Object.assign(process.env, ENV, { DATA_DIR: DATA, PORT: '0' });
  const tr = (id, d) => ({ id, uri: 'spotify:track:' + id, name: 'Song ' + id, duration_ms: d, artists: [{ name: 'Art' }], album: { images: [{ url: 'big' }, { url: 'mid' }] } });
  const song = id => ({ id, uri: 'spotify:track:' + id, name: 'Song ' + id, artists: 'Art', image: 'mid', played: false });
  fs.writeFileSync(FILE, JSON.stringify({
    token: { access: 'OLD', refresh: 'R', expires: 0 },
    songs: { a: song('a'), b: song('b'), c: song('c') },
    duel: { ids: ['a', 'b'], votes: { v1: 'b', v2: 'b', v3: 'a' } },
  }));
  const saved = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

  const calls = [];
  const mock = { queued: null, searchStatus: 200, refreshFails: false };
  const t0 = Date.now();
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    calls.push(method + ' ' + url.replace(/^https:\/\/[^/]+/, ''));
    if (url === 'https://accounts.spotify.com/api/token') {
      assert.strictEqual(opts.headers.Authorization, 'Basic ' + Buffer.from('cid:sec').toString('base64'));
      const body = new URLSearchParams(String(opts.body));
      if (body.get('grant_type') === 'refresh_token') {
        assert.strictEqual(body.get('refresh_token'), 'R');
        if (mock.refreshFails) return json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      } else {
        assert.strictEqual(body.get('code'), 'CODE');
        assert.strictEqual(body.get('redirect_uri'), 'http://127.0.0.1:8080/callback');
      }
      return json(200, { access_token: 'NEW', expires_in: 3600 });
    }
    if (opts.headers?.Authorization !== 'Bearer NEW') return json(401, { error: { status: 401 } });
    if (url.includes('/me/player/queue')) {
      assert.strictEqual(method, 'POST');
      mock.queued = new URL(url).searchParams.get('uri');
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/me/player/next')) {
      assert.strictEqual(method, 'POST');
      mock.skipped = Date.now();
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/me/player')) {
      const el = Date.now() - t0;
      if (mock.skipped) return json(200, { is_playing: true, progress_ms: Date.now() - mock.skipped, item: tr(mock.queued.split(':')[2], 180000) });
      if (!mock.queued || el < 31500) return json(200, { is_playing: true, progress_ms: 169000 + el, item: tr('T0', 200000) });
      return json(200, { is_playing: true, progress_ms: el - 31500, item: tr(mock.queued.split(':')[2], 180000) });
    }
    if (url.includes('/search?')) {
      assert.strictEqual(new URL(url).searchParams.get('limit'), '10');
      if (mock.searchStatus === 429) { mock.searchStatus = 200; return json(429, { error: { reason: 'QUOTA_EXCEEDED' } }, { 'retry-after': '2' }); }
      if (mock.searchStatus === 401) { mock.searchStatus = 200; return json(401, { error: { status: 401 } }); }
      return json(200, { tracks: { items: [tr('d', 1000), null, { ...tr('e', 1000), is_playable: false }, tr('a', 1000)] } });
    }
    throw new Error('appel inattendu ' + url);
  };

  const { server, privateNet } = require(SERVER);
  t.after(() => { server.closeAllConnections(); server.close(); });
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const req = (method, path, headers = {}) => new Promise((ok, ko) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b, json: () => JSON.parse(b) }));
    });
    r.on('error', ko);
    r.end();
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const count = re => calls.filter(c => re.test(c)).length;
  const auth = { authorization: 'Basic ' + Buffer.from('x:pw:with:colons').toString('base64') };
  const me = { 'x-real-ip': '10.0.0.1' }, other = { 'x-real-ip': '10.0.0.2' };

  // X-Real-IP n'est cru que derrière un proxy du réseau local
  for (const ip of ['127.0.0.1', '::1', '::ffff:172.18.0.1', '10.1.2.3', '192.168.1.1', 'fd12:3456::1']) assert.ok(privateNet(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:8.8.8.8', '2001:db8::1', '', undefined]) assert.ok(!privateNet(ip), ip);

  // Une URL invalide ne fait pas tomber le serveur
  const raw = require('node:net').connect(port, '127.0.0.1');
  raw.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
  assert.match(String((await once(raw, 'data'))[0]), /^HTTP\/1\.1 500/);
  raw.destroy();

  await sleep(500);
  let r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Vote du prochain son/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.headers['set-cookie'], undefined);

  // Pseudo obligatoire, unique ; requêtes venues d'un autre site refusées
  assert.match((await req('POST', '/api/vote?id=a', { 'x-real-ip': '10.0.0.3' })).json().error, /pseudo/);
  assert.strictEqual((await req('GET', '/api/state', me)).json().name, null);
  assert.strictEqual((await req('POST', '/api/name?name=Moi', { ...me, origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await req('POST', '/api/name?name=Moi', { ...me, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.strictEqual((await req('POST', '/api/name?name=Moi', { ...me, origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.match((await req('POST', '/api/name?name=moi', other)).json().error, /pris/);
  assert.strictEqual((await req('POST', '/api/name?name=Autre', other)).status, 200);
  assert.strictEqual((await req('GET', '/api/state', me)).json().name, 'Moi');

  // Avant la fermeture : T0 en cours, duel a/b, b mène 2 à 1
  let s = (await req('GET', '/api/state', me)).json();
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.now.name, 'Song T0');
  assert.strictEqual(s.now.image, 'big');
  r = await req('GET', '/ecran');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Prochain son/);
  r = await req('GET', '/qrcode.js');
  assert.match(r.headers['content-type'], /javascript/);
  assert.match(r.body, /QR Code Generator/);
  assert.deepStrictEqual(s.duel.songs.map(x => [x.id, x.votes]), [['a', 1], ['b', 2]]);
  assert.ok(s.closesIn >= 0 && s.closesIn < 1500, 'closesIn ' + s.closesIn);
  assert.strictEqual(count(/api\/token/), 1, 'un seul refresh au démarrage');

  // Après la fermeture (~1 s) : b en file d'attente, nouveau duel a/c sans votes
  await sleep(1500);
  assert.strictEqual(mock.queued, 'spotify:track:b');
  s = (await req('GET', '/api/state', me)).json();
  assert.strictEqual(s.next.id, 'b');
  assert.deepStrictEqual(s.duel.songs.map(x => x.id).sort(), ['a', 'c']);
  assert.ok(s.duel.songs.every(x => x.votes === 0));
  assert.strictEqual(s.closesIn, null, 'vote déjà clos pour T0');
  assert.deepStrictEqual(s.pool, []);

  // Votes
  assert.strictEqual((await req('POST', '/api/vote?id=c', me)).status, 200);
  assert.strictEqual((await req('POST', '/api/vote?id=b', me)).status, 400);
  s = (await req('GET', '/api/state', me)).json();
  assert.strictEqual(s.duel.mine, 'c');
  assert.strictEqual(s.duel.songs.find(x => x.id === 'c').votes, 1);
  assert.strictEqual((await req('GET', '/api/state', other)).json().duel.mine, null, 'autre visiteur');

  // Recherche + propositions
  const found = (await req('GET', '/api/search?q=test', me)).json();
  assert.deepStrictEqual(found.map(x => [x.id, x.taken]), [['d', false], ['a', true]]);
  assert.strictEqual((await req('POST', '/api/propose?id=d', me)).status, 200);
  assert.strictEqual((await req('POST', '/api/propose?id=d', me)).json().error, 'Déjà proposé');
  assert.strictEqual((await req('POST', '/api/propose?id=zzz', me)).json().error, 'Refais la recherche');
  s = (await req('GET', '/api/state', me)).json();
  assert.deepStrictEqual(s.pool.map(x => x.id), ['d']);
  assert.strictEqual(saved().songs.b.played, true);
  assert.ok(saved().songs.d);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(FILE).mode & 0o777, 0o600, 'jeton lisible par le seul propriétaire');

  // 429 : on arrête d'appeler Spotify pendant Retry-After
  mock.searchStatus = 429;
  assert.strictEqual((await req('GET', '/api/search?q=x')).status, 500);
  const before = count(/search/);
  assert.match((await req('GET', '/api/search?q=x')).json().error, /limite/);
  assert.strictEqual(count(/search/), before, 'aucun appel pendant le blocage');
  await sleep(2100);
  assert.strictEqual((await req('GET', '/api/search?q=x')).status, 200);

  // 401 : rafraîchissement forcé au prochain appel
  const refreshes = count(/api\/token/);
  mock.searchStatus = 401;
  assert.strictEqual((await req('GET', '/api/search?q=x')).status, 500);
  assert.strictEqual((await req('GET', '/api/search?q=x')).status, 200);
  assert.strictEqual(count(/api\/token/), refreshes + 1);

  // Connexion admin
  assert.strictEqual((await req('GET', '/login')).status, 401);
  assert.strictEqual((await req('GET', '/login', { authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') })).status, 401);
  r = await req('GET', '/login', auth);
  assert.strictEqual(r.status, 302);
  const loc = new URL(r.headers.location);
  assert.strictEqual(loc.origin + loc.pathname, 'https://accounts.spotify.com/authorize');
  assert.strictEqual(loc.searchParams.get('client_id'), 'cid');
  assert.strictEqual(loc.searchParams.get('redirect_uri'), 'http://127.0.0.1:8080/callback');
  assert.strictEqual(loc.searchParams.get('scope'), 'user-read-playback-state user-modify-playback-state');
  const st = loc.searchParams.get('state');
  assert.strictEqual((await req('GET', '/callback?state=wrong&code=CODE')).status, 400);
  r = await req('GET', `/callback?state=${st}&code=CODE`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/admin');
  assert.strictEqual((await req('GET', `/callback?state=${st}&code=CODE`)).status, 400, 'state à usage unique');

  // Mot de passe admin : 10 essais ratés, puis blocage de l'adresse (même avec le bon mot de passe)
  const robot = { 'x-real-ip': '10.6.6.6' };
  for (let i = 0; i < 10; i++) assert.strictEqual((await req('GET', '/admin', { ...robot, authorization: 'Basic ' + Buffer.from('x:essai' + i).toString('base64') })).status, 401);
  assert.strictEqual((await req('GET', '/admin', { ...robot, ...auth })).status, 429);
  assert.strictEqual((await req('GET', '/admin', auth)).status, 200, "les autres adresses ne sont pas bloquées");

  // Le gagnant b démarre (~31,5 s) : "à suivre" disparaît, nouveau compte à rebours
  await sleep(Math.max(0, 34000 - (Date.now() - t0)));
  s = (await req('GET', '/api/state', me)).json();
  assert.strictEqual(s.now.name, 'Song b');
  assert.strictEqual(s.next, null);
  assert.ok(s.closesIn > 140000 && s.closesIn < 150000, 'closesIn ' + s.closesIn);
  assert.strictEqual(count(/POST \/v1\/me\/player\/queue/), 1, 'une seule mise en file');

  // Les IP des auteurs ne sortent jamais
  s = (await req('GET', '/api/state', me)).json();
  assert.ok(!JSON.stringify(s).includes('10.0.0.1'), 'IP exposée');
  assert.strictEqual(s.pool.find(x => x.id === 'd').mine, true);
  assert.strictEqual((await req('GET', '/api/state', other)).json().pool.find(x => x.id === 'd').mine, false);

  // Relance : 2 votes "autres sons" contre 0
  assert.strictEqual(s.duel.reroll, 0);
  assert.deepStrictEqual(s.duel.songs.map(x => x.id).sort(), ['a', 'c']);
  assert.strictEqual((await req('POST', '/api/vote?id=reroll', me)).status, 200);
  s = (await req('GET', '/api/state', me)).json();
  assert.strictEqual(s.duel.mine, 'reroll');
  assert.strictEqual(s.duel.reroll, 1);
  assert.strictEqual((await req('POST', '/api/vote?id=reroll', other)).status, 200);
  s = (await req('GET', '/api/state', me)).json();
  assert.ok(s.duel.songs.some(x => x.id === 'd'), 'nouveau tirage');
  assert.strictEqual(s.duel.reroll, null, 'une seule relance');
  assert.strictEqual((await req('POST', '/api/vote?id=reroll', me)).status, 400);

  // Retrait de son propre son seulement
  assert.strictEqual((await req('POST', '/api/withdraw?id=d', other)).status, 400);
  assert.strictEqual((await req('POST', '/api/withdraw?id=d', me)).status, 200);
  s = (await req('GET', '/api/state', me)).json();
  assert.deepStrictEqual(s.duel.songs.map(x => x.id).sort(), ['a', 'c']);

  // Administration
  assert.strictEqual((await req('GET', '/admin')).status, 401);
  r = await req('GET', '/admin', { ...auth, 'sec-fetch-site': 'none' });
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Administration/);
  assert.strictEqual((await req('POST', '/admin/remove?id=a', { ...auth, 'sec-fetch-site': 'cross-site' })).status, 403, 'CSRF');
  assert.strictEqual((await req('POST', '/admin/remove?id=a')).status, 401);
  assert.strictEqual((await req('POST', '/admin/remove?id=a', { ...auth, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.match((await req('POST', '/api/propose?id=a', me)).json().error, /refusé/);
  assert.strictEqual((await req('POST', '/api/propose?id=d', other)).status, 200);
  assert.strictEqual((await req('POST', '/admin/block?id=zzz', auth)).status, 400);
  assert.strictEqual((await req('POST', '/admin/block?id=d', auth)).status, 200);
  s = (await req('GET', '/api/state', me)).json();
  assert.deepStrictEqual(s.duel.songs.map(x => x.id), ['c']);
  assert.strictEqual(s.banned, 2);
  assert.match((await req('POST', '/api/propose?id=d', other)).json().error, /bloqué/);
  assert.match((await req('POST', '/api/vote?id=c', other)).json().error, /bloqué/);
  assert.strictEqual((await req('POST', '/admin/unblock', auth)).status, 200);
  assert.strictEqual((await req('POST', '/api/propose?id=d', other)).status, 200);

  // L'auteur n'est visible que de l'admin pendant le duel
  assert.strictEqual((await req('POST', '/api/vote?id=d', me)).status, 200);
  assert.ok((await req('GET', '/api/state', me)).json().duel.songs.every(x => !('author' in x)));
  assert.strictEqual((await req('GET', '/admin/state')).status, 401);
  assert.strictEqual((await req('GET', '/admin/state', auth)).json().duel.songs.find(x => x.id === 'd').author, 'Autre');

  // Passer : le vote de b se ferme tout de suite, le gagnant (d, 1 vote contre 0) est lancé
  assert.strictEqual(count(/POST \/v1\/me\/player\/queue/), 1);
  assert.strictEqual((await req('POST', '/admin/skip', auth)).status, 200);
  assert.strictEqual(mock.queued, 'spotify:track:d');
  assert.strictEqual(count(/POST \/v1\/me\/player\/queue/), 2);
  assert.strictEqual(count(/POST \/v1\/me\/player\/next/), 1);
  assert.strictEqual((await req('GET', '/api/state', me)).json().next.id, 'd');
  await sleep(2000);
  s = (await req('GET', '/api/state', me)).json();
  assert.strictEqual(s.now.name, 'Song d');
  assert.strictEqual(s.next, null);
  assert.ok(s.closesIn > 140000, 'nouveau vote ouvert');

  // Classement : le vote reçu par d compte pour son auteur, révélé quand le son passe
  assert.strictEqual(s.now.author, 'Autre');
  assert.deepStrictEqual(s.ranking, [{ name: 'Autre', score: 1 }]);
  assert.strictEqual((await req('POST', '/admin/block?name=Inconnu', auth)).status, 400);
  assert.strictEqual((await req('POST', '/admin/block?name=Autre', auth)).status, 200);
  assert.deepStrictEqual((await req('GET', '/api/state')).json().ranking, [], 'bloqué : hors classement');
  assert.strictEqual((await req('POST', '/admin/unblock', auth)).status, 200);
  assert.strictEqual((await req('POST', '/admin/reset-ranking', auth)).status, 200);
  s = (await req('GET', '/api/state', me)).json();
  assert.deepStrictEqual(s.ranking, []);
  assert.strictEqual(s.name, null, 'pseudo à rechoisir');

  // Pause / reprise par l'hôte (plus aucune action admin en GET)
  assert.strictEqual((await req('GET', '/off', auth)).status, 404);
  assert.strictEqual((await req('POST', '/admin/pause')).status, 401);
  assert.strictEqual((await req('POST', '/admin/pause', auth)).status, 200);
  s = (await req('GET', '/api/state')).json();
  assert.strictEqual(s.paused, true);
  assert.strictEqual(s.now, null);
  assert.strictEqual(s.closesIn, null);
  assert.strictEqual(saved().paused, true);
  assert.strictEqual((await req('POST', '/admin/resume', auth)).status, 200);
  assert.strictEqual((await req('GET', '/api/state')).json().paused, false);

  // Reset des sons déjà passés (b et d) : la liste en attente reste
  assert.strictEqual((await req('POST', '/admin/reset-played')).status, 401);
  assert.strictEqual((await req('POST', '/admin/reset-played', auth)).status, 200);
  assert.deepStrictEqual(Object.keys(saved().songs), ['c'], 'seul le perdant en attente reste');

  // Refresh token révoqué : déconnexion propre
  mock.refreshFails = true;
  mock.searchStatus = 401;
  await req('GET', '/api/search?q=x');
  assert.strictEqual((await req('GET', '/api/search?q=x')).status, 500);
  assert.strictEqual((await req('GET', '/api/state')).json().connected, false);

  // 10 recherches par minute et par personne
  const greedy = { 'x-real-ip': '10.0.0.9' };
  for (let i = 0; i < 10; i++) assert.notStrictEqual((await req('GET', '/api/search?q=x', greedy)).status, 429);
  assert.strictEqual((await req('GET', '/api/search?q=x', greedy)).status, 429);
  assert.notStrictEqual((await req('GET', '/api/search?q=x', me)).status, 429, 'les autres peuvent encore chercher');
});
