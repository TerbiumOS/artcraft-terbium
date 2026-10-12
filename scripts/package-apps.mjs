import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(join(root, "apps.json"), "utf8"));
const selected = new Set(process.argv.slice(2).filter((arg) => arg !== "--list"));

if (process.argv.includes("--list")) {
  for (const app of config.apps) console.log(`${app.id}\t${app.repository}`);
  process.exit(0);
}

const apps = selected.size ? config.apps.filter((app) => selected.has(app.id)) : config.apps;
if (!apps.length) throw new Error("No configured apps matched the requested app IDs.");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    shell: false,
    stdio: "inherit",
    env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${command} ${args.join(" ")}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findIndexDirectory(path) {
  if (!(await exists(path))) throw new Error(`Build output directory does not exist: ${path}`);
  if (await exists(join(path, "index.html"))) return path;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(path, entry.name);
    if (await exists(join(candidate, "index.html"))) return candidate;
  }
  throw new Error(`Could not find index.html in build output: ${path}`);
}

async function packageApp(app) {
  const source = join(root, "sources", app.id);
  const appRoot = join(root, "build", `${app.id}.tapp`);
  const workingDirectory = resolve(source, app.build.workingDirectory);
  const output = resolve(workingDirectory, app.build.outputDirectory);

  if (await exists(source)) {
    if (!(await exists(join(source, ".git")))) {
      throw new Error(`${app.id}: ${source} exists but is not a Git checkout; move it aside and rerun the build`);
    }
    run("git", ["fetch", "--depth", "1", "origin", app.branch], source);
    run("git", ["reset", "--hard", "FETCH_HEAD"], source);
  } else {
    await mkdir(join(root, "sources"), { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", app.branch, app.repository, source]);
  }

  if (!Array.isArray(app.build.command) || app.build.command.length === 0) {
    throw new Error(`${app.id}: build.command must be a non-empty argument array`);
  }
  if (!(await exists(workingDirectory))) throw new Error(`${app.id}: build directory not found: ${workingDirectory}`);

  if (app.build.wasmBindgenVersionFromCargoLock) {
    const lock = await readFile(join(source, "Cargo.lock"), "utf8");
    const version = lock.match(/\[\[package\]\]\s*name = "wasm-bindgen"\s*version = "([^"]+)"/)?.[1];
    if (!version) throw new Error(`${app.id}: could not read wasm-bindgen version from Cargo.lock`);
    const cli = spawnSync("wasm-bindgen", ["--version"], { cwd: source, encoding: "utf8" });
    if (cli.error || cli.status !== 0 || !cli.stdout.includes(version)) {
      throw new Error(`${app.id}: wasm-bindgen-cli ${version} is required. Install with: cargo install wasm-bindgen-cli --version ${version} --locked`);
    }
  }

  const rustVersionFile = join(source, "rust-toolchain.toml");
  const cargoToml = await readFile(join(source, "Cargo.toml"), "utf8");
  const minimumRust = cargoToml.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
  if (minimumRust && !(await exists(rustVersionFile)) && !app.build.toolchain) {
    const compiler = spawnSync("rustc", ["--version"], { encoding: "utf8" });
    const compilerVersion = compiler.stdout?.match(/rustc (\d+\.\d+\.\d+)/)?.[1];
    const required = minimumRust.split(".").map(Number);
    const current = compilerVersion?.split(".").map(Number) ?? [];
    if (!compilerVersion || required.some((part, index) => (current[index] ?? 0) < part && current.slice(0, index).every((v, i) => v === required[i]))) {
      throw new Error(`${app.id}: upstream requires Rust ${minimumRust} or newer; current compiler is ${compilerVersion ?? "unknown"}`);
    }
  }

  const buildToolchain = app.build.toolchain ?? "1.95.0";
  const [buildCommand, ...buildArgs] = app.build.command;
  if (buildCommand === "cargo" || buildCommand === "trunk") {
    const env = { ...process.env, RUSTUP_TOOLCHAIN: buildToolchain };
    const result = spawnSync(buildCommand, buildArgs, { cwd: workingDirectory, stdio: "inherit", env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${buildCommand} ${buildArgs.join(" ")}`);
  } else {
    run(buildCommand, buildArgs, workingDirectory);
  }
  const staticOutput = await findIndexDirectory(output);
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });
  await cp(staticOutput, appRoot, { recursive: true });
  await writeFile(join(appRoot, ".tbconfig"), `${JSON.stringify({
    title: app.name,
    wmArgs: {
      title: { text: app.name, weight: 600 },
      icon: "icon.svg",
      src: `${app.id}.html`,
      size: app.window,
      single: false,
      resizable: true,
      snapable: true,
      controls: ["minimize", "maximize", "close"]
    }
  }, null, 2)}\n`);
  const builtIndex = await readFile(join(appRoot, "index.html"), "utf8");
  const appHtml = join(appRoot, `${app.id}.html`);
  const relativePath = (from, to) => relative(from, to).split(sep).join("/");
  const assetPrefix = relativePath(appRoot, staticOutput) || ".";
  const tbHtml = builtIndex
    .replace(/(["'(])\.\//g, `$1${assetPrefix}/`)
    .replace("</body>", `  <script src="./terbium-tfs.js"></script>\n  <script type="module" src="./${app.id}.js"></script>\n</body>`);
  await writeFile(appHtml, tbHtml);
  await rm(join(appRoot, "index.html"), { force: true });
  const wasmModule = app.id === "lightcraft" ? "lightcraft_web.js" : `${app.id}-web.js`;
  const bridgeScript = `const wasm = new URL(${JSON.stringify(`${assetPrefix}/${wasmModule}`)}, import.meta.url);\nimport(wasm).catch(error => { console.error("${app.name} failed to start", error); });\n`;
  await writeFile(join(appRoot, `${app.id}.js`), bridgeScript);
  await writeFile(join(appRoot, "tfs-bridge.js"), tfsBridge(app.id));
  await writeFile(join(appRoot, "terbium-tfs.js"), `(() => {\n  const script = document.createElement("script");\n  script.src = new URL("./tfs-bridge.js", document.currentScript.src).href;\n  document.head.appendChild(script);\n})();\n`);
  for (const extension of ["gz", "br"]) {
    const compressed = join(staticOutput, `index.html.${extension}`);
    if (await exists(compressed)) await cp(compressed, join(appRoot, `${app.id}.html.${extension}`));
  }
  await writeFile(join(appRoot, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#222"/><path d="M12 48 28 12l8 20 8-12 8 28H12Z" fill="#fff"/></svg>\n`);
  await mkdir(join(root, "dist"), { recursive: true });
  const archive = join(root, "dist", `${app.id}.tapp.zip`);
  await rm(archive, { force: true });
  run("tar", ["-a", "-c", "-f", archive, "-C", appRoot, ...await readdir(appRoot)]);
  console.log(`Created ${archive}`);
}

function tfsBridge(appId) {
  return `(() => {
  const APP = ${JSON.stringify(appId)};
  const ROOT = "/home/.config/artcraft-terbium/" + APP;
  const originalStorage = window.localStorage;
  const nativeStorage = {
    getItem: typeof originalStorage.getItem === "function" ? originalStorage.getItem.bind(originalStorage) : () => null,
    setItem: typeof originalStorage.setItem === "function" ? originalStorage.setItem.bind(originalStorage) : () => {},
    removeItem: typeof originalStorage.removeItem === "function" ? originalStorage.removeItem.bind(originalStorage) : () => {},
    clear: typeof originalStorage.clear === "function" ? originalStorage.clear.bind(originalStorage) : () => {},
    key: typeof originalStorage.key === "function" ? originalStorage.key.bind(originalStorage) : () => null,
    get length() { return originalStorage.length; }
  };
  const cache = new Map();
  let ready = false;
  let flushing = Promise.resolve();
  let loadPromise;

  function tfs() {
    try { return window.parent && window.parent !== window && window.parent.tb && window.parent.tb.fs && window.parent.tb.fs.promises; }
    catch { return null; }
  }

  function pathFor(key) {
    const encoded = Array.from(new TextEncoder().encode(String(key)), b => b.toString(16).padStart(2, "0")).join("");
    return ROOT + "/" + encoded + ".json";
  }

  async function ensureTfsDirectories(fs) {
    for (const dir of ["/home/.config", "/home/.config/artcraft-terbium", ROOT]) {
      try { await fs.mkdir(dir); }
      catch (error) {
        if (!await fs.stat(dir).then(stat => stat?.isDirectory?.() ?? false).catch(() => false)) throw error;
      }
    }
  }

  function persist(key, value) {
    cache.set(String(key), String(value));
    const fs = tfs();
    if (!fs || !ready) return;
    const path = pathFor(key);
    flushing = flushing.then(async () => {
      try {
        await ensureTfsDirectories(fs);
        await fs.writeFile(path, JSON.stringify({ key: String(key), value: String(value) }), "utf8");
      } catch (error) { console.warn("Terbium TFS preference save failed", error); }
    });
  }

  function remove(key) {
    cache.delete(String(key));
    const fs = tfs();
    if (!fs || !ready) return;
    flushing = flushing.then(async () => {
      try { await fs.unlink(pathFor(key)); } catch {}
    });
  }

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const fs = tfs();
      if (!fs) return;
      try {
        await ensureTfsDirectories(fs);
        const files = await fs.readdir(ROOT, { recursive: true });
        for (const entry of files) {
          const path = String(entry).startsWith(ROOT + "/") ? String(entry) : ROOT + "/" + String(entry);
          if (!path.endsWith(".json")) continue;
          try {
            const raw = await fs.readFile(path, "utf8");
            const item = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
            if (!item || typeof item.key !== "string" || typeof item.value !== "string") continue;
            storage.__restore(item.key, item.value);
          } catch (error) { console.warn("Terbium TFS preference read failed", path, error); }
        }
      } catch (error) { console.warn("Terbium TFS is unavailable; using browser storage", error); }
      ready = true;
      try {
        for (let i = 0; i < nativeStorage.length; i++) {
          const key = nativeStorage.key(i);
          if (key !== null && !cache.has(key)) {
            const value = nativeStorage.getItem(key);
            if (value !== null) cache.set(key, value);
          }
        }
        for (const [key, value] of cache) nativeStorage.setItem(key, value);
      } catch (error) { console.warn("Browser storage sync failed", error); }
      for (const [key, value] of cache) persist(key, value);
    })();
    return loadPromise;
  }

  const storage = {
    get length() { return cache.size; },
    key(index) { return Array.from(cache.keys())[index] ?? null; },
    getItem(key) {
      key = String(key);
      if (cache.has(key)) return cache.get(key);
      try { return nativeStorage.getItem(key); } catch { return null; }
    },
    setItem(key, value) {
      key = String(key); value = String(value);
      try { nativeStorage.setItem(key, value); } catch (error) { console.warn("Browser storage write failed", error); }
      persist(key, value);
    },
    removeItem(key) {
      key = String(key);
      try { nativeStorage.removeItem(key); } catch {}
      remove(key);
    },
    clear() {
      const keys = Array.from(cache.keys());
      try { nativeStorage.clear(); } catch {}
      for (const key of keys) remove(key);
    },
    restoreFromTfs(key, value) {
      key = String(key); value = String(value);
      cache.set(key, value);
      try { nativeStorage.setItem(key, value); } catch (error) { console.warn("Browser storage sync failed", error); }
    }
  };
  const proxy = new Proxy(storage, {
    get(target, property) {
      if (property === Symbol.toStringTag) return "Storage";
      if (property in target) return Reflect.get(target, property);
      if (typeof property === "string") return target.getItem(property) ?? undefined;
    },
    set(target, property, value) {
      if (typeof property === "string") target.setItem(property, value);
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property === "string") target.removeItem(property);
      return true;
    },
    defineProperty(target, property, descriptor) {
      if (typeof property === "string" && Object.prototype.hasOwnProperty.call(descriptor, "value")) target.setItem(property, descriptor.value);
      return true;
    },
    ownKeys() { return Array.from(cache.keys()); },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && cache.has(property)) return { configurable: true, enumerable: true, writable: true, value: cache.get(property) };
      return Object.getOwnPropertyDescriptor(target, property);
    }
  });

  try { Object.defineProperty(window, "localStorage", { configurable: true, value: proxy }); }
  catch (error) { console.warn("Could not install Terbium TFS storage bridge", error); }

  const onStorage = event => {
    if (event.key === null) {
      for (const [key, value] of cache) storage.restoreFromTfs(key, value);
    }
    else if (event.newValue === null) remove(event.key);
    else persist(event.key, event.newValue);
  };
  window.addEventListener("storage", onStorage);
  window.artcraftTfsStorageChange = onStorage;
  window.__artcraftTfsBridge = { onStorage };
  window.addEventListener("pagehide", () => { void flushing; });
  void load();
})();
`;
}

for (const app of apps) await packageApp(app);
