-- =====================================================================
-- 数据库迁移检测（一）：结构与运行健康检查（只读，不会修改任何数据）
--
-- 用法：在新 Supabase 项目的 SQL Editor 中粘贴全部内容并运行。
--   * 建议迁移完成后至少等 5 分钟再运行，让定时任务先跑几轮。
--   * 第一行「总结」给出失败 / 警告 / 提示 / 通过的数量；失败项排在最前。
--   * 结构部分对比的是下方内嵌的「旧正式库结构基线」（生成时间见总结行）。
--     旧库之后若部署过数据库更新，需要重新生成基线：把下方两个 baseline
--     标记之间的内容清空后在旧库运行，复制「当前结构指纹」那一格，粘贴回
--     两个 baseline 标记之间。
--   * SQL 无法检查：Edge Function、实际文件内容、项目 API/上传设置、
--     前端环境变量。这些请按结果中的「提示」另行确认。
-- =====================================================================
set search_path = pg_catalog, pg_temp;
set time zone 'UTC';
set transaction read only;

with
baseline_raw as (
  select $baseline$
#generated 2026-10-26 21:45 UTC（旧正式库 hxpbpqoqkoiiplvdwmld）
buckets|announcement-images|lim=104857600|mime=image/gif,image/jpeg,image/jpg,image/png,image/webp,video/mp4,video/ogg,video/webm|pub=true
buckets|chat-images|lim=不限|mime=不限|pub=true
buckets|content-audit-evidence|lim=不限|mime=不限|pub=false
buckets|super-customer-avatars|lim=5242880|mime=image/gif,image/jpeg,image/jpg,image/png,image/webp|pub=true
buckets|template-images|lim=不限|mime=不限|pub=true
buckets|verification-documents|lim=不限|mime=不限|pub=true
buckets|website-icons|lim=5242880|mime=image/jpeg,image/jpg,image/png,image/svg+xml|pub=true
cron|auto_cleanup_due_history_data_every_minute|act=true|cmd=SELECT public.auto_cleanup_due_history_data();|db=postgres|sch=* * * * *|usr=postgres
cron|collect-audit-deletion-confirmations|act=true|cmd=SELECT private.collect_audit_deletion_confirmations();|db=postgres|sch=* * * * *|usr=postgres
cron|enqueue-daily-wallet-reconciliation|act=true|cmd=SELECT public.enqueue_all_wallets_for_reconciliation();|db=postgres|sch=17 3 * * *|usr=postgres
cron|process_notification_automation_queue_every_five_seconds|act=true|cmd=CALL private.run_notification_automation_queue(200, false);|db=postgres|sch=5 seconds|usr=postgres
cron|process_notification_automation_queue_every_minute|act=true|cmd=CALL private.run_notification_automation_queue(200, true);|db=postgres|sch=* * * * *|usr=postgres
cron|process_pending_orders_every_minute|act=true|cmd=SELECT public.process_pending_orders();|db=postgres|sch=* * * * *|usr=postgres
cron|process-wallet-reconciliation-queue|act=true|cmd=SELECT public.process_wallet_reconciliation_queue(100);|db=postgres|sch=* * * * *|usr=postgres
cron|reconcile_dispatch_lifecycle_every_minute|act=true|cmd=SELECT public.auto_cleanup_dispatch_system();|db=postgres|sch=* * * * *|usr=postgres
cron|weekly_cleanup_practice_data|act=true|cmd=SELECT public.cleanup_all_practice_data();|db=postgres|sch=0 2 * * 0|usr=postgres
event_triggers|issue_graphql_placeholder|en=O|fn=extensions.set_graphql_placeholder
event_triggers|issue_pg_cron_access|en=O|fn=extensions.grant_pg_cron_access
event_triggers|issue_pg_graphql_access|en=O|fn=extensions.grant_pg_graphql_access
event_triggers|issue_pg_net_access|en=O|fn=extensions.grant_pg_net_access
event_triggers|pgrst_ddl_watch|en=O|fn=extensions.pgrst_ddl_watch
event_triggers|pgrst_drop_watch|en=O|fn=extensions.pgrst_drop_watch
ext_triggers|storage.objects.guard_content_audit_public_media_upload|d=44052608
extensions|pg_cron|s=pg_catalog|v=1.6.4
extensions|pg_stat_statements|s=extensions|v=1.11
extensions|pg_trgm|s=extensions|v=1.6
extensions|pgcrypto|s=extensions|v=1.3
extensions|plpgsql|s=pg_catalog|v=1.0
extensions|supabase_vault|s=vault|v=0.3.1
extensions|uuid-ossp|s=extensions|v=1.1
meta|locale|v=en_US.UTF-8 / en_US.UTF-8 / UTF8
meta|pg_major|v=17
meta|realtime_pub|v=insert=true,update=true,delete=true,truncate=true,all_tables=false
meta|timezone|v=UTC
realtime|public.account_lock_events|in=已加入
realtime|public.account_locks|in=已加入
realtime|public.admin_configs|in=已加入
realtime|public.admins|in=已加入
realtime|public.announcements|in=已加入
realtime|public.customer_employee_conversations|in=已加入
realtime|public.dispatch_group_members|in=已加入
realtime|public.dispatch_group_orders|in=已加入
realtime|public.dispatch_groups|in=已加入
realtime|public.dispatch_order_pools|in=已加入
realtime|public.dispatch_sessions|in=已加入
realtime|public.employee_login_history_events|in=已加入
realtime|public.employee_presence_events|in=已加入
realtime|public.message_recipients|in=已加入
realtime|public.orders|in=已加入
realtime|public.product_types|in=已加入
realtime|public.rating_requests|in=已加入
realtime|public.system_configs|in=已加入
realtime|public.users|in=已加入
realtime|public.verification_requests|in=已加入
realtime|public.wallet_transactions|in=已加入
realtime|public.wallets|in=已加入
realtime|public.withdrawal_events|in=已加入
realtime|public.work_sessions|in=已加入
roles|anon|cfg=statement_timeout=3s
roles|authenticated|cfg=statement_timeout=8s
roles|authenticator|cfg=lock_timeout=8s;session_preload_libraries=safeupdate;statement_timeout=8s
schemas|private|a=334c4a4c|o=postgres
schemas|public|a=83da5a00|o=pg_database_owner
sequences|private.employee_login_maintenance_events_id_seq|a=557707b3|d=bigint,start=1,inc=1,min=1,max=9223372036854775807,cache=1,cycle=false,owned=private.employee_login_maintenance_events.id|o=postgres
sequences|public.message_recipients_delivery_sequence_seq|a=01b6dabc|d=bigint,start=1,inc=1,min=1,max=9223372036854775807,cache=1,cycle=false,owned=public.message_recipients.delivery_sequence|o=postgres
sequences|public.wallet_ledger_entries_id_seq|a=01b6dabc|d=bigint,start=1,inc=1,min=1,max=9223372036854775807,cache=1,cycle=false,owned=public.wallet_ledger_entries.id|o=postgres
sequences|public.wallet_reconciliation_audit_id_seq|a=01b6dabc|d=bigint,start=1,inc=1,min=1,max=9223372036854775807,cache=1,cycle=false,owned=public.wallet_reconciliation_audit.id|o=postgres
storage_policies|objects: Allow authenticated users to upload super customer avatars|d=f09322d8
storage_policies|objects: Allow delete from website-icons|d=666190ec
storage_policies|objects: Allow delete verification documents|d=de25ff9a
storage_policies|objects: Allow update verification documents|d=3985642c
storage_policies|objects: Allow upload to verification documents|d=17df6ac8
storage_policies|objects: Allow upload to website-icons|d=94c53d7f
storage_policies|objects: Anyone can upload announcement images|d=f2c09b87
storage_policies|objects: Anyone can upload chat images|d=d2b659e6
storage_policies|objects: Anyone can upload template images|d=940188ab
storage_policies|objects: Anyone can view template images|d=959b764a
views|public.history_cleanup_summary|a=4dcd1b56|d=df6b2d5d|o=postgres
tables|private.content_audit_delete_jobs|a=557707b3|c=10:720e354e|i=2:d27efde2|k=1:155983e0|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.content_audit_events|a=557707b3|c=23:c436e60b|i=11:d7b78cc8|k=4:e8c9b5c3|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=3:addf81f6
tables|private.content_audit_public_media_claims|a=557707b3|c=4:a169c800|i=1:97ba67b6|k=4:142229b8|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.content_audit_purge_windows|a=557707b3|c=3:fb6ba135|i=1:9b6c7559|k=1:c30b1956|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.content_audit_recipient_versions|a=557707b3|c=3:cd9110d0|i=2:5a8b622e|k=1:89000b93|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.content_audit_storage_origins|a=557707b3|c=1:1036e934|i=1:d9fcffa3|k=1:7de70b22|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.deleted_employee_accounts|a=557707b3|c=19:e432b318|i=6:a7e5ef6d|k=3:18bd39cb|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.deleted_employee_delete_jobs|a=557707b3|c=14:bfa46ca8|i=2:15a1952c|k=1:1196cd75|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.deleted_employee_notifications|a=557707b3|c=9:a996b3fe|i=3:d1378448|k=3:80590501|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=2:6da7fc8a
tables|private.employee_chat_image_deletion_claims|a=557707b3|c=3:da5a32ea|i=2:7e67d472|k=1:a978272b|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.employee_login_maintenance_confirmations|a=557707b3|c=3:619068de|i=1:7d997224|k=3:6cc0962c|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|private.employee_login_maintenance_events|a=557707b3|c=5:d4b04993|i=1:6601992a|k=2:ee3a1a79|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|private.employee_login_maintenance|a=557707b3|c=4:9580b0df|i=1:60387571|k=3:d9dd9de6|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|private.employee_work_stop_markers|a=557707b3|c=2:6d6b16c9|i=1:c5b4c658|k=1:0b96e007|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|private.notification_delivery_operations|a=557707b3|c=3:df08ec63|i=1:30d9ebb8|k=2:031681cb|o=postgres|p=0:-|r=rls=false,force=false,replica=d|t=0:-
tables|public.account_lock_events|a=761f20d4|c=3:d353f5b0|i=1:dc988279|k=2:36398b0c|o=postgres|p=1:06bdd5c0|r=rls=true,force=false,replica=d|t=0:-
tables|public.account_locks|a=3b160c5d|c=10:9dd791e8|i=5:a9efbe4f|k=4:9014f698|o=postgres|p=0:-|r=rls=true,force=false,replica=f|t=2:16e2235b
tables|public.admin_configs|a=4dcd1b56|c=8:700cb432|i=4:43a04578|k=6:54f71786|o=postgres|p=1:440dd131|r=rls=true,force=false,replica=f|t=2:d5f26512
tables|public.admin_financial_sessions|a=3b160c5d|c=6:6db23a5b|i=3:a431c84f|k=3:7c0fcf76|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.admin_group_members|a=4dcd1b56|c=4:855ad108|i=3:ca2e52f6|k=4:f76854d0|o=postgres|p=3:e49c1f18|r=rls=true,force=false,replica=d|t=0:-
tables|public.admin_groups|a=4dcd1b56|c=5:3032865a|i=3:d35f1404|k=3:af50f4fb|o=postgres|p=4:575ab7d7|r=rls=true,force=false,replica=d|t=0:-
tables|public.admins|a=2e7c033d|c=9:bd808b91|i=3:f163ac53|k=4:76d71ddf|o=postgres|p=1:35e2f6ea|r=rls=true,force=false,replica=d|t=3:4c86f825
tables|public.announcement_categories|a=4dcd1b56|c=8:0d7bdeb2|i=3:c14a04f9|k=4:90c9e69f|o=postgres|p=4:ad7f4b8f|r=rls=true,force=false,replica=d|t=0:-
tables|public.announcements|a=4dcd1b56|c=12:834c1fe1|i=6:53983205|k=3:23346348|o=postgres|p=1:f0e7a75d|r=rls=true,force=false,replica=d|t=2:d7712ecc
tables|public.broadcast_messages|a=4dcd1b56|c=9:67154984|i=4:7ffbaa52|k=5:d23fb535|o=postgres|p=2:bddb08a2|r=rls=true,force=false,replica=d|t=2:b5e079a7
tables|public.broadcast_recipients|a=4dcd1b56|c=6:11b60e83|i=4:4fd408fe|k=4:c69e9fe9|o=postgres|p=4:2313c65b|r=rls=true,force=false,replica=d|t=0:-
tables|public.bulk_import_log|a=4dcd1b56|c=13:01dbd915|i=3:02ac9f21|k=2:728d855c|o=postgres|p=1:2cfd36f4|r=rls=true,force=false,replica=d|t=0:-
tables|public.ccc_conversation_annotations|a=3b160c5d|c=7:500ca325|i=4:4fe7ed6a|k=6:6de29b62|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.commission_audit_log|a=4dcd1b56|c=12:b0d3beec|i=5:fde25f0d|k=5:5e591b1b|o=postgres|p=3:294ea1ca|r=rls=true,force=false,replica=d|t=0:-
tables|public.cs_message_templates|a=69a4ae2d|c=12:805eca99|i=4:c2eb157d|k=3:243818b2|o=postgres|p=4:f64152a8|r=rls=true,force=false,replica=d|t=3:f749aa57
tables|public.customer_auto_message_logs|a=4dcd1b56|c=5:2315b23f|i=3:fdce94f8|k=4:43b2235d|o=postgres|p=5:bc768066|r=rls=true,force=false,replica=d|t=0:-
tables|public.customer_auto_messages|a=f92aac32|c=13:fc5e03ad|i=2:27a1ee75|k=4:d561586d|o=postgres|p=4:4287b1ac|r=rls=true,force=false,replica=d|t=3:8f63a98a
tables|public.customer_employee_conversations|a=fedf2b94|c=18:4f5b9d8b|i=14:ff44d4b6|k=7:8bb1179c|o=postgres|p=5:19791f8e|r=rls=true,force=false,replica=f|t=6:b7d0e0f2
tables|public.customer_service_sessions|a=4dcd1b56|c=7:cafe3f56|i=6:7f903a97|k=6:8a83d9fc|o=postgres|p=5:0174ce33|r=rls=true,force=false,replica=f|t=1:4054960d
tables|public.data_retention_policies|a=4dcd1b56|c=9:c5953fa9|i=2:bc8a9da7|k=2:8ea8361a|o=postgres|p=1:649abff4|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_assignments|a=761f20d4|c=21:cc55d52e|i=15:0cc1943a|k=16:2cf4c03f|o=postgres|p=2:7fc94ead|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_config|a=4dcd1b56|c=5:d33c9489|i=2:23911a1e|k=2:0644b231|o=postgres|p=1:51077efb|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_group_members|a=761f20d4|c=5:07dd78b1|i=6:626e4464|k=5:942aeb70|o=postgres|p=2:f175a8fa|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_group_orders|a=761f20d4|c=9:b1c825bf|i=7:9063e3f3|k=4:1da98055|o=postgres|p=1:e7e39a59|r=rls=true,force=false,replica=d|t=1:f1152e45
tables|public.dispatch_groups|a=761f20d4|c=22:cd28310f|i=3:a60e0d08|k=17:4b8c0335|o=postgres|p=1:273fefb9|r=rls=true,force=false,replica=d|t=1:03e753ff
tables|public.dispatch_order_pools|a=761f20d4|c=15:d45324cf|i=5:b8d941f6|k=14:570995f5|o=postgres|p=1:b55914b7|r=rls=true,force=false,replica=d|t=2:65e12e77
tables|public.dispatch_orders|a=4dcd1b56|c=6:0e59a233|i=2:61c1bebc|k=2:9d670b3a|o=postgres|p=4:2052121a|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_performance_metrics|a=4dcd1b56|c=6:1b9072dd|i=1:9fb76eea|k=1:7a92a27a|o=postgres|p=2:8303aaca|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_pool_selections|a=3b160c5d|c=6:be530276|i=3:cdb5329d|k=6:a2bb352e|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_rate_limits|a=4dcd1b56|c=4:f3114ec8|i=1:236dae46|k=2:8db8283d|o=postgres|p=2:d7bdea4e|r=rls=true,force=false,replica=d|t=0:-
tables|public.dispatch_sessions|a=37ddb814|c=7:e917d09d|i=6:503908ab|k=4:32ff2084|o=postgres|p=2:a7268811|r=rls=true,force=false,replica=f|t=4:edcc8141
tables|public.dispatch_system_logs|a=4dcd1b56|c=9:f6ef0b2d|i=4:fe310f11|k=4:0068a0cc|o=postgres|p=3:65e0fd46|r=rls=true,force=false,replica=d|t=0:-
tables|public.employee_financial_sessions|a=3b160c5d|c=9:87c1ec18|i=3:0a276b29|k=3:fac44de1|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.employee_login_history_events|a=761f20d4|c=3:e6381249|i=1:f43c045d|k=3:8707f18e|o=postgres|p=1:3a6ce4fa|r=rls=true,force=false,replica=d|t=0:-
tables|public.employee_login_history|a=3b160c5d|c=10:056c91de|i=7:a07b678f|k=3:f64f31de|o=postgres|p=1:8ad62742|r=rls=true,force=false,replica=d|t=2:be89d698
tables|public.employee_presence_events|a=761f20d4|c=4:59a9fe1f|i=2:8f46bc4e|k=4:7baf48d7|o=postgres|p=2:591be9fa|r=rls=true,force=false,replica=d|t=0:-
tables|public.employee_regions|a=3b160c5d|c=5:795feeed|i=2:c4fd1c94|k=3:5fd7a0f7|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.employee_submit_time_settings|a=3b160c5d|c=6:222f89c3|i=4:b0a5ce90|k=7:ab9b3519|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.financial_admin_credentials|a=3b160c5d|c=4:cc106c52|i=1:12fd83f0|k=2:56478010|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.financial_employee_credentials|a=3b160c5d|c=4:a9a6543a|i=1:645a3ce0|k=2:0df01fbf|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.financial_login_attempts|a=3b160c5d|c=5:ed51ff8f|i=1:14f843b9|k=2:2e50a562|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.financial_operations|a=3b160c5d|c=7:3acf0fe7|i=1:d0e5009f|k=2:b4ef4c30|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=3:0d28d633
tables|public.group_configs|a=4dcd1b56|c=6:b53ae955|i=2:d6a13341|k=4:3b4fab57|o=postgres|p=4:faacd8bb|r=rls=true,force=false,replica=d|t=0:-
tables|public.history_cleanup_config|a=37ddb814|c=18:406b1556|i=2:e5addaf6|k=6:f3355d74|o=postgres|p=1:dd59a20d|r=rls=true,force=false,replica=d|t=0:-
tables|public.history_cleanup_log|a=3325c5bb|c=12:7b6aca12|i=4:f4f1e905|k=4:dbb5e404|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.login_attempts|a=3b160c5d|c=8:c0203047|i=3:25c3e498|k=2:ff280e6d|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.message_recipients|a=f58736c2|c=15:337f49e1|i=8:16e9f944|k=6:cc4e4eb2|o=postgres|p=2:c47b58a6|r=rls=true,force=false,replica=d|t=2:e36816c6
tables|public.message_templates|a=4dcd1b56|c=11:0c833fbf|i=2:fc6bf23f|k=5:b5a163f5|o=postgres|p=4:82d1a089|r=rls=true,force=false,replica=d|t=3:b2c06875
tables|public.messages|a=f58736c2|c=15:44e55d56|i=3:d5873055|k=8:c9331c0c|o=postgres|p=3:f10d1a79|r=rls=true,force=false,replica=d|t=6:269318ab
tables|public.money_data_protection_audit|a=4dcd1b56|c=7:4aff9d77|i=2:dbcb0dbf|k=1:decd8805|o=postgres|p=1:01f60cc1|r=rls=true,force=false,replica=d|t=0:-
tables|public.notification_automation_executions|a=3b160c5d|c=21:ea47d0e3|i=8:e6efc23d|k=10:7db3c4bf|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=3:23b27f6c
tables|public.notification_automation_failures|a=3b160c5d|c=7:a58b5aa6|i=3:7ecdc94f|k=5:2da8bc77|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.notification_automation_plan_members|a=3b160c5d|c=3:6fe5b990|i=3:522838d3|k=4:980accd6|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=1:81fef1dc
tables|public.notification_automation_plans|a=3b160c5d|c=8:7101513c|i=3:418c5a08|k=4:4e0abc0f|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.notification_automation_progress|a=3b160c5d|c=6:e14cb3c3|i=2:659f127b|k=3:16cd4b9c|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.notification_automation_queue|a=3b160c5d|c=5:bfaf5a8e|i=2:2d052636|k=2:2c9bceb1|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.notification_automation_task_recipients|a=3b160c5d|c=3:77be1bc8|i=2:6dc8224e|k=3:abd8c267|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.notification_automation_tasks|a=3b160c5d|c=30:aee14513|i=5:48578ca2|k=26:96b9656a|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=4:6c8ffd5d
tables|public.orders_history_2025|a=4dcd1b56|c=12:00eb774b|i=1:295b61dd|k=1:a7a13736|o=postgres|p=2:e1f8544d|r=rls=true,force=false,replica=d,partition=FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2026-01-01 00:00:00+00')|t=0:-
tables|public.orders_history_2026|a=4dcd1b56|c=12:00eb774b|i=1:dbcda50f|k=1:3787129e|o=postgres|p=2:b5d768ee|r=rls=true,force=false,replica=d,partition=FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2027-01-01 00:00:00+00')|t=0:-
tables|public.orders_history|a=4dcd1b56|c=12:00eb774b|i=1:80433457|k=1:9df24653|o=postgres|p=2:320ea921|r=rls=true,force=false,replica=d,partitioned=RANGE (archived_at)|t=0:-
tables|public.orders|a=4dcd1b56|c=16:403cb4cc|i=11:543108cb|k=7:80b1fdef|o=postgres|p=4:9eac8250|r=rls=true,force=false,replica=f|t=8:af1cd0ed
tables|public.product_types|a=4dcd1b56|c=6:34ac97bf|i=3:181e0f11|k=2:1dc3c4ca|o=postgres|p=4:8289105b|r=rls=true,force=false,replica=d|t=1:d5c1ac46
tables|public.rating_requests|a=4dcd1b56|c=7:43a41edc|i=5:8063d4e4|k=5:df8f6606|o=postgres|p=5:9f251cf2|r=rls=true,force=false,replica=d|t=0:-
tables|public.rich_card_contents|a=37ddb814|c=6:3e72745c|i=4:441653ae|k=1:ca5cf183|o=postgres|p=4:4e391a5e|r=rls=true,force=false,replica=d|t=3:302cd1ee
tables|public.service_ratings|a=4dcd1b56|c=7:947a529c|i=4:ab5f433c|k=5:ef0aafad|o=postgres|p=5:a39e539b|r=rls=true,force=false,replica=d|t=0:-
tables|public.simulated_customers|a=bd69db52|c=21:f39893b7|i=8:cc621984|k=7:9029af30|o=postgres|p=4:82b20279|r=rls=true,force=false,replica=f|t=3:6760d1c8
tables|public.submit_time_groups|a=3b160c5d|c=6:a7f6e419|i=2:18f98e49|k=5:f5181339|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.system_configs|a=37ddb814|c=6:f14fe75d|i=3:ea4b3c83|k=2:df199005|o=postgres|p=1:e3a25584|r=rls=true,force=false,replica=f|t=3:dc99890e
tables|public.used_order_data|a=4dcd1b56|c=5:61f10cdb|i=7:2b72ce4e|k=5:62ada79e|o=postgres|p=3:9f72fb47|r=rls=true,force=false,replica=d|t=2:e7239dae
tables|public.users|a=b456d91a|c=20:689d4271|i=6:a5a8d0a0|k=7:d6156e1b|o=postgres|p=1:158a9772|r=rls=true,force=false,replica=d|t=6:2bc8414f
tables|public.valid_data_audit_log|a=4dcd1b56|c=10:b8515900|i=3:7aa695d3|k=2:a9f06b4a|o=postgres|p=1:9d0a841d|r=rls=true,force=false,replica=d|t=0:-
tables|public.valid_data_error_log|a=4dcd1b56|c=10:137097a2|i=3:e84b2e97|k=2:d89d3229|o=postgres|p=1:f2efe764|r=rls=true,force=false,replica=d|t=0:-
tables|public.valid_data_monthly_stats|a=4dcd1b56|c=13:976a1b04|i=3:b9b9d64d|k=2:5f09ead4|o=postgres|p=1:b7353ba5|r=rls=true,force=false,replica=d|t=0:-
tables|public.valid_data_query_performance|a=4dcd1b56|c=8:97186619|i=2:57d81cd1|k=1:afc43579|o=postgres|p=1:60a86071|r=rls=true,force=false,replica=d|t=0:-
tables|public.valid_order_data_archive|a=4dcd1b56|c=11:cb0310b6|i=1:0e808383|k=1:98bee407|o=postgres|p=1:603ebb8f|r=rls=true,force=false,replica=d|t=0:-
tables|public.valid_order_data|a=4dcd1b56|c=13:dc4c2cd7|i=7:fd32c4ca|k=3:72084e13|o=postgres|p=1:af8b6bad|r=rls=true,force=false,replica=d|t=1:b5ae3716
tables|public.verification_requests|a=4dcd1b56|c=15:6c3af6e2|i=8:8104e4ad|k=4:241050c2|o=postgres|p=2:340f3d94|r=rls=true,force=false,replica=f|t=0:-
tables|public.wallet_balance_baselines|a=3b160c5d|c=6:c4bdc942|i=1:80922747|k=4:e493e817|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.wallet_ledger_entries|a=3b160c5d|c=10:b1bdee8b|i=3:01a7ed3e|k=6:d3b9bc16|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.wallet_reconciliation_audit|a=3b160c5d|c=12:dc11d309|i=2:9d107d2f|k=9:5667688b|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.wallet_reconciliation_queue|a=3b160c5d|c=5:bfaf5a8e|i=2:ca4db383|k=2:da1f691a|o=postgres|p=0:-|r=rls=true,force=false,replica=d|t=0:-
tables|public.wallet_transactions|a=37ddb814|c=11:43197fd2|i=8:590d1e3f|k=5:e09cd99c|o=postgres|p=2:a3ef2bce|r=rls=true,force=false,replica=f|t=4:839c43e9
tables|public.wallets|a=37ddb814|c=5:070c2dc5|i=1:380d195d|k=5:879e66b6|o=postgres|p=2:e3cacd51|r=rls=true,force=false,replica=f|t=2:1e6ad766
tables|public.withdrawal_events|a=761f20d4|c=4:f0058b26|i=2:b1ab82ce|k=4:d913b4f6|o=postgres|p=2:e677f4ef|r=rls=true,force=false,replica=d|t=0:-
tables|public.withdrawals|a=37ddb814|c=9:bfd4362c|i=4:14feba44|k=6:495fcd17|o=postgres|p=2:27ee60e4|r=rls=true,force=false,replica=f|t=3:c6bc1a2d
tables|public.work_sessions|a=37ddb814|c=7:e02b1dd8|i=7:375254d3|k=3:16c32cc0|o=postgres|p=2:4478ae2c|r=rls=true,force=false,replica=f|t=5:d584a647
functions|private.acquire_notification_automation_configuration_lock()|a=334c4a4c|d=d83411d7|o=postgres|s=definer
functions|private.acquire_notification_automation_evaluation_lock(boolean)|a=334c4a4c|d=5a8f888f|o=postgres|s=definer
functions|private.admin_can_manage_automation_user(uuid,text,uuid)|a=c21f969b|d=57e1aba1|o=postgres|s=definer
functions|private.archive_deleted_employee_notifications(uuid,uuid)|a=334c4a4c|d=e69d5774|o=postgres|s=definer
functions|private.archive_employee_before_delete()|a=334c4a4c|d=fbf676ca|o=postgres|s=definer
functions|private.archive_employees_before_admin_delete()|a=334c4a4c|d=747f1418|o=postgres|s=definer
functions|private.assert_admin_can_manage_user(uuid,text,uuid)|a=334c4a4c|d=3219bcac|o=postgres|s=definer
functions|private.assert_content_audit_purge(uuid)|a=334c4a4c|d=396f8513|o=postgres|s=definer
functions|private.assign_product_type_sort_order()|a=c21f969b|d=b68c12d5|o=postgres|s=definer
functions|private.automation_task_applies_to_user(public.notification_automation_tasks,uuid)|a=334c4a4c|d=2b8d3294|o=postgres|s=definer
functions|private.begin_financial_operation(uuid,text,text,uuid,jsonb)|a=334c4a4c|d=ee7ce830|o=postgres|s=definer
functions|private.calculate_automation_metric(public.notification_automation_tasks,uuid,timestamp with time zone)|a=c21f969b|d=286d3ff2|o=postgres|s=definer
functions|private.capture_automation_baseline(public.notification_automation_tasks,uuid,timestamp with time zone)|a=c21f969b|d=45fccdf5|o=postgres|s=definer
functions|private.capture_content_audit_change()|a=334c4a4c|d=6081f6cd|o=postgres|s=definer
functions|private.capture_content_audit_display_metadata()|a=334c4a4c|d=bdf23859|o=postgres|s=definer
functions|private.capture_content_audit_source_change()|a=334c4a4c|d=7a68c285|o=postgres|s=definer
functions|private.capture_notification_automation_assignment_baseline(public.notification_automation_tasks,uuid,timestamp with time zone)|a=334c4a4c|d=21be6a00|o=postgres|s=definer
functions|private.classify_notification_origin()|a=334c4a4c|d=822f4c53|o=postgres|s=definer
functions|private.clear_financial_login_lock_after_account_unlock()|a=334c4a4c|d=d3879ffc|o=postgres|s=definer
functions|private.close_dispatch_session_from_system(uuid,timestamp with time zone)|a=334c4a4c|d=5f9f86d8|o=postgres|s=definer
functions|private.collect_audit_deletion_confirmations()|a=334c4a4c|d=c9331a9e|o=postgres|s=definer
functions|private.content_audit_chat_snapshot(public.customer_employee_conversations)|a=334c4a4c|d=7c9334f7|o=postgres|s=definer
functions|private.content_audit_decode_uri_path(text)|a=334c4a4c|d=fb7d2169|o=postgres|s=invoker
functions|private.content_audit_document_uses_media(jsonb,text,text)|a=334c4a4c|d=3169cab8|o=postgres|s=definer
functions|private.content_audit_media_for(jsonb,uuid)|a=334c4a4c|d=4ff6be3a|o=postgres|s=definer
functions|private.content_audit_orphan_notification_snapshots(uuid[])|a=334c4a4c|d=9bb06997|o=postgres|s=definer
functions|private.content_audit_public_media_candidates(text[])|a=334c4a4c|d=3be88439|o=postgres|s=definer
functions|private.content_audit_public_media_in_use(text,text)|a=334c4a4c|d=8467d514|o=postgres|s=definer
functions|private.content_audit_storage_urls(jsonb)|a=334c4a4c|d=9fe30202|o=postgres|s=definer
functions|private.create_dispatch_base_pool()|a=334c4a4c|d=6268a081|o=postgres|s=definer
functions|private.credit_performance_bonus(uuid,uuid,numeric,text,uuid,uuid,text)|a=c21f969b|d=8fb2da65|o=postgres|s=definer
functions|private.employee_chat_image_in_use(text)|a=334c4a4c|d=18519a7c|o=postgres|s=definer
functions|private.evaluate_notification_automation_for_user(uuid,timestamp with time zone)|a=334c4a4c|d=b3ade324|o=postgres|s=definer
functions|private.evaluate_notification_automation_tasks(uuid,timestamp with time zone,boolean)|a=334c4a4c|d=3f12cf99|o=postgres|s=definer
functions|private.freeze_rich_card_version(text)|a=334c4a4c|d=02cdf09f|o=postgres|s=definer
functions|private.freeze_service_rich_card()|a=334c4a4c|d=9ded7898|o=postgres|s=definer
functions|private.get_account_lock_admin_context(uuid)|a=334c4a4c|d=df6292c7|o=postgres|s=definer
functions|private.get_financial_admin_context(uuid)|a=334c4a4c|d=04c7536b|o=postgres|s=definer
functions|private.get_financial_employee_id(uuid,uuid,text)|a=334c4a4c|d=d00ec864|o=postgres|s=definer
functions|private.guard_archived_withdrawal_operation()|a=334c4a4c|d=1d83999e|o=postgres|s=definer
functions|private.guard_content_audit_public_media_reference()|a=334c4a4c|d=b7c442d2|o=postgres|s=definer
functions|private.guard_content_audit_public_media_upload()|a=334c4a4c|d=134dcdb6|o=postgres|s=definer
functions|private.guard_dispatch_pool_base()|a=334c4a4c|d=9affbf38|o=postgres|s=definer
functions|private.guard_employee_archive()|a=334c4a4c|d=c47f06ff|o=postgres|s=definer
functions|private.guard_employee_chat_image_reference()|a=334c4a4c|d=3eaf616b|o=postgres|s=definer
functions|private.guard_employee_maintenance_submission()|a=334c4a4c|d=4d1087b3|o=postgres|s=definer
functions|private.guard_weighted_dispatch_pool_archive()|a=334c4a4c|d=237b5869|o=postgres|s=definer
functions|private.hash_financial_token(uuid)|a=334c4a4c|d=4aa4199f|o=postgres|s=invoker
functions|private.inherit_automation_message_delivery_mode()|a=c21f969b|d=213f6b74|o=postgres|s=invoker
functions|private.is_history_cleanup_table(text)|a=334c4a4c|d=3a94dd2c|o=postgres|s=invoker
functions|private.mark_manual_valid_order_deactivation()|a=334c4a4c|d=faee7c4a|o=postgres|s=invoker
functions|private.normalize_employee_region_name(text)|a=334c4a4c|d=34ec87e1|o=postgres|s=invoker
functions|private.pause_notification_automation_plans_for_disabled_admin()|a=334c4a4c|d=9e4c85a3|o=postgres|s=definer
functions|private.process_next_notification_automation_user()|a=334c4a4c|d=5d62c2bb|o=postgres|s=definer
functions|private.process_notification_automation_user(uuid)|a=334c4a4c|d=8de6a816|o=postgres|s=definer
functions|private.protect_order_dispatch_rate_snapshots()|a=334c4a4c|d=0119c0ed|o=postgres|s=invoker
functions|private.queue_annual_date_automation_users(timestamp with time zone)|a=c21f969b|d=e5d29d95|o=postgres|s=definer
functions|private.queue_automation_from_employee_login()|a=c21f969b|d=dfda4451|o=postgres|s=definer
functions|private.queue_automation_from_order()|a=c21f969b|d=44b1c93d|o=postgres|s=definer
functions|private.queue_automation_from_wallet_transaction()|a=c21f969b|d=fdb1b4dd|o=postgres|s=definer
functions|private.queue_automation_from_work_session()|a=c21f969b|d=fe6289d1|o=postgres|s=definer
functions|private.queue_notification_automation_user(uuid)|a=c21f969b|d=db8d1fd6|o=postgres|s=definer
functions|private.redact_deleted_notification_send_content(uuid[])|a=334c4a4c|d=0631d72b|o=postgres|s=definer
functions|private.reject_archived_employee_chat()|a=334c4a4c|d=26a34f20|o=postgres|s=definer
functions|private.reject_archived_notification_recipient()|a=334c4a4c|d=58141a25|o=postgres|s=definer
functions|private.remember_content_audit_recipient()|a=334c4a4c|d=94367929|o=postgres|s=definer
functions|private.remove_deleted_employee_notification_recipients(uuid)|a=334c4a4c|d=5d5df44a|o=postgres|s=definer
functions|private.render_automation_template(text,text,numeric,public.notification_automation_tasks,text)|a=c21f969b|d=9147e07c|o=postgres|s=invoker
functions|private.resolve_admin_currency(uuid)|a=c21f969b|d=b9fb97d0|o=postgres|s=definer
functions|private.resolve_employee_region_owner(uuid,text,uuid)|a=334c4a4c|d=bae32c85|o=postgres|s=definer
functions|private.resolve_notification_automation_owner(uuid,text,uuid)|a=334c4a4c|d=f7cbe3ee|o=postgres|s=definer
functions|private.run_history_cleanup(text,integer,uuid,text,date)|a=334c4a4c|d=eda34cef|o=postgres|s=definer
functions|private.run_notification_automation_queue(integer,boolean)|a=334c4a4c|d=ebae93d3|o=postgres|s=invoker
functions|private.save_financial_operation(uuid,text,text,uuid,jsonb,jsonb)|a=334c4a4c|d=cea83aaa|o=postgres|s=definer
functions|private.snapshot_notification_automation_execution_plan()|a=334c4a4c|d=577f8058|o=postgres|s=definer
functions|private.snapshot_order_dispatch_rates()|a=334c4a4c|d=dfb46f77|o=postgres|s=definer
functions|private.sync_notification_delivery_mode()|a=c21f969b|d=cfe5035a|o=postgres|s=invoker
functions|private.validate_notification_automation_plan_member()|a=334c4a4c|d=15e53406|o=postgres|s=definer
functions|private.validate_notification_automation_task_plan()|a=334c4a4c|d=28444a28|o=postgres|s=definer
functions|private.verify_bcrypt_password(text,text)|a=334c4a4c|d=7fb17428|o=postgres|s=invoker
functions|public.accept_dispatch_assignment_secure(uuid,uuid,text,uuid,uuid,text)|a=f26d0caf|d=df63c430|o=postgres|s=definer
functions|public.adjust_wallet_balance(uuid,numeric,text,uuid)|a=5996d9c5|d=d8ddbde7|o=postgres|s=invoker
functions|public.admin_adjust_wallet_balance_atomic(uuid,uuid,numeric,text,uuid)|a=f26d0caf|d=7109c000|o=postgres|s=definer
functions|public.admin_assign_dispatch_group_member(uuid,uuid,uuid)|a=f26d0caf|d=529731dc|o=postgres|s=definer
functions|public.admin_create_employee_account_unlocked(uuid,text,text,text,uuid,text)|a=334c4a4c|d=fc6800bb|o=postgres|s=definer
functions|public.admin_create_employee_account_with_automation_plan(uuid,text,text,text,uuid,text,uuid,uuid,uuid)|a=f26d0caf|d=be50cd2e|o=postgres|s=definer
functions|public.admin_create_employee_account(uuid,text,text,text,uuid,text,uuid)|a=f26d0caf|d=ec482506|o=postgres|s=definer
functions|public.admin_create_employee_region(uuid,uuid,text)|a=f26d0caf|d=498ea973|o=postgres|s=definer
functions|public.admin_create_secondary_account(uuid,text,text)|a=f26d0caf|d=3f55384f|o=postgres|s=definer
functions|public.admin_delete_employee_account_unlocked(uuid,uuid)|a=334c4a4c|d=660f7fc8|o=postgres|s=definer
functions|public.admin_delete_employee_account(uuid,uuid)|a=5996d9c5|d=a91c15aa|o=postgres|s=definer
functions|public.admin_delete_employee_region(uuid,uuid,uuid)|a=f26d0caf|d=b97032d8|o=postgres|s=definer
functions|public.admin_delete_secondary_account_unlocked(uuid,uuid)|a=334c4a4c|d=d393a241|o=postgres|s=definer
functions|public.admin_delete_secondary_account(uuid,uuid)|a=5996d9c5|d=31cdbe74|o=postgres|s=definer
functions|public.admin_execute_history_cleanup(uuid,text,integer)|a=f26d0caf|d=34276197|o=postgres|s=definer
functions|public.admin_get_history_cleanup_schedule(uuid)|a=f26d0caf|d=091514f7|o=postgres|s=definer
functions|public.admin_manage_dispatch_orders(uuid,uuid,text,uuid,text,text[])|a=f26d0caf|d=a634263b|o=postgres|s=definer
functions|public.admin_preview_history_cleanup(uuid,text)|a=f26d0caf|d=105040fa|o=postgres|s=definer
functions|public.admin_rename_employee_region(uuid,uuid,text)|a=f26d0caf|d=98e26a10|o=postgres|s=definer
functions|public.admin_reset_employee_password(uuid,uuid,text)|a=f26d0caf|d=b81452c0|o=postgres|s=definer
functions|public.admin_save_dispatch_group(uuid,uuid,jsonb)|a=f26d0caf|d=d222284c|o=postgres|s=definer
functions|public.admin_save_dispatch_pool(uuid,uuid,uuid,jsonb)|a=f26d0caf|d=784e93fd|o=postgres|s=definer
functions|public.admin_save_history_cleanup_schedule(uuid,text,integer,text,boolean)|a=f26d0caf|d=ca2cfcc3|o=postgres|s=definer
functions|public.admin_save_shared_system_config(uuid,text,jsonb)|a=f26d0caf|d=96a3f5c2|o=postgres|s=definer
functions|public.admin_set_dispatch_pool_probabilities(uuid,uuid,jsonb)|a=f26d0caf|d=7eaf4385|o=postgres|s=definer
functions|public.admin_set_employee_region_pinned(uuid,uuid,boolean)|a=f26d0caf|d=1724640c|o=postgres|s=definer
functions|public.admin_set_employee_verification(uuid,uuid,boolean)|a=f26d0caf|d=c7dd993c|o=postgres|s=definer
functions|public.admin_update_admin_account(uuid,uuid,jsonb)|a=f26d0caf|d=ce3eaeb6|o=postgres|s=definer
functions|public.admin_update_employee_account_unlocked(uuid,uuid,jsonb)|a=334c4a4c|d=b1fe55c9|o=postgres|s=definer
functions|public.admin_update_employee_account(uuid,uuid,jsonb)|a=670462aa|d=09f0b6d6|o=postgres|s=definer
functions|public.admin_update_secondary_account(uuid,uuid,text,text)|a=f26d0caf|d=060ce93c|o=postgres|s=definer
functions|public.aggregate_monthly_statistics()|a=670462aa|d=dd359479|o=postgres|s=invoker
functions|public.allow_employee_chat_image_upload(text)|a=f26d0caf|d=6b729db2|o=postgres|s=definer
functions|public.analyze_query_performance()|a=670462aa|d=1d188531|o=postgres|s=invoker
functions|public.archive_employee_without_chats(uuid,uuid)|a=309f8c3b|d=fcaded50|o=postgres|s=definer
functions|public.archive_employee_without_media(uuid,uuid)|a=309f8c3b|d=f628b71b|o=postgres|s=definer
functions|public.archive_old_orders(integer)|a=670462aa|d=1be92d0f|o=postgres|s=invoker
functions|public.archive_old_valid_data(integer)|a=670462aa|d=ce9ed8b2|o=postgres|s=invoker
functions|public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)|a=f26d0caf|d=1664d5ee|o=postgres|s=definer
functions|public.assign_next_dispatch_order(uuid,uuid,text)|a=5996d9c5|d=1954e820|o=postgres|s=invoker
functions|public.assign_with_fairness(uuid,uuid,text,boolean)|a=f26d0caf|d=a30607dd|o=postgres|s=invoker
functions|public.assign_with_rate_limit(uuid,uuid,text,integer)|a=f26d0caf|d=c67fc859|o=postgres|s=invoker
functions|public.auto_check_pool_health()|a=5996d9c5|d=d1511b8d|o=postgres|s=definer
functions|public.auto_cleanup_all_tables()|a=5996d9c5|d=d840e466|o=postgres|s=invoker
functions|public.auto_cleanup_dispatch_system()|a=5996d9c5|d=8581b4ff|o=postgres|s=definer
functions|public.auto_cleanup_due_history_data()|a=5996d9c5|d=25e70284|o=postgres|s=definer
functions|public.auto_cleanup_stale_sessions_fast()|a=5996d9c5|d=fff75e51|o=postgres|s=invoker
functions|public.auto_create_commission_and_update_wallet()|a=5996d9c5|d=9969dab7|o=postgres|s=definer
functions|public.auto_fix_commission_inconsistencies()|a=5996d9c5|d=cfa93489|o=postgres|s=invoker
functions|public.auto_fix_valid_data_issues()|a=670462aa|d=a5a1dc92|o=postgres|s=invoker
functions|public.auto_recover_stale_pending_orders(integer)|a=5996d9c5|d=0bce6526|o=postgres|s=invoker
functions|public.auto_repair_work_sessions()|a=5996d9c5|d=745f38b3|o=postgres|s=invoker
functions|public.batch_delete_dispatch_orders(uuid,integer)|a=5996d9c5|d=cd4c6376|o=postgres|s=invoker
functions|public.batch_delete_valid_order_data(integer)|a=f26d0caf|d=6a89f47f|o=postgres|s=invoker
functions|public.cancel_audit_deletion_confirmation(uuid,text,uuid)|a=5996d9c5|d=433b9154|o=postgres|s=definer
functions|public.cancel_employee_withdrawal(uuid,uuid,text,uuid,uuid)|a=f26d0caf|d=72f1cd65|o=postgres|s=definer
functions|public.change_admin_password_atomic(uuid,text,text)|a=f26d0caf|d=392df935|o=postgres|s=definer
functions|public.change_admin_username_atomic(uuid,text,text)|a=f26d0caf|d=337036af|o=postgres|s=definer
functions|public.change_employee_password_atomic(uuid,uuid,text,text,text)|a=f26d0caf|d=d02c9c03|o=postgres|s=definer
functions|public.check_all_pools_health()|a=670462aa|d=05ce44d6|o=postgres|s=invoker
functions|public.check_conversation_group_isolation()|a=670462aa|d=d51ae7fa|o=postgres|s=invoker
functions|public.check_dispatch_pool_health(uuid)|a=670462aa|d=c94ee881|o=postgres|s=invoker
functions|public.check_login_rate_limit(text,text)|a=f26d0caf|d=c422baff|o=postgres|s=definer
functions|public.check_no_overlapping_sessions()|a=670462aa|d=d306be9c|o=postgres|s=invoker
functions|public.check_rate_limit(uuid,integer)|a=670462aa|d=7b2fb667|o=postgres|s=invoker
functions|public.check_system_alerts()|a=670462aa|d=101071f8|o=postgres|s=invoker
functions|public.check_valid_data_capacity()|a=670462aa|d=8c79fc05|o=postgres|s=invoker
functions|public.check_valid_data_consistency()|a=670462aa|d=8c70cdf0|o=postgres|s=invoker
functions|public.check_withdrawal_eligibility(uuid)|a=5996d9c5|d=0fab66b7|o=postgres|s=definer
functions|public.claim_next_login_notification_delivery(uuid,uuid,text,boolean,integer)|a=f26d0caf|d=b574d15d|o=postgres|s=definer
functions|public.claim_next_realtime_notification_delivery(uuid,uuid,text,integer)|a=f26d0caf|d=62c2701a|o=postgres|s=definer
functions|public.claim_realtime_notification_delivery(uuid,uuid,text,uuid,integer)|a=f26d0caf|d=313ca81e|o=postgres|s=definer
functions|public.cleanup_admin_data()|a=670462aa|d=f6621141|o=postgres|s=definer
functions|public.cleanup_all_practice_data()|a=5996d9c5|d=13bbf05c|o=postgres|s=invoker
functions|public.cleanup_all_stale_sessions()|a=5996d9c5|d=ff6f30b9|o=postgres|s=definer
functions|public.cleanup_duplicate_active_sessions()|a=670462aa|d=6fc99efa|o=postgres|s=invoker
functions|public.cleanup_duplicate_work_sessions()|a=5996d9c5|d=85470dd6|o=postgres|s=invoker
functions|public.cleanup_expired_messages()|a=670462aa|d=98b965ae|o=postgres|s=definer
functions|public.cleanup_inactive_sessions()|a=f26d0caf|d=aa35b215|o=postgres|s=invoker
functions|public.cleanup_old_archived_data()|a=670462aa|d=19b91857|o=postgres|s=invoker
functions|public.cleanup_old_audit_logs()|a=670462aa|d=5f0c43c6|o=postgres|s=invoker
functions|public.cleanup_old_dispatch_assignments()|a=5996d9c5|d=8c9010d4|o=postgres|s=invoker
functions|public.cleanup_old_error_logs()|a=670462aa|d=8b4176af|o=postgres|s=invoker
functions|public.cleanup_old_login_attempts()|a=5996d9c5|d=2b1e310b|o=postgres|s=invoker
functions|public.cleanup_old_messages()|a=5996d9c5|d=7438453a|o=postgres|s=definer
functions|public.cleanup_old_query_performance()|a=670462aa|d=f00396b3|o=postgres|s=invoker
functions|public.cleanup_old_rate_limits()|a=670462aa|d=7877476b|o=postgres|s=invoker
functions|public.cleanup_old_valid_data(integer)|a=670462aa|d=39cfccdf|o=postgres|s=invoker
functions|public.cleanup_stale_dispatch_sessions()|a=5996d9c5|d=2728bade|o=postgres|s=definer
functions|public.cleanup_stale_work_sessions_optimized()|a=5996d9c5|d=a8f8947e|o=postgres|s=definer
functions|public.cleanup_stale_work_sessions()|a=5996d9c5|d=868c7c6e|o=postgres|s=invoker
functions|public.cleanup_stress_test_data()|a=670462aa|d=6cd564bd|o=postgres|s=invoker
functions|public.cleanup_used_order_data(integer,uuid)|a=5996d9c5|d=86a516f0|o=postgres|s=invoker
functions|public.cleanup_user_data()|a=5996d9c5|d=14e01350|o=postgres|s=definer
functions|public.cleanup_user_storage_files()|a=5996d9c5|d=0abf4c12|o=postgres|s=definer
functions|public.cleanup_zero_duration_sessions()|a=670462aa|d=fa0e4149|o=postgres|s=invoker
functions|public.cleanup_zombie_dispatch_orders()|a=5996d9c5|d=59e87286|o=postgres|s=invoker
functions|public.clear_deleted_employee_account(uuid,uuid,text)|a=5996d9c5|d=9763a03d|o=postgres|s=definer
functions|public.clear_deleted_employee_notification(uuid,uuid,text)|a=5996d9c5|d=2a7c3d9c|o=postgres|s=definer
functions|public.clear_employee_session(uuid)|a=5996d9c5|d=1b599bb0|o=postgres|s=invoker
functions|public.commit_content_audit_change(uuid,text,uuid[],uuid,text,jsonb,uuid,jsonb)|a=5996d9c5|d=cbf2bf77|o=postgres|s=definer
functions|public.complete_content_audit_delete(uuid,uuid)|a=5996d9c5|d=956d236d|o=postgres|s=definer
functions|public.complete_deleted_employee_archive_delete(uuid,uuid)|a=5996d9c5|d=7a4f35dc|o=postgres|s=definer
functions|public.complete_notification_delivery(uuid,uuid,text,uuid,uuid,boolean)|a=f26d0caf|d=ea4b8690|o=postgres|s=definer
functions|public.copy_shared_notification_automation_task_unlocked(uuid,uuid)|a=334c4a4c|d=855dac77|o=postgres|s=definer
functions|public.copy_shared_notification_automation_task_with_delivery_unlocked(uuid,uuid)|a=334c4a4c|d=83fa5cb7|o=postgres|s=definer
functions|public.copy_shared_notification_automation_task_with_delivery(uuid,uuid)|a=5996d9c5|d=b6646f5e|o=postgres|s=definer
functions|public.copy_shared_notification_automation_task(uuid,uuid)|a=5996d9c5|d=2941b47f|o=postgres|s=definer
functions|public.correct_withdrawal_status_atomic(uuid,uuid,text,text,uuid)|a=f26d0caf|d=d7e35b3c|o=postgres|s=definer
functions|public.count_commission_issues()|a=5996d9c5|d=9385a787|o=postgres|s=invoker
functions|public.count_failed_orders_by_user(uuid[])|a=670462aa|d=804d02c3|o=postgres|s=invoker
functions|public.count_order_days_by_user(uuid[])|a=670462aa|d=060314c2|o=postgres|s=invoker
functions|public.count_orders_by_user(uuid[])|a=670462aa|d=95cf0f37|o=postgres|s=invoker
functions|public.count_today_completed_orders_by_user(uuid[],timestamp with time zone)|a=670462aa|d=13f1d405|o=postgres|s=invoker
functions|public.count_today_orders_by_user(uuid[],timestamp with time zone)|a=670462aa|d=0e18939e|o=postgres|s=invoker
functions|public.count_today_valid_data_failed_orders_by_user(uuid[],timestamp with time zone)|a=670462aa|d=71980c3f|o=postgres|s=invoker
functions|public.create_admin_financial_session(text,text)|a=f26d0caf|d=8ca1b6e2|o=postgres|s=definer
functions|public.create_employee_financial_session(text,text,text)|a=f26d0caf|d=2a8158e9|o=postgres|s=definer
functions|public.create_wallet_for_new_user()|a=5996d9c5|d=cab97fb4|o=postgres|s=definer
functions|public.daily_commission_integrity_check()|a=5996d9c5|d=afad199f|o=postgres|s=invoker
functions|public.delete_all_messages_for_admin(uuid,uuid)|a=5996d9c5|d=f39cb937|o=postgres|s=invoker
functions|public.delete_archived_notification_automation_plan(uuid,uuid)|a=f26d0caf|d=0b8eae9f|o=postgres|s=definer
functions|public.delete_messages(uuid[],uuid)|a=5996d9c5|d=c337d0c1|o=postgres|s=invoker
functions|public.delete_notification_automation_task(uuid,uuid)|a=f26d0caf|d=c74b3cf4|o=postgres|s=definer
functions|public.detect_valid_data_bottlenecks()|a=5996d9c5|d=c4d04d3b|o=postgres|s=invoker
functions|public.detect_work_time_anomalies(integer)|a=5996d9c5|d=d822c15f|o=postgres|s=invoker
functions|public.emit_account_lock_event()|a=5996d9c5|d=320aec17|o=postgres|s=definer
functions|public.emit_employee_login_history_event()|a=5996d9c5|d=340ec4af|o=postgres|s=definer
functions|public.emit_employee_presence_event()|a=5996d9c5|d=11aa7275|o=postgres|s=definer
functions|public.emit_withdrawal_event()|a=5996d9c5|d=93c74f72|o=postgres|s=definer
functions|public.end_employee_dispatch_session_secure(uuid,uuid,text,uuid)|a=f26d0caf|d=1b941e0b|o=postgres|s=definer
functions|public.end_work_session_by_user(uuid)|a=5996d9c5|d=93b835b5|o=postgres|s=invoker
functions|public.end_work_session(uuid)|a=5996d9c5|d=093c1a4f|o=postgres|s=invoker
functions|public.enqueue_all_wallets_for_reconciliation()|a=5996d9c5|d=fc1fd6da|o=postgres|s=definer
functions|public.enqueue_changed_wallet()|a=5996d9c5|d=9bde1e0d|o=postgres|s=definer
functions|public.enqueue_wallet_reconciliation(uuid)|a=5996d9c5|d=8c969258|o=postgres|s=definer
functions|public.execute_cleanup(text,integer,uuid)|a=5996d9c5|d=33a184e3|o=postgres|s=invoker
functions|public.execute_cleanup(uuid,text,integer)|a=5996d9c5|d=a2001e27|o=postgres|s=definer
functions|public.expire_old_rating_requests()|a=670462aa|d=cd330fff|o=postgres|s=invoker
functions|public.expire_pending_dispatch_assignment_secure(uuid,uuid,text,uuid,uuid)|a=f26d0caf|d=9845cacf|o=postgres|s=definer
functions|public.find_available_valid_data(uuid,numeric,text)|a=670462aa|d=37365ea0|o=postgres|s=invoker
functions|public.finish_content_audit_delete(uuid,uuid)|a=5996d9c5|d=bb7cd2f8|o=postgres|s=definer
functions|public.finish_deleted_employee_archive_delete(uuid,uuid)|a=5996d9c5|d=960c2d92|o=postgres|s=definer
functions|public.finish_dispatch_assignment_secure(uuid,uuid,text,uuid,text,text)|a=f26d0caf|d=be43625f|o=postgres|s=definer
functions|public.generate_customer_id()|a=670462aa|d=6d655d69|o=postgres|s=invoker
functions|public.generate_service_ticket_number()|a=670462aa|d=6b40f374|o=postgres|s=invoker
functions|public.generate_stress_test_report()|a=670462aa|d=5ae3ab37|o=postgres|s=invoker
functions|public.generate_super_customer_id()|a=670462aa|d=1bee7ce9|o=postgres|s=invoker
functions|public.get_account_lock_history_for_admin(uuid,integer)|a=f26d0caf|d=651d0df6|o=postgres|s=definer
functions|public.get_account_locks_for_admin(uuid)|a=f26d0caf|d=c1e2f679|o=postgres|s=definer
functions|public.get_active_work_session(uuid)|a=670462aa|d=4075acb5|o=postgres|s=invoker
functions|public.get_admin_chat_unread_counts(uuid)|a=f26d0caf|d=797ed873|o=postgres|s=definer
functions|public.get_admin_customer_conversations(uuid)|a=f26d0caf|d=ea15fadc|o=postgres|s=invoker
functions|public.get_admin_employees(uuid)|a=f26d0caf|d=6a9fdb2f|o=postgres|s=invoker
functions|public.get_admin_groups_for_customer_service(text)|a=670462aa|d=968a8049|o=postgres|s=invoker
functions|public.get_batch_work_status(uuid[])|a=670462aa|d=bc6799b2|o=postgres|s=invoker
functions|public.get_batch_work_time(uuid[])|a=670462aa|d=d4d210d5|o=postgres|s=invoker
functions|public.get_ccc_conversation_annotations(uuid,uuid)|a=f26d0caf|d=8ddb40c4|o=postgres|s=definer
functions|public.get_ccc_conversation_summaries(uuid,text)|a=670462aa|d=ab4c6f2d|o=postgres|s=invoker
functions|public.get_content_audit_conversation(uuid,uuid,text,uuid,uuid,integer,integer)|a=f26d0caf|d=9123b78a|o=postgres|s=definer
functions|public.get_content_audit_event(uuid,uuid)|a=f26d0caf|d=b42baaa5|o=postgres|s=definer
functions|public.get_content_audit_filter_counts(uuid)|a=f26d0caf|d=c8b75411|o=postgres|s=definer
functions|public.get_daily_order_stats(uuid)|a=f26d0caf|d=d8a419fe|o=postgres|s=invoker
functions|public.get_deleted_employee_account(uuid,uuid,integer,integer,text)|a=f26d0caf|d=a6f2f979|o=postgres|s=definer
functions|public.get_deleted_employee_notification(uuid,uuid)|a=f26d0caf|d=2c8ce70b|o=postgres|s=definer
functions|public.get_detailed_valid_data_stats(integer)|a=670462aa|d=e71332b8|o=postgres|s=invoker
functions|public.get_dispatch_analytics(timestamp with time zone,timestamp with time zone)|a=670462aa|d=6b9d3b91|o=postgres|s=invoker
functions|public.get_dispatch_bottlenecks()|a=5996d9c5|d=0de9b255|o=postgres|s=invoker
functions|public.get_dispatch_performance_stats()|a=5996d9c5|d=9b25fde4|o=postgres|s=invoker
functions|public.get_dispatch_system_health()|a=5996d9c5|d=5777b25b|o=postgres|s=invoker
functions|public.get_dispatch_system_metrics()|a=5996d9c5|d=7a1a6a03|o=postgres|s=invoker
functions|public.get_employee_conversation_summaries(uuid)|a=670462aa|d=6e49c730|o=postgres|s=invoker
functions|public.get_employee_detail_summary_for_admin(uuid,uuid)|a=f26d0caf|d=7fc974c2|o=postgres|s=definer
functions|public.get_employee_dispatch_submit_wait_secure(uuid,uuid,text)|a=f26d0caf|d=86db8411|o=postgres|s=definer
functions|public.get_employee_login_history_with_device_info(uuid,uuid,integer,integer)|a=f26d0caf|d=273b8a9c|o=postgres|s=definer
functions|public.get_employee_login_history(uuid,uuid,integer,integer)|a=5996d9c5|d=f8ba7cf5|o=postgres|s=invoker
functions|public.get_employee_login_maintenance(uuid,uuid)|a=f26d0caf|d=22811d89|o=postgres|s=definer
functions|public.get_employee_login_summary(uuid,text)|a=f26d0caf|d=5b80ce2d|o=postgres|s=definer
functions|public.get_employee_maintenance_status(uuid,uuid,text)|a=f26d0caf|d=afe6bf53|o=postgres|s=definer
functions|public.get_employee_management_snapshot(uuid)|a=f26d0caf|d=81b747cf|o=postgres|s=definer
functions|public.get_employee_notification_messages(uuid,uuid,text,text,integer)|a=f26d0caf|d=743d23fa|o=postgres|s=definer
functions|public.get_employee_transaction_date_counts_for_admin(uuid,uuid)|a=f26d0caf|d=414e5296|o=postgres|s=definer
functions|public.get_employee_transaction_page_for_admin(uuid,uuid,integer,integer,date)|a=f26d0caf|d=3a25f555|o=postgres|s=definer
functions|public.get_employee_unread_customer_messages_count(uuid)|a=f26d0caf|d=120254c4|o=postgres|s=invoker
functions|public.get_employee_withdrawal_page_for_admin(uuid,uuid,integer,integer)|a=f26d0caf|d=98afed82|o=postgres|s=definer
functions|public.get_employee_withdrawal_policy_secure(uuid,uuid,text)|a=f26d0caf|d=5678db92|o=postgres|s=definer
functions|public.get_employees_by_admin()|a=5996d9c5|d=052144a2|o=postgres|s=invoker
functions|public.get_empty_dispatch_groups()|a=5996d9c5|d=5ab2d73f|o=postgres|s=invoker
functions|public.get_fairness_summary()|a=670462aa|d=581ddd42|o=postgres|s=invoker
functions|public.get_heartbeat_distribution()|a=5996d9c5|d=a9cf2595|o=postgres|s=invoker
functions|public.get_hot_valid_data(integer)|a=5996d9c5|d=b8361e16|o=postgres|s=invoker
functions|public.get_ios_config()|a=5996d9c5|d=69a4fed4|o=postgres|s=invoker
functions|public.get_money_protection_audit_log(integer)|a=5996d9c5|d=34fefc7f|o=postgres|s=invoker
functions|public.get_notification_automation_dashboard_v2(uuid,uuid)|a=f26d0caf|d=a7b467be|o=postgres|s=definer
functions|public.get_notification_automation_dashboard(uuid,uuid)|a=5996d9c5|d=52164deb|o=postgres|s=definer
functions|public.get_notification_automation_executions_v2(uuid,uuid,uuid,boolean,text)|a=670462aa|d=1ce3493f|o=postgres|s=definer
functions|public.get_notification_automation_failures(uuid,uuid)|a=f26d0caf|d=598b26c7|o=postgres|s=definer
functions|public.get_notification_automation_plan_assignments(uuid)|a=f26d0caf|d=0fa8e862|o=postgres|s=definer
functions|public.get_optimal_valid_data(uuid,numeric,integer)|a=670462aa|d=42496ad3|o=postgres|s=invoker
functions|public.get_or_create_service_session(uuid,uuid)|a=670462aa|d=69758e87|o=postgres|s=invoker
functions|public.get_order_counts_by_user()|a=670462aa|d=0f42eb20|o=postgres|s=invoker
functions|public.get_overall_order_stats(uuid)|a=f26d0caf|d=f1309c90|o=postgres|s=invoker
functions|public.get_pending_orders_status()|a=670462aa|d=cb49dd5b|o=postgres|s=invoker
functions|public.get_pending_withdrawal_count_for_admin(uuid)|a=f26d0caf|d=ae9b6f26|o=postgres|s=definer
functions|public.get_practice_data_stats()|a=5996d9c5|d=d41ee54f|o=postgres|s=invoker
functions|public.get_rate_limit_stats()|a=670462aa|d=0276d16b|o=postgres|s=invoker
functions|public.get_stale_session_report()|a=5996d9c5|d=4930bc1f|o=postgres|s=invoker
functions|public.get_system_health_metrics()|a=5996d9c5|d=b9a3b263|o=postgres|s=invoker
functions|public.get_table_record_count(text)|a=5996d9c5|d=06eb7422|o=postgres|s=invoker
functions|public.get_table_size(text)|a=5996d9c5|d=11ba2cfc|o=postgres|s=invoker
functions|public.get_today_commission_by_user(uuid[])|a=f26d0caf|d=3f45caf6|o=postgres|s=invoker
functions|public.get_today_commission(uuid)|a=f26d0caf|d=b8537fe9|o=postgres|s=invoker
functions|public.get_today_work_time(uuid)|a=670462aa|d=8105b399|o=postgres|s=invoker
functions|public.get_total_work_time(uuid)|a=670462aa|d=43419177|o=postgres|s=invoker
functions|public.get_unread_message_count(uuid)|a=f26d0caf|d=30838a99|o=postgres|s=invoker
functions|public.get_user_completed_orders_count(uuid)|a=f26d0caf|d=b41b8047|o=postgres|s=invoker
functions|public.get_user_work_days_count(uuid)|a=5996d9c5|d=a9d8aac2|o=postgres|s=invoker
functions|public.get_user_work_time_by_date(uuid,date)|a=670462aa|d=ff8bcaa0|o=postgres|s=invoker
functions|public.get_user_work_time_today(uuid)|a=670462aa|d=b9a6aa26|o=postgres|s=invoker
functions|public.get_valid_data_audit_trail(uuid)|a=670462aa|d=a9d1c3e8|o=postgres|s=invoker
functions|public.get_valid_data_pool_stats()|a=670462aa|d=131ce3b2|o=postgres|s=invoker
functions|public.get_valid_data_pool_status()|a=5996d9c5|d=4ec80297|o=postgres|s=invoker
functions|public.get_valid_data_system_metrics()|a=5996d9c5|d=8ecbad17|o=postgres|s=invoker
functions|public.get_valid_data_usage_stats()|a=5996d9c5|d=db05b4ab|o=postgres|s=invoker
functions|public.get_validation_stats(integer)|a=670462aa|d=8487b04e|o=postgres|s=invoker
functions|public.get_withdrawal_review_data(uuid)|a=f26d0caf|d=0aa0c3cd|o=postgres|s=definer
functions|public.get_withdrawals_for_admin(uuid)|a=f26d0caf|d=0741eb3b|o=postgres|s=definer
functions|public.has_pending_employee_login_notifications(uuid,uuid,text,boolean)|a=f26d0caf|d=830d19b3|o=postgres|s=definer
functions|public.history_cleanup_completed_today(text)|a=f26d0caf|d=5b6ee7e1|o=postgres|s=definer
functions|public.list_content_audit_cards_filtered(uuid,text,uuid,text,text,text,timestamp with time zone,timestamp with time zone,integer,integer)|a=f26d0caf|d=8767cfa0|o=postgres|s=definer
functions|public.list_content_audit_cards(uuid,text,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,integer,integer)|a=f26d0caf|d=94760a53|o=postgres|s=definer
functions|public.list_content_audit_events(uuid,text,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,integer,integer)|a=f26d0caf|d=eea06cb9|o=postgres|s=definer
functions|public.list_content_audit_orphan_media()|a=5996d9c5|d=8d84e7df|o=postgres|s=definer
functions|public.list_content_audit_owners(uuid)|a=f26d0caf|d=3be796e7|o=postgres|s=definer
functions|public.list_content_audit_pending_deletes(uuid)|a=5996d9c5|d=b5d7a006|o=postgres|s=definer
functions|public.list_deleted_employee_accounts(uuid,uuid,text,timestamp with time zone,timestamp with time zone,integer,integer,text)|a=f26d0caf|d=e69e0369|o=postgres|s=definer
functions|public.list_deleted_employee_notifications(uuid,uuid,integer,integer)|a=f26d0caf|d=984f359e|o=postgres|s=definer
functions|public.list_deleted_employee_withdrawals(uuid,uuid,integer,integer)|a=309f8c3b|d=29931022|o=postgres|s=definer
functions|public.list_pending_deleted_employee_archive_deletes(uuid)|a=5996d9c5|d=8525b540|o=postgres|s=definer
functions|public.list_unpurged_archived_employees(uuid)|a=f26d0caf|d=96f044a8|o=postgres|s=definer
functions|public.log_employee_login_with_device_info(uuid,text,text,text,text,text,jsonb)|a=f26d0caf|d=e0d1b970|o=postgres|s=definer
functions|public.log_employee_login(uuid,text,text,text,text,text)|a=f26d0caf|d=f13e76d3|o=postgres|s=definer
functions|public.log_employee_logout_secure(uuid,uuid,text,text,text,jsonb)|a=f26d0caf|d=1c71b1bc|o=postgres|s=definer
functions|public.log_employee_logout_with_device_info(uuid,text,text,text,text,text,jsonb)|a=5996d9c5|d=f5706c91|o=postgres|s=invoker
functions|public.log_employee_logout(uuid,text,text,text,text,text)|a=5996d9c5|d=0b14a7ea|o=postgres|s=invoker
functions|public.log_valid_data_changes()|a=670462aa|d=22ac1244|o=postgres|s=invoker
functions|public.log_valid_data_error(text,text,text,jsonb)|a=670462aa|d=050ac11c|o=postgres|s=invoker
functions|public.mark_dispatch_assignment_submitted_secure(uuid,uuid,text,uuid,text,uuid)|a=f26d0caf|d=809d3554|o=postgres|s=definer
functions|public.mark_employee_notification_read(uuid,uuid,text,uuid)|a=f26d0caf|d=dee0030d|o=postgres|s=definer
functions|public.mark_login_popup_as_shown(uuid,uuid)|a=5996d9c5|d=81d7d877|o=postgres|s=invoker
functions|public.mark_message_as_read(uuid,uuid)|a=5996d9c5|d=b373b9a9|o=postgres|s=invoker
functions|public.merge_overlapping_work_sessions(uuid)|a=670462aa|d=f1078d96|o=postgres|s=invoker
functions|public.monitor_large_tables()|a=670462aa|d=4efddf9a|o=postgres|s=invoker
functions|public.monitor_storage_usage()|a=670462aa|d=dfd14bac|o=postgres|s=invoker
functions|public.predict_data_exhaustion()|a=670462aa|d=4fcec2c7|o=postgres|s=invoker
functions|public.prepare_content_audit_change(uuid,text,uuid[],uuid)|a=5996d9c5|d=d154757a|o=postgres|s=definer
functions|public.prepare_content_audit_conversation_delete(uuid,uuid)|a=5996d9c5|d=b719ca2a|o=postgres|s=definer
functions|public.prepare_content_audit_delete(uuid,text,uuid,text,text,text,timestamp with time zone,timestamp with time zone,uuid)|a=5996d9c5|d=68c2e2f5|o=postgres|s=definer
functions|public.prepare_deleted_employee_archive_delete(uuid,uuid,text,uuid,uuid)|a=f26d0caf|d=7f78b859|o=postgres|s=definer
functions|public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)|a=f26d0caf|d=b2a99774|o=postgres|s=definer
functions|public.prepare_unpurged_archived_employee_delete(uuid,uuid)|a=f26d0caf|d=b0a1db83|o=postgres|s=definer
functions|public.prevent_duplicate_dispatch_sessions()|a=670462aa|d=6f2dc5e2|o=postgres|s=invoker
functions|public.prevent_multiple_active_sessions()|a=670462aa|d=4f243954|o=postgres|s=invoker
functions|public.preview_cleanup_used_order_data(integer)|a=670462aa|d=858e1141|o=postgres|s=invoker
functions|public.preview_cleanup(text,integer)|a=5996d9c5|d=621b6232|o=postgres|s=invoker
functions|public.process_customer_service_tip(uuid,numeric,uuid)|a=5996d9c5|d=9e538e06|o=postgres|s=definer
functions|public.process_notification_automation_queue_fast(integer)|a=5996d9c5|d=6b7ff525|o=postgres|s=definer
functions|public.process_notification_automation_queue(integer)|a=5996d9c5|d=369527d5|o=postgres|s=definer
functions|public.process_pending_orders()|a=5996d9c5|d=9627b5da|o=postgres|s=invoker
functions|public.process_wallet_reconciliation_queue(integer)|a=5996d9c5|d=9ca79939|o=postgres|s=definer
functions|public.protect_money_data()|a=5996d9c5|d=861ea4fd|o=postgres|s=definer
functions|public.recalculate_all_users_total_income()|a=5996d9c5|d=b92b1715|o=postgres|s=invoker
functions|public.recalculate_user_total_income(uuid)|a=5996d9c5|d=82df691a|o=postgres|s=invoker
functions|public.recheck_content_audit_public_media(uuid,uuid,text,jsonb)|a=5996d9c5|d=611f500b|o=postgres|s=definer
functions|public.recheck_deleted_employee_archive_media(uuid,uuid,text[])|a=5996d9c5|d=013dbdac|o=postgres|s=definer
functions|public.reconcile_server_dispatch_lifecycle()|a=5996d9c5|d=064bc38a|o=postgres|s=definer
functions|public.reconcile_stale_dispatch_assignments(integer,integer)|a=5996d9c5|d=9872e099|o=postgres|s=definer
functions|public.reconcile_wallet_from_ledger(uuid)|a=5996d9c5|d=b9ae9032|o=postgres|s=definer
functions|public.record_login_attempt(text,text,boolean,text,text)|a=f26d0caf|d=a9c32461|o=postgres|s=definer
functions|public.recover_employee_dispatch_assignment_secure(uuid,uuid,text)|a=f26d0caf|d=733b0802|o=postgres|s=definer
functions|public.reorder_product_types(uuid,uuid[])|a=f26d0caf|d=d5d99912|o=postgres|s=definer
functions|public.repair_work_session_mismatches()|a=5996d9c5|d=f7f85dbc|o=postgres|s=invoker
functions|public.request_employee_withdrawal(uuid,uuid,text,uuid)|a=f26d0caf|d=32901dcf|o=postgres|s=definer
functions|public.resume_employee_dispatch_session_secure(uuid,uuid,text,uuid)|a=f26d0caf|d=d77f81ed|o=postgres|s=definer
functions|public.reverse_deleted_wallet_transaction_in_ledger()|a=5996d9c5|d=38bbde1f|o=postgres|s=definer
functions|public.review_withdrawal_atomic(uuid,uuid,text,text,uuid)|a=f26d0caf|d=786a9f9a|o=postgres|s=definer
functions|public.revoke_financial_session(uuid)|a=f26d0caf|d=0864d76c|o=postgres|s=definer
functions|public.run_comprehensive_cleanup(boolean)|a=670462aa|d=0f212291|o=postgres|s=invoker
functions|public.run_comprehensive_health_check()|a=670462aa|d=6e8e22cc|o=postgres|s=invoker
functions|public.run_daily_maintenance()|a=670462aa|d=d93e596f|o=postgres|s=invoker
functions|public.run_valid_data_maintenance()|a=670462aa|d=f7db5eba|o=postgres|s=invoker
functions|public.save_notification_automation_plan(uuid,uuid,uuid,text,text)|a=f26d0caf|d=12e810ce|o=postgres|s=definer
functions|public.save_notification_automation_task_copy_unlocked(uuid,uuid,uuid,text,text,text,text,numeric,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamp with time zone,timestamp with time zone)|a=334c4a4c|d=30776d98|o=postgres|s=definer
functions|public.save_notification_automation_task_copy_with_delivery(uuid,uuid,uuid,text,text,text,text,numeric,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamp with time zone,timestamp with time zone)|a=5996d9c5|d=eb0ca1dd|o=postgres|s=definer
functions|public.save_notification_automation_task_copy(uuid,uuid,uuid,text,text,text,text,numeric,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamp with time zone,timestamp with time zone)|a=5996d9c5|d=ec1e5b7e|o=postgres|s=definer
functions|public.save_notification_automation_task_unlocked(uuid,uuid,text,text,text,text,numeric,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamp with time zone,timestamp with time zone)|a=334c4a4c|d=00ad4ff4|o=postgres|s=definer
functions|public.save_notification_automation_task_v2(uuid,uuid,uuid,uuid,text,text,text,text,numeric,integer,integer,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,timestamp with time zone,timestamp with time zone)|a=f26d0caf|d=ac6a2357|o=postgres|s=definer
functions|public.save_notification_automation_task_with_delivery(uuid,uuid,text,text,text,text,numeric,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamp with time zone,timestamp with time zone)|a=5996d9c5|d=52850dfa|o=postgres|s=definer
functions|public.save_notification_automation_task(uuid,uuid,text,text,text,text,numeric,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamp with time zone,timestamp with time zone)|a=5996d9c5|d=9a76aba6|o=postgres|s=definer
functions|public.search_all_employees_for_admin(uuid,text,integer)|a=f26d0caf|d=4bf479c3|o=postgres|s=definer
functions|public.send_admin_message_secure(uuid,uuid[],text,text,text,text,numeric,uuid)|a=5996d9c5|d=a363f7cd|o=postgres|s=definer
functions|public.send_admin_message_with_delivery(uuid,uuid[],text,text,text,text,numeric,uuid)|a=f26d0caf|d=bdcafc06|o=postgres|s=definer
functions|public.send_broadcast_message(uuid,text,text,text,text,uuid,uuid[])|a=f26d0caf|d=01ec8030|o=postgres|s=invoker
functions|public.send_customer_service_tip_atomic(uuid,uuid,uuid,numeric,text,uuid)|a=f26d0caf|d=4a8a52e7|o=postgres|s=definer
functions|public.set_content_audit_purge_window(uuid,boolean)|a=f26d0caf|d=d6229b23|o=postgres|s=definer
functions|public.set_customer_id()|a=670462aa|d=ea4bfd04|o=postgres|s=invoker
functions|public.set_employee_login_maintenance(uuid,uuid,text,boolean)|a=f26d0caf|d=7ccf984c|o=postgres|s=definer
functions|public.set_employee_session(uuid,uuid)|a=5996d9c5|d=abc330c1|o=postgres|s=invoker
functions|public.set_notification_automation_plan_for_employee(uuid,uuid,uuid)|a=f26d0caf|d=3b3bc3c4|o=postgres|s=definer
functions|public.set_notification_automation_plan_members(uuid,uuid,uuid[])|a=f26d0caf|d=42377edc|o=postgres|s=definer
functions|public.set_notification_automation_plan_status(uuid,uuid,text)|a=f26d0caf|d=f41a98e1|o=postgres|s=definer
functions|public.set_notification_automation_task_status_unlocked(uuid,uuid,text)|a=334c4a4c|d=9b7a3cd8|o=postgres|s=definer
functions|public.set_notification_automation_task_status_v2(uuid,uuid,text)|a=f26d0caf|d=bd3daac4|o=postgres|s=definer
functions|public.set_notification_automation_task_status(uuid,uuid,text)|a=5996d9c5|d=1d14391f|o=postgres|s=definer
functions|public.set_order_scheduled_process_at()|a=670462aa|d=b52b3345|o=postgres|s=invoker
functions|public.set_service_ticket_number()|a=670462aa|d=ade7c031|o=postgres|s=invoker
functions|public.should_lock_account(text)|a=f26d0caf|d=8e91c00b|o=postgres|s=invoker
functions|public.start_employee_dispatch_session_secure(uuid,uuid,text)|a=f26d0caf|d=b48eccb9|o=postgres|s=definer
functions|public.start_work_session(uuid)|a=5996d9c5|d=32121c6d|o=postgres|s=invoker
functions|public.stop_employee_dispatch_session_secure(uuid,uuid,text,uuid)|a=f26d0caf|d=ce02569d|o=postgres|s=definer
functions|public.stress_test_order_submissions(integer)|a=670462aa|d=5b7362fc|o=postgres|s=invoker
functions|public.stress_test_valid_data_lookups(integer,integer)|a=670462aa|d=10961c32|o=postgres|s=invoker
functions|public.sync_dispatch_session_end()|a=5996d9c5|d=db6dea5d|o=postgres|s=definer
functions|public.sync_dispatch_session_start()|a=670462aa|d=6d3584d0|o=postgres|s=invoker
functions|public.test_assignment_race_condition(uuid,integer)|a=5996d9c5|d=d8df7b60|o=postgres|s=invoker
functions|public.test_concurrent_dispatch(uuid,integer)|a=670462aa|d=5ab1c8b2|o=postgres|s=invoker
functions|public.test_valid_data_index_performance()|a=670462aa|d=32b6482b|o=postgres|s=invoker
functions|public.track_query_performance(text,numeric,integer)|a=670462aa|d=c685c1d4|o=postgres|s=invoker
functions|public.track_wallet_transaction_in_ledger()|a=5996d9c5|d=aedc8f6e|o=postgres|s=definer
functions|public.track_withdrawal_in_ledger()|a=5996d9c5|d=8645c63a|o=postgres|s=definer
functions|public.unlock_account_with_permission_check(text,text,uuid)|a=f26d0caf|d=80205b4a|o=postgres|s=definer
functions|public.unlock_account(text,text,uuid)|a=5996d9c5|d=a869ba64|o=postgres|s=invoker
functions|public.update_admin_message_content_with_session(uuid,uuid,text,text)|a=5996d9c5|d=734403d4|o=postgres|s=definer
functions|public.update_ccc_conversation_annotation(uuid,uuid,uuid,boolean,text,boolean)|a=f26d0caf|d=0c58c187|o=postgres|s=definer
functions|public.update_employee_heartbeat(uuid,uuid)|a=5996d9c5|d=ef50b9e7|o=postgres|s=invoker
functions|public.update_ios_config(jsonb)|a=5996d9c5|d=b132a06a|o=postgres|s=invoker
functions|public.update_session_heartbeat_secure(uuid,uuid,text,uuid)|a=f26d0caf|d=4ee66d2d|o=postgres|s=definer
functions|public.update_session_heartbeat(uuid)|a=5996d9c5|d=4728e839|o=postgres|s=invoker
functions|public.update_system_configs_updated_at()|a=670462aa|d=ec5b6868|o=postgres|s=invoker
functions|public.update_user_total_income_on_order_success()|a=5996d9c5|d=a05689b9|o=postgres|s=definer
functions|public.update_valid_data_usage_stats()|a=670462aa|d=3f423e32|o=postgres|s=invoker
functions|public.validate_commission_integrity(uuid)|a=5996d9c5|d=b80f34b4|o=postgres|s=invoker
functions|public.validate_employee_session(uuid,text,text)|a=f26d0caf|d=8c751701|o=postgres|s=invoker
functions|public.validate_employee_session(uuid,uuid,text)|a=f26d0caf|d=a26de628|o=postgres|s=definer
functions|public.validate_employee_session(uuid,uuid)|a=f26d0caf|d=adf3bf12|o=postgres|s=invoker
functions|public.validate_work_session()|a=5996d9c5|d=0be3ee33|o=postgres|s=definer
functions|public.verify_no_duplicate_valid_data()|a=670462aa|d=62a296f7|o=postgres|s=invoker
functions|public.verify_user_config_params(uuid)|a=670462aa|d=62ab87bd|o=postgres|s=invoker
functions|public.warm_valid_data_cache()|a=670462aa|d=552cd59d|o=postgres|s=invoker
$baseline$::text as t
),
baseline_lines as (
  select btrim(line, E' \r\t') as line
  from baseline_raw, regexp_split_to_table(baseline_raw.t, E'\n') line
  where btrim(line, E' \r\t') <> ''
),
is_gen as (
  select not exists (select 1 from baseline_lines where line not like '#%') as g
),

-- ---------------------------------------------------------------------
-- 当前数据库结构指纹
-- ---------------------------------------------------------------------
rel as (
  select c.oid, n.nspname::text as nspname, c.relname::text as relname, n.nspname || '.' || c.relname as k,
         c.relkind::text as relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity,
         c.relreplident::text as relreplident, c.relpersistence::text as relpersistence, c.relispartition, c.relpartbound
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S')
),
t_col as (
  select a.attrelid as oid, count(*) as n,
         left(md5(string_agg(concat_ws('|', a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull::text,
              coalesce(pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity::text, a.attgenerated::text),
              E'\n' order by a.attname)), 8) as h
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid in (select oid from rel where relkind in ('r', 'p')) and a.attnum > 0 and not a.attisdropped
  group by a.attrelid
),
t_con as (
  select k.conrelid as oid, count(*) as n,
         left(md5(string_agg(concat_ws('|', k.conname::text, k.contype::text, pg_get_constraintdef(k.oid)),
              E'\n' order by k.conname)), 8) as h
  from pg_constraint k
  where k.conrelid in (select oid from rel where relkind in ('r', 'p'))
  group by k.conrelid
),
t_idx as (
  select i.indrelid as oid, count(*) as n,
         left(md5(string_agg(pg_get_indexdef(i.indexrelid), E'\n' order by ic.relname)), 8) as h
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  where i.indrelid in (select oid from rel where relkind in ('r', 'p'))
  group by i.indrelid
),
t_trg as (
  select t.tgrelid as oid, count(*) as n,
         left(md5(string_agg(concat_ws('|', t.tgname::text, t.tgenabled::text, pg_get_triggerdef(t.oid)),
              E'\n' order by t.tgname)), 8) as h
  from pg_trigger t
  where not t.tgisinternal and t.tgrelid in (select oid from rel where relkind in ('r', 'p'))
  group by t.tgrelid
),
t_pol as (
  select p.polrelid as oid, count(*) as n,
         left(md5(string_agg(concat_ws('|', p.polname::text, p.polcmd::text, p.polpermissive::text,
              (select string_agg(x, ',' order by x) from (
                 select case when r = 0 then 'PUBLIC' else pg_get_userbyid(r)::text end as x from unnest(p.polroles) r) s),
              coalesce(pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')),
              E'\n' order by p.polname)), 8) as h
  from pg_policy p
  where p.polrelid in (select oid from rel where relkind in ('r', 'p'))
  group by p.polrelid
),
t_acl as (
  select r.oid,
         case when r.relacl is null then 'default' else coalesce((select string_agg(x, ',' order by x) from (
           select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end) || '=' || a.privilege_type
                  || (case when a.is_grantable then '*' else '' end) as x
           from aclexplode(r.relacl) a where a.grantee <> r.relowner) s), 'none') end
         || '#' || coalesce((select string_agg(y, ',' order by y) from (
           select at.attname::text || ':' || (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end)
                  || '=' || a.privilege_type as y
           from pg_attribute at
           cross join lateral aclexplode(at.attacl) a
           where at.attrelid = r.oid and at.attnum > 0 and not at.attisdropped and at.attacl is not null
             and a.grantee <> r.relowner) s2), '') as acl
  from rel r
),
s_tables as (
  select coalesce(jsonb_object_agg(r.k, jsonb_build_object(
           'c', coalesce(c.n, 0) || ':' || coalesce(c.h, '-'),
           'k', coalesce(k.n, 0) || ':' || coalesce(k.h, '-'),
           'i', coalesce(i.n, 0) || ':' || coalesce(i.h, '-'),
           't', coalesce(t.n, 0) || ':' || coalesce(t.h, '-'),
           'p', coalesce(p.n, 0) || ':' || coalesce(p.h, '-'),
           'a', left(md5(a.acl), 8),
           'r', concat_ws(',', 'rls=' || r.relrowsecurity::text, 'force=' || r.relforcerowsecurity::text, 'replica=' || r.relreplident,
                  case when r.relpersistence <> 'p' then 'persistence=' || r.relpersistence end,
                  case when r.relkind = 'p' then 'partitioned=' || pg_get_partkeydef(r.oid) end,
                  case when r.relispartition then 'partition=' || pg_get_expr(r.relpartbound, r.oid) end),
           'o', pg_get_userbyid(r.relowner)::text)), '{}'::jsonb) as j
  from rel r
  left join t_col c on c.oid = r.oid
  left join t_con k on k.oid = r.oid
  left join t_idx i on i.oid = r.oid
  left join t_trg t on t.oid = r.oid
  left join t_pol p on p.oid = r.oid
  left join t_acl a on a.oid = r.oid
  where r.relkind in ('r', 'p')
),
s_views as (
  select coalesce(jsonb_object_agg(r.k, jsonb_build_object(
           'd', left(md5(pg_get_viewdef(r.oid)), 8), 'a', left(md5(a.acl), 8), 'o', pg_get_userbyid(r.relowner)::text)), '{}'::jsonb) as j
  from rel r
  join t_acl a on a.oid = r.oid
  where r.relkind in ('v', 'm')
),
s_sequences as (
  select coalesce(jsonb_object_agg(r.k, jsonb_build_object(
           'd', concat_ws(',', format_type(s.seqtypid, null), 'start=' || s.seqstart, 'inc=' || s.seqincrement, 'min=' || s.seqmin,
                  'max=' || s.seqmax, 'cache=' || s.seqcache, 'cycle=' || s.seqcycle::text,
                  (select 'owned=' || dr.refobjid::regclass::text || '.' || da.attname::text
                   from pg_depend dr
                   join pg_attribute da on da.attrelid = dr.refobjid and da.attnum = dr.refobjsubid
                   where dr.classid = 'pg_class'::regclass and dr.objid = r.oid and dr.refclassid = 'pg_class'::regclass
                     and dr.refobjsubid > 0 and dr.deptype in ('a', 'i')
                   limit 1)),
           'a', left(md5(a.acl), 8), 'o', pg_get_userbyid(r.relowner)::text)), '{}'::jsonb) as j
  from rel r
  join pg_sequence s on s.seqrelid = r.oid
  join t_acl a on a.oid = r.oid
  where r.relkind = 'S'
),
s_functions as (
  select coalesce(jsonb_object_agg(n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ', ', ',') || ')',
           jsonb_build_object(
             'd', left(md5(pg_get_functiondef(p.oid)), 8),
             'a', left(md5(case when p.proacl is null then 'default' else coalesce((select string_agg(x, ',' order by x) from (
                    select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end) || '=' || a.privilege_type
                           || (case when a.is_grantable then '*' else '' end) as x
                    from aclexplode(p.proacl) a where a.grantee <> p.proowner) s), 'none') end), 8),
             'o', pg_get_userbyid(p.proowner)::text,
             's', case when p.prosecdef then 'definer' else 'invoker' end)), '{}'::jsonb) as j
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind in ('f', 'p', 'w')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
s_schemas as (
  select coalesce(jsonb_object_agg(n.nspname, jsonb_build_object(
           'a', left(md5(case when n.nspacl is null then 'default' else coalesce((select string_agg(x, ',' order by x) from (
                  select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end) || '=' || a.privilege_type
                         || (case when a.is_grantable then '*' else '' end) as x
                  from aclexplode(n.nspacl) a where a.grantee <> n.nspowner) s), 'none') end), 8),
           'o', pg_get_userbyid(n.nspowner)::text)), '{}'::jsonb) as j
  from pg_namespace n
  where n.nspname in ('public', 'private')
),
s_extensions as (
  select coalesce(jsonb_object_agg(e.extname, jsonb_build_object('v', e.extversion, 's', n.nspname::text)), '{}'::jsonb) as j
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
),
s_ext_triggers as (
  select coalesce(jsonb_object_agg(tn.nspname || '.' || tc.relname || '.' || t.tgname,
           jsonb_build_object('d', left(md5(t.tgenabled::text || '|' || pg_get_triggerdef(t.oid)), 8))), '{}'::jsonb) as j
  from pg_trigger t
  join pg_class tc on tc.oid = t.tgrelid
  join pg_namespace tn on tn.oid = tc.relnamespace
  join pg_proc fp on fp.oid = t.tgfoid
  join pg_namespace fn on fn.oid = fp.pronamespace
  where not t.tgisinternal and tn.nspname not in ('public', 'private') and fn.nspname in ('public', 'private')
),
s_storage_policies as (
  select coalesce(jsonb_object_agg(c.relname || ': ' || p.polname, jsonb_build_object('d', left(md5(concat_ws('|',
           p.polcmd::text, p.polpermissive::text,
           (select string_agg(x, ',' order by x) from (
              select case when r = 0 then 'PUBLIC' else pg_get_userbyid(r)::text end as x from unnest(p.polroles) r) s),
           coalesce(pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))), 8))), '{}'::jsonb) as j
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage'
),
s_buckets as (
  select coalesce(jsonb_object_agg(b.id, jsonb_build_object(
           'pub', coalesce(b.public, false)::text,
           'lim', coalesce(b.file_size_limit::text, '不限'),
           'mime', coalesce((select string_agg(m, ',' order by m) from unnest(b.allowed_mime_types) m), '不限'))), '{}'::jsonb) as j
  from storage.buckets b
),
s_realtime as (
  select coalesce(jsonb_object_agg(pt.schemaname || '.' || pt.tablename, jsonb_build_object('in', '已加入')), '{}'::jsonb) as j
  from pg_publication_tables pt
  where pt.pubname = 'supabase_realtime'
),
s_cron as (
  select coalesce(jsonb_object_agg(x.jobname, jsonb_build_object(
           'sch', x.schedule, 'cmd', x.command, 'act', x.active, 'db', x.dbname, 'usr', x.username)), '{}'::jsonb) as j
  from xmltable('/table/row' passing (
         case when to_regclass('cron.job') is not null
              then query_to_xml('select jobname, schedule, command, active::text as active, database as dbname, username from cron.job where jobname is not null', false, false, '')
              else '<table/>'::xml end)
       columns jobname text path 'jobname', schedule text path 'schedule', command text path 'command',
               active text path 'active', dbname text path 'dbname', username text path 'username') x
),
s_roles as (
  select coalesce(jsonb_object_agg(x.rolname, jsonb_build_object('cfg', x.cfg)), '{}'::jsonb) as j
  from (
    select r.rolname::text as rolname, string_agg(c, ';' order by c) as cfg
    from pg_db_role_setting s
    join pg_roles r on r.oid = s.setrole
    cross join lateral unnest(s.setconfig) c
    where r.rolname in ('anon', 'authenticated', 'authenticator', 'service_role')
      and s.setdatabase in (0, (select oid from pg_database where datname = current_database()))
    group by r.rolname
  ) x
),
s_event_triggers as (
  select coalesce(jsonb_object_agg(e.evtname, jsonb_build_object('en', e.evtenabled::text, 'fn', e.evtfoid::regproc::text)), '{}'::jsonb) as j
  from pg_event_trigger e
),
s_meta as (
  select jsonb_build_object(
           'pg_major', jsonb_build_object('v', split_part(current_setting('server_version'), '.', 1)),
           'locale', jsonb_build_object('v', (select datcollate || ' / ' || datctype || ' / ' || pg_encoding_to_char(encoding)
                                              from pg_database where datname = current_database())),
           'timezone', jsonb_build_object('v', (select reset_val from pg_settings where name = 'TimeZone')),
           'realtime_pub', jsonb_build_object('v', coalesce((select concat_ws(',', 'insert=' || pubinsert::text, 'update=' || pubupdate::text,
                                 'delete=' || pubdelete::text, 'truncate=' || pubtruncate::text, 'all_tables=' || puballtables::text)
                                 from pg_publication where pubname = 'supabase_realtime'), '缺少'))
         ) as j
),
cur as (
  select jsonb_build_object(
           'meta', m.j, 'schemas', sc.j, 'extensions', ex.j, 'tables', tb.j, 'views', vw.j, 'sequences', sq.j,
           'functions', fn.j, 'ext_triggers', et.j, 'storage_policies', sp.j, 'buckets', bk.j, 'realtime', rt.j,
           'cron', cr.j, 'roles', ro.j, 'event_triggers', ev.j) as j
  from s_meta m, s_schemas sc, s_extensions ex, s_tables tb, s_views vw, s_sequences sq, s_functions fn,
       s_ext_triggers et, s_storage_policies sp, s_buckets bk, s_realtime rt, s_cron cr, s_roles ro, s_event_triggers ev
),

-- ---------------------------------------------------------------------
-- 结构对比
-- ---------------------------------------------------------------------
exp_flat as (
  select split_part(b.line, '|', 1) as section, split_part(b.line, '|', 2) as k,
         substring(part from '^[^=]+') as sub, coalesce(substring(part from '^[^=]+=(.*)$'), '') as v
  from baseline_lines b
  cross join lateral unnest((string_to_array(b.line, '|'))[3:]) part
  where b.line not like '#%'
),
cur_flat as (
  select s.key as section, o.key as k, f.key as sub,
         regexp_replace(coalesce(f.value #>> '{}', ''), '[\r\n|]+', ' ', 'g') as v
  from cur b
  cross join lateral jsonb_each(b.j) s
  cross join lateral jsonb_each(s.value) o
  cross join lateral jsonb_each(o.value) f
),
cur_lines as (
  select section || '|' || k || '|' || string_agg(sub || '=' || v, '|' order by sub) as line
  from cur_flat
  group by section, k
),
exp_obj as (select distinct section, k from exp_flat),
cur_obj as (select distinct section, k from cur_flat),
obj_missing as (
  select e.section, e.k from exp_obj e
  where not exists (select 1 from cur_obj c where c.section = e.section and c.k = e.k)
),
obj_extra as (
  select c.section, c.k from cur_obj c
  where exists (select 1 from exp_obj s where s.section = c.section)
    and not exists (select 1 from exp_obj e where e.section = c.section and e.k = c.k)
),
sub_diff as (
  select e.section, e.k, e.sub, e.v as ev, c.v as cv
  from exp_flat e
  join cur_obj co on co.section = e.section and co.k = e.k
  left join cur_flat c on c.section = e.section and c.k = e.k and c.sub = e.sub
  where c.v is distinct from e.v
  union all
  select c.section, c.k, c.sub, null, c.v
  from cur_flat c
  join exp_obj eo on eo.section = c.section and eo.k = c.k
  where not exists (select 1 from exp_flat e where e.section = c.section and e.k = c.k and e.sub = c.sub)
),
sec_lbl(section, label, feature) as (
  values ('meta', '数据库基础设置', '平台设置'), ('extensions', '数据库扩展', '平台设置'), ('schemas', '数据库空间(schema)', '平台设置'),
         ('tables', '数据表', null), ('views', '视图', null), ('sequences', '自增序列', null), ('functions', '函数/RPC', null),
         ('ext_triggers', '存储触发器', '文件存储'), ('storage_policies', '文件存储权限策略', '文件存储'), ('buckets', '存储桶', '文件存储'),
         ('realtime', '实时更新表', '实时更新'), ('cron', '定时任务', '定时任务'), ('roles', '数据库角色设置', '平台设置'),
         ('event_triggers', '平台事件触发器', '平台设置')
),
sub_lbl(section, sub, label, kind) as (
  values ('tables', 'c', '字段', 'count'), ('tables', 'k', '约束', 'count'), ('tables', 'i', '索引', 'count'),
         ('tables', 't', '触发器', 'count'), ('tables', 'p', '行级权限策略', 'count'), ('tables', 'a', '表/字段权限', 'hash'),
         ('tables', 'r', '表属性', 'text'), ('tables', 'o', '所有者', 'text'),
         ('functions', 'd', '函数内容', 'hash'), ('functions', 'a', '执行权限', 'hash'), ('functions', 'o', '所有者', 'text'),
         ('functions', 's', '安全模式', 'text'),
         ('views', 'd', '视图定义', 'hash'), ('views', 'a', '权限', 'hash'), ('views', 'o', '所有者', 'text'),
         ('sequences', 'd', '序列定义', 'text'), ('sequences', 'a', '权限', 'hash'), ('sequences', 'o', '所有者', 'text'),
         ('schemas', 'a', '使用权限', 'hash'), ('schemas', 'o', '所有者', 'text'),
         ('extensions', 'v', '版本', 'text'), ('extensions', 's', '安装位置', 'text'),
         ('ext_triggers', 'd', '触发器定义', 'hash'), ('storage_policies', 'd', '策略内容', 'hash'),
         ('buckets', 'pub', '是否公开', 'text'), ('buckets', 'lim', '单个文件上限(字节)', 'text'), ('buckets', 'mime', '允许的文件类型', 'text'),
         ('realtime', 'in', '是否加入实时更新', 'text'),
         ('cron', 'sch', '执行频率', 'text'), ('cron', 'cmd', '执行内容', 'text'), ('cron', 'act', '是否启用', 'text'),
         ('cron', 'db', '数据库', 'text'), ('cron', 'usr', '执行身份', 'text'),
         ('roles', 'cfg', '角色设置', 'text'), ('event_triggers', 'en', '启用状态', 'text'), ('event_triggers', 'fn', '调用函数', 'text'),
         ('meta', 'v', '值', 'text')
),
feat_rules(ord, pattern, feature) as (
  values (1, '(content_audit|deleted_employee|archiv|audit_delet|purge|evidence|redact)', '内容稽核与已删员工'),
         (2, 'maintenance', '团队维护'),
         (3, 'region', '员工地区'),
         (4, '(customer|conversation|rich_card|cs_|rating|ccc|service_|simulated|annotation)', '客服聊天'),
         (5, '(work_session|presence|heartbeat|work_stop)', '工时与在线'),
         (6, '(order|dispatch|product|submit|valid_data|valid_order|used_order|pool|assignment)', '订单与派单'),
         (7, '(credential|login|session|account_lock|_locks|unlock|password|token)', '账号登录与会话'),
         (8, '(withdraw|wallet|ledger|financial|commission|reward|money|reconcil|income|balance)', '钱包与资金'),
         (9, '(notification|message|broadcast|announcement|template|popup)', '通知与公告'),
         (10, 'verification', '实名验证'),
         (11, '(history|cleanup|retention|bulk_import|practice)', '历史资料清理'),
         (12, '(admin|user|employee|group|config|navigation|brand)', '员工与后台设置')
),
struct_problem as (
  select case when m.section in ('tables', 'views', 'functions', 'sequences', 'schemas', 'ext_triggers',
                                 'storage_policies', 'buckets', 'realtime', 'cron') then '失败'
              when m.section = 'extensions' and m.k in ('pg_cron', 'pg_trgm', 'pgcrypto', 'uuid-ossp', 'plpgsql') then '失败'
              else '警告' end as result,
         m.section, m.k, null::text as sub, '存在' as expected, '缺少' as actual, '新库缺少这一项（旧库有）' as note
  from obj_missing m
  union all
  select case when x.section in ('extensions', 'event_triggers') then '提示' else '警告' end,
         x.section, x.k, null, '不存在', '存在',
         case when x.section = 'cron' then '新库多出这个定时任务；如果与原有任务重复，可能造成重复处理'
              else '新库多出这一项（旧库没有）' end
  from obj_extra x
  union all
  select case when d.section = 'functions' and d.sub = 'o' then
                case when (select e.v from exp_flat e where e.section = 'functions' and e.k = d.k and e.sub = 's') = 'definer'
                     then '失败' else '警告' end
              when d.sub = 'o' then '警告'
              when d.section in ('roles', 'event_triggers') then '警告'
              when d.section = 'extensions' and d.sub = 'v' then '警告'
              when d.section = 'meta' and d.k in ('pg_major', 'timezone') then '警告'
              else '失败' end,
         d.section, d.k, d.sub,
         coalesce(case sl.kind when 'count' then split_part(d.ev, ':', 1) || ' 个' when 'hash' then '指纹 ' || d.ev else d.ev end, '—'),
         coalesce(case sl.kind when 'count' then split_part(d.cv, ':', 1) || ' 个' when 'hash' then '指纹 ' || d.cv else d.cv end, '—'),
         case when d.ev is null then '新库多出这一属性'
              when d.cv is null then '新库缺少这一属性'
              when sl.kind = 'count' and split_part(d.ev, ':', 1) = split_part(d.cv, ':', 1) then '数量相同，但内容与旧库不同'
              when sl.kind = 'count' then '数量与旧库不同'
              when d.section = 'functions' and d.sub = 'o' then '所有者不同；安全定义者函数会以所有者的权限运行'
              else '与旧库不同' end
  from sub_diff d
  left join sub_lbl sl on sl.section = d.section and sl.sub = d.sub
),
struct_rows as (
  select p.result,
         coalesce(s.feature, (select f.feature from feat_rules f where p.k ~* f.pattern order by f.ord limit 1), '通用') as feature,
         s.label as category, p.k as obj,
         coalesce(l.label, '整项') as item, p.expected, p.actual, p.note
  from struct_problem p
  join sec_lbl s on s.section = p.section
  left join sub_lbl l on l.section = p.section and l.sub = p.sub
),
struct_pass as (
  select case when x.n_ok = x.n_all then '通过' else '提示' end as result, x.feature, x.category, '全部' as obj,
         '结构与旧库一致' as item, x.n_all || ' 项' as expected, x.n_ok || ' 项一致' as actual,
         case when x.n_ok = x.n_all then '' else '不一致的项目已在上方「失败/警告」中逐项列出' end as note
  from (
    select coalesce(s.feature, '全部功能') as feature, s.label as category, count(*) as n_all,
           count(*) filter (where not exists (select 1 from obj_missing m where m.section = e.section and m.k = e.k)
                              and not exists (select 1 from sub_diff d where d.section = e.section and d.k = e.k)) as n_ok
    from exp_obj e
    join sec_lbl s on s.section = e.section
    group by s.section, s.feature, s.label
  ) x
),

-- ---------------------------------------------------------------------
-- 数据一致性检查（每项查询返回「问题数量」，0 为正常）
-- ---------------------------------------------------------------------
chk(feature, item, sev, note, need, q) as (
  values
  ('钱包与资金', '钱包余额与账本一致', '失败',
   '可用余额+冻结金额 应等于 对账基准+之后的账本变动；不一致的钱包会被每分钟的对账任务自动改写',
   array['public.wallets', 'public.wallet_balance_baselines', 'public.wallet_ledger_entries'],
   $q$select count(*) as c from (
        select b.user_id, b.available_balance + b.frozen_balance + coalesce(sum(e.available_delta + e.frozen_delta), 0) as exp_total
        from public.wallet_balance_baselines b
        left join public.wallet_ledger_entries e on e.user_id = b.user_id and e.id > b.last_ledger_id
        group by b.user_id, b.available_balance, b.frozen_balance) l
      join public.wallets w on w.user_id = l.user_id
      where w.available_balance + w.frozen_balance <> l.exp_total$q$),
  ('钱包与资金', '员工累计收入与账本一致', '失败',
   '员工累计收入应等于 对账基准收入+之后的账本收入变动',
   array['public.users', 'public.wallet_balance_baselines', 'public.wallet_ledger_entries'],
   $q$select count(*) as c from (
        select b.user_id, b.total_income + coalesce(sum(e.income_delta), 0) as exp_income
        from public.wallet_balance_baselines b
        left join public.wallet_ledger_entries e on e.user_id = b.user_id and e.id > b.last_ledger_id
        group by b.user_id, b.total_income) l
      join public.users u on u.id = l.user_id
      where u.total_income is distinct from l.exp_income$q$),
  ('钱包与资金', '冻结金额等于待处理提款合计', '失败',
   '每个钱包的冻结金额必须等于该员工所有「待处理」提款金额之和',
   array['public.wallets', 'public.withdrawals'],
   $q$select count(*) as c from public.wallets w
      left join (select user_id, sum(amount) as amt from public.withdrawals where status = 'pending' group by user_id) p
        on p.user_id = w.user_id
      where w.frozen_balance <> coalesce(p.amt, 0)$q$),
  ('钱包与资金', '没有负数余额', '失败', '可用余额和冻结金额都不能小于 0',
   array['public.wallets'],
   $q$select count(*) as c from public.wallets where available_balance < 0 or frozen_balance < 0$q$),
  ('钱包与资金', '在职员工都有钱包', '失败', '没有钱包的员工无法入账和提款',
   array['public.users', 'public.wallets'],
   $q$select count(*) as c from public.users u
      where u.archived_at is null and not exists (select 1 from public.wallets w where w.user_id = u.id)$q$),
  ('钱包与资金', '钱包都有对账基准', '警告', '缺少基准时，下一次对账会自动建立',
   array['public.wallets', 'public.wallet_balance_baselines'],
   $q$select count(*) as c from public.wallets w
      where not exists (select 1 from public.wallet_balance_baselines b where b.user_id = w.user_id)$q$),
  ('钱包与资金', '对账队列没有积压超过 15 分钟', '警告', '对账定时任务每分钟处理；有积压说明定时任务可能没在运行',
   array['public.wallet_reconciliation_queue'],
   $q$select count(*) as c from public.wallet_reconciliation_queue where requested_at < now() - interval '15 minutes'$q$),
  ('账号登录与会话', '在职员工都有登录凭据', '失败', '缺少登录凭据的员工无法登录',
   array['public.users', 'public.financial_employee_credentials'],
   $q$select count(*) as c from public.users u
      where u.archived_at is null and not exists (select 1 from public.financial_employee_credentials f where f.user_id = u.id)$q$),
  ('账号登录与会话', '启用中的管理员都有登录凭据', '失败', '缺少登录凭据的管理员无法登录后台',
   array['public.admins', 'public.financial_admin_credentials'],
   $q$select count(*) as c from public.admins a
      where a.is_active and not exists (select 1 from public.financial_admin_credentials f where f.admin_id = a.id)$q$),
  ('账号登录与会话', '至少有一名启用中的超级管理员', '失败', '没有超级管理员将无法管理后台',
   array['public.admins'],
   $q$select case when count(*) = 0 then 1 else 0 end as c from public.admins where role = 'super_admin' and is_active$q$),
  ('订单与派单', '订单状态都合法', '失败', '订单状态只能是 processing / success / failure',
   array['public.orders'],
   $q$select count(*) as c from public.orders where status is null or status not in ('processing', 'success', 'failure')$q$),
  ('订单与派单', '没有超过 10 分钟仍未结算的处理中订单', '警告',
   '订单处理定时任务每分钟结算满 3 分钟的订单；有积压说明定时任务可能没在运行',
   array['public.orders'],
   $q$select count(*) as c from public.orders where status = 'processing' and created_at < now() - interval '10 minutes'$q$),
  ('通知与公告', '自动通知队列没有积压超过 5 分钟', '警告', '自动通知每 5 秒处理一次；有积压说明定时任务可能没在运行',
   array['public.notification_automation_queue'],
   $q$select count(*) as c from public.notification_automation_queue where requested_at < now() - interval '5 minutes'$q$),
  ('通知与公告', '自动通知没有失败记录', '警告', '失败原因会显示在后台「通知自動化」任务列表上方',
   array['public.notification_automation_failures'],
   $q$select count(*) as c from public.notification_automation_failures$q$),
  ('数据完整性', '所有索引都有效', '失败', '无效索引会影响查询和唯一性检查',
   array[]::text[],
   $q$select count(*) as c from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and not (i.indisvalid and i.indisready)$q$),
  ('数据完整性', '所有约束都已验证', '警告', '未验证的约束不保证旧数据符合规则',
   array[]::text[],
   $q$select count(*) as c from pg_constraint k join pg_namespace n on n.oid = k.connamespace
      where n.nspname in ('public', 'private') and not k.convalidated$q$)
),
chk_run as (
  select c.*,
         case when coalesce((select bool_and(to_regclass(t) is not null) from unnest(c.need) t), true)
              then (xpath('/row/c/text()', query_to_xml(c.q, false, true, '')))[1]::text::bigint end as n
  from chk c
),
chk_rows as (
  select case when n is null then '失败' when n = 0 then '通过' else sev end as result,
         feature, '数据检查' as category, item as obj, '问题数量' as item, '0' as expected,
         coalesce(n::text, '无法检查'), case when n is null then '缺少相关数据表，无法检查' else note end as note
  from chk_run
),
fk as (
  select k.conname::text as conname, k.conrelid::regclass::text as child, k.confrelid::regclass::text as parent,
         (select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ' order by u.ord)
          from unnest(k.conkey, k.confkey) with ordinality u(ck, pk, ord)
          join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = u.ck
          join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = u.pk) as join_cond,
         (select string_agg(format('c.%I is not null', ca.attname), ' and ' order by u.ord)
          from unnest(k.conkey) with ordinality u(ck, ord)
          join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = u.ck) as nn_cond
  from pg_constraint k
  join pg_namespace n on n.oid = k.connamespace
  where k.contype = 'f' and k.conparentid = 0 and n.nspname in ('public', 'private')
),
fk_run as (
  select f.*,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s c where %s and not exists (select 1 from %s p where %s)',
            f.child, f.nn_cond, f.parent, f.join_cond), false, true, '')))[1]::text::bigint as orphans
  from fk f
),
fk_rows as (
  select '失败' as result,
         coalesce((select r.feature from feat_rules r where f.child ~* r.pattern order by r.ord limit 1), '通用') as feature,
         '数据完整性' as category, f.child || ' → ' || f.parent as obj, '关联记录缺失（' || f.conname || '）' as item,
         '0' as expected, f.orphans::text as actual, '有记录引用了不存在的上级记录' as note
  from fk_run f
  where f.orphans > 0
  union all
  select '通过', '数据完整性', '数据完整性', '全部外键关联', '关联记录完整', count(*) || ' 项', count(*) || ' 项完整',
         '所有引用关系都能找到对应记录'
  from fk_run
  having count(*) filter (where orphans > 0) = 0
),
seqs as (
  select s.seqrelid::regclass::text as seq, dr.refobjid::regclass::text as tbl, da.attname::text as col,
         (select ps.last_value from pg_sequences ps where ps.schemaname = sn.nspname and ps.sequencename = sc.relname) as last_value
  from pg_sequence s
  join pg_class sc on sc.oid = s.seqrelid
  join pg_namespace sn on sn.oid = sc.relnamespace
  join pg_depend dr on dr.classid = 'pg_class'::regclass and dr.objid = s.seqrelid and dr.refclassid = 'pg_class'::regclass
                   and dr.refobjsubid > 0 and dr.deptype in ('a', 'i')
  join pg_attribute da on da.attrelid = dr.refobjid and da.attnum = dr.refobjsubid
  where sn.nspname in ('public', 'private')
),
seq_run as (
  select s.*,
         (xpath('/row/c/text()', query_to_xml(format('select coalesce(max(%I), 0)::text as c from %s', s.col, s.tbl), false, true, '')))[1]::text::numeric as max_val
  from seqs s
),
seq_rows as (
  select '失败' as result,
         coalesce((select r.feature from feat_rules r where s.tbl ~* r.pattern order by r.ord limit 1), '通用') as feature,
         '数据完整性' as category, s.tbl || '.' || s.col as obj, '自增编号没有落后于现有数据' as item,
         '≥ ' || s.max_val as expected, coalesce(s.last_value::text, '尚未使用') as actual,
         '新增记录时可能因编号重复而失败' as note
  from seq_run s
  where s.max_val > coalesce(s.last_value, 0)
  union all
  select '通过', '数据完整性', '数据完整性', '全部自增编号', '自增编号没有落后于现有数据', count(*) || ' 个', count(*) || ' 个正常', ''
  from seq_run
  having count(*) filter (where max_val > coalesce(last_value, 0)) = 0
),
cron_run as (
  select x.*
  from xmltable('/table/row' passing (
         case when to_regclass('cron.job_run_details') is not null then query_to_xml($q$
           select j.jobname, j.schedule, j.active::text as active,
                  to_char(max(d.end_time) filter (where d.status = 'succeeded'), 'YYYY-MM-DD HH24:MI:SS') as last_ok,
                  extract(epoch from now() - max(d.end_time) filter (where d.status = 'succeeded'))::bigint as age_s,
                  count(*) filter (where d.status = 'failed' and d.start_time > now() - interval '1 hour') as fails,
                  left((array_agg(d.return_message order by d.start_time desc)
                        filter (where d.status = 'failed' and d.start_time > now() - interval '1 hour'))[1], 200) as last_err
           from cron.job j
           left join cron.job_run_details d on d.jobid = j.jobid and d.start_time > now() - interval '8 days'
           where j.jobname is not null
           group by j.jobname, j.schedule, j.active$q$, false, false, '')
         else '<table/>'::xml end)
       columns jobname text path 'jobname', schedule text path 'schedule', active text path 'active',
               last_ok text path 'last_ok', age_s bigint path 'age_s', fails bigint path 'fails', last_err text path 'last_err') x
),
cron_rows as (
  select case when r.active is distinct from 'true' then '失败'
              when r.age_s is null or r.age_s > l.lim then case when f.freq = 'frequent' then '失败' else '警告' end
              else '通过' end as result,
         '定时任务' as feature, '定时任务运行情况' as category, r.jobname as obj, '最近一次成功运行（UTC）' as item,
         l.lim_label as expected,
         case when r.active is distinct from 'true' then '已停用' else coalesce(r.last_ok, '近 8 天没有成功记录') end as actual,
         case when f.freq = 'frequent' then '刚迁移完请等 5 分钟后再检查；一直没有成功记录说明该任务没在运行'
              else '每天/每周才运行一次，新库刚建好时可能还没轮到' end as note
  from cron_run r
  cross join lateral (select case when r.schedule ~ 'second' or r.schedule = '* * * * *' then 'frequent'
                                  when r.schedule ~ '^\S+\s+\S+\s+\*\s+\*\s+\*$' then 'daily'
                                  else 'weekly' end as freq) f
  cross join lateral (select case f.freq when 'frequent' then 600 when 'daily' then 93600 else 691200 end as lim,
                             case f.freq when 'frequent' then '10 分钟内' when 'daily' then '26 小时内' else '8 天内' end as lim_label) l
  union all
  select '警告', '定时任务', '定时任务运行情况', r.jobname, '最近 1 小时失败次数', '0', r.fails::text,
         '最近一次错误：' || coalesce(r.last_err, '')
  from cron_run r
  where r.fails > 0
),
probe(feature, item, ext, q, note) as (
  values
  ('账号登录与会话', '密码加密校验（bcrypt）可用', 'pgcrypto',
   $q$select (extensions.crypt('probe', s) = s)::text as c from (select extensions.crypt('probe', extensions.gen_salt('bf', 4)) as s) x$q$,
   '管理员和员工登录依赖它'),
  ('账号登录与会话', '登录令牌哈希（SHA-256）可用', 'pgcrypto',
   $q$select (encode(extensions.digest('probe', 'sha256'), 'hex') = encode(sha256('probe'::bytea), 'hex'))::text as c$q$,
   '登录会话验证依赖它'),
  ('平台设置', 'UUID 生成可用', null,
   $q$select (gen_random_uuid() is not null)::text as c$q$,
   '新记录编号依赖它'),
  ('平台设置', '文字相似度搜索可用（pg_trgm）', 'pg_trgm',
   $q$select (extensions.similarity('abc', 'abc') = 1)::text as c$q$,
   '员工搜索索引依赖它')
),
probe_rows as (
  select case when x.ok = 'true' then '通过' else '失败' end as result, x.feature, '运行环境' as category, x.item as obj,
         '实际调用' as item, '可用' as expected,
         case when x.ok = 'true' then '可用' when x.ok is null then '扩展不在 extensions 中' else '结果不正确' end as actual, x.note
  from (
    select p.*,
           case when p.ext is null or exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                                              where e.extname = p.ext and n.nspname = 'extensions')
                then (xpath('/row/c/text()', query_to_xml(p.q, false, true, '')))[1]::text end as ok
    from probe p
  ) x
),
storage_rows as (
  select '提示' as result, '文件存储' as feature, '文件记录' as category, '存储桶文件记录数' as obj, '各桶文件记录数' as item,
         '' as expected, coalesce(string_agg(s.bucket_id || '：' || s.n, '，' order by s.bucket_id), '没有文件记录') as actual,
         'SQL 只能看到文件记录，无法确认实际文件内容是否存在；请在新站打开几张图片/视频确认' as note
  from (select bucket_id, count(*) as n from storage.objects group by bucket_id) s
),
url_cols as (
  select format('%I.%I', n.nspname, c.relname) as tbl, a.attname::text as col
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'jsonb'::regtype, 'json'::regtype, 'text[]'::regtype)
),
url_hits as (
  select x.ref, sum(x.n) as n
  from url_cols u
  cross join lateral xmltable('/table/row' passing query_to_xml(format(
         $q$select h as ref, count(*) as n from (
              select (regexp_matches(%I::text, 'https?://([a-z0-9]+)\.supabase\.co/storage/v1/object', 'g'))[1] as h
              from %s where %I::text like '%%.supabase.co/storage/v1/object%%') s group by h$q$, u.col, u.tbl, u.col), false, false, '')
       columns ref text path 'ref', n bigint path 'n') x
  group by x.ref
),
url_rows as (
  select '提示' as result, '文件存储' as feature, '文件地址' as category, '文件地址指向的项目：' || h.ref as obj,
         '数据库中保存的图片/视频地址' as item, '' as expected, h.n || ' 处' as actual,
         '整体转移时项目 ID 不变，属正常；如果新项目 ID 不同，这些旧文件仍从该项目读取，该项目停用后会失效' as note
  from url_hits h
  union all
  select '警告', '文件存储', '文件地址', '多个项目', '数据库中保存的图片/视频地址', '1 个项目', count(*) || ' 个项目',
         '文件地址分散在多个 Supabase 项目，任一项目停用都会导致部分图片/视频失效'
  from url_hits
  having count(*) > 1
),
manual_rows as (
  select '提示' as result, '平台设置' as feature, '需人工确认' as category, 'SQL 无法检查的项目' as obj,
         '请另行确认' as item, '' as expected, '' as actual,
         'Edge Function content-audit 已部署且关闭 JWT 校验；实际图片/视频能打开；项目 API 与上传大小设置；新前端的 Supabase 地址与公开密钥' as note
),
all_rows as (
  select * from struct_rows
  union all select * from struct_pass
  union all select * from chk_rows
  union all select * from fk_rows
  union all select * from seq_rows
  union all select * from cron_rows
  union all select * from probe_rows
  union all select * from storage_rows
  union all select * from url_rows
  union all select * from manual_rows
),
summary as (
  select '总结' as result, '全部' as feature, '检查结果' as category,
         case when count(*) filter (where result = '失败') > 0 then '存在失败项，请先处理'
              when count(*) filter (where result = '警告') > 0 then '没有失败项，请查看警告'
              else '全部通过' end as obj,
         '' as item, '' as expected,
         '失败 ' || count(*) filter (where result = '失败') || ' 项，警告 ' || count(*) filter (where result = '警告')
           || ' 项，提示 ' || count(*) filter (where result = '提示') || ' 项，通过 ' || count(*) filter (where result = '通过') || ' 项' as actual,
         '结构基线生成时间：' || coalesce((select substring(line from '^#generated (.*)$') from baseline_lines
                                       where line like '#generated %' limit 1), '未知') as note
  from all_rows
)
select result as "结果", feature as "功能", category as "类别", obj as "对象", item as "检查内容",
       expected as "期望", actual as "实际", note as "说明"
from (
  select 0 as grp, * from summary where not (select g from is_gen)
  union all
  select case result when '失败' then 1 when '警告' then 2 when '提示' then 3 else 4 end, *
  from all_rows where not (select g from is_gen)
  union all
  select 0, '基线生成模式', '', '', '当前结构指纹', '复制「说明」这一格', '', '',
         '#generated ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ' UTC' || E'\n'
           || (select string_agg(line, E'\n' order by line) from cur_lines)
  where (select g from is_gen)
) z
order by grp, feature, category, obj, item;
