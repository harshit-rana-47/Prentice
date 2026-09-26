import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cloudConfig } from "@/lib/relay-browser";

let client: SupabaseClient | null = null;

export function prenticeAuth(): SupabaseClient {
  if (client) return client;
  const config = cloudConfig();
  client = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}
