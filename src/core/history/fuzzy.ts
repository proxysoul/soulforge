export interface FuzzyMatch {
  entry: string;
  score: number;
  indices: number[];
}

export function fuzzyMatch(pattern: string, target: string): FuzzyMatch | null {
  const p = pattern.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let pi = 0;

  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) {
      indices.push(ti);

      if (ti === 0) score += 5;
      else if (t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-" || t[ti - 1] === "_")
        score += 3;

      if (indices.length > 1 && indices[indices.length - 2] === ti - 1) score += 2;

      pi++;
    } else if (indices.length > 0) {
      score -= 1;
    }
  }

  if (pi < p.length) return null;

  // Prefix matches rank above scattered subsequence matches (e.g. "/mod" → "/models"
  // beats "/model-scope"). Ignore a leading slash on both sides so "/model" prefixes
  // "/models". Shorter targets win ties so the exact command surfaces first.
  const strip = (s: string) => (s.startsWith("/") ? s.slice(1) : s);
  const sp = strip(p);
  const st = strip(t);
  if (sp.length > 0 && st.startsWith(sp)) {
    score += 100;
    if (st.length === sp.length) score += 50;
    score -= st.length;
  }

  return { entry: target, score, indices };
}

export function fuzzyFilter(pattern: string, entries: string[], limit = 50): FuzzyMatch[] {
  if (!pattern) return entries.slice(0, limit).map((e) => ({ entry: e, score: 0, indices: [] }));

  const matches: FuzzyMatch[] = [];
  for (const entry of entries) {
    const m = fuzzyMatch(pattern, entry);
    if (m) matches.push(m);
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}
