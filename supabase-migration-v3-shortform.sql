-- ============================================================
-- NTHP · Bắt Mạch Tài Chính — Migration V3: Rút gọn form đăng ký
-- Chạy SAU khi đã chạy V1 và V2. Chỉ ADD/ALTER, không xoá dữ liệu.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nới lỏng các cột không còn bắt buộc trên form mới, GIỮ NGUYÊN
--    dữ liệu Lead cũ đã có (city/referral_source cũ vẫn còn trong bảng).
-- ------------------------------------------------------------
alter table registrations alter column city drop not null;
alter table registrations alter column referral_source drop not null;

-- ------------------------------------------------------------
-- 1b. Thêm trạng thái gift_email_failed (mục 7 — Lead vẫn được lưu
--     dù email quà tặng gửi thất bại, không mất Lead).
-- ------------------------------------------------------------
do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'registrations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%payment_status%'
  loop
    execute format('alter table registrations drop constraint %I', con.conname);
  end loop;
end $$;

alter table registrations add constraint registrations_payment_status_check check (payment_status in (
  'new_lead','lead_gift_sent','lead_unpaid','gift_email_failed','payment_started','payment_submitted',
  'payment_confirmed','payment_rejected','cancelled','refunded','attended','no_show'
));

-- ------------------------------------------------------------
-- 2. Cột mới: last_seen_at (mục 12 — khi Lead cũ quay lại đăng ký/xem lại)
-- ------------------------------------------------------------
alter table registrations add column if not exists last_seen_at timestamptz;

-- ------------------------------------------------------------
-- 3. email_logs: thêm retry_count + trạng thái "retrying"
--    (không thêm delivered/bounced/complained vì Gmail SMTP hiện tại
--    không có cơ chế webhook báo trạng thái gửi — xem báo cáo bàn giao)
-- ------------------------------------------------------------
alter table email_logs add column if not exists retry_count integer not null default 0;

do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'email_logs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table email_logs drop constraint %I', con.conname);
  end loop;
end $$;

alter table email_logs add constraint email_logs_status_check
  check (status in ('pending','sent','failed','retrying','skipped'));

-- ------------------------------------------------------------
-- 4. submit_registration — email bắt buộc, dedup theo SĐT HOẶC email,
--    cập nhật last_seen_at khi Lead cũ quay lại.
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in select oid::regprocedure as sig from pg_proc where proname = 'submit_registration'
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

create or replace function submit_registration(
  p_full_name text, p_phone text, p_zalo text, p_city text, p_referral_source text,
  p_email text default null, p_facebook_url text default null,
  p_occupation text default null, p_note text default null,
  p_show_in_social_proof boolean default false, p_consent boolean default false,
  p_email_opt_in boolean default true,
  p_landing_page_url text default null, p_referrer text default null,
  p_utm_source text default null, p_utm_medium text default null, p_utm_campaign text default null,
  p_utm_content text default null, p_utm_term text default null,
  p_fbclid text default null, p_ttclid text default null, p_gclid text default null,
  p_device_type text default null,
  p_ref_code text default null,
  p_first_touch_source text default null, p_first_touch_utm_campaign text default null,
  p_last_touch_source text default null, p_last_touch_utm_campaign text default null,
  p_lead_magnet_type text default null, p_lead_magnet_title text default null
) returns table(registration_id uuid, registration_code text, payment_token uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_code text; v_token uuid; v_email text;
begin
  if p_consent is not true then raise exception 'consent_required'; end if;
  if p_full_name is null or trim(p_full_name) = '' then raise exception 'full_name_required'; end if;
  if p_phone is null or trim(p_phone) = '' then raise exception 'phone_required'; end if;
  if p_email is null or trim(p_email) = '' then raise exception 'email_required'; end if;

  v_email := lower(trim(p_email));

  -- Không tạo hồ sơ mới nếu SĐT HOẶC email này đã có lead chưa hoàn tất
  -- (chưa confirmed/cancelled) — cập nhật hồ sơ cũ + last_seen_at.
  select r.registration_id, r.registration_code, r.payment_token
    into v_id, v_code, v_token
  from registrations r
  where (r.phone = trim(p_phone) or lower(r.email) = v_email)
    and r.payment_status not in ('payment_confirmed','cancelled')
  order by r.created_at desc
  limit 1;

  if v_id is not null then
    update registrations set
      full_name = trim(p_full_name),
      zalo = trim(p_zalo),
      city = coalesce(nullif(trim(p_city),''), city),
      referral_source = coalesce(p_referral_source, referral_source),
      email = v_email,
      facebook_url = coalesce(nullif(trim(p_facebook_url),''), facebook_url),
      occupation = coalesce(nullif(trim(p_occupation),''), occupation),
      note = coalesce(nullif(trim(p_note),''), note),
      show_in_social_proof = coalesce(p_show_in_social_proof, show_in_social_proof),
      email_opt_in = coalesce(p_email_opt_in, email_opt_in),
      last_touch_source = coalesce(p_last_touch_source, last_touch_source),
      last_touch_utm_campaign = coalesce(p_last_touch_utm_campaign, last_touch_utm_campaign),
      last_seen_at = now()
    where registrations.registration_id = v_id;

    return query select v_id, v_code, v_token;
    return;
  end if;

  -- Chống spam double-submit: cùng SĐT không tạo lead hoàn toàn mới trong vòng 60 giây
  if exists (
    select 1 from registrations
    where phone = trim(p_phone) and created_at > now() - interval '60 seconds'
  ) then
    raise exception 'duplicate_submission';
  end if;

  insert into registrations (
    full_name, phone, zalo, city, referral_source, email, facebook_url, occupation, note,
    show_in_social_proof, consent_at, email_opt_in,
    landing_page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, ttclid, gclid, device_type,
    ref_code, first_touch_source, first_touch_utm_campaign, last_touch_source, last_touch_utm_campaign,
    lead_magnet_type, lead_magnet_title,
    payment_status, last_seen_at
  ) values (
    trim(p_full_name), trim(p_phone), trim(p_zalo), nullif(trim(p_city),''), p_referral_source,
    v_email, nullif(trim(p_facebook_url),''), nullif(trim(p_occupation),''), nullif(trim(p_note),''),
    coalesce(p_show_in_social_proof,false), now(), coalesce(p_email_opt_in, true),
    p_landing_page_url, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_fbclid, p_ttclid, p_gclid, p_device_type,
    nullif(trim(p_ref_code),''), p_first_touch_source, p_first_touch_utm_campaign, p_last_touch_source, p_last_touch_utm_campaign,
    p_lead_magnet_type, p_lead_magnet_title,
    'new_lead', now()
  ) returning registrations.registration_id, registrations.registration_code, registrations.payment_token
    into v_id, v_code, v_token;

  return query select v_id, v_code, v_token;
end;
$$;

revoke all on function submit_registration from public;
grant execute on function submit_registration to anon;

-- ------------------------------------------------------------
-- 5. get_email_status — cho phép frontend kiểm tra ngay sau đăng ký
--    xem email quà (U1_gift) đã gửi thành công hay thất bại, để hiển
--    thị thông báo "chưa gửi được email" mà KHÔNG làm mất Lead.
-- ------------------------------------------------------------
create or replace function get_email_status(p_registration_id uuid, p_payment_token uuid, p_email_code text)
returns table(status text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  select e.status
  from email_logs e
  join registrations r on r.registration_id = e.registration_id
  where e.registration_id = p_registration_id
    and r.payment_token = p_payment_token
    and e.email_code = p_email_code
  order by e.created_at desc
  limit 1;
end;
$$;

revoke all on function get_email_status from public;
grant execute on function get_email_status to anon;

-- ------------------------------------------------------------
-- 6. resend_gift_email — cho phép admin gửi lại email quà tặng thủ công
--    (dùng chung mã đăng ký cũ, KHÔNG tạo Lead/mã mới). Bảo vệ bằng
--    admin secret riêng (không phải anon key) — gọi qua Edge Function
--    resend-gift-email, không lộ trực tiếp cho anon.
-- ------------------------------------------------------------
create or replace function admin_resend_gift_email(p_registration_id uuid)
returns table(registration_id uuid, registration_code text, email text)
language plpgsql security definer set search_path = public as $$
begin
  delete from email_logs where email_logs.registration_id = p_registration_id and email_code = 'U1_gift';
  return query
  select r.registration_id, r.registration_code, r.email
  from registrations r
  where r.registration_id = p_registration_id;
end;
$$;

revoke all on function admin_resend_gift_email from public;
-- KHÔNG grant cho anon — chỉ service_role (Edge Function admin) được gọi hàm này.
