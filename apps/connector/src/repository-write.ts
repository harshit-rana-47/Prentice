import { basename } from "node:path";
import parse from "shell-quote/parse.js";

/** This is evidence of write intent, not a shell sandbox or an execution parser. */
export function commandWritesRepository(command: string, depth = 0): boolean {
  if (depth > 3) return false;
  const heredocs: string[] = [];
  for (const line of command.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    if (heredocs.length) {
      if (line.trim() === heredocs[0]) heredocs.shift();
      continue; // Here-document contents are data, not shell commands.
    }
    let tokens: ReturnType<typeof parse>;
    try {
      // Preserve variable names without consulting this process's environment.
      tokens = parse(line, key => `$${key}`);
    } catch {
      continue; // Unparsed syntax alone is not evidence that a write was attempted.
    }
    const words: string[] = [];
    const check = () => writesCommand(words, depth);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (typeof token === "string") {
        words.push(token);
        continue;
      }
      if (!("op" in token)) break; // Shell comment.
      if (token.op === "glob") {
        words.push(token.pattern);
      } else if ([">", ">>", ">&"].includes(token.op)) {
        if (/^\d+$/.test(words.at(-1) ?? "")) words.pop(); // Redirected file descriptor.
        const target = tokens[++i];
        if (typeof target === "string" && !(token.op === ">&" && /^\d+$/.test(target)) && !scratchPath(target)) return true;
      } else if (token.op === "<") {
        const next = tokens[i + 1];
        if (typeof next === "object" && "op" in next && next.op === "<") {
          i++;
          const delimiter = tokens[++i];
          if (typeof delimiter === "string") heredocs.push(delimiter.replace(/^-/, ""));
        } else i++; // Input redirection is not a write.
      } else if (token.op === "<<<" || token.op === "<&") {
        i++;
      } else {
        if (check()) return true;
        words.length = 0;
      }
    }
    if (check()) return true;
  }
  return false;
}

function scratchPath(path: string): boolean {
  return /^(?:\/private)?\/tmp(?:\/|$)/.test(path) ||
    /^(?:\/private)?\/var\/folders\//.test(path) ||
    /^\/dev\/(?:null|stdout|stderr)$/.test(path);
}

function writesCommand(words: string[], depth: number): boolean {
  const start = words.findIndex(word => !/^[\w]+=/.test(word));
  if (start < 0) return false;
  const name = basename(words[start]);
  const args = words.slice(start + 1);
  if (["sh", "bash", "zsh"].includes(name)) {
    const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
    return flag >= 0 && commandWritesRepository(args[flag + 1] ?? "", depth + 1);
  }
  const operands = args.filter(arg => !arg.startsWith("-"));
  if (name === "git") return /^(?:add|commit|checkout|switch|restore|reset|clean|mv|rm)$/.test(operands[0] ?? "");
  if (["cp", "install"].includes(name)) {
    const targetFlag = args.findIndex(arg => arg === "-t" || arg === "--target-directory");
    const target = targetFlag >= 0 ? args[targetFlag + 1] : operands.at(-1);
    return Boolean(target && !scratchPath(target));
  }
  if (["sed", "perl"].includes(name)) {
    return args.some(arg => /^-[a-z]*i/.test(arg) || arg === "--in-place") &&
      Boolean(operands.at(-1) && !scratchPath(operands.at(-1)!));
  }
  return ["tee", "mkdir", "rmdir", "rm", "mv", "touch", "truncate", "unlink"].includes(name) &&
    operands.some(path => !scratchPath(path));
}
