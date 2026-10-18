import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { createEmployeeTransferMediaHandler } from './handler.ts';

// Deployment may use verify_jwt=false: SQL22 authenticates BOTH the administrator
// session and transfer job on authorize AND commit. No config is changed here.
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
let db: SupabaseClient | undefined;
function client() {
  // Lazy initialization keeps configuration/SDK failures inside the handler's
  // sanitized error boundary. Never forward a caller's Authorization header.
  if (!serviceKey) throw new Error('TRANSFER_FAILED');
  return db ??= createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

Deno.serve(createEmployeeTransferMediaHandler({
  supabaseUrl,
  rpc: (name, args) => client().rpc(name, args),
  store: {
    download: (bucket, path) => client().storage.from(bucket).download(path),
    upload: (bucket, path, bytes, options) => client().storage.from(bucket).upload(path, bytes, options),
  },
}));
