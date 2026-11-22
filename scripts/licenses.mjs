import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
console.log('| Package | Version | License | Installed license/notice files (SHA-256) |');
console.log('|---|---|---|---|');
for(const [path,pkg] of Object.entries(lock.packages)) {
 if(!path) continue;
 if(!['MIT','Apache-2.0','0BSD'].includes(pkg.license)) throw Error('Unreviewed license: '+path);
 let files;
 try {files=await readdir(path);} catch(error) {
  if(error.code!=='ENOENT'||!pkg.optional) throw error;
  console.log(`| ${path.replace('node_modules/','')} | ${pkg.version} | ${pkg.license} | Optional platform binary; not installed on this host |`);continue;
 }
 const notices=files.filter(name=>/^(license|licence|copying|notice)/i.test(name));
 if(!notices.length && path.startsWith('node_modules/@esbuild/')) {
  const license=await readFile('node_modules/esbuild/LICENSE.md');
  console.log(`| ${path.replace('node_modules/','')} | ${pkg.version} | ${pkg.license} | Same-version esbuild/LICENSE.md: ${createHash('sha256').update(license).digest('hex')} |`);continue;
 }
 if(!notices.length) throw Error('Missing license: '+path);
 const hashes=[];
 for(const name of notices) hashes.push(name+': '+createHash('sha256').update(await readFile(path+'/'+name)).digest('hex'));
 console.log(`| ${path.replace('node_modules/','')} | ${pkg.version} | ${pkg.license} | ${hashes.join('; ')} |`);
}
