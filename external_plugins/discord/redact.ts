/**
 * Scrubbing for anything bound for a Discord channel.
 *
 * Trace threads post tool arguments and tool output close to verbatim, and
 * `Bash` is by a wide margin the most-used tool. That makes this the most
 * likely route by which a secret from the environment ends up in a chat log,
 * so redaction is applied unconditionally rather than being a trace-only
 * concern.
 *
 * Two layers, because neither is sufficient alone:
 *   1. Known values, read from the user's own secret files. Exact, and covers
 *      secrets that look like ordinary words.
 *   2. Shape-based patterns, for credentials this process never loaded.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const MASK = '«redacted»'

/**
 * Files whose values are treated as secret. These are the ones CLAUDE.md
 * names as never-print; the list is deliberately conservative.
 */
const SECRET_FILES = [
  join(homedir(), 'workspace', '.env'),
  join(homedir(), '.gradle', 'gradle.properties'),
  join(homedir(), '.claude', 'channels', 'discord', '.env'),
]

/**
 * Short values are excluded: a 4-character secret would match constantly and
 * turn ordinary output into a wall of masks, which trains people to ignore it.
 */
const MIN_SECRET_LEN = 8

function parseValues(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    let v = line.slice(eq + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)
    ) {
      v = v.slice(1, -1)
    }
    if (v.length >= MIN_SECRET_LEN) out.push(v)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Credential shapes worth masking even when we never loaded the value. */
const PATTERNS: RegExp[] = [
  // Provider keys: sk-..., sk-ant-..., ghp_..., github_pat_...
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Discord bot tokens: three dot-separated base64 segments.
  /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // PEM private key bodies.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // `PASSWORD=hunter2`, `api_key: "..."` and friends.
  /\b([A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z_]*)\s*[:=]\s*"?([^\s"',;]{6,})"?/gi,
]

export class Redactor {
  private values: string[] = []

  constructor(files: string[] = SECRET_FILES) {
    for (const f of files) {
      try {
        this.values.push(...parseValues(readFileSync(f, 'utf8')))
      } catch {
        // Missing or unreadable secret file is normal; patterns still apply.
      }
    }
    // Longest first, so a value containing another is masked whole.
    this.values.sort((a, b) => b.length - a.length)
  }

  /** True if any known secret value appears verbatim. */
  containsSecret(text: string): boolean {
    return this.values.some(v => text.includes(v))
  }

  redact(text: string): string {
    let out = text
    for (const v of this.values) {
      if (!v) continue
      out = out.replace(new RegExp(escapeRe(v), 'g'), MASK)
    }
    for (const re of PATTERNS) {
      out = out.replace(re, (m, ...rest) => {
        // The key=value pattern keeps its key so the line stays readable.
        if (typeof rest[0] === 'string' && typeof rest[1] === 'string') return `${rest[0]}=${MASK}`
        return MASK
      })
    }
    return out
  }
}
