// Text normalisation for search. SQLite on D1 only folds ASCII case and never strips Greek accents,
// so we store a normalised copy of each question (see table qnorm) and normalise queries the same way.
// Order matters: strip marks, lowercase, then final sigma (toLowerCase turns "ΟΔΟΣ" into "οδος").
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ς/g, 'σ').normalize('NFC');
export const terms = (q, max = 6) => [...new Set(norm(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, max);
// What we index for one question: `norm` is title+body, `head` is the title plus ",tag,tag," for topic matching.
export const indexRow = (title, body, tags) => ({
  norm: norm(title + ' ' + body),
  head: norm(title) + ' ,' + (tags || []).map(norm).join(',') + ',',
});
