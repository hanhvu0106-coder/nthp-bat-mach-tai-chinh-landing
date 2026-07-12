-- ============================================================
-- NTHP · Bắt Mạch Tài Chính — Registration System Migration
-- Chạy toàn bộ file này trong Supabase SQL Editor
-- ============================================================

-- 1. Sequence cho mã đăng ký dạng BMTC-000001, BMTC-000002...
create sequence if not exists registration_code_seq start 1;

-- 2. Bảng đăng ký chính
create table if not exists registrations (
  registration_id      uuid primary key default gen_random_uuid(),
  registration_code    text unique not null default (
    'BMTC-' || lpad(nextval('registration_code_seq')::text, 6, '0')
  ),

  -- Thông tin khách hàng
  full_name             text not null,
  phone                 text not null,
  zalo                  text not null,
  email                 text,
  city                  text not null,
  occupation            text,
  referral_source       text not null check (referral_source in (
                          'tiktok','facebook','youtube','zalo','ban_be_gioi_thieu',
                          'workshop_truoc','google','khac'
                        )),
  facebook_url          text,
  note                  text,

  -- Giá vé (snapshot tại thời điểm đăng ký, không đổi dù giá sau này thay đổi)
  ticket_original_price numeric not null default 999000,
  ticket_sale_price     numeric not null default 699000,
  vat_rate              numeric not null default 0.08,
  payment_amount        numeric not null default 699000,

  -- Trạng thái thanh toán
  payment_status text not null default 'registered' check (payment_status in (
    'registered','awaiting_payment','payment_submitted',
    'payment_confirmed','payment_rejected','cancelled','refunded'
  )),

  -- Thông tin xác nhận chuyển khoản (khách tự điền ở bước "Tôi đã chuyển khoản")
  payer_name       text,
  payer_bank       text,
  transfer_time    timestamptz,
  receipt_file_url text,          -- đường dẫn trong storage, KHÔNG public

  -- Đồng ý điều khoản
  consent_at timestamptz not null default now(),

  -- Social proof: chỉ hiển thị popup nếu khách tick riêng ô này (opt-in, mặc định false)
  show_in_social_proof boolean not null default false,

  -- Marketing / UTM (tự động lưu từ URL, không phụ thuộc câu hỏi khách tự khai)
  landing_page_url text,
  referrer          text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  utm_content       text,
  utm_term          text,
  fbclid            text,
  ttclid            text,
  gclid             text,
  device_type       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_registrations_status on registrations(payment_status);
create index if not exists idx_registrations_created on registrations(created_at desc);
create index if not exists idx_registrations_phone on registrations(phone);

-- 3. Tự động cập nhật updated_at mỗi khi có thay đổi
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_registrations_updated_at on registrations;
create trigger trg_registrations_updated_at
  before update on registrations
  for each row execute function set_updated_at();

-- 4. View đếm số vé ưu đãi đã xác nhận thanh toán (dùng cho "Còn X/50 vé")
create or replace view promo_ticket_stats as
select
  count(*) filter (where payment_status = 'payment_confirmed') as confirmed_count,
  50 - count(*) filter (where payment_status = 'payment_confirmed') as remaining_count
from registrations
where ticket_sale_price = 699000;

-- 5. View an toàn cho popup social proof — CHỈ lộ dữ liệu tối thiểu, đã ẩn danh 1 phần
create or replace view public_social_proof as
select
  registration_id,
  left(full_name, position(' ' in full_name || ' ')) ||
    substring(split_part(full_name, ' ', -1) from 1 for 1) || '.' as display_name, -- "Nguyễn H."
  city,
  created_at
from registrations
where show_in_social_proof = true
  and payment_status in ('payment_submitted','payment_confirmed')
order by created_at desc
limit 20;

-- ============================================================
-- 6. ROW LEVEL SECURITY — khoá hoàn toàn bảng gốc với anon.
--    KHÔNG tạo bất kỳ policy INSERT/UPDATE/SELECT trực tiếp nào cho anon.
--    Mọi thao tác ghi đi qua 2 hàm SECURITY DEFINER bên dưới — an toàn hơn
--    nhiều so với việc dùng USING(true) trên UPDATE (điều đó sẽ cho phép
--    bất kỳ ai sửa BẤT KỲ đăng ký nào, không riêng gì đăng ký của họ).
-- ============================================================
alter table registrations enable row level security;
-- Không có policy nào cho anon => mặc định DENY toàn bộ SELECT/INSERT/UPDATE trực tiếp.
-- Admin xem toàn bộ qua Supabase Dashboard (Table Editor dùng service_role, tự bypass RLS).

grant select on public_social_proof to anon;
grant select on promo_ticket_stats to anon;

-- ------------------------------------------------------------
-- 6a. RPC: tạo đăng ký mới (thay cho INSERT trực tiếp)
-- ------------------------------------------------------------
create or replace function submit_registration(
  p_full_name text, p_phone text, p_zalo text, p_city text, p_referral_source text,
  p_email text default null, p_facebook_url text default null,
  p_occupation text default null, p_note text default null,
  p_show_in_social_proof boolean default false, p_consent boolean default false,
  p_landing_page_url text default null, p_referrer text default null,
  p_utm_source text default null, p_utm_medium text default null, p_utm_campaign text default null,
  p_utm_content text default null, p_utm_term text default null,
  p_fbclid text default null, p_ttclid text default null, p_gclid text default null,
  p_device_type text default null
) returns table(registration_id uuid, registration_code text)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_code text;
begin
  if p_consent is not true then raise exception 'consent_required'; end if;
  if p_full_name is null or trim(p_full_name) = '' then raise exception 'full_name_required'; end if;
  if p_phone is null or trim(p_phone) = '' then raise exception 'phone_required'; end if;

  insert into registrations (
    full_name, phone, zalo, city, referral_source, email, facebook_url, occupation, note,
    show_in_social_proof, consent_at,
    landing_page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, ttclid, gclid, device_type, payment_status
  ) values (
    trim(p_full_name), trim(p_phone), trim(p_zalo), trim(p_city), p_referral_source,
    nullif(trim(p_email),''), nullif(trim(p_facebook_url),''), nullif(trim(p_occupation),''), nullif(trim(p_note),''),
    coalesce(p_show_in_social_proof,false), now(),
    p_landing_page_url, p_referrer, p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_fbclid, p_ttclid, p_gclid, p_device_type, 'awaiting_payment'
  ) returning registrations.registration_id, registrations.registration_code into v_id, v_code;

  return query select v_id, v_code;
end;
$$;

revoke all on function submit_registration from public;
grant execute on function submit_registration to anon;

-- ------------------------------------------------------------
-- 6b. RPC: gửi xác nhận chuyển khoản (thay cho UPDATE trực tiếp)
--     Bắt buộc biết CẢ registration_id (uuid ngẫu nhiên) LẪN registration_code
--     — 2 giá trị này chỉ khách vừa đăng ký mới biết, đóng vai trò "mã xác thực
--     sở hữu" mà không cần hệ thống đăng nhập.
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
    and payment_status in ('awaiting_payment','payment_submitted');

  get diagnostics v_found = row_count;
  if v_found = 0 then raise exception 'registration_not_found_or_invalid'; end if;

  return query select true;
end;
$$;

revoke all on function submit_payment_confirmation from public;
grant execute on function submit_payment_confirmation to anon;

-- ============================================================
-- 7. STORAGE — bucket riêng tư cho ảnh biên lai
-- ============================================================
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Khách được TẢI LÊN nhưng không được xem/list lại (kể cả file của chính mình)
create policy "anon_can_upload_receipt"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'receipts');

-- Không tạo policy SELECT cho anon => file riêng tư, chỉ admin (service_role) xem được
-- trong Supabase Dashboard → Storage → receipts
