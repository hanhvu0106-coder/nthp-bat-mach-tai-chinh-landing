// Registration data layer for Kien Tao Hanh Phuc Toan Phan.
//
// This file is intentionally the ONLY place that talks to storage. The UI (landing.html)
// calls Registration.getNextCode / submitLead / uploadReceipt and never touches
// localStorage or any backend directly — so swapping in a real backend later means
// editing only the three functions below, nothing in landing.html.
//
// CURRENT MODE: placeholder / demo. Data is kept in this browser's localStorage only.
// It is NOT shared across devices, NOT safe against duplicate codes if two people
// register at the exact same time, and is lost if the user clears site data.
//
// TODO before real launch: replace the bodies of getNextCode/submitLead/uploadReceipt
// with calls to a real backend (Supabase Postgres function for atomic sequence +
// Storage bucket for receipts, OR a Google Apps Script Web App backed by a Sheet).

const Registration = (() => {
  const STORAGE_KEY = 'kthp_registrations';

  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeAll(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  // TODO: thay bằng RPC/API sinh mã tuần tự nguyên tử phía server (Supabase Postgres
  // sequence hoặc Google Apps Script với LockService), để không bị trùng mã khi
  // nhiều người đăng ký cùng lúc. Bản hiện tại chỉ đếm số dòng trong localStorage.
  async function getNextCode() {
    const list = readAll();
    const n = list.length + 1;
    return 'KTHP' + String(n).padStart(3, '0');
  }

  // TODO: thay bằng insert 1 dòng vào Supabase table `registrations`
  // (hoặc POST tới Google Apps Script webhook ghi vào Google Sheet).
  // Payload cần lưu: code, hoTen, soDienThoai, zalo, email, facebook, thanhPho,
  // ngheNghiep, source, mucTieu, utm, createdAt.
  async function submitLead(data) {
    const code = await getNextCode();
    const list = readAll();
    list.push({
      code,
      ...data,
      createdAt: new Date().toISOString(),
      paid: false,
      receiptNote: null,
      receiptUrl: null
    });
    writeAll(list);
    return { code };
  }

  // TODO: thay bằng upload file thật lên Supabase Storage (hoặc Google Drive qua
  // Apps Script), lấy URL công khai, rồi update dòng đăng ký tương ứng với URL đó
  // và đánh dấu paid = true. Bản hiện tại chỉ tạo URL xem tạm trong trình duyệt
  // (object URL) — KHÔNG lưu trữ lâu dài, sẽ mất khi tải lại trang.
  async function uploadReceipt(code, file, note) {
    const list = readAll();
    const idx = list.findIndex((r) => r.code === code);
    let previewUrl = null;
    if (file) {
      previewUrl = URL.createObjectURL(file);
    }
    if (idx > -1) {
      list[idx].paid = true;
      list[idx].receiptNote = note || '';
      list[idx].receiptUrl = previewUrl;
      writeAll(list);
    }
    return { ok: true };
  }

  return { getNextCode, submitLead, uploadReceipt };
})();
