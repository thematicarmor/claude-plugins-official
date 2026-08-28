/**
 * Naming for spawned session channels.
 *
 * `/new` takes a task, not a project, because sessions all run from the
 * workspace root and routinely touch several repos. The channel name is
 * therefore derived from the task text, with a repo prefix when the task
 * names one — `fix the saber glow in starwars` → `starwars-saber-glow`.
 */

/** Discord's own limit is 100; leaving room keeps collision suffixes safe. */
const MAX_NAME = 90

/**
 * Dropped so the name is built from words that distinguish one task from
 * another. Verbs like "fix" and "add" are kept — they carry real meaning.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'at', 'of', 'for', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'with', 'from', 'into', 'my', 'our', 'we', 'i', 'you', 'your', 'please',
  'can', 'could', 'would', 'should', 'lets', 'let', 'me', 'us', 'do', 'does',
  'so', 'then', 'than', 'there', 'here', 'up', 'out', 'if', 'as', 'by',
])

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~>#|]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Picks the repo a task is about, if it names one. Longest match wins so
 * `claude-plugins-official` isn't shadowed by a shorter repo whose name is a
 * substring of it.
 */
export function detectRepo(task: string, repos: string[]): string | null {
  const hay = slugify(task)
  const hits = repos
    .filter(r => {
      const s = slugify(r)
      return s.length > 2 && new RegExp(`(^|-)${s}(-|$)`).test(hay)
    })
    .sort((a, b) => b.length - a.length)
  return hits[0] ?? null
}

/**
 * Builds a channel name from a task. `taken` is consulted for collisions, to
 * which a numeric suffix is appended.
 */
export function channelNameFor(task: string, repos: string[], taken: string[] = [], words = 4): string {
  const repo = detectRepo(task, repos)
  const repoSlug = repo ? slugify(repo) : null

  const picked: string[] = []
  for (const w of slugify(task).split('-')) {
    if (!w || STOPWORDS.has(w)) continue
    // The repo name is already the prefix; don't repeat it in the tail.
    if (repoSlug && (w === repoSlug || repoSlug.split('-').includes(w))) continue
    picked.push(w)
    if (picked.length >= words) break
  }

  let base = [repoSlug, ...picked].filter(Boolean).join('-')
  if (!base) base = 'session'
  if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME).replace(/-+$/, '')

  const used = new Set(taken.map(t => t.toLowerCase()))
  if (!used.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

/** tmux session name for a spawned Claude session. */
export function tmuxNameFor(channelName: string): string {
  // tmux treats '.' and ':' as address syntax, so keep the name plain.
  return `cc-${channelName}`.replace(/[.:]/g, '-').slice(0, 60)
}
