-- 只在目标项目运行；先用最新版 03 复制文件，再填写下方目标项目地址。
-- 仅扫描和切换 public.announcements.content，按正文引用处理公开桶文件（不限 announcement-images）。
-- 支持新增文件、多个来源及同一路径多来源；按唯一桶／路径核对对象，要求03的SHA-256迁移凭据。出错时整体撤销本次修改，仅保留临时结果表。
-- 03 有待处理、检查异常、操作失败或停止时不要运行；HTTP 400 不等于文件丢失。
-- 必须运行全文并查看最后的结果表；「未通过（已撤销）」不是成功。SQL 红色报错或未返回结果表也不算完成。
-- 默认拒绝缺失文件；v_allow_missing 仅用于人工核实原站也已缺失、目标无记录的路径。
-- 不改公告标题、聊天、富卡及哈希、通知、头像、实名、范本、配置或历史证据，不操作任何触发器。
-- 保留全部旧可信来源，仅补入目标来源；不扫描其他内容或历史用途，也不复制公告数据库记录。

do $switch$
declare
  v_new text := 'https://在这里填新项目地址.supabase.co';  -- 【填写这里】
  v_allow_missing text[] := '{}';
  v_origin_pattern constant text := '^https://[a-z0-9]{20}\.supabase\.co$';
  v_old text;
  v_found text[];
  v_target record;
  v_total bigint := 0;
  v_count bigint;
  v_rows bigint;
  v_hit boolean;
  v_pending bigint;
  v_copied bigint;
  v_missing bigint;
  v_allowed bigint;
  v_example text;
  v_missing_example text;
  v_leftovers text[] := '{}';
  v_seq int := 0;
  v_stage text := '输入检查';
  v_error text;
  v_detail text;
  v_hint text;
  v_state text;
  v_check record;
  v_before bigint;
  v_after bigint;
  v_expected bigint;
  v_target_before bigint := 0;
  v_target_after bigint := 0;
begin
  drop table if exists pg_temp.storage_origin_switch_report;
  create temp table storage_origin_switch_report (seq int, 项目 text, 结果 text, 说明 text);
  begin
  v_new := rtrim(lower(btrim(v_new)), '/');
  if v_new !~ v_origin_pattern then
    raise exception '请先把【填写这里】改成目标项目地址。现在填的是：%。本次没有做任何修改。', v_new;
  end if;

  create or replace function pg_temp.decode_storage_path(value text) returns text
  language sql immutable set search_path = pg_catalog as $decode$
    select convert_from(decode(string_agg(case when piece[1] ~ '^%[0-9a-fA-F]{2}$'
      then substr(piece[1], 2) else encode(convert_to(piece[1], 'UTF8'), 'hex') end, ''), 'hex'), 'UTF8')
    from regexp_matches(replace(value, '&amp;', '&'), '(%[0-9a-fA-F]{2}|.)', 'g') piece;
  $decode$;

  create or replace function pg_temp.storage_media_urls(value text) returns setof text
  language plpgsql immutable set search_path = pg_catalog as $media$
  declare
    remaining text := value;
    matched text[];
    media_url text;
    at_position int;
    depth int;
    i int;
  begin
    loop
      matched := regexp_match(remaining, 'https://[a-z0-9]{20}\.supabase\.co/storage/v1/[^"''<>[:space:]\\]+', 'i');
      exit when matched is null;
      media_url := matched[1];
      at_position := strpos(remaining, media_url);
      if regexp_replace(left(remaining, at_position - 1), '[[:space:]]+$', '') ~* '(\]\(|\murl\()$' then
        depth := 0;
        for i in 1..length(media_url) loop
          if substr(media_url, i, 1) = '(' then depth := depth + 1; end if;
          if substr(media_url, i, 1) = ')' then
            if depth = 0 then media_url := left(media_url, i - 1); exit; end if;
            depth := depth - 1;
          end if;
        end loop;
      end if;
      return next media_url;
      remaining := substr(remaining, at_position + length(media_url));
    end loop;
  end;
  $media$;

  create temp table storage_origin_switch_targets on commit drop as
  select * from (values
    ('public', 'announcements', 'content')
  ) t(sch, tbl, col);

  v_stage := '扫描当前公告媒体';
  create temp table storage_origin_switch_docs (t text) on commit drop;
  for v_target in select * from pg_temp.storage_origin_switch_targets loop
    execute format('insert into pg_temp.storage_origin_switch_docs select %1$I::text from %2$I.%3$I where %1$I::text like $1',
                   v_target.col, v_target.sch, v_target.tbl)
      using '%.supabase.co/storage/v1/%';
  end loop;

  select coalesce(array_agg(distinct o order by o), '{}') into v_found
  from (
    select 'https://' || m[1] || '.supabase.co' as o
    from pg_temp.storage_origin_switch_docs d,
         regexp_matches(d.t, 'https://([a-z0-9]{20})\.supabase\.co/storage/v1/', 'g') m
  ) s where o <> v_new;

  if exists (
    select 1 from pg_temp.storage_origin_switch_docs d, pg_temp.storage_media_urls(d.t) u,
      regexp_matches(u, '^https://([a-z0-9]{20})\.supabase\.co/storage/v1/([^"''<>[:space:]\\]+)') m
    where 'https://' || m[1] || '.supabase.co' = any(v_found) and m[2] not like 'object/public/%'
  ) then
    raise exception '发现非公开 Storage 地址（例如临时签名链接），不能直接替换域名。请先核实该文件。本次没有做任何修改。';
  end if;

  create temp table storage_origin_switch_refs on commit drop as
  select distinct pg_temp.decode_storage_path(m[2]) as bucket,
         pg_temp.decode_storage_path(m[3]) as path
  from pg_temp.storage_origin_switch_docs d, pg_temp.storage_media_urls(d.t) u,
       regexp_matches(u, '^https://([a-z0-9]{20})\.supabase\.co/storage/v1/object/public/([^/"''<>[:space:]?#\\]+)/([^"''<>[:space:]?#\\]+)') m
  where 'https://' || m[1] || '.supabase.co' = any(v_found);

  v_stage := '文件迁移核对';
  with checked as (
    select r.*, o.id,
      coalesce(to_jsonb(o) #>> '{user_metadata,storageMigration,target}' = v_new
        and to_jsonb(o) #>> '{user_metadata,storageMigration,bytes}' = o.metadata ->> 'size'
        and to_jsonb(o) #>> '{user_metadata,storageMigration,version}' = '3'
        and to_jsonb(o) #>> '{user_metadata,storageMigration,sha256}' ~ '^[a-f0-9]{64}$', false) as verified
    from pg_temp.storage_origin_switch_refs r
    left join storage.objects o on o.bucket_id = r.bucket and o.name = r.path
  )
  select count(*) filter (where id is not null and not verified),
         count(*) filter (where id is not null and verified),
         count(*) filter (where id is null and not (bucket || '/' || path = any(v_allow_missing))),
         count(*) filter (where id is null and bucket || '/' || path = any(v_allow_missing)),
         min(bucket || '/' || path) filter (where id is not null and not verified),
         min(bucket || '/' || path) filter (where id is null and not (bucket || '/' || path = any(v_allow_missing)))
    into v_pending, v_copied, v_missing, v_allowed, v_example, v_missing_example
  from checked;

  if v_pending > 0 then
    raise exception '还有 % 个被引用的文件没有复制到这个项目（例如 %）。请先用最新版 03_copy_storage_files.html 完成复制；仅有文件记录、更新时间变化或 HTTP 400 均不能证明文件已复制。不要跳过失败项，并确认当前是目标项目。本次没有做任何修改。', v_pending, v_example;
  end if;
  if v_missing > 0 then
    raise exception '还有 % 个被引用的新文件或其他文件在目标 Storage 没有记录（例如 %）。必须先用 03 上传，不能默认当作旧站已缺失。本次没有做任何修改。', v_missing, v_missing_example;
  end if;

  create temp table storage_origin_switch_counts (
    sch text, tbl text, col text, old_links bigint, target_links bigint
  ) on commit drop;
  for v_target in select * from pg_temp.storage_origin_switch_targets loop
    execute format('select coalesce(sum((length(%1$I::text) - length(replace(%1$I::text, $1, ''''))) / length($1)), 0) from %2$I.%3$I where %1$I::text like $2',
                   v_target.col, v_target.sch, v_target.tbl)
      into v_before using v_new || '/storage/v1/', '%' || v_new || '/storage/v1/%';
    v_expected := 0;
    foreach v_old in array v_found loop
      execute format('select coalesce(sum((length(%1$I::text) - length(replace(%1$I::text, $1, ''''))) / length($1)), 0) from %2$I.%3$I where %1$I::text like $2',
                     v_target.col, v_target.sch, v_target.tbl)
        into v_count using v_old || '/storage/v1/', '%' || v_old || '/storage/v1/%';
      v_expected := v_expected + v_count;
    end loop;
    insert into pg_temp.storage_origin_switch_counts values (v_target.sch, v_target.tbl, v_target.col, v_expected, v_before);
    v_target_before := v_target_before + v_before;
  end loop;

  v_stage := '切换地址';
  insert into private.content_audit_storage_origins(origin) values (v_new) on conflict do nothing;

  foreach v_old in array v_found loop
    for v_target in select * from pg_temp.storage_origin_switch_targets loop
      execute format('select coalesce(sum((length(%1$I::text) - length(replace(%1$I::text, $1, ''''))) / length($1)), 0) from %2$I.%3$I where %1$I::text like $2',
                     v_target.col, v_target.sch, v_target.tbl)
        into v_count using v_old || '/storage/v1/', '%' || v_old || '/storage/v1/%';
      v_total := v_total + v_count;
      execute format('update %2$I.%3$I set %1$I = replace(%1$I, $1, $2) where %1$I like $3',
                     v_target.col, v_target.sch, v_target.tbl)
        using v_old || '/storage/v1/', v_new || '/storage/v1/', '%' || v_old || '/storage/v1/%';
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        v_seq := v_seq + 1;
        insert into pg_temp.storage_origin_switch_report values
          (10 + v_seq, v_target.tbl || '.' || v_target.col, '已修改', v_rows || ' 行，' || v_count || ' 处地址，来源 ' || v_old);
      end if;
    end loop;
  end loop;

  v_stage := '切换后核对';

  for v_check in select * from pg_temp.storage_origin_switch_counts loop
    execute format('select coalesce(sum((length(%1$I::text) - length(replace(%1$I::text, $1, ''''))) / length($1)), 0) from %2$I.%3$I where %1$I::text like $2',
                   v_check.col, v_check.sch, v_check.tbl)
      into v_after using v_new || '/storage/v1/', '%' || v_new || '/storage/v1/%';
    if v_after <> v_check.old_links + v_check.target_links then
      raise exception '目标地址数量核对未通过：%.%.% 预期%处，实际%处。本次所有修改已撤销。',
        v_check.sch, v_check.tbl, v_check.col, v_check.old_links + v_check.target_links, v_after;
    end if;
    v_target_after := v_target_after + v_after;
  end loop;
  select coalesce(sum(old_links), 0) into v_expected from pg_temp.storage_origin_switch_counts;
  if v_total <> v_expected then
    raise exception '切换数量核对未通过：预期%处，实际处理%处。本次所有修改已撤销。', v_expected, v_total;
  end if;

  for v_target in select * from pg_temp.storage_origin_switch_targets loop
    execute format('select exists (select 1 from %2$I.%3$I where %1$I like $3 and exists (
      select 1 from regexp_matches(%1$I, $2, ''g'') m where ''https://'' || m[1] || ''.supabase.co'' <> $1
    ))', v_target.col, v_target.sch, v_target.tbl)
      into v_hit using v_new, 'https://([a-z0-9]{20})\.supabase\.co/storage/v1/', '%.supabase.co/storage/v1/%';
    if v_hit then
      v_leftovers := v_leftovers || (v_target.sch || '.' || v_target.tbl || '.' || v_target.col);
    end if;
  end loop;
  if cardinality(v_leftovers) > 0 then
    raise exception '修改后仍有旧项目地址残留在：%。本次所有修改已撤销，需要先核实这些字段。', array_to_string(v_leftovers, '、');
  end if;

  if v_total = 0 then
    insert into pg_temp.storage_origin_switch_report values
      (1, '无需切换', '通过', '已重新扫描当前公告正文，没有需要修改的媒体地址；这不代表SQL已验证文件可读取。目标 ' || v_new);
  else
    insert into pg_temp.storage_origin_switch_report values
      (1, '总结', case when v_allowed > 0 then '完成（有警告）' else '完成' end, '共改 ' || v_total || ' 处旧地址，来源 ' || array_to_string(v_found, '、') || '，目标 ' || v_new),
      (4, '被引用的文件', '凭据通过', v_copied || ' 个唯一桶／路径的目标项目、大小及03核验SHA-256凭据已通过；实际可读取仍需03复检'),
      (5, '已确认原站缺失的文件', case when v_allowed = 0 then '无' else '警告' end, v_allowed || ' 个显式允许缺失的文件，仍无法显示');
  end if;
  insert into pg_temp.storage_origin_switch_report values
    (2, '地址数量核对', '通过', '1 个媒体字段 public.announcements.content 核对：原有目标地址 ' || v_target_before || ' 处 + 本次切换 ' || v_total || ' 处 = 切换后 ' || v_target_after || ' 处'),
    (3, '旧地址残留', '通过', '公告正文旧项目 Storage 地址残留0个；不检查标题或其他内容'),
    (6, '内容稽核可信地址', '已确认', '已加入目标 ' || v_new || '；全部旧可信来源均保留，未扫描历史用途'),
    (7, '触发器', '未改动', '未关闭、开启或修改任何触发器；现有媒体删除保护保持原状'),
    (8, '实际文件可读性', '需03复检', 'SQL只能检查链接和文件迁移凭据，不能读取实际文件；请用03「只检查」复检，并在网站抽查图片／视频'),
    (9, '后续处理', case when v_allowed > 0 then '有缺失警告' else '请复检' end,
      case when v_allowed > 0 then '存在人工允许的缺失文件，仍无法显示；恢复文件后重跑03。' else '若03出现待处理或检查异常，请修复后重跑03，再运行04；不要把SQL执行结束等同于文件全部正常。' end),
    (10, '处理范围', '仅公告正文', '仅修改 public.announcements.content；公告标题、聊天、富卡及哈希、通知、头像、实名、范本、配置与历史证据均未改动');
  exception when others then
    get stacked diagnostics v_error = message_text, v_detail = pg_exception_detail,
      v_hint = pg_exception_hint, v_state = returned_sqlstate;
    insert into pg_temp.storage_origin_switch_report values
      (1, '总结', '未通过（已撤销）', '本次公告正文与新增可信来源修改均未保留；其他内容与触发器未改动，不能当作切换成功'),
      (2, '中止阶段', '未通过', v_stage),
      (3, '具体原因', '需处理', v_error || ' [SQLSTATE ' || v_state || ']'),
      (4, '后续处理', '请修复后重跑', coalesce(nullif(v_hint, ''),
        case when v_stage = '输入检查' then '核对目标项目地址，并在目标项目运行完整04脚本。'
          when v_stage = '文件迁移核对' then '先用最新版03逐文件比对来源、处理待复制文件并取得带SHA-256的目标凭据；报告通过后重跑04，不要自动忽略问题文件。'
          else '按具体原因核实字段、权限、约束或触发器；可将本结果表发给维护人员。修复后运行完整04，不要单独执行其中UPDATE。' end));
    if nullif(v_detail, '') is not null then
      insert into pg_temp.storage_origin_switch_report values (5, '错误详情', '供排查', v_detail);
    end if;
  end;
end
$switch$;

select 项目, 结果, 说明 from pg_temp.storage_origin_switch_report order by seq;
