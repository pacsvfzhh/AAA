export interface Admin {
  id: string;
  username: string;
  admin_id?: string;
  role: 'super_admin' | 'secondary_admin' | 'emergency_admin';
  parent_id: string | null;
  is_active: boolean;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export type AutomationPlanStatus = 'active' | 'paused' | 'archived';

export interface NotificationAutomationPlan {
  id: string;
  owner_admin_id: string;
  name: string;
  description: string;
  status: AutomationPlanStatus;
  member_count?: number;
  task_count?: number;
  active_task_count?: number;
  selected_task_count?: number;
  all_managed_task_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface NotificationAutomationPlanAssignment {
  user_id: string;
  plan_id: string;
  plan_name: string;
  plan_status: AutomationPlanStatus;
}

export interface Employee {
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
  automation_plan_id?: string | null;
  automation_plan_name?: string | null;
  current_session_token?: string | null;
  session_created_at?: string | null;
  last_heartbeat_at?: string | null;
  current_tab_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductType {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Order {
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
  processed_at: string | null;
  created_at: string;
}

export interface Wallet {
  user_id: string;
  available_balance: number;
  frozen_balance: number;
  created_at: string;
  updated_at: string;
}

export interface WalletTransaction {
  id: string;
  user_id: string;
  type: 'commission' | 'withdrawal_request' | 'withdrawal_approved' | 'withdrawal_rejected' | 'withdrawal_correction' | 'manual_adjustment' | 'tip' | 'performance_bonus';
  amount: number;
  balance_before: number;
  balance_after: number;
  reference_id: string | null;
  remarks: string;
  created_by: string | null;
  operation_id?: string | null;
  created_at: string;
}

export interface Withdrawal {
  id: string;
  user_id: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'processed';
  audit_remark: string | null;
  audited_by: string | null;
  audited_at: string | null;
  last_operation_id?: string | null;
  created_at: string;
}

export interface AdminConfig {
  id: string;
  admin_id: string | null;
  config_type: 'commission_rate' | 'success_rate' | 'withdrawal_amount_threshold' | 'withdrawal_days_threshold';
  config_value: string;
  created_at: string;
  updated_at: string;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  is_global: boolean;
  is_hidden: boolean;
  pin_order: number;
  category: string | null;
  publish_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementListItem {
  id: string;
  title: string;
  is_pinned: boolean;
  is_global: boolean;
  is_hidden: boolean;
  pin_order: number;
  category: string | null;
  publish_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface VerificationRequest {
  id: string;
  user_id: string;
  real_name: string;
  wallet_address: string;
  phone: string;
  email: string;
  id_front_url: string | null;
  id_back_url: string | null;
  selfie_url: string | null;
  status: 'pending' | 'approved' | 'rejected';
  audit_remark: string | null;
  audited_by: string | null;
  audited_at: string | null;
  created_at: string;
  updated_at: string;
}

export type NotificationDeliveryMode = 'realtime_only' | 'login_only' | 'realtime_with_login_fallback';
export type NotificationDeliveryChannel = 'realtime' | 'login_popup';

export interface Message {
  id: string;
  sender_id?: string;
  sender_username: string;
  title: string;
  content: string;
  message_type: 'login_popup' | 'realtime';
  delivery_mode: NotificationDeliveryMode;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  notification_category?: 'standard' | 'performance_reward';
  reward_amount?: number | null;
  reward_currency?: string | null;
  automation_execution_id?: string | null;
  expires_at?: string | null;
  created_at: string | null;
}

export interface MessageRecipient {
  id: string;
  message_id: string;
  recipient_id: string;
  is_read: boolean | null;
  read_at: string | null;
  is_shown: boolean | null;
  shown_at: string | null;
  delivery_channel: NotificationDeliveryChannel | null;
  delivery_claim_token: string | null;
  delivery_claim_channel: NotificationDeliveryChannel | null;
  delivery_claim_until: string | null;
  delivery_completed_claim_token: string | null;
  delivered_at: string | null;
  delivery_sequence: number;
  created_at: string | null;
}

export interface MessageWithRecipient extends MessageRecipient {
  messages: Message;
}

export interface MessageStats {
  total_recipients: number;
  read_count: number;
  unread_count: number;
  read_percentage: number;
}

export interface AdminGroup {
  id: string;
  username: string;
  role: 'super_admin' | 'secondary_admin' | 'emergency_admin';
  total_employees: number;
  active_employees: number;
  verified_employees: number;
}

export type AuthState =
  | { user: null; userType: null }
  | { user: Admin; userType: 'admin' }
  | { user: Employee; userType: 'employee' };
