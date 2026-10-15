/*
# Fix ambiguous get_ccc_conversation_summaries function overload

## Problem
Two overloads of `get_ccc_conversation_summaries` exist:
1. `(p_admin_id uuid)` — hardcodes `source_type = 'ccc_service'`
2. `(p_admin_id uuid, p_source_type text DEFAULT 'ccc_service')` — accepts optional source_type

When calling with a single uuid argument, PostgreSQL cannot choose between them,
resulting in: "function get_ccc_conversation_summaries(uuid) is not unique".
This causes the CCC page's "All History" and "All New" buttons to silently fail
because the RPC call errors out and the conversation data is never loaded.

## Fix
Drop the old single-parameter overload. The newer two-parameter version with a
DEFAULT covers the exact same behavior when called with just `p_admin_id`.

## Security
No changes — both functions had identical logic and security characteristics.
*/

-- Drop the old single-parameter overload that causes ambiguity
DROP FUNCTION IF EXISTS get_ccc_conversation_summaries(uuid);
