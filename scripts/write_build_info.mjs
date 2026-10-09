import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const files=[...walk('src'),...walk('tests'),'index.html','package.json','package-lock.json','vite.config.js'].sort();
const hash=crypto.createHash('sha256');for(const name of files){hash.update(name);hash.update('\0');hash.update(fs.readFileSync(name));hash.update('\0');}
const catalog=JSON.parse(fs.readFileSync('public/data/catalog.json'));
const info={name:'CITY EATER',version:JSON.parse(fs.readFileSync('package.json')).version,sourceSha256:hash.digest('hex'),dataVersions:Object.fromEntries(catalog.levels.map(l=>[l.id,l.version]))};
fs.writeFileSync('public/build-info.json',`${JSON.stringify(info,null,2)}\n`);
console.log(`Source SHA-256: ${info.sourceSha256}`);
