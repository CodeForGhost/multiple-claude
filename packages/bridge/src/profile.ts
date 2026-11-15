// Zero-config project profiling: detect stack, test/dev commands, API spec and git info.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './proc.js';

export interface Profile {
  name: string;
  stacks: string[];
  frameworks: string[];
  packageManager?: string;
  testCommand?: string;
  devCommand?: string;
  devPort?: number;
  apiSpec?: string;
  hasClaudeMd: boolean;
  git: { isRepo: boolean; remote?: string; branch?: string };
  /** One-paragraph AI summary of the project's API surface (optional). */
  summary?: string;
  detectedAt: string;
}

const exists = (p: string) => fs.existsSync(p);
const readText = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const readJsonSafe = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return undefined; } };

const NODE_FRAMEWORKS: Record<string, [string, number]> = {
  next: ['Next.js', 3000],
  '@nestjs/core': ['NestJS', 3000],
  express: ['Express', 3000],
  fastify: ['Fastify', 3000],
  hono: ['Hono', 3000],
  koa: ['Koa', 3000],
  '@remix-run/node': ['Remix', 3000],
  nuxt: ['Nuxt', 3000],
  '@adonisjs/core': ['AdonisJS', 3333],
  'react-native': ['React Native', 8081],
  expo: ['Expo', 8081],
  vite: ['Vite', 5173],
};

export async function detectProfile(dir: string): Promise<Profile> {
  const p: Profile = {
    name: path.basename(dir),
    stacks: [],
    frameworks: [],
    hasClaudeMd: exists(path.join(dir, 'CLAUDE.md')) || exists(path.join(dir, '.claude', 'CLAUDE.md')),
    git: { isRepo: false },
    detectedAt: new Date().toISOString(),
  };

  // --- Node / JS / TS ---
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  if (pkg) {
    p.stacks.push(exists(path.join(dir, 'tsconfig.json')) ? 'typescript' : 'node');
    if (pkg.name) p.name = String(pkg.name).replace(/^@[^/]+\//, '');
    p.packageManager =
      exists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm'
      : exists(path.join(dir, 'yarn.lock')) ? 'yarn'
      : exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock')) ? 'bun'
      : 'npm';
    const pm = p.packageManager;
    const scripts = pkg.scripts || {};
    if (scripts.test && !/no test specified/.test(scripts.test)) p.testCommand = `${pm} test`;
    const devScript = ['dev', 'start:dev', 'start', 'serve'].find((s) => scripts[s]);
    if (devScript) p.devCommand = devScript === 'start' ? `${pm} start` : `${pm} run ${devScript}`;
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [dep, [fw, port]] of Object.entries(NODE_FRAMEWORKS)) {
      if (deps[dep]) {
        p.frameworks.push(fw);
        p.devPort ??= port;
      }
    }
    const portInScript = String(scripts[devScript || ''] || '').match(/(?:--port|-p|PORT=)\s*=?\s*(\d{2,5})/);
    if (portInScript) p.devPort = Number(portInScript[1]);
  }

  // --- Python ---
  const pyproject = readText(path.join(dir, 'pyproject.toml'));
  const requirements = readText(path.join(dir, 'requirements.txt'));
  if (pyproject || requirements || exists(path.join(dir, 'manage.py'))) {
    p.stacks.push('python');
    const py = (pyproject + requirements).toLowerCase();
    if (exists(path.join(dir, 'manage.py')) || py.includes('django')) {
      p.frameworks.push('Django');
      p.testCommand ??= 'python manage.py test';
      p.devCommand ??= 'python manage.py runserver';
      p.devPort ??= 8000;
    }
    if (py.includes('fastapi')) { p.frameworks.push('FastAPI'); p.devPort ??= 8000; }
    if (py.includes('flask')) { p.frameworks.push('Flask'); p.devPort ??= 5000; }
    if (py.includes('pytest') || exists(path.join(dir, 'pytest.ini')) || exists(path.join(dir, 'tests'))) {
      p.testCommand ??= 'pytest -q';
    }
    const m = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
    if (m && !pkg) p.name = m[1];
  }

  // --- Go ---
  const gomod = readText(path.join(dir, 'go.mod'));
  if (gomod) {
    p.stacks.push('go');
    p.testCommand ??= 'go test ./...';
    p.devCommand ??= 'go run .';
    for (const [needle, fw] of [['gin-gonic/gin', 'Gin'], ['labstack/echo', 'Echo'], ['gofiber/fiber', 'Fiber'], ['go-chi/chi', 'chi']]) {
      if (gomod.includes(needle)) p.frameworks.push(fw);
    }
    p.devPort ??= gomod.includes('gofiber') ? 3000 : 8080;
    const m = gomod.match(/^module\s+(\S+)/m);
    if (m && !pkg) p.name = m[1].split('/').pop() || p.name;
  }

  // --- Rust ---
  const cargo = readText(path.join(dir, 'Cargo.toml'));
  if (cargo) {
    p.stacks.push('rust');
    p.testCommand ??= 'cargo test';
    p.devCommand ??= 'cargo run';
    for (const [needle, fw] of [['axum', 'Axum'], ['actix-web', 'Actix'], ['rocket', 'Rocket']]) {
      if (cargo.includes(needle)) { p.frameworks.push(fw); p.devPort ??= 8080; }
    }
  }

  // --- JVM ---
  if (exists(path.join(dir, 'pom.xml'))) {
    p.stacks.push('java');
    p.testCommand ??= process.platform === 'win32' && exists(path.join(dir, 'mvnw.cmd')) ? 'mvnw.cmd test'
      : exists(path.join(dir, 'mvnw')) ? './mvnw test' : 'mvn test';
    if (readText(path.join(dir, 'pom.xml')).includes('spring-boot')) { p.frameworks.push('Spring Boot'); p.devPort ??= 8080; }
  } else if (exists(path.join(dir, 'build.gradle')) || exists(path.join(dir, 'build.gradle.kts'))) {
    p.stacks.push('jvm');
    p.testCommand ??= process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test';
    p.devPort ??= 8080;
  }

  // --- .NET ---
  try {
    if (fs.readdirSync(dir).some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) {
      p.stacks.push('dotnet');
      p.testCommand ??= 'dotnet test';
      p.devCommand ??= 'dotnet run';
      p.devPort ??= 5000;
    }
  } catch { /* unreadable */ }

  // --- PHP / Ruby ---
  const composer = readJsonSafe(path.join(dir, 'composer.json'));
  if (composer) {
    p.stacks.push('php');
    if (composer.require?.['laravel/framework']) { p.frameworks.push('Laravel'); p.devPort ??= 8000; p.devCommand ??= 'php artisan serve'; }
    p.testCommand ??= composer.scripts?.test ? 'composer test' : 'vendor/bin/phpunit';
  }
  const gemfile = readText(path.join(dir, 'Gemfile'));
  if (gemfile) {
    p.stacks.push('ruby');
    if (gemfile.includes('rails')) { p.frameworks.push('Rails'); p.devPort ??= 3000; p.devCommand ??= 'bin/rails server'; }
    p.testCommand ??= gemfile.includes('rspec') ? 'bundle exec rspec' : 'bin/rails test';
  }

  // --- Port hint from .env ---
  const env = readText(path.join(dir, '.env')) + readText(path.join(dir, '.env.example'));
  const envPort = env.match(/^PORT\s*=\s*(\d{2,5})/m);
  if (envPort) p.devPort = Number(envPort[1]);

  p.apiSpec = findApiSpec(dir);
  p.frameworks = [...new Set(p.frameworks)];
  p.stacks = [...new Set(p.stacks)];

  // --- git ---
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    p.git.isRepo = true;
    const remote = await git(dir, ['remote', 'get-url', 'origin']);
    if (remote.code === 0) p.git.remote = remote.stdout.trim();
    const br = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (br.code === 0) p.git.branch = br.stdout.trim();
  }
  return p;
}

const SPEC_NAMES = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json'];
const SPEC_DIRS = ['', 'docs', 'api', 'spec', 'specs', 'openapi', 'src', 'public'];

function findApiSpec(dir: string): string | undefined {
  for (const d of SPEC_DIRS) {
    for (const n of SPEC_NAMES) {
      const rel = path.join(d, n);
      if (exists(path.join(dir, rel))) return rel.replace(/\\/g, '/');
    }
  }
  return undefined;
}

export const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'manage.py', '.git',
];

export function looksLikeProject(dir: string): boolean {
  return PROJECT_MARKERS.some((m) => exists(path.join(dir, m)));
}

/** Normalise a git remote so ssh/https forms of the same repo compare equal. */
export function normalizeRemote(url?: string): string | undefined {
  if (!url) return undefined;
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//, '');      // scheme
  u = u.replace(/^[^@/]+@/, '');           // user@
  u = u.replace(/:(?!\d)/, '/');           // scp-style host:path
  u = u.replace(/:\d+\//, '/');            // explicit port
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  return u;
}
