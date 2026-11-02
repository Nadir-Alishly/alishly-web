// Sentinel check for task local-folder: "a build must not read local/ even when it exists".
//
//   node tests/dist-local-sentinel.mjs [parent-dir]
//
// Makes an ISOLATED copy of the sources (src, public, dev, astro.config.mjs, package.json, tsconfig.json; node_modules is a
// symlink to this checkout's) in a fresh temp directory, so the developer's real local/ folder and a running dev server are never
// touched. The copy is built twice with `astro build`:
//   A. without a local/ folder;
//   B. with a local/ folder full of unique sentinels (a wall colour, an object id, a model id + label, a GLB payload).
// Passing means: the production output of B is byte-identical to A (so the build did not read local/ at all), none of the sentinels
// appears anywhere in dist, dist/models holds exactly the committed models, B did not create or change anything in local/, and A did
// not create a local/ folder. The temp directory is removed at the end (also on failure). `parent-dir` (optional) is where the temp
// directory is created; the default is tests/ of this checkout (.tmp-dist-sentinel-*).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.resolve(process.argv[2] ?? path.join(repo, 'tests'));
let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const walk = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
};
/** relative path -> sha256 of every file under dir */
const hashTree = async (dir) => {
  const map = {};
  for (const file of (await walk(dir)).sort()) map[path.relative(dir, file).split(path.sep).join('/')] = sha(await readFile(file));
  return map;
};

const SENTINELS = {
  wall: '#0a1b2c',
  object: 'SENTINEL_OBJ_9f3a',
  modelId: 'sentinel-chair-9f3a',
  label: 'SENTINEL_LABEL_9f3a',
  glb: 'SENTINEL_GLB_PAYLOAD_9f3a',
};

const astroBin = path.join(repo, 'node_modules', 'astro', 'bin', 'astro.mjs');
if (!existsSync(astroBin)) {
  console.log(`FAIL  cannot find ${path.relative(repo, astroBin)}; run npm install first`);
  process.exit(1);
}

const work = await mkdtemp(path.join(parent, '.tmp-dist-sentinel-'));
try {
  for (const item of ['src', 'public', 'dev', 'astro.config.mjs', 'package.json', 'tsconfig.json']) {
    if (existsSync(path.join(repo, item))) await cp(path.join(repo, item), path.join(work, item), { recursive: true });
  }
  await symlink(path.join(repo, 'node_modules'), path.join(work, 'node_modules'));

  const build = (label) => {
    const result = spawnSync(process.execPath, [astroBin, 'build'], { cwd: work, encoding: 'utf8', timeout: 5 * 60_000, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', CI: '1' } });
    check(result.status === 0, `${label}: astro build succeeds in the isolated copy${result.status === 0 ? '' : `\n${(result.stdout ?? '').slice(-1500)}\n${(result.stderr ?? '').slice(-1500)}`}`);
    return result.status === 0;
  };

  // A. no local/
  check(!existsSync(path.join(work, 'local')), 'copy: starts without a local/ folder');
  const okA = build('A (no local/)');
  check(!existsSync(path.join(work, 'local')), 'A: the build did not create a local/ folder');
  if (!okA) throw new Error('build A failed');
  const distA = await hashTree(path.join(work, 'dist'));
  await rm(path.join(work, 'dist'), { recursive: true });

  // B. local/ with sentinels
  const localScene = {
    version: 1,
    rooms: {
      elnur: {
        wallColor: SENTINELS.wall,
        objects: [{ id: SENTINELS.object, type: `model:${SENTINELS.modelId}`, position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }],
      },
    },
  };
  await mkdir(path.join(work, 'local', 'models'), { recursive: true });
  await writeFile(path.join(work, 'local', 'scene.json'), `${JSON.stringify(localScene, null, 2)}\n`);
  await writeFile(path.join(work, 'local', 'models.json'), `${JSON.stringify([{ id: SENTINELS.modelId, label: SENTINELS.label, file: `/models/${SENTINELS.modelId}.glb`, defaultScale: 1 }], null, '\t')}\n`);
  await writeFile(path.join(work, 'local', 'models', `${SENTINELS.modelId}.glb`), SENTINELS.glb);
  const localBefore = await hashTree(path.join(work, 'local'));
  const okB = build('B (local/ with sentinels)');
  if (!okB) throw new Error('build B failed');
  const distB = await hashTree(path.join(work, 'dist'));
  const localAfter = await hashTree(path.join(work, 'local'));

  check(JSON.stringify(localAfter) === JSON.stringify(localBefore), 'B: the build left local/ exactly as it was (nothing created, nothing rewritten)');
  const namesA = Object.keys(distA);
  const namesB = Object.keys(distB);
  check(JSON.stringify(namesA) === JSON.stringify(namesB), `B: dist has the same ${namesA.length} files as the build without local/`);
  const differing = namesA.filter((f) => distA[f] !== distB[f]);
  check(differing.length === 0, `B: every file of dist is byte-identical to the build without local/${differing.length ? `: ${differing.slice(0, 8).join(', ')}` : ''}`);

  // sentinels nowhere in dist (text and binary, latin1 so any encoding of the ASCII needles is seen)
  const leaks = [];
  for (const file of await walk(path.join(work, 'dist'))) {
    const text = (await readFile(file)).toString('latin1');
    for (const [name, needle] of Object.entries(SENTINELS)) if (text.toLowerCase().includes(needle.toLowerCase())) leaks.push(`${path.relative(path.join(work, 'dist'), file)} ~ ${name}`);
  }
  check(leaks.length === 0, `B: none of the ${Object.keys(SENTINELS).length} sentinels (wall colour, object id, model id, label, GLB payload) appears in dist${leaks.length ? `: ${leaks.join('; ')}` : ''}`);
  const committedGlbs = (await readdir(path.join(work, 'public', 'models'))).sort();
  const builtGlbs = (await readdir(path.join(work, 'dist', 'models'))).sort();
  check(JSON.stringify(builtGlbs) === JSON.stringify(committedGlbs), `B: dist/models has exactly the committed models (${builtGlbs.join(', ')})`);
  check(!(await walk(path.join(work, 'dist'))).some((f) => /(^|[\\/])local([\\/]|$)/.test(path.relative(path.join(work, 'dist'), f))), 'B: dist has no local/ path');
  const roomHtml = await readFile(path.join(work, 'dist', 'rooms', 'elnur', 'index.html'), 'utf8');
  check(!roomHtml.toLowerCase().includes(SENTINELS.wall), "B: elnur's room page does not use the sentinel wall colour");

  // C. negative control: the same sentinels as COMMITTED data must show up in dist, otherwise the needles above prove nothing
  await rm(path.join(work, 'dist'), { recursive: true });
  await writeFile(path.join(work, 'src', 'data', 'scene.json'), await readFile(path.join(work, 'local', 'scene.json')));
  await writeFile(path.join(work, 'src', 'data', 'models.json'), await readFile(path.join(work, 'local', 'models.json')));
  await writeFile(path.join(work, 'public', 'models', `${SENTINELS.modelId}.glb`), SENTINELS.glb);
  if (build('C (negative control: sentinels committed)')) {
    const seen = new Set();
    for (const file of await walk(path.join(work, 'dist'))) {
      const text = (await readFile(file)).toString('latin1').toLowerCase();
      for (const [name, needle] of Object.entries(SENTINELS)) if (text.includes(needle.toLowerCase())) seen.add(name);
    }
    const missing = Object.keys(SENTINELS).filter((name) => !seen.has(name));
    check(missing.length === 0, `C: committed sentinels DO reach dist, so the search can see them (missing: ${missing.join(', ') || 'none'})`);
  }

  // the repo's own local/ was never involved
  check(true, `the real checkout was not used for the sentinel data (copy in ${path.relative(repo, work) || '.'})`);
} catch (error) {
  failed++;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await rm(work, { recursive: true, force: true });
  check(!existsSync(work), 'temp directory removed');
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
