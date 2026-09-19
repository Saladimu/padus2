/**
 * BACKEND ABSENSI PADUAN SUARA
 * Deploy sebagai Web App -> Execute as: Me -> Access: Anyone
 */

const SHEET_NAME_STUDENTS = 'STUDENTS';
const SHEET_NAME_ATTENDANCE = 'ATTENDANCE';

// Kolom STUDENTS: [0]=ID, [1]=Nama, [2]=Kelas, [3]=PIN, [4]=Status
// Kolom ATTENDANCE: [0]=Timestamp, [1]=Tanggal, [2]=ID, [3]=Nama, [4]=Kelas, [5]=Jenis, [6]=Remark, [7]=Status
const PIN_SALT = 'choir-absensi-salt';

const VALID_TYPES = [
  'Latihan Rutin', 'Latihan Vokal', 'Latihan Lagu',
  'Persiapan Lomba', 'Persiapan Pentas', 'Gladi Bersih',
  'Latihan Tambahan', 'Lainnya', 'Izin'
];

// Rate limit verifikasi untuk mencegah brute-force PIN
const VERIFY_MAX_FAILS = 5;          // maksimal percobaan gagal per identitas
const VERIFY_WINDOW_MIN = 5;         // durasi blokir (menit)
const VERIFY_GLOBAL_MAX_FAILS = 50;  // pengaman global bila banyak percobaan gagal
const VERIFY_CACHE_TTL = 300;        // detik (5 menit)

let cachedVerifyCache = null;
function getVerifyCache() {
  if (!cachedVerifyCache) cachedVerifyCache = CacheService.getScriptCache();
  return cachedVerifyCache;
}

let cachedScriptTimeZone = null;
function getScriptTimeZone() {
  if (cachedScriptTimeZone === null) cachedScriptTimeZone = Session.getScriptTimeZone();
  return cachedScriptTimeZone;
}

let cachedSpreadsheet = null;
function getSpreadsheet() {
  if (!cachedSpreadsheet) cachedSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return cachedSpreadsheet;
}

function verifyFailCountKey(idKey) {
  return 'vfail:' + idKey;
}

function verifyBlockKey(idKey) {
  return 'vblock:' + idKey;
}

// Mengembalikan sisa menit blokir (0 = tidak terblokir).
function verifyBlocked(idKey) {
  const cache = getVerifyCache();
  const until = Number(cache.get(verifyBlockKey(idKey)) || 0);
  if (until > Date.now()) {
    return Math.max(1, Math.ceil((until - Date.now()) / 60000));
  }
  const globalUntil = Number(cache.get('vblock:global') || 0);
  if (globalUntil > Date.now()) {
    return Math.max(1, Math.ceil((globalUntil - Date.now()) / 60000));
  }
  return 0;
}

// Catat kegagalan verifikasi; kembalikan true jika kini terblokir.
function recordVerifyFail(idKey) {
  const cache = getVerifyCache();
  const countKey = verifyFailCountKey(idKey);
  const count = Number(cache.get(countKey) || 0) + 1;

  const g = Number(cache.get('vgfail') || 0) + 1;
  cache.put('vgfail', String(g), VERIFY_CACHE_TTL);
  if (g >= VERIFY_GLOBAL_MAX_FAILS) {
    cache.put('vblock:global', String(Date.now() + VERIFY_WINDOW_MIN * 60000), VERIFY_CACHE_TTL);
  }

  if (count >= VERIFY_MAX_FAILS) {
    cache.put(verifyBlockKey(idKey), String(Date.now() + VERIFY_WINDOW_MIN * 60000), VERIFY_CACHE_TTL);
    cache.remove(countKey);
    return true;
  }
  cache.put(countKey, String(count), VERIFY_CACHE_TTL);
  return false;
}

// Bersihkan catatan kegagalan saat verifikasi berhasil.
function clearVerifyFails(idKey) {
  const cache = getVerifyCache();
  cache.remove(verifyFailCountKey(idKey));
  cache.remove(verifyBlockKey(idKey));
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'verify') {
      return respond(verifyStudent(data.id, data.pin));
    } else if (action === 'submit') {
      return respond(submitAttendance(data));
    } else if (action === 'ping') {
      return respond({ success: true, message: 'pong' });
    } else if (action === 'report') {
      return respond(getAttendanceReport(data.date, data.lean === true));
    } else if (action === 'students') {
      return respond(getStudentList());
    } else if (action === 'backup') {
      return respond(backupSheets());
    } else if (action === 'backuplist') {
      return respond(listBackups());
    } else if (action === 'history') {
      return respond(getStudentHistory(data.id));
    } else if (action === 'maintenance') {
      return respond(handleMaintenance(data.value));
    } else if (action === 'debug') {
      return respond(debugCheck(data.id));
    }

    return respond({ success: false, message: 'Action tidak valid.' });
  } catch (err) {
    console.error('doPost error:', err);
    return respond({ success: false, message: 'Terjadi kesalahan server.' });
  }
}

function doOptions(e) {
  // Dibutuhkan untuk preflight CORS pada web app Google Apps Script.
  return respond({ success: true });
}

const MAINTENANCE_KEY = 'choir_maintenance';

function getMaintenanceMode() {
  return PropertiesService.getScriptProperties().getProperty(MAINTENANCE_KEY) === '1';
}

function setMaintenanceMode(value) {
  PropertiesService.getScriptProperties().setProperty(MAINTENANCE_KEY, value ? '1' : '0');
}

function handleMaintenance(value) {
  if (typeof value === 'boolean') {
    setMaintenanceMode(value);
  }
  return { success: true, maintenance: getMaintenanceMode() };
}

// Dipakai untuk menolak permintaan saat mode maintenance aktif, sehingga
// klien yang masih membuka halaman lama tetap tidak bisa menulis data.
function maintenanceBlockResponse() {
  return {
    success: false,
    maintenance: true,
    message: 'Aplikasi sedang dalam mode maintenance. Silakan coba lagi nanti.'
  };
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// SEMENTARA: hanya untuk diagnosa format data, hapus setelah selesai.
function debugCheck(studentId) {
  const sheet = getSheet(SHEET_NAME_ATTENDANCE);
  if (!sheet) return { success: false, message: 'Sheet ATTENDANCE tidak ditemukan.' };
  const rows = getAttendanceData(sheet);
  const now = new Date();
  const dateString = Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd');
  const target = String(studentId || '').trim().toUpperCase();
  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    const recId = rows[i][2] ? String(rows[i][2]).trim().toUpperCase() : '';
    if (target && recId !== target) continue;
    matches.push({
      col1Raw: rows[i][1],
      col1IsDate: isDateValue(rows[i][1]),
      col2: rows[i][2],
      matchesToday: matchesToday(rows[i][1], dateString)
    });
  }
  return {
    success: true,
    todayGMT7: dateString,
    scriptTimezone: getScriptTimeZone(),
    targetId: target,
    rowCount: rows.length - 1,
    matches: matches
  };
}

function getSheet(name) {
  return getSpreadsheet().getSheetByName(name);
}

// Ambil nilai sheet dibatasi getLastRow()/getLastColumn() agar tidak memindai
// baris kosong di ekor sheet. Baris pertama (header) tetap disertakan sehingga
// loop pemanggil yang mulai dari indeks 1 tidak perlu diubah.
function getBoundedValues(sheet, minCols) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  const lastCol = Math.max(sheet.getLastColumn(), minCols || 1);
  return sheet.getRange(1, 1, lastRow, lastCol).getValues();
}

function getAttendanceData(sheet) {
  return getBoundedValues(sheet, 8);
}

// Cache daftar siswa (ID/Nama/Kelas/PIN/Status). STUDENTS jarang berubah dan
// selalu dibaca saat verify/report/students/history. TTL singkat agar
// perubahan manual di sheet tetap terbaca.
const STUDENTS_CACHE_KEY = 'students:list:v1';
const STUDENTS_CACHE_TTL = 120;

function getStudentsData() {
  const cache = getVerifyCache();
  const cached = cache.get(STUDENTS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* cache rusak, muat ulang */ }
  }
  const sheet = getSheet(SHEET_NAME_STUDENTS);
  if (!sheet) return null;
  const data = getBoundedValues(sheet, 5);
  try { cache.put(STUDENTS_CACHE_KEY, JSON.stringify(data), STUDENTS_CACHE_TTL); } catch (e) { /* data terlalu besar untuk cache */ }
  return data;
}

function hashPin(pin) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    PIN_SALT + pin
  );
  return digest.map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

function pinMatches(storedPin, inputPin) {
  const stored = (storedPin || '').toString().trim();
  const input = (inputPin || '').toString().trim();
  if (!stored || !input) return false;
  // Mendukung PIN lama (plaintext) maupun PIN baru (hash SHA-256, 64 hex).
  if (/^[0-9a-f]{64}$/.test(stored)) {
    return stored === hashPin(input);
  }
  return stored === input;
}

function isDateValue(v) {
  return v instanceof Date || Object.prototype.toString.call(v) === '[object Date]';
}

function matchesToday(cellValue, todayString) {
  if (!cellValue) return false;
  if (isDateValue(cellValue)) {
    // Object Date dari Sheets kadang gagal dicek dengan instanceof, gunakan isDateValue().
    const tz = getScriptTimeZone();
    if (Utilities.formatDate(cellValue, tz, 'yyyy-MM-dd') === todayString) return true;
    if (tz !== 'GMT+7' && Utilities.formatDate(cellValue, 'GMT+7', 'yyyy-MM-dd') === todayString) return true;
    return false;
  }
  const text = String(cellValue).trim();
  // Menangani teks "2026-08-24", "2026-08-24 08:00:00", dsb.
  if (text.substring(0, 10) === todayString) return true;
  return text === todayString;
}

function getTodayRecord(studentId) {
  const sheet = getSheet(SHEET_NAME_ATTENDANCE);
  if (!sheet) return null;
  const data = getAttendanceData(sheet);
  const now = new Date();
  const dateString = Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd');

  for (let i = data.length - 1; i >= 1; i--) {
    if (!data[i] || data[i][2] === '') continue;

    const recId = data[i][2] ? data[i][2].toString().trim().toUpperCase() : '';
    if (recId !== studentId) continue;

    if (matchesToday(data[i][1], dateString)) {
      return {
        date: dateString,
        type: data[i][5] || '',
        remark: data[i][6] || ''
      };
    }
  }
  return null;
}

function verifyStudent(id, pin, skipTodayCheck) {
  if (getMaintenanceMode()) return maintenanceBlockResponse();
  if (!id || !pin) return { success: false, message: 'Student ID/Nama dan PIN wajib diisi.' };
  if (id.toString().length > 50 || pin.toString().length > 20) {
    return { success: false, message: 'Student ID/Nama atau PIN terlalu panjang.' };
  }

  const idKey = id.toString().trim().toUpperCase();

  const blockedMin = verifyBlocked(idKey);
  if (blockedMin > 0) {
    return { success: false, message: 'Terlalu banyak percobaan gagal. Coba lagi dalam ' + blockedMin + ' menit.' };
  }

  const data = getStudentsData();
  if (!data) return { success: false, message: 'Sheet STUDENTS tidak ditemukan.' };
  const input = idKey;

  for (let i = 1; i < data.length; i++) {
    if (!data[i] || data[i][0] === '') continue;

    const rowId = data[i][0] ? data[i][0].toString().trim().toUpperCase() : '';
    const rowName = data[i][1] ? data[i][1].toString().trim().toUpperCase() : '';
    const rowClass = data[i][2] || '';
    const rowPin = data[i][3] || '';
    const rowStatus = data[i][4] ? data[i][4].toString().trim().toUpperCase() : '';

    // Cocokkan dengan Student ID ATAU Nama (case-insensitive)
    if (rowId !== input && rowName !== input) continue;

    if (rowStatus !== 'ACTIVE') {
      recordVerifyFail(idKey);
      return { success: false, message: 'Akun Anda tidak memiliki akses untuk melakukan absensi.' };
    }
    if (!pinMatches(rowPin, pin)) {
      recordVerifyFail(idKey);
      return { success: false, message: 'PIN yang dimasukkan salah.' };
    }

    clearVerifyFails(idKey);

    const response = {
      success: true,
      data: { id: rowId, name: data[i][1] || '', className: rowClass }
    };

    if (!skipTodayCheck) {
      const todayRecord = getTodayRecord(rowId);
      if (todayRecord) {
        response.already = true;
        response.record = todayRecord;
      }
    }

    return response;
  }

  recordVerifyFail(idKey);
  return { success: false, message: 'Student ID atau Nama tidak terdaftar. Silakan hubungi guru pembimbing.' };
}

function getAttendanceReport(date, lean) {
  const sheet = getSheet(SHEET_NAME_ATTENDANCE);
  if (!sheet) return { success: false, message: 'Sheet ATTENDANCE tidak ditemukan.' };
  if (!date) return { success: false, message: 'Tanggal wajib diisi.' };

  const target = String(date).trim();
  const todayStr = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
  if (target > todayStr) return { success: false, message: 'Tanggal tidak boleh melebihi hari ini.' };
  const data = getAttendanceData(sheet);
  const records = [];
  const attendedIds = {};

  function formatTimestamp(v) {
    if (!v) return '';
    if (isDateValue(v)) return Utilities.formatDate(v, 'GMT+7', 'yyyy-MM-dd HH:mm:ss');
    return String(v).trim();
  }

  for (let i = 1; i < data.length; i++) {
    if (!data[i] || data[i][1] === '') continue;
    if (!matchesToday(data[i][1], target)) continue;

    const id = data[i][2] ? String(data[i][2]).trim().toUpperCase() : '';
    if (id) attendedIds[id] = true;

    records.push({
      timestamp: formatTimestamp(data[i][0]),
      id: data[i][2] ? String(data[i][2]) : '',
      name: data[i][3] ? String(data[i][3]) : '',
      className: data[i][4] ? String(data[i][4]) : '',
      type: data[i][5] ? String(data[i][5]) : '',
      remark: data[i][6] ? String(data[i][6]) : '',
      status: data[i][7] ? String(data[i][7]) : ''
    });
  }

  records.sort(function (a, b) {
    return String(a.timestamp).localeCompare(String(b.timestamp));
  });

  return {
    success: true,
    date: target,
    count: records.length,
    records: records,
    absent: lean ? [] : getAbsentStudents(attendedIds, data, target)
  };
}

function getAbsentStudents(attendedIds, attendanceData, targetDate) {
  const data = getStudentsData();
  if (!data) return [];

  // Peta ID siswa -> catatan absensi terakhir SEBELUM tanggal laporan.
  const lastLogMap = {};
  if (attendanceData) {
    for (let i = 1; i < attendanceData.length; i++) {
      const row = attendanceData[i];
      if (!row || row[2] === '') continue;
      const recId = row[2] ? String(row[2]).trim().toUpperCase() : '';
      if (!recId) continue;
      if (attendedIds[recId]) continue;

      let dateStr = '';
      if (isDateValue(row[1])) dateStr = Utilities.formatDate(row[1], 'GMT+7', 'yyyy-MM-dd');
      else dateStr = String(row[1] || '').trim().substring(0, 10);
      if (!dateStr) continue;
      if (targetDate && dateStr >= String(targetDate)) continue;

      let timeStr = '';
      if (isDateValue(row[0])) timeStr = Utilities.formatDate(row[0], 'GMT+7', 'HH:mm');
      else {
        const t = String(row[0] || '').trim();
        timeStr = t.length >= 16 ? t.substring(11, 16) : '';
      }

      const log = {
        date: dateStr,
        time: timeStr,
        type: row[5] ? String(row[5]) : '',
        remark: row[6] ? String(row[6]) : '',
        sortKey: dateStr + ' ' + timeStr
      };
      const prev = lastLogMap[recId];
      if (!prev || log.sortKey > prev.sortKey) lastLogMap[recId] = log;
    }
  }

  const absent = [];

  for (let i = 1; i < data.length; i++) {
    if (!data[i] || data[i][0] === '') continue;

    const rowId = data[i][0] ? String(data[i][0]).trim().toUpperCase() : '';
    const rowStatus = data[i][4] ? String(data[i][4]).trim().toUpperCase() : '';

    if (!rowId || rowStatus !== 'ACTIVE') continue;
    if (attendedIds[rowId]) continue;

    const entry = {
      id: data[i][0] ? String(data[i][0]).trim() : '',
      name: data[i][1] ? String(data[i][1]).trim() : '',
      className: data[i][2] ? String(data[i][2]).trim() : ''
    };

    const last = lastLogMap[rowId];
    if (last) {
      entry.lastDate = last.date;
      entry.lastTime = last.time;
      entry.lastType = last.type;
      entry.lastRemark = last.remark;
    }

    absent.push(entry);
  }

  absent.sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  });

  return absent;
}

function getStudentList() {
  const data = getStudentsData();
  if (!data) return { success: false, message: 'Sheet STUDENTS tidak ditemukan.' };
  const students = [];

  for (let i = 1; i < data.length; i++) {
    if (!data[i] || (data[i][0] === '' && data[i][1] === '')) continue;

    students.push({
      id: data[i][0] ? String(data[i][0]).trim() : '',
      name: data[i][1] ? String(data[i][1]).trim() : '',
      className: data[i][2] ? String(data[i][2]).trim() : '',
      status: data[i][4] ? String(data[i][4]).trim().toUpperCase() : ''
    });
  }

  students.sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  });

  return { success: true, count: students.length, students: students };
}

function getStudentHistory(studentId) {
  const sheet = getSheet(SHEET_NAME_ATTENDANCE);
  if (!sheet) return { success: false, message: 'Sheet ATTENDANCE tidak ditemukan.' };
  if (!studentId) return { success: false, message: 'ID siswa wajib diisi.' };

  const target = String(studentId).trim().toUpperCase();
  const data = getAttendanceData(sheet);
  const records = [];
  let studentName = '';
  let className = '';

  const stuData = getStudentsData();
  if (stuData) {
    for (let i = 1; i < stuData.length; i++) {
      if (!stuData[i]) continue;
      const sid = stuData[i][0] ? String(stuData[i][0]).trim().toUpperCase() : '';
      if (sid === target) {
        studentName = stuData[i][1] ? String(stuData[i][1]).trim() : '';
        className = stuData[i][2] ? String(stuData[i][2]).trim() : '';
        break;
      }
    }
  }

  for (let i = 1; i < data.length; i++) {
    if (!data[i] || data[i][2] === '') continue;
    const recId = data[i][2] ? String(data[i][2]).trim().toUpperCase() : '';
    if (recId !== target) continue;

    let dateStr = '';
    if (isDateValue(data[i][1])) dateStr = Utilities.formatDate(data[i][1], 'GMT+7', 'yyyy-MM-dd');
    else dateStr = String(data[i][1]).trim().substring(0, 10);

    records.push({
      date: dateStr,
      type: data[i][5] ? String(data[i][5]) : '',
      remark: data[i][6] ? String(data[i][6]) : '',
      status: data[i][7] ? String(data[i][7]) : '',
      timestamp: data[i][0] ? (isDateValue(data[i][0]) ? Utilities.formatDate(data[i][0], 'GMT+7', 'yyyy-MM-dd HH:mm:ss') : String(data[i][0]).trim()) : ''
    });
  }

  records.sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date));
  });
  records.reverse(); // riwayat terbaru di atas

  return {
    success: true,
    id: String(studentId).trim(),
    name: studentName,
    className: className,
    count: records.length,
    records: records
  };
}

function submitAttendance(payload) {
  if (getMaintenanceMode()) return maintenanceBlockResponse();
  const { id, pin, type, remark } = payload;
  if (VALID_TYPES.indexOf(type) === -1) {
    return { success: false, message: 'Jenis latihan tidak valid.' };
  }

  const verify = verifyStudent(id, pin, true);
  if (!verify.success) return verify;

  const student = verify.data;
  const studentId = student.id; // Gunakan Student ID kanonik dari sheet
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getSheet(SHEET_NAME_ATTENDANCE);
    if (!sheet) return { success: false, message: 'Sheet ATTENDANCE tidak ditemukan.' };
    const data = getAttendanceData(sheet);

    const now = new Date();
    const dateString = Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd');
    const timestampString = Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd HH:mm:ss');

    for (let i = data.length - 1; i >= 1; i--) {
      if (!data[i] || data[i][2] === '') continue;

      const recId = data[i][2] ? data[i][2].toString().trim().toUpperCase() : '';

      if (recId === studentId && matchesToday(data[i][1], dateString)) {
        return { success: false, message: 'Absensi Anda untuk hari ini sudah tercatat.' };
      }
    }

    const sanitizedRemark = (remark || '').toString().substring(0, 200);
    if (type === 'Izin' && sanitizedRemark === '') {
      return { success: false, message: 'Alasan / keterangan izin wajib diisi.' };
    }

    const status = type === 'Izin' ? 'Izin' : 'Hadir';

    sheet.appendRow([
      timestampString,
      dateString,
      studentId,
      student.name,
      student.className,
      type,
      sanitizedRemark,
      status
    ]);

    const confirmation = type === 'Izin'
      ? `Terima kasih, ${student.name}. Izin Anda pada ${dateString} telah tercatat.`
      : `Terima kasih, ${student.name}. Kehadiran Anda pada ${dateString} telah tercatat.`;

    return {
      success: true,
      message: confirmation
    };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// BACKUP SHEET (duplikat di spreadsheet yang sama)
// ==========================================
// Menyalin sheet STUDENTS dan ATTENDANCE menjadi sheet baru bertanggal
// "<NamaSheet>DDMMYY" (mis. STUDENTS110926), lalu menyimpan hanya
// BACKUP_KEEP salinan terbaru per sheet. Bila salinan hari itu sudah ada,
// salinan lama diganti agar tidak terjadi duplikat nama.
const BACKUP_KEEP = 6;

// Ubah stempel DDMMYY menjadi kunci urut YYMMDD agar pengurutan kronologis.
function backupSortKey(stamp) {
  return stamp.substring(4, 6) + stamp.substring(2, 4) + stamp.substring(0, 2);
}

// Daftar sheet backup milik satu sheet sumber, terbaru lebih dulu.
function getBackupSheets(baseName) {
  const ss = getSpreadsheet();
  const list = [];
  ss.getSheets().forEach(function (sheet) {
    const name = sheet.getName();
    if (name.indexOf(baseName) !== 0) return;
    const stamp = name.substring(baseName.length);
    if (!/^\d{6}$/.test(stamp)) return;
    list.push({ sheet: sheet, name: name, stamp: stamp, key: backupSortKey(stamp) });
  });
  list.sort(function (a, b) { return b.key.localeCompare(a.key); });
  return list;
}

// Hapus backup lama sehingga hanya BACKUP_KEEP terbaru yang tersisa.
function pruneBackups(baseName) {
  const ss = getSpreadsheet();
  const removed = [];
  getBackupSheets(baseName).slice(BACKUP_KEEP).forEach(function (item) {
    ss.deleteSheet(item.sheet);
    removed.push(item.name);
  });
  return removed;
}

// Daftar seluruh backup (STUDENTS + ATTENDANCE) untuk ditampilkan di UI.
function listBackups() {
  const ss = getSpreadsheet();
  if (!ss) return { success: false, message: 'Spreadsheet tidak ditemukan.' };

  const items = [];
  [SHEET_NAME_STUDENTS, SHEET_NAME_ATTENDANCE].forEach(function (base) {
    getBackupSheets(base).forEach(function (item) {
      items.push({
        name: item.name,
        base: base,
        stamp: item.stamp,
        rows: Math.max(0, item.sheet.getLastRow() - 1)
      });
    });
  });

  return { success: true, keep: BACKUP_KEEP, count: items.length, backups: items };
}

function backupSheets() {
  const ss = getSpreadsheet();
  if (!ss) return { success: false, message: 'Spreadsheet tidak ditemukan.' };

  const stamp = Utilities.formatDate(new Date(), 'GMT+7', 'ddMMyy');
  const targets = [SHEET_NAME_STUDENTS, SHEET_NAME_ATTENDANCE];
  const created = [];
  const replaced = [];
  const missing = [];

  targets.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      missing.push(name);
      return;
    }
    const backupName = name + stamp;
    const existing = ss.getSheetByName(backupName);
    if (existing) {
      ss.deleteSheet(existing);
      replaced.push(backupName);
    }
    sheet.copyTo(ss).setName(backupName);
    created.push(backupName);
  });

  if (created.length === 0) {
    return { success: false, message: 'Sheet yang akan dibackup tidak ditemukan: ' + missing.join(', ') + '.' };
  }

  pruneBackups(SHEET_NAME_STUDENTS);
  pruneBackups(SHEET_NAME_ATTENDANCE);

  const listed = listBackups();
  let message = 'Backup dibuat: ' + created.join(', ') + '.';
  if (replaced.length) message += ' Salinan hari ini sebelumnya diganti.';
  if (missing.length) message += ' Tidak ditemukan: ' + missing.join(', ') + '.';
  message += ' Menyimpan maksimal ' + BACKUP_KEEP + ' backup terbaru per sheet.';

  return { success: true, message: message, keep: BACKUP_KEEP, backups: listed.backups || [] };
}
