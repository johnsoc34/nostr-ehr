'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { use } from 'react';

const Icon = ({ d, size = 18 }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
    <path d={d} />
  </svg>
);

const Icons = {
  user: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z",
  users: "M17 21v-2a4 4 0 00-3-3.87 M13 7a4 4 0 100-8 4 4 0 000 8z M9 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M1 7a4 4 0 108 0 4 4 0 10-8 0z",
  plus: "M12 5v14 M5 12h14",
  x: "M18 6L6 18 M6 6l12 12",
  home: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  baby: "M12 2a3 3 0 013 3v1a3 3 0 01-3 3 3 3 0 01-3-3V5a3 3 0 013-3z M12 9v13",
  check: "M20 6L9 17l-5-5",
  copy: "M8 4v12a2 2 0 002 2h8a2 2 0 002-2V7.242a2 2 0 00-.602-1.43L16.083 2.57A2 2 0 0014.685 2H10a2 2 0 00-2 2z M16 18v2a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2",
};

const DARK = {
  bg: "#0a0d12", surface: "#111620", surfaceHi: "#1a2233", border: "#1e2d44",
  text: "#e8edf5", textMuted: "#6b7fa3", accent: "#f7931a", accentLt: "#fbb040",
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444",
};

export default function CreateHouseholdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: signupId } = use(params);
  const router = useRouter();
  const T = DARK;
  
  const [loading, setLoading] = useState(true);
  const [signup, setSignup] = useState<any>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [generatedKeys, setGeneratedKeys] = useState<any[]>([]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  
  const [familyName, setFamilyName] = useState('');
  const [householdAddress, setHouseholdAddress] = useState('');
  const [primaryHolder, setPrimaryHolder] = useState({ name: '', email: '', phone: '' });
  const [secondaryHolder, setSecondaryHolder] = useState({ name: '', email: '', phone: '' });
  const [showSecondary, setShowSecondary] = useState(false);
  const [children, setChildren] = useState([{ name: '', dateOfBirth: '', monthlyFee: 15000 }]);

  useEffect(() => {
    fetch(`/api/signups/list`)
      .then(res => res.json())
      .then(data => {
        const signup = data.find((s: any) => s.id === parseInt(signupId));
        if (signup) {
          setSignup(signup);
          setPrimaryHolder({
            name: signup.name,
            email: signup.email,
            phone: signup.phone || ''
          });
          setFamilyName(`${signup.name.split(' ').pop()} Family`);
        }
        setLoading(false);
      });
  }, [signupId]);

  const addChild = () => {
    setChildren([...children, { name: '', dateOfBirth: '', monthlyFee: 15000 }]);
  };

  const removeChild = (index: number) => {
    setChildren(children.filter((_, i) => i !== index));
  };

  const updateChild = (index: number, field: string, value: any) => {
    const updated = [...children];
    updated[index] = { ...updated[index], [field]: value };
    setChildren(updated);
  };

  const calculateTotal = () => {
    const childTotal = children.reduce((sum, child) => sum + child.monthlyFee, 0);
    const maxCap = 40000;
    const threshold = 3;
    
    if (children.length >= threshold) {
      return Math.min(childTotal, maxCap);
    }
    return childTotal;
  };

  const handleSubmit = async () => {
    if (!primaryHolder.name || !familyName) {
      alert('Please fill in required fields');
      return;
    }

    if (children.some(c => !c.name || !c.dateOfBirth)) {
      alert('Please fill in all child information');
      return;
    }

    try {
      const res = await fetch('/api/signups/create-household', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signupId,
          familyName,
          householdAddress,
          primaryHolder,
          secondaryHolder: showSecondary ? secondaryHolder : null,
          children
        })
      });

      const data = await res.json();
      
      if (res.ok) {
        setGeneratedKeys(data.generatedKeys);
        setShowKeys(true);
      } else {
        alert(data.error || 'Failed to create household');
      }
    } catch (err) {
      alert('Error creating household');
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const downloadAllKeys = () => {
    const content = generatedKeys.map(k => 
      `${k.relationship}: ${k.name}\nnsec: ${k.nsec}\nnpub: ${k.npub}\n\n`
    ).join('');
    
    const blob = new Blob([`{process.env.NEXT_PUBLIC_PRACTICE_NAME || "Your Practice"} - ${familyName}\n\n${content}`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${familyName.replace(/\s+/g, '-')}-keys.txt`;
    a.click();
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: T.textMuted }}>Loading...</div>
      </div>
    );
  }

  if (showKeys) {
    return (
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, padding: 40, fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 800, margin: '0 auto' }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 32 }}>
            <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>Household Keys Generated</div>
            <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 24 }}>
              ⚠️ Save these keys now - they will never be shown again
            </div>

            <div style={{ background: T.red + '22', border: `2px solid ${T.red}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.red, marginBottom: 8 }}>CRITICAL: SAVE THESE KEYS</div>
              <div style={{ fontSize: 12, color: T.text, lineHeight: 1.6 }}>
                These secret keys (nsec) are the ONLY way to access patient records. If lost, they cannot be recovered.
                Copy each nsec to add patients to the EHR.
              </div>
            </div>

            {generatedKeys.map((key, index) => (
              <div key={index} style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 4 }}>{key.relationship}</div>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>{key.name}</div>
                {key.dateOfBirth && <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>DOB: {key.dateOfBirth}</div>}
                
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>SECRET KEY (nsec)</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, padding: '10px 12px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                      {key.nsec}
                    </div>
                    <button
                      onClick={() => copyToClipboard(key.nsec, index)}
                      style={{ padding: '10px 14px', background: T.accent, border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer' }}
                    >
                      <Icon d={copiedIndex === index ? Icons.check : Icons.copy} size={16} />
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, fontWeight: 600 }}>PUBLIC KEY (npub)</div>
                  <div style={{ padding: '8px 12px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', color: T.textMuted }}>
                    {key.npub}
                  </div>
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
              <button
                onClick={downloadAllKeys}
                style={{ flex: 1, padding: '14px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                Download All Keys (.txt)
              </button>
              <button
                onClick={() => router.push('/dashboard/patients')}
                style={{ flex: 1, padding: '14px', background: T.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
              >
                I've Saved These, Continue
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, padding: 40, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <div style={{ marginBottom: 32 }}>
          <button
            onClick={() => router.push('/dashboard/signups')}
            style={{ background: 'none', border: 'none', color: T.accent, fontSize: 14, cursor: 'pointer', marginBottom: 16 }}
          >
            ← Back to Signups
          </button>
          <div style={{ fontSize: 28, fontWeight: 800 }}>Create Household</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginTop: 4 }}>
            Generate keys for family members and set up billing
          </div>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 32, marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon d={Icons.home} size={20} />
            Family Information
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
              Family Name *
            </label>
            <input
              type="text"
              value={familyName}
              onChange={e => setFamilyName(e.target.value)}
              placeholder="Smith Family"
              style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
            />
          </div>

          <div>
            <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
              Household Address (Optional)
            </label>
            <input
              type="text"
              value={householdAddress}
              onChange={e => setHouseholdAddress(e.target.value)}
              placeholder="123 Main St, City, State 12345"
              style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
            />
          </div>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 32, marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon d={Icons.user} size={20} />
            Primary Account Holder
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
                Name *
              </label>
              <input
                type="text"
                value={primaryHolder.name}
                onChange={e => setPrimaryHolder({ ...primaryHolder, name: e.target.value })}
                style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
                Email *
              </label>
              <input
                type="email"
                value={primaryHolder.email}
                onChange={e => setPrimaryHolder({ ...primaryHolder, email: e.target.value })}
                style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
              Phone
            </label>
            <input
              type="tel"
              value={primaryHolder.phone}
              onChange={e => setPrimaryHolder({ ...primaryHolder, phone: e.target.value })}
              style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
            />
          </div>

          {!showSecondary && (
            <button
              onClick={() => setShowSecondary(true)}
              style={{ marginTop: 16, padding: '10px 16px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.accent, fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <Icon d={Icons.plus} size={14} />
              Add Second Parent/Guardian
            </button>
          )}

          {showSecondary && (
            <div style={{ marginTop: 24, paddingTop: 24, borderTop: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Secondary Account Holder</div>
                <button
                  onClick={() => setShowSecondary(false)}
                  style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 13 }}
                >
                  Remove
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
                    Name
                  </label>
                  <input
                    type="text"
                    value={secondaryHolder.name}
                    onChange={e => setSecondaryHolder({ ...secondaryHolder, name: e.target.value })}
                    style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 13, color: T.textMuted, marginBottom: 6, display: 'block', fontWeight: 600 }}>
                    Email
                  </label>
                  <input
                    type="email"
                    value={secondaryHolder.email}
                    onChange={e => setSecondaryHolder({ ...secondaryHolder, email: e.target.value })}
                    style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 32, marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon d={Icons.baby} size={20} />
            Children/Patients
          </div>

          {children.map((child, index) => (
            <div key={index} style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Child {index + 1}</div>
                {children.length > 1 && (
                  <button
                    onClick={() => removeChild(index)}
                    style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 13 }}
                  >
                    Remove
                  </button>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: T.textMuted, marginBottom: 4, display: 'block', fontWeight: 600 }}>
                    Name *
                  </label>
                  <input
                    type="text"
                    value={child.name}
                    onChange={e => updateChild(index, 'name', e.target.value)}
                    style={{ width: '100%', padding: '10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: T.textMuted, marginBottom: 4, display: 'block', fontWeight: 600 }}>
                    Date of Birth *
                  </label>
                  <input
                    type="date"
                    value={child.dateOfBirth}
                    onChange={e => updateChild(index, 'dateOfBirth', e.target.value)}
                    style={{ width: '100%', padding: '10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: T.textMuted, marginBottom: 4, display: 'block', fontWeight: 600 }}>
                    Monthly Fee
                  </label>
                  <input
                    type="number"
                    value={child.monthlyFee / 100}
                    onChange={e => updateChild(index, 'monthlyFee', parseFloat(e.target.value) * 100)}
                    style={{ width: '100%', padding: '10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, boxSizing: 'border-box' }}
                  />
                </div>
              </div>
            </div>
          ))}

          <button
            onClick={addChild}
            style={{ width: '100%', padding: '12px', background: T.surfaceHi, border: `1px dashed ${T.border}`, borderRadius: 10, color: T.accent, fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            <Icon d={Icons.plus} size={16} />
            Add Child
          </button>
        </div>

        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 32, marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Family Billing Summary</div>
          
          {children.map((child, index) => (
            <div key={index} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 14, color: T.textMuted }}>{child.name || `Child ${index + 1}`}</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>${(child.monthlyFee / 100).toFixed(2)}</div>
            </div>
          ))}

          {children.length >= 3 && (
            <div style={{ background: T.green + '22', borderRadius: 8, padding: 12, marginTop: 16 }}>
              <div style={{ fontSize: 13, color: T.green, fontWeight: 600 }}>Family Max Cap Applied</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>
                3+ children = $400/month maximum
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 0', borderTop: `2px solid ${T.border}`, marginTop: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Total Monthly</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: T.accent }}>${(calculateTotal() / 100).toFixed(2)}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <button
            onClick={() => router.push('/dashboard/signups')}
            style={{ flex: 1, padding: '14px', background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{ flex: 1, padding: '14px', background: T.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >
            Save & Generate Keys
          </button>
        </div>
      </div>
    </div>
  );
}
