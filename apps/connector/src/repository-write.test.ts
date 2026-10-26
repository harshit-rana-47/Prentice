import { expect, it } from "vitest";
import { claimedWriteMissed, commandWritesRepository } from "./session.js";

it.each([
  'node -e "setTimeout(() => console.log(\'done\'), 15000)"',
  'git status --porcelain > /tmp/prentice-status-before.txt && cat /tmp/prentice-status-before.txt',
  'node --test example.test.js > /private/tmp/prentice-focused.tap 2>&1',
  'npm test > /dev/null 2>&1',
  'npm test 2>&1',
  'printf "%s" "touch README.md; cat > src/file.js"',
  'node <<\'JS\'\nconsole.log(2 > 1);\nJS',
  'mkdir -p /tmp/check && touch /tmp/check/done',
  'cp README.md /tmp/readme-backup',
  'cp README.md /tmp/readme-backup 2>&1',
  'node --test | tee /tmp/test-output.tap',
  'sed -i "s/before/after/" /tmp/scratch.txt',
])("does not infer a repository write from read-only code or scratch output: %s", command => {
  expect(commandWritesRepository(command)).toBe(false);
  expect(claimedWriteMissed([{type:"command.finished",command,exitCode:0}])).toBe(false);
});

it.each([
  'cat > hello.txt <<\'EOF\'\nHello\nEOF',
  'printf hello >> "src/hello world.txt"',
  'node --test > results.tap 2>&1',
  'echo hello | tee src/hello.txt',
  'touch src/new.txt',
  'cp /tmp/prepared.js src/new.js',
  'sed -i "s/before/after/" src/new.js',
  'git add src/new.js',
  'bash -c "printf hello > hello.txt"',
])("keeps the missing-write guard for actual repository write intent: %s", command => {
  expect(commandWritesRepository(command)).toBe(true);
  expect(claimedWriteMissed([{type:"command.finished",command,exitCode:0}])).toBe(true);
});

it("still checks explicit agent file-change claims and ignores commands which failed", () => {
  expect(claimedWriteMissed([{type:"file.changed",path:"src/new.js",change:"added",source:"agent"}])).toBe(true);
  expect(claimedWriteMissed([{type:"command.finished",command:"cat > hello.txt",exitCode:1}])).toBe(false);
});
