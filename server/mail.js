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
      async send({ to, subject, text, html }) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text, html }),
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
