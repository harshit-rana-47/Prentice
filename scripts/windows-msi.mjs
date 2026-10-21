import { createHash } from "node:crypto";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const WIX_VERSION = "7.0.0";
export const UPGRADE_CODE = "792f9eec-9810-4c64-b71b-95803658550e";
const xml = (text) => String(text).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[character]));
const id = (text) => `p${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0,32)}`;
const guid = (text) => { const hex=createHash("sha256").update(`${UPGRADE_CODE}:${text.toLowerCase()}`).digest("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; };
export function payloadFiles(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path=join(directory,name);const info=lstatSync(path);
    if(info.isSymbolicLink())throw new Error(`Installer payload cannot contain a symlink: ${name}`);
    if(info.isDirectory())return payloadFiles(path);
    if(!info.isFile())throw new Error(`Installer payload must contain regular files: ${name}`);
    return [path];
  });
}
export function assertWindowsBinary(path) {
  const bytes=readFileSync(path);const offset=bytes.length>=64?bytes.readUInt32LE(60):0;
  if(bytes.length<offset+6 || bytes.toString('ascii',0,2)!=='MZ' || bytes.readUInt32LE(offset)!==0x4550 || bytes.readUInt16LE(offset+4)!==0x8664)throw new Error(`Expected an x64 Windows PE binary: ${path}`);
}
export function msiVersion(version) {
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error("MSI requires a three-part numeric application version.");
  const [major,minor,build]=version.split('.').map(Number);
  if(major>255||minor>255||build>65535)throw new Error("Application version is outside MSI version limits.");
  return version;
}
/** Explicit HKCU key paths keep all user-profile file components valid for a per-user MSI. */
export function payloadSource(directory) {
  const files=payloadFiles(directory);
  for(const required of ['Prentice.exe','node.exe','connector.mjs','process-guard.exe','prentice.config.json'])if(!files.includes(join(directory,required)))throw new Error(`Missing installer payload: ${required}`);
  for(const name of ['Prentice.exe','node.exe','process-guard.exe'])assertWindowsBinary(join(directory,name));
  const directories=new Set(['']);for(const file of files){const parts=relative(directory,file).replaceAll('\\','/').split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop();}}
  const directoryId = path => path ? id(`dir:${path}`) : 'INSTALLFOLDER';
  const tree=parent=>[...directories].filter(path=>path && (path.includes('/')?path.slice(0,path.lastIndexOf('/')):'')===parent).sort().map(path=>`<Directory Id="${directoryId(path)}" Name="${xml(path.split('/').at(-1))}">${tree(path)}</Directory>`).join('');
  const components=files.map(file=>{const path=relative(directory,file).replaceAll('\\','/');const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';const key=id(path);return `<DirectoryRef Id="${directoryId(parent)}"><Component Id="${key}" Guid="${guid(path)}" Bitness="always64"><File Id="f${key}" Source="${xml(file)}"/><RegistryValue Root="HKCU" Key="Software\\Prentice\\Installer\\Files" Name="${key}" Type="integer" Value="1" KeyPath="yes"/></Component></DirectoryRef>`;}).join('\n');
  const removal = `<DirectoryRef Id="INSTALLFOLDER"><Component Id="PayloadDirectories" Guid="cfaaad1f-1e3f-5f62-a4d2-611c217c85fb" Bitness="always64"><RegistryValue Root="HKCU" Key="Software\\Prentice\\Installer" Name="Directories" Type="integer" Value="1" KeyPath="yes"/>${[...directories].map(path=>`<RemoveFolder Id="${id('remove:'+path)}" Directory="${directoryId(path)}" On="uninstall"/>`).join('')}</Component></DirectoryRef>`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment><DirectoryRef Id="INSTALLFOLDER">${tree('')}</DirectoryRef>${components}${removal}<ComponentGroup Id="Payload"><ComponentRef Id="PayloadDirectories"/>${files.map(file=>`<ComponentRef Id="${id(relative(directory,file).replaceAll('\\','/'))}"/>`).join('')}</ComponentGroup></Fragment></Wix>\n`;
}
/** External signer receives explicit arguments, never shell text or a certificate password. */
export function signWindows(files, { signer, run, release }) {
  if(!signer) { if(release)throw new Error("Release MSI requires PRENTICE_WIN_SIGNER: an executable signing adapter.");return false; }
  for(const file of files) { run(signer,['sign',file]);run(signer,['verify',file]); }
  return true;
}
