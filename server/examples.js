/* Example projects for new accounts, in each language. Plain data: used by the server (seed.js) and the in-browser demo. */
export const EXAMPLES = {
  ar: {
    clients: [
      { name: "سلمى — Nile Coffee", company: "Nile Coffee", phone: "01012345678", lang: "ar" },
      { name: "يوسف — Bloom Studio", company: "Bloom Studio", phone: "01198765432", lang: "ar" },
      { name: "مريم وعمر", company: "", phone: "01287654321", lang: "ar" },
      { name: "Daniel — Koshary Lab", company: "Koshary Lab", phone: "+447700900123", lang: "en" },
    ],
    projects: [
      { c: 0, title: "فيديو إطلاق منتج (مثال)", type: "فيديو", status: "with_client", start: -12, due: 3, fee: 12000, rev: [3, 1], paid: [true, false],
        deliverables: [["نسخة 16:9 كاملة", true], ["نسخة 9:16 للريلز", false], ["3 كتات 15 ثانية", false]],
        link: { url: "https://drive.google.com/example-v2", label: "النسخة 2" }, folder: "https://drive.google.com/drive/folders/example" },
      { c: 0, title: "تصوير منيو الخريف (مثال)", type: "تصوير", status: "booked", start: 0, due: 8, fee: 5000, rev: [2, 0], paid: [false, false],
        deliverables: [["30 صورة متعدلة", false]], session: [2, "10:00"] },
      { c: 1, title: "ريلز رمضان ×6 (مثال)", type: "ريلز", status: "active", start: -5, due: 9, fee: 8000, rev: [2, 0], paid: [true, false],
        deliverables: [["ريل 1", true], ["ريل 2", true], ["ريل 3", true], ["ريل 4", false], ["ريل 5", false], ["ريل 6", false]] },
      { c: 2, title: "تصوير فرح (مثال)", type: "تصوير", status: "delivered", start: -40, due: -9, fee: 9000, rev: [2, 2], paid: [true, false],
        deliverables: [["فيلم الفرح", true], ["هايلايت دقيقة", true]] },
      { c: 3, title: "Brand identity (example)", type: "Design", status: "lead", start: null, due: 21, fee: 6500, rev: [3, 0], paid: [false, false],
        deliverables: [] },
    ],
    /* p: index into projects above, or null for a business expense. day: days from today. */
    expenses: [
      { p: 0, label: "إيجار عدسات وإضاءة", category: "equipment", amount: 1500, day: -10 },
      { p: 0, label: "مونتير مساعد", category: "crew", amount: 2000, day: -4 },
      { p: 3, label: "مواصلات يوم الفرح", category: "travel", amount: 350, day: -40 },
      { p: null, label: "اشتراك Adobe Creative Cloud", category: "software", amount: 1200, day: -3, repeat: "monthly" },
      { p: null, label: "إنترنت المكتب", category: "rent", amount: 600, day: -20, repeat: "monthly" },
    ],
  },
  en: {
    clients: [
      { name: "Sara Lee", company: "Northwind Coffee", phone: "+14155550134", lang: "en" },
      { name: "Marco Rossi", company: "Bloom Studio", phone: "+393471234567", lang: "en" },
      { name: "Emma & Jack", company: "", phone: "+447700900456", lang: "en" },
      { name: "سلمى — Nile Coffee", company: "Nile Coffee", phone: "01012345678", lang: "ar" },
    ],
    projects: [
      { c: 0, title: "Product launch video (example)", type: "Video", status: "with_client", start: -12, due: 3, fee: 2400, rev: [3, 1], paid: [true, false],
        deliverables: [["Full 16:9 master", true], ["9:16 cut for Reels", false], ["Three 15s cutdowns", false]],
        link: { url: "https://drive.google.com/example-v2", label: "Version 2" }, folder: "https://drive.google.com/drive/folders/example" },
      { c: 0, title: "Autumn menu shoot (example)", type: "Photo", status: "booked", start: 0, due: 8, fee: 900, rev: [2, 0], paid: [false, false],
        deliverables: [["30 edited photos", false]], session: [2, "10:00"] },
      { c: 1, title: "Six launch reels (example)", type: "Reels", status: "active", start: -5, due: 9, fee: 1800, rev: [2, 0], paid: [true, false],
        deliverables: [["Reel 1", true], ["Reel 2", true], ["Reel 3", true], ["Reel 4", false], ["Reel 5", false], ["Reel 6", false]] },
      { c: 2, title: "Wedding film (example)", type: "Photo & video", status: "delivered", start: -40, due: -9, fee: 3200, rev: [2, 2], paid: [true, false],
        deliverables: [["Feature film", true], ["One-minute highlight", true]] },
      { c: 3, title: "Café menu photos (example)", type: "Photo", status: "lead", start: null, due: 21, fee: 900, rev: [2, 0], paid: [false, false],
        deliverables: [] },
    ],
    expenses: [
      { p: 0, label: "Lens and lighting rental", category: "equipment", amount: 300, day: -10 },
      { p: 0, label: "Assistant editor", category: "crew", amount: 400, day: -4 },
      { p: 3, label: "Travel to the venue", category: "travel", amount: 80, day: -40 },
      { p: null, label: "Adobe Creative Cloud", category: "software", amount: 60, day: -3, repeat: "monthly" },
      { p: null, label: "Studio internet", category: "rent", amount: 45, day: -20, repeat: "monthly" },
    ],
  },
};
