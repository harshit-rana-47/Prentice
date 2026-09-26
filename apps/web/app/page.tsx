import { ProductShell } from "@/components/product-shell";
import { assertProtocolContract } from "@/lib/protocol-contract";

export default function HomePage() {
  assertProtocolContract();
  return <ProductShell />;
}
