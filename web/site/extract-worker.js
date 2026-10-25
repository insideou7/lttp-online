// Runs zelda3's asset tool (assets/restool.py) on the player's ROM, inside
// Pyodide (Python compiled to WebAssembly), off the main thread.
// In:  { rom: Uint8Array }  (headerless US ROM)
// Out: { progress: string } messages, then { assets: Uint8Array } or { error: string }
import { loadPyodide } from './pyodide/pyodide.mjs';

const base = new URL('./', import.meta.url);

async function extract(rom) {
  postMessage({ progress: 'Starting Python…' });
  const py = await loadPyodide({ indexURL: new URL('pyodide/', base).href });
  postMessage({ progress: 'Loading image and YAML libraries…' });
  await py.loadPackage(['pillow', 'pyyaml']);

  postMessage({ progress: 'Loading the asset tool…' });
  const list = await (await fetch(new URL('restool/files.txt', base))).text();
  const files = list.split('\n').filter(Boolean);
  await Promise.all(files.map(async (f) => {
    const res = await fetch(new URL('restool/' + f, base));
    if (!res.ok) throw new Error(`Missing ${f}`);
    const data = new Uint8Array(await res.arrayBuffer());
    const path = '/zelda3/' + f;
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    py.FS.writeFile(path, data);
  }));
  py.FS.mkdirTree('/zelda3/assets/sprites');
  py.FS.writeFile('/zelda3/zelda3.sfc', rom);

  postMessage({ progress: 'Extracting game assets from your ROM (about 15–60 seconds)…' });
  // Let the progress message paint before Python blocks this worker.
  await new Promise((r) => setTimeout(r, 0));
  py.setStdout({ batched: (s) => console.log('[restool]', s) });
  py.setStderr({ batched: (s) => console.warn('[restool]', s) });
  await py.runPythonAsync(`
import sys, runpy, warnings
warnings.simplefilter('ignore')
sys.argv = ['restool.py', '--extract-from-rom']
sys.path.insert(0, '/zelda3/assets')
runpy.run_path('/zelda3/assets/restool.py', run_name='__main__')
`);
  return py.FS.readFile('/zelda3/zelda3_assets.dat');
}

onmessage = async (e) => {
  try {
    const assets = await extract(e.data.rom);
    postMessage({ assets }, [assets.buffer]);
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
  }
};
