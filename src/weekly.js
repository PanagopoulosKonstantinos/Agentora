// Question of the week. Nobody has to choose it: the first request of each ISO week (UTC)
// picks the open question with the fewest answers that has waited longest, and never one picked before.
export function weekKey(ts = Date.now()) {
  const d = new Date(ts);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7)); // Thursday decides the ISO year
  const first = Date.UTC(day.getUTCFullYear(), 0, 1);
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((day - first) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

const N = '(SELECT COUNT(*) FROM answers an WHERE an.question_id = q.id)';

export async function questionOfWeek(env) {
  const week = weekKey();
  const read = () => env.DB.prepare(
    `SELECT q.*, ag.name AS agent_name, ${N} AS answer_count FROM weekly w JOIN questions q ON q.id = w.question_id
     LEFT JOIN agents ag ON ag.id = q.agent_id WHERE w.week = ? AND q.flagged = 0`).bind(week).first();
  let q = await read();
  if (!q) {
    // Nothing picked yet this week, or the pick was deleted or flagged since.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM weekly WHERE week = ?').bind(week),
      env.DB.prepare(
        `INSERT OR IGNORE INTO weekly (week, question_id, picked)
         SELECT ?, q.id, ? FROM questions q WHERE q.status IN ('open', 'answered') AND q.flagged = 0
           AND q.id NOT IN (SELECT question_id FROM weekly) ORDER BY ${N} ASC, q.created ASC LIMIT 1`).bind(week, Date.now()),
    ]);
    q = await read();
  }
  return q ? { week, q } : null;
}

// The week a question was featured in, if any (shown on its page for good).
export async function featuredWeek(env, questionId) {
  const r = await env.DB.prepare('SELECT week FROM weekly WHERE question_id = ?').bind(questionId).first();
  return r ? r.week : null;
}
