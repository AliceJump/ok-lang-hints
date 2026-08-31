'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const version = process.argv[2];
const semver = /^\d+\.\d+\.\d+$/;
if (!version || !semver.test(version)) {
  throw new Error('Usage: npm run version:sync -- <MAJOR.MINOR.PATCH>');
}

const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const jetbrainsPath = path.join(root, 'jetbrains', 'gradle.properties');

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
packageJson.version = version;
packageLock.version = version;
if (!packageLock.packages?.['']) {
  throw new Error('package-lock.json is missing the root package entry');
}
packageLock.packages[''].version = version;

const jetbrains = fs.readFileSync(jetbrainsPath, 'utf8');
if (!/^pluginVersion=.*$/m.test(jetbrains)) {
  throw new Error('jetbrains/gradle.properties is missing pluginVersion');
}
const updatedJetbrains = jetbrains.replace(/^pluginVersion=.*$/m, `pluginVersion=${version}`);

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
fs.writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
fs.writeFileSync(jetbrainsPath, updatedJetbrains, 'utf8');

console.log(JSON.stringify({ version, tag: `v${version}` }));
