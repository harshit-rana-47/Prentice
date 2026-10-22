import { downloadResponse } from "@/lib/download";

export async function GET() {
  return downloadResponse("Prentice-Mac.zip", process.env.PRENTICE_MAC_ZIP);
}
