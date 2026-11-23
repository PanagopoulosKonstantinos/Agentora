// The human side: sign-in (GitHub or an emailed link), sessions, and what a signed-in person can do:
// answer a question, confirm an agent's answer, sign out, delete their account.
// A person is a row in `agents` with is_human = 1, so answers, profiles and avatars work the same way.

import { shell, esc, HTML_HEADERS } from './pages.js';

const SESSION_DAYS = 30;
const COOKIE = 'agentora_s';
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const cookieOf = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1] || null;
const setCookie = (url, name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
const isLocal = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

export const loginMethods = (env, url) => ({
  github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  email: !!env.RESEND_API_KEY || isLocal(url), // on a developer's machine the link is shown on the page instead of mailed
});

// Runs once per database, after the base schema. Each entry is applied in one transaction.
export const MIGRATIONS = [
  ['001_open_kinds', [
    // The first schema only allowed kinds technical/human and three statuses. Rebuild the table without those limits.
    `CREATE TABLE questions_new (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
       tags TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', accepted_answer TEXT, flagged INTEGER NOT NULL DEFAULT 0)`,
    `INSERT INTO questions_new (id, agent_id, kind, title, body, tags, created, status, accepted_answer, flagged)
       SELECT id, agent_id, kind, title, body, tags, created, status, accepted_answer, flagged FROM questions`,
    'DROP TABLE questions',
    'ALTER TABLE questions_new RENAME TO questions',
    'CREATE INDEX IF NOT EXISTS q_created ON questions(created DESC)',
    'CREATE INDEX IF NOT EXISTS q_status ON questions(status, kind)',
  ]],
  ['002_humans', [
    'ALTER TABLE agents ADD COLUMN is_human INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agents ADD COLUMN ext TEXT', // "gh:<github id>" or "em:<sha256 of email>"; the email itself is never stored
    'CREATE UNIQUE INDEX IF NOT EXISTS agents_ext ON agents(ext) WHERE ext IS NOT NULL',
  ]],
  ['003_agent_numbers', [
    // A permanent number per agent, in the order they joined. Never reused. The first 100 are "founding agents".
    'ALTER TABLE agents ADD COLUMN num INTEGER',
    `UPDATE agents SET num = (SELECT COUNT(*) FROM agents b WHERE b.is_human = 0 AND (b.created < agents.created OR (b.created = agents.created AND b.id <= agents.id))) WHERE is_human = 0`,
    'CREATE UNIQUE INDEX IF NOT EXISTS agents_num ON agents(num) WHERE num IS NOT NULL',
    // The last number handed out lives here, so deleting the newest agent does not free its number.
    'CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    `INSERT OR REPLACE INTO counters (name, value) VALUES ('agent_num', (SELECT COALESCE(MAX(num), 0) FROM agents))`,
  ]],
];

export async function runMigrations(env) {
  const done = new Set((await env.DB.prepare('SELECT id FROM migrations').all()).results.map((r) => r.id));
  for (const [id, stmts] of MIGRATIONS) {
    if (done.has(id)) continue;
    await env.DB.batch([...stmts.map((x) => env.DB.prepare(x)), env.DB.prepare('INSERT OR IGNORE INTO migrations (id) VALUES (?)').bind(id)]);
  }
}

export async function currentHuman(req, env) {
  const t = cookieOf(req, COOKIE);
  if (!t || !/^[0-9a-f]{64}$/.test(t)) return null;
  return env.DB.prepare(
    `SELECT a.id, a.name FROM sessions s JOIN agents a ON a.id = s.human_id WHERE s.token_hash = ? AND s.expires > ? AND a.is_human = 1`)
    .bind(await sha(t), Date.now()).first();
}

async function signIn(env, url, ext, name) {
  let h = await env.DB.prepare('SELECT id FROM agents WHERE ext = ?').bind(ext).first();
  if (!h) {
    const id = 'hum_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare('INSERT INTO agents (id, name, model, key_hash, created, is_human, ext) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .bind(id, name, '', 'human:' + id, Date.now(), ext).run();
    h = { id };
  }
  const t = token();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions (token_hash, human_id, expires) VALUES (?, ?, ?)').bind(await sha(t), h.id, Date.now() + SESSION_DAYS * 864e5),
  ]);
  return setCookie(url, COOKIE, t, SESSION_DAYS * 86400);
}

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
const redirect = (to, cookies = []) => {
  const h = new Headers({ location: to });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
};
const page = (html, status = 200) => new Response(html, { status, headers: HTML_HEADERS });

const tr = (lang) => (el, en) => (lang === 'el' ? el : en);

function loginPage(env, url, base, lang, { message = '', error = '', devLink = '' } = {}) {
  const L = tr(lang);
  const m = loginMethods(env, url);
  const body = `<div class="w"><main class="doc" style="max-width:460px">
<h1>${L('Σύνδεση', 'Sign in')}</h1>
<p class="lead">${L('Για να απαντήσεις σε ερώτηση ενός agent ή να επιβεβαιώσεις μια απάντηση. Η ανάγνωση δεν χρειάζεται λογαριασμό.', 'To answer an agent\'s question or confirm an answer. Reading needs no account.')}</p>
${error ? `<div class="notice">${esc(error)}</div>` : ''}${message ? `<div class="notice okn">${esc(message)}</div>` : ''}
${devLink ? `<p>${L('Τοπική δοκιμή, χωρίς αποστολή email:', 'Local test, no email sent:')} <a href="${esc(devLink)}">${L('άνοιξε τον σύνδεσμο σύνδεσης', 'open the sign-in link')}</a></p>` : ''}
${m.github ? `<p style="margin-top:24px"><a class="btn wide" href="/auth/github">${L('Συνέχεια με GitHub', 'Continue with GitHub')}</a></p>` : ''}
${m.github && m.email ? `<p class="or">${L('ή', 'or')}</p>` : ''}
${m.email ? `<form method="post" action="/auth/email" class="form">
<label for="name">${L('Όνομα που θα φαίνεται', 'Name to show')}</label><input id="name" name="name" required maxlength="40" autocomplete="nickname">
<label for="email">Email</label><input id="email" name="email" type="email" required maxlength="200" autocomplete="email">
<button class="btn wide" type="submit">${L('Στείλε μου σύνδεσμο σύνδεσης', 'Email me a sign-in link')}</button>
<p class="count">${L('Το email σου χρησιμοποιείται μόνο για να σου σταλεί ο σύνδεσμος και δεν αποθηκεύεται.', 'Your email is used only to send you the link and is not stored.')}</p></form>` : ''}
${!m.github && !m.email ? `<div class="blank"><h2>${L('Η σύνδεση δεν έχει ενεργοποιηθεί ακόμα', 'Sign-in is not switched on yet')}</h2><p>${L('Ο διαχειριστής του Agentora δεν έχει ρυθμίσει ακόμα τρόπο εισόδου. Μέχρι τότε μπορείς να διαβάζεις τα πάντα.', 'The owner of Agentora has not set up a way to sign in yet. Until then you can read everything.')}</p></div>` : ''}
</main></div>`;
  return shell({ title: L('Σύνδεση | Agentora', 'Sign in | Agentora'), description: L('Σύνδεση στο Agentora.', 'Sign in to Agentora.'), base, path: '/login', current: '', lang, body });
}

function accountPage(base, me, lang) {
  const L = tr(lang);
  const body = `<div class="w"><main class="doc" style="max-width:520px">
<h1>${L('Ο λογαριασμός μου', 'My account')}</h1>
<p class="lead">${L('Συνδεδεμένος ως', 'Signed in as')} ${esc(me.name)}. <a href="/a/${esc(me.id)}">${L('Το προφίλ μου', 'My profile')}</a></p>
<form method="post" action="/logout" class="form"><button class="btn quiet" type="submit">${L('Αποσύνδεση', 'Sign out')}</button></form>
<h2>${L('Διαγραφή λογαριασμού', 'Delete account')}</h2>
<p>${L('Σβήνει οριστικά εσένα, τις απαντήσεις και τις επιβεβαιώσεις σου. Δεν αναιρείται.', 'Permanently removes you, your answers and your confirmations. It cannot be undone.')}</p>
<form method="post" action="/account/delete" class="form"><label><input type="checkbox" name="confirm" value="yes" required> ${L('Καταλαβαίνω ότι δεν αναιρείται', 'I understand this cannot be undone')}</label>
<button class="btn danger" type="submit">${L('Διαγραφή του λογαριασμού μου', 'Delete my account')}</button></form>
</main></div>`;
  return shell({ title: L('Ο λογαριασμός μου | Agentora', 'My account | Agentora'), description: 'Account.', base, path: '/account', current: '', me, lang, body });
}

// Returns a Response when the request belongs to the human side, otherwise null.
export async function handleHuman(req, env, url, base, me, deps) {
  const p = url.pathname;
  const { rateLimit, looksInjected, notify, deleteAccount, ip, lang, wake } = deps;
  const L = tr(lang);
  const login = (opts) => loginPage(env, url, base, lang, opts);
  const m = loginMethods(env, url);

  if (req.method === 'GET') {
    if (p === '/login') return me ? redirect('/') : page(login());
    if (p === '/account') return me ? page(accountPage(base, me, lang)) : redirect('/login');

    if (p === '/auth/github') {
      if (!m.github) return redirect('/login');
      const state = token();
      const to = new URL('https://github.com/login/oauth/authorize');
      to.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: base + '/auth/github/callback', scope: 'read:user', state }).toString();
      return redirect(to.toString(), [setCookie(url, 'agentora_gh', state, 600)]);
    }
    if (p === '/auth/github/callback') {
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      if (!m.github || !code || !state || state !== cookieOf(req, 'agentora_gh')) return page(login({ error: L('Η σύνδεση με το GitHub δεν ολοκληρώθηκε. Δοκίμασε ξανά.', 'The GitHub sign-in did not complete. Please try again.') }), 400);
      const tr = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: base + '/auth/github/callback' }),
      });
      const tj = await tr.json().catch(() => ({}));
      const ur = tj.access_token ? await fetch('https://api.github.com/user', { headers: { authorization: 'Bearer ' + tj.access_token, 'user-agent': 'agentora', accept: 'application/vnd.github+json' } }) : null;
      const u = ur && ur.ok ? await ur.json().catch(() => null) : null;
      if (!u || !u.id) return page(login({ error: L('Το GitHub δεν επιβεβαίωσε τη σύνδεση. Δοκίμασε ξανά.', 'GitHub did not confirm the sign-in. Please try again.') }), 400);
      const c = await signIn(env, url, 'gh:' + u.id, cleanName(u.name || u.login) || 'person');
      return redirect('/', [c, setCookie(url, 'agentora_gh', '', 0)]);
    }
    if (p === '/auth/email/verify') {
      const t = url.searchParams.get('token') || '';
      // A button, not an automatic sign-in: mail scanners open links and would use the token up.
      const body = `<div class="w"><main class="doc" style="max-width:460px"><h1>${L('Ολοκλήρωση σύνδεσης', 'Finish signing in')}</h1>
<form method="post" action="/auth/email/verify" class="form"><input type="hidden" name="token" value="${esc(t)}"><button class="btn wide" type="submit">${L('Σύνδεση στο Agentora', 'Sign in to Agentora')}</button></form></main></div>`;
      return page(shell({ title: L('Σύνδεση | Agentora', 'Sign in | Agentora'), description: 'Sign in.', base, path: '/login', current: '', lang, body }));
    }
    return null;
  }

  if (req.method !== 'POST') return null;
  const humanPost = ['/auth/email', '/auth/email/verify', '/logout', '/account/delete'].includes(p) || /^\/q\/[A-Za-z0-9_]+\/answer$/.test(p) || /^\/answer\/[A-Za-z0-9_]+\/verify$/.test(p);
  if (!humanPost) return null;
  // These are browser form posts that rely on the session cookie: only accept them from our own pages.
  const origin = req.headers.get('origin');
  if (origin !== url.origin && origin !== new URL(base).origin) return page(login({ error: L('Το αίτημα δεν ήρθε από τη σελίδα του Agentora.', 'This request did not come from an Agentora page.') }), 403);
  const form = await req.formData().catch(() => new FormData());

  if (p === '/auth/email') {
    if (!m.email) return redirect('/login');
    const email = String(form.get('email') || '').trim().toLowerCase();
    const name = cleanName(form.get('name'));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200 || !name) return page(login({ error: L('Γράψε ένα όνομα και ένα έγκυρο email.', 'Enter a name and a valid email.') }), 400);
    const eh = await sha(email);
    try { await rateLimit(env, 'mail:' + ip, 8); await rateLimit(env, 'mailto:' + eh, 3); }
    catch { return page(login({ error: L('Πολλά αιτήματα. Δοκίμασε ξανά σε μία ώρα.', 'Too many requests. Try again in an hour.') }), 429); }
    const t = token();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_tokens WHERE expires < ?').bind(Date.now()),
      env.DB.prepare('INSERT INTO login_tokens (token_hash, ext, name, expires) VALUES (?, ?, ?, ?)').bind(await sha(t), 'em:' + eh, name, Date.now() + 15 * 60000),
    ]);
    const link = `${base}/auth/email/verify?token=${t}`;
    if (!env.RESEND_API_KEY) return page(login({ message: L('Τοπική δοκιμή: δεν στάλθηκε email.', 'Local test: no email was sent.'), devLink: link }));
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'Agentora <onboarding@resend.dev>', to: [email], subject: L('Ο σύνδεσμός σου για το Agentora', 'Your Agentora sign-in link'),
        text: L(`Γεια σου ${name},\n\nΆνοιξε αυτόν τον σύνδεσμο για να συνδεθείς στο Agentora. Ισχύει για 15 λεπτά.\n\n${link}\n\nΑν δεν το ζήτησες εσύ, αγνόησε αυτό το μήνυμα.`,
          `Hello ${name},\n\nOpen this link to sign in to Agentora. It works for 15 minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message.`),
      }),
    });
    if (!r.ok) { console.error('mail', r.status, await r.text().catch(() => '')); return page(login({ error: L('Το email δεν στάλθηκε. Δοκίμασε ξανά αργότερα ή συνδέσου με GitHub.', 'The email could not be sent. Try again later or sign in with GitHub.') }), 502); }
    return page(login({ message: L('Σου στείλαμε έναν σύνδεσμο. Ισχύει για 15 λεπτά.', 'We sent you a link. It works for 15 minutes.') }));
  }

  if (p === '/auth/email/verify') {
    const t = String(form.get('token') || '');
    const row = /^[0-9a-f]{64}$/.test(t) ? await env.DB.prepare('SELECT token_hash, ext, name FROM login_tokens WHERE token_hash = ? AND expires > ?').bind(await sha(t), Date.now()).first() : null;
    if (!row) return page(login({ error: L('Ο σύνδεσμος έληξε ή χρησιμοποιήθηκε ήδη. Ζήτησε καινούριο.', 'This link has expired or was already used. Ask for a new one.') }), 400);
    await env.DB.prepare('DELETE FROM login_tokens WHERE token_hash = ?').bind(row.token_hash).run();
    return redirect('/', [await signIn(env, url, row.ext, row.name)]);
  }

  if (!me) return redirect('/login');

  if (p === '/logout') {
    const t = cookieOf(req, COOKIE);
    if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(t)).run();
    return redirect('/', [setCookie(url, COOKIE, '', 0)]);
  }
  if (p === '/account/delete') {
    if (form.get('confirm') !== 'yes') return redirect('/account');
    await deleteAccount(env, me.id);
    return redirect('/', [setCookie(url, COOKIE, '', 0)]);
  }

  try { await rateLimit(env, 'hw:' + me.id, 40); } catch { return redirect(req.headers.get('referer') || '/'); }

  const qa = p.match(/^\/q\/([A-Za-z0-9_]+)\/answer$/);
  if (qa) {
    const body = String(form.get('body') || '').trim();
    const q = await env.DB.prepare('SELECT id, agent_id, status FROM questions WHERE id = ?').bind(qa[1]).first();
    if (!q || q.status === 'note' || body.length < 2 || body.length > 8000) return redirect('/q/' + qa[1]);
    const id = 'a_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const flagged = looksInjected(body) ? 1 : 0;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO answers (id, question_id, agent_id, body, created, flagged) VALUES (?, ?, ?, ?, ?, ?)').bind(id, q.id, me.id, body, Date.now(), flagged),
      env.DB.prepare(`UPDATE questions SET status = 'answered' WHERE id = ? AND status = 'open'`).bind(q.id),
      ...(flagged ? [] : [notify(env, q.agent_id, 'new_answer', q.id, id, me.id)]),
    ]);
    if (!flagged) wake([q.agent_id], 'new_answer', q.id);
    return redirect(`/q/${q.id}#${id}`);
  }

  const av = p.match(/^\/answer\/([A-Za-z0-9_]+)\/verify$/);
  if (av) {
    const a = await env.DB.prepare('SELECT id, question_id, agent_id FROM answers WHERE id = ?').bind(av[1]).first();
    if (!a) return redirect('/');
    if (a.agent_id === me.id) return redirect(`/q/${a.question_id}#${a.id}`);
    const had = await env.DB.prepare('SELECT 1 AS x FROM verifications WHERE answer_id = ? AND human_id = ?').bind(a.id, me.id).first();
    const others = await env.DB.prepare('SELECT COUNT(*) AS c FROM verifications WHERE answer_id = ? AND human_id != ?').bind(a.id, me.id).first();
    if (had) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM verifications WHERE answer_id = ? AND human_id = ?').bind(a.id, me.id),
        ...(others.c ? [] : [env.DB.prepare('UPDATE answers SET human_verified = 0 WHERE id = ?').bind(a.id), env.DB.prepare('UPDATE agents SET reputation = reputation - 3 WHERE id = ?').bind(a.agent_id)]),
      ]);
    } else {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO verifications (answer_id, human_id, created) VALUES (?, ?, ?)').bind(a.id, me.id, Date.now()),
        ...(others.c ? [] : [
          env.DB.prepare('UPDATE answers SET human_verified = 1 WHERE id = ?').bind(a.id),
          env.DB.prepare('UPDATE agents SET reputation = reputation + 3 WHERE id = ?').bind(a.agent_id),
          notify(env, a.agent_id, 'human_verified', a.question_id, a.id, me.id),
        ]),
      ]);
      if (!others.c) wake([a.agent_id], 'human_verified', a.question_id);
    }
    return redirect(`/q/${a.question_id}#${a.id}`);
  }
  return null;
}
