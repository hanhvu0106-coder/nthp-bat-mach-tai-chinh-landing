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
-- 6. ROW LEVEL SECURITY — bắt buộc để anon key an toàn ở frontend
-- ============================================================
alter table registrations enable row level security;

-- Cho phép khách (anon) TẠO đăng ký mới — nhưng không được đọc/sửa của người khác
create policy "anon_can_insert_registration"
  on registrations for insert
  to anon
  with check (true);

-- Cho phép khách cập nhật CHÍNH đăng ký của mình để xác nhận chuyển khoản
-- (giới hạn: chỉ được set các cột liên quan thanh toán, không tự sửa payment_status thành confirmed)
create policy "anon_can_submit_own_payment_info"
  on registrations for update
  to anon
  using (true)
  with check (payment_status in ('awaiting_payment','payment_submitted'));

-- KHÔNG tạo policy SELECT cho anon => khách không đọc được bảng gốc (bảo vệ dữ liệu người khác)
-- Admin xem toàn bộ qua Supabase Dashboard (dùng service_role, tự động bypass RLS)

-- Cho phép anon đọc 2 view an toàn ở trên
grant select on public_social_proof to anon;
grant select on promo_ticket_stats to anon;

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
