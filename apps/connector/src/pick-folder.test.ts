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

  it("uses the bundled native picker for the installed Mac app", async () => {
    const helper = "/Applications/Prentice.app/Contents/Helpers/Prentice Folder Picker.app/Contents/MacOS/folder-picker";
    const path = await chooseFolderOn("darwin", async (command, args) => {
      expect(command).toBe(helper);
      expect(args).toEqual([]);
      return { stdout: "/private/tmp/check project\n", stderr: "" };
    }, helper);
    expect(path).toBe("/private/tmp/check project");
  });

  it("returns null when the native picker is cancelled", async () => {
    expect(await chooseFolderOn("darwin", async () => ({ stdout: "", stderr: "" }), "/native-picker")).toBeNull();
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