import { downloadResponse } from "@/lib/download";

export async function GET() {
  if (process.env.PRENTICE_WINDOWS_MSI_READY !== "1") return new Response("The Windows installer is not available yet.", { status: 404 });
  return downloadResponse("Prentice-Windows.msi", process.env.PRENTICE_WINDOWS_MSI);
}
