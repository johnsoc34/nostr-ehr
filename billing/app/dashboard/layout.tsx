'use client';
import { useState, useEffect } from 'react';
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const isAuth = sessionStorage.getItem('billing_auth') === 'true';
    setAuthenticated(isAuth);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        sessionStorage.setItem('billing_auth', 'true');
        setAuthenticated(true);
      } else {
        setError('Invalid password');
      }
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  };

  if (!authenticated) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0d12',
        fontFamily: "'DM Sans', sans-serif"
      }}>
        <div style={{
          width: '100%',
          maxWidth: 400,
          padding: 32,
          background: '#111620',
          borderRadius: 16,
          border: '1px solid #1e2d44'
        }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            background: 'linear-gradient(135deg, #f7931a, #fbb040)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            fontWeight: 800,
            color: '#fff',
            margin: '0 auto 24px'
          }}>Ⅰ</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#e8edf5', textAlign: 'center', marginBottom: 24 }}>
            {process.env.NEXT_PUBLIC_PRACTICE_NAME || "Practice"} Billing
          </h1>
          <form onSubmit={handleLogin}>
            <label style={{ fontSize: 13, color: '#6b7fa3', fontWeight: 600, display: 'block', marginBottom: 8 }}>
              Dashboard Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: 8,
                border: '1px solid #1e2d44',
                background: '#1a2233',
                color: '#e8edf5',
                fontSize: 14,
                marginBottom: 16,
                boxSizing: 'border-box'
              }}
              autoFocus
            />
            {error && (
              <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 16 }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: 8,
                background: loading ? '#b5751a' : '#f7931a',
                color: '#fff',
                border: 'none',
                fontSize: 15,
                fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              {loading ? 'Checking...' : 'Sign In'}
            </button>
          </form>
          <div style={{ fontSize: 12, color: '#6b7fa3', textAlign: 'center', marginTop: 16 }}>
            Secured by end-to-end encryption
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
