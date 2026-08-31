'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const version = String(packageJson.version || '');
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
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

const tag = `v${version}`;
const vsix = `${packageJson.name}-${version}.vsix`;
const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME;
if (refType === 'tag' && refName && refName !== tag) {
  throw new Error(`Tag ${refName} does not match package version ${tag}`);
}

const output = process.env.GITHUB_OUTPUT;
if (output) {
  fs.appendFileSync(output, `version=${version}\ntag=${tag}\nvsix=${vsix}\n`, 'utf8');
}

console.log(JSON.stringify({ version, tag, vsix }));
