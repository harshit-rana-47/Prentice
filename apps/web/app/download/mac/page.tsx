import type { Metadata } from "next";
import { MacDownload } from "@/components/mac-download";
import { publicDownloadUrl } from "@/lib/download";

export const metadata: Metadata = { title: "Prentice for Mac" };
export const dynamic = "force-dynamic";

export default function MacDownloadPage() {
  const available = Boolean(publicDownloadUrl("Prentice-Mac.zip")) || process.env.NODE_ENV !== "production";
  return <MacDownload available={available} />;
}
