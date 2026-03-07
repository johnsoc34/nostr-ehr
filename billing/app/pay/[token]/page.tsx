'use client';
import { useState, useEffect } from 'react';
import { use } from 'react';

const Icon = ({ d, size = 18, stroke = "currentColor" }: any) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const Icons = {
  check: "M20 6L9 17l-5-5",
  copy: "M8 4v12a2 2 0 002 2h8a2 2 0 002-2V7.242a2 2 0 00-.602-1.43L16.083 2.57A2 2 0 0014.685 2H10a2 2 0 00-2 2z M16 18v2a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h2",
  clock: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 6v6l4 2",
  info: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 16v-4 M12 8h.01",
  refresh: "M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15",
  alert: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01",
  zap: "M13 2L3 14h8l-1 8 10-12h-8l1-8z",
};

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

const BITCOIN_DISCOUNT = 0.15;

function Card({ T, children, style = {} }: any) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, ...style }}>
      {children}
    </div>
  );
}

export default function PaymentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [dark, setDark] = useState(true);
  const [loading, setLoading] = useState(true);
  const [invoice, setInvoice] = useState<any>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [btcPrice, setBtcPrice] = useState(97420); // ← MOVE THIS UP HERE
  const T = dark ? DARK : LIGHT;

  const usd = (n: number) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  const btcAmount = (usdAmt: number) => (usdAmt / btcPrice).toFixed(8);
  const satsAmount = (usdAmt: number) => Math.round((usdAmt / btcPrice) * 100000000);

  useEffect(() => {
    // Fetch live Bitcoin price from mempool.space
     fetch('https://mempool.space/api/v1/prices')
      .then(res => res.json())
      .then(data => {
        if (data.USD) {
          setBtcPrice(data.USD);
        }
      })
      .catch(err => console.error('Failed to fetch BTC price:', err));
  }, []);

  useEffect(() => {
    fetch(`/api/invoice/${token}`)
      .then(res => res.json())
      .then(data => {
        setInvoice(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load invoice:', err);
        setLoading(false);
      });
  }, [token]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: T.textMuted }}>Loading invoice...</div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: T.red }}>Invoice not found</div>
      </div>
    );
  }

  if (paid) {
    return <SuccessScreen T={T} invoice={invoice} />;
  }

  const baseAmount = invoice.amount / 100;
  const discountedAmount = baseAmount * (1 - BITCOIN_DISCOUNT);
  const savings = baseAmount - discountedAmount;

  return (
    <div style={{
      minHeight: "100vh", background: T.bg, color: T.text,
      fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif",
      display: "flex", flexDirection: "column", alignItems: "center", padding: 24,
    }}>
      <div style={{ width: "100%", maxWidth: 540, marginTop: 40 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16,
            background: `linear-gradient(135deg, ${T.accent}, ${T.accentLt})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 28, fontWeight: 700, color: "#fff", margin: "0 auto 16px",
          }}>₿</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>{process.env.NEXT_PUBLIC_PRACTICE_NAME || "Your Practice"}</div>
          <div style={{ fontSize: 13, color: T.textMuted }}>Secure Payment Portal</div>
        </div>

        <Card T={T} style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Invoice</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: T.accent, marginTop: 4 }}>{invoice.id}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Due Date</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{invoice.due_date}</div>
            </div>
          </div>

          <div style={{ padding: "16px 0", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 8 }}>Description</div>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{invoice.description}</div>
          </div>

          <div style={{
            background: dark ? "rgba(247,147,26,0.08)" : "rgba(247,147,26,0.06)",
            borderRadius: 10, padding: 16, border: `1px solid ${T.accent}33`, marginBottom: 16
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: T.textMuted, fontWeight: 600 }}>Standard Price</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: T.text }}>{usd(baseAmount)}</div>
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, textAlign: "right" }}>
              ACH & Credit Card payments
            </div>
          </div>

          <div style={{
            background: `linear-gradient(135deg, ${T.green}18, ${T.accent}18)`,
            borderRadius: 10, padding: 16, border: `2px solid ${T.green}`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Icon d={Icons.zap} size={24} stroke={T.green} />
              <div style={{ fontSize: 16, fontWeight: 700, color: T.green }}>Save 15% with Bitcoin/Lightning!</div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.accent, marginBottom: 8 }}>
              {usd(discountedAmount)}
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>
              ≈ {btcAmount(discountedAmount)} BTC ({satsAmount(discountedAmount).toLocaleString()} sats)
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: T.text }}>
              Little to no processing fees, faster settlement, and better for your privacy.
            </div>
            <div style={{ marginTop: 12, padding: "8px 12px", background: `${T.green}22`, borderRadius: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.green }}>
                You save: {usd(savings)} ✨
              </div>
            </div>
          </div>
        </Card>

	{!method && <PaymentMethodSelector T={T} setMethod={setMethod} baseAmount={baseAmount} discountedAmount={discountedAmount} usd={usd} />}
	{method === "bitcoin" && <BitcoinPayment T={T} invoice={invoice} amount={discountedAmount} btcAmount={btcAmount} satsAmount={satsAmount} onBack={() => setMethod(null)} onPaid={() => setPaid(true)} />}
	{method === "lightning" && <LightningPayment T={T} invoice={invoice} amount={discountedAmount} usd={usd} satsAmount={satsAmount} onBack={() => setMethod(null)} onPaid={() => setPaid(true)} />}
        
	<div style={{ marginTop: 32, textAlign: "center", fontSize: 12, color: T.textMuted }}>
          <div style={{ marginBottom: 8 }}>Secured by end-to-end encryption</div>
        </div>
      </div>
    </div>
  );
}

function PaymentMethodSelector({ T, setMethod, baseAmount, discountedAmount, usd }: any) {
  const methods = [
    { id: "bitcoin", label: "Bitcoin", icon: "₿", desc: "On-chain payment", color: T.accent, price: discountedAmount, discount: true },
    { id: "lightning", label: "Lightning", icon: "⚡", desc: "Instant payment", color: T.amber, price: discountedAmount, discount: true },
  ];

  return (
    <Card T={T}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, textAlign: "center" }}>Select Payment Method</div>
      <div style={{ display: "grid", gap: 10 }}>
        {methods.map(m => (
          <button
            key={m.id}
            onClick={() => setMethod(m.id)}
            style={{
              display: "flex", alignItems: "center", gap: 14, padding: 16, borderRadius: 10,
              background: T.surfaceHi, border: `1px solid ${T.border}`, cursor: "pointer",
              transition: "all 0.15s", textAlign: "left", position: "relative"
            }}
            onMouseEnter={(e: any) => {
              e.currentTarget.style.borderColor = m.color;
              e.currentTarget.style.background = `${m.color}08`;
            }}
            onMouseLeave={(e: any) => {
              e.currentTarget.style.borderColor = T.border;
              e.currentTarget.style.background = T.surfaceHi;
            }}
          >
            <div style={{
              width: 44, height: 44, borderRadius: 10, background: `${m.color}18`,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0
            }}>{m.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>{m.label}</div>
                {m.discount && (
                  <div style={{ padding: "2px 6px", background: T.green, borderRadius: 4, fontSize: 10, fontWeight: 700, color: "#fff" }}>
                    15% OFF
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{m.desc}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: m.discount ? T.green : T.text, marginTop: 4 }}>
                {usd(m.price)}
              </div>
            </div>
            <div style={{ color: T.textMuted }}>→</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function BitcoinPayment({ T, invoice, amount, btcAmount, satsAmount, onBack, onPaid }: any) {
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    fetch('/api/bitcoin/derive-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: invoice.id })
    })
      .then(res => res.json())
      .then(data => setAddress(data.address));
  }, [invoice.id]);

  const copyAddress = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const checkPayment = () => {
    setChecking(true);
    fetch('/api/bitcoin/check-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: invoice.id })
    })
      .then(res => res.json())
      .then(data => {
        setChecking(false);
        if (data.paid) {
          setTimeout(() => onPaid(), 1000);
        }
      });
  };

  const qrData = `bitcoin:${address}?amount=${btcAmount(amount)}`;

  return (
    <Card T={T}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: T.accent, fontSize: 13, cursor: "pointer" }}>
          ← Back
        </button>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Bitcoin Payment</div>
        <div style={{ width: 40 }} />
      </div>

      {address && (
        <>
          <div style={{ background: "#fff", padding: 20, borderRadius: 12, marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <div style={{ width: 200, height: 200, background: `url('https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}')`, backgroundSize: "cover" }} />
            <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>Scan with any Bitcoin wallet</div>
          </div>

          <div style={{ background: T.surfaceHi, borderRadius: 10, padding: 14, marginBottom: 14, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Send Exactly</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: T.accent, fontFamily: "monospace" }}>{btcAmount(amount)} BTC</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{satsAmount(amount).toLocaleString()} sats</div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6, fontWeight: 600, textTransform: "uppercase" }}>Bitcoin Address</div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 8, background: T.surfaceHi, border: `1px solid ${T.border}`, fontSize: 12, fontFamily: "monospace", color: T.text, wordBreak: "break-all" }}>
                {address}
              </div>
              <button onClick={copyAddress} style={{ padding: "10px 14px", borderRadius: 8, background: T.accent, border: "none", color: "#fff", cursor: "pointer", flexShrink: 0 }}>
                <Icon d={copied ? Icons.check : Icons.copy} size={16} stroke="#fff" />
              </button>
            </div>
          </div>

          <button onClick={checkPayment} disabled={checking} style={{
            width: "100%", padding: "12px", borderRadius: 10,
            background: checking ? T.border : T.accent, color: "#fff", border: "none",
            fontSize: 14, fontWeight: 700, cursor: checking ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8
          }}>
            <Icon d={Icons.refresh} size={16} stroke="#fff" />
            {checking ? "Checking blockchain..." : "Check Payment Status"}
          </button>
        </>
      )}
    </Card>
  );
}

function LightningPayment({ T, invoice, amount, usd, satsAmount, onBack, onPaid }: any) {
  const [bolt11, setBolt11] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/lightning/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: invoice.id, amount: Math.round(amount * 100) })
    })
      .then(res => res.json())
      .then(data => setBolt11(data.invoice));
  }, [invoice.id, amount]);

  const copyInvoice = () => {
    navigator.clipboard.writeText(bolt11);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card T={T}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: T.accent, fontSize: 13, cursor: "pointer" }}>← Back</button>
        <div style={{ fontSize: 14, fontWeight: 700 }}>⚡ Lightning Payment</div>
        <div style={{ width: 40 }} />
      </div>

      {bolt11 ? (
        <>
          <div style={{ background: T.green + "18", borderRadius: 10, padding: 14, marginBottom: 16, border: `1px solid ${T.green}44` }}>
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4, fontWeight: 600, textTransform: "uppercase" }}>Discounted Amount</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: T.green }}>{usd(amount)}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{satsAmount(amount).toLocaleString()} sats</div>
          </div>

          <div style={{ background: "#fff", padding: 20, borderRadius: 12, marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <div style={{ width: 200, height: 200, background: `url('https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(bolt11)}')`, backgroundSize: "cover" }} />
            <div style={{ fontSize: 12, color: "#64748b", textAlign: "center" }}>Scan with Lightning wallet</div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6, fontWeight: 600 }}>Lightning Invoice</div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, padding: "10px 12px", borderRadius: 8, background: T.surfaceHi, border: `1px solid ${T.border}`, fontSize: 11, fontFamily: "monospace", color: T.text, wordBreak: "break-all", maxHeight: 80, overflow: "auto" }}>
                {bolt11}
              </div>
              <button onClick={copyInvoice} style={{ padding: "10px 14px", borderRadius: 8, background: T.accent, border: "none", color: "#fff", cursor: "pointer", flexShrink: 0 }}>
                <Icon d={copied ? Icons.check : Icons.copy} size={16} stroke="#fff" />
              </button>
            </div>
          </div>

          <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", padding: "12px", background: T.surfaceHi, borderRadius: 8 }}>
            Payment will be confirmed instantly once received
          </div>
        </>
      ) : (
        <div style={{ textAlign: "center", padding: "40px 20px", color: T.textMuted }}>Generating invoice...</div>
      )}
    </Card>
  );
}

function SuccessScreen({ T, invoice }: any) {
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 440, textAlign: "center" }}>
        <div style={{ width: 80, height: 80, borderRadius: "50%", background: `linear-gradient(135deg, ${T.green}, #10b981)`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px", boxShadow: `0 8px 24px ${T.green}44` }}>
          <Icon d={Icons.check} size={40} stroke="#fff" />
        </div>
        <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>Payment Successful!</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 24 }}>Your payment has been received and confirmed.</div>
        
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8, fontWeight: 600, textTransform: "uppercase" }}>Invoice</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace", color: T.accent }}>{invoice.id}</div>
        </div>

        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
          A confirmation has been sent to your email. Thank you for choosing {process.env.NEXT_PUBLIC_PRACTICE_NAME || "Your Practice"}.
        </div>
      </div>
    </div>
  );
}
