-- ============================================================
-- NTHP · Bắt Mạch Tài Chính — Migration V2: Lead Gen + Email Automation
-- Chạy TOÀN BỘ file này trong Supabase SQL Editor SAU KHI đã chạy
-- supabase-migration.sql (V1). File này chỉ ADD/ALTER, không xoá dữ liệu.
-- ============================================================

-- ------------------------------------------------------------
-- 1. CỘT MỚI trên bảng registrations
-- ------------------------------------------------------------
alter table registrations
  add column if not exists payment_token uuid not null default gen_random_uuid(),
  add column if not exists lead_magnet_type text,
  add column if not exists lead_magnet_title text,
  add column if not exists lead_magnet_sent_at timestamptz,
  add column if not exists first_touch_source text,
  add column if not exists first_touch_utm_campaign text,
  add column if not exists last_touch_source text,
  add column if not exists last_touch_utm_campaign text,
  add column if not exists ref_code text,
  add column if not exists email_opt_in boolean not null default true,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists refunded_amount numeric not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists attended_at timestamptz;

create unique index if not exists idx_registrations_payment_token on registrations(payment_token);
create index if not exists idx_registrations_ref_code on registrations(ref_code);

-- ------------------------------------------------------------
-- 2. MỞ RỘNG payment_status ENUM (dùng check constraint động,
--    không phụ thuộc tên constraint cũ để tránh lỗi nếu tên khác)
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

-- Map dữ liệu cũ (nếu có) sang trạng thái mới trước khi áp constraint mới
update registrations set payment_status = 'lead_unpaid' where payment_status in ('registered','awaiting_payment');

alter table registrations add constraint registrations_payment_status_check check (payment_status in (
  'new_lead','lead_gift_sent','lead_unpaid','payment_started','payment_submitted',
  'payment_confirmed','payment_rejected','cancelled','refunded','attended','no_show'
));

alter table registrations alter column payment_status set default 'new_lead';

-- ------------------------------------------------------------
-- 3. BẢNG email_logs — chống gửi trùng, lưu lịch sử gửi email
-- ------------------------------------------------------------
create table if not exists email_logs (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid references registrations(registration_id) on delete cascade,
  email_code text not null,
  recipient_email text,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  provider_message_id text,
  error_message text,
  opened_at timestamptz,
  clicked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (registration_id, email_code)
);

create index if not exists idx_email_logs_status on email_logs(status);

alter table email_logs enable row level security;
-- Không cấp policy nào cho anon => chỉ Edge Functions (dùng service_role) đọc/ghi được bảng này.

-- ------------------------------------------------------------
-- 4. VIEW báo cáo tổng quan cho admin (CHỈ service_role đọc được,
--    không grant cho anon — chứa doanh thu, không public)
-- ------------------------------------------------------------
create or replace view admin_summary_stats as
select
  count(*) as total_leads,
  count(*) filter (where payment_status = 'payment_submitted') as awaiting_reconciliation,
  count(*) filter (where payment_status = 'payment_confirmed') as confirmed_count,
  coalesce(sum(payment_amount) filter (where payment_status = 'payment_confirmed'), 0) as confirmed_revenue,
  coalesce(sum(refunded_amount), 0) as total_refunded,
  coalesce(sum(payment_amount) filter (where payment_status = 'payment_confirmed'), 0)
    - coalesce(sum(refunded_amount), 0) as net_revenue,
  greatest(0, 50 - count(*) filter (where payment_status = 'payment_confirmed' and ticket_sale_price = 699000)) as promo_tickets_remaining
from registrations;

-- ------------------------------------------------------------
-- 5. submit_registration — MỞ RỘNG chữ ký hàm (đổi return type nên
--    phải DROP hàm cũ trước khi tạo lại, tránh lỗi "cannot change
--    return type of existing function")
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
  v_id uuid; v_code text; v_token uuid;
begin
  if p_consent is not true then raise exception 'consent_required'; end if;
  if p_full_name is null or trim(p_full_name) = '' then raise exception 'full_name_required'; end if;
  if p_phone is null or trim(p_phone) = '' then raise exception 'phone_required'; end if;

  -- Không tạo hồ sơ mới nếu SĐT này đã có lead chưa hoàn tất (chưa confirmed/cancelled) —
  -- cập nhật hồ sơ cũ thay vì nhân bản, đúng yêu cầu "nối đúng hồ sơ cũ".
  select r.registration_id, r.registration_code, r.payment_token
    into v_id, v_code, v_token
  from registrations r
  where r.phone = trim(p_phone)
    and r.payment_status not in ('payment_confirmed','cancelled')
  order by r.created_at desc
  limit 1;

  if v_id is not null then
    update registrations set
      full_name = trim(p_full_name),
      zalo = trim(p_zalo),
      city = trim(p_city),
      referral_source = p_referral_source,
      email = coalesce(nullif(trim(p_email),''), email),
      facebook_url = coalesce(nullif(trim(p_facebook_url),''), facebook_url),
      occupation = coalesce(nullif(trim(p_occupation),''), occupation),
      note = coalesce(nullif(trim(p_note),''), note),
      show_in_social_proof = coalesce(p_show_in_social_proof, show_in_social_proof),
      email_opt_in = coalesce(p_email_opt_in, email_opt_in),
      last_touch_source = coalesce(p_last_touch_source, last_touch_source),
      last_touch_utm_campaign = coalesce(p_last_touch_utm_campaign, last_touch_utm_campaign)
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
    payment_status
  ) values (
    trim(p_full_name), trim(p_phone), trim(p_zalo), trim(p_city), p_referral_source,
    nullif(trim(p_email),''), nullif(trim(p_facebook_url),''), nullif(trim(p_occupation),''), nullif(trim(p_note),''),
    coalesce(p_show_in_social_proof,false), now(), coalesce(p_email_opt_in, true),
    p_landing_page_url, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_fbclid, p_ttclid, p_gclid, p_device_type,
    nullif(trim(p_ref_code),''), p_first_touch_source, p_first_touch_utm_campaign, p_last_touch_source, p_last_touch_utm_campaign,
    p_lead_magnet_type, p_lead_magnet_title,
    'new_lead'
  ) returning registrations.registration_id, registrations.registration_code, registrations.payment_token
    into v_id, v_code, v_token;

  return query select v_id, v_code, v_token;
end;
$$;

revoke all on function submit_registration from public;
grant execute on function submit_registration to anon;

-- ------------------------------------------------------------
-- 6. get_registration_by_token — dùng cho link thanh toán cá nhân hoá
--    trong email (?registration=CODE&token=TOKEN), chỉ lộ dữ liệu
--    cần thiết để hiển thị lại đúng bước, KHÔNG lộ SĐT/email/note...
-- ------------------------------------------------------------
create or replace function get_registration_by_token(p_registration_code text, p_payment_token uuid)
returns table(
  registration_id uuid, full_name text, phone text, registration_code text, payment_status text,
  payment_amount numeric, ticket_sale_price numeric, ticket_original_price numeric,
  vat_rate numeric, lead_magnet_type text, lead_magnet_title text
)
language plpgsql security definer set search_path = public as $$
begin
  return query
  select r.registration_id, r.full_name, r.phone, r.registration_code, r.payment_status,
         r.payment_amount, r.ticket_sale_price, r.ticket_original_price,
         r.vat_rate, r.lead_magnet_type, r.lead_magnet_title
  from registrations r
  where r.registration_code = p_registration_code and r.payment_token = p_payment_token;
end;
$$;

revoke all on function get_registration_by_token from public;
grant execute on function get_registration_by_token to anon;

-- ------------------------------------------------------------
-- 7. mark_payment_started — khi khách bấm "Thanh toán ngay" từ màn hình quà tặng
-- ------------------------------------------------------------
create or replace function mark_payment_started(p_registration_id uuid, p_registration_code text, p_payment_token uuid)
returns table(ok boolean)
language plpgsql security definer set search_path = public as $$
begin
  update registrations set payment_status = 'payment_started'
  where registration_id = p_registration_id
    and registration_code = p_registration_code
    and payment_token = p_payment_token
    and payment_status in ('new_lead','lead_gift_sent','lead_unpaid');
  return query select true;
end;
$$;

revoke all on function mark_payment_started from public;
grant execute on function mark_payment_started to anon;

-- ------------------------------------------------------------
-- 8. mark_lead_unpaid — khi khách bấm "Tôi sẽ thanh toán sau"
-- ------------------------------------------------------------
create or replace function mark_lead_unpaid(p_registration_id uuid, p_registration_code text, p_payment_token uuid)
returns table(ok boolean)
language plpgsql security definer set search_path = public as $$
begin
  update registrations set payment_status = 'lead_unpaid'
  where registration_id = p_registration_id
    and registration_code = p_registration_code
    and payment_token = p_payment_token
    and payment_status in ('new_lead','lead_gift_sent','payment_started');
  return query select true;
end;
$$;

revoke all on function mark_lead_unpaid from public;
grant execute on function mark_lead_unpaid to anon;

-- ------------------------------------------------------------
-- 9. unsubscribe_email — huỷ nhận email marketing (giữ quyền nhận
--    email giao dịch bắt buộc, xử lý riêng ở tầng Edge Function)
-- ------------------------------------------------------------
create or replace function unsubscribe_email(p_registration_code text, p_payment_token uuid)
returns table(ok boolean)
language plpgsql security definer set search_path = public as $$
begin
  update registrations set unsubscribed_at = now(), email_opt_in = false
  where registration_code = p_registration_code and payment_token = p_payment_token;
  return query select true;
end;
$$;

revoke all on function unsubscribe_email from public;
grant execute on function unsubscribe_email to anon;

-- ------------------------------------------------------------
-- 10. submit_payment_confirmation — cập nhật danh sách trạng thái
--     nguồn hợp lệ theo enum mới (không đổi chữ ký hàm nên không cần drop)
-- ------------------------------------------------------------
create or replace function submit_payment_confirmation(
  p_registration_id uuid, p_registration_code text,
  p_payer_name text, p_payer_bank text, p_transfer_time timestamptz,
  p_receipt_file_url text, p_payment_note text default null
) returns table(ok boolean)
language plpgsql security definer set search_path = public as $$
declare v_found int;
begin
  update registrations
  set payer_name = trim(p_payer_name),
      payer_bank = trim(p_payer_bank),
      transfer_time = p_transfer_time,
      receipt_file_url = p_receipt_file_url,
      note = case when p_payment_note is not null and trim(p_payment_note) <> ''
                  then coalesce(note || ' | ', '') || trim(p_payment_note)
                  else note end,
      payment_status = 'payment_submitted'
  where registration_id = p_registration_id
    and registration_code = p_registration_code
    and payment_status in ('new_lead','lead_gift_sent','lead_unpaid','payment_started','payment_submitted','payment_rejected');

  get diagnostics v_found = row_count;
  if v_found = 0 then raise exception 'registration_not_found_or_invalid'; end if;

  return query select true;
end;
$$;

revoke all on function submit_payment_confirmation from public;
grant execute on function submit_payment_confirmation to anon;
