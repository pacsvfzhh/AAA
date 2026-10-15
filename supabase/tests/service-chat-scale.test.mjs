import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Baselines are the definitions live in production; 20260905015900 was never applied there.
const migration = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const [isolationSQL, sourcesSQL, scaleSQL] = await Promise.all([
  migration('20260901220357_enforce_ccc_group_isolation.sql'),
  migration('20260930081803_align_service_conversation_sources.sql'),
  migration('20261101000002_scale_service_chat_queries.sql'),
]);

function functionSQL(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.notEqual(start, -1, `Function not found: ${name}`);
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, `Function end not found: ${name}`);
  return source.slice(start, end + '$function$;'.length);
}

const adminId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sessionToken = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPER = 1;
const SECONDARY = 2;
const INACTIVE = 4;
const EMERGENCY = 6;
const OTHER_SUPER = 7;
const SOURCES = ['aaa_service', 'ccc_service'];
let db;
let emptyBaseline;
let baseline;

const rows = async (query, params = []) => (await db.query(query, params)).rows;
const count = async (query, params = []) => Number((await rows(query, params))[0].count);

async function snapshot() {
  const admins = (await rows('SELECT id FROM public.admins ORDER BY id')).map(row => row.id);
  const summaries = {};
  for (const id of [...admins, adminId(99)]) {
    for (const source of SOURCES) {
      summaries[`${id}:${source}`] = await rows(
        'SELECT * FROM public.get_ccc_conversation_summaries($1, $2)', [id, source]);
    }
  }
  const groups = {};
  for (const source of [null, ...SOURCES]) {
    groups[String(source)] = await rows(
      'SELECT * FROM public.get_admin_groups_for_customer_service($1)', [source]);
  }
  return { summaries, groups };
}

async function unreadAs(token) {
  await db.exec('SET ROLE anon');
  try {
    return await rows(`SELECT admin_id, source_type, unread_count
      FROM public.get_admin_chat_unread_counts($1) ORDER BY admin_id, source_type`, [token]);
  } finally {
    await db.exec('RESET ROLE');
  }
}

// Mirrors the replaced browser logic: listed groups, same-group pairs, archived employees hidden by RLS.
const expectedUnread = () => rows(`
  SELECT customer.admin_id, message.source_type, count(*)::bigint AS unread_count
  FROM public.customer_employee_conversations AS message
  JOIN public.simulated_customers AS customer ON customer.id = message.customer_id
  JOIN public.users AS employee ON employee.id = message.employee_id
  WHERE message.sender_type = 'employee' AND message.is_read = false
    AND employee.created_by = customer.admin_id AND employee.archived_at IS NULL
    AND customer.admin_id IN (SELECT admin_id FROM public.get_admin_groups_for_customer_service(NULL))
  GROUP BY 1, 2 ORDER BY 1, 2`);

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA private;
    CREATE TABLE public.admins(id uuid PRIMARY KEY, username text NOT NULL, role text NOT NULL,
      is_active boolean DEFAULT true);
    CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL,
      employee_id text NOT NULL, created_by uuid REFERENCES public.admins(id), archived_at timestamptz);
    CREATE TABLE public.simulated_customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id uuid NOT NULL REFERENCES public.admins(id), customer_name text NOT NULL, customer_avatar text,
      custom_avatar_url text, source_type text NOT NULL DEFAULT 'aaa_service', UNIQUE (id, source_type));
    CREATE TABLE public.customer_employee_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES public.users(id), sender_type text NOT NULL,
      message_content text NOT NULL, message_type text DEFAULT 'text', is_read boolean DEFAULT false,
      created_at timestamptz DEFAULT now(), source_type text NOT NULL DEFAULT 'aaa_service',
      FOREIGN KEY (customer_id, source_type) REFERENCES public.simulated_customers(id, source_type));
    CREATE TABLE private.sessions(token uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES public.admins(id));
    CREATE FUNCTION private.get_financial_admin_context(p_token uuid)
    RETURNS TABLE(admin_id uuid, admin_role text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp AS $$
    BEGIN
      RETURN QUERY SELECT a.id, a.role FROM private.sessions s JOIN public.admins a ON a.id = s.admin_id
      WHERE s.token = p_token AND a.is_active = true AND a.role IN ('super_admin', 'secondary_admin') LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Financial administrator session is invalid or expired.'; END IF;
    END $$;
    REVOKE ALL ON FUNCTION private.get_financial_admin_context(uuid) FROM PUBLIC;
  `);
  await db.exec(functionSQL(isolationSQL, 'public.get_ccc_conversation_summaries'));
  await db.exec(functionSQL(sourcesSQL, 'public.get_admin_groups_for_customer_service'));
  await db.exec(`
    INSERT INTO public.admins(id, username, role, is_active) VALUES
      ('${adminId(SUPER)}', 'a1_super', 'super_admin', true),
      ('${adminId(SECONDARY)}', 'a2_secondary', 'secondary_admin', true),
      ('${adminId(3)}', 'a3_secondary', 'secondary_admin', true),
      ('${adminId(INACTIVE)}', 'a4_inactive', 'secondary_admin', false),
      ('${adminId(5)}', 'a5_unknown_active', 'secondary_admin', NULL),
      ('${adminId(EMERGENCY)}', 'a6_emergency', 'emergency_admin', true),
      ('${adminId(OTHER_SUPER)}', 'a7_super', 'super_admin', true);
    INSERT INTO private.sessions(token, admin_id)
      SELECT ('10000000-0000-4000-8000-' || right(id::text, 12))::uuid, id FROM public.admins;
    INSERT INTO public.users(username, employee_id, created_by, archived_at)
      SELECT a.username || '_e' || g, a.username || '-' || g, a.id, CASE WHEN g = 1 THEN now() END
      FROM public.admins a CROSS JOIN generate_series(1, 6) g;
    INSERT INTO public.users(username, employee_id) SELECT 'orphan_' || g, 'orphan-' || g FROM generate_series(1, 2) g;
    INSERT INTO public.simulated_customers(admin_id, customer_name, customer_avatar, custom_avatar_url, source_type)
      SELECT a.id, a.username || '_' || s.source || '_' || g,
        CASE WHEN g % 2 = 0 THEN 'customer-avatar:regular:' || g END,
        CASE WHEN g = 3 THEN 'https://fixture.invalid/' || g || '.png' END, s.source
      FROM public.admins a CROSS JOIN (VALUES ('aaa_service'), ('ccc_service')) s(source)
      CROSS JOIN generate_series(1, 4) g;
  `);
  emptyBaseline = await snapshot();

  // Every customer/employee combination is eligible, so cross-group legacy rows are covered too.
  // Salted hashes instead of random(): the planner may share one random() value across a row.
  await db.exec(`
    CREATE FUNCTION pg_temp.pick(p_salt text, p_key text, p_modulus int) RETURNS int
      LANGUAGE sql IMMUTABLE AS 'SELECT (abs(hashtext(p_salt || '':'' || p_key)::bigint) % p_modulus)::int';
    CREATE TEMP TABLE seed_pairs AS
      SELECT row_number() OVER (ORDER BY customer.customer_name, employee.username) AS pair_no,
        customer.id AS customer_id, customer.source_type, employee.id AS employee_id,
        1 + pg_temp.pick('count', customer.customer_name || '/' || employee.username, 12) AS message_count
      FROM public.simulated_customers AS customer CROSS JOIN public.users AS employee
      WHERE pg_temp.pick('pair', customer.customer_name || '/' || employee.username, 10) < 3;
    INSERT INTO public.customer_employee_conversations
      (customer_id, employee_id, source_type, sender_type, message_content, message_type, is_read, created_at)
    SELECT p.customer_id, p.employee_id, p.source_type,
      CASE WHEN pg_temp.pick('sender', p.pair_no || '/' || n, 2) = 0 THEN 'employee' ELSE 'customer' END,
      'message ' || p.pair_no || '-' || n,
      (ARRAY['text', 'text', 'image', 'rich_card', 'rating_request', 'rating_result', 'tip'])[1 + pg_temp.pick('type', p.pair_no || '/' || n, 7)],
      pg_temp.pick('read', p.pair_no || '/' || n, 10) < 6,
      CASE WHEN n = 2 AND p.message_count >= 3 AND p.pair_no % 9 = 0 THEN NULL
           ELSE timestamptz '2026-01-01 00:00:00+00' + (n * 100000 + p.pair_no) * interval '1 second' END
    FROM seed_pairs AS p CROSS JOIN LATERAL generate_series(1, p.message_count) AS n;
    DROP TABLE seed_pairs;
  `);
  baseline = await snapshot();
  await db.exec(scaleSQL);
});
after(async () => { await db?.close(); });

test('fixture covers cross-group, archived, rich card and NULL-time messages', async () => {
  assert.ok(await count(`SELECT count(*) FROM public.get_ccc_conversation_summaries($1, 'aaa_service') s
    JOIN public.users u ON u.id = s.employee_id WHERE u.created_by IS DISTINCT FROM $1`, [adminId(SUPER)]) > 0);
  assert.ok(Object.values(baseline.summaries).flat().some(row => row.last_message === '[Rich Card]'));
  assert.ok(await count(`SELECT count(*) FROM public.customer_employee_conversations c
    JOIN public.users u ON u.id = c.employee_id
    JOIN public.simulated_customers sc ON sc.id = c.customer_id AND sc.admin_id = u.created_by
    WHERE u.archived_at IS NOT NULL AND c.sender_type = 'employee' AND NOT c.is_read`) > 0);
  assert.ok(await count('SELECT count(*) FROM public.customer_employee_conversations WHERE created_at IS NULL') > 0);
  assert.ok(baseline.groups.null.some(group => Number(group.conversation_count) > 0));
});

test('rewritten summaries and group counts match the live definitions', async () => {
  assert.deepEqual(await snapshot(), baseline);
});

test('an empty chat table gives the same results and no unread counts', async () => {
  await db.exec('BEGIN');
  try {
    await db.exec('DELETE FROM public.customer_employee_conversations');
    assert.deepEqual(await snapshot(), emptyBaseline);
    assert.deepEqual(await unreadAs(sessionToken(SUPER)), []);
  } finally {
    await db.exec('ROLLBACK');
  }
});

test('unread counts follow the signed-in admin scope', async () => {
  const expected = await expectedUnread();
  assert.ok(expected.length > 2);
  assert.deepEqual(await unreadAs(sessionToken(SUPER)), expected);
  assert.deepEqual(await unreadAs(sessionToken(OTHER_SUPER)), expected);
  const own = expected.filter(row => row.admin_id === adminId(SECONDARY));
  assert.ok(own.length > 0);
  assert.deepEqual(await unreadAs(sessionToken(SECONDARY)), own);
});

test('unread counts reject invalid, inactive and emergency sessions', async () => {
  for (const token of [sessionToken(99), sessionToken(INACTIVE), sessionToken(EMERGENCY)]) {
    await assert.rejects(unreadAs(token), /Financial administrator session is invalid or expired/);
  }
});

test('function security attributes and privileges', async () => {
  const attributes = Object.fromEntries((await rows(`SELECT proname, prosecdef FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname IN
      ('get_ccc_conversation_summaries', 'get_admin_groups_for_customer_service', 'get_admin_chat_unread_counts')`))
    .map(row => [row.proname, row.prosecdef]));
  assert.deepEqual(attributes, {
    get_admin_chat_unread_counts: true,
    get_admin_groups_for_customer_service: false,
    get_ccc_conversation_summaries: false,
  });
  const privilege = role => rows(`SELECT has_function_privilege($1,
    'public.get_admin_chat_unread_counts(uuid)', 'EXECUTE') AS allowed`, [role]).then(result => result[0].allowed);
  assert.equal(await privilege('public'), false);
  assert.equal(await privilege('anon'), true);
  assert.equal(await privilege('authenticated'), true);
  assert.equal(await count(`SELECT count(*) FROM pg_indexes
    WHERE indexname = 'idx_conversations_employee_customer_created'`), 1);
});
