-- ============================================================
-- NTHP · Bắt Mạch Tài Chính — Payment Automation (SePay webhook)
-- Chạy toàn bộ file này trong Supabase SQL Editor SAU khi đã chạy
-- supabase-migration.sql, supabase-migration-v2-leadgen.sql,
-- supabase-migration-v3-shortform.sql
-- ============================================================

-- 1. Cột lưu thời điểm được xác nhận TỰ ĐỘNG bởi webhook
--    (phân biệt với xác nhận thủ công trước đây — không có cột tương đương)
alter table registrations
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by text; -- 'sepay_webhook' hoặc 'manual'

-- 2. Bảng log MỌI giao dịch ngân hàng nhận được từ SePay
--    id = đúng bằng "id" SePay gửi -> primary key tự chống xử lý trùng
--    (SePay tự động retry nếu response không phải 2xx, nên bắt buộc phải
--    idempotent: cùng 1 giao dịch gọi lại nhiều lần không được xử lý 2 lần)
create table if not exists bank_transactions (
  id                    bigint primary key,        -- SePay "id"
  gateway               text,
  transaction_date      timestamptz,
  account_number        text,
  content               text,
  transfer_type         text,                       -- 'in' | 'out'
  transfer_amount       numeric,
  reference_code        text,
  matched_registration_id uuid references registrations(registration_id),
  match_status          text not null check (match_status in (
                          'matched','unmatched_no_code','unmatched_amount','ignored_outflow'
                        )),
  raw_payload           jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists idx_bank_transactions_match_status on bank_transactions(match_status);

alter table bank_transactions enable row level security;
-- Không có policy cho anon/authenticated => mặc định DENY toàn bộ.
-- Chỉ Edge Function (dùng service_role, tự bypass RLS) mới ghi/đọc được bảng này.

-- 3. Hàm xử lý 1 giao dịch webhook — được gọi bởi Edge Function `sepay-webhook`
--    bằng service_role (KHÔNG cấp quyền cho anon).
--    Trả về đủ thông tin để Edge Function biết cần gửi email nào cho ai.
create or replace function process_bank_transaction(
  p_id bigint,
  p_gateway text,
  p_transaction_date timestamptz,
  p_account_number text,
  p_content text,
  p_transfer_type text,
  p_transfer_amount numeric,
  p_reference_code text,
  p_raw_payload jsonb
) returns table(
  outcome text,               -- 'duplicate' | 'ignored_outflow' | 'unmatched_no_code' | 'unmatched_amount' | 'confirmed'
  registration_id uuid,
  registration_code text,
  full_name text,
  email text,
  phone text,
  matched_amount numeric,
  expected_amount numeric
)
language plpgsql security definer set search_path = public as $$
declare
  v_code_digits text;
  v_reg registrations%rowtype;
begin
  -- 3a. Idempotency: nếu đã log giao dịch này rồi thì dừng ngay
  if exists (select 1 from bank_transactions bt where bt.id = p_id) then
    return query select 'duplicate'::text, null::uuid, null::text, null::text, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  -- 3b. Chỉ xử lý tiền VÀO, bỏ qua các giao dịch ra
  if p_transfer_type is distinct from 'in' then
    insert into bank_transactions(id, gateway, transaction_date, account_number, content, transfer_type, transfer_amount, reference_code, match_status, raw_payload)
    values (p_id, p_gateway, p_transaction_date, p_account_number, p_content, p_transfer_type, p_transfer_amount, p_reference_code, 'ignored_outflow', p_raw_payload);
    return query select 'ignored_outflow'::text, null::uuid, null::text, null::text, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  -- 3c. Trích mã đăng ký dạng BMTC-000123 từ nội dung chuyển khoản.
  --     Nội dung do ngân hàng/app chuyển thường viết hoa và có thể bỏ dấu gạch ngang,
  --     nên chuẩn hoá: viết hoa, tìm "BMTC" theo sau là tối đa 3 ký tự không phải số
  --     rồi đến đúng 6 chữ số.
  v_code_digits := substring(upper(coalesce(p_content, '')) from 'BMTC[^0-9]{0,3}([0-9]{6})');

  if v_code_digits is null then
    insert into bank_transactions(id, gateway, transaction_date, account_number, content, transfer_type, transfer_amount, reference_code, match_status, raw_payload)
    values (p_id, p_gateway, p_transaction_date, p_account_number, p_content, p_transfer_type, p_transfer_amount, p_reference_code, 'unmatched_no_code', p_raw_payload);
    return query select 'unmatched_no_code'::text, null::uuid, null::text, null::text, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  select * into v_reg from registrations r
    where r.registration_code = 'BMTC-' || v_code_digits
    limit 1;

  if v_reg.registration_id is null then
    insert into bank_transactions(id, gateway, transaction_date, account_number, content, transfer_type, transfer_amount, reference_code, match_status, raw_payload)
    values (p_id, p_gateway, p_transaction_date, p_account_number, p_content, p_transfer_type, p_transfer_amount, p_reference_code, 'unmatched_no_code', p_raw_payload);
    return query select 'unmatched_no_code'::text, null::uuid, null::text, null::text, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  -- 3d. Nếu vé này đã được xác nhận từ trước (thủ công hoặc webhook khác) thì không xử lý lại,
  --     nhưng vẫn log để có dấu vết đối soát.
  if v_reg.payment_status = 'payment_confirmed' then
    insert into bank_transactions(id, gateway, transaction_date, account_number, content, transfer_type, transfer_amount, reference_code, matched_registration_id, match_status, raw_payload)
    values (p_id, p_gateway, p_transaction_date, p_account_number, p_content, p_transfer_type, p_transfer_amount, p_reference_code, v_reg.registration_id, 'unmatched_amount', p_raw_payload);
    return query select 'unmatched_amount'::text, v_reg.registration_id, v_reg.registration_code, v_reg.full_name, v_reg.email, v_reg.phone, p_transfer_amount, v_reg.payment_amount;
    return;
  end if;

  -- 3e. Số tiền phải khớp CHÍNH XÁC giá vé đã chốt lúc đăng ký (699.000đ hoặc 999.000đ).
  --     Không tự confirm nếu lệch số tiền — đẩy sang diện cần BTC kiểm tra tay để tránh
  --     xác nhận nhầm khi khách chuyển thiếu/thừa hoặc gộp nhiều vé trong 1 lần chuyển.
  if p_transfer_amount is distinct from v_reg.payment_amount then
    insert into bank_transactions(id, gateway, transaction_date, account_number, content, transfer_type, transfer_amount, reference_code, matched_registration_id, match_status, raw_payload)
    values (p_id, p_gateway, p_transaction_date, p_account_number, p_content, p_transfer_type, p_transfer_amount, p_reference_code, v_reg.registration_id, 'unmatched_amount', p_raw_payload);
    return query select 'unmatched_amount'::text, v_reg.registration_id, v_reg.registration_code, v_reg.full_name, v_reg.email, v_reg.phone, p_transfer_amount, v_reg.payment_amount;
    return;
  end if;

  -- 3f. Khớp đủ điều kiện -> xác nhận tự động
  update registrations
    set payment_status = 'payment_confirmed',
        confirmed_at = coalesce(p_transaction_date, now()),
        confirmed_by = 'sepay_webhook'
    where registration_id = v_reg.registration_id;

  insert into bank_transactions(id, gateway, transaction_date, account_number, content, transfer_type, transfer_amount, reference_code, matched_registration_id, match_status, raw_payload)
  values (p_id, p_gateway, p_transaction_date, p_account_number, p_content, p_transfer_type, p_transfer_amount, p_reference_code, v_reg.registration_id, 'matched', p_raw_payload);

  return query select 'confirmed'::text, v_reg.registration_id, v_reg.registration_code, v_reg.full_name, v_reg.email, v_reg.phone, p_transfer_amount, v_reg.payment_amount;
end;
$$;

-- Không cấp quyền cho anon/authenticated. Chỉ service_role (Edge Function) gọi được —
-- service_role tự bypass mọi grant/RLS nên không cần dòng grant nào ở đây.
revoke all on function process_bank_transaction from public;
