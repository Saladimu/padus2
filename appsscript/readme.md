# Backend Google Apps Script

Kode backend untuk aplikasi Absensi Paduan Suara. Deploy sebagai **Aplikasi Web** dari menu **Terapkan > Penerapan Baru** (Execute as: Me, Access: Anyone). URL Aplikasi Web yang dihasilkan dimasukkan ke `GAS_WEB_APP_URL` di `../index.html`.

## Action yang Didukung (`doPost`)

| Action | Deskripsi |
|--------|-----------|
| `verify` | Verifikasi `id` (Student ID **atau** Nama) + `pin` terhadap sheet `STUDENTS`; mengembalikan nama dan kelas siswa. Jika siswa sudah tercatat absen hari ini, respons menyertakan `already: true` beserta `record` (tanggal, jenis latihan, remark). Ditolak dengan `{ success:false, maintenance:true }` saat mode maintenance aktif. |
| `ping` | Kesehatan koneksi; mengembalikan `{ success: true }`. Dipakai oleh menu **Test Koneksi** di Pengaturan Admin. |
| `report` | Mengembalikan rekap absensi untuk tanggal tertentu (`date` format `yyyy-MM-dd`) dari sheet `ATTENDANCE`, diurutkan berdasarkan timestamp. Dipakai oleh menu **Laporan Absensi**. |
| `submit` | Validasi ulang identitas, cek duplikasi per hari, lalu menulis baris ke sheet `ATTENDANCE`. Ditolak dengan `{ success:false, maintenance:true }` saat mode maintenance aktif (memanggil `verifyStudent()` yang juga memeriksa maintenance). |
| `backup` | Menduplikasi sheet `STUDENTS` dan `ATTENDANCE` menjadi sheet bertanggal `DDMMYY` di spreadsheet yang sama, lalu menyimpan maksimal `BACKUP_KEEP` (6) backup terbaru per sheet (lihat `backupSheets()`). Dipakai oleh submenu **Backup Data**. |
| `backuplist` | Mengembalikan daftar backup tersimpan (`name`, `base`, `stamp`, `rows`) beserta nilai `keep`, dipakai untuk menampilkan daftar di submenu **Backup Data** (lihat `listBackups()`). |

## Struktur Sheet

### STUDENTS
`ID | Nama | Kelas | PIN | Status`

Status harus bernilai `ACTIVE` agar siswa bisa absensi. Kolom PIN dapat berupa plaintext (legacy) atau hash SHA-256 64-hex (disarankan).

### ATTENDANCE
`Timestamp | Tanggal | ID | Nama | Kelas | Jenis | Remark | Status`

Duplikasi dicegah berdasarkan kombinasi `ID` + `Tanggal` (format `yyyy-MM-dd`, zona waktu GMT+7).

## Keamanan

- PIN dicocokkan dengan `pinMatches()` di `code.gs` - mendukung hash dan legacy plaintext.
- `type` divalidasi terhadap `VALID_TYPES` di sisi server.
- Panjang input `id`/`pin` dibatasi.
- Gunakan `LockService` untuk mencegah race condition saat menulis absensi.

## Duplikasi Absensi

- Pengecekan dilakukan dua lapis: pada `verify` (via `getTodayRecord()`) frontend menampilkan pemberitahuan "Pemberitahuan", dan pada `submit` (via `submitAttendance()`) sebagai pengaman terhadap race condition.
