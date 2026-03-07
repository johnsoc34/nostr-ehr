'use client';
import { useState, useEffect, useCallback } from 'react';

// ─── Icons ────────────────────────────────────────────────────────────────────
const Icon = ({ d, size = 18, stroke = "currentColor" }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const Icons = {
  dashboard: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
  patients: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
  invoices: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  reports: "M18 20V10 M12 20V4 M6 20v-6",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  sun: "M12 17A5 5 0 1012 7a5 5 0 000 10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42",
  moon: "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z",
  plus: "M12 5v14 M5 12h14",
  check: "M20 6L9 17l-5-5",
  alert: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01",
  close: "M18 6L6 18 M6 6l12 12",
  menu: "M3 12h18 M3 6h18 M3 18h18",
  trend_up: "M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.35-4.35",
  send: "M22 2L11 13 M22 2l-7 20-4-9-9-4z",
  refresh: "M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0020.49 15",
  dollar: "M12 1v22 M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
  family: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75",
};

// ─── Theme ────────────────────────────────────────────────────────────────────
const DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a", accentLt: "#fbb040",
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};
const LIGHT = {
  bg: "#f4f6fb", surface: "#ffffff", surfaceHi: "#eef2fa", border: "#d4dae8",
  text: "#0f172a", textMuted: "#64748b", accent: "#f7931a", accentLt: "#ea7c0a",
  blue: "#2563eb", green: "#16a34a", red: "#dc2626", amber: "#d97706",
};
type Theme = typeof DARK;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const cents = (n: number) => `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const usd = (n: number) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const shortDate = (d: string | null) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

// ─── Shared Components ────────────────────────────────────────────────────────
function Card({ T, children, style = {} }: { T: Theme; children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
}

function Badge({ T, status }: { T: Theme; status: string }) {
  const colors: Record<string, string> = {
    paid: T.green, pending: T.amber, unpaid: T.amber, overdue: T.red,
    active: T.green, head_of_household: T.blue, lapsed: T.red, delinquent: T.amber,
  };
  const labels: Record<string, string> = {
    head_of_household: "HOH", active: "active", lapsed: "lapsed",
    delinquent: "overdue", paid: "paid", unpaid: "unpaid", overdue: "overdue", pending: "pending",
  };
  const c = colors[status] || T.textMuted;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: c, background: `${c}15`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {labels[status] || status}
    </span>
  );
}

function StatCard({ T, label, value, sub, icon, color }: { T: Theme; label: string; value: string | number; sub?: string; icon: string; color?: string }) {
  const c = color || T.accent;
  return (
    <Card T={T} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        <div style={{ background: `${c}15`, borderRadius: 8, padding: 7, lineHeight: 0 }}><Icon d={icon} size={15} stroke={c} /></div>
      </div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", color: T.text }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{sub}</div>}
      </div>
    </Card>
  );
}

function TableRow({ T, children, header = false, onClick }: { T: Theme; children: React.ReactNode; header?: boolean; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{
      display: "contents", cursor: onClick ? "pointer" : "default",
      ...(header ? {} : {}),
    }}>
      {children}
    </div>
  );
}

function Spinner({ T }: { T: Theme }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
      <div style={{ width: 28, height: 28, border: `3px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────
function DashboardTab({ T, stats, onNav }: { T: Theme; stats: any; onNav: (page: string) => void }) {
  if (!stats) return <Spinner T={T} />;

  const { members, financials, invoices, overdueInvoices, recentInvoices, pendingSignups } = stats;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Pending signups alert */}
      {pendingSignups > 0 && (
        <div style={{
          background: `${T.amber}10`, border: `1px solid ${T.amber}30`, borderRadius: 10,
          padding: "12px 16px", display: "flex", alignItems: "center", gap: 12,
        }}>
          <Icon d={Icons.alert} size={18} stroke={T.amber} />
          <span style={{ fontSize: 13, color: T.amber, fontWeight: 600 }}>{pendingSignups} pending signup{pendingSignups > 1 ? "s" : ""} awaiting review</span>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        <div style={{ cursor: "pointer" }} onClick={() => onNav("patients")}>
          <StatCard T={T} label="Active Members" value={members.active} sub={`${members.total} total · ${members.delinquent || 0} overdue`} icon={Icons.patients} color={T.blue} />
        </div>
        <StatCard T={T} label="Monthly Recurring" value={cents(financials.mrr)} sub={`from ${members.active} active member${members.active !== 1 ? "s" : ""}`} icon={Icons.dollar} color={T.green} />
        <div style={{ cursor: "pointer" }} onClick={() => onNav("invoices")}>
          <StatCard T={T} label="Outstanding" value={cents(financials.outstanding)} sub={`${invoices.unpaid + invoices.overdue} unpaid invoice${invoices.unpaid + invoices.overdue !== 1 ? "s" : ""}`} icon={Icons.alert} color={financials.outstanding > 0 ? T.red : T.green} />
        </div>
        <StatCard T={T} label="Total Collected" value={cents(financials.collected)} sub={`${invoices.paid} paid invoice${invoices.paid !== 1 ? "s" : ""}`} icon={Icons.trend_up} color={T.accent} />
      </div>

      {/* Two-column: overdue + recent activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Overdue */}
        <Card T={T}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Unpaid Invoices</div>
            <button onClick={() => onNav("invoices")} style={{ background: "none", border: "none", color: T.accent, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>View all →</button>
          </div>
          {overdueInvoices.length === 0 ? (
            <div style={{ color: T.green, fontSize: 13, padding: "16px 0", textAlign: "center" }}>All caught up!</div>
          ) : overdueInvoices.slice(0, 6).map((inv: any) => (
            <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{inv.patient_name}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{inv.id} · due {shortDate(inv.due_date)}</div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.red }}>{cents(inv.amount)}</div>
            </div>
          ))}
          {overdueInvoices.length > 0 && (
            <div style={{ textAlign: "right", paddingTop: 10 }}>
              <span style={{ fontSize: 11, color: T.textMuted }}>{overdueInvoices.length} total</span>
            </div>
          )}
        </Card>

        {/* Recent invoices */}
        <Card T={T}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Recent Invoices</div>
            <button onClick={() => onNav("invoices")} style={{ background: "none", border: "none", color: T.accent, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>View all →</button>
          </div>
          {recentInvoices.slice(0, 6).map((inv: any) => (
            <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{inv.patient_name}</div>
                  <div style={{ fontSize: 11, color: T.textMuted }}>{inv.id} · {shortDate(inv.created_at)}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{cents(inv.amount)}</div>
                <Badge T={T} status={inv.status} />
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ─── Members Tab ──────────────────────────────────────────────────────────────
function MembersTab({ T }: { T: Theme }) {
  const [patients, setPatients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const loadPatients = useCallback(() => {
    fetch("/api/patients/list").then(r => r.json()).then(data => {
      setPatients(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadPatients(); }, [loadPatients]);

  const toggleTest = async (patient: any) => {
    const newVal = patient.is_test_patient ? 0 : 1;
    try {
      const res = await fetch("/api/patients/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: patient.id, is_test_patient: newVal }),
      });
      if (res.ok) {
        setPatients(prev => prev.map(p => p.id === patient.id ? { ...p, is_test_patient: newVal } : p));
      }
    } catch {}
  };

  if (loading) return <Spinner T={T} />;

  const filtered = patients.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.npub || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || p.status === statusFilter || (statusFilter === "active" && p.status === "head_of_household");
    return matchSearch && matchStatus;
  });

  const statusCounts: Record<string, number> = {};
  patients.forEach(p => { statusCounts[p.status] = (statusCounts[p.status] || 0) + 1; });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Filters */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 320 }}>
          <Icon d={Icons.search} size={15} stroke={T.textMuted} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search members..."
            style={{
              width: "100%", padding: "9px 12px 9px 32px", borderRadius: 8,
              border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text,
              fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", outline: "none",
              position: "relative",
            }}
          />
          <div style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <Icon d={Icons.search} size={14} stroke={T.textMuted} />
          </div>
        </div>
        {["all", "active", "delinquent", "lapsed", "pending"].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: `1px solid ${statusFilter === s ? T.accent : T.border}`,
            background: statusFilter === s ? `${T.accent}15` : "transparent",
            color: statusFilter === s ? T.accent : T.textMuted,
            cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize",
          }}>
            {s === "all" ? `All (${patients.length})` : `${s} (${statusCounts[s] || (s === "active" ? (statusCounts.active || 0) + (statusCounts.head_of_household || 0) : 0)})`}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card T={T} style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 1fr 1fr 1fr", gap: 0 }}>
          {/* Header */}
          {["Name", "npub", "Status", "Monthly Fee", "Balance", "Member Since"].map(h => (
            <div key={h} style={{ padding: "12px 16px", fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: `1px solid ${T.border}`, background: T.surfaceHi }}>
              {h}
            </div>
          ))}
          {/* Rows */}
          {filtered.map(p => (
            <TableRow key={p.id} T={T}>
              <div style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8 }}>
                {p.name}
                <button onClick={() => toggleTest(p)} title={p.is_test_patient ? "Remove test flag" : "Mark as test patient"} style={{
                  fontSize: 9, color: p.is_test_patient ? T.amber : T.textMuted,
                  background: p.is_test_patient ? `${T.amber}15` : `${T.textMuted}10`,
                  padding: "2px 6px", borderRadius: 4, fontWeight: 600, border: `1px solid ${p.is_test_patient ? T.amber + "40" : "transparent"}`,
                  cursor: "pointer", fontFamily: "inherit", opacity: p.is_test_patient ? 1 : 0.5,
                  transition: "all 0.15s",
                }}>
                  {p.is_test_patient ? "TEST" : "TEST"}
                </button>
              </div>
              <div style={{ padding: "12px 16px", fontSize: 11, color: T.textMuted, borderBottom: `1px solid ${T.border}`, fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.npub}
              </div>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
                <Badge T={T} status={p.status} />
              </div>
              <div style={{ padding: "12px 16px", fontSize: 13, color: T.text, borderBottom: `1px solid ${T.border}` }}>
                {cents(p.monthly_fee)}
              </div>
              <div style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: p.balance > 0 ? T.red : T.green, borderBottom: `1px solid ${T.border}` }}>
                {p.balance > 0 ? cents(p.balance) : "$0.00"}
              </div>
              <div style={{ padding: "12px 16px", fontSize: 12, color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>
                {shortDate(p.member_since || p.created_at)}
              </div>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <div style={{ gridColumn: "1 / -1", padding: 32, textAlign: "center", color: T.textMuted, fontSize: 13 }}>
              No members found
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── Invoices Tab ─────────────────────────────────────────────────────────────
function InvoicesTab({ T }: { T: Theme }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ patientId: "", amount: "", description: "Monthly membership", dueDate: "" });
  const [sortCol, setSortCol] = useState<string>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [toast, setToast] = useState<{msg:string;type:"ok"|"err"}|null>(null);

  const toggleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortDir(col === "amount" ? "desc" : "asc");
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/patients/list").then(r => r.json()),
      fetch("/api/stats").then(r => r.json()),
    ]).then(([pts, stats]) => {
      setPatients(Array.isArray(pts) ? pts : []);
      // Stats has recentInvoices but we need ALL invoices — build from patient list query
      // Actually we'll get all invoices from a dedicated fetch. For now use stats.
      // We'll load all invoices by fetching stats which has recentInvoices (last 10) plus overdueInvoices
      // Better: make a separate call. But since we're limited to existing endpoints,
      // let's combine overdue + recent, dedup, and sort.
      const allInvs: any[] = [];
      const seen = new Set();
      for (const inv of [...(stats.overdueInvoices || []), ...(stats.recentInvoices || [])]) {
        if (!seen.has(inv.id)) { seen.add(inv.id); allInvs.push(inv); }
      }
      allInvs.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setInvoices(allInvs);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.patientId || !form.amount) return;
    setCreating(true);
    try {
      const res = await fetch("/api/invoices/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: parseInt(form.patientId),
          amount: Math.round(parseFloat(form.amount) * 100),
          description: form.description,
          dueDate: form.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
          deliveryMethods: ["nostr"],
        }),
      });
      if (res.ok) {
        setShowCreate(false);
        setForm({ patientId: "", amount: "", description: "Monthly membership", dueDate: "" });
        setToast({msg:"Invoice created and sent via Nostr DM",type:"ok"});
        setTimeout(()=>setToast(null),4000);
        load();
      } else {
        const err = await res.json().catch(()=>({error:"Unknown error"}));
        setToast({msg:"Failed: "+(err.error||"Server error"),type:"err"});
        setTimeout(()=>setToast(null),5000);
      }
    } catch (e:any) {
      setToast({msg:"Network error: "+(e.message||"Could not reach server"),type:"err"});
      setTimeout(()=>setToast(null),5000);
    }
    setCreating(false);
  };

  if (loading) return <Spinner T={T} />;

  const filtered = statusFilter === "all" ? invoices : invoices.filter(i => i.status === statusFilter);

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let av: any, bv: any;
    switch (sortCol) {
      case "id": av = a.id; bv = b.id; break;
      case "patient_name": av = (a.patient_name || "").toLowerCase(); bv = (b.patient_name || "").toLowerCase(); break;
      case "amount": av = a.amount; bv = b.amount; break;
      case "status": av = a.status; bv = b.status; break;
      case "due_date": av = a.due_date || ""; bv = b.due_date || ""; break;
      case "created_at": default: av = a.created_at || ""; bv = b.created_at || ""; break;
    }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const statusCounts: Record<string, number> = {};
  invoices.forEach(i => { statusCounts[i.status] = (statusCounts[i.status] || 0) + 1; });

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "9px 12px", borderRadius: 8, border: `1px solid ${T.border}`,
    background: T.surfaceHi, color: T.text, fontSize: 13, fontFamily: "inherit",
    boxSizing: "border-box", outline: "none",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {toast && <div style={{padding:"10px 16px",borderRadius:8,fontSize:13,fontWeight:600,background:toast.type==="ok"?"#052e16":"#450a0a",border:toast.type==="ok"?"1px solid #166534":"1px solid #991b1b",color:toast.type==="ok"?"#4ade80":"#fca5a5",display:"flex",alignItems:"center",gap:8}}>{toast.type==="ok"?"✅":"❌"} {toast.msg}</div>}
      {/* Actions */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {["all", "unpaid", "overdue", "paid"].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
            border: `1px solid ${statusFilter === s ? T.accent : T.border}`,
            background: statusFilter === s ? `${T.accent}15` : "transparent",
            color: statusFilter === s ? T.accent : T.textMuted,
            cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize",
          }}>
            {s === "all" ? `All (${invoices.length})` : `${s} (${statusCounts[s] || 0})`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowCreate(!showCreate)} style={{
          padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: T.accent, color: "#fff", border: "none", cursor: "pointer", fontFamily: "inherit",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <Icon d={Icons.plus} size={14} stroke="#fff" /> New Invoice
        </button>
      </div>

      {/* Create invoice form */}
      {showCreate && (
        <Card T={T} style={{ border: `1px solid ${T.accent}40` }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Create Invoice</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Patient</label>
              <select value={form.patientId} onChange={e => setForm({ ...form, patientId: e.target.value })} style={{ ...inputStyle, cursor: "pointer" }}>
                <option value="">Select...</option>
                {patients.filter(p => p.status !== "lapsed").map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Amount ($)</label>
              <input value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="150.00" type="number" step="0.01" style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Description</label>
              <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Due Date</label>
              <input type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} style={inputStyle} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleCreate} disabled={!form.patientId || !form.amount || creating} style={{
              padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: T.accent, color: "#fff", border: "none", cursor: creating ? "wait" : "pointer",
              fontFamily: "inherit", opacity: (!form.patientId || !form.amount) ? 0.5 : 1,
            }}>
              {creating ? "Creating..." : "Create & Send via Nostr DM"}
            </button>
            <button onClick={() => setShowCreate(false)} style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
              background: "transparent", color: T.textMuted, border: `1px solid ${T.border}`,
              cursor: "pointer", fontFamily: "inherit",
            }}>Cancel</button>
          </div>
        </Card>
      )}

      {/* Invoice table */}
      <Card T={T} style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 1fr 1fr 1fr", gap: 0 }}>
          {/* Sortable headers */}
          {[
            { label: "Invoice", col: "id" },
            { label: "Patient", col: "patient_name" },
            { label: "Amount", col: "amount" },
            { label: "Status", col: "status" },
            { label: "Due Date", col: "due_date" },
            { label: "Created", col: "created_at" },
          ].map(h => (
            <div key={h.col} onClick={() => toggleSort(h.col)} style={{
              padding: "12px 16px", fontSize: 11, fontWeight: 700, color: sortCol === h.col ? T.accent : T.textMuted,
              textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: `1px solid ${T.border}`,
              background: T.surfaceHi, cursor: "pointer", userSelect: "none",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              {h.label}
              {sortCol === h.col && <span style={{ fontSize: 10 }}>{sortDir === "asc" ? "▲" : "▼"}</span>}
            </div>
          ))}
          {sorted.map(inv => (
            <TableRow key={inv.id} T={T}>
              <div style={{ padding: "12px 16px", fontSize: 12, fontWeight: 600, color: T.accent, borderBottom: `1px solid ${T.border}`, fontFamily: "'IBM Plex Mono', monospace" }}>{inv.id}</div>
              <div style={{ padding: "12px 16px", fontSize: 13, fontWeight: 500, color: T.text, borderBottom: `1px solid ${T.border}` }}>{inv.patient_name}</div>
              <div style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: T.text, borderBottom: `1px solid ${T.border}` }}>{cents(inv.amount)}</div>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}><Badge T={T} status={inv.status} /></div>
              <div style={{ padding: "12px 16px", fontSize: 12, color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>{shortDate(inv.due_date)}</div>
              <div style={{ padding: "12px 16px", fontSize: 12, color: T.textMuted, borderBottom: `1px solid ${T.border}` }}>{shortDate(inv.created_at)}</div>
            </TableRow>
          ))}
          {sorted.length === 0 && (
            <div style={{ gridColumn: "1 / -1", padding: 32, textAlign: "center", color: T.textMuted, fontSize: 13 }}>
              No invoices found
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── Reports Tab ──────────────────────────────────────────────────────────────
function ReportsTab({ T, stats }: { T: Theme; stats: any }) {
  if (!stats) return <Spinner T={T} />;

  const { members, financials, invoices, families } = stats;
  const collectionRate = invoices.total > 0 ? Math.round((invoices.paid / invoices.total) * 100) : 0;
  const avgFee = members.active > 0 ? Math.round(financials.mrr / members.active) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
        <StatCard T={T} label="Collection Rate" value={`${collectionRate}%`} sub={`${invoices.paid} of ${invoices.total} invoices paid`} icon={Icons.check} color={collectionRate >= 80 ? T.green : T.amber} />
        <StatCard T={T} label="Avg. Monthly Fee" value={cents(avgFee)} sub={`across ${members.active} active members`} icon={Icons.dollar} color={T.blue} />
        <StatCard T={T} label="Families" value={families} sub={`family group${families !== 1 ? "s" : ""}`} icon={Icons.family} color={T.accent} />
      </div>

      {/* Membership breakdown */}
      <Card T={T}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Membership Breakdown</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          {[
            { label: "Active", value: members.active, color: T.green },
            { label: "Delinquent", value: members.delinquent, color: T.amber },
            { label: "Lapsed", value: members.lapsed, color: T.red },
            { label: "Pending", value: members.pending, color: T.textMuted },
            { label: "Test", value: members.testPatients, color: T.blue },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center", padding: "16px 0" }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Invoice breakdown */}
      <Card T={T}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Invoice Summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { label: "Paid", value: invoices.paid, color: T.green },
            { label: "Unpaid", value: invoices.unpaid, color: T.amber },
            { label: "Overdue", value: invoices.overdue, color: T.red },
            { label: "Total", value: invoices.total, color: T.text },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center", padding: "16px 0" }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Financial summary */}
      <Card T={T}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Financial Overview</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { label: "Monthly Recurring Revenue (MRR)", value: cents(financials.mrr), color: T.green },
            { label: "Outstanding Balance", value: cents(financials.outstanding), color: financials.outstanding > 0 ? T.red : T.green },
            { label: "Total Collected (All Time)", value: cents(financials.collected), color: T.accent },
          ].map(row => (
            <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 13, color: T.textMuted }}>{row.label}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: row.color }}>{row.value}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
function SettingsTab({ T }: { T: Theme }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card T={T}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Practice Info</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { label: "Practice Name", value: process.env.NEXT_PUBLIC_PRACTICE_NAME || "My Practice" },
            { label: "Billing URL", value: (process.env.NEXT_PUBLIC_APP_URL || "").replace("https://", "") || "—" },
            { label: "Relay", value: (process.env.NEXT_PUBLIC_RELAY_URL || "").replace("wss://", "") || "—" },
            { label: "Database", value: process.env.DATABASE_PATH || "/var/lib/immutable-health/billing.db" },
          ].map(row => (
            <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 13, color: T.textMuted }}>{row.label}</span>
              <span style={{ fontSize: 13, color: T.text, fontFamily: "'IBM Plex Mono', monospace" }}>{row.value}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card T={T}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Automated Jobs</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { label: "Monthly invoice generation", schedule: "1st of each month at 9:00 AM", script: "monthly-billing.js" },
            { label: "Membership lapse check", schedule: "Daily at 1:00 AM", script: "check-lapsed-memberships.sh" },
            { label: "Relay whitelist sync", schedule: "Daily at 2:00 AM", script: "sync-whitelist.sh" },
          ].map(job => (
            <div key={job.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{job.label}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{job.schedule}</div>
              </div>
              <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "'IBM Plex Mono', monospace", background: T.surfaceHi, padding: "3px 8px", borderRadius: 4 }}>{job.script}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card T={T}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Payment Methods</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { method: "Bitcoin (on-chain)", status: "Active", desc: "BIP-32 address derivation per invoice" },
            { method: "Lightning Network", status: "Active", desc: "Invoice generation via Strike/LND" },
          ].map(pm => (
            <div key={pm.method} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{pm.method}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{pm.desc}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: T.green, background: `${T.green}15`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase", letterSpacing: "0.05em" }}>{pm.status}</span>
            </div>
          ))}
        </div>
      </Card>

    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [dark, setDark] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [stats, setStats] = useState<any>(null);
  const T = dark ? DARK : LIGHT;

  // Load dashboard stats
  useEffect(() => {
    fetch("/api/stats").then(r => r.json()).then(setStats).catch(() => {});
  }, []);

  const nav = [
    { id: "dashboard", label: "Dashboard", icon: Icons.dashboard },
    { id: "patients", label: "Members", icon: Icons.patients },
    { id: "invoices", label: "Invoices", icon: Icons.invoices },
    { id: "reports", label: "Reports", icon: Icons.reports },
    { id: "settings", label: "Settings", icon: Icons.settings },
  ];

  return (
    <div style={{
      display: "flex", height: "100vh", overflow: "hidden",
      fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif",
      background: T.bg, color: T.text, transition: "background 0.3s, color 0.3s",
    }}>
      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? 220 : 60, flexShrink: 0, background: T.surface,
        borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column",
        transition: "width 0.2s ease", overflow: "hidden",
      }}>
        <div style={{
          padding: sidebarOpen ? "20px 16px 16px" : "20px 0 16px", display: "flex",
          alignItems: "center", justifyContent: sidebarOpen ? "space-between" : "center",
          borderBottom: `1px solid ${T.border}`, flexShrink: 0,
        }}>
          {sidebarOpen && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: `linear-gradient(135deg, ${T.accent}, ${T.accentLt})`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 16, fontWeight: 800, color: "#fff", flexShrink: 0,
              }}>Ⅰ</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{(process.env.NEXT_PUBLIC_PRACTICE_NAME || "My Practice").split(" ").slice(0, 2).join(" ")}</div>
                <div style={{ fontSize: 10, color: T.textMuted }}>Billing</div>
              </div>
            </div>
          )}
          <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{
            background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 4, borderRadius: 6, flexShrink: 0,
          }}>
            <Icon d={sidebarOpen ? Icons.close : Icons.menu} size={16} />
          </button>
        </div>

        <nav style={{ flex: 1, padding: "10px 6px", display: "flex", flexDirection: "column", gap: 2 }}>
          {nav.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              display: "flex", alignItems: "center", gap: sidebarOpen ? 10 : 0,
              justifyContent: sidebarOpen ? "flex-start" : "center",
              padding: sidebarOpen ? "8px 12px" : "8px", borderRadius: 8, cursor: "pointer",
              background: page === n.id ? `${T.accent}12` : "transparent",
              color: page === n.id ? T.accent : T.textMuted,
              fontWeight: page === n.id ? 600 : 400, fontSize: 13, whiteSpace: "nowrap",
              transition: "all 0.15s", border: "none", width: "100%", textAlign: "left", fontFamily: "inherit",
            }}>
              <Icon d={n.icon} size={16} />
              {sidebarOpen && <span>{n.label}</span>}
            </button>
          ))}
        </nav>

        {sidebarOpen && (
          <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: T.green, boxShadow: `0 0 6px ${T.green}` }} />
              <span style={{ fontSize: 10, color: T.textMuted }}>relay connected</span>
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Topbar */}
        <header style={{
          height: 56, background: T.surface, borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", padding: "0 24px", gap: 12, flexShrink: 0,
        }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {nav.find(n => n.id === page)?.label || "Dashboard"}
          </div>
          <button onClick={() => setDark(!dark)} style={{
            background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "6px 9px", cursor: "pointer", color: T.textMuted, display: "flex", alignItems: "center",
          }}>
            <Icon d={dark ? Icons.sun : Icons.moon} size={15} />
          </button>
          <button onClick={() => { sessionStorage.removeItem("billing_auth"); window.location.reload(); }} style={{
            background: "transparent", border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "6px 12px", cursor: "pointer", color: T.textMuted, fontSize: 12,
            fontFamily: "inherit", fontWeight: 500,
          }}>Sign Out</button>
        </header>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {page === "dashboard" && <DashboardTab T={T} stats={stats} onNav={setPage} />}
          {page === "patients" && <MembersTab T={T} />}
          {page === "invoices" && <InvoicesTab T={T} />}
          {page === "reports" && <ReportsTab T={T} stats={stats} />}
          {page === "settings" && <SettingsTab T={T} />}
        </div>
      </main>
    </div>
  );
}
