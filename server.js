const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const game = require('./game');

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, ADMIN_PASSWORD, PORT = 8080 } = process.env;
const missing = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI', 'ADMIN_PASSWORD'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Variables manquantes : ${missing.join(', ')} (voir .env.example)`);
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 12) console.warn('ADMIN_PASSWORD fait moins de 12 caractères : choisis un mot de passe plus long');

const CLOSE = 30000; // le vote se ferme 30 s avant la fin : le fondu enchaîné de Spotify va jusqu'à 12 s, il reste de quoi réessayer en cas d'erreur
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DIR, 'state.json');
fs.mkdirSync(DIR, { recursive: true });
let state = { token: null, songs: {}, duel: null };
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') { // fichier illisible : on le met de côté plutôt que de l'écraser
    console.error(`${FILE} illisible (${e.message}) : copié dans state.json.corrupt, on repart de zéro`);
    fs.renameSync(FILE, FILE + '.corrupt');
  }
}
// Écriture atomique, lisible par le seul propriétaire (le fichier contient le jeton Spotify).
const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(state), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); };

// --- Spotify ---

const TIMEOUT = 10000; // un appel qui ne répond pas ne doit pas bloquer le suivi de la lecture
const basic = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
async function auth(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: basic }, body: new URLSearchParams(params), signal: AbortSignal.timeout(TIMEOUT) });
  const t = await r.json();
  if (!r.ok) {
    if (t.error === 'invalid_grant' && params.refresh_token) { state.token = null; save(); } // accès révoqué ou expiré : l'hôte doit se reconnecter
    throw new Error(`Spotify : ${t.error_description || t.error}`);
  }
  state.token = { access: t.access_token, refresh: t.refresh_token || state.token?.refresh, expires: Date.now() + t.expires_in * 1000 };
  save();
}

let blockedUntil = 0, refreshing = null;
async function api(path, method = 'GET') {
  if (!state.token) throw new Error('Spotify non connecté');
  if (Date.now() < blockedUntil) throw new Error('Spotify limite les requêtes, réessaie plus tard');
  if (Date.now() > state.token.expires - 60000) await (refreshing ??= auth({ grant_type: 'refresh_token', refresh_token: state.token.refresh }).finally(() => refreshing = null));
  const r = await fetch('https://api.spotify.com/v1' + path, { method, headers: { Authorization: 'Bearer ' + state.token.access }, signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status === 401) state.token.expires = 0; // force un rafraîchissement au prochain appel
  if (r.status === 429) blockedUntil = Date.now() + (Number(r.headers.get('retry-after')) || 60) * 1000; // préserve le quota du compte développeur
  if (!r.ok) throw new Error(`Spotify ${r.status} : ${await r.text()}`);
  return method === 'GET' && r.status !== 204 ? r.json() : null;
}

const track = t => ({ id: t.id, uri: t.uri, name: t.name, artists: t.artists.map(a => a.name).join(', '), image: (t.album.images[1] || t.album.images[0])?.url });

// Ferme le vote du morceau `uri` : le gagnant part dans la file d'attente Spotify. Une seule fermeture à la fois.
let player = null, upNext = null, closedFor = null, closing = null, timer;
const closeVote = uri => closing ??= (async () => {
  const id = game.winner(state.duel);
  if (id) {
    await api('/me/player/queue?uri=' + encodeURIComponent(state.songs[id].uri), 'POST');
    upNext = state.songs[id];
    game.played(state, id);
    save();
  }
  closedFor = uri;
})().finally(() => closing = null);

// Un seul suivi à la fois, même si l'admin demande une resynchro pendant un tour.
const schedule = ms => { clearTimeout(timer); timer = setTimeout(tick, ms).unref(); };

// Suit la lecture de l'hôte. On ne sonde Spotify qu'aux moments utiles (~10 appels par morceau) pour ménager le quota.
async function tick() {
  let wait = 30000; // rien en lecture
  try {
    if (!state.token || state.paused) { player = null; wait = 5000; return; } // en pause : on ne touche plus à Spotify
    const p = await api('/me/player');
    const t = p?.item;
    // pochette en 640 px pour /ecran
    player = t && { ...track(t), image: t.album.images[0]?.url, progress: p.progress_ms, duration: t.duration_ms, playing: p.is_playing, at: Date.now() };
    if (!t || !p.is_playing) return;
    if (t.uri === upNext?.uri) upNext = null;
    const left = t.duration_ms - p.progress_ms;
    if (closedFor !== t.uri) {
      if (left > CLOSE) { wait = Math.min(30000, left - CLOSE); return; } // resynchro régulière (pause, morceau passé…)
      await closeVote(t.uri);
    }
    wait = Math.min(30000, left + 1500); // juste après le changement de morceau
  } catch (e) {
    console.error(e.message);
    wait = 10000;
  } finally {
    schedule(Math.max(1000, wait));
  }
}
tick();

// --- Site ---

const page = file => fs.readFileSync(path.join(__dirname, file));
const pages = { '/': page('index.html'), '/ecran': page('screen.html'), '/admin': page('admin.html') };
const qrLib = page('vendor/qrcode.js'); // qrcode-generator 2.0.4 (Kazuhiko Arase, MIT), tel que publié sur npm
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

// L'adresse de l'invité vient de l'en-tête X-Real-IP posé par le reverse proxy. On ne le croit que si la connexion
// vient d'un réseau privé (proxy sur la même machine ou dans Docker) : sinon n'importe qui pourrait s'inventer des adresses.
const privateNet = ip => /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i.test(ip ?? '');
const client = req => (privateNet(req.socket.remoteAddress) && req.headers['x-real-ip']) || req.socket.remoteAddress;

// Refuse les requêtes déclenchées depuis un autre site : le navigateur y joindrait le mot de passe admin ou l'adresse de l'invité.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin; // navigateurs sans Sec-Fetch-Site
  return !origin || (URL.canParse(origin) && new URL(origin).host === req.headers.host);
}

// Réservé à l'hôte : ADMIN_PASSWORD via l'authentification HTTP du navigateur, 10 essais ratés par quart d'heure et par adresse.
const sha = s => crypto.createHash('sha256').update(s).digest();
const failures = new Map();
function admin(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'Requête refusée' });
  const who = client(req), f = failures.get(who), fresh = f && Date.now() < f.until;
  if (fresh && f.n >= 10) return send(res, 429, { error: "Trop d'essais, réessaie dans un quart d'heure" });
  const pass = Buffer.from(req.headers.authorization?.slice(6) ?? '', 'base64').toString().split(':').slice(1).join(':');
  if (crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD))) { failures.delete(who); return true; }
  if (req.headers.authorization) { // la première visite, sans mot de passe, ne compte pas
    if (failures.size > 10000) failures.clear();
    failures.set(who, { n: (fresh ? f.n : 0) + 1, until: Date.now() + 15 * 60000 });
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Jukeduel", charset="UTF-8"' });
  res.end('Mot de passe admin requis');
}

const seen = new Map(); // sons sortis d'une recherche : on ne peut proposer que de vrais sons Spotify
let oauthState = null, searches = [];

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://localhost'); // dans le try : une URL invalide ne doit pas faire tomber le serveur
    // Une personne = une adresse IP, pour que la navigation privée ou un autre navigateur ne donne pas de vote en plus.
    // Limite connue : des invités sur le même Wi-Fi en IPv4 partagent une adresse et comptent pour une seule personne.
    const who = client(req);
    if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Requête refusée' });
    // pour voter ou proposer, il faut un pseudo (il s'affiche au classement)
    if (req.method === 'POST' && ['/api/propose', '/api/vote'].includes(url.pathname) && !state.names?.[who]) return send(res, 400, { error: "Choisis d'abord un pseudo" });
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /admin': // fenêtre d'administration
        if (!admin(req, res)) return;
        // puis comme les autres pages
      case 'GET /':
      case 'GET /ecran': // affichage pour l'écran branché à la sono, sans vote
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pages[url.pathname]);

      case 'GET /qrcode.js': // pour le QR code de /ecran, servi par le site plutôt que par un service externe
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(qrLib);

      case 'GET /login':
        if (!admin(req, res)) return;
        oauthState = crypto.randomUUID();
        res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT_URI, scope: 'user-read-playback-state user-modify-playback-state', state: oauthState }) });
        return res.end();

      case 'GET /callback':
        if (!oauthState || url.searchParams.get('state') !== oauthState) return send(res, 400, { error: 'Connexion expirée, recommence via /login' });
        oauthState = null;
        if (!url.searchParams.get('code')) return send(res, 400, { error: 'Connexion Spotify refusée' });
        await auth({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: SPOTIFY_REDIRECT_URI });
        res.writeHead(302, { Location: '/admin' });
        return res.end();

      case 'POST /admin/pause': // couper le vote pour écouter Spotify normalement
      case 'POST /admin/resume':
        if (!admin(req, res)) return;
        state.paused = url.pathname === '/admin/pause';
        if (state.paused) player = null;
        else schedule(0);
        save();
        return send(res, 200, {});

      case 'POST /admin/reset-played': // les sons déjà passés peuvent être reproposés
        if (!admin(req, res)) return;
        game.resetPlayed(state);
        save();
        return send(res, 200, {});

      case 'POST /admin/skip': // ferme le vote si besoin, pour que le gagnant passe tout de suite
        if (!admin(req, res)) return;
        if (player && closedFor !== player.uri) await closeVote(player.uri);
        await api('/me/player/next', 'POST');
        schedule(1500);
        return send(res, 200, {});

      case 'POST /admin/remove': // le son est retiré et ne pourra plus être proposé
      case 'POST /admin/block': { // la personne qui a proposé ce son ne peut plus proposer ni voter
        if (!admin(req, res)) return;
        const id = url.searchParams.get('id'), name = url.searchParams.get('name'); // une personne : par un de ses sons ou par son pseudo
        const x = url.pathname === '/admin/remove' ? id : name ? Object.keys(state.names ?? {}).find(w => state.names[w] === name) : state.songs[id]?.by;
        if (!x) return send(res, 400, { error: name ? 'Pseudo introuvable' : "Ce son n'a pas été proposé sur le site" });
        game.ban(state, x);
        save();
        return send(res, 200, {});
      }

      case 'POST /admin/unblock':
        if (!admin(req, res)) return;
        state.banned = [];
        save();
        return send(res, 200, {});

      case 'POST /admin/reset-ranking': // nouvelle soirée : chacun rechoisit son pseudo
        if (!admin(req, res)) return;
        state.scores = {};
        state.names = {};
        save();
        return send(res, 200, {});

      case 'GET /admin/state': // avec le pseudo de l'auteur de chaque son, pour modérer
        if (!admin(req, res)) return;
        // puis comme pour les invités
      case 'GET /api/state': {
        const d = state.duel, p = player, names = state.names ?? {};
        const progress = p && Math.min(p.duration, p.progress + (p.playing ? Date.now() - p.at : 0));
        const pub = ({ by, played, ...s }) => ({ ...s, mine: by === who, ...url.pathname === '/admin/state' && { author: names[by] ?? null } }); // jamais l'IP de l'auteur
        return send(res, 200, {
          connected: !!state.token,
          paused: !!state.paused,
          banned: state.banned?.length ?? 0,
          name: names[who] ?? null,
          ranking: game.ranking(state).slice(0, 10),
          now: p && { ...p, progress, author: names[state.songs[p.id]?.by] ?? null }, // l'auteur n'est révélé que quand son son passe
          next: upNext && pub(upNext),
          closesIn: p?.playing && d && closedFor !== p.uri ? Math.max(0, p.duration - progress - CLOSE) : null,
          duel: d && {
            mine: d.votes[who] ?? null,
            reroll: game.canReroll(state) ? game.votes(d, game.REROLL) : null, // null : relance indisponible
            songs: d.ids.map(id => ({ ...pub(state.songs[id]), votes: game.votes(d, id) })),
          },
          pool: Object.values(state.songs).filter(s => !s.played && !d?.ids.includes(s.id)).map(pub),
        });
      }

      case 'GET /api/search': {
        const q = url.searchParams.get('q')?.trim().slice(0, 100);
        if (!q) return send(res, 200, []);
        // pour ménager le quota Spotify : 60 recherches par minute en tout, 10 par personne
        searches = searches.filter(s => Date.now() - s.t < 60000);
        if (searches.length >= 60 || searches.filter(s => s.who === who).length >= 10) return send(res, 429, { error: 'Trop de recherches, réessaie dans une minute' });
        searches.push({ who, t: Date.now() });
        const r = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: 10 })); // 10 = maximum autorisé en mode développement
        if (seen.size > 5000) seen.clear();
        return send(res, 200, r.tracks.items.filter(t => t && t.is_playable !== false).map(t => {
          seen.set(t.id, track(t));
          return { ...track(t), taken: !!state.songs[t.id] };
        }));
      }

      case 'POST /api/propose': {
        const t = seen.get(url.searchParams.get('id'));
        const error = t ? game.propose(state, t, who) : 'Refais la recherche';
        if (!error) save();
        return send(res, error ? 400 : 200, { error });
      }

      case 'POST /api/name': {
        const error = game.rename(state, who, url.searchParams.get('name'));
        if (!error) save();
        return send(res, error ? 400 : 200, { error });
      }

      case 'POST /api/vote':
      case 'POST /api/withdraw': {
        const error = (url.pathname === '/api/vote' ? game.vote : game.withdraw)(state, who, url.searchParams.get('id'));
        if (!error) save();
        return send(res, error ? 400 : 200, { error });
      }

      default:
        return send(res, 404, { error: 'Introuvable' });
    }
  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: e.message });
  }
});
server.listen(PORT, () => console.log(`Jukeduel écoute sur le port ${server.address().port}`));

module.exports = { server, privateNet };
