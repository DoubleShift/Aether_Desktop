// =============================================================================
//  gen-light-theme.mjs — produce src/styles/light.css (a white/light theme
//  overlay) from the five upstream stylesheets.
//
//  Why generated instead of hand-edited:
//    upstream hardcodes ~358 hex colours across app.css / chat.css / mobile.css
//    / parity.css / tokens.css. Editing them in place would touch thousands of
//    lines and make future upstream merges impossible. The overlay keeps every
//    original selector and only rewrites the colour-carrying declarations under
//    `html[data-theme="light"]`, so it wins by specificity and stays reversible
//    (remove data-theme="light" to get the original dark theme back).
//
//  Rules:
//    * neutral DARK colours in background/border/shadow -> light surfaces
//    * neutral LIGHT colours used as `color`            -> dark ink
//    * saturated brand / status colours                  -> kept as-is
//    * CSS custom properties in tokens.css are handled by an explicit block
//      appended by this script (never by the automatic mapper), because e.g.
//      --md-on-primary must stay white on a blue button.
//
//  Usage: node scripts/gen-light-theme.mjs
// =============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STYLES = path.join(ROOT, 'src', 'styles')
const SOURCES = ['app.css', 'chat.css', 'mobile.css', 'parity.css']
const OUT = path.join(STYLES, 'light.css')

// ---- colour helpers -------------------------------------------------------
function parseHex(h) {
  let s = h.slice(1)
  if (s.length === 3) s = s.split('').map(c => c + c).join('')
  if (s.length === 8) s = s.slice(0, 6) // ignore alpha for classification
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16))
}
function classify(hex) {
  const [r, g, b] = parseHex(hex)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const sat = max === 0 ? 0 : (max - min) / max
  // navy / charcoal / near-black neutrals
  if (sat > 0.28 && lum > 0.18) return 'accent'
  if (lum < 0.45) return 'dark'
  if (sat < 0.22 && lum > 0.62) return 'pale'
  return 'accent'
}
// Map a dark neutral to one of four light surfaces, preserving the original
// ordering (darkest -> white, lightest of the darks -> light grey).
function toSurface(hex) {
  const [r, g, b] = parseHex(hex)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (lum < 0.075) return '#FFFFFF'
  if (lum < 0.115) return '#F8FAFC'
  if (lum < 0.175) return '#F1F5F9'
  if (lum < 0.26) return '#E9EFF7'
  return '#E2E8F0'
}
function toInk(hex) {
  const [r, g, b] = parseHex(hex)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (lum > 0.94) return '#111C2E'
  if (lum > 0.84) return '#233248'
  return '#41506A'
}

const HEX_RE = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b/g
const COLOUR_PROPS = /^(color|background|background-color|background-image|border|border-top|border-right|border-bottom|border-left|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|outline|outline-color|box-shadow|text-shadow|fill|stroke|caret-color|column-rule-color|text-decoration-color|-webkit-text-fill-color)$/i
const BGISH = /background|border|outline|shadow/i

function rewrite(value, prop) {
  const isBg = BGISH.test(prop)
  let changed = false
  let out = value.replace(HEX_RE, (hex) => {
    const kind = classify(hex)
    if (isBg) {
      if (kind === 'dark') { changed = true; return toSurface(hex) }
      return hex
    }
    // `color` and friends
    if (kind === 'pale') { changed = true; return toInk(hex) }
    if (kind === 'dark' && prop === 'color') {
      // already dark ink on a (now light) surface -> keep
      return hex
    }
    return hex
  })
  // Dark translucent scrims / hairlines (rgba(3,7,15,.72) etc.)
  out = out.replace(/rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)/g,
    (whole, r, g, b, a) => {
      const R = +r, G = +g, B = +b, A = +a
      if (R < 90 && G < 100 && B < 130 && A > 0.25) {
        changed = true
        return `rgba(15, 23, 42, ${Math.min(A * 0.45, 0.32).toFixed(3)})`
      }
      if (R > 235 && G > 235 && B > 235) {
        changed = true
        return `rgba(15, 23, 42, ${Math.min(A, 0.18).toFixed(3)})`
      }
      return whole
    })
  return changed ? out : null
}

// ---- lightweight CSS rule walker -----------------------------------------
function* rules(css) {
  // innermost blocks only: selector { declarations } with no nested braces
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    yield [m[1].trim(), m[2]]
  }
}

function cleanSelector(sel) {
  // The innermost-block regex treats everything between a previous `}` and the
  // next `{` as a selector, which includes upstream's standalone comment
  // blocks. Strip them first or we emit broken rules like
  // `html[data-theme="light"] /* ... */`.
  return sel
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function scopeSelector(sel) {
  return sel.split(',').map(part => {
    const s = part.trim()
    if (!s) return ''
    if (s === ':root' || s === 'html' || s === 'html:root') return 'html[data-theme="light"]'
    if (s.startsWith('html')) return s.replace(/^html\b/, 'html[data-theme="light"]')
    if (s.startsWith('body') || s.startsWith('*')) return `html[data-theme="light"] ${s}`
    return `html[data-theme="light"] ${s}`
  }).filter(Boolean).join(',\n')
}

const blocks = []
const stats = { rules: 0, decls: 0, files: {} }

for (const file of SOURCES) {
  const css = fs.readFileSync(path.join(STYLES, file), 'utf8')
  let fileDecls = 0
  for (const [rawSel, body] of rules(css)) {
    const sel = cleanSelector(rawSel)
    if (!sel || /^@|^from$|^to$|^\d+%$/.test(sel)) continue
    // keyframes percentage selectors are handled as normal selectors; harmless
    const out = []
    for (const raw of body.split(';')) {
      const i = raw.indexOf(':')
      if (i < 0) continue
      const prop = raw.slice(0, i).trim()
      const val = raw.slice(i + 1).trim()
      if (!COLOUR_PROPS.test(prop) || !val) continue
      const next = rewrite(val, prop)
      if (next) { out.push(`  ${prop}: ${next} !important;`); fileDecls++ }
    }
    if (out.length) {
      blocks.push(`/* ${file}: ${sel.replace(/\s+/g, ' ').slice(0, 110)} */\n${scopeSelector(sel)} {\n${out.join('\n')}\n}`)
      stats.rules++
    }
  }
  stats.files[file] = fileDecls
  stats.decls += fileDecls
}

// ---- explicit token override (never auto-mapped) -------------------------
const TOKENS = `/* ==========================================================================
   Light design tokens. The original dark :root block is left untouched above
   (tokens.css), so switching data-theme back to "dark" restores 1.4.0 exactly.
   ========================================================================== */
html[data-theme="light"] {
  --navy-950: #FFFFFF;
  --navy-900: #FFFFFF;
  --navy-850: #F8FAFC;
  --navy-800: #FFFFFF;
  --navy-750: #F1F5F9;
  --navy-700: #F8FAFC;
  --navy-row: #F8FAFC;
  --navy-600: #DDE5F0;
  --navy-outline: #CBD5E1;
  --on-dark-faint: #64748B;
  --on-dark: #111C2E;
  --on-dark-muted: #5A6B84;
  --ambient-fill: #FFFFFF;

  --aether-teal:   #0E8FA6;
  --aether-blue:   #2563EB;
  --aether-cyan:   #0F8F6B;
  --aether-violet: #6D5BD0;
  --aether-violet-bg: #F1EEFF;
  --aether-amber:  #B45309;
  --aether-error:  #D92D4B;

  --md-primary:            #2563EB;
  --md-on-primary:         #FFFFFF;
  --md-secondary:          #0F8F6B;
  --md-on-secondary:       #FFFFFF;
  --md-tertiary:           #0F8F6B;
  --md-background:         #FFFFFF;
  --md-on-background:      #111C2E;
  --md-surface:            #FFFFFF;
  --md-on-surface:         #111C2E;
  --md-surface-variant:    #F1F5F9;
  --md-on-surface-variant: #5A6B84;
  --md-error:              #D92D4B;
  --md-on-error:           #FFFFFF;
  --md-outline:            #DDE5F0;

  --news-bg:            #FFFFFF;
  --news-bg-2:          #F8FAFC;
  --news-border:        #DDE5F0;
  --news-divider:       #E8EEF7;
  --news-text:          #111C2E;
  --news-text-2:        #334155;
  --news-note:          #5A6B84;
  --news-accent:        #2563EB;
  --news-accent-2:      #0E8FA6;
  --news-on-accent:     #FFFFFF;
  --news-warn-bg:       rgba(234, 179, 8, 0.12);
  --news-warn-bar:      #B45309;
  --news-scroll-track:  rgba(15, 23, 42, 0.06);
  --news-scroll-thumb:  rgba(37, 99, 235, 0.45);
  --news-scroll-hover:  #2563EB;
  --news-check-idle:    #94A3B8;
  --news-scrim:         rgba(15, 23, 42, 0.35);

  --settings-card-bg: #FFFFFF;
  --settings-divider: rgba(15, 23, 42, 0.09);

  --surface:  #FFFFFF;
  --surface-2:#F8FAFC;
  --text:     #111C2E;
  --text-dim: #5A6B84;
  --line:     #DDE5F0;
  --accent:   #2563EB;
  color-scheme: light;
}

html[data-theme="light"],
html[data-theme="light"] body {
  background-color: #FFFFFF !important;
  color: #111C2E !important;
}

html[data-theme="light"] ::-webkit-scrollbar-track { background: #F1F5F9; }
html[data-theme="light"] ::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 8px; }
html[data-theme="light"] ::selection { background: #DBEAFE; color: #111C2E; }
`

const header = `/* ==========================================================================
   Aether Desktop — Light (white background) theme overlay
   --------------------------------------------------------------------------
   GENERATED by scripts/gen-light-theme.mjs from ${SOURCES.join(', ')}.
   ${stats.rules} rules / ${stats.decls} colour declarations rewritten.
   Per-file declarations: ${JSON.stringify(stats.files)}
   Loaded LAST from src/index.html; active only when html has data-theme="light".
   ========================================================================== */

`
fs.writeFileSync(OUT, header + TOKENS + '\n' + blocks.join('\n\n') + '\n', 'utf8')
console.log(`wrote ${path.relative(ROOT, OUT)}: ${stats.rules} rules, ${stats.decls} declarations`)
console.log('per file:', stats.files)
