'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const jetbrainsPropertiesPath = path.join(root, 'jetbrains', 'gradle.properties');

const version = String(packageJson.version || '');
const semver = /^\d+\.\d+\.\d+$/;
if (!semver.test(version)) {
  throw new Error(`package.json contains an invalid release version: ${version || '<empty>'}`);
}

const lockVersion = String(packageLock.version || '');
const rootPackageVersion = String(packageLock.packages?.['']?.version || '');
if (lockVersion !== version || rootPackageVersion !== version) {
  throw new Error(
    `Version mismatch: package.json=${version}, package-lock.json=${lockVersion}, package-lock root=${rootPackageVersion}`,
  );
}

if (!fs.existsSync(jetbrainsPropertiesPath)) {
  throw new Error('JetBrains submodule is missing. Check it out before verifying a release.');
}
const jetbrainsProperties = Object.fromEntries(
  fs.readFileSync(jetbrainsPropertiesPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
);
const jetbrainsVersion = String(jetbrainsProperties.pluginVersion || '');
if (jetbrainsVersion !== version) {
  throw new Error(`Version mismatch: package.json=${version}, jetbrains pluginVersion=${jetbrainsVersion || '<empty>'}`);
}

const tag = `v${version}`;
const vsix = `${packageJson.name}-${version}.vsix`;
const jetbrainsZip = `ok-lang-hints-jetbrains-${version}.zip`;
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === 'tag' && refName && refName !== tag) {
  throw new Error(`Tag ${refName} does not match package version ${tag}`);
}

const output = process.env.GITHUB_OUTPUT;
if (output) {
  fs.appendFileSync(
    output,
    `version=${version}\ntag=${tag}\nvsix=${vsix}\njetbrains_zip=${jetbrainsZip}\n`,
    'utf8',
  );
}

console.log(JSON.stringify({ version, tag, vsix, jetbrainsZip }));
