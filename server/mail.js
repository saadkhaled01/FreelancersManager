/* Outgoing email. Uses Resend's HTTP API when RESEND_API_KEY is set; otherwise prints the message to the log
   so whoever runs the server can pass a reset link on by hand. */
const COPY = {
  en: {
    subject: "Reset your Freelancers Manager password",
    text: (name, link, mins) => `Hi ${name},\n\nSomeone asked to reset the password for your Freelancers Manager account. Open this link to choose a new one:\n\n${link}\n\nThe link works once and expires in ${mins} minutes. If you didn't ask for this, ignore this email; your password stays the same.`,
  },
  ar: {
    subject: "تغيير باسورد Freelancers Manager",
    text: (name, link, mins) => `أهلًا ${name}،\n\nفيه طلب لتغيير باسورد حسابك على Freelancers Manager. افتح اللينك ده واختار باسورد جديد:\n\n${link}\n\nاللينك بيشتغل مرة واحدة وبيخلص بعد ${mins} دقيقة. لو إنت ما طلبتش ده، تجاهل الإيميل والباسورد هيفضل زي ما هو.`,
  },
};

const escHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function resetEmail({ lang, name, link, minutes }) {
  const c = COPY[lang] || COPY.en;
  const text = c.text(name, link, minutes);
  const dir = lang === "ar" ? "rtl" : "ltr";
  const html = `<div dir="${dir}" style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#221E19">${
    escHtml(text).replace(escHtml(link), `<a href="${escHtml(link)}" style="color:#1E6F5C">${escHtml(link)}</a>`).replace(/\n/g, "<br>")}</div>`;
  return { subject: c.subject, text, html };
}

export function createMailer(env = process.env) {
  const key = env.RESEND_API_KEY, from = env.MAIL_FROM;
  if (key && from) {
    return {
      configured: true,
      async send({ to, subject, text, html, replyTo }) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
        if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
      },
    };
  }
  return {
    configured: false,
    async send({ to, subject, text }) {
      console.log(`[mail not configured] To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    },
  };
}

/* Branded email for a quote / invoice: the sender's colour and logo, a short message, the total, and a button to the document. */
const DOC = {
  en: {
    quote: "Quote", invoice: "Invoice", from: name => `${name} sent you a`, total: "Total", due: "Balance due", view: d => `View ${d.toLowerCase()}`,
    subject: (d, code, who) => `${d} ${code} from ${who}`, hello: name => `Hi ${name},`,
  },
  ar: {
    quote: "عرض سعر", invoice: "فاتورة", from: name => `${name} بعتلك`, total: "الإجمالي", due: "المطلوب", view: d => `افتح ال${d === "فاتورة" ? "فاتورة" : "عرض"}`,
    subject: (d, code, who) => `${d} ${code} من ${who}`, hello: name => `أهلًا ${name}،`,
  },
};
const CUR = { EGP: { ar: "ج.م", en: "EGP" } };

export function docEmail({ lang, doc, message, link, logoUrl }) {
  const c = DOC[lang] || DOC.en;
  const who = doc.from.business || doc.from.name;
  const kind = c[doc.kind];
  const cur = CUR[doc.currency]?.[lang] || doc.currency;
  const amount = n => `${(Math.round(n * 100) / 100).toLocaleString("en-US")} ${cur}`;
  const color = doc.brand.color;
  const total = doc.kind === "quote" ? doc.fee : doc.owed;
  const label = doc.kind === "quote" ? c.total : c.due;
  const greet = doc.client?.name ? c.hello(doc.client.name.split(/\s+/)[0]) : "";
  const text = [greet, message, `${kind} ${doc.code} · ${doc.project.title}`, `${label}: ${amount(total)}`, link, "", who].filter(s => s !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");
  const dir = lang === "ar" ? "rtl" : "ltr", align = lang === "ar" ? "right" : "left";
  const html = `<div dir="${dir}" style="background:#EEEBE3;padding:24px 12px;font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;color:#221E19">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;border-collapse:separate;overflow:hidden">
    <tr><td style="background:${color};height:6px;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="padding:28px 28px 8px;text-align:${align}">
      ${logoUrl ? `<img src="${escHtml(logoUrl)}" alt="${escHtml(who)}" style="max-height:48px;max-width:160px;margin-bottom:12px">` : ""}
      <div style="font-size:13px;color:#77705F">${escHtml(c.from(who))}</div>
      <div style="font-size:24px;font-weight:700;color:${color};margin:2px 0 12px">${escHtml(kind)} ${escHtml(doc.code)}</div>
      ${greet ? `<p style="margin:0 0 8px;font-size:15px">${escHtml(greet)}</p>` : ""}
      ${message ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6">${escHtml(message).replace(/\n/g, "<br>")}</p>` : ""}
      <table role="presentation" width="100%" style="background:#F7F4EC;border-radius:10px;margin:8px 0 18px"><tr>
        <td style="padding:14px 16px;text-align:${align};font-size:14px">${escHtml(doc.project.title)}<br><span style="color:#77705F;font-size:12px">${escHtml(label)}</span></td>
        <td style="padding:14px 16px;text-align:${lang === "ar" ? "left" : "right"};font-size:20px;font-weight:700;white-space:nowrap">${escHtml(amount(total))}</td>
      </tr></table>
      <a href="${escHtml(link)}" style="display:inline-block;background:${color};color:${inkFor(color)};text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;font-size:15px">${escHtml(c.view(kind))}</a>
    </td></tr>
    <tr><td style="padding:18px 28px 26px;text-align:${align};font-size:12px;color:#77705F">${escHtml(who)}${doc.from.email ? ` · <span dir="ltr">${escHtml(doc.from.email)}</span>` : ""}</td></tr>
  </table></div>`;
  return { subject: c.subject(kind, doc.code, who), text, html };
}

function inkFor(hex) {
  const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] > 0.4 ? "#1F1C18" : "#FFFFFF";
}
