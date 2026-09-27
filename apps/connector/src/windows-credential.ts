import { spawn } from "node:child_process";
import type { DeviceKeychain } from "./device.js";

type Run = (action: "write" | "read" | "delete", account: string, secret?: string) => Promise<string>;

/** Windows Credential Manager. The secret is written on stdin, not on the command line. */
export function windowsCredentialManager(run: Run = powershellCredential): DeviceKeychain {
  return {
    async writePrivateKey(account, pkcs8) {
      await run("write", account, pkcs8);
    },
    async readPrivateKey(account) {
      const value = (await run("read", account)).trim();
      return value || null;
    },
    async deletePrivateKey(account) {
      await run("delete", account);
    },
  };
}

export function credentialProgram(): string {
  return `$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd().Replace("` + "`r`n" + `","` + "`n" + `")
$split = $raw.Split([char]10, 2)
$account = $split[0].Trim()
$secret = if ($split.Length -gt 1) { $split[1].Trim() } else { '' }
$target = 'Prentice:' + $account
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PrenticeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NativeCredential {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredWrite(ref NativeCredential cred, uint flags);
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredRead(string target, uint type, uint reserved, out IntPtr cred);
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredDelete(string target, uint type, uint reserved);
  [DllImport("advapi32")]
  static extern void CredFree(IntPtr cred);
  public static void Write(string target, string secret) {
    var bytes = Encoding.Unicode.GetBytes(secret);
    var blob = Marshal.AllocHGlobal(bytes.Length);
    var targetPtr = Marshal.StringToCoTaskMemUni(target);
    var userPtr = Marshal.StringToCoTaskMemUni("prentice");
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      var cred = new NativeCredential {
        Type = 1,
        TargetName = targetPtr,
        CredentialBlobSize = (uint)bytes.Length,
        CredentialBlob = blob,
        Persist = 2,
        UserName = userPtr
      };
      if (!CredWrite(ref cred, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      Marshal.FreeHGlobal(blob);
      Marshal.FreeCoTaskMem(targetPtr);
      Marshal.FreeCoTaskMem(userPtr);
    }
  }
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return "";
    try {
      var cred = Marshal.PtrToStructure<NativeCredential>(pointer);
      if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) return "";
      var bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.Unicode.GetString(bytes);
    } finally { CredFree(pointer); }
  }
  public static void Delete(string target) { CredDelete(target, 1, 0); }
}
'@
$action = $env:PRENTICE_CRED_ACTION
if ($action -eq 'write') { [PrenticeCred]::Write($target, $secret) }
elseif ($action -eq 'read') { [Console]::Out.Write([PrenticeCred]::Read($target)) }
elseif ($action -eq 'delete') { [PrenticeCred]::Delete($target) }
else { throw 'Unknown credential action.' }
`;
}

function powershellCredential(action: "write" | "read" | "delete", account: string, secret = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", credentialProgram()],
      { env: { ...process.env, PRENTICE_CRED_ACTION: action }, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "Windows Credential Manager rejected the device key."));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(`${account}\n${secret}`);
  });
}
