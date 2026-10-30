// Read-only check of the built site in dist/. Run after `npm run build`: node tests/dist-check.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const members = [
  ['elnur', 'Elnur'], ['sabina', 'Sabina'], ['nadir', 'Nadir'], ['chinara', 'Chinara'],
  ['alibala', 'Alibala'], ['elkhan', 'Elkhan'], ['fazil', 'Fazil'],
];
let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const read = (p) => readFileSync(join(dist, p), 'utf8');
const navOf = (html) => html.match(/<nav aria-label="Rooms"[\s\S]*?<\/nav>/)?.[0] ?? '';
const links = (nav) => [...nav.matchAll(/<a href="([^"]+)"([^>]*)>/g)].map((m) => ({ href: m[1], attrs: m[2] }));

// Picker
check(existsSync(join(dist, 'index.html')), 'dist/index.html exists');
const index = read('index.html');
check(/The Alishly family/.test(index), 'picker has title "The Alishly family"');
check(/<h1[^>]*>\s*The Alishly family/.test(index), 'picker title is an <h1>');
for (const [slug, name] of members) {
  check(new RegExp(`href="/rooms/${slug}/"[\\s\\S]*?${name}`).test(index), `picker links to /rooms/${slug}/ with name ${name}`);
}
check(!/<canvas/.test(index), 'picker has no <canvas>');
check(!/RoomScene\.astro_astro_type_script/.test(index), 'picker does not load the three.js bundle');

// Rooms
for (const [slug, name] of members) {
  const f = `rooms/${slug}/index.html`;
  check(existsSync(join(dist, f)), `${f} exists`);
  if (!existsSync(join(dist, f))) continue;
  const html = read(f);
  check(new RegExp(`<h1[^>]*>${name}'s room</h1>`).test(html), `${slug}: <h1> is "${name}'s room"`);
  check(html.includes(`<title>${name}&#39;s room`), `${slug}: <title> has name`);
  const nav = links(navOf(html)).filter((l) => l.href.startsWith('/rooms/'));
  check(nav.map((l) => l.href).join() === members.map(([s]) => `/rooms/${s}/`).join(), `${slug}: nav lists 7 rooms in order`);
  const current = nav.filter((l) => /aria-current="page"/.test(l.attrs));
  check(current.length === 1 && current[0].href === `/rooms/${slug}/`, `${slug}: aria-current="page" only on own link`);
  check(!/aria-current/.test(navOf(html).match(/<a href="\/"[^>]*>/)?.[0] ?? ''), `${slug}: "All rooms" link not aria-current`);
  check((html.match(/<canvas/g) ?? []).length === 1, `${slug}: exactly one <canvas>`);
  check(/<canvas[^>]*role="img"[^>]*aria-label="[^"]*\S[^"]*"/.test(html), `${slug}: canvas has role=img + aria-label`);
  check(html.includes(`aria-label="Isometric 3D view of ${name}'s room`), `${slug}: canvas aria-label names the member`);
  check(/data-astro-transition-persist="room-scene"/.test(html), `${slug}: persisted wrapper present`);
  const cfg = html.match(/data-room="([^"]+)"/)?.[1].replace(/&quot;/g, '"');
  let parsed; try { parsed = JSON.parse(cfg); } catch {}
  check(parsed?.name === name && ['leftWall', 'rightWall', 'floor', 'trim'].every((k) => /^#[0-9a-f]{6}$/i.test(parsed.colors?.[k] ?? '')), `${slug}: data-room JSON valid`);
  check(/astro-view-transitions-enabled/.test(html), `${slug}: ClientRouter enabled`);
}

// Distinct palettes
const palettes = members.map(([s]) => (read(`rooms/${s}/index.html`).match(/data-room="([^"]+)"/)?.[1] ?? ''));
check(new Set(palettes).size === 7, 'all 7 palettes are distinct');

// Unknown slug: no page generated
check(!existsSync(join(dist, 'rooms/nobody')), 'no page for unknown slug');
const roomDirs = readdirSync(join(dist, 'rooms')).sort();
check(roomDirs.join() === members.map(([s]) => s).sort().join(), `dist/rooms contains exactly the 7 members (${roomDirs.join(',')})`);

// Fonts: self-hosted @font-face + preload on every page, headings use font-heading, theme tokens wired
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const textFiles = walk(dist).filter((f) => /\.(html|css|js|mjs|json|svg|txt|xml)$/.test(f));
const google = textFiles.filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, 'utf8')));
check(google.length === 0, `no fonts.googleapis.com / fonts.gstatic.com in dist/${google.length ? ` (${google.join(', ')})` : ''}`);

const families = [['Montserrat', 'montserrat'], ['Libre Baskerville', 'libre-baskerville']];
const fontPages = ['index.html', ...members.map(([s]) => `rooms/${s}/index.html`)];
for (const f of fontPages) {
  if (!existsSync(join(dist, f))) continue;
  const html = read(f);
  const faces = [...html.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
  for (const [family, slug] of families) {
    const own = faces.filter((b) => new RegExp(`font-family:"?${family}-[0-9a-f]+"?[;}]`).test(b));
    const files = [...new Set(own.map((b) => b.match(/url\("?(\/_astro\/fonts\/[^"')]+\.woff2)"?\)/)?.[1]))];
    check(own.length > 0 && files.every((u) => u && existsSync(join(dist, u))), `${f}: @font-face for ${family} -> existing local ${files.join(',') || '(none)'}`);
    const preloads = files.filter((u) => u && new RegExp(`<link[^>]*rel="preload"[^>]*href="${u}"[^>]*as="font"`).test(html));
    check(files.length > 0 && preloads.length === files.length, `${f}: preload link for ${family} font file`);
    const faceName = own[0]?.match(/font-family:"?([^";}]+)"?/)?.[1];
    check(!!faceName && new RegExp(`--font-${slug}:\\s*"?${faceName}"?[,;}]`).test(html), `${f}: --font-${slug} starts with the @font-face family`);
  }
  check(faces.every((b) => !/url\("?https?:/.test(b)), `${f}: no remote @font-face src`);
}

const headingClass = (tag) => /class="[^"]*\bfont-heading\b[^"]*"/.test(tag) && !/tracking-tight/.test(tag);
check(headingClass(index.match(/<h1[^>]*>/)?.[0] ?? ''), 'picker <h1> has font-heading (no tracking-tight)');
const cardNames = [...index.matchAll(/<span class="([^"]*)">([A-Z][a-z]+)<\/span>/g)].filter((m) => members.some(([, n]) => n === m[2]));
check(cardNames.length === 7 && cardNames.every((m) => /\bfont-heading\b/.test(m[1])), `picker card names (${cardNames.length}) all have font-heading`);
for (const [slug] of members) {
  check(headingClass(read(`rooms/${slug}/index.html`).match(/<h1[^>]*>/)?.[0] ?? ''), `${slug}: <h1> has font-heading (no tracking-tight)`);
}

const css = readdirSync(join(dist, '_astro')).filter((f) => f.endsWith('.css')).map((f) => read(`_astro/${f}`)).join('\n');
check(/--font-heading:\s*var\(--font-libre-baskerville\)/.test(css), 'built CSS: --font-heading -> --font-libre-baskerville');
// Tailwind inlines --font-sans (@theme inline) into --default-font-family, which <html> uses
check(/--(font-sans|default-font-family):\s*var\(--font-montserrat\)/.test(css), 'built CSS: sans/default font -> --font-montserrat');
check(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*font-family:\s*var\(--font-heading\)/.test(css), 'built CSS: h1-h6 base rule uses --font-heading');
check(/html,\s*:host\s*\{[^}]*font-family:\s*var\(--default-font-family/.test(css), 'built CSS: html font-family uses --default-font-family');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
