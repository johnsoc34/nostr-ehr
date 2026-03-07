'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Icons
const Icon = ({ d, size = 18, stroke = "currentColor" }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const Icons = {
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18 M6 6l12 12",
  clock: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 6v6l4 2",
  user: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z",
  mail: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z M22 6l-10 7L2 6",
  phone: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z",
  copy: "M8 4v12a2 2 0 002 2h8a2 2 0 002-2V7.242a2 2 0 00-.602-1.43L16.083 2.57A2 2 0 0014.685 2H10a2 2 0 00-2 2z M16 18v2a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  alertCircle: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 8v4 M12 16h.01",
};

const DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a", blue: "#3b82f6",
  green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const LIGHT = {
  bg: "#f4f6fb", surface: "#ffffff", surfaceHi: "#eef2fa", border: "#d4dae8",
  text: "#0f172a", textMuted: "#64748b", accent: "#f7931a", blue: "#2563eb",
  green: "#16a34a", red: "#dc2626", amber: "#d97706",
};

interface Signup {
  id: number;
  name: string;
  email: string;
  phone?: string;
  message?: string;
  status: string;
  created_at: string;
  approved_at?: string;
  generated_npub?: string;
  generated_nsec?: string;
}

function Card({ T, children, style = {} }: any) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, ...style }}>
      {children}
    </div>
  );
}

function Badge({ T, status }: any) {
  const colors: any = {
    pending: T.amber,
    approved: T.green,
    rejected: T.red,
  };
  const labels: any = {
    pending: "Pending Review",
    approved: "Approved",
    rejected: "Rejected",
  };
  const c = colors[status] || T.textMuted;
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: c, background: `${c}18`, padding: "4px 10px", borderRadius: 20, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      {labels[status] || status}
    </span>
  );
}

export default function SignupsPage() {
  const router = useRouter();
  const [dark, setDark] = useState(true);
  const [signups, setSignups] = useState<Signup[]>([]);
  const [loading, setLoading] = useState(true);
  const T = dark ? DARK : LIGHT;

  useEffect(() => {
    loadSignups();
  }, []);

  const loadSignups = async () => {
    try {
      const res = await fetch('/api/signups/list');
      const data = await res.json();
      setSignups(data);
      setLoading(false);
    } catch (err) {
      console.error('Failed to load signups:', err);
      setLoading(false);
    }
  };

  const rejectSignup = async (signupId: number) => {
    if (!confirm('Reject this application? This cannot be undone.')) return;
    
    try {
      await fetch('/api/signups/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signupId })
      });
      loadSignups();
    } catch (err) {
      alert('Error rejecting signup');
    }
  };

  const pending = signups.filter(s => s.status === 'pending');
  const approved = signups.filter(s => s.status === 'approved');
  const rejected = signups.filter(s => s.status === 'rejected');

  return (
    <div style={{
      minHeight: "100vh", background: T.bg, color: T.text,
      fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif",
      padding: 24
    }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Patient Signups</h1>
          <p style={{ fontSize: 14, color: T.textMuted }}>Review and approve new patient applications</p>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
          {[
            { label: "Pending Review", value: pending.length, color: T.amber, icon: Icons.clock },
            { label: "Approved", value: approved.length, color: T.green, icon: Icons.check },
            { label: "Rejected", value: rejected.length, color: T.red, icon: Icons.x },
          ].map(stat => (
            <Card key={stat.label} T={T} style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: `${stat.color}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon d={stat.icon} size={20} stroke={stat.color} />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{stat.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Pending Applications */}
        {pending.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Pending Applications</h2>
            <div style={{ display: "grid", gap: 16 }}>
              {pending.map(signup => (
                <Card key={signup.id} T={T}>
                  <div style={{ display: "flex", gap: 20 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                        <div style={{ width: 48, height: 48, borderRadius: 12, background: `linear-gradient(135deg, ${T.accent}44, ${T.blue}44)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 }}>
                          {signup.name[0]}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>{signup.name}</div>
                          <div style={{ fontSize: 12, color: T.textMuted }}>
                            Applied {new Date(signup.created_at).toLocaleDateString()}
                          </div>
                        </div>
                        <Badge T={T} status={signup.status} />
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 16 }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.textMuted, marginBottom: 4 }}>
                            <Icon d={Icons.mail} size={14} />
                            Email
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{signup.email}</div>
                        </div>
                        {signup.phone && (
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: T.textMuted, marginBottom: 4 }}>
                              <Icon d={Icons.phone} size={14} />
                              Phone
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 500 }}>{signup.phone}</div>
                          </div>
                        )}
                      </div>

                      {signup.message && (
                        <div style={{ padding: 12, borderRadius: 8, background: T.surfaceHi, border: `1px solid ${T.border}`, marginBottom: 16 }}>
                          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6, fontWeight: 600 }}>Why joining DPC:</div>
                          <div style={{ fontSize: 13, lineHeight: 1.6 }}>{signup.message}</div>
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 10 }}>
                        <button onClick={() => router.push(`/dashboard/signups/${signup.id}/create-household`)} style={{
                          flex: 1, padding: "10px 18px", borderRadius: 8, background: T.green,
                          color: "#fff", border: "none", fontSize: 14, fontWeight: 700,
                          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6
                        }}>
                          <Icon d={Icons.check} size={16} stroke="#fff" />
                          Create Household
                        </button>
                        <button onClick={() => rejectSignup(signup.id)} style={{
                          padding: "10px 18px", borderRadius: 8, background: T.surfaceHi,
                          border: `1px solid ${T.border}`, color: T.red, fontSize: 14,
                          fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6
                        }}>
                          <Icon d={Icons.x} size={16} />
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Approved Applications */}
        {approved.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Approved (Ready for First Visit)</h2>
            <Card T={T} style={{ padding: 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    {["Name", "Email", "Approved", "npub"].map(h => (
                      <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {approved.map((s, i) => (
                    <tr key={s.id} style={{ borderBottom: i < approved.length - 1 ? `1px solid ${T.border}` : "none" }}>
                      <td style={{ padding: "14px 16px", fontSize: 14, fontWeight: 600 }}>{s.name}</td>
                      <td style={{ padding: "14px 16px", fontSize: 13, color: T.textMuted }}>{s.email}</td>
                      <td style={{ padding: "14px 16px", fontSize: 13, color: T.textMuted }}>
                        {s.approved_at ? new Date(s.approved_at).toLocaleDateString() : "—"}
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <span style={{ fontSize: 11, fontFamily: "monospace", color: T.textMuted, background: T.surfaceHi, padding: "4px 8px", borderRadius: 5 }}>
                          {s.generated_npub?.slice(0, 16)}...
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {/* Empty State */}
        {loading ? (
          <Card T={T}>
            <div style={{ padding: 40, textAlign: "center", color: T.textMuted }}>Loading applications...</div>
          </Card>
        ) : signups.length === 0 ? (
          <Card T={T}>
            <div style={{ padding: 40, textAlign: "center" }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No applications yet</div>
              <div style={{ fontSize: 14, color: T.textMuted }}>
                Patient applications will appear here once they submit the signup form
              </div>
            </div>
          </Card>
        ) : null}
      </div>

      {/* nsec Modal */}
    </div>
  );
}

