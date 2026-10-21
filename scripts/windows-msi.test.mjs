import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';import { execFileSync } from 'node:child_process';
import { payloadSource, signWindows, msiVersion, UPGRADE_CODE } from './windows-msi.mjs';
import { publicConfig } from './package-common.mjs';
test('public desktop configuration rejects credentials without echoing them',()=>{
 const names=['PRENTICE_CLOUD_URL','PRENTICE_WEBSITE_URL'];const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 try {
  for(const name of names){
   process.env.PRENTICE_CLOUD_URL='https://relay.example.test';process.env.PRENTICE_WEBSITE_URL='https://site.example.test';
   process.env[name]='https://private-user:private-password@example.test';
   assert.throws(()=>publicConfig(),error=>!error.message.includes('private-password')&&/without embedded credentials/.test(error.message));
  }
 }finally{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}}
});
function pe(){const bytes=Buffer.alloc(128);bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.writeUInt32LE(0x4550,64);bytes.writeUInt16LE(0x8664,68);return bytes;}
test('MSI payload rejects missing/wrong-platform guardians and preserves per-user component identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'prentice-msi-'));try{
 for(const file of ['Prentice.exe','node.exe','process-guard.exe'])writeFileSync(join(dir,file),pe());
 writeFileSync(join(dir,'connector.mjs'),'');writeFileSync(join(dir,'prentice.config.json'),'{}');
 mkdirSync(join(dir,'node_modules','nested'),{recursive:true});writeFileSync(join(dir,'node_modules','nested','binding.node'),pe());
 const first=payloadSource(dir);assert.match(first,/node_modules/);assert.match(first,/Directory="p[0-9a-f]+" On="uninstall"/);assert.match(first,/Root="HKCU"/);assert.ok(!first.includes('KeyPath="yes" Source='));
 writeFileSync(join(dir,'new.txt'),'');const second=payloadSource(dir);const old=first.match(/<Component Id="[^"]+" Guid="[^"]+"/g);for(const component of old)assert.ok(second.includes(component));
 rmSync(join(dir,'process-guard.exe'));assert.throws(()=>payloadSource(dir),/Missing installer payload/);
 writeFileSync(join(dir,'process-guard.exe'),'not Windows');assert.throws(()=>payloadSource(dir),/x64 Windows PE/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('signing fails closed and verifies payloads before the finished MSI',()=>{
 assert.throws(()=>signWindows(['guardian.exe'],{release:true,run:()=>assert.fail('must not execute')}),/requires/);
 const calls=[];signWindows(['Prentice.exe','process-guard.exe','node.exe','binding.node'],{signer:'signer',release:true,run:(exe,args)=>calls.push(args)});signWindows(['Prentice.msi'],{signer:'signer',release:true,run:(exe,args)=>calls.push(args)});
 assert.deepEqual(calls.at(-2),['sign','Prentice.msi']);assert.deepEqual(calls.at(-1),['verify','Prentice.msi']);
 assert.throws(()=>signWindows(['Prentice.msi'],{signer:'signer',release:true,run:()=>{throw Error('bad signature')}}),/bad signature/);
});
test('installer scope/startup/uninstall authoring owns only application resources',()=>{
 const source=readFileSync(new URL('./windows/Prentice.wxs',import.meta.url),'utf8');
 assert.ok(source.includes(UPGRADE_CODE));
 assert.match(source,/Scope="perUser"/);assert.match(source,/Schedule="afterInstallInitialize"/);assert.match(source,/CurrentVersion\\Run/);assert.match(source,/DowngradeErrorMessage/);
 assert.ok(!source.includes('ServiceInstall'));assert.ok(!source.includes('RemoveFile'));assert.ok(!source.includes('.prentice'));assert.ok(!source.includes('Credential'));
 const launcher=readFileSync(new URL('../apps/connector/native/windows-launcher.c',import.meta.url),'utf8');assert.match(launcher,/PRENTICE_INSTALL_LOGIN_ITEM",L"0"/);assert.match(launcher,/RegisterApplicationRestart/);
 assert.equal(msiVersion('1.2.3'),'1.2.3');for(const version of ['1.2.3-beta','256.0.0','1.0.65536'])assert.throws(()=>msiVersion(version));
});
test('release guards refuse a production ZIP and unsigned Mac release before packaging',()=>{
 const root=new URL('../',import.meta.url);const env={...process.env,PRENTICE_RELEASE:'1',PRENTICE_MAC_SIGN_IDENTITY:'',PRENTICE_MAC_NOTARY_PROFILE:''};
 assert.throws(()=>execFileSync(process.execPath,['scripts/package-win.mjs','--zip'],{cwd:root,env,stdio:'pipe'}),error=>String(error.stderr).includes('development-only'));
 assert.throws(()=>execFileSync(process.execPath,['scripts/package-mac.mjs'],{cwd:root,env,stdio:'pipe'}),error=>String(error.stderr).includes('requires a Developer ID'));
});
