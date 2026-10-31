// Read-only check of the built site in dist/. Run after `npm run build`: node tests/dist-check.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const members = [
  ['elnur', 'Elnur'], ['sabina', 'Sabina'], ['nadir', 'Nadir'], ['chinara', 'Chinara'],
  ['alibala', 'Alibala'], ['elkhan', 'Elkhan'], ['fazil', 'Fazil'],
];
// Wall colours from room-colors-v2.pdf (lower-case), both walls of each room.
const pdfWalls = {
  elnur: '#dff2fe', sabina: '#ede9fe', nadir: '#ecfcca', chinara: '#ffe4e6',
  alibala: '#ffedd4', elkhan: '#fef9c2', fazil: '#cbfbf1',
};
// scene.json can override a room's wall colour (scene-settings): what pages must show is the EFFECTIVE colour. The same
// source modules the build uses give the expectation: no override = the v2 PDF colour (pdfWalls, floor from family.ts);
// override = both walls the override (lower-case), floor = floorOf(override).
const sceneTs = await import(new URL('../src/data/scene.ts', import.meta.url).href);
const settingsTs = await import(new URL('../src/data/scene-settings.ts', import.meta.url).href);
const effTs = await import(new URL('../src/data/effective-colors.ts', import.meta.url).href);
const paletteTs = await import(new URL('../src/data/room-palette.ts', import.meta.url).href);
const familyTs = await import(new URL('../src/data/family.ts', import.meta.url).href);
const sceneRaw = JSON.parse(readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8'));
const modelIds = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8')).map((m) => m.id);
const sceneParsed = sceneTs.parseScene(sceneRaw, { slugs: members.map(([s]) => s), modelIds });
const overrideOf = (slug) => sceneParsed.scene.rooms[slug]?.wallColor ?? null;
const expectedColors = (slug) => {
  const o = overrideOf(slug);
  if (o) return { leftWall: o, rightWall: o, floor: paletteTs.floorOf(o) };
  return { leftWall: pdfWalls[slug], rightWall: pdfWalls[slug], floor: familyTs.family.find((m) => m.slug === slug).colors.floor };
};
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
  check(parsed?.name === name && ['leftWall', 'rightWall', 'floor'].every((k) => /^#[0-9a-f]{6}$/i.test(parsed.colors?.[k] ?? '')) && !('trim' in (parsed.colors ?? {})), `${slug}: data-room JSON valid`);
  check(/astro-view-transitions-enabled/.test(html), `${slug}: ClientRouter enabled`);
  // room-colors-v2.pdf, or the scene.json wallColor override: both walls carry the room's EFFECTIVE colour, the floor follows
  const want = expectedColors(slug);
  check(parsed?.colors?.leftWall?.toLowerCase() === want.leftWall && parsed?.colors?.rightWall?.toLowerCase() === want.rightWall, `${slug}: both walls are the effective colour ${want.leftWall}${overrideOf(slug) ? ' (scene.json wallColor override)' : ' (v2 PDF colour)'}`);
  check(parsed?.colors?.floor?.toLowerCase() === want.floor, `${slug}: floor tint is the effective ${want.floor}`);
  check(effTs.effectiveColors(familyTs.family.find((m) => m.slug === slug), sceneParsed.scene).leftWall === want.leftWall, `${slug}: effectiveColors() agrees with the expectation`);
}

// Distinct palettes
const palettes = members.map(([s]) => (read(`rooms/${s}/index.html`).match(/data-room="([^"]+)"/)?.[1] ?? ''));
check(new Set(palettes).size === 7, 'all 7 palettes are distinct');
const effPalettes = members.map(([s]) => JSON.stringify(expectedColors(s)));
check(new Set(effPalettes).size === 7, 'all 7 effective colour sets are distinct (override included)');
check(!palettes.some((p) => /trim/i.test(p)), 'no data-room JSON carries a "trim" colour');

// Texture preloads: room pages and /admin preload the 4 texture URLs (same crossorigin mode as the TextureLoader), the picker none
const texFiles = ['floor/oak-diff.jpg', 'floor/oak-rough.jpg', 'wall/stucco-detail.jpg', 'wall/stucco-normal.webp'];
const imagePreloads = (html) => [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((t) => /\brel="preload"/.test(t) && /\bas="image"/.test(t));
const preloadChecks = (label, html) => {
  const tags = imagePreloads(html);
  for (const f of texFiles) {
    const hits = tags.filter((t) => t.includes(`href="/textures/${f}"`));
    check(hits.length === 1 && /\bcrossorigin="anonymous"/.test(hits[0]), `${label}: exactly one <link rel="preload" as="image" crossorigin="anonymous"> for /textures/${f}`);
  }
  const normal = tags.find((t) => t.includes('stucco-normal.webp'));
  check(/media="not all and \(pointer: coarse\)"/.test(normal ?? ''), `${label}: the stucco normal preload is skipped on touch screens`);
  check(tags.length === 4, `${label}: no other image preloads (${tags.length})`);
};
for (const [slug] of members) preloadChecks(`${slug}`, read(`rooms/${slug}/index.html`));
preloadChecks('admin', read('admin/index.html'));
check(!/\/textures\//.test(read('index.html')), 'picker: no texture URL at all (no preload)');

// Room textures: copied from public/ into dist/
for (const f of ['floor/oak-diff.jpg', 'floor/oak-rough.jpg', 'wall/stucco-detail.jpg', 'wall/stucco-normal.webp']) {
  const p = join(dist, 'textures', f);
  check(existsSync(p) && statSync(p).size > 10_000, `dist/textures/${f} present`);
}

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

// ---------------------------------------------------------------------------------------------
// scene-admin: scene data, /admin page, headers, bundles
// ---------------------------------------------------------------------------------------------
const decodeAttr = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Every room's data-room JSON carries an `objects` array
for (const [slug] of members) {
  const html = read(`rooms/${slug}/index.html`);
  let cfg; try { cfg = JSON.parse(decodeAttr(html.match(/data-room="([^"]+)"/)?.[1] ?? '')); } catch {}
  check(Array.isArray(cfg?.objects), `${slug}: data-room JSON has an objects array`);
}

// Source scene data parses and validates (uses the same module as the build)
{
  const raw = sceneRaw;
  const modelsJson = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8'));
  const slugs = members.map(([s]) => s);
  const res = sceneTs.parseScene(raw, { slugs, modelIds: modelsJson.map((m) => m.id) });
  check(res.ok && res.warnings.length === 0, `src/data/scene.json is valid (${res.warnings.join('; ') || 'no warnings'})`);
  check(raw.version === 1 && slugs.every((s) => Array.isArray(raw.rooms?.[s]?.objects)), 'scene.json has version 1 and an objects array for all 7 rooms');
  check(Object.keys(raw.rooms ?? {}).length === 7, 'scene.json has exactly 7 rooms');
  // What the built pages embed must equal the validated scene
  const same = slugs.every((s) => {
    const html = read(`rooms/${s}/index.html`);
    try { return JSON.stringify(JSON.parse(decodeAttr(html.match(/data-room="([^"]+)"/)[1])).objects) === JSON.stringify(res.scene.rooms[s].objects); } catch { return false; }
  });
  check(same, 'data-room objects of each room equal the validated scene.json objects');
  // scene-settings: scene.json's `settings` / `wallColor` are valid and reach every page
  check(res.warnings.length === 0, 'scene.json settings and wallColor parse without warnings');
  check(!('settings' in raw) || (typeof raw.settings === 'object' && raw.settings !== null), 'scene.json `settings`, when present, is an object');
  check(Object.keys(raw).join() === (('settings' in raw) ? 'version,settings,rooms' : 'version,rooms'), `scene.json top-level key order is version${'settings' in raw ? ',settings' : ''},rooms`);
  check(sceneTs.serializeScene(res.scene) === readFileSync(new URL('../src/data/scene.json', import.meta.url), 'utf8'), 'scene.json is byte-identical to serializeScene(parseScene(scene.json)) (canonical, sparse)');
  for (const s of slugs) {
    const w = raw.rooms?.[s]?.wallColor;
    check(w === undefined || /^#[0-9a-f]{6}$/.test(w), `${s}: wallColor ${w ?? '(none)'} is a lower-case #rrggbb or absent`);
  }
  // every room page carries the SAME complete, valid settings object (the parsed scene.json settings)
  const want = res.scene.settings;
  const rangeOk = (g, k, v) => typeof v === 'number' && Number.isFinite(v) && v >= settingsTs.SETTING_RANGES[g][k].min && v <= settingsTs.SETTING_RANGES[g][k].max;
  for (const s of slugs) {
    let cfg; try { cfg = JSON.parse(decodeAttr(read(`rooms/${s}/index.html`).match(/data-room="([^"]+)"/)[1])); } catch {}
    const st = cfg?.settings;
    const complete = !!st && typeof st === 'object' && Object.keys(st).join() === settingsTs.SETTINGS_GROUPS.join()
      && settingsTs.SETTINGS_GROUPS.every((g) => Object.keys(st[g] ?? {}).join() === Object.keys(settingsTs.DEFAULT_SETTINGS[g]).join());
    check(complete, `${s}: data-room.settings has all ${settingsTs.SETTINGS_GROUPS.length} groups with every key`);
    const valid = complete && settingsTs.SETTINGS_GROUPS.every((g) => Object.entries(st[g]).every(([k, v]) =>
      typeof settingsTs.DEFAULT_SETTINGS[g][k] === 'string' ? /^#[0-9a-f]{6}$/.test(v) : rangeOk(g, k, v)));
    check(valid, `${s}: data-room.settings values are in range / valid colours`);
    check(complete && JSON.stringify(st) === JSON.stringify(want), `${s}: data-room.settings equals the settings of scene.json`);
  }
  // the picker swatches show the effective colours (left wall, right wall, floor)
  for (const s of slugs) {
    const card = index.match(new RegExp(`<a href="/rooms/${s}/"[\\s\\S]*?</a>`))?.[0] ?? '';
    const bg = [...card.matchAll(/background:(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
    const w = expectedColors(s);
    check(bg.join() === [w.leftWall, w.rightWall, w.floor].join(), `picker swatch of ${s} is ${w.leftWall}/${w.rightWall}/${w.floor} (got ${bg.join('/') || 'none'})`);
  }
  check(Array.isArray(modelsJson) && modelsJson.every((m) => m.id && m.label && m.file && typeof m.defaultScale === 'number'), 'models.json entries have id,label,file,defaultScale');
  check(modelsJson.every((m) => existsSync(join(dist, m.file))), 'every models.json file exists in dist');
}

// GLBs of the model library: every models.json entry must be a self-contained binary glTF 2.0 (0 iterations when empty)
{
  const modelsJson = JSON.parse(readFileSync(new URL('../src/data/models.json', import.meta.url), 'utf8'));
  check(!existsSync(join(dist, 'models/test-crate.glb')), 'the removed test-crate.glb is not in dist');
  for (const m of modelsJson) {
    const path = join(dist, m.file);
    const glb = existsSync(path) ? readFileSync(path) : null;
    check(!!glb, `dist${m.file} exists (model ${m.id})`);
    check(!!glb && glb.subarray(0, 4).toString('latin1') === 'glTF', `${m.id}: starts with magic "glTF"`);
    check(!!glb && glb.readUInt32LE(4) === 2, `${m.id}: glTF version 2`);
    check(!!glb && glb.readUInt32LE(8) === glb.length, `${m.id}: header length equals file size`);
    check(m.file === `/models/${m.id}.glb`, `${m.id}: file path is /models/<id>.glb`);
    check(!!glb && glb.length <= 10 * 1024 * 1024, `${m.id}: at most 10 MB`);
  }
}

// No public bundle may contain the admin-only model registry / editor code. The files each public page loads are collected
// from its <script src> / modulepreload URLs and followed through their static imports (shared chunks like room-core).
{
  const ADMIN_ONLY = ['no visible geometry', 'parseAsync', 'registerModel', 'inspectModel', 'TransformControls', 'git/blobs'];
  const pages = ['index.html', ...readdirSync(join(dist, 'rooms')).map((r) => `rooms/${r}/index.html`)];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(join(dist, file))) return;
    seen.add(file);
    for (const m of read(file).matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(`_astro/${m[1]}`);
  };
  for (const page of pages) {
    for (const m of read(page).matchAll(/\/_astro\/([^"'\s]+\.js)/g)) visit(`_astro/${m[1]}`);
  }
  check(seen.size >= 3, `public bundle walk found ${seen.size} JS files from ${pages.length} pages (expects the picker script, the room script and the shared room-core chunk)`);
  check([...seen].some((f) => /room-core/.test(f)), 'public bundle walk reaches the shared room-core chunk');
  for (const f of seen) {
    const src = read(f);
    const found = ADMIN_ONLY.filter((str) => src.includes(str));
    check(found.length === 0, `public bundle ${f} has no admin-only code${found.length ? ` (found: ${found.join(', ')})` : ''}`);
  }
  // control: the strings are real, i.e. they DO exist in the admin bundle graph (so the check above cannot pass by accident)
  const adminSeen = new Set();
  const visitAdmin = (file) => {
    if (adminSeen.has(file) || !existsSync(join(dist, file))) return;
    adminSeen.add(file);
    for (const m of read(file).matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visitAdmin(`_astro/${m[1]}`);
  };
  for (const m of read('admin/index.html').matchAll(/\/_astro\/([^"'\s]+\.js)/g)) visitAdmin(`_astro/${m[1]}`);
  const adminSrc = [...adminSeen].map(read).join('\n');
  check(adminSrc.includes('no visible geometry') && adminSrc.includes('parseAsync'), 'control: the admin bundle graph does contain the model registry strings');
  check([...adminSeen].some((f) => !seen.has(f)), 'control: the admin loads scripts the public pages do not');
}

// /admin page
const adminOk = existsSync(join(dist, 'admin/index.html'));
check(adminOk, 'dist/admin/index.html exists');
if (adminOk) {
  const admin = read('admin/index.html');
  const metas = [...admin.matchAll(/<meta\b[^>]*>/g)].map((m) => m[0]);
  const robots = metas.find((m) => /name="robots"/.test(m)) ?? '';
  check(/content="[^"]*noindex/.test(robots), 'admin: meta robots noindex');
  const csp = decodeAttr(metas.find((m) => /http-equiv="Content-Security-Policy"/i.test(m))?.match(/content="([^"]*)"/)?.[1] ?? '');
  const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '';
  check(!!csp, 'admin: CSP meta tag present');
  check(/https:\/\/api\.github\.com(\s|$)/.test(directive('connect-src')), 'admin: CSP connect-src includes https://api.github.com');
  check(/'self'/.test(directive('connect-src')) && !/\*/.test(directive('connect-src')), "admin: CSP connect-src has 'self' and no wildcard");
  check(!!directive('script-src') && !/'unsafe-inline'|'unsafe-eval'/.test(directive('script-src')), "admin: CSP script-src has no 'unsafe-inline' / 'unsafe-eval'");
  check(!/'unsafe-eval'/.test(csp), "admin: CSP has no 'unsafe-eval' anywhere");
  check(/default-src 'self'/.test(csp), "admin: CSP default-src 'self'");
  check(/object-src 'none'/.test(csp) && /base-uri/.test(csp), 'admin: CSP object-src none + base-uri set');
  const hosts = [...csp.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]);
  check(hosts.every((h) => h === 'https://api.github.com'), `admin: CSP names no remote host except api.github.com (${hosts.join(',') || 'none'})`);
  // scripts: all external, no inline bodies, no inline handlers
  const scripts = [...admin.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  check(scripts.length >= 1, 'admin: has at least one <script>');
  check(scripts.every((m) => /\bsrc="/.test(m[1]) && m[2].trim() === ''), 'admin: every <script> is external with an empty body (no inline script)');
  check(!/\son[a-z]+\s*=\s*["']/i.test(admin.replace(/<script[\s\S]*?<\/script>/g, '')), 'admin: no inline on*= event handlers');
  check(!/javascript:/i.test(admin), 'admin: no javascript: URLs');
  check(scripts.every((m) => /src="\/_astro\//.test(m[1])), 'admin: scripts are served from /_astro/ (same origin)');
  check(!/astro-view-transitions-enabled|ClientRouter|data-astro-transition/.test(admin), 'admin: no ClientRouter / view transitions');
  check(!/<script[^>]+src="[^"]*ClientRouter/.test(admin), 'admin: does not load the ClientRouter script');
  check(/<title>[^<]*<\/title>/.test(admin), 'admin: has a <title>');
  check((admin.match(/<canvas/g) ?? []).length === 1, 'admin: exactly one <canvas>');
  check(/type="password"[^>]*id="gh-token"|id="gh-token"[^>]*type="password"/.test(admin), 'admin: token input is type=password');
  check(!/<(link|script|img|iframe)[^>]+(?:src|href)="https?:\/\//i.test(admin), 'admin: loads no remote resources');
  const tokenInput = admin.match(/<input\b[^>]*\bid="gh-token"[^>]*>/)?.[0] ?? '';
  check(/autocomplete="new-password"/.test(tokenInput), 'admin: token input has autocomplete="new-password"');
  check(!/\bvalue=/.test(tokenInput), 'admin: token input has no pre-filled value');
  check(!/(?:github_pat_|ghp_)[A-Za-z0-9_]{6,}/.test(admin), 'admin: no token-looking string in page');
  // admin script bundle: editor code lives here
  const adminJs = scripts.map((m) => m[1].match(/src="([^"]+)"/)?.[1]).filter(Boolean);
  const bundle = adminJs.map((u) => readFileSync(join(dist, u), 'utf8')).join('\n');
  check(/api\.github\.com/.test(bundle), 'admin bundle talks to api.github.com');
  check(/TransformControls/.test(bundle), 'admin bundle includes TransformControls');
  check(['Scene settings', 'Floor texture', 'Window glow', 'Advanced shadows', 'Reset to defaults'].every((t) => bundle.includes(t) || admin.includes(t)), 'admin: the settings panel schema (group titles, Reset to defaults) is in the admin page/bundle');
  for (const id of ['settings-panel', 'room-wall-color', 'room-wall-reset']) check(new RegExp(`id="${id}"`).test(admin), `admin: has #${id}`);
  check(/<input[^>]*id="room-wall-color"[^>]*type="color"|<input[^>]*type="color"[^>]*id="room-wall-color"/.test(admin), 'admin: wall colour input is type=color');
  check(!/<script[^>]*>[^<]*Floor texture/.test(admin), 'admin: schema text is not inlined into the page');
}

// Public pages: no admin link, no editor/GitHub code in any JS they can load
const publicPages = ['index.html', ...members.map(([s]) => `rooms/${s}/index.html`)];
for (const f of publicPages) {
  const html = read(f);
  const hrefs = [...html.matchAll(/\b(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]);
  check(!hrefs.some((h) => /^\/admin(\/|$|\?|#)/.test(h) || /\/admin\/?(\?|#|$)/.test(h)), `${f}: no link to /admin`);
  check(!/<a\b[^>]*>[^<]*admin/i.test(html), `${f}: no link text mentioning admin`);
}
// Transitive closure of JS (static + dynamic imports) reachable from public pages
const reach = new Set();
const queue = [];
const enqueue = (u) => { const p = u.replace(/^\//, ''); if (!reach.has(p) && existsSync(join(dist, p))) { reach.add(p); queue.push(p); } };
for (const f of publicPages) {
  for (const m of read(f).matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/_astro\/[^"]+\.js)"/g)) enqueue(m[1]);
}
while (queue.length) {
  const p = queue.pop();
  const src = read(p);
  for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["'`]\.\/([^"'`]+\.js)["'`]/g)) enqueue('/_astro/' + m[1]);
}
const reachFiles = [...reach];
check(reachFiles.length > 0, `public pages reach JS files (${reachFiles.length})`);
check(!reachFiles.some((p) => /TransformControls/.test(read(p))), 'no "TransformControls" in any JS reachable from public pages');
check(!reachFiles.some((p) => /api\.github\.com/.test(read(p))), 'no "api.github.com" in any JS reachable from public pages');
check(!reachFiles.some((p) => /alishly-admin-token/.test(read(p))), 'no admin token storage key in any JS reachable from public pages');
check(!reachFiles.some((p) => /index\.astro_astro_type_script/.test(p)), 'admin entry chunk is not reachable from public pages');
// scene-settings: the admin-only panel schema (labels, hints, grouping) must not ship to the public
for (const marker of ['Floor texture', 'Advanced shadows', 'Reset to defaults', 'Shadow bias fixes speckles', "Exposure doesn't dim", 'Bump strength', 'Scene settings', 'setting-floor']) {
  check(!reachFiles.some((p) => read(p).includes(marker)), `no admin settings-panel text "${marker}" in any JS reachable from public pages`);
  check(publicPages.every((f) => !read(f).includes(marker)), `no "${marker}" in the HTML of public pages`);
}
check(!reachFiles.some((p) => /room-wall-color|settings-panel/.test(read(p))), 'no settings-panel / room-wall-color element ids in public JS');
// Inline module scripts on public pages must not contain admin/GitHub code either
check(publicPages.every((f) => ![...read(f).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].some((m) => /TransformControls|api\.github\.com/.test(m[1]))), 'no editor/GitHub code in inline scripts of public pages');
// Picker still loads no three.js (only the ClientRouter chunk)
{
  const pickerJs = [...index.matchAll(/<script\b[^>]*\bsrc="(\/_astro\/[^"]+)"/g)].map((m) => m[1]);
  check(pickerJs.length > 0 && pickerJs.every((u) => /ClientRouter/.test(u)), `picker loads only the ClientRouter script (${pickerJs.map((u) => u.split('/').pop()).join(',')})`);
  check(!/room-core|GLTFLoader|three/i.test(index.match(/<head[\s\S]*<\/head>/)?.[0] ?? ''), 'picker <head> references no three.js / room-core chunk');
}

// _headers
{
  const ok = existsSync(join(dist, '_headers'));
  check(ok, 'dist/_headers exists');
  const h = ok ? read('_headers') : '';
  // split into blocks keyed by path rule (lines starting without indentation)
  const blocks = {}; let cur = null;
  for (const line of h.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^\S/.test(line)) { cur = line.trim(); blocks[cur] = []; } else if (cur) blocks[cur].push(line.trim());
  }
  const adminRules = Object.entries(blocks).filter(([k]) => /^\/admin/.test(k));
  check(adminRules.length > 0, `_headers has /admin rule(s) (${adminRules.map(([k]) => k).join(', ')})`);
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.some((x) => /^X-Robots-Tag:\s*.*noindex/i.test(x))), '_headers /admin: X-Robots-Tag noindex');
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.some((x) => /^Referrer-Policy:\s*no-referrer\s*$/i.test(x))), '_headers /admin: Referrer-Policy no-referrer');
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.some((x) => /^X-Frame-Options:\s*DENY/i.test(x) || /^Content-Security-Policy:.*frame-ancestors 'none'/i.test(x))), '_headers /admin: X-Frame-Options DENY or frame-ancestors none');
  check(adminRules.length > 0 && adminRules.every(([, v]) => { const c = v.find((x) => /^Content-Security-Policy:/i.test(x)) ?? ''; return /connect-src[^;]*https:\/\/api\.github\.com/.test(c) && !/script-src[^;]*'unsafe-inline'/.test(c); }), "_headers /admin: CSP allows api.github.com and no script 'unsafe-inline'");
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.some((x) => /^Permissions-Policy:.*camera=\(\)/i.test(x) && /microphone=\(\)/.test(x) && /geolocation=\(\)/.test(x))), '_headers /admin: Permissions-Policy disables camera, microphone, geolocation');
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.some((x) => /^Cross-Origin-Opener-Policy:\s*same-origin\s*$/i.test(x))), '_headers /admin: Cross-Origin-Opener-Policy same-origin');
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.some((x) => /^X-Content-Type-Options:\s*nosniff/i.test(x)) && v.some((x) => /^Cache-Control:.*no-store/i.test(x))), '_headers /admin: nosniff + Cache-Control no-store');
  check(adminRules.length > 0 && adminRules.every(([, v]) => v.filter((x) => /^Content-Security-Policy:/i.test(x)).length === 1), '_headers /admin: exactly one CSP header per rule');
  check(Object.keys(blocks).some((k) => /^\/admin\/\*$/.test(k)), '_headers covers /admin/*');
  check(Object.keys(blocks).some((k) => /^\/admin\/?$/.test(k)), '_headers covers /admin itself');
  check(!Object.keys(blocks).some((k) => k === '/*' || k === '/' || k === '/rooms/*') || !blocks['/*']?.some((x) => /X-Robots-Tag|X-Frame-Options/i.test(x)), '_headers: public routes do not get the admin-only headers');
}

// robots.txt
{
  const ok = existsSync(join(dist, 'robots.txt'));
  check(ok, 'dist/robots.txt exists');
  const r = ok ? read('robots.txt') : '';
  check(/^User-agent:\s*\*\s*$/mi.test(r) && /^Disallow:\s*\/admin\/?\s*$/mi.test(r), 'robots.txt disallows /admin for all agents');
  check(!/^Disallow:\s*\/\s*$/mi.test(r), 'robots.txt does not disallow the whole site');
}

// No token-looking strings anywhere in dist (text and binary-as-latin1)
{
  const bad = walk(dist).filter((f) => /github_pat_|ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|ghs_[A-Za-z0-9]/.test(readFileSync(f, 'latin1')));
  check(bad.length === 0, `no "github_pat_" / "ghp_" token strings in dist${bad.length ? ` (${bad.join(', ')})` : ''}`);
}
// Plan: unknown-slug / admin must not leak into the page set
check(readdirSync(join(dist, 'rooms')).length === 7, 'dist/rooms still has exactly 7 entries (admin is not under rooms)');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
