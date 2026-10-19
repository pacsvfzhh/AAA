import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { createEmployeeTransferMediaHandler } from './handler.ts';

// verify_jwt=false is safe only because SQL22 revalidates both tokens at commit.
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
let db: SupabaseClient | undefined;
function client() {
  // Lazy creation keeps configuration failures inside the sanitized error boundary.
  if (!serviceKey) throw new Error('TRANSFER_FAILED');
  return db ??= createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

Deno.serve(createEmployeeTransferMediaHandler({
  supabaseUrl,
  rpc: (name, args) => client().rpc(name, args),
  store: {
    // Only the validated env-origin path may receive service credentials.
    download: async (bucket, path, signal) => ({
      data: await fetch(`${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${path}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Accept-Encoding': 'identity' },
      }),
      error: null,
    }),
    upload: (bucket, path, bytes, options) => client().storage.from(bucket).upload(path, bytes, options),
  },
}));
