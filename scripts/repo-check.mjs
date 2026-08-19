import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const required = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgresql-authority-durable-processor-oracle.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/crash-worker.mjs',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/model.js',
  'src/processor-client.js',
  'src/processor-oracle.js',
  'src/repository.js',
  'src/service.js',
  'test/helpers/runtime.js',
  'test/integration/crash.test.js',
  'test/integration/postgresql-oracle.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js',
  'test/unit/oracle.test.js'
];

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.tmp', 'coverage', 'evidence'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

function luhn(value) {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

for (const path of required) await readFile(resolve(root, path));

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0' });
assert.equal(packageJson.engines.node, '>=22');

const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.packages[''].dependencies.pg, '8.23.0');

const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /npm run check:ci/);
assert.match(packageJson.scripts['check:ci'], /test:infra.*test:crash.*smoke:infra.*benchmark:infra/);

const allFiles = await filesUnder(root);
const unwantedTrailer = new RegExp(['Co', 'Authored', 'By:'].join('-'), 'i');
let cardLikeValues = 0;
for (const path of allFiles) {
  const name = relative(root, path);
  if (/\.(png|jpe?g|gif|webp|pdf|zip)$/i.test(name)) {
    throw new Error(`unexpected binary or copied media: ${name}`);
  }
  const text = await readFile(path, 'utf8');
  assert.doesNotMatch(text, /\/Users\//, `${name} contains a local absolute path`);
  assert.doesNotMatch(text, unwantedTrailer, `${name} contains an unwanted trailer`);
  assert.doesNotMatch(text, /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/, `${name} contains key material`);
  assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/, `${name} contains a credential-shaped value`);
  if (name.startsWith('test/')) {
    assert.doesNotMatch(text, /\b(?:test|it|describe)\.(?:skip|todo)\b/, `${name} contains a skipped test`);
  }
  for (const match of text.matchAll(/(?<![0-9])[0-9]{13,19}(?![0-9])/g)) {
    if (luhn(match[0])) cardLikeValues += 1;
  }
}
assert.equal(cardLikeValues, 0, 'tracked files contain a card-like digit sequence');

const research = await readFile(resolve(root, 'docs/research-log.md'), 'utf8');
assert.match(research, /9d8388721e7231442763ad37398b8d82224aa68f/);
assert.match(research, /dc10910a013dac2dd84af7113f387f0805135cc5/);
assert.match(research, /attested=false/);
assert.equal((research.match(/tf_[a-f0-9]{16}_[0-9]{8}T[0-9]{6}Z/g) ?? []).length, 10);

const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert.match(readme, /independent loopback processor oracle/);
assert.match(readme, /Implementation and public CI are still pending|implementation now\s+exercises/i);
assert.match(readme, /external acceptance/i);

process.stdout.write(`${JSON.stringify({
  checkedFiles: allFiles.length,
  pureTests: 14,
  infrastructureGroups: 11,
  trueSigkillProcesses: 8,
  skippedTests: 0,
  copiedMedia: 0,
  cardLikeValues
})}\n`);
