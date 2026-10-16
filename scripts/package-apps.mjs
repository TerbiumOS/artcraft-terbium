import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const adapterPath = join(root, "scripts", "tfsbridge-adapter.js");
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

function gitOutput(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git command failed: git ${args.join(" ")} (${result.stderr?.trim() || result.status})`);
  return result.stdout.trim();
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
  if (!(await exists(adapterPath))) throw new Error(`TFS bridge adapter is missing: ${adapterPath}`);
  const source = join(root, "sources", app.id);
  const appRoot = join(root, "build", `${app.id}.tapp`);
  const workingDirectory = resolve(source, app.build.workingDirectory);
  const output = resolve(workingDirectory, app.build.outputDirectory);
  const buildStateDir = join(root, ".build-state");
  const buildStamp = join(buildStateDir, `${app.id}.upstream-commit`);

  let upstreamChanged = true;
  let upstreamHead = null;
  if (await exists(source)) {
    if (!(await exists(join(source, ".git")))) {
      throw new Error(`${app.id}: ${source} exists but is not a Git checkout; move it aside and rerun the build`);
    }
    const previousHead = gitOutput(["rev-parse", "HEAD"], source);
    run("git", ["fetch", "--depth", "1", "origin", app.branch], source);
    const fetchedHead = gitOutput(["rev-parse", "FETCH_HEAD"], source);
    upstreamHead = fetchedHead;
    const commitChanged = previousHead !== fetchedHead;
    if (commitChanged) {
      run("git", ["reset", "--hard", "FETCH_HEAD"], source);
      console.log(`${app.id}: upstream commit changed ${previousHead.slice(0, 12)} -> ${fetchedHead.slice(0, 12)}`);
    } else {
      console.log(`${app.id}: upstream commit unchanged at ${fetchedHead.slice(0, 12)}`);
    }
    upstreamChanged = commitChanged;
  } else {
    await mkdir(join(root, "sources"), { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", app.branch, app.repository, source]);
    upstreamChanged = true;
  }

  if (!Array.isArray(app.build.command) || app.build.command.length === 0) {
    throw new Error(`${app.id}: build.command must be a non-empty argument array`);
  }
  if (!(await exists(workingDirectory))) throw new Error(`${app.id}: build directory not found: ${workingDirectory}`);

  // Build against the upstream source only when its commit differs from the
  // commit recorded for the existing build. Otherwise reuse static output.
  const packagedHead = await exists(buildStamp) ? (await readFile(buildStamp, "utf8")).trim() : null;
  const buildOutOfDate = upstreamChanged || (packagedHead !== null && packagedHead !== upstreamHead);
  const forceBuild = process.env.FORCE_APP_BUILD === "1";
  const outputExists = await exists(output);
  const runBuild = buildOutOfDate || forceBuild || !outputExists;
  if (buildOutOfDate) {
    console.log(`${app.id}: WASM build is out of date (packaged ${packagedHead?.slice(0, 12) ?? "unrecorded"}, upstream ${upstreamHead?.slice(0, 12) ?? "unknown"}); rebuilding`);
  } else if (!outputExists) {
    console.log(`${app.id}: no existing WASM build output; building upstream ${upstreamHead?.slice(0, 12) ?? "unknown"}`);
  } else if (runBuild) {
    console.log(`${app.id}: forced rebuild requested`);
  } else {
    console.log(`${app.id}: WASM build matches upstream commit ${upstreamHead.slice(0, 12)}; reusing existing build`);
  }

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

  if (runBuild) {
    console.log(`${app.id}: building upstream at ${upstreamHead?.slice(0, 12) ?? "unknown"}`);
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
  }
  const staticOutput = await findIndexDirectory(output);
  if (upstreamHead && runBuild) {
    await mkdir(buildStateDir, { recursive: true });
    await writeFile(buildStamp, `${upstreamHead}\n`);
  }
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
  const adapterScript = await readFile(adapterPath, "utf8");
  const initializedAdapter = adapterScript.replace(
    'const APP = window.__ARTCRAFT_APP__ || "vectorcraft";',
    `const APP = ${JSON.stringify(app.id)};`,
  );
  const appHtml = join(appRoot, `${app.id}.html`);
  const tbHtml = builtIndex.replace("<head>", `<head>\n    <script>window.__ARTCRAFT_APP__ = ${JSON.stringify(app.id)};</script>\n    <script src="./terbium-tfs.js"></script>`);
  await writeFile(appHtml, tbHtml);
  await rm(join(appRoot, "index.html"), { force: true });
  await writeFile(join(appRoot, "terbium-tfs.js"), initializedAdapter);
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

function bridge() {
return ``
}

for (const app of apps) await packageApp(app);
