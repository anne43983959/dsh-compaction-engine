import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Modules the engine must borrow from the DSH installation that hosts it.
// They are never bundled with the plugin and must never be resolved from a
// hardcoded version path: the same plugin source is installed into different
// DSH versions and homes.
const RUNTIME = '@deepseek-ai/dsh';
const BASIC = '@deepseek-ai/dsh-compaction-basic';
const TOOLS = '@deepseek-ai/dsh-tools';
const LLM = '@deepseek-ai/dsh-llm';

export const HOST_MODULE_NAMES = Object.freeze({ RUNTIME, BASIC, TOOLS, LLM });

function packageVersion(file) {
  let directory = path.dirname(file);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
      } catch {
        // ignore malformed manifests and keep walking
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function hasDshBin(root) {
  return fs.existsSync(path.join(root, 'node_modules', RUNTIME, 'lib', 'bin.js'));
}

function compareVersions(a, b) {
  return new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare(a, b);
}

function installedVersionRoots(launcher) {
  const versionsDirectory = path.join(launcher, 'versions');
  let entries;
  try {
    entries = fs.readdirSync(versionsDirectory);
  } catch {
    return [];
  }
  return entries
    .map((name) => path.join(versionsDirectory, name))
    .filter(hasDshBin)
    .sort((left, right) => compareVersions(path.basename(right), path.basename(left)));
}

function rootFromExecutable(executable) {
  let current;
  try {
    current = path.dirname(fs.realpathSync(executable));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 14; depth += 1) {
    if (path.basename(path.dirname(current)) === 'versions') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function rootFromHome(home, launcher) {
  const series = path.basename(home).split('-')[0];
  if (series.length === 0) return null;
  const candidates = installedVersionRoots(launcher).filter((root) => {
    const name = path.basename(root);
    return name === series || name.startsWith(series + '-');
  });
  return candidates.length > 0 ? candidates[0] : null;
}

function resolveFromRoot(root) {
  const bin = path.join(root, 'node_modules', RUNTIME, 'lib', 'bin.js');
  if (!fs.existsSync(bin)) return null;
  const require = createRequire(fs.realpathSync(bin));
  const basicPath = require.resolve(BASIC);
  const toolsPath = require.resolve(TOOLS);
  const llmPath = require.resolve(LLM);
  const runtimeManifest = path.resolve(fs.realpathSync(bin), '..', '..', 'package.json');
  let runtimeVersion = null;
  try {
    runtimeVersion = JSON.parse(fs.readFileSync(runtimeManifest, 'utf8')).version ?? null;
  } catch {
    runtimeVersion = null;
  }
  return {
    source: 'host',
    versionRoot: root,
    runtimeVersion,
    basicVersion: packageVersion(basicPath),
    toolsVersion: packageVersion(toolsPath),
    llmVersion: packageVersion(llmPath),
    basicUrl: pathToFileURL(basicPath).href,
    toolsUrl: pathToFileURL(toolsPath).href,
    llmUrl: pathToFileURL(llmPath).href,
  };
}

function pluginLauncherDirectory() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.dirname(path.dirname(here));
}

/**
 * Resolve the compaction base + tool-definition helpers from the DSH
 * installation that is running this plugin.
 *
 * Order:
 * 1. DSH_COMPACTION_BASIC_URL + DSH_TOOLS_URL (tests / emergency override)
 * 2. the running dsh binary from process.argv[1]
 * 3. the DSH home in DSH_HOME, matched by its version series
 * 4. the newest installed DSH under <launcher>/versions (tests only)
 *
 * @param {{ argv1?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ source: string, versionRoot: string | null, runtimeVersion: string | null,
 *   basicVersion: string | null, toolsVersion: string | null, basicUrl: string, toolsUrl: string }}
 */
export function resolveHostModules(options = {}) {
  const env = options.env ?? process.env;
  const argv1 = options.argv1 ?? process.argv[1];
  const basicOverride = typeof env.DSH_COMPACTION_BASIC_URL === 'string' && env.DSH_COMPACTION_BASIC_URL.length > 0
    ? env.DSH_COMPACTION_BASIC_URL
    : null;
  const toolsOverride = typeof env.DSH_TOOLS_URL === 'string' && env.DSH_TOOLS_URL.length > 0
    ? env.DSH_TOOLS_URL
    : null;
  const llmOverride = typeof env.DSH_LLM_URL === 'string' && env.DSH_LLM_URL.length > 0
    ? env.DSH_LLM_URL
    : null;
  if (basicOverride !== null && toolsOverride !== null) {
    let llmUrl = llmOverride;
    if (llmUrl === null) {
      try {
        const require = createRequire(fileURLToPath(basicOverride));
        llmUrl = pathToFileURL(require.resolve(LLM)).href;
      } catch (error) {
        throw new Error('dsh-compaction-engine: cannot resolve ' + LLM + ' for the env override: ' + (error && error.message ? error.message : String(error)));
      }
    }
    return {
      source: 'env',
      versionRoot: null,
      runtimeVersion: null,
      basicVersion: null,
      toolsVersion: null,
      llmVersion: null,
      basicUrl: basicOverride,
      toolsUrl: toolsOverride,
      llmUrl,
    };
  }

  const launcher = pluginLauncherDirectory();
  const roots = [];
  const fromExecutable = typeof argv1 === 'string' ? rootFromExecutable(argv1) : null;
  if (fromExecutable !== null) roots.push(fromExecutable);
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) {
    const fromHome = rootFromHome(env.DSH_HOME, launcher);
    if (fromHome !== null) roots.push(fromHome);
  }
  for (const root of installedVersionRoots(launcher)) roots.push(root);
  const unique = [...new Set(roots)];

  const failures = [];
  for (const root of unique) {
    try {
      const resolved = resolveFromRoot(root);
      if (resolved === null) {
        failures.push(root + ': missing ' + RUNTIME + '/lib/bin.js');
        continue;
      }
      if (basicOverride !== null) resolved.basicUrl = basicOverride;
      if (toolsOverride !== null) resolved.toolsUrl = toolsOverride;
      if (llmOverride !== null) resolved.llmUrl = llmOverride;
      return resolved;
    } catch (error) {
      failures.push(root + ': ' + (error && error.message ? error.message : String(error)));
    }
  }

  throw new Error(
    'dsh-compaction-engine: cannot resolve host modules (' + BASIC + ', ' + TOOLS + ', ' + LLM + '). ' +
    'Set DSH_COMPACTION_BASIC_URL, DSH_TOOLS_URL and DSH_LLM_URL, or load the plugin inside a DSH installation. ' +
    'Tried: ' + (unique.length === 0 ? '(none)' : unique.join(' | ')) +
    (failures.length === 0 ? '' : '; failures: ' + failures.join(' | ')),
  );
}

export { BASIC as BASIC_MODULE, TOOLS as TOOLS_MODULE, LLM as LLM_MODULE, RUNTIME as RUNTIME_MODULE };
