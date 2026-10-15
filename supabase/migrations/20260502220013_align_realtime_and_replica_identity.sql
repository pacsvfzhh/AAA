/*
  # 对齐 Realtime 发布与 Replica Identity

  1. 将 orders 表加入 supabase_realtime 发布
     - 前端 OrderList / EmployeeManagement / DispatchManagement / DispatchRecords 订阅了 orders 的变更
     - 不加入会导致这些页面无法实时刷新
  2. 将关键业务表的 REPLICA IDENTITY 设为 FULL
     - 让 UPDATE / DELETE 事件携带完整旧行数据，便于前端按非主键字段匹配
     - 涉及表：orders, wallets, admins, account_locks, customer_service_sessions

  说明：以上更改均为元数据层面，不会影响现有数据。
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;
END $$;

ALTER TABLE public.orders REPLICA IDENTITY FULL;
ALTER TABLE public.wallets REPLICA IDENTITY FULL;
ALTER TABLE public.admins REPLICA IDENTITY FULL;
ALTER TABLE public.account_locks REPLICA IDENTITY FULL;
ALTER TABLE public.customer_service_sessions REPLICA IDENTITY FULL;
