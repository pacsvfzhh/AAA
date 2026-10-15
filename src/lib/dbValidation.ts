/**
 * Database Validation Utilities
 *
 * Validates database query results and ensures type safety
 */

import { supabase } from './supabase';
import type { Database } from '../types/database';

type TableName = keyof Database['public']['Tables'];

/**
 * Validates that a required table column exists
 */
export async function validateTableColumn(
  tableName: string,
  columnName: string
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from(tableName as TableName)
      .select(columnName)
      .limit(1);

    if (error) {
      console.error(`[DB Validation] Column ${columnName} not found in ${tableName}:`, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[DB Validation] Error checking column ${columnName} in ${tableName}:`, error);
    return false;
  }
}

/**
 * Validates that required columns exist before running a query
 */
export async function validateRequiredColumns(
  tableName: string,
  columns: string[]
): Promise<{ valid: boolean; missingColumns: string[] }> {
  const missingColumns: string[] = [];

  for (const column of columns) {
    const exists = await validateTableColumn(tableName, column);
    if (!exists) {
      missingColumns.push(column);
    }
  }

  return {
    valid: missingColumns.length === 0,
    missingColumns
  };
}

/**
 * Safe database query wrapper with validation
 */
export async function safeQuery<T>(
  tableName: string,
  select: string,
  options?: {
    validate?: boolean;
    defaultValue?: T;
  }
): Promise<{ data: T | null; error: Error | null }> {
  try {
    // Optionally validate columns before querying
    if (options?.validate) {
      const columns = select.split(',').map(c => c.trim());
      const validation = await validateRequiredColumns(tableName, columns);

      if (!validation.valid) {
        return {
          data: options.defaultValue ?? null,
          error: new Error(
            `Missing columns in ${tableName}: ${validation.missingColumns.join(', ')}`
          )
        };
      }
    }

    const { data, error } = await supabase
      .from(tableName as TableName)
      .select(select);

    if (error) {
      console.error(`[DB Query] Error querying ${tableName}:`, error);
      return {
        data: options?.defaultValue ?? null,
        error: new Error(error.message)
      };
    }

    return { data: data as T, error: null };
  } catch (error) {
    console.error(`[DB Query] Unexpected error querying ${tableName}:`, error);
    return {
      data: options?.defaultValue ?? null,
      error: error instanceof Error ? error : new Error('Unknown error')
    };
  }
}

/**
 * Check if a table exists
 */
export async function tableExists(tableName: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from(tableName as TableName)
      .select('*')
      .limit(0);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Validate database schema for critical tables
 */
export async function validateCriticalSchema(): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  // Check system_configs table
  const systemConfigsExists = await tableExists('system_configs');
  if (!systemConfigsExists) {
    errors.push('system_configs table does not exist');
  } else {
    const { valid, missingColumns } = await validateRequiredColumns(
      'system_configs',
      ['key', 'value']
    );
    if (!valid) {
      errors.push(`system_configs missing columns: ${missingColumns.join(', ')}`);
    }
  }

  // Check history_cleanup_config table
  const cleanupConfigExists = await tableExists('history_cleanup_config');
  if (!cleanupConfigExists) {
    errors.push('history_cleanup_config table does not exist');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
