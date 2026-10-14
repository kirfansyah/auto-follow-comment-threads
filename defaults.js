// Pengaturan default, dipakai oleh popup.js dan content.js
const THREADS_BOT_DEFAULTS = {
  keywords: [
    "mutualan", "mutual", "mutualin", "mutu4lan",
    "follback", "folback", "followback", "follow back", "fback",
    "fb an", "fbb", "saling follow", "ayo follow", "yuk follow",
    "yuk mutual", "ayo mutual", "cari mutual", "cari temen", "moots"
  ],
  comments: [
    "udah aku follow ya kak, follback 🙌",
    "done follow! ditunggu fb-nya ya ✨",
    "ayo mutualan, aku udah follow 😊",
    "fb ya kak {username}, udah aku follow 🙏",
    "sudah follow ya, salam kenal! 👋",
    "done kak, follback yaa 🤝"
  ],
  delayMin: 30,       // detik antar postingan, dipakai kedua mode (unfollow sama rawannya kena limit)
  delayMax: 90,
  maxActions: 20,     // maksimal postingan yang diproses per sesi
  doFollow: true,
  doComment: true,
  dryRun: false,

  // --- mode unfollow ---
  unfollowAfterDays: 3,   // tunggu sekian hari sebelum akun yang tidak follow back di-unfollow
  maxUnfollows: 10,       // sengaja rendah: run pertama bisa menyasar akun yang difollow manual
  whitelist: []           // username yang tidak boleh di-unfollow, tanpa '@'
};
