/*
  # Fix Dispatch Groups Deletion - Preserve Historical Data
  
  1. Overview
    - When deleting a dispatch group, preserve historical data
    - Group orders, member relationships, and assignments should be kept as historical records
    - Only actual user deletion should clean up user-specific data
  
  2. Changes
    - `dispatch_group_orders.group_id`: CASCADE → RESTRICT
      - Prevents deletion if group has orders (historical data)
      - Admin must manually handle or reassign orders before deleting group
    
    - `dispatch_group_members.group_id`: CASCADE → RESTRICT
      - Prevents deletion if group has members
      - Admin must remove members first before deleting group
  
  3. Rationale
    - Historical派单记录很重要，不应该因为删除分组而丢失
    - 成员关系是审计追踪的一部分
    - 管理员应该明确处理这些关系，而不是自动删除
  
  4. Admin Workflow (删除分组的正确流程)
    Step 1: Remove all members from the group (or reassign to other groups)
    Step 2: Deactivate or reassign all orders in the group
    Step 3: Then delete the empty group
  
  5. Notes
    - This prevents accidental data loss
    - Maintains audit trail and historical records
    - Forces deliberate cleanup process
*/

-- Drop existing foreign key constraints
ALTER TABLE dispatch_group_orders 
  DROP CONSTRAINT IF EXISTS dispatch_group_orders_group_id_fkey;

ALTER TABLE dispatch_group_members 
  DROP CONSTRAINT IF EXISTS dispatch_group_members_group_id_fkey;

-- Recreate with RESTRICT to preserve historical data
ALTER TABLE dispatch_group_orders
  ADD CONSTRAINT dispatch_group_orders_group_id_fkey
  FOREIGN KEY (group_id)
  REFERENCES dispatch_groups(id)
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE dispatch_group_members
  ADD CONSTRAINT dispatch_group_members_group_id_fkey
  FOREIGN KEY (group_id)
  REFERENCES dispatch_groups(id)
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- Add helpful comments
COMMENT ON CONSTRAINT dispatch_group_orders_group_id_fkey ON dispatch_group_orders IS 
  '防止删除有订单的分组，保留历史数据。删除分组前必须先处理所有订单。';

COMMENT ON CONSTRAINT dispatch_group_members_group_id_fkey ON dispatch_group_members IS 
  '防止删除有成员的分组，保留历史数据。删除分组前必须先移除所有成员。';
