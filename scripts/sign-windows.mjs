import { execFileSync } from "node:child_process";
const [action,file]=process.argv.slice(2);
if(process.platform!=="win32" || !['sign','verify'].includes(action) || !file)throw new Error("Use sign-windows.mjs sign|verify <file> on Windows.");
const tool=process.env.PRENTICE_SIGNTOOL_EXE || 'signtool';
if(action==='sign') {
  const certificate=process.env.PRENTICE_WIN_CERT_SHA1?.replaceAll(' ','');
  const timestamp=process.env.PRENTICE_WIN_TIMESTAMP_URL;
  if(!/^[a-f0-9]{40}$/i.test(certificate||''))throw new Error("Supply PRENTICE_WIN_CERT_SHA1 for an installed code-signing certificate.");
  if(!timestamp || new URL(timestamp).protocol!=='https:')throw new Error("Supply an HTTPS RFC3161 PRENTICE_WIN_TIMESTAMP_URL.");
  // Append, preserving any existing vendor signature on the official Node runtime.
  execFileSync(tool,['sign','/as','/sha1',certificate,...(process.env.PRENTICE_WIN_CERT_MACHINE_STORE==='1'?['/sm']:[]),'/fd','SHA256','/tr',timestamp,'/td','SHA256',file],{stdio:'inherit',shell:false});
} else execFileSync(tool,['verify','/pa','/all','/v',file],{stdio:'inherit',shell:false});
