import { downloadResponse } from "@/lib/download";

export async function GET() {
  return downloadResponse("Prentice-Windows.zip", process.env.PRENTICE_WINDOWS_ZIP);
}
