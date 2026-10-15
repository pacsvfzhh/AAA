/*
# Fix ambiguous get_admin_groups_for_customer_service overload

## Problem
Two overloads exist:
1. `()` — no parameters, hardcoded filter
2. `(p_source_type text)` — with source_type parameter

The no-parameter version causes ambiguity if called without arguments.
Both callers (CCC and AAA pages) already pass `p_source_type` explicitly,
so the old no-parameter version is unused dead code.

## Fix
Drop the old no-parameter overload.
*/

DROP FUNCTION IF EXISTS get_admin_groups_for_customer_service();
