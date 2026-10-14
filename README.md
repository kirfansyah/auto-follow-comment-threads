# Threads Mutualan Bot

Chrome extension (Manifest V3) untuk otomatis **follow** dan **komentar** di postingan Threads yang ngajak mutualan.

Syarat: sudah **login** di Threads web. Bot selalu bekerja dari halaman **Beranda**; kalau Start ditekan di halaman lain, bot kembali ke Beranda dulu.

## Install
1. Buka `chrome://extensions`
2. Aktifkan **Developer mode** (pojok kanan atas)
3. Klik **Load unpacked** → pilih **folder** `auto-comment` (bukan file di dalamnya)
4. Klik ikon **puzzle 🧩** di toolbar Chrome → klik **pin 📌** di sebelah *Threads Mutualan Bot* supaya ikon **@** hitam muncul di toolbar

> Setelah install / reload extension, **refresh** dulu tab Threads-nya. Kalau tidak, popup akan bilang "Bot belum aktif di tab ini".

## Cara pakai
1. **Login** di https://www.threads.com
2. Buka halaman Threads mana saja (kalau bukan Beranda, bot otomatis kembali ke Beranda dulu)
3. Klik ikon **@** → atur pengaturan kalau perlu → **Start**
4. Biarkan tab tetap terbuka. Klik **Stop** kapan saja.

### Boleh pindah tab?
Boleh — bot tetap jalan, dan sejak versi ini jeda/timer-nya sudah dibuat tahan terhadap penghematan Chrome di tab background.

Satu hal yang **tidak** bisa diakali: Threads memuat postingan berikutnya hanya saat halamannya digambar di layar. Jadi selama tab tersembunyi, feed tidak menambah postingan baru dan bot cuma bisa menggarap yang sudah ter-load. Kalau habis, bot menunggu (tidak berhenti) sampai tabnya dibuka lagi.

Paling aman kalau mau ditinggal lama: taruh tab Threads di **window sendiri**, lalu kerja di window lain sambil menyisakan sebagian window Threads tetap kelihatan. Jangan di-minimize dan jangan tertutup penuh — Chrome menganggap window yang tertimbun total sebagai tersembunyi.

Chrome juga bisa membuang tab background untuk menghemat memori. Kalau itu terjadi, popup akan bilang bot tidak merespons dan menyuruh refresh tab.

Bot akan:
1. Membaca postingan di feed satu per satu
2. Kalau teksnya mengandung kata kunci mutualan → **follow** pembuatnya
   - Kalau akunnya **sudah kamu follow**, postingan itu **dilewati** — tidak difollow lagi, tidak dikomentari lagi, langsung lanjut ke postingan berikutnya. Di log muncul `⏭️ sudah difollow, lewati`, dan masuk hitungan "dilewati", bukan "diproses"
3. Menutup popup yang muncul — Esc → klik area kosong → tombol "Buang" → tombol tutup popup-nya — lalu kembali ke **Beranda** kalau sempat pindah halaman
4. Mencari lagi postingan tadi, lalu **membalas** dengan komentar acak
5. Menutup popup lagi, kembali ke Beranda, jeda, lalu **ulangi** ke postingan berikutnya
6. Scroll otomatis kalau tidak ada postingan yang cocok di layar
7. Berhenti sendiri kalau: batas aksi tercapai, tidak ada postingan baru setelah 15 kali scroll, muncul peringatan limit dari Threads, atau ada jendela/dialog yang menutupi halaman dan tidak bisa ditutup
8. Setelah berhenti (termasuk kalau kamu klik **Stop**), bot menyapu popup yang masih tersisa supaya layar bersih — lihat log `🧹 Membersihkan ... popup sisa`

Kalau kembali ke Beranda tanpa reload gagal, bot me-reload ke `threads.com/` dan **melanjutkan otomatis** (statistik tetap tersambung).

### Percobaan pertama yang disarankan
1. Nyalakan **Dry run** → Start. Postingan yang terdeteksi diberi garis hijau, tanpa follow/komentar.
2. Kalau deteksinya sudah benar, matikan Dry run, set **Maks aksi = 1** → Start. Cek follow & komentarnya benar-benar masuk.

## Pengaturan
| Pengaturan | Keterangan | Default |
|---|---|---|
| Kata kunci | Satu per baris. Postingan yang mengandung salah satunya dianggap ngajak mutualan. Tidak peka huruf besar/kecil & tanda baca (`fb-an` = `fb an`). | mutualan, follback, fb an, saling follow, dll. |
| Template komentar | Satu per baris, dipilih acak. `{username}` diganti jadi `@username` pembuat postingan. | 6 template |
| Jeda min/max | Jeda acak antar postingan (detik, minimal 5). | 30–90 |
| Maks aksi | Jumlah postingan yang diproses per sesi. | 20 |
| Follow / Komentar | Bisa dimatikan masing-masing. | aktif |
| Dry run | Hanya menandai, tanpa klik apa pun. | mati |

Tombol lain:
- **Default** – isi ulang form dengan pengaturan bawaan
- **Reset riwayat** – bot mengingat postingan yang sudah diproses (maks 2000) agar tidak dikomentari dua kali; tombol ini menghapus ingatan itu

## Struktur file
```
manifest.json   konfigurasi extension
defaults.js     kata kunci & template komentar default
content.js      logika bot (jalan di halaman Threads)
popup.html/js/css  panel Start/Stop, pengaturan, statistik & log
icons/          ikon extension
```

## Troubleshooting
| Masalah | Solusi |
|---|---|
| Extension tidak terlihat | Klik ikon puzzle 🧩 → pin. Pastikan yang dipilih saat Load unpacked adalah foldernya. |
| "Bot belum aktif di tab ini" | Refresh tab Threads. |
| Log: "tombol follow/reply tidak ditemukan" | Threads mengubah tampilannya. Sesuaikan selector di objek `SEL` / `RE` di atas `content.js`, lalu reload extension. |
| Bot berhenti: "Terdeteksi limit" | Akun sedang dibatasi Threads. Istirahat beberapa jam, lalu pakai jeda lebih panjang. |
| Log: "popup masih nyangkut" | Ada jendela yang tidak mau tertutup setelah semua cara dicoba (Esc, scroll, klik area kosong, klik overlay, tombol tutup). Kalau popup-nya cuma kartu profil, bot menyembunyikannya sendiri dan lanjut. Kalau yang nyangkut dialog beneran, log menyebutkan isinya — tambahkan label tombol tutupnya ke `RE.close` (atau tombol konfirmasinya ke `RE.discard`) di atas `content.js`, lalu reload extension. |
| Log: "popup disembunyikan paksa" | Normal, bukan error. Kartu profil yang menolak tertutup disembunyikan supaya tidak menghalangi langkah berikutnya. Hilang sendiri saat halaman di-refresh. |
| "Bot tidak merespons (N menit terakhir diam)" | Tab Threads-nya kemungkinan dibuang Chrome untuk hemat memori. Refresh tab itu lalu Start lagi. Kalau sering kejadian, matikan Memory Saver untuk situs ini di `chrome://settings/performance`. |
| Log: "teks komentar gagal dimasukkan" | Threads menolak teks yang disisipkan — biasanya karena tabnya tidak fokus. Komentar itu sengaja dibatalkan supaya tidak terkirim kosong. Coba jalankan dengan tab Threads terlihat. |
| Log: "Tab tersembunyi & postingan yang ter-load habis" | Normal, bukan error. Feed Threads tidak memuat postingan baru selama tab tersembunyi. Buka tabnya sebentar, bot lanjut sendiri. |

## ⚠️ Catatan
Otomasi seperti ini melanggar ketentuan Threads/Meta dan bisa membuat akun kena limit atau diblokir. Pakai jeda yang wajar dan jumlah aksi kecil. Risiko sepenuhnya ditanggung pengguna.
