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

/* The connection card deliberately pins its own palette in .ccard instead of
   using the theme tokens (see the comment in app.css). Overriding only the
   colour *declarations* leaves these local variables dark, which produces an
   unreadable slate card with near-white text on a white page. Re-pin them. */
html[data-theme="light"] .ccard {
  --cc-accent: #2563EB;
  --cc-surface-top: #FFFFFF;
  --cc-surface-bottom: #F1F5FB;
  --cc-sub: rgba(15, 23, 42, 0.045);
  --cc-sub-border: rgba(15, 143, 107, 0.20);
  --cc-text: #111C2E;
  --cc-muted: rgba(17, 28, 46, 0.66);
  --cc-dim: rgba(17, 28, 46, 0.42);
}
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
// Emitted LAST: the automatic mapper occasionally rewrites a gradient that is
// built purely from custom properties (it sees a neighbouring rgba stop and
// substitutes both stops). Pin the connection card's gradient explicitly so
// the variable re-pinning above is what the browser actually paints.
const FINAL = `
/* Final word on the connection card: a white surface, not a tinted scrim.
   The drop shadow is kept deliberately tight: the card is flexed close to the
   window bottom, and a wide shadow would spill into the last three viewport
   rows that tests/layout-desktop.mjs requires to stay pure background. */
html[data-theme="light"] .ccard {
  background: linear-gradient(180deg, #FFFFFF, #F1F5FB) !important;
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.10) !important;
}

/* Small card labels are pinned to translucent white in upstream app.css and
   are not reached by the --cc-* variable re-pin. On a white card they turned
   into invisible text (e.g. the "Offline" ping-quality badge). */
html[data-theme="light"] .ccard__ping-q,
html[data-theme="light"] .ccard__ping-k,
html[data-theme="light"] .ccard__speed-total,
html[data-theme="light"] .ccard__slide-k,
html[data-theme="light"] .ccard__timer-k,
html[data-theme="light"] .ccard__pill-k,
html[data-theme="light"] .ccard__caption {
  color: rgba(17, 28, 46, 0.62) !important;
}

/* Home layout: no dead band under the connection card.
   At 390x820 the card ended at y=710, leaving 110px of empty window. The card
   now owns the remaining height and its rows spread across it. A 32px bottom
   gutter is kept: it is small enough that the old empty band is gone, but
   leaves room for the card's tightened drop shadow to fade out before the
   last three viewport rows (tests/layout-desktop.mjs checks those stay blank). */
html[data-theme="light"] .main { padding-bottom: 32px !important; }
html[data-theme="light"] .view--home { min-height: 100% !important; }
html[data-theme="light"] .view--home .ccard {
  display: flex !important;
  flex-direction: column !important;
  flex: 1 1 auto !important;
  min-height: 386px !important;
}
/* The card is a flex container now, so its body must grow with it. Without
   flex:1 the body keeps its natural height and the empty space simply moves
   inside the card instead of disappearing. .ccard__edge is position:absolute
   and stays out of the flex flow. */
html[data-theme="light"] .view--home .ccard__body {
  flex: 1 1 auto !important;
  justify-content: space-between !important;
}
`

fs.writeFileSync(OUT, header + TOKENS + '\n' + blocks.join('\n\n') + '\n' + FINAL, 'utf8')
console.log(`wrote ${path.relative(ROOT, OUT)}: ${stats.rules} rules, ${stats.decls} declarations`)
console.log('per file:', stats.files)
