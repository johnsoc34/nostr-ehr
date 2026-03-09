'use client';
import { useState, useEffect } from 'react';

const DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a", accentLt: "#fbb040",
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444", amber: "#f59e0b",
};

const LIGHT = {
  bg: "#f8fafc", surface: "#ffffff", surfaceHi: "#f1f5f9", border: "#e2e8f0",
  text: "#0f172a", textMuted: "#64748b", accent: "#f7931a", accentLt: "#ea7c0a",
  blue: "#2563eb", green: "#16a34a", red: "#dc2626", amber: "#d97706",
};
const Icons = {
  search: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  plus: "M12 4v16m8-8H4",
  edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
  trash: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
};

const Icon = ({ d, size = 18 }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
    <path d={d} />
  </svg>
);

interface Patient {
  id: number;
  npub: string;
  name: string;
  email: string;
  monthly_fee: number;
  status: string;
  member_since: string;
  balance?: number;
  date_of_birth?: string;
  ehr_synced?: boolean;
  relationship?: string;
  family_id?: number;
  is_account_holder?: boolean;
}

function Badge({ T, status }: any) {
  const colors: any = {
    active: T.green, 
    pending: T.amber,
    pending_onboarding: T.amber,
    lapsed: T.red,
    head_of_household: T.blue
  };
  
  const labels: any = {
    active: "Active",
    pending: "Pending",
    pending_onboarding: "Pending Onboarding",
    lapsed: "Lapsed",
    head_of_household: "Head of Household"
  };
  
  const c = colors[status] || "#888";
  const label = labels[status] || status;
  
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: c, background: `${c}18`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase" }}>
      {label}
    </span>
  );
}

function Card({ T, children, style = {} }: any) {
  return <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24, ...style }}>{children}</div>;
}

function AddChildModal({ T, parent, onClose, onSuccess }: any) {
  const [formData, setFormData] = useState({ name: '', dateOfBirth: '', monthlyFee: '150.00' });
  const [submitting, setSubmitting] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [childKeys, setChildKeys] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/families/add-child', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: parent.family_id,
          name: formData.name,
          dateOfBirth: formData.dateOfBirth,
          monthlyFee: Math.round(parseFloat(formData.monthlyFee) * 100)
        })
      });
      const data = await res.json();
      if (res.ok) {
        setChildKeys(data.child);
        setShowKeys(true);
      } else {
        alert(data.error || 'Failed to add child');
      }
    } catch (err) {
      alert('Error adding child');
    }
    setSubmitting(false);
  };

  const copyNsec = () => {
    navigator.clipboard.writeText(childKeys.nsec);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadKeys = () => {
    const content = `Immutable Health Pediatrics - Patient Key\n\nChild: ${childKeys.name}\nDOB: ${childKeys.dateOfBirth}\n\nSECRET KEY (nsec):\n${childKeys.nsec}\n\nPUBLIC KEY (npub):\n${childKeys.npub}\n\n⚠️ IMPORTANT: Save this file securely. The secret key cannot be recovered if lost.`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${childKeys.name.replace(/\s+/g, '-')}-key.txt`;
    a.click();
  };

  if (showKeys && childKeys) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 24 }}>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, maxWidth: 600, width: "100%" }}>
          <div style={{ padding: 24 }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Child Added Successfully</div>
            <div style={{ background: T.red + "22", border: `2px solid ${T.red}`, borderRadius: 12, padding: 16, marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.red, marginBottom: 8 }}>⚠️ SAVE THIS KEY NOW</div>
              <div style={{ fontSize: 12, color: T.text }}>This secret key will never be shown again.</div>
            </div>
            <div style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{childKeys.name}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>DOB: {childKeys.dateOfBirth}</div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>SECRET KEY (nsec)</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, padding: '10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>{childKeys.nsec}</div>
                  <button onClick={copyNsec} style={{ padding: '10px 14px', background: T.accent, border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer' }}>{copied ? '✓' : '📋'}</button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>PUBLIC KEY (npub)</div>
                <div style={{ padding: '8px 12px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', color: T.textMuted }}>{childKeys.npub}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={downloadKeys} style={{ flex: 1, padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Download .txt</button>
              <button onClick={() => { onSuccess(); onClose(); }} style={{ flex: 1, padding: '12px', background: T.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 24 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, maxWidth: 500, width: "100%" }}>
        <div style={{ padding: 20, borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Add Child to {parent.name}'s Family</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 20 }}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Child's Name *</label>
              <input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Date of Birth *</label>
              <input required type="date" value={formData.dateOfBirth} onChange={e => setFormData({ ...formData, dateOfBirth: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Monthly Fee (USD)</label>
              <input required type="number" step="0.01" value={formData.monthlyFee} onChange={e => setFormData({ ...formData, monthlyFee: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ marginTop: 24, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={onClose} style={{ padding: "10px 20px", borderRadius: 8, background: T.surfaceHi, border: `1px solid ${T.border}`, color: T.textMuted, fontSize: 14, cursor: "pointer" }}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ padding: "10px 20px", borderRadius: 8, background: submitting ? T.border : T.accent, color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer" }}>{submitting ? "Adding..." : "Add Child"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditModal({ T, patient, onClose, onSuccess }: any) {
  const [formData, setFormData] = useState({
    name: patient.name,
    email: patient.email || '',
    monthlyFee: (patient.monthly_fee / 100).toFixed(2)
  });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/patients/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: patient.id,
          name: formData.name,
          email: formData.email,
          monthlyFee: Math.round(parseFloat(formData.monthlyFee) * 100)
        })
      });
      if (res.ok) {
        onSuccess();
      } else {
        alert('Failed to update patient');
      }
    } catch (err) {
      alert('Error updating patient');
    }
    setSubmitting(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 24 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, maxWidth: 500, width: "100%" }}>
        <div style={{ padding: 20, borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Edit Patient</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 20 }}>×</button>
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Patient Name</label>
              <input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Email</label>
              <input type="email" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Monthly Fee (USD)</label>
              <input required type="number" step="0.01" value={formData.monthlyFee} onChange={e => setFormData({ ...formData, monthlyFee: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ marginTop: 24, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={onClose} style={{ padding: "10px 20px", borderRadius: 8, background: T.surfaceHi, border: `1px solid ${T.border}`, color: T.textMuted, fontSize: 14, cursor: "pointer" }}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ padding: "10px 20px", borderRadius: 8, background: submitting ? T.border : T.accent, color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer" }}>{submitting ? "Saving..." : "Save Changes"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EnrollModal({ T, onClose, onSuccess }: any) {
  const [formData, setFormData] = useState({
    npub: '',
    name: '',
    email: '',
    monthlyFee: '150.00',
    memberSince: new Date().toISOString().split('T')[0]
  });
  const [submitting, setSubmitting] = useState(false);
  const [npubError, setNpubError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = formData.npub.trim();
    if (trimmed.startsWith("nsec1")) {
      setNpubError("STOP \u2014 this is a SECRET KEY (nsec). Enter the PUBLIC key (npub) instead.");
      return;
    }
    if (!trimmed.startsWith("npub1")) {
      setNpubError("Must start with npub1");
      return;
    }
    if (trimmed.length !== 63) {
      setNpubError("Invalid npub \u2014 expected 63 characters");
      return;
    }
    setNpubError("");
    setSubmitting(true);
    try {
      const res = await fetch('/api/patients/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          npub: trimmed,
          name: formData.name,
          email: formData.email,
          monthlyFee: Math.round(parseFloat(formData.monthlyFee) * 100),
          memberSince: formData.memberSince
        })
      });
      if (res.ok) {
        onSuccess();
        onClose();
      } else {
        const errData = await res.json().catch(() => ({}));
        setNpubError(errData.error || 'Failed to enroll patient');
      }
    } catch (err) {
      setNpubError('Network error \u2014 could not reach server');
    }
    setSubmitting(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 24 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, maxWidth: 500, width: "100%" }}>
        <div style={{ padding: 20, borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Enroll New Member</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 20 }}>\u00d7</button>
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Nostr Public Key (npub)</label>
              <input required value={formData.npub} onChange={e => { setFormData({ ...formData, npub: e.target.value }); setNpubError(""); }} placeholder="npub1..." style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${npubError ? T.red : T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "monospace" }} />
              {npubError && <div style={{ fontSize: 12, color: T.red, marginTop: 6, fontWeight: 600 }}>{npubError}</div>}
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Paste the patient\u2019s npub from their EHR record. Never enter an nsec here.</div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Full Name</label>
              <input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder='Last, First (e.g. "Doe, Jane")' style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Format: Last, First \u2014 or "Jane Doe" (auto-converted)</div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Email</label>
              <input type="email" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Monthly Fee (USD)</label>
              <input required type="number" step="0.01" value={formData.monthlyFee} onChange={e => setFormData({ ...formData, monthlyFee: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, display: "block", marginBottom: 6 }}>Member Since</label>
              <input required type="date" value={formData.memberSince} onChange={e => setFormData({ ...formData, memberSince: e.target.value })} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surfaceHi, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ marginTop: 24, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={onClose} style={{ padding: "10px 20px", borderRadius: 8, background: T.surfaceHi, border: `1px solid ${T.border}`, color: T.textMuted, fontSize: 14, cursor: "pointer" }}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ padding: "10px 20px", borderRadius: 8, background: submitting ? T.border : T.accent, color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: submitting ? "not-allowed" : "pointer" }}>{submitting ? "Enrolling..." : "Enroll Member"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function PatientsPage() {
  const [dark, setDark] = useState(true);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null);
  const [addingChildTo, setAddingChildTo] = useState<Patient | null>(null);
  const T = dark ? DARK : LIGHT;

  const loadPatients = async () => {
    try {
      const res = await fetch('/api/patients/list');
      const data = await res.json();
      setPatients(data);
      setLoading(false);
    } catch (err) {
      console.error('Failed to load patients:', err);
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPatients();
  }, []);

  const updatePatientStatus = async (patientId: number, newStatus: string) => {
    try {
      const res = await fetch('/api/patients/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId, status: newStatus })
      });
      if (res.ok) {
        loadPatients();
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const deletePatient = async (patientId: number) => {
    if (!confirm('Are you sure you want to delete this patient?')) return;
    try {
      const res = await fetch('/api/patients/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId })
      });
      if (res.ok) {
        loadPatients();
      }
    } catch (err) {
      console.error('Failed to delete patient:', err);
    }
  };

  const sortedPatients = [...patients].sort((a, b) => {
    // If both have family_id, sort by family then role
    if (a.family_id && b.family_id) {
      if (a.family_id !== b.family_id) return a.family_id - b.family_id;
      // Within same family: account holders first, then children
      if (a.is_account_holder && !b.is_account_holder) return -1;
      if (!a.is_account_holder && b.is_account_holder) return 1;
      return 0;
    }
    // Family members come before individuals
    if (a.family_id && !b.family_id) return -1;
    if (!a.family_id && b.family_id) return 1;
    return 0;
  });

  const filteredPatients = sortedPatients.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.npub.toLowerCase().includes(search.toLowerCase()) ||
    p.email?.toLowerCase().includes(search.toLowerCase())
  );

  const stats = {
    total: patients.length,
    active: patients.filter(p => p.status === 'active').length,
    lapsed: patients.filter(p => p.status === 'lapsed').length,
    pending: patients.filter(p => p.status === 'pending_onboarding').length
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: 40 }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <div>
              <a href="/dashboard" style={{ color: T.textMuted, fontSize: 13, textDecoration: "none", marginBottom: 8, display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ fontSize: 16 }}>←</span> Back to Dashboard</a>
              <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, marginBottom: 4 }}>Patient Management</h1>
              <p style={{ fontSize: 14, color: T.textMuted, margin: 0 }}>Manage DPC memberships and billing</p>
            </div>
            <button onClick={() => setShowEnrollModal(true)} style={{ padding: "12px 24px", borderRadius: 10, background: T.accent, color: "#fff", border: "none", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
              <Icon d={Icons.plus} size={16} />
              Enroll New Member
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
            <Card T={T}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Total Members</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: T.blue }}>{stats.total}</div>
            </Card>
            <Card T={T}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Active</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: T.green }}>{stats.active}</div>
            </Card>
            <Card T={T}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Lapsed</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: T.red }}>{stats.lapsed}</div>
            </Card>
            <Card T={T}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Pending</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: T.amber }}>{stats.pending}</div>
            </Card>
          </div>

          <div style={{ position: "relative", marginBottom: 24 }}>
            <input
              type="text"
              placeholder="Search by name, npub, or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: "100%", padding: "12px 12px 12px 44px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: T.textMuted }}>
              <Icon d={Icons.search} size={18} />
            </div>
          </div>
        </div>

        <Card T={T} style={{ padding: 0, overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: "center", color: T.textMuted }}>Loading patients...</div>
          ) : filteredPatients.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: T.textMuted }}>No patients found</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: T.surfaceHi, borderBottom: `1px solid ${T.border}` }}>
                  {["Patient", "DOB", "Nostr npub", "Email", "Monthly Fee", "Status", "Member Since", "Actions"].map(h => (
                    <th key={h} style={{ padding: "14px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredPatients.map(p => (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${T.border}` }}>
		    <td style={{ padding: "16px", paddingLeft: p.relationship === 'child' ? "48px" : "16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{
                          width: 40, height: 40, borderRadius: 10,
                          background: `linear-gradient(135deg, ${T.accent}44, ${T.blue}44)`,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 14, fontWeight: 700, color: T.text
                        }}>
                          {p.name[0]}
                        </div>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: T.textMuted }}>ID: {p.id}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "16px", fontSize: 13, color: T.textMuted }}>{p.date_of_birth || "—"}</td>
                    <td style={{ padding: "16px" }}>
                      <span style={{ fontSize: 11, fontFamily: "monospace", color: T.textMuted, background: T.surfaceHi, padding: "4px 8px", borderRadius: 5 }}>
                        {p.npub.slice(0, 16)}...
                      </span>
                    </td>
                    <td style={{ padding: "16px", fontSize: 13, color: T.textMuted }}>{p.email || "—"}</td>
                    <td style={{ padding: "16px", fontSize: 14, fontWeight: 600 }}>${(p.monthly_fee / 100).toFixed(2)}</td>
                    <td style={{ padding: "16px" }}><Badge T={T} status={p.status} /></td>
                    <td style={{ padding: "16px", fontSize: 13, color: T.textMuted }}>{p.member_since}</td>
                    <td style={{ padding: "16px" }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        {p.status === 'head_of_household' && (
                          <button onClick={() => setAddingChildTo(p)} style={{
                            padding: "6px 12px", borderRadius: 6, background: T.accent + "22",
                            border: `1px solid ${T.accent}44`, color: T.accent, fontSize: 12,
                            fontWeight: 600, cursor: "pointer"
                          }}>
                            + Add Child
                          </button>
                        )}
                        {p.status === 'active' ? (
                          <button onClick={() => updatePatientStatus(p.id, 'lapsed')} style={{
                            padding: "6px 12px", borderRadius: 6, background: T.red + "22",
                            border: `1px solid ${T.red}44`, color: T.red, fontSize: 12,
                            fontWeight: 600, cursor: "pointer"
                          }}>
                            Mark Lapsed
                          </button>
                        ) : p.status === 'lapsed' && (
                          <button onClick={() => updatePatientStatus(p.id, 'active')} style={{
                            padding: "6px 12px", borderRadius: 6, background: T.green + "22",
                            border: `1px solid ${T.green}44`, color: T.green, fontSize: 12,
                            fontWeight: 600, cursor: "pointer"
                          }}>
                            Reactivate
                          </button>
                        )}
                        <button onClick={() => setEditingPatient(p)} style={{
                          padding: "6px 10px", borderRadius: 6, background: T.surfaceHi,
                          border: `1px solid ${T.border}`, color: T.textMuted, cursor: "pointer"
                        }}>
                          <Icon d={Icons.edit} size={14} />
                        </button>
                        <button onClick={() => deletePatient(p.id)} style={{
                          padding: "6px 10px", borderRadius: 6, background: T.surfaceHi,
                          border: `1px solid ${T.border}`, color: T.red, cursor: "pointer"
                        }}>
                          <Icon d={Icons.trash} size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

      </div>

      {showEnrollModal && (
        <EnrollModal T={T} onClose={() => setShowEnrollModal(false)} onSuccess={loadPatients} />
      )}

      {editingPatient && (
        <EditModal T={T} patient={editingPatient} onClose={() => setEditingPatient(null)} onSuccess={() => { setEditingPatient(null); loadPatients(); }} />
      )}

      {addingChildTo && (
        <AddChildModal T={T} parent={addingChildTo} onClose={() => setAddingChildTo(null)} onSuccess={loadPatients} />
      )}
    </div>
  );
}
