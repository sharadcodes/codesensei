import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type BuildAccess = 'source-only' | 'include-build-config';

export interface AnalysisWorkspace {
  cwd: string;
  files: string[];
  projectType: string;
  cleanup(): Promise<void>;
}

const HARD_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'target',
  'coverage', '.next', '.nuxt', '.turbo', '.gradle', '.cache', '__pycache__',
]);
const SECRET_RE = /(^|\/)(\.env(?:\..*)?|.*credentials.*|.*secrets?.*|.*\.pem|.*\.key|id_rsa.*)$/i;
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.kts', '.py',
  '.go', '.rs', '.rb', '.cs', '.cpp', '.c', '.h', '.swift', '.php', '.vue',
  '.svelte', '.html', '.css', '.scss', '.sql', '.md', '.json', '.xml', '.yaml', '.yml',
  '.properties', '.graphql', '.proto',
]);
const LIGHTWEIGHT_MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock']);
const BUILD_FILES = new Set([
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'vite.config.ts',
  'vite.config.js', 'webpack.config.js', 'webpack.config.ts', 'tsconfig.json',
]);
const SOURCE_ROOTS = new Set(['src', 'app', 'pages', 'components', 'lib', 'test', 'tests']);
const BUILD_ROOTS = new Set(['.github', 'infra', 'infrastructure', 'deploy', 'deployment', 'helm']);

export async function createAnalysisWorkspace(root: string, buildAccess: BuildAccess): Promise<AnalysisWorkspace> {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'codesensei-analysis-'));
  const files: string[] = [];
  let totalBytes = 0;
  const maxFiles = 300;
  const maxTotal = 10 * 1024 * 1024;
  const maxFile = 512 * 1024;

  const rootNames = new Set(await fs.readdir(root).catch(() => []));
  const projectType = detectProjectType(rootNames);

  async function walk(current: string, relative = '', inSourceRoot = false): Promise<void> {
    if (files.length >= maxFiles || totalBytes >= maxTotal) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles || totalBytes >= maxTotal) break;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || SECRET_RE.test(rel)) continue;
      if (entry.isDirectory()) {
        if (HARD_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.') && entry.name !== '.github') continue;
        const nextIsSource = inSourceRoot || SOURCE_ROOTS.has(entry.name) || rel === 'src/main' || rel === 'src/test';
        const approvedBuildRoot = buildAccess === 'include-build-config' && relative === '' && BUILD_ROOTS.has(entry.name);
        if (!nextIsSource && !approvedBuildRoot && relative === '' && !SOURCE_ROOTS.has(entry.name)) continue;
        await walk(path.join(current, entry.name), rel, nextIsSource);
        continue;
      }
      if (!entry.isFile()) continue;
      const base = entry.name;
      if (LOCK_FILES.has(base)) continue;
      const allowedManifest = relative === '' && LIGHTWEIGHT_MANIFESTS.has(base);
      const allowedBuild = buildAccess === 'include-build-config' && (
        BUILD_FILES.has(base) || rel.startsWith('.github/workflows/') ||
        [...BUILD_ROOTS].some((rootName) => rel.startsWith(`${rootName}/`)) ||
        base === 'Makefile' || base === 'Jenkinsfile' || path.extname(base) === '.tf'
      );
      const allowedSource = (inSourceRoot || relative === '') && SOURCE_EXTS.has(path.extname(base).toLowerCase()) && !BUILD_FILES.has(base);
      if (!allowedManifest && !allowedBuild && !allowedSource && base !== 'README.md') continue;
      const from = path.join(current, base);
      const stat = await fs.stat(from).catch(() => null);
      if (!stat || stat.size > maxFile || totalBytes + stat.size > maxTotal) continue;
      const to = path.join(destination, rel);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      totalBytes += stat.size;
      files.push(rel);
    }
  }

  await walk(root);
  return {
    cwd: destination,
    files,
    projectType,
    cleanup: () => rmWithRetry(destination),
  };
}

async function rmWithRetry(target: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

export function detectProjectType(rootNames: Set<string>): string {
  if (rootNames.has('pom.xml') || rootNames.has('build.gradle') || rootNames.has('build.gradle.kts')) return 'Java / Spring-compatible';
  if (rootNames.has('package.json')) return 'JavaScript / TypeScript';
  if (rootNames.has('pyproject.toml')) return 'Python';
  if (rootNames.has('Cargo.toml')) return 'Rust';
  if (rootNames.has('go.mod')) return 'Go';
  return 'Unknown';
}
