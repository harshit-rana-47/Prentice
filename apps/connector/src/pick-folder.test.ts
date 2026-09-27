import { describe, expect, it } from "vitest";
import { chooseFolderOn } from "./pick-folder.js";

describe("folder dialog", () => {
  it("returns the macOS folder the person chose", async () => {
    const path = await chooseFolderOn("darwin", async (command) => {
      expect(command).toBe("osascript");
      return { stdout: "/Users/ada/Projects/Demo/\n", stderr: "" };
    });
    expect(path).toBe("/Users/ada/Projects/Demo");
  });

  it("returns the Windows folder the person chose", async () => {
    const path = await chooseFolderOn("win32", async (command, args) => {
      expect(command).toBe("powershell.exe");
      expect(args.join(" ")).toContain("FolderBrowserDialog");
      return { stdout: "C:\\Users\\ada\\Projects\\Demo\r\n", stderr: "" };
    });
    expect(path).toBe("C:\\Users\\ada\\Projects\\Demo");
  });

  it("treats a cancelled dialog as no choice", async () => {
    const error = Object.assign(new Error("Command failed"), { stderr: "execution error: User canceled. (-128)" });
    const path = await chooseFolderOn("darwin", async () => {
      throw error;
    });
    expect(path).toBeNull();
  });

  it("does not invent a dialog on other systems", async () => {
    await expect(chooseFolderOn("linux", async () => ({ stdout: "", stderr: "" }))).rejects.toThrow(/macOS and Windows/);
  });
});