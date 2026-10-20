type EmployeeFinanceCounts = Record<'wallets' | 'wallet_balance_baselines' | 'wallet_ledger_entries' | 'wallet_transactions' | 'withdrawals' | 'wallet_reconciliation_audit', number>;
type EmployeeVerificationCounts = { verification_requests: number };
type EmployeeVerificationCatalog = {
  version: 1; scope: 'employee-verification'; site_id: string; package_id: string; identity_catalog: EmployeeIdentityCatalog;
  tables: { key: 'verification_requests'; rows: number; bytes: number; row_hashes_sha256: string }[]; full_site_complete: false;
};
type EmployeeVerificationReceipt = EmployeeIdentityPending & {
  success: true; scope: 'employee-verification'; counts: EmployeeVerificationCounts; completed_employees: number; total_employees: number;
  verified: true; repeated: boolean;
};
type EmployeeVerificationMediaFile = {
  key: string; source_url: string; bytes: number; sha256: string;
  content_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf';
};
type EmployeeVerificationMediaAction = 'download' | 'recheck-export' | 'upload' | 'recheck-import';
type EmployeeActivityCounts = Record<'employee_login_history' | 'work_sessions' | 'work_stop_markers', number>;
type EmployeeActivityCatalog = {
  version: 1; scope: 'employee-activity'; site_id: string; package_id: string; identity_catalog: EmployeeIdentityCatalog;
  tables: { key: keyof EmployeeActivityCounts; rows: number; bytes: number; row_hashes_sha256: string }[]; full_site_complete: false;
};
type EmployeeActivityReceipt = EmployeeIdentityPending & {
  success: true; scope: 'employee-activity'; counts: EmployeeActivityCounts; completed_employees: number; total_employees: number;
  verified: true; repeated: boolean;
};
type EmployeeFinanceCatalog = {
  version: 1; scope: 'employee-finance'; site_id: string; package_id: string; identity_catalog: EmployeeIdentityCatalog;
  tables: { key: keyof EmployeeFinanceCounts; rows: number; bytes: number; row_hashes_sha256: string }[]; full_site_complete: false;
};
type EmployeeFinanceReceipt = EmployeeIdentityPending & {
  success: true; scope: 'employee-finance'; counts: EmployeeFinanceCounts; completed_employees: number; total_employees: number;
  verified: true; repeated: boolean;
};
type DispatchDependencyCounts = Record<'dispatch_group_members' | 'used_order_data', number>;
type DispatchDependencyReceipt = EmployeeIdentityPending & {
  success: true; scope: 'dispatch-dependencies'; counts: DispatchDependencyCounts; next_chunks: DispatchDependencyCounts;
  chunks: DispatchDependencyCounts; totals: DispatchDependencyCounts; verified: boolean; repeated: boolean;
};
type EmployeeIdentityCounts = Record<'accounts' | 'credentials' | 'orders', number>;
type EmployeeIdentityPending = {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
};
type EmployeeIdentityCatalog = {
  version: 1; scope: 'employee-identity'; site_id: string; package_id: string;
  tables: { key: 'accounts' | 'credentials' | 'orders'; rows: number; bytes: number; row_hashes_sha256: string }[];
  processing_orders: number; full_site_complete: false;
};
type EmployeeIdentityReceipt = EmployeeIdentityPending & {
  success: true; scope: 'employee-identity'; counts: EmployeeIdentityCounts; next_chunks: EmployeeIdentityCounts;
  chunks: EmployeeIdentityCounts; totals: EmployeeIdentityCounts; verified: boolean; repeated: boolean;
};

export interface Database {
  public: {
    Tables: {
      account_locks: {
        Row: {
          id: string;
          identifier: string;
          identifier_type: string;
          lock_until: string;
          lock_reason: string | null;
          failed_attempts: number;
          created_at: string | null;
          unlocked_at: string | null;
          unlocked_by: string | null;
          user_id: string | null;
        };
        Insert: {
          id?: string;
          identifier: string;
          identifier_type: string;
          lock_until: string;
          lock_reason?: string | null;
          failed_attempts?: number;
          created_at?: string | null;
          unlocked_at?: string | null;
          unlocked_by?: string | null;
          user_id?: string | null;
        };
        Update: {
          id?: string;
          identifier?: string;
          identifier_type?: string;
          lock_until?: string;
          lock_reason?: string | null;
          failed_attempts?: number;
          created_at?: string | null;
          unlocked_at?: string | null;
          unlocked_by?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      login_attempts: {
        Row: {
          id: string;
          identifier: string;
          identifier_type: string;
          attempt_time: string;
          success: boolean;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          identifier: string;
          identifier_type: string;
          attempt_time?: string;
          success?: boolean;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          identifier?: string;
          identifier_type?: string;
          attempt_time?: string;
          success?: boolean;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      system_configs: {
        Row: {
          id: string;
          key: string;
          value: unknown;
          description: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          key: string;
          value: unknown;
          description?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          key?: string;
          value?: unknown;
          description?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      admin_groups: {
        Row: {
          id: string;
          name: string;
          created_by: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          created_by: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          created_by?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      admin_group_members: {
        Row: {
          id: string;
          group_id: string;
          admin_id: string;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          group_id: string;
          admin_id: string;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          group_id?: string;
          admin_id?: string;
          created_at?: string | null;
        };
        Relationships: [];
      };
      group_configs: {
        Row: {
          id: string;
          group_id: string;
          config_type: string;
          config_value: string;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          group_id: string;
          config_type: string;
          config_value: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          group_id?: string;
          config_type?: string;
          config_value?: string;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      dispatch_groups: {
        Row: {
          id: string;
          group_name: string;
          description: string | null;
          pool_selection_mode: 'base' | 'random' | 'weighted';
          archived_at: string | null;
          dispatch_interval_min: number;
          dispatch_interval_max: number;
          session_timeout_minutes: number;
          submit_wait_min_seconds: number;
          submit_wait_max_seconds: number;
          commission_rate: number;
          withdrawal_amount_threshold: number;
          withdrawal_orders_threshold: number;
          withdrawal_condition_mode: 'OR' | 'AND' | 'amount_only' | 'days_only';
          dispatch_order_mode: 'random' | 'sequential';
          grab_success_rate: number;
          dispatch_success_rate: number;
          is_default: boolean;
          is_active: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_name: string;
          description?: string | null;
          pool_selection_mode?: 'base' | 'random' | 'weighted';
          archived_at?: string | null;
          dispatch_interval_min?: number | null;
          dispatch_interval_max?: number | null;
          session_timeout_minutes?: number;
          submit_wait_min_seconds?: number;
          submit_wait_max_seconds?: number;
          commission_rate?: number;
          withdrawal_amount_threshold?: number;
          withdrawal_orders_threshold?: number;
          withdrawal_condition_mode?: 'OR' | 'AND' | 'amount_only' | 'days_only';
          dispatch_order_mode?: string | null;
          grab_success_rate?: number;
          dispatch_success_rate?: number;
          is_default?: boolean | null;
          is_active?: boolean | null;
          created_by?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          group_name?: string;
          description?: string | null;
          pool_selection_mode?: 'base' | 'random' | 'weighted';
          archived_at?: string | null;
          dispatch_interval_min?: number | null;
          dispatch_interval_max?: number | null;
          session_timeout_minutes?: number;
          submit_wait_min_seconds?: number;
          submit_wait_max_seconds?: number;
          commission_rate?: number;
          withdrawal_amount_threshold?: number;
          withdrawal_orders_threshold?: number;
          withdrawal_condition_mode?: 'OR' | 'AND' | 'amount_only' | 'days_only';
          dispatch_order_mode?: string | null;
          grab_success_rate?: number;
          dispatch_success_rate?: number;
          is_default?: boolean | null;
          is_active?: boolean | null;
          created_by?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      dispatch_order_pools: {
        Row: {
          id: string;
          group_id: string;
          pool_name: string;
          is_base: boolean;
          is_active: boolean;
          dispatch_interval_min: number;
          dispatch_interval_max: number;
          session_timeout_minutes: number;
          trigger_probability: number;
          dispatch_order_mode: 'random' | 'sequential';
          dispatch_success_rate: number;
          archived_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          pool_name: string;
          is_base?: boolean;
          is_active?: boolean;
          dispatch_interval_min?: number;
          dispatch_interval_max?: number;
          session_timeout_minutes?: number;
          trigger_probability?: number;
          dispatch_order_mode?: 'random' | 'sequential';
          dispatch_success_rate?: number;
          archived_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          pool_name?: string;
          is_base?: boolean;
          is_active?: boolean;
          dispatch_interval_min?: number;
          dispatch_interval_max?: number;
          session_timeout_minutes?: number;
          trigger_probability?: number;
          dispatch_order_mode?: 'random' | 'sequential';
          dispatch_success_rate?: number;
          archived_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [{
          foreignKeyName: 'dispatch_order_pools_group_id_fkey';
          columns: ['group_id'];
          isOneToOne: false;
          referencedRelation: 'dispatch_groups';
          referencedColumns: ['id'];
        }];
      };
      dispatch_pool_selections: {
        Row: {
          session_id: string;
          user_id: string;
          group_id: string;
          pool_id: string;
          selected_at: string;
          due_at: string;
        };
        Insert: {
          session_id: string;
          user_id: string;
          group_id: string;
          pool_id: string;
          selected_at?: string;
          due_at: string;
        };
        Update: {
          session_id?: string;
          user_id?: string;
          group_id?: string;
          pool_id?: string;
          selected_at?: string;
          due_at?: string;
        };
        Relationships: [];
      };
      dispatch_group_orders: {
        Row: {
          id: string;
          group_id: string;
          pool_id: string;
          archived_at: string | null;
          order_content: string;
          is_active: boolean;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          pool_id: string;
          archived_at?: string | null;
          order_content: string;
          is_active?: boolean | null;
          created_by?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          group_id?: string;
          pool_id?: string;
          archived_at?: string | null;
          order_content?: string;
          is_active?: boolean | null;
          created_by?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'dispatch_group_orders_group_id_fkey';
            columns: ['group_id'];
            isOneToOne: false;
            referencedRelation: 'dispatch_groups';
            referencedColumns: ['id'];
          }
        ];
      };
      dispatch_orders: {
        Row: {
          id: string;
          order_content: string;
          is_active: boolean | null;
          created_by: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          order_content: string;
          is_active?: boolean | null;
          created_by?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          order_content?: string;
          is_active?: boolean | null;
          created_by?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      dispatch_assignments: {
        Row: {
          id: string;
          dispatch_order_id: string | null;
          group_id: string | null;
          pool_id: string | null;
          order_content_snapshot: string | null;
          dispatch_success_rate_snapshot: number | null;
          grab_success_rate_snapshot: number | null;
          commission_rate_snapshot: number | null;
          session_timeout_minutes_snapshot: number | null;
          submit_wait_min_seconds_snapshot: number | null;
          submit_wait_max_seconds_snapshot: number | null;
          user_id: string;
          status: string;
          assigned_at: string;
          accepted_at: string | null;
          completed_at: string | null;
          remarks: string | null;
          assignment_id: string | null;
          order_submitted: boolean;
          dispatch_session_id: string | null;
          accept_deadline_at: string | null;
        };
        Insert: {
          id?: string;
          dispatch_order_id?: string | null;
          group_id?: string | null;
          pool_id?: string | null;
          order_content_snapshot?: string | null;
          dispatch_success_rate_snapshot?: number | null;
          grab_success_rate_snapshot?: number | null;
          commission_rate_snapshot?: number | null;
          session_timeout_minutes_snapshot?: number | null;
          submit_wait_min_seconds_snapshot?: number | null;
          submit_wait_max_seconds_snapshot?: number | null;
          user_id?: string | null;
          status?: string | null;
          assigned_at?: string | null;
          accepted_at?: string | null;
          completed_at?: string | null;
          remarks?: string | null;
          assignment_id?: string | null;
          order_submitted?: boolean;
          dispatch_session_id?: string | null;
          accept_deadline_at?: string | null;
        };
        Update: {
          id?: string;
          dispatch_order_id?: string | null;
          group_id?: string | null;
          pool_id?: string | null;
          order_content_snapshot?: string | null;
          dispatch_success_rate_snapshot?: number | null;
          grab_success_rate_snapshot?: number | null;
          commission_rate_snapshot?: number | null;
          session_timeout_minutes_snapshot?: number | null;
          submit_wait_min_seconds_snapshot?: number | null;
          submit_wait_max_seconds_snapshot?: number | null;
          user_id?: string | null;
          status?: string | null;
          assigned_at?: string | null;
          accepted_at?: string | null;
          completed_at?: string | null;
          remarks?: string | null;
          assignment_id?: string | null;
          order_submitted?: boolean;
          dispatch_session_id?: string | null;
          accept_deadline_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'dispatch_assignments_dispatch_order_id_fkey';
            columns: ['dispatch_order_id'];
            isOneToOne: false;
            referencedRelation: 'dispatch_group_orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'dispatch_assignments_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
      dispatch_config: {
        Row: {
          id: string;
          config_key: string;
          config_value: string;
          description: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          config_key: string;
          config_value: string;
          description?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          config_key?: string;
          config_value?: string;
          description?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      dispatch_sessions: {
        Row: {
          id: string;
          user_id: string | null;
          status: string | null;
          started_at: string | null;
          ended_at: string | null;
          last_activity_at: string | null;
          consecutive_unaccepted_count: number;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          status?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
          last_activity_at?: string | null;
          consecutive_unaccepted_count?: number;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          status?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
          last_activity_at?: string | null;
          consecutive_unaccepted_count?: number;
        };
        Relationships: [];
      };
      dispatch_group_members: {
        Row: {
          id: string;
          group_id: string;
          user_id: string;
          assigned_by: string | null;
          assigned_at: string | null;
        };
        Insert: {
          id?: string;
          group_id: string;
          user_id: string;
          assigned_by?: string | null;
          assigned_at?: string | null;
        };
        Update: {
          id?: string;
          group_id?: string;
          user_id?: string;
          assigned_by?: string | null;
          assigned_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'dispatch_group_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'dispatch_group_members_group_id_fkey';
            columns: ['group_id'];
            isOneToOne: false;
            referencedRelation: 'dispatch_groups';
            referencedColumns: ['id'];
          }
        ];
      };
      work_sessions: {
        Row: {
          id: string;
          user_id: string;
          start_time: string;
          end_time: string | null;
          duration_minutes: number | null;
          created_at: string | null;
          last_heartbeat_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          start_time?: string;
          end_time?: string | null;
          duration_minutes?: number | null;
          created_at?: string | null;
          last_heartbeat_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          start_time?: string;
          end_time?: string | null;
          duration_minutes?: number | null;
          created_at?: string | null;
          last_heartbeat_at?: string | null;
        };
        Relationships: [];
      };
      employee_submit_time_settings: {
        Row: {
          id: string;
          user_id: string;
          group_id: string | null;
          min_seconds: number | null;
          max_seconds: number | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          group_id?: string | null;
          min_seconds?: number | null;
          max_seconds?: number | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          group_id?: string | null;
          min_seconds?: number | null;
          max_seconds?: number | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      submit_time_groups: {
        Row: {
          id: string;
          admin_id: string;
          name: string;
          min_seconds: number;
          max_seconds: number;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          admin_id: string;
          name: string;
          min_seconds?: number;
          max_seconds?: number;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          admin_id?: string;
          name?: string;
          min_seconds?: number;
          max_seconds?: number;
          created_at?: string | null;
        };
        Relationships: [];
      };
      valid_order_data: {
        Row: {
          id: string;
          product_value: number;
          transaction_id: string;
          is_active: boolean;
          created_by: string;
          created_at: string;
          updated_at: string | null;
          usage_count: number | null;
          last_used_at: string | null;
          deactivated_at: string | null;
          deactivation_reason: string | null;
          priority: number | null;
          tags: string[] | null;
        };
        Insert: {
          id?: string;
          product_value: number;
          transaction_id: string;
          is_active?: boolean | null;
          created_by: string;
          created_at?: string | null;
          updated_at?: string | null;
          usage_count?: number | null;
          last_used_at?: string | null;
          deactivated_at?: string | null;
          deactivation_reason?: string | null;
          priority?: number | null;
          tags?: string[] | null;
        };
        Update: {
          id?: string;
          product_value?: number;
          transaction_id?: string;
          is_active?: boolean | null;
          created_by?: string;
          created_at?: string | null;
          updated_at?: string | null;
          usage_count?: number | null;
          last_used_at?: string | null;
          deactivated_at?: string | null;
          deactivation_reason?: string | null;
          priority?: number | null;
          tags?: string[] | null;
        };
        Relationships: [];
      };
      used_order_data: {
        Row: {
          id: string;
          user_id: string;
          valid_order_data_id: string;
          order_id: string;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          valid_order_data_id: string;
          order_id: string;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          valid_order_data_id?: string;
          order_id?: string;
          created_at?: string | null;
        };
        Relationships: [];
      };
      message_templates: {
        Row: {
          id: string;
          admin_id: string;
          name: string;
          title: string;
          content: string;
          message_type: string;
          delivery_mode: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          priority: string;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          admin_id: string;
          name: string;
          title?: string;
          content?: string;
          message_type?: string;
          delivery_mode?: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          priority?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          admin_id?: string;
          name?: string;
          title?: string;
          content?: string;
          message_type?: string;
          delivery_mode?: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          priority?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          sender_id: string;
          sender_username: string;
          title: string;
          content: string;
          message_type: 'login_popup' | 'realtime';
          delivery_mode: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          priority: 'low' | 'normal' | 'high' | 'urgent';
          notification_category: 'standard' | 'performance_reward';
          reward_amount: number | null;
          reward_currency: string | null;
          automation_execution_id: string | null;
          audit_origin: 'manual_admin' | 'automation' | 'unverified';
          expires_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          sender_id: string;
          sender_username: string;
          title: string;
          content: string;
          message_type: string;
          delivery_mode?: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          priority?: string;
          notification_category?: 'standard' | 'performance_reward';
          reward_amount?: number | null;
          reward_currency?: string | null;
          automation_execution_id?: string | null;
          audit_origin?: 'manual_admin' | 'automation' | 'unverified';
          expires_at?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          sender_id?: string;
          sender_username?: string;
          title?: string;
          content?: string;
          message_type?: string;
          delivery_mode?: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          priority?: string;
          notification_category?: 'standard' | 'performance_reward';
          reward_amount?: number | null;
          reward_currency?: string | null;
          automation_execution_id?: string | null;
          audit_origin?: 'manual_admin' | 'automation' | 'unverified';
          expires_at?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      message_recipients: {
        Row: {
          id: string;
          message_id: string;
          recipient_id: string;
          is_read: boolean | null;
          read_at: string | null;
          is_shown: boolean | null;
          shown_at: string | null;
          delivery_channel: 'realtime' | 'login_popup' | null;
          delivery_claim_token: string | null;
          delivery_claim_channel: 'realtime' | 'login_popup' | null;
          delivery_claim_until: string | null;
          delivery_completed_claim_token: string | null;
          delivered_at: string | null;
          delivery_sequence: number;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          message_id: string;
          recipient_id: string;
          is_read?: boolean | null;
          read_at?: string | null;
          is_shown?: boolean | null;
          shown_at?: string | null;
          delivery_channel?: 'realtime' | 'login_popup' | null;
          delivery_claim_token?: string | null;
          delivery_claim_channel?: 'realtime' | 'login_popup' | null;
          delivery_claim_until?: string | null;
          delivery_completed_claim_token?: string | null;
          delivered_at?: string | null;
          delivery_sequence?: number;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          message_id?: string;
          recipient_id?: string;
          is_read?: boolean | null;
          read_at?: string | null;
          is_shown?: boolean | null;
          shown_at?: string | null;
          delivery_channel?: 'realtime' | 'login_popup' | null;
          delivery_claim_token?: string | null;
          delivery_claim_channel?: 'realtime' | 'login_popup' | null;
          delivery_claim_until?: string | null;
          delivery_completed_claim_token?: string | null;
          delivered_at?: string | null;
          delivery_sequence?: number;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'message_recipients_message_id_fkey';
            columns: ['message_id'];
            isOneToOne: false;
            referencedRelation: 'messages';
            referencedColumns: ['id'];
          }
        ];
      };
      announcement_categories: {
        Row: {
          id: string;
          name: string;
          display_order: number;
          icon_name: string;
          color_scheme: string;
          is_active: boolean | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          display_order: number;
          icon_name?: string;
          color_scheme?: string;
          is_active?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          display_order?: number;
          icon_name?: string;
          color_scheme?: string;
          is_active?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      data_retention_policies: {
        Row: {
          id: string;
          table_name: string;
          retention_days: number;
          cleanup_enabled: boolean | null;
          last_cleanup_at: string | null;
          records_cleaned_last_run: number | null;
          description: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          table_name: string;
          retention_days: number;
          cleanup_enabled?: boolean | null;
          last_cleanup_at?: string | null;
          records_cleaned_last_run?: number | null;
          description?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          table_name?: string;
          retention_days?: number;
          cleanup_enabled?: boolean | null;
          last_cleanup_at?: string | null;
          records_cleaned_last_run?: number | null;
          description?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      history_cleanup_config: {
        Row: {
          id: string;
          table_name: string;
          display_name: string;
          category: string;
          description: string;
          default_retention_days: number;
          min_retention_days: number;
          can_cleanup: boolean | null;
          requires_confirmation: boolean | null;
          cleanup_priority: number | null;
          last_cleanup_at: string | null;
          last_cleanup_records: number | null;
          created_at: string | null;
          updated_at: string | null;
          retention_days: number;
          auto_cleanup_enabled: boolean | null;
          cleanup_schedule: string | null;
          schedule_time_utc: string;
        };
        Insert: {
          id?: string;
          table_name: string;
          display_name: string;
          category: string;
          description: string;
          default_retention_days: number;
          min_retention_days: number;
          can_cleanup?: boolean | null;
          requires_confirmation?: boolean | null;
          cleanup_priority?: number | null;
          last_cleanup_at?: string | null;
          last_cleanup_records?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
          retention_days: number;
          auto_cleanup_enabled?: boolean | null;
          cleanup_schedule?: string | null;
          schedule_time_utc?: string;
        };
        Update: {
          id?: string;
          table_name?: string;
          display_name?: string;
          category?: string;
          description?: string;
          default_retention_days?: number;
          min_retention_days?: number;
          can_cleanup?: boolean | null;
          requires_confirmation?: boolean | null;
          cleanup_priority?: number | null;
          last_cleanup_at?: string | null;
          last_cleanup_records?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
          retention_days?: number;
          auto_cleanup_enabled?: boolean | null;
          cleanup_schedule?: string | null;
          schedule_time_utc?: string;
        };
        Relationships: [];
      };
      history_cleanup_log: {
        Row: {
          id: string;
          table_name: string;
          admin_id: string | null;
          records_deleted: number;
          space_freed: string | null;
          retention_days: number;
          status: string;
          message: string | null;
          error_details: string | null;
          created_at: string;
          run_source: 'manual' | 'automatic' | null;
          scheduled_for: string | null;
        };
        Insert: {
          id?: string;
          table_name: string;
          admin_id?: string | null;
          records_deleted?: number;
          space_freed?: string | null;
          retention_days: number;
          status: string;
          message?: string | null;
          error_details?: string | null;
          created_at?: string;
          run_source?: 'manual' | 'automatic' | null;
          scheduled_for?: string | null;
        };
        Update: {
          id?: string;
          table_name?: string;
          admin_id?: string | null;
          records_deleted?: number;
          space_freed?: string | null;
          retention_days?: number;
          status?: string;
          message?: string | null;
          error_details?: string | null;
          created_at?: string;
          run_source?: 'manual' | 'automatic' | null;
          scheduled_for?: string | null;
        };
        Relationships: [];
      };
      employee_login_history: {
        Row: {
          id: string;
          user_id: string;
          username: string;
          employee_id: string;
          action_type: 'login' | 'logout';
          ip_address: string | null;
          user_agent: string | null;
          session_id: string | null;
          device_info: unknown | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          username: string;
          employee_id: string;
          action_type: 'login' | 'logout';
          ip_address?: string | null;
          user_agent?: string | null;
          session_id?: string | null;
          device_info?: unknown | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          username?: string;
          employee_id?: string;
          action_type?: 'login' | 'logout';
          ip_address?: string | null;
          user_agent?: string | null;
          session_id?: string | null;
          device_info?: unknown | null;
          created_at?: string;
        };
        Relationships: [];
      };
      employee_login_history_events: {
        Row: {
          admin_id: string;
          event_type: 'INSERT' | 'UPDATE' | 'DELETE';
          occurred_at: string;
        };
        Insert: {
          admin_id: string;
          event_type: 'INSERT' | 'UPDATE' | 'DELETE';
          occurred_at?: string;
        };
        Update: {
          admin_id?: string;
          event_type?: 'INSERT' | 'UPDATE' | 'DELETE';
          occurred_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'employee_login_history_events_admin_id_fkey';
            columns: ['admin_id'];
            isOneToOne: true;
            referencedRelation: 'admins';
            referencedColumns: ['id'];
          }
        ];
      };
      employee_presence_events: {
        Row: {
          user_id: string;
          admin_id: string;
          status: 'online' | 'offline';
          occurred_at: string;
        };
        Insert: {
          user_id: string;
          admin_id: string;
          status: 'online' | 'offline';
          occurred_at?: string;
        };
        Update: {
          user_id?: string;
          admin_id?: string;
          status?: 'online' | 'offline';
          occurred_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'employee_presence_events_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'employee_presence_events_admin_id_fkey';
            columns: ['admin_id'];
            isOneToOne: false;
            referencedRelation: 'admins';
            referencedColumns: ['id'];
          }
        ];
      };
      notification_automation_plans: {
        Row: {
          id: string;
          owner_admin_id: string;
          name: string;
          description: string;
          status: 'active' | 'paused' | 'archived';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_admin_id: string;
          name: string;
          description?: string;
          status?: 'active' | 'paused' | 'archived';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_admin_id?: string;
          name?: string;
          description?: string;
          status?: 'active' | 'paused' | 'archived';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_automation_plans_owner_admin_id_fkey';
            columns: ['owner_admin_id'];
            isOneToOne: false;
            referencedRelation: 'admins';
            referencedColumns: ['id'];
          }
        ];
      };
      notification_automation_plan_members: {
        Row: {
          plan_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          plan_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          plan_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_automation_plan_members_plan_id_fkey';
            columns: ['plan_id'];
            isOneToOne: false;
            referencedRelation: 'notification_automation_plans';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_automation_plan_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          }
        ];
      };
      admins: {
        Row: {
          id: string;
          username: string;
          password_hash: string;
          role: 'super_admin' | 'secondary_admin' | 'emergency_admin';
          parent_id: string | null;
          is_active: boolean;
          is_pinned: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          username: string;
          password_hash: string;
          role: 'super_admin' | 'secondary_admin';
          parent_id?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          username?: string;
          password_hash?: string;
          role?: 'super_admin' | 'secondary_admin' | 'emergency_admin';
          parent_id?: string | null;
          is_active?: boolean;
          is_pinned?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      users: {
        Row: {
          id: string;
          username: string;
          password_hash: string;
          employee_id: string;
          is_verified: boolean;
          is_active: boolean;
          total_income: number;
          first_success_order_date: string | null;
          created_by: string;
          remarks: string;
          tags: string[];
          is_pinned: boolean;
          current_session_token: string | null;
          session_created_at: string | null;
          last_heartbeat_at: string | null;
          current_tab_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          username: string;
          password_hash: string;
          employee_id: string;
          is_verified?: boolean;
          is_active?: boolean;
          total_income?: number;
          first_success_order_date?: string | null;
          created_by: string;
          remarks?: string;
          tags?: string[];
          is_pinned?: boolean;
          current_session_token?: string | null;
          session_created_at?: string | null;
          last_heartbeat_at?: string | null;
          current_tab_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          username?: string;
          password_hash?: string;
          employee_id?: string;
          is_verified?: boolean;
          is_active?: boolean;
          total_income?: number;
          first_success_order_date?: string | null;
          created_by?: string;
          remarks?: string;
          tags?: string[];
          is_pinned?: boolean;
          current_session_token?: string | null;
          session_created_at?: string | null;
          last_heartbeat_at?: string | null;
          current_tab_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'wallets_user_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'wallets';
            referencedColumns: ['user_id'];
          }
        ];
      };
      product_types: {
        Row: {
          id: string;
          name: string;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          is_active?: boolean;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          user_id: string;
          username: string;
          product_type_id: string;
          product_value: number;
          order_number: string;
          transaction_id: string;
          status: 'processing' | 'success' | 'failure';
          commission_amount: number | null;
          commission_rate: number | null;
          dispatch_commission_rate_snapshot: number | null;
          dispatch_success_rate_snapshot: number | null;
          processed_at: string | null;
          scheduled_process_at: string | null;
          assignment_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          username: string;
          product_type_id: string;
          product_value: number;
          order_number: string;
          transaction_id: string;
          status?: 'processing' | 'success' | 'failure';
          commission_amount?: number | null;
          commission_rate?: number | null;
          dispatch_commission_rate_snapshot?: number | null;
          dispatch_success_rate_snapshot?: number | null;
          processed_at?: string | null;
          scheduled_process_at?: string | null;
          assignment_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          username?: string;
          product_type_id?: string;
          product_value?: number;
          order_number?: string;
          transaction_id?: string;
          status?: 'processing' | 'success' | 'failure';
          commission_amount?: number | null;
          commission_rate?: number | null;
          dispatch_commission_rate_snapshot?: number | null;
          dispatch_success_rate_snapshot?: number | null;
          processed_at?: string | null;
          scheduled_process_at?: string | null;
          assignment_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      wallets: {
        Row: {
          user_id: string;
          available_balance: number;
          frozen_balance: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          available_balance?: number;
          frozen_balance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          available_balance?: number;
          frozen_balance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      wallet_transactions: {
        Row: {
          id: string;
          user_id: string;
          type: 'commission' | 'withdrawal_request' | 'withdrawal_approved' | 'withdrawal_rejected' | 'withdrawal_correction' | 'manual_adjustment' | 'tip' | 'performance_bonus';
          amount: number;
          balance_before: number;
          balance_after: number;
          reference_id: string | null;
          remarks: string;
          created_by: string | null;
          operation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: 'commission' | 'withdrawal_request' | 'withdrawal_approved' | 'withdrawal_rejected' | 'withdrawal_correction' | 'manual_adjustment' | 'tip' | 'performance_bonus';
          amount: number;
          balance_before: number;
          balance_after: number;
          reference_id?: string | null;
          remarks?: string;
          created_by?: string | null;
          operation_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          type?: 'commission' | 'withdrawal_request' | 'withdrawal_approved' | 'withdrawal_rejected' | 'manual_adjustment' | 'tip';
          amount?: number;
          balance_before?: number;
          balance_after?: number;
          reference_id?: string | null;
          remarks?: string;
          created_by?: string | null;
          operation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      withdrawal_events: {
        Row: {
          user_id: string;
          admin_id: string | null;
          event_type: 'INSERT' | 'UPDATE' | 'DELETE';
          occurred_at: string;
        };
        Insert: {
          user_id: string;
          admin_id?: string | null;
          event_type: 'INSERT' | 'UPDATE' | 'DELETE';
          occurred_at?: string;
        };
        Update: {
          user_id?: string;
          admin_id?: string | null;
          event_type?: 'INSERT' | 'UPDATE' | 'DELETE';
          occurred_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'withdrawal_events_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'withdrawal_events_admin_id_fkey';
            columns: ['admin_id'];
            isOneToOne: false;
            referencedRelation: 'admins';
            referencedColumns: ['id'];
          }
        ];
      };
      withdrawals: {
        Row: {
          id: string;
          user_id: string;
          amount: number;
          status: 'pending' | 'approved' | 'rejected' | 'cancelled';
          audit_remark: string | null;
          audited_by: string | null;
          audited_at: string | null;
          last_operation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          amount: number;
          status?: 'pending' | 'approved' | 'rejected' | 'cancelled';
          audit_remark?: string | null;
          audited_by?: string | null;
          audited_at?: string | null;
          last_operation_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          amount?: number;
          status?: 'pending' | 'approved' | 'rejected' | 'cancelled';
          audit_remark?: string | null;
          audited_by?: string | null;
          audited_at?: string | null;
          last_operation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      admin_configs: {
        Row: {
          id: string;
          admin_id: string | null;
          config_type: string;
          config_value: string;
          icon_type: string | null;
          icon_custom_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          admin_id?: string | null;
          config_type: string;
          config_value: string;
          icon_type?: string | null;
          icon_custom_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          admin_id?: string | null;
          config_type?: string;
          config_value?: string;
          icon_type?: string | null;
          icon_custom_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      announcements: {
        Row: {
          id: string;
          title: string;
          content: string;
          is_pinned: boolean;
          publish_at: string;
          created_by: string;
          category: string;
          is_global: boolean;
          pin_order: number;
          is_hidden: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          content: string;
          is_pinned?: boolean;
          publish_at?: string;
          created_by: string;
          category?: string;
          is_global?: boolean;
          pin_order?: number;
          is_hidden?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          content?: string;
          is_pinned?: boolean;
          publish_at?: string;
          created_by?: string;
          category?: string;
          is_global?: boolean;
          pin_order?: number;
          is_hidden?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      cs_message_templates: {
        Row: {
          admin_id: string;
          content: string;
          content_type: 'text' | 'richtext' | 'rich_card';
          created_at: string;
          id: string;
          is_pinned: boolean;
          name: string;
          sort_order: number;
          source_type: 'aaa_service' | 'ccc_service';
          subtitle: string | null;
          title: string | null;
          updated_at: string;
        };
        Insert: {
          admin_id: string;
          content: string;
          content_type?: string;
          created_at?: string;
          id?: string;
          is_pinned?: boolean;
          name: string;
          sort_order?: number;
          source_type?: string;
          subtitle?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Update: {
          admin_id?: string;
          content?: string;
          content_type?: string;
          created_at?: string;
          id?: string;
          is_pinned?: boolean;
          name?: string;
          sort_order?: number;
          source_type?: string;
          subtitle?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_auto_messages: {
        Row: {
          admin_id: string;
          content: string;
          content_type: 'text' | 'richtext' | 'rich_card';
          created_at: string;
          customer_id: string;
          id: string;
          is_enabled: boolean;
          message_type: 'quick_send' | 'rich_card';
          name: string;
          sort_order: number;
          subtitle: string | null;
          title: string | null;
          updated_at: string;
        };
        Insert: {
          admin_id: string;
          content?: string;
          content_type?: string;
          created_at?: string;
          customer_id: string;
          id?: string;
          is_enabled?: boolean;
          message_type: string;
          name?: string;
          sort_order?: number;
          subtitle?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Update: {
          admin_id?: string;
          content?: string;
          content_type?: string;
          created_at?: string;
          customer_id?: string;
          id?: string;
          is_enabled?: boolean;
          message_type?: string;
          name?: string;
          sort_order?: number;
          subtitle?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_auto_message_logs: {
        Row: {
          id: string;
          customer_id: string;
          employee_id: string;
          auto_message_id: string;
          sent_at: string;
        };
        Insert: {
          id?: string;
          customer_id: string;
          employee_id: string;
          auto_message_id: string;
          sent_at?: string;
        };
        Update: {
          id?: string;
          customer_id?: string;
          employee_id?: string;
          auto_message_id?: string;
          sent_at?: string;
        };
        Relationships: [];
      };
      ccc_conversation_annotations: {
        Row: {
          customer_id: string;
          employee_id: string;
          owner_admin_id: string;
          is_special: boolean;
          note: string | null;
          updated_by: string | null;
          updated_at: string;
        };
        Insert: {
          customer_id: string;
          employee_id: string;
          owner_admin_id: string;
          is_special?: boolean;
          note?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Update: {
          customer_id?: string;
          employee_id?: string;
          owner_admin_id?: string;
          is_special?: boolean;
          note?: string | null;
          updated_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_employee_conversations: {
        Row: {
          created_at: string;
          customer_id: string;
          employee_id: string;
          id: string;
          image_url: string | null;
          is_read: boolean;
          message_content: string;
          message_type: 'text' | 'image' | 'rating_request' | 'rating_result' | 'tip' | 'rich_card';
          rating_data: { rating?: number; comment?: string | null; employee_id?: string; status?: string; tip_amount?: number } | null;
          read_at: string | null;
          rich_card_content_id: string | null;
          content_frozen: boolean;
          sender_type: 'customer' | 'employee';
          source_auto_message_id: string | null;
          source_template_id: string | null;
          source_type: string;
          subtitle: string | null;
          title: string | null;
        };
        Insert: {
          created_at?: string;
          customer_id: string;
          employee_id: string;
          id?: string;
          image_url?: string | null;
          is_read?: boolean | null;
          message_content: string;
          message_type?: string | null;
          rating_data?: { rating?: number; comment?: string | null; employee_id?: string; status?: string; tip_amount?: number } | null;
          read_at?: string | null;
          rich_card_content_id?: string | null;
          content_frozen?: boolean;
          sender_type: string;
          source_auto_message_id?: string | null;
          source_template_id?: string | null;
          source_type?: string;
          subtitle?: string | null;
          title?: string | null;
        };
        Update: {
          created_at?: string;
          customer_id?: string;
          employee_id?: string;
          id?: string;
          image_url?: string | null;
          is_read?: boolean | null;
          message_content?: string;
          message_type?: string | null;
          rating_data?: { rating?: number; comment?: string | null; employee_id?: string; status?: string; tip_amount?: number } | null;
          read_at?: string | null;
          rich_card_content_id?: string | null;
          content_frozen?: boolean;
          sender_type?: string;
          source_auto_message_id?: string | null;
          source_template_id?: string | null;
          source_type?: string;
          subtitle?: string | null;
          title?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'customer_employee_conversations_employee_id_fkey';
            columns: ['employee_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'customer_employee_conversations_customer_id_fkey';
            columns: ['customer_id', 'source_type'];
            isOneToOne: false;
            referencedRelation: 'simulated_customers';
            referencedColumns: ['id', 'source_type'];
          }
        ];
      };
      customer_service_sessions: {
        Row: {
          closed_at: string | null;
          created_at: string | null;
          customer_id: string;
          employee_id: string;
          id: string;
          service_ticket_number: string;
          status: string;
        };
        Insert: {
          closed_at?: string | null;
          created_at?: string | null;
          customer_id: string;
          employee_id: string;
          id?: string;
          service_ticket_number: string;
          status?: string;
        };
        Update: {
          closed_at?: string | null;
          created_at?: string | null;
          customer_id?: string;
          employee_id?: string;
          id?: string;
          service_ticket_number?: string;
          status?: string;
        };
        Relationships: [];
      };
      rich_card_contents: {
        Row: {
          created_at: string;
          html_content: string;
          id: string;
          source_auto_message_id: string | null;
          source_template_id: string | null;
        };
        Insert: {
          created_at?: string;
          html_content: string;
          id?: string;
          source_auto_message_id?: string | null;
          source_template_id?: string | null;
        };
        Update: {
          created_at?: string;
          html_content?: string;
          id?: string;
          source_auto_message_id?: string | null;
          source_template_id?: string | null;
        };
        Relationships: [];
      };
      simulated_customers: {
        Row: {
          admin_id: string;
          badge_type: string | null;
          customer_avatar: string;
          customer_id: string;
          customer_name: string;
          custom_avatar_url: string | null;
          employee_always_visible: boolean;
          employee_pin_top: boolean;
          id: string;
          is_active: boolean | null;
          is_super: boolean;
          super_customer_title: string | null;
          target_employee_id: string | null;
          target_employee_ids: string[] | null;
          vip_label: string | null;
          auto_messages_enabled: boolean;
          is_pinned: boolean;
          remarks: string | null;
          source_type: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          admin_id: string;
          badge_type?: string | null;
          customer_avatar?: string | null;
          customer_id: string;
          customer_name: string;
          custom_avatar_url?: string | null;
          employee_always_visible?: boolean;
          employee_pin_top?: boolean;
          id?: string;
          is_active?: boolean | null;
          is_super?: boolean;
          super_customer_title?: string | null;
          target_employee_id?: string | null;
          target_employee_ids?: string[] | null;
          vip_label?: string | null;
          auto_messages_enabled?: boolean;
          is_pinned?: boolean;
          remarks?: string | null;
          source_type?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          admin_id?: string;
          badge_type?: string | null;
          customer_avatar?: string | null;
          customer_id?: string;
          customer_name?: string;
          custom_avatar_url?: string | null;
          employee_always_visible?: boolean;
          employee_pin_top?: boolean;
          id?: string;
          is_active?: boolean | null;
          is_super?: boolean;
          super_customer_title?: string | null;
          target_employee_id?: string | null;
          target_employee_ids?: string[] | null;
          vip_label?: string | null;
          auto_messages_enabled?: boolean;
          is_pinned?: boolean;
          remarks?: string | null;
          source_type?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      commission_audit_log: {
        Row: {
          id: string;
          user_id: string;
          order_id: string | null;
          event_type: string;
          commission_amount: number;
          wallet_balance_before: number | null;
          wallet_balance_after: number | null;
          total_income_before: number | null;
          total_income_after: number | null;
          transaction_id: string | null;
          details: unknown;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          order_id?: string | null;
          event_type: string;
          commission_amount: number;
          wallet_balance_before?: number | null;
          wallet_balance_after?: number | null;
          total_income_before?: number | null;
          total_income_after?: number | null;
          transaction_id?: string | null;
          details?: unknown;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          order_id?: string | null;
          event_type?: string;
          commission_amount?: number;
          wallet_balance_before?: number | null;
          wallet_balance_after?: number | null;
          total_income_before?: number | null;
          total_income_after?: number | null;
          transaction_id?: string | null;
          details?: unknown;
          created_at?: string | null;
        };
        Relationships: [];
      };
      valid_order_data_archive: {
        Row: {
          id: string;
          product_value: number;
          transaction_id: string;
          usage_count: number | null;
          created_by: string;
          created_at: string;
          updated_at: string | null;
          deactivated_at: string;
          deactivation_reason: string | null;
          archived_at: string | null;
          total_users_used: number | null;
        };
        Insert: {
          id: string;
          product_value: number;
          transaction_id: string;
          usage_count?: number | null;
          created_by: string;
          created_at: string;
          updated_at?: string | null;
          deactivated_at: string;
          deactivation_reason?: string | null;
          archived_at?: string | null;
          total_users_used?: number | null;
        };
        Update: {
          id?: string;
          product_value?: number;
          transaction_id?: string;
          usage_count?: number | null;
          created_by?: string;
          created_at?: string;
          updated_at?: string | null;
          deactivated_at?: string;
          deactivation_reason?: string | null;
          archived_at?: string | null;
          total_users_used?: number | null;
        };
        Relationships: [];
      };
      orders_history: {
        Row: {
          id: string;
          user_id: string;
          product_type_id: string;
          product_value: number;
          transaction_id: string;
          status: string;
          screenshot_url: string | null;
          commission_amount: number | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
          archived_at: string;
        };
        Insert: {
          id: string;
          user_id: string;
          product_type_id: string;
          product_value: number;
          transaction_id: string;
          status: string;
          screenshot_url?: string | null;
          commission_amount?: number | null;
          created_at: string;
          updated_at: string;
          completed_at?: string | null;
          archived_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          product_type_id?: string;
          product_value?: number;
          transaction_id?: string;
          status?: string;
          screenshot_url?: string | null;
          commission_amount?: number | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
          archived_at?: string;
        };
        Relationships: [];
      };
      bulk_import_log: {
        Row: {
          id: string;
          table_name: string;
          import_type: string;
          total_records: number;
          records_imported: number | null;
          records_failed: number | null;
          started_at: string | null;
          completed_at: string | null;
          status: string | null;
          error_message: string | null;
          import_batch_size: number | null;
          performed_by: string | null;
          metadata: unknown;
        };
        Insert: {
          id?: string;
          table_name: string;
          import_type: string;
          total_records: number;
          records_imported?: number | null;
          records_failed?: number | null;
          started_at?: string | null;
          completed_at?: string | null;
          status?: string | null;
          error_message?: string | null;
          import_batch_size?: number | null;
          performed_by?: string | null;
          metadata?: unknown;
        };
        Update: {
          id?: string;
          table_name?: string;
          import_type?: string;
          total_records?: number;
          records_imported?: number | null;
          records_failed?: number | null;
          started_at?: string | null;
          completed_at?: string | null;
          status?: string | null;
          error_message?: string | null;
          import_batch_size?: number | null;
          performed_by?: string | null;
          metadata?: unknown;
        };
        Relationships: [];
      };
      dispatch_system_logs: {
        Row: {
          id: string;
          log_type: string;
          user_id: string | null;
          assignment_id: string | null;
          event_name: string;
          event_data: unknown;
          execution_time_ms: number | null;
          error_message: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          log_type: string;
          user_id?: string | null;
          assignment_id?: string | null;
          event_name: string;
          event_data?: unknown;
          execution_time_ms?: number | null;
          error_message?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          log_type?: string;
          user_id?: string | null;
          assignment_id?: string | null;
          event_name?: string;
          event_data?: unknown;
          execution_time_ms?: number | null;
          error_message?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      dispatch_performance_metrics: {
        Row: {
          id: string;
          metric_name: string;
          metric_value: number;
          metric_unit: string | null;
          metadata: unknown;
          measured_at: string | null;
        };
        Insert: {
          id?: string;
          metric_name: string;
          metric_value: number;
          metric_unit?: string | null;
          metadata?: unknown;
          measured_at?: string | null;
        };
        Update: {
          id?: string;
          metric_name?: string;
          metric_value?: number;
          metric_unit?: string | null;
          metadata?: unknown;
          measured_at?: string | null;
        };
        Relationships: [];
      };
      dispatch_rate_limits: {
        Row: {
          user_id: string;
          request_count: number | null;
          window_start: string | null;
          last_request_at: string | null;
        };
        Insert: {
          user_id: string;
          request_count?: number | null;
          window_start?: string | null;
          last_request_at?: string | null;
        };
        Update: {
          user_id?: string;
          request_count?: number | null;
          window_start?: string | null;
          last_request_at?: string | null;
        };
        Relationships: [];
      };
      verification_requests: {
        Row: {
          audit_remark: string | null;
          audited_at: string | null;
          audited_by: string | null;
          created_at: string;
          email: string;
          id: string;
          id_back_url: string | null;
          id_front_url: string | null;
          phone: string;
          real_name: string;
          selfie_url: string | null;
          status: 'pending' | 'approved' | 'rejected';
          updated_at: string;
          user_id: string;
          wallet_address: string;
        };
        Insert: {
          audit_remark?: string | null;
          audited_at?: string | null;
          audited_by?: string | null;
          created_at?: string | null;
          email: string;
          id?: string;
          id_back_url?: string | null;
          id_front_url?: string | null;
          phone: string;
          real_name: string;
          selfie_url?: string | null;
          status?: string;
          updated_at?: string | null;
          user_id: string;
          wallet_address: string;
        };
        Update: {
          audit_remark?: string | null;
          audited_at?: string | null;
          audited_by?: string | null;
          created_at?: string | null;
          email?: string;
          id?: string;
          id_back_url?: string | null;
          id_front_url?: string | null;
          phone?: string;
          real_name?: string;
          selfie_url?: string | null;
          status?: string;
          updated_at?: string | null;
          user_id?: string;
          wallet_address?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      history_cleanup_summary: {
        Row: {
          table_name: string;
          display_name: string;
          category: string;
          description: string;
          default_retention_days: number;
          min_retention_days: number;
          cleanup_priority: number;
          last_cleanup_at: string | null;
          last_cleanup_records: number;
          cleanup_status: string;
          current_record_count: number;
          current_size: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Functions: {
      employee_export_chat_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string;
          catalog: import('../lib/employeeTransfer/chatTransfer').ChatCatalog;
          scope: 'site-chat'; media_pending: true; full_site_complete: false };
      };
      get_employee_export_chat_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/chatTransfer').ChatPage;
      };
      employee_export_chat_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'site-chat'; media_pending: true; full_site_complete: false };
      };
      employee_export_chat_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'site-chat'; media_pending: true; full_site_complete: false };
      };
      employee_import_chat_bind: {
        Args: { p_admin_session_token: string; p_job_token: string;
          p_catalog: import('../lib/employeeTransfer/chatTransfer').ChatCatalog };
        Returns: { success: true; scope: 'site-chat'; repeated: boolean; media_pending: true; full_site_complete: false };
      };
      employee_import_chat_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_import_chat_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/chatTransfer').ChatPlan;
      };
      get_employee_import_chat_merge_plan: {
        Args: { p_admin_session_token: string; p_job_token: string; p_decisions: import('../lib/employeeTransfer/chatMergeApi').ChatMergeDecision[] };
        Returns: import('../lib/employeeTransfer/chatMergeApi').ChatMergePlan;
      };
      employee_import_chat_backup_prepare: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_decisions: import('../lib/employeeTransfer/chatMergeApi').ChatMergeDecision[] };
        Returns: import('../lib/employeeTransfer/chatBackup').ChatBackupDescriptor;
      };
      get_employee_import_chat_backup_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/chatTransfer').ChatPage;
      };
      employee_import_chat_backup_verify: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string };
        Returns: import('../lib/employeeTransfer/chatBackup').ChatBackupVerification;
      };
      employee_import_chat_backup_append: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string; p_chunk_no: number; p_hex: string };
        Returns: import('../lib/employeeTransfer/chatBackup').ChatBackupAppendReceipt;
      };
      employee_import_chat_backup_seal: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string; p_sha256: string; p_bytes: number };
        Returns: import('../lib/employeeTransfer/chatBackup').ChatBackupSealReceipt;
      };
      get_employee_chat_saved_backup_chunk: {
        Args: { p_admin_session_token: string; p_backup_id: string; p_chunk_no: number };
        Returns: import('../lib/employeeTransfer/chatMergeApi').ChatSavedBackupChunk;
      };
      get_employee_transfer_chat_media: {
        Args: { p_admin_session_token: string; p_job_token: string; p_direction: 'export' | 'import' };
        Returns: import('../lib/employeeTransfer/chatMedia').ChatMediaInventory;
      };
      employee_import_chat_media_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_files: import('../lib/employeeTransfer/chatMedia').ChatMediaFile[] };
        Returns: { success: true; version: 1; scope: 'site-chat-media'; files: number; bytes: number; repeated: boolean; full_site_complete: false };
      };
      employee_transfer_chat_media_authorize: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: EmployeeVerificationMediaAction; p_object_key: string };
        Returns: { direction: 'export' | 'import'; key: string; bucket: import('../lib/employeeTransfer/chatMedia').ChatMediaBucket;
          path: string; source_url: string; file: import('../lib/employeeTransfer/chatMedia').ChatMediaFile | null; avatar: boolean; generation: string };
      };
      employee_transfer_chat_media_commit: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: EmployeeVerificationMediaAction; p_object_key: string;
          p_bytes: number; p_sha256: string; p_content_type: import('../lib/employeeTransfer/chatMedia').ChatMediaType; p_storage_origin: string; p_generation: string };
        Returns: { success: true; key: string; bytes: number; sha256: string; content_type: import('../lib/employeeTransfer/chatMedia').ChatMediaType; full_site_complete: false };
      };
      employee_import_chat_begin: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: import('../lib/employeeTransfer/chatRestoreApi').ChatRestoreReceipt;
      };
      employee_import_chat_chunk: {
        Args: { p_admin_session_token: string; p_job_token: string; p_chunk_no: number };
        Returns: import('../lib/employeeTransfer/chatRestoreApi').ChatRestoreReceipt;
      };
      employee_import_chat_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/chatRestoreApi').ChatRestoreReceipt;
      };
      get_employee_import_chat_restore_status: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/chatRestoreApi').ChatRestoreReceipt;
      };
      get_employee_archive_reexport_inventory: {
        Args: { p_admin_session_token: string };
        Returns: import('../lib/employeeTransfer/archiveReexport').ArchiveReexportInventory;
      };
      get_employee_archive_reexport_catalog: {
        Args: { p_admin_session_token: string; p_source_site_id: string; p_package_id: string };
        Returns: import('../lib/employeeTransfer/archiveReexport').ArchiveReexportSnapshot;
      };
      get_employee_archive_reexport_page: {
        Args: { p_admin_session_token: string; p_source_site_id: string; p_package_id: string; p_snapshot_hash: string;
          p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesPage;
      };
      get_employee_archive_reexport_verify: {
        Args: { p_admin_session_token: string; p_source_site_id: string; p_package_id: string; p_snapshot_hash: string };
        Returns: { verified: true; scope: 'site-archives'; media_pending: true; full_site_complete: false };
      };
      get_employee_archive_reexport_media: {
        Args: { p_admin_session_token: string; p_source_site_id: string; p_package_id: string; p_snapshot_hash: string };
        Returns: import('../lib/employeeTransfer/archiveMedia').ArchiveMediaInventory;
      };
      get_employee_import_replacement_backup: {
        Args: { p_admin_session_token: string; p_job_token: string; p_source_employee_id: string };
        Returns: import('../lib/employeeTransfer/employeeBackup').EmployeeBackupCatalog;
      };
      get_employee_import_replacement_backup_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_source_employee_id: string;
          p_catalog_fingerprint: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_import_replacement_backup_verify: {
        Args: { p_admin_session_token: string; p_job_token: string; p_source_employee_id: string; p_catalog_fingerprint: string };
        Returns: Record<string, unknown>;
      };
      get_employee_transferred_archive_namespaces: {
        Args: { p_admin_session_token: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/archiveReader').TransferredArchiveNamespacesPage;
      };
      employee_transfer_archive_media_inventory: {
        Args: { p_admin_session_token: string; p_job_token: string; p_direction: string };
        Returns: import('../lib/employeeTransfer/archiveMedia').ArchiveMediaInventory;
      };
      employee_transfer_archive_media_status: {
        Args: { p_admin_session_token: string; p_job_token: string; p_direction: string };
        Returns: import('../lib/employeeTransfer/archiveMedia').ArchiveMediaInventory;
      };
      employee_transfer_archive_media_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_files: import('../lib/employeeTransfer/archiveMedia').ArchiveMediaFile[] };
        Returns: { success: true; files: number; bytes: number; repeated: boolean; full_site_complete: false };
      };
      employee_transfer_archive_media_verify: {
        Args: { p_admin_session_token: string; p_job_token: string; p_direction: string };
        Returns: import('../lib/employeeTransfer/archiveMedia').ArchiveMediaInventory;
      };
      employee_transfer_archive_media_authorize: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: string; p_object_key: string };
        Returns: Record<string, unknown>;
      };
      employee_transfer_archive_media_commit: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: string; p_object_key: string; p_bytes: number;
          p_sha256: string; p_content_type: string; p_storage_origin: string; p_generation: string };
        Returns: { success: true; key: string; bytes: number; sha256: string; content_type: string; full_site_complete: false };
      };
      employee_transfer_archive_media_read_authorize: {
        Args: { p_admin_session_token: string; p_source_site_id: string; p_package_id: string; p_event_id: string; p_ref_key: string };
        Returns: Record<string, unknown>;
      };
      employee_import_replacement_plan: {
        Args: { p_admin_session_token: string; p_job_token: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/employeeReplacement').EmployeeReplacementPlan;
      };
      employee_import_replacement_status: {
        Args: { p_admin_session_token: string; p_job_token: string; p_source_fingerprint: string; p_target_fingerprint: string;
          p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/employeeReplacement').EmployeeReplacementStatus;
      };
      employee_export_archives_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string;
          catalog: import('../lib/employeeTransfer/archiveTransfer').ArchivesCatalog; scope: 'site-archives'; media_pending: true; full_site_complete: false };
      };
      get_employee_export_archives_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesPage;
      };
      employee_export_archives_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'site-archives'; media_pending: true; full_site_complete: false };
      };
      employee_export_archives_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'site-archives'; media_pending: true; full_site_complete: false };
      };
      employee_import_archives_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_catalog: import('../lib/employeeTransfer/archiveTransfer').ArchivesCatalog };
        Returns: { success: true; scope: 'site-archives'; repeated: boolean; media_pending: true; full_site_complete: false };
      };
      employee_import_archives_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_import_archives_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesPlan;
      };
      employee_import_archives_begin: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesStatus;
      };
      employee_import_archives_chunk: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesStatus;
      };
      employee_import_archives_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesStatus;
      };
      get_employee_import_archives_status: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesStatus;
      };
      get_employee_transferred_archive_page: {
        Args: { p_admin_session_token: string; p_source_site_id: string; p_package_id: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/archiveTransfer').ArchivesPage;
      };
      employee_export_notifications_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string;
          catalog: import('../lib/employeeTransfer/notificationsTransfer').NotificationsCatalog;
          scope: 'site-notifications'; full_site_complete: false };
      };
      get_employee_export_notifications_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/notificationsTransfer').NotificationsPage;
      };
      employee_export_notifications_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'site-notifications'; media_pending: true; full_site_complete: false };
      };
      employee_export_notifications_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'site-notifications'; media_pending: true; full_site_complete: false };
      };
      employee_import_notifications_bind: {
        Args: { p_admin_session_token: string; p_job_token: string;
          p_catalog: import('../lib/employeeTransfer/notificationsTransfer').NotificationsCatalog };
        Returns: { success: true; scope: 'site-notifications'; repeated: boolean; full_site_complete: false };
      };
      employee_import_notifications_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_import_notifications_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/notificationsTransfer').NotificationsPlan;
      };
      get_employee_import_notification_configuration_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/notificationsConfigurationApi').NotificationConfigurationPlan;
      };
      employee_import_notification_backup_prepare: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: import('../lib/employeeTransfer/notificationsBackup').NotificationsBackupDescriptor;
      };
      get_employee_import_notification_backup_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: import('../lib/employeeTransfer/notificationsTransfer').NotificationsPage;
      };
      employee_import_notification_backup_verify: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string };
        Returns: import('../lib/employeeTransfer/notificationsBackup').NotificationsBackupVerification;
      };
      employee_import_notification_backup_append: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string; p_chunk_no: number; p_hex: string };
        Returns: import('../lib/employeeTransfer/notificationsBackup').NotificationsBackupAppendReceipt;
      };
      employee_import_notification_backup_seal: {
        Args: { p_admin_session_token: string; p_job_token: string; p_backup_id: string; p_sha256: string; p_bytes: number };
        Returns: import('../lib/employeeTransfer/notificationsBackup').NotificationsBackupSealReceipt;
      };
      get_employee_notification_saved_backup_chunk: {
        Args: { p_admin_session_token: string; p_backup_id: string; p_chunk_no: number };
        Returns: { backup_id: string; chunk_no: number; hex: string; sha256: string; bytes: number; chunks: number };
      };
      get_employee_transfer_notification_media: {
        Args: { p_admin_session_token: string; p_job_token: string; p_direction: 'export' | 'import' };
        Returns: import('../lib/employeeTransfer/notificationsMedia').NotificationsMediaInventory;
      };
      employee_import_notification_media_bind: {
        Args: { p_admin_session_token: string; p_job_token: string;
          p_files: import('../lib/employeeTransfer/notificationsMedia').NotificationsMediaFile[] };
        Returns: { success: true; scope: 'site-notifications-media'; files: number; bytes: number; repeated: boolean; full_site_complete: false };
      };
      employee_transfer_notification_media_authorize: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: EmployeeVerificationMediaAction; p_object_key: string };
        Returns: { direction: 'export' | 'import'; key: string;
          bucket: import('../lib/employeeTransfer/notificationsMedia').NotificationsMediaBucket; path: string; source_url: string;
          file: import('../lib/employeeTransfer/notificationsMedia').NotificationsMediaFile | null; generation: string };
      };
      employee_transfer_notification_media_commit: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: EmployeeVerificationMediaAction; p_object_key: string;
          p_bytes: number; p_sha256: string; p_content_type: import('../lib/employeeTransfer/notificationsMedia').NotificationsMediaType;
          p_storage_origin: string; p_generation: string };
        Returns: { success: true; key: string; bytes: number; sha256: string;
          content_type: import('../lib/employeeTransfer/notificationsMedia').NotificationsMediaType; full_site_complete: false };
      };
      employee_import_notifications_begin: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: import('../lib/employeeTransfer/notificationsRestoreApi').NotificationsRestoreReceipt;
      };
      employee_import_notifications_chunk: {
        Args: { p_admin_session_token: string; p_job_token: string; p_chunk_no: number };
        Returns: import('../lib/employeeTransfer/notificationsRestoreApi').NotificationsRestoreReceipt;
      };
      employee_import_notifications_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/notificationsRestoreApi').NotificationsRestoreReceipt;
      };
      get_employee_import_notifications_restore_status: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: import('../lib/employeeTransfer/notificationsRestoreApi').NotificationsRestoreReceipt;
      };
      employee_export_verification_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string; catalog: EmployeeVerificationCatalog; scope: 'employee-verification'; full_site_complete: false }
          | { success: false; error: 'Invalid credentials' }
          | { success: false; error: 'Account is temporarily locked.'; locked_until: string };
      };
      get_employee_export_verification_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: 'verification_requests'; p_after?: string | null; p_limit?: number };
        Returns: { table_key: 'verification_requests'; count: number; ndjson: string; next_after: string | null; sha256: string };
      };
      employee_export_verification_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'employee-verification'; full_site_complete: false };
      };
      employee_export_verification_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'employee-verification'; full_site_complete: false };
      };
      employee_import_verification_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_catalog: EmployeeVerificationCatalog };
        Returns: { success: true; scope: 'employee-verification'; full_site_complete: false; repeated: boolean };
      };
      employee_import_verification_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: 'verification_requests'; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_transfer_verification_media: {
        Args: { p_admin_session_token: string; p_job_token: string; p_direction: 'export' | 'import' };
        Returns: { scope: 'employee-verification-media'; direction: 'export' | 'import';
          files: { key: string; source_url: string; bucket: 'verification-documents'; path: string; file: EmployeeVerificationMediaFile | null }[];
          full_site_complete: false };
      };
      employee_import_verification_media_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_files: EmployeeVerificationMediaFile[] };
        Returns: { success: true; scope: 'employee-verification-media'; files: number; bytes: number; repeated: boolean; full_site_complete: false };
      };
      // Service-only RPCs. Declaring the SQL contract does not grant browser execution.
      employee_transfer_verification_media_authorize: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: EmployeeVerificationMediaAction; p_object_key: string };
        Returns: { direction: 'export' | 'import'; key: string; bucket: 'verification-documents'; path: string; source_url: string;
          file: EmployeeVerificationMediaFile | null; generation: string };
      };
      employee_transfer_verification_media_commit: {
        Args: { p_admin_session_token: string; p_job_token: string; p_action: EmployeeVerificationMediaAction; p_object_key: string;
          p_bytes: number; p_sha256: string; p_content_type: EmployeeVerificationMediaFile['content_type']; p_storage_origin: string; p_generation: string };
        Returns: { success: true; key: string; bytes: number; sha256: string; content_type: EmployeeVerificationMediaFile['content_type']; full_site_complete: false };
      };
      get_employee_import_verification_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeIdentityPending & { scope: 'employee-verification'; can_restore: boolean; counts: EmployeeVerificationCounts; employees: number;
          conflicts: ('verification_target_not_empty' | 'verification_uuid_collision' | 'source_employee_missing' | 'verification_admin_unmapped' | 'media_incomplete')[]; plan_hash: string };
      };
      employee_import_verification_apply: {
        Args: { p_admin_session_token: string; p_job_token: string; p_employee_id: string; p_plan_hash: string };
        Returns: EmployeeVerificationReceipt & { employee_id: string };
      };
      employee_import_verification_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeVerificationReceipt;
      };
      employee_export_activity_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string; catalog: EmployeeActivityCatalog; scope: 'employee-activity'; full_site_complete: false };
      };
      get_employee_export_activity_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: { table_key: string; count: number; ndjson: string; next_after: string | null; sha256: string };
      };
      employee_export_activity_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'employee-activity'; full_site_complete: false };
      };
      employee_export_activity_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'employee-activity'; full_site_complete: false };
      };
      employee_import_activity_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_catalog: Record<string, unknown> };
        Returns: { success: true; scope: 'employee-activity'; full_site_complete: false; repeated: boolean };
      };
      employee_import_activity_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_import_activity_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeIdentityPending & { scope: 'employee-activity'; can_restore: boolean; counts: EmployeeActivityCounts; employees: number;
          running_work_sessions: number; conflicts: ('activity_target_not_empty' | 'activity_uuid_collision' | 'source_employee_missing' | 'work_duration_out_of_range')[]; plan_hash: string };
      };
      employee_import_activity_apply: {
        Args: { p_admin_session_token: string; p_job_token: string; p_employee_id: string; p_plan_hash: string };
        Returns: EmployeeActivityReceipt & { employee_id: string };
      };
      employee_import_activity_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeActivityReceipt;
      };
      employee_export_finance_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string; catalog: EmployeeFinanceCatalog; scope: 'employee-finance'; full_site_complete: false };
      };
      get_employee_export_finance_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: { table_key: string; count: number; ndjson: string; next_after: string | null; sha256: string };
      };
      employee_export_finance_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'employee-finance'; full_site_complete: false };
      };
      employee_export_finance_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'employee-finance'; full_site_complete: false };
      };
      employee_import_finance_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_catalog: Record<string, unknown> };
        Returns: { success: true; scope: 'employee-finance'; full_site_complete: false; repeated: boolean };
      };
      employee_import_finance_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_import_finance_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeIdentityPending & { scope: 'employee-finance'; can_restore: boolean; counts: EmployeeFinanceCounts; employees: number;
          pending_withdrawals: { count: number; amount: string }; conflicts: ('financial_target_not_empty' | 'financial_uuid_collision' | 'financial_unique_collision' | 'unmapped_administrator' | 'inconsistent_source_finance' | 'source_employee_missing')[]; plan_hash: string };
      };
      employee_import_finance_apply: {
        Args: { p_admin_session_token: string; p_job_token: string; p_employee_id: string; p_plan_hash: string };
        Returns: EmployeeFinanceReceipt & { employee_id: string };
      };
      employee_import_finance_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeFinanceReceipt;
      };
      get_employee_import_dispatch_dependency_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeIdentityPending & { scope: 'dispatch-dependencies'; can_restore: boolean; counts: DispatchDependencyCounts;
          conflicts: ('target_members_not_empty' | 'target_used_not_empty' | 'unmapped_assigner')[]; plan_hash: string };
      };
      employee_import_dispatch_dependency_begin: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: DispatchDependencyReceipt;
      };
      employee_import_dispatch_dependency_chunk: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number };
        Returns: DispatchDependencyReceipt;
      };
      employee_import_dispatch_dependency_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: DispatchDependencyReceipt;
      };
      employee_export_identity_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
        Returns: { success: true; job_id: string; job_token: string; site_id: string; catalog: EmployeeIdentityCatalog;
          scope: 'employee-identity'; full_site_complete: false };
      };
      get_employee_export_identity_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: { table_key: 'accounts' | 'credentials' | 'orders'; count: number; ndjson: string; next_after: string | null; sha256: string };
      };
      employee_export_identity_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { verified: true; scope: 'employee-identity'; full_site_complete: false };
      };
      employee_export_identity_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'employee-identity'; full_site_complete: false };
      };
      employee_import_identity_bind: {
        Args: { p_admin_session_token: string; p_job_token: string; p_catalog: Record<string, unknown> };
        Returns: { success: true; scope: 'employee-identity'; full_site_complete: false; repeated: boolean };
      };
      employee_import_identity_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: { success: true; rows: number; bytes: number; sha256: string; repeated: boolean };
      };
      get_employee_import_identity_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeIdentityPending & { scope: 'employee-identity'; can_restore: boolean; counts: EmployeeIdentityCounts;
          conflicts: { source_id: string; reason: 'employee_id_conflict' | 'username_requires_archive' | 'employee_number_conflict'
            | 'administrator_username_conflict' | 'unmapped_administrator' | 'order_id_conflict' | 'placeholder_product_active'
            | 'dispatch_employee_missing' | 'used_order_missing_or_mismatched' }[]; plan_hash: string };
      };
      employee_import_identity_begin: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: EmployeeIdentityReceipt;
      };
      employee_import_identity_chunk: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number };
        Returns: EmployeeIdentityReceipt;
      };
      employee_import_identity_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: EmployeeIdentityReceipt;
      };
      employee_transfer_cancel: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: boolean; cancelled: boolean };
      };
      employee_export_dispatch_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string };
        Returns: Record<string, unknown>;
      };
      get_employee_export_dispatch_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_export_dispatch_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      employee_export_dispatch_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_dispatch_preflight: {
        Args: { p_admin_session_token: string };
        Returns: Record<string, unknown>;
      };
      employee_export_products_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string };
        Returns: Record<string, unknown>;
      };
      get_employee_export_products_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_export_products_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      employee_import_products_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string; p_catalog: Record<string, unknown> };
        Returns: Record<string, unknown>;
      };
      employee_import_products_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_chunk_no: number; p_ndjson: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_products_dry_run: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_products_backup: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_products_backup_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_import_products_backup_append: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_chunk_no: number; p_hex: string };
        Returns: Record<string, unknown>;
      };
      employee_import_products_backup_seal: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_sha256: string; p_bytes: number };
        Returns: Record<string, unknown>;
      };
      get_employee_products_saved_backup_chunk: {
        Args: { p_admin_session_token: string; p_backup_id: string; p_chunk_no: number };
        Returns: Record<string, unknown>;
      };
      employee_import_products_apply: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: Record<string, unknown>;
      };
      employee_products_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_replace_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string; p_catalog: Record<string, unknown> };
        Returns: Record<string, unknown>;
      };
      get_employee_import_shared_replace_dry_run: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      employee_import_dispatch_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string; p_catalog: Record<string, unknown> };
        Returns: Record<string, unknown>;
      };
      employee_import_dispatch_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_dispatch_dry_run: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_dispatch_backup: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_dispatch_backup_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_import_dispatch_backup_append: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_chunk_no: number; p_hex: string };
        Returns: Record<string, unknown>;
      };
      employee_import_dispatch_backup_seal: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_sha256: string; p_bytes: number };
        Returns: Record<string, unknown>;
      };
      get_employee_dispatch_saved_backup_chunk: {
        Args: { p_admin_session_token: string; p_backup_id: string; p_chunk_no: number };
        Returns: Record<string, unknown>;
      };
      employee_import_dispatch_enter_maintenance: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_confirmation: string; p_admin_password: string };
        Returns: { success: true; maintenance: true; dirty: false; repeated: boolean; full_site_complete: false };
      };
      get_employee_transfer_maintenance: {
        Args: { p_admin_session_token: string };
        Returns: { active: boolean; job_id: string | null; dirty: boolean; full_site_complete: false };
      };
      employee_transfer_leave_maintenance: {
        Args: { p_admin_session_token: string; p_job_id: string; p_admin_password: string; p_confirmation: string };
        Returns: { success: true; maintenance: false; full_site_complete: false };
      };
      get_employee_import_dispatch_configuration_plan: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: {
          scope: 'dispatch-configuration'; can_apply_configuration: boolean; full_site_complete: false; replacement_ready: false;
          conflicts: ('group_mapping_collision' | 'pool_mapping_collision' | 'reserved_retirement_name')[];
          group_map: Record<string, string>; pool_map: Record<string, string>; preparation_plan_hash: string; plan_hash: string;
        };
      };
      employee_import_dispatch_apply_configuration: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: {
          success: true; scope: 'dispatch-configuration'; configuration_applied: true; maintenance: true; dependencies_pending: true;
          replacement_ready: false; full_site_complete: false; repeated: boolean;
          group_map: Record<string, string>; pool_map: Record<string, string>;
        };
      };
      employee_import_dispatch_valid_begin: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: {
          success: true; scope: 'dispatch-valid-data'; rows: number; total_rows: number; next_chunk: number; chunks: number;
          verified: boolean; repeated: boolean; maintenance: true; dependencies_pending: true;
          replacement_ready: false; full_site_complete: false;
        };
      };
      employee_import_dispatch_valid_chunk: {
        Args: { p_admin_session_token: string; p_job_token: string; p_chunk_no: number };
        Returns: {
          success: true; scope: 'dispatch-valid-data'; rows: number; total_rows: number; next_chunk: number; chunks: number;
          verified: boolean; repeated: boolean; maintenance: true; dependencies_pending: true;
          replacement_ready: false; full_site_complete: false;
        };
      };
      employee_import_dispatch_valid_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: {
          success: true; scope: 'dispatch-valid-data'; rows: number; total_rows: number; next_chunk: number; chunks: number;
          verified: boolean; repeated: boolean; maintenance: true; dependencies_pending: true;
          replacement_ready: false; full_site_complete: false;
        };
      };
      get_employee_import_shared_backup: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_shared_backup_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_backup_append: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_chunk_no: number; p_hex: string };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_backup_seal: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string; p_sha256: string; p_bytes: number };
        Returns: Record<string, unknown>;
      };
      get_employee_shared_saved_backup_chunk: {
        Args: { p_admin_session_token: string; p_backup_id: string; p_chunk_no: number };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_replace_apply: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string; p_package_id: string; p_catalog: Record<string, unknown> };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_stage: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_chunk_no: number; p_ndjson: string };
        Returns: Record<string, unknown>;
      };
      get_employee_import_shared_dry_run: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      employee_import_shared_apply: {
        Args: { p_admin_session_token: string; p_job_token: string; p_plan_hash: string };
        Returns: Record<string, unknown>;
      };
      employee_export_shared_begin: {
        Args: { p_admin_session_token: string; p_admin_password: string };
        Returns: Record<string, unknown>;
      };
      get_employee_export_shared_catalog: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      get_employee_export_shared_page: {
        Args: { p_admin_session_token: string; p_job_token: string; p_table_key: string; p_after?: string | null; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      employee_export_shared_verify: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: Record<string, unknown>;
      };
      employee_export_shared_close: {
        Args: { p_admin_session_token: string; p_job_token: string };
        Returns: { success: true; scope: 'shared-settings'; full_site_complete: false };
      };
      get_employee_transfer_capabilities: {
        Args: { p_admin_session_token: string };
        Returns: import('../lib/employeeTransfer/siteTransfer').SiteTransferCapabilities;
      };
      get_employee_export_site_snapshot: {
        Args: { p_admin_session_token: string; p_package_id: string };
        Returns: Record<string, unknown>;
      };
      get_employee_transfer_log: {
        Args: { p_admin_session_token: string; p_limit?: number };
        Returns: Record<string, unknown>;
      };
      cancel_audit_deletion_confirmation: {
        Args: { p_admin_session_token: string; p_job_kind: 'content' | 'employee'; p_job_id: string };
        Returns: { success: boolean; cancelled: boolean };
      };
      prepare_deleted_employee_archive_delete: {
        Args: { p_admin_session_token: string; p_owner: string | null; p_search: string | null; p_record_id: string | null; p_notification_id: string | null };
        Returns: { job_id: string; account_count: number; notification_count: number };
      };
      finish_deleted_employee_archive_delete: {
        Args: { p_admin_session_token: string; p_job_id: string };
        Returns: {
          success: boolean;
          deleted_accounts: number;
          deleted_notifications: number;
          deleted_audit_events?: number;
          retained_shared_images: number;
          paths_to_remove: Array<{ bucket: string; path: string }>;
        };
      };
      complete_deleted_employee_archive_delete: {
        Args: { p_admin_session_token: string; p_job_id: string };
        Returns: { success: boolean };
      };
      list_pending_deleted_employee_archive_deletes: {
        Args: { p_admin_session_token: string };
        Returns: Array<{ job_id: string; file_count: number }>;
      };
      list_unpurged_archived_employees: {
        Args: { p_admin_session_token: string };
        Returns: Array<{
          employee_id: string;
          original_username: string | null;
          archived_alias: string;
          owner_username: string | null;
          archived_at: string;
          order_count: number;
          processing_order_count: number;
          historical_order_count: number;
          withdrawal_count: number;
          pending_withdrawal_count: number;
          available_balance: number | null;
          frozen_balance: number | null;
          audit_count: number;
          active_chat_count: number;
          candidate_image_count: number;
          quick_send_image_count: number;
        }>;
      };
      prepare_unpurged_archived_employee_delete: {
        Args: { p_admin_session_token: string; p_employee_id: string };
        Returns: { job_id: string; account_count: number; notification_count: number; original_username: string };
      };
      list_deleted_employee_notifications: {
        Args: { p_admin_session_token: string; p_record_id: string; p_page?: number; p_page_size?: number };
        Returns: { total: number; items: Array<Record<string, unknown>> };
      };
      get_deleted_employee_notification: {
        Args: { p_admin_session_token: string; p_notification_id: string };
        Returns: Record<string, unknown> | null;
      };
      list_deleted_employee_accounts: {
        Args: {
          p_admin_session_token: string;
          p_owner?: string | null;
          p_search?: string | null;
          p_source?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_page?: number;
          p_page_size?: number;
        };
        Returns: {
          total: number;
          owners: Array<{ id: string; username: string; event_count: number }>;
          items: Array<Record<string, unknown>>;
        };
      };
      get_deleted_employee_account: {
        Args: { p_admin_session_token: string; p_record_id: string; p_related_page?: number; p_related_page_size?: number; p_type?: string | null };
        Returns: Record<string, unknown> | null;
      };
      get_content_audit_filter_counts: {
        Args: { p_admin_session_token: string };
        Returns: {
          total: number;
          types: { notification: number; aaa_service: number; ccc_service: number };
          owners: Array<{ id: string; username: string; event_count: number }>;
        };
      };
      list_content_audit_owners: {
        Args: { p_admin_session_token: string };
        Returns: Array<{ id: string; username: string; event_count: number }>;
      };
      list_content_audit_cards_filtered: {
        Args: {
          p_admin_session_token: string;
          p_type?: string | null;
          p_owner?: string | null;
          p_action?: string | null;
          p_content_search?: string | null;
          p_identity_search?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_page?: number;
          p_page_size?: number;
        };
        Returns: { total: number; items: Array<Record<string, unknown>> };
      };
      list_content_audit_cards: {
        Args: {
          p_admin_session_token: string;
          p_type?: string | null;
          p_owner?: string | null;
          p_actor?: string | null;
          p_action?: string | null;
          p_search?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_page?: number;
          p_page_size?: number;
        };
        Returns: { total: number; items: Array<Record<string, unknown>> };
      };
      get_content_audit_conversation: {
        Args: {
          p_admin_session_token: string;
          p_operation_id: string;
          p_type: string;
          p_customer_id: string;
          p_employee_id: string;
          p_page?: number;
          p_page_size?: number;
        };
        Returns: Record<string, unknown> | null;
      };
      list_content_audit_events: {
        Args: {
          p_admin_session_token: string;
          p_type?: string | null;
          p_owner?: string | null;
          p_actor?: string | null;
          p_action?: string | null;
          p_search?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_page?: number;
          p_page_size?: number;
        };
        Returns: { total: number; items: Array<Record<string, unknown>> };
      };
      get_content_audit_event: {
        Args: { p_admin_session_token: string; p_event_id: string };
        Returns: Record<string, unknown> | null;
      };
      set_content_audit_purge_window: {
        Args: { p_admin_session_token: string; p_enabled: boolean };
        Returns: string | null;
      };
      create_admin_financial_session: {
        Args: { p_password: string; p_username: string };
        Returns: {
          success?: boolean;
          error?: string;
          session_token?: string;
          user?: Record<string, unknown>;
        };
      };
      create_employee_financial_session: {
        Args: { p_password: string; p_tab_id: string; p_username: string };
        Returns: {
          success?: boolean;
          error?: string;
          session_token?: string;
          session_marker?: string;
          user?: Record<string, unknown>;
        };
      };
      revoke_financial_session: {
        Args: { p_token: string };
        Returns: boolean;
      };
      reorder_product_types: {
        Args: { p_admin_session_token: string; p_product_type_ids: string[] };
        Returns: { success?: boolean; updated_count?: number; admin_id?: string };
      };
      admin_create_employee_account: {
        Args: {
          p_admin_session_token: string;
          p_created_by: string;
          p_employee_id: string;
          p_password: string;
          p_remarks: string;
          p_username: string;
          p_dispatch_group_id: string;
        };
        Returns: { success?: boolean; error?: string; user?: Record<string, unknown> };
      };
      admin_create_employee_account_with_automation_plan: {
        Args: {
          p_admin_session_token: string;
          p_username: string;
          p_password: string;
          p_employee_id: string;
          p_created_by: string;
          p_remarks: string;
          p_automation_plan_id: string | null;
          p_dispatch_group_id: string;
        };
        Returns: {
          success?: boolean;
          error?: string;
          user?: Record<string, unknown>;
          automation_plan_id?: string | null;
        };
      };
      admin_create_secondary_account: {
        Args: { p_admin_session_token: string; p_password: string; p_username: string };
        Returns: { success?: boolean; error?: string; user?: Record<string, unknown> };
      };
      admin_reset_employee_password: {
        Args: { p_admin_session_token: string; p_new_password: string; p_user_id: string };
        Returns: boolean;
      };
      admin_update_secondary_account: {
        Args: {
          p_admin_session_token: string;
          p_new_password?: string | null;
          p_target_admin_id: string;
          p_username: string;
        };
        Returns: boolean;
      };
      change_admin_password_atomic: {
        Args: { p_admin_session_token: string; p_current_password: string; p_new_password: string };
        Returns: boolean;
      };
      change_admin_username_atomic: {
        Args: { p_admin_session_token: string; p_current_password: string; p_new_username: string };
        Returns: { success?: boolean; user?: Record<string, unknown> };
      };
      change_employee_password_atomic: {
        Args: {
          p_current_password: string;
          p_new_password: string;
          p_session_token: string;
          p_tab_id: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      admin_update_employee_account: {
        Args: { p_admin_session_token: string; p_updates: Record<string, unknown>; p_user_id: string };
        Returns: Record<string, unknown>;
      };
      get_employee_management_snapshot: {
        Args: { p_admin_session_token: string };
        Returns: {
          admins: Array<{
            id: string;
            username: string;
            role: string;
            is_pinned: boolean;
          }>;
          employees: Array<{
            id: string;
            username: string;
            employee_id: string;
            is_verified: boolean;
            is_active: boolean;
            total_income: number;
            first_success_order_date: string | null;
            created_by: string;
            remarks: string;
            tags: string[];
            is_pinned: boolean;
            created_at: string;
            updated_at: string;
            walletBalance: number;
            verification: {
              real_name: string | null;
              wallet_address: string | null;
              phone: string | null;
              email: string | null;
            } | null;
            todayOrders: number;
            todayCompletedOrders: number;
            failedOrders: number;
            todayCommission: number;
            totalWorkMinutes: number;
            todayWorkMinutes: number;
            workDays: number;
            workStatus: 'online' | 'offline' | 'never_started';
            totalOrders: number;
            accountBalance: number;
            hasPendingWithdrawal: boolean;
            pendingWithdrawalAmount: number;
            pendingWithdrawalDate: string | null;
            pendingWithdrawals: Array<{
              id: string;
              amount: number;
              created_at: string;
            }>;
            statsLoaded: true;
          }>;
        };
      };
      get_employee_detail_summary_for_admin: {
        Args: { p_admin_session_token: string; p_user_id: string };
        Returns: {
          wallet: {
            available: number;
            frozen: number;
          };
          dailyStats: Array<{
            date: string;
            totalCommission: number;
            successCount: number;
            failureCount: number;
            totalOrders: number;
          }>;
          totalOrderCount: number;
          firstOrderDate: string | null;
          totalTipAmount: number;
          totalManualAdditionAmount: number;
          verification: {
            id: string;
            user_id: string;
            real_name: string;
            wallet_address: string;
            phone: string;
            email: string;
            status: 'pending' | 'approved' | 'rejected';
            audit_remark: string | null;
            audited_by: string | null;
            audited_at: string | null;
            id_front_url: string | null;
            id_back_url: string | null;
            selfie_url: string | null;
            created_at: string;
            updated_at: string;
          } | null;
        };
      };
      get_employee_transaction_page_for_admin: {
        Args: {
          p_admin_session_token: string;
          p_user_id: string;
          p_page: number;
          p_page_size: number;
          p_activity_date?: string | null;
        };
        Returns: {
          rows: Array<{
            id: string;
            type: 'commission' | 'withdrawal_request' | 'withdrawal_approved' | 'withdrawal_rejected' | 'withdrawal_correction' | 'manual_adjustment' | 'tip' | 'performance_bonus';
            amount: number;
            balance_before: number;
            balance_after: number;
            remarks: string | null;
            created_at: string | null;
            created_by: string | null;
            reference_id: string | null;
            activity_date: string | null;
          }>;
          total_count: number;
        };
      };
      get_employee_transaction_date_counts_for_admin: {
        Args: { p_admin_session_token: string; p_user_id: string };
        Returns: Array<{
          date: string;
          count: number;
        }>;
      };
      list_deleted_employee_withdrawals: {
        Args: { p_admin_session_token: string; p_record_id: string; p_page?: number; p_page_size?: number };
        Returns: { items: Array<{ id: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; created_at: string | null }>; total: number };
      };
      get_employee_withdrawal_page_for_admin: {
        Args: {
          p_admin_session_token: string;
          p_user_id: string;
          p_page: number;
          p_page_size: number;
        };
        Returns: {
          rows: Array<{
            id: string;
            amount: number;
            status: 'pending' | 'approved' | 'rejected' | 'cancelled';
            audit_remark: string | null;
            audited_at: string | null;
            created_at: string;
          }>;
          total_count: number;
        };
      };
      admin_set_employee_verification: {
        Args: { p_admin_session_token: string; p_is_verified: boolean; p_user_id: string };
        Returns: boolean;
      };
      archive_employee_without_media: {
        Args: { p_admin_session_token: string; p_user_id: string };
        Returns: { requires_audit_service: true; success?: never } | { success: boolean; changed_count: number; requires_audit_service?: never };
      };
      admin_delete_employee_account: {
        Args: { p_admin_session_token: string; p_user_id: string };
        Returns: boolean;
      };
      admin_delete_secondary_account: {
        Args: { p_admin_session_token: string; p_target_admin_id: string };
        Returns: boolean;
      };
      admin_update_admin_account: {
        Args: { p_admin_session_token: string; p_target_admin_id: string; p_updates: Record<string, unknown> };
        Returns: Record<string, unknown>;
      };
      request_employee_withdrawal: {
        Args: { p_operation_id: string; p_session_token: string; p_tab_id: string; p_user_id: string };
        Returns: { success?: boolean; error?: string; withdrawal_id?: string; amount?: number };
      };
      cancel_employee_withdrawal: {
        Args: {
          p_operation_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_user_id: string;
          p_withdrawal_id: string;
        };
        Returns: { success?: boolean; error?: string };
      };
      get_withdrawals_for_admin: {
        Args: { p_admin_session_token: string };
        Returns: Array<{
          id: string;
          user_id: string;
          amount: number;
          status: string;
          audit_remark: string | null;
          audited_by: string | null;
          audited_at: string | null;
          last_operation_id: string | null;
          created_at: string;
        }>;
      };
      get_withdrawal_review_data: {
        Args: { p_admin_session_token: string };
        Returns: {
          admin_id: string;
          admin_role: string;
          withdrawals: Array<{
            id: string;
            user_id: string;
            amount: number;
            status: string;
            audit_remark: string | null;
            audited_by: string | null;
            audited_at: string | null;
            last_operation_id: string | null;
            created_at: string;
          }>;
          employees: Array<{
            id: string;
            username: string;
            employee_id: string;
            created_by: string;
          }>;
          admins: Array<{
            id: string;
            username: string;
            role: string;
          }>;
        };
      };
      get_pending_withdrawal_count_for_admin: {
        Args: { p_admin_session_token: string };
        Returns: number;
      };
      review_withdrawal_atomic: {
        Args: {
          p_admin_session_token: string;
          p_operation_id: string;
          p_remark: string;
          p_status: string;
          p_withdrawal_id: string;
        };
        Returns: { success?: boolean; error?: string };
      };
      correct_withdrawal_status_atomic: {
        Args: {
          p_admin_session_token: string;
          p_operation_id: string;
          p_remark: string;
          p_status: string;
          p_withdrawal_id: string;
        };
        Returns: { success?: boolean; error?: string };
      };
      admin_adjust_wallet_balance_atomic: {
        Args: {
          p_admin_session_token: string;
          p_amount: number;
          p_operation_id: string;
          p_remarks: string;
          p_user_id: string;
        };
        Returns: { success?: boolean; error?: string };
      };
      send_customer_service_tip_atomic: {
        Args: {
          p_admin_session_token: string;
          p_amount: number;
          p_customer_id: string;
          p_employee_id: string;
          p_operation_id: string;
          p_source_type: string;
        };
        Returns: { success?: boolean; error?: string; message_id?: string };
      };
      cleanup_all_stale_sessions: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      reconcile_stale_dispatch_assignments: {
        Args: {
          p_submitted_timeout_minutes?: number;
          p_unsubmitted_timeout_minutes?: number;
        };
        Returns: {
          auto_completed?: number;
          auto_failed?: number;
          checked_at?: string;
          submitted_timed_out?: number;
          success?: boolean;
          unsubmitted_timed_out?: number;
        };
      };
      admin_save_dispatch_group: {
        Args: { p_admin_session_token: string; p_group_id: string | null; p_changes: Record<string, unknown> };
        Returns: { group: Database['public']['Tables']['dispatch_groups']['Row'] };
      };
      admin_save_dispatch_pool: {
        Args: { p_admin_session_token: string; p_group_id: string; p_pool_id: string | null; p_changes: Record<string, unknown> };
        Returns: { pool: Database['public']['Tables']['dispatch_order_pools']['Row'] };
      };
      admin_set_dispatch_pool_probabilities: {
        Args: { p_admin_session_token: string; p_group_id: string; p_probabilities: { pool_id: string; probability: number }[] };
        Returns: { pools: Database['public']['Tables']['dispatch_order_pools']['Row'][] };
      };
      admin_manage_dispatch_orders: {
        Args: {
          p_admin_session_token: string;
          p_pool_id: string;
          p_action: 'import' | 'edit' | 'toggle' | 'delete_permanent' | 'delete_all_permanent';
          p_order_id?: string | null;
          p_content?: string | null;
          p_contents?: string[] | null;
        };
        Returns: { success: boolean; action: string; affected: number; order: Database['public']['Tables']['dispatch_group_orders']['Row'] | null };
      };
      admin_assign_dispatch_group_member: {
        Args: { p_admin_session_token: string; p_user_id: string; p_group_id: string };
        Returns: { member: Database['public']['Tables']['dispatch_group_members']['Row'] };
      };
      get_employee_withdrawal_policy_secure: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string };
        Returns: {
          available: boolean;
          message?: string;
          group_id?: string;
          amount_threshold?: number;
          orders_threshold?: number;
          condition_mode?: 'OR' | 'AND' | 'amount_only' | 'days_only';
          completed_orders_count?: number;
          verified?: boolean;
          available_balance?: number;
          eligible?: boolean;
        };
      };
      get_employee_dispatch_submit_wait_secure: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string };
        Returns: {
          available: boolean;
          message?: string;
          min_seconds?: number;
          max_seconds?: number;
          assignment_id?: string | null;
          assignment_code?: string | null;
        };
      };
      prepare_next_dispatch_order_secure: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_session_id: string };
        Returns: {
          available: boolean;
          group_id?: string;
          pool_id?: string;
          due_at?: string;
          message?: string;
          auto_stopped?: boolean;
          config?: {
            dispatch_interval_min: number;
            dispatch_interval_max: number;
            session_timeout_minutes: number;
            dispatch_order_mode: 'random' | 'sequential';
            grab_success_rate: number;
          };
        };
      };
      assign_next_dispatch_order_secure: {
        Args: {
          p_user_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_session_id: string;
          p_group_id: string | null;
          p_dispatch_mode?: string;
        };
        Returns: {
          success?: boolean;
          message?: string;
          retry_selection?: boolean;
          due_at?: string;
          auto_stopped?: boolean;
          schedule_next?: boolean;
          unaccepted_count?: number;
          assignment?: {
            id: string;
            dispatch_order_id: string;
            status: string;
            assigned_at: string;
            order_content: string;
            dispatch_session_id: string;
            accept_deadline_at: string;
            group_id: string;
            pool_id: string;
            session_timeout_minutes: number;
          } | null;
        };
      };
      expire_pending_dispatch_assignment_secure: {
        Args: {
          p_user_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_session_id: string;
          p_assignment_id: string;
        };
        Returns: {
          success: boolean;
          reason: string;
          assignment_status?: string;
          accept_deadline_at?: string;
          schedule_next: boolean;
          auto_stopped: boolean;
          unaccepted_count: number;
        };
      };
      accept_dispatch_assignment_secure: {
        Args: {
          p_user_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_session_id: string;
          p_assignment_id: string;
          p_assignment_code: string;
        };
        Returns: {
          success: boolean;
          reason?: string;
          assignment_status?: string;
          assignment_id?: string;
          assignment_code?: string;
          accepted_at?: string;
          unaccepted_count?: number | null;
        };
      };
      finish_dispatch_assignment_secure: {
        Args: {
          p_user_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_assignment_id: string;
          p_status: string;
          p_remarks?: string | null;
        };
        Returns: { success: boolean; assignment_id: string | null; status: string };
      };
      mark_dispatch_assignment_submitted_secure: {
        Args: {
          p_user_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_assignment_id: string;
          p_assignment_code: string;
          p_order_id: string;
        };
        Returns: boolean;
      };
      resume_employee_dispatch_session_secure: {
        Args: {
          p_user_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_previous_session_id: string;
        };
        Returns: {
          success: boolean;
          session_id: string;
          started_at: string;
          unaccepted_count: number;
        };
      };
      recover_employee_dispatch_assignment_secure: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string };
        Returns: {
          success: boolean;
          recovered: boolean;
          session_id?: string;
          started_at?: string;
          unaccepted_count?: number;
          assignment?: {
            id: string;
            dispatch_order_id: string;
            user_id: string;
            status: string;
            assigned_at: string;
            accepted_at: string | null;
            completed_at: string | null;
            remarks: string | null;
            assignment_id: string | null;
            order_submitted: boolean;
            accept_deadline_at: string | null;
            dispatch_session_id: string;
            dispatch_orders: { order_content: string };
            session_timeout_minutes: number;
          } | null;
        };
      };
      assign_next_dispatch_order: {
        Args: {
          p_dispatch_mode?: string;
          p_group_id: string;
          p_user_id: string;
        };
        Returns: {
          success?: boolean;
          message?: string;
          assignment?: {
            id: string;
            dispatch_order_id: string;
            status: string;
            assigned_at: string;
            order_content: string;
          };
        };
      };
      get_account_locks_for_admin: {
        Args: { p_admin_id: string };
        Returns: Array<{
          admin_username: string;
          created_at: string;
          failed_attempts: number;
          id: string;
          identifier: string;
          identifier_type: string;
          lock_reason: string | null;
          lock_until: string;
          unlocked_at: string | null;
          unlocked_by: string | null;
          user_id: string | null;
          username: string | null;
          employee_id: string | null;
          lock_ip: string | null;
        }>;
      };
      get_account_lock_history_for_admin: {
        Args: { p_admin_id: string; p_limit?: number };
        Returns: Array<{
          admin_username: string | null;
          created_at: string;
          failed_attempts: number;
          id: string;
          identifier: string;
          identifier_type: string;
          lock_reason: string | null;
          lock_until: string;
          unlocked_at: string | null;
          unlocked_by: string | null;
          user_id: string | null;
          username: string | null;
          employee_id: string | null;
          lock_ip: string | null;
        }>;
      };
      get_active_work_session: {
        Args: { p_user_id: string };
        Returns: Array<{
          current_duration_minutes: number;
          session_id: string;
          start_time: string;
        }>;
      };
      start_work_session: {
        Args: { p_user_id: string };
        Returns: string;
      };
      end_work_session: {
        Args: { p_user_id: string };
        Returns: boolean;
      };
      update_session_heartbeat: {
        Args: { p_session_id: string };
        Returns: unknown;
      };
      start_employee_dispatch_session_secure: {
        Args: {
          p_session_token: string;
          p_tab_id: string;
          p_user_id: string;
        };
        Returns: {
          success: boolean;
          session_id: string;
          started_at: string;
        };
      };
      stop_employee_dispatch_session_secure: {
        Args: {
          p_session_id?: string | null;
          p_session_token: string;
          p_tab_id: string;
          p_user_id: string;
        };
        Returns: {
          success: boolean;
          session_id: string | null;
          stopped_count: number;
          ended_at: string | null;
          work_sessions_ended: number;
        };
      };
      end_employee_dispatch_session_secure: {
        Args: {
          p_session_id?: string | null;
          p_session_token: string;
          p_tab_id: string;
          p_user_id: string;
        };
        Returns: {
          success: boolean;
          session_id: string | null;
          stopped_count: number;
          ended_at: string | null;
          work_sessions_ended: number;
        };
      };
      update_session_heartbeat_secure: {
        Args: {
          p_session_id: string;
          p_session_token: string;
          p_tab_id: string;
          p_user_id: string;
        };
        Returns: {
          success: boolean;
          reason: string | null;
          session_id: string;
          user_id: string;
          heartbeat_at: string | null;
          work_sessions_updated: number;
        };
      };
      get_user_work_time_today: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_today_work_time: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_total_work_time: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_batch_work_time: {
        Args: { p_user_ids: string[] };
        Returns: Array<{
          today_work_minutes: number;
          total_work_minutes: number;
          user_id: string;
        }>;
      };
      get_batch_work_status: {
        Args: { p_user_ids: string[] };
        Returns: Array<{ user_id: string; work_status: string }>;
      };
      count_orders_by_user: {
        Args: { user_ids: string[] };
        Returns: Array<{ count: number; user_id: string }>;
      };
      count_order_days_by_user: {
        Args: { user_ids: string[] };
        Returns: Array<{ day_count: number; user_id: string }>;
      };
      count_today_orders_by_user: {
        Args: { today_start: string; user_ids: string[] };
        Returns: Array<{ count: number; user_id: string }>;
      };
      count_today_completed_orders_by_user: {
        Args: { today_start: string; user_ids: string[] };
        Returns: Array<{ count: number; user_id: string }>;
      };
      count_today_valid_data_failed_orders_by_user: {
        Args: { today_start: string; user_ids: string[] };
        Returns: Array<{ count: number; user_id: string }>;
      };
      get_admin_chat_unread_counts: {
        Args: { p_admin_session_token: string };
        Returns: Array<{
          admin_id: string;
          source_type: string;
          unread_count: number;
        }>;
      };
      get_admin_groups_for_customer_service: {
        Args: { p_source_type?: string };
        Returns: Array<{
          admin_id: string;
          admin_role: string;
          admin_username: string;
          conversation_count: number;
          customer_count: number;
          employee_count: number;
        }>;
      };
      get_ccc_conversation_annotations: {
        Args: { p_admin_session_token: string; p_owner_admin_id: string };
        Returns: Array<{
          customer_id: string;
          employee_id: string;
          is_special: boolean;
          note: string | null;
        }>;
      };
      update_ccc_conversation_annotation: {
        Args: {
          p_admin_session_token: string;
          p_customer_id: string;
          p_employee_id: string;
          p_is_special: boolean | null;
          p_note: string | null;
          p_update_note: boolean;
        };
        Returns: {
          customer_id: string;
          employee_id: string;
          is_special: boolean;
          note: string | null;
        };
      };
      get_ccc_conversation_summaries: {
        Args: { p_admin_id: string; p_source_type?: string };
        Returns: Array<{
          custom_avatar_url: string | null;
          customer_avatar: string | null;
          customer_id: string;
          customer_name: string;
          employee_id: string;
          employee_number: string;
          employee_username: string;
          last_message: string | null;
          last_message_time: string | null;
          last_message_type: string | null;
          message_count: number;
          unread_count: number;
        }>;
      };
      get_employee_unread_customer_messages_count: {
        Args: { p_employee_id: string };
        Returns: number;
      };
      search_all_employees_for_admin: {
        Args: {
          p_admin_session_token: string;
          p_search_term: string;
          p_limit?: number;
        };
        Returns: Array<{
          id: string;
          username: string;
          employee_id: string;
          created_at: string;
          is_active: boolean;
          is_verified: boolean;
          remarks: string | null;
          tags: string[];
          total_income: number;
          first_success_order_date: string | null;
          admin_info: {
            username: string;
            role: string;
          } | null;
          verification_info: {
            real_name: string | null;
            email: string | null;
            phone: string | null;
            wallet_address: string | null;
            created_at: string | null;
          } | null;
        }>;
      };
      get_employee_login_summary: {
        Args: { p_admin_id: string; p_search_term?: string | null };
        Returns: Array<{
          created_by: string;
          employee_id: string;
          is_active: boolean;
          is_pinned: boolean;
          latest_login_ip: string | null;
          latest_login_time: string | null;
          latest_login_device_info: unknown | null;
          latest_login_user_agent: string | null;
          latest_logout_ip: string | null;
          latest_logout_time: string | null;
          total_logins: number;
          user_id: string;
          username: string;
        }>;
      };
      get_employee_login_history: {
        Args: {
          p_admin_id: string;
          p_limit?: number;
          p_offset?: number;
          p_user_id: string;
        };
        Returns: Array<{
          action_type: string;
          created_at: string;
          id: string;
          ip_address: string;
          session_id: string;
          user_agent: string;
        }>;
      };
      get_employee_login_history_with_device_info: {
        Args: {
          p_admin_id: string;
          p_limit?: number;
          p_offset?: number;
          p_user_id: string;
        };
        Returns: Array<{
          action_type: string;
          created_at: string;
          device_info: unknown | null;
          id: string;
          ip_address: string | null;
          session_id: string | null;
          user_agent: string | null;
        }>;
      };
      get_admin_employees: {
        Args: { p_admin_id: string };
        Returns: Array<{
          admin_role: string;
          admin_username: string;
          completed_orders: number;
          created_at: string;
          employee_id: string;
          failed_orders: number;
          id: string;
          is_active: boolean;
          is_pinned: boolean;
          is_verified: boolean;
          remarks: string;
          tags: string[];
          today_commission: number;
          total_orders: number;
          username: string;
          wallet_balance: number;
        }>;
      };
      get_today_commission_by_user: {
        Args: { user_ids: string[] };
        Returns: Array<{ today_commission: number; user_id: string }>;
      };
      get_today_commission: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_overall_order_stats: {
        Args: { p_user_id: string };
        Returns: Array<{
          total_failed: number;
          total_orders: number;
          total_revenue: number;
          total_success: number;
        }>;
      };
      get_daily_order_stats: {
        Args: { p_user_id: string };
        Returns: Array<{
          daily_earnings: number;
          day_date: string;
          failure_count: number;
          success_count: number;
          total_orders: number;
        }>;
      };
      process_pending_orders: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      admin_save_shared_system_config: {
        Args: { p_admin_session_token: string; p_key: string; p_value: unknown };
        Returns: undefined;
      };
      admin_get_history_cleanup_schedule: {
        Args: { p_admin_session_token: string };
        Returns: Array<{
          table_name: string;
          days_to_keep: number;
          schedule_time: string;
          enabled: boolean;
          last_cleanup_at: string | null;
        }>;
      };
      admin_save_history_cleanup_schedule: {
        Args: {
          p_admin_session_token: string;
          p_table_name: string;
          p_days_to_keep: number;
          p_schedule_time: string;
          p_enabled: boolean;
        };
        Returns: undefined;
      };
      admin_preview_history_cleanup: {
        Args: { p_admin_session_token: string; p_table_name: string };
        Returns: Array<{
          table_name: string;
          total_records: number;
          records_to_delete: number;
          records_to_keep: number;
          oldest_record: string | null;
          cutoff_date: string;
          estimated_space: string;
          risk_level: string;
          retention_days: number;
        }>;
      };
      admin_execute_history_cleanup: {
        Args: {
          p_admin_session_token: string;
          p_table_name: string;
          p_expected_retention_days: number;
        };
        Returns: Array<{
          success: boolean;
          records_deleted: number;
          space_freed: string;
          execution_time_ms: number;
          message: string;
        }>;
      };
      execute_cleanup: {
        Args: {
          p_admin_session_token: string;
          p_days_to_keep: number;
          p_table_name: string;
        };
        Returns: Array<{
          execution_time_ms: number;
          message: string;
          records_deleted: number;
          space_freed: string;
          success: boolean;
        }>;
      };
      preview_cleanup: {
        Args: { p_days_to_keep: number; p_table_name: string };
        Returns: Array<{
          cutoff_date: string;
          estimated_space: string;
          oldest_record: string;
          records_to_delete: number;
          records_to_keep: number;
          risk_level: string;
          table_name: string;
          total_records: number;
        }>;
      };
      batch_delete_valid_order_data: {
        Args: { p_batch_size?: number };
        Returns: number;
      };
      batch_delete_dispatch_orders: {
        Args: { p_batch_size?: number; p_group_id: string };
        Returns: number;
      };
      get_notification_automation_dashboard: {
        Args: {
          p_admin_session_token: string;
          p_owner_admin_id?: string | null;
        };
        Returns: Record<string, unknown>;
      };
      get_notification_automation_dashboard_v2: {
        Args: {
          p_admin_session_token: string;
          p_owner_admin_id?: string | null;
        };
        Returns: Record<string, unknown>;
      };
      get_notification_automation_plan_assignments: {
        Args: { p_admin_session_token: string };
        Returns: Record<string, unknown>;
      };
      get_notification_automation_executions_v2: {
        Args: {
          p_admin_session_token: string;
          p_owner_admin_id: string;
          p_plan_id?: string | null;
          p_all_plans?: boolean;
          p_search_query?: string | null;
        };
        Returns: unknown[];
      };
      get_notification_automation_failures: {
        Args: {
          p_admin_session_token: string;
          p_owner_admin_id?: string | null;
        };
        Returns: unknown[];
      };
      save_notification_automation_plan: {
        Args: {
          p_admin_session_token: string;
          p_owner_admin_id: string;
          p_plan_id: string | null;
          p_name: string;
          p_description: string;
        };
        Returns: Record<string, unknown>;
      };
      set_notification_automation_plan_status: {
        Args: {
          p_admin_session_token: string;
          p_plan_id: string;
          p_status: 'active' | 'paused' | 'archived';
        };
        Returns: Record<string, unknown>;
      };
      delete_archived_notification_automation_plan: {
        Args: {
          p_admin_session_token: string;
          p_plan_id: string;
        };
        Returns: Record<string, unknown>;
      };
      set_notification_automation_plan_members: {
        Args: {
          p_admin_session_token: string;
          p_plan_id: string;
          p_user_ids: string[];
        };
        Returns: Record<string, unknown>;
      };
      set_notification_automation_plan_for_employee: {
        Args: {
          p_admin_session_token: string;
          p_user_id: string;
          p_plan_id: string | null;
        };
        Returns: Record<string, unknown>;
      };
      save_notification_automation_task_v2: {
        Args: {
          p_admin_session_token: string;
          p_owner_admin_id: string;
          p_plan_id: string | null;
          p_task_id: string | null;
          p_name: string;
          p_description: string;
          p_trigger_type: string;
          p_trigger_mode: string;
          p_threshold_value: number;
          p_minimum_daily_orders: number | null;
          p_minimum_daily_work_minutes: number | null;
          p_annual_month: number | null;
          p_annual_day: number | null;
          p_recipient_scope: string;
          p_recipient_ids: string[];
          p_title_template: string;
          p_content_template: string;
          p_delivery_mode: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          p_priority: string;
          p_reward_enabled: boolean;
          p_reward_amount: number | null;
          p_starts_at: string | null;
          p_ends_at: string | null;
        };
        Returns: Record<string, unknown>;
      };
      set_notification_automation_task_status_v2: {
        Args: {
          p_admin_session_token: string;
          p_task_id: string;
          p_status: string;
        };
        Returns: Record<string, unknown>;
      };
      save_notification_automation_task: {
        Args: {
          p_admin_session_token: string;
          p_task_id: string | null;
          p_name: string;
          p_description: string;
          p_trigger_type: string;
          p_trigger_mode: string;
          p_threshold_value: number;
          p_minimum_daily_orders: number | null;
          p_minimum_daily_work_minutes: number | null;
          p_recipient_scope: string;
          p_recipient_ids: string[];
          p_title_template: string;
          p_content_template: string;
          p_message_type: string;
          p_priority: string;
          p_reward_enabled: boolean;
          p_reward_amount: number | null;
          p_is_shared_template: boolean;
          p_starts_at: string | null;
          p_ends_at: string | null;
        };
        Returns: Record<string, unknown>;
      };
      save_notification_automation_task_copy: {
        Args: {
          p_admin_session_token: string;
          p_source_task_id: string;
          p_task_id: string | null;
          p_name: string;
          p_description: string;
          p_trigger_type: string;
          p_trigger_mode: string;
          p_threshold_value: number;
          p_minimum_daily_orders: number | null;
          p_minimum_daily_work_minutes: number | null;
          p_recipient_scope: string;
          p_recipient_ids: string[];
          p_title_template: string;
          p_content_template: string;
          p_message_type: string;
          p_priority: string;
          p_reward_enabled: boolean;
          p_reward_amount: number | null;
          p_is_shared_template: boolean;
          p_starts_at: string | null;
          p_ends_at: string | null;
        };
        Returns: Record<string, unknown>;
      };
      set_notification_automation_task_status: {
        Args: {
          p_admin_session_token: string;
          p_task_id: string;
          p_status: string;
        };
        Returns: Record<string, unknown>;
      };
      delete_notification_automation_task: {
        Args: {
          p_admin_session_token: string;
          p_task_id: string;
        };
        Returns: Record<string, unknown>;
      };
      copy_shared_notification_automation_task: {
        Args: { p_admin_session_token: string; p_source_task_id: string };
        Returns: Record<string, unknown>;
      };
      send_admin_message_secure: {
        Args: {
          p_admin_session_token: string;
          p_recipient_ids: string[];
          p_title: string;
          p_content: string;
          p_message_type: string;
          p_priority: string;
          p_reward_amount: number | null;
          p_operation_id: string;
        };
        Returns: Record<string, unknown>;
      };
      send_admin_message_with_delivery: {
        Args: {
          p_admin_session_token: string;
          p_recipient_ids: string[];
          p_title: string;
          p_content: string;
          p_delivery_mode: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          p_priority: string;
          p_reward_amount: number | null;
          p_operation_id: string;
        };
        Returns: Record<string, unknown>;
      };
      save_notification_automation_task_with_delivery: {
        Args: {
          p_admin_session_token: string;
          p_task_id: string | null;
          p_name: string;
          p_description: string;
          p_trigger_type: string;
          p_trigger_mode: string;
          p_threshold_value: number;
          p_minimum_daily_orders: number | null;
          p_minimum_daily_work_minutes: number | null;
          p_recipient_scope: string;
          p_recipient_ids: string[];
          p_title_template: string;
          p_content_template: string;
          p_delivery_mode: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          p_priority: string;
          p_reward_enabled: boolean;
          p_reward_amount: number | null;
          p_is_shared_template: boolean;
          p_starts_at: string | null;
          p_ends_at: string | null;
        };
        Returns: Record<string, unknown>;
      };
      save_notification_automation_task_copy_with_delivery: {
        Args: {
          p_admin_session_token: string;
          p_source_task_id: string;
          p_task_id: string | null;
          p_name: string;
          p_description: string;
          p_trigger_type: string;
          p_trigger_mode: string;
          p_threshold_value: number;
          p_minimum_daily_orders: number | null;
          p_minimum_daily_work_minutes: number | null;
          p_recipient_scope: string;
          p_recipient_ids: string[];
          p_title_template: string;
          p_content_template: string;
          p_delivery_mode: 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
          p_priority: string;
          p_reward_enabled: boolean;
          p_reward_amount: number | null;
          p_is_shared_template: boolean;
          p_starts_at: string | null;
          p_ends_at: string | null;
        };
        Returns: Record<string, unknown>;
      };
      copy_shared_notification_automation_task_with_delivery: {
        Args: { p_admin_session_token: string; p_source_task_id: string };
        Returns: Record<string, unknown>;
      };
      get_employee_notification_messages: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_filter?: string; p_limit?: number };
        Returns: unknown[];
      };
      mark_employee_notification_read: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_recipient_id: string };
        Returns: Record<string, unknown>;
      };
      update_admin_message_content_with_session: {
        Args: { p_admin_session_token: string; p_message_id: string; p_title: string; p_content: string };
        Returns: Record<string, unknown>;
      };
      claim_realtime_notification_delivery: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_recipient_id: string; p_lease_seconds?: number };
        Returns: Record<string, unknown> | null;
      };
      claim_next_realtime_notification_delivery: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_lease_seconds?: number };
        Returns: Record<string, unknown> | null;
      };
      has_pending_employee_login_notifications: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_combined_only?: boolean };
        Returns: boolean;
      };
      claim_next_login_notification_delivery: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_combined_only?: boolean; p_lease_seconds?: number };
        Returns: Record<string, unknown> | null;
      };
      complete_notification_delivery: {
        Args: { p_user_id: string; p_session_token: string; p_tab_id: string; p_recipient_id: string; p_claim_token: string; p_mark_read?: boolean };
        Returns: Record<string, unknown>;
      };
      delete_messages: {
        Args: { message_ids: string[]; requesting_admin_id: string };
        Returns: unknown;
      };
      delete_all_messages_for_admin: {
        Args: { requesting_admin_id: string; target_admin_id: string };
        Returns: unknown;
      };
      process_customer_service_tip: {
        Args: { p_amount: number; p_employee_id: string; p_message_id: string };
        Returns: { success?: boolean; error?: string };
      };
      log_employee_login: {
        Args: {
          p_employee_id: string;
          p_ip_address: string;
          p_session_id?: string | null;
          p_user_agent?: string;
          p_user_id: string;
          p_username: string;
        };
        Returns: string;
      };
      log_employee_logout_secure: {
        Args: {
          p_device_info: unknown | null;
          p_financial_token: string;
          p_session_id: string;
          p_tab_id: string;
          p_user_agent: string | null;
          p_user_id: string;
        };
        Returns: string;
      };
      log_employee_login_with_device_info: {
        Args: {
          p_device_info?: unknown | null;
          p_employee_id: string;
          p_ip_address: string;
          p_session_id?: string | null;
          p_user_agent?: string;
          p_user_id: string;
          p_username: string;
        };
        Returns: string;
      };
      check_login_rate_limit: {
        Args: { p_identifier: string; p_identifier_type: string };
        Returns: unknown;
      };
      unlock_account_with_permission_check: {
        Args: { p_admin_id: string; p_identifier: string; p_identifier_type: string };
        Returns: { success: boolean; message: string; unlocked_count?: number };
      };
      record_login_attempt: {
        Args: {
          p_identifier: string;
          p_identifier_type: string;
          p_ip_address?: string;
          p_success: boolean;
          p_user_agent?: string;
        };
        Returns: { success: boolean; locked?: boolean; lock_until?: string; lock_reason?: string; failed_attempts?: number; message?: string };
      };
      validate_employee_session: {
        Args: { p_session_token: string; p_tab_id?: string | null; p_user_id: string };
        Returns: boolean;
      };
      adjust_wallet_balance: {
        Args: {
          p_amount: number;
          p_created_by: string;
          p_remarks: string;
          p_user_id: string;
        };
        Returns: { success?: boolean; error?: string };
      };
      check_withdrawal_eligibility: {
        Args: { check_user_id: string };
        Returns: boolean;
      };
      mark_message_as_read: {
        Args: { message_id_param: string; user_id_param: string };
        Returns: boolean;
      };
      mark_login_popup_as_shown: {
        Args: { message_id_param: string; user_id_param: string };
        Returns: boolean;
      };
      get_unread_message_count: {
        Args: { user_id_param: string };
        Returns: number;
      };
      get_user_completed_orders_count: {
        Args: { p_user_id: string };
        Returns: number;
      };
      get_employee_conversation_summaries: {
        Args: { p_employee_id: string };
        Returns: Array<{
          badge_type: string | null;
          custom_avatar_url: string | null;
          customer_avatar: string | null;
          customer_display_id: string;
          customer_id: string;
          customer_name: string;
          employee_always_visible: boolean | null;
          employee_pin_top: boolean | null;
          is_super: boolean | null;
          last_customer_message_time: string | null;
          last_message: string | null;
          last_message_time: string | null;
          last_message_type: string | null;
          super_customer_title: string | null;
          target_employee_id: string | null;
          target_employee_ids: string[] | null;
          unread_count: number;
          vip_label: string | null;
        }>;
      };
      get_or_create_service_session: {
        Args: { p_customer_id: string; p_employee_id: string };
        Returns: Array<{
          created_at: string;
          service_ticket_number: string;
          session_id: string;
        }>;
      };
    };
  };
}
