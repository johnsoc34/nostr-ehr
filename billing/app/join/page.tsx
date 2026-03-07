'use client';
import { useState } from 'react';

const Icon = ({ d, size = 18, stroke = "currentColor" }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const Icons = {
  check: "M20 6L9 17l-5-5",
  send: "M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z",
  user: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z",
  mail: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6",
  phone: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z",
};

const DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a", accentLt: "#fbb040",
  blue: "#3b82f6", green: "#22c55e",
};

export default function JoinPage() {
  const [formData, setFormData] = useState({ name: '', email: '', phone: '', message: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const T = DARK;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const res = await fetch('/api/signups/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (res.ok) {
        setSubmitted(true);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to submit application');
      }
    } catch (err) {
      alert('Error submitting application. Please try again.');
    }
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div style={{
        minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center",
        justifyContent: "center", padding: 24, fontFamily: "'DM Sans', sans-serif"
      }}>
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <div style={{
            width: 80, height: 80, borderRadius: "50%",
            background: `linear-gradient(135deg, ${T.green}, #10b981)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 24px", boxShadow: `0 8px 24px ${T.green}44`
          }}>
            <Icon d={Icons.check} size={40} stroke="#fff" />
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: T.text, marginBottom: 12 }}>
            Application Submitted!
          </h1>
          <p style={{ fontSize: 16, color: T.textMuted, lineHeight: 1.6, marginBottom: 24 }}>
            Thank you for your interest in {process.env.NEXT_PUBLIC_PRACTICE_NAME || "Your Practice"}. We'll review your application and contact you within 1-2 business days to schedule your first visit.
          </p>
          <div style={{
            padding: 16, borderRadius: 12, background: T.surface,
            border: `1px solid ${T.border}`, fontSize: 14, color: T.textMuted, lineHeight: 1.6
          }}>
            <strong style={{ color: T.text }}>What happens next?</strong><br />
            We'll reach out via email to schedule your first appointment. At your visit, you'll receive your secure medical identity key to access the patient portal.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh", background: T.bg, color: T.text,
      fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif",
      display: "flex", flexDirection: "column", alignItems: "center", padding: 24
    }}>
      <div style={{ width: "100%", maxWidth: 560, marginTop: 40 }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: `linear-gradient(135deg, ${T.accent}, ${T.accentLt})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 32, fontWeight: 700, color: "#fff", margin: "0 auto 20px"
          }}>₿</div>
          <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8 }}>
            Join {process.env.NEXT_PUBLIC_PRACTICE_NAME || "Your Practice"}
          </h1>
          <p style={{ fontSize: 16, color: T.textMuted, lineHeight: 1.6 }}>
            Direct Primary Care for your family. Apply below to get started.
          </p>
        </div>

        {/* Form */}
        <div style={{
          background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 16, padding: 32
        }}>
          <form onSubmit={handleSubmit}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <label style={{
                  fontSize: 13, color: T.textMuted, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6, marginBottom: 8
                }}>
                  <Icon d={Icons.user} size={14} />
                  Full Name
                </label>
                <input
                  required
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                  placeholder="John Doe"
                  style={{
                    width: "100%", padding: "12px 14px", borderRadius: 10,
                    border: `1px solid ${T.border}`, background: T.surfaceHi,
                    color: T.text, fontSize: 15, outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{
                  fontSize: 13, color: T.textMuted, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6, marginBottom: 8
                }}>
                  <Icon d={Icons.mail} size={14} />
                  Email Address
                </label>
                <input
                  required
                  type="email"
                  value={formData.email}
                  onChange={e => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com"
                  style={{
                    width: "100%", padding: "12px 14px", borderRadius: 10,
                    border: `1px solid ${T.border}`, background: T.surfaceHi,
                    color: T.text, fontSize: 15, outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{
                  fontSize: 13, color: T.textMuted, fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 6, marginBottom: 8
                }}>
                  <Icon d={Icons.phone} size={14} />
                  Phone Number (Optional)
                </label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={e => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                  style={{
                    width: "100%", padding: "12px 14px", borderRadius: 10,
                    border: `1px solid ${T.border}`, background: T.surfaceHi,
                    color: T.text, fontSize: 15, outline: "none", boxSizing: "border-box"
                  }}
                />
              </div>

              <div>
                <label style={{
                  fontSize: 13, color: T.textMuted, fontWeight: 600,
                  display: "block", marginBottom: 8
                }}>
                  Why are you interested in joining? (Optional)
                </label>
                <textarea
                  value={formData.message}
                  onChange={e => setFormData({ ...formData, message: e.target.value })}
                  placeholder="Tell us about your family's healthcare needs..."
                  rows={4}
                  style={{
                    width: "100%", padding: "12px 14px", borderRadius: 10,
                    border: `1px solid ${T.border}`, background: T.surfaceHi,
                    color: T.text, fontSize: 15, outline: "none", resize: "vertical",
                    fontFamily: "inherit", boxSizing: "border-box"
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: "100%", padding: "14px", borderRadius: 10,
                  background: submitting ? T.border : T.accent, color: "#fff",
                  border: "none", fontSize: 16, fontWeight: 700,
                  cursor: submitting ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8
                }}
              >
                {submitting ? (
                  "Submitting..."
                ) : (
                  <>
                    <Icon d={Icons.send} size={18} stroke="#fff" />
                    Submit Application
                  </>
                )}
              </button>
            </div>
          </form>

          <div style={{
            marginTop: 24, padding: 16, borderRadius: 10,
            background: T.surfaceHi, border: `1px solid ${T.border}`,
            fontSize: 13, color: T.textMuted, lineHeight: 1.6
          }}>
            <strong style={{ color: T.text }}>What to expect:</strong><br />
            After submitting, we'll review your application and reach out within 1-2 business days. Your first visit includes enrollment and setup of your secure patient portal access.
          </div>
        </div>
      </div>
    </div>
  );
}
