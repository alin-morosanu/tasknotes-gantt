import fs from 'node:fs';

const version = process.env.npm_package_version;
if (!version) throw new Error('npm_package_version is missing');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = version;
fs.writeFileSync('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
versions[version] = manifest.minAppVersion;
fs.writeFileSync('versions.json', `${JSON.stringify(versions, null, 2)}\n`);
