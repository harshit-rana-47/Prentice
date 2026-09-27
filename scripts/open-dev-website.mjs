import { execFile } from "node:child_process";

const website = process.env.PRENTICE_WEBSITE_URL ?? "http://127.0.0.1:3000";
const pairingPort = process.env.PRENTICE_PAIR_PORT ?? "4732";
const pairing = `http://127.0.0.1:${pairingPort}`;
const deadline = Date.now() + 90_000;
let ready = false;

while (Date.now() < deadline) {
  try {
    const response = await fetch(website, { redirect: "manual" });
    if (response.status < 500) {
      ready = true;
      break;
    }
  } catch {
    // The website process is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

console.log(`Prentice website: ${website}`);
console.log(`Connector pairing page (only to pair this computer): ${pairing}`);
if (!ready) {
  console.error(`The Prentice website was not ready at ${website}. That URL is still the workspace.`);
  process.exit(0);
}
if (process.platform === "darwin") {
  execFile("open", [website], (error) => {
    if (error) console.error(error.message);
  });
} else if (process.platform === "win32") {
  execFile("cmd", ["/c", "start", "", website], (error) => {
    if (error) console.error(error.message);
  });
}
